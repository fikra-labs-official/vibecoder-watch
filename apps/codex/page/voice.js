import { BasePage } from '@zeppos/zml/base-page'
import { createVoicePage } from '../shared/voice-page'

Page(BasePage(createVoicePage({ kind: 'codex', title: 'Codex', icon: 'codex-mark.png', version: '0.2.0' })))
