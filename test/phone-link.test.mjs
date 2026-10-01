import assert from 'node:assert/strict'
import { test } from 'node:test'
import { answerPhonePing, createPhoneProbe } from '../shared/phone-link.js'

const flush = () => new Promise(resolve => setImmediate(resolve))

function fixture() {
  let resolve, reject, deadline
  const states = [], sent = []
  let cleared = 0
  const probe = createPhoneProbe({
    request(payload) {
      sent.push(payload)
      return new Promise((yes, no) => { resolve = yes; reject = no })
    },
    report: state => states.push(state),
    setTimer: callback => { deadline = callback; return 1 },
    clearTimer: () => { cleared += 1 }
  })
  return { probe, states, sent, expire: () => deadline(),
    resolve: value => resolve(value), reject: () => reject(new Error('BLE disconnected')),
    cleared: () => cleared }
}

test('a matching phone response succeeds; double taps send only one request', async () => {
  const f = fixture()
  assert.equal(f.probe.start(), true)
  assert.equal(f.probe.start(), false)
  await flush()
  assert.equal(f.sent.length, 1)
  f.resolve(answerPhonePing(f.sent[0]))
  await flush()
  assert.deepEqual(f.states.at(-1), { state: 'ok', busy: false })
  assert.equal(f.cleared(), 1)
})

test('another request ID or protocol version cannot prove connectivity', async () => {
  for (const override of [{ requestId: '1-999' }, { version: 2 }]) {
    const f = fixture()
    f.probe.start()
    await flush()
    f.resolve({ ...answerPhonePing(f.sent[0]), ...override })
    await flush()
    assert.equal(f.states.at(-1).state, 'invalid')
  }
})

test('timeout covers an unresolved handshake and a late reply cannot become success', async () => {
  const f = fixture()
  f.probe.start()
  await flush()
  f.expire()
  assert.deepEqual(f.states.at(-1), { state: 'timeout', busy: true })
  assert.equal(f.probe.start(), false)
  f.resolve(answerPhonePing(f.sent[0]))
  await flush()
  assert.deepEqual(f.states.at(-1), { state: 'timeout', busy: false })
  assert.equal(f.states.some(x => x.state === 'ok'), false)
  assert.equal(f.probe.start(), true)
  f.probe.close()
  await flush()
})

test('closing the page suppresses late responses and clears its timer', async () => {
  const f = fixture()
  f.probe.start()
  await flush()
  f.probe.close()
  const count = f.states.length
  f.resolve(answerPhonePing(f.sent[0]))
  await flush()
  f.expire()
  assert.equal(f.states.length, count)
  assert.equal(f.probe.start(), false)
  assert.equal(f.cleared(), 1)
})

test('transport errors allow retry with a new request ID', async () => {
  const f = fixture()
  f.probe.start()
  await flush()
  f.reject()
  await flush()
  assert.deepEqual(f.states.at(-1), { state: 'error', busy: false })
  f.probe.start()
  await flush()
  assert.notEqual(f.sent[0].params.requestId, f.sent[1].params.requestId)
  f.probe.close()
  f.reject()
  await flush()
})

test('phone accepts only the bounded ping protocol', () => {
  for (const value of [null, {}, { method: 'SHELL' },
    { method: 'PHONE_PING', params: { version: 1, requestId: 'a'.repeat(1000) } },
    { method: 'PHONE_PING', params: { version: 2, requestId: '1-1' } }]) {
    assert.deepEqual(answerPhonePing(value), { ok: false, error: 'INVALID_REQUEST' })
  }
})

test('a synchronous transport failure clears the busy state', () => {
  const states = []
  const probe = createPhoneProbe({
    request: () => { throw new Error('Transport unavailable') },
    report: state => states.push(state),
    setTimer: () => 1,
    clearTimer: () => {}
  })
  probe.start()
  assert.deepEqual(states.at(-1), { state: 'error', busy: false })
  assert.equal(probe.start(), true)
  probe.close()
})
