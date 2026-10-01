import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const shared = fs.readFileSync(new URL('../shared/agent-menu.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replace('export function createAgentMenuPage', 'function createAgentMenuPage')
const entries = {
  claude: fs.readFileSync(new URL('../page/claude.js', import.meta.url), 'utf8').replace(/^import .*$/gm, ''),
  codex: fs.readFileSync(new URL('../page/codex.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '')
}
const flush = () => new Promise(resolve => setImmediate(resolve))

function fixture({ kind = 'claude', request = async () => ({ ok: true }), storage = new Map() } = {}) {
  let page
  const replacements = []
  vm.runInNewContext(shared + '\n' + entries[kind], {
    Page(definition) { page = Object.assign(Object.create(definition), definition) },
    BasePage: value => value,
    getDeviceInfo: () => ({ width: 390, height: 450 }),
    replace: value => replacements.push(value),
    setWakeUpRelaunch() {},
    LocalStorage: class { getItem(key) { return storage.get(key) } setItem(key, value) { storage.set(key, value) } },
    createWidget(kind, options) {
      return { kind, options: { visible: true, ...options }, setProperty(property, value) {
        if (property === 'more') Object.assign(this.options, value); else this.options[property] = value
      } }
    },
    widget: { FILL_RECT: 1, TEXT: 2, BUTTON: 3 }, align: { CENTER_H: 1 }, text_style: { WRAP: 1 },
    prop: { TEXT: 'text', VISIBLE: 'visible', MORE: 'more' }, Date: class extends Date { static now() { return 1700000000000 } },
    console: { log() {} }
  })
  const calls = []
  page.request = (payload, options) => { calls.push({ payload, options }); return request(payload, options) }
  page.build()
  return { page, replacements, storage, calls }
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
  assert.equal(f.page.items[0].label, 'Проекты')
  f.page.items[0].action(); await flush()
  assert.equal(f.page.items[0].label, 'CRM')
  f.page.items[0].action()
  assert.equal(f.page.items[1].label, 'Режим: Авто')
  assert.deepEqual(JSON.parse(f.storage.get('claude-resume')), { screen: 'project', project })
  f.page.items[1].action(); await flush()
  f.page.items.find(item => item.label === 'План').action()
  assert.equal(f.page.items[1].label, 'Режим: План')
  f.page.items[0].action()
  assert.deepEqual(JSON.parse(f.storage.get('voice-destination')), { target: 'claude', project: '/work/crm', label: 'CRM', mode: 'plan', modeLabel: 'План' })
  assert.equal(f.replacements.at(-1).url, 'page/voice')
  f.page.project(project)
  f.page.items[2].action(); await flush()
  assert.equal(f.page.items[0].label, 'Починить оплату')
  f.page.items[0].action()
  assert.equal(JSON.parse(f.storage.get('voice-destination')).sessionId, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
  assert.equal(f.calls.some(c => c.payload.method === 'CLAUDE_SEND'), false)
})

test('sleep restores project, voice and history screens; last task reopens the voice page', () => {
  const storage = new Map([['claude-resume', JSON.stringify({ screen: 'project', project })]])
  const a = fixture({ storage })
  assert.equal(a.page.items[0].label, 'Задача / вопрос')
  const b = fixture({ storage: new Map([['claude-resume', JSON.stringify({ screen: 'history' })]]) })
  assert.equal(b.replacements.at(-1).url, 'page/history')
  const c = fixture({ storage: new Map([['claude-resume', JSON.stringify({ screen: 'voice' })]]) })
  assert.equal(c.page.items[0].label, 'Проекты')
  const d = fixture({ storage: new Map([['voice-destination', JSON.stringify({ target: 'claude', project: '/work/crm' })]]) })
  d.page.items[1].action()
  assert.equal(d.replacements.at(-1).url, 'page/voice')
  const e = fixture()
  e.page.items[2].action()
  assert.equal(e.replacements.at(-1).url, 'page/history')
  assert.deepEqual(JSON.parse(e.storage.get('claude-history-view')), { screen: 'home' })
})

test('codex menu uses CODEX methods, its own storage keys and mode labels', async () => {
  const codexReplies = {
    CODEX_PROJECTS: { ok: true, projects: [project], nextCursor: null },
    CODEX_MODES: { ok: true, modes: [{ id: 'auto', label: 'Авто' }, { id: 'read-only', label: 'Только чтение' }], nextCursor: null }
  }
  const f = fixture({ kind: 'codex', request: async ({ method }) => codexReplies[method] })
  assert.equal(f.page.heading.options.text, 'Codex')
  f.page.items[0].action(); await flush()
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
  f.page.items[0].action(); await flush(); await flush()
  assert.equal(f.page.note.options.text, 'Идёт сейчас · задач: 1')
  assert.equal(f.page.items[0].label, 'Остановить смену')
  f.page.items[0].action(); await flush(); await flush()
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
    { target: 'claude', project: '/work/crm', label: 'CRM', mode: 'auto', modeLabel: 'Авто · ночью', night: true })
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
    { target: 'claude', project: 'research', label: 'Исследование', mode: 'auto', modeLabel: 'Большое · Claude', kind: 'deep', both: false })
  f.page.research()
  f.page.items[1].action()
  assert.deepEqual(JSON.parse(f.storage.get('voice-destination')),
    { target: 'claude', project: 'research', label: 'Исследование', mode: 'auto', modeLabel: 'Claude + Codex', kind: 'research', both: true })
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
  assert.deepEqual(JSON.parse(f.storage.get('voice-destination')), { target: 'claude', project: 'watch', label: 'Дозор', mode: 'auto', modeLabel: 'Адрес сайта словами', kind: 'watch' })
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
  assert.equal(g.page.note.options.text, 'Claude в проектах на Mac')
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
  f.page.items[1].action(); await flush(); await flush()
  assert.deepEqual(sent, [{ id: 'job-1', approvalId: '0123456789abcdef', allow: true, answer: 'Синий' }])
  assert.deepEqual(JSON.parse(f.storage.get('claude-resume')), { screen: 'voice' })
  assert.equal(f.replacements.at(-1).url, 'page/voice')
})
