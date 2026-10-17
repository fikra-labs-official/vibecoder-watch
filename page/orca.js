import { createWidget, widget, align, text_style, prop, getTextLayout, setStatusBarVisible } from '@zos/ui'
import { getDeviceInfo } from '@zos/device'
import { replace } from '@zos/router'
import { LocalStorage } from '@zos/storage'
import { setWakeUpRelaunch } from '@zos/display'
import { onGesture, offGesture, GESTURE_RIGHT, onKey, offKey, KEY_BACK, KEY_EVENT_CLICK } from '@zos/interaction'
import { setTimeout, clearTimeout } from '@zos/timer'
import { BasePage } from '@zeppos/zml/base-page'
import { textRows } from '../shared/text-rows.js'

const CONTEXT_KEY = 'voice-destination'
const RESUME_KEY = 'orca-resume'
const COLOR = { bg: 0x0b0b0c, gold: 0xeac477, white: 0xf4eee3, muted: 0xb8ac99, surface: 0x28231d }
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256

Page(BasePage({
  build() {
    try { setStatusBarVisible(false) } catch (error) {}
    this.requests = new Set()
    const { width, height } = getDeviceInfo()
    this.width = width
    this.height = height
    this.scale = Math.min(width / 432, height / 514)
    this.px = value => Math.round(value * this.scale)
    this.margin = Math.max(18, Math.round(width * 0.055))
    this.controlHeight = Math.max(44, height >= 490 ? 52 : 48)
    this.bottom = height >= 490 ? 16 : 12
    this.closed = false
    this.sequence = 0
    this.generation = 0
    this.mutationPending = false
    this.storage = null
    try { this.storage = new LocalStorage() } catch (error) {}
    try { setWakeUpRelaunch({ relaunch: true }) } catch (error) {}

    const headingY = Math.max(34, this.px(52))
    const headingH = Math.max(30, this.px(38))
    const noteY = headingY + headingH + 2
    const noteH = Math.max(44, this.px(58))
    const footerY = height - this.bottom - this.controlHeight
    const menuTop = noteY + noteH + 10
    const menuBottom = footerY - 12
    const rowHeight = Math.max(44, this.px(52))
    const rowGap = Math.max(8, Math.floor((menuBottom - menuTop - rowHeight * 3) / 2))
    const contentWidth = width - this.margin * 2

    createWidget(widget.FILL_RECT, { x: 0, y: 0, w: width, h: height, color: COLOR.bg })
    this.headingLayout = { x: this.margin, y: headingY, w: contentWidth, h: headingH }
    this.heading = createWidget(widget.TEXT, {
      ...this.headingLayout, text_size: Math.max(21, this.px(25)), color: COLOR.gold,
      align_h: align.CENTER_H, text: 'Orca'
    })
    this.noteLayout = { x: this.margin, y: noteY, w: contentWidth, h: noteH }
    this.noteSize = Math.max(15, this.px(18))
    this.note = createWidget(widget.TEXT, {
      ...this.noteLayout, text_size: this.noteSize, color: COLOR.muted,
      align_h: align.CENTER_H, text_style: text_style.WRAP, text: ''
    })
    const noteRowHeight = Math.max(22, this.px(25))
    this.noteScroll = createWidget(widget.SCROLL_LIST, {
      ...this.noteLayout,
      item_space: 0, snap_to_center: false, item_enable_horizon_drag: false,
      item_config: [{
        type_id: 1, item_height: noteRowHeight, item_bg_color: COLOR.bg, item_bg_radius: 0,
        text_view: [{
          x: 4, y: 0, w: contentWidth - 8, h: noteRowHeight, key: 'display',
          color: COLOR.muted, text_size: this.noteSize, align_h: align.CENTER_H,
          text_style: text_style.WRAP
        }], text_view_count: 1
      }],
      item_config_count: 1, data_array: [{ display: '' }], data_count: 1,
      data_type_config: [{ start: 0, end: 0, type_id: 1 }], data_type_config_count: 1
    })
    this.noteScroll.setProperty(prop.VISIBLE, false)

    this.rowLayouts = [0, 1, 2].map(index => ({
      x: this.margin, y: menuTop + index * (rowHeight + rowGap), w: contentWidth, h: rowHeight
    }))
    this.rowTextSize = Math.max(17, this.px(20))
    this.rows = this.rowLayouts.map((layout, index) => createWidget(widget.BUTTON, {
      ...layout, radius: Math.max(9, this.px(11)), normal_color: COLOR.surface,
      press_color: 0x413629, color: COLOR.white, text_size: this.rowTextSize, text: '',
      click_func: () => {
        const action = this.items[index] && this.items[index].action
        if (typeof action === 'function') action()
      }
    }))

    const footerGap = 12
    const footerWidth = Math.floor((contentWidth - footerGap) / 2)
    this.backLayout = { x: this.margin, y: footerY, w: footerWidth, h: this.controlHeight }
    this.nextLayout = {
      x: width - this.margin - footerWidth, y: footerY, w: footerWidth, h: this.controlHeight
    }
    const button = (layout, text, action) => createWidget(widget.BUTTON, {
      ...layout, radius: Math.max(10, this.px(13)), normal_color: COLOR.surface,
      press_color: 0x413629, color: COLOR.gold, text_size: Math.max(18, this.px(22)), text,
      click_func: action
    })
    this.back = button(this.backLayout, 'Назад', () => this.goBack())
    this.next = button(this.nextLayout, 'Дальше', () => this.nextAction && this.nextAction())
    this.registerInteraction()
    if (!this.storage) {
      this.show('Память недоступна', 'Перезапустите приложение. Задачи не отправлены.', [], null)
      return
    }
    this.restore()
  },

  registerInteraction() {
    this.gestureCallback = gesture => gesture === GESTURE_RIGHT ? this.goBack() : false
    this.keyCallback = (key, event) => key === KEY_BACK && event === KEY_EVENT_CLICK ? this.goBack() : false
    try { onGesture({ callback: this.gestureCallback }) } catch (error) {}
    try { onKey({ callback: this.keyCallback }) } catch (error) {}
  },

  goBack() {
    if (this.mutationPending) return true
    if (typeof this.backAction !== 'function') return false
    this.backAction()
    return true
  },

  remember(value) {
    try { this.storage.setItem(RESUME_KEY, JSON.stringify(value)); return true } catch (error) { return false }
  },

  restore() {
    try {
      const saved = JSON.parse(this.storage.getItem(RESUME_KEY) || 'null')
      if (saved && saved.screen === 'operation' && saved.kind === 'provision' && validId(saved.id) &&
          saved.workspace && validId(saved.workspace.id)) {
        this.recoverOperation(saved)
        return
      }
      if (saved && saved.screen === 'operation' && saved.kind === 'quick' && validId(saved.id) &&
          saved.pair && validId(saved.pair.id) && saved.command && validId(saved.command.id)) {
        this.recoverQuick(saved)
        return
      }
      if (saved && saved.screen === 'voice') {
        const target = JSON.parse(this.storage.getItem(CONTEXT_KEY) || 'null')
        if (target && ((target.target === 'orca' && validId(target.pairId)) ||
            (target.target === 'folder' && validId(target.rootId)))) {
          replace({ url: 'page/voice' })
          return
        }
      }
      if (saved && saved.screen === 'history') {
        const pair = JSON.parse(this.storage.getItem('orca-history-pair') || 'null')
        if (pair && validId(pair.id)) { replace({ url: 'page/history' }); return }
      }
      if (saved && saved.screen === 'pair' && saved.pair && validId(saved.pair.id)) {
        this.pair(saved.pair)
        return
      }
      if (saved && saved.screen === 'project' && saved.workspace && validId(saved.workspace.id)) {
        this.project(saved.workspace)
        return
      }
    } catch (error) {}
    this.home()
  },

  setNote(value) {
    const note = String(value || '')
    const rows = textRows(note, this.noteLayout.w - 8, this.noteSize, getTextLayout)
    const data = rows.length ? rows : [{ display: ' ' }]
    const scroll = data.length > 2
    this.note.setProperty(prop.TEXT, note)
    this.note.setProperty(prop.VISIBLE, !scroll)
    this.noteScroll.setProperty(prop.VISIBLE, scroll)
    if (scroll) this.noteScroll.setProperty(prop.UPDATE_DATA, {
      data_array: data, data_count: data.length,
      data_type_config: [{ start: 0, end: data.length - 1, type_id: 1 }],
      data_type_config_count: 1, on_page: 0
    })
  },

  buttonCaption(value, layout) {
    const label = String(value || '').replace(/\s+/gu, ' ').trim()
    if (!label) return ''
    const width = Math.max(1, layout.w - 36)
    const rows = textRows(label, width, this.rowTextSize, getTextLayout)
    if (rows.length < 2) return rows[0] ? rows[0].display : ''
    let first = rows[0].text.trimEnd()
    while (first && textRows(`${first}…`, width, this.rowTextSize, getTextLayout).length > 1) {
      first = Array.from(first).slice(0, -1).join('').trimEnd()
    }
    return `${first}…`
  },

  show(title, note, items, back, next, generation, offset = 0) {
    if (this.closed) return
    if (generation == null) ++this.generation
    else if (generation !== this.generation) return
    const choices = Array.isArray(items) ? items : []
    const pageOffset = Number.isInteger(offset) && offset > 0 ? offset : 0
    this.items = choices.slice(pageOffset, pageOffset + 3)
    const visibleBack = pageOffset > 0
      ? () => this.show(title, note, choices, back, next, null, Math.max(0, pageOffset - 3))
      : back
    const visibleNext = pageOffset + 3 < choices.length
      ? () => this.show(title, note, choices, back, next, null, pageOffset + 3)
      : next
    this.heading.setProperty(prop.TEXT, String(title || 'Orca'))
    this.setNote(note)
    this.rows.forEach((row, index) => {
      const item = this.items[index]
      const layout = this.rowLayouts[index]
      row.setProperty(prop.MORE, { ...layout, text: item ? this.buttonCaption(item.label, layout) : '' })
      row.setProperty(prop.VISIBLE, Boolean(item))
    })
    this.backAction = visibleBack
    this.nextAction = visibleNext
    this.back.setProperty(prop.MORE, { ...this.backLayout, text: 'Назад' })
    this.next.setProperty(prop.MORE, { ...this.nextLayout, text: 'Дальше' })
    this.back.setProperty(prop.VISIBLE, typeof visibleBack === 'function')
    this.next.setProperty(prop.VISIBLE, typeof visibleNext === 'function')
  },

  boundedRequest(payload, options = {}) {
    return new Promise((resolve, reject) => {
      let settled = false, timer = null
      const finish = (error, reply) => {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        this.requests.delete(cancel)
        if (error) reject(error); else resolve(reply)
      }
      const cancel = () => finish(new Error('CANCELED'))
      this.requests.add(cancel)
      timer = setTimeout(() => finish(new Error('Mac не ответил вовремя')), (options.timeout || 15000) + 3000)
      Promise.resolve().then(() => this.request(payload, options))
        .then(reply => finish(null, reply), error => finish(error))
    })
  },

  async load(method, params, done, back) {
    const generation = ++this.generation
    this.show('Orca', 'Получаю данные с Mac…', [], back, null, generation)
    try {
      const reply = await this.boundedRequest({ method, params }, { timeout: 15000 })
      if (this.closed || generation !== this.generation) return
      if (!reply || !reply.ok) throw new Error(reply && reply.error || 'Нет ответа Orca')
      done(reply)
    } catch (error) {
      if (this.closed || generation !== this.generation) return
      this.show('Не удалось', String(error.message || error),
        [{ label: 'Обновить', action: () => this.load(method, params, done, back) }], back)
    }
  },

  cursorBack(trail, previous, parent) {
    if (!trail.length) return parent
    return () => previous(trail[trail.length - 1], trail.slice(0, -1))
  },

  pendingFolder() {
    try {
      const context = JSON.parse(this.storage.getItem(CONTEXT_KEY) || 'null')
      if (!context || context.target !== 'folder' || !validId(context.rootId)) return null
      if (validId(context.operationId) || context.answering === true) return context
      const key = `voice-draft:folder:${context.rootId}:`
      const draft = JSON.parse(this.storage.getItem(key) || 'null')
      if (draft && validId(draft.id) && typeof draft.text === 'string' && draft.text.trim()) return context
    } catch (error) {}
    return null
  },

  continueFolder(context) {
    const current = this.pendingFolder()
    if (!current || current.rootId !== context.rootId) { this.home(); return }
    this.voice(current)
  },

  home(page = 0) {
    this.mutationPending = false
    this.remember({ screen: 'home' })
    const pending = this.pendingFolder()
    if (page === 1) {
      this.show('Orca', 'Создание и незавершённые проекты', [
        ...(pending ? [{ label: 'Продолжить создание', action: () => this.continueFolder(pending) }] : []),
        { label: 'Новый проект', action: () => this.roots() }
      ], () => this.home(0))
    } else {
      this.show('Orca', 'Проекты и агенты на твоём Mac', [
        { label: 'Новая задача', action: () => this.newTask() },
        { label: 'Текущие проекты', action: () => this.projects() },
        { label: 'Мои связки', action: () => this.pairs() }
      ], null, () => this.home(1))
    }
    const generation = this.generation
    Promise.resolve().then(() => this.boundedRequest({ method: 'SUMMARY', params: {} }, { timeout: 8000 })).then(reply => {
      if (this.closed || generation !== this.generation) return
      if (!reply || !reply.ok || typeof reply.text !== 'string') throw new Error('Нет связи')
      this.setNote(reply.text)
    }).catch(() => {
      if (this.closed || generation !== this.generation) return
      this.show('Orca', 'Mac не ответил. Проверь Zepp и повтори связь.', [
        { label: 'Новая задача', action: () => this.newTask() },
        { label: 'Повторить связь', action: () => this.home(page) },
        { label: 'Текущие проекты', action: () => this.projects() },
        { label: 'Мои связки', action: () => this.pairs() }
      ], null, () => this.home(1))
    })
  },

  newTask(cursor, trail = []) {
    const back = this.cursorBack(trail,
      (previous, previousTrail) => this.newTask(previous, previousTrail), () => this.home())
    this.load('ORCA_PAIRS', { cursor, limit: 3 }, reply => {
      if (!reply.pairs.length && cursor == null) {
        this.show('Новая задача', 'Сначала выбери или создай связку для проекта.', [
          { label: 'Выбрать или создать связку', action: () => this.projects() }
        ], back)
        return
      }
      this.show('Новая задача', 'Выбери готовую связку', reply.pairs.map(pair => ({
        label: `${pair.projectLabel} · ${pair.workerAgent}/${pair.reviewerAgent}`,
        action: () => this.voice({
          target: 'orca', pairId: pair.id, label: pair.projectLabel,
          workerAgent: pair.workerAgent, reviewerAgent: pair.reviewerAgent,
          startFresh: true, autoRecord: false
        })
      })), back, reply.nextCursor
        ? () => this.newTask(reply.nextCursor, [...trail, cursor]) : null)
    }, back)
  },

  projects(cursor, trail = []) {
    const back = this.cursorBack(trail,
      (previous, previousTrail) => this.projects(previous, previousTrail), () => this.home())
    this.load('ORCA_LIST', { cursor, limit: 3 }, reply => this.show('Проекты', 'Выбери рабочий каталог',
      reply.workspaces.map(workspace => ({
        label: `${workspace.projectLabel} · ${workspace.name}`, action: () => this.project(workspace)
      })), back, reply.nextCursor
        ? () => this.projects(reply.nextCursor, [...trail, cursor]) : null), back)
  },

  project(workspace, page = 0) {
    this.mutationPending = false
    this.remember({ screen: 'project', workspace })
    this.workspace = workspace
    if (page === 1) {
      this.show(workspace.projectLabel, workspace.name, [
        { label: 'Репозиторий GitHub', action: () => this.github(workspace) }
      ], () => this.project(workspace, 0))
      return
    }
    this.show(workspace.projectLabel, workspace.name, [
      { label: 'Готовые связки', action: () => this.pairs(workspace) },
      { label: 'Выбрать два терминала', action: () => this.terminals(workspace, 'worker') },
      { label: 'Новая связка / агент', action: () => this.newAgentMenu(workspace) }
    ], () => this.projects(), () => this.project(workspace, 1))
  },

  github(workspace) {
    const note = `${workspace.projectLabel}\n${workspace.name}\nСоздать или подключить приватный репозиторий и отправить текущую ветку.`
    this.show('Приватный GitHub?', note, [
      { label: 'Продолжить приватно', action: () => {
        const id = `${Date.now()}-${++this.sequence}`
        this.dispatchOperation('ORCA_GITHUB_CREATE', { id, workspaceId: workspace.id }, workspace,
          () => this.project(workspace, 1))
      } }
    ], () => this.project(workspace, 1))
  },

  pairs(workspace, cursor, trail = []) {
    const parent = () => workspace ? this.project(workspace) : this.home()
    const back = this.cursorBack(trail,
      (previous, previousTrail) => this.pairs(workspace, previous, previousTrail), parent)
    this.load('ORCA_PAIRS', { workspaceId: workspace && workspace.id, cursor, limit: 3 }, reply => {
      this.show('Мои связки', reply.pairs.length ? 'Боевой + проверяющий' : 'Выбери проект и назначь роли',
        reply.pairs.map(pair => ({
          label: `${pair.projectLabel} · ${pair.workerAgent}/${pair.reviewerAgent}`,
          action: () => this.pair(pair)
        })), back, reply.nextCursor
          ? () => this.pairs(workspace, reply.nextCursor, [...trail, cursor]) : null)
    }, back)
  },

  terminals(workspace, role, worker, cursor, trail = []) {
    const parent = role === 'worker'
      ? () => this.project(workspace)
      : () => this.terminals(workspace, 'worker')
    const back = this.cursorBack(trail,
      (previous, previousTrail) => this.terminals(workspace, role, worker, previous, previousTrail), parent)
    this.load('ORCA_TERMINALS', { workspaceId: workspace.id, cursor, limit: 3 }, reply => {
      const choices = reply.terminals.filter(terminal => !worker || terminal.id !== worker.id)
      this.show(role === 'worker' ? 'Выбери боевого' : 'Проверяющий', workspace.projectLabel,
        choices.map(terminal => ({
          label: `${terminal.busy ? 'Занят · ' : ''}${terminal.title || terminal.agent}`,
          action: terminal.busy ? null : () => {
            if (role === 'worker') this.terminals(workspace, 'reviewer', terminal)
            else this.confirmPair(workspace, worker, terminal)
          }
        })), back, reply.nextCursor
          ? () => this.terminals(workspace, role, worker, reply.nextCursor, [...trail, cursor]) : null)
    }, back)
  },

  confirmPair(workspace, worker, reviewer) {
    const back = () => this.terminals(workspace, 'reviewer', worker)
    this.show('Назначить роли?', workspace.projectLabel, [
      { label: `Боевой: ${worker.title || worker.agent}`, action: () => this.terminals(workspace, 'worker') },
      { label: `Проверка: ${reviewer.title || reviewer.agent}`, action: back },
      { label: 'Сохранить связку', action: () => this.load('ORCA_BIND',
        { workspaceId: workspace.id, workerId: worker.id, reviewerId: reviewer.id },
        reply => this.pair(reply.pair), back) }
    ], back)
  },

  pair(pair, page = 0) {
    this.mutationPending = false
    this.remember({ screen: 'pair', pair })
    const context = role => ({
      target: 'orca', pairId: pair.id, label: pair.projectLabel,
      workerAgent: pair.workerAgent, reviewerAgent: pair.reviewerAgent,
      ...(role ? { askRole: role } : {})
    })
    const note = `${pair.projectLabel}\n${pair.workerAgent} → ${pair.reviewerAgent}`
    if (page === 1) {
      this.show('Связка Orca', note, [
        { label: 'История задач', action: () => this.history(pair) },
        { label: 'Быстрая команда', action: () => this.quick(pair) }
      ], () => this.pair(pair, 0))
      return
    }
    this.show('Связка Orca', note, [
      { label: 'Задать задачу / ответить', action: () => this.voice(context()) },
      { label: 'Спросить проверяющего', action: () => this.voice(context('reviewer')) },
      { label: 'Спросить боевого', action: () => this.voice(context('worker')) }
    ], () => this.pairs(), () => this.pair(pair, 1))
  },

  quick(pair, cursor, trail = []) {
    const back = this.cursorBack(trail,
      (previous, previousTrail) => this.quick(pair, previous, previousTrail), () => this.pair(pair))
    this.load('ORCA_QUICK_LIST', { cursor, limit: 3 }, reply => this.show(
      'Быстрая команда', pair.projectLabel,
      reply.commands.map(command => ({ label: command.label, action: () => this.confirmQuick(pair, command) })),
      back, reply.nextCursor ? () => this.quick(pair, reply.nextCursor, [...trail, cursor]) : null), back)
  },

  confirmQuick(pair, command) {
    this.show('Отправить связке?', `${pair.projectLabel}\n${command.label}`, [
      { label: 'Отправить', action: () => this.sendQuick(pair, command) }
    ], () => this.quick(pair))
  },

  sendQuick(pair, command) {
    const saved = { screen: 'operation', kind: 'quick', id: `${Date.now()}-${++this.sequence}`, pair, command }
    if (!this.remember(saved)) {
      this.show('Не удалось', 'Часы не сохранили ID команды. Отправка отменена.', [
        { label: 'Назад к связке', action: () => this.pair(pair) }
      ], () => this.confirmQuick(pair, command))
      return
    }
    this.dispatchQuick(saved)
  },

  async dispatchQuick(saved) {
    const generation = ++this.generation
    this.mutationPending = true
    this.show('Orca', 'Отправляю команду на Mac…', [], null, null, generation)
    try {
      const reply = await this.boundedRequest({ method: 'ORCA_SEND', params: {
        id: saved.id, pairId: saved.pair.id, presetId: saved.command.id
      } }, { timeout: 15000 })
      if (this.closed || generation !== this.generation) return
      this.mutationPending = false
      if (!reply || !reply.ok) throw new Error(reply && reply.error || 'Нет ответа Orca')
      if (!reply.job || reply.job.id !== saved.id) throw new Error('Некорректный ответ Orca')
      this.openQuickJob(saved, reply.job)
    } catch (error) {
      if (this.closed || generation !== this.generation) return
      this.mutationPending = false
      this.show('Ответ не получен', `${String(error.message || error)}\nID команды сохранён. Сначала проверь статус.`, [
        { label: 'Проверить отправку', action: () => this.recoverQuick(saved) }
      ], () => this.pair(saved.pair))
    }
  },

  async recoverQuick(saved) {
    const generation = ++this.generation
    this.mutationPending = false
    const back = () => this.pair(saved.pair)
    this.show('Orca', 'Проверяю сохранённую команду…', [], back, null, generation)
    try {
      const reply = await this.boundedRequest({ method: 'ORCA_JOB', params: { id: saved.id } }, { timeout: 15000 })
      if (this.closed || generation !== this.generation) return
      if (reply && reply.ok && reply.job && reply.job.id === saved.id) {
        this.openQuickJob(saved, reply.job)
        return
      }
      const message = reply && reply.error || 'Команда с этим ID не найдена'
      const notFound = !reply || reply.retryable === false || /не найден/iu.test(message)
      this.show(notFound ? 'Команда не найдена' : 'Не удалось проверить',
        `${message}\nКоманда автоматически не повторялась.`, notFound ? [
          { label: 'Отправить снова', action: () => this.dispatchQuick(saved) },
          { label: 'Проверить снова', action: () => this.recoverQuick(saved) }
        ] : [{ label: 'Проверить снова', action: () => this.recoverQuick(saved) }], back)
    } catch (error) {
      if (this.closed || generation !== this.generation) return
      this.show('Не удалось проверить', `${String(error.message || error)}\nКоманда автоматически не повторялась.`, [
        { label: 'Проверить снова', action: () => this.recoverQuick(saved) }
      ], back)
    }
  },

  openQuickJob(saved, job) {
    this.voice({
      target: 'orca', pairId: saved.pair.id, label: saved.pair.projectLabel,
      workerAgent: saved.pair.workerAgent || '', reviewerAgent: saved.pair.reviewerAgent || '',
      jobId: job.id, aliasId: job.id, resumeJob: true
    })
  },

  history(pair) {
    this.storage.setItem('orca-history-pair', JSON.stringify(pair))
    this.storage.setItem('orca-history-view', JSON.stringify({ screen: 'home' }))
    this.remember({ screen: 'history' })
    replace({ url: 'page/history' })
  },

  voice(context) {
    this.storage.setItem(CONTEXT_KEY, JSON.stringify(context))
    this.remember({ screen: 'voice' })
    replace({ url: 'page/voice' })
  },

  roots() {
    this.load('ORCA_ROOTS', {}, reply => this.show('Новый проект', 'Где создать папку?',
      reply.roots.map(root => ({
        label: root.label,
        action: () => this.voice({ target: 'folder', rootId: root.id, label: root.label })
      })), () => this.home()), () => this.home())
  },

  presets(workspace, cursor, trail = []) {
    const back = this.cursorBack(trail,
      (previous, previousTrail) => this.presets(workspace, previous, previousTrail),
      () => this.project(workspace))
    this.load('ORCA_PRESETS', { cursor, limit: 3 }, reply => this.show(
      'Новая связка', 'Модели: настройки Orca',
      reply.presets.map(preset => ({
        label: preset.label, action: () => this.models(workspace, preset, 'worker')
      })), back, reply.nextCursor
        ? () => this.presets(workspace, reply.nextCursor, [...trail, cursor]) : null), back)
  },

  newAgentMenu(workspace) {
    this.show('Новые агенты', workspace.projectLabel, [
      { label: 'Связка по шаблону', action: () => this.presets(workspace) },
      { label: 'Один новый агент', action: () => this.agents(workspace) }
    ], () => this.project(workspace))
  },

  agents(workspace, cursor, trail = []) {
    const back = this.cursorBack(trail,
      (previous, previousTrail) => this.agents(workspace, previous, previousTrail),
      () => this.newAgentMenu(workspace))
    this.load('ORCA_AGENTS', { cursor, limit: 3 }, reply => this.show(
      'Новый агент', 'Установленные клиенты Mac',
      reply.agents.map(agent => ({
        label: agent.label,
        action: () => this.models(workspace,
          { id: agent.id, label: agent.label, workerAgent: agent.id, single: true }, 'worker')
      })), back, reply.nextCursor
        ? () => this.agents(workspace, reply.nextCursor, [...trail, cursor]) : null), back)
  },

  models(workspace, preset, role, selected = {}, cursor, trail = []) {
    const parent = role === 'reviewer'
      ? () => this.models(workspace, preset, 'worker', selected)
      : () => preset.single ? this.agents(workspace) : this.presets(workspace)
    const back = this.cursorBack(trail,
      (previous, previousTrail) => this.models(workspace, preset, role, selected, previous, previousTrail), parent)
    const agent = role === 'worker' ? preset.workerAgent : preset.reviewerAgent
    this.load('ORCA_MODELS', { agent, cursor, limit: 3 }, reply => this.show(
      preset.single ? 'Модель агента' : role === 'worker' ? 'Модель боевого' : 'Модель проверки',
      preset.label,
      reply.models.map(model => ({ label: model.label, action: () => {
        const models = { ...selected, [role]: model.id }
        if (role === 'worker' && !preset.single) this.models(workspace, preset, 'reviewer', models)
        else this.modeChoice(workspace, preset, models)
      } })), back, reply.nextCursor
        ? () => this.models(workspace, preset, role, selected, reply.nextCursor, [...trail, cursor]) : null), back)
  },

  modeChoice(workspace, preset, models) {
    const back = () => preset.single
      ? this.models(workspace, preset, 'worker', models)
      : this.models(workspace, preset, 'reviewer', models)
    this.show(preset.single ? 'Режим агента' : 'Режим агентов',
      'Авто: агент действует сам, без вопросов', [
        { label: 'Авто, по умолчанию', action: () => this.createPair(workspace, preset, models, {}) },
        { label: 'Другой режим…', action: () => this.modes(workspace, preset, models, 'worker') }
      ], back)
  },

  modes(workspace, preset, models, role, selected = {}, cursor, trail = []) {
    const parent = role === 'reviewer'
      ? () => this.modes(workspace, preset, models, 'worker', selected)
      : () => this.modeChoice(workspace, preset, models)
    const back = this.cursorBack(trail,
      (previous, previousTrail) => this.modes(
        workspace, preset, models, role, selected, previous, previousTrail), parent)
    const agent = role === 'worker' ? preset.workerAgent : preset.reviewerAgent
    this.load('ORCA_MODES', { agent, cursor, limit: 3 }, reply => this.show(
      preset.single ? 'Режим агента' : role === 'worker' ? 'Режим боевого' : 'Режим проверки',
      preset.label,
      reply.modes.map(mode => ({ label: mode.label, action: () => {
        const modes = { ...selected, [role]: mode.id }
        if (role === 'worker' && !preset.single) this.modes(workspace, preset, models, 'reviewer', modes)
        else this.createPair(workspace, preset, models, modes)
      } })), back, reply.nextCursor
        ? () => this.modes(workspace, preset, models, role, selected, reply.nextCursor, [...trail, cursor]) : null), back)
  },

  createPair(workspace, preset, models, modes = {}) {
    const explicitModes = Object.keys(modes).length > 0
    const back = () => !explicitModes
      ? this.modeChoice(workspace, preset, models)
      : this.modes(workspace, preset, models, preset.single ? 'worker' : 'reviewer', modes)
    this.show(preset.single ? 'Открыть агента?' : 'Открыть связку?',
      `${workspace.projectLabel}\n${preset.label}`, [
        { label: 'Открыть на Mac', action: () => {
          const id = `${Date.now()}-${++this.sequence}`
          const method = preset.single ? 'ORCA_AGENT_CREATE' : 'ORCA_PAIR_CREATE'
          const params = preset.single
            ? { id, workspaceId: workspace.id, agent: preset.workerAgent,
              model: models.worker, mode: modes.worker || '' }
            : { id, workspaceId: workspace.id, presetId: preset.id, models, modes }
          this.dispatchOperation(method, params, workspace, back)
        } }
      ], back)
  },

  async dispatchOperation(method, params, workspace, back) {
    const saved = { screen: 'operation', kind: 'provision', id: params.id, method, workspace }
    if (!this.remember(saved)) {
      this.show('Не удалось', 'Часы не сохранили ID операции. Команда отменена.', [
        { label: 'Вернуться', action: back }
      ], back)
      return
    }
    const generation = ++this.generation
    this.mutationPending = true
    this.show('Orca', 'Отправляю операцию на Mac…', [], null, null, generation)
    try {
      const reply = await this.boundedRequest({ method, params }, { timeout: 15000 })
      if (this.closed || generation !== this.generation) return
      this.mutationPending = false
      if (!reply || !reply.ok) throw new Error(reply && reply.error || 'Нет ответа Orca')
      if (!reply.operation || reply.operation.id !== saved.id) throw new Error('Некорректный ответ Orca')
      this.provision(reply.operation, workspace, saved)
    } catch (error) {
      if (this.closed || generation !== this.generation) return
      this.mutationPending = false
      this.show('Ответ не получен', `${String(error.message || error)}\nID операции сохранён. Сначала проверь статус.`, [
        { label: 'Проверить операцию', action: () => this.recoverOperation(saved) }
      ], () => this.project(workspace))
    }
  },

  async recoverOperation(saved) {
    const generation = ++this.generation
    this.mutationPending = false
    const back = () => this.project(saved.workspace)
    this.show('Orca', 'Проверяю сохранённую операцию…', [], back, null, generation)
    try {
      const reply = await this.boundedRequest({ method: 'ORCA_OPERATION', params: { id: saved.id } }, { timeout: 15000 })
      if (this.closed || generation !== this.generation) return
      if (!reply || !reply.ok) {
        const message = reply && reply.error || 'Операция не найдена'
        this.show(reply && reply.code === 'OPERATION_NOT_FOUND' ? 'Операция не найдена' : 'Не удалось проверить',
          `${message}\nКоманда автоматически не повторялась.`, [
            { label: 'Проверить снова', action: () => this.recoverOperation(saved) }
          ], back)
        return
      }
      if (!reply.operation || reply.operation.id !== saved.id) throw new Error('Некорректный ответ Orca')
      this.provision(reply.operation, saved.workspace, saved)
    } catch (error) {
      if (this.closed || generation !== this.generation) return
      this.show('Не удалось проверить', `${String(error.message || error)}\nКоманда автоматически не повторялась.`, [
        { label: 'Проверить снова', action: () => this.recoverOperation(saved) }
      ], back)
    }
  },

  provision(operation, workspace, saved) {
    if (operation.state === 'completed' && operation.pair) {
      this.pair(operation.pair)
      return
    }
    if (operation.state === 'completed') {
      this.show(operation.github ? 'GitHub' : 'Агент открыт',
        operation.message || workspace.projectLabel, [
          { label: 'К проекту', action: () => this.project(workspace) }
        ], () => this.project(workspace))
      return
    }
    const resume = saved || {
      screen: 'operation', kind: 'provision', id: operation.id, workspace
    }
    this.remember(resume)
    const failed = operation.state === 'error' || operation.state === 'unknown' || operation.state === 'cancelled'
    this.show(failed ? 'Нужен Mac' : 'Открываю связку',
      operation.message || 'Создание выполняется на Mac', [
        { label: 'Проверить', action: () => this.recoverOperation(resume) }
      ], () => this.project(workspace))
  },

  onDestroy() {
    this.closed = true
    ++this.generation
    for (const cancel of this.requests) cancel()
    try { setStatusBarVisible(true) } catch (error) {}
    try { offGesture() } catch (error) {}
    try { offKey() } catch (error) {}
  }
}))
