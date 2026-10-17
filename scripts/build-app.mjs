import { cp, mkdir, readFile, writeFile, symlink, access, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = fileURLToPath(new URL('..', import.meta.url))
const [kind = 'musafir', command = 'build', ...options] = process.argv.slice(2)
if (!['musafir', 'orca', 'claude', 'codex', 'limits'].includes(kind) || !['build', 'preview', 'prepare'].includes(command)) {
  throw new Error('Usage: node scripts/build-app.mjs musafir|orca|claude|codex|limits build|preview|prepare [Zeus options]')
}

// Two independent installable app roots share the recorder source and dependencies.
const source = kind === 'musafir' ? root : join(root, 'apps', kind)
const stage = join(root, '.local/apps', kind)
for (const dir of ['', 'page', 'app-side', 'setting', 'assets/common.s', 'shared']) {
  await mkdir(join(stage, dir), { recursive: true, mode: 0o700 })
}
await cp(join(root, 'shared'), join(stage, 'shared'), { recursive: true })
for (const name of ['app.json', 'app.js']) await copyFile(join(source, name), join(stage, name))
await copyFile(join(source, 'app-side/index.js'), join(stage, 'app-side/index.js'))
// PUBLIC=1 (or no private connection yet) builds a package without secrets: address and key come from the Zepp settings page.
const publicBuild = process.env.PUBLIC === '1' || !existsSync(join(root, 'app-side/connection.js'))
if (publicBuild) await writeFile(join(stage, 'app-side/connection.js'), "export const bridgeURL = ''\nexport const deviceToken = ''\n")
else await copyFile(join(root, 'app-side/connection.js'), join(stage, 'app-side/connection.js'))
await copyFile(join(root, 'setting/index.js'), join(stage, 'setting/index.js'))
if (kind !== 'musafir') {
  await copyFile(join(root, 'page', kind + '.js'), join(stage, 'page/index.js'))
  for (const name of ['voice.js', 'history.js']) {  // single-page apps (limits) have neither
    try { await access(join(source, 'page', name)) } catch { continue }
    await copyFile(join(source, 'page', name), join(stage, 'page', name))
  }
} else {
  for (const name of ['index', 'voice', 'report', 'history']) {
    await copyFile(join(root, 'page', name + '.js'), join(stage, 'page', name + '.js'))
  }
}
const assets = kind === 'musafir' ? ['musafer-icon.png', 'brand-mark.png'] : [kind + '-icon.png', kind + '-mark.png']
for (const name of assets) await copyFile(join(root, 'assets/common.s', name), join(stage, 'assets/common.s', name))
if (kind === 'musafir') {
  await cp(join(root, 'assets/common.s/heroes'), join(stage, 'assets/common.s/heroes'), { recursive: true })
  await cp(join(stage, 'assets/common.s'), join(stage, 'assets/common.w432-s'), { recursive: true })
}
const manifest = JSON.parse(await readFile(join(source, 'app.json'), 'utf8'))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
pkg.name = `${kind}-bipmax`
pkg.version = manifest.app.version.name
pkg.scripts = {}
await writeFile(join(stage, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
try { await access(join(stage, 'node_modules')) }
catch { await symlink(join(root, 'node_modules'), join(stage, 'node_modules'), 'dir') }
console.log(`${manifest.app.appName} ${manifest.app.version.name}, App ID ${manifest.app.appId}${publicBuild ? ', public build without address and key' : ''}`)
if (command !== 'prepare') {
  const child = spawn(process.execPath, [join(root, 'node_modules/@zeppos/zeus-cli/bin/main.js'), command, ...options], {
    cwd: stage, stdio: 'inherit'
  })
  child.on('error', error => { console.error(error.message); process.exitCode = 1 })
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
}
