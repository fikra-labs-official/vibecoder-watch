import { BaseSideService } from '@zeppos/zml/base-side'
import { bridgeURL, deviceToken } from './connection'
import { forwardRequest, resolveConnection } from '../shared/bridge-client'

AppSideService(BaseSideService({
  onInit() {
    console.log('[musafer] voice service 0.7.3 ready')
  },
  onRequest(request, respond) {
    const connection = resolveConnection(key => settings.settingsStorage.getItem(key), bridgeURL, deviceToken)
    if (!connection) {
      respond(null, { ok: false, error: 'Открой Zepp → настройки приложения «Мусафир» и введи адрес моста и ключ' })
      return
    }
    forwardRequest(request, options => this.fetch(options), connection.url, connection.token, 'musafir')
      .then(result => respond(null, result))
      .catch(() => respond(null, {
        ok: false,
        offline: true,
        error: 'Нет связи с Mac. Проверьте Tailscale и оставьте Mac включённым.'
      }))
  }
}))
