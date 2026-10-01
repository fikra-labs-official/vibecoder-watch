import { createWidget, widget, align, text_style, prop } from '@zos/ui'
import { getDeviceInfo } from '@zos/device'
import { replace } from '@zos/router'
import { LocalStorage } from '@zos/storage'
import { setWakeUpRelaunch } from '@zos/display'
import { BasePage } from '@zeppos/zml/base-page'

const CONTEXT_KEY = 'voice-destination'
const RESUME_KEY = 'orca-resume'
const COLOR = { bg: 0x0b0b0c, gold: 0xeac477, white: 0xf4eee3, muted: 0xb8ac99, surface: 0x28231d }
Page(BasePage({
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
      text_size: px(24), color: COLOR.gold, align_h: align.CENTER_H, text: 'Orca' })
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
  restore() {
    try {
      const saved = JSON.parse(this.storage.getItem(RESUME_KEY) || 'null')
      if (saved && saved.screen === 'voice') {
        const target = JSON.parse(this.storage.getItem(CONTEXT_KEY) || 'null')
        if (target && ((target.target === 'orca' && typeof target.pairId === 'string' && target.pairId) ||
            (target.target === 'folder' && typeof target.rootId === 'string' && target.rootId))) {
          replace({ url: 'page/voice' }); return
        }
      }
      if (saved && saved.screen === 'history') {
        const pair = JSON.parse(this.storage.getItem('orca-history-pair') || 'null')
        if (pair && typeof pair.id === 'string' && pair.id) { replace({ url: 'page/history' }); return }
      }
      if (saved && saved.screen === 'pair' && saved.pair && typeof saved.pair.id === 'string') {
        this.pair(saved.pair); return
      }
      if (saved && saved.screen === 'project' && saved.workspace && typeof saved.workspace.id === 'string') {
        this.project(saved.workspace); return
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
    this.show('Orca', 'Получаю данные с Mac…', [], back, null, generation)
    try {
      const reply = await this.request({ method, params }, { timeout: 15000 })
      if (this.closed || generation !== this.generation) return
      if (!reply || !reply.ok) throw new Error(reply && reply.error || 'Нет ответа Orca')
      done(reply)
    } catch (error) {
      if (this.closed || generation !== this.generation) return
      this.show('Не удалось', String(error.message || error).slice(0, 150),
        [{ label: 'Обновить', action: () => this.load(method, params, done, back) }], back)
    }
  },
  home() {
    this.remember({ screen: 'home' })
    this.show('Orca', 'Проекты и агенты на твоём Mac', [
      { label: 'Текущие проекты', action: () => this.projects() },
      { label: 'Мои связки', action: () => this.pairs() },
      { label: 'Новый проект', action: () => this.roots() }
    ])
    const generation = this.generation
    Promise.resolve().then(() => this.request({ method: 'SUMMARY', params: {} }, { timeout: 8000 })).then(reply => {
      if (this.closed || generation !== this.generation || !reply || !reply.ok || typeof reply.text !== 'string') return
      this.note.setProperty(prop.TEXT, reply.text.slice(0, 90))
    }).catch(() => {})
  },
  projects(cursor) {
    this.load('ORCA_LIST', { cursor, limit: 3 }, reply => this.show('Проекты', 'Выбери рабочий каталог',
      reply.workspaces.map(workspace => ({ label: `${workspace.projectLabel} · ${workspace.name}`,
        action: () => this.project(workspace) })), () => this.home(),
      reply.nextCursor ? () => this.projects(reply.nextCursor) : null), () => this.home())
  },
  project(workspace, page = 0) {
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
    // Always private; the Mac decides create vs connect and never makes a second repository.
    this.show('Приватный репозиторий?', `${workspace.projectLabel}\nGitHub, только приватный`, [
      { label: 'Создать на GitHub', action: () => {
        const id = `${Date.now()}-${++this.sequence}`
        this.load('ORCA_GITHUB_CREATE', { id, workspaceId: workspace.id },
          reply => this.provision(reply.operation, workspace), () => this.project(workspace, 1))
      } }
    ], () => this.project(workspace, 1))
  },
  pairs(workspace, cursor) {
    this.load('ORCA_PAIRS', { workspaceId: workspace && workspace.id, cursor, limit: 3 }, reply => {
      this.show('Мои связки', reply.pairs.length ? 'Боевой + проверяющий' : 'Выбери проект и назначь роли',
        reply.pairs.map(pair => ({ label: `${pair.projectLabel} · ${pair.workerAgent}/${pair.reviewerAgent}`,
          action: () => this.pair(pair) })), () => workspace ? this.project(workspace) : this.home(),
        reply.nextCursor ? () => this.pairs(workspace, reply.nextCursor) : null)
    }, () => this.home())
  },
  terminals(workspace, role, worker, cursor) {
    this.load('ORCA_TERMINALS', { workspaceId: workspace.id, cursor, limit: 3 }, reply => {
      const choices = reply.terminals.filter(t => !worker || t.id !== worker.id)
      this.show(role === 'worker' ? 'Выбери боевого' : 'Проверяющий', workspace.projectLabel,
        choices.map(terminal => ({ label: `${terminal.busy ? 'Занят · ' : ''}${terminal.title || terminal.agent}`,
          action: () => {
            if (role === 'worker') this.terminals(workspace, 'reviewer', terminal)
            else this.confirmPair(workspace, worker, terminal)
          } })), () => role === 'worker' ? this.project(workspace) : this.terminals(workspace, 'worker'),
        reply.nextCursor ? () => this.terminals(workspace, role, worker, reply.nextCursor) : null)
    }, () => this.project(workspace))
  },
  confirmPair(workspace, worker, reviewer) {
    this.show('Назначить роли?', workspace.projectLabel, [
      { label: `Боевой: ${worker.title || worker.agent}`, action: () => this.terminals(workspace, 'worker') },
      { label: `Проверка: ${reviewer.title || reviewer.agent}`, action: () => this.terminals(workspace, 'reviewer', worker) },
      { label: 'Сохранить связку', action: () => this.load('ORCA_BIND',
        { workspaceId: workspace.id, workerId: worker.id, reviewerId: reviewer.id }, reply => this.pair(reply.pair),
        () => this.project(workspace)) }
    ], () => this.project(workspace))
  },
  pair(pair, page = 0) {
    this.remember({ screen: 'pair', pair })
    const context = role => ({ target: 'orca', pairId: pair.id, label: pair.projectLabel,
      workerAgent: pair.workerAgent, reviewerAgent: pair.reviewerAgent, ...(role ? { askRole: role } : {}) })
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
  quick(pair, cursor) {
    this.load('ORCA_QUICK_LIST', { cursor, limit: 3 }, reply => this.show('Быстрая команда', pair.projectLabel,
      reply.commands.map(command => ({ label: command.label, action: () => this.confirmQuick(pair, command) })),
      () => this.pair(pair), reply.nextCursor ? () => this.quick(pair, reply.nextCursor) : null), () => this.pair(pair))
  },
  confirmQuick(pair, command) {
    this.show('Отправить связке?', `${pair.projectLabel}\n${command.label}`, [
      { label: 'Отправить', action: () => this.sendQuick(pair, command) }
    ], () => this.quick(pair))
  },
  sendQuick(pair, command) {
    // One id per tap: a retry after a lost receipt returns the same job instead of a second one.
    const id = `${Date.now()}-${++this.sequence}`
    this.load('ORCA_SEND', { id, pairId: pair.id, presetId: command.id }, reply => {
      if (!reply.job || typeof reply.job.id !== 'string') throw new Error('Некорректный ответ Orca')
      this.voice({ target: 'orca', pairId: pair.id, label: pair.projectLabel,
        workerAgent: pair.workerAgent || '', reviewerAgent: pair.reviewerAgent || '',
        jobId: reply.job.id, aliasId: reply.job.id, resumeJob: true })
    }, () => this.pair(pair))
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
      reply.roots.map(root => ({ label: root.label, action: () => this.voice({ target: 'folder', rootId: root.id,
        label: root.label }) })), () => this.home()), () => this.home())
  },
  presets(workspace, cursor) {
    this.load('ORCA_PRESETS', { cursor, limit: 3 }, reply => this.show('Новая связка', 'Модели: настройки Orca',
      reply.presets.map(preset => ({ label: preset.label, action: () => this.models(workspace, preset, 'worker') })),
      () => this.project(workspace), reply.nextCursor ? () => this.presets(workspace, reply.nextCursor) : null),
    () => this.project(workspace))
  },
  newAgentMenu(workspace) {
    this.show('Новые агенты', workspace.projectLabel, [
      { label: 'Связка по шаблону', action: () => this.presets(workspace) },
      { label: 'Один новый агент', action: () => this.agents(workspace) }
    ], () => this.project(workspace))
  },
  agents(workspace, cursor) {
    this.load('ORCA_AGENTS', { cursor, limit: 3 }, reply => this.show('Новый агент', 'Установленные клиенты Mac',
      reply.agents.map(agent => ({ label: agent.label,
        action: () => this.models(workspace, { id: agent.id, label: agent.label, workerAgent: agent.id, single: true }, 'worker') })),
      () => this.newAgentMenu(workspace), reply.nextCursor ? () => this.agents(workspace, reply.nextCursor) : null),
    () => this.newAgentMenu(workspace))
  },
  models(workspace, preset, role, selected = {}, cursor) {
    const agent = role === 'worker' ? preset.workerAgent : preset.reviewerAgent
    this.load('ORCA_MODELS', { agent, cursor, limit: 3 }, reply => this.show(
      preset.single ? 'Модель агента' : role === 'worker' ? 'Модель боевого' : 'Модель проверки', preset.label,
      reply.models.map(model => ({ label: model.label, action: () => {
        const models = { ...selected, [role]: model.id }
        if (role === 'worker' && !preset.single) this.models(workspace, preset, 'reviewer', models)
        else this.modeChoice(workspace, preset, models)
      } })), () => this.newAgentMenu(workspace), reply.nextCursor ? () => this.models(workspace, preset, role, selected, reply.nextCursor) : null),
    () => this.newAgentMenu(workspace))
  },
  modeChoice(workspace, preset, models) {
    // Auto is the default on the Mac (orcaDefaultMode); anything else is one more step.
    this.show(preset.single ? 'Режим агента' : 'Режим агентов', 'Авто: агент действует сам, без вопросов', [
      { label: 'Авто, по умолчанию', action: () => this.createPair(workspace, preset, models, {}) },
      { label: 'Другой режим…', action: () => this.modes(workspace, preset, models, 'worker') }
    ], () => this.newAgentMenu(workspace))
  },
  modes(workspace, preset, models, role, selected = {}, cursor) {
    // Permission mode is a launch option: plan / auto / bypass as explicit choices.
    const agent = role === 'worker' ? preset.workerAgent : preset.reviewerAgent
    this.load('ORCA_MODES', { agent, cursor, limit: 3 }, reply => this.show(
      preset.single ? 'Режим агента' : role === 'worker' ? 'Режим боевого' : 'Режим проверки', preset.label,
      reply.modes.map(mode => ({ label: mode.label, action: () => {
        const modes = { ...selected, [role]: mode.id }
        if (role === 'worker' && !preset.single) this.modes(workspace, preset, models, 'reviewer', modes)
        else this.createPair(workspace, preset, models, modes)
      } })), () => this.newAgentMenu(workspace), reply.nextCursor ? () => this.modes(workspace, preset, models, role, selected, reply.nextCursor) : null),
    () => this.newAgentMenu(workspace))
  },
  createPair(workspace, preset, models, modes = {}) {
    const back = () => preset.single ? this.agents(workspace) : this.presets(workspace)
    this.show(preset.single ? 'Открыть агента?' : 'Открыть связку?', `${workspace.projectLabel}\n${preset.label}`, [
      { label: 'Открыть на Mac', action: () => {
        const id = `${Date.now()}-${++this.sequence}`
        this.load(preset.single ? 'ORCA_AGENT_CREATE' : 'ORCA_PAIR_CREATE', preset.single
          ? { id, workspaceId: workspace.id, agent: preset.workerAgent, model: models.worker, mode: modes.worker || '' }
          : { id, workspaceId: workspace.id, presetId: preset.id, models, modes },
          reply => this.provision(reply.operation, workspace), back)
      } }
    ], back)
  },
  provision(operation, workspace) {
    if (operation.state === 'completed' && operation.pair) { this.pair(operation.pair); return }
    if (operation.state === 'completed') { this.show(operation.github ? 'GitHub' : 'Агент открыт', operation.message || workspace.projectLabel,
      [{ label: 'К проекту', action: () => this.project(workspace) }], () => this.project(workspace)); return }
    this.show(operation.state === 'error' || operation.state === 'unknown' ? 'Нужен Mac' : 'Открываю связку',
      operation.message || 'Создание выполняется на Mac', [{ label: 'Обновить', action: () =>
        this.load('ORCA_OPERATION', { id: operation.id }, reply => this.provision(reply.operation, workspace),
          () => this.project(workspace)) }], () => this.project(workspace))
  },
  onDestroy() { this.closed = true; ++this.generation }
}))
