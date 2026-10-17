import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const textRowsSource = fs.readFileSync(new URL('../shared/text-rows.js', import.meta.url), 'utf8')
  .replace('export function textRows', 'function textRows')
const shared = textRowsSource + '\n' + fs.readFileSync(new URL('../shared/agent-menu.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replace('export function createAgentMenuPage', 'function createAgentMenuPage')
const entries = {
  claude: fs.readFileSync(new URL('../page/claude.js', import.meta.url), 'utf8').replace(/^import .*$/gm, ''),
  codex: fs.readFileSync(new URL('../page/codex.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '')
}
const flush = () => new Promise(resolve => setImmediate(resolve))

function fixture({ kind = 'claude', request = async () => ({ ok: true }), storage = new Map(),
  device = { width: 390, height: 450 }, storageThrows = 0 } = {}) {
  let page
  const replacements = []
  const widgets = []
  const interaction = { gesture: null, key: null, offGesture: 0, offKey: 0 }
  const timers = new Map()
  const statusBar = []
  let nextTimer = 1
  let storageFailures = storageThrows
  const clock = {
    setTimeout(callback, delay) { const id = nextTimer++; timers.set(id, { callback, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    expire(delay) {
      for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback() }
    }
  }
  vm.runInNewContext(shared + '\n' + entries[kind], {
    Page(definition) { page = Object.assign(Object.create(definition), definition) },
    BasePage: value => value,
    getDeviceInfo: () => device,
    replace: value => replacements.push(value),
    routerBack: () => replacements.push({ back: true }),
    setWakeUpRelaunch() {},
    setStatusBarVisible(value) { statusBar.push(value) },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    getTextLayout(text, options) { return { result: 0, width: Array.from(text).length * options.text_size * 0.7 } },
    LocalStorage: class {
      constructor() { if (storageFailures > 0) { storageFailures -= 1; throw new Error('storage unavailable') } }
      getItem(key) { return storage.get(key) }
      setItem(key, value) { storage.set(key, value) }
    },
    createWidget(kind, options) {
      const result = { kind, options: { visible: true, ...options }, setProperty(property, value) {
        if (kind === 3 && property === 'more') {
          for (const key of ['x', 'y', 'w', 'h', 'text']) assert.ok(Object.hasOwn(value, key), 'Native button update requires ' + key)
        }
        if (property === 'more' || property === 'update-data') Object.assign(this.options, value); else this.options[property] = value
      } }
      widgets.push(result)
      return result
    },
    widget: { FILL_RECT: 1, TEXT: 2, BUTTON: 3, SCROLL_LIST: 4 }, align: { CENTER_H: 1, CENTER_V: 2 }, text_style: { WRAP: 1 },
    prop: { TEXT: 'text', VISIBLE: 'visible', MORE: 'more', UPDATE_DATA: 'update-data' },
    onGesture({ callback }) { interaction.gesture = callback }, offGesture() { interaction.offGesture += 1 },
    onKey({ callback }) { interaction.key = callback }, offKey() { interaction.offKey += 1 },
    GESTURE_RIGHT: 10, KEY_BACK: 20, KEY_EVENT_CLICK: 21,
    Date: class extends Date { static now() { return 1700000000000 } },
    console: { log() {} }
  })
  const calls = []
  page.request = (payload, options) => { calls.push({ payload, options }); return request(payload, options) }
  page.build()
  return { page, replacements, storage, calls, interaction, timers, clock, statusBar, widgets }
}

const project = { id: '/work/crm', label: 'CRM' }
const replies = {
  CLAUDE_PROJECTS: { ok: true, projects: [project], nextCursor: null },
  CLAUDE_MODES: { ok: true, modes: [{ id: 'auto', label: 'Авто' }, { id: 'plan', label: 'План' }], nextCursor: null },
  CLAUDE_SESSIONS: { ok: true, sessions: [{ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', label: 'Починить оплату' }], nextCursor: null },
  CLAUDE_QUICK_LIST: { ok: true, items: [{ id: 'broken', label: 'Что упало?' }], nextCursor: null }
}

test('project menu dictates with the chosen mode and can continue a saved session', async () => {
  const f = fixture({ request: async ({ method }) => replies[method] })
  assert.equal(f.page.items[0].label, 'Новая задача')
  f.page.items.find(item => item.label === 'Проекты').action(); await flush()
  assert.equal(f.page.items[0].label, 'CRM')
  f.page.items[0].action()
  assert.equal(f.page.items[1].label, 'Режим: Авто')
  assert.deepEqual(JSON.parse(f.storage.get('claude-resume')), { screen: 'project', project })
  f.page.items[1].action(); await flush()
  f.page.items.find(item => item.label === 'План').action()
  assert.equal(f.page.items[1].label, 'Режим: План')
  f.page.items[0].action()
  assert.deepEqual(JSON.parse(f.storage.get('voice-destination')), { target: 'claude', project: '/work/crm', label: 'CRM', mode: 'plan', modeLabel: 'План', startFresh: true })
  assert.equal(f.replacements.at(-1).url, 'page/voice')
  f.page.project(project)
  f.page.items[2].action(); await flush()
  assert.equal(f.page.items[0].label, 'Починить оплату')
  f.page.items[0].action()
  assert.deepEqual(JSON.parse(f.storage.get('voice-destination')), {
    target: 'claude', project: '/work/crm', label: 'CRM', mode: 'plan', modeLabel: 'План',
    sessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', startFresh: true
  })
  assert.equal(f.calls.some(c => c.payload.method === 'CLAUDE_SEND'), false)
})

test('sleep restores project, voice and history screens; last task reopens the voice page', async () => {
  const storage = new Map([['claude-resume', JSON.stringify({ screen: 'project', project })]])
  const a = fixture({ storage })
  assert.equal(a.page.items[0].label, 'Новая задача')
  const b = fixture({ storage: new Map([['claude-resume', JSON.stringify({ screen: 'history' })]]) })
  assert.equal(b.replacements.at(-1).url, 'page/history')
  const c = fixture({ storage: new Map([['claude-resume', JSON.stringify({ screen: 'voice' })]]) })
  assert.equal(c.page.items[0].label, 'Новая задача')
  const d = fixture({ storage: new Map([['voice-destination', JSON.stringify({
    target: 'claude', project: '/work/crm', jobId: 'last-job'
  })]]) })
  d.page.lastTask()
  assert.equal(d.replacements.at(-1).url, 'page/voice')
  assert.deepEqual(JSON.parse(d.storage.get('voice-destination')), {
    target: 'claude', project: '/work/crm', jobId: 'last-job', resumeJob: true, startFresh: false
  })
  const noExactJob = fixture({ storage: new Map([['voice-destination', JSON.stringify({
    target: 'claude', project: '/work/crm', sessionId: 'draft-only'
  })]]) })
  noExactJob.page.lastTask()
  await flush()
  assert.equal(noExactJob.replacements.length, 0)
  assert.equal(noExactJob.calls.some(call => call.payload.method === 'CLAUDE_PROJECTS'), false)
  assert.equal(noExactJob.page.heading.options.text, 'Пока нет задач')
  const e = fixture()
  e.page.items[2].action()
  assert.equal(e.replacements.at(-1).url, 'page/history')
  assert.deepEqual(JSON.parse(e.storage.get('claude-history-view')), { screen: 'home' })

  const exact = { target: 'claude', project: '/work/crm', label: 'CRM', sessionId: 'selected-session',
    jobId: '1700000000000-9', aliasId: '1700000000000-9', startFresh: true }
  const x = fixture({ storage: new Map([['voice-destination', JSON.stringify(exact)]]) })
  x.page.lastTask()
  assert.deepEqual(JSON.parse(x.storage.get('voice-destination')), {
    ...exact, resumeJob: true, startFresh: false
  })
})

test('codex menu uses CODEX methods, its own storage keys and mode labels', async () => {
  const codexReplies = {
    CODEX_PROJECTS: { ok: true, projects: [project], nextCursor: null },
    CODEX_MODES: { ok: true, modes: [{ id: 'auto', label: 'Авто' }, { id: 'read-only', label: 'Только чтение' }], nextCursor: null }
  }
  const f = fixture({ kind: 'codex', request: async ({ method }) => codexReplies[method] })
  assert.equal(f.page.heading.options.text, 'Codex')
  f.page.items.find(item => item.label === 'Проекты').action(); await flush()
  assert.equal(f.calls[0].payload.method, 'CODEX_PROJECTS')
  f.page.items[0].action()
  assert.equal(f.page.items[1].label, 'Режим: Авто')
  assert.deepEqual(JSON.parse(f.storage.get('codex-resume')), { screen: 'project', project })
  f.page.items[1].action(); await flush()
  f.page.items.find(item => item.label === 'Только чтение').action()
  assert.equal(f.page.items[1].label, 'Режим: Только чтение')
  f.page.items[0].action()
  const destination = JSON.parse(f.storage.get('voice-destination'))
  assert.equal(destination.target, 'codex')
  assert.equal(destination.mode, 'read-only')
  assert.equal(destination.modeLabel, 'Только чтение')
  assert.equal(f.replacements.at(-1).url, 'page/voice')
})

test('night shift screen lists waiting tasks, starts or stops the shift, and queues a project task for the night', async () => {
  let active = false
  const jobs = [{ id: '1-1', text: 'Прогони тесты', projectLabel: 'CRM' }]
  const f = fixture({ request: async ({ method, params }) => {
    if (method === 'CLAUDE_NIGHT') return { ok: true, active, at: '01:00', count: jobs.length, jobs, nextCursor: null }
    if (method === 'CLAUDE_NIGHT_RUN') { active = true; return { ok: true, started: true } }
    if (method === 'CLAUDE_NIGHT_STOP') { active = false; return { ok: true } }
    if (method === 'CLAUDE_HISTORY_SET_DELETED') { jobs.length = 0; assert.deepEqual({ ...params }, { id: '1-1', deleted: true }); return { ok: true } }
    return replies[method]
  } })
  f.page.nextAction(); // home → second page
  assert.equal(f.page.items[0].label, 'Ночная смена')
  f.page.items[0].action(); await flush()
  assert.equal(f.page.note.options.text, 'Старт в 01:00 · задач: 1')
  assert.equal(f.page.items[0].label, 'Запустить сейчас')
  assert.equal(f.page.items[1].label, 'CRM · Прогони тесты')
  assert.deepEqual(JSON.parse(f.storage.get('claude-resume')), { screen: 'night' })
  f.page.items[0].action()
  assert.equal(f.page.mutationPending, true)
  await flush(); await flush()
  assert.equal(f.page.note.options.text, 'Идёт сейчас · задач: 1')
  assert.equal(f.page.items[0].label, 'Остановить смену')
  f.page.items[0].action()
  assert.deepEqual([...f.page.items.map(item => item.label)], ['Отмена', 'Остановить'])
  f.page.items[1].action(); await flush(); await flush()
  assert.equal(f.page.items[0].label, 'Запустить сейчас')
  f.page.items[1].action()
  assert.equal(f.page.items[0].label, 'Убрать из смены')
  f.page.items[0].action(); await flush(); await flush()
  assert.equal(f.page.items[0].label, 'Добавить задачу')
  f.page.project(project)
  f.page.nextAction(); await flush()
  assert.equal(f.page.items[0].label, 'В ночную смену')
  f.page.items[0].action()
  assert.deepEqual(JSON.parse(f.storage.get('voice-destination')),
    { target: 'claude', project: '/work/crm', label: 'CRM', mode: 'auto', modeLabel: 'Авто · ночью', night: true, startFresh: true })
  assert.equal(f.replacements.at(-1).url, 'page/voice')
  const back = fixture({ storage: new Map([['claude-resume', JSON.stringify({ screen: 'night' })]]),
    request: async () => ({ ok: true, active: false, at: '', count: 0, jobs: [], nextCursor: null }) })
  await flush()
  assert.equal(back.page.note.options.text, 'Старт вручную · задач: 0')
})

test('research screen dictates a topic for one agent or both', async () => {
  const f = fixture()
  f.page.nextAction()
  assert.equal(f.page.items[1].label, 'Исследование')
  f.page.items[1].action()
  assert.deepEqual([...f.page.items.map(i => i.label)], ['Быстрое: Claude', 'Быстрое: Claude + Codex', 'Большое: Claude'])
  f.page.items[2].action()
  assert.deepEqual(JSON.parse(f.storage.get('voice-destination')),
    { target: 'claude', project: 'research', label: 'Исследование', mode: 'auto', modeLabel: 'Большое · Claude', kind: 'deep', both: false, startFresh: true })
  f.page.research()
  f.page.items[1].action()
  assert.deepEqual(JSON.parse(f.storage.get('voice-destination')),
    { target: 'claude', project: 'research', label: 'Исследование', mode: 'auto', modeLabel: 'Claude + Codex', kind: 'research', both: true, startFresh: true })
  assert.equal(f.replacements.at(-1).url, 'page/voice')
  const g = fixture({ kind: 'codex' })
  g.page.nextAction(); g.page.items[1].action()
  assert.deepEqual([...g.page.items.map(i => i.label)], ['Быстрое: Codex', 'Быстрое: Codex + Claude'])
  g.page.items[0].action()
  assert.equal(JSON.parse(g.storage.get('voice-destination')).both, false)
  assert.equal(JSON.parse(g.storage.get('voice-destination')).modeLabel, 'Codex')
})

test('project quick commands run a preset without dictation and open the task screen', async () => {
  const sent = []
  const f = fixture({ request: async ({ method, params }) => {
    if (method === 'CLAUDE_QUICK_LIST') return { ok: true, items: [{ id: 'broken', label: 'Что упало?' }, { id: 'status', label: 'Статус проекта' }], nextCursor: null }
    if (method === 'CLAUDE_SEND') { sent.push({ ...params }); return { ok: true, job: { id: params.id, state: 'queued' } } }
    return replies[method]
  } })
  f.page.project(project)
  f.page.nextAction(); await flush()
  assert.deepEqual([...f.page.items.map(i => i.label)], ['В ночную смену', 'Что упало?', 'Статус проекта'])
  f.page.items[1].action(); await flush(); await flush()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].presetId, 'broken')
  assert.equal(sent[0].project, '/work/crm')
  assert.match(sent[0].id, /^\d+-\d+$/)
  const destination = JSON.parse(f.storage.get('voice-destination'))
  assert.equal(destination.resumeJob, true)
  assert.equal(destination.jobId, sent[0].id)
  assert.equal(destination.modeLabel, 'Что упало?')
  assert.equal(f.replacements.at(-1).url, 'page/voice')
})

test('Dozor screen lists checks, adds a site by voice or a project CI, checks and removes', async () => {
  const calls = []
  let items = [{ id: 'a1b2c3d4e5f6', kind: 'url', label: 'fikra.io', state: 'down', detail: 'HTTP 503' }]
  const f = fixture({ request: async ({ method, params }) => {
    calls.push({ method, params: { ...params } })
    if (method === 'WATCH_LIST') return { ok: true, items, count: items.length, nextCursor: null }
    if (method === 'WATCH_ADD') { items = [...items, { id: 'ffffffffffff', kind: 'ci', label: 'CRM', state: 'ok', detail: 'Tests · main: success' }]; return { ok: true, watch: items[1] } }
    if (method === 'WATCH_CHECK') return { ok: true, watch: { ...items[0], state: 'ok', detail: 'HTTP 200' } }
    if (method === 'WATCH_REMOVE') { items = items.slice(1); return { ok: true } }
    return replies[method]
  } })
  f.page.nextAction()
  assert.equal(f.page.items[2].label, 'Дозор')
  f.page.items[2].action(); await flush()
  assert.equal(f.page.note.options.text, 'Проверок: 1')
  assert.deepEqual([...f.page.items.map(i => i.label)], ['Добавить', 'fikra.io · упало'])
  assert.deepEqual(JSON.parse(f.storage.get('claude-resume')), { screen: 'watches' })
  f.page.items[0].action()
  assert.deepEqual([...f.page.items.map(i => i.label)], ['Сайт голосом', 'CI проекта…'])
  f.page.items[1].action(); await flush()
  assert.equal(f.page.items[0].label, 'CRM')
  f.page.items[0].action(); await flush(); await flush()
  assert.deepEqual(calls.find(c => c.method === 'WATCH_ADD').params, { kind: 'ci', project: '/work/crm', label: 'CRM' })
  assert.equal(f.page.note.options.text, 'Проверок: 2')
  f.page.items[1].action()
  assert.equal(f.page.heading.options.text, 'fikra.io')
  assert.match(f.page.note.options.text, /упало\nHTTP 503/)
  f.page.items[0].action(); await flush()
  assert.match(f.page.note.options.text, /в порядке\nHTTP 200/)
  f.page.items[1].action(); await flush(); await flush()
  assert.deepEqual(calls.find(c => c.method === 'WATCH_REMOVE').params, { id: 'a1b2c3d4e5f6' })
  assert.equal(f.page.note.options.text, 'Проверок: 1')
  f.page.items[0].action()
  f.page.items[0].action()
  assert.deepEqual(JSON.parse(f.storage.get('voice-destination')), { target: 'claude', project: 'watch', label: 'Дозор', mode: 'auto', modeLabel: 'Адрес сайта словами', kind: 'watch', startFresh: true })
})

test('PR review offers open pull requests of the project or the number by voice', async () => {
  const sent = []
  const f = fixture({ request: async ({ method, params }) => {
    if (method === 'CLAUDE_QUICK_LIST') return { ok: true, items: [{ id: 'review', label: 'Ревью PR', arg: 'pr' }], nextCursor: null }
    if (method === 'CLAUDE_PRS') return { ok: true, repo: 'fikra/crm', items: [{ number: 12, title: 'Оплата картой', branch: 'pay', author: 'owner' }], nextCursor: null }
    if (method === 'CLAUDE_SEND') { sent.push({ ...params }); return { ok: true, job: { id: params.id, state: 'queued' } } }
    return replies[method]
  } })
  f.page.project(project)
  f.page.nextAction(); await flush()
  assert.equal(f.page.items[1].label, 'Ревью PR…')
  f.page.items[1].action(); await flush()
  assert.equal(f.page.note.options.text, 'Открытые PR · fikra/crm')
  assert.deepEqual([...f.page.items.map(i => i.label)], ['Номер голосом', '#12 · Оплата картой'])
  f.page.items[1].action(); await flush(); await flush()
  assert.equal(sent[0].presetId, 'review')
  assert.equal(sent[0].pr, 12)
  assert.equal(JSON.parse(f.storage.get('voice-destination')).modeLabel, 'Ревью PR #12')
  f.page.project(project); f.page.nextAction(); await flush()
  f.page.items[1].action(); await flush()
  f.page.items[0].action()
  const byVoice = JSON.parse(f.storage.get('voice-destination'))
  assert.equal(byVoice.presetId, 'review')
  assert.equal(byVoice.modeLabel, 'Скажи номер PR')
  assert.equal(byVoice.jobId, undefined)
})

test('home note turns into the cross-agent summary line', async () => {
  const f = fixture({ request: async ({ method }) => method === 'SUMMARY'
    ? { ok: true, text: 'Работают 2 · ждут решения 1 · готово 3' } : replies[method] })
  assert.equal(f.page.note.options.text, 'Claude в проектах на Mac')
  await flush(); await flush()
  assert.equal(f.page.note.options.text, 'Работают 2 · ждут решения 1 · готово 3')
  const g = fixture({ request: async ({ method }) => method === 'SUMMARY' ? { ok: false, error: 'нет моста' } : replies[method] })
  await flush(); await flush()
  assert.equal(g.page.note.options.text, 'Mac не ответил. Проверь Zepp и повтори связь.')
  assert.equal(g.page.items[1].label, 'Повторить связь')
  assert.equal(g.page.items[0].label, 'Новая задача')
})

test('question screen lists the options and sends the choice, then returns to the task', async () => {
  const sent = []
  const saved = { screen: 'question', jobId: 'job-1', approvalId: '0123456789abcdef', question: 'Какой цвет выбрать?', options: ['Красный', 'Синий', 'Зелёный', 'Жёлтый'] }
  const f = fixture({ storage: new Map([['claude-resume', JSON.stringify(saved)]]), request: async ({ method, params }) => {
    if (method === 'CLAUDE_APPROVE') { sent.push({ ...params }); return { ok: true, job: { id: 'job-1', state: 'running' } } }
    return replies[method]
  } })
  assert.equal(f.page.heading.options.text, 'Вопрос от Claude')
  assert.equal(f.page.note.options.text, 'Какой цвет выбрать?')
  assert.deepEqual([...f.page.items.map(i => i.label)], ['Красный', 'Синий', 'Зелёный'])
  f.page.nextAction()
  assert.deepEqual([...f.page.items.map(i => i.label)], ['Жёлтый'])
  f.page.backAction()
  f.page.items[1].action()
  assert.equal(f.page.heading.options.text, 'Ответить так?')
  assert.equal(f.page.note.options.text, 'Синий')
  assert.deepEqual([...f.page.items.map(i => i.label)], ['Отмена', 'Ответить'])
  f.page.items[1].action(); await flush(); await flush()
  assert.deepEqual(sent, [{ id: 'job-1', approvalId: '0123456789abcdef', allow: true, answer: 'Синий' }])
  assert.deepEqual(JSON.parse(f.storage.get('claude-resume')), { screen: 'voice' })
  assert.equal(f.replacements.at(-1).url, 'page/voice')
})

test('full access requires confirmation and remains scoped to one project', async () => {
  const shop = { id: '/work/shop', label: 'Shop' }
  const f = fixture({ request: async ({ method }) => method === 'CLAUDE_MODES'
    ? { ok: true, modes: [{ id: 'auto', label: 'Авто' }, { id: 'bypass', label: 'Без ограничений' }], nextCursor: null }
    : replies[method] })

  f.page.project(project)
  f.page.items[1].action(); await flush()
  f.page.items.find(item => item.label === 'Без ограничений').action()
  assert.equal(f.page.heading.options.text, 'Без ограничений?')
  assert.match(f.page.note.options.text, /только для проекта\nCRM/i)
  assert.equal(f.storage.has('claude-mode:/work/crm'), false)
  f.page.items[0].action(); await flush()
  f.page.items.find(item => item.label === 'Без ограничений').action()
  f.page.items[1].action()
  assert.equal(f.storage.get('claude-mode:/work/crm'), 'bypass')
  assert.equal(f.page.items[1].label, 'Режим: Без ограничений')

  f.page.project(shop)
  assert.equal(f.page.items[1].label, 'Режим: Авто')
  assert.equal(f.storage.has('claude-mode:/work/shop'), false)
})

test('preset mutation persists its exact id and blocks Back until the receipt is known', async () => {
  let finishSend
  const send = new Promise(resolve => { finishSend = resolve })
  const f = fixture({ request: async ({ method, params }) => {
    if (method === 'CLAUDE_QUICK_LIST') return replies.CLAUDE_QUICK_LIST
    if (method === 'CLAUDE_SEND') return send
    return replies[method]
  } })
  f.page.project(project)
  f.page.nextAction(); await flush()
  f.page.items[1].action()
  const pending = JSON.parse(f.storage.get('voice-destination'))
  assert.equal(pending.pendingSend, true)
  assert.equal(pending.resumeJob, true)
  assert.match(pending.jobId, /^\d+-\d+$/)
  assert.deepEqual(JSON.parse(f.storage.get('claude-resume')), { screen: 'voice' })
  assert.equal(f.page.mutationPending, true)
  assert.equal(f.page.back.options.visible, false)
  assert.equal(f.interaction.gesture(10), true)
  assert.equal(f.interaction.key(20, 21), true)
  assert.equal(f.replacements.length, 0)

  finishSend({ ok: true, job: { id: pending.jobId, state: 'queued' } })
  await flush(); await flush()
  const accepted = JSON.parse(f.storage.get('voice-destination'))
  assert.equal(accepted.jobId, pending.jobId)
  assert.equal(accepted.pendingSend, false)
  assert.equal(f.replacements.at(-1).url, 'page/voice')
})

test('soft ping failure is visible and can recover without leaving home', async () => {
  let online = false
  const f = fixture({ request: async ({ method }) => method === 'SUMMARY'
    ? online ? { ok: true, text: 'Mac на связи' } : { ok: false, error: 'offline' }
    : replies[method] })
  await flush(); await flush()
  assert.equal(f.page.items[0].label, 'Новая задача')
  assert.equal(f.page.items[1].label, 'Повторить связь')
  online = true
  f.page.items[1].action()
  await flush(); await flush()
  assert.equal(f.page.note.options.text, 'Mac на связи')
  assert.equal(f.page.items[1].label, 'Проекты')
})

test('native Back, scroll rows and controls stay usable on supported compact and wide sizes', () => {
  for (const device of [{ width: 390, height: 450 }, { width: 432, height: 514 }, { width: 390, height: 400 }]) {
    const longQuestion = 'Какой вариант выбрать для очень длинного вопроса '.repeat(5)
    const longOption = '👩‍💻 مرحبًا. Первый длинный вариант ответа '.repeat(4)
    const saved = { screen: 'question', jobId: 'job-1', approvalId: '0123456789abcdef',
      question: longQuestion, options: [longOption, 'Второй', 'Третий'] }
    const f = fixture({ device, storage: new Map([['claude-resume', JSON.stringify(saved)]]) })
    assert.equal(f.page.rows.length, 3)
    assert.ok(f.page.rows.every(row => row.kind === 3 && row.options.h >= 44))
    assert.ok(f.page.back.options.h >= 44)
    assert.ok(f.page.next.options.h >= 44)
    assert.ok(f.page.back.options.x >= 0 && f.page.back.options.x + f.page.back.options.w <= device.width)
    assert.ok(f.page.next.options.x >= 0 && f.page.next.options.x + f.page.next.options.w <= device.width)
    assert.ok(f.page.back.options.y + f.page.back.options.h <= device.height)
    assert.ok(f.page.next.options.y + f.page.next.options.h <= device.height)
    assert.equal(f.page.noteScroll.options.visible, true)
    assert.ok(f.page.noteScroll.options.data_count > 2)
    assert.equal(f.page.items[0].label, longOption)
    assert.ok(f.page.rows[0].options.text.endsWith('…'))
    f.page.items[0].action()
    assert.equal(f.page.note.options.text, longOption)
    assert.equal(f.page.noteScroll.options.data_array.map(row => row.text).join(''), longOption)
    f.page.backAction()
    assert.equal(f.interaction.gesture(10), true)
    assert.equal(f.replacements.at(-1).url, 'page/voice')
    f.page.onDestroy()
    assert.equal(f.interaction.offGesture, 1)
    assert.equal(f.interaction.offKey, 1)
    assert.deepEqual(f.statusBar, [false, true])
  }
})

test('an unresolved mutation expires at the outer deadline and reconciles without sending twice', async () => {
  const never = new Promise(() => {})
  const f = fixture({ request: async ({ method }) => method === 'WATCH_CHECK' ? never : replies[method] })
  f.page.watchItem({ id: 'watch-1', label: 'Site', state: 'down', detail: 'timeout' })
  f.page.items[0].action()
  await flush()
  assert.equal(f.page.mutationPending, true)
  assert.equal([...f.timers.values()].some(timer => timer.delay === 18000), true)
  f.clock.expire(18000)
  await flush(); await flush()
  assert.equal(f.page.mutationPending, false)
  assert.equal(f.page.items[0].label, 'Проверить статус')
  assert.equal(f.calls.filter(call => call.payload.method === 'WATCH_CHECK').length, 1)
  f.page.items[0].action()
  assert.equal(f.calls.filter(call => call.payload.method === 'WATCH_CHECK').length, 1)
})

test('new views and destroy cancel pending outer deadlines', async () => {
  const f = fixture({ request: async ({ method }) => ['CLAUDE_PROJECTS', 'SUMMARY'].includes(method) ? new Promise(() => {}) : replies[method] })
  f.page.projects()
  await flush()
  assert.equal([...f.timers.values()].some(timer => timer.delay === 18000), true)
  f.page.home()
  assert.equal([...f.timers.values()].some(timer => timer.delay === 18000), false)
  await flush()
  assert.equal([...f.timers.values()].some(timer => timer.delay === 10000), true)
  f.page.onDestroy()
  assert.equal(f.timers.size, 0)
})

test('cursor Back reloads the previous page instead of leaving the list', async () => {
  const seen = []
  const f = fixture({ request: async ({ method, params }) => {
    if (method === 'CLAUDE_PROJECTS') {
      seen.push(params.cursor)
      return params.cursor === 'page-2'
        ? { ok: true, projects: [{ id: '/two', label: 'Two' }], nextCursor: null }
        : { ok: true, projects: [{ id: '/one', label: 'One' }], nextCursor: 'page-2' }
    }
    return replies[method]
  } })
  f.page.projects(); await flush(); await flush()
  f.page.nextAction(); await flush(); await flush()
  assert.equal(f.page.items[0].label, 'Two')
  f.page.backAction(); await flush(); await flush()
  assert.equal(f.page.items[0].label, 'One')
  assert.deepEqual(seen, [undefined, 'page-2', undefined])
})

test('storage construction failure renders retry and exit actions', () => {
  const f = fixture({ storageThrows: 2 })
  assert.equal(f.page.heading.options.text, 'Не удалось')
  assert.deepEqual([...f.page.items.map(item => item.label)], ['Повторить', 'Выйти'])
  f.page.items[0].action()
  assert.equal(f.page.heading.options.text, 'Не удалось')
  f.page.items[1].action()
  assert.deepEqual(f.replacements.at(-1), { back: true })
})

test('authoritative preset rejection clears only its pending context and returns to commands', async () => {
  const f = fixture({ request: async ({ method, params }) => {
    if (method === 'CLAUDE_QUICK_LIST') return replies.CLAUDE_QUICK_LIST
    if (method === 'CLAUDE_SEND') return { ok: false, retryable: false, error: `rejected ${params.id}` }
    return replies[method]
  } })
  f.page.project(project)
  f.page.nextAction(); await flush(); await flush()
  f.page.items[1].action(); await flush(); await flush()
  assert.equal(f.storage.get('voice-destination'), '')
  assert.equal(f.page.heading.options.text, 'Не удалось')
  assert.equal(f.page.items[0].label, 'Вернуться к командам')
  assert.equal(f.calls.filter(call => call.payload.method === 'CLAUDE_SEND').length, 1)
})


test('New task is first and opens a fresh general compose without a catalog or task dispatch', async () => {
  for (const kind of ['claude', 'codex']) {
    const old = { target: kind, project: '/work/crm', label: 'CRM', mode: 'auto',
      sessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', jobId: '1700000000000-8' }
    const f = fixture({ kind, storage: new Map([['voice-destination', JSON.stringify(old)]]),
      request: async () => new Promise(() => {}) })
    assert.equal(f.page.rows[0].options.text, 'Новая задача')
    f.page.rows[0].options.click_func()
    assert.equal(f.replacements.at(-1).url, 'page/voice')
    assert.deepEqual(JSON.parse(f.storage.get('voice-destination')), {
      target: kind, project: 'general', label: 'Общая задача', mode: 'auto', modeLabel: 'Авто',
      startFresh: true, autoRecord: false
    })
    assert.deepEqual(JSON.parse(f.storage.get(kind + '-last-task')), old)
    f.page.more(1)
    f.page.items.find(item => item.label === 'Последняя задача').action()
    assert.equal(JSON.parse(f.storage.get('voice-destination')).jobId, old.jobId)
    await flush()
    assert.equal(f.calls.some(call => /_(PROJECTS|SEND|LATEST)$/.test(call.payload.method)), false)
  }
})

test('home, More and menu controls have disjoint native rectangles on every target size', () => {
  for (const kind of ['claude', 'codex']) for (const device of [
    { width: 432, height: 514 }, { width: 390, height: 450 }, { width: 390, height: 400 }
  ]) {
    const f = fixture({ kind, device, request: async () => new Promise(() => {}) })
    const assertLayout = () => {
      const visible = f.widgets.filter(w => w.options.visible && w.kind !== 1)
      for (const current of visible) {
        const a = current.options
        assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.w <= device.width && a.y + a.h <= device.height)
        for (const other of visible) {
          if (current === other) continue
          const b = other.options
          const overlap = Math.min(a.x+a.w,b.x+b.w)>Math.max(a.x,b.x) &&
            Math.min(a.y+a.h,b.y+b.h)>Math.max(a.y,b.y)
          assert.equal(overlap, false, JSON.stringify({ a, b }))
        }
      }
      for (const row of f.page.rows.filter(w => w.options.visible)) {
        assert.equal(row.kind, 3)
        assert.ok(row.options.h >= 44)
      }
    }
    assertLayout()
    f.page.next.options.click_func(); assertLayout()
    assert.deepEqual([...f.page.items.map(x => x.label)], ['Ночная смена', 'Исследование', 'Дозор'])
    f.page.next.options.click_func(); assertLayout()
    assert.equal(f.page.items[0].label, 'Последняя задача')
    f.page.back.options.click_func(); assertLayout()
    f.page.show('Длинный вопрос', 'Подробности '.repeat(30), [
      { label: 'Длинный вариант '.repeat(30), action() {} },
      { label: 'Второй', action() {} }, { label: 'Третий', action() {} }
    ], () => {}, () => {})
    assertLayout()
    assert.ok(f.page.rows[0].options.text.length < 40)
  }
})
