import { textRows } from '../shared/text-rows.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createWatchClient, MAX_AUDIO_BYTES } from '../shared/watch-client.js'
import { createOrcaVoiceRoute, createFolderVoiceRoute } from '../shared/orca-voice.js'
import { createClaudeVoiceRoute, createCodexVoiceRoute } from '../shared/claude-voice.js'
import { createMusafirVoiceRoute, normalizeContext, heroById, MUSAFIR_CONTEXT_KEY, MUSAFIR_HERO_KEY } from '../shared/musafir-chat.js'

const alertSource = fs.readFileSync(new URL('../shared/watch-alerts.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '')
  .replace('export function createWatchAlerts', 'function createWatchAlerts')
const voiceSource = fs.readFileSync(new URL('../shared/voice-page.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '')
  .replace('export function createVoicePage', 'function createVoicePage')
// Legacy recorder tests exercise the same component used by all four voice apps.
// The new chat entry is exercised explicitly with chats:true below.
const entrySource = "Page(BasePage(createVoicePage({ kind: 'musafir', icon: 'brand-mark.png', title: 'Мусафир', version: '0.9.0' })))"
const source = `${alertSource}\n${voiceSource}\n${entrySource}`
const flush = () => new Promise(resolve => setImmediate(resolve))
const scrollText = scroll => (scroll.options.data_array || [])
  .map(row => String(row.text == null ? row.display || '' : row.text) + String(row.separator || '')).join('')
const assertReaderText = (page, expected) => {
  assert.equal(page.readerScroll.options.visible, true)
  assert.equal(page.bodyWidget.options.visible, false)
  assert.equal(scrollText(page.readerScroll), expected)
}
const assertReviewText = (page, expected) => {
  assert.equal(page.reviewScroll.options.visible, true)
  assert.equal(page.bodyWidget.options.visible, false)
  assert.equal(page.reviewRows.map(row => row.text + row.separator).join(''), expected)
}

export function pageFixture({ media = () => { throw Error('recorder unavailable') }, layout,
  width = 390, height = 450, files = {}, reply, storage = new Map(),
  storageError = false, displayError = false, vibratorError = false, kind = 'musafir', keyboard, chats = false } = {}) {
  let page
  let mediaCalls = 0
  let nextTimer = 0
  let clock = 100000
  const timers = new Map()
  const requests = []
  const widgets = []
  const replacements = []
  const displayCalls = []
  const vibrationCalls = []
  const keyboardCalls = []
  const interactionCalls = []
  let keyboardOptions
  let gestureCallback = null
  let keyCallback = null
  const keyboardUI = keyboard || {
    inputType: { CHAR: 1, JSKB: 4 },
    createKeyboard(options) { keyboardOptions = options; keyboardCalls.push({ action: 'open', options }); return {} },
    deleteKeyboard() { keyboardCalls.push({ action: 'close' }) }
  }
  const display = Object.fromEntries(['setWakeUpRelaunch', 'setPageBrightTime', 'resetPageBrightTime',
    'pauseDropWristScreenOff', 'resetDropWristScreenOff'].map(name => [name, value => {
    displayCalls.push({ name, ...value })
    if (displayError) throw Error('display unavailable')
  }]))
  const executable = kind === 'musafir' ? chats ? `${alertSource}\n${voiceSource}\nPage(BasePage(createVoicePage({kind:'musafir',chats:true,icon:'heroes/musafir.png',title:'Мусафир',version:'0.9.0'})))` : source : kind === 'claude' || kind === 'codex'
    ? `${alertSource}\n${voiceSource}\nPage(BasePage(createVoicePage({ kind: '${kind}', icon: '${kind}-mark.png', title: '${kind === 'codex' ? 'Codex' : 'Claude'}', version: '0.1.0' })))`
    : `${alertSource}\n${voiceSource}\nPage(BasePage(createVoicePage({
    kind: 'orca', icon: 'orca-mark.png', title: 'Orca', version: '0.2.0'
  })))`
  vm.runInNewContext(executable, {
    Page(value) { page = value }, BasePage: value => value,
    createWatchClient, MAX_AUDIO_BYTES, createOrcaVoiceRoute, createFolderVoiceRoute, createClaudeVoiceRoute, createCodexVoiceRoute,
    createMusafirVoiceRoute, normalizeContext, heroById, MUSAFIR_CONTEXT_KEY, MUSAFIR_HERO_KEY, textRows,
    replace(value) { replacements.push(value) },
    ...display, keyboardUI,
    interaction: {
      GESTURE_RIGHT: 4,
      KEY_BACK: 8,
      KEY_EVENT_CLICK: 16,
      onGesture({ callback }) { gestureCallback = callback; interactionCalls.push('onGesture') },
      offGesture() { gestureCallback = null; interactionCalls.push('offGesture') },
      onKey({ callback }) { keyCallback = callback; interactionCalls.push('onKey') },
      offKey() { keyCallback = null; interactionCalls.push('offKey') }
    },
    setStatusBarVisible: value => displayCalls.push({ name: 'setStatusBarVisible', visible: value }),
    LocalStorage: class {
      constructor() { if (storageError) throw Error('storage unavailable') }
      getItem(key) { return storage.get(key) }
      setItem(key, value) { storage.set(key, value) }
    },
    Vibrator: class {
      constructor() { if (vibratorError) throw Error('vibrator unavailable') }
      start(options) { vibrationCalls.push({ name: 'start', ...options }) }
      stop() { vibrationCalls.push({ name: 'stop' }) }
    },
    VIBRATOR_SCENE_SHORT_STRONG: 'short-strong',
    Date: class extends Date { static now() { return clock } },
    getDeviceInfo: () => ({ width, height }),
    createWidget: (kind, options) => {
      const element = {
      kind,
      options: { ...options, visible: true },
      updates: [],
      setProperty(key, value) {
        this.updates.push({ key, value })
        if (kind === 3 && key === 'text') throw new Error('BUTTON prop.TEXT is invalid on native Zepp OS')
        if (kind === 3 && key === 'more') {
          for (const required of ['x', 'y', 'w', 'h', 'text']) {
            assert.ok(Object.hasOwn(value, required), `BUTTON prop.MORE requires ${required}`)
          }
        }
        if (key === 'more' || key === 'update-data') Object.assign(this.options, value)
        else this.options[key] = value
      }
      }
      widgets.push(element)
      return element
    },
    widget: { FILL_RECT: 1, TEXT: 2, BUTTON: 3, IMG: 4, SCROLL_LIST: 5 },
    align: { CENTER_H: 1, CENTER_V: 2, LEFT: 3, TOP: 4 }, text_style: { WRAP: 1 },
    prop: { VISIBLE: 'visible', MORE: 'more', TEXT: 'text', COLOR: 'color', UPDATE_DATA: 'update-data' },
    getTextLayout: layout || (() => ({ height: 80, width: 300 })),
    mediaId: { RECORDER: 1 }, codec: { OPUS: 1 },
    create() { mediaCalls += 1; return media() },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id },
    clearTimeout: id => timers.delete(id),
    O_RDONLY: 0, statSync() {}, openSync() {}, readSync() {}, closeSync() {}, rmSync() {}, ...files,
    console: { log() {} }
  })
  page.request = payload => {
    requests.push(payload)
    return Promise.resolve(reply ? reply(payload) : payload.method === 'STATUS'
      ? { ok: true, agent: 'Мусафир' } : { ok: true, job: null })
  }
  return { page, requests, timers, widgets, displayCalls, vibrationCalls, keyboardCalls, interactionCalls,
    keyboard: () => keyboardOptions, storage, replacements, mediaCalls: () => mediaCalls,
    gesture(event = 4) { return gestureCallback && gestureCallback(event) },
    key(key = 8, event = 16) { return keyCallback && keyCallback(key, event) },
    advance(ms) { clock += ms },
    tick(delay) {
      const match = [...timers].find(([, timer]) => timer.delay === delay)
      assert.ok(match, `Expected a ${delay}ms timer`)
      timers.delete(match[0])
      clock += delay
      match[1].callback()
    }
  }
}

test('startup connects without opening the microphone', async () => {
  const f = pageFixture()
  assert.doesNotThrow(() => f.page.build())
  await flush()
  assert.equal(f.mediaCalls(), 0)
  assert.equal(f.page.client.getState().phase, 'ready')
  assert.equal(f.page.primaryButton.options.visible, true)
  f.page.onDestroy()
})

test('Musafir New task ignores legacy autoRecord and opens local compose without the Mac', async () => {
  const storage = new Map([['musafir-context', JSON.stringify({ target: 'musafir', chatId: null,
    mode: 'task', jobId: null, openJob: false, autoRecord: true })], ['musafir-hero', 'barq']])
  let starts = 0
  const f = pageFixture({ chats: true, storage, media: () => ({
    setFormat() {}, start() { starts++ }, stop() {}
  }), reply: () => { throw Error('Mac must not be needed for local recording') } })
  f.page.build()
  await flush()
  assert.equal(starts, 0)
  assert.equal(f.page.client.getState().phase, 'ready')
  assert.equal(f.requests.length, 0)
  assert.equal(f.page.hero.id, 'barq')
  assert.equal(f.page.statusWidget.options.text, 'Новая задача')
  assert.equal(f.page.primaryButton.options.text, 'Надиктовать')
  assert.equal(f.page.secondaryButton.options.text, 'Написать')
  assert.equal(f.page.backButton.options.x, 24)
  assert.equal(f.page.backButton.options.h >= 48, true)
  assert.deepEqual([f.page.brandWidget.options.w, f.page.brandWidget.options.h], [80, 80])
  assert.equal(f.page.brandWidget.options.src, 'heroes/barq.png')
  f.page.onDestroy()
})

test('Musafir explicit task resumes after sleep and animates its cosmetic hero only while running', async () => {
  const id = '1700000000000-21'
  const storage = new Map([['musafir-context', JSON.stringify({ target: 'musafir', chatId: 'legacy',
    mode: 'task', jobId: id, openJob: true })], ['musafir-hero', 'amin']])
  let state = 'queued'
  const reply = ({ method }) => method === 'STATUS' ? { ok: true, agent: 'Мусафир' }
    : { ok: true, id, chatId: 'legacy', state, text: 'Задание', result: '', summary: '', reportLength: 0 }
  const f = pageFixture({ chats: true, storage, reply })
  f.page.build()
  await flush()
  assert.deepEqual(f.requests.map(x => x.method), ['STATUS', 'JOB_STATUS'])
  assert.equal(f.page.statusWidget.options.text, 'Задание получено')
  assert.equal(f.page.brandWidget.options.src, 'heroes/amin.png')
  state = 'running'
  f.tick(3000)
  await flush()
  assert.equal(f.page.client.getState().state, 'running')
  assert.equal(f.page.statusWidget.options.text, 'Мусафир работает')
  assert.equal(f.page.stageWidget.options.text.includes('Orca'), false)
  f.advance(1800)
  f.tick(300)
  assert.match(f.page.brandWidget.options.src, /^heroes\/amin-[012]\.png$/)
  f.page.onDestroy()
  assert.equal(JSON.parse(storage.get('musafir-context')).openJob, true)
  const reopened = pageFixture({ chats: true, storage, reply })
  reopened.page.build()
  await flush()
  assert.deepEqual(reopened.requests.map(x => x.method), ['STATUS', 'JOB_STATUS'])
  assert.equal(reopened.page.client.getState().jobId, id)
  reopened.page.onDestroy()
})

test('Musafir result exposes full report and Continue returns to compose without the microphone', async () => {
  const id = '1700000000000-31'
  const storage = new Map([['musafir-context', JSON.stringify({ target: 'musafir', chatId: id,
    mode: 'research', jobId: id, openJob: true })]])
  const f = pageFixture({ chats: true, storage, media: () => ({ setFormat() {}, start() {}, stop() {} }),
    reply: ({ method }) => method === 'STATUS' ? { ok: true, agent: 'Мусафир' } : {
      ok: true, id, chatId: id, mode: 'research', state: 'completed', result: 'Полный ответ',
      summary: 'Начало ответа', reportLength: 15000
    } })
  f.page.build()
  await flush()
  assertReaderText(f.page, 'Начало ответа')
  assert.equal(f.page.menuButton.options.text, 'Полный ответ')
  f.page.menuButton.options.click_func()
  assert.equal(f.storage.get('musafir-report-job'), id)
  assert.equal(f.replacements.at(-1).url, 'page/report')
  f.page.primaryButton.options.click_func()
  assert.equal(f.page.draftStorageKey, 'voice-draft:musafir:' + id)
  assert.equal(f.page.client.getState().phase, 'ready')
  assert.equal(f.page.primaryButton.options.text, 'Надиктовать')
  assert.equal(f.mediaCalls(), 0)
  assert.equal(storage.get('pending-audio'), undefined)
  f.page.onDestroy()
})

test('Musafir never overwrites another chat audio when a stale Continue destination opens compose', async () => {
  const audio = { id: '1700000000000-41', fileName: 'saved.opus', accepted: true,
    totalBytes: 100, destinationKey: 'voice-draft:musafir:legacy' }
  const storage = new Map([['pending-audio', JSON.stringify(audio)],
    ['musafir-pending-context', JSON.stringify({ target: 'musafir', chatId: 'legacy', mode: 'task',
      jobId: null, openJob: false, autoRecord: false })],
    ['musafir-context', JSON.stringify({ target: 'musafir', chatId: '1700000000000-42', mode: 'task',
      jobId: null, openJob: false, autoRecord: true })]])
  const f = pageFixture({ chats: true, storage })
  f.page.build()
  await flush()
  assert.equal(f.mediaCalls(), 0)
  assert.deepEqual(JSON.parse(storage.get('pending-audio')), audio)
  assert.equal(f.page.client.getState().phase, 'ready')
  assert.equal(f.replacements.length, 0)
  f.page.onDestroy()
})

test('Musafir can stop while awaiting approval and can read saved output after failure', async () => {
  const id = '1700000000000-51'
  const makeStorage = () => new Map([['musafir-context', JSON.stringify({ target: 'musafir', chatId: 'legacy',
    mode: 'research', jobId: id, openJob: true })]])
  const f = pageFixture({ chats: true, storage: makeStorage(), reply: ({ method }) =>
    method === 'STATUS' ? { ok: true, agent: 'Мусафир' } : { ok: true, id, chatId: 'legacy',
      state: method === 'JOB_STOP' ? 'cancelled' : 'approval', result: '', reportLength: 0,
      approval: { id: 'permission-1', text: 'Действие, ожидающее решения' } } })
  f.page.build()
  await flush()
  assert.equal(f.page.menuButton.options.text, 'Остановить задание')
  assert.equal(f.page.primaryButton.options.text, 'Разрешить')
  assert.equal(f.page.secondaryButton.options.text, 'Отказать')
  f.page.menuButton.options.click_func()
  assert.equal(f.page.menuButton.options.text, 'Подтвердить остановку')
  f.page.menuButton.options.click_func()
  await flush()
  assert.equal(f.page.client.getState().state, 'cancelled')
  assert.equal(f.requests.filter(x => x.method === 'JOB_STOP').length, 1)
  assert.equal(f.requests.filter(x => x.method === 'JOB_APPROVE').length, 0)
  f.page.onDestroy()
  const failed = pageFixture({ chats: true, storage: makeStorage(), reply: ({ method }) =>
    method === 'STATUS' ? { ok: true, agent: 'Мусафир' } : { ok: true, id, chatId: 'legacy',
      state: 'error', result: 'Собранные данные', summary: 'Собранные данные', reportLength: 10000, error: 'Исследование прервано' } })
  failed.page.build()
  await flush()
  assert.equal(failed.page.client.getState().phase, 'error')
  assert.equal(failed.page.menuButton.options.visible, true)
  assert.equal(failed.page.menuButton.options.text, 'Сохранённый ответ')
  failed.page.menuButton.options.click_func()
  assert.equal(failed.replacements.at(-1).url, 'page/report')
  failed.page.onDestroy()
})

test('Musafir hero, clock and text have separate bounds at native, compatibility and compact sizes', async () => {
  for (const [width, height] of [[432, 514], [390, 450], [390, 400]]) {
    const id = '1700000000000-61'
    const f = pageFixture({ chats: true, width, height, storage: new Map([['musafir-context',
      JSON.stringify({ target: 'musafir', chatId: 'legacy', mode: 'task', jobId: id, openJob: true })]]),
      reply: ({ method }) => method === 'STATUS' ? { ok: true, agent: 'Мусафир' }
        : { ok: true, id, chatId: 'legacy', state: 'running', result: '', reportLength: 0 } })
    f.page.build()
    await flush()
    const hero = f.page.brandWidget.options, clock = f.page.metricWidget.options, body = f.page.bodyWidget.options
    const png = fs.readFileSync(new URL('../assets/common.s/' + hero.src, import.meta.url))
    assert.equal(png.readUInt32BE(16), hero.w, 'native image width must match its widget without scaling')
    assert.equal(png.readUInt32BE(20), hero.h, 'native image height must match its widget without scaling')
    assert.ok(f.displayCalls.some(call => call.name === 'setStatusBarVisible' && call.visible === false))
    assert.ok(hero.y + hero.h <= clock.y)
    assert.ok(clock.y + clock.h <= body.y)
    assert.ok(body.y + body.h <= f.page.primaryButton.options.y)
    f.page.onDestroy()
  }
})

test('Orca missing project operation offers saved text and a working exit to the menu', async () => {
  const id = '1700000000000-1'
  const text = 'Проект называется такси дубай.'
  const storage = new Map([['voice-destination', JSON.stringify({
    target: 'folder', rootId: 'external', operationId: id
  })]])
  const f = pageFixture({ kind: 'orca', storage, reply: ({ method }) => {
    if (method === 'ORCA_OPERATION') return { ok: false, code: 'OPERATION_NOT_FOUND', error: 'Операция не найдена' }
    if (method === 'AUDIO_STATUS') return { ok: true, id, state: 'ready', text,
      textLength: text.length, textOffset: 0, textComplete: true }
    throw Error(method)
  } })
  f.page.build()
  await flush()
  assert.equal(f.page.primaryButton.options.text, 'К тексту')
  assert.equal(f.page.secondaryButton.options.text, 'Orca')
  f.page.primaryButton.options.click_func()
  await flush()
  assert.equal(f.page.client.getState().phase, 'review')
  assert.equal(f.page.client.getState().text, text)
  assert.equal(f.requests.some(x => ['ORCA_PROJECT_CREATE', 'ORCA_PROJECT_PLAN'].includes(x.method)), false)
  f.page.openOrca()
  assert.equal(f.replacements.at(-1).url, 'page/index')
  assert.equal(JSON.parse(storage.get('orca-resume')).screen, 'home')
  f.page.onDestroy()
})

test('Musafir ignores and clears a legacy Orca destination without resuming its audio into Hermes', async () => {
  const storage = new Map([
    ['voice-destination', JSON.stringify({ target: 'orca', pairId: 'old-pair' })],
    ['pending-audio', JSON.stringify({
      id: '1700000000000-1', fileName: 'orca-1700000000000-1.opus', totalBytes: 1024, accepted: true
    })]
  ])
  const f = pageFixture({ storage })
  f.page.build()
  await flush()
  assert.equal(f.page.destination, null)
  assert.equal(f.page.pendingAudio, null)
  assert.equal(f.page.menuButton.options.text, 'История')
  assert.equal(storage.get('voice-destination'), '')
  assert.equal(storage.get('pending-audio'), '')
  assert.deepEqual(f.requests.map(request => request.method), ['STATUS', 'LATEST_JOB'])
  assert.equal(f.requests.some(request => request.method.startsWith('ORCA_') ||
    ['AUDIO_BEGIN', 'AUDIO_STATUS', 'SEND_TEXT'].includes(request.method)), false)
  f.page.onDestroy()
})

test('Orca voice without a valid destination returns to its menu before making a request', () => {
  const f = pageFixture({ kind: 'orca' })
  f.page.build()
  assert.deepEqual(JSON.parse(JSON.stringify(f.replacements)), [{ url: 'page/index' }])
  assert.deepEqual(f.requests, [])
  assert.equal(f.page.client, undefined)
  f.page.onDestroy()
})

test('Orca voice uses Orca branding and never sends Hermes status methods', async () => {
  const storage = new Map([['voice-destination', JSON.stringify({
    target: 'orca', pairId: 'pair-1', label: 'Проект'
  })]])
  const f = pageFixture({ kind: 'orca', storage })
  f.page.build()
  await flush()
  assert.deepEqual(f.requests.map(request => request.method), ['ORCA_LATEST'])
  assert.equal(f.page.statusWidget.options.text, 'Задача для Orca')
  assert.equal(f.page.stageWidget.options.text, 'Проект')
  assert.equal(f.page.brandWidget.options.src, 'orca-mark.png')
  assert.equal(f.page.menuButton.options.visible, false)
  assert.equal(f.page.backButton.options.visible, true)
  assert.equal(f.page.bodyWidget.options.text.includes('Мусафир'), false)
  f.page.onDestroy()
})

test('Orca stop needs two taps, fences the task and shows the final state', async () => {
  const storage = new Map([['voice-destination', JSON.stringify({
    target: 'orca', pairId: 'pair-1', label: 'Проект', jobId: 'job-1', aliasId: 'job-1', resumeJob: true
  })]])
  let stopped = false
  const f = pageFixture({ kind: 'orca', storage, reply: ({ method, params }) => {
    if (method === 'ORCA_JOB') return { ok: true, job: { id: 'job-1', state: stopped ? 'error' : 'running',
      stage: stopped ? 'stopped' : 'worker_working', error: stopped ? 'Остановлено с часов' : '', result: '', nextCursor: null } }
    if (method === 'ORCA_STOP') { assert.equal(params.id, 'job-1'); stopped = true
      return { ok: true, job: { id: 'job-1', state: 'error', stage: 'stopped', error: 'Остановлено с часов' } } }
    throw Error(method)
  } })
  f.page.build()
  await flush()
  assert.equal(f.page.statusWidget.options.text, 'Боевой работает')
  assert.equal(f.page.primaryButton.options.text, 'Стоп')
  assert.equal(f.page.secondaryButton.options.text, 'Пауза')
  f.page.primaryButton.options.click_func()
  assert.equal(f.page.primaryButton.options.text, 'Точно стоп?')
  assert.equal(f.requests.filter(r => r.method === 'ORCA_STOP').length, 0)
  f.page.disarmStop()
  assert.equal(f.page.primaryButton.options.text, 'Стоп')
  f.page.primaryButton.options.click_func()
  f.page.primaryButton.options.click_func()
  await flush(); await flush()
  assert.equal(f.requests.filter(r => r.method === 'ORCA_STOP').length, 1)
  assert.equal(f.page.client.getState().state, 'cancelled')
  assert.equal(f.page.statusWidget.options.text, 'Остановлено')
  assert.equal(f.page.stageWidget.options.text, 'Остановка подтверждена')
  assertReaderText(f.page, 'Остановлено с часов')
  assert.equal(f.page.stopArmed, false)
  f.page.onDestroy()
})

test('Orca question screen labels the role and hands a proposed prompt to the worker only on tap', async () => {
  const storage = new Map([['voice-destination', JSON.stringify({
    target: 'orca', pairId: 'pair-1', label: 'Проект', askRole: 'reviewer'
  })]])
  const f = pageFixture({ kind: 'orca', storage, reply: ({ method }) => {
    if (method === 'ORCA_LATEST') return { ok: true, job: null }
    throw Error(method)
  } })
  f.page.build()
  await flush()
  assert.equal(f.page.statusWidget.options.text, 'Вопрос проверяющему')
  assert.match(f.page.bodyWidget.options.text, /только ответит/)
  f.page.onDestroy()

  const handed = []
  const g = pageFixture({ kind: 'orca', storage: new Map([['voice-destination', JSON.stringify({
    target: 'orca', pairId: 'pair-1', label: 'Проект', askRole: 'reviewer', jobId: 'ask-1', aliasId: 'ask-1', resumeJob: true
  })]]), reply: ({ method, params }) => {
    if (method === 'ORCA_JOB') return { ok: true, job: { id: 'ask-1', state: 'completed', stage: 'completed', mode: 'ask',
      askRole: 'reviewer', result: 'Мы на этапе 2. Промпт готов.', handoff: true, nextCursor: null } }
    if (method === 'ORCA_HANDOFF') { handed.push(params); return { ok: true, job: { id: params.newId, state: 'queued', stage: 'queued' } } }
    throw Error(method)
  } })
  g.page.build()
  await flush()
  assert.equal(g.page.statusWidget.options.text, 'Ответ агента')
  assert.match(scrollText(g.page.readerScroll), /этапе 2/)
  assert.equal(g.page.secondaryButton.options.text, 'Боевому')
  assert.equal(handed.length, 0)
  g.page.secondaryButton.options.click_func()
  await flush(); await flush()
  assert.equal(handed.length, 1)
  assert.equal(handed[0].id, 'ask-1')
  assert.match(handed[0].newId, /^\d+-\d+$/)
  const saved = JSON.parse(g.storage.get('voice-destination'))
  assert.equal(saved.jobId, handed[0].newId)
  assert.equal(saved.resumeJob, true)
  assert.equal(saved.handoff, false)
  assert.equal(g.replacements.at(-1).url, 'page/voice')
  g.page.onDestroy()
})

test('Claude voice needs a project destination, shows the mode, runs the task and can stop it', async () => {
  const bare = pageFixture({ kind: 'claude' })
  bare.page.build()
  assert.equal(bare.replacements.at(-1).url, 'page/index')
  assert.equal(bare.requests.length, 0)
  bare.page.onDestroy()

  const storage = new Map([['voice-destination', JSON.stringify({
    target: 'claude', project: '/work/crm', label: 'CRM', mode: 'plan'
  })]])
  const f = pageFixture({ kind: 'claude', storage, reply: ({ method }) => {
    if (method === 'CLAUDE_LATEST') return { ok: true, job: null }
    throw Error(method)
  } })
  f.page.build()
  await flush()
  assert.deepEqual(f.requests.map(r => r.method), ['CLAUDE_LATEST'])
  assert.equal(f.page.statusWidget.options.text, 'Задача для Claude')
  assert.equal(f.page.stageWidget.options.text, 'CRM')
  assert.match(f.page.bodyWidget.options.text, /Режим: План/)
  assert.equal(f.page.menuButton.options.text, 'Claude')
  assert.equal(f.page.menuButton.options.visible, false)
  assert.equal(f.page.backButton.options.visible, true)
  assert.equal(JSON.parse(storage.get('claude-resume')).screen, 'voice')
  f.page.backButton.options.click_func()
  assert.deepEqual(JSON.parse(storage.get('claude-resume')), { screen: 'project', project: { id: '/work/crm', label: 'CRM' } })
  assert.equal(f.replacements.at(-1).url, 'page/index')
  f.page.onDestroy()

  let stopped = false
  const g = pageFixture({ kind: 'claude', storage: new Map([['voice-destination', JSON.stringify({
    target: 'claude', project: '/work/crm', label: 'CRM', mode: 'auto', jobId: 'job-1', aliasId: 'job-1', resumeJob: true
  })]]), reply: ({ method, params }) => {
    if (method === 'CLAUDE_JOB') return { ok: true, job: { id: 'job-1', state: stopped ? 'error' : 'running',
      error: stopped ? 'Остановлено с часов' : '', result: '', nextCursor: null } }
    if (method === 'CLAUDE_STOP') { stopped = true; assert.equal(params.id, 'job-1'); return { ok: true, job: { id: 'job-1', state: 'error', error: 'Остановлено с часов' } } }
    throw Error(method)
  } })
  g.page.build()
  await flush()
  assert.equal(g.page.statusWidget.options.text, 'Claude работает')
  assert.equal(g.page.primaryButton.options.text, 'Стоп')
  assert.equal(g.page.secondaryButton.options.text, 'История')
  g.page.primaryButton.options.click_func()
  g.page.primaryButton.options.click_func()
  await flush(); await flush()
  assert.equal(g.requests.filter(r => r.method === 'CLAUDE_STOP').length, 1)
  assert.equal(g.page.client.getState().state, 'cancelled')
  assert.equal(g.page.statusWidget.options.text, 'Остановлено')
  assert.equal(g.page.stageWidget.options.text, 'Остановка подтверждена')
  assertReaderText(g.page, 'Остановлено с часов')
  assert.equal(g.page.secondaryButton.options.text, 'История')
  assert.equal(g.page.backButton.options.visible, true)
  g.page.onDestroy()
})

test('Codex voice mirrors Claude with its own methods, keys and title', async () => {
  const storage = new Map([['voice-destination', JSON.stringify({
    target: 'codex', project: '/work/shop', label: 'Shop', mode: 'read-only', modeLabel: 'Только чтение', jobId: 'job-2', aliasId: 'job-2', resumeJob: true
  })]])
  let stopped = false
  const f = pageFixture({ kind: 'codex', storage, reply: ({ method, params }) => {
    if (method === 'CODEX_JOB') return { ok: true, job: { id: 'job-2', state: stopped ? 'error' : 'running', error: stopped ? 'Остановлено с часов' : '', result: '', nextCursor: null } }
    if (method === 'CODEX_STOP') { stopped = true; assert.equal(params.id, 'job-2'); return { ok: true, job: { id: 'job-2', state: 'error', error: 'Остановлено с часов' } } }
    throw Error(method)
  } })
  f.page.build()
  await flush()
  assert.equal(f.requests[0].method, 'CODEX_JOB')
  assert.equal(f.page.statusWidget.options.text, 'Codex работает')
  assert.equal(f.page.menuButton.options.text, 'Codex')
  assert.equal(JSON.parse(storage.get('codex-resume')).screen, 'voice')
  f.page.primaryButton.options.click_func(); f.page.primaryButton.options.click_func()
  await flush(); await flush()
  assert.equal(f.requests.filter(r => r.method === 'CODEX_STOP').length, 1)
  assert.equal(f.page.client.getState().state, 'cancelled')
  assert.equal(f.page.statusWidget.options.text, 'Остановлено')
  assert.equal(f.page.stageWidget.options.text, 'Остановка подтверждена')
  assertReaderText(f.page, 'Остановлено с часов')
  assert.equal(f.page.secondaryButton.options.text, 'История')
  f.page.backButton.options.click_func()
  assert.deepEqual(JSON.parse(storage.get('codex-resume')), { screen: 'project', project: { id: '/work/shop', label: 'Shop' } })
  f.page.onDestroy()
  const home = pageFixture({ kind: 'codex', storage: new Map([['voice-destination', JSON.stringify({ target: 'codex', project: '/work/shop', label: 'Shop', mode: 'read-only', modeLabel: 'Только чтение' })]]), reply: () => ({ ok: true, job: null }) })
  home.page.build(); await flush()
  assert.equal(home.page.statusWidget.options.text, 'Задача для Codex')
  assert.match(home.page.bodyWidget.options.text, /Режим: Только чтение/)
  home.page.onDestroy()
})

test('folder voice presents a general brief, then separates transcript review from plan approval', async () => {
  const storage = new Map([['voice-destination', JSON.stringify({
    target: 'folder', rootId: 'storage', label: 'Storage'
  })]])
  const f = pageFixture({ kind: 'orca', storage, reply: () => ({ ok: true, job: null }) })
  f.page.build()
  await flush()
  assert.equal(f.page.statusWidget.options.text, 'Новый проект')
  assert.match(f.page.bodyWidget.options.text, /Опишите проект/)
  assert.doesNotMatch(f.page.bodyWidget.options.text, /такси/i)

  f.page.render({ phase: 'review', text: 'Сделай учебный тренажёр' })
  assert.equal(f.page.primaryButton.options.text, 'Разобрать')
  assertReviewText(f.page, 'Сделай учебный тренажёр')

  Object.assign(f.page.destination, { approvalKind: 'plan', currentApprovalId: 'approval-1' })
  f.page.render({ phase: 'approval', id: 'plan-1', jobId: 'plan-1',
    approvalId: 'approval-1', approvalText: 'План с моделями Codex gpt-5 и Claude sonnet' })
  assert.equal(f.page.statusWidget.options.text, 'План проекта')
  assert.equal(f.page.primaryButton.options.text, 'Создать')
  assert.equal(f.page.secondaryButton.options.text, 'Изменить')
  assert.match(scrollText(f.page.readerScroll), /gpt-5.*sonnet/)
  f.page.onDestroy()
})

test('folder clarification starts a new recording with the current plan as parent', async () => {
  const storage = new Map([['voice-destination', JSON.stringify({
    target: 'folder', rootId: 'storage', operationId: 'plan-1'
  })]])
  const f = pageFixture({ kind: 'orca', storage, reply: ({ method }) => {
    if (method === 'ORCA_OPERATION') return { ok: true, operation: {
      id: 'plan-1', state: 'clarification', phase: 'planning', message: 'Кто будет пользоваться проектом?'
    } }
    throw Error(method)
  } })
  f.page.build()
  await flush()
  assert.equal(f.page.statusWidget.options.text, 'Нужно уточнение')
  assert.equal(f.page.primaryButton.options.text, 'Уточнить')
  assert.equal(f.page.secondaryButton.options.text, 'Orca')
  assert.equal(f.page.client.getState().approvalId, null)
  f.page.primaryButton.options.click_func()
  const saved = JSON.parse(storage.get('voice-destination'))
  assert.equal(saved.answering, true)
  assert.equal(saved.pendingSend, false)
  assert.equal(saved.parentPlanId, 'plan-1')
  assert.equal(f.replacements.at(-1).url, 'page/voice')
  f.page.onDestroy()
})

test('a Claude permission prompt is answered from the watch', async () => {
  let decided = null
  const f = pageFixture({ kind: 'claude', storage: new Map([['voice-destination', JSON.stringify({
    target: 'claude', project: '/work/crm', label: 'CRM', mode: 'auto', jobId: 'job-1', aliasId: 'job-1', resumeJob: true
  })]]), reply: ({ method, params }) => {
    if (method === 'CLAUDE_JOB') return { ok: true, job: decided
      ? { id: 'job-1', state: 'completed', result: 'Тесты прошли', nextCursor: null }
      : { id: 'job-1', state: 'approval', approval: { id: '0123456789abcdef', text: 'Bash:\nnpm test' }, nextCursor: null } }
    if (method === 'CLAUDE_APPROVE') { decided = params; return { ok: true, job: { id: 'job-1', state: 'running', result: '', nextCursor: null } } }
    throw Error(method)
  } })
  f.page.build()
  await flush()
  assert.equal(f.page.statusWidget.options.text, 'Нужно разрешение')
  assert.equal(f.page.stageWidget.options.text, 'Действие Claude на Mac')
  assertReaderText(f.page, 'Bash:\nnpm test')
  assert.equal(f.page.primaryButton.options.text, 'Разрешить')
  assert.equal(f.page.secondaryButton.options.text, 'Отказать')
  f.page.primaryButton.options.click_func()
  await flush(); await flush()
  assert.deepEqual(decided, { id: 'job-1', approvalId: '0123456789abcdef', allow: true })
  assert.equal(f.requests.filter(r => r.method === 'CLAUDE_APPROVE').length, 1)
  f.page.onDestroy()
})

test('a Claude question with options hands the choice to the menu page', async () => {
  const storage = new Map([['voice-destination', JSON.stringify({
    target: 'claude', project: '/work/crm', label: 'CRM', mode: 'auto', jobId: 'job-1', aliasId: 'job-1', resumeJob: true
  })]])
  const f = pageFixture({ kind: 'claude', storage, reply: ({ method }) => {
    if (method === 'CLAUDE_JOB') return { ok: true, job: { id: 'job-1', state: 'approval', nextCursor: null,
      approval: { id: '0123456789abcdef', text: 'Вопрос:\nКакой цвет?', question: 'Какой цвет?', options: ['Красный', 'Синий'], step: '1/2' } } }
    throw Error(method)
  } })
  f.page.build()
  await flush()
  assert.equal(f.page.statusWidget.options.text, 'Вопрос от Claude')
  assert.equal(f.page.stageWidget.options.text, 'Вопрос 1/2 · вариантов: 2')
  assertReaderText(f.page, 'Какой цвет?')
  assert.equal(f.page.primaryButton.options.text, 'Выбрать…')
  assert.equal(f.page.secondaryButton.options.text, 'Отказать')
  f.page.primaryButton.options.click_func()
  assert.deepEqual(JSON.parse(storage.get('claude-resume')), { screen: 'question', jobId: 'job-1', approvalId: '0123456789abcdef', question: 'Какой цвет?', options: ['Красный', 'Синий'] })
  assert.equal(f.replacements.at(-1).url, 'page/index')
  f.page.onDestroy()
})

test('folder trust uses explicit allow and decline controls', async () => {
  const storage = new Map([['voice-destination', JSON.stringify({
    target: 'folder', rootId: 'storage', operationId: 'plan-1'
  })]])
  const requests = []
  const f = pageFixture({ kind: 'orca', storage, reply: payload => {
    requests.push(payload)
    if (payload.method === 'ORCA_OPERATION') return { ok: true, operation: {
      id: 'plan-1', state: 'approval', phase: 'creating',
      approval: { id: 'trust-1', kind: 'folder_trust', text: 'Доверять папке /Volumes/Data/Atlas?' }
    } }
    if (payload.method === 'ORCA_PROJECT_DECIDE') return { ok: true, operation: {
      id: 'plan-1', state: 'cancelled', phase: 'creating', message: 'Доступ отклонён'
    } }
    throw Error(payload.method)
  } })
  f.page.build()
  await flush()
  assert.equal(f.page.statusWidget.options.text, 'Доступ к папке')
  assert.equal(f.page.primaryButton.options.text, 'Доверять')
  assert.equal(f.page.secondaryButton.options.text, 'Отказать')
  f.page.secondaryButton.options.click_func()
  await flush()
  assert.deepEqual(requests.find(item => item.method === 'ORCA_PROJECT_DECIDE').params, {
    id: 'plan-1', approvalId: 'trust-1', allow: false
  })
  assert.equal(f.page.statusWidget.options.text, 'Создание отменено')
  assert.notEqual(f.page.primaryButton.options.text, 'Открыть')
  f.page.onDestroy()
})

test('completed project changes into the exact Orca pair only after the owner opens it', async () => {
  const storage = new Map([['voice-destination', JSON.stringify({
    target: 'folder', rootId: 'storage', operationId: 'plan-1'
  })]])
  const f = pageFixture({ kind: 'orca', storage, reply: ({ method }) => {
    if (method === 'ORCA_OPERATION') return { ok: true, operation: {
      id: 'plan-1', state: 'completed', phase: 'creating', message: 'Проект создан',
      workspace: { path: '/Volumes/Data/Atlas', projectLabel: 'Atlas' },
      pair: { id: 'pair-8', projectLabel: 'Atlas', workerAgent: 'codex', reviewerAgent: 'claude',
        workerModel: 'gpt-5', reviewerModel: 'sonnet' },
      jobId: 'job-8'
    } }
    throw Error(method)
  } })
  f.page.build()
  await flush()
  assert.equal(JSON.parse(storage.get('voice-destination')).target, 'folder')
  assert.equal(f.page.primaryButton.options.text, 'Открыть')
  f.page.primaryButton.options.click_func()
  const saved = JSON.parse(storage.get('voice-destination'))
  assert.deepEqual(saved, {
    target: 'orca', pairId: 'pair-8', label: 'Atlas', workerAgent: 'codex', reviewerAgent: 'claude',
    workerModel: 'gpt-5', reviewerModel: 'sonnet', jobId: 'job-8', aliasId: 'job-8', resumeJob: true
  })
  assert.equal(f.replacements.at(-1).url, 'page/voice')
  f.page.onDestroy()
})

test('completed project without an initial task still opens its created pair', async () => {
  const storage = new Map([['voice-destination', JSON.stringify({
    target: 'folder', rootId: 'storage', operationId: 'plan-2'
  })]])
  const f = pageFixture({ kind: 'orca', storage, reply: () => ({ ok: true, operation: {
    id: 'plan-2', state: 'completed', phase: 'creating', message: 'Связка открыта',
    pair: { id: 'pair-9', projectLabel: 'Без задачи', workerAgent: 'claude', reviewerAgent: 'codex' }
  } }) })
  f.page.build()
  await flush()
  f.page.primaryButton.options.click_func()
  assert.equal(JSON.parse(storage.get('voice-destination')).pairId, 'pair-9')
  assert.deepEqual(JSON.parse(storage.get('orca-resume')), {
    screen: 'pair', pair: { id: 'pair-9', projectLabel: 'Без задачи', workerAgent: 'claude', reviewerAgent: 'codex' }
  })
  assert.equal(f.replacements.at(-1).url, 'page/index')
  f.page.onDestroy()
})

test('Musafir emits three stopped pulses once per approval and rearms for the next approval', async () => {
  const storage = new Map()
  const id = '1790459890499-1'
  let approvalId = 'approval-1'
  const current = () => ({ id, state: 'approval', approval: { id: approvalId, text: 'Нужно решение' } })
  const reply = payload => payload.method === 'STATUS'
    ? { ok: true, agent: 'Мусафир' }
    : payload.method === 'LATEST_JOB' ? { ok: true, job: current() } : { ok: true, ...current() }
  const first = pageFixture({ storage, reply })
  first.page.build()
  await flush()
  assert.deepEqual(first.vibrationCalls.filter(c => c.name === 'start'), [{ name: 'start', mode: 'short-strong' }])
  first.page.client.refresh()
  await flush()
  assert.equal(first.vibrationCalls.filter(call => call.name === 'start').length, 1)
  first.tick(80); first.tick(200); first.tick(80); first.tick(200); first.tick(80)
  assert.equal(first.vibrationCalls.filter(call => call.name === 'start').length, 3)
  assert.equal(first.vibrationCalls.at(-1).name, 'stop')
  assert.equal([...first.timers.values()].some(t => [80, 200].includes(t.delay)), false)
  assert.equal([...first.timers.values()].some(timer => timer.delay === 30000), false)
  first.page.onDestroy()
  assert.equal(first.vibrationCalls.at(-1).name, 'stop')
  assert.equal(first.timers.size, 0)

  const reopened = pageFixture({ storage, reply })
  reopened.page.build()
  await flush()
  assert.equal(reopened.vibrationCalls.length, 0, 'same approval stays acknowledged across page recreation')
  approvalId = 'approval-2'
  reopened.page.client.refresh()
  await flush()
  assert.deepEqual(reopened.vibrationCalls.filter(c => c.name === 'start'), [{ name: 'start', mode: 'short-strong' }])
  reopened.page.onDestroy()
  assert.equal(reopened.timers.size, 0)
})

test('approval tap stops immediately; stale timers cannot restart; next request pulses again', async () => {
  const f = pageFixture({ reply: payload => payload.method === 'STATUS'
    ? { ok: true, agent: 'Мусафир' }
    : { ok: true, job: { id: 'job-1', state: 'approval',
      approval: { id: 'approval-1', text: 'Первое решение' } } } })
  f.page.build()
  await flush()
  const stale = [...f.timers.values()].find(t => t.delay === 80).callback
  let approved = false
  f.page.client.approve = allow => {
    assert.equal(f.vibrationCalls.at(-1).name, 'stop', 'stop precedes network request')
    approved = allow
  }
  f.page.primaryAction()
  assert.equal(approved, true)
  assert.equal([...f.timers.values()].some(t => [80, 200].includes(t.delay)), false)
  stale()
  assert.equal([...f.timers.values()].some(t => [80, 200].includes(t.delay)), false)
  f.page.alerts.observe({ phase: 'approval', jobId: 'job-1', approvalId: 'approval-1' })
  assert.equal(f.vibrationCalls.filter(c => c.name === 'start').length, 1)
  f.page.alerts.observe({ phase: 'approval', jobId: 'job-1', approvalId: 'approval-2' })
  f.tick(80); f.tick(200); f.tick(80); f.tick(200); f.tick(80)
  assert.equal(f.vibrationCalls.filter(c => c.name === 'start').length, 4)
  assert.equal(f.vibrationCalls.at(-1).name, 'stop')
  f.page.onDestroy()
  assert.equal(f.timers.size, 0)
})

test('long approval remains complete and polling preserves the reader page', async () => {
  const text = ('Точная команда для проверки, без исполнения. ').repeat(72)
  const job = { id: '123-1', state: 'approval', approval: { id: 'approval-1', text } }
  const f = pageFixture({ reply: payload => payload.method === 'STATUS'
    ? { ok: true, agent: 'Мусафир' }
    : payload.method === 'LATEST_JOB' ? { ok: true, job } : { ok: true, ...job } })
  f.page.build()
  await flush()
  assert.ok(text.length > 3066)
  assertReaderText(f.page, text)
  assert.equal(f.page.previousButton.options.visible, false)
  assert.equal(f.page.nextButton.options.visible, false)
  const updates = f.page.readerScroll.updates.filter(update => update.key === 'update-data').length
  f.tick(3000)
  await flush()
  assertReaderText(f.page, text)
  assert.equal(f.page.readerScroll.updates.filter(update => update.key === 'update-data').length, updates,
    'unchanged approval must preserve the native reader position')
  assert.equal(f.requests.some(request => request.params && request.params.cursor != null), false)
  assert.equal(f.vibrationCalls.filter(x => x.name === 'start').length, 1)
  f.page.onDestroy()
})

test('Orca question uses the approval alert key and is deduplicated after wake', async () => {
  const storage = new Map([['voice-destination', JSON.stringify({
    target: 'orca', pairId: 'pair-1', label: 'Проект'
  })]])
  const reply = () => ({ ok: true, job: {
    id: 'orca-job-1', state: 'question', questionId: 'question-1', question: 'Как продолжить?'
  } })
  const first = pageFixture({ kind: 'orca', storage, reply })
  first.page.build()
  await flush()
  assert.equal(first.page.client.getState().phase, 'approval')
  assert.deepEqual(first.vibrationCalls.filter(c => c.name === 'start'), [{ name: 'start', mode: 'short-strong' }])
  first.page.onDestroy()

  const reopened = pageFixture({ kind: 'orca', storage, reply })
  reopened.page.build()
  await flush()
  assert.equal(reopened.page.client.getState().approvalId, 'question-1')
  assert.equal(reopened.vibrationCalls.length, 0)
  reopened.page.onDestroy()
})

test('terminal result and terminal error are distinct alerts with bounded saved ids', async () => {
  const storage = new Map()
  const id = '1790459890499-1'
  let state = { id, state: 'completed', result: 'Готово' }
  const reply = payload => payload.method === 'STATUS'
    ? { ok: true, agent: 'Мусафир' }
    : { ok: true, job: state }
  const result = pageFixture({ storage, reply })
  result.page.build()
  await flush()
  assert.deepEqual(result.vibrationCalls.filter(c => c.name === 'start'), [{ name: 'start', mode: 'short-strong' }])
  result.tick(80)
  assert.equal([...result.timers.values()].some(t => t.delay === 200), false, 'a finished answer pulses once')
  assert.equal(result.vibrationCalls.filter(c => c.name === 'start').length, 1)
  result.page.onDestroy()

  state = { id, state: 'error', error: 'Не вышло' }
  const failed = pageFixture({ storage, reply })
  failed.page.build()
  await flush()
  assert.deepEqual(failed.vibrationCalls.filter(c => c.name === 'start'), [{ name: 'start', mode: 'short-strong' }])
  failed.tick(80); failed.tick(200); failed.tick(80)
  assert.equal([...failed.timers.values()].some(t => t.delay === 200), false, 'an error pulses twice')
  assert.equal(failed.vibrationCalls.filter(c => c.name === 'start').length, 2)
  failed.page.alerts.observe({ phase: 'error', state: 'running', errorKind: 'job', jobId: 'poll-failed' })
  assert.equal(failed.vibrationCalls.filter(c => c.name === 'start').length, 2, 'a failed status poll is not a terminal alert')
  const saved = storage.get('watch-alert-ids:musafir')
  failed.page.alerts.observe({ phase: 'approval', jobId: 'unsafe id', approvalId: 'question-1' })
  assert.equal(storage.get('watch-alert-ids:musafir'), saved, 'unsafe event ids are not acknowledged')
  for (let i = 0; i < 30; i++) {
    failed.page.alerts.observe({ phase: 'result', jobId: `job-${i}` })
  }
  assert.equal(JSON.parse(storage.get('watch-alert-ids:musafir')).length, 24)
  failed.page.onDestroy()
})

test('unsupported vibrator is harmless and destroy clears its approval reminder', async () => {
  const storage = new Map()
  const f = pageFixture({ storage, vibratorError: true, reply: payload => payload.method === 'STATUS'
    ? { ok: true, agent: 'Мусафир' }
    : { ok: true, job: { id: 'job-1', state: 'approval',
      approval: { id: 'approval-1', text: 'Нужно решение' } } }
  })
  assert.doesNotThrow(() => f.page.build())
  await flush()
  assert.equal(f.vibrationCalls.length, 0)
  assert.equal(JSON.parse(storage.get('watch-alert-ids:musafir')).length, 1)
  assert.equal([...f.timers.values()].filter(timer => [80, 200, 30000].includes(timer.delay)).length, 0)
  assert.doesNotThrow(() => f.page.onDestroy())
  assert.equal(f.timers.size, 0)
})

test('long audio limit is 8 MiB and device code has no whole-file reader', () => {
  assert.equal(MAX_AUDIO_BYTES, 8 * 1024 * 1024)
  assert.equal(source.includes('readFileSync'), false)
})

test('unavailable recorder reports an actionable error after pressing record', async () => {
  const f = pageFixture()
  f.page.build()
  await flush()
  assert.doesNotThrow(() => f.page.startRecording())
  assert.equal(f.page.client.getState().phase, 'error')
  assert.match(scrollText(f.page.readerScroll), /микрофон|запись/)
  assert.equal(f.page.primaryButton.options.visible, true)
  f.page.onDestroy()
})

test('missing text layout API cannot prevent requests or hide recovery buttons', async () => {
  const f = pageFixture({ layout: () => { throw Error('layout unsupported') } })
  f.page.build()
  await flush()
  assert.deepEqual(f.requests.map(x => x.method), ['STATUS', 'LATEST_JOB'])
  assert.equal(f.page.client.getState().phase, 'ready')
  assert.equal(f.page.primaryButton.options.visible, true)
  assert.match(f.page.bodyWidget.options.text, /Голос|клавиатура/)
  f.page.onDestroy()
})

test('layout replies without result field still produce a whole readable page', async () => {
  const f = pageFixture()
  f.page.build()
  await flush()
  assert.ok(f.page.bodyWidget.options.text.length > 30)
  f.page.onDestroy()
})

function recordingFixture({ sizes = [1024], start, stop, width, height, fd = 7, read, open,
  storage = new Map(), compact = false } = {}) {
  let starts = 0
  let stops = 0
  let file
  let reads = 0
  const readLengths = []
  let opens = 0
  let nativeHandle
  let closes = 0
  let statCalls = 0
  let receivedBytes = 0
  const removed = []
  const bytes = Uint8Array.from({length: sizes[sizes.length - 1]}, (_, i) => i % 251)
  const f = pageFixture({ width, height, storage,
    media: () => ({
      setFormat(type, options) { assert.equal(type, 1); file = options.target_file },
      start() { starts++; return start && start() },
      stop() { stops++; return stop && stop() }
    }),
    files: {
      statSync({ path }) {
        assert.equal('data://' + path, file)
        return { size: sizes[Math.min(statCalls++, sizes.length - 1)] }
      },
      openSync({ path, flag }) {
        assert.equal('data://' + path, file)
        assert.equal(flag, 0)
        opens++
        nativeHandle = open ? open() : fd
        return nativeHandle
      },
      readSync(options) {
        assert.equal(options.fd, nativeHandle, 'readSync must receive the original native handle')
        reads++
        readLengths.push(options.options.length)
        if (read) return read(options, bytes)
        const target = new Uint8Array(options.buffer)
        const { offset, length, position } = options.options
        target.set(bytes.subarray(position, position + length), offset)
        return length
      },
      closeSync({ fd: closedFd }) { assert.equal(closedFd, nativeHandle, 'closeSync must receive the original native handle'); closes++ },
      rmSync({ path }) { removed.push(path) }
    },
    reply: payload => {
      const { method, params } = payload
      if (method === 'STATUS') return { ok: true, agent: 'Мусафир' }
      if (method === 'LATEST_JOB') return { ok: true, job: null }
      if (method === 'AUDIO_BEGIN') {
        return { ok: true, id: params.id, receivedBytes, totalBytes: params.totalBytes,
          ...(compact ? { chunkBytes: 6144, encoding: 'base64' } : {}) }
      }
      if (method === 'AUDIO_PART') {
        const decoded = Buffer.from(params.data, 'base64')
        assert.deepEqual([...decoded], [...bytes.slice(params.offset, params.offset + decoded.length)])
        receivedBytes = params.offset + decoded.length
        return { ok: true, id: params.id, receivedBytes, totalBytes: bytes.length }
      }
      if (method === 'AUDIO_CHUNK') {
        receivedBytes = params.index * 1024 + params.data.length
        return { ok: true, id: params.id, receivedBytes, totalBytes: bytes.length }
      }
      if (method === 'AUDIO_STATUS') return { ok: true, id: params.id, state: 'ready', text: 'Проверка' }
      if (method === 'AUDIO_FINISH') return { ok: true, id: params.id, state: 'transcribing' }
      return { ok: true, id: params.id }
    }
  })
  return { ...f, starts: () => starts, stops: () => stops, reads: () => reads,
    readLengths, opens: () => opens, closes: () => closes, removed }
}

test('baseline Recorder without event APIs records, flushes, uploads and reaches review', async () => {
  const f = recordingFixture({ sizes: [0, 512, 1024, 1024, 1024] })
  f.page.build()
  await flush()
  f.page.primaryAction()
  assert.equal(f.page.client.getState().phase, 'recording')
  assert.equal(f.starts(), 1)
  f.page.primaryAction()
  f.page.stopRecording(false)
  assert.equal(f.stops(), 1)
  for (let i = 0; i < 4; i++) f.tick(250)
  assert.equal(f.requests.filter(x => x.method === 'AUDIO_BEGIN').length, 0)
  f.tick(250)
  await flush()
  assert.equal(f.reads(), 1)
  assert.equal(f.requests.filter(x => x.method === 'AUDIO_BEGIN').length, 1)
  assert.equal(f.page.client.getState().phase, 'transcribing')
  f.tick(2000)
  await flush()
  assert.equal(f.page.client.getState().phase, 'review')
  assertReviewText(f.page, 'Проверка')
  assert.equal(f.requests.some(x => x.method === 'SEND_TEXT'), false)
  f.page.onDestroy()
  assert.equal(f.timers.size, 0)
})

test('cancel stops once, deletes the recording and never uploads', async () => {
  const f = recordingFixture()
  f.page.build()
  await flush()
  f.page.startRecording()
  f.page.cancelRecording()
  f.page.cancelRecording()
  await flush()
  assert.equal(f.stops(), 1)
  assert.equal(f.page.client.getState().phase, 'ready')
  assert.equal(f.requests.some(x => ['AUDIO_BEGIN', 'AUDIO_PART', 'AUDIO_CHUNK',
    'AUDIO_FINISH', 'AUDIO_STATUS'].includes(x.method)), false)
  assert.equal(f.requests.filter(x => x.method === 'AUDIO_CANCEL').length, 1)
  assert.ok(f.removed.length >= 2)
  f.page.onDestroy()
})

test('the five minute limit stops recording without native events', async () => {
  const f = recordingFixture()
  f.page.build()
  await flush()
  f.page.startRecording()
  f.tick(300000)
  assert.equal(f.stops(), 1)
  assert.equal(f.page.client.getState().phase, 'stopping')
  f.page.onDestroy()
  assert.equal(f.timers.size, 0)
})

test('an empty file reaches a bounded error and reports its cause privately', async () => {
  const f = recordingFixture({ sizes: [0] })
  f.page.build()
  await flush()
  f.page.startRecording()
  f.page.stopRecording(false)
  for (let i = 0; i < 12; i++) f.tick(250)
  await flush()
  assert.equal(f.page.client.getState().phase, 'error')
  const diagnosis = f.requests.find(x => x.method === 'DIAGNOSTIC')
  assert.equal(diagnosis.params.stage, 'recorder_file')
  assert.equal(diagnosis.params.detail, 'EMPTY_RECORDING')
  assert.equal(f.page.primaryButton.options.text, 'Повторить')
  assert.equal(f.requests.some(x => x.method === 'AUDIO_BEGIN'), false)
  f.page.onDestroy()
  assert.equal(f.timers.size, 0)
})

test('native start failure identifies the failing stage without guessing a busy microphone', async () => {
  const f = recordingFixture({ start: () => false })
  f.page.build()
  await flush()
  f.page.startRecording()
  assert.equal(f.page.client.getState().phase, 'error')
  assert.match(f.page.client.getState().error, /Этап: микрофон/)
  assert.doesNotMatch(f.page.client.getState().error, /другие|Закройте/)
  assert.equal(f.requests.find(x => x.method === 'DIAGNOSTIC').params.detail, 'START_FAILED')
  f.page.secondaryAction()
  assert.equal(f.page.client.getState().phase, 'ready')
  f.page.onDestroy()
})

test('bounded file reads preserve exact chunk order and close the descriptor after acceptance', async () => {
  const f = recordingFixture({ sizes: [2057] })
  f.page.build()
  await flush()
  f.page.startRecording()
  f.page.stopRecording(false)
  for (let i = 0; i < 3; i++) f.tick(250)
  await flush()
  const chunks = f.requests.filter(x => x.method === 'AUDIO_CHUNK')
  assert.deepEqual(chunks.map(x => x.params.data.length), [1024, 1024, 9])
  assert.deepEqual(chunks.flatMap(x => [...x.params.data]),
    Array.from({length: 2057}, (_, i) => i % 251))
  assert.equal(f.reads(), 3)
  assert.deepEqual(f.readLengths, [1024, 1024, 9])
  assert.equal(f.opens(), 1)
  assert.equal(f.closes(), 1)
  assert.equal(f.page.audioFd, null)
  f.page.onDestroy()
})

test('failed or incomplete bounded reads stop the upload and retain the file for retry', async () => {
  for (const read of [() => undefined, () => 0, ({ options }) => options.length + 1]) {
    const f = recordingFixture({ read })
    f.page.build()
    await flush()
    f.page.startRecording()
    f.page.stopRecording(false)
    for (let i = 0; i < 3; i++) f.tick(250)
    await flush()
    assert.equal(f.page.client.getState().phase, 'error')
    assert.equal(f.page.client.getState().retryMethod, 'AUDIO_UPLOAD')
    assert.equal(f.requests.some(x => x.method === 'AUDIO_BEGIN'), true)
    assert.equal(f.page.audioFd, 7)
    assert.equal(f.removed.filter(name => name === f.page.pendingAudio.fileName).length, 1)
    f.page.onDestroy()
    assert.equal(f.closes(), 1)
  }
})

test('numeric descriptor zero is valid and short reads are completed without whole-file allocation', async () => {
  const f = recordingFixture({ sizes: [7], fd: 0, read(options, bytes) {
    const target = new Uint8Array(options.buffer)
    const { offset, length, position } = options.options
    const count = Math.min(2, length)
    target.set(bytes.subarray(position, position + count), offset)
    return count
  } })
  f.page.build()
  await flush()
  f.page.startRecording()
  f.page.stopRecording(false)
  for (let i = 0; i < 3; i++) f.tick(250)
  await flush()
  assert.deepEqual([...f.requests.find(x => x.method === 'AUDIO_CHUNK').params.data], [0, 1, 2, 3, 4, 5, 6])
  assert.equal(f.reads(), 4)
  assert.equal(f.closes(), 1)
  f.page.onDestroy()
})

test('native handles including opaque objects are passed unchanged through upload and close', async () => {
  const opaque = Object.freeze({ toString() { return '71' }, valueOf() { throw Error('Native handle must not be converted') } })
  for (const fd of [opaque, '71', BigInt(71), Object(71)]) {
    const size = fd === opaque ? 957807 : 2051
    const f = recordingFixture({ sizes: [size], fd })
    f.page.build()
    await flush()
    f.page.startRecording()
    f.page.stopRecording(false)
    for (let i = 0; i < 3; i++) f.tick(250)
    await flush()
    assert.equal(f.page.client.getState().phase, 'transcribing', String(fd))
    const chunks = f.requests.filter(x => x.method === 'AUDIO_CHUNK')
    const received = chunks.flatMap(x => [...x.params.data])
    assert.deepEqual(received, Array.from({ length: size }, (_, i) => i % 251))
    assert.ok(f.readLengths.every(length => length <= 1024))
    assert.equal(f.closes(), 1)
    f.page.onDestroy()
  }
})

test('invalid native handles preserve recording for retry and never upload', async () => {
  for (const fd of [null, false, true, '', '-1', -1, 1.5, NaN, Infinity, {}, '71x']) {
    const f = recordingFixture({ fd })
    f.page.build()
    await flush()
    f.page.startRecording()
    f.page.stopRecording(false)
    for (let i = 0; i < 3; i++) f.tick(250)
    await flush()
    assert.equal(f.page.client.getState().phase, 'error')
    assert.equal(f.requests.some(x => x.method === 'AUDIO_BEGIN'), false)
    assert.ok(f.page.pendingAudio)
    assert.equal(f.removed.length, 1, 'only the pre-recording cleanup ran')
    f.page.onDestroy()
  }
})

test('Repeat reopens the saved file using its original id after a failed open', async () => {
  const opaque = { toString() { return '71' }, valueOf() { throw Error('opaque native handle') } }
  let attempts = 0
  const f = recordingFixture({ sizes: [2051], open: () => ++attempts === 1 ? null : opaque })
  f.page.build()
  await flush()
  f.page.startRecording()
  f.page.stopRecording(false)
  for (let i = 0; i < 3; i++) f.tick(250)
  await flush()
  assert.equal(f.page.client.getState().phase, 'error')
  const savedId = f.page.pendingAudio.id
  f.page.primaryAction()
  await flush()
  assert.equal(f.page.client.getState().phase, 'transcribing')
  assert.equal(f.starts(), 1, 'do not record again')
  assert.equal(f.opens(), 2)
  assert.equal(f.closes(), 1)
  assert.equal(f.requests.filter(r => r.method === 'AUDIO_BEGIN').length, 1)
  assert.equal(f.requests.find(r => r.method === 'AUDIO_BEGIN').params.id, savedId)
  f.tick(2000)
  await flush()
  assert.equal(f.page.client.getState().phase, 'review')
  assertReviewText(f.page, 'Проверка')
  f.page.onDestroy()
})

test('accepted transcription id survives page destruction and resumes without reuploading audio', async () => {
  const storage = new Map()
  const first = recordingFixture({ storage })
  first.page.build()
  await flush()
  first.page.startRecording()
  first.page.stopRecording(false)
  for (let i = 0; i < 3; i++) first.tick(250)
  await flush()
  const id = first.page.client.getState().id
  assert.equal(first.page.client.getState().phase, 'transcribing')
  assert.equal(JSON.parse(storage.get('pending-audio')).accepted, true)
  first.page.onDestroy()

  const reopened = recordingFixture({ storage })
  reopened.page.build()
  await flush()
  reopened.tick(0)
  await flush()
  assert.equal(reopened.page.client.getState().phase, 'review')
  assert.equal(reopened.page.client.getState().id, id)
  assert.equal(reopened.requests.some(x => x.method === 'AUDIO_BEGIN'), false)
  assert.equal(JSON.parse(storage.get('pending-audio')).accepted, true)
  reopened.page.onDestroy()
})

test('sleep on transcript restores draft instead of an older result, without sending', async () => {
  const storage = new Map()
  const first = recordingFixture({ storage })
  first.page.build()
  await flush()
  first.page.startRecording()
  first.page.stopRecording(false)
  for (let i = 0; i < 3; i++) first.tick(250)
  await flush()
  first.tick(2000)
  await flush()
  assert.equal(first.page.client.getState().phase, 'review')
  const id = first.page.client.getState().id
  first.page.onDestroy()
  let latest = { id: '99999-1', state: 'completed', result: 'Старый ответ' }
  const reply = payload => {
    if (payload.method === 'STATUS') return { ok: true, agent: 'Мусафир' }
    if (payload.method === 'LATEST_JOB') return { ok: true, job: latest }
    if (payload.method === 'AUDIO_STATUS') return { ok: true, id, state: 'ready', text: 'Проверка' }
    throw Error(`Unexpected mutation: ${payload.method}`)
  }
  const reopened = pageFixture({ storage, reply })
  reopened.page.build()
  await flush()
  assert.equal(reopened.page.client.getState().phase, 'review')
  assertReviewText(reopened.page, 'Проверка')
  assert.equal(reopened.requests.some(x => ['SEND_TEXT', 'AUDIO_BEGIN'].includes(x.method)), false)
  reopened.page.onDestroy()
  latest = { id, state: 'completed', result: 'Новый ответ' }
  const accepted = pageFixture({ storage, reply })
  accepted.page.build()
  await flush()
  assert.equal(accepted.page.client.getState().phase, 'review')
  assertReviewText(accepted.page, 'Проверка')
  assert.equal(JSON.parse(storage.get('pending-audio')).accepted, true)
  assert.equal([...accepted.timers.values()].some(t => t.delay === 0), false)
  accepted.page.onDestroy()
})

test('Orca voice page remembers its destination but explicit menu does not bounce back', async () => {
  const context = { target: 'orca', pairId: 'pair-1', label: 'Работа', workerAgent: 'claude', reviewerAgent: 'claude' }
  const storage = new Map([['voice-destination', JSON.stringify(context)]])
  const f = pageFixture({ kind: 'orca', storage, reply: () => ({ ok: true, job: null }) })
  f.page.build()
  await flush()
  assert.equal(JSON.parse(storage.get('orca-resume')).screen, 'voice')
  f.page.openOrca()
  assert.equal(JSON.parse(storage.get('orca-resume')).screen, 'pair')
  assert.equal(JSON.parse(storage.get('orca-resume')).pair.id, 'pair-1')
  assert.equal(f.replacements[0].url, 'page/index')
  f.page.onDestroy()
})

test('microphone pulse starts only after native start and timer stops with the microphone', async () => {
  let f
  f = recordingFixture({ start() {
    assert.equal(f.page.recordDot.options.visible, false)
    assert.equal(f.page.client.getState().phase, 'ready')
  } })
  f.page.build()
  await flush()
  f.page.startRecording()
  assert.equal(f.page.recordDot.options.visible, true)
  assert.equal(f.page.metricWidget.options.text, '00:00 / 05:00')
  assert.match(f.page.bodyWidget.options.text, /Микрофон включён/)
  const firstColor = f.page.recordDot.options.color
  f.tick(300)
  f.tick(300)
  assert.notEqual(f.page.recordDot.options.color, firstColor)
  f.advance(6300)
  f.tick(300)
  assert.equal(f.page.metricWidget.options.text, '00:07 / 05:00')
  assert.match(f.page.bodyWidget.options.text, /Осталось 04:53/)
  f.page.stopRecording(false)
  assert.equal(f.page.recordDot.options.visible, false)
  assert.match(f.page.stageWidget.options.text, /Микрофон выключен/)
  f.page.onDestroy()
  assert.equal(f.timers.size, 0)
})

test('a rejected native microphone start never leaves the active mic indicator visible', async () => {
  const f = recordingFixture({ start: () => false })
  f.page.build()
  await flush()
  f.page.startRecording()
  assert.equal(f.page.recordDot.options.visible, false)
  assert.equal(f.page.metricWidget.options.visible, false)
  assert.equal([...f.timers.values()].some(t => t.delay === 300), false)
  f.page.onDestroy()
})

test('upload progress comes from acknowledged bytes; transcription animates without invented percentages', async () => {
  const f = pageFixture()
  f.page.build()
  await flush()
  f.page.render({ phase: 'uploading', sentBytes: 620, totalBytes: 1000 })
  assert.equal(f.page.metricWidget.options.text, '62%')
  assert.equal(f.page.progressFill.options.w, Math.round(f.page.progressTrack.options.w * 0.62))
  f.page.render({ phase: 'transcribing' })
  const x = f.page.progressFill.options.x
  f.tick(300)
  assert.notEqual(f.page.progressFill.options.x, x)
  f.advance(4000)
  f.page.render({ phase: 'transcribing' })
  assert.equal(f.page.metricWidget.options.text, '00:04')
  assert.match(f.page.stageWidget.options.text, /Голос в текст/)
  assert.doesNotMatch(f.page.metricWidget.options.text, /%/)
  f.page.render({ phase: 'review', text: 'Проверка' })
  assert.equal(f.page.progressTrack.options.visible, false)
  assert.equal([...f.timers.values()].some(t => t.delay === 300), false)
  f.page.onDestroy()
})

test('native reader scroll preserves every character and polling does not reset unchanged text', async () => {
  const f = pageFixture({ layout: text => ({ height: Math.ceil(text.length / 24) * 25 }) })
  f.page.build()
  await flush()
  const text = 'Ответ Мусафира. Сохраняем слова целиком, знаки и пробелы.\n'.repeat(10)
  f.page.render({ phase: 'result', result: text })
  assertReaderText(f.page, text)
  assert.ok(f.page.readerScroll.options.data_count > 1)
  assert.equal(f.page.previousButton.options.visible, false)
  assert.equal(f.page.nextButton.options.visible, false)
  const updates = f.page.readerScroll.updates.filter(update => update.key === 'update-data').length
  f.page.render({ phase: 'result', result: text })
  assert.equal(f.page.readerScroll.updates.filter(update => update.key === 'update-data').length, updates)
  f.page.onDestroy()
})

test('all states have nonoverlapping widgets within native and compatibility windows', async () => {
  for (const [width, height] of [[390, 450], [432, 514], [390, 400]]) {
    const f = pageFixture({ width, height })
    f.page.build()
    await flush()
    for (const phase of ['connecting', 'refreshing', 'ready', 'recording', 'stopping', 'canceling', 'uploading', 'transcribing',
      'review', 'saving-text', 'sending', 'job', 'approval', 'result', 'unknown', 'error']) {
      f.page.localRecordingError = phase === 'error'
      f.page.render({ phase, text: 'Команда', result: 'Длинный ответ. '.repeat(35), error: 'Ошибка микрофона',
        approvalId: '1', approvalText: 'Разрешить действие?' })
      const visible = f.widgets.filter(w => w.kind !== 1 && w.options.visible).map(w => w.options)
      for (let i = 0; i < visible.length; i++) {
        const a = visible[i]
        assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.w <= width && a.y + a.h <= height,
          `${phase}: ${a.text} must fit the ${width}x${height} window`)
        for (const b of visible.slice(i + 1)) {
          const overlaps = a.x < b.x + b.w && a.x + a.w > b.x &&
            a.y < b.y + b.h && a.y + a.h > b.y
          assert.equal(overlaps, false, `${phase}: ${a.text} overlaps ${b.text}`)
        }
      }
    }
    assert.equal(f.widgets.some(w => /0\.3\.|Новая запись/.test(w.options.text)), false)
    f.page.onDestroy()
  }
})

test('sleep after an approval recovers the completed answer without resending or acknowledging it', async () => {
  const storage = new Map()
  const id = '1790459890499-1'
  let job = { id, state: 'approval', approval: { id: 'approval-1', text: 'Проверить прогноз' } }
  let accepted
  const reply = payload => {
    if (payload.method === 'STATUS') return { ok: true, agent: 'Мусафир' }
    if (payload.method === 'LATEST_JOB') return { ok: true, job }
    if (payload.method === 'JOB_APPROVE') {
      assert.equal(payload.params.approvalId, 'approval-1')
      job = { id, state: 'running' }
      return new Promise(resolve => { accepted = resolve })
    }
    throw Error(`unexpected ${payload.method}`)
  }
  const first = pageFixture({ storage, reply })
  first.page.build()
  await flush()
  first.page.primaryAction()
  assert.equal(first.page.client.getState().phase, 'sending')
  assert.equal(first.page.statusWidget.options.text, 'Передаю решение')
  first.page.onDestroy()
  assert.equal(first.timers.size, 0)
  assert.equal(first.displayCalls.filter(c => c.name === 'setWakeUpRelaunch').at(-1).relaunch, true)
  assert.equal(storage.get('acknowledged-result-id'), undefined)

  job = { id, state: 'completed', result: 'Сохранённый ответ после разрешения' }
  accepted({ ok: true, id, state: 'running' })
  await flush()
  const reopened = pageFixture({ storage, reply })
  reopened.page.build()
  await flush()
  assert.equal(reopened.page.client.getState().phase, 'result')
  assertReaderText(reopened.page, job.result)
  assert.deepEqual(reopened.requests.map(r => r.method), ['STATUS', 'LATEST_JOB'])
  assert.equal(first.requests.filter(r => r.method === 'JOB_APPROVE').length, 1)
  assert.equal(storage.get('acknowledged-result-id'), undefined)
  reopened.page.onDestroy()

  const readingAgain = pageFixture({ storage, reply })
  readingAgain.page.build()
  await flush()
  assert.equal(readingAgain.page.client.getState().phase, 'result')
  readingAgain.page.client.home() // Explicit Home acknowledges this result.
  assert.equal(storage.get('acknowledged-result-id'), id)
  assert.equal(readingAgain.displayCalls.filter(c => c.name === 'setWakeUpRelaunch').at(-1).relaunch, true)
  readingAgain.page.onDestroy()
  const afterHome = pageFixture({ storage, reply })
  afterHome.page.build()
  await flush()
  assert.equal(afterHome.page.client.getState().phase, 'ready')
  assert.equal(afterHome.page.secondaryButton.options.text, 'Написать')
  assert.equal(afterHome.page.readerScroll.options.visible, false)
  afterHome.page.onDestroy()
})

test('display overrides are bounded and polling does not continually extend the light', async () => {
  const f = pageFixture()
  f.page.build()
  await flush()
  f.page.render({ phase: 'recording' })
  assert.equal(f.displayCalls.filter(c => c.name === 'pauseDropWristScreenOff').at(-1).duration, 60000)
  f.page.render({ phase: 'job', state: 'running' })
  assert.equal(f.displayCalls.at(-1).name, 'resetDropWristScreenOff')
  const count = f.displayCalls.length
  for (let i = 0; i < 20; i++) {
    f.advance(3000)
    f.page.render({ phase: 'job', state: 'running' })
  }
  assert.equal(f.displayCalls.length, count)
  assert.ok(f.displayCalls.filter(c => c.name === 'setPageBrightTime').every(c => c.brightTime === 60000))
  f.page.onDestroy()
  assert.equal(f.displayCalls.at(-2).name, 'resetPageBrightTime')
  assert.equal(f.displayCalls.at(-1).name, 'resetDropWristScreenOff')
  assert.equal(f.timers.size, 0)
})

test('recording renews the finite display override before it expires', async () => {
  const f = recordingFixture()
  f.page.build()
  await flush()
  f.page.startRecording()
  const brightCount = f.displayCalls.filter(c => c.name === 'setPageBrightTime').length
  const wristCount = f.displayCalls.filter(c => c.name === 'pauseDropWristScreenOff').length
  f.advance(45000)
  f.tick(300)
  assert.equal(f.displayCalls.filter(c => c.name === 'setPageBrightTime').length, brightCount + 1)
  assert.equal(f.displayCalls.filter(c => c.name === 'pauseDropWristScreenOff').length, wristCount + 1)
  f.page.cancelRecording()
  f.page.onDestroy()
})

test('native display and storage failures still allow the saved answer to open', async () => {
  const f = pageFixture({ storageError: true, displayError: true,
    reply: payload => payload.method === 'STATUS' ? { ok: true, agent: 'Мусафир' }
      : { ok: true, job: { id: '1790459890499-1', state: 'completed', result: 'Ответ сохранён' } }
  })
  assert.doesNotThrow(() => f.page.build())
  await flush()
  assert.equal(f.page.client.getState().phase, 'result')
  assertReaderText(f.page, 'Ответ сохранён')
  assert.doesNotThrow(() => f.page.secondaryAction())
  assert.doesNotThrow(() => f.page.onDestroy())
})

test('manifest permits the acknowledgement storage used by the device page', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../app.json', import.meta.url), 'utf8'))
  assert.ok(manifest.permissions.includes('device:os.local_storage'))
})

test('Musafir history resumes after sleep, but never interrupts a pending audio draft', async () => {
  const storage = new Map([['musafir-resume', 'history']])
  const f = pageFixture({ storage })
  f.page.build()
  assert.equal(f.replacements.at(-1).url, 'page/history')
  assert.equal(f.requests.length, 0)
  assert.doesNotThrow(() => f.page.onDestroy())
  storage.set('pending-audio', JSON.stringify({ id: '100000-1', fileName: 'pending.opus', accepted: true, totalBytes: 100 }))
  const g = pageFixture({ storage })
  g.page.build(); await flush()
  assert.equal(g.replacements.length, 0)
  assert.equal(g.page.pendingAudio.id, '100000-1')
  g.page.openHistory()
  assert.equal(g.replacements.length, 0)
  g.page.onDestroy()
})

test('entering history while the agent works neither cancels nor resends the job', async () => {
  const f = pageFixture({ reply: p => p.method === 'STATUS' ? { ok: true, agent: 'Мусафир' }
    : { ok: true, job: { id: '100000-1', state: 'running' } } })
  f.page.build(); await flush()
  assert.equal(f.page.client.getState().phase, 'job')
  f.page.secondaryAction()
  assert.equal(f.replacements.at(-1).url, 'page/history')
  assert.equal(f.storage.get('musafir-resume'), 'history')
  assert.deepEqual(f.requests.map(p => p.method), ['STATUS', 'LATEST_JOB'])
  f.page.onDestroy()
})


test('compact large-file transfer preserves the opaque native handle and all bytes', async () => {
  const size = 957807
  const fd = Object.freeze({ toString() { return '71' }, valueOf() { throw Error('opaque handle') } })
  const f = recordingFixture({ sizes: [size], fd, compact: true })
  f.page.build()
  await flush()
  f.page.startRecording()
  f.page.stopRecording(false)
  for (let i = 0; i < 3; i++) f.tick(250)
  await flush()
  assert.equal(f.page.client.getState().phase, 'transcribing')
  const parts = f.requests.filter(x => x.method === 'AUDIO_PART')
  assert.equal(parts.length, Math.ceil(size / 6144))
  assert.equal(f.requests.some(x => x.method === 'AUDIO_CHUNK'), false)
  assert.equal(f.readLengths.reduce((a, b) => a + b, 0), size)
  assert.equal(Math.max(...f.readLengths), 6144)
  assert.equal(f.closes(), 1)
  assert.ok(f.removed.length > 0)
  f.page.onDestroy()
})

for (const kind of ['musafir', 'orca', 'claude', 'codex']) {
  test(`${kind}: native keyboard edits the whole transcript without submitting; cancel and destroy preserve it`, async () => {
    const id = '1700000000000-17'
    const original = 'Проверь пару ошибочных слов. '.repeat(20)
    const storage = new Map(kind === 'musafir' ? [] : [['voice-destination', JSON.stringify({
      target: kind, project: 'project-1', pairId: 'pair-1', label: 'Проект'
    })]])
    const f = pageFixture({ kind, storage, layout: text => ({ height: Math.ceil(text.length / 24) * 25 }),
      reply: ({ method }) => method === 'STATUS' ? { ok: true, agent: 'Мусафир' }
        : method === 'AUDIO_STATUS' ? { ok: true, id, state: 'ready', text: original,
          textLength: original.length, textOffset: 0, textComplete: true }
          : { ok: true, job: null }
    })
    f.page.build()
    await flush()
    f.page.client.resumeAudio(id)
    await flush()
    assert.equal(f.page.editButton.options.visible, true)
    assertReviewText(f.page, original)
    f.page.editButton.options.click_func()
    assert.equal(f.keyboard().text, original, 'editor receives every page, including the off-screen text')
    assert.equal(f.keyboard().inputType, 4, 'enabled custom keyboard is preferred')
    const changed = 'Проверь исправленные слова 🕌.\n' + original
    f.keyboard().onComplete(null, { data: changed })
    assert.equal(f.page.client.getState().text, changed)
    assertReviewText(f.page, changed)
    assert.equal(f.page.client.getState().phase, 'review')
    assert.equal(JSON.parse(storage.get(f.page.draftStorageKey)).text, changed)
    assert.equal(f.requests.some(x => /SEND|TEXT_(BEGIN|PART|FINISH)/.test(x.method)), false)
    f.page.editTranscript()
    f.keyboard().onCancel()
    assert.equal(f.page.client.getState().text, changed)
    f.page.editTranscript()
    const stale = f.keyboard()
    f.page.onDestroy()
    const saved = storage.get(f.page.draftStorageKey)
    stale.onComplete(null, { data: 'late callback' })
    assert.equal(storage.get(f.page.draftStorageKey), saved)
    assert.equal(f.keyboardCalls.at(-1).action, 'close')
  })
}

test('missing or failing keyboard keeps the review and all original text', async () => {
  for (const keyboard of [{}, { inputType: { CHAR: 1, JSKB: 4 },
    createKeyboard() { throw Error('unavailable') }, deleteKeyboard() {} }]) {
    const f = pageFixture({ keyboard })
    f.page.build()
    await flush()
    f.page.client.getState = () => ({ phase: 'review', text: 'Полный исходный текст', id: '1700000000000-1' })
    f.page.render(f.page.client.getState())
    assert.doesNotThrow(() => f.page.editTranscript())
    assertReviewText(f.page, 'Полный исходный текст')
    assert.equal(f.page.keyboardOpen, false)
    assert.match(f.page.stageWidget.options.text, /клавиатур/i)
    f.page.onDestroy()
  }
})

const agentProfiles = [
  { kind: 'orca', prefix: 'ORCA', context: { target: 'orca', pairId: 'pair-typed', label: 'Проект' } },
  { kind: 'claude', prefix: 'CLAUDE', context: { target: 'claude', project: '/work/typed', label: 'Typed', mode: 'auto' } },
  { kind: 'codex', prefix: 'CODEX', context: { target: 'codex', project: '/work/typed', label: 'Typed', mode: 'read-only' } }
]

test('Orca, Claude and Codex typed compose cancel safely, persist drafts and honor every Back path', async () => {
  for (const profile of agentProfiles) {
    const storage = new Map([['voice-destination', JSON.stringify(profile.context)]])
    const reply = ({ method }) => method === profile.prefix + '_LATEST'
      ? { ok: true, job: null } : { ok: true, job: null }
    const f = pageFixture({ kind: profile.kind, storage, reply })
    f.page.build(); await flush()
    assert.equal(f.page.secondaryButton.options.text, 'Написать')
    f.page.secondaryButton.options.click_func()
    f.keyboard().onCancel()
    assert.equal(f.page.client.getState().phase, 'ready')

    const text = `  Черновик ${profile.kind} 🙂\n`
    f.page.secondaryButton.options.click_func()
    f.keyboard().onComplete(null, { data: text })
    assert.equal(f.page.client.getState().phase, 'review')
    assertReviewText(f.page, text)
    assert.equal(JSON.parse(storage.get(f.page.draftStorageKey)).text, text)
    assert.equal(f.requests.some(request => /SEND|TEXT_(BEGIN|PART|FINISH)/.test(request.method)), false)
    f.page.backButton.options.click_func()
    assert.equal(f.replacements.at(-1).url, 'page/index')
    assert.equal(JSON.parse(storage.get(f.page.draftStorageKey)).text, text)
    f.page.onDestroy()

    const reopened = pageFixture({ kind: profile.kind, storage, reply })
    reopened.page.build(); await flush()
    assert.equal(reopened.page.client.getState().phase, 'review')
    assertReviewText(reopened.page, text)
    assert.equal(reopened.gesture(), true)
    assert.equal(reopened.replacements.at(-1).url, 'page/index')
    assert.equal(reopened.key(), true)
    assert.equal(reopened.replacements.at(-1).url, 'page/index')
    assert.equal(JSON.parse(storage.get(reopened.page.draftStorageKey)).text, text)
    reopened.page.onDestroy()
  }
})

test('Orca, Claude and Codex show the first result chunk and open exact full-answer history context', async () => {
  for (const profile of agentProfiles) {
    const id = `${profile.kind}-job-1`
    const context = { ...profile.context, jobId: id, aliasId: id, resumeJob: true }
    const storage = new Map([['voice-destination', JSON.stringify(context)]])
    const f = pageFixture({ kind: profile.kind, storage, reply: ({ method, params }) => {
      assert.equal(method, profile.prefix + '_JOB')
      assert.deepEqual({ ...params }, { id })
      return { ok: true, job: { id, state: 'completed', stage: 'completed',
        result: 'Первая часть', resultLength: 12000 } }
    } })
    f.page.build(); await flush()
    assertReaderText(f.page, 'Первая часть')
    assert.equal(f.requests.length, 1, 'voice result must not eagerly fetch history pages')
    assert.equal(f.page.menuButton.options.visible, true)
    assert.equal(f.page.menuButton.options.text, 'Полный ответ')
    f.page.menuButton.options.click_func()
    assert.deepEqual(JSON.parse(storage.get(profile.kind + '-history-view')),
      { screen: 'detail', id, field: 'result', offset: 0 })
    assert.deepEqual(JSON.parse(storage.get(profile.kind + '-resume')), { screen: 'history' })
    if (profile.kind === 'orca') {
      assert.deepEqual(JSON.parse(storage.get('orca-history-pair')), {
        id: 'pair-typed', projectLabel: 'Проект', workerAgent: '', reviewerAgent: ''
      })
    }
    assert.equal(f.replacements.at(-1).url, 'page/history')
    f.page.primaryButton.options.click_func()
    assert.equal(f.page.client.getState().phase, 'ready')
    assert.equal(f.page.primaryButton.options.text, 'Надиктовать')
    assert.equal(f.page.secondaryButton.options.text, 'Написать')
    const saved = JSON.parse(storage.get('voice-destination'))
    assert.equal(saved.startFresh, true)
    assert.equal(saved.resumeJob, false)
    f.page.onDestroy()
  }
})

test('all agent compose footers remain in bounds with at least 44px controls', async () => {
  for (const profile of agentProfiles) {
    for (const [width, height] of [[390, 450], [432, 514], [390, 400]]) {
      const storage = new Map([['voice-destination', JSON.stringify(profile.context)]])
      const f = pageFixture({ kind: profile.kind, width, height, storage,
        reply: () => ({ ok: true, job: null }) })
      f.page.build(); await flush()
      for (const control of [f.page.backButton, f.page.primaryButton, f.page.secondaryButton]) {
        const box = control.options
        assert.ok(box.h >= 44, `${profile.kind} control height at ${width}x${height}`)
        assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.w <= width && box.y + box.h <= height,
          `${profile.kind} control bounds at ${width}x${height}`)
      }
      f.page.onDestroy()
    }
  }
})

test('Musafir typed compose handles cancel, blank input and exact text without RPC before Send', async () => {
  const storage = new Map([[MUSAFIR_CONTEXT_KEY, JSON.stringify({
    target: 'musafir', chatId: null, mode: 'task', jobId: null, openJob: false
  })]])
  const text = '  Напомни позвонить 🙂\n'
  let uploaded = ''
  const f = pageFixture({ chats: true, storage, reply: ({ method, params }) => {
    if (method === 'TEXT_BEGIN') return { ok: true, id: params.id,
      textLength: params.textLength, receivedLength: 0 }
    if (method === 'TEXT_PART') {
      uploaded += params.text
      return { ok: true, id: params.id, textLength: Array.from(text).length,
        receivedLength: params.offset + Array.from(params.text).length }
    }
    if (method === 'TEXT_FINISH') return { ok: true, id: params.id,
      state: 'ready', textLength: Array.from(text).length }
    if (method === 'SEND_TEXT') return { ok: true, id: params.id, chatId: params.id,
      mode: params.mode, state: 'queued', text: '', result: '', reportLength: 0 }
    throw new Error(`unexpected ${method}`)
  } })
  f.page.build()
  await flush()
  assert.equal(f.requests.length, 0)

  f.page.secondaryButton.options.click_func()
  f.keyboard().onCancel()
  assert.equal(f.page.client.getState().phase, 'ready')
  assert.equal(f.requests.length, 0)

  f.page.secondaryButton.options.click_func()
  f.keyboard().onComplete(null, { data: '   ' })
  assert.equal(f.page.client.getState().phase, 'ready')
  assert.match(f.page.stageWidget.options.text, /Введите/)
  assert.equal(f.requests.length, 0)

  f.page.writeTask()
  f.keyboard().onComplete(null, { data: text })
  const draft = JSON.parse(storage.get(f.page.draftStorageKey))
  assert.equal(f.page.client.getState().phase, 'review')
  assert.equal(f.page.client.getState().text, text)
  assert.deepEqual({ typed: draft.typed, sourceId: draft.sourceId,
    sameId: draft.id === draft.draftId, text: draft.text }, {
    typed: true, sourceId: null, sameId: true, text
  })
  assert.equal(f.requests.length, 0)

  f.page.primaryButton.options.click_func()
  await flush()
  assert.equal(uploaded, text)
  assert.deepEqual(f.requests.map(item => item.method),
    ['TEXT_BEGIN', 'TEXT_PART', 'TEXT_FINISH', 'SEND_TEXT'])
  f.page.onDestroy()
})

test('Musafir Back preserves review, all native back paths navigate, and destroy unregisters them', async () => {
  const makeStorage = () => new Map([[MUSAFIR_CONTEXT_KEY, JSON.stringify({
    target: 'musafir', chatId: null, mode: 'task', jobId: null, openJob: false
  })]])
  const storage = makeStorage()
  const first = pageFixture({ chats: true, storage })
  first.page.build()
  await flush()
  first.page.writeTask()
  first.keyboard().onComplete(null, { data: 'Сохранить этот черновик' })
  first.page.backButton.options.click_func()
  assert.equal(first.replacements.at(-1).url, 'page/index')
  assert.equal(JSON.parse(storage.get(first.page.draftStorageKey)).text, 'Сохранить этот черновик')
  first.page.onDestroy()
  assert.deepEqual(first.interactionCalls.slice(-2), ['offGesture', 'offKey'])

  const reopened = pageFixture({ chats: true, storage })
  reopened.page.build()
  await flush()
  assert.equal(reopened.page.client.getState().phase, 'review')
  assert.equal(reopened.page.client.getState().text, 'Сохранить этот черновик')
  for (const phase of ['connecting', 'ready', 'recording', 'stopping', 'uploading',
    'transcribing', 'review', 'saving-text', 'sending', 'job', 'approval',
    'result', 'unknown', 'error']) {
    reopened.page.render({ phase, state: phase === 'job' ? 'running' : undefined,
      id: '100000-1', jobId: '100000-1', text: 'Текст', result: 'Ответ', error: 'Ошибка' })
    assert.equal(reopened.page.backButton.options.visible, true, phase)
  }
  reopened.page.onDestroy()

  for (const invoke of [fixture => fixture.gesture(), fixture => fixture.key()]) {
    const f = pageFixture({ chats: true, storage: makeStorage() })
    f.page.build()
    await flush()
    assert.equal(invoke(f), true)
    assert.equal(f.replacements.at(-1).url, 'page/index')
    f.page.onDestroy()
  }
})

test('Musafir Back cancels an in-flight text save and ignores its late completion', async () => {
  const storage = new Map([[MUSAFIR_CONTEXT_KEY, JSON.stringify({
    target: 'musafir', chatId: null, mode: 'task', jobId: null, openJob: false
  })]])
  let resolveBegin
  const f = pageFixture({ chats: true, storage, reply: ({ method, params }) => {
    if (method === 'TEXT_BEGIN') return new Promise(resolve => { resolveBegin = () => resolve({
      ok: true, id: params.id, textLength: params.textLength, receivedLength: 0
    }) })
    throw new Error(`unexpected ${method}`)
  } })
  f.page.build()
  await flush()
  f.page.writeTask()
  f.keyboard().onComplete(null, { data: 'Не отправлять' })
  f.page.primaryButton.options.click_func()
  assert.equal(f.page.client.getState().phase, 'saving-text')
  f.page.backButton.options.click_func()
  assert.equal(f.page.client.getState().phase, 'review')
  assert.equal(f.replacements.at(-1).url, 'page/index')
  resolveBegin()
  await flush()
  assert.equal(f.requests.some(item => ['TEXT_PART', 'TEXT_FINISH', 'SEND_TEXT'].includes(item.method)), false)
  f.page.onDestroy()
})

test('Musafir explicit review Cancel deletes its checkpoint while Back does not', async () => {
  const storage = new Map([[MUSAFIR_CONTEXT_KEY, JSON.stringify({
    target: 'musafir', chatId: null, mode: 'task', jobId: null, openJob: false
  })]])
  const f = pageFixture({ chats: true, storage })
  f.page.build()
  await flush()
  f.page.writeTask()
  f.keyboard().onComplete(null, { data: 'Удалить по явной отмене' })
  assert.equal(f.page.secondaryButton.options.text, 'Отмена')
  f.page.secondaryButton.options.click_func()
  assert.equal(f.page.client.getState().phase, 'ready')
  assert.equal(storage.get(f.page.draftStorageKey), '')
  assert.equal(storage.get('musafir-pending-context'), '')
  f.page.onDestroy()
})

test('Musafir failed native re-record leaves the previous review and draft intact', async () => {
  const storage = new Map([[MUSAFIR_CONTEXT_KEY, JSON.stringify({
    target: 'musafir', chatId: null, mode: 'task', jobId: null, openJob: false
  })]])
  const f = pageFixture({ chats: true, storage, media: () => ({
    setFormat() {}, start() { return false }, stop() {}
  }) })
  f.page.build()
  await flush()
  f.page.writeTask()
  f.keyboard().onComplete(null, { data: 'Старый черновик' })
  const saved = storage.get(f.page.draftStorageKey)
  f.page.startRecording()
  assert.equal(f.page.client.getState().phase, 'review')
  assert.equal(f.page.client.getState().text, 'Старый черновик')
  assert.equal(storage.get(f.page.draftStorageKey), saved)
  f.page.onDestroy()
})

test('unaccepted legacy audio is discarded and never uploaded on reopen', async () => {
  const storage = new Map([[MUSAFIR_CONTEXT_KEY, JSON.stringify({
    target: 'musafir', chatId: null, mode: 'task', jobId: null, openJob: false
  })], ['pending-audio', JSON.stringify({
    id: '100000-1', fileName: 'legacy.opus', totalBytes: 100, accepted: false,
    destinationKey: 'voice-draft:musafir:new'
  })]])
  const removed = []
  const f = pageFixture({ chats: true, storage, files: {
    rmSync({ path }) { removed.push(path) }
  } })
  f.page.build()
  await flush()
  assert.equal(storage.get('pending-audio'), '')
  assert.deepEqual(removed, ['legacy.opus'])
  assert.equal(f.requests.some(item => item.method.startsWith('AUDIO_')), false)
  f.page.onDestroy()
})

test('recording cancellation survives immediate destroy, while explicit Stop consent resumes once', async () => {
  const context = JSON.stringify({ target: 'musafir', chatId: null, mode: 'task', jobId: null, openJob: false })
  const makeNative = shared => ({
    media: () => ({
      setFormat(_codec, { target_file }) { shared.target = target_file },
      start() {},
      stop() { shared.stops += 1 }
    }),
    files: {
      statSync({ path }) { assert.equal(`data://${path}`, shared.target); return { size: 1 } },
      openSync() { return 7 },
      readSync({ buffer }) { new Uint8Array(buffer)[0] = 1; return 1 },
      closeSync() {},
      rmSync({ path }) { shared.removed.push(path) }
    }
  })

  for (const exit of ['cancel', 'destroy-active', 'stop-cancel']) {
    const storage = new Map([[MUSAFIR_CONTEXT_KEY, context]])
    const shared = { target: null, stops: 0, removed: [] }
    const first = pageFixture({ chats: true, storage, ...makeNative(shared) })
    first.page.build(); await flush(); first.page.startRecording()
    if (exit === 'cancel') first.page.cancelRecording()
    if (exit === 'stop-cancel') { first.page.stopRecording(false); first.page.cancelRecording() }
    first.page.onDestroy()
    const reopened = pageFixture({ chats: true, storage, ...makeNative(shared) })
    reopened.page.build(); await flush()
    assert.equal(reopened.requests.some(item => ['AUDIO_BEGIN', 'AUDIO_PART', 'AUDIO_CHUNK',
      'AUDIO_FINISH', 'AUDIO_STATUS'].includes(item.method)), false, exit)
    assert.equal(storage.get('pending-audio'), '')
    reopened.page.onDestroy()
  }

  const storage = new Map([[MUSAFIR_CONTEXT_KEY, context]])
  const shared = { target: null, stops: 0, removed: [] }
  const reply = ({ method, params }) => {
    if (method === 'AUDIO_BEGIN') return { ok: true, id: params.id,
      receivedBytes: 0, totalBytes: 1 }
    if (method === 'AUDIO_CHUNK') return { ok: true, id: params.id,
      receivedBytes: 1, totalBytes: 1 }
    if (method === 'AUDIO_FINISH') return { ok: true, id: params.id, state: 'transcribing' }
    if (method === 'AUDIO_CANCEL') return { ok: true, id: params.id, state: 'cancelled' }
    throw new Error(`unexpected ${method}`)
  }
  const stopped = pageFixture({ chats: true, storage, reply, ...makeNative(shared) })
  stopped.page.build(); await flush(); stopped.page.startRecording(); stopped.page.stopRecording(false)
  stopped.page.onDestroy()
  assert.equal(JSON.parse(storage.get('pending-audio')).uploadConsent, true)
  const resumed = pageFixture({ chats: true, storage, reply, ...makeNative(shared) })
  resumed.page.build(); await flush(); resumed.tick(0); await flush()
  assert.deepEqual(resumed.requests.map(item => item.method),
    ['AUDIO_BEGIN', 'AUDIO_CHUNK', 'AUDIO_FINISH'])
  resumed.page.onDestroy()
})

test('accepted and submitting states never claim the agent is already working', async () => {
  for (const kind of ['musafir', 'orca', 'claude', 'codex']) {
    const storage = new Map(kind === 'musafir' ? [] : [['voice-destination', JSON.stringify({
      target: kind, project: 'project-1', pairId: 'pair-1', label: 'Проект'
    })]])
    const f = pageFixture({ kind, storage })
    f.page.build()
    await flush()
    for (const state of ['queued', 'submitting']) {
      f.page.render({ phase: 'job', state, id: 'job-1' })
      assert.doesNotMatch(f.page.statusWidget.options.text, /работает|думает/)
      assert.doesNotMatch(f.page.bodyWidget.options.text, /выполняется|работает/)
      assert.match(f.page.bodyWidget.options.text, /ожидаю/i)
    }
    f.page.render({ phase: 'job', state: 'running', id: 'job-1' })
    assert.match(f.page.statusWidget.options.text, /работает/)
    f.page.onDestroy()
  }
})

test('a confirmed agent start vibrates once; queued status and polling do not repeat it', async () => {
  const f = pageFixture()
  f.page.build()
  await flush()
  f.page.alerts.observe({ phase: 'job', state: 'queued', id: 'start-1' })
  assert.equal(f.vibrationCalls.filter(x => x.name === 'start').length, 0)
  f.page.alerts.observe({ phase: 'job', state: 'running', id: 'start-1' })
  assert.equal(f.vibrationCalls.filter(x => x.name === 'start').length, 1)
  f.page.alerts.observe({ phase: 'refreshing' })
  f.page.alerts.observe({ phase: 'job', state: 'running', id: 'start-1' })
  assert.equal(f.vibrationCalls.filter(x => x.name === 'start').length, 1)
  f.page.onDestroy()
  const again = pageFixture({ storage: f.storage })
  again.page.build()
  await flush()
  again.page.alerts.observe({ phase: 'job', state: 'running', id: 'start-1' })
  assert.equal(again.vibrationCalls.filter(x => x.name === 'start').length, 0)
  again.page.onDestroy()
})

test('an edited draft and its pending audio cannot be restored into a different project', async () => {
  const id = '1700000000000-33'
  const destination = project => JSON.stringify({ target: 'claude', project, label: project })
  const storage = new Map([['voice-destination', destination('project-a')]])
  const first = pageFixture({ kind: 'claude', storage, reply: ({ method }) => method === 'AUDIO_STATUS'
    ? { ok: true, id, state: 'ready', text: 'Задание для A', textLength: 13, textOffset: 0, textComplete: true }
    : { ok: true, job: null } })
  first.page.build()
  await flush()
  first.page.client.resumeAudio(id)
  await flush()
  first.page.client.updateReviewText('Исправлено только для A')
  first.page.savePendingAudio({ id, fileName: 'draft.opus', totalBytes: 1024, accepted: true })
  const savedPending = storage.get('pending-audio')
  first.page.onDestroy()
  storage.set('voice-destination', destination('project-b'))
  const removed = []
  const second = pageFixture({ kind: 'claude', storage,
    media: () => { throw new Error('foreign recording must not open the microphone') },
    files: { rmSync({ path }) { removed.push(path) } }
  })
  second.page.build()
  await flush()
  assert.equal(second.page.client.getState().phase, 'ready')
  assert.equal(second.page.pendingAudio, null)
  assert.notEqual(first.page.draftStorageKey, second.page.draftStorageKey)
  assert.equal(JSON.parse(storage.get(first.page.draftStorageKey)).text, 'Исправлено только для A')
  second.page.primaryButton.options.click_func()
  assert.equal(second.page.client.getState().phase, 'error')
  assert.match(scrollText(second.page.readerScroll), /другой задачи.*не потерять/s)
  assert.equal(second.page.primaryButton.options.text, 'Claude')
  assert.equal(second.mediaCalls(), 0)
  assert.equal(storage.get('pending-audio'), savedPending)
  assert.deepEqual(removed, [])
  second.page.primaryButton.options.click_func()
  assert.equal(second.replacements.at(-1).url, 'page/index')
  second.page.onDestroy()

  const unaccepted = { ...JSON.parse(savedPending), accepted: false, uploadConsent: false }
  storage.set('pending-audio', JSON.stringify(unaccepted))
  storage.set('voice-destination', destination('project-c'))
  const third = pageFixture({ kind: 'claude', storage,
    media: () => { throw new Error('unaccepted foreign recording must also stay untouched') },
    files: { rmSync({ path }) { removed.push(path) } }
  })
  third.page.build()
  await flush()
  third.page.primaryButton.options.click_func()
  assert.equal(third.page.client.getState().phase, 'error')
  assert.equal(third.mediaCalls(), 0)
  assert.equal(storage.get('pending-audio'), JSON.stringify(unaccepted))
  assert.deepEqual(removed, [])
  third.page.onDestroy()
})

test('Musafir review scroll preserves the full text despite underestimated native multiline height', async () => {
  for (const [width, height] of [[432, 514], [390, 450], [390, 400]]) {
    const f = pageFixture({ chats: true, storage: new Map([[MUSAFIR_CONTEXT_KEY, JSON.stringify({ target: 'musafir', chatId: null, mode: 'task', jobId: null, openJob: false })]]), width, height,
      layout: text => ({ result: 0, height: 1, width: Array.from(text).length * 14 }) })
    f.page.build(); await flush()
    const text = '  Первые слова для проверки.\n\n' + 'Длинное сообщение на часах без пропущенных слов. '.repeat(45) + '\nПоследняя строка 🙂'
    f.page.client.createTypedReview(text)
    const rows = f.page.reviewRows
    assert.equal(rows.map(row => row.text + row.separator).join(''), text)
    assert.ok(rows.length > 40)
    for (const row of rows) assert.equal(text.slice(row.start, row.end), row.text)
    assert.ok(rows.some(row => row.text === '' && row.display === '↵'))
    assert.equal(f.page.reviewScroll.options.visible, true)
    assert.equal(f.page.bodyWidget.options.visible, false)
    assert.equal(f.page.nextButton.options.visible, false)
    const list = f.page.reviewScroll.options, edit = f.page.editButton.options, send = f.page.primaryButton.options
    assert.ok(list.y + list.h + 8 <= edit.y)
    assert.ok(edit.y + edit.h + 8 <= send.y)
    assert.ok(send.y + send.h <= height - 14)
    assert.ok(list.item_config[0].item_height >= 44)
    assert.equal(list.item_enable_horizon_drag, false)
    const updates = f.page.reviewScroll.updates.filter(update => update.key === 'update-data').length
    f.page.render(f.page.client.getState())
    assert.equal(f.page.reviewScroll.updates.filter(update => update.key === 'update-data').length, updates,
      'unchanged review must not reset the native scroll position')
    f.page.editTranscript(); assert.equal(f.keyboard().text, text); f.keyboard().onCancel()
    assert.equal(f.requests.length, 0)
    f.page.discardReview()
    assert.equal(f.page.reviewScroll.options.visible, false)
    assert.equal(f.page.bodyWidget.options.visible, true)
    f.page.onDestroy()
  }
})

test('Musafir tap-to-edit changes exactly one UTF-16 span and keeps separators and unsent state', async () => {
  const f = pageFixture({ chats: true, storage: new Map([[MUSAFIR_CONTEXT_KEY, JSON.stringify({ target: 'musafir', chatId: null, mode: 'task', jobId: null, openJob: false })]]) })
  f.page.build(); await flush()
  const text = '🙂 Первая строка\n\nТретья строка\nКонец'
  f.page.client.createTypedReview(text)
  const row = f.page.reviewRows.find(value => value.text.includes('Третья'))
  const index = f.page.reviewRows.indexOf(row)
  f.page.reviewScroll.options.item_click_func(null, index, 'display')
  assert.equal(f.keyboard().text, row.text)
  const replacement = '  Исправлено 🕌  '
  f.keyboard().onComplete(null, { data: replacement })
  const expected = text.slice(0, row.start) + replacement + text.slice(row.end)
  assert.equal(f.page.client.getState().text, expected)
  assert.equal(JSON.parse(f.storage.get(f.page.draftStorageKey)).text, expected)
  assert.equal(f.page.reviewRows.map(value => value.text + value.separator).join(''), expected)
  assert.equal(f.page.reviewScroll.options.on_page, 1, 'fragment edit retains approximate scroll position')
  assert.equal(f.requests.length, 0)
  const blank = f.page.reviewRows.findIndex(value => value.text === '')
  f.page.editReviewRow(blank)
  assert.equal(f.keyboard().text, '', 'placeholder must never enter the editable text')
  f.keyboard().onCancel()
  assert.equal(f.page.client.getState().text, expected)
  f.page.editReviewRow(0)
  const pending = f.keyboard()
  f.page.client.updateReviewText('Другой локальный черновик')
  pending.onComplete(null, { data: 'Запоздалая правка' })
  assert.equal(f.page.client.getState().text, 'Другой локальный черновик')
  assert.match(f.page.stageWidget.options.text, /Текст изменился/)
  f.page.editReviewRow(0)
  const destroyed = f.keyboard()
  f.page.onDestroy()
  destroyed.onComplete(null, { data: 'Правка после закрытия' })
  assert.equal(JSON.parse(f.storage.get(f.page.draftStorageKey)).text, 'Другой локальный черновик')
})

test('Musafir scroll accepts 30000 Unicode codepoints with bounded glyph measurements and intact graphemes', async () => {
  let measurements = 0
  const f = pageFixture({ chats: true, storage: new Map([[MUSAFIR_CONTEXT_KEY, JSON.stringify({ target: 'musafir', chatId: null, mode: 'task', jobId: null, openJob: false })]]), layout: text => {
    measurements++
    return { result: 0, height: 1, width: Array.from(text).length * 12 }
  } })
  f.page.build(); await flush()
  const text = Array.from(('Русский текст е\u0301 👨‍👩‍👧‍👦 汉字\n\n').repeat(1600)).slice(0, 30000).join('')
  assert.equal(Array.from(text).length, 30000)
  const before = measurements
  f.page.client.createTypedReview(text)
  assert.equal(f.page.reviewRows.map(row => row.text + row.separator).join(''), text)
  assert.ok(f.page.reviewRows.length < 5000)
  assert.ok(measurements - before <= new Set(Array.from(text)).size, 'glyph metrics are cached per review')
  for (const row of f.page.reviewRows) {
    assert.doesNotMatch(row.text, /[\ud800-\udbff]$/u)
    assert.doesNotMatch(row.text, /^[\udc00-\udfff\u0301\u200d]/u)
    assert.doesNotMatch(row.text, /\u200d$/u)
  }
  assert.equal(f.requests.length, 0)
  assert.equal(f.gesture(), true)
  assert.equal(f.replacements.at(-1).url, 'page/index')
  assert.equal(JSON.parse(f.storage.get(f.page.draftStorageKey)).text, text)
  f.page.onDestroy()
})

test('Musafir row boundaries keep skin tones, flag pairs and spacing marks with their base', async () => {
  const f = pageFixture({ chats: true, storage: new Map([[MUSAFIR_CONTEXT_KEY, JSON.stringify({
    target: 'musafir', chatId: null, mode: 'task', jobId: null, openJob: false
  })]]) })
  f.page.build(); await flush()
  for (let prefix = 0; prefix < 36; prefix++) {
    const text = 'W'.repeat(prefix) + '👍🏽 🇪🇬 🇷🇺 का конец'
    if (prefix === 0) f.page.client.createTypedReview(text)
    else f.page.client.updateReviewText(text)
    assert.equal(f.page.reviewRows.map(row => row.text + row.separator).join(''), text)
    for (const row of f.page.reviewRows) {
      if (row.text.includes('👍')) assert.ok(row.text.includes('👍🏽'))
      assert.doesNotMatch(row.text, /^[🏽ा]/u)
      assert.equal(Array.from(row.text).filter(c => c.codePointAt(0) >= 0x1f1e6 && c.codePointAt(0) <= 0x1f1ff).length % 2, 0)
    }
  }
  f.page.onDestroy()
})

test('Orca handoff persists one ID before dispatch and reconciles a lost receipt without another mutation', async () => {
  const sourceId = '1700000000000-1'
  const storage = new Map([['voice-destination', JSON.stringify({ target: 'orca', pairId: 'pair-1',
    label: 'Проект', jobId: sourceId, resumeJob: true })]])
  let release
  const f = pageFixture({ kind: 'orca', storage, reply: payload => {
    if (payload.method === 'ORCA_HANDOFF') {
      assert.equal(JSON.parse(storage.get('voice-destination')).pendingHandoff.id, payload.params.newId)
      return new Promise(resolve => { release = resolve })
    }
    if (payload.method === 'ORCA_JOB' && payload.params.id !== sourceId) return {
      ok: true, job: { id: payload.params.id, state: 'queued' }
    }
    return { ok: true, job: { id: sourceId, state: 'completed', result: 'План готов', mode: 'ask', handoff: true } }
  } })
  f.page.build(); await flush()
  f.page.handoffOrca(); f.page.handoffOrca(); await flush()
  assert.equal(f.requests.filter(x => x.method === 'ORCA_HANDOFF').length, 1)
  const newId = JSON.parse(storage.get('voice-destination')).pendingHandoff.id
  f.tick(18000); await flush()
  assert.equal(f.page.controlBusy, false)
  assert.match(f.page.stageWidget.options.text, /не подтверждена/)
  f.page.handoffOrca(); await flush()
  assert.equal(f.requests.filter(x => x.method === 'ORCA_HANDOFF').length, 1)
  assert.equal(f.requests.at(-1).method, 'ORCA_JOB')
  assert.equal(f.requests.at(-1).params.id, newId)
  assert.equal(JSON.parse(storage.get('voice-destination')).jobId, newId)
  assert.equal(JSON.parse(storage.get('voice-destination')).pendingHandoff, null)
  release({ ok: true, job: { id: newId, state: 'queued' } }); await flush()
  assert.equal(f.replacements.length, 1)
  f.page.onDestroy()
  assert.equal(f.timers.size, 0)
})

test('Continue stores the next draft under the newly returned agent session', async () => {
  const sessionId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  const storage = new Map([['voice-destination', JSON.stringify({ target: 'codex', project: '/project', label: 'Проект', jobId: '123-1', resumeJob: true })]])
  const reply = () => ({ ok: true, job: { id: '123-1', state: 'completed', result: 'Готово', sessionId } })
  const f = pageFixture({ kind: 'codex', storage, reply })
  f.page.build(); await flush()
  f.page.primaryAction()
  assert.equal(f.page.client.getState().phase, 'ready')
  f.page.secondaryAction()
  f.keyboard().onComplete(null, { data: 'Продолжение в той же сессии' })
  const key = f.page.draftStorageKey
  assert.ok(key.endsWith(sessionId))
  f.page.onDestroy()
  const g = pageFixture({ kind: 'codex', storage, reply })
  g.page.build(); await flush()
  assert.equal(g.page.client.getState().phase, 'review')
  assert.equal(g.page.client.getState().text, 'Продолжение в той же сессии')
  assert.equal(g.requests.some(x => x.method === 'CODEX_SEND'), false)
  g.page.onDestroy()
})
