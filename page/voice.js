import { BasePage } from '@zeppos/zml/base-page'
import { createVoicePage } from '../shared/voice-page'

Page(BasePage(createVoicePage({
  kind: 'musafir', chats: true, icon: 'heroes/musafir.png',
  title: 'Мусафир', version: '0.11.0'
})))
