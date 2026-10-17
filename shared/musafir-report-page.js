import { createWidget, widget, align, prop, getTextLayout, setStatusBarVisible } from '@zos/ui'
import { getDeviceInfo } from '@zos/device'
import { replace } from '@zos/router'
import { LocalStorage } from '@zos/storage'
import { setTimeout, clearTimeout } from '@zos/timer'
import {
  onGesture, offGesture, GESTURE_RIGHT,
  onKey, offKey, KEY_BACK, KEY_EVENT_CLICK
} from '@zos/interaction'

import { textRows } from './text-rows.js'

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
      this.content = ''
      this.rows = []
      this.continueTimer = null
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
      const footerY = height - this.bottom - this.controlHeight
      this.textSize = Math.max(18, Math.round(21 * this.scale))
      this.textWidth = width - this.margin * 2 - 16
      const rowHeight = Math.max(36, Math.round(40 * this.scale))
      this.body = createWidget(widget.SCROLL_LIST, {
        x: this.margin, y: 132, w: width - this.margin * 2, h: footerY - 140,
        item_space: 0, snap_to_center: false, item_enable_horizon_drag: false,
        item_config: [{ type_id: 1, item_height: rowHeight,
          item_bg_color: COLOR.bg, item_bg_radius: 0,
          text_view: [{ x: 6, y: 0, w: this.textWidth, h: rowHeight,
            key: 'display', color: COLOR.white, text_size: this.textSize }], text_view_count: 1 }],
        item_config_count: 1, data_array: [{ display: '' }], data_count: 1
      })
      this.retry = createWidget(widget.BUTTON, {
        x: this.margin, y: footerY, w: width - this.margin * 2, h: this.controlHeight,
        radius: 13, text: 'Повторить загрузку', text_size: 18,
        normal_color: COLOR.surface, press_color: COLOR.pressed, color: COLOR.white,
        click_func: () => this.load(this.offset)
      })
      this.retry.setProperty(prop.VISIBLE, false)

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

      if (!this.reportContext) {
        this.display('Откройте ответ из выбранного чата.')
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

    display(text, keepPosition = false) {
      this.rows = textRows(text || 'Ответ пуст', this.textWidth, this.textSize, getTextLayout, keepPosition ? this.rows : [])
      this.body.setProperty(prop.UPDATE_DATA, {
        data_array: this.rows, data_count: this.rows.length, on_page: keepPosition ? 1 : 0
      })
    },

    stopReading() {
      ++this.generation
      if (this.continueTimer !== null) clearTimeout(this.continueTimer)
      this.continueTimer = null
      if (this.cancelRequest) this.cancelRequest()
    },

    backToTask() {
      this.stopReading()
      if (!this.reportContext || !this.write(CONTEXT_KEY, JSON.stringify(this.reportContext))) {
        this.goHome()
        return
      }
      replace({ url: 'page/voice' })
    },

    goHome() {
      this.stopReading()
      this.write(RETURN_KEY, '')
      replace({ url: 'page/index' })
    },

    async load(offset) {
      if (this.closed || this.loading) return
      const generation = ++this.generation
      this.offset = offset
      this.error = false
      this.loading = true
      this.retry.setProperty(prop.VISIBLE, false)
      this.note.setProperty(prop.TEXT, this.content ? 'Читаю продолжение…' : 'Читаю сохранённый ответ…')
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
        const keepPosition = this.content.length > 0
        this.content += reply.text
        this.offset = offset + length
        this.display(keepPosition ? reply.text : this.content, keepPosition)
        this.loading = false
        this.note.setProperty(prop.TEXT, reply.nextOffset === null
          ? (this.truncated ? 'Предел длины · полный текст на Mac' : 'Весь ответ · листайте вверх и вниз')
          : 'Читаю продолжение…')
        if (reply.nextOffset !== null) {
          this.continueTimer = setTimeout(() => {
            this.continueTimer = null
            if (!this.closed && generation === this.generation) this.load(reply.nextOffset)
          }, 0)
        }
      } catch (error) {
        if (this.closed || generation !== this.generation) return
        this.loading = false
        this.error = true
        this.note.setProperty(prop.TEXT, this.content ? 'Продолжение не загружено' : 'Не удалось загрузить ответ')
        if (!this.content) this.display(error.message || 'Нет связи с Mac')
        this.retry.setProperty(prop.VISIBLE, true)
      }
    },

    onDestroy() {
      setStatusBarVisible(true)
      this.closed = true
      this.stopReading()
      offGesture()
      offKey()
    }
  }
}
