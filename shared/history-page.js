import { createWidget, widget, align, text_style, prop, getTextLayout } from '@zos/ui'
import { getDeviceInfo } from '@zos/device'
import { replace } from '@zos/router'
import { LocalStorage } from '@zos/storage'
import { setWakeUpRelaunch } from '@zos/display'

const COLOR = { bg: 0x0b0b0c, gold: 0xeac477, white: 0xf4eee3, muted: 0xb8ac99, surface: 0x28231d }
const ID = /^\d{1,16}-\d{1,8}$/
const STATES = { completed: 'Ответ', error: 'Ошибка', queued: 'В очереди', submitting: 'Отправляется',
  running: 'В работе', approval: 'Нужно решение', unknown: 'Уточнить статус', night: 'Ночная смена' }
// One page for both apps: Mac stays the source of truth, trash is reversible.
const KINDS = {
  musafir: {
    prefix: 'musafir-history', title: 'История', listTitle: 'Вопросы и ответы',
    question: 'Мой вопрос', answer: 'Ответ Мусафира', leave: 'Запись',
    trashNote: 'Это удаление из истории.\nПамять Hermes сохранится.',
    purgeNote: 'Записи из корзины будут удалены с Mac навсегда.\nПамять Hermes сохранится.',
    methods: { list: 'HISTORY_LIST', detail: 'HISTORY_DETAIL', setDeleted: 'HISTORY_SET_DELETED', current: 'HISTORY_CURRENT', emptyTrash: 'HISTORY_EMPTY_TRASH' }
  },
  orca: {
    prefix: 'orca-history', title: 'История Orca', listTitle: 'Задачи',
    question: 'Моя задача', answer: 'Отчёт Orca', leave: 'Orca',
    trashNote: 'Это удаление из истории.\nОтчёт на Mac сохранится.',
    purgeNote: 'Задачи из корзины и их отчёты будут удалены с Mac навсегда.',
    methods: { list: 'ORCA_HISTORY_LIST', detail: 'ORCA_HISTORY_DETAIL', setDeleted: 'ORCA_HISTORY_SET_DELETED', current: null, emptyTrash: 'ORCA_HISTORY_EMPTY_TRASH' }
  },
  claude: {
    prefix: 'claude-history', title: 'История Claude', listTitle: 'Запросы',
    question: 'Мой запрос', answer: 'Ответ Claude', leave: 'Claude',
    trashNote: 'Это удаление из истории.\nСессия Claude на Mac сохранится.',
    purgeNote: 'Записи из корзины будут удалены с Mac навсегда.\nСессии Claude сохранятся.',
    methods: { list: 'CLAUDE_HISTORY_LIST', detail: 'CLAUDE_HISTORY_DETAIL', setDeleted: 'CLAUDE_HISTORY_SET_DELETED', current: null, emptyTrash: 'CLAUDE_HISTORY_EMPTY_TRASH' }
  },
  codex: {
    prefix: 'codex-history', title: 'История Codex', listTitle: 'Запросы',
    question: 'Мой запрос', answer: 'Ответ Codex', leave: 'Codex',
    trashNote: 'Это удаление из истории.\nСессия Codex на Mac сохранится.',
    purgeNote: 'Записи из корзины будут удалены с Mac навсегда.\nСессии Codex сохранятся.',
    methods: { list: 'CODEX_HISTORY_LIST', detail: 'CODEX_HISTORY_DETAIL', setDeleted: 'CODEX_HISTORY_SET_DELETED', current: null, emptyTrash: 'CODEX_HISTORY_EMPTY_TRASH' }
  }
}
const validId = value => typeof value === 'string' && ID.test(value)
const validOffset = value => Number.isInteger(value) && value >= 0
const stamp = seconds => {
  const date = new Date(seconds * 1000)
  const two = value => String(value).padStart(2, '0')
  return `${two(date.getDate())}.${two(date.getMonth() + 1)} ${two(date.getHours())}:${two(date.getMinutes())}`
}

export function createHistoryPage({ kind }) {
  const K = KINDS[kind] || KINDS.musafir
  const isOrca = kind === 'orca'
  const isClaude = kind === 'claude' || kind === 'codex'
  const agentTitle = kind === 'codex' ? 'Codex' : 'Claude'
  const VIEW_KEY = K.prefix + '-view'
  const CACHE_KEY = K.prefix + '-cache'
  const LIST_KEY = K.prefix + '-list'
  return {
  build() {
    const { width, height } = getDeviceInfo()
    this.px = value => Math.round(value * Math.min(width / 390, height / 450))
    this.width = width
    const px = this.px
    this.closed = false
    this.generation = 0
    this.storage = new LocalStorage()
    this.cache = []
    if (isOrca) {
      // History is per pair; the menu stores the pair before opening this page.
      try { this.pair = JSON.parse(this.storage.getItem('orca-history-pair') || 'null') } catch (error) {}
      if (!this.pair || typeof this.pair.id !== 'string' || !this.pair.id) {
        this.closed = true
        replace({ url: 'page/index' })
        return
      }
      this.save('orca-resume', JSON.stringify({ screen: 'history' }))
    } else if (isClaude) {
      this.save(kind + '-resume', JSON.stringify({ screen: 'history' }))
    } else {
      this.save('musafir-resume', 'history')
    }
    try {
      const cache = JSON.parse(this.storage.getItem(CACHE_KEY) || '[]')
      if (Array.isArray(cache)) this.cache = cache.filter(x => x && typeof x.key === 'string' && x.reply).slice(-16)
    } catch (error) {}
    try { this.listContext = JSON.parse(this.storage.getItem(LIST_KEY) || 'null') } catch (error) {}
    try { setWakeUpRelaunch({ relaunch: true }) } catch (error) {}
    createWidget(widget.FILL_RECT, { x: 0, y: 0, w: width, h: height, color: COLOR.bg })
    const text = (y, h, size, color) => createWidget(widget.TEXT, {
      x: px(24), y: px(y), w: width - px(48), h: px(h), text_size: px(size), color,
      align_h: align.CENTER_H, align_v: align.CENTER_V, text_style: text_style.WRAP, text: ''
    })
    this.heading = text(55, 38, 24, COLOR.gold)
    this.note = text(96, 48, 16, COLOR.muted)
    this.body = text(150, 176, 20, COLOR.white)
    const button = (x, y, w, h, action, size = 19) => createWidget(widget.BUTTON, {
      x: px(x), y: px(y), w: px(w), h: px(h), radius: px(10), normal_color: COLOR.surface,
      press_color: 0x413629, color: COLOR.white, text_size: px(size), text: '', click_func: action
    })
    this.rows = [0, 1, 2].map(index => button(24, 150 + index * 63, 342, 52,
      () => this.items[index] && this.items[index].action(), 17))
    this.footer = [0, 1, 2].map(index => button(24 + index * 118, 365, 106, 48,
      () => this.actions[index] && this.actions[index].action(), 17))
    this.restore()
  },
  save(key, value) { try { this.storage.setItem(key, value) } catch (error) {} },
  remember(view) { this.save(VIEW_KEY, JSON.stringify(view)) },
  listParams(trash, offset) {
    return isOrca ? { pairId: this.pair.id, trash, offset, limit: 3 } : { trash, offset, limit: 3 }  // Claude and Musafir: one global list
  },
  restore() {
    try {
      const v = JSON.parse(this.storage.getItem(VIEW_KEY) || 'null')
      if (v && v.screen === 'list' && typeof v.trash === 'boolean' && validOffset(v.offset)) {
        this.list(v.trash, v.offset); return
      }
      if (v && v.screen === 'detail' && validId(v.id) && ['text', 'result'].includes(v.field) && validOffset(v.offset)) {
        this.detail(v.id, v.field, v.offset, validOffset(v.subpage) ? v.subpage : 0); return
      }
      if (v && v.screen === 'entry' && validId(v.id)) { this.entry(v.id); return }
    } catch (error) {}
    this.home()
  },
  show(title, note = '', items = [], actions = [], body = '') {
    if (this.closed) return
    ++this.generation
    this.items = items
    this.actions = actions
    this.heading.setProperty(prop.TEXT, title)
    this.note.setProperty(prop.TEXT, note)
    this.body.setProperty(prop.TEXT, body)
    this.body.setProperty(prop.VISIBLE, !items.length)
    this.rows.forEach((row, i) => {
      row.setProperty(prop.VISIBLE, !!items[i])
      if (items[i]) row.setProperty(prop.TEXT, items[i].label)
    })
    this.footer.forEach((row, i) => {
      row.setProperty(prop.VISIBLE, !!actions[i])
      if (actions[i]) row.setProperty(prop.TEXT, actions[i].label)
    })
  },
  async load(method, params, done, back, cached = true) {
    this.show(K.title, 'Получаю с Mac…', [], [{ label: 'Назад', action: back }])
    const generation = this.generation
    const key = method + ':' + JSON.stringify(params)
    try {
      const reply = await this.request({ method, params }, { timeout: 15000 })
      if (this.closed || generation !== this.generation) return
      if (!reply || reply.ok !== true) {
        // A server rejection is authoritative; never replace it with a stale cache hit.
        const error = new Error(reply && reply.error || 'Нет ответа Mac')
        error.server = reply && reply.offline !== true
        throw error
      }
      try { done(reply, false) }
      catch (error) { error.server = true; throw error }
      if (cached) {
        this.cache = this.cache.filter(x => x.key !== key)
        this.cache.push({ key, reply })
        this.cache = this.cache.slice(-16)
        this.save(CACHE_KEY, JSON.stringify(this.cache))
      }
    } catch (error) {
      if (this.closed || generation !== this.generation) return
      const hit = cached && !error.server && this.cache.find(x => x.key === key)
      if (hit) {
        try { done(hit.reply, true); return } catch (invalid) {}
      }
      this.show('Нет данных', String(error.message || 'Нет связи с Mac').slice(0, 100), [
        { label: 'Повторить', action: () => this.load(method, params, done, back, cached) }
      ], [{ label: 'Назад', action: back }])
    }
  },
  home() {
    this.remember({ screen: 'home' })
    this.show(K.title, isOrca ? this.pair.projectLabel || 'Orca' : isClaude ? agentTitle + ' · твой Mac' : 'Мусафир · твой Mac', [
      { label: K.listTitle, action: () => this.list(false) },
      { label: 'Текущая задача', action: () => this.current() },
      { label: 'Корзина', action: () => this.list(true) }
    ], [{ label: K.leave, action: () => isOrca || isClaude ? this.menu() : this.voice() }])
  },
  voice() {
    if (isClaude) {
      // Reopen the last Claude task screen if one exists, otherwise the project menu.
      let saved = null
      try { saved = JSON.parse(this.storage.getItem('voice-destination') || 'null') } catch (error) {}
      if (saved && saved.target === kind && typeof saved.project === 'string') {
        this.save(kind + '-resume', JSON.stringify({ screen: 'voice' }))
        replace({ url: 'page/voice' })
      } else this.menu()
      return
    }
    if (isOrca) {
      const pair = this.pair
      this.save('voice-destination', JSON.stringify({ target: 'orca', pairId: pair.id,
        label: pair.projectLabel || 'Orca', workerAgent: pair.workerAgent || '', reviewerAgent: pair.reviewerAgent || '' }))
      this.save('orca-resume', JSON.stringify({ screen: 'voice' }))
      replace({ url: 'page/voice' })
      return
    }
    this.save('musafir-resume', 'voice')
    replace({ url: 'page/index' })
  },
  menu() {
    if (isClaude) this.save(kind + '-resume', JSON.stringify({ screen: 'home' }))
    else this.save('orca-resume', JSON.stringify({ screen: 'pair', pair: this.pair }))
    replace({ url: 'page/index' })
  },
  list(trash = false, offset = 0) {
    this.remember({ screen: 'list', trash, offset })
    this.listContext = { trash, offset }
    this.save(LIST_KEY, JSON.stringify(this.listContext))
    this.load(K.methods.list, this.listParams(trash, offset), (reply, offline) => {
      if (!Array.isArray(reply.items) || reply.items.length > 3 || typeof reply.hasMore !== 'boolean' ||
          reply.items.some(x => !validId(x.id) || typeof x.text !== 'string' || !Number.isFinite(x.created) || !STATES[x.state])) {
        throw new Error('Некорректная история')
      }
      this.show(trash ? 'Корзина' : K.listTitle,
        offline ? 'Нет связи · сохранённое' : reply.items.length ? `Страница ${offset / 3 + 1}` : 'Здесь пока пусто',
        reply.items.map(x => ({ label: `${stamp(x.created)} · ${STATES[x.state]}\n${Array.from(x.text).slice(0, 23).join('')}${Array.from(x.text).length > 23 ? '…' : ''}`,
          action: () => this.entry(x.id) })), [
          { label: 'Меню', action: () => this.home() },
          offset ? { label: '‹', action: () => this.list(trash, Math.max(0, offset - 3)) }
            : trash && reply.items.length && !offline ? { label: 'Очистить', action: () => this.confirmEmpty() } : null,
          reply.hasMore ? { label: '›', action: () => this.list(trash, offset + 3) } : null
        ])
    }, () => this.home())
  },
  backToList() { const v = this.listContext || { trash: false, offset: 0 }; this.list(v.trash, v.offset) },
  validateDetail(reply, id, field, offset) {
    if (reply.id !== id || reply.field !== field || reply.offset !== offset || typeof reply.content !== 'string' ||
        !validOffset(reply.total) || typeof reply.deleted !== 'boolean' || typeof reply.complete !== 'boolean' ||
        !Number.isFinite(reply.created) || !STATES[reply.state]) throw new Error('Некорректный ответ')
    const end = offset + Array.from(reply.content).length
    if (Array.from(reply.content).length > 600 || end > reply.total || reply.complete !== (end === reply.total) || (!reply.complete && end === offset)) {
      throw new Error('Неполный ответ')
    }
  },
  entry(id) {
    this.remember({ screen: 'entry', id })
    this.load(K.methods.detail, { id, field: 'text', offset: 0, limit: 600 }, (r, offline) => {
      this.validateDetail(r, id, 'text', 0)
      const terminal = ['completed', 'error', 'night'].includes(r.state)
      this.show(r.deleted ? 'В корзине' : 'Запись истории',
        `${stamp(r.created)} · ${STATES[r.state]}${offline ? '\nНет связи · сохранённое' : ''}`, [
          { label: K.question, action: () => this.detail(id, 'text') },
          { label: terminal ? K.answer : 'Открыть задачу', action: () => terminal ? this.detail(id, 'result') : this.voice() },
          ...(terminal ? [{ label: r.deleted ? 'Восстановить' : 'В корзину', action: () => this.confirm(id, !r.deleted) }] : [])
        ], [{ label: 'Назад', action: () => this.backToList() }])
    }, () => this.backToList())
  },
  splitText(value) {
    const chars = Array.from(value)
    const pages = []
    while (chars.length) {
      let count = Math.min(200, chars.length)
      for (; count > 1; count--) {
        const text = chars.slice(0, count).join('')
        let fits
        try {
          const measured = getTextLayout(text, { text_size: this.px(20), text_width: this.width - this.px(48), wrapped: 1 })
          if (!measured || !Number.isFinite(measured.height)) throw new Error('layout')
          fits = measured.result !== -1 && measured.height <= this.px(168)
        } catch (error) {
          fits = text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(Array.from(line).length / 14)), 0) <= 6
        }
        if (fits) break
      }
      pages.push(chars.splice(0, count).join(''))
    }
    return pages.length ? pages : ['Текст отсутствует']
  },
  detail(id, field, offset = 0, subpage = 0) {
    this.remember({ screen: 'detail', id, field, offset, subpage })
    this.load(K.methods.detail, { id, field, offset, limit: 600 }, (r, offline) => {
      this.validateDetail(r, id, field, offset)
      const pages = this.splitText(r.content)
      const render = index => {
        index = Math.min(index, pages.length - 1)
        this.remember({ screen: 'detail', id, field, offset, subpage: index })
        this.show(field === 'text' ? K.question : K.answer,
          `${offline ? 'Нет связи · сохранённое' : stamp(r.created)}\nЧасть ${Math.floor(offset / 600) + 1} · ${index + 1}/${pages.length}`, [], [
            { label: 'Назад', action: () => this.entry(id) },
            index > 0 ? { label: '‹', action: () => render(index - 1) }
              : offset ? { label: '‹', action: () => this.detail(id, field, Math.max(0, offset - 600), 999) } : null,
            index < pages.length - 1 ? { label: '›', action: () => render(index + 1) }
              : !r.complete ? { label: '›', action: () => this.detail(id, field, offset + Array.from(r.content).length) } : null
          ], pages[index])
      }
      render(subpage)
    }, () => this.entry(id))
  },
  confirm(id, deleted) {
    this.show(deleted ? 'В корзину?' : 'Восстановить?',
      deleted ? 'Запись можно вернуть' : 'Запись вернётся в историю', [], [
        { label: 'Отмена', action: () => this.entry(id) }, null,
        { label: deleted ? 'Убрать' : 'Вернуть', action: () => this.setDeleted(id, deleted) }
      ], deleted ? K.trashNote : 'Запись появится в общем списке.')
  },
  confirmEmpty() {
    this.show('Очистить корзину?', 'Удаление навсегда', [], [
      { label: 'Отмена', action: () => this.list(true) }, null,
      { label: 'Удалить', action: () => this.emptyTrash() }
    ], K.purgeNote)
  },
  emptyTrash() {
    this.cache = []
    this.save(CACHE_KEY, '[]')
    this.load(K.methods.emptyTrash, isOrca ? { pairId: this.pair.id } : {}, r => {  // Claude: all projects
      if (!Number.isInteger(r.removed) || r.removed < 0) throw new Error('Не получено подтверждение')
      this.list(true)
    }, () => this.list(true), false)
  },
  setDeleted(id, deleted) {
    // Clear stale pages before sending: the Mac may commit even if its receipt is lost.
    this.cache = []
    this.save(CACHE_KEY, '[]')
    this.load(K.methods.setDeleted, { id, deleted }, r => {
      if (r.id !== id || r.deleted !== deleted) throw new Error('Не получено подтверждение')
      this.list(deleted ? false : true)
    }, () => this.entry(id), false)
  },
  current() {
    if (isOrca || isClaude) { this.voice(); return }
    this.load(K.methods.current, {}, r => {
      if (r.job === null) {
        this.show('Текущая задача', 'Активных задач нет', [
          { label: K.listTitle, action: () => this.list() },
          { label: 'Новая запись', action: () => this.voice() }
        ], [{ label: 'Назад', action: () => this.home() }])
        return
      }
      if (!r.job || !validId(r.job.id) || !STATES[r.job.state]) throw new Error('Некорректная задача')
      this.show('Текущая задача', STATES[r.job.state], [
        { label: 'Открыть', action: () => this.voice() },
        { label: 'История', action: () => this.list() }
      ], [{ label: 'Назад', action: () => this.home() }])
    }, () => this.home(), false)
  },
  onDestroy() { this.closed = true; ++this.generation }
  }
}
