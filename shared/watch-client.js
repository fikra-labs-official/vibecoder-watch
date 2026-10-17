const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
export function encodeAudioPart(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1] || 0, c = bytes[i + 2] || 0
    out += BASE64[a >> 2] + BASE64[((a & 3) << 4) | (b >> 4)] +
      (i + 1 < bytes.length ? BASE64[((b & 15) << 2) | (c >> 6)] : '=') +
      (i + 2 < bytes.length ? BASE64[c & 63] : '=')
  }
  return out
}

export const AUDIO_CHUNK_SIZE = 1024
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024
export const TRANSCRIPT_PAGE_SIZE = 1000
export const MAX_TRANSCRIPT_CODEPOINTS = 30000
export const TEXT_PART_SIZE = 1000
export const REQUEST_TIMEOUT_MS = 15000
export const HANDSHAKE_TIMEOUT_MS = 20000
export const TRANSCRIPTION_POLL_MS = 2000
export const JOB_POLL_MS = 3000

const LOCAL_ID = /^\d{1,16}-\d{1,8}$/
const JOB_STATES = new Set([
  'transcribing', 'ready', 'submitting', 'queued', 'running', 'stopping', 'approval',
  'completed', 'cancelled', 'error', 'unknown'
])
const RETRYABLE_READS = new Set(['STATUS', 'LATEST_JOB', 'AUDIO_STATUS', 'JOB_STATUS'])

function messageOf(error) {
  if (!error) return 'Неизвестная ошибка'
  if (error.message === 'REQUEST_TIMEOUT') return 'Телефон не ответил'
  return typeof error.message === 'string' ? error.message : 'Ошибка связи'
}

function validReply(reply) {
  return reply && reply.ok === true
}

function normalizeReviewText(value) {
  if (typeof value !== 'string' || value.includes('\0')) return null
  if (!value.trim() || Array.from(value).length > MAX_TRANSCRIPT_CODEPOINTS) return null
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if ((code <= 0x1f && code !== 0x09 && code !== 0x0a) ||
        (code >= 0x7f && code <= 0x9f)) return null
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return null
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return null
    }
  }
  return value
}

export function createWatchClient({
  request,
  report,
  setTimer,
  clearTimer,
  now = Date.now,
  readAcknowledgedResultId = () => null,
  writeAcknowledgedResultId = () => {},
  readDraft = () => null,
  writeDraft = () => {}
}) {
  let closed = false
  let generation = 0
  let sequence = 0
  let pollTimer = null
  const pending = new Set()
  let lastResult = null
  let pendingUpload = null
  let current = { phase: 'connecting', hasLastResult: false }

  function createId() {
    let stamp = Math.floor(Number(now()))
    if (!Number.isFinite(stamp) || stamp < 0) stamp = 0
    const id = `${stamp}-${++sequence}`
    return LOCAL_ID.test(id) ? id : `${String(stamp).slice(0, 16)}-${sequence}`
  }

  function storedReview(id = null) {
    let draft
    try { draft = readDraft() } catch (error) { return null }
    if (!draft || (id !== null && draft.id !== id) || !LOCAL_ID.test(draft.id) ||
        typeof draft.edited !== 'boolean' || typeof draft.pendingSend !== 'boolean') return null
    if (draft.edited) {
      if (!LOCAL_ID.test(draft.draftId) || (draft.textId !== null && draft.textId !== draft.draftId)) return null
    } else if (draft.draftId !== null || (draft.textId !== null && draft.textId !== draft.id)) {
      return null
    }
    const text = normalizeReviewText(draft.text)
    return text === null ? null : { ...draft, text }
  }

  function persistDraft(draft) {
    try {
      writeDraft(draft)
      return true
    } catch (error) {
      return false
    }
  }

  function clearDraft(id = null) {
    let draft = null
    try { draft = readDraft() } catch (error) {}
    if (id !== null && (!draft || draft.id !== id)) return
    try { writeDraft(null) } catch (error) {}
  }

  function emitReview(id, text, textId = null) {
    const draft = storedReview(id)
    if (draft) {
      emit({ phase: 'review', id, jobId: null, text: draft.text, textId: draft.textId,
        edited: draft.edited, draftId: draft.draftId, busy: false })
      return
    }
    emit({ phase: 'review', id, jobId: null, text, textId,
      edited: false, draftId: null, busy: false })
  }

  function emit(next) {
    if (closed) return
    const clearedError = next.phase && next.phase !== 'error'
      ? { error: '', errorKind: null, retryMethod: null, retryId: null }
      : {}
    current = { ...current, ...clearedError, ...next, hasLastResult: lastResult !== null }
    report(current)
  }

  function clearPoll() {
    if (pollTimer !== null) clearTimer(pollTimer)
    pollTimer = null
  }

  function beginOperation() {
    clearPoll()
    generation += 1
    return generation
  }

  function active(operation) {
    return !closed && operation === generation
  }

  function assertActive(operation) {
    if (!active(operation)) throw new Error('CANCELED')
  }

  function resultWasAcknowledged(id) {
    try {
      return readAcknowledgedResultId() === id
    } catch (error) {
      return false
    }
  }

  function acknowledgeCurrentResult() {
    if (current.phase !== 'result' || !lastResult || current.id !== lastResult.id) return
    try {
      writeAcknowledgedResultId(lastResult.id)
    } catch (error) {}
  }

  function call(payload) {
    if (closed) return Promise.reject(new Error('CANCELED'))

    return new Promise((resolve, reject) => {
      let settled = false
      let cancel
      let timer = null
      const expire = () => {
        if (settled) return
        settled = true
        pending.delete(cancel)
        reject(new Error('REQUEST_TIMEOUT'))
      }
      const keepAlive = () => {
        if (settled) return
        if (timer !== null) clearTimer(timer)
        timer = setTimer(expire, HANDSHAKE_TIMEOUT_MS)
      }
      keepAlive()

      function finish(callback, value) {
        if (settled) return
        settled = true
        pending.delete(cancel)
        clearTimer(timer)
        if (closed) {
          reject(new Error('CANCELED'))
          return
        }
        callback(value)
      }

      cancel = () => {
        if (settled) return
        settled = true
        clearTimer(timer)
        pending.delete(cancel)
        reject(new Error('CANCELED'))
      }
      pending.add(cancel)

      try {
        request(payload, { timeout: REQUEST_TIMEOUT_MS, onRouteProgress: keepAlive }).then(
          value => finish(resolve, value),
          error => finish(reject, error)
        )
      } catch (error) {
        finish(reject, error)
      }
    })
  }

  async function callOk(payload, operation, retry = RETRYABLE_READS.has(payload.method)) {
    const attempts = retry ? 2 : 1
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let reply
      try {
        reply = await call(payload)
      } catch (error) {
        if (attempt + 1 >= attempts || !active(operation)) throw error
        continue
      }
      assertActive(operation)
      if (validReply(reply)) return reply
      const retryableReply = reply && reply.ok === false && reply.retryable === true
      if (attempt + 1 >= attempts || !retryableReply) {
        throw new Error(reply && reply.error ? reply.error : 'INVALID_RESPONSE')
      }
    }
    throw new Error('INVALID_RESPONSE')
  }

  function schedule(delay, operation, callback) {
    clearPoll()
    pollTimer = setTimer(() => {
      pollTimer = null
      if (!active(operation)) return
      callback()
    }, delay)
  }

  function fail(error, operation, retryMethod = null, retryId = null, errorKind = 'request') {
    if (!active(operation) || error && error.message === 'CANCELED') return
    emit({
      phase: 'error', error: messageOf(error), busy: false,
      errorKind, retryMethod, retryId
    })
  }

  function scheduleAudioStatus(id, operation) {
    schedule(TRANSCRIPTION_POLL_MS, operation, () => pollAudioStatus(id, operation))
  }

  function validateAudioProgress(reply, id, totalBytes) {
    if (reply.id !== undefined && reply.id !== id) throw new Error('INVALID_RESPONSE')
    if (!Number.isInteger(reply.receivedBytes) || reply.receivedBytes < 0 ||
        reply.receivedBytes > totalBytes ||
        (reply.receivedBytes < totalBytes && reply.receivedBytes % AUDIO_CHUNK_SIZE !== 0)) {
      throw new Error('INVALID_RESPONSE')
    }
    if (reply.totalBytes !== undefined && reply.totalBytes !== totalBytes) {
      throw new Error('INVALID_RESPONSE')
    }
    return reply.receivedBytes
  }

  async function showReadyTranscript(id, first, operation) {
    if (typeof first.text !== 'string') throw new Error('INVALID_RESPONSE')
    if (first.textOffset === undefined) {
      if (!first.text.trim()) throw new Error('INVALID_RESPONSE')
      emitReview(id, first.text, null)
      return
    }

    const textLength = first.textLength
    if (!Number.isInteger(textLength) || textLength < 1 || textLength > MAX_TRANSCRIPT_CODEPOINTS) {
      throw new Error('INVALID_RESPONSE')
    }
    const parts = []
    let reply = first
    let offset = 0
    while (true) {
      if (reply.id !== id || reply.state !== 'ready' || reply.textOffset !== offset ||
          reply.textLength !== textLength || typeof reply.text !== 'string' ||
          typeof reply.textComplete !== 'boolean') throw new Error('INVALID_RESPONSE')
      const count = Array.from(reply.text).length
      if (count < 1 || count > TRANSCRIPT_PAGE_SIZE || offset + count > textLength) {
        throw new Error('INVALID_RESPONSE')
      }
      parts.push(reply.text)
      offset += count
      if (reply.textComplete) {
        if (offset !== textLength) throw new Error('INVALID_RESPONSE')
        break
      }
      reply = await callOk({
        method: 'AUDIO_STATUS',
        params: { id, textOffset: offset, textLimit: TRANSCRIPT_PAGE_SIZE }
      }, operation)
    }
    const text = parts.join('')
    if (!text.trim()) throw new Error('INVALID_RESPONSE')
    emitReview(id, text, id)
  }

  async function pollAudioStatus(id, operation) {
    try {
      const reply = await callOk({
        method: 'AUDIO_STATUS',
        params: { id, textOffset: 0, textLimit: TRANSCRIPT_PAGE_SIZE }
      }, operation)
      if (reply.id !== id || !JOB_STATES.has(reply.state)) throw new Error('INVALID_RESPONSE')
      if (reply.state === 'transcribing') {
        emit({ phase: 'transcribing', id, busy: true })
        scheduleAudioStatus(id, operation)
        return
      }
      if (reply.state === 'ready') {
        await showReadyTranscript(id, reply, operation)
        return
      }
      if (reply.state === 'error') {
        fail(new Error(reply.error || 'Ошибка распознавания'), operation,
          'AUDIO_FINISH', id, 'audio')
        return
      }
      throw new Error('INVALID_RESPONSE')
    } catch (error) {
      fail(error, operation, 'AUDIO_STATUS', id, 'audio')
    }
  }

  function scheduleJobStatus(id, operation) {
    schedule(JOB_POLL_MS, operation, () => pollJobStatus(id, operation))
  }

  function showJob(job, operation, recovered = false) {
    if (!active(operation) || !job || typeof job.id !== 'string' || !JOB_STATES.has(job.state)) {
      throw new Error('INVALID_RESPONSE')
    }

    const rejected = job.state === 'error' && job.retryTextId === job.id
    const accepted = ['submitting', 'queued', 'running', 'stopping', 'approval', 'completed', 'cancelled', 'unknown'].includes(job.state) ||
      (job.state === 'error' && !rejected)
    if (accepted) clearDraft(job.id)
    const base = { id: job.id, jobId: job.id, state: job.state, busy: false }
    if (typeof job.chatId === 'string') base.chatId = job.chatId
    if (typeof job.summary === 'string') base.summary = job.summary
    if (job.mode === 'task' || job.mode === 'research') base.mode = job.mode
    if (Number.isInteger(job.reportLength) && job.reportLength >= 0) base.reportLength = job.reportLength
    if (job.state === 'transcribing') {
      emit({ ...base, phase: 'transcribing', busy: true })
      scheduleAudioStatus(job.id, operation)
    } else if (job.state === 'ready') {
      if (typeof job.text !== 'string' || !job.text.trim()) throw new Error('INVALID_RESPONSE')
      emitReview(job.id, job.text, null)
    } else if (job.state === 'submitting' || job.state === 'queued' || job.state === 'running' || job.state === 'stopping') {
      emit({ ...base, phase: 'job', text: job.text || '', busy: true })
      scheduleJobStatus(job.id, operation)
    } else if (job.state === 'approval') {
      const approval = job.approval
      if (approval && typeof approval.id === 'string' && typeof approval.text === 'string') {
        const options = Array.isArray(approval.options) && approval.options.length && approval.options.every(o => typeof o === 'string')
          ? approval.options : null
        emit({ ...base, phase: 'approval', approvalId: approval.id, approvalText: approval.text,
          approvalQuestion: options && typeof approval.question === 'string' ? approval.question : null,
          approvalOptions: options, approvalStep: typeof approval.step === 'string' ? approval.step : null })
      } else {
        emit({
          ...base,
          phase: 'approval',
          approvalId: null,
          approvalText: typeof job.result === 'string' && job.result
            ? job.result
            : 'Не удалось получить действие для подтверждения. Обновляем статус.'
        })
      }
      scheduleJobStatus(job.id, operation)
    } else if (job.state === 'completed' || job.state === 'cancelled') {
      lastResult = {
        ...base,
        text: typeof job.text === 'string' ? job.text : '',
        result: typeof job.result === 'string' && job.result
          ? job.result : job.state === 'cancelled' ? 'Задание остановлено' : 'Готово'
      }
      if (recovered && resultWasAcknowledged(job.id)) {
        emit({
          phase: 'ready', busy: false, id: null, jobId: null,
          approvalId: null, text: '', result: ''
        })
      } else {
        emit({ ...lastResult, phase: 'result' })
      }
    } else if (job.state === 'unknown') {
      emit({ ...base, phase: 'unknown', text: job.text || '', statusMessage: job.result || '' })
    } else {
      emit({
        ...base, phase: 'error', error: job.error || 'Задание завершилось с ошибкой',
        jobId: rejected ? null : job.id,
        errorKind: rejected ? 'rejected' : 'job',
        retryMethod: rejected ? 'AUDIO_STATUS' : 'JOB_STATUS', retryId: job.id
      })
    }
  }

  async function pollJobStatus(id, operation) {
    try {
      const reply = await callOk({ method: 'JOB_STATUS', params: { id } }, operation)
      if (reply.id !== id) throw new Error('INVALID_RESPONSE')
      showJob(reply, operation)
    } catch (error) {
      fail(error, operation, 'JOB_STATUS', id, 'job')
    }
  }

  async function recoverLatest(operation) {
    const draft = storedReview()
    if (draft && !draft.pendingSend) {
      emitReview(draft.id, draft.text, draft.textId)
      return
    }
    if (draft && draft.pendingSend) {
      let reply
      try {
        try {
          reply = await call({ method: 'JOB_STATUS', params: { id: draft.id } })
        } catch (error) {
          assertActive(operation)
          reply = await call({ method: 'JOB_STATUS', params: { id: draft.id } })
        }
        assertActive(operation)
      } catch (error) {
        if (!active(operation) || error && error.message === 'CANCELED') return
        fail(error, operation, 'JOB_STATUS', draft.id, 'job')
        return
      }
      if (validReply(reply)) {
        if (reply.id !== draft.id) throw new Error('INVALID_RESPONSE')
        showJob(reply, operation, true)
        return
      }
      emit({ phase: 'unknown', state: 'unknown', id: draft.id, jobId: draft.id,
        text: draft.text, textId: draft.textId, edited: draft.edited, draftId: draft.draftId,
        error: reply && reply.error || 'Не удалось подтвердить принятие задания', busy: false,
        retryMethod: 'JOB_STATUS', retryId: draft.id })
      return
    }
    const latest = await callOk({ method: 'LATEST_JOB', params: {} }, operation)
    if (latest.job === null || latest.job === undefined) {
      emit({ phase: 'ready', busy: false, id: null, jobId: null, text: '', result: '' })
      return
    }
    showJob(latest.job, operation, true)
  }

  async function runUpload(upload) {
    const { id, totalBytes, readChunk } = upload
    const operation = beginOperation()
    emit({ phase: 'uploading', id, sentBytes: 0, totalBytes, busy: true })
    try {
      const begin = await callOk({ method: 'AUDIO_BEGIN', params: { id, totalBytes } }, operation, true)
      const compact = begin.chunkBytes === 6144 && begin.encoding === 'base64'
      const chunkBytes = compact ? 6144 : AUDIO_CHUNK_SIZE
      let sentBytes = validateAudioProgress(begin, id, totalBytes)
      emit({ phase: 'uploading', id, sentBytes, totalBytes, busy: true })

      while (sentBytes < totalBytes) {
        assertActive(operation)
        const wanted = Math.min(chunkBytes, totalBytes - sentBytes)
        const data = readChunk(sentBytes, wanted)
        if (!Array.isArray(data) || data.length !== wanted ||
            data.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
          throw new Error('Не удалось прочитать аудиозапись')
        }
        const reply = await callOk({
          method: compact ? 'AUDIO_PART' : 'AUDIO_CHUNK',
          params: compact ? { id, offset: sentBytes, data: encodeAudioPart(data) }
            : { id, index: sentBytes / AUDIO_CHUNK_SIZE, data }
        }, operation, true)
        const receivedBytes = validateAudioProgress(reply, id, totalBytes)
        if (receivedBytes !== sentBytes + data.length) throw new Error('INVALID_RESPONSE')
        sentBytes = receivedBytes
        emit({ phase: 'uploading', id, sentBytes, totalBytes, busy: true })
      }

      const finish = await callOk({ method: 'AUDIO_FINISH', params: { id } }, operation, true)
      if (finish.id !== id || (finish.state !== 'transcribing' && finish.state !== 'ready')) {
        throw new Error('INVALID_RESPONSE')
      }
      if (pendingUpload === upload) pendingUpload = null
      if (typeof upload.onAccepted === 'function') upload.onAccepted(id)
      if (!active(operation)) return false
      if (finish.state === 'ready') {
        await pollAudioStatus(id, operation)
      } else {
        emit({ phase: 'transcribing', id, busy: true })
        scheduleAudioStatus(id, operation)
      }
      return true
    } catch (error) {
      fail(error, operation, 'AUDIO_UPLOAD', id, 'audio')
      return false
    }
  }

  async function saveEditedText(review, operation) {
    const codepoints = Array.from(review.text)
    const total = codepoints.length
    emit({ phase: 'saving-text', id: review.id, jobId: null, text: review.text,
      textId: null, edited: true, draftId: review.draftId, busy: true })

    const begin = await callOk({ method: 'TEXT_BEGIN', params: {
      id: review.draftId, sourceId: review.id, textLength: total
    } }, operation, true)
    if (begin.id !== review.draftId || begin.textLength !== total ||
        !Number.isInteger(begin.receivedLength) || begin.receivedLength < 0 || begin.receivedLength > total) {
      throw new Error('INVALID_RESPONSE')
    }

    for (let offset = 0; offset < total; offset += TEXT_PART_SIZE) {
      const text = codepoints.slice(offset, offset + TEXT_PART_SIZE).join('')
      const accepted = offset + Array.from(text).length
      const part = await callOk({ method: 'TEXT_PART', params: {
        id: review.draftId, offset, text
      } }, operation, true)
      if (part.id !== review.draftId || part.textLength !== total ||
          !Number.isInteger(part.receivedLength) || part.receivedLength < accepted || part.receivedLength > total) {
        throw new Error('INVALID_RESPONSE')
      }
    }

    const finish = await callOk({ method: 'TEXT_FINISH', params: { id: review.draftId } }, operation, true)
    if (finish.id !== review.draftId || finish.state !== 'ready' || finish.textLength !== total) {
      throw new Error('INVALID_RESPONSE')
    }
    const saved = { ...review, textId: review.draftId, pendingSend: false }
    if (!persistDraft(saved)) throw new Error('Не удалось сохранить исправленный текст')
    return saved
  }

  return {
    start() {
      const operation = beginOperation()
      emit({ phase: 'connecting', busy: true })
      ;(async () => {
        try {
          const status = await callOk({ method: 'STATUS', params: {} }, operation)
          if (typeof status.agent !== 'string') throw new Error('INVALID_RESPONSE')
          await recoverLatest(operation)
        } catch (error) {
          fail(error, operation)
        }
      })()
    },

    createId,

    updateReviewText(value) {
      if (current.phase !== 'review' || typeof current.id !== 'string') {
        throw new Error('Текст сейчас нельзя изменить')
      }
      const text = normalizeReviewText(value)
      if (text === null) throw new Error('Введите от 1 до 30000 допустимых символов')
      if (text === current.text) {
        emit({ phase: 'review', busy: false })
        return true
      }
      const draft = {
        id: current.id, text, textId: null, edited: true,
        draftId: createId(), pendingSend: false
      }
      if (!persistDraft(draft)) throw new Error('Не удалось сохранить исправленный текст')
      emit({ phase: 'review', id: draft.id, jobId: null, text: draft.text,
        textId: null, edited: true, draftId: draft.draftId, busy: false })
      return true
    },

    beginRecording(id) {
      if (!LOCAL_ID.test(id)) return false
      const canStart = current.phase === 'ready' || current.phase === 'review' ||
        current.phase === 'result' || (current.phase === 'error' && current.errorKind === 'local')
      if (!canStart) return false
      acknowledgeCurrentResult()
      clearDraft()
      beginOperation()
      emit({
        phase: 'recording', id, jobId: null, approvalId: null,
        busy: true, text: '', result: '', error: ''
      })
      return true
    },

    recordingStopped(canceled = false) {
      emit({ phase: canceled ? 'canceling' : 'stopping', busy: true })
    },

    cancelRecording() {
      beginOperation()
      emit({
        phase: 'ready', busy: false, id: null, jobId: null,
        approvalId: null, text: '', result: ''
      })
    },

    failLocal(message) {
      const operation = beginOperation()
      fail(new Error(message || 'Ошибка на часах'), operation, null, null, 'local')
    },

    async uploadAudio({ id, totalBytes, readChunk, onAccepted }) {
      if (!LOCAL_ID.test(id) || !Number.isInteger(totalBytes) || totalBytes <= 0 ||
          totalBytes > MAX_AUDIO_BYTES || typeof readChunk !== 'function') {
        const operation = beginOperation()
        fail(new Error('Некорректная аудиозапись'), operation, null, null, 'local')
        return false
      }

      pendingUpload = { id, totalBytes, readChunk, onAccepted }
      return runUpload(pendingUpload)
    },

    resumeAudio(id) {
      if (!LOCAL_ID.test(id)) return false
      const operation = beginOperation()
      emit({ phase: 'transcribing', id, busy: true })
      pollAudioStatus(id, operation)
      return true
    },

    cancelUpload() {
      if (!pendingUpload && current.retryMethod !== 'AUDIO_UPLOAD') return false
      pendingUpload = null
      beginOperation()
      emit({
        phase: 'ready', busy: false, id: null, jobId: null,
        approvalId: null, text: '', result: ''
      })
      return true
    },

    sendText() {
      if (current.phase !== 'review' || typeof current.id !== 'string' || typeof current.text !== 'string') {
        return false
      }
      const id = current.id
      const text = current.text
      let review = {
        id, text,
        textId: typeof current.textId === 'string' ? current.textId : null,
        edited: current.edited === true,
        draftId: current.edited === true ? current.draftId : null,
        pendingSend: false
      }
      if (review.edited && (!LOCAL_ID.test(review.draftId) ||
          (review.textId !== null && review.textId !== review.draftId))) return false
      const operation = beginOperation()
      ;(async () => {
        try {
          if (review.edited && review.textId === null) review = await saveEditedText(review, operation)
          const pendingReview = { ...review, pendingSend: true }
          if (!persistDraft(pendingReview)) {
            emit({ phase: 'review', id, jobId: null, text, textId: review.textId,
              edited: review.edited, draftId: review.draftId,
              error: 'Не удалось сохранить текст перед отправкой', busy: false })
            return
          }
          review = pendingReview
          emit({ phase: 'sending', id, jobId: id, text, textId: review.textId,
            edited: review.edited, draftId: review.draftId, busy: true })
          const params = review.textId ? { id, textId: review.textId } : { id, text }
          let reply
          try {
            reply = await call({ method: 'SEND_TEXT', params })
          } catch (error) {
            assertActive(operation)
            emit({
              phase: 'unknown', state: 'unknown', id, jobId: id, text,
              error: messageOf(error), busy: false,
              retryMethod: 'JOB_STATUS', retryId: id
            })
            return
          }
          assertActive(operation)
          if (!validReply(reply)) {
            emit({ phase: 'unknown', state: 'unknown', id, jobId: id, text, textId: review.textId,
              edited: review.edited, draftId: review.draftId,
              error: reply && reply.error || 'Не удалось подтвердить принятие задания', busy: false,
              retryMethod: 'JOB_STATUS', retryId: id })
            return
          }
          if (reply.id !== id) throw new Error('INVALID_RESPONSE')
          showJob(reply, operation)
        } catch (error) {
          if (active(operation)) {
            if (current.phase === 'saving-text') {
              const restored = { ...review, pendingSend: false }
              persistDraft(restored)
              emit({ phase: 'review', id, jobId: null, text,
                textId: review.textId, edited: review.edited, draftId: review.draftId,
                error: messageOf(error), busy: false })
            } else {
              emit({
                phase: 'unknown', state: 'unknown', id, jobId: id, text,
                error: messageOf(error), busy: false,
                retryMethod: 'JOB_STATUS', retryId: id
              })
            }
          }
        }
      })()
      return true
    },

    cancelReview() {
      if (current.phase !== 'review') return false
      clearDraft(current.id)
      beginOperation()
      emit({
        phase: 'ready', busy: false, id: null, jobId: null,
        approvalId: null, text: ''
      })
      return true
    },

    home() {
      const canGoHome = current.phase === 'ready' || current.phase === 'review' ||
        current.phase === 'result' || (current.phase === 'error' && current.errorKind === 'local')
      if (!canGoHome) return false
      acknowledgeCurrentResult()
      if (current.phase === 'review') clearDraft(current.id)
      beginOperation()
      emit({
        phase: 'ready', busy: false, id: null, jobId: null,
        approvalId: null, text: '', result: ''
      })
      return true
    },

    showLastResult() {
      if (current.phase !== 'ready' || lastResult === null) return false
      beginOperation()
      emit({ ...lastResult, phase: 'result' })
      return true
    },

    refresh() {
      const previousPhase = current.phase
      const previousId = current.id
      const previousJobId = current.jobId
      const retryMethod = current.retryMethod
      const retryId = current.retryId
      const refreshMethod = retryMethod ||
        (previousPhase === 'transcribing' && previousId ? 'AUDIO_STATUS' :
          previousJobId ? 'JOB_STATUS' : null)
      const refreshId = retryId ||
        (refreshMethod === 'AUDIO_STATUS' ? previousId : previousJobId)
      const operation = beginOperation()
      emit({ phase: 'refreshing', busy: true })
      ;(async () => {
        try {
          if (retryMethod === 'AUDIO_UPLOAD' && retryId && pendingUpload && pendingUpload.id === retryId) {
            await runUpload(pendingUpload)
          } else if (retryMethod === 'AUDIO_FINISH' && retryId) {
            const reply = await callOk({ method: 'AUDIO_FINISH', params: { id: retryId } }, operation, true)
            if (reply.id !== retryId || (reply.state !== 'transcribing' && reply.state !== 'ready')) {
              throw new Error('INVALID_RESPONSE')
            }
            if (reply.state === 'ready') await pollAudioStatus(retryId, operation)
            else {
              emit({ phase: 'transcribing', id: retryId, busy: true })
              scheduleAudioStatus(retryId, operation)
            }
          } else if (retryMethod === 'AUDIO_STATUS' && retryId) {
            await pollAudioStatus(retryId, operation)
          } else if (retryMethod === 'JOB_STATUS' && retryId) {
            const reply = await callOk({ method: 'JOB_STATUS', params: { id: retryId } }, operation)
            if (reply.id !== retryId) throw new Error('INVALID_RESPONSE')
            showJob(reply, operation)
          } else if (previousPhase === 'transcribing' && previousId) {
            await pollAudioStatus(previousId, operation)
          } else if (previousJobId) {
            const id = previousJobId
            const reply = await callOk({ method: 'JOB_STATUS', params: { id } }, operation)
            if (reply.id !== id) throw new Error('INVALID_RESPONSE')
            showJob(reply, operation)
          } else {
            await recoverLatest(operation)
          }
        } catch (error) {
          fail(error, operation, refreshMethod, refreshId,
            refreshMethod === 'JOB_STATUS' ? 'job' :
              refreshMethod && refreshMethod.startsWith('AUDIO_') ? 'audio' : 'request')
        }
      })()
    },

    approve(allow, answer) {
      if (current.phase !== 'approval' || typeof current.jobId !== 'string' ||
          typeof current.approvalId !== 'string') return false
      const id = current.jobId
      const approvalId = current.approvalId
      const operation = beginOperation()
      emit({ phase: 'sending', jobId: id, busy: true })
      ;(async () => {
        try {
          const params = { id, approvalId, allow: allow === true }
          if (typeof answer === 'string' && answer) params.answer = answer  // a chosen option of an agent question
          const reply = await callOk({ method: 'JOB_APPROVE', params }, operation)
          if (reply.id !== id) throw new Error('INVALID_RESPONSE')
          showJob(reply, operation)
        } catch (error) {
          fail(error, operation, 'JOB_STATUS', id, 'job')
        }
      })()
      return true
    },

    stopJob() {
      if (!['job', 'approval'].includes(current.phase) || typeof current.jobId !== 'string' ||
          !['submitting', 'queued', 'running', 'approval'].includes(current.state)) return false
      const id = current.jobId
      const text = typeof current.text === 'string' ? current.text : ''
      const operation = beginOperation()
      const keepPolling = error => {
        if (!active(operation) || error && error.message === 'CANCELED') return
        emit({ phase: 'job', id, jobId: id, state: 'stopping', text, busy: true,
          error: messageOf(error) })
        scheduleJobStatus(id, operation)
      }
      emit({ phase: 'job', id, jobId: id, state: 'stopping', text, busy: true })
      ;(async () => {
        try {
          const reply = await call({ method: 'JOB_STOP', params: { id } })
          assertActive(operation)
          if (!validReply(reply) || reply.id !== id || reply.state === 'unknown') {
            keepPolling(new Error(reply && (reply.error || reply.result) || 'Статус остановки уточняется'))
            return
          }
          showJob(reply, operation)
        } catch (error) {
          keepPolling(error)
        }
      })()
      return true
    },

    close() {
      closed = true
      generation += 1
      clearPoll()
      for (const cancel of [...pending]) cancel()
    },

    getState() {
      return { ...current }
    },

    getReviewedId() {
      return current.phase === 'review' && typeof current.id === 'string' ? current.id : null
    }
  }
}
