/**
 * The one place this plugin talks to WeKnora over HTTP.
 *
 * Every tool goes through `call()`, so four things are decided once instead of
 * once per tool:
 *
 *   1. the base URL, which changes when the server is adopted on another port;
 *   2. the API key, read from the credential seam on every call rather than
 *      captured at registration (a key saved while the plugin is live must reach
 *      the very next call);
 *   3. what an error looks like to the model, which must read as a sentence a
 *      human could act on — WeKnora answers `{"success":false,"error":{...}}`,
 *      while its middleware answers bare `{"error":"..."}`, and a tool that
 *      simply forwarded either would hand the model a shape it cannot use;
 *   4. the size cap, because a listing tool that streams an unbounded body
 *      would fill the context window before the model saw anything.
 */

/** WeKnora's own envelope for a failed request. */
const MAX_CHARS = 60_000

/** Per-call deadline. Retrieval is local, but a cold embedding model is not. */
export const DEFAULT_TIMEOUT_MS = 60_000

/** Long-running chat needs its own budget: it answers via SSE, token by token. */
export const CHAT_TIMEOUT_MS = 300_000

/**
 * An error a tool can throw, carrying a message written for the model.
 *
 * `defineTool` turns any throw into an `isError` result, so the only thing that
 * matters is that `message` explains what went wrong and what to do — not that
 * the class is distinguishable.
 */
export class WeknoraApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message)
    this.name = 'WeknoraApiError'
    this.status = status
    this.body = body
  }
}

/** Join a base URL and a path without doubling or dropping the separator. */
function joinUrl(baseUrl, pathTemplate) {
  const base = String(baseUrl ?? '').replace(/\/+$/, '')
  const suffix = pathTemplate.startsWith('/') ? pathTemplate : `/${pathTemplate}`
  return `${base}${suffix}`
}

/**
 * Fill `{name}` placeholders from a flat argument object.
 *
 * WeKnora's Swagger spells parameters `{id}`; the catalog stores that spelling so
 * a path can be compared with the API documentation. A missing value is a model
 * error worth naming exactly — a request to `/knowledge-bases//` would reach the
 * server and come back as an unrelated 404.
 */
export function fillPath(pathTemplate, args) {
  return pathTemplate.replace(/\{([^}]+)\}/g, (_match, name) => {
    const value = args?.[name]
    if (value === undefined || value === null || value === '') {
      throw new WeknoraApiError(`缺少路径参数 "${name}"（${pathTemplate}）`)
    }
    return encodeURIComponent(String(value))
  })
}

/**
 * Split a tool's arguments into path, query, and body.
 *
 * The catalog hands every tool one flat argument object, because that is what a
 * model composes best; WeKnora needs the values in three different places. The
 * template and the schema together decide where each one goes:
 *
 *   - a name the PATH TEMPLATE mentions is a path parameter, full stop — the
 *     extractor does not preserve `in`, and guessing from the schema would turn
 *     `/sessions/{id}` into a query string;
 *   - a name the body schema declares travels in the JSON body;
 *   - everything else stays a query parameter.
 *
 * Unknown names are dropped rather than forwarded: WeKnora rejects unknown body
 * fields on some routes, so passing a model's leftover argument through would
 * turn a typo into a 400 the model cannot diagnose.
 */
export function partitionArgs(pathTemplate, schema, args) {
  const properties = schema?.properties ?? {}
  const bodySchema = properties.requestBody
  const bodyFields = new Set(Object.keys(bodySchema?.properties ?? {}))
  const pathNames = new Set([...String(pathTemplate ?? '').matchAll(/\{([^}]+)\}/g)].map((m) => m[1]))

  const path = {}
  const query = {}
  const body = {}

  for (const [key, value] of Object.entries(args ?? {})) {
    if (value === undefined) continue
    if (key === 'requestBody') {
      // A caller that nested the body explicitly keeps it whole.
      Object.assign(body, value ?? {})
      continue
    }
    if (pathNames.has(key)) {
      path[key] = value
      continue
    }
    if (bodyFields.has(key)) {
      body[key] = value
      continue
    }
    if (key in properties) query[key] = value
  }

  return { path, query, body }
}

/** Render any thrown value as the one sentence a model can act on. */
function describeFailure(status, text) {
  let detail = ''
  let code = 0
  try {
    const parsed = JSON.parse(text)
    const error = parsed?.error
    if (typeof error === 'string') detail = error
    else if (error !== undefined) {
      code = error.code ?? 0
      detail = error.message ?? ''
    }
    if (detail === '' && typeof parsed?.message === 'string') detail = parsed.message
  } catch {
    // A non-JSON body (an HTML error page, an empty 502) still has a status.
    detail = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
  }

  const suffix = detail === '' ? '' : `：${detail}`
  switch (status) {
    case 401:
      return `未认证：API Key 无效或已过期${suffix}`
    case 403:
      return `无权限：该 API Key 没有这个操作所需的能力，或知识库不在它的白名单内${suffix}`
    case 404:
      return `资源不存在${suffix}`
    case 409:
      return `冲突：资源已存在或状态不允许该操作${suffix}`
    case 429:
      return `请求过多：已触发限流或配额${suffix}`
    default:
      return code !== 0 ? `请求失败（HTTP ${status}，code ${code}）${suffix}` : `请求失败（HTTP ${status}）${suffix}`
  }
}

/**
 * A cap on what one call hands the model.
 *
 * Nothing here changes what the server returned; it changes how much of a large
 * listing survives into the context. The model is told the result was cut, so it
 * can narrow the query instead of assuming it saw everything.
 */
export function clip(text, limit = MAX_CHARS) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  if (value.length <= limit) return { text: value, truncated: false }
  return { text: `${value.slice(0, limit)}\n…（结果过长，已截断；请缩小查询范围）`, truncated: true }
}

/**
 * One HTTP call to WeKnora.
 *
 * @param {object} options
 * @param {string} options.baseUrl - `http://127.0.0.1:<port>/api/v1`
 * @param {string} options.apiKey - the workspace key; sent as `X-API-Key`
 * @param {string} options.method - `GET`, `POST`, …
 * @param {string} options.path - already-filled path template
 * @param {object} [options.query] - query values; undefined/null entries dropped
 * @param {object} [options.body] - JSON body; omitted when empty
 * @param {AbortSignal} [options.signal] - the tool call's cancellation
 * @param {number} [options.timeoutMs]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<string>} the raw response text
 */
export async function call({
  baseUrl,
  apiKey,
  method,
  path,
  query,
  body,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch
}) {
  if (typeof fetchImpl !== 'function') throw new WeknoraApiError('当前环境没有 fetch，无法访问 WeKnora')

  const url = new URL(joinUrl(baseUrl, path))
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item))
    } else url.searchParams.set(key, String(value))
  }

  const headers = { accept: 'application/json' }
  if (typeof apiKey === 'string' && apiKey !== '') headers['X-API-Key'] = apiKey

  const payload = body === undefined || Object.keys(body).length === 0 ? undefined : JSON.stringify(body)
  if (payload !== undefined) headers['content-type'] = 'application/json'

  // Two deadlines can end a call: the caller's (the user pressed stop) and this
  // one (the server hung). `AbortSignal.any` keeps whichever fires first without
  // inventing a third timer to clean up.
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])

  let response
  try {
    response = await fetchImpl(url, {
      method: method ?? 'GET',
      headers,
      body: payload,
      signal: combined
    })
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new WeknoraApiError(signal?.aborted === true ? '调用已取消' : `请求超时（${Math.round(timeoutMs / 1000)} 秒）`)
    }
    throw new WeknoraApiError(`无法连接 WeKnora（${url.origin}）：${String(error?.message ?? error)}`)
  }

  // SSE endpoints answer 200 with an event stream. Those are chat tools, which
  // read the body themselves; everything here expects JSON.
  const text = await response.text()
  if (!response.ok) throw new WeknoraApiError(describeFailure(response.status, text), { status: response.status, body: text })
  return text
}

/**
 * Unwrap WeKnora's `{success, data}` envelope and re-render it as text.
 *
 * The envelope itself is noise to a model: `success: true` on every successful
 * call adds nothing, and the `data` payload is what the tool description
 * promised. A response that is already bare JSON passes through unchanged,
 * because `/system/info` and a few admin routes do that.
 */
export function unwrap(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return { data: null, raw: '' }
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && 'data' in parsed && 'success' in parsed) {
      return { data: parsed.data, raw: trimmed, extra: parsed }
    }
    return { data: parsed, raw: trimmed }
  } catch {
    // Not JSON: a plain-text route, or an HTML page from a misrouted request.
    return { data: trimmed, raw: trimmed }
  }
}
