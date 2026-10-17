import test from 'node:test'
import assert from 'node:assert/strict'
import { forwardRequest, forwardVoiceRequest, resolveConnection } from '../shared/bridge-client.js'

test('all four voice profiles forward explicit audio cancellation; Limits stays blocked', async () => {
  const payload = { method: 'AUDIO_CANCEL', params: { id: '1700000000000-1' } }
  let seen = null
  const fetchRequest = async options => {
    seen = JSON.parse(options.body)
    return { status: 200, body: { ok: true, id: payload.params.id, state: 'cancelled' } }
  }
  for (const profile of ['musafir', 'orca', 'claude', 'codex']) {
    seen = null
    const reply = await forwardVoiceRequest(payload, fetchRequest, 'https://mac.test', 'device-secret', profile)
    assert.deepEqual(seen, payload)
    assert.equal(reply.state, 'cancelled')
  }
  seen = null
  const blocked = await forwardRequest(payload, fetchRequest, 'https://mac.test', 'device-secret', 'limits')
  assert.equal(blocked.ok, false)
  assert.equal(seen, null)
})

test('phone forwards only allowed methods to a fixed authenticated destination', async () => {
  let seen
  const result = await forwardRequest({ method: 'SEND_TEXT', params: { id: '1-1', text: 'Привет' } },
    async options => { seen = options; return { status: 200, body: '{"ok":true,"state":"queued"}' } },
    'https://mac.test', 'device-secret')
  assert.equal(seen.url, 'https://mac.test/rpc')
  assert.equal(seen.timeout, 14000)
  assert.equal(seen.headers.Authorization, 'Bearer device-secret')
  assert.equal(JSON.parse(seen.body).params.text, 'Привет')
  assert.equal(result.state, 'queued')
  let called = false
  const invalid = await forwardRequest({ method: 'SHELL' }, () => { called = true }, '', '')
  assert.equal(called, false)
  assert.equal(invalid.ok, false)
})

test('profiles cannot forward each other routes and unknown profiles fail closed', async () => {
  let calls = 0
  const fetchRequest = async () => {
    calls += 1
    return { status: 200, body: { ok: true } }
  }
  for (const request of [
    { method: 'ORCA_LIST', profile: 'musafir' },
    { method: 'STATUS', profile: 'orca' },
    { method: 'LATEST_JOB', profile: 'orca' },
    { method: 'SEND_TEXT', profile: 'orca' },
    { method: 'JOB_APPROVE', profile: 'orca' },
    { method: 'AUDIO_STATUS', profile: 'unknown' },
    { method: 'AUDIO_STATUS', profile: 'toString' },
    { method: 'AUDIO_STATUS', profile: null }
  ]) {
    const result = await forwardRequest(
      { method: request.method }, fetchRequest, 'https://mac.test', 'device-secret', request.profile
    )
    assert.equal(result.ok, false)
  }
  assert.equal(calls, 0)
})

test('audio and diagnostics are shared but Orca RPC stays in the Orca profile', async () => {
  const seen = []
  const fetchRequest = async options => {
    seen.push(JSON.parse(options.body).method)
    return { status: 200, body: { ok: true } }
  }
  await forwardRequest(
    { method: 'AUDIO_BEGIN' }, fetchRequest, 'https://mac.test', 'device-secret', 'musafir'
  )
  await forwardRequest(
    { method: 'AUDIO_BEGIN' }, fetchRequest, 'https://mac.test', 'device-secret', 'orca'
  )
  await forwardRequest(
    { method: 'DIAGNOSTIC' }, fetchRequest, 'https://mac.test', 'device-secret', 'orca'
  )
  await forwardRequest(
    { method: 'ORCA_LIST' }, fetchRequest, 'https://mac.test', 'device-secret', 'orca'
  )
  assert.deepEqual(seen, ['AUDIO_BEGIN', 'AUDIO_BEGIN', 'DIAGNOSTIC', 'ORCA_LIST'])
})

test('project planning and decisions are forwarded only by the Orca profile', async () => {
  const seen = []
  const fetchRequest = async options => {
    seen.push(JSON.parse(options.body).method)
    return { status: 200, body: { ok: true } }
  }
  for (const method of ['ORCA_PROJECT_PLAN', 'ORCA_PROJECT_DECIDE']) {
    assert.equal((await forwardRequest({ method }, fetchRequest, '', '', 'orca')).ok, true)
    assert.equal((await forwardRequest({ method }, fetchRequest, '', '', 'musafir')).ok, false)
  }
  assert.deepEqual(seen, ['ORCA_PROJECT_PLAN', 'ORCA_PROJECT_DECIDE'])
})

test('phone handles object bodies, rejected tokens and malformed responses', async () => {
  const input = { method: 'STATUS' }
  assert.deepEqual(await forwardRequest(input, async () => ({ status: 200, body: { ok: true } }), '', ''), { ok: true })
  assert.equal((await forwardRequest(input, async () => ({ status: 401, body: { ok: false, error: 'Нет доступа' } }), '', '')).error, 'Нет доступа')
  await assert.rejects(forwardRequest(input, async () => ({ status: 200, body: 'bad json' }), '', ''))
})

test('phone forwards the bounded diagnostic method', async () => {
  let body
  const params = { version: '0.3.2', stage: 'recorder_start', detail: 'NotAllowedError' }
  const result = await forwardRequest({ method: 'DIAGNOSTIC', params }, async options => {
    body = JSON.parse(options.body)
    return { status: 200, body: { ok: true } }
  }, 'https://mac.test', 'device-secret')
  assert.deepEqual(body, { method: 'DIAGNOSTIC', params })
  assert.deepEqual(result, { ok: true })
})

test('history methods are available only to the Musafir profile', async () => {
  const methods = ['HISTORY_LIST', 'HISTORY_DETAIL', 'HISTORY_SET_DELETED', 'HISTORY_CURRENT']
  const seen = []
  const fetchRequest = async options => {
    seen.push(JSON.parse(options.body).method)
    return { status: 200, body: { ok: true } }
  }
  for (const method of methods) {
    assert.equal((await forwardRequest({ method }, fetchRequest, '', '', 'musafir')).ok, true)
    assert.equal((await forwardRequest({ method }, fetchRequest, '', '', 'orca')).ok, false)
  }
  assert.deepEqual(seen, methods)
})

test('Musafir chat RPCs cross the real phone forwarding path with exact params and stay isolated', async () => {
  const requests = [
    { method: 'CHAT_LIST', params: { offset: 3, limit: 3, archived: false } },
    { method: 'CHAT_DETAIL', params: { chatId: '1700000000000-4', offset: 2, limit: 2 } },
    { method: 'CHAT_ARCHIVE', params: { chatId: '1700000000000-4', archived: true } },
    { method: 'JOB_REPORT', params: { id: '1700000000001-4', offset: 1000, limit: 1000 } },
    { method: 'JOB_STOP', params: { id: '1700000000001-4' } }
  ]
  const forwarded = []
  const fetchRequest = async options => {
    forwarded.push(JSON.parse(options.body))
    return { status: 200, body: { ok: true } }
  }

  for (const request of requests) {
    assert.deepEqual(await forwardVoiceRequest(
      request, fetchRequest, 'https://mac.test', 'device-secret', 'musafir'
    ), { ok: true })
  }
  assert.deepEqual(forwarded, requests)

  for (const profile of ['orca', 'claude', 'codex', 'limits', 'unknown']) {
    for (const request of requests) {
      const before = forwarded.length
      const rejected = await forwardVoiceRequest(
        request, fetchRequest, 'https://mac.test', 'device-secret', profile
      )
      assert.equal(rejected.ok, false)
      assert.equal(forwarded.length, before, `${profile} must not forward ${request.method}`)
    }
  }
})

test('phone forwards a 30000-codepoint reviewed prompt without truncation', async () => {
  const text = '😀' + 'я'.repeat(29999)
  let forwarded
  const result = await forwardRequest(
    { method: 'SEND_TEXT', params: { id: '1-1', text } },
    async options => {
      forwarded = JSON.parse(options.body)
      return {
        status: 200,
        body: {
          ok: true, id: '1-1', state: 'queued',
          text: Array.from(text).slice(0, 1000).join(''), textLength: 30000
        }
      }
    },
    'https://mac.test',
    'device-secret'
  )
  assert.equal(Array.from(forwarded.params.text).length, 30000)
  assert.equal(forwarded.params.text, text)
  assert.equal(result.textLength, 30000)
  assert.equal(Array.from(result.text).length, 1000)
})

test('connection: Zepp settings win as a pair, baked values are the fallback, only https and a sane key pass', () => {
  const key = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE'
  const store = values => name => values[name]
  assert.deepEqual({ ...resolveConnection(store({ bridgeURL: 'https://mac.tail1.ts.net:8443/', deviceToken: key }), 'https://baked.ts.net:8443', 'baked-key-0123456789') },
    { url: 'https://mac.tail1.ts.net:8443', token: key })
  assert.deepEqual({ ...resolveConnection(store({ bridgeURL: '"https://mac.tail1.ts.net:8443"', deviceToken: `"${key}"` })) },
    { url: 'https://mac.tail1.ts.net:8443', token: key }, 'JSON-quoted values from the settings page are unwrapped')
  assert.deepEqual({ ...resolveConnection(store({ bridgeURL: 'https://mac.tail1.ts.net:8443' }), 'https://baked.ts.net:8443', 'baked-key-0123456789') },
    { url: 'https://baked.ts.net:8443', token: 'baked-key-0123456789' }, 'a half-filled form never mixes with the baked pair')
  assert.deepEqual({ ...resolveConnection(() => { throw new Error('no settings') }, 'https://baked.ts.net:8443', 'baked-key-0123456789') },
    { url: 'https://baked.ts.net:8443', token: 'baked-key-0123456789' })
  assert.equal(resolveConnection(store({}), '', ''), null, 'a public build without settings asks for them')
  assert.equal(resolveConnection(store({ bridgeURL: 'http://mac.ts.net:8443', deviceToken: key })), null, 'plain http is refused')
  assert.equal(resolveConnection(store({ bridgeURL: 'https://mac.ts.net:8443/evil path', deviceToken: key })), null)
  assert.equal(resolveConnection(store({ bridgeURL: 'https://mac.ts.net:8443', deviceToken: 'short' })), null)
})

test('corrected text chunks reach the bridge for all voice profiles and stay forbidden in Limits', async () => {
  for (const profile of ['musafir', 'orca', 'claude', 'codex']) {
    for (const method of ['TEXT_BEGIN', 'TEXT_PART', 'TEXT_FINISH']) {
      let seen
      const params = { id: '1700000000000-2', offset: 0, text: 'Исправлено 🕌' }
      const result = await forwardRequest({ method, params }, async options => {
        seen = JSON.parse(options.body)
        return { status: 200, body: { ok: true } }
      }, 'https://mac.test', 'device-secret', profile)
      assert.equal(result.ok, true)
      assert.deepEqual(seen, { method, params })
      assert.equal((await forwardRequest({ method }, () => { throw Error('must not forward') }, '', '', 'limits')).ok, false)
    }
  }
})
