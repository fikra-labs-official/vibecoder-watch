#!/usr/bin/env node
// Render any text as a QR PNG: node scripts/make-qr.mjs <text> <out.png>
// Reuses the terminal renderer Zeus uses (qrcode-terminal, small mode) and qr-from-log.mjs for the PNG.
import { createRequire } from 'node:module'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const [text, out] = process.argv.slice(2)
if (!text || !out) throw new Error('Usage: make-qr.mjs <text> <out.png>')
const qrcode = createRequire(import.meta.url)('qrcode-terminal')
let ascii = ''
qrcode.generate(text, { small: true }, value => { ascii = value })
const dir = mkdtempSync(join(tmpdir(), 'qr-'))
try {
  writeFileSync(join(dir, 'qr.log'), ascii + '\n')
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./qr-from-log.mjs', import.meta.url)), join(dir, 'qr.log'), out], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status || 1)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
