import { BaseSideService } from '@zeppos/zml/base-side'
import { bridgeURL, deviceToken } from './connection'
import { forwardVoiceRequest, resolveConnection } from '../shared/bridge-client'

AppSideService(BaseSideService({
  onInit() {
    console.log('[musafer] voice service 0.10.0 ready')
  },
  onRequest(request, respond) {
    const connection = resolveConnection(key => settings.settingsStorage.getItem(key), bridgeURL, deviceToken)
    if (!connection) {
      respond(null, { ok: false, error: 'Открой Zepp → настройки приложения «Мусафир» и введи адрес моста и ключ' })
      return
    }
    forwardVoiceRequest(request, options => this.fetch(options), connection.url, connection.token, 'musafir')
      .then(result => respond(null, result))
  }
}))
