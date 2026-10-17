import { BaseSideService } from '@zeppos/zml/base-side'
import { bridgeURL, deviceToken } from './connection'
import { forwardLimitsRequest, resolveConnection } from '../shared/bridge-client'

AppSideService(BaseSideService({
  onInit() {
    console.log('[limits] service ready')
  },
  onRequest(request, respond) {
    const connection = resolveConnection(key => settings.settingsStorage.getItem(key), bridgeURL, deviceToken)
    if (!connection) {
      respond(null, { ok: false, error: 'Открой Zepp → настройки приложения «Лимиты» и введи адрес моста и ключ' })
      return
    }
    forwardLimitsRequest(request, options => this.fetch(options), connection.url, connection.token)
      .then(result => respond(null, result))
  }
}))
