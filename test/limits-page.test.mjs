import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { forwardRequest } from '../shared/bridge-client.js'

const shared = fs.readFileSync(new URL('../shared/limits-page.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replace('export function createLimitsPage', 'function createLimitsPage')
const entry = fs.readFileSync(new URL('../page/limits.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '')
const flush = () => new Promise(resolve => setImmediate(resolve))

function fixture({ request = async () => ({ ok: true }), storage = new Map() } = {}) {
  let page
  const widgets = []
  const delays = []
  vm.runInNewContext(shared + '\n' + entry, {
    Page(definition) { page = Object.assign(Object.create(definition), definition) },
    BasePage: value => value,
    getDeviceInfo: () => ({ width: 390, height: 450 }),
    LocalStorage: class { getItem(key) { return storage.get(key) } setItem(key, value) { storage.set(key, value) } },
    createWidget(kind, options) {
      const w = { kind, options: { ...options }, setProperty(property, value) { this.options[property] = value } }
      widgets.push(w); return w
    },
    widget: { FILL_RECT: 1, TEXT: 2, BUTTON: 3 }, align: { CENTER_H: 1 }, text_style: { WRAP: 1 },
    prop: { TEXT: 'text', COLOR: 'color' }, console: { log() {} },
    setTimeout: (callback, delay) => { delays.push(delay); return setImmediate(callback) }
  })
  const calls = []
  page.request = (payload, options) => { calls.push({ payload, options }); return request(payload, options) }
  page.build()
  return { page, widgets, storage, calls, delays }
}

const reply = { ok: true, checkedAt: '12:00', text: 'Claude 5 часов 43% · Неделя 51% | Codex Неделя 37%', agents: [
  { id: 'claude', label: 'Claude Code', error: '', plan: '', windows: [
    { id: 'five_hour', label: '5 часов', used: 43, free: 57, resets: '14:15', left: 'через 2 ч 15 мин' },
    { id: 'seven_day', label: 'Неделя', used: 51, free: 49, resets: '03.10 20:00', left: 'через 5 д 8 ч' }] },
  { id: 'codex', label: 'Codex', error: '', plan: 'pro', windows: [{ id: 'seven_day', label: 'Неделя', used: 95, resets: '03.10 20:00', left: 'через 5 д 8 ч' }] }
] }

test('limits page shows the cached reading at once, then the fresh one; refresh forces a re-read', async () => {
  const cached = { ...reply, checkedAt: '11:40' }
  const f = fixture({ storage: new Map([['limits-cache', JSON.stringify(cached)]]), request: async () => reply })
  assert.equal(f.page.note.options.text, 'Обновляю…')
  assert.equal(f.page.blocks[0].title.options.text, 'Claude Code')
  assert.equal(f.page.blocks[0].lines.options.text,
    '5 часов · осталось 57 %\nсброс 14:15, через 2 ч 15 мин\nНеделя · осталось 49 %\nсброс 03.10 20:00, через 5 д 8 ч')
  await flush(); await flush()
  assert.equal(f.page.note.options.text, 'Обновлено 12:00')
  assert.equal(f.page.blocks[1].lines.options.color, 0xe07a5f, 'a window at 90 % or more is red')
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].payload)), { method: 'LIMITS', params: {} })
  f.page.button.options.click_func()
  assert.equal(f.page.note.options.text, 'Спрашиваю Claude и Codex…')
  await flush(); await flush()
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[1].payload)), { method: 'LIMITS', params: { force: true } })
  assert.equal(JSON.parse(f.storage.get('limits-cache')).checkedAt, '12:00')
})

test('a failed reading keeps the screen and explains; the Side Service profile allows only LIMITS', async () => {
  const f = fixture({ request: async () => ({ ok: false, error: 'Мост недоступен' }) })
  await flush(); await flush()
  assert.equal(f.page.note.options.text, 'Мост недоступен')
  assert.equal(f.page.blocks[0].lines.options.text, '')
  const fetched = []
  await forwardRequest({ method: 'LIMITS', params: {} }, options => { fetched.push(options); return Promise.resolve({ body: '{"ok":true}' }) }, 'https://bridge', 'token', 'limits')
  assert.equal(fetched.length, 1)
  const denied = await forwardRequest({ method: 'CLAUDE_SEND', params: {} }, () => { throw new Error('must not fetch') }, 'https://bridge', 'token', 'limits')
  assert.deepEqual(denied, { ok: false, error: 'Обновите приложение Лимиты' })
})

test('a slow phone handshake is retried quietly, then explained in Russian', async () => {
  let failures = 2
  const f = fixture({ request: async () => { if (failures-- > 0) throw new Error('shake timeout'); return reply } })
  for (let i = 0; i < 12; i++) await flush()
  assert.equal(f.calls.length, 3)
  assert.deepEqual([...f.delays], [1500, 3000])
  assert.equal(f.page.note.options.text, 'Обновлено 12:00')
  const g = fixture({ request: async () => { throw new Error('shake timeout') } })
  for (let i = 0; i < 20; i++) await flush()
  assert.equal(g.calls.length, 4)
  assert.equal(g.page.note.options.text, 'Телефон не ответил. Открой Zepp на телефоне и нажми «Обновить»')
  g.page.button.options.click_func(); g.page.button.options.click_func()
  await flush()
  assert.equal(g.calls.length, 5, 'a second tap while loading does not start another request')
  const h = fixture({ request: async () => { throw new Error('Мост не отвечает') } })
  for (let i = 0; i < 6; i++) await flush()
  assert.equal(h.calls.length, 1, 'bridge errors are not retried')
  assert.equal(h.page.note.options.text, 'Мост не отвечает')
})
