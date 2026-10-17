import { BasePage } from '@zeppos/zml/base-page'
import { createVoicePage } from '../shared/voice-page'

Page(BasePage(createVoicePage({ kind: 'orca', title: 'Orca', icon: 'orca-mark.png', version: '0.4.0' })))
