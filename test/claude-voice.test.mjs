import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClaudeVoiceRoute, createCodexVoiceRoute } from '../shared/claude-voice.js'

test('a dictated task runs in the chosen project and the returned session is continued next time', async () => {
  const calls = []
  const context = { target: 'claude', project: '/work/crm', label: 'CRM', mode: 'auto' }
  const route = createClaudeVoiceRoute({ context, request: async payload => {
    calls.push(payload)
    if (payload.method === 'CLAUDE_SEND') return { ok: true, job: { id: payload.params.id, state: 'queued', sessionId: null } }
    if (payload.method === 'CLAUDE_JOB') return { ok: true, job: { id: payload.params.id, state: 'completed',
      sessionId: '11111111-2222-3333-4444-555555555555', result: 'Первая часть ', nextCursor: payload.params.cursor ? null : '13' } }
    throw new Error(payload.method)
  } })
  assert.deepEqual(await route({ method: 'STATUS' }), { ok: true, agent: 'Claude' })
  const sent = await route({ method: 'SEND_TEXT', params: { id: '1700000000000-1', textId: '1700000000000-1' } })
  assert.deepEqual(calls[0].params, { id: '1700000000000-1', textId: '1700000000000-1', project: '/work/crm', mode: 'auto' })
  assert.equal(sent.state, 'queued')
  const done = await route({ method: 'JOB_STATUS', params: { id: '1700000000000-1' } })
  assert.equal(done.state, 'completed')
  assert.equal(done.result, 'Первая часть ')
  assert.equal(context.sessionId, '11111111-2222-3333-4444-555555555555')
  await route({ method: 'SEND_TEXT', params: { id: '1700000000000-2', textId: '1700000000000-2' } })
  const second = calls.find(c => c.method === 'CLAUDE_SEND' && c.params.id === '1700000000000-2')
  assert.equal(second.params.sessionId, '11111111-2222-3333-4444-555555555555')
})

test('latest job of the project is recovered, exact resume wins once, chosen session is sent', async () => {
  const calls = []
  const context = { target: 'claude', project: '/work/crm', label: 'CRM', mode: 'plan',
    sessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', jobId: 'job-9', aliasId: 'job-9', resumeJob: true }
  const route = createClaudeVoiceRoute({ context, request: async payload => {
    calls.push(payload)
    if (payload.method === 'CLAUDE_JOB') return { ok: true, job: { id: 'job-9', state: 'running', sessionId: null } }
    if (payload.method === 'CLAUDE_LATEST') return { ok: true, job: null }
    if (payload.method === 'CLAUDE_SEND') return { ok: true, job: { id: payload.params.id, state: 'queued' } }
    throw new Error(payload.method)
  } })
  const first = await route({ method: 'LATEST_JOB', params: {} })
  assert.equal(first.job.state, 'running')
  assert.equal(calls[0].method, 'CLAUDE_JOB')
  assert.equal(context.resumeJob, false)
  const second = await route({ method: 'LATEST_JOB', params: {} })
  assert.equal(second.job, null)
  assert.equal(calls[1].method, 'CLAUDE_LATEST')
  assert.equal(calls[1].params.project, '/work/crm')
  await route({ method: 'SEND_TEXT', params: { id: '1700000000000-3', textId: '1700000000000-3' } })
  const send = calls.find(c => c.method === 'CLAUDE_SEND').params
  assert.equal(send.sessionId, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
  assert.equal(send.mode, 'plan')
})

test('codex route uses CODEX methods and names itself Codex', async () => {
  const calls = []
  const route = createCodexVoiceRoute({ context: { target: 'codex', project: '/work/shop', mode: 'read-only' }, request: async payload => {
    calls.push(payload)
    if (payload.method === 'CODEX_LATEST') return { ok: true, job: null }
    if (payload.method === 'CODEX_SEND') return { ok: true, job: { id: payload.params.id, state: 'queued' } }
    throw new Error(payload.method)
  } })
  assert.deepEqual(await route({ method: 'STATUS' }), { ok: true, agent: 'Codex' })
  await route({ method: 'LATEST_JOB', params: {} })
  await route({ method: 'SEND_TEXT', params: { id: '1700000000000-4', textId: '1700000000000-4' } })
  assert.deepEqual(calls.map(c => c.method), ['CODEX_LATEST', 'CODEX_SEND'])
  assert.equal(calls[1].params.mode, 'read-only')
})

test('a pending permission becomes an approval screen and the decision goes back by exact id', async () => {
  const calls = []
  let decided = null
  const context = { target: 'claude', project: '/work/crm', jobId: 'job-5', aliasId: 'job-5' }
  const route = createClaudeVoiceRoute({ context, request: async payload => {
    calls.push(payload)
    if (payload.method === 'CLAUDE_JOB') return { ok: true, job: { id: 'job-5', state: decided ? 'running' : 'approval',
      approval: decided ? null : { id: '0123456789abcdef', text: 'Bash:\nnpm test' }, result: '', nextCursor: null } }
    if (payload.method === 'CLAUDE_APPROVE') { decided = payload.params; return { ok: true, job: { id: 'job-5', state: 'running', approval: null, result: '' } } }
    throw new Error(payload.method)
  } })
  const waiting = await route({ method: 'JOB_STATUS', params: { id: 'job-5' } })
  assert.equal(waiting.state, 'approval')
  assert.deepEqual(waiting.approval, { id: '0123456789abcdef', text: 'Bash:\nnpm test' })
  const after = await route({ method: 'JOB_APPROVE', params: { id: 'job-5', approvalId: '0123456789abcdef', allow: true } })
  assert.deepEqual(decided, { id: 'job-5', approvalId: '0123456789abcdef', allow: true })
  assert.equal(after.state, 'running')
})

test('a night task is queued without running and shows the waiting note as its answer', async () => {
  const calls = []
  const context = { target: 'claude', project: '/work/crm', label: 'CRM', mode: 'auto', night: true }
  const route = createClaudeVoiceRoute({ context, request: async payload => {
    calls.push(payload)
    if (payload.method === 'CLAUDE_SEND') return { ok: true, job: { id: payload.params.id, state: 'night', night: true,
      result: 'Задача ждёт ночной смены. Старт в 01:00.' } }
    throw new Error(payload.method)
  } })
  const sent = await route({ method: 'SEND_TEXT', params: { id: '1700000000000-7', textId: '1700000000000-7' } })
  assert.equal(calls[0].params.night, true)
  assert.equal(sent.state, 'completed')
  assert.equal(sent.result, 'Задача ждёт ночной смены. Старт в 01:00.')
})

test('a research topic is sent as a research job, optionally mirrored to the other agent', async () => {
  const calls = []
  const context = { target: 'claude', project: 'research', label: 'Исследование', mode: 'auto', kind: 'research', both: true }
  const route = createClaudeVoiceRoute({ context, request: async payload => {
    calls.push(payload)
    if (payload.method === 'CLAUDE_SEND') return { ok: true, job: { id: payload.params.id, state: 'queued', kind: 'research' } }
    throw new Error(payload.method)
  } })
  const sent = await route({ method: 'SEND_TEXT', params: { id: '1700000000000-8', textId: '1700000000000-8' } })
  assert.deepEqual(calls[0].params, { id: '1700000000000-8', textId: '1700000000000-8', project: 'research', mode: 'auto', kind: 'research', both: true })
  assert.equal(sent.state, 'queued')
})

test('a dictated site address becomes a standing check and reads back like an answer', async () => {
  const calls = []
  const context = { target: 'claude', project: 'watch', label: 'Дозор', mode: 'auto', kind: 'watch' }
  const route = createClaudeVoiceRoute({ context, request: async payload => {
    calls.push(payload)
    if (payload.method === 'WATCH_ADD') return { ok: true, watch: { id: 'abc' }, message: 'Дозор: слежу за сайтом fikra.io. Сейчас: в порядке, HTTP 200' }
    throw new Error(payload.method)
  } })
  assert.deepEqual(await route({ method: 'LATEST_JOB', params: {} }), { ok: true, job: null })
  const sent = await route({ method: 'SEND_TEXT', params: { id: '1700000000000-9', textId: '1700000000000-9' } })
  assert.deepEqual(calls.at(-1).params, { kind: 'url', textId: '1700000000000-9' })
  assert.equal(sent.state, 'completed')
  assert.match(sent.result, /слежу за сайтом fikra.io/)
  assert.equal(context.jobId, null)
})

test('a deep research topic is sent as kind deep and never mirrored', async () => {
  const calls = []
  const context = { target: 'claude', project: 'research', label: 'Исследование', mode: 'auto', kind: 'deep', both: true }
  const route = createClaudeVoiceRoute({ context, request: async payload => {
    calls.push(payload)
    return { ok: true, job: { id: payload.params.id, state: 'queued', kind: 'deep' } }
  } })
  await route({ method: 'SEND_TEXT', params: { id: '1700000000000-3', textId: '1700000000000-3' } })
  assert.equal(calls[0].params.kind, 'deep')
  assert.equal('both' in calls[0].params, false)
})

test('a dictated PR number is sent with the review preset', async () => {
  const calls = []
  const context = { target: 'claude', project: '/work/crm', label: 'CRM', mode: 'auto', presetId: 'review' }
  const route = createClaudeVoiceRoute({ context, request: async payload => {
    calls.push(payload)
    return { ok: true, job: { id: payload.params.id, state: 'queued', preset: 'review' } }
  } })
  await route({ method: 'SEND_TEXT', params: { id: '1700000000000-4', textId: '1700000000000-4' } })
  assert.deepEqual(calls[0].params, { id: '1700000000000-4', textId: '1700000000000-4', project: '/work/crm', mode: 'auto', presetId: 'review' })
})

test('question options pass through the route and the answer reaches CLAUDE_APPROVE', async () => {
  const calls = []
  const context = { target: 'claude', project: '/work/crm', label: 'CRM', mode: 'auto', jobId: 'job-1', aliasId: 'job-1' }
  const route = createClaudeVoiceRoute({ context, request: async payload => {
    calls.push(payload)
    return { ok: true, job: { id: 'job-1', state: 'approval', approval: { id: '0123456789abcdef', text: 'Вопрос', question: 'Какой цвет?', options: ['Красный', 'Синий'], step: '1/1' } } }
  } })
  const shown = await route({ method: 'JOB_STATUS', params: { id: 'job-1' } })
  assert.deepEqual(shown.approval, { id: '0123456789abcdef', text: 'Вопрос', question: 'Какой цвет?', options: ['Красный', 'Синий'], step: '1/1' })
  await route({ method: 'JOB_APPROVE', params: { id: 'job-1', approvalId: '0123456789abcdef', allow: true, answer: 'Синий' } })
  assert.deepEqual(calls.at(-1).params, { id: 'job-1', approvalId: '0123456789abcdef', allow: true, answer: 'Синий' })
})

test('a lost new send receipt never maps the previous Claude job to the new voice id', async () => {
  const calls = []
  const context = { target: 'claude', project: '/work/crm', mode: 'auto',
    jobId: 'old-job', aliasId: 'old-voice' }
  const route = createClaudeVoiceRoute({ context, request: async payload => {
    calls.push(payload)
    if (payload.method === 'CLAUDE_SEND') throw new Error('receipt lost')
    if (payload.method === 'CLAUDE_JOB') return { ok: true, job: {
      id: payload.params.id, state: 'running'
    } }
    throw new Error(payload.method)
  } })
  await assert.rejects(route({ method: 'SEND_TEXT', params: {
    id: '1700000000000-2', textId: '1700000000000-2'
  } }), /receipt lost/)
  const status = await route({ method: 'JOB_STATUS', params: { id: '1700000000000-2' } })
  assert.equal(status.id, '1700000000000-2')
  assert.deepEqual(calls.at(-1), { method: 'CLAUDE_JOB', params: { id: '1700000000000-2' } })
})

test('startup with an uncertain Claude send recovers its exact alias and renders the first chunk without blocking on continuation', async () => {
  const options = { onRouteProgress() { options.progress += 1 }, progress: 0 }
  const calls = []
  const context = { target: 'claude', project: '/work/crm', mode: 'auto',
    jobId: 'old-job', aliasId: '1700000000000-2', pendingSend: true }
  const route = createClaudeVoiceRoute({ context, request: async (payload, receivedOptions) => {
    calls.push({ payload, receivedOptions })
    return { ok: true, job: { id: '1700000000000-2', state: 'completed',
      result: payload.params.cursor ? 'два' : 'один ', nextCursor: payload.params.cursor ? null : 'page-2' } }
  } })
  const latest = await route({ method: 'LATEST_JOB' }, options)
  assert.equal(latest.job.result, 'один ')
  assert.deepEqual(calls.map(call => call.payload), [
    { method: 'CLAUDE_JOB', params: { id: '1700000000000-2' } }
  ])
  assert.ok(calls.every(call => call.receivedOptions === options))
  assert.equal(options.progress, 1)
})

test('Claude and Codex expose submitting before their process starts', async () => {
  for (const [createRoute, method] of [
    [createClaudeVoiceRoute, 'CLAUDE_SEND'],
    [createCodexVoiceRoute, 'CODEX_SEND']
  ]) {
    const route = createRoute({ context: { project: '/work/crm', mode: 'auto' }, request: async payload => {
      assert.equal(payload.method, method)
      return { ok: true, job: { id: payload.params.id, state: 'submitting' } }
    } })
    const reply = await route({ method: 'SEND_TEXT', params: {
      id: '1700000000000-3', textId: '1700000000000-3'
    } })
    assert.equal(reply.state, 'submitting')
  }
})

for (const [factory, prefix] of [[createClaudeVoiceRoute, 'CLAUDE'], [createCodexVoiceRoute, 'CODEX']]) {
  test(prefix + ' fresh and selected-session compose never adopts a different latest job', async () => {
    const context = { target: prefix.toLowerCase(), project: 'project-a', sessionId: 'selected-session', startFresh: true }
    const calls = []
    const route = factory({ context, request: async payload => {
      calls.push(payload)
      if (payload.method.endsWith('_LATEST')) return { ok: true, job: { id: 'other-job', state: 'completed', sessionId: 'other-session' } }
      return { ok: true, job: { id: payload.params.id, state: 'queued' } }
    } })
    assert.deepEqual(await route({ method: 'LATEST_JOB' }), { ok: true, job: null })
    assert.equal(calls.length, 0)
    assert.equal(context.sessionId, 'selected-session')
    await route({ method: 'SEND_TEXT', params: { id: '123-1', textId: '123-1' } })
    assert.equal(calls[0].params.sessionId, 'selected-session')
    assert.equal(context.startFresh, false)
  })
  test(prefix + ' definite rejection restores fresh context and confirmed stop is terminal', async () => {
    const context = { target: prefix.toLowerCase(), project: 'project-a', startFresh: true }
    let stopped = false
    const route = factory({ context, request: async payload => stopped
      ? { ok: true, job: { id: '123-1', state: 'error', error: 'Остановлено с часов' } }
      : { ok: false, retryable: false, error: 'Нет проекта' } })
    const rejection = await route({ method: 'SEND_TEXT', params: { id: '123-1' } })
    assert.equal(rejection.retryable, false)
    assert.equal(context.pendingSend, false)
    assert.equal(context.startFresh, true)
    stopped = true
    const result = await route({ method: 'JOB_STATUS', params: { id: '123-1' } })
    assert.equal(result.state, 'cancelled')
  })
}
