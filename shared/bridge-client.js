const PROFILES = {
  musafir: ['STATUS', 'SUMMARY', 'AUDIO_BEGIN', 'AUDIO_CHUNK', 'AUDIO_PART', 'AUDIO_FINISH', 'AUDIO_STATUS', 'TEXT_BEGIN', 'TEXT_PART', 'TEXT_FINISH',
    'DIAGNOSTIC', 'SEND_TEXT', 'JOB_STATUS', 'LATEST_JOB', 'JOB_APPROVE',
    'HISTORY_LIST', 'HISTORY_DETAIL', 'HISTORY_SET_DELETED', 'HISTORY_CURRENT', 'HISTORY_EMPTY_TRASH'],
  orca: ['SUMMARY', 'AUDIO_BEGIN', 'AUDIO_CHUNK', 'AUDIO_PART', 'AUDIO_FINISH', 'AUDIO_STATUS', 'TEXT_BEGIN', 'TEXT_PART', 'TEXT_FINISH', 'DIAGNOSTIC',
    'ORCA_LIST', 'ORCA_TERMINALS', 'ORCA_PAIRS', 'ORCA_BIND',
    'ORCA_SEND', 'ORCA_JOB', 'ORCA_LATEST', 'ORCA_REPLY', 'ORCA_PAUSE', 'ORCA_ROOTS',
    'ORCA_PRESETS', 'ORCA_AGENTS', 'ORCA_MODELS', 'ORCA_PROJECT_CREATE', 'ORCA_PROJECT_PLAN',
    'ORCA_PROJECT_DECIDE', 'ORCA_PROJECT_RESUME',
    'ORCA_PAIR_CREATE', 'ORCA_AGENT_CREATE', 'ORCA_OPERATION', 'ORCA_GITHUB_CREATE',
    'ORCA_HISTORY_LIST', 'ORCA_HISTORY_DETAIL', 'ORCA_HISTORY_SET_DELETED', 'ORCA_HISTORY_EMPTY_TRASH',
    'ORCA_QUICK_LIST', 'ORCA_MODES', 'ORCA_STOP', 'ORCA_ASK', 'ORCA_HANDOFF'
  ],
  claude: ['SUMMARY', 'AUDIO_BEGIN', 'AUDIO_CHUNK', 'AUDIO_PART', 'AUDIO_FINISH', 'AUDIO_STATUS', 'TEXT_BEGIN', 'TEXT_PART', 'TEXT_FINISH', 'DIAGNOSTIC',
    'CLAUDE_PROJECTS', 'CLAUDE_SESSIONS', 'CLAUDE_MODES', 'CLAUDE_SEND', 'CLAUDE_JOB', 'CLAUDE_LATEST', 'CLAUDE_STOP', 'CLAUDE_APPROVE',
    'CLAUDE_HISTORY_LIST', 'CLAUDE_HISTORY_DETAIL', 'CLAUDE_HISTORY_SET_DELETED', 'CLAUDE_HISTORY_EMPTY_TRASH',
    'CLAUDE_NIGHT', 'CLAUDE_NIGHT_RUN', 'CLAUDE_NIGHT_STOP', 'CLAUDE_QUICK_LIST', 'CLAUDE_PRS',
    'WATCH_LIST', 'WATCH_ADD', 'WATCH_REMOVE', 'WATCH_CHECK'],
  codex: ['SUMMARY', 'AUDIO_BEGIN', 'AUDIO_CHUNK', 'AUDIO_PART', 'AUDIO_FINISH', 'AUDIO_STATUS', 'TEXT_BEGIN', 'TEXT_PART', 'TEXT_FINISH', 'DIAGNOSTIC',
    'CODEX_PROJECTS', 'CODEX_SESSIONS', 'CODEX_MODES', 'CODEX_SEND', 'CODEX_JOB', 'CODEX_LATEST', 'CODEX_STOP', 'CODEX_APPROVE',
    'CODEX_HISTORY_LIST', 'CODEX_HISTORY_DETAIL', 'CODEX_HISTORY_SET_DELETED', 'CODEX_HISTORY_EMPTY_TRASH',
    'CODEX_NIGHT', 'CODEX_NIGHT_RUN', 'CODEX_NIGHT_STOP', 'CODEX_QUICK_LIST', 'CODEX_PRS',
    'WATCH_LIST', 'WATCH_ADD', 'WATCH_REMOVE', 'WATCH_CHECK'],
  limits: ['LIMITS']
}

// Bridge address and key. What the owner typed in the app's settings in Zepp wins; the values baked
// into a personal build are the fallback. Both come as a pair, never mixed; only https is accepted.
export function resolveConnection(read, fallbackURL = '', fallbackToken = '') {
  const clean = value => {
    let text = typeof value === 'string' ? value.trim() : ''
    if (text.startsWith('"')) { try { text = String(JSON.parse(text)).trim() } catch (error) {} }
    return text
  }
  let url = '', token = ''
  try { url = clean(read('bridgeURL')); token = clean(read('deviceToken')) } catch (error) {}
  if (!url || !token) { url = clean(fallbackURL); token = clean(fallbackToken) }
  url = url.replace(/\/+$/, '')
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(url) || !/^[A-Za-z0-9._~+\/=-]{16,256}$/.test(token)) return null
  return { url, token }
}

export function forwardRequest(request, fetchRequest, bridgeURL, deviceToken, profile = 'musafir') {
  const methods = Object.prototype.hasOwnProperty.call(PROFILES, profile) ? PROFILES[profile] : null
  if (!methods || !request || methods.indexOf(request.method) < 0) {
    const app = profile === 'orca' ? 'Orca' : profile === 'claude' ? 'Claude' : profile === 'codex' ? 'Codex' : profile === 'limits' ? 'Лимиты' : 'Мусафир'
    return Promise.resolve({ ok: false, error: `Обновите приложение ${app}` })
  }
  return fetchRequest({
    url: bridgeURL + '/rpc',
    method: 'POST',
    timeout: 14000,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + deviceToken },
    body: JSON.stringify({ method: request.method, params: request.params || {} })
  }).then(response => {
    let body
    try {
      body = typeof response.body === 'string' ? JSON.parse(response.body) : response.body
      if (!body || typeof body.ok !== 'boolean') throw new Error('Invalid bridge reply')
    } catch (error) {
      const invalid = new Error('Invalid bridge reply')
      invalid.code = 'BRIDGE_PROTOCOL'
      throw invalid
    }
    if (response.status !== 200) return {
      ok: false, error: body.error || 'Мост к Mac недоступен',
      code: typeof body.code === 'string' ? body.code : 'BRIDGE_HTTP',
      retryable: response.status >= 500 && body.retryable !== false
    }
    return body
  })
}

// A failed HTTP request does not prove that Tailscale or the Mac is offline.
// The caller may retry safe reads or idempotent uploads; never a task submission.
export function forwardVoiceRequest(request, fetchRequest, bridgeURL, deviceToken, profile = 'musafir') {
  return Promise.resolve().then(() => forwardRequest(request, fetchRequest, bridgeURL, deviceToken, profile))
    .catch(error => {
      const malformed = error && error.code === 'BRIDGE_PROTOCOL'
      return {
        ok: false,
        code: malformed ? 'BRIDGE_PROTOCOL' : 'BRIDGE_TRANSPORT',
        retryable: !malformed,
        error: malformed ? 'Mac прислал некорректный ответ' : 'Телефон не получил ответ Mac'
      }
    })
}

export function forwardLimitsRequest(request, fetchRequest, bridgeURL, deviceToken) {
  return forwardVoiceRequest(request, fetchRequest, bridgeURL, deviceToken, 'limits')
}
