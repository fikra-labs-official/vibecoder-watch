import { BaseSideService } from '@zeppos/zml/base-side'
import { bridgeURL, deviceToken } from './connection'
import { forwardRequest, resolveConnection } from '../shared/bridge-client'

AppSideService(BaseSideService({
  onInit() {
    console.log('[codex] service 0.1.0 ready')
  },
  onRequest(request, respond) {
    const connection = resolveConnection(key => settings.settingsStorage.getItem(key), bridgeURL, deviceToken)
    if (!connection) {
      respond(null, { ok: false, error: 'Открой Zepp → настройки приложения «Codex» и введи адрес моста и ключ' })
      return
    }
    forwardRequest(request, options => this.fetch(options), connection.url, connection.token, 'codex')
      .then(result => respond(null, result))
      .catch(() => respond(null, {
        ok: false,
        error: 'Нет связи с Codex на Mac. Проверьте Tailscale и оставьте Mac включённым.'
      }))
  }
}))
