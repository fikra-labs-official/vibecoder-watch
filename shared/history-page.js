import { createWidget, widget, align, text_style, prop, getTextLayout, setStatusBarVisible } from '@zos/ui'
import { getDeviceInfo } from '@zos/device'
import { replace } from '@zos/router'
import { LocalStorage } from '@zos/storage'
import { setWakeUpRelaunch } from '@zos/display'
import { setTimeout, clearTimeout } from '@zos/timer'
import {
  onGesture, offGesture, GESTURE_RIGHT,
  onKey, offKey, KEY_BACK, KEY_EVENT_CLICK
} from '@zos/interaction'

import { textRows } from './text-rows.js'

const COLOR = { bg: 0x0b0b0c, gold: 0xeac477, white: 0xf4eee3, muted: 0xb8ac99, surface: 0x28231d }
const ID = /^\d{1,16}-\d{1,8}$/
const MAX_CONTENT = 200000
const CHUNK_SIZE = 600
const READ_DEADLINE = 45000
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
    try { setStatusBarVisible(false) } catch (error) {}
    const { width, height } = getDeviceInfo()
    this.px = value => Math.round(value * Math.min(width / 390, height / 450))
    this.width = width
    const px = this.px
    this.closed = false
    this.generation = 0
    this.height = height
    this.storage = null
    try { this.storage = new LocalStorage() } catch (error) {}
    this.cache = []
    if (isOrca) {
      // History is per pair; the menu stores the pair before opening this page.
      try { this.pair = JSON.parse(this.read('orca-history-pair') || 'null') } catch (error) {}
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
      const raw = this.read(CACHE_KEY) || '[]'
      if (raw.length <= 50000) {
        const cache = JSON.parse(raw)
        if (Array.isArray(cache)) this.cache = cache.filter(x => this.validCacheEntry(x)).slice(-16)
      }
    } catch (error) {}
    try { this.listContext = JSON.parse(this.read(LIST_KEY) || 'null') } catch (error) {}
    try { setWakeUpRelaunch({ relaunch: true }) } catch (error) {}
    createWidget(widget.FILL_RECT, { x: 0, y: 0, w: width, h: height, color: COLOR.bg })
    const text = (y, h, size, color) => createWidget(widget.TEXT, {
      x: px(24), y: px(y), w: width - px(48), h: px(h), text_size: px(size), color,
      align_h: align.CENTER_H, align_v: align.CENTER_V, text_style: text_style.WRAP, text: ''
    })
    this.heading = text(55, 38, 24, COLOR.gold)
    this.note = text(96, 48, 16, COLOR.muted)
    this.body = text(150, 176, 20, COLOR.white)
    const footerY = height - 14 - Math.max(44, px(48))
    this.textSize = Math.max(17, px(20))
    this.textWidth = width - px(60)
    const rowHeight = Math.max(34, px(40))
    this.scroll = createWidget(widget.SCROLL_LIST, {
      x: px(24), y: px(150), w: width - px(48), h: footerY - px(150) - 10,
      item_space: 0, snap_to_center: false, item_enable_horizon_drag: false,
      item_config: [{ type_id: 1, item_height: rowHeight, item_bg_color: COLOR.bg, item_bg_radius: 0,
        text_view: [{ x: px(6), y: 0, w: this.textWidth, h: rowHeight,
          key: 'display', color: COLOR.white, text_size: this.textSize }], text_view_count: 1 }],
      item_config_count: 1, data_array: [{ display: '' }], data_count: 1
    })
    this.scroll.setProperty(prop.VISIBLE, false)
    const buttonProps = (x, y, w, h, action, size = 19) => ({
      x: px(x), y: px(y), w: px(w), h: Math.max(44, px(h)), radius: px(10), normal_color: COLOR.surface,
      press_color: 0x413629, color: COLOR.white, text_size: px(size), text: '', click_func: action
    })
    this.rowMore = [0, 1, 2].map(index => buttonProps(24, 150 + index * 63, 342, 52,
      () => this.items[index] && this.items[index].action(), 17))
    this.rowMore.forEach(value => { value.w = width - px(48) })
    this.rows = this.rowMore.map(value => createWidget(widget.BUTTON, value))
    this.footerMore = [0, 1, 2].map(index => buttonProps(24 + index * 118, 365, 106, 48,
      () => this.actions[index] && this.actions[index].action(), 17))
    const footerWidth = Math.floor((width - px(48) - 16) / 3)
    this.footerMore.forEach((value, index) => Object.assign(value, { x: px(24) + index * (footerWidth + 8), y: footerY, w: footerWidth }))
    this.footer = this.footerMore.map(value => createWidget(widget.BUTTON, value))
    this.gestureCallback = gesture => {
      if (gesture !== GESTURE_RIGHT) return false
      this.goBack(); return true
    }
    this.keyCallback = (key, keyEvent) => {
      if (key !== KEY_BACK || keyEvent !== KEY_EVENT_CLICK) return false
      this.goBack(); return true
    }
    try { onGesture({ callback: this.gestureCallback }); onKey({ callback: this.keyCallback }) } catch (error) {}
    this.restore()
  },
  read(key) { try { return this.storage && this.storage.getItem(key) } catch (error) { return null } },
  save(key, value) { try { if (!this.storage) return false; this.storage.setItem(key, value); return true } catch (error) { return false } },
  remember(view) { this.view = view; this.save(VIEW_KEY, JSON.stringify(view)) },
  validCacheEntry(value) {
    if (!value || typeof value.key !== 'string' || value.key.length > 500 || !value.reply || value.reply.ok !== true) return false
    try { if (JSON.stringify(value).length > 16000) return false } catch (error) { return false }
    const content = value.reply.content
    return content === undefined || (typeof content === 'string' && Array.from(content).length <= CHUNK_SIZE &&
      validOffset(value.reply.total) && value.reply.total <= MAX_CONTENT)
  },
  listParams(trash, offset) {
    return isOrca ? { pairId: this.pair.id, trash, offset, limit: 3 } : { trash, offset, limit: 3 }  // Claude and Musafir: one global list
  },
  restore() {
    try {
      const v = JSON.parse(this.read(VIEW_KEY) || 'null')
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
    this.stopReading()
    ++this.generation
    this.items = items
    this.actions = actions
    const back = actions.find(action => action && ['Назад', 'Отмена', 'Меню', K.leave].includes(action.label))
    this.backAction = back && back.action
    this.heading.setProperty(prop.TEXT, title)
    this.note.setProperty(prop.TEXT, note)
    this.body.setProperty(prop.TEXT, body)
    this.body.setProperty(prop.VISIBLE, !items.length)
    this.scroll.setProperty(prop.VISIBLE, false)
    this.rows.forEach((row, i) => {
      row.setProperty(prop.VISIBLE, !!items[i])
      if (items[i]) row.setProperty(prop.MORE, { ...this.rowMore[i], text: items[i].label })
    })
    this.footer.forEach((row, i) => {
      row.setProperty(prop.VISIBLE, !!actions[i])
      if (actions[i]) row.setProperty(prop.MORE, { ...this.footerMore[i], text: actions[i].label })
    })
  },
  stopReading() {
    if (this.continueTimer != null) clearTimeout(this.continueTimer)
    if (this.requestTimer != null) clearTimeout(this.requestTimer)
    this.continueTimer = null
    this.requestTimer = null
    if (this.cancelRequest) this.cancelRequest()
    this.cancelRequest = null
    this.reading = false
  },
  goBack() {
    if (this.closed) return
    const view = this.view || { screen: 'home' }
    if (view.screen === 'detail') this.entry(view.id)
    else if (view.screen === 'entry') this.backToList()
    else if (view.screen === 'list') this.home()
    else if (this.backAction) this.backAction()
    else if (isOrca || isClaude) this.menu()
    else this.voice()
  },
  boundedRequest(payload) {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error, value) => {
        if (settled) return
        settled = true
        if (this.requestTimer != null) clearTimeout(this.requestTimer)
        this.requestTimer = null
        this.cancelRequest = null
        if (error) reject(error); else resolve(value)
      }
      this.cancelRequest = () => finish(new Error('CANCELED'))
      this.requestTimer = setTimeout(() => finish(new Error('Mac не ответил вовремя')), 18000)
      Promise.resolve().then(() => this.request(payload, { timeout: 15000 }))
        .then(value => finish(null, value), error => finish(error))
    })
  },
  async load(method, params, done, back, cached = true) {
    this.show(K.title, 'Получаю с Mac…', [], [{ label: 'Назад', action: back }])
    const generation = this.generation
    const key = method + ':' + JSON.stringify(params)
    try {
      const reply = await this.boundedRequest({ method, params })
      if (this.closed || generation !== this.generation) return
      if (!reply || reply.ok !== true) {
        // A server rejection is authoritative; never replace it with a stale cache hit.
        const error = new Error(reply && reply.error || 'Нет ответа Mac')
        error.server = reply && reply.offline !== true
        if (error.server) {
          this.cache = this.cache.filter(x => x.key !== key)
          this.save(CACHE_KEY, JSON.stringify(this.cache))
        }
        throw error
      }
      try { done(reply, false) }
      catch (error) { error.server = true; throw error }
      if (cached) {
        const cachedReply = { ...reply }
        delete cachedReply.context
        this.cache = this.cache.filter(x => x.key !== key)
        const candidate = { key, reply: cachedReply }
        if (this.validCacheEntry(candidate)) this.cache.push(candidate)
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
        { label: cached ? 'Повторить' : 'Проверить', action: () => cached ? this.load(method, params, done, back, cached) : back() }
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
      const saved = this.savedContext()
      if (saved) this.openContext(saved)
      else this.menu()
      return
    }
    if (isOrca) {
      const saved = this.savedContext()
      if (saved) this.openContext(saved)
      else this.menu()
      return
    }
    this.save('musafir-resume', 'voice')
    this.stopReading()
    ++this.generation
    replace({ url: 'page/index' })
  },
  context(value, id = null) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.autoRecord !== false || value.resumeJob !== true ||
        typeof value.jobId !== 'string' || !value.jobId || (id !== null && value.jobId !== id)) return null
    if (isOrca) {
      if (!this.pair || value.target !== 'orca' || typeof value.pairId !== 'string' || !value.pairId || typeof value.label !== 'string' ||
          !value.label.trim() || value.label.length > 120 || /[\u0000-\u001f]/.test(value.label) ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.jobId) ||
          (id === null && this.pair.projectLabel && value.label.trim() !== this.pair.projectLabel) ||
          value.pairId !== this.pair.id) return null
      return { target: 'orca', pairId: value.pairId, label: value.label.trim(), jobId: value.jobId,
        resumeJob: true, autoRecord: false }
    }
    if (isClaude) {
      const modes = kind === 'codex' ? ['auto', 'read-only', 'bypass'] : ['auto', 'acceptEdits', 'plan', 'bypass', 'default']
      if (value.target !== kind || !ID.test(value.jobId) || typeof value.project !== 'string' || !value.project ||
          value.project.length > 2048 || value.project.includes('\u0000') ||
          value.openJob !== true || (value.mode !== undefined && !modes.includes(value.mode)) ||
          (value.label !== undefined && (typeof value.label !== 'string' || !value.label.trim() || value.label.length > 120 || /[\u0000-\u001f]/.test(value.label))) ||
          (id === null && (typeof value.label !== 'string' || !value.label.trim())) ||
          (value.sessionId !== undefined && (typeof value.sessionId !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.sessionId)))) return null
      const answer = { target: kind, project: value.project, jobId: value.jobId,
        openJob: true, resumeJob: true, autoRecord: false }
      if (value.label !== undefined) answer.label = value.label.trim()
      if (value.mode !== undefined) answer.mode = value.mode
      if (value.sessionId !== undefined) answer.sessionId = value.sessionId
      return answer
    }
    return null
  },
  savedContext() {
    let saved = null
    try { saved = JSON.parse(this.read('voice-destination') || 'null') } catch (error) {}
    return this.context(saved)
  },
  openContext(value, id = null) {
    const context = this.context(value, id)
    if (!context || !this.save('voice-destination', JSON.stringify(context)) ||
        !this.save(isOrca ? 'orca-resume' : kind + '-resume', JSON.stringify({ screen: 'voice' }))) {
      this.show('Не удалось открыть', 'Контекст задачи не сохранён', [], [{ label: 'Назад', action: () => this.home() }])
      this.backAction = () => this.home()
      return
    }
    this.stopReading()
    ++this.generation
    replace({ url: 'page/voice' })
  },
  menu() {
    if (isClaude) this.save(kind + '-resume', JSON.stringify({ screen: 'home' }))
    else this.save('orca-resume', JSON.stringify({ screen: 'pair', pair: this.pair }))
    this.stopReading()
    ++this.generation
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
  validateDetail(reply, id, field, offset, limit = CHUNK_SIZE) {
    if (reply.id !== id || reply.field !== field || reply.offset !== offset || typeof reply.content !== 'string' ||
        !validOffset(reply.total) || typeof reply.deleted !== 'boolean' || typeof reply.complete !== 'boolean' ||
        !Number.isFinite(reply.created) || !STATES[reply.state]) throw new Error('Некорректный ответ')
    const end = offset + Array.from(reply.content).length
    if (Array.from(reply.content).length > limit || end > reply.total || reply.complete !== (end === reply.total) || (!reply.complete && end === offset)) {
      throw new Error('Неполный ответ')
    }
  },
  entry(id) {
    this.remember({ screen: 'entry', id })
    this.load(K.methods.detail, { id, field: 'text', offset: 0, limit: 600 }, (r, offline) => {
      this.validateDetail(r, id, 'text', 0)
      const terminal = ['completed', 'error', 'night'].includes(r.state)
      const activeContext = !offline && !terminal ? this.context(r.context, id) : null
      this.show(r.deleted ? 'В корзине' : 'Запись истории',
        `${stamp(r.created)} · ${STATES[r.state]}${offline ? '\nНет связи · сохранённое' : ''}`, [
          { label: K.question, action: () => this.detail(id, 'text') },
          { label: terminal ? K.answer : 'Открыть задачу', action: () => terminal ? this.detail(id, 'result') :
            activeContext ? this.openContext(activeContext, id) : this.contextError(id) },
          ...(terminal ? [{ label: r.deleted ? 'Восстановить' : 'В корзину', action: () => this.confirm(id, !r.deleted) }] : [])
        ], [{ label: 'Назад', action: () => this.backToList() }])
    }, () => this.backToList())
  },
  contextError(id) {
    this.show('Не удалось открыть', 'Mac не вернул точный контекст этой задачи', [], [
      { label: 'Назад', action: () => this.entry(id) }
    ])
    this.backAction = () => this.entry(id)
  },
  detail(id, field) {
    this.stopReading()
    const generation = ++this.generation
    this.remember({ screen: 'detail', id, field, offset: 0 })
    this.reader = { id, field, content: '', rows: [], offset: 0, total: null, created: null,
      deadline: Date.now() + READ_DEADLINE, offline: false, capped: false }
    this.items = []
    this.actions = [{ label: 'Назад', action: () => this.entry(id) }]
    this.heading.setProperty(prop.TEXT, field === 'text' ? K.question : K.answer)
    this.note.setProperty(prop.TEXT, 'Читаю с Mac…')
    this.body.setProperty(prop.VISIBLE, false)
    this.rows.forEach(row => row.setProperty(prop.VISIBLE, false))
    this.footer.forEach((row, index) => {
      row.setProperty(prop.VISIBLE, index === 0)
      if (index === 0) row.setProperty(prop.MORE, { ...this.footerMore[index], text: 'Назад' })
    })
    this.scroll.setProperty(prop.VISIBLE, true)
    this.scroll.setProperty(prop.UPDATE_DATA, { data_array: [{ display: '' }], data_count: 1, on_page: 0 })
    this.readChunk(generation)
  },
  async detailRequest(params, generation) {
    const key = K.methods.detail + ':' + JSON.stringify(params)
    try {
      const reply = await new Promise((resolve, reject) => {
        let settled = false
        const finish = (error, value) => {
          if (settled) return
          settled = true
          if (this.requestTimer != null) clearTimeout(this.requestTimer)
          this.requestTimer = null
          this.cancelRequest = null
          if (error) reject(error); else resolve(value)
        }
        this.cancelRequest = () => finish(new Error('CANCELED'))
        const remaining = Math.max(1, this.reader.deadline - Date.now())
        this.requestTimer = setTimeout(() => finish(new Error('Mac не ответил вовремя')), Math.min(18000, remaining))
        Promise.resolve().then(() => this.request({ method: K.methods.detail, params }, { timeout: 15000 }))
          .then(value => finish(null, value), error => finish(error))
      })
      if (this.closed || generation !== this.generation) return null
      if (!reply || reply.ok !== true) {
        const error = new Error(reply && reply.error || 'Нет ответа Mac')
        error.server = reply && reply.offline !== true
        if (error.server) {
          this.cache = this.cache.filter(x => x.key !== key)
          this.save(CACHE_KEY, JSON.stringify(this.cache))
        }
        throw error
      }
      return { reply, offline: false, key }
    } catch (error) {
      if (this.closed || generation !== this.generation || error.message === 'CANCELED') return null
      const hit = !error.server && this.cache.find(x => x.key === key)
      if (hit) return { reply: hit.reply, offline: true, key }
      throw error
    }
  },
  async readChunk(generation) {
    if (this.closed || generation !== this.generation || this.reading) return
    const reader = this.reader
    if (!reader || Date.now() >= reader.deadline) {
      this.readerError('Время чтения истекло', generation); return
    }
    this.reading = true
    const offset = reader.offset
    const limit = Math.min(CHUNK_SIZE, MAX_CONTENT - offset)
    try {
      const loaded = await this.detailRequest({ id: reader.id, field: reader.field, offset, limit }, generation)
      if (!loaded || this.closed || generation !== this.generation) return
      const { reply, offline, key } = loaded
      this.validateDetail(reply, reader.id, reader.field, offset, limit)
      if (reader.total !== null && reader.total !== reply.total) throw new Error('Ответ изменился. Откройте его заново.')
      const chars = Array.from(reply.content)
      const next = offset + chars.length
      if (next > MAX_CONTENT) throw new Error('Ответ превышает допустимый размер')
      reader.total = reply.total
      reader.created = reply.created
      reader.offline = reader.offline || offline
      reader.capped = reply.total > MAX_CONTENT
      reader.content += reply.content
      reader.offset = next
      reader.deadline = Date.now() + READ_DEADLINE
      this.reading = false
      if (!offline) {
        const cachedReply = { ...reply }; delete cachedReply.context
        const candidate = { key, reply: cachedReply }
        this.cache = this.cache.filter(x => x.key !== key)
        if (this.validCacheEntry(candidate)) this.cache.push(candidate)
        this.cache = this.cache.slice(-16)
        this.save(CACHE_KEY, JSON.stringify(this.cache))
      }
      const rows = textRows(offset ? reply.content : reader.content || 'Текст отсутствует', this.textWidth, this.textSize, getTextLayout, offset ? reader.rows : [])
      reader.rows = rows
      this.scroll.setProperty(prop.UPDATE_DATA, { data_array: rows, data_count: rows.length, on_page: offset ? 1 : 0 })
      const finished = reply.complete || next >= Math.min(reply.total, MAX_CONTENT)
      this.note.setProperty(prop.TEXT, finished
        ? reader.capped ? 'Предел 200 000 знаков · полный текст на Mac' : reader.offline ? 'Сохранённое · листайте вверх и вниз' : 'Весь текст · листайте вверх и вниз'
        : reader.offline ? 'Сохранённое · читаю продолжение…' : 'Читаю продолжение…')
      if (!finished) {
        this.continueTimer = setTimeout(() => {
          this.continueTimer = null
          if (!this.closed && generation === this.generation) this.readChunk(generation)
        }, 0)
      }
    } catch (error) {
      this.reading = false
      if (!this.closed && generation === this.generation) this.readerError(error.message || 'Нет связи с Mac', generation)
    }
  },
  readerError(message, generation) {
    if (this.closed || generation !== this.generation) return
    this.note.setProperty(prop.TEXT, this.reader && this.reader.content ? 'Продолжение не загружено' : String(message).slice(0, 100))
    this.actions = [{ label: 'Назад', action: () => this.entry(this.reader.id) }, null,
      { label: 'Повторить', action: () => {
        if (this.closed || generation !== this.generation) return
        this.reader.deadline = Date.now() + READ_DEADLINE
        this.footer[1].setProperty(prop.VISIBLE, false)
        this.footer[2].setProperty(prop.VISIBLE, false)
        this.note.setProperty(prop.TEXT, this.reader.content ? 'Читаю продолжение…' : 'Читаю с Mac…')
        this.readChunk(generation)
      } }]
    this.footer[1].setProperty(prop.VISIBLE, false)
    this.footer[2].setProperty(prop.VISIBLE, true)
    this.footer[2].setProperty(prop.MORE, { ...this.footerMore[2], text: 'Повторить' })
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
    if (isOrca || isClaude) {
      const saved = this.savedContext()
      if (saved) this.openContext(saved)
      else this.menu()
      return
    }
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
  onDestroy() {
    this.closed = true
    ++this.generation
    this.stopReading()
    try { offGesture(); offKey(); setStatusBarVisible(true) } catch (error) {}
  }
  }
}
