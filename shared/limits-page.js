import { createWidget, widget, align, text_style, prop } from '@zos/ui'
import { getDeviceInfo } from '@zos/device'
import { LocalStorage } from '@zos/storage'
import { setTimeout } from '@zos/timer'

const COLOR = { bg: 0x0b0b0c, gold: 0xeac477, white: 0xf4eee3, muted: 0xb8ac99, surface: 0x28231d, red: 0xe07a5f }
const CACHE_KEY = 'limits-cache'
// The watch gives the phone 5 s to answer the handshake; Zepp on the phone often needs longer to wake this app's service.
const RETRYABLE = /shake|ble disconnect|timeout/i
const ATTEMPTS = 4
const human = error => {
  const text = String(error && error.message || error || '')
  return RETRYABLE.test(text) ? 'Телефон не ответил. Открой Zepp на телефоне и нажми «Обновить»' : text.slice(0, 60)
}
// One screen: Claude Code and Codex usage windows with the reset time. The Mac reads them; the watch shows the last reading first.
export function createLimitsPage() {
  return {
  build() {
    const { width, height } = getDeviceInfo()
    const px = value => Math.round(value * Math.min(width / 390, height / 450))
    this.closed = false
    this.storage = new LocalStorage()
    createWidget(widget.FILL_RECT, { x: 0, y: 0, w: width, h: height, color: COLOR.bg })
    createWidget(widget.TEXT, { x: px(24), y: px(40), w: width - px(48), h: px(36), text_size: px(24), color: COLOR.gold,
      align_h: align.CENTER_H, text: 'Лимиты' })
    this.note = createWidget(widget.TEXT, { x: px(24), y: px(78), w: width - px(48), h: px(26), text_size: px(16), color: COLOR.muted,
      align_h: align.CENTER_H, text: 'Обновляю…' })
    this.blocks = [0, 1].map(index => ({
      title: createWidget(widget.TEXT, { x: px(24), y: px(110 + index * 128), w: width - px(48), h: px(28), text_size: px(21),
        color: COLOR.gold, text: '' }),
      lines: createWidget(widget.TEXT, { x: px(24), y: px(140 + index * 128), w: width - px(48), h: px(92), text_size: px(16),
        color: COLOR.white, text_style: text_style.WRAP, text: '' })
    }))
    this.button = createWidget(widget.BUTTON, { x: px(96), y: px(372), w: px(198), h: px(48), radius: px(12), normal_color: COLOR.surface,
      press_color: 0x413629, color: COLOR.gold, text_size: px(20), text: 'Обновить', click_func: () => this.load(true) })
    try {
      const cached = JSON.parse(this.storage.getItem(CACHE_KEY) || 'null')
      if (cached && cached.ok) this.render(cached)
    } catch (error) {}
    this.load(false)
  },
  load(force) {
    if (this.loading) return  // one request at a time; repeated taps do not stack
    this.loading = true
    this.note.setProperty(prop.TEXT, force ? 'Спрашиваю Claude и Codex…' : 'Обновляю…')
    this.ask({ method: 'LIMITS', params: force ? { force: true } : {} }, 0).then(reply => {
      if (this.closed) return
      if (!reply || !reply.ok) { this.note.setProperty(prop.TEXT, String(reply && reply.error || 'Нет ответа Mac').slice(0, 60)); return }
      try { this.storage.setItem(CACHE_KEY, JSON.stringify(reply)) } catch (error) {}
      this.render(reply)
    }).catch(error => { if (!this.closed) this.note.setProperty(prop.TEXT, human(error)) })
      .then(() => { this.loading = false })
  },
  ask(payload, attempt) {
    return Promise.resolve().then(() => this.request(payload, { timeout: 40000 })).catch(error => {
      if (this.closed || attempt + 1 >= ATTEMPTS || !RETRYABLE.test(String(error && error.message || error))) throw error
      this.note.setProperty(prop.TEXT, `Жду телефон… попытка ${attempt + 2} из ${ATTEMPTS}`)
      return new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1))).then(() => this.ask(payload, attempt + 1))
    })
  },
  render(reply) {
    this.note.setProperty(prop.TEXT, reply.checkedAt ? `Обновлено ${reply.checkedAt}` : '')
    const agents = Array.isArray(reply.agents) ? reply.agents : []
    this.blocks.forEach((block, index) => {
      const agent = agents[index]
      if (!agent) { block.title.setProperty(prop.TEXT, ''); block.lines.setProperty(prop.TEXT, ''); return }
      block.title.setProperty(prop.TEXT, String(agent.label || ''))
      const windows = Array.isArray(agent.windows) ? agent.windows : []
      const text = windows.length
        // One word, the owner's choice: what is left. Claude Code's own number is the used share, so it is inverted here.
        ? windows.map(w => `${w.label} · осталось ${w.free != null ? w.free : 100 - w.used} %` +
          (w.resets || w.left ? `\n${w.resets ? `сброс ${w.resets}` : ''}${w.resets && w.left ? ', ' : ''}${w.left || ''}` : '')).join('\n')
        : String(agent.error || 'нет данных')
      block.lines.setProperty(prop.TEXT, text)
      block.lines.setProperty(prop.COLOR, windows.some(w => w.used >= 90) ? COLOR.red : COLOR.white)
    })
  },
  onDestroy() { this.closed = true }
  }
}
