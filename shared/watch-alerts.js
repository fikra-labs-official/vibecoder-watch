import { Vibrator, VIBRATOR_SCENE_SHORT_STRONG } from '@zos/sensor'

const MAX_SEEN = 24
const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/

export function createWatchAlerts({ namespace, storage, setTimer, clearTimer }) {
  const storageKey = `watch-alert-ids:${namespace}`
  let seen = []
  let vibrator
  let vibratorChecked = false
  let activeKey = null
  let pulseTimer = null
  let generation = 0
  let destroyed = false

  try {
    const saved = storage && JSON.parse(storage.getItem(storageKey) || '[]')
    if (Array.isArray(saved)) seen = saved.filter(value => typeof value === 'string').slice(-MAX_SEEN)
  } catch (error) {}

  function keyFor(state) {
    const id = state && (state.jobId || state.id)
    if (!SAFE_ID.test(id || '')) return null
    if (state.phase === 'approval') {
      if (!SAFE_ID.test(state.approvalId || '')) return null
      return JSON.stringify([namespace, 'approval', id, state.approvalId])
    }
    if (state.phase === 'result') return JSON.stringify([namespace, 'result', id])
    if (state.phase === 'error' && state.errorKind === 'job' && state.state === 'error') {
      return JSON.stringify([namespace, 'error', id])
    }
    return null
  }

  function remember(key) {
    if (seen.includes(key)) return false
    seen.push(key)
    seen = seen.slice(-MAX_SEEN)
    try { if (storage) storage.setItem(storageKey, JSON.stringify(seen)) } catch (error) {}
    return true
  }

  function stopMotor() {
    try { if (vibrator) vibrator.stop() } catch (error) {}
  }

  function silence() {
    generation += 1
    if (pulseTimer !== null) clearTimer(pulseTimer)
    pulseTimer = null
    stopMotor()
  }

  function vibrate(pulseCount) {
    silence()
    if (destroyed) return
    if (!vibratorChecked) {
      vibratorChecked = true
      try { vibrator = new Vibrator() } catch (error) { vibrator = null }
    }
    if (!vibrator || typeof vibrator.start !== 'function' || typeof vibrator.stop !== 'function') return
    const sequence = generation
    let pulses = 0
    function pulse() {
      if (destroyed || sequence !== generation) return
      // Explicit stop releases each finite pulse before the next start.
      stopMotor()
      try { vibrator.start({ mode: VIBRATOR_SCENE_SHORT_STRONG }) }
      catch (error) { silence(); return }
      pulses += 1
      pulseTimer = setTimer(() => {
        pulseTimer = null
        if (destroyed || sequence !== generation) return
        stopMotor()
        if (pulses < pulseCount) pulseTimer = setTimer(pulse, 200)
      }, 80)
    }
    pulse()
  }

  return {
    observe(state) {
      if (destroyed || !state) return
      // Refresh temporarily replaces the view of the same event.
      if (state.phase === 'refreshing') return
      const key = keyFor(state)
      if (key === activeKey) return
      activeKey = key
      silence()
      // Distinct patterns: a prompt asks three times, an error twice, a finished answer once.
      if (key && remember(key)) vibrate(state.phase === 'approval' ? 3 : state.phase === 'error' ? 2 : 1)
    },
    silence,
    destroy() {
      destroyed = true
      activeKey = null
      silence()
      vibrator = null
    }
  }
}
