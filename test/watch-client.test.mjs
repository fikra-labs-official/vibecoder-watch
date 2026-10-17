import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AUDIO_CHUNK_SIZE,
  encodeAudioPart,
  HANDSHAKE_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  createWatchClient
} from '../shared/watch-client.js'

const flush = () => new Promise(resolve => setImmediate(resolve))

test('compact encoding matches base64 including tails', () => {
  for (const size of [1, 2, 3, 1024, 6144]) {
    const bytes = Array.from({ length: size }, (_, i) => i % 256)
    assert.equal(encodeAudioPart(bytes), Buffer.from(bytes).toString('base64'))
  }
})

test('negotiated compact upload resumes legacy bytes and retries lost ACK exactly', async () => {
  const bytes = Array.from({ length: 8193 }, (_, i) => i % 256)
  let accepted = bytes.slice(0, 1024), lost = false
  const f = fixture(({ method, params: p }) => {
    if (method === 'AUDIO_BEGIN') return Promise.resolve({ ok: true, id: p.id,
      receivedBytes: accepted.length, totalBytes: bytes.length, chunkBytes: 6144, encoding: 'base64' })
    if (method === 'AUDIO_PART') {
      const part = [...Buffer.from(p.data, 'base64')]
      if (p.offset === accepted.length) accepted.push(...part)
      else assert.deepEqual(accepted.slice(p.offset, p.offset + part.length), part)
      if (!lost) { lost = true; return Promise.reject(new Error('lost receipt')) }
      return Promise.resolve({ ok: true, id: p.id, receivedBytes: accepted.length, totalBytes: bytes.length })
    }
    if (method === 'AUDIO_FINISH') return Promise.resolve({ ok: true, id: p.id, state: 'transcribing' })
    throw new Error(method)
  })
  await f.client.uploadAudio({ id: '123-1', totalBytes: bytes.length,
    readChunk: (offset, size) => bytes.slice(offset, offset + size) })
  assert.deepEqual(accepted, bytes)
  assert.deepEqual(f.sent.filter(x => x.payload.method === 'AUDIO_PART').map(x => x.payload.params.offset), [1024, 1024, 7168])
  assert.equal(f.states.at(-1).phase, 'transcribing')
  f.client.close()
})

test('approval screen keeps polling and exits when remote wait finishes', async () => {
  const f = fixture(({ method }) => {
    if (method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    if (method === 'LATEST_JOB') return Promise.resolve({ ok: true, job: { id: '123-1', state: 'approval',
      approval: { id: 'approval-1', text: 'complete action' } } })
    if (method === 'JOB_STATUS') return Promise.resolve({ ok: true, id: '123-1', state: 'completed', result: 'Expired' })
    throw new Error(method)
  })
  f.client.start()
  await flush()
  assert.equal(f.states.at(-1).phase, 'approval')
  f.clock.fireDelay(3000)
  await flush()
  assert.equal(f.states.at(-1).phase, 'result')
  assert.equal(f.sent.some(x => x.payload.method === 'JOB_APPROVE'), false)
  f.client.close()
})

test('safe reads retry one retryable phone-to-Mac failure', async () => {
  let statusCalls = 0
  const f = fixture(({ method }) => {
    if (method === 'STATUS') {
      statusCalls += 1
      if (statusCalls === 1) return Promise.resolve({ ok: false, code: 'BRIDGE_TRANSPORT',
        retryable: true, error: 'Mac temporarily unavailable' })
      return Promise.resolve({ ok: true, agent: 'Мусафир' })
    }
    if (method === 'LATEST_JOB') return Promise.resolve({ ok: true, job: null })
    throw new Error(method)
  })
  f.client.start()
  await flush()
  assert.equal(statusCalls, 2)
  assert.equal(f.client.getState().phase, 'ready')
  f.client.close()
})

test('audio status retries one retryable bridge reply for the same recording', async () => {
  let audioCalls = 0
  const f = fixture(({ method, params }) => {
    if (method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    if (method === 'LATEST_JOB') return Promise.resolve({ ok: true, job: {
      id: '123-10', state: 'transcribing'
    } })
    if (method === 'AUDIO_STATUS') {
      audioCalls += 1
      if (audioCalls === 1) return Promise.resolve({ ok: false, code: 'BRIDGE_HTTP',
        retryable: true, error: 'Bridge HTTP 503' })
      return Promise.resolve({ ok: true, id: params.id, state: 'ready', text: 'Готово' })
    }
    throw new Error(method)
  })
  f.client.start()
  await flush()
  f.clock.fireDelay(2000)
  await flush()
  assert.equal(audioCalls, 2)
  assert.equal(f.client.getState().phase, 'review')
  assert.equal(f.client.getState().text, 'Готово')
  f.client.close()
})

test('retryable reply flags never repeat SEND_TEXT or JOB_APPROVE mutations', async () => {
  let sendCalls = 0
  const send = fixture(({ method }) => {
    if (method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    if (method === 'LATEST_JOB') return Promise.resolve({ ok: true, job: {
      id: '123-11', state: 'ready', text: 'Команда'
    } })
    if (method === 'SEND_TEXT') {
      sendCalls += 1
      return Promise.resolve({ ok: false, code: 'BRIDGE_HTTP', retryable: true, error: 'Bridge HTTP 503' })
    }
    throw new Error(method)
  })
  send.client.start()
  await flush()
  assert.equal(send.client.sendText(), true)
  await flush()
  assert.equal(sendCalls, 1)
  assert.equal(send.client.getState().phase, 'unknown')
  send.client.close()

  let approvalCalls = 0
  const approval = fixture(({ method }) => {
    if (method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Claude' })
    if (method === 'LATEST_JOB') return Promise.resolve({ ok: true, job: {
      id: '123-12', state: 'approval', approval: { id: 'approval-12', text: 'Разрешить?' }
    } })
    if (method === 'JOB_APPROVE') {
      approvalCalls += 1
      return Promise.resolve({ ok: false, code: 'BRIDGE_TRANSPORT', retryable: true, error: 'Receipt unknown' })
    }
    throw new Error(method)
  })
  approval.client.start()
  await flush()
  assert.equal(approval.client.approve(true), true)
  await flush()
  assert.equal(approvalCalls, 1)
  assert.equal(approval.client.getState().phase, 'error')
  assert.equal(approval.client.getState().retryMethod, 'JOB_STATUS')
  approval.client.close()
})

test('safe reads do not retry false or malformed retryable flags', async () => {
  for (const reply of [
    { ok: false, retryable: false, error: 'Rejected' },
    { ok: false, retryable: 'true', error: 'Rejected' },
    { ok: false, retryable: 1, error: 'Rejected' },
    { ok: false, retryable: null, error: 'Rejected' },
    { ok: 'false', retryable: true, error: 'Malformed' },
    { retryable: true, error: 'Malformed' },
    null,
    false
  ]) {
    let calls = 0
    const f = fixture(({ method }) => {
      assert.equal(method, 'STATUS')
      calls += 1
      return Promise.resolve(reply)
    })
    f.client.start()
    await flush()
    assert.equal(calls, 1)
    assert.equal(f.client.getState().phase, 'error')
    f.client.close()
  }
})

function timers() {
  let nextId = 1
  const active = new Map()
  return {
    setTimer(callback, delay) {
      const id = nextId++
      active.set(id, { callback, delay })
      return id
    },
    clearTimer(id) {
      active.delete(id)
    },
    fireDelay(delay) {
      const entry = [...active.entries()].find(([, value]) => value.delay === delay)
      assert.ok(entry, `missing ${delay} ms timer`)
      active.delete(entry[0])
      entry[1].callback()
    },
    count() {
      return active.size
    }
  }
}

function fixture(handler, persistence = {}) {
  const clock = timers()
  const sent = []
  const states = []
  const client = createWatchClient({
    request(payload, options) {
      sent.push({ payload, options })
      return handler(payload, sent.length)
    },
    report: state => states.push(state),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: () => 123456789,
    ...persistence
  })
  return { client, sent, states, clock }
}

test('audio is chunked sequentially and text is sent only after explicit confirmation', async () => {
  let receivedBytes = 0
  const f = fixture(payload => {
    if (payload.method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    if (payload.method === 'LATEST_JOB') return Promise.resolve({ ok: true, job: null })
    if (payload.method === 'AUDIO_BEGIN') {
      return Promise.resolve({ ok: true, id: payload.params.id,
        receivedBytes, totalBytes: payload.params.totalBytes })
    }
    if (payload.method === 'AUDIO_CHUNK') {
      receivedBytes = payload.params.index * AUDIO_CHUNK_SIZE + payload.params.data.length
      return Promise.resolve({ ok: true, id: payload.params.id,
        receivedBytes, totalBytes: AUDIO_CHUNK_SIZE * 2 + 2 })
    }
    if (payload.method === 'AUDIO_FINISH') {
      return Promise.resolve({ ok: true, id: payload.params.id, state: 'transcribing' })
    }
    if (payload.method === 'AUDIO_STATUS') {
      return Promise.resolve({ ok: true, id: payload.params.id, state: 'ready', text: 'Открой календарь' })
    }
    if (payload.method === 'SEND_TEXT') {
      return Promise.resolve({ ok: true, id: payload.params.id, state: 'queued', text: payload.params.text })
    }
    throw new Error(`unexpected ${payload.method}`)
  })

  f.client.start()
  await flush()
  const id = f.client.createId()
  assert.equal(f.client.beginRecording(id), true)

  const bytes = Array.from({ length: AUDIO_CHUNK_SIZE * 2 + 2 }, (_, index) => index % 256)
  let offset = 0
  await f.client.uploadAudio({
    id,
    totalBytes: bytes.length,
    readChunk(position, length) {
      assert.equal(position, offset)
      const chunk = bytes.slice(position, position + length)
      offset = position + chunk.length
      return chunk
    }
  })

  const chunks = f.sent.filter(item => item.payload.method === 'AUDIO_CHUNK')
  assert.deepEqual(chunks.map(item => item.payload.params.index), [0, 1, 2])
  assert.deepEqual(chunks.map(item => item.payload.params.data.length), [1024, 1024, 2])
  assert.equal(f.sent.some(item => item.payload.method === 'SEND_TEXT'), false)

  f.clock.fireDelay(2000)
  await flush()
  assert.equal(f.states.at(-1).phase, 'review')
  assert.equal(f.states.at(-1).text, 'Открой календарь')
  assert.equal(f.client.sendText(), true)
  await flush()

  const command = f.sent.find(item => item.payload.method === 'SEND_TEXT')
  assert.deepEqual(command.payload.params, { id, text: 'Открой календарь' })
  assert.equal(f.states.at(-1).phase, 'job')
  for (const item of f.sent) assert.equal(item.options.timeout, REQUEST_TIMEOUT_MS)
  f.client.close()
})

test('interrupted upload resumes the same id from authoritative received bytes', async () => {
  let receivedBytes = 0
  let failures = 0
  const id = '123456789-1'
  const totalBytes = AUDIO_CHUNK_SIZE * 2 + 3
  const bytes = Array.from({ length: totalBytes }, (_, index) => index % 251)
  const f = fixture(payload => {
    if (payload.method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    if (payload.method === 'LATEST_JOB') return Promise.resolve({ ok: true, job: null })
    if (payload.method === 'AUDIO_BEGIN') {
      return Promise.resolve({ ok: true, id, receivedBytes, totalBytes })
    }
    if (payload.method === 'AUDIO_CHUNK') {
      if (payload.params.index === 1 && failures++ < 2) {
        return Promise.reject(new Error('BLE disconnected'))
      }
      receivedBytes = payload.params.index * AUDIO_CHUNK_SIZE + payload.params.data.length
      return Promise.resolve({ ok: true, id, receivedBytes, totalBytes })
    }
    if (payload.method === 'AUDIO_FINISH') {
      return Promise.resolve({ ok: true, id, state: 'transcribing' })
    }
    throw new Error(`unexpected ${payload.method}`)
  })

  f.client.start()
  await flush()
  f.client.beginRecording(id)
  const reads = []
  const accepted = []
  assert.equal(await f.client.uploadAudio({
    id,
    totalBytes,
    readChunk(position, length) {
      reads.push([position, length])
      return bytes.slice(position, position + length)
    },
    onAccepted: value => accepted.push(value)
  }), false)
  assert.equal(f.states.at(-1).retryMethod, 'AUDIO_UPLOAD')
  assert.equal(f.states.at(-1).retryId, id)

  f.client.refresh()
  await flush()
  assert.deepEqual(
    f.sent.filter(item => item.payload.method === 'AUDIO_BEGIN').map(item => item.payload.params.id),
    [id, id]
  )
  assert.deepEqual(reads, [
    [0, 1024], [1024, 1024],
    [1024, 1024], [2048, 3]
  ])
  assert.deepEqual(accepted, [id])
  assert.equal(f.sent.some(item => item.payload.method === 'SEND_TEXT'), false)
  assert.equal(f.states.at(-1).phase, 'transcribing')
  f.client.close()
})

test('long Unicode transcript is fetched in bounded pages and submitted by stored text id', async () => {
  const text = `${'а'.repeat(999)}🙂${'б'.repeat(1501)}`
  const codepoints = Array.from(text)
  const id = '123456789-1'
  const offsets = []
  const f = fixture(payload => {
    if (payload.method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    if (payload.method === 'LATEST_JOB') {
      return Promise.resolve({ ok: true, job: { id, state: 'transcribing' } })
    }
    if (payload.method === 'AUDIO_STATUS') {
      const { textOffset, textLimit } = payload.params
      offsets.push(textOffset)
      const page = codepoints.slice(textOffset, textOffset + textLimit).join('')
      const end = textOffset + Array.from(page).length
      return Promise.resolve({
        ok: true, id, state: 'ready', text: page,
        textOffset, textLength: codepoints.length, textComplete: end === codepoints.length,
        receivedBytes: 1, totalBytes: 1
      })
    }
    if (payload.method === 'SEND_TEXT') {
      assert.deepEqual(payload.params, { id, textId: id })
      return Promise.resolve({ ok: true, id, state: 'queued' })
    }
    throw new Error(`unexpected ${payload.method}`)
  })

  f.client.start()
  await flush()
  f.clock.fireDelay(2000)
  await flush()
  await flush()
  assert.deepEqual(offsets, [0, 1000, 2000])
  assert.equal(f.states.at(-1).phase, 'review')
  assert.equal(f.states.at(-1).text, text)
  assert.equal(Array.from(f.states.at(-1).text).length, 2501)
  assert.equal(f.client.getReviewedId(), id)
  assert.equal(f.client.sendText(), true)
  await flush()
  assert.equal(f.states.at(-1).phase, 'job')
  f.client.close()
})

test('the 20 second guard covers an unresolved handshake and ignores a late reply', async () => {
  const statusResolvers = []
  const f = fixture(payload => {
    assert.equal(payload.method, 'STATUS')
    return new Promise(resolve => { statusResolvers.push(resolve) })
  })

  f.client.start()
  await flush()
  f.clock.fireDelay(HANDSHAKE_TIMEOUT_MS)
  await flush()
  assert.equal(statusResolvers.length, 2)
  f.clock.fireDelay(HANDSHAKE_TIMEOUT_MS)
  await flush()
  assert.equal(f.states.at(-1).phase, 'error')
  assert.equal(f.states.at(-1).error, 'Телефон не ответил')

  statusResolvers[0]({ ok: true, agent: 'Мусафир' })
  await flush()
  assert.equal(f.states.some(state => state.phase === 'ready'), false)
  f.client.close()
})

test('unknown status refreshes the same job and never resends the command', async () => {
  const f = fixture(payload => {
    if (payload.method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    if (payload.method === 'LATEST_JOB') {
      return Promise.resolve({ ok: true, job: { id: '123-1', state: 'unknown', text: 'Проверь задачу' } })
    }
    if (payload.method === 'JOB_STATUS') {
      return Promise.resolve({ ok: true, id: payload.params.id, state: 'unknown', text: 'Проверь задачу' })
    }
    throw new Error(`unexpected ${payload.method}`)
  })

  f.client.start()
  await flush()
  assert.equal(f.states.at(-1).phase, 'unknown')
  f.client.refresh()
  await flush()

  const status = f.sent.find(item => item.payload.method === 'JOB_STATUS')
  assert.equal(status.payload.params.id, '123-1')
  assert.equal(f.sent.some(item => item.payload.method === 'SEND_TEXT'), false)
  f.client.close()
})

test('refresh during transcription checks audio status instead of latest job', async () => {
  const f = fixture(payload => {
    if (payload.method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    if (payload.method === 'LATEST_JOB') {
      return Promise.resolve({ ok: true, job: { id: '123-3', state: 'transcribing' } })
    }
    if (payload.method === 'AUDIO_STATUS') {
      return Promise.resolve({ ok: true, id: '123-3', state: 'ready', text: 'Готовый текст' })
    }
    throw new Error(`unexpected ${payload.method}`)
  })

  f.client.start()
  await flush()
  assert.equal(f.states.at(-1).phase, 'transcribing')
  f.client.refresh()
  await flush()

  assert.equal(f.sent.filter(item => item.payload.method === 'LATEST_JOB').length, 1)
  assert.equal(f.sent.filter(item => item.payload.method === 'AUDIO_STATUS').length, 1)
  assert.equal(f.states.at(-1).phase, 'review')
  assert.equal(f.states.at(-1).text, 'Готовый текст')
  f.client.close()
})

test('failed transcription refresh retries audio status for the same recording', async () => {
  let audioChecks = 0
  const f = fixture(payload => {
    if (payload.method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    if (payload.method === 'LATEST_JOB') {
      return Promise.resolve({ ok: true, job: { id: '123-6', state: 'transcribing' } })
    }
    if (payload.method === 'AUDIO_STATUS') {
      audioChecks += 1
      if (audioChecks <= 2) return Promise.reject(new Error('BLE disconnected'))
      return Promise.resolve({ ok: true, id: '123-6', state: 'ready', text: 'Повтор сработал' })
    }
    throw new Error(`unexpected ${payload.method}`)
  })

  f.client.start()
  await flush()
  f.clock.fireDelay(2000)
  await flush()
  assert.equal(f.states.at(-1).phase, 'error')
  assert.equal(f.states.at(-1).retryMethod, 'AUDIO_STATUS')
  assert.equal(f.states.at(-1).retryId, '123-6')

  f.client.refresh()
  await flush()
  assert.deepEqual(
    f.sent.filter(item => item.payload.method === 'AUDIO_STATUS')
      .map(item => item.payload.params.id),
    ['123-6', '123-6', '123-6']
  )
  assert.equal(f.sent.filter(item => item.payload.method === 'LATEST_JOB').length, 1)
  assert.equal(f.sent.some(item => item.payload.method === 'JOB_STATUS'), false)
  assert.equal(f.states.at(-1).phase, 'review')
  f.client.close()
})

test('ASR error retries AUDIO_FINISH for the same accepted audio without reuploading', async () => {
  let audioChecks = 0
  const id = '123-8'
  const f = fixture(payload => {
    if (payload.method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    if (payload.method === 'LATEST_JOB') {
      return Promise.resolve({ ok: true, job: { id, state: 'transcribing' } })
    }
    if (payload.method === 'AUDIO_STATUS') {
      audioChecks += 1
      if (audioChecks === 1) {
        return Promise.resolve({ ok: true, id, state: 'error', error: 'ASR unavailable' })
      }
      return Promise.resolve({ ok: true, id, state: 'ready', text: 'Сохранённая запись' })
    }
    if (payload.method === 'AUDIO_FINISH') {
      return Promise.resolve({ ok: true, id, state: 'transcribing' })
    }
    throw new Error(`unexpected ${payload.method}`)
  })

  f.client.start()
  await flush()
  f.clock.fireDelay(2000)
  await flush()
  assert.equal(f.states.at(-1).phase, 'error')
  assert.equal(f.states.at(-1).retryMethod, 'AUDIO_FINISH')
  assert.equal(f.states.at(-1).retryId, id)

  f.client.refresh()
  await flush()
  assert.equal(f.states.at(-1).phase, 'transcribing')
  f.clock.fireDelay(2000)
  await flush()
  assert.equal(f.states.at(-1).phase, 'review')
  assert.equal(f.sent.filter(item => item.payload.method === 'AUDIO_FINISH').length, 1)
  assert.equal(f.sent.some(item => item.payload.method === 'AUDIO_BEGIN'), false)
  assert.equal(f.sent.some(item => item.payload.method === 'SEND_TEXT'), false)
  f.client.close()
})

test('lost SEND_TEXT reply becomes refreshable unknown state with the same id', async () => {
  const f = fixture(payload => {
    if (payload.method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    if (payload.method === 'LATEST_JOB') {
      return Promise.resolve({
        ok: true,
        job: { id: '123-4', state: 'ready', text: 'Открой календарь' }
      })
    }
    if (payload.method === 'SEND_TEXT') return Promise.reject(new Error('BLE disconnected'))
    if (payload.method === 'JOB_STATUS') {
      return Promise.resolve({ ok: true, id: '123-4', state: 'submitting', text: 'Открой календарь' })
    }
    throw new Error(`unexpected ${payload.method}`)
  })

  f.client.start()
  await flush()
  assert.equal(f.client.sendText(), true)
  await flush()
  assert.equal(f.states.at(-1).phase, 'unknown')
  assert.equal(f.states.at(-1).jobId, '123-4')

  f.client.refresh()
  await flush()
  const status = f.sent.find(item => item.payload.method === 'JOB_STATUS')
  assert.equal(status.payload.params.id, '123-4')
  assert.equal(f.states.at(-1).phase, 'job')
  assert.equal(f.states.at(-1).state, 'submitting')
  f.client.close()
})

test('approval returns the exact current approval id and explicit decision', async () => {
  const proposal = 'Запустить команду на Mac: open -a Calendar'
  const f = fixture(payload => {
    if (payload.method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    if (payload.method === 'LATEST_JOB') {
      return Promise.resolve({
        ok: true,
        job: { id: '123-2', state: 'approval', approval: { id: 'approval-7', text: proposal } }
      })
    }
    if (payload.method === 'JOB_APPROVE') {
      return Promise.resolve({ ok: true, id: payload.params.id, state: 'completed', result: 'Отказано' })
    }
    throw new Error(`unexpected ${payload.method}`)
  })

  f.client.start()
  await flush()
  assert.equal(f.states.at(-1).approvalText, proposal)
  assert.equal(f.client.approve(false), true)
  await flush()

  const approval = f.sent.find(item => item.payload.method === 'JOB_APPROVE')
  assert.deepEqual(approval.payload.params, {
    id: '123-2', approvalId: 'approval-7', allow: false
  })
  assert.equal(f.states.at(-1).phase, 'result')
  f.client.close()
})

test('approval without a safe proposal stays refresh-only for a decision on Mac', async () => {
  const f = fixture(payload => {
    if (payload.method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    if (payload.method === 'LATEST_JOB') {
      return Promise.resolve({
        ok: true,
        job: { id: '123-5', state: 'approval', result: 'Нужно решение на Mac' }
      })
    }
    throw new Error(`unexpected ${payload.method}`)
  })

  f.client.start()
  await flush()
  assert.equal(f.states.at(-1).phase, 'approval')
  assert.equal(f.states.at(-1).approvalId, null)
  assert.equal(f.states.at(-1).approvalText, 'Нужно решение на Mac')
  assert.equal(f.client.approve(true), false)
  assert.equal(f.sent.some(item => item.payload.method === 'JOB_APPROVE'), false)
  f.client.close()
})

test('starting a new recording clears a recovered stale job id', async () => {
  const f = fixture(payload => {
    if (payload.method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    if (payload.method === 'LATEST_JOB') {
      return Promise.resolve({ ok: true, job: { id: 'old-1', state: 'completed', result: 'Старый ответ' } })
    }
    throw new Error(`unexpected ${payload.method}`)
  })

  f.client.start()
  await flush()
  const id = f.client.createId()
  assert.equal(f.client.beginRecording(id), true)
  assert.equal(f.client.getState().jobId, null)
  f.client.close()
})

test('an acknowledged recovered response stays available without reopening it', async () => {
  const f = fixture(payload => {
    if (payload.method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    if (payload.method === 'LATEST_JOB') {
      return Promise.resolve({
        ok: true,
        job: { id: 'old-2', state: 'completed', text: 'Старая команда', result: 'Старый ответ' }
      })
    }
    throw new Error(`unexpected ${payload.method}`)
  }, {
    readAcknowledgedResultId: () => 'old-2'
  })

  f.client.start()
  await flush()
  assert.equal(f.client.getState().phase, 'ready')
  assert.equal(f.client.getState().hasLastResult, true)
  assert.equal(f.states.some(state => state.phase === 'result'), false)

  assert.equal(f.client.showLastResult(), true)
  assert.equal(f.client.getState().phase, 'result')
  assert.equal(f.client.getState().result, 'Старый ответ')
  assert.equal(f.client.home(), true)
  assert.equal(f.client.getState().phase, 'ready')
  assert.equal(f.client.getState().hasLastResult, true)
  f.client.close()
})

test('a result completed after page destruction opens on the next client', async () => {
  let job = { id: 'late-1', state: 'running', text: 'Какая погода?' }
  const handler = payload => {
    if (payload.method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    if (payload.method === 'LATEST_JOB') return Promise.resolve({ ok: true, job })
    throw new Error(`unexpected ${payload.method}`)
  }

  const first = fixture(handler)
  first.client.start()
  await flush()
  assert.equal(first.client.getState().phase, 'job')
  first.client.close()

  job = { id: 'late-1', state: 'completed', text: 'Какая погода?', result: 'В Каире ясно' }
  const reopened = fixture(handler)
  reopened.client.start()
  await flush()
  assert.equal(reopened.client.getState().phase, 'result')
  assert.equal(reopened.client.getState().result, 'В Каире ясно')
  reopened.client.close()
})

test('closing while reading a result does not acknowledge it', async () => {
  let acknowledgedId = null
  const job = { id: 'sleep-1', state: 'completed', result: 'Ответ остаётся непрочитанным' }
  const handler = payload => {
    if (payload.method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    if (payload.method === 'LATEST_JOB') return Promise.resolve({ ok: true, job })
    throw new Error(`unexpected ${payload.method}`)
  }
  const persistence = {
    readAcknowledgedResultId: () => acknowledgedId,
    writeAcknowledgedResultId: id => { acknowledgedId = id }
  }

  const first = fixture(handler, persistence)
  first.client.start()
  await flush()
  assert.equal(first.client.getState().phase, 'result')
  first.client.close()
  assert.equal(acknowledgedId, null)

  const reopened = fixture(handler, persistence)
  reopened.client.start()
  await flush()
  assert.equal(reopened.client.getState().phase, 'result')
  reopened.client.close()
})

test('home and a new recording explicitly acknowledge the result', async () => {
  let acknowledgedId = null
  let job = { id: 'ack-home', state: 'completed', result: 'Первый ответ' }
  const handler = payload => {
    if (payload.method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    if (payload.method === 'LATEST_JOB') return Promise.resolve({ ok: true, job })
    throw new Error(`unexpected ${payload.method}`)
  }
  const persistence = {
    readAcknowledgedResultId: () => acknowledgedId,
    writeAcknowledgedResultId: id => { acknowledgedId = id }
  }

  const homeClient = fixture(handler, persistence)
  homeClient.client.start()
  await flush()
  assert.equal(homeClient.client.home(), true)
  assert.equal(acknowledgedId, 'ack-home')
  homeClient.client.close()

  const afterHome = fixture(handler, persistence)
  afterHome.client.start()
  await flush()
  assert.equal(afterHome.client.getState().phase, 'ready')
  assert.equal(afterHome.client.getState().hasLastResult, true)
  assert.equal(afterHome.client.showLastResult(), true)
  afterHome.client.close()

  acknowledgedId = null
  job = { id: 'ack-record', state: 'completed', result: 'Второй ответ' }
  const recordClient = fixture(handler, persistence)
  recordClient.client.start()
  await flush()
  assert.equal(recordClient.client.beginRecording(recordClient.client.createId()), true)
  assert.equal(acknowledgedId, 'ack-record')
  recordClient.client.close()

  const afterRecord = fixture(handler, persistence)
  afterRecord.client.start()
  await flush()
  assert.equal(afterRecord.client.getState().phase, 'ready')
  afterRecord.client.close()
})

test('storage failures cannot hide an unacknowledged result', async () => {
  const job = { id: 'storage-1', state: 'completed', result: 'Ответ пережил ошибку хранилища' }
  const handler = payload => {
    if (payload.method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    if (payload.method === 'LATEST_JOB') return Promise.resolve({ ok: true, job })
    throw new Error(`unexpected ${payload.method}`)
  }
  const brokenPersistence = {
    readAcknowledgedResultId() { throw new Error('read failed') },
    writeAcknowledgedResultId() { throw new Error('write failed') }
  }

  const first = fixture(handler, brokenPersistence)
  first.client.start()
  await flush()
  assert.equal(first.client.getState().phase, 'result')
  assert.equal(first.client.home(), true)
  first.client.close()

  const reopened = fixture(handler, brokenPersistence)
  reopened.client.start()
  await flush()
  assert.equal(reopened.client.getState().phase, 'result')
  assert.equal(reopened.client.getState().result, 'Ответ пережил ошибку хранилища')
  reopened.client.close()
})

test('recording cannot replace active or unresolved accepted work', async () => {
  let failStatus = false
  const f = fixture(payload => {
    if (payload.method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    if (payload.method === 'LATEST_JOB') {
      return Promise.resolve({
        ok: true,
        job: { id: '123-7', state: 'running', text: 'Активная команда' }
      })
    }
    if (payload.method === 'JOB_STATUS') {
      if (failStatus) return Promise.reject(new Error('BLE disconnected'))
      return Promise.resolve({ ok: true, id: '123-7', state: 'unknown', text: 'Активная команда' })
    }
    throw new Error(`unexpected ${payload.method}`)
  })

  f.client.start()
  await flush()
  assert.equal(f.client.getState().phase, 'job')
  assert.equal(f.client.beginRecording(f.client.createId()), false)

  f.client.refresh()
  await flush()
  assert.equal(f.client.getState().phase, 'unknown')
  assert.equal(f.client.beginRecording(f.client.createId()), false)

  failStatus = true
  f.client.refresh()
  await flush()
  assert.equal(f.client.getState().phase, 'error')
  assert.equal(f.client.getState().retryMethod, 'JOB_STATUS')
  assert.equal(f.client.beginRecording(f.client.createId()), false)
  assert.equal(f.client.home(), false)
  f.client.close()
})

test('local recording errors can start over and cancellation returns home', async () => {
  const f = fixture(payload => {
    if (payload.method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    if (payload.method === 'LATEST_JOB') return Promise.resolve({ ok: true, job: null })
    throw new Error(`unexpected ${payload.method}`)
  })

  f.client.start()
  await flush()
  f.client.failLocal('Нет записи')
  const id = f.client.createId()
  assert.equal(f.client.beginRecording(id), true)
  assert.equal(f.client.beginRecording(f.client.createId()), false)
  f.client.cancelRecording()
  assert.equal(f.client.getState().phase, 'ready')
  f.client.close()
})

test('closing cancels timers and suppresses late state changes', async () => {
  let resolveStatus
  const f = fixture(() => new Promise(resolve => { resolveStatus = resolve }))
  f.client.start()
  await flush()
  const count = f.states.length
  f.client.close()
  assert.equal(f.clock.count(), 0)
  resolveStatus({ ok: true, agent: 'Мусафир' })
  await flush()
  assert.equal(f.states.length, count)
})

test('an agent question carries its options and the chosen answer travels with the approval', async () => {
  const f = fixture(payload => {
    if (payload.method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Claude' })
    if (payload.method === 'LATEST_JOB') return Promise.resolve({ ok: true, job: { id: '123-9', state: 'approval',
      approval: { id: 'q-1', text: 'Вопрос:\nКакой цвет?', question: 'Какой цвет?', options: ['Красный', 'Синий'], step: '1/1' } } })
    if (payload.method === 'JOB_APPROVE') return Promise.resolve({ ok: true, id: '123-9', state: 'running' })
    throw new Error(`unexpected ${payload.method}`)
  })
  f.client.start()
  await flush()
  const shown = f.states.at(-1)
  assert.deepEqual([shown.approvalQuestion, shown.approvalOptions, shown.approvalStep], ['Какой цвет?', ['Красный', 'Синий'], '1/1'])
  assert.equal(f.client.approve(true, 'Синий'), true)
  await flush()
  const approval = f.sent.find(item => item.payload.method === 'JOB_APPROVE')
  assert.deepEqual(approval.payload.params, { id: '123-9', approvalId: 'q-1', allow: true, answer: 'Синий' })
  f.client.close()
})

test('manual review edits are validated, persisted, and get a new id after every change', async () => {
  let draft = null
  const writes = []
  const f = fixture(payload => {
    if (payload.method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    if (payload.method === 'LATEST_JOB') return Promise.resolve({ ok: true, job: {
      id: '123-1', state: 'ready', text: 'Исходный текст'
    } })
    throw new Error(`unexpected ${payload.method}`)
  }, {
    readDraft: () => draft,
    writeDraft: value => { draft = value; writes.push(value) }
  })
  f.client.start()
  await flush()

  for (const invalid of ['', '   ', 'a\0b', 'a\rb', 'a\u0085b', '\ud800', 'x'.repeat(30001)]) {
    assert.throws(() => f.client.updateReviewText(invalid))
  }
  assert.deepEqual(writes, [{
    id: '123-1', text: 'Исходный текст', textId: null,
    edited: false, draftId: null, typed: false,
    sourceId: '123-1', pendingSend: false
  }])

  assert.equal(f.client.updateReviewText('Исправлено 🙂'), true)
  const firstId = draft.draftId
  assert.deepEqual(draft, {
    id: '123-1', text: 'Исправлено 🙂', textId: null,
    edited: true, draftId: firstId, typed: false,
    sourceId: '123-1', pendingSend: false
  })
  assert.equal(f.client.getState().edited, true)
  assert.equal(f.client.getState().text, 'Исправлено 🙂')

  assert.equal(f.client.updateReviewText('Исправлено ещё раз'), true)
  assert.notEqual(draft.draftId, firstId)
  assert.equal(draft.text, 'Исправлено ещё раз')
  assert.equal(f.client.updateReviewText('Строка\nс табом\tи семьёй 👨‍👩‍👧‍👦'), true)
  assert.match(draft.text, /👨‍👩‍👧‍👦/)
  f.client.close()
})

test('typed compose preserves exact Unicode whitespace and uploads only after explicit Send', async () => {
  let draft = null
  const text = `  ${'а'.repeat(998)}🙂${'б'.repeat(1001)}\n`
  const parts = []
  const f = fixture(({ method, params }) => {
    if (method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    if (method === 'LATEST_JOB') return Promise.resolve({ ok: true, job: null })
    if (method === 'TEXT_BEGIN') {
      assert.deepEqual(params, { id: draft.id, sourceId: null,
        textLength: Array.from(text).length })
      return Promise.resolve({ ok: true, id: params.id, textLength: params.textLength,
        receivedLength: 0 })
    }
    if (method === 'TEXT_PART') {
      parts.push(params)
      return Promise.resolve({ ok: true, id: params.id,
        textLength: Array.from(text).length,
        receivedLength: params.offset + Array.from(params.text).length })
    }
    if (method === 'TEXT_FINISH') return Promise.resolve({ ok: true, id: params.id,
      state: 'ready', textLength: Array.from(text).length })
    if (method === 'SEND_TEXT') {
      assert.deepEqual(params, { id: draft.id, textId: draft.id })
      return Promise.resolve({ ok: true, id: params.id, state: 'queued' })
    }
    throw new Error(`unexpected ${method}`)
  }, {
    readDraft: () => draft,
    writeDraft: value => { draft = value }
  })
  f.client.start()
  await flush()
  assert.equal(f.client.createTypedReview(text), true)
  assert.equal(f.client.getState().text, text)
  assert.deepEqual(draft, { id: draft.id, text, textId: null, edited: true,
    draftId: draft.id, typed: true, sourceId: null, pendingSend: false })
  assert.deepEqual(f.sent.map(item => item.payload.method), ['STATUS', 'LATEST_JOB'])

  assert.equal(f.client.sendText(), true)
  await flush()
  assert.deepEqual(parts.map(part => Array.from(part.text).length), [1000, 1000, 3])
  assert.equal(parts.map(part => part.text).join(''), text)
  assert.equal(f.sent.filter(item => item.payload.method === 'SEND_TEXT').length, 1)
  f.client.close()
})

test('editing a typed draft after a partial upload creates a new immutable job id', async () => {
  let draft = null
  const begins = []
  const sends = []
  const f = fixture(({ method, params }) => {
    if (method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    if (method === 'LATEST_JOB') return Promise.resolve({ ok: true, job: null })
    if (method === 'TEXT_BEGIN') {
      begins.push(params)
      return Promise.resolve({ ok: true, id: params.id, textLength: params.textLength,
        receivedLength: 0 })
    }
    if (method === 'TEXT_PART') {
      if (params.id === begins[0].id) {
        return Promise.reject(new Error('partial write lost'))
      }
      return Promise.resolve({ ok: true, id: params.id,
        textLength: Array.from(draft.text).length,
        receivedLength: params.offset + Array.from(params.text).length })
    }
    if (method === 'TEXT_FINISH') return Promise.resolve({ ok: true, id: params.id,
      state: 'ready', textLength: Array.from(draft.text).length })
    if (method === 'SEND_TEXT') {
      sends.push(params)
      return Promise.resolve({ ok: true, id: params.id, state: 'queued' })
    }
    throw new Error(`unexpected ${method}`)
  }, {
    readDraft: () => draft,
    writeDraft: value => { draft = value }
  })
  f.client.start()
  await flush()
  f.client.createTypedReview('Первый текст')
  const firstId = draft.id
  f.client.sendText()
  await flush()
  assert.equal(f.client.getState().phase, 'review')
  assert.equal(draft.id, firstId)

  f.client.updateReviewText('Исправленный текст')
  const secondId = draft.id
  assert.notEqual(secondId, firstId)
  assert.equal(draft.draftId, secondId)
  f.client.sendText()
  await flush()
  assert.deepEqual(begins.map(item => item.id), [firstId, secondId])
  assert.deepEqual(begins.map(item => item.sourceId), [null, null])
  assert.deepEqual(sends, [{ id: secondId, textId: secondId }])
  f.client.close()
})

test('canceling text save fences its late reply and never sends the command', async () => {
  let draft = null
  let resolveBegin
  const f = fixture(({ method, params }) => {
    if (method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    if (method === 'LATEST_JOB') return Promise.resolve({ ok: true, job: null })
    if (method === 'TEXT_BEGIN') return new Promise(resolve => { resolveBegin = () => resolve({
      ok: true, id: params.id, textLength: params.textLength, receivedLength: 0
    }) })
    throw new Error(`unexpected ${method}`)
  }, {
    readDraft: () => draft,
    writeDraft: value => { draft = value }
  })
  f.client.start()
  await flush()
  f.client.createTypedReview('Не отправлять')
  assert.equal(f.client.sendText(), true)
  assert.equal(f.client.getState().phase, 'saving-text')
  assert.equal(f.client.cancelBeforeSend(), true)
  assert.equal(f.client.getState().phase, 'review')
  resolveBegin()
  await flush()
  assert.equal(f.client.getState().phase, 'review')
  assert.equal(draft.pendingSend, false)
  assert.equal(f.sent.some(item => ['TEXT_PART', 'TEXT_FINISH', 'SEND_TEXT']
    .includes(item.payload.method)), false)
  f.client.close()
})

test('audio cancellation fences late upload and ASR replies and requests remote cleanup', async () => {
  let resolveBegin
  let resolveStatus
  const f = fixture(({ method, params }) => {
    if (method === 'AUDIO_BEGIN') return new Promise(resolve => { resolveBegin = () => resolve({
      ok: true, id: params.id, receivedBytes: 0, totalBytes: params.totalBytes
    }) })
    if (method === 'AUDIO_STATUS') return new Promise(resolve => { resolveStatus = () => resolve({
      ok: true, id: params.id, state: 'ready', text: 'Слишком поздно'
    }) })
    if (method === 'AUDIO_CANCEL') return Promise.resolve({ ok: true, id: params.id,
      state: 'cancelled' })
    throw new Error(`unexpected ${method}`)
  })
  const uploadId = '123456789-1'
  const uploading = f.client.uploadAudio({ id: uploadId, totalBytes: 1,
    readChunk: () => [1] })
  assert.equal(f.client.cancelAudio(uploadId), true)
  resolveBegin()
  assert.equal(await uploading, false)
  assert.equal(f.sent.some(item => ['AUDIO_PART', 'AUDIO_CHUNK', 'AUDIO_FINISH']
    .includes(item.payload.method)), false)

  const asrId = '123456789-2'
  assert.equal(f.client.resumeAudio(asrId), true)
  assert.equal(f.client.cancelAudio(asrId), true)
  resolveStatus()
  await flush()
  assert.equal(f.client.getState().phase, 'ready')
  assert.deepEqual(f.sent.filter(item => item.payload.method === 'AUDIO_CANCEL')
    .map(item => item.payload.params.id), [uploadId, asrId])
  f.client.close()
})

test('edited text is uploaded in codepoint pages and persisted before the command mutation', async () => {
  let draft = null
  const writes = []
  const text = `${'а'.repeat(999)}🙂${'б'.repeat(2)}`
  const f = fixture(payload => {
    const { method, params } = payload
    if (method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    if (method === 'LATEST_JOB') return Promise.resolve({ ok: true, job: {
      id: '123-1', state: 'ready', text: 'Исходный текст'
    } })
    if (method === 'TEXT_BEGIN') return Promise.resolve({ ok: true, id: params.id,
      state: 'uploading', textLength: params.textLength, receivedLength: 0 })
    if (method === 'TEXT_PART') return Promise.resolve({ ok: true, id: params.id,
      state: 'uploading', textLength: Array.from(text).length,
      receivedLength: params.offset + Array.from(params.text).length })
    if (method === 'TEXT_FINISH') return Promise.resolve({ ok: true, id: params.id,
      state: 'ready', textLength: Array.from(text).length })
    if (method === 'SEND_TEXT') {
      assert.equal(draft.pendingSend, true)
      assert.equal(draft.textId, draft.draftId)
      assert.deepEqual(params, { id: '123-1', textId: draft.draftId })
      return Promise.resolve({ ok: true, id: '123-1', state: 'queued' })
    }
    throw new Error(`unexpected ${method}`)
  }, {
    readDraft: () => draft,
    writeDraft: value => { draft = value; writes.push(value && { ...value }) }
  })
  f.client.start()
  await flush()
  f.client.updateReviewText(text)
  const draftId = draft.draftId
  assert.equal(f.client.sendText(), true)
  await flush()
  await flush()

  assert.deepEqual(f.sent.map(item => item.payload.method), [
    'STATUS', 'LATEST_JOB', 'TEXT_BEGIN', 'TEXT_PART', 'TEXT_PART', 'TEXT_FINISH', 'SEND_TEXT'
  ])
  assert.deepEqual(f.sent.filter(item => item.payload.method === 'TEXT_PART').map(item => ({
    offset: item.payload.params.offset,
    length: Array.from(item.payload.params.text).length
  })), [{ offset: 0, length: 1000 }, { offset: 1000, length: 2 }])
  assert.deepEqual(f.sent.find(item => item.payload.method === 'TEXT_BEGIN').payload.params, {
    id: draftId, sourceId: '123-1', textLength: 1002
  })
  const readyWrite = writes.find(value => value && value.textId === draftId && value.pendingSend === false)
  const pendingWrite = writes.find(value => value && value.textId === draftId && value.pendingSend === true)
  assert.ok(readyWrite)
  assert.ok(pendingWrite)
  assert.equal(f.client.getState().phase, 'job')
  assert.equal(draft, null)
  f.client.close()
})

test('a failed edited-text upload stays reviewable and only explicit Send retries it', async () => {
  let draft = null
  let beginFailures = 2
  const f = fixture(payload => {
    const { method, params } = payload
    if (method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    if (method === 'LATEST_JOB') return Promise.resolve({ ok: true, job: {
      id: '123-1', state: 'ready', text: 'Исходный текст'
    } })
    if (method === 'TEXT_BEGIN' && beginFailures-- > 0) return Promise.reject(new Error('BLE disconnected'))
    if (method === 'TEXT_BEGIN') return Promise.resolve({ ok: true, id: params.id,
      state: 'uploading', textLength: params.textLength, receivedLength: 0 })
    if (method === 'TEXT_PART') return Promise.resolve({ ok: true, id: params.id,
      state: 'uploading', textLength: 10, receivedLength: 10 })
    if (method === 'TEXT_FINISH') return Promise.resolve({ ok: true, id: params.id,
      state: 'ready', textLength: 10 })
    if (method === 'SEND_TEXT') return Promise.resolve({ ok: true, id: '123-1', state: 'queued' })
    throw new Error(`unexpected ${method}`)
  }, {
    readDraft: () => draft,
    writeDraft: value => { draft = value }
  })
  f.client.start()
  await flush()
  f.client.updateReviewText('Исправлено')
  assert.equal(f.client.sendText(), true)
  await flush()
  assert.equal(f.client.getState().phase, 'review')
  assert.match(f.client.getState().error, /BLE disconnected/)
  assert.equal(f.sent.some(item => item.payload.method === 'SEND_TEXT'), false)
  assert.equal(draft.pendingSend, false)

  assert.equal(f.client.sendText(), true)
  await flush()
  await flush()
  assert.equal(f.sent.filter(item => item.payload.method === 'TEXT_BEGIN').length, 3)
  assert.equal(f.sent.filter(item => item.payload.method === 'SEND_TEXT').length, 1)
  assert.equal(f.client.getState().phase, 'job')
  f.client.close()
})

test('an uncertain submitted draft is recovered by exact id without resending', async () => {
  let draft = null
  let first = true
  const handler = payload => {
    const { method, params } = payload
    if (method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    if (method === 'LATEST_JOB') return Promise.resolve({ ok: true, job: {
      id: '123-1', state: 'ready', text: 'Исходный текст'
    } })
    if (method === 'SEND_TEXT') return Promise.reject(new Error('receipt lost'))
    if (method === 'JOB_STATUS') return Promise.resolve({ ok: true, id: params.id, state: 'queued' })
    throw new Error(`unexpected ${method}`)
  }
  const persistence = {
    readDraft: () => draft,
    writeDraft: value => { draft = value }
  }
  const original = fixture(handler, persistence)
  original.client.start()
  await flush()
  assert.equal(original.client.sendText(), true)
  await flush()
  assert.equal(original.client.getState().phase, 'unknown')
  assert.equal(draft.pendingSend, true)
  original.client.close()

  let statusChecks = 0
  const reopened = fixture(payload => {
    first = false
    if (payload.method === 'JOB_STATUS' && statusChecks++ === 0) {
      return Promise.reject(new Error('cold handshake'))
    }
    return handler(payload)
  }, persistence)
  reopened.client.start()
  await flush()
  assert.equal(first, false)
  assert.deepEqual(reopened.sent.map(item => item.payload.method), ['STATUS', 'JOB_STATUS', 'JOB_STATUS'])
  assert.equal(reopened.sent[1].payload.params.id, '123-1')
  assert.equal(reopened.client.getState().phase, 'job')
  assert.equal(draft, null)
  reopened.client.close()
})

test('failure to persist pending send keeps the review and sends no command', async () => {
  let draft = null
  let rejectPending = true
  const f = fixture(payload => {
    if (payload.method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    if (payload.method === 'LATEST_JOB') return Promise.resolve({ ok: true, job: {
      id: '123-1', state: 'ready', text: 'Исходный текст'
    } })
    if (payload.method === 'SEND_TEXT') return Promise.resolve({ ok: true, id: '123-1', state: 'queued' })
    throw new Error(`unexpected ${payload.method}`)
  }, {
    readDraft: () => draft,
    writeDraft: value => {
      if (value && value.pendingSend && rejectPending) throw new Error('storage full')
      draft = value
    }
  })
  f.client.start()
  await flush()
  assert.equal(f.client.sendText(), true)
  await flush()
  assert.equal(f.client.getState().phase, 'review')
  assert.match(f.client.getState().error, /сохранить текст/)
  assert.equal(f.sent.some(item => item.payload.method === 'SEND_TEXT'), false)

  rejectPending = false
  assert.equal(f.client.sendText(), true)
  await flush()
  assert.equal(f.sent.filter(item => item.payload.method === 'SEND_TEXT').length, 1)
  assert.equal(f.client.getState().phase, 'job')
  f.client.close()
})

test('non-authoritative send and status errors keep the pending draft uncertain', async () => {
  let draft = null
  const persistence = {
    readDraft: () => draft,
    writeDraft: value => { draft = value }
  }
  const first = fixture(payload => {
    if (payload.method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    if (payload.method === 'LATEST_JOB') return Promise.resolve({ ok: true, job: {
      id: '123-1', state: 'ready', text: 'Не потерять'
    } })
    if (payload.method === 'SEND_TEXT') return Promise.resolve({ ok: false, error: 'BRIDGE_HTTP_503' })
    throw new Error(`unexpected ${payload.method}`)
  }, persistence)
  first.client.start()
  await flush()
  assert.equal(first.client.sendText(), true)
  await flush()
  assert.equal(first.client.getState().phase, 'unknown')
  assert.equal(first.client.getState().retryMethod, 'JOB_STATUS')
  assert.equal(draft.pendingSend, true)
  first.client.close()

  const reopened = fixture(payload => {
    if (payload.method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    if (payload.method === 'JOB_STATUS') return Promise.resolve({ ok: false, error: 'BRIDGE_HTTP_503' })
    throw new Error(`unexpected ${payload.method}`)
  }, persistence)
  reopened.client.start()
  await flush()
  assert.equal(reopened.client.getState().phase, 'unknown')
  assert.equal(reopened.client.getState().retryId, '123-1')
  assert.equal(draft.pendingSend, true)
  assert.equal(reopened.sent.some(item => item.payload.method === 'LATEST_JOB'), false)
  assert.equal(reopened.sent.some(item => item.payload.method === 'SEND_TEXT'), false)
  reopened.client.close()
})

test('an exact ready status preserves and restores the pending review text', async () => {
  let draft = { id: '123-1', text: 'Правка остаётся', textId: null,
    edited: false, draftId: null, pendingSend: true }
  const f = fixture(payload => {
    if (payload.method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    if (payload.method === 'JOB_STATUS') return Promise.resolve({ ok: true,
      id: '123-1', state: 'ready', text: 'Старый текст' })
    throw new Error(`unexpected ${payload.method}`)
  }, {
    readDraft: () => draft,
    writeDraft: value => { draft = value }
  })
  f.client.start()
  await flush()
  assert.equal(f.client.getState().phase, 'review')
  assert.equal(f.client.getState().text, 'Правка остаётся')
  assert.equal(draft.pendingSend, true)
  f.client.close()
})

test('an unsent edited draft is restored without any automatic submission', async () => {
  let draft = { id: '123-1', text: 'Сохранённая правка', textId: null,
    edited: true, draftId: '123-2', pendingSend: false }
  const f = fixture(payload => {
    if (payload.method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    throw new Error(`unexpected ${payload.method}`)
  }, {
    readDraft: () => draft,
    writeDraft: value => { draft = value }
  })
  f.client.start()
  await flush()
  assert.equal(f.client.getState().phase, 'review')
  assert.equal(f.client.getState().text, 'Сохранённая правка')
  assert.deepEqual(f.sent.map(item => item.payload.method), ['STATUS'])
  assert.equal(f.client.cancelReview(), true)
  assert.equal(draft, null)
  f.client.close()
})

test('stop is sent once, stopping stays a job phase, and cancelled becomes a result', async () => {
  let statusCalls = 0
  let stopCalls = 0
  const f = fixture(({ method, params }) => {
    if (method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    if (method === 'LATEST_JOB') return Promise.resolve({ ok: true, job: {
      id: '123-20', state: 'running', text: 'Долгая задача', chatId: '123-20',
      summary: 'Долгая задача', mode: 'research', reportLength: 120
    } })
    if (method === 'JOB_STOP') {
      stopCalls += 1
      return Promise.resolve({ ok: true, id: params.id, state: 'stopping',
        chatId: '123-20', summary: 'Останавливаю', mode: 'research', reportLength: 120 })
    }
    if (method === 'JOB_STATUS') {
      statusCalls += 1
      return Promise.resolve({ ok: true, id: params.id, state: 'cancelled', result: '',
        chatId: '123-20', summary: 'Остановлено', mode: 'research', reportLength: 120 })
    }
    throw new Error(method)
  })
  f.client.start()
  await flush()
  assert.equal(f.client.stopJob(), true)
  assert.equal(f.client.stopJob(), false)
  await flush()
  assert.equal(stopCalls, 1)
  assert.equal(f.client.getState().phase, 'job')
  assert.equal(f.client.getState().state, 'stopping')
  assert.equal(f.client.getState().chatId, '123-20')
  assert.equal(f.client.getState().reportLength, 120)

  f.clock.fireDelay(3000)
  await flush()
  assert.equal(statusCalls, 1)
  assert.equal(f.client.getState().phase, 'result')
  assert.equal(f.client.getState().state, 'cancelled')
  assert.equal(f.client.getState().result, 'Задание остановлено')
  f.client.close()
})

test('unknown stop receipt polls the exact job without repeating JOB_STOP', async () => {
  let stopCalls = 0
  const f = fixture(({ method, params }) => {
    if (method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    if (method === 'LATEST_JOB') return Promise.resolve({ ok: true, job: {
      id: '123-21', state: 'running', text: 'Задача'
    } })
    if (method === 'JOB_STOP') {
      stopCalls += 1
      return Promise.resolve({ ok: true, id: params.id, state: 'unknown',
        error: 'Ответ об остановке потерян' })
    }
    if (method === 'JOB_STATUS') return Promise.resolve({ ok: true, id: params.id,
      state: 'cancelled' })
    throw new Error(method)
  })
  f.client.start()
  await flush()
  assert.equal(f.client.stopJob(), true)
  await flush()
  assert.equal(stopCalls, 1)
  assert.equal(f.client.getState().phase, 'job')
  assert.equal(f.client.getState().state, 'stopping')
  f.clock.fireDelay(3000)
  await flush()
  assert.equal(stopCalls, 1)
  assert.deepEqual(f.sent.filter(item => item.payload.method === 'JOB_STATUS')
    .map(item => item.payload.params.id), ['123-21'])
  assert.equal(f.client.getState().phase, 'result')
  f.client.close()
})

test('closing during stop suppresses a late invalid reply', async () => {
  let resolveStop
  const f = fixture(({ method }) => {
    if (method === 'STATUS') return Promise.resolve({ ok: true, agent: 'Мусафир' })
    if (method === 'LATEST_JOB') return Promise.resolve({ ok: true, job: {
      id: '123-22', state: 'running', text: 'Задача'
    } })
    if (method === 'JOB_STOP') return new Promise(resolve => { resolveStop = resolve })
    throw new Error(method)
  })
  f.client.start()
  await flush()
  assert.equal(f.client.stopJob(), true)
  const count = f.states.length
  f.client.close()
  resolveStop({ ok: true, id: 'other', state: 'cancelled' })
  await flush()
  assert.equal(f.states.length, count)
  assert.equal(f.clock.count(), 0)
})

test('definite nonretryable send rejection returns the exact draft to review and survives reopen', async () => {
  let draft = { id: '123-1', text: 'Сохранить точный текст 🙂', textId: '123-1',
    edited: false, draftId: null, typed: false, sourceId: '123-1', pendingSend: false }
  const handler = async payload => {
    if (payload.method === 'STATUS') return { ok: true, agent: 'Test' }
    if (payload.method === 'SEND_TEXT') return { ok: false, retryable: false, error: 'Выбранная связка недоступна' }
    throw Error(payload.method)
  }
  const persistence = { readDraft: () => draft, writeDraft: value => { draft = value } }
  const f = fixture(handler, persistence)
  f.client.start(); await flush()
  f.client.sendText(); await flush()
  assert.equal(f.client.getState().phase, 'review')
  assert.equal(f.client.getState().jobId, null)
  assert.equal(f.client.getState().text, 'Сохранить точный текст 🙂')
  assert.equal(draft.pendingSend, false)
  assert.equal(f.sent.filter(x => x.payload.method === 'SEND_TEXT').length, 1)
  f.client.close()
  const g = fixture(handler, persistence)
  g.client.start(); await flush()
  assert.equal(g.client.getState().phase, 'review')
  assert.equal(g.client.getState().text, draft.text)
  assert.equal(g.sent.some(x => x.payload.method === 'SEND_TEXT'), false)
  g.client.close()
})
