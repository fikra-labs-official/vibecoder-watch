import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MUSAFIR_CONTEXT_KEY,
  MUSAFIR_HERO_KEY,
  MUSAFIR_HEROES,
  createMusafirVoiceRoute,
  heroById,
  normalizeContext
} from '../shared/musafir-chat.js'

const job = (id, chatId, state = 'queued', extra = {}) => ({
  ok: true,
  id,
  chatId,
  state,
  text: 'Проверь задачу',
  result: '',
  error: '',
  summary: 'Проверка задачи',
  mode: 'task',
  reportLength: 0,
  ...extra
})

test('Musafir context and hero helpers reject stale values and have a stable fallback', () => {
  assert.equal(MUSAFIR_CONTEXT_KEY, 'musafir-context')
  assert.equal(MUSAFIR_HERO_KEY, 'musafir-hero')
  assert.deepEqual(MUSAFIR_HEROES, [
    { id: 'musafir', name: 'Musafir', meaning: 'Путешественник' },
    { id: 'kashif', name: 'Kashif', meaning: 'Исследователь' },
    { id: 'barq', name: 'Barq', meaning: 'Молния' },
    { id: 'hakim', name: 'Hakim', meaning: 'Мудрый' },
    { id: 'amin', name: 'Amin', meaning: 'Надёжный' }
  ])
  assert.equal(heroById('barq').name, 'Barq')
  assert.equal(heroById('missing').id, 'musafir')
  assert.deepEqual(normalizeContext({ target: 'orca', chatId: 17, mode: 'deep',
    jobId: 'bad', openJob: true, autoRecord: 'yes', pendingSend: true }), {
    target: 'musafir', chatId: null, mode: 'task', jobId: null,
    openJob: false, autoRecord: false, pendingSend: false
  })
  assert.deepEqual(normalizeContext({ chatId: 'legacy', mode: 'research',
    jobId: '1700000000000-1', openJob: true, autoRecord: true, pendingSend: true }), {
    target: 'musafir', chatId: 'legacy', mode: 'research', jobId: '1700000000000-1',
    openJob: true, autoRecord: true, pendingSend: true
  })
})

test('empty launch never asks for a global latest job and STATUS uses the real bridge', async () => {
  const calls = []
  const context = { target: 'musafir', chatId: null, mode: 'task' }
  const route = createMusafirVoiceRoute({ context, request: async payload => {
    calls.push(payload)
    return { ok: true, agent: 'Мусафир' }
  } })
  assert.deepEqual(await route({ method: 'LATEST_JOB', params: {} }), { ok: true, job: null })
  assert.equal(calls.length, 0)
  assert.deepEqual(await route({ method: 'STATUS', params: { ignored: true } }), {
    ok: true, agent: 'Мусафир'
  })
  assert.deepEqual(calls, [{ method: 'STATUS', params: {} }])
})

test('new chat is accepted from its first job and continuation keeps that exact chat', async () => {
  const calls = []
  const saves = []
  const context = { target: 'musafir', chatId: null, mode: 'task' }
  const route = createMusafirVoiceRoute({ context, save: value => saves.push({ ...value }), request: async payload => {
    calls.push(payload)
    return job(payload.params.id, payload.params.chatId || payload.params.id, 'queued',
      calls.length === 1 ? { mode: 'research' } : {})
  } })
  const first = await route({ method: 'SEND_TEXT', params: {
    id: '1700000000000-1', textId: '1700000000000-1'
  } })
  assert.deepEqual(calls[0], { method: 'SEND_TEXT', params: {
    id: '1700000000000-1', textId: '1700000000000-1', chatId: null, mode: 'task'
  } })
  assert.equal(first.chatId, '1700000000000-1')
  assert.equal('hero' in calls[0].params, false)
  assert.equal(first.summary, 'Проверка задачи')
  assert.equal(first.mode, 'research')
  assert.equal(first.reportLength, 0)
  assert.equal(context.chatId, '1700000000000-1')
  assert.equal(context.mode, 'task')
  assert.equal(context.pendingSend, false)
  assert.equal(saves[0].pendingSend, true)

  await route({ method: 'SEND_TEXT', params: {
    id: '1700000000000-2', textId: '1700000000000-2'
  } })
  assert.equal(calls[1].params.chatId, '1700000000000-1')
  assert.equal(context.chatId, '1700000000000-1')
})

test('lost new-chat receipt recovers only the exact pending job and never sends twice', async () => {
  const calls = []
  const context = { target: 'musafir', chatId: null, mode: 'task' }
  const route = createMusafirVoiceRoute({ context, request: async payload => {
    calls.push(payload)
    if (payload.method === 'SEND_TEXT') throw new Error('receipt lost')
    if (payload.method === 'JOB_STATUS') return job(payload.params.id, payload.params.id, 'running')
    throw new Error(payload.method)
  } })
  await assert.rejects(route({ method: 'SEND_TEXT', params: {
    id: '1700000000000-3', textId: '1700000000000-3'
  } }), /receipt lost/)
  assert.equal(context.pendingSend, true)
  assert.equal(context.jobId, '1700000000000-3')

  const recovered = await route({ method: 'LATEST_JOB', params: {} })
  assert.equal(recovered.job.state, 'running')
  assert.equal(context.chatId, '1700000000000-3')
  assert.equal(context.pendingSend, false)
  assert.deepEqual(calls.map(call => call.method), ['SEND_TEXT', 'JOB_STATUS'])
  assert.deepEqual(calls[1].params, { id: '1700000000000-3', brief: true })

  assert.deepEqual(await route({ method: 'LATEST_JOB', params: {} }), { ok: true, job: null })
  assert.deepEqual(calls.map(call => call.method), ['SEND_TEXT', 'JOB_STATUS'])
})

test('missing, foreign, or mismatched accepted chat never changes routing', async () => {
  for (const badReply of [
    job('1700000000000-4', undefined),
    job('1700000000000-4', '1700000000000-99'),
    job('1700000000000-99', '1700000000000-4')
  ]) {
    const context = { target: 'musafir', chatId: null, mode: 'task' }
    const route = createMusafirVoiceRoute({ context, request: async () => badReply })
    await assert.rejects(route({ method: 'SEND_TEXT', params: {
      id: '1700000000000-4', textId: '1700000000000-4'
    } }), /Musafir|чату/)
    assert.equal(context.chatId, null)
    assert.equal(context.jobId, '1700000000000-4')
    assert.equal(context.pendingSend, true)
  }

  const context = { target: 'musafir', chatId: 'legacy', mode: 'task' }
  const route = createMusafirVoiceRoute({ context, request: async () =>
    job('1700000000000-5', '1700000000000-5') })
  await assert.rejects(route({ method: 'SEND_TEXT', params: {
    id: '1700000000000-5', textId: '1700000000000-5'
  } }), /другому чату/)
  assert.equal(context.chatId, 'legacy')
})

test('research mode is explicit and an opened job is consumed by exact id once', async () => {
  const calls = []
  const context = { target: 'musafir', chatId: 'legacy', mode: 'research',
    jobId: '1700000000000-6', openJob: true }
  const route = createMusafirVoiceRoute({ context, request: async payload => {
    calls.push(payload)
    if (payload.method === 'JOB_STATUS') return job(payload.params.id, 'legacy', 'completed', {
      mode: 'research', reportLength: 8200, result: 'Краткий итог'
    })
    if (payload.method === 'SEND_TEXT') return job(payload.params.id, 'legacy', 'queued', {
      mode: payload.params.mode
    })
    throw new Error(payload.method)
  } })
  const opened = await route({ method: 'LATEST_JOB', params: {} })
  assert.equal(opened.job.id, '1700000000000-6')
  assert.equal(opened.job.mode, 'research')
  assert.equal(opened.job.reportLength, 8200)
  assert.equal(context.openJob, false)
  assert.deepEqual(await route({ method: 'LATEST_JOB', params: {} }), { ok: true, job: null })

  await route({ method: 'SEND_TEXT', params: {
    id: '1700000000000-7', textId: '1700000000000-7'
  } })
  assert.equal(calls.at(-1).params.mode, 'research')
  assert.equal(calls.at(-1).params.chatId, 'legacy')
})

test('status, approval, and stop reject stale job ids and use the exact current job', async () => {
  const calls = []
  const context = { target: 'musafir', chatId: 'legacy', mode: 'task',
    jobId: '1700000000000-8', openJob: false }
  const route = createMusafirVoiceRoute({ context, request: async payload => {
    calls.push(payload)
    return job('1700000000000-8', 'legacy', payload.method === 'JOB_STOP' ? 'stopping' : 'running')
  } })
  for (const method of ['JOB_STATUS', 'JOB_APPROVE', 'JOB_STOP']) {
    const stale = await route({ method, params: {
      id: '1700000000000-9', approvalId: 'approval-1', allow: true
    } })
    assert.equal(stale.ok, false)
  }
  assert.equal(calls.length, 0)

  await route({ method: 'JOB_APPROVE', params: {
    id: '1700000000000-8', approvalId: 'approval-1', allow: false
  } })
  await route({ method: 'JOB_STOP', params: { id: '1700000000000-8' } })
  assert.deepEqual(calls, [
    { method: 'JOB_APPROVE', params: {
      id: '1700000000000-8', approvalId: 'approval-1', allow: false
    } },
    { method: 'JOB_STOP', params: { id: '1700000000000-8' } }
  ])
})
