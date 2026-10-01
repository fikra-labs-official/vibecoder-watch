#!/usr/bin/env node
// Render the terminal QR that `zeus preview` prints (qrcode-terminal small mode)
// as a PNG for the phone camera: node scripts/qr-from-log.mjs <preview.log> <out.png>
import { readFileSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const [logPath, outPath] = process.argv.slice(2)
if (!logPath || !outPath) throw new Error('Usage: qr-from-log.mjs <preview.log> <out.png>')
const lines = readFileSync(logPath, 'utf8').split('\n')
const start = lines.findIndex(line => /^▄+$/.test(line))
if (start < 0) throw new Error('No QR block in log')
const body = []
for (const line of lines.slice(start + 1)) {
  if (!/^█[█▀▄ ]+█$/.test(line)) break
  body.push(line.slice(1, -1))
}
const count = body[0].length
const rows = []
for (const line of body) {
  const top = [], bottom = []
  for (const char of line) {
    top.push(char === '▄' || char === ' ')      // top half black = dark module
    bottom.push(char === '▀' || char === ' ')   // bottom half black = dark module
  }
  rows.push(top, bottom)
}
rows.length = count                             // odd sizes carry one padding row
if (rows.some(row => row.length !== count)) throw new Error('QR block is not square')

function encodePng(modules, scale = 10, quiet = 4) {
  const size = (modules.length + quiet * 2) * scale
  const raw = Buffer.alloc((size + 1) * size, 255)
  for (let y = 0; y < size; y++) {
    raw[y * (size + 1)] = 0
    const r = Math.floor(y / scale) - quiet
    for (let x = 0; x < size; x++) {
      const c = Math.floor(x / scale) - quiet
      if (modules[r] && modules[r][c]) raw[y * (size + 1) + 1 + x] = 0
    }
  }
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc32 = buffer => {
    let c = 0xffffffff
    for (const byte of buffer) c = table[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const bodyBytes = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(bodyBytes))
    return Buffer.concat([length, bodyBytes, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ])
}
writeFileSync(outPath, encodePng(rows), { mode: 0o600 })
console.log(`${outPath}: ${count}x${count} modules`)
