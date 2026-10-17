import { BaseApp } from '@zeppos/zml/base-app'

App(BaseApp({
  globalData: {},
  onCreate() { console.log('[claude] watch remote 0.3.1 started') },
  onDestroy() { console.log('[claude] watch remote closed') }
}))
