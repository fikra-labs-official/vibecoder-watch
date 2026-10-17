import { createWidget, widget, align, text_style, prop, getTextLayout, setStatusBarVisible } from '@zos/ui'
import { getDeviceInfo } from '@zos/device'
import { replace, back as routerBack } from '@zos/router'
import { LocalStorage } from '@zos/storage'
import { setWakeUpRelaunch } from '@zos/display'
import { setTimeout, clearTimeout } from '@zos/timer'
import { onGesture, offGesture, GESTURE_RIGHT, onKey, offKey, KEY_BACK, KEY_EVENT_CLICK } from '@zos/interaction'
import { textRows } from './text-rows.js'
const CONTEXT_KEY = 'voice-destination'
const MODE_LABELS = {
  claude: { auto: 'Авто', acceptEdits: 'Автоправки', plan: 'План', bypass: 'Без ограничений', default: 'Без правок' },
  codex: { auto: 'Авто', 'read-only': 'Только чтение', bypass: 'Без ограничений' }
}
const WATCH_STATES = { ok: 'в порядке', down: 'упало', unknown: 'не проверено' }
const COLOR = { bg: 0x0b0b0c, gold: 0xeac477, white: 0xf4eee3, muted: 0xb8ac99, surface: 0x28231d }
// One project menu for the headless agent apps (Claude, Codex): projects → task / mode / session.
export function createAgentMenuPage({ kind, title }) {
  const PREFIX = kind.toUpperCase()
  const RESUME_KEY = kind + '-resume'
  const MODE_KEY = kind + '-mode'
  const MODES = MODE_LABELS[kind] || MODE_LABELS.claude
  return {
  build() {
    const { width, height } = getDeviceInfo()
    this.px = value => Math.round(value * Math.min(width / 390, height / 450))
    const px = this.px
    this.closed = false
    this.sequence = 0
    this.generation = 0
    this.mutationPending = false
    this.deadlineTimers = new Set()
    this.storage = null
    try { this.storage = new LocalStorage() } catch (error) {}
    try { setWakeUpRelaunch({ relaunch: true }) } catch (error) {}
    try { setStatusBarVisible(false) } catch (error) {}
    createWidget(widget.FILL_RECT, { x: 0, y: 0, w: width, h: height, color: COLOR.bg })
    this.heading = createWidget(widget.TEXT, { x: px(24), y: px(55), w: width - px(48), h: px(39),
      text_size: px(24), color: COLOR.gold, align_h: align.CENTER_H, text: title })
    this.noteLayout = { x: px(24), y: px(96), w: width - px(48), h: px(54) }
    this.note = createWidget(widget.TEXT, { x: px(24), y: px(96), w: width - px(48), h: px(54),
      text_size: px(17), color: COLOR.muted, align_h: align.CENTER_H, text_style: text_style.WRAP, text: '' })
    const noteRowHeight = Math.max(22, px(24))
    this.noteScroll = createWidget(widget.SCROLL_LIST, {
      ...this.noteLayout,
      item_config: [{ type_id: 1, item_height: noteRowHeight, item_bg_color: COLOR.bg, item_bg_radius: 0,
        text_view: [{ x: 0, y: 0, w: this.noteLayout.w, h: noteRowHeight, key: 'display',
          color: COLOR.muted, text_size: px(17), align_h: align.CENTER_H, align_v: align.CENTER_V,
          text_style: text_style.WRAP }], text_view_count: 1 }],
      item_config_count: 1, data_array: [{ display: '' }], data_count: 1,
      data_type_config: [{ start: 0, end: 0, type_id: 1 }], data_type_config_count: 1,
      snap_to_center: false, item_enable_horizon_drag: false
    })
    this.noteScroll.setProperty(prop.VISIBLE, false)
    const listY = px(158)
    const footerY = px(369)
    const rowHeight = Math.max(44, px(54))
    this.menuLayout = { x: px(24), y: listY, w: width - px(48), h: Math.max(rowHeight, footerY - listY - px(8)) }
    this.menuList = createWidget(widget.SCROLL_LIST, {
      ...this.menuLayout,
      item_config: [{ type_id: 1, item_height: rowHeight, item_bg_color: COLOR.surface, item_bg_radius: px(10),
        text_view: [{ x: px(10), y: 0, w: this.menuLayout.w - px(20), h: rowHeight, key: 'label', action: true,
          color: COLOR.white, text_size: px(18), align_h: align.CENTER_H, align_v: align.CENTER_V,
          text_style: text_style.WRAP }], text_view_count: 1 }],
      item_config_count: 1, data_array: [{ label: '' }], data_count: 1,
      data_type_config: [{ start: 0, end: 0, type_id: 1 }], data_type_config_count: 1,
      snap_to_center: false, item_enable_horizon_drag: false,
      item_click_func: (_list, index) => this.items[index] && this.items[index].action()
    })
    const button = (x, w, text, action) => {
      const layout = { x: px(x), y: footerY, w: px(w), h: Math.max(44, px(50)) }
      return { layout, widget: createWidget(widget.BUTTON, { ...layout, radius: px(12), normal_color: COLOR.surface,
      press_color: 0x413629, color: COLOR.gold, text_size: px(21), text, click_func: action
      }) }
    }
    const back = button(24, 144, 'Назад', () => this.goBack())
    const next = button(222, 144, 'Дальше', () => this.nextAction && this.nextAction())
    this.back = back.widget
    this.backLayout = back.layout
    this.next = next.widget
    this.nextLayout = next.layout
    this.registerInteraction()
    if (this.storage) this.restore()
    else this.storageFailure()
  },
  storageFailure() {
    this.show('Не удалось', 'Хранилище часов недоступно. Задачи не будут отправлены.', [
      { label: 'Повторить', action: () => this.retryStorage() },
      { label: 'Выйти', action: () => routerBack() }
    ], null)
  },
  retryStorage() {
    try { this.storage = new LocalStorage() } catch (error) { this.storage = null }
    if (this.storage) this.restore()
    else this.storageFailure()
  },
  cancelDeadlines() {
    for (const timer of this.deadlineTimers) clearTimeout(timer)
    this.deadlineTimers.clear()
  },
  requestWithDeadline(payload, options, deadline) {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (callback, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.deadlineTimers.delete(timer)
        callback(value)
      }
      const timer = setTimeout(() => finish(reject, new Error('Мас не ответил вовремя.')), deadline)
      this.deadlineTimers.add(timer)
      Promise.resolve().then(() => this.request(payload, options)).then(
        value => finish(resolve, value), error => finish(reject, error))
    })
  },
  remember(value) {
    try { this.storage.setItem(RESUME_KEY, JSON.stringify(value)) } catch (error) {}
  },
  mode(projectId) {
    let saved = null
    try { saved = this.storage.getItem(projectId ? MODE_KEY + ':' + projectId : MODE_KEY) } catch (error) {}
    return MODES[saved] ? saved : 'auto'
  },
  setMode(project, mode) {
    try { this.storage.setItem(MODE_KEY + ':' + project.id, mode.id) } catch (error) {
      this.show('Не удалось', 'Часы не сохранили режим', [
        { label: 'Повторить', action: () => this.setMode(project, mode) }
      ], () => this.modes(project))
      return
    }
    this.project(project)
  },
  chooseMode(project, mode) {
    if (mode.id !== 'bypass') { this.setMode(project, mode); return }
    this.show('Без ограничений?', `Полный доступ только для проекта\n${project.label}`, [
      { label: 'Отмена', action: () => this.modes(project) },
      { label: 'Включить полный доступ', action: () => this.setMode(project, mode) }
    ], () => this.modes(project))
  },
  registerInteraction() {
    this.gestureCallback = gesture => gesture === GESTURE_RIGHT ? this.goBack() : false
    this.keyCallback = (key, event) => key === KEY_BACK && event === KEY_EVENT_CLICK ? this.goBack() : false
    try { onGesture({ callback: this.gestureCallback }) } catch (error) {}
    try { onKey({ callback: this.keyCallback }) } catch (error) {}
  },
  goBack() {
    if (this.mutationPending) return true
    if (!this.backAction) return false
    this.backAction()
    return true
  },
  pageBack(loadPage, parent, cursor, trail) {
    return trail.length ? () => loadPage(trail[trail.length - 1], trail.slice(0, -1)) : parent
  },
  pageNext(loadPage, cursor, trail, nextCursor) {
    return nextCursor == null ? null : () => loadPage(nextCursor, [...trail, cursor])
  },
  restore() {
    try {
      const saved = JSON.parse(this.storage.getItem(RESUME_KEY) || 'null')
      if (saved && saved.screen === 'voice') {
        const target = JSON.parse(this.storage.getItem(CONTEXT_KEY) || 'null')
        if (target && target.target === kind && typeof target.project === 'string' && target.project) {
          replace({ url: 'page/voice' }); return
        }
      }
      if (saved && saved.screen === 'history') { replace({ url: 'page/history' }); return }
      if (saved && saved.screen === 'night') { this.night(); return }
      if (saved && saved.screen === 'question' && typeof saved.jobId === 'string' && typeof saved.approvalId === 'string' &&
          Array.isArray(saved.options) && saved.options.length) { this.question(saved); return }
      if (saved && saved.screen === 'watches') { this.watches(); return }
      if (saved && saved.screen === 'project' && saved.project && typeof saved.project.id === 'string') {
        this.project(saved.project); return
      }
    } catch (error) {}
    this.home()
  },
  show(title, note, items, back, next, generation) {
    if (this.closed) return
    if (generation == null) { this.cancelDeadlines(); ++this.generation }
    else if (generation !== this.generation) return
    this.items = items
    this.heading.setProperty(prop.TEXT, title)
    const noteText = String(note || '')
    const noteData = textRows(noteText, this.noteLayout.w, Math.max(17, this.px(17)), getTextLayout)
    const scrollNote = noteData.length > 2
    this.note.setProperty(prop.TEXT, noteText)
    this.note.setProperty(prop.VISIBLE, !scrollNote)
    this.noteScroll.setProperty(prop.VISIBLE, scrollNote)
    if (scrollNote) this.noteScroll.setProperty(prop.UPDATE_DATA, {
      data_array: noteData, data_count: noteData.length,
      data_type_config: [{ start: 0, end: noteData.length - 1, type_id: 1 }], data_type_config_count: 1, on_page: 0
    })
    const menuData = items.map(item => ({ label: String(item.label == null ? '' : item.label) }))
    this.menuList.setProperty(prop.UPDATE_DATA, {
      data_array: menuData, data_count: menuData.length,
      data_type_config: [{ start: 0, end: Math.max(0, menuData.length - 1), type_id: 1 }], data_type_config_count: 1, on_page: 0
    })
    this.menuList.setProperty(prop.VISIBLE, Boolean(menuData.length))
    this.backAction = back
    this.nextAction = next
    this.back.setProperty(prop.MORE, { ...this.backLayout, text: 'Назад' })
    this.next.setProperty(prop.MORE, { ...this.nextLayout, text: 'Дальше' })
    this.back.setProperty(prop.VISIBLE, Boolean(back))
    this.next.setProperty(prop.VISIBLE, Boolean(next))
  },
  async load(method, params, done, back, mutation = false, rejected = null) {
    this.cancelDeadlines()
    const generation = ++this.generation
    this.mutationPending = mutation
    this.show(title, mutation ? 'Отправляю на Mac…' : 'Получаю данные с Mac…', [], mutation ? null : back, null, generation)
    try {
      const reply = await this.requestWithDeadline({ method, params }, { timeout: 15000 }, 18000)
      if (this.closed || generation !== this.generation) return
      if (!reply || !reply.ok) {
        const failure = new Error(reply && reply.error || `Нет ответа ${title}`)
        failure.retryable = reply && reply.retryable
        throw failure
      }
      this.mutationPending = false
      done(reply)
    } catch (error) {
      if (this.closed || generation !== this.generation) return
      this.mutationPending = false
      if (mutation && error.retryable === false && rejected) {
        rejected(error)
        return
      }
      const reconcile = () => { if (back) back() }
      this.show('Не удалось', String(error.message || error), mutation
        ? [{ label: error.retryable === false ? 'Вернуться' : 'Проверить статус', action: reconcile }]
        : [{ label: 'Обновить', action: () => this.load(method, params, done, back, false) }], back)
    }
  },
  renderHome(note, failed = false) {
    this.remember({ screen: 'home' })
    this.show(title, note, failed ? [
      { label: 'Повторить связь', action: () => { this.renderHome('Проверяю Mac…'); this.summarize() } },
      { label: 'Проекты', action: () => this.projects() },
      { label: 'История', action: () => this.history() }
    ] : [
      { label: 'Проекты', action: () => this.projects() },
      { label: 'Последняя задача', action: () => this.lastTask() },
      { label: 'История', action: () => this.history() }
    ], null, () => this.more())
  },
  home() {
    this.renderHome(`${title} в проектах на Mac`)
    this.summarize()
  },
  summarize() {
    // One line across all agents: what runs, what waits for a tap, what finished today.
    const generation = this.generation
    Promise.resolve().then(() => {
      if (this.closed || generation !== this.generation) return null
      return this.requestWithDeadline({ method: 'SUMMARY', params: {} }, { timeout: 8000 }, 10000)
    }).then(reply => {
      if (this.closed || generation !== this.generation) return
      if (!reply || !reply.ok || typeof reply.text !== 'string') throw new Error(reply && reply.error || 'Mac не ответил')
      if (this.closed || generation !== this.generation) return
      this.renderHome(reply.text)
    }).catch(() => {
      if (this.closed || generation !== this.generation) return
      this.renderHome('Mac не ответил. Проверь Zepp и повтори связь.', true)
    })
  },
  // An agent question with options: the full choice is shown for confirmation before it reaches the bridge.
  question(saved, offset = 0) {
    const back = () => { this.remember({ screen: 'voice' }); replace({ url: 'page/voice' }) }
    const options = saved.options.slice(offset, offset + 3)
    this.show(`Вопрос от ${title}`, String(saved.question || ''), options.map(option => ({ label: String(option),
      action: () => this.confirmAnswer(saved, option, offset) })),
    offset ? () => this.question(saved, offset - 3) : back, offset + 3 < saved.options.length ? () => this.question(saved, offset + 3) : null)
  },
  confirmAnswer(saved, option, offset) {
    const voice = () => { this.remember({ screen: 'voice' }); replace({ url: 'page/voice' }) }
    this.show('Ответить так?', String(option), [
      { label: 'Отмена', action: () => this.question(saved, offset) },
      { label: 'Ответить', action: () => this.load(PREFIX + '_APPROVE',
        { id: saved.jobId, approvalId: saved.approvalId, allow: true, answer: option }, voice, voice, true) }
    ], () => this.question(saved, offset))
  },
  more() {
    this.remember({ screen: 'home' })
    this.show(title, 'Очередь на ночь, исследования, Дозор', [
      { label: 'Ночная смена', action: () => this.night() },
      { label: 'Исследование', action: () => this.research() },
      { label: 'Дозор', action: () => this.watches() }
    ], () => this.home())
  },
  // Watchdog: standing checks of sites and project CI; only a change of state is announced.
  watches(cursor, trail = []) {
    this.remember({ screen: 'watches' })
    this.load('WATCH_LIST', { cursor, limit: 2 }, reply => {
      this.show('Дозор', reply.count ? `Проверок: ${reply.count}` : 'Пока ничего не сторожу', [
        { label: 'Добавить', action: () => this.addWatch() },
        ...reply.items.map(w => ({ label: `${w.label} · ${WATCH_STATES[w.state] || w.state}`, action: () => this.watchItem(w) }))
      ], this.pageBack((next, prior) => this.watches(next, prior), () => this.more(), cursor, trail),
      this.pageNext((next, prior) => this.watches(next, prior), cursor, trail, reply.nextCursor))
    }, () => this.more())
  },
  addWatch() {
    this.show('Дозор', 'Что сторожить?', [
      { label: 'Сайт голосом', action: () => this.voice({ target: kind, project: 'watch', label: 'Дозор', mode: this.mode('watch'),
        modeLabel: 'Адрес сайта словами', kind: 'watch', startFresh: true }) },
      { label: 'CI проекта…', action: () => this.watchProjects() }
    ], () => this.watches())
  },
  watchProjects(cursor, trail = []) {
    this.load(PREFIX + '_PROJECTS', { cursor, limit: 3 }, reply => this.show('CI проекта', 'GitHub Actions по origin',
      reply.projects.map(project => ({ label: project.label, action: () => this.load('WATCH_ADD',
        { kind: 'ci', project: project.id, label: project.label }, () => this.watches(), () => this.watches(), true) })),
      this.pageBack((next, prior) => this.watchProjects(next, prior), () => this.addWatch(), cursor, trail),
      this.pageNext((next, prior) => this.watchProjects(next, prior), cursor, trail, reply.nextCursor)), () => this.addWatch())
  },
  watchItem(w) {
    this.show(w.label, `${WATCH_STATES[w.state] || w.state}\n${w.detail || ''}`, [
      { label: 'Проверить', action: () => this.load('WATCH_CHECK', { id: w.id }, reply => this.watchItem(reply.watch), () => this.watches(), true) },
      { label: 'Убрать', action: () => this.load('WATCH_REMOVE', { id: w.id }, () => this.watches(), () => this.watches(), true) }
    ], () => this.watches())
  },
  // Quick web research: the topic is dictated, the summary comes back here, the full report goes to Telegram.
  research() {
    const other = kind === 'claude' ? 'Codex' : 'Claude'
    const go = (both, deep) => this.voice({ target: kind, project: 'research', label: 'Исследование', mode: this.mode('research'),
      modeLabel: deep ? `Большое · ${title}` : both ? `${title} + ${other}` : title, kind: deep ? 'deep' : 'research', both,
      startFresh: true })
    this.show('Исследование', 'Тему скажи голосом. Полный отчёт придёт файлом в Telegram', [
      { label: `Быстрое: ${title}`, action: () => go(false, false) },
      { label: `Быстрое: ${title} + ${other}`, action: () => go(true, false) },
      // The bundled deep-research workflow exists only in Claude Code: ~100 agents, 10–15 minutes.
      ...(kind === 'claude' ? [{ label: 'Большое: Claude', action: () => go(false, true) }] : [])
    ], () => this.more())
  },
  // Night shift: dictated tasks wait and run one after another while the owner sleeps.
  night(cursor, trail = []) {
    this.remember({ screen: 'night' })
    this.load(PREFIX + '_NIGHT', { cursor, limit: 2 }, reply => {
      const when = reply.active ? 'Идёт сейчас' : reply.at ? `Старт в ${reply.at}` : 'Старт вручную'
      const control = reply.active ? { label: 'Остановить смену', action: () => this.confirmNightStop() }
        : reply.count ? { label: 'Запустить сейчас', action: () => this.nightCommand('_NIGHT_RUN') }
          : { label: 'Добавить задачу', action: () => this.projects() }
      this.show('Ночная смена', `${when} · задач: ${reply.count}`, [control,
        ...reply.jobs.map(job => ({ label: `${job.projectLabel} · ${job.text}`, action: () => this.nightJob(job) }))],
      this.pageBack((next, prior) => this.night(next, prior), () => this.home(), cursor, trail),
      this.pageNext((next, prior) => this.night(next, prior), cursor, trail, reply.nextCursor))
    }, () => this.home())
  },
  nightCommand(method) {
    this.load(PREFIX + method, {}, () => this.night(), () => this.night(), true)
  },
  confirmNightStop() {
    this.show('Остановить смену?', 'Текущая задача остановится. Остальные останутся в очереди.', [
      { label: 'Отмена', action: () => this.night() },
      { label: 'Остановить', action: () => this.nightCommand('_NIGHT_STOP') }
    ], () => this.night())
  },
  nightJob(job) {
    this.show(job.projectLabel, job.text, [
      { label: 'Убрать из смены', action: () => this.load(PREFIX + '_HISTORY_SET_DELETED', { id: job.id, deleted: true },
        () => this.night(), () => this.night(), true) }
    ], () => this.night())
  },
  projects(cursor, trail = []) {
    this.load(PREFIX + '_PROJECTS', { cursor, limit: 3 }, reply => this.show('Проекты', `Папки с сессиями ${title}`,
      reply.projects.map(project => ({ label: project.label, action: () => this.project(project) })),
      this.pageBack((next, prior) => this.projects(next, prior), () => this.home(), cursor, trail),
      this.pageNext((next, prior) => this.projects(next, prior), cursor, trail, reply.nextCursor)), () => this.home())
  },
  project(project) {
    this.remember({ screen: 'project', project: { id: project.id, label: project.label } })
    const mode = this.mode(project.id)
    this.show(project.label, project.id, [
      { label: 'Задача / вопрос', action: () => this.voice({ target: kind, project: project.id, label: project.label,
        mode, modeLabel: MODES[mode], startFresh: true }) },
      { label: `Режим: ${MODES[mode]}`, action: () => this.modes(project) },
      { label: 'Продолжить сессию…', action: () => this.sessions(project) }
    ], () => this.projects(), () => this.projectMore(project))
  },
  projectMore(project, cursor, trail = []) {
    // Night queue plus read-only investigation presets («Что упало?», «Статус проекта»), no dictation needed.
    this.load(PREFIX + '_QUICK_LIST', { cursor, limit: 2 }, reply => this.show(project.label,
      cursor ? 'Быстрые команды' : 'Ночная смена и быстрые команды', [
        ...(cursor ? [] : [{ label: 'В ночную смену', action: () => this.voice({ target: kind, project: project.id, label: project.label,
          mode: this.mode(project.id), modeLabel: `${MODES[this.mode(project.id)]} · ночью`, night: true, startFresh: true }) }]),
        ...reply.items.map(preset => ({ label: preset.arg === 'pr' ? preset.label + '…' : preset.label,
          action: () => preset.arg === 'pr' ? this.reviewMenu(project, preset) : this.runPreset(project, preset) }))
      ], this.pageBack((next, prior) => this.projectMore(project, next, prior), () => this.project(project), cursor, trail),
      this.pageNext((next, prior) => this.projectMore(project, next, prior), cursor, trail, reply.nextCursor)),
    () => this.project(project))
  },
  // PR review: pick an open pull request of the project's origin, or say its number.
  reviewMenu(project, preset, cursor, trail = []) {
    this.load(PREFIX + '_PRS', { project: project.id, cursor, limit: 2 }, reply => this.show(preset.label,
      reply.items.length ? `Открытые PR · ${reply.repo}` : `Открытых PR нет · ${reply.repo}`, [
        ...(cursor ? [] : [{ label: 'Номер голосом', action: () => this.voice({ target: kind, project: project.id, label: project.label,
          mode: this.mode(project.id), modeLabel: 'Скажи номер PR', presetId: preset.id, startFresh: true }) }]),
        ...reply.items.map(pr => ({ label: `#${pr.number} · ${pr.title}`, action: () => this.runPreset(project, preset, { pr: pr.number }) }))
      ], this.pageBack((next, prior) => this.reviewMenu(project, preset, next, prior), () => this.projectMore(project), cursor, trail),
      this.pageNext((next, prior) => this.reviewMenu(project, preset, next, prior), cursor, trail, reply.nextCursor)),
    () => this.projectMore(project))
  },
  runPreset(project, preset, extra = {}) {
    // One id per tap: a retry after a lost receipt returns the same job instead of a second one.
    const id = `${Date.now()}-${++this.sequence}`
    const mode = this.mode(project.id)
    const pending = { target: kind, project: project.id, label: project.label, mode,
      modeLabel: extra.pr ? `${preset.label} #${extra.pr}` : preset.label,
      jobId: id, aliasId: id, pendingSend: true, resumeJob: true }
    try {
      this.storage.setItem(CONTEXT_KEY, JSON.stringify(pending))
      this.remember({ screen: 'voice' })
    } catch (error) {
      this.show('Не удалось', 'Часы не сохранили задачу. Она не отправлена.', [
        { label: 'Повторить', action: () => this.runPreset(project, preset, extra) }
      ], () => this.projectMore(project))
      return
    }
    const reconcile = () => { this.remember({ screen: 'voice' }); replace({ url: 'page/voice' }) }
    this.load(PREFIX + '_SEND', { id, project: project.id, mode, presetId: preset.id, ...extra }, reply => {
      if (!reply.job || reply.job.id !== id) throw new Error(`Некорректный ответ ${title}`)
      this.voice({ ...pending, jobId: reply.job.id, aliasId: reply.job.id, pendingSend: false, resumeJob: true })
    }, reconcile, true, error => {
      let current = null
      try { current = JSON.parse(this.storage.getItem(CONTEXT_KEY) || 'null') } catch (readError) {}
      if (current && current.target === kind && current.jobId === id && current.pendingSend === true) {
        try { this.storage.setItem(CONTEXT_KEY, '') } catch (writeError) {}
      }
      this.remember({ screen: 'project', project: { id: project.id, label: project.label } })
      this.show('Не удалось', String(error.message || error), [
        { label: 'Вернуться к командам', action: () => this.projectMore(project) }
      ], () => this.projectMore(project))
    })
  },
  modes(project, cursor, trail = []) {
    // Permission mode for headless runs: prompts that would ask a human are denied and reported.
    this.load(PREFIX + '_MODES', { cursor, limit: 3 }, reply => this.show(`Режим ${title}`, project.label,
      reply.modes.map(mode => ({ label: mode.label, action: () => {
        this.chooseMode(project, mode)
      } })), this.pageBack((next, prior) => this.modes(project, next, prior), () => this.project(project), cursor, trail),
      this.pageNext((next, prior) => this.modes(project, next, prior), cursor, trail, reply.nextCursor)),
    () => this.project(project))
  },
  sessions(project, cursor, trail = []) {
    this.load(PREFIX + '_SESSIONS', { project: project.id, cursor, limit: 3 }, reply => this.show('Сессии', project.label,
      reply.sessions.map(session => ({ label: session.label, action: () => this.voice({ target: kind,
        project: project.id, label: project.label, mode: this.mode(project.id), modeLabel: MODES[this.mode(project.id)],
        sessionId: session.id, startFresh: true }) })),
      this.pageBack((next, prior) => this.sessions(project, next, prior), () => this.project(project), cursor, trail),
      this.pageNext((next, prior) => this.sessions(project, next, prior), cursor, trail, reply.nextCursor)),
    () => this.project(project))
  },
  lastTask() {
    let saved = null
    try { saved = JSON.parse(this.storage.getItem(CONTEXT_KEY) || 'null') } catch (error) {}
    if (saved && saved.target === kind && typeof saved.project === 'string' && saved.project &&
        typeof saved.jobId === 'string' && saved.jobId) {
      saved.resumeJob = true
      saved.startFresh = false
      this.remember({ screen: 'voice' })
      try { this.storage.setItem(CONTEXT_KEY, JSON.stringify(saved)) } catch (error) {
        this.show('Не удалось', 'Часы не открыли последнюю задачу', [
          { label: 'Повторить', action: () => this.lastTask() }
        ], () => this.home())
        return
      }
      replace({ url: 'page/voice' })
      return
    }
    this.projects()
  },
  history() {
    try { this.storage.setItem(kind + '-history-view', JSON.stringify({ screen: 'home' })) } catch (error) {}
    this.remember({ screen: 'history' })
    replace({ url: 'page/history' })
  },
  voice(context) {
    try {
      this.storage.setItem(CONTEXT_KEY, JSON.stringify(context))
      this.remember({ screen: 'voice' })
      replace({ url: 'page/voice' })
    } catch (error) {
      this.show('Не удалось', 'Часы не сохранили выбранную задачу', [
        { label: 'Повторить', action: () => this.voice(context) }
      ], () => this.home())
    }
  },
  onDestroy() {
    this.closed = true
    ++this.generation
    this.cancelDeadlines()
    try { offGesture() } catch (error) {}
    try { offKey() } catch (error) {}
    try { setStatusBarVisible(true) } catch (error) {}
  }
  }
}
