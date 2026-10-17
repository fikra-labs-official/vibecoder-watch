import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../shared/musafir-report-page.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replace('export function createMusafirReportPage', 'function createMusafirReportPage')
const flush = () => new Promise(resolve => setImmediate(resolve))
const id = '1700000000000-1'

function fixture(text, reply) {
  const timers = new Map(), calls = [], statusBars = []
  let nextTimer = 0
  const page = vm.runInNewContext(source + '\ncreateMusafirReportPage()', {
    getDeviceInfo: () => ({ width: 432, height: 514 }),
    setStatusBarVisible: value => statusBars.push(value),
    LocalStorage: class { getItem() { return id } }, replace() {},
    widget: { FILL_RECT: 1, TEXT: 2, BUTTON: 3 }, align: {}, text_style: {},
    prop: { TEXT: 'text', MORE: 'more', VISIBLE: 'visible' },
    createWidget(kind, options) { return { options, setProperty(p, v) { if (p === 'more') Object.assign(options, v); else options[p] = v } } },
    getTextLayout: text => ({ height: Math.ceil(Array.from(text).length / 20) * 26 }),
    setTimeout(cb, delay) { const key = ++nextTimer; timers.set(key, { cb, delay }); return key },
    clearTimeout(key) { timers.delete(key) }
  })
  page.request = payload => {
    calls.push(payload)
    if (reply) return reply(payload)
    const { offset, limit } = payload.params, chars = Array.from(text)
    return Promise.resolve({ ok: true, id, offset, text: chars.slice(offset, offset + limit).join(''),
      textLength: chars.length, nextOffset: offset + limit < chars.length ? offset + limit : null, truncated: false })
  }
  page.build()
  return { page, calls, timers, statusBars }
}

test('full report preserves every Unicode character while paging bounded chunks in both directions', async () => {
  const text = 'Русский текст 🙂 العربية\n'.repeat(130)
  const f = fixture(text)
  await flush()
  let collected = ''
  while (true) {
    collected += f.page.pages.join('')
    if (f.page.nextOffset === null) break
    f.page.page = f.page.pages.length - 1
    f.page.turn(1)
    await flush()
  }
  assert.deepEqual(f.statusBars, [false])
  assert.equal(collected, text)
  assert.ok(f.calls.length > 2)
  assert.equal(f.page.total, Array.from(text).length)
  const offset = f.page.offset
  f.page.page = 0
  f.page.turn(-1)
  await flush()
  assert.equal(f.page.offset, offset - 1000)
  assert.equal(f.page.page, f.page.pages.length - 1)
  f.page.onDestroy()
  assert.equal(f.timers.size, 0)
  assert.deepEqual(f.statusBars, [false, true])
})

test('wrong report, truncated flag omission and inconsistent lengths are rejected', async () => {
  for (const overrides of [{ id: 'other' }, { truncated: undefined }, { nextOffset: 0 }, { textLength: 200001 }]) {
    const f = fixture('', async () => ({ ok: true, id, offset: 0, text: 'x', textLength: 1,
      nextOffset: null, truncated: false, ...overrides }))
    await flush()
    assert.equal(f.page.error, true)
    assert.equal(f.page.next.options.text, 'Повторить')
    f.page.onDestroy()
  }
})

test('report timeout and page destruction cannot leave a pending spinner or apply a late result', async () => {
  let finish
  const f = fixture('', () => new Promise(resolve => { finish = resolve }))
  await flush()
  const timer = [...f.timers.values()].find(item => item.delay === 18000)
  timer.cb()
  await flush()
  assert.equal(f.page.error, true)
  f.page.onDestroy()
  finish({ ok: true, id, text: 'late', offset: 0, textLength: 4, nextOffset: null, truncated: false })
  await flush()
  assert.notEqual(f.page.body.options.text, 'late')
})
