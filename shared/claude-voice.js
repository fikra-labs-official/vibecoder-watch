// Claude from the watch: the shared recorder/review UI stays; only routing changes.
// A task runs headless in the chosen project; the session Claude returns is kept
// so the next dictation continues the same conversation.
export function createAgentVoiceRoute({ request, context, save = () => {}, prefix = 'CLAUDE', agent = 'Claude' }) {
  const remember = values => { Object.assign(context, values); save(context) }
  async function jobReply(reply, alias, options) {
    if (options && typeof options.onRouteProgress === 'function') options.onRouteProgress()
    if (!reply || reply.ok !== true) return reply
    const job = reply.job
    if (!job) return { ok: true, job: null }
    if (!job.id || !['night', 'submitting', 'queued', 'running', 'approval', 'completed', 'error', 'unknown'].includes(job.state)) {
      throw new Error(`Некорректный ответ ${agent}`)
    }
    remember({ jobId: job.id, aliasId: alias || context.aliasId || job.id, pendingSend: false,
      sessionId: typeof job.sessionId === 'string' && job.sessionId ? job.sessionId : context.sessionId || null })
    const publicJob = { ok: true, id: context.aliasId, state: job.state, result: job.result || '',
      text: '', error: job.error || '' }
    if (job.state === 'error' && job.error === 'Остановлено с часов') {
      publicJob.state = 'cancelled'
      publicJob.result = job.error
    }
    if (job.state === 'night') {
      // Waiting for the night shift: the shared recorder shows it as a finished answer with the waiting note.
      publicJob.state = 'completed'
      publicJob.result = job.result || 'Задача ждёт ночной смены.'
    }
    if (job.state === 'approval') {
      const approval = job.approval
      publicJob.approval = approval && typeof approval.id === 'string' && typeof approval.text === 'string'
        ? { id: approval.id, text: approval.text } : null
      if (publicJob.approval && typeof approval.question === 'string' && Array.isArray(approval.options) &&
          approval.options.every(o => typeof o === 'string')) {
        Object.assign(publicJob.approval, { question: approval.question, options: approval.options, step: approval.step })
      }
    }
    // The first result renders immediately; the full reader streams history chunks.
    publicJob.reportLength = Number.isInteger(job.resultLength) ? job.resultLength : Array.from(publicJob.result).length
    return publicJob
  }
  return async function route(payload, options) {
    const { method, params = {} } = payload
    if (method === 'STATUS') return { ok: true, agent }
    if (method === 'LATEST_JOB' && context.kind === 'watch') return { ok: true, job: null }
    if (method === 'SEND_TEXT' && context.kind === 'watch') {
      // A dictated site address becomes a standing check; the reply is shown like a finished answer.
      const reply = await request({ method: 'WATCH_ADD', params: { kind: 'url', textId: params.textId || params.id } }, options)
      if (!reply || reply.ok !== true) return reply
      remember({ jobId: null, aliasId: params.id, pendingSend: false })
      return { ok: true, id: params.id, state: 'completed', result: reply.message || 'Дозор поставлен', text: '', error: '' }
    }
    if (method === 'LATEST_JOB') {
      if (context.startFresh === true && !context.pendingSend) return { ok: true, job: null }
      const pendingId = context.pendingSend === true && context.aliasId
      const resumeId = context.resumeJob === true && context.jobId
      const exactId = pendingId || resumeId
      const reply = await request(exactId
        ? { method: prefix + '_JOB', params: { id: exactId } }
        : { method: prefix + '_LATEST', params: { project: context.project } }, options)
      if (resumeId && reply && reply.ok) remember({ resumeJob: false })
      if (!pendingId && reply && reply.ok && reply.job && context.jobId !== reply.job.id) remember({ aliasId: reply.job.id })
      const job = await jobReply(reply, null, options)
      return job && job.ok ? { ok: true, job: job.job === null ? null : job } : job
    }
    if (method === 'SEND_TEXT') {
      remember({ aliasId: params.id, pendingSend: true, startFresh: false })
      const sendParams = { id: params.id, textId: params.textId || params.id, project: context.project, mode: context.mode || 'auto' }
      if (context.sessionId) sendParams.sessionId = context.sessionId
      if (context.night === true) sendParams.night = true
      if (typeof context.presetId === 'string' && context.presetId) sendParams.presetId = context.presetId  // e.g. «проверь PR 12»
      if (context.kind === 'research' || context.kind === 'deep') {
        sendParams.kind = context.kind
        if (context.kind === 'research' && context.both === true) sendParams.both = true  // the bridge mirrors the topic to the other agent
      }
      const reply = await request({ method: prefix + '_SEND', params: sendParams }, options)
      if (reply && !reply.ok && reply.retryable === false) remember({ pendingSend: false, startFresh: true })
      return jobReply(reply, params.id, options)
    }
    if (method === 'JOB_STATUS') {
      const id = context.pendingSend === true && context.aliasId ? context.aliasId : context.jobId || params.id
      return jobReply(await request({ method: prefix + '_JOB', params: { id } }, options), params.id, options)
    }
    if (method === 'JOB_APPROVE') {
      // The bridge holds Claude's prompt until this exact decision arrives.
      const decision = { id: context.jobId || params.id, approvalId: params.approvalId, allow: params.allow === true }
      if (typeof params.answer === 'string') decision.answer = params.answer
      return jobReply(await request({ method: prefix + '_APPROVE', params: decision }, options), params.id, options)
    }
    return request(payload, options)
  }
}

export const createClaudeVoiceRoute = options => createAgentVoiceRoute({ ...options, prefix: 'CLAUDE', agent: 'Claude' })
export const createCodexVoiceRoute = options => createAgentVoiceRoute({ ...options, prefix: 'CODEX', agent: 'Codex' })
