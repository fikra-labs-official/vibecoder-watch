import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

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
    getDeviceInfo: () => ({ width, height }),
    setStatusBarVisible: value => statusBars.push(value),
    LocalStorage: class {
      getItem(key) { return values.get(key) }
      setItem(key, value) { values.set(key, value) }
    },
    replace(value) { replacements.push(value) },
    widget: { FILL_RECT: 1, TEXT: 2, BUTTON: 3 },
    align: { CENTER_H: 1, CENTER_V: 2, LEFT: 3, TOP: 4 },
    text_style: { WRAP: 1 },
    prop: { TEXT: 'text', MORE: 'more', VISIBLE: 'visible' },
    createWidget(kind, options) {
      const item = {
        kind,
        options: { ...options, visible: true },
        setProperty(property, value) {
          if (kind === 3 && property === 'text') throw new Error('BUTTON prop.TEXT is forbidden')
          if (kind === 3 && property === 'more') {
            for (const key of ['x', 'y', 'w', 'h']) assert.equal(Number.isFinite(value[key]), true, `BUTTON MORE ${key}`)
          }
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
  const nav = f.page.next.options
  assert.equal(body.y + body.h <= nav.y, true)
}

test('full report preserves Unicode while paging bounded chunks in both directions', async () => {
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
  assert.equal(collected, text)
  assert.ok(f.calls.length > 2)
  assert.equal(f.page.total, Array.from(text).length)
  const offset = f.page.offset
  f.page.page = 0
  f.page.turn(-1)
  await flush()
  assert.equal(f.page.offset, offset - 1000)
  assert.equal(f.page.page, f.page.pages.length - 1)
  assert.equal(f.page.previous.options.text, '‹')
  assert.equal(f.page.next.options.text, '›')
  f.page.onDestroy()
  assert.equal(f.timers.size, 0)
  assert.deepEqual(f.statusBars, [false, true])
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
  assert.equal(invalid.page.body.options.text, 'Откройте ответ из выбранного чата.')
  invalid.page.back.options.click_func()
  assert.equal(invalid.replacements.at(-1).url, 'page/index')
  assert.equal(storage.get('musafir-return-view'), '')
})

test('loading, success, errors and all three device sizes keep compact safe geometry', async () => {
  for (const [width, height] of [[432, 514], [390, 450], [390, 400]]) {
    let finish
    const f = fixture('', () => new Promise(resolve => { finish = resolve }), { width, height })
    assert.equal(f.page.counter.options.text, '')
    assertGeometry(f, width, height)
    await flush()
    finish({ ok: true, id, offset: 0, text: 'Ответ', textLength: 5, nextOffset: null, truncated: false })
    await flush()
    assertGeometry(f, width, height)
    assert.equal(f.page.body.options.y + f.page.body.options.h <= f.page.next.options.y, true)
    f.page.onDestroy()
    assert.equal(f.interaction.offGesture, 1)
    assert.equal(f.interaction.offKey, 1)

    const error = fixture('', async () => ({ ok: false, error: 'Нет связи с Mac' }), { width, height })
    await flush()
    assert.equal(error.page.next.options.text, 'Повторить')
    assert.equal(error.page.counter.options.text, '')
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
    assert.equal(f.page.counter.options.text, '')
    assert.equal(f.page.next.options.text, 'Повторить')
    assert.equal(f.page.next.options.visible, true)
    f.page.onDestroy()
  }

  let finish
  const f = fixture('', () => new Promise(resolve => { finish = resolve }))
  await flush()
  const timer = [...f.timers.values()].find(item => item.delay === 18000)
  timer.callback()
  await flush()
  assert.equal(f.page.error, true)
  assert.equal(f.page.counter.options.text, '')
  f.page.onDestroy()
  finish({ ok: true, id, text: 'late', offset: 0, textLength: 4, nextOffset: null, truncated: false })
  await flush()
  assert.notEqual(f.page.body.options.text, 'late')
})
