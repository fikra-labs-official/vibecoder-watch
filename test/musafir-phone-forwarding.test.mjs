import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { forwardVoiceRequest } from '../shared/bridge-client.js'
import { MUSAFIR_HEROES, heroById } from '../shared/musafir-chat.js'

const source = fs.readFileSync(new URL('../shared/musafir-page.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?from ['\"][^'\"]+['\"]\n/gm, '')
  .replace('export function createMusafirPage', 'function createMusafirPage')
const flush = () => new Promise(resolve => setImmediate(resolve))

test('Musafir home CHAT_LIST reaches the bridge through the phone forwarding allowlist', async () => {
  const forwarded = []
  const widgets = []
  const timers = new Map()
  let nextTimer = 0
  const page = vm.runInNewContext(source + '\ncreateMusafirPage()', {
    MUSAFIR_HEROES,
    heroById,
    getDeviceInfo: () => ({ width: 432, height: 514 }),
    setStatusBarVisible() {},
    replace() {},
    LocalStorage: class { getItem() {} setItem() {} },
    createWidget(kind, options) {
      const item = {
        kind,
        events: {},
        addEventListener(type, callback) { this.events[type] = callback },
        options: { ...options, visible: true },
        setProperty(property, value) {
          if (kind === 3 && property === 'text') throw new Error('BUTTON prop.TEXT is forbidden')
          if (kind === 3 && property === 'more' && !['x', 'y', 'w', 'h'].every(key => Number.isFinite(value[key]))) throw new Error('partial BUTTON MORE')
          if (property === 'more' || property === 'update_data') Object.assign(this.options, value)
          else this.options[property] = value
        }
      }
      widgets.push(item)
      return item
    },
    widget: { FILL_RECT: 1, TEXT: 2, BUTTON: 3, IMG: 4, SCROLL_LIST: 5 },
    event: { CLICK_UP: 'click_up' },
    align: { LEFT: 1 },
    text_style: { WRAP: 1 },
    prop: { TEXT: 'text', VISIBLE: 'visible', MORE: 'more', UPDATE_DATA: 'update_data' },
    onGesture() {}, offGesture() {}, GESTURE_RIGHT: 10,
    onKey() {}, offKey() {}, KEY_BACK: 20, KEY_EVENT_CLICK: 21,
    setTimeout(callback, delay) {
      const id = ++nextTimer
      timers.set(id, { callback, delay })
      return id
    },
    clearTimeout(id) { timers.delete(id) }
  })
  page.request = request => forwardVoiceRequest(request, async options => {
    forwarded.push(JSON.parse(options.body))
    return {
      status: 200,
      body: { ok: true, chats: [], nextOffset: null, activeJob: null }
    }
  }, 'https://mac.test', 'device-secret', 'musafir')

  page.build()
  await flush()
  await flush()

  assert.deepEqual(forwarded, [
    { method: 'CHAT_LIST', params: { offset: 0, limit: 10, archived: false } }
  ])
  assert.equal(page.heading.options.text, 'Последние чаты')
  assert.equal(page.note.options.text, 'Здесь появятся твои задачи')
  assert.equal(timers.size, 0)
  page.onDestroy()
  assert.equal(widgets.length > 0, true)
})
