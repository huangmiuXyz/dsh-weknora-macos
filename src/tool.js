/**
 * The one model-facing tool.
 *
 * `weknora_run` has no arguments on purpose: "start the project" is the whole job.
 * Anything narrower (a port, a mode) belongs in the plugin's Config, which a user
 * edits once, not in a call the model has to compose correctly every time.
 */
import { KEY_WAIT_MS, TOOL_NAME } from './protocol.js'
import { maskKey } from './apikey.js'
import { resolveApiKey } from './credentials.js'

/**
 * Model-facing description.
 *
 * It states the three facts that change how a model calls this: the call is
 * idempotent (no need to impose an ordering on later calls), the first call is
 * slow, and the answer is an address a human opens rather than something the
 * model fetches itself.
 */
const DESCRIPTION =
  'Start the WeKnora knowledge-base server bundled with this plugin and return the address of its ' +
  'local web UI. Idempotent: when a WeKnora server already answers, that instance is reused ' +
  '(state "already-running" or "adopted") instead of starting a second one, so calling this again ' +
  'is always safe. The first call after install creates and migrates the SQLite database and can ' +
  'take tens of seconds; later calls return in milliseconds. The server listens on loopback only, ' +
  'keeps its data under the DSH home directory, and is stopped when the plugin unloads. Call this ' +
  'once when a task needs the user\'s own knowledge base, then give the user the returned URL. ' +
  'When no WeKnora API key is configured yet, this call waits up to five minutes for the user to ' +
  'fill one into the tool card; the result then reports apiKeyConfigured.'

/** What one call reports. Kept flat: the model needs the address, not a state tree. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['running', 'baseUrl', 'port', 'state', 'host', 'dataDir'],
  properties: {
    running: { type: 'boolean', description: 'Whether a server is reachable after the call.' },
    baseUrl: { type: 'string', description: 'Address of the WeKnora web UI, trailing slash included.' },
    port: { type: 'integer', description: 'Loopback port the server is bound to.' },
    state: {
      type: 'string',
      enum: ['started', 'already-running', 'adopted'],
      description:
        'started: this call launched it. already-running: this process already had it. ' +
        'adopted: an existing server (possibly from an earlier DSH session) answers and is reused.'
    },
    host: { type: 'string', description: 'The bind address, normally 127.0.0.1.' },
    dataDir: {
      type: 'string',
      description: 'This plugin\'s home: the database (data/), uploads, logs and generated dotenv live here.'
    },
    startupMs: { type: 'integer', description: 'How long this call waited for readiness, when started.' },
    note: { type: 'string', description: 'Why the address differs from the configured port.' },
    apiKeyConfigured: {
      type: 'boolean',
      description: 'Whether a WeKnora API key is present for the retrieval tool this session.'
    },
    apiKeyHint: {
      type: 'string',
      description: 'Masked form of the configured key (`sk-****3f2a`); empty when none is configured.'
    },
    tools: {
      type: 'array',
      items: { type: 'string' },
      description:
        'The tools this call just registered. Before it runs, only weknora_run exists; after a successful call the ' +
        'retrieval and API tools are available for the next request.'
    }
  }
}

/** Plugin log line; a closed stdout must not fail a tool call. */
function hostLog(message) {
  try {
    console.log(`[dsh-weknora-macos] ${message}`)
  } catch {
    /* nothing to do */
  }
}

/** Human-facing rendering of one successful call. */
function renderText(value) {
  const lines = []
  if (value.state === 'started') lines.push(`WeKnora 已启动：${value.baseUrl}`)
  else if (value.state === 'adopted') lines.push(`WeKnora 已在运行（复用现有实例）：${value.baseUrl}`)
  else lines.push(`WeKnora 已在运行：${value.baseUrl}`)
  if (typeof value.startupMs === 'number') {
    lines.push(`启动耗时 ${(value.startupMs / 1000).toFixed(1)} 秒`)
  }
  if (typeof value.note === 'string' && value.note !== '') lines.push(value.note)
  if (value.state === 'started') lines.push('首次打开页面需要注册一个本地账号。')
  if (value.apiKeyConfigured === false) lines.push('尚未配置 API Key：在工具卡片里填写后可用于知识库检索。')
  if (Array.isArray(value.tools) && value.tools.length > 0) {
    lines.push(`检索工具：${value.tools.join(', ')}`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

export function weknoraRunTool(supervisor, { gate, credentials, keyWaitMs = KEY_WAIT_MS, onReady } = {}) {
  return {
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {}
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => renderText(value)
    },
    async execute(_args, exec) {
      const value = await supervisor.ensure({ signal: exec?.signal })

      // The card asks for the key on this very call's row, so the call is what
      // waits: returning first would answer "server up" while the user is still
      // typing, and the model would move on without retrieval. `gate` releases on
      // a saved key; timeout and cancellation both end the wait quietly.
      let waited = false
      if ((await resolveApiKey(credentials)) === undefined && gate !== undefined) {
        waited = true
        await gate.wait({ timeoutMs: keyWaitMs, signal: exec?.signal })
      }

      // Re-read after the wait: the card may have just stored a key.
      const key = await resolveApiKey(credentials)
      const configured = key !== undefined
      let note = value.note
      if (waited && !configured) {
        note = [note, `等待 API Key 超时（${Math.round(keyWaitMs / 1000)} 秒）。`].filter(Boolean).join('；')
      }

      const output = {
        ...value,
        apiKeyConfigured: configured,
        apiKeyHint: maskKey(key ?? ''),
        // Reported so the model learns what it just gained: the names exist only
        // after this call, which is otherwise impossible to discover.
        tools: []
      }
      // A missing note must stay absent: an explicit `undefined` is not
      // lossless JSON, and the tool runner rejects the whole result for it.
      if (typeof note === 'string' && note !== '') output.note = note

      // The server answers, so the tools that depend on it can exist. This runs
      // on every state (started, already-running, adopted) and is idempotent; a
      // failed reveal must not turn "the server is up" into an error, because the
      // address is still the answer to this call.
      if (typeof onReady === 'function') {
        try {
          const names = onReady()
          if (Array.isArray(names)) output.tools = names
        } catch (error) {
          hostLog(`注册检索工具失败：${String(error?.message ?? error)}`)
        }
      }
      return output
    }
  }
}