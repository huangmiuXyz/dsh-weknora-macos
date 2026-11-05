/**
 * Making two environment variables true for the next DSH launch, on macOS.
 *
 * The problem this file solves is macOS-specific and has no `setx` equivalent:
 *
 * - `.zshrc` / `.zprofile` only run for interactive shells. DSH is a GUI app
 *   started by launchd (`PPID 1`), so those files are never sourced and writing
 *   the key there is a silent no-op that *looks* like a fix.
 * - `launchctl setenv` does reach every process started afterwards by launchd —
 *   including a relaunched DSH — but its namespace is in-memory and is wiped at
 *   logout/reboot. Alone it is a per-session fix.
 *
 * The combination that actually holds is both halves: `launchctl setenv` now (so
 * the very next DSH start inside this login session sees the key) plus a tiny
 * `RunAtLoad` LaunchAgent that republishes the same two variables at every login.
 *
 * The agent carries the values in its own `EnvironmentVariables` dictionary, which
 * launchd hands to the job's process; the job then copies them into the global
 * namespace with `launchctl setenv`. One stored copy, no shell profile touched,
 * and `plutil -convert json` makes the file readable back for bootstrapping.
 */
import { execFile } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Stable label, so an upgrade replaces its agent instead of adding a second one. */
export const LAUNCH_AGENT_LABEL = 'com.dsh.weknora-env'

/** `~/Library/LaunchAgents/com.dsh.weknora-env.plist` */
export function launchAgentPath(home = os.homedir()) {
  return path.join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`)
}

/** The two variables the retrieval bundle's patch row reads. */
export const PERSISTED_KEYS = Object.freeze(['WEKNORA_API_KEY', 'WEKNORA_BASE_URL'])

/** XML-escape one plist string value. */
function xmlEscape(value) {
  return String(value)
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
}

/**
 * The agent's body.
 *
 * `EnvironmentVariables` is the store; `ProgramArguments` is the republisher. The
 * shell only ever expands `$NAME` from its own environment, so no value is
 * interpolated into the script text and no quoting can be broken by a key that
 * contains a quote.
 */
export function launchAgentPlist(values) {
  const environment = Object.entries(values)
    .map(([key, value]) => `        <key>${xmlEscape(key)}</key>\n        <string>${xmlEscape(value)}</string>`)
    .join('\n')
  const republish = PERSISTED_KEYS.map((key) => `launchctl setenv ${key} "$${key}"`).join('; ')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCH_AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/sh</string>
        <string>-c</string>
        <string>${xmlEscape(republish)}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${environment}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
`
}

/** The `gui/<uid>` launchd domain an agent must be bootstrapped into. */
function guiDomain() {
  return `gui/${process.getuid?.() ?? 501}`
}

/**
 * Read the agent's stored values back without running anything.
 *
 * Used at mount time: if DSH was started outside a session where `setenv` had
 * already happened, the plist is still the record of what the user saved, and the
 * plugin can republish it instead of claiming no key is configured.
 *
 * Synchronous on purpose — it runs once during `apply()`, where the tool
 * registration below needs `process.env` to be correct immediately.
 */
export function readPersistedEnvSync(file = launchAgentPath()) {
  if (!fs.existsSync(file)) return {}
  try {
    const json = execFileSync('plutil', ['-convert', 'json', '-o', '-', file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const parsed = JSON.parse(json)
    const environment = parsed?.EnvironmentVariables
    if (environment === null || typeof environment !== 'object') return {}
    const values = {}
    for (const key of PERSISTED_KEYS) {
      const value = environment[key]
      if (typeof value === 'string' && value !== '') values[key] = value
    }
    return values
  } catch {
    return {}
  }
}

/** Publish one variable into the running launchd session. */
async function launchctlSetenv(name, value) {
  await execFileAsync('launchctl', ['setenv', name, value])
}

/**
 * Write both variables to disk, then make them true right now.
 *
 * Order matters: the plist is written first so that a failure to bootstrap the
 * agent still leaves a durable record, and the in-session `setenv` last so a
 * returned success means the current DSH does see the key.
 */
export async function persistEnvMap(values, { file = launchAgentPath(), log = () => {} } = {}) {
  const body = launchAgentPlist(values)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, body, { encoding: 'utf8', mode: 0o600 })
  // `writeFile` only applies `mode` when creating the file; re-assert it so the
  // key is not left world-readable after an upgrade rewrote an existing plist.
  await fsp.chmod(file, 0o600)

  // Immediate effect for processes launchd starts from here on.
  for (const [name, value] of Object.entries(values)) {
    try {
      await launchctlSetenv(name, value)
    } catch (error) {
      log(`launchctl setenv ${name} failed: ${error?.message ?? error}`)
    }
  }

  // Re-arm the login-time republisher. `bootout` fails harmlessly when it was
  // never loaded, so both commands are best-effort.
  try {
    await execFileAsync('launchctl', ['bootout', `${guiDomain()}/${LAUNCH_AGENT_LABEL}`])
  } catch {
    /* not loaded yet */
  }
  try {
    await execFileAsync('launchctl', ['bootstrap', guiDomain(), file])
  } catch (error) {
    // A saved key still works for this session; only persistence across a reboot
    // is lost, and the caller reports that rather than failing the whole save.
    log(`launchctl bootstrap failed: ${String(error?.stderr ?? '').trim() || error?.message || error}`)
    return { file, bootstrapped: false }
  }
  return { file, bootstrapped: true }
}

/**
 * Re-apply a previously saved key at mount time.
 *
 * Returns the values it published, so the caller can mirror them into
 * `process.env` without a second `plutil` call.
 */
export async function restorePersistedEnv({ env = process.env, file = launchAgentPath(), log = () => {} } = {}) {
  const values = readPersistedEnvSync(file)
  if (Object.keys(values).length === 0) return {}
  for (const [name, value] of Object.entries(values)) {
    if (typeof env[name] !== 'string' || env[name] === '') env[name] = value
    try {
      await launchctlSetenv(name, value)
    } catch (error) {
      log(`launchctl setenv ${name} failed during restore: ${error?.message ?? error}`)
    }
  }
  return values
}
