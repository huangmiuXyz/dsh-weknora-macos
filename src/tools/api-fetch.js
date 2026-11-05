/**
 * `weknora_api_fetch` — the escape hatch for everything the five retrieval tools
 * do not cover.
 *
 * The plugin registers six tools: `weknora_run`, five retrieval helpers, and this
 * one. The retrieval helpers are declared because a conversation lives in them,
 * and a tool the model cannot see is a tool it will not use. Everything else —
 * creating a knowledge base, editing FAQ entries, listing models, driving the wiki
 * — is one call away through here.
 *
 * The alternative was registering 275 tools: 270 KB of schemas on every request,
 * for operations most conversations never touch. A directory the model searches
 * costs nothing until it is read.
 *
 * Two properties make a generic dispatcher safe to hand a model:
 *
 *   1. **It can only reach routes this build knows.** `method`+`path` is
 *      normalised and matched against the catalog, so a typo is refused with the
 *      real methods for that path instead of becoming a probe of the server.
 *   2. **A write must be asked for.** Only GET runs without `allow_write`, and the
 *      method is taken from the CATALOG rather than the request — omitting the
 *      flag cannot be used to slip a DELETE through.
 */
import { GROUPS, OPERATIONS, OPERATIONS_BY_NAME } from '../api-catalog.js'
import { call, clip, fillPath, partitionArgs, unwrap, CHAT_TIMEOUT_MS } from '../http.js'

export const API_FETCH_NAME = 'weknora_api_fetch'

/** Chat endpoints answer with `text/event-stream`; they need their own reader. */
const STREAMING = new Set(['/knowledge-chat/{session_id}', '/agent-chat/{session_id}'])

/** Methods that need no `allow_write`: a read cannot lose data. */
const READ_METHODS = new Set(['GET'])

/** How many operations one `list` returns. More than this stops being scannable. */
const PAGE_SIZE = 25

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean', description: 'Whether the call did what was asked.' },
    status: { type: 'integer', description: 'HTTP status of the WeKnora response, for action=call.' },
    truncated: { type: 'boolean', description: 'Whether a large body was cut to fit the context.' },
    data: { description: 'The response payload for action=call, with the WeKnora envelope removed.' },
    operations: {
      type: 'array',
      items: { type: 'string' },
      description: 'For action=list: one line per matching operation — name, METHOD, path, and description.'
    },
    total: { type: 'integer', description: 'For action=list: how many operations matched, before paging.' },
    note: { type: 'string', description: 'Guidance: why a result is empty, or what to do next.' }
  }
}

const DESCRIPTION =
  'Call any WeKnora REST operation the five retrieval tools do not cover — creating and editing knowledge bases, ' +
  'documents, FAQ entries, wiki pages, models, agents, data sources, MCP services. Two actions. ' +
  'action="list" searches the operation directory: pass `query` for a keyword, or `capability` to browse a group; ' +
  'no filter lists the groups. action="call" runs ONE operation, addressed by `operation` (the name `list` ' +
  'printed) or by `method` + `path`. Arguments go in `params` as one flat object — path placeholders like {id}, ' +
  'query values, and body fields are all taken from it and placed where the server wants them. Only GET runs by ' +
  'default: set `allow_write: true` for POST/PUT/PATCH/DELETE, after reading what the operation does. ' +
  'For reading and searching documents, prefer the dedicated tools — they are shaped for the task.'

/** One scannable line per operation. */
function formatOperation(row) {
  const [name, method, pathTemplate, , title, description] = row
  const summary = description !== '' ? description : title
  return `${name}  ${method} ${pathTemplate}${summary === '' ? '' : `  — ${summary}`}`
}

/** Rank matches so the likeliest answer lands on page one. */
function score(row, needle) {
  const [name, , pathTemplate, , title, description] = row
  let total = 0
  if (name === needle || pathTemplate === needle) total += 100
  if (name.includes(needle)) total += 30
  if (pathTemplate.includes(needle)) total += 20
  if (title.toLowerCase().includes(needle)) total += 12
  if (description.toLowerCase().includes(needle)) total += 6
  return total
}

/** Operations matching the query and/or group, best first; null for a bad group. */
function searchOperations(query, capability) {
  const needle = String(query ?? '').trim().toLowerCase()
  let rows = OPERATIONS
  if (capability !== undefined && capability !== '') {
    const names = GROUPS[capability]
    if (names === undefined) return null
    rows = rows.filter((row) => names.includes(row[0]))
  }
  if (needle === '') return [...rows].sort((a, b) => a[0].localeCompare(b[0]))
  return rows
    .map((row) => ({ row, score: score(row, needle) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.row[0].localeCompare(b.row[0]))
    .map((entry) => entry.row)
}

/**
 * Every template shape a concrete path could correspond to.
 *
 * A caller that already has an id pastes it, so an exact match is tried first.
 * When that fails, each segment is replaced in turn by a known placeholder name:
 * WeKnora's routes vary in which placeholder they use (`{id}`, `{tag_id}`,
 * `{entry_id}`, `{slug}`), and a wrong guess only costs an error message that
 * names the real methods.
 */
function templateShapes(rawPath) {
  const wanted = String(rawPath ?? '').trim().split('?')[0].replace(/\/+$/, '')
  const shapes = new Set([wanted])
  const segments = wanted.split('/')
  const placeholders = ['{id}', '{tag_id}', '{entry_id}', '{slug}', '{share_id}', '{field}', '{task_id}']
  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index] === '') continue
    for (const placeholder of placeholders) {
      const copy = [...segments]
      copy[index] = placeholder
      shapes.add(copy.join('/'))
    }
  }
  return [...shapes]
}

/**
 * Recover the concrete values a caller put where the template has placeholders.
 *
 * `/knowledge-bases/kb-1/tags` against `/knowledge-bases/{id}/tags` yields
 * `{ id: 'kb-1' }`. Only positions where the template has a placeholder are read,
 * so a fixed word can never be mistaken for a value.
 */
function liftPathValues(concrete, template) {
  const actual = String(concrete).split('/')
  const shape = String(template).split('/')
  const params = {}
  for (let index = 0; index < shape.length; index += 1) {
    const match = /^\{([^}]+)\}$/.exec(shape[index] ?? '')
    if (match === null) continue
    const value = actual[index]
    if (value !== undefined && value !== '') params[match[1]] = value
  }
  return params
}

/** Resolve `method` + `path` onto a catalog row, or explain why it cannot. */
function resolveByPath(method, rawPath) {
  const wanted = String(rawPath ?? '').trim().split('?')[0].replace(/\/+$/, '')
  const upper = String(method ?? '').trim().toUpperCase()
  if (wanted === '') return { row: null, reason: '' }

  for (const row of OPERATIONS) {
    if (row[2] === wanted) return { row, reason: '' }
  }

  const shapes = templateShapes(wanted)
  for (const content of shapes) {
    for (const row of OPERATIONS) {
      if (row[2] !== content) continue
      if (upper !== '' && row[1] !== upper) continue
      // The concrete path carries values the template does not: without lifting
      // them back into `params`, a caller who pasted `/knowledge-bases/kb-1` would
      // match the template and then fail with "缺少路径参数 id".
      return { row, reason: '', params: liftPathValues(wanted, row[2]) }
    }
  }

  const samePath = OPERATIONS.filter((row) => shapes.includes(row[2]))
  if (samePath.length > 0) {
    const methods = [...new Set(samePath.map((row) => row[1]))].join(' / ')
    return { row: null, reason: `${wanted} 存在，但方法是 ${methods}，不是 ${upper || '（未指定）'}。` }
  }
  return { row: null, reason: `${wanted} 不在操作目录里；先用 action=list 搜索。` }
}

/** Assemble an SSE answer stream into its text. */
function readStream(raw) {
  const answers = []
  let error = ''
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    try {
      const event = JSON.parse(line.slice(5).trim())
      if (event?.response_type === 'error') error = String(event?.content ?? '流式回答失败')
      else if (event?.response_type === 'answer' && typeof event.content === 'string') answers.push(event.content)
    } catch {
      /* a frame split across chunks; the next line completes it */
    }
  }
  return { answer: answers.join(''), error }
}

/** Run one catalog operation with a flat parameter object. */
async function callOperation(row, params, { signal, accessors }) {
  const [, method, pathTemplate, , , , schema] = row
  const { baseUrl, apiKey } = await accessors()
  const { path, query, body } = partitionArgs(pathTemplate, schema, params)
  const streaming = STREAMING.has(pathTemplate)

  const raw = await call({
    baseUrl,
    apiKey,
    method,
    path: fillPath(pathTemplate, path),
    query,
    body,
    signal,
    timeoutMs: streaming ? CHAT_TIMEOUT_MS : undefined
  })

  if (streaming) {
    const collected = readStream(raw)
    if (collected.error !== '') throw new Error(`WeKnora 流式回答失败：${collected.error}`)
    const answer = clip(collected.answer)
    return { ok: true, status: 200, data: answer.text, ...(answer.truncated ? { truncated: true } : {}) }
  }

  const { data, extra } = unwrap(raw)
  const rendered = clip(
    data === null ? '（无数据）' : typeof data === 'string' ? data : JSON.stringify(data, null, 1)
  )
  const value = { ok: true, status: 200 }
  if (rendered.truncated) value.truncated = true
  if (extra !== undefined && typeof extra.total === 'number') {
    // Pagination is the one envelope field worth keeping: it says how much the
    // caller did NOT receive.
    const pagination = { total: extra.total }
    if (typeof extra.page === 'number') pagination.page = extra.page
    if (typeof extra.page_size === 'number') pagination.page_size = extra.page_size
    pagination.data = rendered.text
    value.data = pagination
  } else {
    value.data = rendered.text
  }
  return value
}

/**
 * Build the tool.
 *
 * @param {object} options
 * @param {() => Promise<{baseUrl: string, apiKey: string}>} options.accessors
 */
export function apiFetchTool({ accessors }) {
  return {
    name: API_FETCH_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'call'],
          description: 'list: search the operation directory. call: run one operation.'
        },
        query: {
          type: 'string',
          description: 'action=list: keyword matched against name, path, title, and description.'
        },
        capability: {
          type: 'string',
          description: 'action=list: restrict to one group. An unfiltered list reports the available groups.'
        },
        operation: {
          type: 'string',
          description: 'action=call: operation name as printed by action=list, e.g. weknora_create_knowledge_base.'
        },
        method: { type: 'string', description: 'action=call: HTTP method, when addressing by path.' },
        path: {
          type: 'string',
          description: 'action=call: path template, e.g. /knowledge-bases/{id}/faq/entries.'
        },
        params: {
          type: 'object',
          additionalProperties: true,
          description: 'action=call: one flat object holding path placeholders, query values, and body fields.'
        },
        allow_write: {
          type: 'boolean',
          description: 'action=call: required for POST/PUT/PATCH/DELETE. GET never needs it.'
        },
        offset: {
          type: 'integer',
          description: `action=list: skip this many matches. Page size is ${PAGE_SIZE}.`
        }
      }
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        if (value.operations !== undefined) {
          const body = value.operations.length === 0 ? '（没有匹配的操作）' : value.operations.join('\n')
          const more =
            typeof value.total === 'number' && value.total > value.operations.length
              ? `\n…共 ${value.total} 条，已显示 ${value.operations.length} 条；用 offset 翻页或收窄 query。`
              : ''
          return [{ type: 'text', text: `${body}${more}${value.note === undefined ? '' : `\n${value.note}`}` }]
        }
        const lines = [`HTTP ${value.status ?? 200}`]
        if (value.truncated === true) lines.push('（结果已截断）')
        lines.push(typeof value.data === 'string' ? value.data : JSON.stringify(value.data ?? null, null, 1))
        return [{ type: 'text', text: lines.join('\n') }]
      }
    },
    async execute(args, exec) {
      const action = typeof args?.action === 'string' ? args.action : ''
      const capability = typeof args?.capability === 'string' ? args.capability.trim() : ''

      if (action === 'list') {
        const matched = searchOperations(args?.query, capability)
        if (matched === null) {
          return {
            ok: false,
            operations: [],
            total: 0,
            note: `未知的 capability "${capability}"；合法值：${Object.keys(GROUPS).join(', ')}`
          }
        }
        // An unfiltered first call lists the GROUPS: 275 names is not a useful
        // first page, but knowing the 15 groups are is.
        if (String(args?.query ?? '').trim() === '' && capability === '') {
          const lines = Object.entries(GROUPS).map(([group, names]) => `${group}(${names.length})`)
          return {
            ok: true,
            operations: [],
            total: 0,
            note: `未指定过滤条件。可用 capability：${lines.join(', ')}。建议先 capability=<组> 或用 query 搜索。`
          }
        }
        const offset = Number.isInteger(args?.offset) && args.offset > 0 ? args.offset : 0
        const page = matched.slice(offset, offset + PAGE_SIZE).map(formatOperation)
        return {
          ok: true,
          operations: page,
          total: matched.length,
          ...(page.length === 0 && offset > 0 ? { note: '已经翻到末尾。' } : {})
        }
      }

      if (action !== 'call') throw new Error('action 必须是 "list" 或 "call"')

      let target = null
      let lifted = {}
      const operationName = typeof args?.operation === 'string' ? args.operation.trim() : ''
      if (operationName !== '') {
        target = OPERATIONS_BY_NAME.get(operationName) ?? null
        if (target === null) {
          const near = searchOperations(operationName, '').slice(0, 5).map((row) => row[0])
          throw new Error(
            `未知操作 "${operationName}"。${near.length > 0 ? `相近的有：${near.join(', ')}。` : ''}先用 action=list 搜索。`
          )
        }
      } else {
        const resolved = resolveByPath(args?.method, args?.path)
        if (resolved.row === null) {
          throw new Error(resolved.reason === '' ? '需要 operation，或 method + path' : resolved.reason)
        }
        target = resolved.row
        // Values from the concrete path fill any placeholder the caller did not
        // repeat in `params`; an explicit `params` entry still wins.
        lifted = resolved.params ?? {}
      }

      // The method comes from the CATALOG, never from the request, so leaving out
      // `allow_write` cannot be used to reach a write route.
      if (!READ_METHODS.has(target[1]) && args?.allow_write !== true) {
        throw new Error(
          `${target[0]} 是 ${target[1]}，会修改数据。确认后把 allow_write 设为 true 再调用。` +
            `（${target[5] !== '' ? target[5] : target[4]}）`
        )
      }

      const given = args?.params !== null && typeof args?.params === 'object' ? args.params : {}
      return callOperation(target, { ...lifted, ...given }, { signal: exec?.signal, accessors })
    }
  }
}
