/**
 * The API key, stored through the harness's own credential seam.
 *
 * `ctx.credentials` is the documented place for secrets in DSH: composition files
 * and settings carry a *reference* (a POSIX identifier such as
 * `WEKNORA_API_KEY`) while the value lives in `$DSH_HOME/.credentials.yaml` at
 * 0600. `dsh-image-gen` stores every provider key this way, and the settings page
 * never echoes a value back — this module follows that same seam instead of
 * inventing a file, a shell profile, or a launchd variable of its own.
 *
 * Two consequences worth stating, because they are the reason for the code below:
 *
 * 1. No environment variable is written. `process.env` is not a store: a value
 *    put there dies with the process, and on a GUI-launched DSH nothing ever
 *    re-reads a shell profile to restore it.
 * 2. The seam is optional in a composition. When `credentials` is absent the
 *    plugin still starts the server and reports the key as unconfigured, exactly
 *    as it does for a missing `webServer`.
 */

/** The reference this plugin owns: a WeKnora API key is all one reference holds. */
export const CREDENTIAL_REF = 'WEKNORA_API_KEY'

/** The base URL is not a secret, so it stays in the plugin's own Config. */

/** Whether a string could name a reference at all (the seam's own grammar). */
export function isCredentialRefName(value) {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)
}

/**
 * Resolve the stored key to a trimmed, non-blank string.
 *
 * A blank stored value never counts as configured: the host treats an empty entry
 * as absent, and a whitespace-only key must never be sent to a server.
 */
export async function resolveApiKey(service, ref = CREDENTIAL_REF) {
  // `service` may be a getter when the seam is provided after the plugin mounts.
  if (typeof service === 'function') return resolveApiKey(service(), ref)
  if (service === undefined || typeof service?.resolve !== 'function') return undefined
  try {
    const resolved = await service.resolve(isCredentialRefName(ref) ? ref : CREDENTIAL_REF)
    const value = typeof resolved?.value === 'string' ? resolved.value.trim() : ''
    return value === '' ? undefined : value
  } catch {
    return undefined
  }
}

/** Store the key. Throws with an actionable message when the seam is absent. */
export async function storeApiKey(service, value, ref = CREDENTIAL_REF) {
  if (typeof service === 'function') return storeApiKey(service(), value, ref)
  if (service === undefined || typeof service?.set !== 'function') {
    throw new Error('当前组合没有 credentials 服务，无法保存 API Key（请在桌面版或 web profile 中使用）')
  }
  await service.set(ref, value)
}

/** Forget the key. Safe when nothing was stored. */
export async function clearApiKey(service, ref = CREDENTIAL_REF) {
  if (typeof service === 'function') return clearApiKey(service(), ref)
  if (service === undefined || typeof service?.unset !== 'function') return
  try {
    await service.unset(ref)
  } catch {
    /* already absent */
  }
}
