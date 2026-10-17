import { BaseApp } from '@zeppos/zml/base-app'

App(BaseApp({
  globalData: {},
  onCreate() {
    console.log('[musafir] Hermes voice remote 0.10.0 started')
  },
  onDestroy() {
    console.log('[musafer] voice remote closed')
  }
}))
