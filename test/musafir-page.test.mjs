import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { MUSAFIR_HEROES, heroById } from '../shared/musafir-chat.js'

const stripImports = value => value.replace(/^import[\s\S]*?from ['"][^'"]+['"]\n/gm, '')
const shared = stripImports(fs.readFileSync(new URL('../shared/musafir-page.js', import.meta.url), 'utf8'))
  .replace('export function createMusafirPage', 'function createMusafirPage')
const entry = stripImports(fs.readFileSync(new URL('../page/index.js', import.meta.url), 'utf8'))
const source = shared + '\n' + entry
const flush = () => new Promise(resolve => setImmediate(resolve))
const CHAT_ID = '1700000000000-7'
const OTHER_CHAT_ID = '1700000000000-8'
const JOB_ID = '1700000000001-7'
const OTHER_JOB_ID = '1700000000001-8'

const CHAT = {
  id: CHAT_ID,
  title: 'Авто в Каире',
  updated: 1700000000,
  archived: false,
  latestJob: { id: JOB_ID, state: 'completed', summary: 'Подборка готова', mode: 'task' }
}
const JOB = {
  ok: true,
  id: JOB_ID,
  chatId: CHAT_ID,
  state: 'completed',
  text: 'Найди авто',
  summary: 'Подборка готова',
  result: 'Ответ',
  mode: 'task',
  reportLength: 0
}

function fixture({ width = 432, height = 514, storage = new Map(), request } = {}) {
  let page
  const widgets = [], replacements = [], calls = [], statusBars = []
  const timers = new Map(), interaction = { gesture: null, key: null, offGesture: 0, offKey: 0 }
  let nextTimer = 0
  vm.runInNewContext(source, {
    Page(definition) { page = Object.assign(Object.create(definition), definition) },
    BasePage: value => value,
    MUSAFIR_HEROES,
    heroById,
    getDeviceInfo: () => ({ width, height }),
    setStatusBarVisible: value => statusBars.push(value),
    replace: value => replacements.push(value),
    LocalStorage: class {
      getItem(key) { return storage.get(key) }
      setItem(key, value) { storage.set(key, value) }
    },
    createWidget(kind, options) {
      const item = {
        kind,
        events: {},
        options: { ...options, visible: true },
        addEventListener(type, callback) { this.events[type] = callback },
        setProperty(property, value) {
          if (kind === 3 && property === 'text') throw new Error('BUTTON prop.TEXT is forbidden')
          if (kind === 3 && property === 'more') {
            for (const key of ['x', 'y', 'w', 'h']) assert.equal(Number.isFinite(value[key]), true, `BUTTON MORE ${key}`)
          }
          if (property === 'more') Object.assign(this.options, value)
          else if (property === 'update_data') Object.assign(this.options, value)
          else this.options[property] = value
        }
      }
      widgets.push(item)
      return item
    },
    widget: { FILL_RECT: 1, TEXT: 2, BUTTON: 3, IMG: 4, SCROLL_LIST: 5 },
    event: { CLICK_UP: 'click_up' },
    align: { CENTER_H: 1, CENTER_V: 2, LEFT: 3 },
    text_style: { WRAP: 1 },
    prop: { TEXT: 'text', VISIBLE: 'visible', MORE: 'more', UPDATE_DATA: 'update_data' },
    onGesture(option) { interaction.gesture = option.callback },
    offGesture() { interaction.offGesture += 1 },
    GESTURE_RIGHT: 10,
    onKey(option) { interaction.key = option.callback },
    offKey() { interaction.offKey += 1 },
    KEY_BACK: 20,
    KEY_EVENT_CLICK: 21,
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    console: { log() {} }
  })
  page.request = (payload, options) => {
    calls.push({ payload, options })
    return Promise.resolve(request ? request(payload, options) : {
      ok: true, chats: [], nextOffset: null, activeJob: null
    })
  }
  page.build()
  return {
    page, widgets, replacements, calls, storage, timers, statusBars, interaction,
    tick(delay) {
      const match = [...timers].find(([, timer]) => timer.delay === delay)
      assert.ok(match, `Expected a ${delay}ms timer`)
      timers.delete(match[0])
      match[1].callback()
    }
  }
}

const click = widget => widget.options.click_func()
const listReply = (chats = [], extra = {}) => ({ ok: true, chats, nextOffset: null, activeJob: null, ...extra })
const detailReply = (chat = CHAT, jobs = [], nextOffset = null) => ({
  ok: true,
  chat: { id: chat.id, title: chat.title, archived: chat.archived },
  jobs,
  nextOffset
})

function assertVisibleButtonGeometry(f, width, height) {
  const buttons = f.widgets.filter(item => item.kind === 3 && item.options.visible)
  for (const button of buttons) {
    const { x, y, w, h } = button.options
    assert.equal([x, y, w, h].every(Number.isFinite), true)
    assert.equal(x >= 0 && y >= 0 && x + w <= width && y + h <= height, true)
    assert.equal(h >= 44, true)
    assert.equal(y + h <= height - 8, true)
  }
  for (let i = 0; i < buttons.length; i += 1) {
    for (let j = i + 1; j < buttons.length; j += 1) {
      const a = buttons[i].options, b = buttons[j].options
      const overlap = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
      assert.equal(overlap, false, `button overlap ${a.text}/${b.text}`)
    }
  }
}

test('legacy draft migrates without changing text', async () => {
  const audio = { id: JOB_ID, fileName: 'saved.opus', totalBytes: 1024, accepted: true, destinationKey: 'voice-draft' }
  const draft = JSON.stringify({ id: JOB_ID, text: 'Точный старый текст' })
  const storage = new Map([['pending-audio', JSON.stringify(audio)], ['voice-draft', draft]])
  const f = fixture({ storage })
  await flush()
  assert.equal(storage.get('voice-draft:musafir:legacy'), draft)
  assert.equal(JSON.parse(storage.get('pending-audio')).destinationKey, 'voice-draft:musafir:legacy')
  assert.equal(JSON.parse(storage.get('musafir-pending-context')).chatId, 'legacy')
  f.page.onDestroy()
})

test('home never opens an old result and every compose entry keeps the microphone idle', async () => {
  const f = fixture({ request: () => listReply([CHAT]) })
  assert.equal(f.page.primary.options.visible, true)
  assert.equal(f.page.primary.options.text, 'Новая задача')
  await flush()
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])), {
    payload: { method: 'CHAT_LIST', params: { offset: 0, limit: 10, archived: false } },
    options: { timeout: 15000 }
  })
  assert.equal(f.calls.some(call => ['LATEST_JOB', 'JOB_STATUS'].includes(call.payload.method)), false)
  click(f.page.primary)
  assert.deepEqual(JSON.parse(f.storage.get('musafir-context')), {
    target: 'musafir', chatId: null, mode: 'task', jobId: null, openJob: false, autoRecord: false
  })
  assert.deepEqual(JSON.parse(f.storage.get('musafir-return-view')), { kind: 'home' })
  assert.equal(f.replacements.at(-1).url, 'page/voice')
})

test('chat detail opens exact jobs and stores a one-shot exact return view', async () => {
  const chats = [CHAT, { ...CHAT, id: OTHER_CHAT_ID, title: 'Второй' }]
  const f = fixture({ request: ({ method, params }) => {
    if (method === 'CHAT_LIST') return listReply(chats, { nextOffset: params.offset === 0 ? 3 : null })
    return detailReply(CHAT, [JOB])
  } })
  await flush()
  f.page.chats(false, 3)
  await flush()
  click(f.page.rows[0])
  await flush()
  click(f.page.rows[0])
  assert.deepEqual(JSON.parse(f.storage.get('musafir-context')), {
    target: 'musafir', chatId: CHAT_ID, mode: 'task', jobId: JOB_ID, openJob: true, autoRecord: false
  })
  assert.deepEqual(JSON.parse(f.storage.get('musafir-return-view')), {
    kind: 'detail',
    chat: { id: CHAT_ID, title: CHAT.title, archived: false, mode: 'task' },
    offset: 0,
    origin: { kind: 'list', archived: false, offset: 3 }
  })

  const restored = fixture({ storage: f.storage, request: ({ method, params }) => {
    assert.equal(method, 'CHAT_DETAIL')
    assert.equal(params.offset, 0)
    return detailReply(CHAT, [JOB])
  } })
  assert.equal(restored.storage.get('musafir-return-view'), '')
  await flush()
  assert.equal(restored.page.heading.options.text, CHAT.title)
  click(restored.page.topBack)
  await flush()
  assert.deepEqual(JSON.parse(JSON.stringify(restored.calls.at(-1).payload)), {
    method: 'CHAT_LIST', params: { offset: 3, limit: 3, archived: false }
  })
  restored.page.onDestroy()

  const fresh = fixture({ storage: restored.storage, request: ({ method }) => {
    assert.equal(method, 'CHAT_LIST')
    return listReply([])
  } })
  await flush()
  assert.equal(fresh.page.heading.options.text, 'Последние чаты')
  fresh.page.onDestroy()
})

test('list paging is separate from fixed Back and right swipe/KEY_BACK use the same action', async () => {
  const f = fixture({ request: ({ method, params }) => method === 'CHAT_LIST'
    ? listReply([CHAT], { nextOffset: params.offset === 0 ? 3 : null })
    : detailReply(CHAT) })
  await flush()
  f.page.chats(true, 3)
  assert.equal(f.page.topBack.options.visible, true)
  await flush()
  assert.deepEqual(JSON.parse(JSON.stringify(f.page.footerItems.map(item => item.label))), ['Активные', 'Раньше'])
  assert.equal(f.interaction.gesture(10), true)
  await flush()
  assert.equal(f.page.topBack.options.visible, false)
  f.page.chats(false, 0)
  assert.equal(f.interaction.key(20, 21), true)
  await flush()
  assert.equal(f.page.heading.options.text, 'Последние чаты')
  assert.equal(f.interaction.key(20, 21), false)
})

test('detail paging preserves its source list and Continue opens compose without auto-record', async () => {
  const jobs = [0, 1, 2, 3].map(index => ({ ...JOB, id: `1700000000002-${index + 1}`, summary: `Ответ ${index + 1}` }))
  const f = fixture({ request: ({ method, params }) => {
    if (method === 'CHAT_LIST') return listReply([CHAT])
    return detailReply(CHAT, jobs.slice(params.offset, params.offset + 2), params.offset === 0 ? 2 : null)
  } })
  await flush()
  f.page.chatDetail(CHAT, 0, { kind: 'list', archived: false, offset: 6 })
  await flush()
  click(f.page.rows[2])
  await flush()
  assert.equal(f.page.note.options.text, 'Ответы 3–4')
  assert.equal(f.page.footerItems.some(item => item.label === 'Новее'), true)
  click(f.page.primary)
  assert.deepEqual(JSON.parse(f.storage.get('musafir-context')), {
    target: 'musafir', chatId: CHAT_ID, mode: 'task', jobId: null, openJob: false, autoRecord: false
  })
  assert.equal(JSON.parse(f.storage.get('musafir-return-view')).offset, 2)
})

test('draft guard is independent of autoRecord and pendingSend offers status only', async () => {
  const pending = { target: 'musafir', chatId: null, mode: 'task', jobId: null,
    openJob: false, autoRecord: false }
  const draft = JSON.stringify({ text: 'Не потеряй этот текст' })
  const audio = JSON.stringify({ id: JOB_ID, totalBytes: 1024, destinationKey: 'voice-draft:musafir:new' })
  const storage = new Map([
    ['musafir-pending-context', JSON.stringify(pending)],
    ['voice-draft:musafir:new', draft],
    ['pending-audio', audio]
  ])
  const f = fixture({ storage })
  await flush()
  click(f.page.primary)
  assert.equal(f.page.heading.options.text, 'Есть черновик')
  assert.deepEqual(JSON.parse(JSON.stringify(f.page.items.map(item => item.label))), ['Продолжить черновик', 'Начать заново'])
  assert.equal(f.replacements.length, 0)
  click(f.page.rows[1])
  assert.equal(storage.get('voice-draft:musafir:new'), '')
  assert.equal(storage.get('pending-audio'), '')
  assert.equal(JSON.parse(storage.get('musafir-context')).autoRecord, false)

  const uncertain = { ...pending, chatId: CHAT_ID, jobId: JOB_ID, openJob: true, pendingSend: true }
  const f2 = fixture({ storage: new Map([['musafir-pending-context', JSON.stringify(uncertain)]]) })
  await flush()
  click(f2.page.primary)
  assert.deepEqual(JSON.parse(JSON.stringify(f2.page.items.map(item => item.label))), ['Открыть задание'])
})

test('archive confirmation and every non-home loading/error screen keep a fixed Back', async () => {
  let archived = false
  const f = fixture({ request: ({ method }) => {
    if (method === 'CHAT_LIST') return listReply([CHAT])
    if (method === 'CHAT_DETAIL') return detailReply({ ...CHAT, archived })
    if (method === 'CHAT_ARCHIVE') { archived = true; return { ok: true, chatId: CHAT_ID, archived } }
  } })
  await flush()
  click(f.page.rows[0])
  assert.equal(f.page.topBack.options.visible, true)
  await flush()
  click(f.page.footer[0])
  assert.equal(f.page.heading.options.text, CHAT.title)
  assert.equal(f.page.note.options.text, 'Чат можно будет восстановить из архива')
  assert.equal(f.page.topBack.options.visible, true)
  click(f.page.topBack)
  await flush()
  assert.equal(f.page.primary.options.text, 'Продолжить')

  const error = fixture({ request: async () => ({ ok: false, error: 'Нет связи с Mac. Повторите позже.' }) })
  error.page.chats(false, 0)
  assert.equal(error.page.topBack.options.visible, true)
  await flush()
  assert.equal(error.page.heading.options.text, 'Не удалось')
  assert.equal(error.page.topBack.options.visible, true)
  assert.equal(error.page.primary.options.text, 'Новая задача')
})

test('hero picker is one native scroll list with five cosmetic choices', async () => {
  const savedContext = JSON.stringify({ target: 'musafir', chatId: CHAT_ID, mode: 'task',
    jobId: null, openJob: false, autoRecord: false })
  const storage = new Map([['musafir-context', savedContext]])
  const f = fixture({ storage, request: ({ method }) => method === 'CHAT_LIST'
    ? listReply([CHAT]) : detailReply(CHAT) })
  await flush()
  click(f.page.rows[0])
  await flush()
  const callCount = f.calls.length
  click(f.page.heroButton)
  assert.equal(f.page.heading.options.text, 'Выбери героя')
  assert.equal(f.page.note.options.text, 'Только внешний вид')
  assert.equal(f.page.heroHint.options.text, '5 героев · листайте вверх')
  assert.equal(f.page.heroScroll.options.visible, true)
  assert.equal(f.page.heroScroll.options.data_count, 5)
  assert.deepEqual(f.page.heroScroll.options.data_array.map(item => item.image),
    MUSAFIR_HEROES.map(hero => `heroes/${hero.id}-picker.png`))
  const config = f.page.heroScroll.options.item_config[0]
  assert.equal(config.item_height, 112)
  assert.equal(config.image_view[0].action, true)
  assert.equal(config.text_view.every(item => item.action), true)
  f.page.heroScroll.options.item_click_func(f.page.heroScroll, 4, 'tap')
  assert.equal(storage.get('musafir-hero'), 'amin')
  assert.equal(f.page.heading.options.text, CHAT.title)
  assert.equal(f.calls.length, callCount)
  assert.equal(storage.get('musafir-context'), savedContext)
})

test('late replies cannot replace hero picker and request deadline remains bounded', async () => {
  let resolve
  const f = fixture({ request: () => new Promise(done => { resolve = done }) })
  await flush()
  f.page.heroPicker()
  resolve(listReply([CHAT]))
  await flush()
  assert.equal(f.page.heading.options.text, 'Выбери героя')

  const stalled = fixture({ request: () => new Promise(() => {}) })
  await flush()
  stalled.tick(18000)
  await flush()
  assert.equal(stalled.page.heading.options.text, 'Не удалось')
  assert.equal(stalled.page.note.options.text, 'Mac не ответил вовремя')
})

test('all three layouts keep visible buttons in bounds, disjoint and at least 44px high', async () => {
  for (const [width, height] of [[432, 514], [390, 450], [390, 400]]) {
    const pending = { target: 'musafir', chatId: CHAT_ID, mode: 'task', jobId: null,
      openJob: false, autoRecord: false }
    const storage = new Map([['musafir-pending-context', JSON.stringify(pending)]])
    const f = fixture({ width, height, storage, request: ({ method }) => {
      if (method === 'CHAT_DETAIL') return detailReply(CHAT, [JOB])
      return listReply([
        CHAT, { ...CHAT, id: OTHER_CHAT_ID, title: 'Идеи проекта' }
      ], { activeJob: { id: OTHER_JOB_ID, chatId: CHAT_ID, state: 'running' } })
    } })
    await flush()
    assertVisibleButtonGeometry(f, width, height)
    const visibleRecent = f.page.rows.filter(row => row.options.visible).length
    assert.equal(visibleRecent, height >= 490 ? 2 : height >= 430 ? 1 : 0)

    f.page.chats(false, 0)
    await flush()
    assertVisibleButtonGeometry(f, width, height)
    click(f.page.rows[0])
    await flush()
    assertVisibleButtonGeometry(f, width, height)
    click(f.page.footer[0])
    assertVisibleButtonGeometry(f, width, height)

    f.page.heroPicker()
    assertVisibleButtonGeometry(f, width, height)
    assert.equal(f.page.heroScroll.options.y + f.page.heroScroll.options.h <= height - 14, true)
    assert.equal(f.page.heroScroll.options.h >= 224, true)

    const error = fixture({ width, height, request: async () => ({ ok: false, error: 'Нет связи с Mac' }) })
    error.page.chats(false, 0)
    assertVisibleButtonGeometry(error, width, height)
    await flush()
    assertVisibleButtonGeometry(error, width, height)
    error.page.onDestroy()

    f.page.onDestroy()
    assert.deepEqual(f.statusBars, [false, true])
    assert.equal(f.interaction.offGesture, 1)
    assert.equal(f.interaction.offKey, 1)
  }
})

test('malformed replies expose retry only and destruction cancels pending timers', async () => {
  const malformed = fixture({ request: () => listReply([{ ...CHAT, id: 'wrong' }]) })
  await flush()
  assert.equal(malformed.page.heading.options.text, 'Не удалось')
  assert.deepEqual(JSON.parse(JSON.stringify(malformed.page.items.map(item => item.label))), ['Повторить'])
  assert.equal(malformed.replacements.length, 0)

  const stalled = fixture({ request: () => new Promise(() => {}) })
  await flush()
  assert.equal(stalled.timers.size, 1)
  stalled.page.onDestroy()
  assert.equal(stalled.timers.size, 0)
})
