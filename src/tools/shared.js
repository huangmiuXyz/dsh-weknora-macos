/**
 * The five retrieval tools, mirroring WeKnora's own built-in MCP server.
 *
 * This is not a re-invention: `internal/mcpserver/tools_retrieve.go` in WeKnora
 * ships exactly these five tool names, parameter sets, and semantics, and that
 * file is the specification followed here. The reason to mirror it rather than
 * design something new is that those five were tuned against a real RAG workflow:
 *
 *   - `list_knowledge_bases` answers "what is in scope" before anything else;
 *   - `search_knowledge` takes a `mode` because semantic and keyword retrieval
 *     fail in different ways and a caller sometimes knows which it wants;
 *   - `grep_chunks` is a REGEX over chunk text, for identifiers and error codes
 *     that embeddings miss;
 *   - `list_documents` is what turns "a document about refunds" into an id;
 *   - `read_document` reads in order, pages by offset, and can filter by words.
 *
 * Collapsing them into one or two tools would lose those distinctions: grep's
 * regex is not read_document's all-words AND; `mode` has no equivalent elsewhere.
 *
 * Two deliberate departures from the built-in server, both because this plugin
 * talks REST rather than MCP:
 *
 *   1. Grep filters candidates LOCALLY. The REST search endpoint returns chunks
 *      ranked by relevance; a regex cannot be pushed to it. WeKnora's own grep
 *      caps its candidate pool at 30 and warns that matches can be missed — here
 *      the tool states which chunks it actually inspected, so "no match" is a
 *      fact about the text rather than a guess about the retriever.
 *   2. `read_document` concatenates chunk text instead of using a chunk-id
 *      cursor, because the REST preview returns parsed text and its chunk APIs
 *      are separate calls. Offsets are characters, which is what a caller can
 *      reason about when quoting.
 */
import { OPERATIONS_BY_NAME } from '../api-catalog.js'
import { call, fillPath, partitionArgs, unwrap } from '../http.js'

/** How many passages a search may return; WeKnora's own default is 10, cap 30. */
export const DEFAULT_LIMIT = 10
export const MAX_LIMIT = 30

/** Candidate chunks pulled before a local regex filter; larger than any page. */
export const GREP_CANDIDATES = 60

/** Where a grep found its match, with just enough text to recognise it. */
export const EXCERPT_PAD = 140

export const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean', description: 'Whether the call found anything.' },
    total: { type: 'integer', description: 'How many items were returned or matched.' },
    items: {
      type: 'array',
      items: { type: 'string' },
      description: 'One line or block per result: what it is, its id, and what matched.'
    },
    text: { type: 'string', description: "For read_document: the document's ordered text." },
    truncated: { type: 'boolean', description: 'Whether the output was cut to fit the context.' },
    next_offset: { type: 'integer', description: 'For read_document: pass as offset to continue.' },
    note: { type: 'string', description: 'Why a result is empty, or what to try next.' }
  }
}

/** Resolve one operation by name; a missing row is a build error, not a caller error. */
export function row(name) {
  const found = OPERATIONS_BY_NAME.get(name)
  if (found === undefined) throw new Error(`catalog 缺少 ${name}，请重新生成`)
  return found
}

/** Read one catalog operation with a flat parameter object. */
export async function run(name, params, { signal, accessors }) {
  const target = row(name)
  const { baseUrl, apiKey } = await accessors()
  const { path, query, body } = partitionArgs(target[2], target[6], params)
  const raw = await call({
    baseUrl,
    apiKey,
    method: target[1],
    path: fillPath(target[2], path),
    query,
    body,
    signal
  })
  return unwrap(raw).data
}

/** Clamp a requested page size into the range the server accepts. */
export function pageSize(value, fallback) {
  if (!Number.isInteger(value) || value <= 0) return fallback
  return Math.min(value, MAX_LIMIT)
}

/** Render a knowledge base as one line: id, name, and what it can do. */
export function kbLine(kb) {
  const id = String(kb?.id ?? '')
  const name = String(kb?.name ?? '(未命名)')
  const caps = []
  if (kb?.is_vector_enabled === true || kb?.vector_enabled === true) caps.push('semantic')
  if (kb?.is_keyword_enabled === true || kb?.keyword_enabled === true) caps.push('keyword')
  if (kb?.is_wiki_enabled === true || kb?.wiki_enabled === true) caps.push('wiki')
  const type = String(kb?.type ?? 'document')
  return `${id}  ${name}  [${type}]${caps.length === 0 ? '' : `  ${caps.join('+')}`}`
}

/** Render a document as one line: id, title, parse state. */
export function docLine(doc) {
  const id = String(doc?.id ?? '')
  const title = String(doc?.title ?? doc?.file_name ?? '(未命名)')
  const status = String(doc?.parse_status ?? '')
  const folder = String(doc?.folder_path ?? '')
  return `${id}  ${title}${folder === '' ? '' : `  [${folder}]`}  ${status}`
}

/** A passage: which document, which position, and the text. */
export function passageLine(hit, index) {
  const doc = String(hit?.knowledge_title ?? hit?.knowledge_filename ?? hit?.knowledge_id ?? '(未命名文档)')
  const id = String(hit?.knowledge_id ?? '')
  const position = typeof hit?.chunk_index === 'number' ? hit.chunk_index : index
  const text = String(hit?.content ?? '').trim()
  return `${doc}${id === '' ? '' : ` (${id})`} · 分块 ${position}\n${text}`
}
