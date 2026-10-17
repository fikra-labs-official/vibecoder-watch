import { createWidget, widget, align, text_style, prop, getTextLayout, setStatusBarVisible } from '@zos/ui'
import { getDeviceInfo } from '@zos/device'
import { replace } from '@zos/router'
import { LocalStorage } from '@zos/storage'
import { setTimeout, clearTimeout } from '@zos/timer'
import {
  onGesture, offGesture, GESTURE_RIGHT,
  onKey, offKey, KEY_BACK, KEY_EVENT_CLICK
} from '@zos/interaction'

const LOCAL_ID = /^\d{1,16}-\d{1,8}$/
const CONTEXT_KEY = 'musafir-context'
const RETURN_KEY = 'musafir-return-view'
const REPORT_KEY = 'musafir-report-job'
const COLOR = {
  bg: 0x080b0f,
  surface: 0x171d25,
  gold: 0xf0be75,
  white: 0xf3f6fa,
  muted: 0xa8b3c3,
  pressed: 0x26313e
}

function splitText(text, fits) {
  const chars = Array.from(text)
  const pages = []
  let offset = 0
  while (offset < chars.length) {
    let low = 1, high = Math.min(600, chars.length - offset), count = 1
    while (low <= high) {
      const n = Math.floor((low + high) / 2)
      if (fits(chars.slice(offset, offset + n).join(''))) { count = n; low = n + 1 }
      else high = n - 1
    }
    if (offset + count < chars.length && !/\s/.test(chars[offset + count])) {
      for (let n = count - 1; n > count / 2; n--) {
        if (/\s/.test(chars[offset + n])) { count = n + 1; break }
      }
    }
    pages.push(chars.slice(offset, offset + count).join(''))
    offset += count
  }
  return pages.length ? pages : ['Ответ пуст']
}

function exactReportContext(raw, jobId) {
  let value = null
  try { value = JSON.parse(raw || 'null') } catch (error) {}
  if (!value || value.target !== 'musafir' || value.jobId !== jobId || !LOCAL_ID.test(jobId || '') ||
      !(value.chatId === 'legacy' || LOCAL_ID.test(value.chatId || '')) ||
      (value.mode !== 'task' && value.mode !== 'research')) return null
  const context = {
    target: 'musafir',
    chatId: value.chatId,
    mode: value.mode,
    jobId,
    openJob: true,
    autoRecord: false
  }
  if (value.pendingSend === true) context.pendingSend = true
  return context
}

export function createMusafirReportPage() {
  return {
    build() {
      setStatusBarVisible(false)
      const { width, height } = getDeviceInfo()
      this.width = width
      this.height = height
      this.scale = Math.min(width / 432, height / 514)
      this.margin = Math.max(18, Math.round(width * 0.055))
      this.controlHeight = height >= 490 ? 52 : 48
      this.bottom = height >= 490 ? 16 : 14
      this.closed = false
      this.generation = 0
      this.requestTimer = null
      this.cancelRequest = null
      this.offset = 0
      this.page = 0
      this.pages = []
      this.total = null
      this.nextOffset = null
      this.storage = null
      try { this.storage = new LocalStorage() } catch (error) {}
      this.jobId = this.read(REPORT_KEY)
      this.reportContext = exactReportContext(this.read(CONTEXT_KEY), this.jobId)

      createWidget(widget.FILL_RECT, { x: 0, y: 0, w: width, h: height, color: COLOR.bg })
      this.back = createWidget(widget.BUTTON, {
        x: this.margin, y: 14, w: 116, h: 48, radius: 13, text: '‹ Назад', text_size: 18,
        normal_color: COLOR.surface, press_color: COLOR.pressed, color: COLOR.white,
        click_func: () => this.backToTask()
      })
      this.home = createWidget(widget.BUTTON, {
        x: width - this.margin - 92, y: 14, w: 92, h: 48, radius: 13, text: 'Домой', text_size: 17,
        normal_color: COLOR.surface, press_color: COLOR.pressed, color: COLOR.gold,
        click_func: () => this.goHome()
      })
      this.title = createWidget(widget.TEXT, {
        x: this.margin, y: 70, w: width - this.margin * 2, h: 28,
        text: 'Полный ответ', text_size: Math.max(21, Math.round(25 * this.scale)),
        color: COLOR.gold, align_h: align.CENTER_H
      })
      this.note = createWidget(widget.TEXT, {
        x: this.margin, y: 100, w: width - this.margin * 2, h: 28,
        text: '', text_size: Math.max(15, Math.round(16 * this.scale)),
        color: COLOR.muted, align_h: align.CENTER_H
      })
      const navY = height - this.bottom - this.controlHeight
      const bodyY = 132
      this.body = createWidget(widget.TEXT, {
        x: this.margin, y: bodyY, w: width - this.margin * 2, h: Math.max(96, navY - bodyY - 8),
        text: '', text_size: Math.max(18, Math.round(21 * this.scale)), color: COLOR.white,
        text_style: text_style.WRAP, align_h: align.LEFT, align_v: align.TOP
      })
      this.fits = text => {
        try {
          const layout = getTextLayout(text, {
            text_size: Math.max(18, Math.round(21 * this.scale)),
            text_width: width - this.margin * 2,
            wrapped: 1
          })
          if (layout && Number.isFinite(layout.height)) {
            return layout.result !== -1 && layout.height <= this.bodyHeight()
          }
        } catch (error) {}
        return Array.from(text).length <= 180 && text.split('\n').length <= 8
      }
      const arrowWidth = 92
      this.previous = createWidget(widget.BUTTON, {
        x: this.margin, y: navY, w: arrowWidth, h: this.controlHeight, radius: 13,
        text: '‹', text_size: 24, normal_color: COLOR.surface,
        press_color: COLOR.pressed, color: COLOR.white, click_func: () => this.turn(-1)
      })
      this.counter = createWidget(widget.TEXT, {
        x: this.margin + arrowWidth, y: navY,
        w: width - this.margin * 2 - arrowWidth * 2, h: this.controlHeight,
        text: '', text_size: 17, color: COLOR.muted,
        align_h: align.CENTER_H, align_v: align.CENTER_V
      })
      this.next = createWidget(widget.BUTTON, {
        x: width - this.margin - arrowWidth, y: navY, w: arrowWidth, h: this.controlHeight, radius: 13,
        text: '›', text_size: 24, normal_color: COLOR.surface,
        press_color: COLOR.pressed, color: COLOR.white,
        click_func: () => this.error ? this.load(this.offset) : this.turn(1)
      })

      this.gestureCallback = gesture => {
        if (gesture !== GESTURE_RIGHT) return false
        this.backToTask()
        return true
      }
      this.keyCallback = (key, keyEvent) => {
        if (key !== KEY_BACK || keyEvent !== KEY_EVENT_CLICK) return false
        this.backToTask()
        return true
      }
      onGesture({ callback: this.gestureCallback })
      onKey({ callback: this.keyCallback })

      this.setButton(this.back, true, { x: this.margin, y: 14, w: 116, h: 48 }, '‹ Назад')
      this.setButton(this.home, true, { x: width - this.margin - 92, y: 14, w: 92, h: 48 }, 'Домой')
      this.setButton(this.previous, false,
        { x: this.margin, y: navY, w: arrowWidth, h: this.controlHeight }, '‹')
      this.setButton(this.next, false,
        { x: width - this.margin - arrowWidth, y: navY, w: arrowWidth, h: this.controlHeight }, '›')
      if (!this.reportContext) {
        this.note.setProperty(prop.TEXT, '')
        this.setCounter('')
        this.body.setProperty(prop.TEXT, 'Откройте ответ из выбранного чата.')
        return
      }
      this.load(0)
    },

    read(key) {
      if (!this.storage) return null
      try { return this.storage.getItem(key) } catch (error) { return null }
    },

    write(key, value) {
      if (!this.storage) return false
      try { this.storage.setItem(key, value); return true } catch (error) { return false }
    },

    bodyHeight() {
      const navY = this.height - this.bottom - this.controlHeight
      return Math.max(96, navY - 132 - 8)
    },

    setButton(button, visible, rectangle, text) {
      button.setProperty(prop.MORE, {
        x: rectangle.x, y: rectangle.y, w: rectangle.w, h: rectangle.h, text
      })
      button.setProperty(prop.VISIBLE, Boolean(visible))
    },

    setCounter(text, rightWidth = 92) {
      this.counter.setProperty(prop.MORE, {
        x: this.margin + 92,
        y: this.height - this.bottom - this.controlHeight,
        w: this.width - this.margin * 2 - 92 - rightWidth,
        h: this.controlHeight,
        text
      })
    },

    backToTask() {
      if (!this.reportContext || !this.write(CONTEXT_KEY, JSON.stringify(this.reportContext))) {
        this.goHome()
        return
      }
      replace({ url: 'page/voice' })
    },

    goHome() {
      this.write(RETURN_KEY, '')
      replace({ url: 'page/index' })
    },

    async load(offset, lastPage = false) {
      const generation = ++this.generation
      if (this.cancelRequest) this.cancelRequest()
      this.offset = offset
      this.error = false
      this.loading = true
      this.note.setProperty(prop.TEXT, 'Читаю сохранённый ответ…')
      this.setCounter('')
      this.body.setProperty(prop.TEXT, '')
      const navY = this.height - this.bottom - this.controlHeight
      this.setButton(this.previous, false,
        { x: this.margin, y: navY, w: 92, h: this.controlHeight }, '‹')
      this.setButton(this.next, false,
        { x: this.width - this.margin - 92, y: navY, w: 92, h: this.controlHeight }, '›')
      try {
        const reply = await new Promise((resolve, reject) => {
          let settled = false
          const finish = (error, result) => {
            if (settled) return
            settled = true
            if (this.requestTimer !== null) clearTimeout(this.requestTimer)
            this.requestTimer = null
            this.cancelRequest = null
            if (error) reject(error); else resolve(result)
          }
          this.cancelRequest = () => finish(new Error('CANCELED'))
          this.requestTimer = setTimeout(() => finish(new Error('Mac не ответил вовремя')), 18000)
          Promise.resolve().then(() => this.request({
            method: 'JOB_REPORT', params: { id: this.jobId, offset, limit: 1000 }
          }, { timeout: 15000 })).then(value => finish(null, value), error => finish(error))
        })
        if (this.closed || generation !== this.generation) return
        if (!reply || !reply.ok || reply.id !== this.jobId || reply.offset !== offset ||
            typeof reply.text !== 'string' || !Number.isInteger(reply.textLength) ||
            reply.textLength < 0 || reply.textLength > 200000 || typeof reply.truncated !== 'boolean') {
          throw new Error(reply && reply.error || 'Не удалось прочитать отчёт')
        }
        const length = Array.from(reply.text).length
        if (length > 1000 || offset + length > reply.textLength ||
            (length === 0 && reply.textLength > 0) ||
            reply.nextOffset !== (offset + length < reply.textLength ? offset + length : null) ||
            (this.total !== null && this.total !== reply.textLength)) {
          throw new Error('Ответ изменился. Откройте его заново.')
        }
        this.total = reply.textLength
        this.nextOffset = reply.nextOffset
        this.truncated = reply.truncated
        this.pages = splitText(reply.text, this.fits)
        this.page = lastPage ? this.pages.length - 1 : 0
        this.loading = false
        this.show()
      } catch (error) {
        if (this.closed || generation !== this.generation) return
        this.loading = false
        this.error = true
        this.note.setProperty(prop.TEXT, 'Часть ответа не загружена')
        this.setCounter('', 116)
        this.body.setProperty(prop.TEXT, error.message || 'Нет связи с Mac')
        this.setButton(this.next, true,
          { x: this.width - this.margin - 116, y: navY, w: 116, h: this.controlHeight }, 'Повторить')
      }
    },

    show() {
      const navY = this.height - this.bottom - this.controlHeight
      this.body.setProperty(prop.TEXT, this.pages[this.page])
      this.note.setProperty(prop.TEXT,
        `Часть ${Math.floor(this.offset / 1000) + 1}${this.truncated ? ' · есть ограничение длины' : ''}`)
      this.setCounter(`${this.page + 1}/${this.pages.length}`)
      this.setButton(this.previous, this.offset > 0 || this.page > 0,
        { x: this.margin, y: navY, w: 92, h: this.controlHeight }, '‹')
      this.setButton(this.next, this.page < this.pages.length - 1 || this.nextOffset !== null,
        { x: this.width - this.margin - 92, y: navY, w: 92, h: this.controlHeight }, '›')
    },

    turn(direction) {
      if (this.loading || this.error) return
      const next = this.page + direction
      if (next >= 0 && next < this.pages.length) { this.page = next; this.show() }
      else if (direction > 0 && this.nextOffset !== null) this.load(this.nextOffset)
      else if (direction < 0 && this.offset > 0) this.load(Math.max(0, this.offset - 1000), true)
    },

    onDestroy() {
      setStatusBarVisible(true)
      this.closed = true
      ++this.generation
      if (this.cancelRequest) this.cancelRequest()
      offGesture()
      offKey()
    }
  }
}
