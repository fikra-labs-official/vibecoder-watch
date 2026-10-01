import { BaseApp } from '@zeppos/zml/base-app'

App(BaseApp({
  globalData: {},
  onCreate() { console.log('[limits] watch app started') },
  onDestroy() { console.log('[limits] watch app closed') }
}))
