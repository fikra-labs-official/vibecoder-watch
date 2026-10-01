import { BaseSideService } from '@zeppos/zml/base-side'
import { bridgeURL, deviceToken } from './connection'
import { forwardRequest, resolveConnection } from '../shared/bridge-client'

AppSideService(BaseSideService({
  onInit() {
    console.log('[claude] service 0.1.0 ready')
  },
  onRequest(request, respond) {
    const connection = resolveConnection(key => settings.settingsStorage.getItem(key), bridgeURL, deviceToken)
    if (!connection) {
      respond(null, { ok: false, error: 'Открой Zepp → настройки приложения «Claude» и введи адрес моста и ключ' })
      return
    }
    forwardRequest(request, options => this.fetch(options), connection.url, connection.token, 'claude')
      .then(result => respond(null, result))
      .catch(() => respond(null, {
        ok: false,
        error: 'Нет связи с Claude на Mac. Проверьте Tailscale и оставьте Mac включённым.'
      }))
  }
}))
