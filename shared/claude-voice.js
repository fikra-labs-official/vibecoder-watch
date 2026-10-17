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
    let cursor = job.nextCursor
    let length = Array.from(publicJob.result).length
    const seen = new Set()
    while (job.state === 'completed' && cursor != null) {
      if (options && typeof options.onRouteProgress === 'function') options.onRouteProgress()
      if (seen.has(cursor) || seen.size >= 128 || length > 100000) throw new Error('Ответ слишком большой. Полный текст сохранён на Mac.')
      seen.add(cursor)
      const page = await request({ method: prefix + '_JOB', params: { id: job.id, cursor } }, options)
      if (!page || !page.ok || !page.job || page.job.id !== job.id) throw new Error('Не удалось получить продолжение ответа')
      publicJob.result += page.job.result || ''
      length += Array.from(page.job.result || '').length
      if (length > 100000) throw new Error('Ответ слишком большой. Полный текст сохранён на Mac.')
      cursor = page.job.nextCursor
    }
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
      remember({ aliasId: params.id, pendingSend: true })
      const sendParams = { id: params.id, textId: params.textId || params.id, project: context.project, mode: context.mode || 'auto' }
      if (context.sessionId) sendParams.sessionId = context.sessionId
      if (context.night === true) sendParams.night = true
      if (typeof context.presetId === 'string' && context.presetId) sendParams.presetId = context.presetId  // e.g. «проверь PR 12»
      if (context.kind === 'research' || context.kind === 'deep') {
        sendParams.kind = context.kind
        if (context.kind === 'research' && context.both === true) sendParams.both = true  // the bridge mirrors the topic to the other agent
      }
      return jobReply(await request({ method: prefix + '_SEND', params: sendParams }, options), params.id, options)
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
