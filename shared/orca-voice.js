// Keep the proven recorder/ASR UI shared; only confirmed command routing changes.
export function createOrcaVoiceRoute({ request, context, save = () => {} }) {
  const remember = values => { Object.assign(context, values); save(context) }
  async function jobReply(reply, alias, options) {
    if (options && typeof options.onRouteProgress === 'function') options.onRouteProgress()
    if (!reply || reply.ok !== true) return reply
    const job = reply.job
    if (!job) return { ok: true, job: null }
    if (!job.id || !['queued', 'running', 'question', 'completed', 'error', 'unknown'].includes(job.state)) {
      throw new Error('Некорректный ответ Orca')
    }
    remember({ jobId: job.id, aliasId: alias || context.aliasId || job.id,
      answering: false, pendingSend: false,
      stage: job.stage, paused: job.stage === 'paused',
      mode: job.mode === 'ask' ? 'ask' : 'task', handoff: job.handoff === true })
    const publicJob = { ok: true, id: context.aliasId, state: job.state === 'question' ? 'approval' : job.state,
      result: job.result || job.summary || '', text: '', error: job.error || '',
      orcaStage: job.stage, questionId: job.questionId || null }
    // Read every page; a short BLE envelope must not silently lose the answer/question.
    let cursor = job.nextCursor
    let length = Array.from(publicJob.result).length
    const seen = new Set()
    while (job.state === 'completed' && cursor != null) {
      if (options && typeof options.onRouteProgress === 'function') options.onRouteProgress()
      if (seen.has(cursor) || seen.size >= 128 || length > 100000) throw new Error('Ответ слишком большой. Полный отчёт сохранён на Mac.')
      seen.add(cursor)
      const page = await request({ method: 'ORCA_JOB', params: { id: job.id, cursor } }, options)
      if (!page || !page.ok || !page.job || page.job.id !== job.id) throw new Error('Не удалось получить продолжение ответа')
      publicJob.result += page.job.result || ''
      length += Array.from(page.job.result || '').length
      if (length > 100000) throw new Error('Ответ слишком большой. Полный отчёт сохранён на Mac.')
      cursor = page.job.nextCursor
    }
    if (job.state === 'question') {
      if (!job.questionId) throw new Error('Некорректный вопрос Orca')
      remember({ pendingQuestionId: job.questionId })
      let question = job.question || job.summary || 'Нужен ответ владельца'
      let next = job.questionNextCursor
      while (next != null) {
        if (options && typeof options.onRouteProgress === 'function') options.onRouteProgress()
        if (seen.has(next) || seen.size >= 64 || Array.from(question).length > 30000) throw new Error('Вопрос нужно открыть на Mac')
        seen.add(next)
        const more = await request({ method: 'ORCA_JOB', params: { id: job.id, questionCursor: next } }, options)
        if (!more || !more.ok || !more.job || more.job.id !== job.id || more.job.questionId !== job.questionId) {
          throw new Error('Не удалось прочитать весь вопрос')
        }
        question += more.job.question || ''
        if (Array.from(question).length > 30000) throw new Error('Вопрос нужно открыть на Mac')
        next = more.job.questionNextCursor
      }
      publicJob.approval = { id: job.questionId, text: question }
    }
    return publicJob
  }
  return async function route(payload, options) {
    const { method, params = {} } = payload
    if (method === 'STATUS') return { ok: true, agent: 'Orca' }
    if (method === 'LATEST_JOB') {
      if (context.answering && !context.pendingSend) return { ok: true, job: null }
      const pendingId = context.pendingSend === true && (context.answering ? context.jobId : context.aliasId)
      const resumeId = context.resumeJob === true && context.jobId
      const exactId = pendingId || resumeId
      const reply = await request(exactId
        ? { method: 'ORCA_JOB', params: { id: exactId } }
        : { method: 'ORCA_LATEST', params: { pairId: context.pairId } }, options)
      if (resumeId && reply && reply.ok) remember({ resumeJob: false })
      if (!pendingId && reply && reply.ok && reply.job && context.jobId !== reply.job.id) remember({ aliasId: reply.job.id })
      const job = await jobReply(reply, null, options)
      return job && job.ok ? { ok: true, job: job.job === null ? null : job } : job
    }
    if (method === 'SEND_TEXT') {
      remember({ aliasId: params.id, pendingSend: true })
      const reply = context.answering
        ? await request({ method: 'ORCA_REPLY', params: { id: context.jobId, questionId: context.pendingQuestionId, textId: params.textId || params.id } }, options)
        : context.askRole
          ? await request({ method: 'ORCA_ASK', params: { id: params.id, textId: params.textId || params.id, pairId: context.pairId, role: context.askRole } }, options)
          : await request({ method: 'ORCA_SEND', params: { id: params.id, textId: params.textId || params.id, pairId: context.pairId } }, options)
      if (reply && reply.ok) remember({ answering: false })
      return jobReply(reply, params.id, options)
    }
    if (method === 'JOB_STATUS') {
      const pendingId = context.pendingSend === true && (context.answering ? context.jobId : context.aliasId)
      return jobReply(await request({ method: 'ORCA_JOB', params: { id: pendingId || context.jobId || params.id } }, options), params.id, options)
    }
    if (method === 'JOB_APPROVE') return { ok: false, error: 'Ответьте на вопрос голосом в Orca' }
    return request(payload, options)
  }
}

export function createFolderVoiceRoute({ request, context, save = () => {} }) {
  const remember = values => { Object.assign(context, values); save(context) }
  const clearCreated = {
    createdPairId: null, createdLabel: null,
    createdWorkerAgent: '', createdReviewerAgent: '',
    createdWorkerModel: '', createdReviewerModel: '',
    createdJobId: null, createdWorkspace: null
  }
  function rejected(id, message) {
    remember({ operationId: null, pendingSend: false, answering: false,
      approvalKind: null, approvalMessage: null, currentApprovalId: null,
      rejectedTextId: id, rejection: message })
    return { ok: true, id, state: 'error', error: message, retryTextId: id }
  }
  async function operation(reply, id, options) {
    if (options && typeof options.onRouteProgress === 'function') options.onRouteProgress()
    if (reply && reply.ok === false && ['PROJECT_REJECTED', 'OPERATION_NOT_FOUND'].includes(reply.code)) {
      return rejected(id, reply.code === 'OPERATION_NOT_FOUND'
        ? 'План проекта не найден. Текст сохранён. Вернитесь к нему или откройте меню Orca.'
        : reply.error)
    }
    if (!reply || !reply.ok) return reply
    const item = reply.operation
    if (!item || item.id !== id) throw new Error('Не удалось прочитать план проекта')

    let approval = item.approval
    if (item.state === 'approval') {
      if (!approval || typeof approval.id !== 'string' ||
          !['plan', 'folder_trust'].includes(approval.kind) || typeof approval.text !== 'string') {
        throw new Error('Некорректное подтверждение проекта')
      }
      let cursor = item.nextCursor
      let text = approval.text
      if (Array.from(text).length > 30000) throw new Error('План нужно открыть на Mac')
      const seen = new Set()
      while (cursor != null) {
        if (options && typeof options.onRouteProgress === 'function') options.onRouteProgress()
        if (seen.has(cursor) || seen.size >= 64) throw new Error('План нужно открыть на Mac')
        seen.add(cursor)
        const page = await request({ method: 'ORCA_OPERATION', params: { id, cursor } }, options)
        const next = page && page.operation
        if (!page || !page.ok || !next || next.id !== id || next.state !== 'approval' ||
            !next.approval || next.approval.id !== approval.id || next.approval.kind !== approval.kind ||
            typeof next.approval.text !== 'string') {
          throw new Error('Не удалось прочитать весь план')
        }
        text += next.approval.text
        if (Array.from(text).length > 30000) throw new Error('План нужно открыть на Mac')
        cursor = next.nextCursor
      }
      approval = { ...approval, text }
    } else if (item.state === 'clarification' && (approval || item.nextCursor != null)) {
      throw new Error('Некорректный вопрос проекта')
    }

    const pair = item.pair
    const pairId = (typeof pair === 'string' ? pair : pair && pair.id) || item.pairId
    const label = pair && typeof pair === 'object' && pair.projectLabel ||
      item.workspace && typeof item.workspace === 'object' &&
        (item.workspace.projectLabel || item.workspace.label || item.workspace.name) || context.label || 'Проект'
    const approvalKind = item.state === 'clarification' ? 'clarification'
      : item.state === 'approval' ? approval.kind : null
    const approvalMessage = item.state === 'clarification' ? item.message || 'Orca просит уточнить задачу.'
      : approval ? approval.text : null
    const values = {
      operationId: id,
      canResume: item.canResume === true,
      operationState: item.state,
      operationStage: item.phase || (['queued', 'running'].includes(item.state) ? 'planning' : null),
      stage: item.phase || (['queued', 'running'].includes(item.state) ? 'planning' : null),
      approvalKind,
      approvalMessage,
      currentApprovalId: approval && approval.id || null,
      pendingSend: false,
      answering: false,
      parentPlanId: null
    }
    if (item.state === 'cancelled' || item.state === 'clarification' ||
        (item.state === 'approval' && approval.kind === 'plan')) Object.assign(values, clearCreated)
    if (item.state === 'completed') Object.assign(values, {
      createdPairId: pairId || null,
      createdLabel: label,
      createdWorkerAgent: pair && typeof pair === 'object' ? pair.workerAgent || '' : '',
      createdReviewerAgent: pair && typeof pair === 'object' ? pair.reviewerAgent || '' : '',
      createdWorkerModel: pair && typeof pair === 'object' ? pair.workerModel || pair.models && pair.models.worker || '' : '',
      createdReviewerModel: pair && typeof pair === 'object' ? pair.reviewerModel || pair.models && pair.models.reviewer || '' : '',
      createdJobId: item.jobId || null,
      createdWorkspace: item.workspace || null
    })
    remember(values)

    const state = ({ queued: 'queued', running: 'running', clarification: 'approval',
      approval: 'approval', completed: 'completed', cancelled: 'completed',
      error: 'error', unknown: 'unknown' })[item.state] || 'unknown'
    let result = item.message || ''
    if (item.state === 'completed') {
      const path = typeof item.workspace === 'string' ? item.workspace
        : item.workspace && item.workspace.path || item.path || ''
      result = [item.message || 'Проект создан.', path,
        pairId ? 'Связка готова в Orca.' : 'Открой Orca и выбери связку.'].filter(Boolean).join('\n')
    }
    const publicItem = { ok: true, id, state, text: '', result,
      error: item.state === 'error' ? item.message || 'Не удалось создать проект' : '' }
    if (item.state === 'approval') publicItem.approval = { id: approval.id, text: approval.text }
    return publicItem
  }
  return async (payload, options) => {
    const { method, params = {} } = payload
    if (method === 'STATUS') return { ok: true, agent: 'Orca' }
    if (method === 'LATEST_JOB') {
      if (context.answering && !context.pendingSend) return { ok: true, job: null }
      if (!context.operationId) return { ok: true, job: context.rejectedTextId
        ? rejected(context.rejectedTextId, context.rejection) : null }
      const id = context.operationId
      const job = await operation(await request({ method: 'ORCA_OPERATION', params: { id } }, options), id, options)
      return job && job.ok ? { ok: true, job } : job
    }
    if (method === 'SEND_TEXT') {
      const parentId = context.parentPlanId || null
      remember({ operationId: params.id, originalTextId: context.originalTextId || params.textId || params.id,
        pendingSend: true, operationStage: 'planning', stage: 'planning', approvalKind: null,
        approvalMessage: null, currentApprovalId: null, rejectedTextId: null, rejection: null,
        ...clearCreated })
      const planParams = { id: params.id, textId: params.textId || params.id, rootId: context.rootId }
      if (parentId) planParams.parentId = parentId
      return operation(await request({ method: 'ORCA_PROJECT_PLAN', params: planParams }, options), params.id, options)
    }
    if (method === 'JOB_STATUS') {
      const id = context.operationId || params.id
      const method = context.canResume && context.operationState === 'unknown' ? 'ORCA_PROJECT_RESUME' : 'ORCA_OPERATION'
      // Only an explicit Refresh from the unknown screen continues saved stages.
      // Startup recovery (LATEST_JOB) remains read-only.
      remember({ canResume: false })
      return operation(await request({ method, params: { id } }, options), id, options)
    }
    if (method === 'JOB_APPROVE') {
      const id = context.operationId
      if (!id || params.id !== id || !context.currentApprovalId ||
          params.approvalId !== context.currentApprovalId ||
          !['plan', 'folder_trust'].includes(context.approvalKind)) {
        return { ok: false, error: 'Это решение уже устарело. Обновите статус.' }
      }
      return operation(await request({ method: 'ORCA_PROJECT_DECIDE', params: {
        id, approvalId: params.approvalId, allow: params.allow === true
      } }, options), id, options)
    }
    return request(payload, options)
  }
}
