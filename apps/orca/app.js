import { BaseApp } from '@zeppos/zml/base-app'

App(BaseApp({
  globalData: {},
  onCreate() { console.log('[orca] watch remote 0.3.7 started') },
  onDestroy() { console.log('[orca] watch remote closed') }
}))
