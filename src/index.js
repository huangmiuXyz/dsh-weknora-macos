/**
 * dsh-weknora-macos, HOST half.
 *
 * Installing this bundle puts one row into the profile and that row is enough: the
 * plugin injects `weknora_run`, and the tool owns the server's lifecycle. Nothing
 * is spawned at mount time — the plugin's only work here is registering the tool
 * and making the teardown path explicit.
 *
 * The plugin imports nothing from the harness at runtime. `tool.js` mirrors the
 * documented `ToolDefinition` shape, which is what keeps this package loadable in
 * a deployment whose `@deepseek-ai/*` copies differ from the dev checkout's.
 */
import { normalizeConfig } from './config.js'
import { KeyGate } from './gate.js'
import { registerApiKeyRoute, registerBrowserRoute } from './routes.js'
import { subprocessSpawner } from './spawn.js'
import { WeknoraSupervisor } from './supervisor.js'
import { weknoraRunTool } from './tool.js'
import { retrievalTools } from './tools/retrieval.js'
import { apiFetchTool } from './tools/api-fetch.js'
import { resolveApiKey } from './credentials.js'

export const name = 'dsh-weknora-macos'

/**
 * `tools` is the feature itself; `subprocess` is how the server is run. The server
 * is a long-lived managed child, so it goes through the host seam rather than
 * around it: the seam owns the process range, scrubs the parent environment, and
 * reaps a forgotten server when the service is disposed.
 */
export const inject = ['tools', 'subprocess', 'credentials']

/** Host log line; console output lands in the DSH host log. */
function hostLog(message) {
  try {
    console.log(`[dsh-weknora-macos] ${message}`)
  } catch {
    /* a closed stdout must not fail a mount */
  }
}

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const supervisor = new WeknoraSupervisor({
    config,
    spawner: subprocessSpawner(ctx.subprocess),
    log: hostLog
  })
  // Releases a `weknora_run` call that is waiting for the card's save button.
  const gate = new KeyGate()


  // The credential seam is passed as a getter, never captured at mount: a key
  // stored while the plugin is live must reach the very next tool call.
  const credentials = () => ctx.credentials

  /**
   * What a retrieval tool needs at CALL time, never at mount time.
   *
   * The port is only known once the server answers (and changes when an instance
   * on another port is adopted), and the key may be saved between two calls.
   * Reading both here keeps a long-lived session correct across a child restart.
   */
  const accessors = async () => {
    const current = await supervisor.ensure({})
    return {
      baseUrl: `${current.baseUrl.replace(/\/+$/, '')}/api/v1`,
      apiKey: (await resolveApiKey(credentials)) ?? ''
    }
  }

  // Five retrieval helpers plus one generic dispatcher. The helpers exist because
  // a conversation lives in them; the dispatcher covers the other 270 operations
  // without spending 270 KB of schema on every request.
  const retrieval = [...retrievalTools({ accessors }), apiFetchTool({ accessors })]

  /**
   * The tools `weknora_run` reveals once the server answers.
   *
   * Mounting all seven immediately would list five tools that can only fail until
   * a server exists — the model would try a search, get "无法连接", and have to
   * discover `weknora_run` on its own. Showing ONE tool that says "start me" is a
   * smaller surface for the same path.
   *
   * Registration is idempotent because `weknora_run` is called more than once per
   * session (every restart, every adopted instance). `revealed` is the guard; the
   * disposers are owned by this fiber so a reload takes them down with it.
   */
  let revealed = false
  const revealDisposers = []
  const reveal = () => {
    if (revealed) return retrieval.map((definition) => definition.name)
    revealed = true
    const names = []
    for (const definition of retrieval) {
      try {
        revealDisposers.push(ctx.tools.register(definition, `weknora: ${definition.name}`))
        names.push(definition.name)
      } catch (error) {
        hostLog(`注册 ${definition.name} 失败：${String(error?.message ?? error)}`)
      }
    }
    hostLog(`已注册 ${names.length} 个检索工具`)
    return names
  }

  ctx.effect(() => {
    const disposeRun = ctx.tools.register(
      weknoraRunTool(supervisor, { gate, credentials, onReady: reveal }),
      'weknora: weknora_run tool'
    )
    return () => {
      // The revealed tools go first: a tool that queries a stopped server is worse
      // than one that is simply absent.
      for (const dispose of revealDisposers.reverse()) {
        try {
          dispose()
        } catch (error) {
          hostLog(`卸载工具失败：${String(error?.message ?? error)}`)
        }
      }
      revealDisposers.length = 0
      revealed = false
      try {
        disposeRun()
      } catch (error) {
        hostLog(`卸载 weknora_run 失败：${String(error?.message ?? error)}`)
      }
    }
  }, 'weknora: tools')

  // The tool card's backend: a same-origin route the client half posts a key to.
  // `webServer` is awaited rather than probed: at apply time the service is not
  // provided yet, and `get()` quietly returns undefined — the exact failure that
  // made the route 404 on the first install. A composition without a web server
  // keeps the tool and has no card backend.
  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(() => {
      const offKey = registerApiKeyRoute(hostCtx, supervisor, {
        config,
        credentials,
        gate,
        log: hostLog
      })
      const offOpen = registerBrowserRoute(hostCtx, supervisor, { config, log: hostLog })
      return () => {
        offKey()
        offOpen()
      }
    }, 'weknora: card routes')
  })

  // The server is this plugin's child: unloading the plugin stops it. An adopted
  // instance is not ours and survives this, by design.
  ctx.effect(() => () => supervisor.dispose(), 'weknora: server lifecycle')
}

export { normalizeConfig } from './config.js'
export { WeknoraSupervisor } from './supervisor.js'
export { weknoraRunTool } from './tool.js'
export { TOOL_NAME } from './protocol.js'