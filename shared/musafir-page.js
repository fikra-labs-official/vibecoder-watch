import { createWidget, widget, align, text_style, prop, event, setStatusBarVisible } from '@zos/ui'
import { getDeviceInfo } from '@zos/device'
import { replace } from '@zos/router'
import { LocalStorage } from '@zos/storage'
import { setTimeout, clearTimeout } from '@zos/timer'
import {
  onGesture, offGesture, GESTURE_RIGHT,
  onKey, offKey, KEY_BACK, KEY_EVENT_CLICK
} from '@zos/interaction'
import { MUSAFIR_HEROES, heroById } from './musafir-chat'

const CONTEXT_KEY = 'musafir-context'
const RETURN_KEY = 'musafir-return-view'
const PENDING_KEY = 'musafir-pending-context'
const PENDING_AUDIO_KEY = 'pending-audio'
const DRAFT_PREFIX = 'voice-draft:musafir:'
const HERO_KEY = 'musafir-hero'
const COLOR = {
  bg: 0x080b0f,
  surface: 0x171d25,
  gold: 0xf0be75,
  white: 0xf3f6fa,
  muted: 0xa8b3c3,
  cyan: 0x67ddf2,
  pressed: 0x26313e
}
const ACTIVE_LABEL = {
  submitting: 'Отправляю',
  queued: 'В очереди',
  running: 'В работе',
  approval: 'Нужно решение',
  unknown: 'Проверяю',
  stopping: 'Останавливаю'
}
const LOCAL_ID = /^\d{1,16}-\d{1,8}$/
const JOB_STATES = new Set([
  'submitting', 'queued', 'running', 'stopping', 'approval',
  'completed', 'cancelled', 'error', 'unknown'
])
const ACTIVE_STATES = new Set(['submitting', 'queued', 'running', 'stopping', 'approval', 'unknown'])
const OUTER_TIMEOUT = 18000

const clip = (value, limit) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, limit)
const modeOf = value => value === 'research' ? 'research' : 'task'
const validChatId = value => value === 'legacy' || typeof value === 'string' && LOCAL_ID.test(value)
const validJobId = value => typeof value === 'string' && LOCAL_ID.test(value)
const validOffset = value => value === null || Number.isSafeInteger(value) && value >= 0

function validLatestJob(job) {
  return job === null || Boolean(job && validJobId(job.id) && JOB_STATES.has(job.state) &&
    typeof job.summary === 'string' && (job.mode === 'task' || job.mode === 'research'))
}

function validChat(chat) {
  return Boolean(chat && validChatId(chat.id) && typeof chat.title === 'string' &&
    Number.isFinite(chat.updated) && typeof chat.archived === 'boolean' && validLatestJob(chat.latestJob))
}

function validActiveJob(job) {
  return job === null || Boolean(job && validJobId(job.id) && validChatId(job.chatId) &&
    ACTIVE_STATES.has(job.state) && (job.mode == null || job.mode === 'task' || job.mode === 'research'))
}

function checkedChatList(reply, limit) {
  if (!Array.isArray(reply.chats) || !reply.chats.every(validChat) ||
      reply.chats.length > limit || !validOffset(reply.nextOffset) || !validActiveJob(reply.activeJob)) {
    throw new Error('Некорректный список чатов')
  }
  const ids = reply.chats.map(chat => chat.id)
  if (new Set(ids).size !== ids.length) throw new Error('Некорректный список чатов')
  return reply
}

function validDetailJob(job, chatId) {
  return Boolean(job && job.ok === true && validJobId(job.id) && job.chatId === chatId &&
    JOB_STATES.has(job.state) && typeof job.text === 'string' && typeof job.summary === 'string' &&
    (job.mode === 'task' || job.mode === 'research'))
}

function checkedChatDetail(reply, expectedId, offset) {
  const chat = reply.chat
  if (!chat || chat.id !== expectedId || !validChatId(chat.id) || typeof chat.title !== 'string' ||
      typeof chat.archived !== 'boolean' || !Array.isArray(reply.jobs) ||
      reply.jobs.length > 2 || !reply.jobs.every(job => validDetailJob(job, chat.id)) ||
      !validOffset(reply.nextOffset) ||
      (reply.nextOffset !== null && (reply.jobs.length !== 2 || reply.nextOffset !== offset + 2))) {
    throw new Error('Некорректный чат')
  }
  const ids = reply.jobs.map(job => job.id)
  if (new Set(ids).size !== ids.length) throw new Error('Некорректный чат')
  return reply
}

function validPendingContext(value) {
  return Boolean(value && value.target === 'musafir' &&
    (value.chatId === null || validChatId(value.chatId)) &&
    (value.mode === 'task' || value.mode === 'research') &&
    (value.jobId === null || validJobId(value.jobId)) &&
    typeof value.openJob === 'boolean' && typeof value.autoRecord === 'boolean')
}

function normalizeOrigin(value) {
  if (value && value.kind === 'list' && typeof value.archived === 'boolean' &&
      Number.isSafeInteger(value.offset) && value.offset >= 0) {
    return { kind: 'list', archived: value.archived, offset: value.offset }
  }
  return { kind: 'home' }
}

function normalizeReturnView(value) {
  if (!value || typeof value !== 'object') return null
  if (value.kind === 'home') return { kind: 'home' }
  if (value.kind === 'list') return normalizeOrigin(value)
  if (value.kind !== 'detail' || !value.chat || !validChatId(value.chat.id) ||
      typeof value.chat.title !== 'string' || typeof value.chat.archived !== 'boolean' ||
      !Number.isSafeInteger(value.offset) || value.offset < 0) return null
  return {
    kind: 'detail',
    chat: {
      id: value.chat.id,
      title: clip(value.chat.title, 80),
      archived: value.chat.archived,
      mode: modeOf(value.chat.mode)
    },
    offset: value.offset,
    origin: normalizeOrigin(value.origin)
  }
}

function voiceContext(value) {
  const context = {
    target: 'musafir',
    chatId: value && validChatId(value.chatId) ? value.chatId : null,
    mode: modeOf(value && value.mode),
    jobId: value && validJobId(value.jobId) ? value.jobId : null,
    openJob: Boolean(value && validJobId(value.jobId) && value.openJob === true),
    autoRecord: false
  }
  if (value && value.pendingSend === true && context.jobId) context.pendingSend = true
  return context
}

export function createMusafirPage() {
  return {
    build() {
      setStatusBarVisible(false)
      const { width, height } = getDeviceInfo()
      this.width = width
      this.height = height
      this.scale = Math.min(width / 432, height / 514)
      this.px = value => Math.round(value * this.scale)
      this.margin = Math.max(18, Math.round(width * 0.055))
      this.controlHeight = height >= 490 ? 52 : 48
      this.gap = 6
      this.bottom = height >= 490 ? 16 : 14
      this.closed = false
      this.generation = 0
      this.pendingRequests = []
      this.currentBack = null
      this.currentLocation = { kind: 'home' }
      this.storage = null
      try { this.storage = new LocalStorage() } catch (error) {}
      this.migrateLegacyDraft()

      createWidget(widget.FILL_RECT, { x: 0, y: 0, w: width, h: height, color: COLOR.bg })
      this.heroButton = createWidget(widget.BUTTON, {
        x: this.margin + 60, y: 18, w: width - this.margin * 2 - 60, h: 56, radius: 16,
        normal_color: COLOR.surface, press_color: COLOR.pressed, color: COLOR.white,
        text_size: Math.max(17, this.px(19)), text: '', click_func: () => this.heroPicker()
      })
      this.heroImage = createWidget(widget.IMG, {
        x: this.margin + 8, y: 24, w: 44, h: 44, src: 'heroes/musafir-small.png'
      })
      this.heroImage.addEventListener(event.CLICK_UP, () => this.heroPicker())
      this.topBack = createWidget(widget.BUTTON, {
        x: this.margin, y: 14, w: 116, h: 48, radius: 13,
        normal_color: COLOR.surface, press_color: COLOR.pressed, color: COLOR.white,
        text_size: 18, text: '‹ Назад', click_func: () => this.goBack()
      })
      this.heading = createWidget(widget.TEXT, {
        x: this.margin, y: 78, w: width - this.margin * 2, h: 28, text_size: Math.max(21, this.px(24)),
        color: COLOR.gold, align_h: align.LEFT, text: ''
      })
      this.note = createWidget(widget.TEXT, {
        x: this.margin, y: 106, w: width - this.margin * 2, h: 28, text_size: Math.max(15, this.px(17)),
        color: COLOR.muted, align_h: align.LEFT, text_style: text_style.WRAP, text: ''
      })
      this.heroHint = createWidget(widget.TEXT, {
        x: this.margin, y: 124, w: width - this.margin * 2, h: 22, text_size: 14,
        color: COLOR.muted, align_h: align.LEFT, text: '5 героев · листайте вверх'
      })
      const createHiddenButton = () => {
        const item = createWidget(widget.BUTTON, {
          x: this.margin, y: 136, w: width - this.margin * 2, h: this.controlHeight, radius: 13,
          normal_color: COLOR.surface, press_color: COLOR.pressed, color: COLOR.white,
          text_size: Math.max(16, this.px(18)), text: '', click_func: () => item.clickAction && item.clickAction()
        })
        item.setProperty(prop.VISIBLE, false)
        return item
      }
      this.banners = [0, 1].map(createHiddenButton)
      this.rows = [0, 1, 2].map(createHiddenButton)
      this.footer = [0, 1, 2].map(createHiddenButton)
      this.primary = createHiddenButton()

      const listY = 148
      const listWidth = width - this.margin * 2
      const listData = this.heroData()
      this.heroScroll = createWidget(widget.SCROLL_LIST, {
        x: this.margin,
        y: listY,
        w: listWidth,
        h: Math.max(112, height - listY - this.bottom),
        item_space: 6,
        item_config: [{
          type_id: 1,
          item_height: 112,
          item_bg_color: COLOR.surface,
          item_bg_radius: 14,
          text_view: [
            { x: 0, y: 0, w: listWidth, h: 112, key: 'tap', color: COLOR.surface, text_size: 1, action: true },
            { x: 100, y: 12, w: listWidth - 100, h: 48, key: 'name', color: COLOR.white, text_size: 20, action: true },
            { x: 100, y: 58, w: listWidth - 100, h: 42, key: 'meaning', color: COLOR.muted, text_size: 16, action: true }
          ],
          text_view_count: 3,
          image_view: [{ x: 0, y: 8, w: 96, h: 96, key: 'image', action: true }],
          image_view_count: 1
        }],
        item_config_count: 1,
        data_array: listData,
        data_count: listData.length,
        snap_to_center: false,
        item_click_func: (_list, index) => this.chooseHero(index)
      })
      this.heroScroll.setProperty(prop.VISIBLE, false)

      this.gestureCallback = gesture => gesture === GESTURE_RIGHT ? this.goBack() : false
      this.keyCallback = (key, keyEvent) => key === KEY_BACK && keyEvent === KEY_EVENT_CLICK
        ? this.goBack() : false
      onGesture({ callback: this.gestureCallback })
      onKey({ callback: this.keyCallback })

      this.refreshHero()
      const returnView = this.consumeReturnView()
      if (returnView) this.restoreLocation(returnView)
      else this.home()
    },

    read(key) {
      if (!this.storage) return null
      try { return this.storage.getItem(key) } catch (error) { return null }
    },

    write(key, value) {
      if (!this.storage) return false
      try { this.storage.setItem(key, value); return true } catch (error) { return false }
    },

    consumeReturnView() {
      const raw = this.read(RETURN_KEY)
      if (raw) this.write(RETURN_KEY, '')
      try { return normalizeReturnView(JSON.parse(raw || 'null')) } catch (error) { return null }
    },

    rememberReturnView() {
      const value = normalizeReturnView(this.currentLocation) || { kind: 'home' }
      return this.write(RETURN_KEY, JSON.stringify(value))
    },

    restoreLocation(location) {
      const value = normalizeReturnView(location)
      if (!value || value.kind === 'home') return this.home()
      if (value.kind === 'list') return this.chats(value.archived, value.offset)
      this.chatDetail({
        id: value.chat.id,
        title: value.chat.title,
        archived: value.chat.archived,
        mode: value.chat.mode,
        latestJob: null
      }, value.offset, value.origin)
    },

    migrateLegacyDraft() {
      if (this.read(PENDING_KEY)) return
      try {
        const raw = this.read(PENDING_AUDIO_KEY)
        const audio = JSON.parse(raw || 'null')
        if (!audio || !validJobId(audio.id) || (audio.destinationKey && audio.destinationKey !== 'voice-draft')) return
        const draftKey = DRAFT_PREFIX + 'legacy'
        const draft = this.read('voice-draft')
        if (draft && !this.read(draftKey)) this.write(draftKey, draft)
        this.write(PENDING_AUDIO_KEY, JSON.stringify({ ...audio, destinationKey: draftKey }))
        this.write(PENDING_KEY, JSON.stringify({ target: 'musafir', chatId: 'legacy', mode: 'task',
          jobId: null, openJob: false, autoRecord: false }))
      } catch (error) {}
    },

    updateButton(button, visible, rectangle, text) {
      button.setProperty(prop.MORE, {
        x: rectangle.x, y: rectangle.y, w: rectangle.w, h: rectangle.h, text: text || ''
      })
      button.setProperty(prop.VISIBLE, Boolean(visible))
    },

    headerRectangle() {
      return { x: this.margin + 60, y: 18, w: this.width - this.margin * 2 - 60, h: 56 }
    },

    refreshHero() {
      const hero = heroById(this.read(HERO_KEY))
      this.hero = hero
      if (!this.heroButton) return
      this.updateButton(this.heroButton, this.heroButtonVisible !== false, this.headerRectangle(),
        `${hero.name} · ${hero.meaning}`)
      this.heroImage.setProperty(prop.MORE, {
        x: this.margin + 8, y: 24, w: 44, h: 44, src: `heroes/${hero.id}-small.png`
      })
    },

    heroData() {
      const selected = heroById(this.read(HERO_KEY)).id
      return MUSAFIR_HEROES.map(hero => ({
        tap: ' ',
        name: `${hero.id === selected ? '✓ ' : ''}${hero.name}`,
        meaning: hero.meaning,
        image: `heroes/${hero.id}-picker.png`
      }))
    },

    layout(view) {
      const hasPrimary = Boolean(view.primary)
      const footerCount = (view.footer || []).filter(Boolean).length
      const primaryY = this.height - this.bottom - this.controlHeight
      const footerY = (hasPrimary ? primaryY - this.gap : this.height - this.bottom) -
        (footerCount ? this.controlHeight : 0)
      return {
        contentY: view.home ? 146 : 136,
        primaryY,
        footerY,
        contentBottom: (footerCount ? footerY : hasPrimary ? primaryY : this.height - this.bottom) - this.gap
      }
    },

    display(view, generation, remember = true) {
      if (this.closed) return
      if (generation == null) ++this.generation
      else if (generation !== this.generation) return
      if (remember) this.currentView = () => this.display(view)
      this.currentBack = typeof view.back === 'function' ? view.back : null
      this.heroPickerActive = view.heroPicker === true

      const homeHeader = view.home === true
      this.heroButtonVisible = homeHeader
      this.updateButton(this.heroButton, homeHeader, this.headerRectangle(), `${this.hero.name} · ${this.hero.meaning}`)
      this.heroImage.setProperty(prop.VISIBLE, homeHeader)
      this.updateButton(this.topBack, Boolean(this.currentBack),
        { x: this.margin, y: 14, w: 116, h: 48 }, '‹ Назад')

      const headingY = homeHeader ? 78 : 68
      this.heading.setProperty(prop.MORE, {
        x: this.margin, y: headingY, w: this.width - this.margin * 2, h: 28, text: view.title || ''
      })
      this.note.setProperty(prop.MORE, {
        x: this.margin, y: headingY + 28, w: this.width - this.margin * 2,
        h: view.heroPicker ? 24 : 36, text: view.note || ''
      })
      this.heroHint.setProperty(prop.VISIBLE, this.heroPickerActive)
      this.heroScroll.setProperty(prop.VISIBLE, this.heroPickerActive)
      if (this.heroPickerActive) {
        this.heroScroll.setProperty(prop.UPDATE_DATA, {
          data_array: this.heroData(), data_count: MUSAFIR_HEROES.length, on_page: 0
        })
      }

      this.bannerItems = []
      this.items = []
      this.footerItems = []
      this.primaryItem = null
      const hiddenRect = { x: this.margin, y: 136, w: this.width - this.margin * 2, h: this.controlHeight }
      if (this.heroPickerActive) {
        this.banners.forEach(button => this.updateButton(button, false, hiddenRect, ''))
        this.rows.forEach(button => this.updateButton(button, false, hiddenRect, ''))
        this.footer.forEach(button => this.updateButton(button, false, hiddenRect, ''))
        this.updateButton(this.primary, false, hiddenRect, '')
        return
      }

      const layout = this.layout(view)
      const capacity = Math.max(0, Math.floor((layout.contentBottom - layout.contentY + this.gap) /
        (this.controlHeight + this.gap)))
      this.bannerItems = (view.banners || []).slice(0, Math.min(2, capacity))
      this.items = (view.items || []).slice(0, Math.min(3, capacity - this.bannerItems.length))
      this.footerItems = (view.footer || []).filter(Boolean).slice(0, 3)
      this.primaryItem = view.primary || null

      let y = layout.contentY
      this.banners.forEach((button, index) => {
        const item = this.bannerItems[index]
        this.updateButton(button, Boolean(item),
          { x: this.margin, y, w: this.width - this.margin * 2, h: this.controlHeight },
          item && item.label)
        if (item) y += this.controlHeight + this.gap
        button.clickAction = () => this.bannerItems[index] && this.bannerItems[index].action()
      })
      this.rows.forEach((button, index) => {
        const item = this.items[index]
        this.updateButton(button, Boolean(item), {
          x: this.margin,
          y: y + index * (this.controlHeight + this.gap),
          w: this.width - this.margin * 2,
          h: this.controlHeight
        }, item && item.label)
        button.clickAction = () => this.items[index] && this.items[index].action()
      })

      const footerCount = this.footerItems.length
      const usable = this.width - this.margin * 2 - this.gap * Math.max(0, footerCount - 1)
      const footerWidth = footerCount ? Math.floor(usable / footerCount) : usable
      this.footer.forEach((button, index) => {
        const item = this.footerItems[index]
        const x = this.margin + index * (footerWidth + this.gap)
        const w = index === footerCount - 1 ? this.width - this.margin - x : footerWidth
        this.updateButton(button, Boolean(item),
          { x, y: layout.footerY, w: Math.max(1, w), h: this.controlHeight }, item && item.label)
        button.clickAction = () => this.footerItems[index] && this.footerItems[index].action()
      })
      this.updateButton(this.primary, Boolean(this.primaryItem),
        { x: this.margin, y: layout.primaryY, w: this.width - this.margin * 2, h: this.controlHeight },
        this.primaryItem && this.primaryItem.label)
      this.primary.clickAction = () => this.primaryItem && this.primaryItem.action()
    },

    goBack() {
      const action = this.currentBack
      if (!action) return false
      this.currentBack = null
      action()
      return true
    },

    cancelRequests() {
      const pending = this.pendingRequests.splice(0)
      pending.forEach(entry => entry.finish(undefined, false))
    },

    boundedRequest(payload) {
      return new Promise((resolve, reject) => {
        const entry = { timer: null, settled: false, finish: null }
        entry.finish = (value, failed) => {
          if (entry.settled) return
          entry.settled = true
          if (entry.timer != null) clearTimeout(entry.timer)
          const index = this.pendingRequests.indexOf(entry)
          if (index >= 0) this.pendingRequests.splice(index, 1)
          if (failed) reject(value)
          else resolve(value)
        }
        this.pendingRequests.push(entry)
        entry.timer = setTimeout(() => entry.finish(new Error('Mac не ответил вовремя'), true), OUTER_TIMEOUT)
        Promise.resolve().then(() => entry.settled ? undefined : this.request(payload, { timeout: 15000 })).then(
          reply => entry.finish(reply, false), error => entry.finish(error, true))
      })
    },

    async load(method, params, done, back, title = 'Мусафир', home = false) {
      this.cancelRequests()
      const generation = ++this.generation
      this.display({
        home,
        back,
        title,
        note: 'Получаю данные с Mac…',
        primary: home ? { label: 'Новая задача', action: () => this.newChat('task') } : null
      }, generation)
      this.currentView = () => this.load(method, params, done, back, title, home)
      try {
        const reply = await this.boundedRequest({ method, params })
        if (this.closed || generation !== this.generation) return
        if (!reply || reply.ok !== true) throw new Error(reply && reply.error || 'Нет ответа Musafir')
        done(reply, generation)
      } catch (error) {
        if (this.closed || generation !== this.generation) return
        this.display({
          home,
          back,
          title: 'Не удалось',
          note: clip(error && error.message || error, 80),
          items: [{ label: 'Повторить', action: () => this.load(method, params, done, back, title, home) }],
          primary: { label: 'Новая задача', action: () => this.newChat('task') }
        }, generation)
      }
    },

    home() {
      this.currentLocation = { kind: 'home' }
      this.load('CHAT_LIST', { offset: 0, limit: 10, archived: false },
        (reply, generation) => this.homeReply(reply, generation), null, 'Мусафир', true)
    },

    homeReply(reply, generation) {
      checkedChatList(reply, 10)
      const chats = reply.chats
      const banners = []
      let pending = null
      try { pending = JSON.parse(this.read(PENDING_KEY) || 'null') } catch (error) {}
      if (validPendingContext(pending)) {
        banners.push({
          label: pending.pendingSend ? 'Проверить отправку' : 'Черновик · продолжить',
          action: () => this.openContext(pending)
        })
      }
      const active = reply.activeJob
      if (active) {
        const matching = chats.find(chat => chat.id === active.chatId)
        const latest = matching && matching.latestJob && matching.latestJob.id === active.id
          ? matching.latestJob : null
        banners.push({
          label: `${ACTIVE_LABEL[active.state] || 'Активно'} · ${clip(matching && matching.title || 'задача', 28)}`,
          action: () => this.openContext({
            target: 'musafir', chatId: active.chatId,
            mode: modeOf(active.mode || latest && latest.mode), jobId: active.id,
            openJob: true, autoRecord: false
          })
        })
      }
      this.display({
        home: true,
        title: 'Последние чаты',
        note: chats.length ? 'Продолжи тему или начни новую' : 'Здесь появятся твои задачи',
        banners,
        items: chats.slice(0, 2).map(chat => ({
          label: this.chatLabel(chat),
          action: () => this.chatDetail(chat, 0, { kind: 'home' })
        })),
        footer: [
          { label: 'Все чаты', action: () => this.chats(false, 0) },
          { label: 'Исследование', action: () => this.newChat('research') }
        ],
        primary: { label: 'Новая задача', action: () => this.newChat('task') }
      }, generation)
    },

    chatLabel(chat) {
      const title = clip(chat.title, 34) || 'Без названия'
      const summary = chat.latestJob && clip(chat.latestJob.summary, 28)
      return summary ? `${title} · ${summary}` : title
    },

    chats(archived = false, offset = 0) {
      const location = { kind: 'list', archived: Boolean(archived), offset: Math.max(0, offset) }
      this.currentLocation = location
      this.load('CHAT_LIST', { offset: location.offset, limit: 3, archived: location.archived },
        (reply, generation) => {
          checkedChatList(reply, 3)
          const chats = reply.chats.slice(0, 3)
          this.display({
            back: () => this.home(),
            title: location.archived ? 'Архив' : 'Все чаты',
            note: chats.length ? 'По три чата на странице' : location.archived ? 'Архив пуст' : 'Чатов пока нет',
            items: chats.map(chat => ({
              label: this.chatLabel(chat),
              action: () => this.chatDetail(chat, 0, location)
            })),
            footer: [
              { label: location.archived ? 'Активные' : 'Архив', action: () => this.chats(!location.archived, 0) },
              location.offset > 0
                ? { label: 'Раньше', action: () => this.chats(location.archived, Math.max(0, location.offset - 3)) }
                : null,
              reply.nextOffset == null
                ? null
                : { label: 'Дальше', action: () => this.chats(location.archived, reply.nextOffset) }
            ]
          }, generation)
        }, () => this.home(), location.archived ? 'Архив' : 'Все чаты')
    },

    chatDetail(chat, offset = 0, origin = { kind: 'home' }) {
      if (!chat || !validChatId(chat.id)) return this.home()
      const safeOrigin = normalizeOrigin(origin)
      const safeOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0
      this.currentLocation = {
        kind: 'detail',
        chat: {
          id: chat.id,
          title: clip(chat.title, 80),
          archived: Boolean(chat.archived),
          mode: modeOf(chat.mode || chat.latestJob && chat.latestJob.mode)
        },
        offset: safeOffset,
        origin: safeOrigin
      }
      this.load('CHAT_DETAIL', { chatId: chat.id, offset: safeOffset, limit: 2 },
        (reply, generation) => this.detailReply(
          checkedChatDetail(reply, chat.id, safeOffset), chat, safeOffset, safeOrigin, generation),
        () => this.restoreLocation(safeOrigin), clip(chat.title, 30) || 'Чат')
    },

    detailReply(reply, fallback, offset, origin, generation) {
      const chat = reply.chat
      const jobs = reply.jobs
      const latestMode = modeOf(offset === 0 && jobs[0] && jobs[0].mode ||
        fallback.mode || fallback.latestJob && fallback.latestJob.mode)
      const chatForPaging = { ...fallback, ...chat, mode: latestMode, latestJob: fallback.latestJob || null }
      this.currentLocation = {
        kind: 'detail',
        chat: { id: chat.id, title: clip(chat.title, 80), archived: chat.archived, mode: latestMode },
        offset,
        origin: normalizeOrigin(origin)
      }
      const jobItems = jobs.map(job => ({
        label: clip(job.summary || job.text || job.state, 42) || 'Открыть ответ',
        action: () => this.openContext({
          target: 'musafir', chatId: chat.id, mode: modeOf(job.mode), jobId: job.id,
          openJob: true, autoRecord: false
        })
      }))
      if (reply.nextOffset !== null) jobItems.push({
        label: 'Более ранние ответы',
        action: () => this.chatDetail(chatForPaging, reply.nextOffset, origin)
      })
      this.display({
        back: () => this.restoreLocation(origin),
        title: clip(chat.title, 34) || 'Чат',
        note: jobs.length ? offset ? `Ответы ${offset + 1}–${offset + jobs.length}` : 'Последние ответы'
          : 'В этом чате пока нет ответов',
        items: jobItems,
        footer: [
          {
            label: chat.archived ? 'Восстановить' : 'Архивировать',
            action: () => this.archiveConfirm(chatForPaging, offset, origin)
          },
          offset > 0
            ? { label: 'Новее', action: () => this.chatDetail(chatForPaging, Math.max(0, offset - 2), origin) }
            : null
        ],
        primary: chat.archived ? null : {
          label: 'Продолжить',
          action: () => this.openCompose({
            target: 'musafir', chatId: chat.id, mode: latestMode, jobId: null,
            openJob: false, autoRecord: false
          })
        }
      }, generation)
    },

    archiveConfirm(chat, offset = 0, origin = { kind: 'home' }) {
      if (chat.archived) {
        this.setArchived(chat, false, offset, origin)
        return
      }
      this.display({
        back: () => this.chatDetail(chat, offset, origin),
        title: clip(chat.title, 34) || 'Чат',
        note: 'Чат можно будет восстановить из архива',
        items: [{ label: 'Архивировать', action: () => this.setArchived(chat, true, offset, origin) }]
      })
    },

    setArchived(chat, archived, offset = 0, origin = { kind: 'home' }) {
      this.load('CHAT_ARCHIVE', { chatId: chat.id, archived }, reply => {
        if (reply.chatId !== chat.id || reply.archived !== archived) throw new Error('Некорректный ответ архива')
        this.chatDetail({ ...chat, archived }, offset, origin)
      }, () => this.chatDetail(chat, offset, origin), archived ? 'Архивирую' : 'Восстанавливаю')
    },

    newChat(mode) {
      this.openCompose({
        target: 'musafir', chatId: null, mode: modeOf(mode), jobId: null,
        openJob: false, autoRecord: false
      })
    },

    openCompose(context) {
      const raw = this.read(PENDING_KEY)
      let pending = null
      try { pending = JSON.parse(raw || 'null') } catch (error) {}
      if (!validPendingContext(pending)) return this.openContext(context)
      const back = this.currentView || (() => this.home())
      const uncertain = pending.pendingSend === true
      this.display({
        back,
        title: uncertain ? 'Проверим отправку' : 'Есть черновик',
        note: uncertain ? 'Задание могло быть принято. Открой его статус.' : 'Продолжи его или явно начни новую задачу',
        items: [
          {
            label: uncertain ? 'Открыть задание' : 'Продолжить черновик',
            action: () => this.openContext({ ...pending, autoRecord: false })
          },
          ...(uncertain ? [] : [{
            label: 'Начать заново',
            action: () => this.discardPendingAndStart(context, raw, pending)
          }])
        ]
      })
    },

    openContext(context) {
      const value = voiceContext(context)
      const back = this.currentView || (() => this.home())
      if (!this.write(CONTEXT_KEY, JSON.stringify(value))) {
        this.display({
          back,
          title: 'Не удалось сохранить',
          note: 'Чат не открыт. Проверьте свободное место на часах.'
        })
        return
      }
      this.rememberReturnView()
      replace({ url: 'page/voice' })
    },

    discardPendingAndStart(context, raw, pending) {
      if (this.read(PENDING_KEY) !== raw) {
        this.home()
        return
      }
      const draftKey = DRAFT_PREFIX + (pending.chatId || 'new')
      this.write(PENDING_KEY, '')
      this.write(draftKey, '')
      try {
        const audio = JSON.parse(this.read(PENDING_AUDIO_KEY) || 'null')
        if (audio && audio.destinationKey === draftKey) this.write(PENDING_AUDIO_KEY, '')
      } catch (error) {}
      this.openContext(context)
    },

    heroPicker(returnView) {
      this.cancelRequests()
      const back = returnView || this.currentView || (() => this.home())
      this.heroReturnView = back
      this.display({
        back,
        heroPicker: true,
        title: 'Выбери героя',
        note: 'Только внешний вид'
      }, null, false)
    },

    chooseHero(index) {
      if (!this.heroPickerActive || !Number.isInteger(index) || !MUSAFIR_HEROES[index]) return
      const hero = MUSAFIR_HEROES[index]
      if (!this.write(HERO_KEY, hero.id)) {
        this.note.setProperty(prop.TEXT, 'Не удалось сохранить выбор')
        return
      }
      this.refreshHero()
      const back = this.heroReturnView || (() => this.home())
      this.heroPickerActive = false
      back()
    },

    onDestroy() {
      setStatusBarVisible(true)
      this.closed = true
      ++this.generation
      this.cancelRequests()
      offGesture()
      offKey()
    }
  }
}
