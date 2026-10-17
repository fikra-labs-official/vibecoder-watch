import { createWidget, widget, align, text_style, prop, getTextLayout } from '@zos/ui'
import { getDeviceInfo } from '@zos/device'
import { replace } from '@zos/router'
import { LocalStorage } from '@zos/storage'
import { setTimeout, clearTimeout } from '@zos/timer'

// One bounded server chunk is held at a time, including for long research reports.
function splitText(text, fits) {
  const chars = Array.from(text)
  const pages = []
  let offset = 0
  while (offset < chars.length) {
    let low = 1, high = Math.min(600, chars.length - offset), count = 1
    while (low <= high) {
      const n = Math.floor((low + high) / 2)
      if (fits(chars.slice(offset, offset + n).join(''))) { count = n; low = n + 1 }
      else high = n - 1
    }
    if (offset + count < chars.length && !/\s/.test(chars[offset + count])) {
      for (let n = count - 1; n > count / 2; n--) {
        if (/\s/.test(chars[offset + n])) { count = n + 1; break }
      }
    }
    pages.push(chars.slice(offset, offset + count).join(''))
    offset += count
  }
  return pages.length ? pages : ['Ответ пуст']
}

export function createMusafirReportPage() {
  return {
    build() {
      const { width, height } = getDeviceInfo()
      this.px = value => Math.round(value * Math.min(width / 432, height / 514))
      const px = this.px
      this.closed = false
      this.generation = 0
      this.requestTimer = null
      this.cancelRequest = null
      this.offset = 0
      this.page = 0
      this.pages = []
      this.total = null
      this.nextOffset = null
      this.storage = new LocalStorage()
      this.jobId = this.storage.getItem('musafir-report-job')
      createWidget(widget.FILL_RECT, { x: 0, y: 0, w: width, h: height, color: 0x080b0f })
      createWidget(widget.TEXT, { x: px(24), y: px(28), w: width - px(48), h: px(36),
        text: 'Полный ответ', text_size: px(25), color: 0xf0be75, align_h: align.CENTER_H })
      this.note = createWidget(widget.TEXT, { x: px(24), y: px(76), w: width - px(48), h: px(30),
        text: '', text_size: px(16), color: 0xa8b3c3, align_h: align.CENTER_H })
      this.body = createWidget(widget.TEXT, { x: px(24), y: px(116), w: width - px(48), h: px(264),
        text: '', text_size: px(22), color: 0xf3f6fa, text_style: text_style.WRAP,
        align_h: align.LEFT, align_v: align.TOP })
      this.fits = text => {
        try {
          const layout = getTextLayout(text, { text_size: px(22), text_width: width - px(48), wrapped: 1 })
          if (layout && Number.isFinite(layout.height)) return layout.result !== -1 && layout.height <= px(256)
        } catch (error) {}
        return Array.from(text).length <= 180 && text.split('\n').length <= 8
      }
      this.previous = createWidget(widget.BUTTON, { x: px(24), y: px(394), w: px(112), h: px(52),
        radius: px(14), text: '‹ Назад', text_size: px(19), normal_color: 0x171d25,
        press_color: 0x26313e, color: 0xf3f6fa, click_func: () => this.turn(-1) })
      this.counter = createWidget(widget.TEXT, { x: px(142), y: px(394), w: width - px(284), h: px(52),
        text: '', text_size: px(17), color: 0xa8b3c3, align_h: align.CENTER_H, align_v: align.CENTER_V })
      this.next = createWidget(widget.BUTTON, { x: width - px(136), y: px(394), w: px(112), h: px(52),
        radius: px(14), text: 'Далее ›', text_size: px(19), normal_color: 0x171d25,
        press_color: 0x26313e, color: 0xf3f6fa, click_func: () => this.error ? this.load(this.offset) : this.turn(1) })
      createWidget(widget.BUTTON, { x: px(24), y: height - px(60), w: width - px(48), h: px(51),
        radius: px(14), text: 'К задаче', text_size: px(21), normal_color: 0xf0be75,
        press_color: 0xd3a25f, color: 0x080b0f, click_func: () => replace({ url: 'page/voice' }) })
      if (!/^\d{1,16}-\d{1,8}$/.test(this.jobId || '')) {
        this.body.setProperty(prop.TEXT, 'Откройте ответ из выбранного чата.')
        this.previous.setProperty(prop.VISIBLE, false)
        this.next.setProperty(prop.VISIBLE, false)
        return
      }
      this.load(0)
    },

    async load(offset, lastPage = false) {
      const generation = ++this.generation
      if (this.cancelRequest) this.cancelRequest()
      this.offset = offset
      this.error = false
      this.loading = true
      this.note.setProperty(prop.TEXT, 'Читаю сохранённый ответ…')
      this.previous.setProperty(prop.VISIBLE, false)
      this.next.setProperty(prop.VISIBLE, false)
      try {
        const reply = await new Promise((resolve, reject) => {
          let settled = false
          const finish = (error, result) => {
            if (settled) return
            settled = true
            if (this.requestTimer !== null) clearTimeout(this.requestTimer)
            this.requestTimer = null
            this.cancelRequest = null
            if (error) reject(error); else resolve(result)
          }
          this.cancelRequest = () => finish(new Error('CANCELED'))
          this.requestTimer = setTimeout(() => finish(new Error('Mac не ответил вовремя')), 18000)
          Promise.resolve().then(() => this.request({ method: 'JOB_REPORT', params: {
            id: this.jobId, offset, limit: 1000
          } }, { timeout: 15000 })).then(value => finish(null, value), error => finish(error))
        })
        if (this.closed || generation !== this.generation) return
        if (!reply || !reply.ok || reply.id !== this.jobId || reply.offset !== offset ||
            typeof reply.text !== 'string' || !Number.isInteger(reply.textLength) ||
            reply.textLength < 0 || reply.textLength > 200000 || typeof reply.truncated !== 'boolean') {
          throw new Error(reply && reply.error || 'Не удалось прочитать отчёт')
        }
        const length = Array.from(reply.text).length
        if (length > 1000 || offset + length > reply.textLength ||
            (length === 0 && reply.textLength > 0) ||
            reply.nextOffset !== (offset + length < reply.textLength ? offset + length : null) ||
            (this.total !== null && this.total !== reply.textLength)) throw new Error('Ответ изменился. Откройте его заново.')
        this.total = reply.textLength
        this.nextOffset = reply.nextOffset
        this.truncated = reply.truncated
        this.pages = splitText(reply.text, this.fits)
        this.page = lastPage ? this.pages.length - 1 : 0
        this.loading = false
        this.show()
      } catch (error) {
        if (this.closed || generation !== this.generation) return
        this.loading = false
        this.error = true
        this.note.setProperty(prop.TEXT, 'Часть ответа не загружена')
        this.body.setProperty(prop.TEXT, error.message || 'Нет связи с Mac')
        this.next.setProperty(prop.TEXT, 'Повторить')
        this.next.setProperty(prop.VISIBLE, true)
      }
    },

    show() {
      this.body.setProperty(prop.TEXT, this.pages[this.page])
      this.note.setProperty(prop.TEXT, `Часть ${Math.floor(this.offset / 1000) + 1}${this.truncated ? ' · есть ограничение длины' : ''}`)
      this.counter.setProperty(prop.TEXT, `${this.page + 1}/${this.pages.length}`)
      this.previous.setProperty(prop.VISIBLE, this.offset > 0 || this.page > 0)
      this.next.setProperty(prop.TEXT, 'Далее ›')
      this.next.setProperty(prop.VISIBLE, this.page < this.pages.length - 1 || this.nextOffset !== null)
    },

    turn(direction) {
      if (this.loading || this.error) return
      const next = this.page + direction
      if (next >= 0 && next < this.pages.length) { this.page = next; this.show() }
      else if (direction > 0 && this.nextOffset !== null) this.load(this.nextOffset)
      else if (direction < 0 && this.offset > 0) this.load(Math.max(0, this.offset - 1000), true)
    },

    onDestroy() {
      this.closed = true
      ++this.generation
      if (this.cancelRequest) this.cancelRequest()
    }
  }
}
