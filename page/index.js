import { BasePage } from '@zeppos/zml/base-page'
import { createVoicePage } from '../shared/voice-page'

Page(BasePage(createVoicePage({
  kind: 'musafir',
  icon: 'brand-mark.png',
  title: 'Мусафир',
  version: '0.8.0'
})))
