import { textRows } from './text-rows'
import { createWidget, widget, align, text_style, prop, getTextLayout, setStatusBarVisible } from '@zos/ui'
import * as keyboardUI from '@zos/ui'
import { getDeviceInfo } from '@zos/device'
import { setTimeout, clearTimeout } from '@zos/timer'
import { codec, create, id as mediaId } from '@zos/media'
import { closeSync, openSync, O_RDONLY, readSync, rmSync, statSync } from '@zos/fs'
import { setWakeUpRelaunch, setPageBrightTime, resetPageBrightTime, pauseDropWristScreenOff, resetDropWristScreenOff } from '@zos/display'
import { LocalStorage } from '@zos/storage'
import { replace } from '@zos/router'
import * as interaction from '@zos/interaction'
import { createOrcaVoiceRoute, createFolderVoiceRoute } from './orca-voice'
import { createClaudeVoiceRoute, createCodexVoiceRoute } from './claude-voice'
import { createWatchAlerts } from './watch-alerts'
import { MAX_AUDIO_BYTES, createWatchClient } from './watch-client'
import { createMusafirVoiceRoute, normalizeContext, heroById, MUSAFIR_CONTEXT_KEY, MUSAFIR_HERO_KEY } from './musafir-chat'

const RECORDING_LIMIT_MS = 300000
const FILE_POLL_MS = 250
const FILE_POLL_LIMIT = 12
const UI_TICK_MS = 300
const PAGE_BRIGHT_MS = 60000
const DISPLAY_RENEW_MS = 45000
const ACKNOWLEDGED_RESULT_KEY = 'acknowledged-result-id'
const DESTINATION_KEY = 'voice-destination'
const PENDING_AUDIO_KEY = 'pending-audio'
const DRAFT_KEY = 'voice-draft'
const CLAUDE_MODES = { auto: 'Авто', acceptEdits: 'Автоправки', plan: 'План', bypass: 'Без ограничений', default: 'Без правок' }
const LEGACY_COLORS = { background: 0x0b0b0c, gold: 0xeac477, text: 0xf4eee3,
  muted: 0xb8ac99, surface: 0x28231d, pressed: 0x413629, red: 0xff776a }
function clockText(seconds) {
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}

function pagesFor(value, width, px, height = 146) {
  const characters = Array.from(String(value || ''))
  if (!characters.length) return ['']
  const pages = []
  let offset = 0
  while (offset < characters.length) {
    let low = 1
    let high = Math.min(240, characters.length - offset)
    let count = 1
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const candidate = characters.slice(offset, offset + middle).join('')
      let fits
      try {
        const layout = getTextLayout(candidate, {
          text_size: px(20), text_width: width, wrapped: 1
        })
        if (!layout || !Number.isFinite(layout.height)) throw new Error('layout unavailable')
        fits = layout.result !== -1 && layout.height <= px(height)
      } catch (error) {
        // Older firmware may omit layout metadata; keep all text in small pages.
        const lines = candidate.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 14)), 0)
        fits = candidate.length <= (height < 146 ? 56 : 70) && lines <= (height < 146 ? 4 : 5)
      }
      if (fits) {
        count = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    // Keep words intact when they fit; a long unbroken token may still span pages.
    if (offset + count < characters.length && !/\s/.test(characters[offset + count])) {
      for (let split = count - 1; split >= Math.floor(count / 2); split--) {
        if (/\s/.test(characters[offset + split])) { count = split + 1; break }
      }
    }
    pages.push(characters.slice(offset, offset + count).join(''))
    offset += count
  }
  return pages
}

export function createVoicePage({ kind, icon, title, version, chats = false }) {
  const isOrca = kind === 'orca'
  const isMusafir = kind === 'musafir' && chats
  const COLORS = isMusafir ? { background: 0x080b0f, gold: 0xf0be75, text: 0xf3f6fa,
    muted: 0xa8b3c3, surface: 0x171d25, pressed: 0x26313e, red: 0xff626b } : LEGACY_COLORS
  const isClaude = kind === 'claude' || kind === 'codex'  // headless agent apps share one screen flow
  const isMenuApp = isOrca || isClaude
  const menuResumeKey = isOrca ? 'orca-resume' : kind + '-resume'
  const logName = isOrca ? 'orca' : isClaude ? kind : 'musafer'
  return {
  build() {
    setStatusBarVisible(false)
    const { width, height } = getDeviceInfo()
    // Keep layout in the actual app window, including compatibility mode.
    const scale = Math.min(width / 390, height / 450)
    const px = this.px = value => Math.round(value * scale)
    this.width = width
    this.height = height
    this.closed = false
    this.recorder = null
    this.recording = null
    this.recordTimer = null
    this.stopWatchdog = null
    this.audioFd = null
    this.audioFile = null
    this.audioSize = 0
    this.pageSource = null
    this.textPages = ['']
    this.textPage = 0
    this.reviewSource = null
    this.reviewRows = []
    this.keyboardOpen = false
    this.keyboardGeneration = 0
    this.heroFrame = null
    this.interactionRegistered = false
    this.foreignPendingAudio = false

    this.animationTimer = null
    this.phaseStartedAt = Date.now()
    this.viewState = null
    this.resultStorage = null
    try { this.resultStorage = new LocalStorage() } catch (error) {}
    this.alerts = createWatchAlerts({
      namespace: kind,
      storage: this.resultStorage,
      setTimer: setTimeout,
      clearTimer: clearTimeout
    })
    this.destination = null
    this.pendingResumeTimer = null
    this.stopArmed = false
    this.stopTimer = null
    this.controlTimer = null
    this.cancelControl = null
    this.controlBusy = false
    this.displayRenewedAt = 0
    let legacyOrcaContext = false
    if (isMenuApp) {
      try {
        const saved = this.resultStorage && this.resultStorage.getItem(DESTINATION_KEY)
        const context = saved && JSON.parse(saved)
        const orcaTarget = context && ((context.target === 'orca' && typeof context.pairId === 'string' && context.pairId) ||
            (context.target === 'folder' && typeof context.rootId === 'string' && context.rootId))
        const claudeTarget = context && context.target === kind && typeof context.project === 'string' && context.project
        if ((isOrca && orcaTarget) || (isClaude && claudeTarget)) this.destination = context
      } catch (error) {}
      if (!this.destination) {
        this.closed = true
        replace({ url: 'page/index' })
        return
      }
      try { this.resultStorage.setItem(menuResumeKey, JSON.stringify({ screen: 'voice' })) } catch (error) {}
    } else if (isMusafir) {
      try {
        const context = JSON.parse(this.resultStorage.getItem(MUSAFIR_CONTEXT_KEY) || 'null')
        if (!context || context.target !== 'musafir') throw new Error('No selected chat')
        this.destination = normalizeContext(context)
      } catch (error) {
        this.closed = true
        replace({ url: 'page/index' })
        return
      }
      this.hero = heroById(this.resultStorage && this.resultStorage.getItem(MUSAFIR_HERO_KEY))
    } else {
      try {
        const saved = this.resultStorage && this.resultStorage.getItem(DESTINATION_KEY)
        const context = saved && JSON.parse(saved)
        legacyOrcaContext = Boolean(context && ['orca', 'folder'].includes(context.target))
        if (legacyOrcaContext && this.resultStorage) {
          this.resultStorage.setItem(DESTINATION_KEY, '')
          this.resultStorage.setItem(PENDING_AUDIO_KEY, '')
        }
      } catch (error) {}
    }
    this.draftStorageKey = isMusafir ? DRAFT_KEY + ':musafir:' + (this.destination.chatId || 'new') : DRAFT_KEY + (this.destination
      ? ':' + [this.destination.target, this.destination.pairId || this.destination.project || this.destination.rootId,
        this.destination.sessionId || ''].join(':') : '')
    this.pendingAudio = legacyOrcaContext ? null : this.readPendingAudio()
    if (!isMusafir && !isOrca && !this.pendingAudio && this.resultStorage &&
        this.resultStorage.getItem('musafir-resume') === 'history') {
      this.closed = true
      replace({ url: 'page/history' })
      return
    }

    const centered = {
      x: px(24), w: width - px(48), align_h: align.CENTER_H,
      align_v: align.CENTER_V, text_style: text_style.WRAP
    }
    createWidget(widget.FILL_RECT, {
      x: 0, y: 0, w: width, h: height, color: COLORS.background
    })
    this.backButton = createWidget(widget.BUTTON, {
      x: px(24), y: px(12), w: Math.max(112, px(112)), h: Math.max(48, px(48)), radius: px(12),
      normal_color: COLORS.surface, press_color: COLORS.pressed, color: COLORS.text,
      text_size: px(18), text: '‹ Назад', click_func: () => this.handleMusafirBack()
    })
    const statusY = px(12) + Math.max(48, px(48)) + 4
    const stageY = statusY + px(32) + 2
    this.statusWidget = createWidget(widget.TEXT, {
      ...centered, y: statusY, h: px(32), color: COLORS.gold,
      text_size: px(24), text: 'Подключение'
    })
    this.stageWidget = createWidget(widget.TEXT, {
      ...centered, y: stageY, h: px(25), color: COLORS.muted,
      text_size: px(17), text: ''
    })
    this.brandWidget = createWidget(widget.IMG, {
      x: (width - (isMusafir ? 80 : px(64))) / 2, y: px(isMusafir ? 133 : 139),
      w: isMusafir ? 80 : px(64), h: isMusafir ? 80 : px(64),
      src: isMusafir ? `heroes/${this.hero.id}.png` : icon, auto_scale: !isMusafir
    })
    this.metricWidget = createWidget(widget.TEXT, {
      ...centered, y: px(151), h: px(66), color: COLORS.text,
      text_size: px(52), text: ''
    })
    this.recordDot = createWidget(widget.FILL_RECT, {
      x: width / 2 - px(7), y: px(130), w: px(14), h: px(14),
      radius: px(7), color: COLORS.red
    })
    this.progressTrack = createWidget(widget.FILL_RECT, {
      x: px(58), y: px(233), w: width - px(116), h: px(6),
      radius: px(3), color: COLORS.surface
    })
    this.progressFill = createWidget(widget.FILL_RECT, {
      x: px(58), y: px(233), w: px(1), h: px(6), radius: px(3), color: COLORS.gold
    })
    this.bodyWidget = createWidget(widget.TEXT, {
      ...centered, y: px(139), h: px(151), color: COLORS.text,
      text_size: px(20), text: ''
    })
    this.previousButton = createWidget(widget.BUTTON, {
      x: px(72), y: px(302), w: px(62), h: px(38), radius: px(12),
      normal_color: COLORS.surface, press_color: COLORS.pressed, color: COLORS.text,
      text_size: px(25), text: '‹', click_func: () => this.turnPage(-1)
    })
    this.pageWidget = createWidget(widget.TEXT, {
      x: px(140), y: px(302), w: width - px(280), h: px(38),
      color: COLORS.muted, text_size: px(17), align_h: align.CENTER_H,
      align_v: align.CENTER_V, text: ''
    })
    this.nextButton = createWidget(widget.BUTTON, {
      x: width - px(134), y: px(302), w: px(62), h: px(38), radius: px(12),
      normal_color: COLORS.surface, press_color: COLORS.pressed, color: COLORS.text,
      text_size: px(25), text: '›', click_func: () => this.turnPage(1)
    })
    this.primaryButton = createWidget(widget.BUTTON, {
      x: px(24), y: px(350), w: width - px(48), h: px(62), radius: px(18),
      normal_color: COLORS.gold, press_color: 0xd0a551, color: 0x17120b,
      text_size: px(22), text: 'Запись',
      click_func: () => this.primaryAction && this.primaryAction()
    })
    this.secondaryButton = createWidget(widget.BUTTON, {
      x: width / 2 + px(5), y: px(350), w: width / 2 - px(29), h: px(62),
      radius: px(18), normal_color: COLORS.surface, press_color: COLORS.pressed,
      color: COLORS.text, text_size: px(20), text: 'Отмена',
      click_func: () => this.secondaryAction && this.secondaryAction()
    })

    this.editButton = createWidget(widget.BUTTON, {
      x: px(24), y: px(296), w: width - px(48), h: px(44), radius: px(12),
      normal_color: COLORS.surface, press_color: COLORS.pressed, color: COLORS.gold,
      text_size: px(19), text: 'Править вручную', click_func: () => this.editTranscript()
    })
    this.editButton.setProperty(prop.VISIBLE, false)

    this.menuButton = createWidget(widget.BUTTON, {
      x: px(110), y: px(302), w: width - px(220), h: px(38), radius: px(12),
      normal_color: COLORS.surface, press_color: COLORS.pressed, color: COLORS.gold,
      text_size: px(18), text: isOrca ? 'Orca' : isClaude ? title : 'История',
      click_func: () => this.fullAnswerVisible ? this.openFullAnswer()
        : this.cancelPlanVisible ? this.client.approve(false) : isMenuApp ? this.handleMusafirBack()
        : isMusafir && this.client && this.client.getState().phase === 'approval'
          ? this.stopMusafir() : isMusafir && this.client && this.client.getState().reportLength > 0
            ? this.openMusafirReport() : this.openHistory()
    })
    if (this.menuButton) this.menuButton.setProperty(prop.VISIBLE, false)
    {
      const footerHeight = Math.max(44, px(54))
      const editHeight = Math.max(44, px(44))
      const editY = height - 16 - footerHeight - 10 - editHeight
      const listY = Math.max(px(139), stageY + px(25) + 8)
      const listWidth = width - px(48)
      this.reviewEditLayout = { x: px(24), y: editY, w: listWidth, h: editHeight }
      this.reviewTextWidth = listWidth - 24
      this.reviewTextSize = Math.max(18, px(20))
      const rowHeight = Math.max(44, px(40))
      this.reviewScroll = createWidget(widget.SCROLL_LIST, {
        x: px(24), y: listY, w: listWidth, h: editY - listY - 10,
        item_space: 0, snap_to_center: false, item_enable_horizon_drag: false,
        item_config: [{
          type_id: 1, item_height: rowHeight, item_bg_color: COLORS.background, item_bg_radius: 0,
          text_view: [{ x: 6, y: 0, w: this.reviewTextWidth, h: rowHeight,
            key: 'display', color: COLORS.text, text_size: this.reviewTextSize, action: true }],
          text_view_count: 1
        }],
        item_config_count: 1, data_array: [{ display: '' }], data_count: 1,
        item_click_func: (_list, index) => this.editReviewRow(index)
      })
      this.reviewScroll.setProperty(prop.VISIBLE, false)
      this.readerScroll = createWidget(widget.SCROLL_LIST, {
        x: px(24), y: listY, w: listWidth, h: editY - listY - 10,
        item_space: 0, snap_to_center: false, item_enable_horizon_drag: false,
        item_config: [{ type_id: 1, item_height: rowHeight, item_bg_color: COLORS.background,
          text_view: [{ x: 6, y: 0, w: this.reviewTextWidth, h: rowHeight,
            key: 'display', color: COLORS.text, text_size: this.reviewTextSize }], text_view_count: 1 }],
        item_config_count: 1, data_array: [{ display: '' }], data_count: 1
      })
      this.readerScroll.setProperty(prop.VISIBLE, false)
    }
    this.hideNavigation()
    this.setButtons(null, null)
    this.registerInteraction()

    try {
      const rawRequest = (payload, options) => this.request(payload, options)
      const save = context => {
        if (!this.resultStorage) return
        this.resultStorage.setItem(isMusafir ? MUSAFIR_CONTEXT_KEY : DESTINATION_KEY, JSON.stringify(context))
        if (isMusafir && (this.pendingAudio || context.pendingSend)) this.saveMusafirPending()
      }
      const route = isMusafir ? createMusafirVoiceRoute : this.destination && this.destination.target === 'orca' ? createOrcaVoiceRoute
        : this.destination && this.destination.target === 'folder' ? createFolderVoiceRoute
          : this.destination && this.destination.target === 'claude' ? createClaudeVoiceRoute
            : this.destination && this.destination.target === 'codex' ? createCodexVoiceRoute : null
      const request = route ? route({ request: rawRequest, context: this.destination, save }) : rawRequest
      const acknowledgementKey = ACKNOWLEDGED_RESULT_KEY + (this.destination ? ':' + (this.destination.chatId || this.destination.pairId || this.destination.project || 'folder') : '')
      this.client = createWatchClient({
        setTimer: setTimeout,
        clearTimer: clearTimeout,
        request,
        readDraft: () => {
          try { return JSON.parse(this.resultStorage.getItem(this.draftStorageKey) || 'null') }
          catch (error) { return null }
        },
        writeDraft: value => {
          if (!this.resultStorage) throw new Error('Не удалось сохранить текст на часах')
          this.resultStorage.setItem(this.draftStorageKey, value ? JSON.stringify(value) : '')
          if (isMusafir) {
            if (value) this.saveMusafirPending()
            else this.clearMusafirPending()
          }
        },
        readAcknowledgedResultId: () => !isMusafir && this.resultStorage && this.resultStorage.getItem(acknowledgementKey),
        writeAcknowledgedResultId: id => this.resultStorage && this.resultStorage.setItem(acknowledgementKey, id),
        report: state => {
          try {
            this.alerts.observe(state)
            this.render(state)
            this.handlePendingAudio(state)
          } catch (error) { this.showStartupError(error) }
        }
      })
      this.client.start()
    } catch (error) {
      this.showStartupError(error)
    }
  },

  saveMusafirPending() {
    if (isMusafir && this.resultStorage && this.destination) {
      this.resultStorage.setItem('musafir-pending-context', JSON.stringify({ ...this.destination, autoRecord: false }))
    }
  },

  clearMusafirPending() {
    if (!isMusafir || !this.resultStorage) return
    try {
      const saved = JSON.parse(this.resultStorage.getItem('musafir-pending-context') || 'null')
      if (!saved || saved.chatId === this.destination.chatId || saved.jobId === this.destination.jobId) {
        this.resultStorage.setItem('musafir-pending-context', '')
      }
    } catch (error) {}
  },

  registerInteraction() {
    if (this.interactionRegistered) return
    try {
      if (typeof interaction.onGesture === 'function') {
        interaction.onGesture({ callback: event => {
          if (this.keyboardOpen) return false
          if (event !== interaction.GESTURE_RIGHT) return false
          return this.handleMusafirBack()
        } })
      }
      if (typeof interaction.onKey === 'function') {
        interaction.onKey({ callback: (key, event) => {
          if (this.keyboardOpen) return false
          if (key !== interaction.KEY_BACK || event !== interaction.KEY_EVENT_CLICK) return false
          return this.handleMusafirBack()
        } })
      }
      this.interactionRegistered = true
    } catch (error) {}
  },

  unregisterInteraction() {
    if (!this.interactionRegistered) return
    try { if (typeof interaction.offGesture === 'function') interaction.offGesture() } catch (error) {}
    try { if (typeof interaction.offKey === 'function') interaction.offKey() } catch (error) {}
    this.interactionRegistered = false
  },

  persistMusafirExit(state) {
    if (this.destination && this.client) {
      if (state.jobId) this.destination.jobId = state.jobId
      this.destination.autoRecord = false
      this.destination.openJob = Boolean(state.jobId &&
        ['sending', 'job', 'approval', 'result', 'unknown'].includes(state.phase))
      this.resultStorage && this.resultStorage.setItem(MUSAFIR_CONTEXT_KEY, JSON.stringify(this.destination))
    }
  },

  handleMusafirBack() {
    if (this.closed || this.keyboardOpen || !this.client) return false
    const state = this.client.getState()
    if (['recording', 'stopping', 'canceling'].includes(state.phase) || this.recording) {
      this.cancelRecording()
    } else if (['uploading', 'transcribing'].includes(state.phase) ||
        (state.phase === 'error' && this.pendingAudio)) {
      this.cancelPendingAudio()
    } else if (state.phase === 'saving-text') {
      this.client.cancelBeforeSend()
      this.saveMusafirPending()
    } else if (state.phase === 'review') {
      // Both dictated and typed reviews are persisted before they are shown.
      this.saveMusafirPending()
    }
    if (!isMusafir) { this.persistAgentExit(); this.openOrca(); return true }
    this.persistMusafirExit(this.client.getState())
    replace({ url: 'page/index' })
    return true
  },

  persistAgentExit() {
    if (!this.destination || !this.resultStorage || !this.client) return
    const state = this.client.getState()
    // Keep actual backend identity; the client id may alias a reply or handoff.
    if (this.destination.jobId && ['sending', 'job', 'approval', 'result', 'unknown', 'error'].includes(state.phase)) {
      this.destination.resumeJob = true
    }
    this.destination.autoRecord = false
    this.resultStorage.setItem(DESTINATION_KEY, JSON.stringify(this.destination))
  },

  continueAgent() {
    if (!this.client || this.client.getState().phase !== 'result') return
    Object.assign(this.destination, { startFresh: true, resumeJob: false, autoRecord: false })
    this.resultStorage.setItem(DESTINATION_KEY, JSON.stringify(this.destination))
    this.draftStorageKey = DRAFT_KEY + ':' + [this.destination.target, this.destination.pairId || this.destination.project || this.destination.rootId, this.destination.sessionId || ''].join(':')
    this.client.home()
  },

  openFullAnswer() {
    if (isMusafir) { this.openMusafirReport(); return }
    if (!this.destination || !this.destination.jobId || !this.resultStorage) return
    this.persistAgentExit()
    if (isOrca) this.resultStorage.setItem('orca-history-pair', JSON.stringify({
      id: this.destination.pairId, projectLabel: this.destination.label,
      workerAgent: this.destination.workerAgent || '', reviewerAgent: this.destination.reviewerAgent || '' }))
    this.resultStorage.setItem(kind + '-history-view', JSON.stringify({
      screen: 'detail', id: this.destination.jobId, field: 'result', offset: 0 }))
    this.resultStorage.setItem(kind + '-resume', JSON.stringify({ screen: 'history' }))
    replace({ url: 'page/history' })
  },

  openMusafirHome() {
    return this.handleMusafirBack()
  },

  continueMusafir() {
    if (!isMusafir || !this.client || this.client.getState().phase !== 'result') return
    this.destination.openJob = false
    this.destination.autoRecord = false
    if (this.resultStorage) this.resultStorage.setItem(MUSAFIR_CONTEXT_KEY, JSON.stringify(this.destination))
    this.client.home()
  },

  discardReview() {
    if (!this.client || this.client.getState().phase !== 'review') return
    const fileName = this.pendingAudio && this.pendingAudio.fileName
    this.closeAudio(false)
    this.removeAudio(fileName)
    this.clearPendingAudio()
    this.localRecordingError = false
    this.client.cancelReview()
  },

  openMusafirReport() {
    if (!isMusafir || !this.client || !this.client.getState().jobId) return
    this.resultStorage.setItem('musafir-report-job', this.client.getState().jobId)
    this.destination.openJob = true
    this.resultStorage.setItem(MUSAFIR_CONTEXT_KEY, JSON.stringify(this.destination))
    replace({ url: 'page/report' })
  },

  stopMusafir() {
    if (!isMusafir || !this.client || this.client.getState().state === 'stopping') return
    if (!this.stopArmed) {
      this.stopArmed = true
      this.stopTimer = setTimeout(() => { this.stopTimer = null; this.disarmStop() }, 6000)
      this.render(this.client.getState())
      return
    }
    this.disarmStop()
    this.client.stopJob()
  },

  editTranscript() {
    if (this.closed || this.keyboardOpen || !this.client) return
    const state = this.client.getState()
    if (state.phase !== 'review') return
    this.openKeyboard(state.text, value => this.client.updateReviewText(value))
  },

  editReviewRow(index) {
    if (this.closed || this.keyboardOpen || !this.client) return
    const state = this.client.getState()
    const row = this.reviewRows[index]
    if (state.phase !== 'review' || !row || state.text !== this.reviewSource) return
    const original = state.text
    this.openKeyboard(original.slice(row.start, row.end), value => {
      const current = this.client.getState()
      if (current.phase !== 'review' || current.text !== original) throw new Error('Текст изменился. Откройте строку заново.')
      this.reviewKeepPosition = true
      try { this.client.updateReviewText(original.slice(0, row.start) + value + original.slice(row.end)) }
      finally { this.reviewKeepPosition = false }
    })
  },

  showReviewText(text) {
    if (text !== this.reviewSource) {
      this.reviewSource = text
      this.reviewRows = textRows(text, this.reviewTextWidth, this.reviewTextSize, getTextLayout)
      this.reviewScroll.setProperty(prop.UPDATE_DATA, {
        data_array: this.reviewRows, data_count: this.reviewRows.length, on_page: this.reviewKeepPosition ? 1 : 0
      })
    }
    this.reviewScroll.setProperty(prop.VISIBLE, true)
    this.bodyWidget.setProperty(prop.VISIBLE, false)
    this.hideNavigation()
    this.editButton.setProperty(prop.MORE, { ...this.reviewEditLayout, text: 'Править весь текст' })
  },

  writeTask() {
    if (this.closed || this.keyboardOpen || !this.client ||
        this.client.getState().phase !== 'ready') return
    this.openKeyboard('', value => this.client.createTypedReview(value))
  },

  openKeyboard(text, onComplete) {
    if (typeof keyboardUI.createKeyboard !== 'function' || !keyboardUI.inputType) {
      this.stageWidget.setProperty(prop.TEXT, 'Клавиатура требует Zepp OS API 4.0+')
      return
    }
    this.alerts.silence()
    const generation = ++this.keyboardGeneration
    this.keyboardOpen = true
    const options = {
      text,
      onComplete: (_, result) => {
        if (this.closed || generation !== this.keyboardGeneration) return
        this.closeKeyboard()
        try {
          if (!result || typeof result.data !== 'string') throw new Error('Клавиатура не вернула текст')
          onComplete(result.data)
        } catch (error) {
          this.stageWidget.setProperty(prop.TEXT, error.message || 'Не удалось сохранить текст')
        }
      },
      onCancel: () => {
        if (this.closed || generation !== this.keyboardGeneration) return
        this.closeKeyboard()
        this.render(this.client.getState())
      }
    }
    try {
      // JSKB opens the enabled custom keyboard; CHAR also allows switching via the globe.
      const type = keyboardUI.inputType.JSKB == null ? keyboardUI.inputType.CHAR : keyboardUI.inputType.JSKB
      try {
        if (keyboardUI.createKeyboard({ ...options, inputType: type }) === false) throw new Error('KEYBOARD_UNAVAILABLE')
      } catch (error) {
        try { keyboardUI.deleteKeyboard() } catch (ignored) {}
        if (type === keyboardUI.inputType.CHAR ||
            keyboardUI.createKeyboard({ ...options, inputType: keyboardUI.inputType.CHAR }) === false) throw error
      }
    } catch (error) {
      this.closeKeyboard()
      this.stageWidget.setProperty(prop.TEXT, 'Включите клавиатуру в настройках часов')
    }
  },

  closeKeyboard() {
    if (!this.keyboardOpen) return
    this.keyboardOpen = false
    this.keyboardGeneration += 1
    try { keyboardUI.deleteKeyboard() } catch (error) {}
  },

  openHistory() {
    if (isMusafir) { this.openMusafirHome(); return }
    if (isOrca || this.pendingAudio || !this.client ||
        !['ready', 'result', 'job', 'unknown', 'error'].includes(this.client.getState().phase)) return
    if (this.client.getState().phase === 'result') this.client.home()
    try {
      if (isClaude) {
        this.resultStorage.setItem(kind + '-resume', JSON.stringify({ screen: 'history' }))
        this.resultStorage.setItem(kind + '-history-view', JSON.stringify({ screen: 'home' }))
      } else {
        this.resultStorage.setItem('musafir-resume', 'history')
        this.resultStorage.setItem('musafir-history-view', JSON.stringify({ screen: 'home' }))
      }
    } catch (error) {}
    replace({ url: 'page/history' })
  },

  chooseAnswer(state) {
    try {
      this.resultStorage.setItem(kind + '-resume', JSON.stringify({ screen: 'question', jobId: state.jobId,
        approvalId: state.approvalId, question: state.approvalQuestion || state.approvalText, options: state.approvalOptions }))
    } catch (error) { return }
    replace({ url: 'page/index' })
  },

  openOrca() {
    try {
      this.persistAgentExit()
      const target = this.destination
      if (isClaude) {
        this.resultStorage.setItem(kind + '-resume', JSON.stringify(target && target.target === kind && target.project !== 'general'
          ? { screen: 'project', project: { id: target.project, label: target.label || title } }
          : { screen: 'home' }))
        replace({ url: 'page/index' })
        return
      }
      this.resultStorage.setItem('orca-resume', JSON.stringify(target && target.target === 'orca'
        ? { screen: 'pair', pair: { id: target.pairId, projectLabel: target.label,
          workerAgent: target.workerAgent || '', reviewerAgent: target.reviewerAgent || '' } }
        : { screen: 'home' }))
    } catch (error) {}
    replace({ url: 'page/index' })
  },

  answerOrca() {
    this.destination.answering = true
    this.destination.pendingSend = false
    if (this.destination.target === 'folder') this.destination.parentPlanId = this.destination.operationId
    this.resultStorage.setItem(DESTINATION_KEY, JSON.stringify(this.destination))
    replace({ url: 'page/voice' })
  },

  openCreatedProject() {
    const current = this.destination
    if (!current || !current.createdPairId) {
      this.openOrca()
      return
    }
    this.destination = {
      target: 'orca',
      pairId: current.createdPairId,
      label: current.createdLabel || current.label || 'Проект',
      workerAgent: current.createdWorkerAgent || '',
      reviewerAgent: current.createdReviewerAgent || '',
      workerModel: current.createdWorkerModel || '',
      reviewerModel: current.createdReviewerModel || '',
      jobId: current.createdJobId || null,
      aliasId: current.createdJobId || null,
      resumeJob: Boolean(current.createdJobId)
    }
    this.resultStorage.setItem(DESTINATION_KEY, JSON.stringify(this.destination))
    if (current.createdJobId) replace({ url: 'page/voice' })
    else this.openOrca()
  },

  async controlRequest(payload) {
    if (this.closed || this.controlBusy) throw new Error('Дождитесь подтверждения')
    this.controlBusy = true
    this.stageWidget.setProperty(prop.TEXT, 'Жду подтверждение Mac…')
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error, reply) => {
        if (settled) return
        settled = true
        if (this.controlTimer !== null) clearTimeout(this.controlTimer)
        this.controlTimer = null
        this.cancelControl = null
        this.controlBusy = false
        if (error) reject(error); else resolve(reply)
      }
      this.cancelControl = () => finish(new Error('Экран закрыт'))
      this.controlTimer = setTimeout(() => finish(new Error('Нет подтверждения Mac. Обновите статус.')), 18000)
      Promise.resolve().then(() => this.request(payload, { timeout: 15000 }))
        .then(reply => finish(null, reply), error => finish(error))
    })
  },

  async handoffOrca() {
    const current = this.destination
    if (!current || !current.jobId || !current.handoff || this.controlBusy || this.closed) return
    const pending = current.pendingHandoff
    const transfer = pending || { id: this.client.createId(), sourceId: current.jobId }
    if (!/^\d{1,16}-\d{1,8}$/.test(transfer.id || '') || transfer.sourceId !== current.jobId) {
      this.stageWidget.setProperty(prop.TEXT, 'Не удалось проверить сохранённую передачу')
      return
    }
    try {
      current.pendingHandoff = transfer
      this.resultStorage.setItem(DESTINATION_KEY, JSON.stringify(current))
      let reply
      if (pending) {
        reply = await this.controlRequest({ method: 'ORCA_JOB', params: { id: transfer.id } })
        if (this.closed) return
        if (!reply || !reply.ok) {
          if (!reply || reply.retryable !== false) throw new Error(reply && reply.error || 'Передача не подтверждена')
          reply = null
        }
      }
      if (!reply) reply = await this.controlRequest({ method: 'ORCA_HANDOFF', params: { id: transfer.sourceId, newId: transfer.id } })
      if (this.closed) return
      if (!reply || !reply.ok || !reply.job || reply.job.id !== transfer.id) {
        throw new Error(reply && reply.error || 'Не удалось подтвердить передачу')
      }
      Object.assign(current, { jobId: reply.job.id, aliasId: reply.job.id, resumeJob: true,
        handoff: false, pendingHandoff: null, mode: 'task', startFresh: false })
      this.resultStorage.setItem(DESTINATION_KEY, JSON.stringify(current))
      replace({ url: 'page/voice' })
    } catch (error) {
      if (!this.closed) this.stageWidget.setProperty(prop.TEXT, 'Передача не подтверждена · нажмите «Боевому»')
    }
  },

  async pauseOrca() {
    if (this.closed || this.controlBusy || !this.destination || !this.destination.jobId) return
    try {
      const reply = await this.controlRequest({ method: 'ORCA_PAUSE', params: { id: this.destination.jobId, paused: !this.destination.paused } })
      if (!reply || !reply.ok) throw new Error(reply && reply.error || 'Не удалось изменить паузу')
      if (!this.closed) this.client.refresh()
    } catch (error) { if (!this.closed) this.stageWidget.setProperty(prop.TEXT, error.message || 'Нет связи с Mac') }
  },

  stopOrca() {
    if (this.closed || this.controlBusy || !this.destination || !this.destination.jobId) return
    if (!this.stopArmed) {
      // Two taps within 6 s: a stop interrupts the agent and closes the task for good.
      this.stopArmed = true
      if (this.stopTimer !== null) clearTimeout(this.stopTimer)
      this.stopTimer = setTimeout(() => { this.stopTimer = null; this.disarmStop() }, 6000)
      this.render(this.client.getState())
      return
    }
    this.disarmStop()
    this.controlRequest({ method: isClaude ? kind.toUpperCase() + '_STOP' : 'ORCA_STOP', params: { id: this.destination.jobId } })
      .then(reply => {
        if (!reply || !reply.ok) throw new Error(reply && reply.error || 'Не удалось остановить')
        if (!this.closed) this.client.refresh()
      })
      .catch(error => { if (!this.closed) this.stageWidget.setProperty(prop.TEXT, error.message || 'Нет связи с Mac') })
  },

  disarmStop() {
    if (this.stopTimer !== null) clearTimeout(this.stopTimer)
    this.stopTimer = null
    const rerender = this.stopArmed && !this.closed
    this.stopArmed = false
    if (rerender && this.viewState && ['job', 'approval'].includes(this.viewState.phase)) this.render(this.client.getState())
  },

  showStartupError(error) {
    console.log(`[${logName}] startup error: ${String(error && error.message || error)}`)
    this.statusWidget.setProperty(prop.TEXT, 'Ошибка запуска')
    this.bodyWidget.setProperty(prop.TEXT, 'Не удалось открыть экран.\nНажмите «Повторить».')
    this.setButtons({ text: 'Повторить',
      action: () => this.client ? this.client.start() : this.showStartupError('client unavailable') }, null)
  },

  prepareRecorder() {
    if (this.recorder) return
    const recorder = create(mediaId.RECORDER)
    if (!recorder || typeof recorder.setFormat !== 'function' ||
        typeof recorder.start !== 'function' || typeof recorder.stop !== 'function') {
      throw new Error('RECORDER_API_UNAVAILABLE')
    }
    // Recorder's documented baseline has no event enum. Read the saved file
    // after stop(), with a bounded wait for firmware to finish flushing it.
    this.recorder = recorder
  },

  reportRecorderError(stage, error) {
    const detail = String(error && error.message || error).slice(0, 160)
    console.log(`[${logName}] ${stage}: ${detail}`)
    try {
      this.request({ method: 'DIAGNOSTIC', params: { version, stage, detail } },
        { timeout: 5000 }).catch(() => {})
    } catch (ignored) {}
  },

  setButtons(primary, secondary) {
    const px = this.px
    this.primaryAction = primary && (() => {
      if (this.controlBusy) return
      this.alerts.silence()
      primary.action()
    })
    this.secondaryAction = secondary && (() => {
      if (this.controlBusy) return
      this.alerts.silence()
      secondary.action()
    })
    this.primaryButton.setProperty(prop.VISIBLE, Boolean(primary))
    this.secondaryButton.setProperty(prop.VISIBLE, Boolean(secondary))
    const height = Math.max(44, px(54))
    const y = this.height - 16 - height
    const margin = px(24)
    const gap = px(10)
    const half = Math.floor((this.width - margin * 2 - gap) / 2)
    if (primary) {
      this.primaryButton.setProperty(prop.MORE, {
        x: margin, y,
        w: secondary ? half : this.width - margin * 2,
        h: height, text: primary.text
      })
    }
    if (secondary) this.secondaryButton.setProperty(prop.MORE, {
      x: margin + half + gap, y, w: half, h: height, text: secondary.text
    })
  },

  setBody(text, pageable = true, height = 146) {
    const source = String(text || '')
    if (source !== this.pageSource || pageable !== this.bodyPageable || height !== this.bodyPageHeight) {
      this.bodyPageHeight = height
      this.bodyPageable = pageable
      this.pageSource = source
      this.textPages = pageable ? pagesFor(source, this.width - this.px(48), this.px, height) : [source]
      this.textPage = 0
    }
    this.bodyWidget.setProperty(prop.TEXT, this.textPages[this.textPage])
    this.updateNavigation()
  },

  hideNavigation() {
    this.previousButton.setProperty(prop.VISIBLE, false)
    this.nextButton.setProperty(prop.VISIBLE, false)
    this.pageWidget.setProperty(prop.VISIBLE, false)
  },

  turnPage(direction) {
    const next = this.textPage + direction
    if (next < 0 || next >= this.textPages.length) return
    this.textPage = next
    this.bodyWidget.setProperty(prop.TEXT, this.textPages[this.textPage])
    this.updateNavigation()
  },

  updateNavigation() {
    const multiple = this.textPages.length > 1
    this.previousButton.setProperty(prop.VISIBLE, multiple && this.textPage > 0)
    this.nextButton.setProperty(prop.VISIBLE, multiple && this.textPage < this.textPages.length - 1)
    this.pageWidget.setProperty(prop.VISIBLE, multiple)
    this.pageWidget.setProperty(prop.TEXT, multiple ? `${this.textPage + 1}/${this.textPages.length}` : '')
  },

  updateDisplay(state) {
    const ongoing = state.phase !== 'ready' && state.phase !== 'canceling' &&
      !(state.phase === 'error' && state.errorKind === 'local')
    try { setWakeUpRelaunch({ relaunch: true }) } catch (error) {}
    // A finite page override, never renewed by status polling or UI animation.
    try {
      if (ongoing) {
        setPageBrightTime({ brightTime: PAGE_BRIGHT_MS })
        this.displayRenewedAt = Date.now()
      }
      else resetPageBrightTime()
    } catch (error) {}
    try {
      if (['recording', 'stopping', 'uploading', 'transcribing', 'review'].includes(state.phase)) {
        pauseDropWristScreenOff({ duration: PAGE_BRIGHT_MS })
      } else resetDropWristScreenOff()
    } catch (error) {}
  },

  render(state) {
    if (this.closed) return
    const px = this.px
    const changed = !this.viewState || state.phase !== this.viewState.phase
    if (changed) {
      this.phaseStartedAt = Date.now()
      this.updateDisplay(state)
    }
    this.viewState = state
    if (!['job', 'approval'].includes(state.phase) && this.stopArmed) {
      if (this.stopTimer !== null) clearTimeout(this.stopTimer)
      this.stopTimer = null
      this.stopArmed = false
    }
    this.clearAnimation()
    let status = title
    let stage = ''
    let body = ''
    let primary = null
    let secondary = null
    const home = state.phase === 'ready'
    const active = ['connecting', 'refreshing', 'recording', 'stopping', 'canceling',
      'uploading', 'transcribing', 'saving-text', 'sending', 'job'].includes(state.phase)
    const reader = !home && !active

    if (state.phase === 'connecting' || state.phase === 'refreshing') {
      status = 'Подключение'
      stage = 'Часы → телефон → Mac'
      body = `Соединяюсь с ${title}.\nZepp должен быть открыт.`
    } else if (home) {
      status = 'Готов слушать'
      stage = `${title} · твой Mac`
      body = 'Нажмите «Запись» и говорите.\nДо 5 минут на команду.'
      primary = { text: 'Запись', action: () => this.startRecording() }
      if (state.hasLastResult) secondary = { text: 'Ответ', action: () => this.client.showLastResult() }
    } else if (state.phase === 'recording') {
      status = 'Идёт запись'
      stage = '1 из 3 · Голос'
      primary = { text: 'Стоп', action: () => this.stopRecording(false) }
      secondary = { text: 'Отмена', action: () => this.cancelRecording() }
    } else if (state.phase === 'stopping') {
      status = 'Сохраняю запись'
      stage = 'Микрофон выключен'
      body = 'Подготавливаю звук\nдля передачи на Mac.'
    } else if (state.phase === 'canceling') {
      status = 'Отменяю запись'
      stage = 'Микрофон выключен'
      body = 'Удаляю аудио.\nКоманда не отправлена.'
    } else if (state.phase === 'uploading') {
      status = 'Передаю запись'
      stage = '2 из 3 · На твой Mac'
      body = 'Запись идёт через телефон.\nСледом распознаю речь.'
    } else if (state.phase === 'transcribing') {
      status = 'Распознаю речь'
      stage = '2 из 3 · Голос в текст'
      body = 'Обрабатываю звук на Mac.\nЗатем покажу текст команды.'
    } else if (state.phase === 'review') {
      status = 'Всё верно?'
      stage = 'Проверь текст перед отправкой'
      body = state.text
      primary = { text: 'Отправить', action: () => this.client.sendText() }
      secondary = { text: 'Заново', action: () => this.startRecording() }
      if (state.edited) stage = 'Правки сохранены · проверь и отправь'
      if (state.error) stage = state.error
    } else if (state.phase === 'saving-text') {
      status = 'Сохраняю правки'
      stage = 'Текст ещё не отправлен агенту'
      body = 'Передаю исправленный текст на Mac.\nЗатем отправлю задание.'
    } else if (state.phase === 'sending') {
      status = state.approvalId ? 'Передаю решение' : 'Отправляю команду'
      stage = `3 из 3 · ${title}`
      body = state.approvalId ? `Передаю ваш выбор\n${title} на Mac.` : `Передаю подтверждённый\nтекст ${title} на Mac.`
    } else if (state.phase === 'job') {
      status = state.state === 'queued' ? 'Задание получено'
        : state.state === 'submitting' ? 'Передаю агенту' : `${title} работает`
      stage = state.state === 'running' ? 'Работа началась · жду результат' : 'Сохранено на Mac'
      body = state.state === 'running' ? `${title} выполняет задание.\nРезультат появится здесь.`
        : state.state === 'submitting' ? `Ожидаю подтверждение\nзапуска ${title}.`
          : `Задание принято в очередь.\nОжидаю запуска ${title}.`
      if (!isOrca) secondary = { text: 'История', action: () => this.openHistory() }
    } else if (state.phase === 'approval' && isClaude && state.approvalId && state.approvalOptions) {
      // An agent question with options: the choice is made on the menu page's list.
      status = `Вопрос от ${title}`
      stage = state.approvalStep ? `Вопрос ${state.approvalStep} · вариантов: ${state.approvalOptions.length}` : `Вариантов: ${state.approvalOptions.length}`
      body = state.approvalQuestion || state.approvalText
      primary = { text: 'Выбрать…', action: () => this.chooseAnswer(state) }
      secondary = { text: 'Отказать', action: () => this.client.approve(false) }
    } else if (state.phase === 'approval') {
      status = 'Нужно разрешение'
      stage = `Действие ${title} на Mac`
      body = state.approvalText
      if (state.approvalId) {
        primary = { text: 'Разрешить', action: () => this.client.approve(true) }
        secondary = { text: 'Отказать', action: () => this.client.approve(false) }
      } else {
        primary = { text: 'Обновить', action: () => this.client.refresh() }
      }
    } else if (state.phase === 'result') {
      status = `Ответ ${title}`
      stage = isOrca ? 'Orca · твой Mac' : isClaude ? title + ' · твой Mac' : 'Hermes · твой Mac'
      body = state.result
      primary = { text: 'Запись', action: () => this.startRecording() }
      secondary = isOrca ? { text: 'Домой', action: () => this.client.home() }
        : { text: 'История', action: () => this.openHistory() }
    } else if (state.phase === 'unknown') {
      status = 'Уточним статус'
      stage = 'Команда могла быть принята'
      body = state.statusMessage || 'Связь прервалась. Нажмите «Обновить», чтобы узнать итог. Команда не отправится повторно.'
      primary = { text: 'Обновить', action: () => this.client.refresh() }
      if (isOrca) secondary = { text: 'Orca', action: () => this.openOrca() }
      if (isClaude) secondary = { text: title, action: () => this.openOrca() }
      if (!isMenuApp && !this.pendingAudio) secondary = { text: 'История', action: () => this.openHistory() }
    } else if (state.phase === 'error') {
      const local = state.errorKind === 'local' || this.localRecordingError
      status = local ? 'Ошибка записи' : 'Не удалось продолжить'
      stage = state.retryMethod === 'AUDIO_STATUS' ? 'Распознавание на Mac' : 'Нужно повторить этот шаг'
      body = state.error || 'Не удалось выполнить запрос.'
      primary = { text: 'Повторить', action: () => local
        ? (this.pendingAudio ? this.uploadPendingAudio() : this.startRecording())
        : this.client.refresh() }
      if (state.retryMethod === 'AUDIO_UPLOAD') {
        secondary = { text: 'Отмена', action: () => this.cancelPendingAudio() }
      } else if (local) secondary = this.pendingAudio
        ? { text: 'Отмена', action: () => this.cancelPendingAudio() }
        : { text: 'Домой', action: () => {
          this.localRecordingError = false
          this.client.home()
        } }
      else if (!isOrca && state.errorKind === 'job') secondary = { text: 'История', action: () => this.openHistory() }
      if (isClaude && !local && !this.pendingAudio) secondary = { text: title, action: () => this.openOrca() }
      if (isOrca && !local && !this.pendingAudio) {
        secondary = { text: 'Orca', action: () => this.openOrca() }
        if (state.errorKind === 'rejected') {
          status = 'Проект не создан'
          stage = 'Текст сохранён на Mac'
          primary.text = 'К тексту'
        }
      }
      if (local && this.foreignPendingAudio) {
        status = 'Запись сохранена'
        stage = 'Она относится к другой задаче'
        body = state.error
        primary = isMusafir
          ? { text: 'К задачам', action: () => this.openMusafirHome() }
          : isMenuApp
            ? { text: isOrca ? 'Orca' : title, action: () => this.openOrca() }
            : { text: 'Домой', action: () => this.client.home() }
        secondary = null
      }
    }

    if (this.destination && isClaude) {
      const label = this.destination.label || title
      if (home) {
        status = `Задача для ${title}`
        stage = label + (this.destination.sessionId ? ' · продолжение' : '')
        body = `Нажмите «Запись» и говорите.\nРежим: ${this.destination.modeLabel || CLAUDE_MODES[this.destination.mode] || 'Авто'}`
      } else if (state.phase === 'job') {
        stage = state.state === 'running' ? label + ' · в работе' : label + ' · ожидает запуска'
        primary = { text: this.stopArmed ? 'Точно стоп?' : 'Стоп', action: () => this.stopOrca() }
        secondary = { text: 'История', action: () => this.openHistory() }
      } else if (state.phase === 'result') {
        stage = label
      }
    }
    if (this.destination && ['orca', 'folder'].includes(this.destination.target)) {
      const folder = this.destination.target === 'folder'
      const label = this.destination.label || 'Orca'
      const askRole = !folder && this.destination.askRole
      if (home) {
        status = folder ? this.destination.answering ? 'Уточнение проекта' : 'Новый проект'
          : this.destination.answering ? 'Ответ проверяющему'
            : askRole ? (askRole === 'worker' ? 'Вопрос боевому' : 'Вопрос проверяющему') : 'Задача для Orca'
        stage = label
        body = folder ? this.destination.answering
          ? 'Ответьте на вопрос или продиктуйте изменения к плану.'
          : 'Опишите проект, результат и нужных агентов.\nOrca сначала покажет план.'
          : askRole ? 'Спросите агента голосом.\nОн только ответит, ничего не меняя.'
            : 'Нажмите «Запись» и говорите.\nДо 5 минут на задачу.'
      } else if (state.phase === 'review') {
        stage = folder ? 'Разобрать задачу · ' + label : 'Отправить в Orca · ' + label
        primary.text = folder ? 'Разобрать' : 'Отправить'
      } else if (state.phase === 'sending' || state.phase === 'job') {
        const planning = folder && this.destination.operationStage !== 'creating'
        status = folder ? planning ? 'Готовлю план' : 'Создаю проект'
          : this.destination.mode === 'ask' ? 'Агент отвечает'
            : ({ reviewer_working: 'Готовится задание', worker_working: 'Боевой работает',
              reviewer_checking: 'Идёт проверка', paused: 'Цикл на паузе', coordinator_starting: 'Запускаю связку' })[this.destination.stage] || 'Orca работает'
        stage = label
        body = folder ? planning ? 'Orca разбирает задачу\nи готовит план.' : 'Создание идёт на Mac.'
          : 'Задача выполняется на Mac.\nРезультат сохранится.'
        if (state.phase === 'sending') {
          status = 'Отправляю задание'
          body = 'Ожидаю подтверждение\nприёма на Mac.'
        } else if (state.state === 'queued' || state.state === 'submitting') {
          status = 'Задание получено'
          body = 'Сохранено на Mac.\nОжидаю запуска.'
        }
        if (!folder && state.phase === 'job') {
          primary = { text: this.stopArmed ? 'Точно стоп?' : 'Стоп', action: () => this.stopOrca() }
          secondary = { text: this.destination.paused ? 'Продолжить' : 'Пауза', action: () => this.pauseOrca() }
        }
      } else if (state.phase === 'approval' && folder) {
        const approvalKind = this.destination.approvalKind
        if (approvalKind === 'plan') {
          status = 'План проекта'
          stage = 'Проверьте перед созданием'
          primary = { text: 'Создать', action: () => this.client.approve(true) }
          secondary = { text: 'Изменить', action: () => this.answerOrca() }
        } else if (approvalKind === 'clarification') {
          status = 'Нужно уточнение'
          stage = label
          primary = { text: 'Уточнить', action: () => this.answerOrca() }
          secondary = { text: 'Orca', action: () => this.openOrca() }
        } else if (approvalKind === 'folder_trust') {
          status = 'Доступ к папке'
          stage = 'Решение для Claude Code'
          primary = { text: 'Доверять', action: () => this.client.approve(true) }
          secondary = { text: 'Отказать', action: () => this.client.approve(false) }
        }
      } else if (state.phase === 'approval' && !folder) {
        status = 'Вопрос из Orca'
        stage = label
        primary = { text: 'Ответить', action: () => this.answerOrca() }
        secondary = { text: 'Orca', action: () => this.openOrca() }
      } else if (state.phase === 'result') {
        status = folder ? this.destination.operationState === 'cancelled'
          ? 'Создание отменено' : 'Проект создан'
          : this.destination.mode === 'ask' ? 'Ответ агента' : 'Итог Orca'
        stage = label
        if (folder) {
          primary = { text: this.destination.createdPairId ? 'Открыть' : 'Orca',
            action: () => this.openCreatedProject() }
          secondary = null
        } else if (this.destination.handoff) {
          // The agent proposed a prompt for the worker; only the owner's tap starts it.
          secondary = { text: 'Боевому', action: () => this.handoffOrca() }
        }
      }
    }
    if (isMusafir) {
      if (home) {
        status = this.destination.chatId ? 'Продолжение' : 'Новая задача'
        stage = this.destination.mode === 'research' ? 'Режим исследования' : 'Выберите способ ввода'
        body = 'Продиктуйте задачу или напишите её на клавиатуре.'
        primary = { text: 'Надиктовать', action: () => this.startRecording() }
        secondary = { text: 'Написать', action: () => this.writeTask() }
      } else if (state.phase === 'recording') {
        primary = { text: 'Распознать', action: () => this.stopRecording(false) }
        secondary = { text: 'Отмена', action: () => this.cancelRecording() }
      } else if (['stopping', 'uploading', 'transcribing'].includes(state.phase)) {
        primary = { text: 'Отмена', action: () => state.phase === 'stopping'
          ? this.cancelRecording() : this.cancelPendingAudio() }
        secondary = null
      } else if (state.phase === 'review') {
        secondary = { text: 'Отмена', action: () => this.discardReview() }
      } else if (state.phase === 'job') {
        if (state.state === 'stopping') {
          status = 'Останавливаю'
          stage = 'Жду подтверждение Hermes'
          body = 'Остановка запрошена.\nПроверяю результат.'
        } else {
          primary = { text: this.stopArmed ? 'Точно стоп?' : 'Остановить', action: () => this.stopMusafir() }
        }
        secondary = null
      } else if (state.phase === 'result') {
        status = state.state === 'cancelled' ? 'Остановлено' : 'Готово'
        stage = state.state === 'cancelled' ? 'Hermes подтвердил остановку' : 'Начало ответа · полный текст ниже'
        body = state.summary || state.result
        primary = { text: 'Продолжить', action: () => this.continueMusafir() }
        secondary = null
      } else if (state.phase === 'unknown') {
        secondary = null
      }
    }
    if (!isMusafir) {
      if (home) {
        body = body.replace('Нажмите «Запись» и говорите.', 'Голос или клавиатура.').replace('Спросите агента голосом.', 'Введите вопрос.')
        primary = { text: 'Надиктовать', action: () => this.startRecording() }
        secondary = { text: 'Написать', action: () => this.writeTask() }
      } else if (state.phase === 'recording') {
        primary = { text: 'Распознать', action: () => this.stopRecording(false) }
      } else if (['stopping', 'uploading', 'transcribing'].includes(state.phase)) {
        primary = { text: 'Отмена', action: () => state.phase === 'stopping' ? this.cancelRecording() : this.cancelPendingAudio() }
      } else if (state.phase === 'review') {
        secondary = { text: 'Отмена', action: () => this.discardReview() }
      } else if (state.phase === 'result' && this.destination && this.destination.target !== 'folder') {
        if (state.state === 'cancelled') { status = 'Остановлено'; stage = 'Остановка подтверждена' }
        primary = { text: 'Продолжить', action: () => this.continueAgent() }
      }
    }
    const reportButton = ['result', 'error'].includes(state.phase) && state.jobId && state.reportLength > 0 &&
      (!this.destination || this.destination.target !== 'folder')
    this.fullAnswerVisible = Boolean(reportButton)
    this.cancelPlanVisible = Boolean(isOrca && state.phase === 'approval' && this.destination.approvalKind === 'plan')
    const stopApproval = isMusafir && state.phase === 'approval'
    if (this.menuButton) {
      this.menuButton.setProperty(prop.VISIBLE, reportButton || stopApproval || this.cancelPlanVisible || (!isMusafir && !isMenuApp && home && !this.pendingAudio))
      this.menuButton.setProperty(prop.MORE, {
        ...this.reviewEditLayout,
        text: reportButton ? state.phase === 'error' ? 'Сохранённый ответ' : 'Полный ответ'
          : this.cancelPlanVisible ? 'Отменить план' : stopApproval ? this.stopArmed ? 'Подтвердить остановку' : 'Остановить задание' : isMenuApp ? title : 'История'
      })
    }

    this.statusWidget.setProperty(prop.MORE, { text: status,
      color: state.phase === 'error' ? COLORS.red : COLORS.gold })
    this.stageWidget.setProperty(prop.TEXT, stage)
    const heroActive = isMusafir && state.phase === 'job'
    this.brandWidget.setProperty(prop.VISIBLE, home || heroActive)
    if (isMusafir) this.brandWidget.setProperty(prop.MORE, {
      x: (this.width - 80) / 2, y: px(heroActive ? 128 : 133),
      w: 80, h: 80, src: `heroes/${this.hero.id}.png`
    })
    this.heroFrame = null
    this.metricWidget.setProperty(prop.VISIBLE, active)
    if (isMusafir) this.metricWidget.setProperty(prop.MORE, { y: px(heroActive ? 229 : 151), h: px(heroActive ? 30 : 66) })
    this.recordDot.setProperty(prop.VISIBLE, false)
    this.progressTrack.setProperty(prop.VISIBLE, active && !heroActive)
    this.progressFill.setProperty(prop.VISIBLE, active && !heroActive)
    this.bodyWidget.setProperty(prop.MORE, {
      y: px(home ? 222 : active ? heroActive ? 261 : 259 : 139),
      h: px(home ? 73 : active ? 63 : state.phase === 'review' || reportButton || stopApproval ? 111 : 151),
      text_size: px(active ? 19 : 20),
      align_h: reader ? align.LEFT : align.CENTER_H,
      align_v: reader ? align.TOP : align.CENTER_V
    })
    const review = state.phase === 'review'
    const navigationY = px(review || reportButton || stopApproval ? 254 : 302)
    this.previousButton.setProperty(prop.MORE, {
      x: px(72), y: navigationY, w: px(62), h: px(38), text: '‹'
    })
    this.nextButton.setProperty(prop.MORE, {
      x: this.width - px(134), y: navigationY, w: px(62), h: px(38), text: '›'
    })
    this.pageWidget.setProperty(prop.MORE, { y: navigationY, h: px(38) })
    this.editButton.setProperty(prop.VISIBLE, review)
    this.readerScroll.setProperty(prop.VISIBLE, false)
    if (review) {
      this.showReviewText(state.text)
      if (!state.error) this.stageWidget.setProperty(prop.TEXT, 'Листайте · нажмите строку для правки')
    } else {
      if (this.reviewScroll) {
        this.reviewScroll.setProperty(prop.VISIBLE, false)
        this.reviewSource = null
      }
      this.bodyWidget.setProperty(prop.VISIBLE, true)
      if (reader) {
        const source = String(body || '')
        if (source !== this.readerSource) {
          this.readerSource = source
          const rows = textRows(source, this.reviewTextWidth, this.reviewTextSize, getTextLayout)
          this.readerScroll.setProperty(prop.UPDATE_DATA, { data_array: rows, data_count: rows.length, on_page: 0 })
        }
        this.readerScroll.setProperty(prop.VISIBLE, true)
        this.bodyWidget.setProperty(prop.VISIBLE, false)
        this.hideNavigation()
      } else this.setBody(body, false)
    }
    this.setButtons(primary, secondary)
    if (active) this.animate()
    if (changed) console.log(`[${logName}] watch state: ${state.phase}`)
  },

  animate() {
    if (this.closed || !this.viewState) return
    const state = this.viewState
    const px = this.px
    const elapsed = Math.max(0, Date.now() - this.phaseStartedAt)
    const trackWidth = this.width - px(116)
    let fillWidth = px(54)
    let fillX = px(58) + Math.round((trackWidth - fillWidth) * ((elapsed % 1800) / 1800))
    let color = COLORS.gold
    let metric = clockText(Math.floor(elapsed / 1000))
    let repeat = true
    if (state.phase === 'recording') {
      const started = this.recording && this.recording.startedAt != null
      const seconds = started ? Math.min(300, Math.floor((Date.now() - this.recording.startedAt) / 1000)) : 0
      metric = `${clockText(seconds)} / 05:00`
      color = COLORS.red
      fillX = px(58)
      fillWidth = Math.round(trackWidth * seconds / 300)
      this.recordDot.setProperty(prop.VISIBLE, Boolean(started))
      this.recordDot.setProperty(prop.MORE, { color: Math.floor(elapsed / 600) % 2 ? 0x9b433b : COLORS.red })
      this.bodyWidget.setProperty(prop.TEXT, started
        ? `Микрофон включён\nОсталось ${clockText(300 - seconds)}` : 'Включаю микрофон…')
      if (started && Date.now() - this.displayRenewedAt >= DISPLAY_RENEW_MS) {
        try { setPageBrightTime({ brightTime: PAGE_BRIGHT_MS }) } catch (error) {}
        try { pauseDropWristScreenOff({ duration: PAGE_BRIGHT_MS }) } catch (error) {}
        this.displayRenewedAt = Date.now()
      }
    } else if (state.phase === 'uploading') {
      const fraction = state.totalBytes > 0 ? Math.max(0, Math.min(1, state.sentBytes / state.totalBytes)) : 0
      metric = `${Math.floor(fraction * 100)}%`
      fillX = px(58)
      fillWidth = Math.round(trackWidth * fraction)
      repeat = false
    }
    this.metricWidget.setProperty(prop.MORE, {
      text: metric, color, text_size: px(isMusafir && state.phase === 'job' ? 22 : state.phase === 'recording' ? 34 : 52)
    })
    this.progressFill.setProperty(prop.VISIBLE, fillWidth > 0 && !(isMusafir && state.phase === 'job'))
    this.progressFill.setProperty(prop.MORE, { x: fillX, w: Math.max(1, fillWidth), color })
    if (isMusafir && state.phase === 'job' && state.state === 'running') {
      const frames = [1, 1, 1, 0, 0, 1, 1, 2, 2, 1]
      const frame = frames[Math.floor(elapsed / 420) % frames.length]
      if (this.heroFrame !== frame) {
        this.heroFrame = frame
        this.brandWidget.setProperty(prop.MORE, {
          x: (this.width - 80) / 2, y: px(128), w: 80, h: 80,
          src: `heroes/${this.hero.id}-${frame}.png`
        })
      }
    }
    if (repeat) this.animationTimer = setTimeout(() => {
      this.animationTimer = null
      this.animate()
    }, UI_TICK_MS)
  },

  clearAnimation() {
    if (this.animationTimer !== null) clearTimeout(this.animationTimer)
    this.animationTimer = null
  },

  startRecording() {
    if (this.closed || this.recording) return
    if (isMusafir) {
      this.draftStorageKey = DRAFT_KEY + ':musafir:' + (this.destination.chatId || 'new')
    }
    if (!this.pendingAudio && this.resultStorage) {
      try {
        const pending = JSON.parse(this.resultStorage.getItem(PENDING_AUDIO_KEY) || 'null')
        if (pending && /^\d{1,16}-\d{1,8}$/.test(pending.id || '') && pending.destinationKey !== this.draftStorageKey) {
          this.foreignPendingAudio = true
          this.localRecordingError = true
          this.client.failLocal('На часах уже сохранена запись для другой задачи. Вернитесь к ней, чтобы не потерять запись.')
          return
        }
      } catch (error) { this.client.failLocal('Не удалось проверить сохранённый черновик'); return }
    }
    const id = this.client.createId()
    const fileName = `${logName}-${id}.opus`
    const previousState = this.client.getState()
    const previousPending = this.pendingAudio
    this.removeAudio(fileName)
    this.recording = { id, fileName, canceled: false, handled: false, uploadConsent: false }
    this.localRecordingError = false
    let stage = 'recorder_create'
    try {
      this.prepareRecorder()
      stage = 'recorder_format'
      if (this.recorder.setFormat(codec.OPUS, { target_file: `data://${fileName}` }) === false) {
        throw new Error('SET_FORMAT_FAILED')
      }
      stage = 'recorder_start'
      if (this.recorder.start() === false) throw new Error('START_FAILED')
      if (!this.client.beginRecording(id)) {
        try { this.recorder.stop() } catch (ignored) {}
        this.recording = null
        this.removeAudio(fileName)
        return
      }
      this.recording.startedAt = Date.now()
      this.savePendingAudio({ id, fileName, totalBytes: null, accepted: false, uploadConsent: false })
      this.clearAnimation()
      this.animate()
      this.recordTimer = setTimeout(() => this.stopRecording(true), RECORDING_LIMIT_MS)
    } catch (error) {
      this.reportRecorderError(stage, error)
      try { if (this.recorder) this.recorder.stop() } catch (ignored) {}
      this.recorder = null
      this.clearRecordTimer()
      this.recording = null
      this.removeAudio(fileName)
      if (this.pendingAudio && this.pendingAudio.id === id) {
        if (previousPending) this.savePendingAudio(previousPending)
        else this.clearPendingAudio()
      }
      const message = 'Не удалось начать запись. Этап: ' +
        ({ recorder_create: 'диктофон', recorder_format: 'формат', recorder_start: 'микрофон' })[stage]
      if (previousState.phase === 'review') {
        this.render(this.client.getState())
        this.stageWidget.setProperty(prop.TEXT, message)
      } else {
        this.localRecordingError = true
        this.client.failLocal(message.replace('. Этап:', '.\nЭтап:'))
      }
    }
  },

  stopRecording(automatic) {
    if (this.closed || !this.recording || this.recording.handled || this.recording.stopping) return
    this.clearRecordTimer()
    this.recording.stopping = true
    this.recording.uploadConsent = automatic !== true
    if (this.recording.uploadConsent && this.pendingAudio && this.pendingAudio.id === this.recording.id) {
      this.savePendingAudio({ ...this.pendingAudio, uploadConsent: true })
    }
    this.client.recordingStopped()
    try {
      if (this.recorder.stop() === false) throw new Error('STOP_FAILED')
      this.startStopWatchdog()
      if (automatic) console.log(`[${logName}] recording stopped at 5 minute limit`)
    } catch (error) {
      this.reportRecorderError('recorder_stop', error)
      this.localRecordingError = true
      this.client.failLocal('Не удалось остановить запись')
      this.removeAudio(this.recording.fileName)
      this.clearPendingAudio()
      this.recording = null
    }
  },

  cancelRecording() {
    if (!this.recording || this.recording.canceled) return
    const recording = this.recording
    const wasStopping = recording.stopping === true
    recording.canceled = true
    recording.stopping = true
    this.clearRecordTimer()
    this.clearStopWatchdog()
    this.closeAudio(false)
    this.clearPendingAudio()
    this.client.cancelAudio(recording.id)
    try {
      if (!wasStopping && this.recorder) this.recorder.stop()
    } catch (error) {
      this.reportRecorderError('recorder_stop', error)
    }
    this.removeAudio(recording.fileName)
    this.recording = null
  },

  onRecorderStopped() {
    if (this.closed || !this.recording || this.recording.handled) return
    const recording = this.recording
    recording.handled = true
    this.clearRecordTimer()
    this.clearStopWatchdog()

    if (recording.canceled || !recording.uploadConsent) {
      this.removeAudio(recording.fileName)
      this.clearPendingAudio()
      this.recording = null
      this.client.cancelAudio(recording.id)
      return
    }

    let fileStat
    try {
      fileStat = statSync({ path: recording.fileName })
    } catch (error) {
      fileStat = undefined
    }
    if (!fileStat || !Number.isInteger(fileStat.size) || fileStat.size <= 0) {
      this.removeAudio(recording.fileName)
      this.clearPendingAudio()
      this.recording = null
      this.localRecordingError = true
      this.reportRecorderError('recorder_file', 'EMPTY_RECORDING')
      this.client.failLocal('Часы не сохранили звук.\nПопробуйте записать ещё раз.')
      return
    }
    if (fileStat.size > MAX_AUDIO_BYTES) {
      this.removeAudio(recording.fileName)
      this.clearPendingAudio()
      this.recording = null
      this.localRecordingError = true
      this.reportRecorderError('recorder_file', 'RECORDING_TOO_LARGE')
      this.client.failLocal('Запись слишком большая')
      return
    }

    this.recording = null
    this.savePendingAudio({
      id: recording.id, fileName: recording.fileName,
      totalBytes: fileStat.size, accepted: false, uploadConsent: true
    })
    this.uploadPendingAudio()
  },

  readPendingAudio() {
    if (!this.resultStorage) return null
    try {
      const raw = this.resultStorage.getItem(PENDING_AUDIO_KEY)
      const value = raw && JSON.parse(raw)
      if (!value || !/^\d{1,16}-\d{1,8}$/.test(value.id) ||
          typeof value.fileName !== 'string' || typeof value.accepted !== 'boolean') return null
      if (value.destinationKey && value.destinationKey !== this.draftStorageKey) return null
      if (value.totalBytes !== null && (!Number.isInteger(value.totalBytes) ||
          value.totalBytes <= 0 || value.totalBytes > MAX_AUDIO_BYTES)) return null
      if (!value.accepted && value.uploadConsent !== true) {
        this.removeAudio(value.fileName)
        this.resultStorage.setItem(PENDING_AUDIO_KEY, '')
        if (isMusafir) this.clearMusafirPending()
        return null
      }
      return { ...value, uploadConsent: value.accepted || value.uploadConsent === true }
    } catch (error) {
      return null
    }
  },

  savePendingAudio(value) {
    this.pendingAudio = { ...value, destinationKey: this.draftStorageKey }
    try {
      if (this.resultStorage) this.resultStorage.setItem(PENDING_AUDIO_KEY, JSON.stringify(this.pendingAudio))
      if (isMusafir) this.saveMusafirPending()
    } catch (error) {}
  },

  clearPendingAudio() {
    this.pendingAudio = null
    try {
      if (this.resultStorage) this.resultStorage.setItem(PENDING_AUDIO_KEY, '')
      if (isMusafir) this.clearMusafirPending()
    } catch (error) {}
  },

  handlePendingAudio(state) {
    if (!this.pendingAudio) return
    // Keep the transcript checkpoint until the server accepts the command.
    // Otherwise sleeping on the text confirmation screen loses the draft.
    if (['job', 'approval', 'result'].includes(state.phase) && state.id === this.pendingAudio.id) {
      this.clearPendingAudio()
      return
    }
    if (!['ready', 'result'].includes(state.phase) || this.pendingResumeTimer !== null) return
    this.pendingResumeTimer = setTimeout(() => {
      this.pendingResumeTimer = null
      if (this.closed || !this.pendingAudio || !['ready', 'result'].includes(this.client.getState().phase)) return
      if (this.pendingAudio.accepted) this.client.resumeAudio(this.pendingAudio.id)
      else if (this.pendingAudio.uploadConsent === true) this.uploadPendingAudio()
      else this.cancelPendingAudio()
    }, 0)
  },

  uploadPendingAudio() {
    const pending = this.pendingAudio
    if (!pending || pending.accepted || pending.uploadConsent !== true || this.closed) return
    try {
      let totalBytes = pending.totalBytes
      if (totalBytes === null) {
        const fileStat = statSync({ path: pending.fileName })
        totalBytes = fileStat && fileStat.size
        if (!Number.isInteger(totalBytes) || totalBytes <= 0 || totalBytes > MAX_AUDIO_BYTES) {
          throw new Error('INVALID_PENDING_AUDIO')
        }
        this.savePendingAudio({ ...pending, totalBytes })
      }
      this.openAudio(pending.fileName, totalBytes)
      this.client.uploadAudio({
        id: pending.id,
        totalBytes,
        readChunk: (offset, length) => this.readAudioChunk(offset, length),
        onAccepted: id => {
          if (!this.pendingAudio || this.pendingAudio.id !== id) return
          const fileName = this.pendingAudio.fileName
          this.closeAudio(false)
          this.removeAudio(fileName)
          this.savePendingAudio({ id, fileName, totalBytes, accepted: true, uploadConsent: true })
        }
      })
    } catch (error) {
      this.closeAudio(false)
      this.localRecordingError = true
      this.reportRecorderError('recorder_open', error)
      this.client.failLocal('Запись сохранена, но её не удалось прочитать.\nПричина передана на Mac.')
    }
  },

  openAudio(fileName, totalBytes) {
    this.closeAudio(false)
    const fd = openSync({ path: fileName, flag: O_RDONLY })
    // Bip Max returns an opaque native object (typeof=object, String(fd)="71").
    // Validate its representation, but preserve the exact handle for native calls.
    const representation = String(fd)
    if (!/^\d+$/.test(representation) || Number(representation) > 9007199254740991) {
      throw new Error(`OPEN_FAILED type=${typeof fd} fd=${representation}`)
    }
    this.audioFd = fd
    this.audioFile = fileName
    this.audioSize = totalBytes
  },

  readAudioChunk(position, length) {
    if (this.audioFd == null || !Number.isInteger(position) ||
        !Number.isInteger(length) || length <= 0 || position < 0 ||
        position + length > this.audioSize) throw new Error('AUDIO_CLOSED')
    const buffer = new ArrayBuffer(length)
    let offset = 0
    while (offset < length) {
      const rawCount = readSync({
        fd: this.audioFd,
        buffer,
        options: { offset, length: length - offset, position: position + offset }
      })
      const count = rawCount === null || typeof rawCount === 'boolean' ? NaN : Number(rawCount)
      if (!Number.isFinite(count) || Math.floor(count) !== count || count <= 0 || count > length - offset) {
        throw new Error(`SHORT_READ expected=${length - offset} type=${typeof rawCount} actual=${String(rawCount)}`)
      }
      offset += count
    }
    return Array.from(new Uint8Array(buffer))
  },

  cancelPendingAudio() {
    const pending = this.pendingAudio
    const fileName = pending && pending.fileName
    this.closeAudio(false)
    this.removeAudio(fileName)
    this.clearPendingAudio()
    this.localRecordingError = false
    const canceled = this.client && pending && this.client.cancelAudio(pending.id)
    if (!canceled && this.client) this.client.home()
  },

  clearRecordTimer() {
    if (this.recordTimer !== null) clearTimeout(this.recordTimer)
    this.recordTimer = null
  },

  startStopWatchdog() {
    this.clearStopWatchdog()
    const recording = this.recording
    let attempts = 0
    let lastSize = 0
    let stable = 0
    const poll = () => {
      this.stopWatchdog = null
      if (this.closed || this.recording !== recording || recording.handled) return
      if (recording.canceled) { this.onRecorderStopped(); return }
      let size = 0
      try { size = statSync({ path: recording.fileName }).size } catch (ignored) {}
      stable = size > 0 && size === lastSize ? stable + 1 : 0
      lastSize = size
      attempts += 1
      if (stable >= 2) { this.onRecorderStopped(); return }
      if (attempts >= FILE_POLL_LIMIT) {
        this.recording = null
        this.removeAudio(recording.fileName)
        this.clearPendingAudio()
        this.localRecordingError = true
        this.reportRecorderError('recorder_file', size > 0 ? 'FILE_NOT_STABLE' : 'EMPTY_RECORDING')
        this.client.failLocal('Часы не сохранили запись.\nНажмите «Повторить».')
        return
      }
      this.stopWatchdog = setTimeout(poll, FILE_POLL_MS)
    }
    this.stopWatchdog = setTimeout(poll, FILE_POLL_MS)
  },

  clearStopWatchdog() {
    if (this.stopWatchdog !== null) clearTimeout(this.stopWatchdog)
    this.stopWatchdog = null
  },

  closeAudio(removeFile = false) {
    const fileName = this.audioFile
    const fd = this.audioFd
    this.audioFd = null
    this.audioFile = null
    this.audioSize = 0
    if (fd != null) {
      try { closeSync({ fd }) } catch (error) {}
    }
    if (removeFile && fileName) this.removeAudio(fileName)
  },

  removeAudio(fileName) {
    if (!fileName) return
    try { rmSync({ path: fileName }) } catch (error) {}
  },

  onDestroy() {
    setStatusBarVisible(true)
    try { if (isMusafir && this.client && this.resultStorage) {
      const state = this.client.getState()
      if (state.jobId && ['job', 'approval', 'result', 'unknown', 'sending'].includes(state.phase)) {
        this.destination.jobId = state.jobId
        this.destination.openJob = true
        this.destination.autoRecord = false
        this.resultStorage.setItem(MUSAFIR_CONTEXT_KEY, JSON.stringify(this.destination))
      }
    } } catch (error) {}
    if (!isMusafir) { try { this.persistAgentExit() } catch (error) {} }
    this.unregisterInteraction()
    if (this.recording && (!this.recording.stopping || this.recording.canceled ||
        this.recording.uploadConsent !== true)) {
      const recording = this.recording
      recording.canceled = true
      this.clearPendingAudio()
      try { if (this.recorder) this.recorder.stop() } catch (error) {}
      this.removeAudio(recording.fileName)
      if (this.client) this.client.cancelAudio(recording.id)
      this.recording = null
    }
    this.closed = true
    if (this.cancelControl) this.cancelControl()
    this.closeKeyboard()
    // Zepp also destroys the page on sleep. Keep wake-up relaunch enabled:
    // the next build recovers the same accepted job without resending it.
    try { resetPageBrightTime() } catch (error) {}
    try { resetDropWristScreenOff() } catch (error) {}
    this.clearAnimation()
    this.clearRecordTimer()
    this.clearStopWatchdog()
    if (this.pendingResumeTimer !== null) clearTimeout(this.pendingResumeTimer)
    this.pendingResumeTimer = null
    if (this.stopTimer !== null) clearTimeout(this.stopTimer)
    this.stopTimer = null
    if (this.alerts) this.alerts.destroy()
    if (this.client) this.client.close()
    if (this.recording) {
      // A prior explicit "Распознать" is resumable after sleep/page teardown.
      try { this.recorder.stop() } catch (error) {}
      this.recording = null
    }
    this.closeAudio(false)
  }
  }
}
