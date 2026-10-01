import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../page/orca.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '')
const flush = () => new Promise(resolve => setImmediate(resolve))

function fixture({ width = 390, height = 450, request = async () => ({ ok: true }),
  storage = new Map() } = {}) {
  let page
  const widgets = []
  const replacements = []
  const wakeCalls = []
  vm.runInNewContext(source, {
    Page(definition) { page = Object.assign(Object.create(definition), definition) },
    BasePage: value => value,
    getDeviceInfo: () => ({ width, height }),
    replace: value => replacements.push(value),
    setWakeUpRelaunch: value => wakeCalls.push(value),
    LocalStorage: class {
      getItem(key) { return storage.get(key) }
      setItem(key, value) { storage.set(key, value) }
    },
    createWidget(kind, options) {
      const item = {
        kind,
        options: { visible: true, ...options },
        setProperty(property, value) {
          if (property === 'more') Object.assign(this.options, value)
          else this.options[property] = value
        }
      }
      widgets.push(item)
      return item
    },
    widget: { FILL_RECT: 1, TEXT: 2, BUTTON: 3 },
    align: { CENTER_H: 1 },
    text_style: { WRAP: 1 },
    prop: { TEXT: 'text', VISIBLE: 'visible', MORE: 'more' },
    Date: class extends Date { static now() { return 1700000000000 } },
    console: { log() {} }
  })
  const calls = []
  page.request = (payload, options) => {
    if (payload.method !== 'SUMMARY') calls.push({ payload, options })  // home summary is background noise here
    return request(payload, options)
  }
  page.build()
  return { page, widgets, replacements, storage, calls, wakeCalls }
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
    assert.equal(f.page.items[0].label, 'Текущие проекты')
    assert.equal(f.replacements.length, 0)
  }
})

test('a late catalog reply cannot replace any newer menu page', async () => {
  let finish
  const f = fixture({ request: () => new Promise(resolve => { finish = resolve }) })
  f.page.projects()
  assert.equal(f.page.heading.options.text, 'Orca')
  assert.match(f.page.note.options.text, /Получаю данные/)
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
  assert.equal(f.page.backAction, undefined)
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
    for (let i = 1; i < f.page.rows.length; i++) {
      const above = f.page.rows[i - 1].options
      const below = f.page.rows[i].options
      assert.ok(below.y - above.y - above.h >= f.page.px(18), 'rows need visible physical spacing')
    }
    const workspace = { id: 'workspace', projectLabel: 'Проект', name: 'main' }
    const worker = { id: 'worker', title: 'Боевой' }
    const reviewer = { id: 'reviewer', title: 'Проверяющий' }
    f.page.confirmPair(workspace, worker, reviewer)
    const visible = f.widgets.filter(item => item.kind !== 1 && item.options.visible)
      .map(item => item.options)
    for (let index = 0; index < visible.length; index += 1) {
      const item = visible[index]
      assert.ok(item.x >= 0 && item.y >= 0 && item.x + item.w <= width && item.y + item.h <= height,
        `${item.text} must fit ${width}x${height}`)
      for (const other of visible.slice(index + 1)) {
        const overlap = item.x < other.x + other.w && item.x + item.w > other.x &&
          item.y < other.y + other.h && item.y + item.h > other.y
        assert.equal(overlap, false, `${item.text} overlaps ${other.text} at ${width}x${height}`)
      }
    }
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
  assert.equal(orphan.page.items[0].label, 'Текущие проекты')
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
  assert.equal(f.page.heading.options.text, 'Приватный репозиторий?')
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
