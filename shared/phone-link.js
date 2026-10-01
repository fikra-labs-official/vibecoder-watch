const VERSION = 1

export function answerPhonePing(request) {
  const params = request && request.params
  if (!request || request.method !== 'PHONE_PING' || !params ||
      params.version !== VERSION || typeof params.requestId !== 'string' ||
      !/^\d{1,16}-\d{1,8}$/.test(params.requestId)) {
    return { ok: false, error: 'INVALID_REQUEST' }
  }
  return {
    ok: true,
    kind: 'PHONE_PONG',
    version: VERSION,
    requestId: params.requestId
  }
}

export function createPhoneProbe({ request, report, setTimer, clearTimer }) {
  let active = null
  let sequence = 0
  let closed = false

  function finish(attempt, state) {
    if (closed || active !== attempt) return
    clearTimer(attempt.timer)
    active = null
    // A transport response after the UI deadline cannot count as a successful test.
    report({ state: attempt.expired ? 'timeout' : state, busy: false })
  }

  return {
    start() {
      if (closed || active) return false
      const attempt = { requestId: `${Date.now()}-${++sequence}`, expired: false }
      active = attempt
      report({ state: 'waiting', busy: true })
      // ZML starts its request timeout after the handshake. This also bounds that wait.
      attempt.timer = setTimer(() => {
        if (closed || active !== attempt) return
        attempt.expired = true
        report({ state: 'timeout', busy: true })
      }, 12000)

      try {
        request({
            method: 'PHONE_PING',
            params: { version: VERSION, requestId: attempt.requestId }
          }, { timeout: 8000 })
          .then(reply => {
          const valid = reply && reply.ok === true && reply.kind === 'PHONE_PONG' &&
            reply.version === VERSION && reply.requestId === attempt.requestId
          finish(attempt, valid ? 'ok' : 'invalid')
        }, () => finish(attempt, 'error'))
      } catch {
        finish(attempt, 'error')
      }
      return true
    },
    close() {
      closed = true
      if (active) clearTimer(active.timer)
      active = null
    }
  }
}
