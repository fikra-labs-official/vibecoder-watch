import { BaseApp } from '@zeppos/zml/base-app'

App(BaseApp({
  globalData: {},
  onCreate() { console.log('[codex] watch remote 0.1.0 started') },
  onDestroy() { console.log('[codex] watch remote closed') }
}))
