import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { forwardRequest } from '../shared/bridge-client.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const TOKEN = 's'.repeat(43)
const QUESTION = 'Вопрос😀строка\n'.repeat(80) + 'конец'
const RESULT = 'Ответ🌙подробный\n'.repeat(80) + 'готово'
const IDS = [1, 2, 3, 4].map(number => `1700000000000-${number}`)

const SERVER = String.raw`
import json
import os
from pathlib import Path
import signal
import sys
from http.server import ThreadingHTTPServer

sys.path.insert(0, str(Path.cwd() / "bridge"))
from server import Bridge, make_handler

state = Path(os.environ["MUSAFIR_TEST_STATE"])
metrics = state / "metrics.json"

class RefusingHermes:
    def __init__(self):
        self.calls = []

    def call(self, *args, **kwargs):
        self.calls.append([args, kwargs])
        raise AssertionError("Hermes must not be called by terminal history reads")

hermes = RefusingHermes()
transcriber_calls = []

def transcriber(*args):
    transcriber_calls.append(args)
    raise AssertionError("Transcriber must not be called by history reads")

bridge = Bridge(state, hermes, transcriber, state / "unused-model")
question = "Вопрос😀строка\n" * 80 + "конец"
result = "Ответ🌙подробный\n" * 80 + "готово"
with bridge.lock:
    bridge.db.executemany(
        "INSERT INTO jobs(id,text,created,state,result) VALUES (?,?,?,'completed',?)",
        [(f"1700000000000-{number}", question if number == 4 else f"Вопрос {number}",
          number, result if number == 4 else f"Ответ {number}") for number in range(1, 5)]
    )
    bridge.db.commit()

server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(bridge, os.environ["MUSAFIR_TEST_TOKEN"]))
print(json.dumps({"port": server.server_port}), flush=True)
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    server.server_close()
    bridge.close()
    metrics.write_text(json.dumps({
        "hermesCalls": len(hermes.calls),
        "transcriberCalls": len(transcriber_calls)
    }))
`

function waitForStartup(child, stderr) {
  return new Promise((resolve, reject) => {
    let stdout = ''
    const timer = setTimeout(() => reject(new Error(`bridge startup timeout: ${stderr()}`)), 5000)
    const failed = code => {
      clearTimeout(timer)
      reject(new Error(`bridge exited during startup (${code}): ${stderr()}`))
    }
    child.once('exit', failed)
    child.stdout.on('data', chunk => {
      stdout += chunk
      const newline = stdout.indexOf('\n')
      if (newline < 0) return
      try {
        const startup = JSON.parse(stdout.slice(0, newline))
        if (!Number.isInteger(startup.port) || startup.port <= 0) throw new Error('invalid port')
        clearTimeout(timer)
        child.off('exit', failed)
        resolve(startup.port)
      } catch (error) {
        clearTimeout(timer)
        child.off('exit', failed)
        reject(error)
      }
    })
  })
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return
  const exited = new Promise(resolve => child.once('exit', resolve))
  child.kill('SIGINT')
  let timer
  await Promise.race([
    exited,
    new Promise(resolve => {
      timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 3000)
    })
  ])
  clearTimeout(timer)
}

test('real HTTP history protocol preserves Unicode paging and reversible trash', async () => {
  const state = await mkdtemp(join(tmpdir(), 'musafir-history-'))
  let stderr = ''
  const child = spawn('python3', ['-u', '-c', SERVER], {
    cwd: ROOT,
    env: { ...process.env, MUSAFIR_TEST_STATE: state, MUSAFIR_TEST_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stderr.on('data', chunk => { stderr += chunk })

  try {
    const port = await waitForStartup(child, () => stderr)
    const bridgeURL = `http://127.0.0.1:${port}`
    const fetchRequest = async options => {
      const response = await fetch(options.url, {
        method: options.method,
        headers: options.headers,
        body: options.body,
        signal: AbortSignal.timeout(options.timeout)
      })
      return { status: response.status, body: await response.text() }
    }
    const rpc = (method, params = {}) => forwardRequest(
      { method, params }, fetchRequest, bridgeURL, TOKEN, 'musafir'
    )

    const first = await rpc('HISTORY_LIST', { trash: false, offset: 0, limit: 3 })
    assert.deepEqual(first.items.map(item => item.id), [IDS[3], IDS[2], IDS[1]])
    assert.equal(first.items[0].text, Array.from(QUESTION).slice(0, 70).join(''))
    assert.equal(first.hasMore, true)
    const last = await rpc('HISTORY_LIST', { trash: false, offset: 3, limit: 3 })
    assert.deepEqual(last.items.map(item => item.id), [IDS[0]])
    assert.equal(last.hasMore, false)

    for (const [field, expected] of [['text', QUESTION], ['result', RESULT]]) {
      let offset = 0
      let content = ''
      while (true) {
        const page = await rpc('HISTORY_DETAIL', { id: IDS[3], field, offset, limit: 600 })
        assert.equal(page.offset, offset)
        assert.equal(page.total, Array.from(expected).length)
        assert.equal('run_id' in page, false)
        content += page.content
        offset += Array.from(page.content).length
        if (page.complete) break
      }
      assert.equal(content, expected)
    }

    assert.deepEqual(await rpc('HISTORY_SET_DELETED', { id: IDS[3], deleted: true }), {
      ok: true, id: IDS[3], deleted: true
    })
    const latest = await rpc('LATEST_JOB')
    assert.equal(latest.job.id, IDS[2])
    assert.equal('run_id' in latest.job, false)
    assert.deepEqual((await rpc('HISTORY_LIST', { trash: true })).items.map(item => item.id), [IDS[3]])
    assert.deepEqual((await rpc('HISTORY_LIST')).items.map(item => item.id), [IDS[2], IDS[1], IDS[0]])

    assert.deepEqual(await rpc('HISTORY_SET_DELETED', { id: IDS[3], deleted: false }), {
      ok: true, id: IDS[3], deleted: false
    })
    assert.equal((await rpc('HISTORY_LIST')).items[0].id, IDS[3])
  } finally {
    await stopChild(child)
    let metrics
    try {
      metrics = JSON.parse(await readFile(join(state, 'metrics.json'), 'utf8'))
    } finally {
      await rm(state, { recursive: true, force: true })
    }
    assert.deepEqual(metrics, { hermesCalls: 0, transcriberCalls: 0 })
  }
})
