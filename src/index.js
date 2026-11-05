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
import { restorePersistedEnv } from './persist.js'
import { registerApiKeyRoute, registerBrowserRoute } from './routes.js'
import { subprocessSpawner } from './spawn.js'
import { WeknoraSupervisor } from './supervisor.js'
import { weknoraRunTool } from './tool.js'

export const name = 'dsh-weknora-macos'

/**
 * `tools` is the feature itself; `subprocess` is how the server is run. The server
 * is a long-lived managed child, so it goes through the host seam rather than
 * around it: the seam owns the process range, scrubs the parent environment, and
 * reaps a forgotten server when the service is disposed.
 */
export const inject = ['tools', 'subprocess']

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

  // A key saved in an earlier launch lives in the LaunchAgent, and launchd only
  // republishes it when its job runs at login. A DSH that was started from a
  // terminal, or reopened without a full logout, must not report itself
  // unconfigured — restore it here, before the tool is registered, so
  // `isConfigured()` is already correct on the first call.
  restorePersistedEnv({ log: hostLog }).catch((error) => hostLog(`restore failed: ${error?.message ?? error}`))

  // Registering through `effect` makes the tool disappear with the fiber, which is
  // what an HMR reload or a profile disable expects.
  ctx.effect(() => ctx.tools.register(weknoraRunTool(supervisor, { gate })), 'weknora: weknora_run tool')

  // The tool card's backend: a same-origin route the client half posts a key to.
  // `webServer` is awaited rather than probed: at apply time the service is not
  // provided yet, and `get()` quietly returns undefined — the exact failure that
  // made the route 404 on the first install. A composition without a web server
  // keeps the tool and has no card backend.
  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(() => {
      const offKey = registerApiKeyRoute(hostCtx, supervisor, { config, gate, log: hostLog })
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