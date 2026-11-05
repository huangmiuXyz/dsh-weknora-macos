/**
 * Refresh `assets/<platform>-<arch>/` from a built WeKnora checkout.
 *
 * The plugin ships the release layout rather than a single executable because
 * WeKnora resolves `config/config.yaml` and `migrations/sqlite` relative to its
 * working directory and serves the SPA from `WEKNORA_WEB_DIR`. Keeping the four
 * pieces together is what lets the supervisor stage the tiny writable parts and
 * point at the rest in place.
 *
 * Usage:
 *   node scripts/sync-assets.mjs [--source <WeKnora checkout>] [--platform darwin] [--arch arm64]
 *
 * Defaults: WEKNORA_ROOT, else `<repo>/WeKnora` three levels above this package.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const packageDir = path.resolve(scriptDir, '..')

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const [flag, inline] = token.slice(2).split('=')
    args[flag] = inline ?? argv[index + 1]
    if (inline === undefined) index += 1
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const source = path.resolve(
  args.source ?? process.env.WEKNORA_ROOT ?? path.resolve(packageDir, '..', '..', 'WeKnora')
)
const platform = args.platform ?? process.platform
const arch = args.arch ?? process.arch
const dest = path.join(packageDir, 'assets', `${platform}-${arch}`)

function fail(message) {
  console.error(`sync-assets: ${message}`)
  process.exit(1)
}

// macOS builds are single-file Mach-O executables with no extension.
const exeName = 'WeKnora-lite'

function requirePath(target, label) {
  if (!fs.existsSync(target)) fail(`${label} not found: ${target}`)
  return target
}

/** Copy a directory tree verbatim, reporting nothing: callers print one summary. */
async function copyTree(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true })
  await fsp.cp(from, to, { recursive: true, force: true })
}

async function sha256(file) {
  const hash = crypto.createHash('sha256')
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return hash.digest('hex').toUpperCase()
}

/** Byte total and file count for one tree. */
async function measure(dir) {
  let files = 0
  let bytes = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    const entries = await fsp.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) {
        files += 1
        bytes += (await fsp.stat(full)).size
      }
    }
  }
  return { files, bytes }
}

const sourceExe = requirePath(path.join(source, exeName), 'executable')
const sourceWeb = requirePath(path.join(source, 'web'), 'web assets')
const sourceConfig = requirePath(path.join(source, 'config'), 'config directory')
const sourceMigrations = requirePath(path.join(source, 'migrations', 'sqlite'), 'sqlite migrations')

// Start from a clean tree: a removed upstream file must not survive a refresh.
await fsp.rm(dest, { recursive: true, force: true })
await fsp.mkdir(dest, { recursive: true })

await fsp.copyFile(sourceExe, path.join(dest, exeName))
await copyTree(sourceWeb, path.join(dest, 'web'))
await copyTree(sourceConfig, path.join(dest, 'config'))
await copyTree(sourceMigrations, path.join(dest, 'migrations', 'sqlite'))

for (const name of ['licenses']) {
  const from = path.join(source, name)
  if (fs.existsSync(from)) await copyTree(from, path.join(dest, name))
}
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  const from = path.join(source, name)
  if (fs.existsSync(from)) await fsp.copyFile(from, path.join(dest, name))
}

const version = (await fsp.readFile(path.join(source, 'VERSION'), 'utf8').catch(() => '')).trim()
const exeStat = await fsp.stat(path.join(dest, exeName))
const web = await measure(path.join(dest, 'web'))
const manifest = {
  name: 'WeKnora',
  edition: 'lite',
  version: version === '' ? 'unknown' : version,
  platform,
  arch,
  exe: {
    file: exeName,
    bytes: exeStat.size,
    sha256: await sha256(path.join(dest, exeName))
  },
  web: { files: web.files, bytes: web.bytes }
}
await fsp.writeFile(
  path.join(dest, '..', 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8'
)

const total = await measure(dest)
console.log(
  `sync-assets: ${manifest.name} ${manifest.version} (${platform}-${arch}) → ${dest}\n` +
    `  exe    ${(exeStat.size / 1024 / 1024).toFixed(1)} MB  sha256 ${manifest.exe.sha256}\n` +
    `  web    ${(web.bytes / 1024 / 1024).toFixed(1)} MB  (${web.files} files)\n` +
    `  total  ${(total.bytes / 1024 / 1024).toFixed(1)} MB  (${total.files} files)`
)