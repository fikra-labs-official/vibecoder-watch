import { BasePage } from '@zeppos/zml/base-page'
import { createHistoryPage } from '../shared/history-page'

Page(BasePage(createHistoryPage({ kind: 'claude' })))
