import { createWidget, widget, align, text_style, prop } from '@zos/ui'
import { getDeviceInfo } from '@zos/device'
import { replace } from '@zos/router'
import { LocalStorage } from '@zos/storage'
import { setWakeUpRelaunch } from '@zos/display'
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
    this.storage = new LocalStorage()
    try { setWakeUpRelaunch({ relaunch: true }) } catch (error) {}
    createWidget(widget.FILL_RECT, { x: 0, y: 0, w: width, h: height, color: COLOR.bg })
    this.heading = createWidget(widget.TEXT, { x: px(24), y: px(55), w: width - px(48), h: px(39),
      text_size: px(24), color: COLOR.gold, align_h: align.CENTER_H, text: title })
    this.note = createWidget(widget.TEXT, { x: px(24), y: px(96), w: width - px(48), h: px(54),
      text_size: px(17), color: COLOR.muted, align_h: align.CENTER_H, text_style: text_style.WRAP, text: '' })
    this.rows = [0, 1, 2].map(index => createWidget(widget.BUTTON, {
      x: px(24), y: px(162 + index * 68), w: width - px(48), h: px(48), radius: px(10),
      normal_color: COLOR.surface, press_color: 0x413629, color: COLOR.white,
      text_size: px(19), text: '', click_func: () => this.items[index] && this.items[index].action()
    }))
    const button = (x, w, text, action) => createWidget(widget.BUTTON, {
      x: px(x), y: px(369), w: px(w), h: px(50), radius: px(12), normal_color: COLOR.surface,
      press_color: 0x413629, color: COLOR.gold, text_size: px(21), text, click_func: action
    })
    this.back = button(24, 144, 'Назад', () => this.backAction && this.backAction())
    this.next = button(222, 144, 'Дальше', () => this.nextAction && this.nextAction())
    this.restore()
  },
  remember(value) {
    try { this.storage.setItem(RESUME_KEY, JSON.stringify(value)) } catch (error) {}
  },
  mode() {
    const saved = this.storage.getItem(MODE_KEY)
    return MODES[saved] ? saved : 'auto'
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
    if (generation == null) ++this.generation
    else if (generation !== this.generation) return
    this.items = items
    this.heading.setProperty(prop.TEXT, title)
    this.note.setProperty(prop.TEXT, note || '')
    this.rows.forEach((row, index) => {
      row.setProperty(prop.VISIBLE, Boolean(items[index]))
      if (items[index]) row.setProperty(prop.TEXT, items[index].label)
    })
    this.backAction = back
    this.nextAction = next
    this.back.setProperty(prop.VISIBLE, Boolean(back))
    this.next.setProperty(prop.VISIBLE, Boolean(next))
  },
  async load(method, params, done, back) {
    const generation = ++this.generation
    this.show(title, 'Получаю данные с Mac…', [], back, null, generation)
    try {
      const reply = await this.request({ method, params }, { timeout: 15000 })
      if (this.closed || generation !== this.generation) return
      if (!reply || !reply.ok) throw new Error(reply && reply.error || `Нет ответа ${title}`)
      done(reply)
    } catch (error) {
      if (this.closed || generation !== this.generation) return
      this.show('Не удалось', String(error.message || error).slice(0, 150),
        [{ label: 'Обновить', action: () => this.load(method, params, done, back) }], back)
    }
  },
  home() {
    this.remember({ screen: 'home' })
    this.show(title, `${title} в проектах на Mac`, [
      { label: 'Проекты', action: () => this.projects() },
      { label: 'Последняя задача', action: () => this.lastTask() },
      { label: 'История', action: () => this.history() }
    ], null, () => this.more())
    this.summarize()
  },
  summarize() {
    // One line across all agents: what runs, what waits for a tap, what finished today. Silent on failure.
    const generation = this.generation
    Promise.resolve().then(() => this.request({ method: 'SUMMARY', params: {} }, { timeout: 8000 })).then(reply => {
      if (this.closed || generation !== this.generation || !reply || !reply.ok || typeof reply.text !== 'string') return
      this.note.setProperty(prop.TEXT, reply.text.slice(0, 90))
    }).catch(() => {})
  },
  // An agent question with options: one row per option, the choice goes straight to the bridge.
  question(saved, offset = 0) {
    const back = () => { this.remember({ screen: 'voice' }); replace({ url: 'page/voice' }) }
    const options = saved.options.slice(offset, offset + 3)
    this.show(`Вопрос от ${title}`, String(saved.question || '').slice(0, 150), options.map(option => ({ label: String(option).slice(0, 40),
      action: () => this.load(PREFIX + '_APPROVE', { id: saved.jobId, approvalId: saved.approvalId, allow: true, answer: option }, back, back) })),
    offset ? () => this.question(saved, offset - 3) : back, offset + 3 < saved.options.length ? () => this.question(saved, offset + 3) : null)
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
  watches(cursor) {
    this.remember({ screen: 'watches' })
    this.load('WATCH_LIST', { cursor, limit: 2 }, reply => {
      this.show('Дозор', reply.count ? `Проверок: ${reply.count}` : 'Пока ничего не сторожу', [
        { label: 'Добавить', action: () => this.addWatch() },
        ...reply.items.map(w => ({ label: `${w.label} · ${WATCH_STATES[w.state] || w.state}`.slice(0, 40), action: () => this.watchItem(w) }))
      ], () => this.more(), reply.nextCursor ? () => this.watches(reply.nextCursor) : null)
    }, () => this.more())
  },
  addWatch() {
    this.show('Дозор', 'Что сторожить?', [
      { label: 'Сайт голосом', action: () => this.voice({ target: kind, project: 'watch', label: 'Дозор', mode: this.mode(),
        modeLabel: 'Адрес сайта словами', kind: 'watch' }) },
      { label: 'CI проекта…', action: () => this.watchProjects() }
    ], () => this.watches())
  },
  watchProjects(cursor) {
    this.load(PREFIX + '_PROJECTS', { cursor, limit: 3 }, reply => this.show('CI проекта', 'GitHub Actions по origin',
      reply.projects.map(project => ({ label: project.label, action: () => this.load('WATCH_ADD',
        { kind: 'ci', project: project.id, label: project.label }, () => this.watches(), () => this.watches()) })),
      () => this.addWatch(), reply.nextCursor ? () => this.watchProjects(reply.nextCursor) : null), () => this.addWatch())
  },
  watchItem(w) {
    this.show(w.label, `${WATCH_STATES[w.state] || w.state}\n${w.detail || ''}`.slice(0, 150), [
      { label: 'Проверить', action: () => this.load('WATCH_CHECK', { id: w.id }, reply => this.watchItem(reply.watch), () => this.watches()) },
      { label: 'Убрать', action: () => this.load('WATCH_REMOVE', { id: w.id }, () => this.watches(), () => this.watches()) }
    ], () => this.watches())
  },
  // Quick web research: the topic is dictated, the summary comes back here, the full report goes to Telegram.
  research() {
    const other = kind === 'claude' ? 'Codex' : 'Claude'
    const go = (both, deep) => this.voice({ target: kind, project: 'research', label: 'Исследование', mode: this.mode(),
      modeLabel: deep ? `Большое · ${title}` : both ? `${title} + ${other}` : title, kind: deep ? 'deep' : 'research', both })
    this.show('Исследование', 'Тему скажи голосом. Полный отчёт придёт файлом в Telegram', [
      { label: `Быстрое: ${title}`, action: () => go(false, false) },
      { label: `Быстрое: ${title} + ${other}`, action: () => go(true, false) },
      // The bundled deep-research workflow exists only in Claude Code: ~100 agents, 10–15 minutes.
      ...(kind === 'claude' ? [{ label: 'Большое: Claude', action: () => go(false, true) }] : [])
    ], () => this.more())
  },
  // Night shift: dictated tasks wait and run one after another while the owner sleeps.
  night(cursor) {
    this.remember({ screen: 'night' })
    this.load(PREFIX + '_NIGHT', { cursor, limit: 2 }, reply => {
      const when = reply.active ? 'Идёт сейчас' : reply.at ? `Старт в ${reply.at}` : 'Старт вручную'
      const control = reply.active ? { label: 'Остановить смену', action: () => this.nightCommand('_NIGHT_STOP') }
        : reply.count ? { label: 'Запустить сейчас', action: () => this.nightCommand('_NIGHT_RUN') }
          : { label: 'Добавить задачу', action: () => this.projects() }
      this.show('Ночная смена', `${when} · задач: ${reply.count}`, [control,
        ...reply.jobs.map(job => ({ label: `${job.projectLabel} · ${job.text}`.slice(0, 40), action: () => this.nightJob(job) }))],
      () => this.home(), reply.nextCursor ? () => this.night(reply.nextCursor) : null)
    }, () => this.home())
  },
  nightCommand(method) {
    this.load(PREFIX + method, {}, () => this.night(), () => this.night())
  },
  nightJob(job) {
    this.show(job.projectLabel, job.text, [
      { label: 'Убрать из смены', action: () => this.load(PREFIX + '_HISTORY_SET_DELETED', { id: job.id, deleted: true },
        () => this.night(), () => this.night()) }
    ], () => this.night())
  },
  projects(cursor) {
    this.load(PREFIX + '_PROJECTS', { cursor, limit: 3 }, reply => this.show('Проекты', `Папки с сессиями ${title}`,
      reply.projects.map(project => ({ label: project.label, action: () => this.project(project) })),
      () => this.home(), reply.nextCursor ? () => this.projects(reply.nextCursor) : null), () => this.home())
  },
  project(project) {
    this.remember({ screen: 'project', project: { id: project.id, label: project.label } })
    this.show(project.label, project.id, [
      { label: 'Задача / вопрос', action: () => this.voice({ target: kind, project: project.id, label: project.label, mode: this.mode(), modeLabel: MODES[this.mode()] }) },
      { label: `Режим: ${MODES[this.mode()]}`, action: () => this.modes(project) },
      { label: 'Продолжить сессию…', action: () => this.sessions(project) }
    ], () => this.projects(), () => this.projectMore(project))
  },
  projectMore(project, cursor) {
    // Night queue plus read-only investigation presets («Что упало?», «Статус проекта»), no dictation needed.
    this.load(PREFIX + '_QUICK_LIST', { cursor, limit: 2 }, reply => this.show(project.label,
      cursor ? 'Быстрые команды' : 'Ночная смена и быстрые команды', [
        ...(cursor ? [] : [{ label: 'В ночную смену', action: () => this.voice({ target: kind, project: project.id, label: project.label,
          mode: this.mode(), modeLabel: `${MODES[this.mode()]} · ночью`, night: true }) }]),
        ...reply.items.map(preset => ({ label: preset.arg === 'pr' ? preset.label + '…' : preset.label,
          action: () => preset.arg === 'pr' ? this.reviewMenu(project, preset) : this.runPreset(project, preset) }))
      ], () => this.project(project), reply.nextCursor ? () => this.projectMore(project, reply.nextCursor) : null),
    () => this.project(project))
  },
  // PR review: pick an open pull request of the project's origin, or say its number.
  reviewMenu(project, preset, cursor) {
    this.load(PREFIX + '_PRS', { project: project.id, cursor, limit: 2 }, reply => this.show(preset.label,
      reply.items.length ? `Открытые PR · ${reply.repo}` : `Открытых PR нет · ${reply.repo}`, [
        ...(cursor ? [] : [{ label: 'Номер голосом', action: () => this.voice({ target: kind, project: project.id, label: project.label,
          mode: this.mode(), modeLabel: 'Скажи номер PR', presetId: preset.id }) }]),
        ...reply.items.map(pr => ({ label: `#${pr.number} · ${pr.title}`.slice(0, 40), action: () => this.runPreset(project, preset, { pr: pr.number }) }))
      ], () => this.projectMore(project), reply.nextCursor ? () => this.reviewMenu(project, preset, reply.nextCursor) : null),
    () => this.projectMore(project))
  },
  runPreset(project, preset, extra = {}) {
    // One id per tap: a retry after a lost receipt returns the same job instead of a second one.
    const id = `${Date.now()}-${++this.sequence}`
    this.load(PREFIX + '_SEND', { id, project: project.id, mode: this.mode(), presetId: preset.id, ...extra }, reply => {
      if (!reply.job || typeof reply.job.id !== 'string') throw new Error(`Некорректный ответ ${title}`)
      this.voice({ target: kind, project: project.id, label: project.label, mode: this.mode(),
        modeLabel: extra.pr ? `${preset.label} #${extra.pr}` : preset.label, jobId: reply.job.id, aliasId: reply.job.id, resumeJob: true })
    }, () => this.projectMore(project))
  },
  modes(project, cursor) {
    // Permission mode for headless runs: prompts that would ask a human are denied and reported.
    this.load(PREFIX + '_MODES', { cursor, limit: 3 }, reply => this.show(`Режим ${title}`, project.label,
      reply.modes.map(mode => ({ label: mode.label, action: () => {
        try { this.storage.setItem(MODE_KEY, mode.id) } catch (error) {}
        this.project(project)
      } })), () => this.project(project), reply.nextCursor ? () => this.modes(project, reply.nextCursor) : null),
    () => this.project(project))
  },
  sessions(project, cursor) {
    this.load(PREFIX + '_SESSIONS', { project: project.id, cursor, limit: 3 }, reply => this.show('Сессии', project.label,
      reply.sessions.map(session => ({ label: session.label, action: () => this.voice({ target: kind,
        project: project.id, label: project.label, mode: this.mode(), modeLabel: MODES[this.mode()], sessionId: session.id }) })),
      () => this.project(project), reply.nextCursor ? () => this.sessions(project, reply.nextCursor) : null),
    () => this.project(project))
  },
  lastTask() {
    let saved = null
    try { saved = JSON.parse(this.storage.getItem(CONTEXT_KEY) || 'null') } catch (error) {}
    if (saved && saved.target === kind && typeof saved.project === 'string' && saved.project) {
      this.remember({ screen: 'voice' })
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
    this.storage.setItem(CONTEXT_KEY, JSON.stringify(context))
    this.remember({ screen: 'voice' })
    replace({ url: 'page/voice' })
  },
  onDestroy() { this.closed = true; ++this.generation }
  }
}
