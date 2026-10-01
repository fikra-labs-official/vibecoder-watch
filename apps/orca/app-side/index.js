import { BaseSideService } from '@zeppos/zml/base-side'
import { bridgeURL, deviceToken } from './connection'
import { forwardRequest, resolveConnection } from '../shared/bridge-client'

AppSideService(BaseSideService({
  onInit() {
    console.log('[orca] service 0.3.7 ready')
  },
  onRequest(request, respond) {
    const connection = resolveConnection(key => settings.settingsStorage.getItem(key), bridgeURL, deviceToken)
    if (!connection) {
      respond(null, { ok: false, error: 'Открой Zepp → настройки приложения «Orca» и введи адрес моста и ключ' })
      return
    }
    forwardRequest(request, options => this.fetch(options), connection.url, connection.token, 'orca')
      .then(result => respond(null, result))
      .catch(() => respond(null, {
        ok: false,
        error: 'Нет связи с Orca на Mac. Проверьте Tailscale и оставьте Mac включённым.'
      }))
  }
}))
