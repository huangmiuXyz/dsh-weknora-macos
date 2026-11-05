/**
 * Checks for dsh-weknora-macos.
 *
 * The unit half needs no assets: it exercises config normalization, the generated
 * dotenv, staging, and the loopback probes. The end-to-end half (`--e2e` or
 * WEKNORA_E2E=1) starts the real bundled executable against a temporary DSH home
 * and asserts the four promises the tool makes: started, idempotent, adoptable,
 * and stoppable.
 */
import assert from 'node:assert/strict'
import { spawn as spawnChild } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { normalizeConfig } from '../src/config.js'
import { maskKey, saveApiKey, validateApiKey } from '../src/apikey.js'
import { clearApiKey, resolveApiKey, storeApiKey } from '../src/credentials.js'
import { TOOL_NAME } from '../src/protocol.js'
import {
  assetPaths,
  copyTreeChanged,
  copyTreeMissing,
  ensureEnvFile,
  ensureExecutable,
  ensureRuntime,
  envFileText,
  freePort,
  isPortFree,
  missingAssets,
  parseEnv,
  probeWeKnora,
  randomSecret
} from '../src/runtime.js'
import { WeknoraSupervisor } from '../src/supervisor.js'
import { subprocessSpawner } from '../src/spawn.js'
import { weknoraRunTool } from '../src/tool.js'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function tempDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix))
}

// --- config ------------------------------------------------------------------

test('normalizeConfig keeps defaults and rejects nonsense', () => {
  const defaults = normalizeConfig()
  assert.equal(defaults.host, '127.0.0.1')
  assert.equal(defaults.port, 18080)
  assert.equal(defaults.startupTimeoutMs, 120_000)
  assert.equal(defaults.stopOnDispose, true)

  const weird = normalizeConfig({
    host: 'http://0.0.0.0/',
    port: 999_999,
    startupTimeoutMs: 1,
    stopOnDispose: 'no',
    extraEnv: { OLLAMA_BASE_URL: 'http://127.0.0.1:11434', BAD_KEY: true, 'not a key': 'x' }
  })
  assert.equal(weird.host, '0.0.0.0')
  assert.equal(weird.port, 65_535)
  assert.equal(weird.startupTimeoutMs, 5_000)
  assert.equal(weird.stopOnDispose, true)
  assert.deepEqual(weird.extraEnv, { OLLAMA_BASE_URL: 'http://127.0.0.1:11434' })
})

// --- generated dotenv --------------------------------------------------------

test('envFileText covers the keys a Lite child needs', () => {
  const text = envFileText({ dataDir: '/Users/x y/.dsh/weknora/data' })
  const values = parseEnv(text)
  for (const key of ['DB_DRIVER', 'DB_PATH', 'RETRIEVE_DRIVER', 'SYSTEM_AES_KEY', 'JWT_SECRET']) {
    assert.ok(values.has(key), `${key} must be generated`)
  }
  assert.equal(values.get('DB_DRIVER'), 'sqlite')
  assert.ok(values.get('DB_PATH').includes('/.dsh/weknora/data/weknora.db'))
  assert.ok(!values.get('DB_PATH').includes('\\'), 'the dotenv uses forward slashes, never backslashes')
  assert.equal(values.get('SYSTEM_AES_KEY').length, 32)
})

test('randomSecret is 32 URL-safe characters', () => {
  const secret = randomSecret()
  assert.equal(secret.length, 32)
  assert.match(secret, /^[A-Za-z0-9]{32}$/)
  assert.notEqual(secret, randomSecret())
})

test('ensureEnvFile creates once, repairs secrets, keeps user edits', async () => {
  const dir = await tempDir('weknora-env-')
  const envPath = path.join(dir, 'weknora.env')
  const created = await ensureEnvFile(envPath, { dataDir: path.join(dir, 'data') })
  assert.equal(created.created, true)

  // A user who edits a value and blanks a secret gets the edit kept and the
  // secret regenerated: blank keys mean plaintext credentials in WeKnora.
  const edited = fs
    .readFileSync(envPath, 'utf8')
    .replace(/^DB_PATH=.*$/mu, 'DB_PATH=D:/moved/weknora.db')
    .replace(/SYSTEM_AES_KEY=.*/u, 'SYSTEM_AES_KEY=')
  fs.writeFileSync(envPath, edited, 'utf8')

  await ensureEnvFile(envPath, { dataDir: path.join(dir, 'data') })
  const values = parseEnv(fs.readFileSync(envPath, 'utf8'))
  assert.equal(values.get('DB_PATH'), 'D:/moved/weknora.db')
  assert.equal(values.get('SYSTEM_AES_KEY').length, 32)

  // Deleting a core key re-adds it with the default instead of leaving the child
  // to panic on an empty database driver.
  fs.writeFileSync(
    envPath,
    fs.readFileSync(envPath, 'utf8').replace(/^DB_DRIVER=.*$/mu, ''),
    'utf8'
  )
  await ensureEnvFile(envPath, { dataDir: path.join(dir, 'data') })
  assert.equal(parseEnv(fs.readFileSync(envPath, 'utf8')).get('DB_DRIVER'), 'sqlite')

  await fsp.rm(dir, { recursive: true, force: true })
})

// --- staging -----------------------------------------------------------------

test('staging copies what is absent and never overwrites user config', async () => {
  const dir = await tempDir('weknora-stage-')
  const source = path.join(dir, 'source')
  const target = path.join(dir, 'target')
  await fsp.mkdir(path.join(source, 'nested'), { recursive: true })
  await fsp.writeFile(path.join(source, 'a.yaml'), 'shipped\n')
  await fsp.writeFile(path.join(source, 'nested', 'b.yaml'), 'shipped\n')

  await fsp.mkdir(target, { recursive: true })
  await fsp.writeFile(path.join(target, 'a.yaml'), 'edited by the user\n')

  assert.equal(await copyTreeMissing(source, target), 1)
  assert.equal(fs.readFileSync(path.join(target, 'a.yaml'), 'utf8'), 'edited by the user\n')
  assert.equal(fs.readFileSync(path.join(target, 'nested', 'b.yaml'), 'utf8'), 'shipped\n')

  // Size-changing files are replaced: migrations are versioned SQL, never edited.
  // Both files differ here on purpose — this helper is used for migrations only,
  // and the config tree above (which keeps user edits) goes through the other one.
  await fsp.writeFile(path.join(source, 'nested', 'b.yaml'), 'shipped but longer\n')
  assert.equal(await copyTreeChanged(source, target), 2)
  assert.equal(fs.readFileSync(path.join(target, 'nested', 'b.yaml'), 'utf8'), 'shipped but longer\n')

  await fsp.rm(dir, { recursive: true, force: true })
})

test('ensureRuntime creates the writable tree and stages config plus migrations', async () => {
  const dir = await tempDir('weknora-runtime-')
  const assets = path.join(dir, 'assets')
  await fsp.mkdir(path.join(assets, 'config'), { recursive: true })
  await fsp.mkdir(path.join(assets, 'migrations', 'sqlite'), { recursive: true })
  await fsp.writeFile(path.join(assets, 'config', 'config.yaml'), 'port: 8080\n')
  await fsp.writeFile(path.join(assets, 'migrations', 'sqlite', '000000_init.up.sql'), 'CREATE TABLE t();\n')

  const home = path.join(dir, 'home')
  const runtime = await ensureRuntime({
    home,
    version: '9.9.9',
    assets: {
      config: path.join(assets, 'config'),
      migrations: path.join(assets, 'migrations')
    }
  })
  assert.ok(fs.existsSync(path.join(runtime.runtimeDir, 'config', 'config.yaml')))
  assert.ok(fs.existsSync(path.join(runtime.runtimeDir, 'migrations', 'sqlite', '000000_init.up.sql')))
  assert.ok(fs.existsSync(runtime.dataDir))
  assert.ok(fs.existsSync(path.join(runtime.dataDir, 'files')))
  assert.ok(fs.existsSync(runtime.envPath))

  // A second pass is a no-op, not a re-copy.
  await fsp.writeFile(path.join(runtime.runtimeDir, 'config', 'config.yaml'), 'edited\n')
  await ensureRuntime({
    home,
    version: '9.9.9',
    assets: {
      config: path.join(assets, 'config'),
      migrations: path.join(assets, 'migrations')
    }
  })
  assert.equal(fs.readFileSync(path.join(runtime.runtimeDir, 'config', 'config.yaml'), 'utf8'), 'edited\n')

  await fsp.rm(dir, { recursive: true, force: true })
})

// --- probes ------------------------------------------------------------------

test('probeWeKnora only accepts a WeKnora SPA', async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/health') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ status: 'ok' }))
      return
    }
    if (request.url === '/') {
      response.setHeader('content-type', 'text/html')
      response.end('<html><head><title>WeKnora</title></head></html>')
      return
    }
    response.statusCode = 404
    response.end('')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  assert.equal(await probeWeKnora('127.0.0.1', port), true)
  // A different service on the same port is not adopted by mistake.
  const impostor = http.createServer((request, response) => {
    if (request.url === '/health') {
      response.end(JSON.stringify({ status: 'ok' }))
      return
    }
    response.end('<html><title>Something else</title></html>')
  })
  await new Promise((resolve) => impostor.listen(0, '127.0.0.1', resolve))
  assert.equal(await probeWeKnora('127.0.0.1', impostor.address().port), false)

  await new Promise((resolve) => server.close(resolve))
  await new Promise((resolve) => impostor.close(resolve))
  assert.equal(await probeWeKnora('127.0.0.1', port, { timeoutMs: 200 }), false)
})

test('isPortFree and freePort agree with a real listener', async () => {
  const server = http.createServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const busy = server.address().port
  assert.equal(await isPortFree('127.0.0.1', busy), false)
  const spare = await freePort('127.0.0.1')
  assert.ok(spare > 0 && spare !== busy)
  assert.equal(await isPortFree('127.0.0.1', spare), true)
  await new Promise((resolve) => server.close(resolve))
})

// --- supervisor failure paths ------------------------------------------------

/**
 * A seam-shaped service backed by `node:child_process`.
 *
 * The plugin only ever talks to `ctx.subprocess`, so the end-to-end test keeps the
 * same adapter the real deployment uses and merely supplies a service in place of
 * the host's. Nothing here ships.
 */
function localSeam() {
  return {
    spawn(spec) {
      const [command, ...args] = spec.argv
      const child = spawnChild(command, args, {
        cwd: spec.cwd,
        env: { ...process.env, ...(spec.env ?? {}) },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const done = new Promise((resolve, reject) => {
        child.once('exit', (code, signal) => resolve({ exitCode: code, signal }))
        child.once('error', reject)
      })
      return {
        stdout: child.stdout,
        stderr: child.stderr,
        done,
        terminate() {
          try {
            child.kill()
          } catch {
            /* already gone */
          }
        },
        async waitForExit(signal) {
          const settled = done.then(
            () => true,
            () => true
          )
          if (signal === undefined) return settled
          return Promise.race([
            settled,
            new Promise((resolve) => {
              signal.addEventListener('abort', () => resolve(false), { once: true })
            })
          ])
        }
      }
    }
  }
}

test('subprocessSpawner drives the host seam contract', async () => {
  const calls = []
  const exits = []
  let terminated = false
  let resolveDone
  const handle = {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    done: new Promise((resolve) => {
      resolveDone = resolve
    }),
    terminate() {
      terminated = true
    },
    async waitForExit() {
      return true
    }
  }
  const spawner = subprocessSpawner({
    spawn(spec) {
      calls.push(spec)
      return handle
    }
  })
  const lines = []
  const adapted = await spawner.spawn({
    exe: '/opt/x/WeKnora-lite',
    cwd: '/tmp/rt',
    env: { SERVER_PORT: '18080' },
    onLine: (line) => lines.push(line),
    onExit: (info) => exits.push(info)
  })

  handle.stdout.write('one\ntwo\n')
  assert.deepEqual(lines, ['one', 'two'], 'piped output is split into lines')
  assert.equal(calls[0].argv[0], '/opt/x/WeKnora-lite')
  assert.equal(calls[0].cwd, '/tmp/rt')
  assert.equal(calls[0].stdio.stdin, 'ignore')
  assert.ok(calls[0].graceMs > 0, 'every disposition is explicit')
  assert.equal(calls[0].env.SERVER_PORT, '18080')

  adapted.terminate()
  assert.equal(terminated, true)
  assert.equal(await adapted.waitExit(100), true)

  resolveDone({ exitCode: 3, signal: null })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(exits[0], { code: 3, signal: null })
})

test('subprocessSpawner refuses a composition without the seam', () => {
  assert.throws(() => subprocessSpawner(undefined), /ctx\.subprocess/u)
})

test('missing bundled assets fail with the exact path', async () => {
  const dir = await tempDir('weknora-missing-')
  const supervisor = new WeknoraSupervisor({
    config: normalizeConfig({ port: 0 }),
    spawner: subprocessSpawner(localSeam()),
    root: dir,
    env: { DSH_HOME: path.join(dir, 'home') }
  })
  await assert.rejects(supervisor.ensure(), /WeKnora 二进制与资源缺失/u)
  await fsp.rm(dir, { recursive: true, force: true })
})

test('missingAssets names every missing piece', () => {
  const paths = assetPaths(path.join(os.tmpdir(), 'weknora-not-here'))
  const missing = missingAssets(paths)
  assert.equal(missing.length, 4)
  assert.ok(missing.some((line) => line.includes('executable')))
})

// --- tool surface ------------------------------------------------------------

test('weknora_run has no arguments and renders the address', () => {
  const definition = weknoraRunTool({ ensure: async () => ({}) })
  assert.equal(definition.name, TOOL_NAME)
  assert.equal(definition.parameters.additionalProperties, false)
  assert.deepEqual(Object.keys(definition.parameters.properties), [])
  const blocks = definition.output.render({}, {
    running: true,
    baseUrl: 'http://127.0.0.1:18080/',
    port: 18080,
    state: 'started',
    startupMs: 1234
  })
  assert.equal(blocks.length, 1)
  assert.match(blocks[0].text, /http:\/\/127\.0\.0\.1:18080\//u)
  assert.match(blocks[0].text, /1\.2 秒/u)
})

test('weknora_run passes the call signal through', async () => {
  const controller = new AbortController()
  let seen
  const definition = weknoraRunTool({
    ensure: async (options) => {
      seen = options?.signal
      return { running: true, baseUrl: 'http://x/', port: 1, state: 'started' }
    }
  })
  await definition.execute({}, { signal: controller.signal })
  assert.equal(seen, controller.signal)
})

// --- end to end --------------------------------------------------------------

const e2eEnabled =
  process.argv.includes('--e2e') || process.env.WEKNORA_E2E === '1'

test(
  'the real binary starts, is idempotent, is adopted, and stops',
  { skip: e2eEnabled ? false : 'pass --e2e (or WEKNORA_E2E=1) to run against the bundled server' },
  async () => {
    const root = packageDir
    const missing = missingAssets(assetPaths(root))
    assert.deepEqual(missing, [], 'assets must be staged: run `node scripts/sync-assets.mjs`')

    const home = await tempDir('weknora-e2e-')
    const env = { DSH_HOME: home }
    const first = new WeknoraSupervisor({
      config: normalizeConfig({ host: '127.0.0.1', port: 0, startupTimeoutMs: 120_000 }),
      spawner: subprocessSpawner(localSeam()),
      root,
      env,
      log: () => {}
    })
    try {
      const started = await first.ensure()
      assert.equal(started.state, 'started')
      assert.equal(started.running, true)
      assert.match(started.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/u)
      assert.ok(started.startupMs > 0)
      const page = await fetch(started.baseUrl)
      assert.equal(page.status, 200)
      assert.match(await page.text(), /WeKnora/u)
      assert.ok(
        fs.existsSync(path.join(started.dataDir, 'data', 'weknora.db')),
        'database lives under the plugin home, never in node_modules'
      )

      const again = await first.ensure()
      assert.equal(again.state, 'already-running')
      assert.equal(again.port, started.port)

      // A second supervisor (a restarted DSH host) adopts via run.json instead of
      // spawning a competing process, and disposing it must not kill the owner's.
      const second = new WeknoraSupervisor({
        config: normalizeConfig({ host: '127.0.0.1', port: started.port }),
        spawner: subprocessSpawner(localSeam()),
        root,
        env,
        log: () => {}
      })
      const adopted = await second.ensure()
      assert.equal(adopted.state, 'adopted')
      assert.equal(adopted.baseUrl, started.baseUrl)
      await second.dispose()

      const still = await fetch(started.baseUrl)
      assert.equal(still.status, 200, 'an adopted instance must survive the adopter')

      const stopped = await first.stop()
      assert.equal(stopped.stopped, true)
      assert.equal(await probeWeKnora('127.0.0.1', started.port, { timeoutMs: 500 }), false)

      const restarted = await first.ensure()
      assert.equal(restarted.state, 'started')
      assert.equal(await probeWeKnora('127.0.0.1', restarted.port, { timeoutMs: 1_000 }), true)
    } finally {
      await first.dispose()
      await fsp.rm(home, { recursive: true, force: true })
    }
  }
)

// --- credential seam ---------------------------------------------------------

/** A minimal in-memory stand-in for `ctx.credentials`. */
function fakeCredentials(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    calls: [],
    async resolve(ref) {
      this.calls.push(['resolve', ref])
      return store.has(ref) ? { value: store.get(ref) } : undefined
    },
    async set(ref, value) {
      this.calls.push(['set', ref])
      store.set(ref, value)
    },
    async unset(ref) {
      this.calls.push(['unset', ref])
      store.delete(ref)
    }
  }
}

test('resolveApiKey treats blank and missing values as unconfigured', async () => {
  assert.equal(await resolveApiKey(fakeCredentials()), undefined, 'nothing stored')
  assert.equal(await resolveApiKey(fakeCredentials({ WEKNORA_API_KEY: '   ' })), undefined, 'blank is absent')
  assert.equal(await resolveApiKey(fakeCredentials({ WEKNORA_API_KEY: ' sk-abc12345 ' })), 'sk-abc12345', 'trimmed')
  assert.equal(await resolveApiKey(undefined), undefined, 'a composition without the seam')
  assert.equal(await resolveApiKey(() => fakeCredentials({ WEKNORA_API_KEY: 'sk-live-999' })), 'sk-live-999', 'a getter is resolved per call')
})

test('resolveApiKey swallows a failing seam instead of breaking a tool call', async () => {
  const broken = { async resolve() { throw new Error('vault locked') } }
  assert.equal(await resolveApiKey(broken), undefined)
})

test('storeApiKey and clearApiKey drive the seam', async () => {
  const service = fakeCredentials()
  await storeApiKey(service, 'sk-new-key-123')
  assert.equal(await resolveApiKey(service), 'sk-new-key-123')
  await clearApiKey(service)
  assert.equal(await resolveApiKey(service), undefined)
  // Clearing twice is not an error: the card may retry a stale request.
  await clearApiKey(service)
})

test('storeApiKey explains a missing seam instead of writing nothing', async () => {
  await assert.rejects(() => storeApiKey(undefined, 'sk-x'), /credentials 服务/u)
})

test('saveApiKey validates before storing', async () => {
  const stored = []
  const store = async (value) => { stored.push(value) }

  await assert.rejects(
    () => saveApiKey({ apiKey: 'sk-shrt', host: '127.0.0.1', port: 18080, store, fetchImpl: async () => ({ ok: true }) }),
    /太短/u
  )
  assert.equal(stored.length, 0, 'a rejected key is never stored')

  await assert.rejects(
    () => saveApiKey({
      apiKey: 'sk-aaaaaaaa',
      host: '127.0.0.1',
      port: 18080,
      store,
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'nope' } }) })
    }),
    /API Key 无效/u
  )
  assert.equal(stored.length, 0, 'a key the server rejects is never stored')

  const result = await saveApiKey({
    apiKey: 'sk-bbbbbbbb',
    host: '127.0.0.1',
    port: 18080,
    store,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) })
  })
  assert.equal(result.configured, true)
  assert.equal(result.baseUrl, 'http://127.0.0.1:18080/api/v1')
  assert.equal(stored[0], 'sk-bbbbbbbb', 'the validated key is what gets stored')
  assert.equal(result.hint, 'sk-****bbbb', 'the card only ever sees a mask')
})

test('validateApiKey names the address it could not reach', async () => {
  await assert.rejects(
    () => validateApiKey({
      apiKey: 'sk-x',
      baseUrl: 'http://127.0.0.1:9/api/v1',
      fetchImpl: async () => { throw new Error('ECONNREFUSED') }
    }),
    /无法连接 WeKnora/u
  )
})

test('maskKey never leaks a full key', () => {
  assert.equal(maskKey(''), '')
  assert.equal(maskKey('short'), '****')
  assert.equal(maskKey('sk-1234567890abcdef'), 'sk-****cdef')
})
