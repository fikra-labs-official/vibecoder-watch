import { textRows } from '/shared/text-rows.js'
import { forwardVoiceRequest } from '/shared/bridge-client.js'
import { MAX_AUDIO_BYTES, createWatchClient } from '/shared/watch-client.js'
import { createFolderVoiceRoute, createOrcaVoiceRoute } from '/shared/orca-voice.js'
import { createClaudeVoiceRoute, createCodexVoiceRoute } from '/shared/claude-voice.js'
import {
  createMusafirVoiceRoute, normalizeContext, heroById, MUSAFIR_HEROES,
  MUSAFIR_CONTEXT_KEY, MUSAFIR_HERO_KEY
} from '/shared/musafir-chat.js'

const screen = document.querySelector('#watch-screen')
const layer = document.querySelector('#widget-layer')
const select = document.querySelector('#state-select')
const appSelect = document.querySelector('#app-select')
const geometrySelect = document.querySelector('#geometry-select')
const appName = document.querySelector('#app-name')
const timeNode = document.querySelector('#watch-time')
const snapshot = document.querySelector('#snapshot')

const widget = Object.freeze({ FILL_RECT: 'fill', TEXT: 'text', BUTTON: 'button', IMG: 'image', SCROLL_LIST: 'scroll-list' })
const align = Object.freeze({ LEFT: 'left', RIGHT: 'right', CENTER_H: 'center-h', TOP: 'top', BOTTOM: 'bottom', CENTER_V: 'center-v' })
const text_style = Object.freeze({ WRAP: 'wrap' })
const prop = Object.freeze({ TEXT: 'text', MORE: 'more', VISIBLE: 'visible', COLOR: 'color', UPDATE_DATA: 'update-data' })
const files = new Map()
const fileHandles = new Map()
const storage = new Map()
const uploads = new Map()
const textDrafts = new Map()
const widgets = []
let currentPage = null
let currentPath = 'page/index'
let appKind = 'musafir'
let nextFileDescriptor = 0
const pageSources = new Map()
let session = 0
let scenario = 'ready'
let lastState = { phase: 'booting' }
let audioStatusCalls = 0
let jobStatusCalls = 0
let gestureCallback = null
let keyCallback = null
const PROFILES = Object.freeze({
  musafir: { title: 'Мусафир', menu: 'page/index', voice: 'page/voice', history: 'page/history' },
  orca: { title: 'Orca', menu: 'page/orca', voice: 'page/voice-orca', history: 'page/history-orca' },
  claude: { title: 'Claude', menu: 'page/claude', voice: 'page/voice-claude', history: 'page/history-claude' },
  codex: { title: 'Codex', menu: 'page/codex', voice: 'page/voice-codex', history: 'page/history-codex' }
})
const interaction = {
  GESTURE_RIGHT: 'right', GESTURE_LEFT: 'left', GESTURE_UP: 'up', GESTURE_DOWN: 'down',
  KEY_BACK: 'back', KEY_HOME: 'home', KEY_EVENT_CLICK: 'click',
  onGesture(value) { gestureCallback = typeof value === 'function' ? value : value.callback },
  offGesture() { gestureCallback = null },
  onKey(value) { keyCallback = typeof value === 'function' ? value : value.callback },
  offKey() { keyCallback = null }
}

const CHAT_ID = '1700000000000-1'
const OTHER_CHAT_ID = '1700000000001-1'
const RESULT_JOB_ID = '1700000001000-1'
const OLDER_JOB_ID = '1700000000900-1'
const RUNNING_JOB_ID = '1700000001100-1'
const APPROVAL_JOB_ID = '1700000001200-1'
const REVIEW_AUDIO_ID = '1700000002000-1'
const LOCAL_ID = /^\d{1,16}-\d{1,8}$/
const archivedChats = new Set()
const submittedJobs = new Map()
const submittedChats = new Map()

const reviewText = 'Проверь состояние проекта. Исправь две опечатки в названии экрана. Перед началом покажи, что задание принято. После выполнения пришли результат на часы. '.repeat(3)
const reportParagraph = [
  'Проверка завершена: русский текст, العربية، 中文, emoji 🧭✅ и составные символы é отображаются вместе.',
  'Проверены меню, возврат, отмена, редактирование, ожидание, ошибка и восстановление.',
  'Это синтетический отчёт browser preview. Файлы, команды, bridge и реальные агенты не затрагиваются.'
].join(' ')
const fullReport = Array.from({ length: 16 }, (_, index) =>
  `${index + 1}. ${reportParagraph}`).join('\n\n') +
  '\n\nФИНАЛ ПРЕДПРОСМОТРА · конец полного ответа ✅'

function makeMusafirJob(id, state, values = {}) {
  const report = values.report || fullReport
  return {
    ok: true,
    id,
    chatId: values.chatId || CHAT_ID,
    mode: values.mode === 'research' ? 'research' : 'task',
    state,
    text: values.text || 'Проверь экран и подготовь краткий отчёт.',
    summary: values.summary || (state === 'completed' ? 'Проверка завершена' : 'Проверяю интерфейс'),
    result: values.result == null
      ? (state === 'completed' ? 'Проверка завершена. Полный отчёт доступен ниже.' : '')
      : values.result,
    error: values.error || '',
    reportLength: Array.from(report).length,
    ...(values.approval ? { approval: values.approval } : {})
  }
}

const demoWorkspace = {
  id: 'demo-repo::/local/demo', projectLabel: 'Демо проект', name: 'main',
  path: '/local/demo', kind: 'git'
}
const demoTerminals = [
  { id: 'term-demo-worker', title: 'Codex · боевой', agent: 'codex', busy: false },
  { id: 'term-demo-reviewer', title: 'Claude · проверяющий', agent: 'claude', busy: false }
]
const demoPair = {
  id: 'pair-demo', projectLabel: 'Демо проект', workerAgent: 'codex', reviewerAgent: 'claude'
}
const historyDemo = [
  {
    id: RESULT_JOB_ID, created: 1700000500, state: 'completed', deleted: false,
    text: reviewText, result: fullReport
  },
  ...[0, 1, 2, 3].map(i => ({
    id: `170000000000${i}-1`, created: 1700000000 - i * 3600, state: 'completed', deleted: false,
    text: ['Покажи мой план на сегодня', 'Что мы обсуждали вчера?', 'Подготовь список дел', 'Напомни мой вопрос'][i],
    result: 'Это пример сохранённого ответа для просмотра интерфейса. '.repeat(15)
  }))
]

const scenarios = {
  ready: null,
  review: { id: REVIEW_AUDIO_ID, state: 'ready', text: reviewText },
  approval: makeMusafirJob(APPROVAL_JOB_ID, 'approval', {
    approval: {
      id: '1700000001300-1',
      text: 'Разрешить синтетическую проверку без реальных изменений?'
    },
    summary: 'Нужно решение'
  }),
  job: makeMusafirJob(RUNNING_JOB_ID, 'running'),
  result: makeMusafirJob(RESULT_JOB_ID, 'completed')
}

const demoChats = [
  {
    id: CHAT_ID, title: 'Интерфейс часов', updated: 1700000200,
    latestJob: { id: RESULT_JOB_ID, state: 'completed', summary: 'Проверка завершена', mode: 'task' }
  },
  {
    id: OTHER_CHAT_ID, title: 'Идеи для поездки', updated: 1700000100,
    latestJob: { id: OLDER_JOB_ID, state: 'completed', summary: 'План готов', mode: 'research' }
  }
]

const demoJobs = new Map([
  [RESULT_JOB_ID, scenarios.result],
  [OLDER_JOB_ID, makeMusafirJob(OLDER_JOB_ID, 'completed', {
    chatId: OTHER_CHAT_ID, mode: 'research', text: 'Собери идеи для поездки.', summary: 'План готов'
  })],
  [RUNNING_JOB_ID, scenarios.job],
  [APPROVAL_JOB_ID, scenarios.approval]
])

// This browser-only stand-in exercises the page callbacks; the watch uses Zepp's native keyboard.
const keyboardUI = {
  inputType: { CHAR: 1, JSKB: 4 },
  createKeyboard(options) {
    this.deleteKeyboard()
    const panel = document.createElement('div')
    panel.className = 'keyboard-demo'
    const label = document.createElement('label')
    label.textContent = 'Демонстрация ввода. На часах откроется системная клавиатура.'
    const input = document.createElement('textarea')
    input.value = options.text
    input.setAttribute('aria-label', 'Полный текст задания')
    const save = document.createElement('button')
    save.textContent = 'Сохранить правки'
    save.onclick = () => options.onComplete(null, { data: input.value })
    const cancel = document.createElement('button')
    cancel.textContent = 'Отмена'
    cancel.onclick = () => options.onCancel()
    panel.append(label, input, save, cancel)
    screen.append(panel)
    input.focus()
    return panel
  },
  deleteKeyboard() { screen.querySelector('.keyboard-demo')?.remove() }
}

function color(value, fallback = 'transparent') {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return `#${Math.max(0, value).toString(16).padStart(6, '0').slice(-6)}`
}

function imageSource(value) {
  const raw = String(value || '')
  if (!raw) return ''
  if (raw.startsWith('/') || raw.startsWith('data:')) return raw
  if (/^heroes\/(?:musafir|kashif|barq|hakim|amin)(?:-[0-2]|-small|-picker)?\.png$/.test(raw)) {
    return `/assets/common.s/${raw}`
  }
  return `/assets/common.s/${raw.split('/').pop()}`
}

function setWatchGeometry() {
  const [width, height] = geometrySelect.value.split('x').map(Number)
  document.documentElement.style.setProperty('--watch-width', `${width}px`)
  document.documentElement.style.setProperty('--watch-height', `${height}px`)
  screen.dataset.app = appKind
  return { width, height }
}

function applyGeometry(node, options) {
  for (const key of ['x', 'y', 'w', 'h']) {
    if (Number.isFinite(options[key])) {
      const css = { x: 'left', y: 'top', w: 'width', h: 'height' }[key]
      node.style[css] = `${options[key]}px`
    }
  }
}

function applyWidget(record, forceListRender = false) {
  const { node, type, options } = record
  applyGeometry(node, options)
  node.hidden = options.visible === false
  node.style.color = color(options.color, 'inherit')
  if (Number.isFinite(options.text_size)) node.style.fontSize = `${options.text_size}px`
  if (Number.isFinite(options.radius)) node.style.borderRadius = `${options.radius}px`

  if (type === widget.FILL_RECT) node.style.backgroundColor = color(options.color, '#000000')
  if (type === widget.TEXT || type === widget.BUTTON) {
    const horizontal = options.align_h || (type === widget.BUTTON ? align.CENTER_H : align.LEFT)
    const vertical = options.align_v || (type === widget.BUTTON ? align.CENTER_V : align.TOP)
    node.textContent = String(options.text ?? '')
    node.style.justifyContent = horizontal === align.CENTER_H ? 'center' : horizontal === align.RIGHT ? 'flex-end' : 'flex-start'
    node.style.textAlign = horizontal === align.CENTER_H ? 'center' : horizontal === align.RIGHT ? 'right' : 'left'
    node.style.alignItems = vertical === align.CENTER_V ? 'center' : vertical === align.BOTTOM ? 'flex-end' : 'flex-start'
  }
  if (type === widget.BUTTON) {
    node.style.backgroundColor = color(options.normal_color, '#252525')
    node.style.setProperty('--press-color', color(options.press_color, '#393939'))
  }
  if (type === widget.IMG) {
    node.src = imageSource(options.src)
    node.alt = ''
    node.style.objectFit = options.auto_scale ? 'contain' : 'none'
    if (!options.auto_scale && node.naturalWidth) {
      node.style.width = `${node.naturalWidth}px`
      node.style.height = `${node.naturalHeight}px`
    }
  }
  if (type === widget.SCROLL_LIST) {
    if (!forceListRender && record.renderedData === options.data_array &&
        record.renderedCount === options.data_count) return
    record.renderedData = options.data_array
    record.renderedCount = options.data_count
    const scrollTop = record.preserveListPosition ? node.scrollTop : 0
    record.preserveListPosition = false
    node.replaceChildren()
    for (let index = 0; index < (options.data_count || 0); index++) {
      const data = options.data_array[index]
      const range = options.data_type_config?.find(value => index >= value.start && index <= value.end)
      const template = options.item_config?.find(value => value.type_id === range?.type_id) || options.item_config?.[0]
      if (!template) continue
      const item = document.createElement('button')
      item.className = 'zepp-list-item'
      item.style.height = `${template.item_height}px`
      item.style.marginBottom = `${options.item_space || 0}px`
      item.style.backgroundColor = color(template.item_bg_color, '#171d25')
      item.style.borderRadius = `${template.item_bg_radius || 0}px`
      item.addEventListener('click', () => options.item_click_func?.(record, index, ''))
      for (const view of template.image_view || []) {
        const img = document.createElement('img')
        applyGeometry(img, view)
        img.src = imageSource(data[view.key])
        img.alt = ''
        item.append(img)
      }
      for (const view of template.text_view || []) {
        const text = document.createElement('span')
        applyGeometry(text, view)
        text.style.color = color(view.color, '#f3f6fa')
        text.style.fontSize = `${view.text_size || 20}px`
        text.textContent = String(data[view.key] || '')
        item.append(text)
      }
      node.append(item)
    }
    node.scrollTop = scrollTop
  }
}

function createWidget(type, initial = {}) {
  const node = document.createElement(type === widget.BUTTON ? 'button' : type === widget.IMG ? 'img' : 'div')
  node.className = `zepp-widget zepp-${type}`
  const record = {
    type,
    node,
    options: { ...initial, visible: true },
    addEventListener(type, callback) {
      node.style.pointerEvents = 'auto'
      node.addEventListener(type, callback)
    },
    setProperty(property, value) {
      if (type === widget.BUTTON && appKind === 'musafir' && property !== prop.VISIBLE &&
          (property !== prop.MORE || !['x', 'y', 'w', 'h'].every(key => Number.isFinite(value?.[key])))) {
        throw new Error('Native BUTTON update requires complete x,y,w,h: ' + String(this.options.text))
      }
      if ((property === prop.MORE || property === prop.UPDATE_DATA) && value && typeof value === 'object') {
        if (property === prop.UPDATE_DATA) {
          this.preserveListPosition = value.on_page === 1
          this.options.on_page = this.preserveListPosition ? 1 : 0
        }
        Object.assign(this.options, value)
      }
      else this.options[property] = value
      applyWidget(this, property === prop.UPDATE_DATA)
      updateSnapshot()
    }
  }
  if (type === widget.BUTTON) node.addEventListener('click', () => record.options.click_func?.())
  node.addEventListener('error', () => { if (type === widget.IMG) node.style.visibility = 'hidden' })
  node.addEventListener('load', () => { if (type === widget.IMG) {
    node.style.visibility = ''
    if (!record.options.auto_scale) {
      node.style.width = `${node.naturalWidth}px`
      node.style.height = `${node.naturalHeight}px`
    }
  } })
  widgets.push(record)
  layer.append(node)
  applyWidget(record)
  return record
}

function deleteWidget(record) {
  record?.node?.remove()
  const index = widgets.indexOf(record)
  if (index >= 0) widgets.splice(index, 1)
}

function getTextLayout(value, options = {}) {
  const size = Number(options.text_size) || 20
  const width = Math.max(1, Number(options.text_width) || screen.clientWidth)
  const node = getTextLayout.node || (getTextLayout.node = (() => {
    const element = document.createElement('div')
    element.className = 'zepp-text'
    element.setAttribute('aria-hidden', 'true')
    Object.assign(element.style, {
      position: 'fixed', left: '-100000px', top: '0', display: 'flex',
      height: 'auto', minHeight: '0', maxHeight: 'none', padding: '0', border: '0',
      overflow: 'visible', visibility: 'hidden', pointerEvents: 'none',
      whiteSpace: 'pre-wrap', lineHeight: '1.17', alignItems: 'flex-start',
      justifyContent: 'flex-start', textAlign: 'left'
    })
    screen.append(element)
    return element
  })())
  const reference = layer.querySelector('.zepp-text') || screen
  const font = getComputedStyle(reference)
  Object.assign(node.style, {
    width: `${width}px`, fontSize: `${size}px`, fontFamily: font.fontFamily,
    fontStyle: font.fontStyle, fontWeight: font.fontWeight, letterSpacing: font.letterSpacing
  })
  node.textContent = String(value || '')
  const height = Math.ceil(Math.max(node.scrollHeight, node.getBoundingClientRect().height))
  return { result: 0, width, height }
}

function updateClock() {
  timeNode.textContent = new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date())
}

function updateSnapshot() {
  snapshot.querySelector('[data-field="phase"]').textContent = lastState.phase || 'unknown'
  snapshot.querySelector('[data-field="widgets"]').textContent = String(widgets.length)
  const source = snapshot.querySelectorAll('dd')[2]
  if (source) source.textContent = `${currentPath}.js`
}

function allDemoChats() {
  const chats = new Map(demoChats.map(chat => [chat.id, chat]))
  for (const chat of submittedChats.values()) chats.set(chat.id, chat)
  return [...chats.values()].map(chat => ({
    ...chat,
    archived: archivedChats.has(chat.id),
    latestJob: chat.latestJob ? { ...chat.latestJob } : null
  }))
}

function jobsForChat(chatId) {
  const jobs = [...demoJobs.values(), ...submittedJobs.values()]
    .filter(job => job.chatId === chatId)
  const unique = new Map(jobs.map(job => [job.id, job]))
  return [...unique.values()].sort((left, right) => right.id.localeCompare(left.id))
}

function activeDemoJob() {
  const selected = scenarios[scenario]
  const job = selected && (knownJob(selected.id) || selected)
  if (!job || !['submitting', 'queued', 'running', 'stopping', 'approval', 'unknown'].includes(job.state)) return null
  return { id: job.id, chatId: job.chatId, state: job.state, mode: job.mode }
}

function knownJob(id) {
  return submittedJobs.get(id) || demoJobs.get(id) || null
}

function localRequest(payload) {
  // Exercise the same phone allowlist as the installed Side Service.
  return forwardVoiceRequest(payload, async options => ({
    status: 200, body: await syntheticBridge(JSON.parse(options.body))
  }), 'https://preview.invalid', 'preview-placeholder', appKind)
}

function syntheticBridge(payload) {
  const ownSession = session
  const delay = payload.method === 'AUDIO_CHUNK' ? 105 : 220
  return new Promise((resolve, reject) => setTimeout(() => {
    if (ownSession !== session) { reject(new Error('CANCELED')); return }
    const params = payload.params || {}
    switch (payload.method) {
      case 'CHAT_LIST': {
        if (scenario === 'home-error') {
          resolve({ ok: false, error: 'Телефон не получил ответ Mac' })
          return
        }
        const offset = Number.isSafeInteger(params.offset) && params.offset >= 0 ? params.offset : 0
        const limit = Number.isSafeInteger(params.limit) && params.limit > 0 ? Math.min(params.limit, 10) : 3
        const chats = allDemoChats().filter(chat => chat.archived === (params.archived === true))
        resolve({
          ok: true,
          chats: chats.slice(offset, offset + limit),
          nextOffset: offset + limit < chats.length ? offset + limit : null,
          activeJob: params.archived === true ? null : activeDemoJob()
        })
        return
      }
      case 'CHAT_DETAIL': {
        const chat = allDemoChats().find(item => item.id === params.chatId)
        if (!chat || !LOCAL_ID.test(params.chatId || '')) {
          resolve({ ok: false, error: 'Чат не найден' })
          return
        }
        const offset = Number.isSafeInteger(params.offset) && params.offset >= 0 ? params.offset : 0
        const jobs = jobsForChat(chat.id)
        resolve({
          ok: true,
          chat: { id: chat.id, title: chat.title, archived: chat.archived },
          jobs: jobs.slice(offset, offset + 2).map(job => ({ ...job })),
          nextOffset: offset + 2 < jobs.length ? offset + 2 : null
        })
        return
      }
      case 'CHAT_ARCHIVE': {
        const chat = allDemoChats().find(item => item.id === params.chatId)
        if (!chat || !LOCAL_ID.test(params.chatId || '') || typeof params.archived !== 'boolean') {
          resolve({ ok: false, error: 'Некорректный чат' })
          return
        }
        if (params.archived) archivedChats.add(chat.id)
        else archivedChats.delete(chat.id)
        resolve({ ok: true, chatId: chat.id, archived: params.archived })
        return
      }
      case 'HISTORY_LIST': {
        const items = historyDemo.filter(x => x.deleted === params.trash)
        resolve({ ok: true, items: items.slice(params.offset, params.offset + params.limit), hasMore: items.length > params.offset + params.limit })
        return
      }
      case 'HISTORY_DETAIL': {
        const entry = historyDemo.find(x => x.id === params.id)
        if (!entry || !['text', 'result'].includes(params.field)) { resolve({ ok: false, error: 'Запись не найдена' }); return }
        const chars = Array.from(entry[params.field])
        resolve({ ok: true, ...entry, field: params.field, offset: params.offset,
          content: chars.slice(params.offset, params.offset + params.limit).join(''), total: chars.length,
          complete: params.offset + params.limit >= chars.length })
        return
      }
      case 'HISTORY_SET_DELETED': {
        const entry = historyDemo.find(x => x.id === params.id)
        entry.deleted = params.deleted
        resolve({ ok: true, id: entry.id, deleted: entry.deleted }); return
      }
      case 'HISTORY_CURRENT': resolve({ ok: true, job: null }); return
      case 'HISTORY_EMPTY_TRASH':
      case 'ORCA_HISTORY_EMPTY_TRASH': {
        const removed = historyDemo.filter(x => x.deleted).length
        historyDemo.forEach(x => { if (x.deleted) x.deleted = false })
        resolve({ ok: true, removed }); return
      }
      case 'ORCA_HISTORY_LIST': {
        const items = historyDemo.filter(x => x.deleted === params.trash)
        resolve({ ok: true, items: items.slice(params.offset, params.offset + params.limit), hasMore: items.length > params.offset + params.limit })
        return
      }
      case 'ORCA_HISTORY_DETAIL': {
        const entry = historyDemo.find(x => x.id === params.id)
        if (!entry || !['text', 'result'].includes(params.field)) { resolve({ ok: false, error: 'Запись не найдена' }); return }
        const chars = Array.from(entry[params.field])
        resolve({ ok: true, ...entry, field: params.field, offset: params.offset,
          content: chars.slice(params.offset, params.offset + params.limit).join(''), total: chars.length,
          complete: params.offset + params.limit >= chars.length })
        return
      }
      case 'ORCA_HISTORY_SET_DELETED': {
        const entry = historyDemo.find(x => x.id === params.id)
        entry.deleted = params.deleted
        resolve({ ok: true, id: entry.id, deleted: entry.deleted }); return
      }
      case 'STATUS':
        if (scenario === 'offline') { reject(new Error('Телефон не ответил')); return }
        resolve({ ok: true, agent: 'Мусафир · локальная демонстрация' })
        return
      case 'TEXT_BEGIN':
        if (!textDrafts.has(params.id)) textDrafts.set(params.id, { length: params.textLength, text: '', sourceId: params.sourceId })
        resolve({ ok: true, id: params.id, state: 'uploading', textLength: params.textLength, receivedLength: 0 }); return
      case 'TEXT_PART': {
        const draft = textDrafts.get(params.id)
        if (!draft) { resolve({ ok: false, error: 'Черновик не найден' }); return }
        if (params.offset === Array.from(draft.text).length) draft.text += params.text
        resolve({ ok: true, id: params.id, textLength: draft.length, receivedLength: Array.from(draft.text).length }); return
      }
      case 'TEXT_FINISH':
        resolve({ ok: true, id: params.id, state: 'ready', textLength: textDrafts.get(params.id)?.length }); return
      case 'LATEST_JOB':
        if (scenario === 'error') { resolve({ ok: false, error: 'Не удалось прочитать запись' }); return }
        resolve({ ok: true, job: scenarios[scenario] ?? null })
        return
      case 'AUDIO_BEGIN':
        if (uploads.get(params.id)?.state === 'cancelled') { resolve({ ok: false, error: 'Запись отменена' }); return }
        if (!LOCAL_ID.test(params.id || '') || !Number.isInteger(params.totalBytes) || params.totalBytes <= 0) {
          resolve({ ok: false, error: 'Некорректная аудиозапись' })
          return
        }
        if (!uploads.has(params.id)) uploads.set(params.id, { totalBytes: params.totalBytes, receivedBytes: 0 })
        resolve({ ok: true, id: params.id, ...uploads.get(params.id) })
        return
      case 'AUDIO_CHUNK': {
        const upload = uploads.get(params.id) || { totalBytes: params.data.length, receivedBytes: 0 }
        upload.receivedBytes = params.index * 1024 + params.data.length
        uploads.set(params.id, upload)
        resolve({ ok: true, id: params.id, ...upload })
        return
      }
      case 'AUDIO_FINISH':
        if (uploads.get(params.id)?.state === 'cancelled') { resolve({ ok: false, error: 'Запись отменена' }); return }
        audioStatusCalls = 0
        resolve({ ok: true, id: params.id, state: 'transcribing' })
        return
      case 'AUDIO_CANCEL':
        uploads.set(params.id, { state: 'cancelled', totalBytes: 0, receivedBytes: 0 })
        resolve({ ok: true, id: params.id, state: 'cancelled' })
        return
      case 'AUDIO_STATUS':
        if (uploads.get(params.id)?.state === 'cancelled') { resolve({ ok: true, id: params.id, state: 'cancelled', text: '' }); return }
        audioStatusCalls += 1
        if (scenario !== 'review' && audioStatusCalls < 2) {
          resolve({ ok: true, id: params.id, state: 'transcribing', text: '',
            textOffset: 0, textLength: 0, textComplete: true })
          return
        }
        {
          const characters = Array.from(reviewText)
          const offset = params.textOffset || 0
          const page = characters.slice(offset, offset + (params.textLimit || 1000)).join('')
          resolve({ ok: true, id: params.id, state: 'ready', text: page,
            textOffset: offset, textLength: characters.length,
            textComplete: offset + Array.from(page).length === characters.length })
        }
        return
      case 'SEND_TEXT': {
        const validChat = params.chatId === null || allDemoChats().some(chat => chat.id === params.chatId)
        if (!LOCAL_ID.test(params.id || '') || !validChat || !['task', 'research'].includes(params.mode)) {
          resolve({ ok: false, error: 'Некорректное задание' })
          return
        }
        jobStatusCalls = 0
        const chatId = params.chatId || params.id
        const text = typeof params.text === 'string' ? params.text : textDrafts.get(params.textId)?.text || reviewText
        const job = makeMusafirJob(params.id, 'completed', {
          chatId, mode: params.mode, text,
          summary: 'Синтетический ответ готов'
        })
        submittedJobs.set(job.id, job)
        const title = text.replace(/\s+/g, ' ').trim().slice(0, 34) || 'Новая задача'
        submittedChats.set(chatId, {
          id: chatId, title, updated: Math.floor(Date.now() / 1000),
          latestJob: { id: job.id, state: job.state, summary: job.summary, mode: job.mode }
        })
        resolve({ ...job })
        return
      }
      case 'JOB_STATUS':
        if (scenario === 'offline') { reject(new Error('Телефон не ответил')); return }
        if (scenario === 'error') {
          resolve({ ok: false, error: 'Не удалось получить статус задания' })
          return
        }
        jobStatusCalls += 1
        {
          const job = knownJob(params.id)
          resolve(job ? { ...job } : { ok: false, error: 'Задание не найдено' })
        }
        return
      case 'JOB_APPROVE': {
        const existing = knownJob(params.id)
        if (!existing || existing.state !== 'approval') {
          resolve({ ok: false, error: 'Подтверждение устарело' })
          return
        }
        const completed = makeMusafirJob(params.id, params.allow ? 'completed' : 'cancelled', {
          chatId: existing.chatId, mode: existing.mode, text: existing.text,
          summary: params.allow ? 'Проверка завершена' : 'Действие отклонено',
          result: params.allow ? 'Проверка завершена. Полный отчёт доступен ниже.' : 'Действие отклонено. Изменений нет.'
        })
        demoJobs.set(params.id, completed)
        resolve({ ...completed })
        return
      }
      case 'JOB_STOP': {
        const existing = knownJob(params.id)
        if (!existing || !LOCAL_ID.test(params.id || '')) {
          resolve({ ok: false, error: 'Задание не найдено' })
          return
        }
        const stopped = makeMusafirJob(params.id, 'cancelled', {
          chatId: existing.chatId, mode: existing.mode, text: existing.text,
          summary: 'Задание остановлено', result: 'Задание остановлено'
        })
        if (submittedJobs.has(params.id)) submittedJobs.set(params.id, stopped)
        else demoJobs.set(params.id, stopped)
        resolve({ ...stopped })
        return
      }
      case 'JOB_REPORT': {
        const job = knownJob(params.id)
        const offset = params.offset
        const limit = params.limit
        if (!job || !LOCAL_ID.test(params.id || '') || !Number.isSafeInteger(offset) || offset < 0 ||
            !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
          resolve({ ok: false, error: 'Отчёт не найден' })
          return
        }
        const characters = Array.from(fullReport)
        const text = characters.slice(offset, offset + limit).join('')
        resolve({
          ok: true, id: params.id, offset, text, textLength: characters.length,
          nextOffset: offset + Array.from(text).length < characters.length
            ? offset + Array.from(text).length : null,
          truncated: false
        })
        return
      }
      case 'DIAGNOSTIC':
        resolve({ ok: true })
        return
      case 'ORCA_LIST':
        resolve({ ok: true, workspaces: [demoWorkspace], nextCursor: null })
        return
      case 'ORCA_TERMINALS':
        resolve({ ok: true, terminals: demoTerminals, nextCursor: null })
        return
      case 'ORCA_PAIRS':
        resolve({ ok: true, pairs: [demoPair], nextCursor: null })
        return
      case 'ORCA_BIND':
        resolve({ ok: true, pair: demoPair })
        return
      case 'ORCA_ROOTS':
        resolve({ ok: true, roots: [{ id: 'storage-demo', label: 'Storage · демонстрация' }] })
        return
      case 'ORCA_PRESETS':
        resolve({ ok: true, presets: [{
          id: 'preset-demo', label: 'Codex + Claude', workerAgent: 'codex', reviewerAgent: 'claude'
        }], nextCursor: null })
        return
      case 'ORCA_AGENTS':
        resolve({ ok: true, agents: [
          { id: 'codex', label: 'Codex' },
          { id: 'claude', label: 'Claude Code' }
        ] })
        return
      case 'ORCA_MODELS':
        resolve({ ok: true, models: [
          { id: '', label: 'Настройки Orca' },
          { id: `${params.agent}-demo`, label: `${params.agent} · синтетическая модель` }
        ], nextCursor: null })
        return
      case 'ORCA_PAIR_CREATE':
        resolve({ ok: true, operation: { id: params.id, state: 'completed',
          message: 'Синтетическая связка готова', pair: demoPair } })
        return
      case 'ORCA_AGENT_CREATE':
        resolve({ ok: true, operation: { id: params.id, state: 'completed',
          message: `Синтетический агент ${params.agent} открыт` } })
        return
      case 'ORCA_PROJECT_CREATE':
        resolve({ ok: true, operation: { id: params.id, state: 'queued',
          message: 'Синтетическое создание принято' } })
        return
      case 'ORCA_OPERATION':
        resolve({ ok: true, operation: { id: params.id, state: 'completed',
          message: 'Синтетическая операция завершена',
          workspace: { path: '/local/demo/new-project' }, pair: demoPair } })
        return
      case 'ORCA_LATEST':
        resolve({ ok: true, job: null })
        return
      case 'ORCA_QUICK_LIST':
        resolve({ ok: true, commands: [{ id: 'continue', label: 'Продолжай' }, { id: 'status', label: 'Статус' }], nextCursor: null })
        return
      case 'ORCA_MODES':
        resolve({ ok: true, agent: params.agent, modes: [{ id: '', label: 'Обычный' }, { id: 'auto', label: 'Авто' }, { id: 'bypass', label: 'Без ограничений' }], nextCursor: null })
        return
      case 'ORCA_SEND':
      case 'ORCA_REPLY':
        jobStatusCalls = 0
        resolve({ ok: true, job: { id: params.id, state: 'queued', stage: 'coordinator_starting',
          summary: 'Синтетическая задача принята' } })
        return
      case 'ORCA_JOB':
        if (scenario === 'offline') { reject(new Error('Телефон не ответил')); return }
        if (scenario === 'error') { resolve({ ok: false, error: 'Не удалось получить статус Orca' }); return }
        jobStatusCalls += 1
        if (scenario === 'approval') {
          resolve({ ok: true, job: { id: params.id, state: 'question', stage: 'reviewer_question',
            questionId: '1700000001300-1', question: 'Какой вариант выбрать для синтетической проверки?' } })
          return
        }
        if (scenario === 'job') {
          resolve({ ok: true, job: { id: params.id, state: 'running', stage: 'worker_working',
            summary: 'Синтетический агент работает' } })
          return
        }
        if (scenario === 'result') {
          resolve({ ok: true, job: { id: params.id, state: 'completed', stage: 'completed',
            result: 'Синтетический итог Orca. Откройте полный ответ.', resultLength: Array.from(fullReport).length } })
          return
        }
        resolve(jobStatusCalls < 2
          ? { ok: true, job: { id: params.id, state: 'running', stage: 'worker_working',
            summary: 'Синтетический агент работает' } }
          : { ok: true, job: { id: params.id, state: 'completed', stage: 'completed',
            result: 'Синтетический итог Orca. Реальные команды и процессы не запускались.', nextCursor: null } })
        return
      case 'ORCA_GITHUB_CREATE':
        resolve({ ok: true, operation: { id: params.id, state: 'completed', message: 'Приватный репозиторий создан: https://github.com/demo/demo',
          github: { url: 'https://github.com/demo/demo', existing: false, private: true } } })
        return
      case 'ORCA_ASK':
        jobStatusCalls = 0
        resolve({ ok: true, job: { id: params.id, state: 'queued', stage: 'queued', mode: 'ask', askRole: params.role, summary: 'Вопрос принят' } })
        return
      case 'ORCA_HANDOFF':
        jobStatusCalls = 0
        resolve({ ok: true, job: { id: params.newId, state: 'queued', stage: 'queued', summary: 'Промпт передан боевому' } })
        return
      case 'ORCA_STOP':
        jobStatusCalls = 99
        resolve({ ok: true, job: { id: params.id, state: 'error', stage: 'stopped', error: 'Остановлено с часов' } })
        return
      case 'ORCA_PAUSE':
        resolve({ ok: true, job: { id: params.id, state: 'running',
          stage: params.paused ? 'paused' : 'worker_working' } })
        return
      case 'CLAUDE_PROJECTS':
      case 'CODEX_PROJECTS':
        resolve({ ok: true, projects: [{ id: '/local/demo', label: 'Демо проект' }], nextCursor: null })
        return
      case 'CLAUDE_MODES':
      case 'CODEX_MODES':
        resolve({ ok: true, modes: [{ id: 'auto', label: 'Авто' }, { id: 'read-only', label: 'Только чтение' }], nextCursor: null })
        return
      case 'CLAUDE_SESSIONS':
      case 'CODEX_SESSIONS':
        resolve({ ok: true, sessions: [{ id: 'session-demo', label: 'Синтетическая сессия' }], nextCursor: null })
        return
      case 'CLAUDE_LATEST':
      case 'CODEX_LATEST':
      case 'CLAUDE_JOB':
      case 'CODEX_JOB': {
        if (scenario === 'offline') { reject(new Error('Телефон не ответил')); return }
        if (scenario === 'error') { resolve({ ok: false, error: `Не удалось получить статус ${PROFILES[appKind].title}` }); return }
        if (scenario === 'compose' || scenario === 'ready' || scenario === 'review') {
          resolve({ ok: true, job: null }); return
        }
        const id = params.id || RESULT_JOB_ID
        if (scenario === 'approval') {
          resolve({ ok: true, job: { id, state: 'approval', result: '', resultLength: 0,
            approval: { id: '1700000001300-1', text: 'Разрешить синтетическое действие?',
              question: 'Как продолжить?', options: ['Разрешить', 'Отклонить'] } } })
          return
        }
        if (scenario === 'job') {
          resolve({ ok: true, job: { id, state: 'running', result: '', resultLength: 0 } }); return
        }
        resolve({ ok: true, job: { id, state: 'completed',
          result: `Синтетический итог ${PROFILES[appKind].title}. Откройте полный ответ.`,
          resultLength: Array.from(fullReport).length, sessionId: 'session-demo' } })
        return
      }
      case 'CLAUDE_SEND':
      case 'CODEX_SEND':
        resolve({ ok: true, job: { id: params.id, state: 'completed',
          result: `Синтетический итог ${PROFILES[appKind].title}.`,
          resultLength: Array.from(fullReport).length, sessionId: 'session-demo' } })
        return
      case 'CLAUDE_APPROVE':
      case 'CODEX_APPROVE':
        resolve({ ok: true, job: { id: params.id, state: params.allow ? 'completed' : 'error',
          result: params.allow ? 'Синтетическое действие разрешено.' : '',
          error: params.allow ? '' : 'Действие отклонено', resultLength: params.allow ? Array.from(fullReport).length : 0 } })
        return
      case 'CLAUDE_STOP':
      case 'CODEX_STOP':
        resolve({ ok: true, job: { id: params.id, state: 'error', error: 'Остановлено с часов', resultLength: 0 } })
        return
      case 'CLAUDE_HISTORY_LIST':
      case 'CODEX_HISTORY_LIST': {
        const items = historyDemo.filter(x => x.deleted === params.trash)
        resolve({ ok: true, items: items.slice(params.offset, params.offset + params.limit), hasMore: items.length > params.offset + params.limit })
        return
      }
      case 'CLAUDE_HISTORY_DETAIL':
      case 'CODEX_HISTORY_DETAIL': {
        const entry = historyDemo.find(x => x.id === params.id)
        if (!entry || !['text', 'result'].includes(params.field)) { resolve({ ok: false, error: 'Запись не найдена' }); return }
        const chars = Array.from(entry[params.field])
        const content = chars.slice(params.offset, params.offset + params.limit).join('')
        resolve({ ok: true, ...entry, field: params.field, offset: params.offset, content,
          total: chars.length, complete: params.offset + Array.from(content).length >= chars.length })
        return
      }
      case 'CLAUDE_HISTORY_SET_DELETED':
      case 'CODEX_HISTORY_SET_DELETED': {
        const entry = historyDemo.find(x => x.id === params.id)
        if (!entry) { resolve({ ok: false, error: 'Запись не найдена' }); return }
        entry.deleted = params.deleted
        resolve({ ok: true, id: entry.id, deleted: entry.deleted })
        return
      }
      case 'CLAUDE_HISTORY_EMPTY_TRASH':
      case 'CODEX_HISTORY_EMPTY_TRASH': {
        const removed = historyDemo.filter(x => x.deleted).length
        historyDemo.forEach(x => { if (x.deleted) x.deleted = false })
        resolve({ ok: true, removed })
        return
      }
      case 'SUMMARY':
        if (scenario === 'offline' || scenario === 'home-error') { reject(new Error('Телефон не ответил')); return }
        resolve({ ok: true, text: `${PROFILES[appKind].title}: синтетическая среда готова` })
        return
      default:
        resolve({ ok: false, error: `Неизвестный локальный метод: ${payload.method}` })
    }
  }, delay))
}

const media = {
  RECORDER: 'recorder',
  create() {
    let fileName = ''
    let startedAt = 0
    return {
      setFormat(_codec, options) {
        fileName = String(options?.target_file || '').replace(/^data:\/\//, '')
        return Boolean(fileName)
      },
      start() { startedAt = Date.now(); return true },
      stop() {
        const duration = Math.max(700, Date.now() - startedAt)
        const size = Math.min(18 * 1024, Math.max(7 * 1024, Math.round(duration * 3.2)))
        const bytes = new Uint8Array(size)
        for (let index = 0; index < size; index += 1) bytes[index] = (index * 17 + 43) % 256
        files.set(fileName, bytes)
        return true
      }
    }
  }
}

function instantiatePage(definition) {
  currentPage = Object.assign(Object.create(definition), definition)
  currentPage.build()
}

function openSyncMock({ path }) {
  if (!files.has(path)) return undefined
  const fd = nextFileDescriptor++
  fileHandles.set(fd, path)
  return fd
}

function readSyncMock({ fd, buffer, options = {} }) {
  const bytes = files.get(fileHandles.get(fd))
  if (!bytes) return 0
  const offset = options.offset || 0
  const position = options.position || 0
  const length = Math.min(options.length ?? buffer.byteLength, bytes.byteLength - position)
  if (length <= 0) return 0
  new Uint8Array(buffer).set(bytes.subarray(position, position + length), offset)
  return length
}

function closeSyncMock({ fd }) {
  fileHandles.delete(fd)
  return 0
}

function localReplace({ url }) {
  navigate(url).catch(error => console.error('[preview] replace', error))
}

function executableSource(source, exportedFactory) {
  const clean = source.replace(/^\s*import\s+[\s\S]*?\s+from\s+['"][^'"]+['"]\s*;?\s*$/gm, '')
  return exportedFactory
    ? clean.replace(`export function ${exportedFactory}`, `function ${exportedFactory}`)
    : clean.replace(/^\s*export\s+/gm, '')
}

function evaluatePage(source, sourcePath) {
  let prefix = ''
  if (sourcePath === 'page/index') {
    prefix = executableSource(pageSources.get('shared/musafir-page'), 'createMusafirPage')
  } else if (sourcePath === 'page/claude' || sourcePath === 'page/codex') {
    prefix = executableSource(pageSources.get('shared/agent-menu'), 'createAgentMenuPage')
  } else if (sourcePath.startsWith('page/voice')) {
    prefix = executableSource(pageSources.get('shared/watch-alerts'), 'createWatchAlerts') + '\n' +
      executableSource(pageSources.get('shared/voice-page'), 'createVoicePage')
  } else if (sourcePath === 'page/report') {
    prefix = executableSource(pageSources.get('shared/musafir-report-page'), 'createMusafirReportPage')
  } else if (sourcePath.startsWith('page/history')) {
    prefix = executableSource(pageSources.get('shared/history-page'), 'createHistoryPage')
  }
  const executable = `${prefix}\n${executableSource(source)}`
  const names = [
    'textRows', 'createWidget', 'widget', 'align', 'text_style', 'prop', 'event', 'getTextLayout', 'setStatusBarVisible',
    'getDeviceInfo', 'setTimeout', 'clearTimeout', 'codec', 'create', 'mediaId',
    'closeSync', 'openSync', 'O_RDONLY', 'readSync', 'rmSync', 'statSync',
    'BasePage', 'MAX_AUDIO_BYTES', 'createWatchClient', 'createFolderVoiceRoute',
    'createOrcaVoiceRoute', 'createClaudeVoiceRoute', 'createCodexVoiceRoute',
    'createMusafirVoiceRoute', 'normalizeContext', 'heroById',
    'MUSAFIR_HEROES', 'MUSAFIR_CONTEXT_KEY', 'MUSAFIR_HERO_KEY',
    'replace', 'routerBack', 'Page', 'LocalStorage', 'setWakeUpRelaunch',
    'setPageBrightTime', 'resetPageBrightTime', 'pauseDropWristScreenOff',
    'resetDropWristScreenOff', 'Vibrator', 'VIBRATOR_SCENE_SHORT_STRONG', 'keyboardUI',
    'deleteWidget', 'interaction', 'onGesture', 'offGesture', 'onKey', 'offKey',
    'GESTURE_RIGHT', 'KEY_BACK', 'KEY_EVENT_CLICK'
  ]
  const values = [
    textRows, createWidget, widget, align, text_style, prop, { CLICK_UP: 'click' }, getTextLayout,
    visible => { document.querySelector('.os-header').hidden = !visible },
    () => setWatchGeometry(),
    window.setTimeout.bind(window), window.clearTimeout.bind(window),
    { OPUS: 'opus' }, media.create, media.RECORDER,
    closeSyncMock, openSyncMock, 0, readSyncMock, ({ path: file }) => files.delete(file),
    ({ path: file }) => ({ size: files.get(file)?.byteLength || 0 }),
    definition => ({ request: localRequest, ...definition }),
    MAX_AUDIO_BYTES, createWatchClient, createFolderVoiceRoute, createOrcaVoiceRoute,
    createClaudeVoiceRoute, createCodexVoiceRoute, createMusafirVoiceRoute,
    normalizeContext, heroById, MUSAFIR_HEROES,
    MUSAFIR_CONTEXT_KEY, MUSAFIR_HERO_KEY,
    localReplace, () => navigate('page/index'), instantiatePage,
    class {
      getItem(key) { return storage.has(key) ? storage.get(key) : null }
      setItem(key, value) { storage.set(key, value) }
    },
    () => {}, () => {}, () => {}, () => {}, () => {},
    class { start({ mode }) { console.log('[preview] simulated vibration:', mode) } stop() {} }, 'short-strong', keyboardUI,
    deleteWidget, interaction, interaction.onGesture, interaction.offGesture, interaction.onKey, interaction.offKey,
    interaction.GESTURE_RIGHT, interaction.KEY_BACK, interaction.KEY_EVENT_CLICK
  ]
  new Function(...names, `${executable}\n//# sourceURL=/${sourcePath}.js`)(...values)
}

function destroyPage() {
  session += 1
  try { currentPage?.onDestroy?.() } catch (error) { console.warn('[preview] destroy', error) }
  currentPage = null
  gestureCallback = null
  keyCallback = null
  fileHandles.clear()
  widgets.splice(0)
  layer.replaceChildren()
  document.querySelector('.os-header').hidden = false
}

async function navigate(path) {
  const profile = PROFILES[appKind]
  const sourcePath = path === 'page/index' ? profile.menu
    : path === 'page/voice' ? profile.voice
      : path === 'page/history' ? profile.history : path
  const source = pageSources.get(sourcePath)
  if (!source) throw new Error(`Нет страницы ${path}`)
  destroyPage()
  currentPath = path
  lastState = {
    phase: ['page/orca', 'page/claude', 'page/codex'].includes(sourcePath) ? 'menu'
      : sourcePath === 'page/index' ? 'home'
        : sourcePath === 'page/report' ? 'report' : 'booting'
  }
  evaluatePage(source, sourcePath)
  observeState()
  updateSnapshot()
}

function waitFor(check, timeout = 2500) {
  return new Promise(resolve => {
    const started = Date.now()
    const poll = () => {
      if (check() || Date.now() - started >= timeout) resolve()
      else setTimeout(poll, 30)
    }
    poll()
  })
}

function waitForPhase(phase, timeout = 2500) {
  return waitFor(() => lastState.phase === phase, timeout)
}

function observeState() {
  if (!currentPage?.client) return
  const originalRender = currentPage.render.bind(currentPage)
  currentPage.render = state => {
    lastState = { ...state }
    originalRender(state)
    updateSnapshot()
  }
  lastState = currentPage.client.getState()
  updateSnapshot()
}

function resetSyntheticRuntime() {
  files.clear()
  fileHandles.clear()
  uploads.clear()
  textDrafts.clear()
  submittedJobs.clear()
  submittedChats.clear()
  archivedChats.clear()
  demoJobs.clear()
  demoJobs.set(RESULT_JOB_ID, scenarios.result)
  demoJobs.set(OLDER_JOB_ID, makeMusafirJob(OLDER_JOB_ID, 'completed', {
    chatId: OTHER_CHAT_ID, mode: 'research', text: 'Собери идеи для поездки.', summary: 'План готов'
  }))
  demoJobs.set(RUNNING_JOB_ID, scenarios.job)
  demoJobs.set(APPROVAL_JOB_ID, scenarios.approval)
  const hero = storage.get(MUSAFIR_HERO_KEY)
  storage.clear()
  if (hero) storage.set(MUSAFIR_HERO_KEY, hero)
  historyDemo.forEach(item => { item.deleted = false })
}

function musafirContext({ chatId = CHAT_ID, mode = 'task', jobId = null, openJob = false, autoRecord = false } = {}) {
  return { target: 'musafir', chatId, mode, jobId, openJob, autoRecord }
}

function seedMusafirScenario(name) {
  if (name === 'history') {
    storage.set('musafir-history-view', JSON.stringify({
      screen: 'detail', id: RESULT_JOB_ID, field: 'result', offset: 0
    }))
    storage.set('musafir-resume', 'history')
    return 'page/history'
  }
  if (name === 'review') {
    storage.set(MUSAFIR_CONTEXT_KEY, JSON.stringify(musafirContext()))
    storage.set('pending-audio', JSON.stringify({
      id: REVIEW_AUDIO_ID, fileName: 'musafir-review.opus', totalBytes: 8192, accepted: true,
      destinationKey: `voice-draft:musafir:${CHAT_ID}`
    }))
    return 'page/voice'
  }
  if (name === 'recording' || name === 'compose') {
    storage.set(MUSAFIR_CONTEXT_KEY, JSON.stringify(musafirContext({
      chatId: null, autoRecord: false
    })))
    return 'page/voice'
  }
  if (name === 'job') {
    storage.set(MUSAFIR_CONTEXT_KEY, JSON.stringify(musafirContext({
      jobId: RUNNING_JOB_ID, openJob: true
    })))
    return 'page/voice'
  }
  if (name === 'approval') {
    storage.set(MUSAFIR_CONTEXT_KEY, JSON.stringify(musafirContext({
      jobId: APPROVAL_JOB_ID, openJob: true
    })))
    return 'page/voice'
  }
  if (name === 'result' || name === 'report') {
    storage.set(MUSAFIR_CONTEXT_KEY, JSON.stringify(musafirContext({
      jobId: RESULT_JOB_ID, openJob: true
    })))
    if (name === 'report') {
      storage.set('musafir-report-job', RESULT_JOB_ID)
      return 'page/report'
    }
    return 'page/voice'
  }
  if (name === 'offline') {
    storage.set(MUSAFIR_CONTEXT_KEY, JSON.stringify(musafirContext({ jobId: RESULT_JOB_ID, openJob: true })))
    return 'page/voice'
  }
  if (name === 'error') {
    storage.set(MUSAFIR_CONTEXT_KEY, JSON.stringify(musafirContext({
      jobId: RESULT_JOB_ID, openJob: true
    })))
    return 'page/voice'
  }
  if (name === 'uploading' || name === 'transcribing') {
    storage.set(MUSAFIR_CONTEXT_KEY, JSON.stringify(musafirContext()))
    return 'page/voice'
  }
  return 'page/index'
}

function destinationForProfile(name) {
  if (appKind === 'orca') {
    return {
      target: 'orca', pairId: demoPair.id, label: demoPair.projectLabel,
      workerAgent: demoPair.workerAgent, reviewerAgent: demoPair.reviewerAgent,
      jobId: ['approval', 'job', 'result', 'offline', 'error'].includes(name) ? RESULT_JOB_ID : null,
      aliasId: RESULT_JOB_ID, resumeJob: ['approval', 'job', 'result', 'offline', 'error'].includes(name),
      startFresh: !['approval', 'job', 'result', 'offline', 'error'].includes(name)
    }
  }
  return {
    target: appKind, project: '/local/demo', label: 'Демо проект', mode: 'auto', modeLabel: 'Авто',
    jobId: ['approval', 'job', 'result', 'offline', 'error'].includes(name) ? RESULT_JOB_ID : null,
    aliasId: RESULT_JOB_ID, resumeJob: ['approval', 'job', 'result', 'offline', 'error'].includes(name),
    startFresh: !['approval', 'job', 'result', 'offline', 'error'].includes(name)
  }
}

function destinationDraftKey(destination) {
  return `voice-draft:${destination.target}:${destination.pairId || destination.project || destination.rootId}:${destination.sessionId || ''}`
}

function seedAgentScenario(name) {
  if (['ready', 'heroes', 'home-error'].includes(name)) return 'page/index'
  const destination = destinationForProfile(name)
  storage.set('voice-destination', JSON.stringify(destination))
  if (name === 'review') {
    storage.set('pending-audio', JSON.stringify({
      id: REVIEW_AUDIO_ID, fileName: `${appKind}-review.opus`, totalBytes: 8192, accepted: true,
      destinationKey: destinationDraftKey(destination)
    }))
  }
  if (name === 'history' || name === 'report') {
    if (appKind === 'orca') storage.set('orca-history-pair', JSON.stringify(demoPair))
    storage.set(`${appKind}-history-view`, JSON.stringify({
      screen: 'detail', id: RESULT_JOB_ID, field: 'result', offset: 0
    }))
    storage.set(`${appKind}-resume`, JSON.stringify({ screen: 'history' }))
    return 'page/history'
  }
  return 'page/voice'
}

async function rebuild(nextScenario) {
  destroyPage()
  scenario = nextScenario
  audioStatusCalls = 0
  jobStatusCalls = 0
  resetSyntheticRuntime()
  setWatchGeometry()
  await navigate(appKind === 'musafir' ? seedMusafirScenario(nextScenario) : seedAgentScenario(nextScenario))
  const expectedPhase = {
    ready: appKind === 'musafir' ? 'home' : 'menu',
    compose: 'ready', recording: 'ready', uploading: 'ready', transcribing: 'ready',
    review: 'review', approval: 'approval', job: 'job', result: 'result',
    report: appKind === 'musafir' ? 'report' : 'history', history: 'history',
    offline: 'error', error: 'error'
  }[nextScenario]
  if (expectedPhase === 'home') {
    await waitFor(() => currentPath === 'page/index' && currentPage && currentPage.items && currentPage.items.length > 0, 1800)
  } else if (expectedPhase === 'report') {
    await waitFor(() => currentPath === 'page/report' && currentPage && currentPage.loading === false, 1800)
  } else if (expectedPhase === 'history') {
    await waitFor(() => currentPath === 'page/history' && currentPage && currentPage.reading === false, 5000)
  } else if (expectedPhase) {
    await waitForPhase(expectedPhase, nextScenario === 'review' ? 3200 : 1800)
  }
}

async function previewShow(name = 'ready') {
  if (!select.querySelector(`option[value="${CSS.escape(name)}"]`)) name = 'ready'
  select.value = name

  if (name === 'recording') {
    await rebuild('recording')
    await waitForPhase('ready')
    currentPage.startRecording()
    // ponytail: one honest demo offset makes the timer and pulse visible immediately.
    if (currentPage.recording) {
      currentPage.recording.startedAt = Date.now() - 7000
      const page = currentPage
      page.clearRecordTimer()
      page.recordTimer = setTimeout(() => page.stopRecording(true), 293000)
      currentPage.clearAnimation?.()
      currentPage.animate?.()
    }
    return window.previewState()
  }
  if (name === 'heroes' && appKind === 'musafir') {
    await rebuild('ready')
    currentPage.heroPicker()
    return window.previewState()
  }
  if (name === 'uploading' || name === 'transcribing') {
    await rebuild(name)
    await waitForPhase('ready')
    currentPage.client.close()
    const state = name === 'uploading'
      ? { phase: 'uploading', id: REVIEW_AUDIO_ID, sentBytes: 6349, totalBytes: 10240, busy: true }
      : { phase: 'transcribing', id: REVIEW_AUDIO_ID, busy: true }
    lastState = state
    currentPage.render(state)
    updateSnapshot()
    return window.previewState()
  }
  await rebuild(name)
  return window.previewState()
}

window.previewShow = previewShow
window.previewState = () => ({
  scenario,
  page: currentPath,
  state: { ...lastState },
  widgets: widgets.map(({ type, options, node }) => ({
    type,
    ...options,
    ...(type === widget.IMG ? { currentSrc: node.currentSrc || node.src || '' } : {})
  }))
})

select.addEventListener('change', () => previewShow(select.value))
geometrySelect.addEventListener('change', () => previewShow(select.value))
document.querySelector('#hardware-back').addEventListener('click', () => {
  keyCallback?.(interaction.KEY_BACK, interaction.KEY_EVENT_CLICK)
})
document.querySelector('#reopen').addEventListener('click', () => navigate(currentPath))
let pointerStart = null
screen.addEventListener('pointerdown', event => { pointerStart = { x: event.clientX, y: event.clientY } })
screen.addEventListener('pointerup', event => {
  if (pointerStart && event.clientX - pointerStart.x > 70 && Math.abs(event.clientY - pointerStart.y) < 60) {
    gestureCallback?.(interaction.GESTURE_RIGHT)
  }
  pointerStart = null
})
appSelect.addEventListener('change', async () => {
  appKind = Object.prototype.hasOwnProperty.call(PROFILES, appSelect.value) ? appSelect.value : 'musafir'
  appName.textContent = PROFILES[appKind].title
  scenario = 'ready'
  select.value = 'ready'
  destroyPage()
  resetSyntheticRuntime()
  setWatchGeometry()
  await navigate('page/index')
})
window.addEventListener('beforeunload', destroyPage)
setInterval(updateClock, 1000)
updateClock()

try {
  const sources = await Promise.all([
    'page/index', 'page/voice', 'page/report', 'page/orca', 'page/claude', 'page/codex', 'page/history',
    'shared/voice-page', 'shared/watch-alerts', 'shared/history-page', 'shared/agent-menu',
    'shared/musafir-page', 'shared/musafir-report-page'
  ].map(async path => {
    const response = await fetch(`/${path}.js`, { cache: 'no-store' })
    if (!response.ok) throw new Error(`${path}.js: HTTP ${response.status}`)
    return [path, await response.text()]
  }))
  for (const [path, source] of sources) pageSources.set(path, source)
  pageSources.set('page/voice-orca', `Page(BasePage(createVoicePage({
    kind: 'orca', icon: 'orca-mark.png', title: 'Orca', version: '0.4.0'
  })))`)
  pageSources.set('page/voice-claude', "Page(BasePage(createVoicePage({ kind: 'claude', icon: 'claude-mark.png', title: 'Claude', version: '0.2.0' })))")
  pageSources.set('page/voice-codex', "Page(BasePage(createVoicePage({ kind: 'codex', icon: 'codex-mark.png', title: 'Codex', version: '0.2.0' })))")
  pageSources.set('page/history-orca', "Page(BasePage(createHistoryPage({ kind: 'orca' })))")
  pageSources.set('page/history-claude', "Page(BasePage(createHistoryPage({ kind: 'claude' })))")
  pageSources.set('page/history-codex', "Page(BasePage(createHistoryPage({ kind: 'codex' })))")
  setWatchGeometry()
  await previewShow('ready')
} catch (error) {
  console.error(error)
  layer.innerHTML = `<div class="preview-fatal">Не удалось открыть page/index.js<br>${String(error.message || error)}</div>`
}
