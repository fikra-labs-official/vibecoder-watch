import { BasePage } from '@zeppos/zml/base-page'
import { createVoicePage } from '../shared/voice-page'

Page(BasePage(createVoicePage({ kind: 'claude', title: 'Claude', icon: 'claude-mark.png', version: '0.3.0' })))
