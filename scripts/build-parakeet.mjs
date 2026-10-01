import { spawnSync } from 'node:child_process'
import { mkdirSync, copyFileSync, chmodSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const root = fileURLToPath(new URL('..', import.meta.url))
const args = ['build', '--package-path', join(root, 'bridge/parakeet-runner'),
  '--scratch-path', join(root, '.local/parakeet-build'), '-c', 'release', '--product', 'parakeet-transcribe']
const build = spawnSync('swift', args, { stdio: 'inherit' })
if (build.error || build.status !== 0) throw build.error || new Error('Parakeet build failed')
const bin = spawnSync('swift', [...args, '--show-bin-path'], { encoding: 'utf8' })
if (bin.error || bin.status !== 0) throw bin.error || new Error('Missing build output')
mkdirSync(join(root, '.local'), { recursive: true, mode: 0o700 })
const target = join(root, '.local/asr-parakeet-transcribe')
copyFileSync(join(bin.stdout.trim(), 'parakeet-transcribe'), target)
chmodSync(target, 0o700)
console.log('Built local Parakeet runner:', target)
