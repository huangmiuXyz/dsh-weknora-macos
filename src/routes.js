/**
 * The card's host side: one same-origin route the tool view calls.
 *
 * `GET`  → what the card should show (running, address, key state, masked hint)
 * `POST` → validate and save one API key, then report the new state
 *
 * The route is registered through the host's web-server service; a composition
 * without that service keeps the tool working and simply has no card backend.
 * The browser talks to it with `fetch` on the page's own origin, which is how
 * the DSH client half reaches its host without any additional RPC plumbing.
 */
import { apiBaseUrl, maskKey, saveApiKey } from './apikey.js'
import { openExternal } from './browser.js'
import { clearApiKey, resolveApiKey, storeApiKey } from './credentials.js'

export const API_KEY_ROUTE = '/weknora-run/api-key'
export const OPEN_ROUTE = '/weknora-run/open'

/** Bodies are two small JSON objects; anything larger is a mistake. */
const MAX_BODY_BYTES = 16_384

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        resolve({})
        return
      }
      try {
        const value = JSON.parse(text)
        resolve(value !== null && typeof value === 'object' ? value : {})
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** The address this plugin's server answers on, or null before a first start. */
function serverAddress(supervisor, config) {
  const port = supervisor.port ?? (config.port > 0 ? config.port : undefined)
  if (typeof port !== 'number' || port <= 0) return null
  return { host: config.host, port, baseUrl: apiBaseUrl(config.host, port) }
}

/**
 * The live credential service.
 *
 * Accepts either the service or a getter: `index.js` passes a getter because the
 * service may be provided after this plugin's fiber starts, and a captured value
 * would freeze the "no credentials" answer forever.
 */
function credentialService(credentials) {
  return typeof credentials === 'function' ? credentials() : credentials
}

/** The card's view of the world: address, key state, masked hint. */
async function currentState(supervisor, config, credentials) {
  const address = serverAddress(supervisor, config)
  const key = await resolveApiKey(credentialService(credentials))
  return {
    configured: key !== undefined,
    hint: maskKey(key ?? ''),
    running: supervisor.running,
    // A card that only knows `running` renders "未启动" during a cold start,
    // which reads as "the call failed" while it is in fact still working.
    starting: supervisor.starting,
    baseUrl: supervisor.baseUrl ?? null,
    port: address?.port ?? null,
    host: config.host,
    apiBaseUrl: address?.baseUrl ?? null
  }
}

/**
 * Register `API_KEY_ROUTE`; returns a disposer (a no-op when the host has no
 * web-server service). Every failure is answered as JSON so the card can show
 * the reason instead of a bare 500.
 */
export function registerApiKeyRoute(ctx, supervisor, { config, credentials, fetchImpl, webServer, gate, log = () => {} } = {}) {
  const service = webServer ?? (typeof ctx?.get === 'function' ? ctx.get('webServer') : undefined)
  if (service === undefined || typeof service?.register !== 'function') {
    log('webServer service is unavailable: the card cannot save an API key on this host')
    return () => {}
  }

  const handler = async (req, res) => {
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        sendJson(res, 200, await currentState(supervisor, config, credentials))
        return
      }
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'GET, POST')
        res.end()
        return
      }

      const body = await readJsonBody(req)
      const address = serverAddress(supervisor, config)
      if (address === null) {
        const error =
          supervisor.starting === true
            ? 'WeKnora 正在启动中，稍候再保存 API Key'
            : 'WeKnora 还没有启动，请先调用一次 weknora_run'
        sendJson(res, 409, { ok: false, error })
        return
      }
      // A DELETE arrives as POST { clear: true }: the same route, one body field.
      if (body.clear === true) {
        await clearApiKey(credentialService(credentials))
        gate?.notify?.()
        sendJson(res, 200, { ok: true, cleared: true, ...(await currentState(supervisor, config, credentials)) })
        return
      }
      const saved = await saveApiKey({
        apiKey: body.apiKey,
        host: address.host,
        port: address.port,
        store: (value) => storeApiKey(credentialService(credentials), value),
        fetchImpl
      })
      // Release a `weknora_run` call that is waiting on this very save.
      gate?.notify?.()
      sendJson(res, 200, { ...saved, ...(await currentState(supervisor, config, credentials)) })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
    }
  }

  const dispose = service.register({ kind: 'exact', path: API_KEY_ROUTE, handler })
  return () => {
    try {
      if (typeof dispose === 'function') dispose()
    } catch {
      /* the host tears its own routes down */
    }
  }
}

/**
 * `POST OPEN_ROUTE` — hand the running server's address to the default browser.
 *
 * The client cannot do this itself (an in-shell `window.open` opens the app's
 * own window, or is blocked), and the address is this supervisor's, never the
 * request body's, so the route cannot be turned into an open-anything endpoint.
 */
export function registerBrowserRoute(ctx, supervisor, { config, webServer, log = () => {} } = {}) {
  const service = webServer ?? (typeof ctx?.get === 'function' ? ctx.get('webServer') : undefined)
  if (service === undefined || typeof service?.register !== 'function') {
    log('webServer service is unavailable: the card cannot open a browser on this host')
    return () => {}
  }

  const handler = async (req, res) => {
    try {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      const address = serverAddress(supervisor, config)
      const url = supervisor.baseUrl ?? (address === null ? null : `http://${address.host}:${address.port}/`)
      if (supervisor.running !== true || url === null) {
        // Three different situations, three different answers: a cold start is
        // "wait", not "start one". Telling a user to call weknora_run while that
        // very call is still migrating the database is the message being wrong,
        // not the state.
        const error =
          supervisor.starting === true
            ? 'WeKnora 正在启动中（首次启动要建库和迁移，可能需要几十秒），请稍候再试'
            : 'WeKnora 还没有启动，请先调用一次 weknora_run'
        sendJson(res, 409, { ok: false, error })
        return
      }
      await openExternal(url)
      sendJson(res, 200, { ok: true, url })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }

  const dispose = service.register({ kind: 'exact', path: OPEN_ROUTE, handler })
  return () => {
    try {
      if (typeof dispose === 'function') dispose()
    } catch {
      /* the host tears its own routes down */
    }
  }
}