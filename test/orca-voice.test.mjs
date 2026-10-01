import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWatchClient } from '../shared/watch-client.js'
import { createFolderVoiceRoute, createOrcaVoiceRoute } from '../shared/orca-voice.js'

const flush = () => new Promise(resolve => setImmediate(resolve))

test('confirmed transcript routes to ORCA_SEND and maps the underlying job to the voice alias', async () => {
  const calls = []
  const saved = []
  const context = { target: 'orca', pairId: 'pair-7' }
  const route = createOrcaVoiceRoute({
    context,
    save: value => saved.push({ ...value }),
    request: async payload => {
      calls.push(payload)
      if (payload.method === 'ORCA_SEND') {
        return { ok: true, job: { id: 'orca-job-9', state: 'queued', stage: 'coordinator_starting' } }
      }
      if (payload.method === 'ORCA_JOB') {
        return { ok: true, job: { id: 'orca-job-9', state: 'running', stage: 'worker_working' } }
      }
      throw new Error(`unexpected ${payload.method}`)
    }
  })

  const sent = await route({ method: 'SEND_TEXT', params: { id: '1700000000000-1', textId: '1700000000000-1' } })
  assert.deepEqual(calls[0], { method: 'ORCA_SEND', params: {
    id: '1700000000000-1', textId: '1700000000000-1', pairId: 'pair-7'
  } })
  assert.equal(sent.id, '1700000000000-1')
  assert.equal(sent.state, 'queued')
  assert.equal(context.jobId, 'orca-job-9')
  assert.equal(context.aliasId, '1700000000000-1')

  const status = await route({ method: 'JOB_STATUS', params: { id: '1700000000000-1' } })
  assert.deepEqual(calls[1], { method: 'ORCA_JOB', params: { id: 'orca-job-9' } })
  assert.equal(status.id, '1700000000000-1')
  assert.equal(status.state, 'running')
  assert.equal(saved.at(-1).jobId, 'orca-job-9')
  assert.equal(calls.some(call => call.method === 'SEND_TEXT'), false)
})

test('lost Orca receipt refreshes the same alias and never resends to Orca or Hermes', async () => {
  const rawCalls = []
  let accepted = false
  let receivedBytes = 0
  const id = '1700000000000-1'
  const context = { target: 'orca', pairId: 'pair-1' }
  const raw = async payload => {
    rawCalls.push(payload)
    const { method, params = {} } = payload
    if (method === 'ORCA_LATEST') return { ok: true, job: null }
    if (method === 'AUDIO_BEGIN') return { ok: true, id, receivedBytes, totalBytes: 1 }
    if (method === 'AUDIO_CHUNK') {
      receivedBytes = 1
      return { ok: true, id, receivedBytes, totalBytes: 1 }
    }
    if (method === 'AUDIO_FINISH') return { ok: true, id, state: 'ready' }
    if (method === 'AUDIO_STATUS') {
      return { ok: true, id, state: 'ready', text: 'Проверь проект', textOffset: 0,
        textLength: 14, textComplete: true, receivedBytes: 1, totalBytes: 1 }
    }
    if (method === 'ORCA_SEND') {
      accepted = true
      throw new Error('BLE disconnected after acceptance')
    }
    if (method === 'ORCA_JOB' && accepted) {
      return { ok: true, job: { id, state: 'running', stage: 'worker_working' } }
    }
    throw new Error(`unexpected ${method}`)
  }
  const states = []
  const client = createWatchClient({
    request: createOrcaVoiceRoute({ request: raw, context }),
    report: state => states.push(state),
    setTimer: setTimeout,
    clearTimer: clearTimeout,
    now: () => 1700000000000
  })

  client.start()
  await flush()
  assert.equal(client.beginRecording(id), true)
  await client.uploadAudio({ id, totalBytes: 1, readChunk: () => [7] })
  assert.equal(client.getState().phase, 'review')
  assert.equal(client.sendText(), true)
  await flush()
  assert.equal(client.getState().phase, 'unknown')
  client.refresh()
  await flush()
  assert.equal(client.getState().phase, 'job')
  assert.equal(rawCalls.filter(call => call.method === 'ORCA_SEND').length, 1)
  assert.equal(rawCalls.filter(call => call.method === 'ORCA_JOB').length, 1)
  assert.equal(rawCalls.some(call => ['SEND_TEXT', 'JOB_STATUS', 'LATEST_JOB', 'STATUS'].includes(call.method)), false)
  assert.equal(states.at(-1).id, id)
  client.close()
})

test('completed results and owner questions are assembled from every Orca page', async () => {
  const calls = []
  const context = { target: 'orca', pairId: 'pair-2', jobId: 'orca-2', aliasId: 'voice-2' }
  const route = createOrcaVoiceRoute({
    context,
    request: async payload => {
      calls.push(payload)
      const params = payload.params || {}
      if (params.cursor === undefined && params.questionCursor === undefined) {
        return { ok: true, job: { id: 'orca-2', state: 'completed', result: 'Первая ', nextCursor: 'result-2' } }
      }
      if (params.cursor === 'result-2') {
        return { ok: true, job: { id: 'orca-2', state: 'completed', result: 'вторая 🙂', nextCursor: null } }
      }
      throw new Error(`unexpected page ${JSON.stringify(params)}`)
    }
  })
  const completed = await route({ method: 'JOB_STATUS', params: { id: 'voice-2' } })
  assert.equal(completed.id, 'voice-2')
  assert.equal(completed.result, 'Первая вторая 🙂')
  assert.deepEqual(calls.map(call => call.params), [
    { id: 'orca-2' }, { id: 'orca-2', cursor: 'result-2' }
  ])

  calls.length = 0
  const questionRoute = createOrcaVoiceRoute({
    context,
    request: async payload => {
      calls.push(payload)
      const params = payload.params || {}
      if (params.questionCursor === undefined) {
        return { ok: true, job: { id: 'orca-2', state: 'question', stage: 'paused',
          questionId: 'question-4', question: 'Выбрать ', questionNextCursor: 'question-2' } }
      }
      return { ok: true, job: { id: 'orca-2', state: 'question',
        questionId: 'question-4', question: 'вариант Б?', questionNextCursor: null } }
    }
  })
  const question = await questionRoute({ method: 'JOB_STATUS', params: { id: 'voice-2' } })
  assert.equal(question.state, 'approval')
  assert.deepEqual(question.approval, { id: 'question-4', text: 'Выбрать вариант Б?' })
  assert.equal(context.pendingQuestionId, 'question-4')
  assert.equal(context.paused, true)
  assert.deepEqual(calls.at(-1).params, { id: 'orca-2', questionCursor: 'question-2' })
})

test('question pagination rejects a page from another job or question', async () => {
  for (const foreign of [
    { id: 'orca-foreign', questionId: 'question-4' },
    { id: 'orca-2', questionId: 'question-foreign' }
  ]) {
    const route = createOrcaVoiceRoute({
      context: { pairId: 'pair-1', jobId: 'orca-2', aliasId: 'voice-2' },
      request: async ({ params }) => params.questionCursor === undefined
        ? { ok: true, job: { id: 'orca-2', state: 'question', questionId: 'question-4',
          question: 'Первая часть', questionNextCursor: 'question-2' } }
        : { ok: true, job: { ...foreign, state: 'question', question: 'подмена', questionNextCursor: null } }
    })
    await assert.rejects(route({ method: 'JOB_STATUS', params: { id: 'voice-2' } }),
      /Не удалось прочитать весь вопрос/)
  }
})

test('question pagination rejects a repeated cursor', async () => {
  const route = createOrcaVoiceRoute({
    context: { pairId: 'pair-1', jobId: 'orca-2', aliasId: 'voice-2' },
    request: async ({ params }) => params.questionCursor === undefined
      ? { ok: true, job: { id: 'orca-2', state: 'question', questionId: 'question-4',
        question: 'Первая часть', questionNextCursor: 'same-cursor' } }
      : { ok: true, job: { id: 'orca-2', state: 'question', questionId: 'question-4',
        question: 'Вторая часть', questionNextCursor: 'same-cursor' } }
  })
  await assert.rejects(route({ method: 'JOB_STATUS', params: { id: 'voice-2' } }),
    /Вопрос нужно открыть на Mac/)
})

test('folder latest operation propagates an upstream failure', async () => {
  const route = createFolderVoiceRoute({
    context: { operationId: 'folder-1' },
    request: async () => ({ ok: false, error: 'Mac offline' })
  })
  assert.deepEqual(await route({ method: 'LATEST_JOB' }), { ok: false, error: 'Mac offline' })
})

test('project rejection retains the transcript across reopening and refresh never repeats creation', async () => {
  const id = '1700000000000-1'
  const text = 'Проект называется такси дубай.'
  const context = { target: 'folder', rootId: 'external' }
  const calls = []
  let saved
  const request = async payload => {
    calls.push(payload)
    if (payload.method === 'ORCA_PROJECT_PLAN') return { ok: false, code: 'PROJECT_REJECTED', error: 'Укажите название' }
    if (payload.method === 'AUDIO_STATUS') return { ok: true, id, state: 'ready', text,
      textLength: text.length, textOffset: 0, textComplete: true }
    throw Error(payload.method)
  }
  const route = createFolderVoiceRoute({ request, context, save: value => { saved = { ...value } } })
  const rejected = await route({ method: 'SEND_TEXT', params: { id, textId: id } })
  assert.equal(rejected.state, 'error')
  assert.equal(rejected.retryTextId, id)
  assert.equal(saved.operationId, null)
  const client = createWatchClient({ request: createFolderVoiceRoute({ request, context: saved }),
    report() {}, setTimer: setTimeout, clearTimer: clearTimeout })
  client.start()
  await flush()
  assert.equal(client.getState().errorKind, 'rejected')
  assert.equal(client.getState().retryMethod, 'AUDIO_STATUS')
  client.refresh()
  await flush()
  assert.equal(client.getState().phase, 'review')
  assert.equal(client.getState().text, text)
  assert.equal(client.getState().textId, id)
  assert.equal(client.getState().jobId, null)
  assert.equal(calls.filter(call => call.method === 'ORCA_PROJECT_PLAN').length, 1)
  assert.equal(calls.filter(call => call.method === 'ORCA_OPERATION').length, 0)
  client.close()
})

test('old missing operation becomes recoverable but a lost creation receipt keeps its operation id', async () => {
  const id = '1700000000000-1'
  const context = { target: 'folder', rootId: 'external', operationId: id }
  const calls = []
  let missing = true
  const route = createFolderVoiceRoute({ context, request: async payload => {
    calls.push(payload)
    if (payload.method === 'ORCA_OPERATION') return missing
      ? { ok: false, code: 'OPERATION_NOT_FOUND', error: 'Операция не найдена' }
      : { ok: true, operation: { id, state: 'running' } }
    if (payload.method === 'ORCA_PROJECT_PLAN') throw Error('receipt lost')
    throw Error(payload.method)
  } })
  const restored = await route({ method: 'LATEST_JOB' })
  assert.equal(restored.job.retryTextId, id)
  assert.equal(context.operationId, null)
  await assert.rejects(route({ method: 'SEND_TEXT', params: { id, textId: id } }), /receipt lost/)
  assert.equal(context.operationId, id)
  assert.equal(context.rejectedTextId, null)
  missing = false
  const recovered = await route({ method: 'JOB_STATUS', params: { id } })
  assert.equal(recovered.state, 'running')
  assert.equal(calls.filter(call => call.method === 'ORCA_PROJECT_PLAN').length, 1)
})

test('answering a stored question uses ORCA_REPLY with the exact job and question ids', async () => {
  const calls = []
  const context = { target: 'orca', pairId: 'pair-3', jobId: 'orca-3', aliasId: 'voice-3',
    answering: true, pendingQuestionId: 'question-8' }
  const route = createOrcaVoiceRoute({
    context,
    request: async payload => {
      calls.push(payload)
      return { ok: true, job: { id: 'orca-3', state: 'running', stage: 'reviewer_working' } }
    }
  })
  const reply = await route({ method: 'SEND_TEXT', params: { id: 'answer-1', textId: 'answer-1' } })
  assert.deepEqual(calls[0], { method: 'ORCA_REPLY', params: {
    id: 'orca-3', questionId: 'question-8', textId: 'answer-1'
  } })
  assert.equal(reply.id, 'answer-1')
  assert.equal(context.answering, false)
  assert.equal(calls.some(call => call.method === 'ORCA_SEND' || call.method === 'SEND_TEXT'), false)
})

test('folder transcript queues a plan and restart polls the same operation without creating it again', async () => {
  const id = '1700000000000-11'
  const calls = []
  const context = { target: 'folder', rootId: 'storage', createdPairId: 'stale-pair', createdJobId: 'stale-job' }
  const request = async payload => {
    calls.push(payload)
    if (payload.method === 'ORCA_PROJECT_PLAN') {
      return { ok: true, operation: { id, state: 'queued', phase: 'planning', message: 'Разбираю задачу' } }
    }
    if (payload.method === 'ORCA_OPERATION') {
      return { ok: true, operation: { id, state: 'running', phase: 'planning', message: 'Строю план' } }
    }
    throw Error(payload.method)
  }
  const first = createFolderVoiceRoute({ request, context })
  const queued = await first({ method: 'SEND_TEXT', params: { id, textId: id } })
  assert.deepEqual(calls[0], { method: 'ORCA_PROJECT_PLAN', params: { id, textId: id, rootId: 'storage' } })
  assert.equal(queued.state, 'queued')
  assert.equal(context.operationId, id)
  assert.equal(context.originalTextId, id)
  assert.equal(context.operationStage, 'planning')
  assert.equal(context.createdPairId, null)
  assert.equal(context.createdJobId, null)

  const restored = await createFolderVoiceRoute({ request, context })({ method: 'LATEST_JOB' })
  assert.equal(restored.job.state, 'running')
  assert.deepEqual(calls[1], { method: 'ORCA_OPERATION', params: { id } })
  assert.equal(calls.filter(call => call.method === 'ORCA_PROJECT_PLAN').length, 1)
})

test('project plan approval is assembled from all pages and keeps model text', async () => {
  const id = 'plan-1'
  const calls = []
  const context = { target: 'folder', rootId: 'storage', operationId: id }
  const route = createFolderVoiceRoute({ context, request: async payload => {
    calls.push(payload)
    if (payload.params.cursor === undefined) return { ok: true, operation: {
      id, state: 'approval', phase: 'planning',
      approval: { id: 'approval-9', kind: 'plan', text: 'Боевой: Codex · gpt-5.\n' },
      nextCursor: 'page-2'
    } }
    return { ok: true, operation: {
      id, state: 'approval', phase: 'planning',
      approval: { id: 'approval-9', kind: 'plan', text: 'Проверяющий: Claude · sonnet.' },
      nextCursor: null
    } }
  } })
  const latest = await route({ method: 'LATEST_JOB' })
  assert.equal(latest.job.state, 'approval')
  assert.deepEqual(latest.job.approval, {
    id: 'approval-9',
    text: 'Боевой: Codex · gpt-5.\nПроверяющий: Claude · sonnet.'
  })
  assert.equal(context.approvalKind, 'plan')
  assert.equal(context.approvalMessage, latest.job.approval.text)
  assert.deepEqual(calls.map(call => call.params), [{ id }, { id, cursor: 'page-2' }])
})

test('project approval pagination rejects foreign operation, approval and repeated cursors', async () => {
  for (const foreign of [
    { id: 'other', approval: { id: 'approval-1', kind: 'plan', text: 'подмена' }, nextCursor: null },
    { id: 'plan-1', approval: { id: 'approval-2', kind: 'plan', text: 'подмена' }, nextCursor: null }
  ]) {
    const route = createFolderVoiceRoute({
      context: { target: 'folder', rootId: 'storage', operationId: 'plan-1' },
      request: async ({ params }) => params.cursor === undefined
        ? { ok: true, operation: { id: 'plan-1', state: 'approval',
          approval: { id: 'approval-1', kind: 'plan', text: 'Первая часть' }, nextCursor: 'next' } }
        : { ok: true, operation: { ...foreign, state: 'approval' } }
    })
    await assert.rejects(route({ method: 'LATEST_JOB' }), /Не удалось прочитать весь план/)
  }

  const repeated = createFolderVoiceRoute({
    context: { target: 'folder', rootId: 'storage', operationId: 'plan-1' },
    request: async ({ params }) => ({ ok: true, operation: {
      id: 'plan-1', state: 'approval', approval: { id: 'approval-1', kind: 'plan', text: 'часть' },
      nextCursor: params.cursor === undefined ? 'same' : 'same'
    } })
  })
  await assert.rejects(repeated({ method: 'LATEST_JOB' }), /План нужно открыть на Mac/)
})

test('clarification records its parent and the next voice transcript creates a new plan operation', async () => {
  const calls = []
  const context = { target: 'folder', rootId: 'storage', operationId: 'plan-1' }
  const route = createFolderVoiceRoute({ context, request: async payload => {
    calls.push(payload)
    if (payload.method === 'ORCA_OPERATION') return { ok: true, operation: {
      id: 'plan-1', state: 'clarification', phase: 'planning', message: 'Какой результат должен получить пользователь?'
    } }
    if (payload.method === 'ORCA_PROJECT_PLAN') return { ok: true, operation: {
      id: 'voice-2', state: 'queued', phase: 'planning', message: 'Уточнение принято'
    } }
    throw Error(payload.method)
  } })
  const question = await route({ method: 'LATEST_JOB' })
  assert.equal(question.job.state, 'approval')
  assert.equal(question.job.approval, undefined)
  assert.equal(context.approvalKind, 'clarification')
  assert.equal(context.approvalMessage, 'Какой результат должен получить пользователь?')

  context.answering = true
  context.parentPlanId = 'plan-1'
  assert.deepEqual(await route({ method: 'LATEST_JOB' }), { ok: true, job: null })
  const queued = await route({ method: 'SEND_TEXT', params: { id: 'voice-2', textId: 'voice-2' } })
  assert.equal(queued.state, 'queued')
  assert.deepEqual(calls.at(-1), { method: 'ORCA_PROJECT_PLAN', params: {
    id: 'voice-2', textId: 'voice-2', rootId: 'storage', parentId: 'plan-1'
  } })
  assert.equal(context.operationId, 'voice-2')
  assert.equal(context.answering, false)
  assert.equal(context.parentPlanId, null)
})

test('a rejected clarification keeps its parent when the saved transcript is submitted again', async () => {
  const calls = []
  let rejected = true
  const context = { target: 'folder', rootId: 'storage', answering: true,
    parentPlanId: 'plan-1', operationId: 'plan-1' }
  const route = createFolderVoiceRoute({ context, request: async payload => {
    calls.push(payload)
    if (payload.method === 'ORCA_PROJECT_PLAN' && rejected) {
      rejected = false
      return { ok: false, code: 'PROJECT_REJECTED', error: 'Слишком длинное уточнение' }
    }
    return { ok: true, operation: { id: 'voice-2', state: 'queued', phase: 'planning' } }
  } })
  const first = await route({ method: 'SEND_TEXT', params: { id: 'voice-2', textId: 'voice-2' } })
  assert.equal(first.retryTextId, 'voice-2')
  assert.equal(context.parentPlanId, 'plan-1')
  const second = await route({ method: 'SEND_TEXT', params: { id: 'voice-2', textId: 'voice-2' } })
  assert.equal(second.state, 'queued')
  assert.deepEqual(calls[1].params, {
    id: 'voice-2', textId: 'voice-2', rootId: 'storage', parentId: 'plan-1'
  })
})

test('folder trust decision uses its exact approval and decline is never replayed after a lost receipt', async () => {
  const calls = []
  let accepted = false
  const context = { target: 'folder', rootId: 'storage', operationId: 'plan-1',
    approvalKind: 'folder_trust', currentApprovalId: 'trust-7' }
  const route = createFolderVoiceRoute({ context, request: async payload => {
    calls.push(payload)
    if (payload.method === 'ORCA_PROJECT_DECIDE') {
      accepted = true
      throw Error('receipt lost')
    }
    if (payload.method === 'ORCA_OPERATION' && accepted) return { ok: true, operation: {
      id: 'plan-1', state: 'cancelled', phase: 'creating', message: 'Доступ отклонён. Папка сохранена.'
    } }
    throw Error(payload.method)
  } })
  await assert.rejects(route({ method: 'JOB_APPROVE', params: {
    id: 'plan-1', approvalId: 'trust-7', allow: false
  } }), /receipt lost/)
  const recovered = await route({ method: 'JOB_STATUS', params: { id: 'plan-1' } })
  assert.equal(recovered.state, 'completed')
  assert.match(recovered.result, /Доступ отклонён/)
  assert.equal(context.operationState, 'cancelled')
  assert.equal(context.createdPairId, null)
  assert.equal(context.createdJobId, null)
  assert.equal(calls.filter(call => call.method === 'ORCA_PROJECT_DECIDE').length, 1)
  assert.deepEqual(calls[0].params, { id: 'plan-1', approvalId: 'trust-7', allow: false })
})

test('completed project keeps the created pair and coordinator receipt for an explicit handoff', async () => {
  const context = { target: 'folder', rootId: 'storage', operationId: 'plan-1' }
  const route = createFolderVoiceRoute({ context, request: async () => ({ ok: true, operation: {
    id: 'plan-1', state: 'completed', phase: 'creating', message: 'Проект создан',
    workspace: { path: '/Volumes/Data/Projects/Atlas', projectLabel: 'Atlas' },
    pair: { id: 'pair-8', projectLabel: 'Atlas', workerAgent: 'codex', reviewerAgent: 'claude',
      workerModel: 'gpt-5', reviewerModel: 'sonnet' },
    jobId: 'job-8'
  } }) })
  const completed = await route({ method: 'LATEST_JOB' })
  assert.equal(completed.job.state, 'completed')
  assert.equal(context.target, 'folder')
  assert.equal(context.createdPairId, 'pair-8')
  assert.equal(context.createdJobId, 'job-8')
  assert.equal(context.createdWorkerModel, 'gpt-5')
  assert.match(completed.job.result, /Связка готова в Orca/)
})

test('explicit project handoff resumes the saved coordinator job instead of selecting another latest job', async () => {
  const calls = []
  const context = { target: 'orca', pairId: 'pair-8', jobId: 'job-8', aliasId: 'job-8', resumeJob: true }
  const route = createOrcaVoiceRoute({ context, request: async payload => {
    calls.push(payload)
    return { ok: true, job: { id: 'job-8', state: 'running', stage: 'coordinator_starting' } }
  } })
  const latest = await route({ method: 'LATEST_JOB' })
  assert.deepEqual(calls, [{ method: 'ORCA_JOB', params: { id: 'job-8' } }])
  assert.equal(latest.job.state, 'running')
  assert.equal(context.resumeJob, false)
})

test('unknown startup resumes only on explicit refresh; reopening is read-only', async () => {
  const calls = []
  const context = { target: 'folder', operationId: '200-1' }
  const route = createFolderVoiceRoute({ context, request: async payload => {
    calls.push(payload.method)
    return { ok: true, operation: { id: '200-1', state: payload.method === 'ORCA_PROJECT_RESUME' ? 'queued' : 'unknown',
      canResume: payload.method !== 'ORCA_PROJECT_RESUME', phase: 'creating', message: 'Запуск сохранён' } }
  } })
  await route({ method: 'LATEST_JOB' })
  assert.deepEqual(calls, ['ORCA_OPERATION'])
  await route({ method: 'JOB_STATUS', params: { id: '200-1' } })
  assert.equal(calls.at(-1), 'ORCA_PROJECT_RESUME')
  await route({ method: 'JOB_STATUS', params: { id: '200-1' } })
  assert.equal(calls.at(-1), 'ORCA_OPERATION')
})

test('a question to one role routes to ORCA_ASK and remembers the proposed handoff', async () => {
  const calls = []
  const context = { target: 'orca', pairId: 'pair-7', askRole: 'reviewer' }
  const route = createOrcaVoiceRoute({
    context,
    request: async payload => {
      calls.push(payload)
      if (payload.method === 'ORCA_ASK') {
        return { ok: true, job: { id: 'ask-9', state: 'queued', stage: 'queued', mode: 'ask', askRole: 'reviewer' } }
      }
      if (payload.method === 'ORCA_JOB') {
        return { ok: true, job: { id: 'ask-9', state: 'completed', stage: 'completed', mode: 'ask', askRole: 'reviewer',
          result: 'Мы на этапе 2.', handoff: true, nextCursor: null } }
      }
      throw new Error(`unexpected ${payload.method}`)
    }
  })
  const sent = await route({ method: 'SEND_TEXT', params: { id: '1700000000000-1', textId: '1700000000000-1' } })
  assert.deepEqual(calls[0], { method: 'ORCA_ASK', params: {
    id: '1700000000000-1', textId: '1700000000000-1', pairId: 'pair-7', role: 'reviewer'
  } })
  assert.equal(sent.state, 'queued')
  assert.equal(context.mode, 'ask')
  assert.equal(context.handoff, false)
  const done = await route({ method: 'JOB_STATUS', params: { id: '1700000000000-1' } })
  assert.equal(done.state, 'completed')
  assert.equal(done.result, 'Мы на этапе 2.')
  assert.equal(context.handoff, true)
  assert.equal(context.mode, 'ask')
  assert.equal(calls.some(call => call.method === 'ORCA_SEND'), false)
})
