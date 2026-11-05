/**
 * The lifecycle of one WeKnora child process.
 *
 * Three rules shape everything below:
 *
 * 1. **Lazy.** Nothing starts when the plugin is mounted. A 261 MB server is not
 *    something the harness should boot alongside the UI; the first `weknora_run`
 *    pays the cost, later calls are free.
 * 2. **Idempotent.** If anything answers as WeKnora on the configured (or last
 *    used) port, it is adopted and its address returned. A second copy would mean
 *    a second database lock; adoption also survives a DSH restart, because the
 *    server keeps running when its parent exits on Windows.
 * 3. **Own only what we spawned.** An adopted server is never killed: it may be
 *    the user's own instance, started from a terminal or from a development
 *    workflow, and killing it would destroy their session.
 *
 * Spawning itself goes through a small adapter (`spawn.js`): the host's
 * `ctx.subprocess` seam when present, `node:child_process` otherwise.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { KILL_GRACE_MS, LOG_RING_LINES, LOG_TAIL_LINES, PROBE_TIMEOUT_MS, READY_POLL_MS } from './protocol.js'
import {
  assetPaths,
  ensureRuntime,
  freePort,
  isPortFree,
  missingAssets,
  packageRoot,
  pluginHome,
  probeWeKnora
} from './runtime.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class WeknoraSupervisor {
  #logStream = null

  constructor({
    config,
    spawner,
    root = packageRoot(),
    env = process.env,
    fetchImpl = globalThis.fetch,
    log = () => {}
  }) {
    this.config = config
    this.spawner = spawner
    this.root = root
    this.env = env
    this.fetchImpl = fetchImpl
    this.log = log
    this.assets = assetPaths(root)
    this.home = pluginHome(config, env)

    /** The live handle, or null when nothing of ours is running. */
    this.handle = null
    this.pending = null
    this.adopted = false
    this.baseUrl = undefined
    this.port = undefined
    this.startedAt = undefined
    this.startupMs = undefined
    /** Exit facts of the last child this supervisor started. */
    this.lastExit = undefined
    this.logTail = []
  }

  /** Whether `weknora_run` has a reachable server right now. */
  get running() {
    return this.handle !== null || this.adopted
  }

  /**
   * Make the server reachable.
   *
   * Concurrent calls share one attempt: two tool calls in the same step must not
   * race to spawn two servers on the same port.
   */
  async ensure({ signal } = {}) {
    if (this.pending !== null) return this.pending
    const attempt = this.#ensureInner({ signal })
    this.pending = attempt
    try {
      return await attempt
    } finally {
      this.pending = null
    }
  }

  async #ensureInner({ signal } = {}) {
    // 1. A child of ours: it may already be ready, or still migrating.
    if (this.handle !== null) {
      if (await this.#probe(this.port)) return this.#result('already-running')
      await this.#waitReady(this.port, this.config.startupTimeoutMs, signal)
      return this.#result('already-running')
    }

    // 2. Somebody else answers as WeKnora: adopt, never kill.
    const existing = await this.#findExisting()
    if (existing !== null) {
      this.adopted = true
      this.port = existing.port
      this.baseUrl = existing.baseUrl
      this.startedAt = Date.now()
      this.log(`adopted WeKnora at ${existing.baseUrl}`)
      return this.#result('adopted')
    }

    // 3. Nothing answers: start our own.
    return this.#start({ signal })
  }

  async #start({ signal } = {}) {
    const missing = missingAssets(this.assets)
    if (missing.length > 0) {
      throw new Error(
        `WeKnora 二进制与资源缺失（平台 ${process.platform}-${process.arch}）：\n${missing.join('\n')}`
      )
    }

    const runtime = await ensureRuntime({
      home: this.home,
      version: this.#packageVersion(),
      assets: this.assets,
      log: this.log
    })

    const port = await this.#choosePort()
    const env = this.#childEnv(runtime, port)
    const startedAt = Date.now()
    this.logTail = []
    this.lastExit = undefined
    this.#openLog(runtime.logPath)

    // The exit callback can fire before `spawn()` has returned its handle, so the
    // callback compares against this holder instead of against `this.handle`.
    const holder = { current: null }
    let handle
    try {
      handle = await this.spawner.spawn({
        exe: this.assets.exe,
        cwd: runtime.runtimeDir,
        env,
        onLine: (line) => this.#recordLine(line),
        onExit: (info) => {
          this.lastExit = { ...info, at: Date.now() }
          this.#closeLog()
          if (this.handle !== null && this.handle === holder.current) {
            this.handle = null
            this.baseUrl = undefined
            this.port = undefined
          }
        }
      })
    } catch (error) {
      this.#closeLog()
      throw new Error(`WeKnora 启动失败：${String(error?.message ?? error)}`)
    }
    holder.current = handle
    this.handle = handle
    this.log(`spawned ${this.spawner.kind} child on port ${port}`)

    try {
      await this.#waitReady(port, this.config.startupTimeoutMs, signal)
    } catch (error) {
      // A start that never answered is not something to keep around: terminate the
      // half-started child so the next call begins from a clean process.
      await this.stop().catch(() => {})
      throw error
    }

    this.adopted = false
    this.port = port
    this.baseUrl = `http://${this.config.host}:${port}/`
    this.startedAt = startedAt
    this.startupMs = Date.now() - startedAt
    await this.#writeState(runtime.statePath)
    this.log(`started WeKnora at ${this.baseUrl} in ${this.startupMs} ms`)

    return this.#result('started', this.startupMs)
  }

  /**
   * The port to bind.
   *
   * The configured port is tried first so the address stays the one the user may
   * have bookmarked; a busy port falls back to an OS-assigned one and says so in
   * the tool result, because a silently changed address is worse than a note.
   */
  async #choosePort() {
    const wanted = this.config.port
    if (wanted > 0 && (await isPortFree(this.config.host, wanted))) return wanted
    const port = await freePort(this.config.host)
    this.log(`port ${wanted} is busy; using ${port}`)
    return port
  }

  async #waitReady(port, timeoutMs, signal) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (signal?.aborted === true) {
        const error = new Error('weknora_run 已取消，本次启动已回滚；下次调用会重新拉起')
        error.name = 'AbortError'
        throw error
      }
      if (this.handle === null || this.lastExit !== undefined) throw this.#startFailure()
      if (await this.#probe(port)) return
      await sleep(READY_POLL_MS)
    }
    throw this.#startFailure(`在 ${timeoutMs} ms 内没有通过 /health 检查`)
  }

  #startFailure(reason) {
    const tail = this.logTail.slice(-LOG_TAIL_LINES).join('\n')
    const exit = this.lastExit
    const detail = tail === '' ? '' : `\n最近输出：\n${tail}`
    if (reason !== undefined) return new Error(`WeKnora 启动失败：${reason}${detail}`)
    if (exit !== undefined && exit.error !== undefined) {
      return new Error(`WeKnora 启动失败：${exit.error}${detail}`)
    }
    const code = exit?.code ?? null
    const name = exit?.signal ?? null
    return new Error(`WeKnora 启动失败：进程已退出（退出码 ${String(code)}，信号 ${String(name)}）${detail}`)
  }

  async #probe(port) {
    if (typeof port !== 'number' || port <= 0) return false
    return probeWeKnora(this.config.host, port, {
      fetchImpl: this.fetchImpl,
      timeoutMs: PROBE_TIMEOUT_MS
    })
  }

  /**
   * Look for a server worth adopting.
   *
   * The last used port is probed first: a server started on a fallback port keeps
   * answering there after a DSH restart, and the configured port may be occupied
   * by an unrelated program by then.
   */
  async #findExisting() {
    const state = await this.#readState()
    const candidates = []
    for (const candidate of [state?.port, this.config.port]) {
      if (typeof candidate !== 'number' || candidate <= 0) continue
      if (candidates.includes(candidate)) continue
      candidates.push(candidate)
    }
    for (const port of candidates) {
      if (await this.#probe(port)) {
        return { port, baseUrl: `http://${this.config.host}:${port}/` }
      }
    }
    return null
  }

  #result(state, startupMs) {
    const result = {
      running: true,
      baseUrl: this.baseUrl,
      port: this.port,
      state,
      host: this.config.host,
      dataDir: this.home
    }
    if (typeof startupMs === 'number') result.startupMs = startupMs
    if (this.config.port > 0 && this.port !== this.config.port) {
      result.note = `配置端口 ${this.config.port} 被占用，已改用 ${this.port}`
    }
    return result
  }

  #packageVersion() {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(this.root, 'package.json'), 'utf8'))
      return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
    } catch {
      return '0.0.0'
    }
  }

  /**
   * The child's environment: only the plugin's own variables.
   *
   * Ambient OS plumbing is the spawner's business — the subprocess seam scrubs the
   * parent environment itself, and the fallback adapter has an explicit allow-list.
   */
  #childEnv(runtime, port) {
    return {
      ENV_FILE: runtime.envPath,
      SERVER_HOST: this.config.host,
      SERVER_PORT: String(port),
      WEKNORA_WEB_DIR: this.assets.web,
      ...(this.config.extraEnv ?? {})
    }
  }

  #openLog(logPath) {
    try {
      this.#logStream = fs.createWriteStream(logPath, { flags: 'w' })
    } catch {
      this.#logStream = null
    }
  }

  #recordLine(line) {
    this.logTail.push(line)
    if (this.logTail.length > LOG_RING_LINES) this.logTail.shift()
    this.#logStream?.write(`${line}\n`)
  }

  #closeLog() {
    try {
      this.#logStream?.end()
    } catch {
      /* already closed */
    }
    this.#logStream = null
  }

  async #readState() {
    try {
      const text = await fsp.readFile(path.join(this.home, 'run.json'), 'utf8')
      const state = JSON.parse(text)
      return state !== null && typeof state === 'object' ? state : null
    } catch {
      return null
    }
  }

  async #writeState(statePath) {
    const state = {
      port: this.port,
      host: this.config.host,
      baseUrl: this.baseUrl,
      startedAt: this.startedAt,
      packageVersion: this.#packageVersion(),
      exePath: this.assets.exe
    }
    try {
      await fsp.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    } catch (error) {
      this.log(`could not write ${statePath}: ${error?.message ?? error}`)
    }
  }

  async #removeState() {
    try {
      await fsp.rm(path.join(this.home, 'run.json'), { force: true })
    } catch {
      /* nothing to remove */
    }
  }

  /**
   * Stop the server — only if this supervisor started it.
   *
   * Windows has no deliverable SIGTERM for a console-less child, so this ends the
   * managed range instead of asking politely; SQLite's WAL makes that safe
   * (verified: a server terminated this way restarts on the same database). The
   * only window worth worrying about is a migration in flight, which is why a
   * failed start waits for the child rather than racing it.
   */
  async stop() {
    const handle = this.handle
    const adopted = this.adopted
    this.handle = null
    this.adopted = false
    this.baseUrl = undefined
    this.port = undefined
    this.startedAt = undefined

    if (handle === null) {
      if (!adopted) await this.#removeState()
      return { stopped: false }
    }

    handle.terminate()
    const exited = await handle.waitExit(KILL_GRACE_MS)
    if (!exited) this.log(`WeKnora did not go quiet within ${KILL_GRACE_MS} ms of terminate()`)
    await this.#removeState()
    this.log('stopped WeKnora')
    return { stopped: exited }
  }

  /** Plugin unload / DSH exit: give the child back, unless the user opted out. */
  async dispose() {
    if (this.config.stopOnDispose !== true) return { stopped: false, kept: true }
    try {
      return await this.stop()
    } catch (error) {
      this.log(`stop failed: ${error?.message ?? error}`)
      return { stopped: false }
    }
  }
}