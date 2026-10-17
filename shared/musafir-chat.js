export const MUSAFIR_CONTEXT_KEY = 'musafir-context'
export const MUSAFIR_HERO_KEY = 'musafir-hero'

export const MUSAFIR_HEROES = [
  { id: 'musafir', name: 'Musafir', meaning: 'Путешественник' },
  { id: 'kashif', name: 'Kashif', meaning: 'Исследователь' },
  { id: 'barq', name: 'Barq', meaning: 'Молния' },
  { id: 'hakim', name: 'Hakim', meaning: 'Мудрый' },
  { id: 'amin', name: 'Amin', meaning: 'Надёжный' }
]

const LOCAL_ID = /^\d{1,16}-\d{1,8}$/
const JOB_STATES = new Set([
  'submitting', 'queued', 'running', 'stopping', 'approval',
  'completed', 'cancelled', 'error', 'unknown'
])

function validChatId(value) {
  return value === 'legacy' || typeof value === 'string' && LOCAL_ID.test(value)
}

function validJobId(value) {
  return typeof value === 'string' && LOCAL_ID.test(value)
}

export function heroById(id) {
  return MUSAFIR_HEROES.find(hero => hero.id === id) || MUSAFIR_HEROES[0]
}

export function normalizeContext(value) {
  const source = value && typeof value === 'object' ? value : {}
  const jobId = validJobId(source.jobId) ? source.jobId : null
  return {
    target: 'musafir',
    chatId: validChatId(source.chatId) ? source.chatId : null,
    mode: source.mode === 'research' ? 'research' : 'task',
    jobId,
    openJob: jobId !== null && source.openJob === true,
    autoRecord: source.autoRecord === true,
    pendingSend: jobId !== null && source.pendingSend === true
  }
}

export function createMusafirVoiceRoute({ request, context, save = () => {} }) {
  Object.assign(context, normalizeContext(context))
  const remember = values => { Object.assign(context, values); save(context) }

  function publicJob(reply, expectedId) {
    if (!reply || reply.ok !== true) return reply
    if (reply.id !== expectedId || !validJobId(reply.id) || !JOB_STATES.has(reply.state)) {
      throw new Error('Некорректный ответ Musafir')
    }
    const expectedChatId = context.chatId === null ? expectedId : context.chatId
    if (!validChatId(reply.chatId) || reply.chatId !== expectedChatId) {
      throw new Error('Задание относится к другому чату')
    }
    const mode = reply.mode === 'research' ? 'research' : 'task'
    const reportLength = Number.isInteger(reply.reportLength) && reply.reportLength >= 0
      ? reply.reportLength : 0
    remember({
      chatId: reply.chatId,
      jobId: reply.id,
      openJob: false,
      pendingSend: false
    })
    const result = reply.state === 'cancelled'
      ? reply.result || 'Задание остановлено'
      : typeof reply.result === 'string' ? reply.result : ''
    const job = {
      ok: true,
      id: reply.id,
      state: reply.state,
      text: typeof reply.text === 'string' ? reply.text : '',
      result,
      error: typeof reply.error === 'string' ? reply.error : '',
      chatId: reply.chatId,
      summary: typeof reply.summary === 'string' ? reply.summary : '',
      mode,
      reportLength
    }
    if (reply.approval && typeof reply.approval === 'object') job.approval = reply.approval
    return job
  }

  function exactId(params) {
    if (!validJobId(context.jobId) || params.id !== context.jobId) return null
    return context.jobId
  }

  return async function route(payload, options) {
    const { method, params = {} } = payload || {}
    if (method === 'STATUS') {
      // Recording is local. A deliberate New/Continue action must not wait for
      // network health; upload and job RPCs still verify the actual connection.
      if (context.autoRecord) return { ok: true, agent: 'Мусафир' }
      return request({ method: 'STATUS', params: {} }, options)
    }
    if (method === 'LATEST_JOB') {
      if ((!context.openJob && !context.pendingSend) || !validJobId(context.jobId)) {
        return { ok: true, job: null }
      }
      const id = context.jobId
      const reply = await request({ method: 'JOB_STATUS', params: { id, brief: true } }, options)
      const job = publicJob(reply, id)
      return job && job.ok ? { ok: true, job } : job
    }
    if (method === 'SEND_TEXT') {
      if (!validJobId(params.id)) return { ok: false, error: 'Некорректный ID задания' }
      const id = params.id
      const chatId = context.chatId
      const mode = context.mode
      remember({ jobId: id, openJob: false, pendingSend: true })
      return publicJob(await request({ method: 'SEND_TEXT', params: {
        ...params, id, chatId, mode
      } }, options), id)
    }
    if (method === 'JOB_STATUS') {
      const id = exactId(params)
      if (!id) return { ok: false, error: 'Это задание уже не открыто' }
      return publicJob(await request({ method: 'JOB_STATUS', params: { id, brief: true } }, options), id)
    }
    if (method === 'JOB_APPROVE') {
      const id = exactId(params)
      if (!id) return { ok: false, error: 'Это подтверждение уже устарело' }
      const decision = { id, approvalId: params.approvalId, allow: params.allow === true }
      if (typeof params.answer === 'string' && params.answer) decision.answer = params.answer
      return publicJob(await request({ method: 'JOB_APPROVE', params: decision }, options), id)
    }
    if (method === 'JOB_STOP') {
      const id = exactId(params)
      if (!id) return { ok: false, error: 'Это задание уже не открыто' }
      return publicJob(await request({ method: 'JOB_STOP', params: { id } }, options), id)
    }
    return request(payload, options)
  }
}
