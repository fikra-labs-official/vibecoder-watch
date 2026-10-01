import { BasePage } from '@zeppos/zml/base-page'
import { createAgentMenuPage } from '../shared/agent-menu'

Page(BasePage(createAgentMenuPage({ kind: 'codex', title: 'Codex' })))
