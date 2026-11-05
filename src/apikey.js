/**
 * The one API key this plugin owns: validation, then storage.
 *
 * Storage is `ctx.credentials` (see `credentials.js`), the same seam
 * `dsh-image-gen` uses for every provider key. Nothing is written to
 * `process.env`, to a shell profile, or to a launchd variable: those are not
 * stores on macOS — a GUI-launched DSH never sources `.zshrc`, and `process.env`
 * dies with the process.
 *
 * The base URL is not a secret and stays in the plugin's own Config, so the two
 * values are no longer forced to travel together through an environment pair.
 */

/** Where a user can find the key, used in messages the card shows. */
export const KEY_SETTINGS_HINT = '设置 > 插件 > WeKnora'

/** The REST surface of one WeKnora server: the API root is `/api/v1`. */
export function apiBaseUrl(host, port) {
  return `http://${host}:${port}/api/v1`
}

/** A key short enough to show in the card: `sk-****3f2a`. Never the full value. */
export function maskKey(key) {
  if (typeof key !== 'string' || key.trim() === '') return ''
  const trimmed = key.trim()
  if (trimmed.length <= 8) return '****'
  return `${trimmed.slice(0, 3)}****${trimmed.slice(-4)}`
}

/**
 * Prove the key works before storing it.
 *
 * A key that fails here would leave the user with a "saved" state that never
 * retrieves anything, so the validation request is the price of the button doing
 * something real. `knowledge-bases` needs the `retrieve` capability and answers
 * 200 for any usable key; an empty list is still a success.
 */
export async function validateApiKey({ apiKey, baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 8_000 }) {
  if (typeof fetchImpl !== 'function') throw new Error('当前环境没有 fetch，无法校验 API Key')
  const url = `${String(baseUrl).replace(/\/+$/, '')}/knowledge-bases`
  let response
  try {
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json', 'X-API-Key': apiKey }
    })
  } catch (error) {
    throw new Error(`无法连接 WeKnora（${url}）：${String(error?.message ?? error)}`)
  }
  if (response.ok) return
  let detail = ''
  try {
    const body = await response.json()
    detail = typeof body?.error?.message === 'string' ? `：${body.error.message}` : ''
  } catch {
    /* a non-JSON error body still carries the status */
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`API Key 无效或没有检索能力（HTTP ${response.status}）${detail}`)
  }
  throw new Error(`校验 API Key 失败（HTTP ${response.status}）${detail}`)
}

/**
 * Validate a key and store it in the credential seam.
 *
 * `store` is injectable so the unit test never touches the real credential file.
 * Validation runs first: storing a key that does not work would make the card
 * claim a configuration that retrieves nothing.
 */
export async function saveApiKey({ apiKey, host, port, store, fetchImpl = globalThis.fetch }) {
  const key = String(apiKey ?? '').trim()
  if (key === '') throw new Error('请先填写 API Key')
  if (key.length < 8) throw new Error('API Key 太短，请检查是否复制完整')
  if (key.length > 512) throw new Error('API Key 太长，请检查是否粘贴了多余内容')

  const baseUrl = apiBaseUrl(host, port)
  await validateApiKey({ apiKey: key, baseUrl, fetchImpl })
  await store(key)

  return { ok: true, configured: true, hint: maskKey(key), baseUrl }
}
