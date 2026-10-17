import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { MUSAFIR_HEROES, heroById } from '../shared/musafir-chat.js'

const shared = fs.readFileSync(new URL('../shared/musafir-page.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '')
  .replace('export function createMusafirPage', 'function createMusafirPage')
const entry = fs.readFileSync(new URL('../page/index.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '')
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

test('old 0.8 audio draft migrates to the legacy chat without changing its text', async () => {
  const audio = { id: JOB_ID, fileName: 'musafer-saved.opus', totalBytes: 1024, accepted: true, destinationKey: 'voice-draft' }
  const draft = JSON.stringify({ id: JOB_ID, text: 'Точный старый текст', edited: false, pendingSend: false, textId: JOB_ID, draftId: null })
  const storage = new Map([['pending-audio', JSON.stringify(audio)], ['voice-draft', draft]])
  const f = fixture({ storage })
  await flush()
  assert.equal(storage.get('voice-draft'), draft)
  assert.equal(storage.get('voice-draft:musafir:legacy'), draft)
  assert.equal(JSON.parse(storage.get('pending-audio')).destinationKey, 'voice-draft:musafir:legacy')
  assert.equal(JSON.parse(storage.get('musafir-pending-context')).chatId, 'legacy')
  assert.match(f.page.banners[0].options.text, /Черновик/)
  f.page.onDestroy()
})

function fixture({ width = 432, height = 514, storage = new Map(), request } = {}) {
  let page
  const widgets = []
  const replacements = []
  const calls = []
  const timers = new Map()
  let nextTimer = 0
  vm.runInNewContext(source, {
    Page(definition) { page = Object.assign(Object.create(definition), definition) },
    BasePage: value => value,
    MUSAFIR_HEROES,
    heroById,
    getDeviceInfo: () => ({ width, height }),
    replace: value => replacements.push(value),
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
    widget: { FILL_RECT: 1, TEXT: 2, BUTTON: 3, IMG: 4 },
    align: { CENTER_H: 1, CENTER_V: 2, LEFT: 3 },
    text_style: { WRAP: 1 },
    prop: { TEXT: 'text', VISIBLE: 'visible', MORE: 'more' },
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
  return { page, widgets, replacements, calls, storage, timers,
    tick(delay) {
      const match = [...timers].find(([, timer]) => timer.delay === delay)
      assert.ok(match, `Expected a ${delay}ms timer`)
      timers.delete(match[0])
      match[1].callback()
    } }
}

test('home loads chats without reopening an old answer and New task starts recording a new chat', async () => {
  const f = fixture({ request: ({ method }) => {
    assert.equal(method, 'CHAT_LIST')
    return { ok: true, chats: [CHAT, { ...CHAT, id: OTHER_CHAT_ID, title: 'Идеи проекта' }],
      nextOffset: null, activeJob: null }
  } })
  await flush()
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])), {
    payload: { method: 'CHAT_LIST', params: { offset: 0, limit: 10, archived: false } },
    options: { timeout: 15000 }
  })
  assert.equal(f.calls.some(call => ['LATEST_JOB', 'JOB_STATUS'].includes(call.payload.method)), false)
  assert.equal(f.page.rows[0].options.text.includes('Авто в Каире'), true)
  assert.equal(f.page.rows[1].options.text.includes('Идеи проекта'), true)
  assert.equal(f.page.primary.options.text, 'Новая задача')
  assert.equal(f.page.heroImage.options.src, 'heroes/musafir.png')
  f.page.primary.options.click_func()
  assert.deepEqual(JSON.parse(f.storage.get('musafir-context')), {
    target: 'musafir', chatId: null, mode: 'task', jobId: null, openJob: false, autoRecord: true
  })
  assert.equal(f.replacements.at(-1).url, 'page/voice')
})

test('chat detail continues the exact topic and opens a selected job without auto-recording', async () => {
  const jobs = [
    { ok: true, id: OTHER_JOB_ID, chatId: CHAT_ID, state: 'running', text: 'Уточни цены', summary: 'Ищу цены', result: '', mode: 'research', reportLength: 0 },
    { ok: true, id: JOB_ID, chatId: CHAT_ID, state: 'completed', text: 'Найди авто', summary: 'Подборка готова', result: 'Ответ', mode: 'task', reportLength: 0 }
  ]
  const f = fixture({ request: ({ method }) => method === 'CHAT_LIST'
    ? { ok: true, chats: [CHAT], nextOffset: null, activeJob: null }
    : { ok: true, chat: { id: CHAT_ID, title: CHAT.title, archived: false }, jobs, nextOffset: null } })
  await flush()
  f.page.rows[0].options.click_func()
  await flush()
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[1].payload)), {
    method: 'CHAT_DETAIL', params: { chatId: CHAT_ID, offset: 0, limit: 2 }
  })
  assert.equal(f.page.rows[0].options.text.includes('Ищу цены'), true)
  f.page.rows[0].options.click_func()
  assert.deepEqual(JSON.parse(f.storage.get('musafir-context')), {
    target: 'musafir', chatId: CHAT_ID, mode: 'research', jobId: OTHER_JOB_ID, openJob: true, autoRecord: false
  })
  f.replacements.length = 0
  f.page.chatDetail(CHAT)
  await flush()
  f.page.primary.options.click_func()
  assert.deepEqual(JSON.parse(f.storage.get('musafir-context')), {
    target: 'musafir', chatId: CHAT_ID, mode: 'research', jobId: null, openJob: false, autoRecord: true
  })
  assert.equal(f.replacements[0].url, 'page/voice')
})

test('draft and active-job banners use their exact saved or backend contexts', async () => {
  const pending = { target: 'musafir', chatId: OTHER_CHAT_ID, mode: 'task', jobId: null,
    openJob: false, autoRecord: false }
  const storage = new Map([['musafir-pending-context', JSON.stringify(pending)]])
  const f = fixture({ storage, request: () => ({ ok: true, chats: [CHAT], nextOffset: null,
    activeJob: { id: OTHER_JOB_ID, chatId: CHAT_ID, state: 'running' } }) })
  await flush()
  assert.equal(f.page.banners[0].options.text.includes('Черновик'), true)
  assert.equal(f.page.banners[1].options.text.includes('В работе'), true)
  f.page.banners[0].options.click_func()
  assert.deepEqual(JSON.parse(f.storage.get('musafir-context')), pending)
  f.replacements.length = 0
  f.page.homeReply({ ok: true, chats: [CHAT], nextOffset: null,
    activeJob: { id: OTHER_JOB_ID, chatId: CHAT_ID, state: 'running' } })
  f.page.banners[1].options.click_func()
  assert.deepEqual(JSON.parse(f.storage.get('musafir-context')), {
    target: 'musafir', chatId: CHAT_ID, mode: 'task', jobId: OTHER_JOB_ID, openJob: true, autoRecord: false
  })
})

test('archive needs confirmation and archived chats can be restored', async () => {
  let archived = false
  const f = fixture({ request: ({ method, params }) => {
    if (method === 'CHAT_LIST') return { ok: true, chats: [{ ...CHAT, archived }], nextOffset: null, activeJob: null }
    if (method === 'CHAT_DETAIL') return { ok: true, chat: { id: CHAT_ID, title: CHAT.title, archived }, jobs: [], nextOffset: null }
    if (method === 'CHAT_ARCHIVE') { archived = params.archived; return { ok: true, chatId: CHAT_ID, archived } }
    throw Error(method)
  } })
  await flush()
  f.page.rows[0].options.click_func()
  await flush()
  f.page.footer[1].options.click_func()
  assert.equal(f.calls.some(call => call.payload.method === 'CHAT_ARCHIVE'), false)
  assert.equal(f.page.rows[0].options.text, 'Архивировать')
  f.page.rows[0].options.click_func()
  await flush(); await flush()
  assert.equal(archived, true)
  f.page.chats(true, 0)
  await flush()
  f.page.rows[0].options.click_func()
  await flush()
  assert.equal(f.page.footer[1].options.text, 'Восстановить')
  assert.equal(f.page.primary.options.visible, false)
  f.page.footer[1].options.click_func()
  await flush(); await flush()
  assert.equal(archived, false)
})

test('hero picker is cosmetic and returns to the same chat screen', async () => {
  const savedContext = JSON.stringify({ target: 'musafir', chatId: CHAT_ID, mode: 'task',
    jobId: null, openJob: false, autoRecord: false })
  const storage = new Map([['musafir-context', savedContext]])
  const f = fixture({ storage, request: ({ method }) => method === 'CHAT_LIST'
    ? { ok: true, chats: [CHAT], nextOffset: null, activeJob: null }
    : { ok: true, chat: { id: CHAT_ID, title: CHAT.title, archived: false }, jobs: [], nextOffset: null } })
  await flush()
  f.page.rows[0].options.click_func()
  await flush()
  const callCount = f.calls.length
  assert.equal(f.page.heading.options.text, CHAT.title)
  f.page.heroButton.options.click_func()
  assert.equal(f.page.note.options.text, 'Только внешний вид')
  assert.equal(f.page.rows.filter(row => row.options.visible).length, 3)
  assert.equal(f.page.rows[0].options.text, 'Musafir · Путешественник')
  f.page.footer[2].options.click_func()
  assert.equal(f.page.rows[0].options.text, 'Hakim · Мудрый')
  f.page.rows[1].options.click_func()
  assert.equal(f.storage.get('musafir-hero'), 'amin')
  assert.equal(f.page.heroImage.options.src, 'heroes/amin.png')
  assert.equal(f.page.heading.options.text, CHAT.title)
  assert.equal(f.page.footer[1].options.text, 'Архивировать')
  assert.equal(f.calls.length, callCount)
  assert.equal(f.storage.get('musafir-context'), savedContext)
  assert.equal(f.page.heroImage.options.auto_scale, true)
})

test('late chat-list replies cannot replace a newer screen', async () => {
  let resolve
  const f = fixture({ request: () => new Promise(done => { resolve = done }) })
  await flush()
  f.page.heroPicker()
  resolve({ ok: true, chats: [CHAT], nextOffset: null, activeJob: null })
  await flush()
  assert.equal(f.page.heading.options.text, 'Выбери героя')
})

test('new recording needs an explicit choice before discarding a pending draft', async () => {
  const pending = { target: 'musafir', chatId: null, mode: 'task', jobId: null,
    openJob: false, autoRecord: false }
  const draft = JSON.stringify({ text: 'Не потеряй этот текст' })
  const audio = JSON.stringify({ id: JOB_ID, fileName: 'draft.opus', accepted: false,
    totalBytes: 1024, destinationKey: 'voice-draft:musafir:new' })
  const storage = new Map([
    ['musafir-pending-context', JSON.stringify(pending)],
    ['voice-draft:musafir:new', draft],
    ['pending-audio', audio]
  ])
  const f = fixture({ storage })
  await flush()
  f.page.primary.options.click_func()
  assert.equal(f.page.heading.options.text, 'Есть черновик')
  assert.equal(f.page.rows[0].options.text, 'Продолжить черновик')
  assert.equal(f.page.rows[1].options.text, 'Новая запись')
  assert.equal(storage.get('voice-draft:musafir:new'), draft)
  assert.equal(storage.get('pending-audio'), audio)
  assert.equal(f.replacements.length, 0)
  f.page.rows[1].options.click_func()
  assert.equal(storage.get('musafir-pending-context'), '')
  assert.equal(storage.get('voice-draft:musafir:new'), '')
  assert.equal(storage.get('pending-audio'), '')
  assert.deepEqual(JSON.parse(storage.get('musafir-context')), {
    target: 'musafir', chatId: null, mode: 'task', jobId: null, openJob: false, autoRecord: true
  })
  assert.equal(f.replacements.at(-1).url, 'page/voice')
})

test('explicit new recording preserves pending audio that belongs to another destination', async () => {
  const pending = { target: 'musafir', chatId: null, mode: 'task', jobId: null,
    openJob: false, autoRecord: false }
  const otherAudio = JSON.stringify({ id: JOB_ID, fileName: 'other.opus', accepted: false,
    totalBytes: 1024, destinationKey: `voice-draft:musafir:${CHAT_ID}` })
  const storage = new Map([
    ['musafir-pending-context', JSON.stringify(pending)],
    ['voice-draft:musafir:new', JSON.stringify({ text: 'Черновик' })],
    ['pending-audio', otherAudio]
  ])
  const f = fixture({ storage })
  await flush()
  f.page.primary.options.click_func()
  f.page.rows[1].options.click_func()
  assert.equal(storage.get('pending-audio'), otherAudio)
})

test('chat detail pages through all jobs in both directions', async () => {
  const jobs = [0, 1, 2, 3, 4].map(index => ({
    ok: true,
    id: `1700000000002-${index + 1}`,
    chatId: CHAT_ID,
    state: 'completed',
    text: `Задание ${index + 1}`,
    summary: `Ответ ${index + 1}`,
    result: '',
    mode: 'task',
    reportLength: 0
  }))
  const f = fixture({ request: ({ method, params }) => {
    if (method === 'CHAT_LIST') return { ok: true, chats: [CHAT], nextOffset: null, activeJob: null }
    if (method === 'CHAT_DETAIL') return {
      ok: true,
      chat: { id: CHAT_ID, title: CHAT.title, archived: false },
      jobs: jobs.slice(params.offset, params.offset + 2),
      nextOffset: params.offset + 2 < jobs.length ? params.offset + 2 : null
    }
    throw Error(method)
  } })
  await flush()
  f.page.rows[0].options.click_func()
  await flush()
  assert.equal(f.page.rows[2].options.text, 'Более ранние ответы')
  f.page.rows[2].options.click_func()
  await flush()
  assert.equal(f.calls.at(-1).payload.params.offset, 2)
  assert.equal(f.page.note.options.text, 'Ответы 3–4')
  assert.equal(f.page.rows[2].options.text, 'Более ранние ответы')
  assert.equal(f.page.footer[2].options.text, 'Новее')
  f.page.rows[2].options.click_func()
  await flush()
  assert.equal(f.calls.at(-1).payload.params.offset, 4)
  assert.equal(f.page.note.options.text, 'Ответы 5–5')
  f.page.footer[2].options.click_func()
  await flush()
  assert.equal(f.calls.at(-1).payload.params.offset, 2)
  assert.equal(f.page.footer[1].options.text, 'Архивировать')
})

test('home controls stay inside the native and compatibility layouts', async () => {
  for (const [width, height] of [[432, 514], [390, 450]]) {
    const pending = { target: 'musafir', chatId: CHAT_ID, mode: 'task', jobId: null,
      openJob: false, autoRecord: false }
    const storage = new Map([['musafir-pending-context', JSON.stringify(pending)]])
    const f = fixture({ width, height, storage, request: () => ({
      ok: true, chats: [CHAT, { ...CHAT, id: OTHER_CHAT_ID }], nextOffset: null,
      activeJob: { id: OTHER_JOB_ID, chatId: CHAT_ID, state: 'running' }
    }) })
    await flush()
    for (const item of f.widgets.filter(item => item.options.visible)) {
      const { x, y, w, h } = item.options
      if (![x, y, w, h].every(Number.isFinite)) continue
      assert.equal(x >= 0 && y >= 0 && x + w <= width && y + h <= height, true)
    }
    assert.equal(f.page.footer[0].options.y + f.page.footer[0].options.h <= f.page.primary.options.y, true)
    const vertical = [f.page.banners[0], f.page.banners[1], f.page.rows[0], f.page.rows[1],
      f.page.footer[0], f.page.primary]
    for (let index = 1; index < vertical.length; index += 1) {
      assert.equal(vertical[index - 1].options.y + vertical[index - 1].options.h <= vertical[index].options.y, true)
    }
    for (const button of f.widgets.filter(item => item.kind === 3 && item.options.visible)) {
      assert.equal(button.options.h >= 44, true)
    }
  }
})

test('malformed chat replies never enable chat actions', async () => {
  const f = fixture({ request: () => ({ ok: true, chats: [{ ...CHAT, id: 'wrong' }],
    nextOffset: null, activeJob: null }) })
  await flush()
  assert.equal(f.page.heading.options.text, 'Не удалось')
  assert.equal(f.page.rows[0].options.text, 'Повторить')
  assert.equal(f.replacements.length, 0)
})

test('malformed chat detail never enables job or continue actions', async () => {
  const f = fixture({ request: ({ method }) => method === 'CHAT_LIST'
    ? { ok: true, chats: [CHAT], nextOffset: null, activeJob: null }
    : { ok: true, chat: { id: CHAT_ID, title: CHAT.title, archived: false },
        jobs: [{ ok: true, id: 'legacy', chatId: CHAT_ID, state: 'completed', text: '',
          summary: '', mode: 'task' }], nextOffset: null } })
  await flush()
  f.page.rows[0].options.click_func()
  await flush()
  assert.equal(f.page.heading.options.text, 'Не удалось')
  assert.equal(f.page.rows[0].options.text, 'Повторить')
  assert.equal(f.page.primary.options.text, 'Новая задача')
  assert.equal(f.replacements.length, 0)
})

test('an outer deadline ends a bridge request that never settles', async () => {
  const f = fixture({ request: () => new Promise(() => {}) })
  await flush()
  f.tick(18000)
  await flush()
  assert.equal(f.page.heading.options.text, 'Не удалось')
  assert.equal(f.page.note.options.text, 'Mac не ответил вовремя')
})

test('destroy cancels the outer deadline of a pending request', async () => {
  const f = fixture({ request: () => new Promise(() => {}) })
  await flush()
  assert.equal(f.timers.size, 1)
  f.page.onDestroy()
  assert.equal(f.timers.size, 0)
  await flush()
  assert.equal(f.page.heading.options.text, 'Мусафир')
})
