import { createWidget, widget, align, text_style, prop, event, setStatusBarVisible } from '@zos/ui'
import { getDeviceInfo } from '@zos/device'
import { replace } from '@zos/router'
import { LocalStorage } from '@zos/storage'
import { setTimeout, clearTimeout } from '@zos/timer'
import { MUSAFIR_HEROES, heroById } from './musafir-chat'

const CONTEXT_KEY = 'musafir-context'
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

export function createMusafirPage() {
  return {
    build() {
      setStatusBarVisible(false)
      const { width, height } = getDeviceInfo()
      this.width = width
      this.height = height
      this.px = value => Math.round(value * Math.min(width / 432, height / 514))
      const px = this.px
      const createHidden = (type, options) => {
        const item = createWidget(type, options)
        item.setProperty(prop.VISIBLE, false)
        return item
      }
      this.closed = false
      this.generation = 0
      this.pendingRequests = []
      this.storage = null
      try { this.storage = new LocalStorage() } catch (error) {}
      this.migrateLegacyDraft()

      createWidget(widget.FILL_RECT, { x: 0, y: 0, w: width, h: height, color: COLOR.bg })
      this.heroButton = createWidget(widget.BUTTON, {
        x: px(24) + 60, y: px(24), w: width - px(48) - 60, h: px(62), radius: px(16),
        normal_color: COLOR.surface, press_color: COLOR.pressed, color: COLOR.white,
        text_size: px(19), text: '', click_func: () => this.heroPicker()
      })
      this.heroImage = createWidget(widget.IMG, {
        x: px(32), y: px(33), w: 44, h: 44, src: 'heroes/musafir-small.png'
      })
      this.heroImage.addEventListener(event.CLICK_UP, () => this.heroPicker())
      this.heading = createWidget(widget.TEXT, {
        x: px(24), y: px(90), w: width - px(48), h: px(30), text_size: px(24),
        color: COLOR.gold, align_h: align.LEFT, text: ''
      })
      this.note = createWidget(widget.TEXT, {
        x: px(24), y: px(120), w: width - px(48), h: px(38), text_size: px(17),
        color: COLOR.muted, align_h: align.LEFT, text_style: text_style.WRAP, text: ''
      })
      this.banners = [0, 1].map(index => createHidden(widget.BUTTON, {
        x: px(24), y: px(162 + index * 56), w: width - px(48), h: px(51), radius: px(11),
        normal_color: COLOR.surface, press_color: COLOR.pressed, color: COLOR.cyan,
        text_size: px(17), text: '',
        click_func: () => this.bannerItems[index] && this.bannerItems[index].action()
      }))
      this.rows = [0, 1, 2].map(index => createHidden(widget.BUTTON, {
        x: px(24), y: px(162 + index * 56), w: width - px(48), h: px(51), radius: px(13),
        normal_color: COLOR.surface, press_color: COLOR.pressed, color: COLOR.white,
        text_size: px(18), text: '',
        click_func: () => this.items[index] && this.items[index].action()
      }))
      this.rowImages = [0, 1, 2].map(index => createHidden(widget.IMG, {
        x: px(32), y: px(165 + index * 56), w: 44, h: 44, src: 'heroes/musafir-small.png'
      }))
      this.footer = [0, 1, 2].map(index => createHidden(widget.BUTTON, {
        x: px(24 + index * 132), y: px(386), w: px(index === 2 ? 120 : 112), h: px(51), radius: px(11),
        normal_color: COLOR.surface, press_color: COLOR.pressed, color: COLOR.gold,
        text_size: px(17), text: '',
        click_func: () => this.footerItems[index] && this.footerItems[index].action()
      }))
      this.primary = createHidden(widget.BUTTON, {
        x: px(24), y: height - px(68), w: width - px(48), h: px(54), radius: px(16),
        normal_color: COLOR.gold, press_color: 0xd3a25f, color: COLOR.bg,
        text_size: px(21), text: '',
        click_func: () => this.primaryItem && this.primaryItem.action()
      })
      this.refreshHero()
      this.home()
    },

    read(key) {
      if (!this.storage) return null
      try { return this.storage.getItem(key) } catch (error) { return null }
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

    write(key, value) {
      if (!this.storage) return false
      try { this.storage.setItem(key, value); return true } catch (error) { return false }
    },

    refreshHero() {
      const hero = heroById(this.read(HERO_KEY))
      this.hero = hero
      this.heroButton.setProperty(prop.TEXT, `${hero.name} · ${hero.meaning}`)
      this.heroImage.setProperty(prop.MORE, {
        x: this.px(32), y: this.px(33), w: 44, h: 44, src: `heroes/${hero.id}-small.png`
      })
    },

    display(view, generation, remember = true) {
      if (this.closed) return
      if (generation == null) ++this.generation
      else if (generation !== this.generation) return
      if (remember) this.currentView = () => this.display(view)

      this.heading.setProperty(prop.TEXT, view.title || '')
      this.note.setProperty(prop.TEXT, view.note || '')
      this.bannerItems = view.banners || []
      this.items = view.items || []
      this.footerItems = view.footer || []
      this.primaryItem = view.primary || null

      const px = this.px
      let y = 162
      this.banners.forEach((banner, index) => {
        const item = this.bannerItems[index]
        banner.setProperty(prop.VISIBLE, Boolean(item))
        if (!item) return
        banner.setProperty(prop.TEXT, item.label)
        banner.setProperty(prop.MORE, { x: px(24), y: px(y), w: this.width - px(48), h: px(51) })
        y += 56
      })
      this.rows.forEach((row, index) => {
        const item = this.items[index]
        const image = this.rowImages[index]
        row.setProperty(prop.VISIBLE, Boolean(item))
        image.setProperty(prop.VISIBLE, Boolean(item && item.image))
        if (!item) return
        const imageSpace = item.image ? 60 : 0
        row.setProperty(prop.TEXT, item.label)
        row.setProperty(prop.MORE, {
          x: px(24) + imageSpace, y: px(y + index * 56),
          w: this.width - px(48) - imageSpace, h: px(51)
        })
        if (item.image) image.setProperty(prop.MORE, {
          x: px(28), y: px(y + 3 + index * 56), w: 44, h: 44, src: item.image
        })
      })
      this.footer.forEach((button, index) => {
        const item = this.footerItems[index]
        button.setProperty(prop.VISIBLE, Boolean(item))
        if (!item) return
        button.setProperty(prop.TEXT, item.label)
        if (this.footerItems[0] && this.footerItems[1] && !this.footerItems[2]) {
          const gap = px(8)
          const buttonWidth = Math.floor((this.width - px(48) - gap) / 2)
          button.setProperty(prop.MORE, {
            x: index === 0 ? px(24) : px(24) + buttonWidth + gap,
            y: px(386), w: buttonWidth, h: px(51)
          })
        } else {
          button.setProperty(prop.MORE, {
            x: px(24 + index * 132), y: px(386),
            w: px(index === 2 ? 120 : 112), h: px(51)
          })
        }
      })
      this.primary.setProperty(prop.VISIBLE, Boolean(this.primaryItem))
      if (this.primaryItem) this.primary.setProperty(prop.TEXT, this.primaryItem.label)
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

    async load(method, params, done, back, title = 'Мусафир') {
      this.cancelRequests()
      const generation = ++this.generation
      this.display({
        title,
        note: 'Получаю данные с Mac…',
        footer: back ? [{ label: 'Назад', action: back }] : []
      }, generation)
      this.currentView = () => this.load(method, params, done, back, title)
      try {
        const reply = await this.boundedRequest({ method, params })
        if (this.closed || generation !== this.generation) return
        if (!reply || reply.ok !== true) throw new Error(reply && reply.error || 'Нет ответа Musafir')
        done(reply, generation)
      } catch (error) {
        if (this.closed || generation !== this.generation) return
        this.display({
          title: 'Не удалось',
          note: clip(error && error.message || error, 120),
          items: [{ label: 'Повторить', action: () => this.load(method, params, done, back, title) }],
          footer: back ? [{ label: 'Назад', action: back }] : [],
          primary: { label: 'Новая задача', action: () => this.newChat('task') }
        }, generation)
      }
    },

    home() {
      this.load('CHAT_LIST', { offset: 0, limit: 10, archived: false },
        (reply, generation) => this.homeReply(reply, generation), null, 'Мусафир')
    },

    homeReply(reply, generation) {
      checkedChatList(reply, 10)
      const chats = reply.chats
      const banners = []
      let pending = null
      try { pending = JSON.parse(this.read(PENDING_KEY) || 'null') } catch (error) {}
      if (validPendingContext(pending)) {
        banners.push({ label: 'Черновик · продолжить', action: () => this.openContext(pending) })
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
        title: 'Последние чаты',
        note: chats.length ? 'Продолжи тему или начни новую' : 'Здесь появятся твои задачи',
        banners,
        items: chats.slice(0, 2).map(chat => ({
          label: this.chatLabel(chat),
          action: () => this.chatDetail(chat)
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
      this.load('CHAT_LIST', { offset, limit: 3, archived }, (reply, generation) => {
        checkedChatList(reply, 3)
        const chats = reply.chats.slice(0, 3)
        const firstAction = offset > 0
          ? { label: 'Раньше', action: () => this.chats(archived, Math.max(0, offset - 3)) }
          : { label: 'Домой', action: () => this.home() }
        this.display({
          title: archived ? 'Архив' : 'Все чаты',
          note: chats.length ? 'По три чата на странице' : archived ? 'Архив пуст' : 'Чатов пока нет',
          items: chats.map(chat => ({ label: this.chatLabel(chat), action: () => this.chatDetail(chat) })),
          footer: [
            firstAction,
            { label: archived ? 'Активные' : 'Архив', action: () => this.chats(!archived, 0) },
            reply.nextOffset == null ? null : { label: 'Дальше', action: () => this.chats(archived, reply.nextOffset) }
          ]
        }, generation)
      }, () => this.home(), archived ? 'Архив' : 'Все чаты')
    },

    chatDetail(chat, offset = 0) {
      if (!chat || !validChatId(chat.id)) return this.home()
      this.load('CHAT_DETAIL', { chatId: chat.id, offset, limit: 2 },
        (reply, generation) => this.detailReply(checkedChatDetail(reply, chat.id, offset), chat, offset, generation),
        () => this.chats(Boolean(chat.archived), 0), clip(chat.title, 30) || 'Чат')
    },

    detailReply(reply, fallback, offset, generation) {
      const chat = reply.chat
      const jobs = reply.jobs
      const latestMode = modeOf(offset === 0 && jobs[0] && jobs[0].mode || fallback.latestJob && fallback.latestJob.mode)
      const chatForPaging = { ...fallback, ...chat, latestJob: fallback.latestJob || null }
      const jobItems = jobs.map(job => ({
        label: clip(job.summary || job.text || job.state, 42) || 'Открыть ответ',
        action: () => this.openContext({
          target: 'musafir', chatId: chat.id, mode: modeOf(job.mode), jobId: job.id,
          openJob: true, autoRecord: false
        })
      }))
      if (reply.nextOffset !== null) jobItems.push({
        label: 'Более ранние ответы',
        action: () => this.chatDetail(chatForPaging, reply.nextOffset)
      })
      this.display({
        title: clip(chat.title, 34) || 'Чат',
        note: jobs.length ? offset ? `Ответы ${offset + 1}–${offset + jobs.length}` : 'Последние ответы'
          : 'В этом чате пока нет ответов',
        items: jobItems,
        footer: [
          { label: 'Назад', action: () => this.chats(Boolean(chat.archived), 0) },
          { label: chat.archived ? 'Восстановить' : 'Архивировать', action: () => this.archiveConfirm(chatForPaging, offset) },
          offset > 0 ? { label: 'Новее', action: () => this.chatDetail(chatForPaging, Math.max(0, offset - 2)) } : null
        ],
        primary: chat.archived ? null : { label: 'Продолжить', action: () => this.openContext({
          target: 'musafir', chatId: chat.id, mode: latestMode, jobId: null,
          openJob: false, autoRecord: true
        }) }
      }, generation)
    },

    archiveConfirm(chat, offset = 0) {
      if (chat.archived) {
        this.setArchived(chat, false, offset)
        return
      }
      this.display({
        title: clip(chat.title, 34) || 'Чат',
        note: 'Чат можно будет восстановить из архива',
        items: [{ label: 'Архивировать', action: () => this.setArchived(chat, true, offset) }],
        footer: [{ label: 'Отмена', action: () => this.chatDetail(chat, offset) }]
      })
    },

    setArchived(chat, archived, offset = 0) {
      this.load('CHAT_ARCHIVE', { chatId: chat.id, archived }, reply => {
        if (reply.chatId !== chat.id || reply.archived !== archived) throw new Error('Некорректный ответ архива')
        this.chatDetail({ ...chat, archived }, offset)
      }, () => this.chatDetail(chat, offset), archived ? 'Архивирую' : 'Восстанавливаю')
    },

    newChat(mode) {
      this.openContext({ target: 'musafir', chatId: null, mode: modeOf(mode), jobId: null,
        openJob: false, autoRecord: true })
    },

    openContext(context) {
      const raw = this.read(PENDING_KEY)
      let pending = null
      try { pending = JSON.parse(raw || 'null') } catch (error) {}
      if (context.autoRecord && validPendingContext(pending)) {
        const back = this.currentView || (() => this.home())
        this.display({
          title: pending.pendingSend ? 'Проверим отправку' : 'Есть черновик',
          note: pending.pendingSend ? 'Задание могло быть принято. Открой его статус.' : 'Продолжи его или явно начни новую запись',
          items: [
            { label: pending.pendingSend ? 'Открыть задание' : 'Продолжить черновик',
              action: () => this.openContext({ ...pending, autoRecord: false }) },
            ...(pending.pendingSend ? [] : [{ label: 'Новая запись', action: () => this.discardPendingAndStart(context, raw, pending) }])
          ],
          footer: [{ label: 'Назад', action: back }]
        })
        return
      }
      if (!this.write(CONTEXT_KEY, JSON.stringify(context))) {
        this.display({ title: 'Не удалось сохранить', note: 'Чат не открыт. Проверьте свободное место на часах.',
          footer: [{ label: 'Назад', action: () => this.home() }] })
        return
      }
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

    heroPicker(page = 0, returnView) {
      this.cancelRequests()
      const back = returnView || this.currentView || (() => this.home())
      const start = page * 3
      const choices = MUSAFIR_HEROES.slice(start, start + 3)
      this.display({
        title: 'Выбери героя',
        note: 'Только внешний вид',
        items: choices.map(hero => ({
          label: `${hero.name} · ${hero.meaning}`,
          image: `heroes/${hero.id}-small.png`,
          action: () => {
            if (!this.write(HERO_KEY, hero.id)) {
              this.note.setProperty(prop.TEXT, 'Не удалось сохранить выбор')
              return
            }
            this.refreshHero()
            back()
          }
        })),
        footer: [
          { label: 'Назад', action: back },
          page > 0 ? { label: 'Раньше', action: () => this.heroPicker(page - 1, back) } : null,
          start + 3 < MUSAFIR_HEROES.length ? { label: 'Дальше', action: () => this.heroPicker(page + 1, back) } : null
        ]
      }, null, false)
    },

    onDestroy() {
      setStatusBarVisible(true)
      this.closed = true
      ++this.generation
      this.cancelRequests()
    }
  }
}
