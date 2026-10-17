#!/usr/bin/env node

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const host = '127.0.0.1'
const requestedPort = Number(process.env.PREVIEW_PORT || process.argv[2] || 8769)
const previewFiles = new Set(['index.html', 'styles.css', 'harness.mjs'])
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png'
}

function sourcePath(pathname) {
  if (pathname === '/' || pathname === '/index.html') return join(root, 'preview/index.html')
  if (pathname === '/page/index.js') return join(root, 'page/index.js')
  if (pathname === '/page/voice.js') return join(root, 'page/voice.js')
  if (pathname === '/page/report.js') return join(root, 'page/report.js')
  if (pathname === '/page/orca.js') return join(root, 'page/orca.js')
  if (pathname === '/page/history.js') return join(root, 'page/history.js')
  if (pathname === '/shared/bridge-client.js') return join(root, 'shared/bridge-client.js')
  if (pathname === '/shared/watch-client.js') return join(root, 'shared/watch-client.js')
  if (pathname === '/shared/orca-voice.js') return join(root, 'shared/orca-voice.js')
  if (pathname === '/shared/watch-alerts.js') return join(root, 'shared/watch-alerts.js')
  if (pathname === '/shared/voice-page.js') return join(root, 'shared/voice-page.js')
  if (pathname === '/shared/history-page.js') return join(root, 'shared/history-page.js')
  if (pathname === '/shared/musafir-chat.js') return join(root, 'shared/musafir-chat.js')
  if (pathname === '/shared/musafir-page.js') return join(root, 'shared/musafir-page.js')
  if (pathname === '/shared/musafir-report-page.js') return join(root, 'shared/musafir-report-page.js')
  if (pathname.startsWith('/preview/')) {
    const name = pathname.slice('/preview/'.length)
    if (previewFiles.has(name)) return join(root, 'preview', name)
  }
  if (pathname.startsWith('/assets/common.s/')) {
    const name = pathname.slice('/assets/common.s/'.length)
    if (/^[a-zA-Z0-9._-]+\.png$/.test(name)) return join(root, 'assets/common.s', name)
    if (/^heroes\/(?:musafir|kashif|barq|hakim|amin)(?:-[0-2]|-small)?\.png$/.test(name)) {
      return join(root, 'assets/common.s', ...name.split('/'))
    }
  }
  return null
}

const server = createServer(async (request, response) => {
  let pathname
  try {
    pathname = new URL(request.url, `http://${host}`).pathname
  } catch {
    response.writeHead(400).end('Bad request')
    return
  }

  if (pathname === '/favicon.ico') {
    response.writeHead(204).end()
    return
  }

  const file = sourcePath(pathname)
  if (!file) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
    return
  }

  try {
    const body = await readFile(file)
    response.writeHead(200, {
      'Content-Type': mime[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'",
      'X-Content-Type-Options': 'nosniff'
    })
    response.end(body)
  } catch (error) {
    const missing = error && error.code === 'ENOENT'
    response.writeHead(missing ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end(missing ? 'Not found' : 'Preview server error')
  }
})

function listen(port) {
  const onListening = () => {
    server.off('error', onError)
    console.log(`[preview] http://${host}:${port}`)
    console.log('[preview] Только локальная демонстрация: bridge, token и Hermes не используются.')
  }
  const onError = error => {
    server.off('listening', onListening)
    if (error.code === 'EADDRINUSE' && port < requestedPort + 20) {
      console.warn(`[preview] ${host}:${port} занят, пробуем ${port + 1}`)
      listen(port + 1)
      return
    }
    throw error
  }
  server.once('error', onError)
  server.once('listening', onListening)
  server.listen(port, host)
}

listen(Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 8769)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
