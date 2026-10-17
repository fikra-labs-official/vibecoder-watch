import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { textRows } from '../shared/text-rows.js'

const source = fs.readFileSync(new URL('../page/orca.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '')
const flush = () => new Promise(resolve => setImmediate(resolve))

function fixture({ width = 390, height = 450, request = async () => ({ ok: true }),
  storage = new Map() } = {}) {
  let page
  const timers = new Map()
  let nextTimer = 0
  const widgets = []
  const replacements = []
  const wakeCalls = []
  const interaction = { gesture: null, key: null, offGesture: 0, offKey: 0 }
  vm.runInNewContext(source, {
    Page(definition) { page = Object.assign(Object.create(definition), definition) },
    BasePage: value => value,
    setStatusBarVisible() {},
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    getDeviceInfo: () => ({ width, height }),
    replace: value => replacements.push(value),
    setWakeUpRelaunch: value => wakeCalls.push(value),
    getTextLayout(value, options) {
      return { result: 0, width: Math.max(1, Array.from(value).length * options.text_size * 0.6), height: options.text_size }
    },
    textRows,
    LocalStorage: class {
      getItem(key) { return storage.get(key) }
      setItem(key, value) { storage.set(key, value) }
    },
    createWidget(kind, options) {
      const item = {
        kind,
        moreUpdates: 0,
        options: { visible: true, ...options },
        setProperty(property, value) {
          if (kind === 3 && property === 'text') throw new Error('BUTTON prop.TEXT is forbidden')
          if (kind === 3 && property === 'more') {
            for (const key of ['x', 'y', 'w', 'h']) {
              assert.equal(Number.isFinite(value[key]), true, `BUTTON MORE ${key}`)
            }
            this.moreUpdates += 1
          }
          if (property === 'more' || property === 'update_data') Object.assign(this.options, value)
          else this.options[property] = value
        }
      }
      widgets.push(item)
      return item
    },
    widget: { FILL_RECT: 1, TEXT: 2, BUTTON: 3, SCROLL_LIST: 4 },
    align: { CENTER_H: 1 },
    text_style: { WRAP: 1 },
    prop: { TEXT: 'text', VISIBLE: 'visible', MORE: 'more', UPDATE_DATA: 'update_data' },
    onGesture(option) { interaction.gesture = option.callback },
    offGesture() { interaction.offGesture += 1 },
    GESTURE_RIGHT: 10,
    onKey(option) { interaction.key = option.callback },
    offKey() { interaction.offKey += 1 },
    KEY_BACK: 20,
    KEY_EVENT_CLICK: 21,
    Date: class extends Date { static now() { return 1700000000000 } },
    console: { log() {} }
  })
  const calls = []
  page.request = (payload, options) => {
    if (payload.method !== 'SUMMARY') calls.push({ payload, options })  // home summary is background noise here
    return request(payload, options)
  }
  page.build()
  return { page, widgets, replacements, storage, calls, wakeCalls, interaction, timers }
}

test('sleep restores the chosen project and pair without creating agents again', () => {
  const storage = new Map()
  const first = fixture({ storage })
  first.page.project({ id: 'project-1', projectLabel: 'Работа', name: 'main' })
  first.page.onDestroy()
  const project = fixture({ storage })
  assert.equal(project.page.workspace.id, 'project-1')
  project.page.pair({ id: 'pair-1', projectLabel: 'Работа', workerAgent: 'claude', reviewerAgent: 'claude' })
  project.page.onDestroy()
  const pair = fixture({ storage })
  assert.equal(pair.page.heading.options.text, 'Связка Orca')
  assert.equal(pair.calls.length, 0)
  assert.equal(pair.wakeCalls.at(-1).relaunch, true)
  pair.page.items[0].action()
  pair.page.onDestroy()
  const voice = fixture({ storage })
  assert.equal(voice.replacements[0].url, 'page/voice')
  assert.equal(voice.calls.length, 0)
  assert.equal(JSON.parse(storage.get('voice-destination')).pairId, 'pair-1')
})

test('invalid saved navigation returns to the home menu', () => {
  for (const saved of ['broken', '{}', '{"screen":"voice"}']) {
    const f = fixture({ storage: new Map([['orca-resume', saved]]) })
    assert.equal(f.page.items[0].label, 'Новая задача')
    assert.equal(f.replacements.length, 0)
  }
})

test('home New task selects an existing pair and opens a clean compose context', async () => {
  const pair = {
    id: 'pair-ready', projectLabel: 'Большой рабочий проект',
    workerAgent: 'codex', reviewerAgent: 'claude'
  }
  const f = fixture({ request: async ({ method }) => {
    if (method === 'SUMMARY') return { ok: true, text: 'На связи' }
    if (method === 'ORCA_PAIRS') return { ok: true, pairs: [pair], nextCursor: null }
    throw new Error(method)
  } })

  assert.deepEqual([...f.page.items].map(item => item.label),
    ['Новая задача', 'Текущие проекты', 'Мои связки'])
  f.page.items[0].action()
  await flush()
  assert.equal(f.page.heading.options.text, 'Новая задача')
  assert.equal(f.page.items[0].label, 'Большой рабочий проект · codex/claude')
  assert.deepEqual(f.calls.map(call => call.payload.method), ['ORCA_PAIRS'])

  f.page.items[0].action()
  assert.equal(f.replacements.at(-1).url, 'page/voice')
  assert.deepEqual(JSON.parse(f.storage.get('voice-destination')), {
    target: 'orca', pairId: 'pair-ready', label: 'Большой рабочий проект',
    workerAgent: 'codex', reviewerAgent: 'claude', startFresh: true, autoRecord: false
  })
  assert.equal(f.calls.some(call => ['ORCA_SEND', 'ORCA_PAIR_CREATE', 'ORCA_AGENT_CREATE'].includes(call.payload.method)), false)
  f.page.onDestroy()
})

test('New task with no pairs offers a reversible choose-or-create route without mutation', async () => {
  const f = fixture({ request: async ({ method }) => {
    if (method === 'SUMMARY') return { ok: true, text: 'На связи' }
    if (method === 'ORCA_PAIRS') return { ok: true, pairs: [], nextCursor: null }
    if (method === 'ORCA_LIST') return { ok: true, workspaces: [], nextCursor: null }
    throw new Error(method)
  } })

  f.page.items[0].action()
  await flush()
  assert.equal(f.page.heading.options.text, 'Новая задача')
  assert.equal(f.page.items[0].label, 'Выбрать или создать связку')
  assert.equal(f.page.back.options.visible, true)
  f.page.backAction()
  assert.equal(f.page.items[0].label, 'Новая задача')

  f.page.items[0].action()
  await flush()
  f.page.items[0].action()
  await flush()
  assert.equal(f.page.heading.options.text, 'Проекты')
  assert.deepEqual(f.calls.map(call => call.payload.method), ['ORCA_PAIRS', 'ORCA_PAIRS', 'ORCA_LIST'])
  assert.equal(f.calls.some(call => ['ORCA_SEND', 'ORCA_PAIR_CREATE', 'ORCA_AGENT_CREATE'].includes(call.payload.method)), false)
  f.page.onDestroy()
})

test('show paginates every action instead of silently dropping the fourth item', () => {
  const f = fixture()
  const labels = ['Один', 'Два', 'Три', 'Четыре', 'Пять']
  f.page.show('Меню', 'Все действия доступны', labels.map(label => ({ label, action() {} })), () => f.page.home())
  assert.deepEqual([...f.page.items].map(item => item.label), labels.slice(0, 3))
  assert.equal(f.page.next.options.visible, true)
  f.page.nextAction()
  assert.deepEqual([...f.page.items].map(item => item.label), labels.slice(3))
  assert.equal(f.page.back.options.visible, true)
  f.page.backAction()
  assert.deepEqual([...f.page.items].map(item => item.label), labels.slice(0, 3))
  f.page.onDestroy()
})

test('failed home summary keeps New task first and leaves Pairs reachable by paging', async () => {
  const f = fixture({ request: async ({ method }) => {
    if (method === 'SUMMARY') throw new Error('offline')
    return { ok: true }
  } })
  await flush()
  assert.deepEqual([...f.page.items].map(item => item.label),
    ['Новая задача', 'Повторить связь', 'Текущие проекты'])
  f.page.nextAction()
  assert.deepEqual([...f.page.items].map(item => item.label), ['Мои связки'])
  assert.equal(f.page.back.options.visible, true)
  f.page.backAction()
  assert.equal(f.page.items[0].label, 'Новая задача')
  f.page.onDestroy()
})

test('long project and pair labels stay width-bound while actions retain full source data', async () => {
  const workspace = {
    id: 'workspace-long',
    projectLabel: 'Очень   длинный\nпроект с названием, которое не помещается в кнопку часов',
    name: 'ветка с ещё более длинным названием для проверки нативной кнопки'
  }
  const pair = {
    id: 'pair-long', projectLabel: 'Связка с исключительно длинным названием рабочего проекта',
    workerAgent: 'codex-agent-with-long-name', reviewerAgent: 'claude-reviewer-with-long-name'
  }
  const f = fixture({ request: async ({ method }) => {
    if (method === 'SUMMARY') return { ok: true, text: 'На связи' }
    if (method === 'ORCA_LIST') return { ok: true, workspaces: [workspace], nextCursor: null }
    if (method === 'ORCA_PAIRS') return { ok: true, pairs: [pair], nextCursor: null }
    throw new Error(method)
  } })

  f.page.projects()
  await flush()
  const projectLabel = `${workspace.projectLabel} · ${workspace.name}`
  assert.equal(f.page.items[0].label, projectLabel)
  assert.equal(/\s{2,}|\n/u.test(f.page.rows[0].options.text), false)
  assert.match(f.page.rows[0].options.text, /…$/u)
  assert.equal(textRows(f.page.rows[0].options.text,
    f.page.rowLayouts[0].w - 36, f.page.rowTextSize, (value, options) => ({
      result: 0, width: Math.max(1, Array.from(value).length * options.text_size * 0.6),
      height: options.text_size
    })).length, 1)
  f.page.rows[0].options.click_func()
  assert.deepEqual(f.page.workspace, workspace)
  assert.deepEqual(JSON.parse(f.storage.get('orca-resume')).workspace, workspace)

  f.page.newTask()
  await flush()
  assert.equal(f.page.items[0].label,
    `${pair.projectLabel} · ${pair.workerAgent}/${pair.reviewerAgent}`)
  assert.match(f.page.rows[0].options.text, /…$/u)
  f.page.rows[0].options.click_func()
  assert.equal(JSON.parse(f.storage.get('voice-destination')).pairId, pair.id)
  f.page.onDestroy()
})

test('a late catalog reply cannot replace any newer menu page', async () => {
  let finish
  const f = fixture({ request: payload => payload.method === 'SUMMARY' ? Promise.resolve({ ok: true, text: 'На связи' }) : new Promise(resolve => { finish = resolve }) })
  f.page.projects()
  assert.equal(f.page.heading.options.text, 'Orca')
  assert.match(f.page.note.options.text, /Получаю данные/)
  await flush()
  f.page.project({ id: 'current', projectLabel: 'Текущий', name: 'main' })
  finish({ ok: true, workspaces: [{ id: 'stale', projectLabel: 'Старый', name: 'ответ' }] })
  await flush()
  assert.equal(f.page.heading.options.text, 'Текущий')
  assert.equal(f.page.note.options.text, 'main')
  assert.deepEqual([...f.page.items].map(item => item.label),
    ['Готовые связки', 'Выбрать два терминала', 'Новая связка / агент'])
  f.page.onDestroy()
})

test('agent catalog follows server cursors without client-side slicing', async () => {
  const workspace = { id: 'workspace', projectLabel: 'Проект', name: 'main' }
  const f = fixture({ request: async payload => {
    assert.equal(payload.method, 'ORCA_AGENTS')
    if (!payload.params.cursor) return {
      ok: true,
      agents: [{ id: 'one', label: 'Один' }, { id: 'two', label: 'Два' }, { id: 'three', label: 'Три' }],
      nextCursor: 'agents-2'
    }
    assert.equal(payload.params.cursor, 'agents-2')
    return { ok: true, agents: [{ id: 'seven', label: 'Седьмой' }], nextCursor: null }
  } })
  f.page.agents(workspace)
  await flush()
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].payload.params)), { limit: 3 })
  assert.deepEqual(f.page.items.map(item => item.label), ['Один', 'Два', 'Три'])
  f.page.nextAction()
  await flush()
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[1].payload.params)), { cursor: 'agents-2', limit: 3 })
  assert.deepEqual(f.page.items.map(item => item.label), ['Седьмой'])
  f.page.backAction()
  await flush()
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[2].payload.params)), { limit: 3 })
  assert.deepEqual(f.page.items.map(item => item.label), ['Один', 'Два', 'Три'])
  f.page.onDestroy()
})

test('exact worker and reviewer are bound only after Save and no task dispatch occurs', async () => {
  const workspace = { id: 'repo-1::/work/main', projectLabel: 'Проект', name: 'main' }
  const worker = { id: 'term-worker', title: 'Codex Worker', agent: 'codex', busy: false }
  const reviewer = { id: 'term-reviewer', title: 'Claude Reviewer', agent: 'claude', busy: false }
  const pair = { id: 'pair-1', projectLabel: 'Проект', workerAgent: 'codex', reviewerAgent: 'claude' }
  const f = fixture({ request: async payload => {
    if (payload.method === 'ORCA_LIST') return { ok: true, workspaces: [workspace], nextCursor: null }
    if (payload.method === 'ORCA_TERMINALS') {
      return { ok: true, terminals: [worker, reviewer], nextCursor: null }
    }
    if (payload.method === 'ORCA_BIND') return { ok: true, pair }
    throw new Error(`unexpected ${payload.method}`)
  } })

  f.page.projects()
  await flush()
  f.page.items[0].action()
  assert.equal(f.page.heading.options.text, 'Проект')
  f.page.items[1].action()
  await flush()
  assert.equal(f.page.heading.options.text, 'Выбери боевого')
  f.page.items.find(item => item.label === 'Codex Worker').action()
  await flush()
  assert.equal(f.page.heading.options.text, 'Проверяющий')
  f.page.items.find(item => item.label === 'Claude Reviewer').action()
  assert.equal(f.page.heading.options.text, 'Назначить роли?')
  assert.equal(f.calls.some(call => call.payload.method === 'ORCA_BIND'), false)
  assert.equal(f.calls.some(call => call.payload.method === 'ORCA_SEND'), false)

  f.page.items.find(item => item.label === 'Сохранить связку').action()
  await flush()
  const bind = f.calls.find(call => call.payload.method === 'ORCA_BIND')
  assert.deepEqual(JSON.parse(JSON.stringify(bind.payload.params)), {
    workspaceId: workspace.id, workerId: worker.id, reviewerId: reviewer.id
  })
  assert.equal(f.page.heading.options.text, 'Связка Orca')
  assert.equal(f.calls.some(call => call.payload.method === 'ORCA_SEND'), false)

  f.page.items[0].action()
  assert.deepEqual(JSON.parse(JSON.stringify(f.replacements)), [{ url: 'page/voice' }])
  const destination = JSON.parse(f.storage.get('voice-destination'))
  assert.deepEqual(destination, {
    target: 'orca', pairId: 'pair-1', label: 'Проект',
    workerAgent: 'codex', reviewerAgent: 'claude'
  })
  assert.equal(f.calls.some(call => call.payload.method === 'ORCA_SEND'), false)
  f.page.onDestroy()
})

test('Orca menu routes voice to its voice page and top-level menu preserves its context', () => {
  const f = fixture()
  const context = { target: 'orca', pairId: 'pair-1', label: 'Проект' }
  f.page.voice(context)
  f.page.home()
  assert.equal(f.page.backAction, null)
  assert.equal(f.page.back.options.visible, false)
  assert.deepEqual(JSON.parse(JSON.stringify(f.replacements)), [{ url: 'page/voice' }])
  assert.deepEqual(JSON.parse(f.storage.get('voice-destination')), context)
  f.page.onDestroy()
})

test('new pair and single agent use the selected models only after Open on Mac', async () => {
  const workspace = { id: 'repo-1::/work/main', projectLabel: 'Проект', name: 'main' }
  const preset = {
    id: 'preset-1', label: 'Codex + Claude', workerAgent: 'codex', reviewerAgent: 'claude'
  }
  const f = fixture({ request: async payload => {
    if (payload.method === 'ORCA_PRESETS') return { ok: true, presets: [preset], nextCursor: null }
    if (payload.method === 'ORCA_AGENTS') return { ok: true, agents: [{ id: 'codex', label: 'Codex' }] }
    if (payload.method === 'ORCA_MODELS') return {
      ok: true,
      models: payload.params.agent === 'codex'
        ? [{ id: '', label: 'Настройки Orca' }, { id: 'gpt-demo', label: 'GPT demo' }]
        : [{ id: 'claude-demo', label: 'Claude demo' }],
      nextCursor: null
    }
    if (payload.method === 'ORCA_MODES') return {
      ok: true, agent: payload.params.agent,
      modes: payload.params.agent === 'codex'
        ? [{ id: 'auto', label: 'Авто' }, { id: 'read-only', label: 'Только чтение' }]
        : [{ id: 'auto', label: 'Авто' }, { id: 'plan', label: 'План' }],
      nextCursor: null
    }
    if (payload.method === 'ORCA_PAIR_CREATE') return {
      ok: true, operation: { id: payload.params.id, state: 'completed', pair: {
        id: 'pair-new', projectLabel: 'Проект', workerAgent: 'codex', reviewerAgent: 'claude'
      } }
    }
    if (payload.method === 'ORCA_AGENT_CREATE') return {
      ok: true, operation: { id: payload.params.id, state: 'completed', message: 'Агент открыт' }
    }
    throw new Error(`unexpected ${payload.method}`)
  } })

  f.page.newAgentMenu(workspace)
  f.page.items[0].action()
  await flush()
  f.page.items[0].action()
  await flush()
  assert.equal(f.page.heading.options.text, 'Модель боевого')
  f.page.items.find(item => item.label === 'GPT demo').action()
  await flush()
  assert.equal(f.page.heading.options.text, 'Модель проверки')
  f.page.items.find(item => item.label === 'Claude demo').action()
  assert.equal(f.page.heading.options.text, 'Режим агентов')
  assert.equal(f.page.items[0].label, 'Авто, по умолчанию')
  f.page.items.find(item => item.label === 'Другой режим…').action()
  await flush()
  assert.equal(f.page.heading.options.text, 'Режим боевого')
  f.page.items.find(item => item.label === 'Авто').action()
  await flush()
  assert.equal(f.page.heading.options.text, 'Режим проверки')
  f.page.items.find(item => item.label === 'План').action()
  assert.equal(f.page.heading.options.text, 'Открыть связку?')
  assert.equal(f.calls.some(call => call.payload.method === 'ORCA_PAIR_CREATE'), false)
  f.page.items[0].action()
  await flush()
  const pairCreate = f.calls.find(call => call.payload.method === 'ORCA_PAIR_CREATE')
  assert.deepEqual(JSON.parse(JSON.stringify(pairCreate.payload.params)), {
    id: '1700000000000-1', workspaceId: workspace.id, presetId: preset.id,
    models: { worker: 'gpt-demo', reviewer: 'claude-demo' }, modes: { worker: 'auto', reviewer: 'plan' }
  })

  f.page.newAgentMenu(workspace)
  f.page.items[1].action()
  await flush()
  f.page.items[0].action()
  await flush()
  assert.equal(f.page.heading.options.text, 'Модель агента')
  f.page.items.find(item => item.label === 'Настройки Orca').action()
  await flush()
  assert.equal(f.page.heading.options.text, 'Режим агента')
  f.page.items.find(item => item.label === 'Авто, по умолчанию').action()
  assert.equal(f.page.heading.options.text, 'Открыть агента?')
  assert.equal(f.calls.some(call => call.payload.method === 'ORCA_AGENT_CREATE'), false)
  f.page.items[0].action()
  await flush()
  const agentCreate = f.calls.find(call => call.payload.method === 'ORCA_AGENT_CREATE')
  assert.deepEqual(JSON.parse(JSON.stringify(agentCreate.payload.params)), {
    id: '1700000000000-2', workspaceId: workspace.id, agent: 'codex', model: '', mode: ''
  })
  assert.equal(f.calls.some(call => call.payload.method === 'ORCA_SEND'), false)
  f.page.onDestroy()
})

test('menu layouts stay inside the watch and visible controls do not overlap', () => {
  for (const [width, height] of [[390, 450], [432, 514], [390, 400]]) {
    const f = fixture({ width, height })
    const assertLayout = screen => {
      const visible = f.widgets.filter(item => item.kind !== 1 && item.options.visible)
        .map(item => item.options)
      for (let index = 0; index < visible.length; index += 1) {
        const item = visible[index]
        assert.ok(item.x >= 0 && item.y >= 0 && item.x + item.w <= width && item.y + item.h <= height,
          `${screen}: ${item.text} must fit ${width}x${height}`)
        for (const other of visible.slice(index + 1)) {
          const overlap = item.x < other.x + other.w && item.x + item.w > other.x &&
            item.y < other.y + other.h && item.y + item.h > other.y
          assert.equal(overlap, false, `${screen}: ${item.text} overlaps ${other.text} at ${width}x${height}`)
        }
      }
    }
    for (let i = 1; i < f.page.rows.length; i++) {
      const above = f.page.rows[i - 1].options
      const below = f.page.rows[i].options
      assert.ok(below.y - above.y - above.h >= f.page.px(18), 'rows need visible physical spacing')
    }
    assertLayout('home')
    f.page.nextAction()
    assertLayout('secondary home')
    f.page.show('Новая задача', 'Очень длинное описание состояния проекта. '.repeat(8), [
      { label: 'Очень длинное название первой готовой связки Codex и Claude', action() {} },
      { label: 'Ещё одна связка с длинным названием рабочего проекта', action() {} },
      { label: 'Третья готовая связка для проверки трёх строк меню', action() {} },
      { label: 'Четвёртая связка остаётся доступной на следующей странице', action() {} }
    ], () => f.page.home())
    assertLayout('long three-row menu')
    for (const control of [...f.page.rows, f.page.back, f.page.next]) {
      assert.ok(control.options.h >= 44, `control height must be at least 44 at ${width}x${height}`)
      assert.ok(control.moreUpdates > 0, `control must receive a full prop.MORE update at ${width}x${height}`)
    }
    f.page.nextAction()
    assert.equal(f.page.items[0].label, 'Четвёртая связка остаётся доступной на следующей странице')
    assertLayout('long overflow page')
    f.page.onDestroy()
  }
})

test('pair menu opens per-pair history and sleep restores it only with a stored pair', () => {
  const storage = new Map()
  const pair = { id: 'pair-1', projectLabel: 'Работа', workerAgent: 'codex', reviewerAgent: 'claude' }
  const f = fixture({ storage })
  f.page.pair(pair)
  assert.equal(f.page.items[1].label, 'Спросить проверяющего')
  f.page.nextAction()
  assert.equal(f.page.items[0].label, 'История задач')
  f.page.items[0].action()
  assert.equal(f.replacements.at(-1).url, 'page/history')
  assert.deepEqual(JSON.parse(storage.get('orca-history-pair')), pair)
  assert.deepEqual(JSON.parse(storage.get('orca-resume')), { screen: 'history' })
  assert.equal(f.calls.length, 0)
  const restored = fixture({ storage })
  assert.equal(restored.replacements.at(-1).url, 'page/history')
  const orphan = fixture({ storage: new Map([['orca-resume', JSON.stringify({ screen: 'history' })]]) })
  assert.equal(orphan.replacements.length, 0)
  assert.equal(orphan.page.items[0].label, 'Новая задача')
})

test('quick command sends one preset task per tap and opens the task screen', async () => {
  const storage = new Map()
  const replies = { ORCA_QUICK_LIST: { ok: true, commands: [{ id: 'continue', label: 'Продолжай' }], nextCursor: null } }
  let sends = 0
  const f = fixture({ storage, request: async ({ method, params }) => {
    if (method === 'ORCA_SEND') { sends += 1; return { ok: true, job: { id: params.id, state: 'queued', stage: 'queued' } } }
    return replies[method]
  } })
  const pair = { id: 'pair-1', projectLabel: 'Работа', workerAgent: 'codex', reviewerAgent: 'claude' }
  f.page.pair(pair)
  f.page.nextAction()
  assert.equal(f.page.items[1].label, 'Быстрая команда')
  f.page.items[1].action(); await flush()
  assert.equal(f.page.items[0].label, 'Продолжай')
  f.page.items[0].action()
  assert.equal(f.page.heading.options.text, 'Отправить связке?')
  assert.equal(sends, 0)
  f.page.items[0].action(); await flush()
  assert.equal(sends, 1)
  const send = f.calls.find(c => c.payload.method === 'ORCA_SEND').payload.params
  assert.deepEqual(Object.keys(send).sort(), ['id', 'pairId', 'presetId'])
  assert.equal(send.presetId, 'continue')
  assert.equal(f.replacements.at(-1).url, 'page/voice')
  const destination = JSON.parse(storage.get('voice-destination'))
  assert.equal(destination.pairId, 'pair-1')
  assert.equal(destination.jobId, send.id)
  assert.equal(destination.resumeJob, true)
})

test('pair menu asks one role by voice with the role in the destination', () => {
  const storage = new Map()
  const f = fixture({ storage })
  const pair = { id: 'pair-1', projectLabel: 'Работа', workerAgent: 'codex', reviewerAgent: 'claude' }
  f.page.pair(pair)
  f.page.items[2].action()
  assert.equal(f.replacements.at(-1).url, 'page/voice')
  const destination = JSON.parse(storage.get('voice-destination'))
  assert.equal(destination.askRole, 'worker')
  assert.equal(destination.pairId, 'pair-1')
  f.page.pair(pair)
  f.page.items[1].action()
  assert.equal(JSON.parse(storage.get('voice-destination')).askRole, 'reviewer')
  f.page.pair(pair)
  f.page.items[0].action()
  assert.equal('askRole' in JSON.parse(storage.get('voice-destination')), false)
  f.page.pair(pair, 1)
  assert.equal(f.page.next.options.visible, false)
  f.page.backAction()
  assert.equal(f.page.items[0].label, 'Задать задачу / ответить')
})

test('project menu creates a private GitHub repository only after confirmation', async () => {
  const workspace = { id: 'repo-1::/work/main', projectLabel: 'Такси Дубай', name: 'main' }
  const f = fixture({ request: async ({ method, params }) => {
    if (method === 'ORCA_GITHUB_CREATE') return { ok: true, operation: { id: params.id, state: 'completed',
      message: 'Приватный репозиторий создан: https://github.com/fikra-labs-official/taksi-dubay',
      github: { url: 'https://github.com/fikra-labs-official/taksi-dubay', existing: false, private: true } } }
    throw Error(method)
  } })
  f.page.project(workspace)
  assert.equal(f.page.items[0].label, 'Готовые связки')
  f.page.nextAction()
  assert.equal(f.page.items[0].label, 'Репозиторий GitHub')
  f.page.items[0].action()
  assert.equal(f.page.heading.options.text, 'Приватный GitHub?')
  assert.equal(f.page.items[0].label, 'Продолжить приватно')
  assert.match(f.page.note.options.text, /Такси Дубай\nmain/)
  assert.match(f.page.note.options.text, /приватный репозиторий/)
  assert.equal(f.calls.length, 0)
  f.page.items[0].action(); await flush()
  const call = f.calls.find(c => c.payload.method === 'ORCA_GITHUB_CREATE').payload.params
  assert.deepEqual(Object.keys(call).sort(), ['id', 'workspaceId'])
  assert.equal(call.workspaceId, workspace.id)
  assert.equal(f.page.heading.options.text, 'GitHub')
  assert.match(f.page.note.options.text, /taksi-dubay/)
  f.page.backAction()
  assert.equal(f.page.items[0].label, 'Готовые связки')
})

test('Orca home note turns into the cross-agent summary line', async () => {
  const f = fixture({ request: async ({ method }) => method === 'SUMMARY' ? { ok: true, text: 'Тишина: агенты свободны' } : { ok: true } })
  assert.equal(f.page.note.options.text, 'Проекты и агенты на твоём Mac')
  await flush(); await flush()
  assert.equal(f.page.note.options.text, 'Тишина: агенты свободны')
  f.page.onDestroy()
})

test('busy terminals cannot be selected', async () => {
  const workspace = { id: 'workspace', projectLabel: 'Проект', name: 'main' }
  const busy = { id: 'busy', title: 'Занятый Codex', agent: 'codex', busy: true }
  const idle = { id: 'idle', title: 'Свободный Claude', agent: 'claude', busy: false }
  const f = fixture({ request: async ({ method }) => method === 'ORCA_TERMINALS'
    ? { ok: true, terminals: [busy, idle], nextCursor: null }
    : { ok: true, text: 'Свободно' } })
  f.page.terminals(workspace, 'worker')
  await flush()
  assert.equal(f.page.items[0].label, 'Занят · Занятый Codex')
  assert.equal(f.page.items[0].action, null)
  f.page.rows[0].options.click_func()
  assert.equal(f.calls.filter(call => call.payload.method === 'ORCA_TERMINALS').length, 1)
  assert.equal(f.page.heading.options.text, 'Выбери боевого')
  f.page.rows[1].options.click_func()
  await flush()
  assert.equal(f.page.heading.options.text, 'Проверяющий')
  f.page.onDestroy()
})

test('wizard Back keeps model and mode choices until the final create request', async () => {
  const workspace = { id: 'workspace', projectLabel: 'Проект', name: 'main' }
  const preset = {
    id: 'pair-preset', label: 'Codex + Claude', workerAgent: 'codex', reviewerAgent: 'claude'
  }
  const f = fixture({ request: async ({ method, params }) => {
    if (method === 'ORCA_MODELS') return { ok: true, nextCursor: null, models: params.agent === 'codex'
      ? [{ id: 'gpt-one', label: 'GPT one' }, { id: 'gpt-two', label: 'GPT two' }]
      : [{ id: 'sonnet', label: 'Sonnet' }] }
    if (method === 'ORCA_MODES') return { ok: true, nextCursor: null, modes: params.agent === 'codex'
      ? [{ id: 'auto', label: 'Авто' }]
      : [{ id: 'plan', label: 'План' }] }
    if (method === 'ORCA_PAIR_CREATE') return { ok: true, operation: { id: params.id, state: 'completed', pair: {
      id: 'new-pair', projectLabel: 'Проект', workerAgent: 'codex', reviewerAgent: 'claude'
    } } }
    if (method === 'SUMMARY') return { ok: true, text: 'Свободно' }
    throw new Error(method)
  } })

  f.page.models(workspace, preset, 'worker')
  await flush()
  f.page.items.find(item => item.label === 'GPT one').action()
  await flush()
  assert.equal(f.page.heading.options.text, 'Модель проверки')
  f.page.backAction()
  await flush()
  assert.equal(f.page.heading.options.text, 'Модель боевого')
  f.page.items.find(item => item.label === 'GPT two').action()
  await flush()
  f.page.items[0].action()
  assert.equal(f.page.heading.options.text, 'Режим агентов')
  f.page.backAction()
  await flush()
  assert.equal(f.page.heading.options.text, 'Модель проверки')
  f.page.items[0].action()
  f.page.items.find(item => item.label === 'Другой режим…').action()
  await flush()
  f.page.items[0].action()
  await flush()
  assert.equal(f.page.heading.options.text, 'Режим проверки')
  f.page.backAction()
  await flush()
  assert.equal(f.page.heading.options.text, 'Режим боевого')
  f.page.items[0].action()
  await flush()
  f.page.items[0].action()
  assert.equal(f.page.heading.options.text, 'Открыть связку?')
  f.page.backAction()
  await flush()
  assert.equal(f.page.heading.options.text, 'Режим проверки')
  f.page.items[0].action()
  f.page.items[0].action()
  await flush()

  const create = f.calls.find(call => call.payload.method === 'ORCA_PAIR_CREATE')
  assert.deepEqual(JSON.parse(JSON.stringify(create.payload.params)), {
    id: '1700000000000-1', workspaceId: 'workspace', presetId: 'pair-preset',
    models: { worker: 'gpt-two', reviewer: 'sonnet' }, modes: { worker: 'auto', reviewer: 'plan' }
  })
  f.page.onDestroy()
})

test('native Back and right swipe use the visible Back action and handlers are removed', async () => {
  const workspace = { id: 'workspace', projectLabel: 'Проект', name: 'main' }
  const f = fixture({ request: async ({ method }) => method === 'ORCA_LIST'
    ? { ok: true, workspaces: [], nextCursor: null }
    : { ok: true, text: 'Свободно' } })
  f.page.project(workspace)
  assert.equal(f.interaction.gesture(10), true)
  await flush()
  assert.equal(f.page.heading.options.text, 'Проекты')
  assert.equal(f.interaction.key(20, 21), true)
  assert.equal(f.page.heading.options.text, 'Orca')
  assert.equal(f.interaction.key(20, 21), false)
  f.page.project(workspace, 1)
  assert.equal(f.interaction.gesture(10), true)
  assert.equal(f.page.items[0].label, 'Готовые связки')
  f.page.onDestroy()
  assert.equal(f.interaction.offGesture, 1)
  assert.equal(f.interaction.offKey, 1)
})

test('long errors use the scroll list without truncating the message', async () => {
  const tail = 'КОНЕЦ_СООБЩЕНИЯ'
  const message = 'Очень подробная ошибка подключения. '.repeat(20) + tail
  const f = fixture({ request: async ({ method }) => {
    if (method === 'SUMMARY') return { ok: true, text: 'Свободно' }
    throw new Error(message)
  } })
  f.page.projects()
  await flush()
  assert.equal(f.page.heading.options.text, 'Не удалось')
  assert.equal(f.page.note.options.visible, false)
  assert.equal(f.page.noteScroll.options.visible, true)
  const rendered = f.page.noteScroll.options.data_array.map(row => row.text + row.separator).join('')
  assert.equal(rendered, message)
  assert.match(rendered, new RegExp(tail))
  f.page.onDestroy()
})

test('a lost create receipt restores by exact operation ID without creating again', async () => {
  const storage = new Map()
  const workspace = { id: 'workspace', projectLabel: 'Atlas', name: 'main' }
  const first = fixture({ storage, request: async ({ method }) => {
    if (method === 'ORCA_GITHUB_CREATE') throw new Error('Квитанция потеряна')
    return { ok: true, text: 'Свободно' }
  } })
  first.page.github(workspace)
  first.page.items[0].action()
  const saved = JSON.parse(storage.get('orca-resume'))
  assert.deepEqual(saved, {
    screen: 'operation', kind: 'provision', id: '1700000000000-1',
    method: 'ORCA_GITHUB_CREATE', workspace
  })
  await flush()
  assert.equal(first.page.items[0].label, 'Проверить операцию')
  first.page.onDestroy()

  const restored = fixture({ storage, request: async ({ method, params }) => {
    assert.equal(method, 'ORCA_OPERATION')
    assert.deepEqual(JSON.parse(JSON.stringify(params)), { id: saved.id })
    return { ok: true, operation: { id: saved.id, state: 'completed',
      message: 'Приватный репозиторий готов', github: { private: true } } }
  } })
  await flush()
  assert.deepEqual(restored.calls.map(call => call.payload.method), ['ORCA_OPERATION'])
  assert.equal(restored.page.heading.options.text, 'GitHub')
  assert.equal(restored.page.note.options.text, 'Приватный репозиторий готов')
  restored.page.onDestroy()
})

test('a lost quick receipt checks the exact job and only explicit retry reuses its ID', async () => {
  const storage = new Map()
  const pair = { id: 'pair-1', projectLabel: 'Работа', workerAgent: 'codex', reviewerAgent: 'claude' }
  const command = { id: 'continue', label: 'Продолжай' }
  const first = fixture({ storage, request: async ({ method }) => {
    if (method === 'ORCA_SEND') throw new Error('Квитанция потеряна')
    return { ok: true, text: 'Свободно' }
  } })
  first.page.sendQuick(pair, command)
  const saved = JSON.parse(storage.get('orca-resume'))
  assert.equal(saved.kind, 'quick')
  assert.equal(saved.id, '1700000000000-1')
  await flush()
  first.page.onDestroy()

  const restored = fixture({ storage, request: async ({ method, params }) => {
    if (method === 'ORCA_JOB') return { ok: false, retryable: false, error: 'Запрос не найден' }
    if (method === 'ORCA_SEND') return { ok: true, job: { id: params.id, state: 'queued' } }
    throw new Error(method)
  } })
  await flush()
  assert.deepEqual(restored.calls.map(call => call.payload.method), ['ORCA_JOB'])
  assert.equal(restored.page.heading.options.text, 'Команда не найдена')
  restored.page.items.find(item => item.label === 'Отправить снова').action()
  await flush()
  assert.deepEqual(restored.calls.map(call => call.payload.method), ['ORCA_JOB', 'ORCA_SEND'])
  assert.equal(restored.calls[1].payload.params.id, saved.id)
  assert.equal(restored.replacements.at(-1).url, 'page/voice')
  assert.equal(JSON.parse(storage.get('voice-destination')).jobId, saved.id)
  restored.page.onDestroy()
})

test('home resumes an existing folder operation or unsent draft without starting another one', () => {
  const contexts = [
    {
      context: { target: 'folder', rootId: 'storage', label: 'Storage', operationId: 'plan-7' },
      draft: null
    },
    {
      context: { target: 'folder', rootId: 'external', label: 'External' },
      draft: { id: '1700000000000-2', text: 'Ответ на уточнение', pendingSend: false }
    }
  ]
  for (const { context, draft } of contexts) {
    const storage = new Map([['voice-destination', JSON.stringify(context)]])
    if (draft) storage.set(`voice-draft:folder:${context.rootId}:`, JSON.stringify(draft))
    const f = fixture({ storage })
    assert.equal(f.page.items[0].label, 'Новая задача')
    assert.equal(f.page.next.options.visible, true)
    f.page.nextAction()
    assert.equal(f.page.items[0].label, 'Продолжить создание')
    f.page.items[0].action()
    assert.equal(f.replacements.at(-1).url, 'page/voice')
    assert.deepEqual(JSON.parse(storage.get('voice-destination')), context)
    assert.equal(f.calls.some(call => call.payload.method.startsWith('ORCA_')), false)
    f.page.onDestroy()
  }

  const stale = fixture({ storage: new Map([['voice-destination', JSON.stringify({
    target: 'folder', rootId: 'storage', label: 'Storage'
  })]]) })
  stale.page.nextAction()
  assert.equal(stale.page.items.some(item => item.label === 'Продолжить создание'), false)
  stale.page.onDestroy()
})

test('a hung Orca mutation times out to exact-ID recovery and destroy cancels all deadlines', async () => {
  const f = fixture({ request: async payload => payload.method === 'SUMMARY'
    ? { ok: true, text: 'На связи' } : new Promise(() => {}) })
  f.page.sendQuick({ id: 'pair-1', projectLabel: 'Работа' }, { id: 'status', label: 'Статус' })
  await flush()
  assert.equal(f.page.mutationPending, true)
  const timeout = [...f.timers.values()].find(timer => timer.delay === 18000)
  assert.ok(timeout)
  timeout.callback(); await flush()
  assert.equal(f.page.mutationPending, false)
  assert.equal(f.page.items[0].label, 'Проверить отправку')
  const saved = JSON.parse(f.storage.get('orca-resume'))
  f.page.items[0].action(); await flush()
  assert.equal(f.calls.at(-1).payload.method, 'ORCA_JOB')
  assert.equal(f.calls.at(-1).payload.params.id, saved.id)
  f.page.onDestroy()
  assert.equal(f.timers.size, 0)
})
