import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const shared = fs.readFileSync(new URL('../shared/history-page.js', import.meta.url), 'utf8')
  .replace(/import \{[\s\S]*?\} from '@zos\/interaction'\n/, '')
  .replace(/^import .*$/gm, '').replace('export function createHistoryPage', 'function createHistoryPage')
const textRowsSource = fs.readFileSync(new URL('../shared/text-rows.js', import.meta.url), 'utf8')
  .replace('export function textRows', 'function textRows')
const entries = {
  musafir: fs.readFileSync(new URL('../page/history.js', import.meta.url), 'utf8').replace(/^import .*$/gm, ''),
  orca: fs.readFileSync(new URL('../apps/orca/page/history.js', import.meta.url), 'utf8').replace(/^import .*$/gm, ''),
  claude: fs.readFileSync(new URL('../apps/claude/page/history.js', import.meta.url), 'utf8').replace(/^import .*$/gm, ''),
  codex: fs.readFileSync(new URL('../apps/codex/page/history.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '')
}
const flush = () => new Promise(resolve => setImmediate(resolve))
const id = '1700000000000-1'
const item = { id, text: 'Мой вопрос', created: 1700000000, state: 'completed', deleted: false }
const detail = (params, extra = {}) => ({ ok: true, ...item, field: params.field,
  content: 'Сохранённый ответ', total: 17, offset: 0, complete: true, ...extra })

export function fixture({ kind = 'musafir', width = 390, height = 450, storage = new Map(), request = async () => ({ ok: true }), layout,
  storageError = false } = {}) {
  let page
  const widgets = [], replacements = [], calls = [], statusBars = [], interaction = {}
  vm.runInNewContext(textRowsSource + '\n' + shared + '\n' + entries[kind], {
    Page(definition) { page = definition }, BasePage: x => x,
    getDeviceInfo: () => ({ width, height }), setWakeUpRelaunch() {}, setStatusBarVisible: value => statusBars.push(value),
    replace: value => replacements.push(value),
    LocalStorage: class {
      constructor() { if (storageError) throw Error('storage') }
      getItem(k) { if (storageError) throw Error('storage'); return storage.get(k) }
      setItem(k, v) { if (storageError) throw Error('storage'); storage.set(k, v) }
    },
    getTextLayout: layout || (text => ({ result: 0, width: Array.from(text).length * 12,
      height: text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(Array.from(l).length / 24)), 0) * 25 })),
    createWidget(kind, options) {
      const w = { kind, options: { visible: true, ...options }, sets: [], setProperty(k, v) {
        this.sets.push([k, v])
        if (k === 'more' || k === 'update') Object.assign(this.options, v); else this.options[k] = v
      } }
      widgets.push(w); return w
    },
    widget: { FILL_RECT: 1, TEXT: 2, BUTTON: 3, SCROLL_LIST: 4 }, align: { CENTER_H: 1, CENTER_V: 2 },
    text_style: { WRAP: 1 }, prop: { TEXT: 'text', VISIBLE: 'visible', MORE: 'more', UPDATE_DATA: 'update' },
    setTimeout, clearTimeout,
    onGesture({ callback }) { interaction.gesture = callback }, offGesture() { interaction.gesture = null }, GESTURE_RIGHT: 10,
    onKey({ callback }) { interaction.key = callback }, offKey() { interaction.key = null }, KEY_BACK: 20, KEY_EVENT_CLICK: 21,
    console
  })
  page.request = payload => { calls.push(payload); return Promise.resolve().then(() => request(payload)) }
  page.build()
  return { page, widgets, storage, calls, replacements, statusBars, interaction }
}

test('browse question and answer then trash and restore without sending a command', async () => {
  let deleted = false
  const f = fixture({ request: ({ method, params }) => {
    if (method === 'HISTORY_LIST') return { ok: true, items: params.trash === deleted ? [{ ...item, deleted }] : [], hasMore: false }
    if (method === 'HISTORY_DETAIL') {
      const content = params.field === 'text' ? 'Мой вопрос' : 'Ответ Мусафира'
      return detail(params, { content, total: Array.from(content).length, deleted })
    }
    if (method === 'HISTORY_SET_DELETED') { deleted = params.deleted; return { ok: true, id, deleted } }
    throw Error(method)
  } })
  f.page.items[0].action(); await flush()
  assert.match(f.page.items[0].label, /Мой вопрос/)
  f.page.items[0].action(); await flush()
  f.page.items[0].action(); await flush()
  assert.equal(f.page.reader.content, 'Мой вопрос')
  f.page.actions[0].action(); await flush()
  f.page.items[1].action(); await flush()
  assert.equal(f.page.reader.content, 'Ответ Мусафира')
  f.page.actions[0].action(); await flush()
  f.page.items[2].action()
  assert.equal(f.calls.filter(x => x.method === 'HISTORY_SET_DELETED').length, 0)
  f.page.actions[2].action(); await flush(); await flush()
  assert.equal(deleted, true)
  assert.equal(f.page.items.length, 0)
  f.page.home(); f.page.items[2].action(); await flush()
  f.page.items[0].action(); await flush()
  assert.equal(f.page.items[2].label, 'Восстановить')
  f.page.items[2].action(); f.page.actions[2].action(); await flush(); await flush()
  assert.equal(deleted, false)
  assert.ok(f.calls.every(x => x.method.startsWith('HISTORY_')))
})

test('long Unicode answer is loaded automatically into one native scroll list', async () => {
  const content = ('Салам 👋\nКаждый символ сохранён. ').repeat(90)
  const chars = Array.from(content)
  const f = fixture({ request: ({ params }) => detail(params, { content: chars.slice(params.offset, params.offset + 600).join(''),
    total: chars.length, offset: params.offset, complete: params.offset + 600 >= chars.length }) })
  f.page.detail(id, 'result'); await flush()
  for (let i = 0; i < 100 && f.page.reader.content !== content; i++) await flush()
  assert.equal(f.page.reader.content, content)
  assert.ok(f.calls.length > 1)
  assert.ok(f.calls.every(x => x.params.limit === 600))
  assert.equal(f.page.actions.length, 1)
  assert.equal(f.page.scroll.options.visible, true)
})

test('recent detail restarts at zero after sleep and reads bounded chunks from cache offline', async () => {
  const storage = new Map()
  const content = 'Длинный ответ на вопрос. '.repeat(20)
  const f = fixture({ storage, request: ({ params }) => detail(params, { content, total: content.length }) })
  f.page.detail(id, 'result'); await flush()
  const shown = f.page.reader.content
  f.page.onDestroy()
  const g = fixture({ storage, request: async () => ({ ok: false, offline: true, error: 'Нет связи с Mac' }) })
  await flush()
  assert.equal(g.page.reader.content, shown)
  assert.match(g.page.note.options.text, /Сохранённое/)
  for (let i = 0; i < 20; i++) {
    g.page.request = async () => ({ ok: true, items: [], hasMore: false })
    g.page.list(false, i * 3); await flush()
  }
  assert.equal(JSON.parse(storage.get('musafir-history-cache')).length, 16)
})

test('server rejection never resurrects a cached page, and mutation lost receipt invalidates cache', async () => {
  const f = fixture({ request: ({ params }) => detail(params, { total: 17 }) })
  f.page.detail(id, 'result'); await flush()
  assert.equal(f.page.cache.length, 1)
  f.page.request = async () => ({ ok: false, error: 'Запрос не найден' })
  f.page.detail(id, 'result'); await flush()
  assert.match(f.page.note.options.text, /Запрос не найден/)
  assert.equal(f.page.reader.content, '')
  f.page.request = async () => { throw Error('Телефон не ответил') }
  f.page.setDeleted(id, true); await flush()
  assert.deepEqual(JSON.parse(f.storage.get('musafir-history-cache')), [])
  assert.equal(f.page.heading.options.text, 'Нет данных')
})

test('late reply after leaving page cannot navigate back or alter cache', async () => {
  let finish
  const f = fixture({ request: () => new Promise(resolve => { finish = resolve }) })
  f.page.list(); await flush(); f.page.home()
  finish({ ok: true, items: [item], hasMore: false }); await flush()
  assert.equal(f.page.heading.options.text, 'История')
  assert.equal(f.page.items[0].label, 'Вопросы и ответы')
  assert.equal(f.page.cache.length, 0)
  f.page.list(); await flush(); f.page.onDestroy()
  finish({ ok: true, items: [item], hasMore: false }); await flush()
  assert.equal(f.page.cache.length, 0)
})

test('active tasks expose Open and never delete or resubmit; return routes to existing voice page', async () => {
  const f = fixture({ request: ({ method, params }) => method === 'HISTORY_CURRENT'
    ? { ok: true, job: { ...item, state: 'approval' } } : detail(params, { total: 17, state: 'running' }) })
  f.page.entry(id); await flush()
  assert.equal(f.page.items.length, 2)
  assert.equal(f.page.items[1].label, 'Открыть задачу')
  f.page.current(); await flush()
  assert.equal(f.page.note.options.text, 'Нужно решение')
  f.page.items[0].action()
  assert.equal(f.storage.get('musafir-resume'), 'voice')
  assert.equal(f.replacements.at(-1).url, 'page/index')
  assert.ok(f.calls.every(x => !['SEND_TEXT', 'JOB_APPROVE'].includes(x.method)))
})

test('all four profiles fit native and smaller windows with separated controls', async () => {
  for (const kind of ['musafir', 'orca', 'claude', 'codex']) for (const [width, height] of [[390, 450], [432, 514], [390, 400]]) {
    const prefix = kind === 'musafir' ? '' : kind.toUpperCase() + '_'
    const storage = kind === 'orca' ? orcaStorage() : new Map()
    const f = fixture({ kind, width, height, storage, request: ({ method, params }) => method === prefix + 'HISTORY_LIST'
      ? { ok: true, items: [item, { ...item, id: '1700000000001-1' }, { ...item, id: '1700000000002-1' }], hasMore: true }
      : detail(params, { total: 17 }) })
    const check = () => {
      const visible = f.widgets.filter(x => x.kind !== 1 && x.options.visible).map(x => x.options)
      for (let i = 0; i < visible.length; i++) {
        const a = visible[i]
        assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.w <= width && a.y + a.h <= height)
        for (const b of visible.slice(i + 1)) assert.equal(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h, false, `${a.text} / ${b.text}`)
      }
    }
    check(); f.page.list(); await flush(); check()
    f.page.entry(id); await flush(); check()
    f.page.detail(id, 'result'); await flush(); check()
    f.page.confirm(id, true); check()
  }
})

test('malformed online success cannot masquerade as an offline cached response', async () => {
  const f = fixture({ request: ({ params }) => detail(params) })
  f.page.detail(id, 'result'); await flush()
  assert.equal(f.page.cache.length, 1)
  f.page.request = async () => ({ ok: true, id, field: 'result', content: 'wrong' })
  f.page.detail(id, 'result'); await flush()
  assert.match(f.page.note.options.text, /Некорректный/)
  assert.equal(f.page.reader.content, '')
})

const PAIR = { id: 'pair-1', projectLabel: 'CRM', workerAgent: 'codex', reviewerAgent: 'codex' }
const orcaStorage = () => new Map([['orca-history-pair', JSON.stringify(PAIR)]])

test('orca history needs a stored pair and otherwise returns to the menu', () => {
  const f = fixture({ kind: 'orca' })
  assert.equal(f.replacements.at(-1).url, 'page/index')
  assert.equal(f.widgets.length, 0)
  assert.equal(f.calls.length, 0)
})

test('orca history browses, trashes and restores tasks of the chosen pair only', async () => {
  let deleted = false
  const f = fixture({ kind: 'orca', storage: orcaStorage(), request: ({ method, params }) => {
    if (method === 'ORCA_HISTORY_LIST') {
      assert.equal(params.pairId, 'pair-1')
      return { ok: true, items: params.trash === deleted ? [{ ...item, deleted }] : [], hasMore: false }
    }
    if (method === 'ORCA_HISTORY_DETAIL') {
      const content = params.field === 'text' ? 'Моя задача' : 'Отчёт Orca'
      return detail(params, { content, total: Array.from(content).length, deleted })
    }
    if (method === 'ORCA_HISTORY_SET_DELETED') { deleted = params.deleted; return { ok: true, id, deleted } }
    throw Error(method)
  } })
  assert.equal(JSON.parse(f.storage.get('orca-resume')).screen, 'history')
  assert.equal(f.page.note.options.text, 'CRM')
  f.page.items[0].action(); await flush()
  assert.match(f.page.items[0].label, /Мой вопрос/)
  f.page.items[0].action(); await flush()
  assert.equal(f.page.items[1].label, 'Отчёт Orca')
  f.page.items[1].action(); await flush()
  assert.equal(f.page.reader.content, 'Отчёт Orca')
  f.page.actions[0].action(); await flush()
  f.page.items[2].action()
  assert.equal(f.calls.filter(x => x.method === 'ORCA_HISTORY_SET_DELETED').length, 0)
  f.page.actions[2].action(); await flush(); await flush()
  assert.equal(deleted, true)
  assert.equal(f.page.items.length, 0)
  // Stale pages were dropped before the mutation; only the fresh list is cached now.
  const cache = JSON.parse(f.storage.get('orca-history-cache'))
  assert.equal(cache.length, 1)
  assert.match(cache[0].key, /^ORCA_HISTORY_LIST:/)
  f.page.actions[0].action(); await flush()
  f.page.items[2].action(); await flush()
  f.page.items[0].action(); await flush()
  assert.equal(f.page.heading.options.text, 'В корзине')
  assert.equal(f.page.items[2].label, 'Восстановить')
  f.page.items[2].action(); f.page.actions[2].action(); await flush(); await flush()
  assert.equal(deleted, false)
  assert.equal(f.calls.filter(x => !x.method.startsWith('ORCA_HISTORY_')).length, 0)
})

test('orca history footer returns to the pair menu and current task needs an exact saved context', () => {
  const f = fixture({ kind: 'orca', storage: orcaStorage() })
  f.page.actions[0].action()
  assert.equal(f.replacements.at(-1).url, 'page/index')
  assert.deepEqual(JSON.parse(f.storage.get('orca-resume')), { screen: 'pair', pair: PAIR })
  const current = { target: 'orca', pairId: 'pair-1', label: 'CRM', jobId: id, resumeJob: true, autoRecord: false }
  const saved = orcaStorage(); saved.set('voice-destination', JSON.stringify(current))
  const g = fixture({ kind: 'orca', storage: saved })
  g.page.items[1].action()
  assert.equal(g.replacements.at(-1).url, 'page/voice')
  assert.deepEqual(JSON.parse(g.storage.get('voice-destination')), current)
  assert.equal(JSON.parse(g.storage.get('orca-resume')).screen, 'voice')
  assert.equal(g.calls.length, 0)
})

test('trash can be emptied permanently only from the first page with items and after confirmation', async () => {
  for (const kind of ['musafir', 'orca']) {
    let trashed = [{ ...item, deleted: true }, { ...item, id: '1700000000000-2', deleted: true }]
    const method = kind === 'orca' ? 'ORCA_HISTORY_EMPTY_TRASH' : 'HISTORY_EMPTY_TRASH'
    const listMethod = kind === 'orca' ? 'ORCA_HISTORY_LIST' : 'HISTORY_LIST'
    const f = fixture({ kind, storage: kind === 'orca' ? orcaStorage() : new Map(), request: ({ method: m, params }) => {
      if (m === listMethod) return { ok: true, items: params.trash ? trashed.slice(params.offset, params.offset + 3) : [], hasMore: params.trash && trashed.length > params.offset + 3 }
      if (m === method) {
        // params come from the vm realm: compare keys, not prototypes
        assert.deepEqual(Object.keys(params), kind === 'orca' ? ['pairId'] : [])
        if (kind === 'orca') assert.equal(params.pairId, 'pair-1')
        const removed = trashed.length; trashed = []; return { ok: true, removed }
      }
      throw Error(m)
    } })
    f.page.items[0].action(); await flush()                       // normal list: no purge button
    assert.equal(f.page.actions[1], null)
    f.page.actions[0].action(); f.page.items[2].action(); await flush()   // trash
    assert.equal(f.page.actions[1].label, 'Очистить')
    f.page.actions[1].action()
    assert.equal(f.page.heading.options.text, 'Очистить корзину?')
    assert.equal(f.calls.filter(x => x.method === method).length, 0)
    f.page.actions[0].action(); await flush()                     // cancel returns to trash
    assert.equal(f.page.actions[1].label, 'Очистить')
    f.page.actions[1].action(); f.page.actions[2].action(); await flush(); await flush()
    assert.equal(f.calls.filter(x => x.method === method).length, 1)
    assert.equal(trashed.length, 0)
    assert.equal(f.page.items.length, 0)
    assert.equal(f.page.actions[1], null)
    f.page.onDestroy()
  }
})

test('claude history is one global list, leaves to the menu and reopens the last task', async () => {
  const f = fixture({ kind: 'claude', request: ({ method, params }) => {
    if (method === 'CLAUDE_HISTORY_LIST') { assert.deepEqual(Object.keys(params).sort(), ['limit', 'offset', 'trash']); return { ok: true, items: [{ ...item, text: 'Почини оплату' }], hasMore: false } }
    if (method === 'CLAUDE_HISTORY_DETAIL') { const content = params.field === 'text' ? 'Почини оплату' : 'Готово'; return detail(params, { content, total: Array.from(content).length }) }
    throw Error(method)
  } })
  assert.equal(JSON.parse(f.storage.get('claude-resume')).screen, 'history')
  assert.equal(f.page.note.options.text, 'Claude · твой Mac')
  assert.equal(f.page.items[0].label, 'Запросы')
  f.page.items[0].action(); await flush()
  f.page.items[0].action(); await flush()
  assert.equal(f.page.items[1].label, 'Ответ Claude')
  f.page.items[1].action(); await flush()
  assert.equal(f.page.reader.content, 'Готово')
  f.page.actions[0].action(); await flush(); f.page.actions[0].action(); await flush()
  f.page.actions[0].action()                                   // Меню → home
  assert.equal(f.page.actions[0].label, 'Claude')
  f.page.actions[0].action()                                   // leave to the project menu
  assert.equal(f.replacements.at(-1).url, 'page/index')
  assert.deepEqual(JSON.parse(f.storage.get('claude-resume')), { screen: 'home' })
  const current = { target: 'claude', project: '/work/crm', label: 'CRM', jobId: id,
    openJob: true, resumeJob: true, autoRecord: false, mode: 'auto' }
  const g = fixture({ kind: 'claude', storage: new Map([['voice-destination', JSON.stringify(current)]]) })
  g.page.items[1].action()
  assert.equal(g.replacements.at(-1).url, 'page/voice')
  assert.deepEqual(JSON.parse(g.storage.get('claude-resume')), { screen: 'voice' })
  assert.equal(g.calls.length, 0)
})

test('codex history uses CODEX methods and its own resume key', async () => {
  const f = fixture({ kind: 'codex', request: ({ method }) => {
    if (method === 'CODEX_HISTORY_LIST') return { ok: true, items: [], hasMore: false }
    throw Error(method)
  } })
  assert.equal(JSON.parse(f.storage.get('codex-resume')).screen, 'history')
  assert.equal(f.page.note.options.text, 'Codex · твой Mac')
  f.page.items[0].action(); await flush()
  assert.equal(f.calls[0].method, 'CODEX_HISTORY_LIST')
  f.page.actions[0].action(); f.page.actions[0].action()
  assert.deepEqual(JSON.parse(f.storage.get('codex-resume')), { screen: 'home' })
})

test('chunk failure keeps loaded text and retry continues from the exact Unicode offset', async () => {
  const content = '🙂'.repeat(700)
  const chars = Array.from(content)
  const offsets = []
  let failed = false
  const f = fixture({ request: ({ params }) => {
    offsets.push(params.offset)
    if (params.offset === 600 && !failed) { failed = true; throw Error('link down') }
    const chunk = chars.slice(params.offset, params.offset + params.limit).join('')
    return detail(params, { content: chunk, total: chars.length, offset: params.offset,
      complete: params.offset + Array.from(chunk).length === chars.length })
  } })
  f.page.detail(id, 'result')
  for (let i = 0; i < 100 && !f.page.actions[2]; i++) await flush()
  assert.equal(Array.from(f.page.reader.content).length, 600)
  assert.equal(f.page.actions[2].label, 'Повторить')
  f.page.actions[2].action()
  for (let i = 0; i < 20 && f.page.reader.content !== content; i++) await flush()
  assert.equal(f.page.reader.content, content)
  assert.deepEqual(offsets, [0, 600, 600])
})

test('leaving during a detail read fences late callbacks and restores native chrome', async () => {
  let finish
  const f = fixture({ request: () => new Promise(resolve => { finish = resolve }) })
  f.page.detail(id, 'result'); await flush()
  f.page.onDestroy()
  finish(detail({ field: 'result' }, { content: 'late', total: 4 }))
  await flush(); await flush()
  assert.equal(f.page.reader.content, '')
  assert.equal(f.page.cache.length, 0)
  assert.deepEqual(f.statusBars, [false, true])
  assert.equal(f.interaction.gesture, null)
  assert.equal(f.interaction.key, null)
})

test('history entry routes only its validated backend context and rejects collisions', async () => {
  for (const kind of ['claude', 'codex']) {
    const stale = { target: kind === 'claude' ? 'codex' : 'claude', project: '/wrong', label: 'Wrong', jobId: id,
      openJob: true, resumeJob: true, autoRecord: false }
    const storage = new Map([['voice-destination', JSON.stringify(stale)]])
    const exact = { target: kind, project: '/work/right', jobId: id, openJob: true, resumeJob: true,
      autoRecord: false, mode: kind === 'codex' ? 'read-only' : 'plan' }
    const f = fixture({ kind, storage, request: ({ params }) => detail(params, { state: 'running', context: exact }) })
    f.page.entry(id); await flush()
    f.page.items[1].action()
    assert.equal(f.replacements.at(-1).url, 'page/voice')
    assert.deepEqual(JSON.parse(storage.get('voice-destination')), exact)
  }

  const storage = orcaStorage()
  storage.set('voice-destination', JSON.stringify({ target: 'orca', pairId: 'pair-old', label: 'Old', jobId: id,
    resumeJob: true, autoRecord: false }))
  const wrong = { target: 'orca', pairId: 'pair-old', label: 'Old', jobId: id, resumeJob: true, autoRecord: false }
  const f = fixture({ kind: 'orca', storage, request: ({ params }) => detail(params, { state: 'running', context: wrong }) })
  f.page.entry(id); await flush(); f.page.items[1].action()
  assert.equal(f.page.heading.options.text, 'Не удалось открыть')
  assert.equal(f.replacements.length, 0)
  assert.equal(JSON.parse(storage.get('voice-destination')).pairId, 'pair-old')
})

test('saved current context requires an explicit label and storage failure never navigates', () => {
  const missingLabel = { target: 'claude', project: '/work/right', jobId: id,
    openJob: true, resumeJob: true, autoRecord: false }
  const storage = new Map([['voice-destination', JSON.stringify(missingLabel)]])
  const f = fixture({ kind: 'claude', storage })
  f.page.items[1].action()
  assert.equal(f.replacements.at(-1).url, 'page/index')

  const g = fixture({ kind: 'claude', storageError: true })
  g.page.openContext({ ...missingLabel, label: 'Right' })
  assert.equal(g.replacements.length, 0)
  assert.equal(g.page.heading.options.text, 'Не удалось открыть')
})

test('dynamic button text uses complete MORE properties', async () => {
  const f = fixture({ request: ({ params }) => detail(params) })
  f.page.entry(id); await flush()
  for (const control of [...f.page.rows.filter(row => row.options.visible), ...f.page.footer.filter(row => row.options.visible)]) {
    const update = control.sets.find(([key]) => key === 'more')?.[1]
    assert.equal(typeof update.text, 'string')
    for (const key of ['x', 'y', 'w', 'h', 'radius', 'normal_color', 'press_color', 'color', 'text_size', 'click_func']) {
      assert.notEqual(update[key], undefined, key)
    }
  }
})

test('backend content beyond 200000 is capped with an explicit notice', async () => {
  const f = fixture({ request: ({ params }) => {
    const length = Math.min(params.limit, 200001 - params.offset)
    return detail(params, { content: 'x'.repeat(length), total: 200001, offset: params.offset,
      complete: params.offset + length === 200001 })
  } })
  f.page.detail(id, 'result')
  await flush(); await flush()
  f.page.stopReading()
  f.page.reader.content = 'x'.repeat(199800)
  f.page.reader.offset = 199800
  f.page.reader.total = 200001
  f.page.reader.deadline = Date.now() + 45000
  await f.page.readChunk(f.page.generation)
  assert.equal(f.page.reader.offset, 200000)
  assert.equal(Array.from(f.page.reader.content).length, 200000)
  assert.match(f.page.note.options.text, /Предел 200 000/)
  assert.ok(f.calls.every(call => call.params.offset < 200000))
  assert.ok(JSON.stringify(f.page.cache).length < 50000)
})
