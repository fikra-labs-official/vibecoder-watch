import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { textRows } from '../shared/text-rows.js'

const stripImports = value => value.replace(/^import[\s\S]*?from ['"][^'"]+['"]\n/gm, '')
const source = stripImports(fs.readFileSync(new URL('../shared/musafir-report-page.js', import.meta.url), 'utf8'))
  .replace('export function createMusafirReportPage', 'function createMusafirReportPage')
const flush = () => new Promise(resolve => setImmediate(resolve))
const id = '1700000000000-1'
const chatId = '1700000000000-7'
const exactContext = {
  target: 'musafir', chatId, mode: 'research', jobId: id, openJob: true, autoRecord: false
}

function fixture(text = '', reply, { width = 432, height = 514, storage } = {}) {
  const timers = new Map(), calls = [], statusBars = [], widgets = [], replacements = []
  const interaction = { gesture: null, key: null, offGesture: 0, offKey: 0 }
  const values = storage || new Map([
    ['musafir-report-job', id],
    ['musafir-context', JSON.stringify(exactContext)],
    ['musafir-return-view', JSON.stringify({ kind: 'detail' })]
  ])
  let nextTimer = 0
  const page = vm.runInNewContext(source + '\ncreateMusafirReportPage()', {
    textRows,
    getDeviceInfo: () => ({ width, height }),
    setStatusBarVisible: value => statusBars.push(value),
    LocalStorage: class {
      getItem(key) { return values.get(key) }
      setItem(key, value) { values.set(key, value) }
    },
    replace(value) { replacements.push(value) },
    widget: { FILL_RECT: 1, TEXT: 2, BUTTON: 3, SCROLL_LIST: 4 },
    align: { CENTER_H: 1, CENTER_V: 2, LEFT: 3, TOP: 4 },
    text_style: { WRAP: 1 },
    prop: { TEXT: 'text', MORE: 'more', VISIBLE: 'visible', UPDATE_DATA: 'data' },
    createWidget(kind, options) {
      const item = {
        kind,
        options: { ...options, visible: true },
        setProperty(property, value) {
          if (kind === 3 && property === 'text') throw new Error('BUTTON prop.TEXT is forbidden')
          if (kind === 3 && property === 'more') {
            for (const key of ['x', 'y', 'w', 'h']) assert.equal(Number.isFinite(value[key]), true, `BUTTON MORE ${key}`)
          }
          if (property === 'data') { Object.assign(this.options, value); return }
          if (property === 'more') Object.assign(this.options, value)
          else this.options[property] = value
        }
      }
      widgets.push(item)
      return item
    },
    getTextLayout: value => ({ height: Math.ceil(Array.from(value).length / 20) * 24 }),
    onGesture(option) { interaction.gesture = option.callback },
    offGesture() { interaction.offGesture += 1 },
    GESTURE_RIGHT: 10,
    onKey(option) { interaction.key = option.callback },
    offKey() { interaction.offKey += 1 },
    KEY_BACK: 20,
    KEY_EVENT_CLICK: 21,
    setTimeout(callback, delay) { const key = ++nextTimer; timers.set(key, { callback, delay }); return key },
    clearTimeout(key) { timers.delete(key) }
  })
  page.request = payload => {
    calls.push(payload)
    if (reply) return reply(payload)
    const { offset, limit } = payload.params, chars = Array.from(text)
    return Promise.resolve({
      ok: true,
      id,
      offset,
      text: chars.slice(offset, offset + limit).join(''),
      textLength: chars.length,
      nextOffset: offset + limit < chars.length ? offset + limit : null,
      truncated: false
    })
  }
  page.build()
  return { page, calls, timers, statusBars, widgets, replacements, storage: values, interaction }
}

function assertGeometry(f, width, height) {
  const buttons = f.widgets.filter(item => item.kind === 3 && item.options.visible)
  for (const button of buttons) {
    const { x, y, w, h } = button.options
    assert.equal(x >= 0 && y >= 0 && x + w <= width && y + h <= height, true)
    assert.equal(h >= 44, true)
    assert.equal(y + h <= height - 14, true)
  }
  for (let i = 0; i < buttons.length; i += 1) {
    for (let j = i + 1; j < buttons.length; j += 1) {
      const a = buttons[i].options, b = buttons[j].options
      const overlap = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
      assert.equal(overlap, false, `${a.text}/${b.text}`)
    }
  }
  const body = f.page.body.options
  const nav = f.page.retry.options
  assert.equal(body.y + body.h <= nav.y, true)
}

async function drain(f) {
  for (let n = 0; n < 250; n++) {
    await flush()
    const next = [...f.timers.entries()].find(([, timer]) => timer.delay === 0)
    if (!next) return
    f.timers.delete(next[0]); next[1].callback()
  }
  throw new Error('unbounded report loading')
}
const rowText = f => f.page.rows.map(row => row.text + row.separator).join('')

test('full report loads automatically into one Unicode scroll list without page controls', async () => {
  const text = 'Русский текст 🙂 العربية\n'.repeat(130)
  const f = fixture(text)
  await drain(f)
  assert.equal(rowText(f), text)
  assert.equal(f.page.content, text)
  assert.ok(f.calls.length > 2)
  assert.equal(f.page.total, Array.from(text).length)
  assert.equal(f.page.body.options.on_page, 1)
  assert.equal(f.page.retry.options.visible, false)
  assert.equal(f.widgets.filter(w => w.kind === 3 && ['‹', '›'].includes(w.options.text)).length, 0)
  f.page.onDestroy()
  assert.equal(f.timers.size, 0)
  assert.deepEqual(f.statusBars, [false, true])
})

test('failed continuation retains loaded text and retries exactly the unread offset', async () => {
  let failed = true
  const text = 'А'.repeat(1000) + 'Конец 🙂'
  const f = fixture(text, async ({ params }) => {
    if (params.offset && failed) return { ok: false, error: 'Нет связи' }
    const chars = Array.from(text), end = Math.min(chars.length, params.offset + params.limit)
    return { ok: true, id, offset: params.offset, text: chars.slice(params.offset, end).join(''),
      textLength: chars.length, nextOffset: end < chars.length ? end : null, truncated: false }
  })
  await drain(f)
  assert.equal(rowText(f), 'А'.repeat(1000))
  assert.equal(f.page.retry.options.visible, true)
  failed = false
  f.page.retry.options.click_func()
  await drain(f)
  assert.equal(rowText(f), text)
  assert.deepEqual(f.calls.map(x => x.params.offset), [0, 1000, 1000])
})

test('Back cancels automatic continuation before navigation', async () => {
  const f = fixture('А'.repeat(3000))
  await flush()
  const queued = [...f.timers.values()].find(x => x.delay === 0)
  assert.ok(queued)
  f.page.back.options.click_func()
  queued.callback()
  await flush()
  assert.equal(f.calls.length, 1)
  assert.equal(f.timers.size, 0)
})

test('Back restores the exact report job; Home clears the pending return view', async () => {
  const f = fixture('Готово')
  await flush()
  f.storage.set('musafir-context', JSON.stringify({ ...exactContext, openJob: false, autoRecord: true }))
  f.page.back.options.click_func()
  assert.deepEqual(JSON.parse(f.storage.get('musafir-context')), exactContext)
  assert.equal(f.replacements.at(-1).url, 'page/voice')

  f.page.home.options.click_func()
  assert.equal(f.storage.get('musafir-return-view'), '')
  assert.equal(f.replacements.at(-1).url, 'page/index')
})

test('right swipe and KEY_BACK use report Back and invalid context falls home', async () => {
  const f = fixture('Готово')
  await flush()
  assert.equal(f.interaction.gesture(10), true)
  assert.equal(f.replacements.at(-1).url, 'page/voice')
  assert.equal(f.interaction.key(20, 21), true)
  assert.equal(f.replacements.at(-1).url, 'page/voice')
  assert.equal(f.interaction.key(99, 21), false)

  const storage = new Map([
    ['musafir-report-job', id],
    ['musafir-context', JSON.stringify({ ...exactContext, jobId: '1700000000000-2' })],
    ['musafir-return-view', 'stale']
  ])
  const invalid = fixture('', null, { storage })
  assert.equal(invalid.calls.length, 0)
  assert.equal(rowText(invalid), 'Откройте ответ из выбранного чата.')
  invalid.page.back.options.click_func()
  assert.equal(invalid.replacements.at(-1).url, 'page/index')
  assert.equal(storage.get('musafir-return-view'), '')
})

test('loading, success, errors and all three device sizes keep compact safe geometry', async () => {
  for (const [width, height] of [[432, 514], [390, 450], [390, 400]]) {
    let finish
    const f = fixture('', () => new Promise(resolve => { finish = resolve }), { width, height })
    assertGeometry(f, width, height)
    await flush()
    finish({ ok: true, id, offset: 0, text: 'Ответ', textLength: 5, nextOffset: null, truncated: false })
    await flush()
    assertGeometry(f, width, height)
    assert.equal(f.page.body.options.y + f.page.body.options.h <= f.page.retry.options.y, true)
    f.page.onDestroy()
    assert.equal(f.interaction.offGesture, 1)
    assert.equal(f.interaction.offKey, 1)

    const error = fixture('', async () => ({ ok: false, error: 'Нет связи с Mac' }), { width, height })
    await flush()
    assert.equal(error.page.retry.options.text, 'Повторить загрузку')
    assertGeometry(error, width, height)
    error.page.onDestroy()
  }
})

test('malformed report and timeout clear the counter and expose a bounded retry', async () => {
  for (const overrides of [{ id: 'other' }, { truncated: undefined }, { nextOffset: 0 }, { textLength: 200001 }]) {
    const f = fixture('', async () => ({
      ok: true, id, offset: 0, text: 'x', textLength: 1, nextOffset: null, truncated: false, ...overrides
    }))
    await flush()
    assert.equal(f.page.error, true)
    assert.equal(f.page.retry.options.text, 'Повторить загрузку')
    assert.equal(f.page.retry.options.visible, true)
    f.page.onDestroy()
  }

  let finish
  const f = fixture('', () => new Promise(resolve => { finish = resolve }))
  await flush()
  const timer = [...f.timers.values()].find(item => item.delay === 18000)
  timer.callback()
  await flush()
  assert.equal(f.page.error, true)
  f.page.onDestroy()
  finish({ ok: true, id, text: 'late', offset: 0, textLength: 4, nextOffset: null, truncated: false })
  await flush()
  assert.notEqual(rowText(f), 'late')
})

test('incremental rows preserve Unicode and exact source offsets without rewrapping loaded content', () => {
  const content = ('Русский е\u0301 👨‍👩‍👧‍👦 العربية\n\n').repeat(2000)
  const chars = Array.from(content)
  let rows = [], measurements = 0
  for (let offset = 0; offset < chars.length; offset += 37) {
    rows = textRows(chars.slice(offset, offset + 37).join(''), 350, 20,
      () => { measurements++; return null }, rows)
  }
  assert.equal(rows.map(row => row.text + row.separator).join(''), content)
  for (const row of rows) assert.equal(content.slice(row.start, row.end), row.text)
  assert.ok(measurements < chars.length, 'work scales with new text, not all previously loaded text')
})
