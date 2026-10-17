import { MAX_AUDIO_BYTES, createWatchClient } from '/shared/watch-client.js'
import { createFolderVoiceRoute, createOrcaVoiceRoute } from '/shared/orca-voice.js'

const screen = document.querySelector('#watch-screen')
const layer = document.querySelector('#widget-layer')
const select = document.querySelector('#state-select')
const appSelect = document.querySelector('#app-select')
const appName = document.querySelector('#app-name')
const timeNode = document.querySelector('#watch-time')
const snapshot = document.querySelector('#snapshot')

const widget = Object.freeze({ FILL_RECT: 'fill', TEXT: 'text', BUTTON: 'button', IMG: 'image' })
const align = Object.freeze({ LEFT: 'left', RIGHT: 'right', CENTER_H: 'center-h', TOP: 'top', BOTTOM: 'bottom', CENTER_V: 'center-v' })
const text_style = Object.freeze({ WRAP: 'wrap' })
const prop = Object.freeze({ TEXT: 'text', MORE: 'more', VISIBLE: 'visible', COLOR: 'color' })
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
const historyDemo = [0, 1, 2, 3].map(i => ({
  id: `170000000000${i}-1`, created: 1700000000 - i * 3600, state: 'completed', deleted: false,
  text: ['Покажи мой план на сегодня', 'Что мы обсуждали вчера?', 'Подготовь список дел', 'Напомни мой вопрос'][i],
  result: 'Это пример сохранённого ответа для просмотра интерфейса. '.repeat(15)
}))

const scenarios = {
  ready: null,
  review: {
    id: '1700000000000-1', state: 'ready',
    text: 'Проверь состояние проекта. Исправь две опечатки в названии экрана. Перед началом покажи, что задание принято. После выполнения пришли результат на часы. '.repeat(3)
  },
  approval: {
    id: 'demo-job-1', state: 'approval', text: 'Показываю план без изменений.',
    approval: { id: 'demo-approval-1', text: 'Разрешить демонстрационное действие: показать план на сегодня без изменений?' }
  },
  job: { id: 'demo-job-1', state: 'running', text: 'Проверяю запланированные дела. Ничего не изменяю.' },
  result: {
    id: 'demo-job-1', state: 'completed', text: 'Покажи мой план на сегодня и ничего не меняй.',
    result: 'Сегодня в плане три пункта. В 10:00 проверить входящие сообщения. В 13:30 подготовить заметки к встрече. В 18:00 подвести итоги дня. Я ничего не менял и не отправлял. Можно открыть любой пункт для чтения, но в этой демонстрации файлы, задачи и сообщения остаются без изменений. Длинный ответ листается стрелками на экране часов.'
  }
}

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
  return `/assets/common.s/${raw.split('/').pop()}`
}

function applyGeometry(node, options) {
  for (const key of ['x', 'y', 'w', 'h']) {
    if (Number.isFinite(options[key])) {
      const css = { x: 'left', y: 'top', w: 'width', h: 'height' }[key]
      node.style[css] = `${options[key]}px`
    }
  }
}

function applyWidget(record) {
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
  }
}

function createWidget(type, initial = {}) {
  const node = document.createElement(type === widget.BUTTON ? 'button' : type === widget.IMG ? 'img' : 'div')
  node.className = `zepp-widget zepp-${type}`
  const record = {
    type,
    node,
    options: { ...initial },
    setProperty(property, value) {
      if (property === prop.MORE && value && typeof value === 'object') Object.assign(this.options, value)
      else this.options[property] = value
      applyWidget(this)
      updateSnapshot()
    }
  }
  if (type === widget.BUTTON) node.addEventListener('click', () => record.options.click_func?.())
  node.addEventListener('error', () => { if (type === widget.IMG) node.style.visibility = 'hidden' })
  node.addEventListener('load', () => { if (type === widget.IMG) node.style.visibility = '' })
  widgets.push(record)
  layer.append(node)
  applyWidget(record)
  return record
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

function localRequest(payload) {
  const ownSession = session
  const delay = payload.method === 'AUDIO_CHUNK' ? 105 : 220
  return new Promise((resolve, reject) => setTimeout(() => {
    if (ownSession !== session) { reject(new Error('CANCELED')); return }
    const params = payload.params || {}
    switch (payload.method) {
      case 'HISTORY_LIST': {
        const items = historyDemo.filter(x => x.deleted === params.trash)
        resolve({ ok: true, items: items.slice(params.offset, params.offset + params.limit), hasMore: items.length > params.offset + params.limit })
        return
      }
      case 'HISTORY_DETAIL': {
        const entry = historyDemo.find(x => x.id === params.id)
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
        textDrafts.set(params.id, params.textLength)
        resolve({ ok: true, id: params.id, state: 'uploading', textLength: params.textLength, receivedLength: 0 }); return
      case 'TEXT_PART':
        resolve({ ok: true, id: params.id, textLength: textDrafts.get(params.id), receivedLength: params.offset + Array.from(params.text).length }); return
      case 'TEXT_FINISH':
        resolve({ ok: true, id: params.id, state: 'ready', textLength: textDrafts.get(params.id) }); return
      case 'LATEST_JOB':
        if (scenario === 'error') { resolve({ ok: false, error: 'Не удалось прочитать запись' }); return }
        resolve({ ok: true, job: scenarios[scenario] ?? null })
        return
      case 'AUDIO_BEGIN':
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
        audioStatusCalls = 0
        resolve({ ok: true, id: params.id, state: 'transcribing' })
        return
      case 'AUDIO_STATUS':
        audioStatusCalls += 1
        if (audioStatusCalls < 2) {
          resolve({ ok: true, id: params.id, state: 'transcribing', text: '',
            textOffset: 0, textLength: 0, textComplete: true })
          return
        }
        {
          const characters = Array.from(scenarios.review.text)
          const offset = params.textOffset || 0
          const page = characters.slice(offset, offset + (params.textLimit || 1000)).join('')
          resolve({ ok: true, id: params.id, state: 'ready', text: page,
            textOffset: offset, textLength: characters.length,
            textComplete: offset + Array.from(page).length === characters.length })
        }
        return
      case 'SEND_TEXT':
        jobStatusCalls = 0
        resolve({ ok: true, id: params.id, state: 'queued', text: 'Команда принята в локальную демонстрацию.' })
        return
      case 'JOB_STATUS':
        if (scenario === 'job') {
          resolve({ ok: true, ...scenarios.job, id: params.id })
          return
        }
        jobStatusCalls += 1
        resolve(jobStatusCalls < 2
          ? { ok: true, id: params.id, state: 'running', text: 'Проверяю план. Ничего не изменяю.' }
          : { ok: true, id: params.id, state: 'approval', text: scenarios.approval.text, approval: scenarios.approval.approval })
        return
      case 'JOB_APPROVE':
        resolve({
          ok: true, id: params.id, state: 'completed', text: scenarios.review.text,
          result: params.allow ? scenarios.result.result : 'Действие отклонено. Изменений нет.'
        })
        return
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
        jobStatusCalls += 1
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

function evaluatePage(source, path) {
  const factory = pageSources.get('shared/watch-alerts').replace('export function createWatchAlerts', 'function createWatchAlerts') + '\n' + pageSources.get('shared/voice-page')
  const prefix = path === 'page/index' || path === 'page/voice'
    ? factory.replace(/^\s*import\s+.*$/gm, '').replace('export function createVoicePage', 'function createVoicePage')
    : path === 'page/history'
      ? pageSources.get('shared/history-page').replace(/^\s*import\s+.*$/gm, '').replace('export function createHistoryPage', 'function createHistoryPage')
      : ''
  const executable = `${prefix}\n${source.replace(/^\s*import\s+.*$/gm, '')}`
  const names = [
    'createWidget', 'widget', 'align', 'text_style', 'prop', 'getTextLayout',
    'getDeviceInfo', 'setTimeout', 'clearTimeout', 'codec', 'create', 'mediaId',
    'closeSync', 'openSync', 'O_RDONLY', 'readSync', 'rmSync', 'statSync',
    'BasePage', 'MAX_AUDIO_BYTES', 'createWatchClient', 'createFolderVoiceRoute',
    'createOrcaVoiceRoute', 'replace', 'Page', 'LocalStorage', 'setWakeUpRelaunch',
    'setPageBrightTime', 'resetPageBrightTime', 'pauseDropWristScreenOff',
    'resetDropWristScreenOff', 'Vibrator', 'VIBRATOR_SCENE_SHORT_STRONG', 'keyboardUI'
  ]
  const values = [
    createWidget, widget, align, text_style, prop, getTextLayout,
    () => ({ width: 390, height: 450 }), window.setTimeout.bind(window), window.clearTimeout.bind(window),
    { OPUS: 'opus' }, media.create, media.RECORDER,
    closeSyncMock, openSyncMock, 0, readSyncMock, ({ path: file }) => files.delete(file),
    ({ path: file }) => ({ size: files.get(file)?.byteLength || 0 }),
    definition => ({ request: localRequest, ...definition }),
    MAX_AUDIO_BYTES, createWatchClient, createFolderVoiceRoute, createOrcaVoiceRoute,
    localReplace, instantiatePage,
    class {
      getItem(key) { return storage.get(key) }
      setItem(key, value) { storage.set(key, value) }
    },
    () => {}, () => {}, () => {}, () => {}, () => {},
    class { start({ mode }) { console.log('[preview] simulated vibration:', mode) } stop() {} }, 'short-strong', keyboardUI
  ]
  new Function(...names, `${executable}\n//# sourceURL=/${path}.js`)(...values)
}

function destroyPage() {
  session += 1
  try { currentPage?.onDestroy?.() } catch (error) { console.warn('[preview] destroy', error) }
  currentPage = null
  files.clear()
  fileHandles.clear()
  widgets.splice(0)
  layer.replaceChildren()
}

async function navigate(path) {
  const sourcePath = appKind === 'orca' && path === 'page/index' ? 'page/orca'
    : appKind === 'orca' && path === 'page/history' ? 'page/history-orca' : path
  const source = pageSources.get(sourcePath)
  if (!source) throw new Error(`Нет страницы ${path}`)
  destroyPage()
  currentPath = path
  lastState = { phase: sourcePath === 'page/orca' ? 'menu' : 'booting' }
  evaluatePage(source, path)
  observeState()
  updateSnapshot()
}

function waitForPhase(phase, timeout = 2500) {
  return new Promise(resolve => {
    const started = Date.now()
    const check = () => {
      if (lastState.phase === phase || Date.now() - started >= timeout) resolve()
      else setTimeout(check, 30)
    }
    check()
  })
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

async function rebuild(nextScenario) {
  scenario = nextScenario
  audioStatusCalls = 0
  jobStatusCalls = 0
  uploads.clear()
  if (appKind === 'orca') {
    storage.set('voice-destination', JSON.stringify({
      target: 'orca', pairId: demoPair.id, label: demoPair.projectLabel,
      workerAgent: demoPair.workerAgent, reviewerAgent: demoPair.reviewerAgent
    }))
    await navigate('page/voice')
  } else {
    storage.set('voice-destination', '')
    await navigate('page/index')
  }
  const expectedPhase = {
    ready: 'ready', review: 'review', approval: 'approval', job: 'job',
    result: 'result', offline: 'error', error: 'error'
  }[nextScenario]
  await waitForPhase(expectedPhase, 1200)
}

async function previewShow(name = 'ready') {
  if (!select.querySelector(`option[value="${CSS.escape(name)}"]`)) name = 'ready'
  select.value = name

  if (name === 'recording') {
    await rebuild('ready')
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
  if (name === 'uploading' || name === 'transcribing') {
    await rebuild('ready')
    await waitForPhase('ready')
    currentPage.client.close()
    const state = name === 'uploading'
      ? { phase: 'uploading', id: '1700000000000-1', sentBytes: 6349, totalBytes: 10240, busy: true }
      : { phase: 'transcribing', id: '1700000000000-1', busy: true }
    lastState = state
    currentPage.render(state)
    updateSnapshot()
    return window.previewState()
  }
  if (name === 'result') {
    await rebuild(name)
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
  widgets: widgets.map(({ type, options }) => ({ type, ...options }))
})

select.addEventListener('change', () => previewShow(select.value))
appSelect.addEventListener('change', async () => {
  appKind = appSelect.value === 'orca' ? 'orca' : 'musafir'
  appName.textContent = appKind === 'orca' ? 'Orca' : 'Мусафир'
  scenario = 'ready'
  select.value = 'ready'
  storage.set('voice-destination', '')
  await navigate('page/index')
})
window.addEventListener('beforeunload', destroyPage)
setInterval(updateClock, 1000)
updateClock()

try {
  const sources = await Promise.all(['page/index', 'page/orca', 'page/history', 'shared/voice-page', 'shared/watch-alerts', 'shared/history-page'].map(async path => {
    const response = await fetch(`/${path}.js`, { cache: 'no-store' })
    if (!response.ok) throw new Error(`${path}.js: HTTP ${response.status}`)
    return [path, await response.text()]
  }))
  for (const [path, source] of sources) pageSources.set(path, source)
  pageSources.set('page/voice', `Page(BasePage(createVoicePage({
    kind: 'orca', icon: 'orca-mark.png', title: 'Orca', version: '0.3.7'
  })))`)
  pageSources.set('page/history-orca', "Page(BasePage(createHistoryPage({ kind: 'orca' })))")
  await previewShow('ready')
} catch (error) {
  console.error(error)
  layer.innerHTML = `<div class="preview-fatal">Не удалось открыть page/index.js<br>${String(error.message || error)}</div>`
}
