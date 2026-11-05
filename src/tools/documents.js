/**
 * The two DOCUMENT tools: enumerate a knowledge base, then read one document.
 *
 * `list_documents` is what turns "a document about refunds" into an id, and
 * `read_document` reads that id in order — paging by character offset, or
 * filtering to the paragraphs that contain every word the caller named.
 *
 * Source of the surface: `internal/mcpserver/tools_retrieve.go` in WeKnora. One
 * departure: the built-in server pages by chunk cursor; this one pages by
 * character, because the REST preview returns parsed text and a caller quoting a
 * passage thinks in characters.
 */
import { RESULT_SCHEMA, docLine, pageSize, run } from './shared.js'
import { clip } from '../http.js'

/**
 * Build the document tools.
 *
 * @param {object} options
 * @param {() => Promise<{baseUrl: string, apiKey: string}>} options.accessors
 */
export function documentTools({ accessors }) {
  const listDocuments = {
    name: 'weknora_list_documents',
    description:
      '列出一个知识库里的文档，支持分页和按标题关键字过滤。返回的文档 id 可以传给 read_document。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['knowledge_base_id'],
      properties: {
        knowledge_base_id: { type: 'string', description: '知识库 id 或准确名称' },
        keyword: { type: 'string', description: '可选，按文档标题做子串过滤' },
        page: { type: 'number', description: '页码，从 1 开始，默认 1' },
        page_size: { type: 'number', description: '每页条数，默认 20，最大 100' }
      }
    },
    output: {
      schema: RESULT_SCHEMA,
      render: (_a, v) => [
        {
          type: 'text',
          text:
            v.items.length === 0
              ? (v.note ?? '（这个知识库里没有文档）')
              : `${v.items.join('\n')}\n\n共 ${v.total} 篇。`
        }
      ]
    },
    async execute(args, exec) {
      const kbId = typeof args?.knowledge_base_id === 'string' ? args.knowledge_base_id.trim() : ''
      if (kbId === '') throw new Error('knowledge_base_id 必填')

      const params = { id: kbId }
      if (typeof args?.keyword === 'string' && args.keyword.trim() !== '') params.keyword = args.keyword.trim()
      if (Number.isInteger(args?.page) && args.page > 0) params.page = args.page
      params.page_size = pageSize(args?.page_size, 20)

      const data = await run('weknora_list_knowledge_bases_knowledge', params, { signal: exec?.signal, accessors })
      const docs = Array.isArray(data) ? data : []
      if (docs.length === 0) {
        return {
          ok: false,
          total: 0,
          items: [],
          note: '这个知识库里没有匹配的文档。确认 knowledge_base_id 是否正确，或去掉 keyword 过滤。'
        }
      }
      return { ok: true, total: docs.length, items: docs.map(docLine) }
    }
  }

  const readDocument = {
    name: 'weknora_read_document',
    description:
      "读取一篇文档的正文。用 offset / limit 按字符分页翻读；传 query 则只返回包含**所有**空白分隔词的分块" +
      '（不区分大小写、顺序不限，不是精确短语）。query 模式最多返回 20 处匹配。返回 next_offset 时用它继续。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['knowledge_id'],
      properties: {
        knowledge_id: { type: 'string', description: '文档 id，来自检索结果或 list_documents' },
        offset: { type: 'number', description: '按字符计的起点，默认 0；用返回的 next_offset 继续' },
        limit: { type: 'number', description: '本次返回的字符数，默认 20000；query 模式下忽略' },
        query: {
          type: 'string',
          description: '可选，空白分隔的关键词；分块必须包含每一个词（顺序不限），不是精确短语'
        }
      }
    },
    output: {
      schema: RESULT_SCHEMA,
      render: (_a, v) => {
        if (v.text !== undefined) {
          const lines = [v.text]
          if (v.truncated === true) lines.push('\n…（还有后续内容）')
          if (v.note !== undefined) lines.push(v.note)
          return [{ type: 'text', text: lines.join('') }]
        }
        const lines = [v.items.length === 0 ? (v.note ?? '（没有匹配）') : v.items.join('\n\n')]
        if (v.note !== undefined && v.items.length > 0) lines.push(v.note)
        return [{ type: 'text', text: lines.join('\n') }]
      }
    },
    async execute(args, exec) {
      const docId = typeof args?.knowledge_id === 'string' ? args.knowledge_id.trim() : ''
      if (docId === '') throw new Error('knowledge_id 必填')

      const data = await run('weknora_preview_knowledge', { id: docId }, { signal: exec?.signal, accessors })
      const text =
        typeof data === 'string' ? data : typeof data?.content === 'string' ? data.content : ''
      if (text === '') {
        return {
          ok: false,
          text: '',
          items: [],
          note: '文档还没有可读正文：可能仍在解析中，或解析失败。用 weknora_api_fetch 查 knowledge.get 的 parse_status。'
        }
      }

      const query = typeof args?.query === 'string' ? args.query.trim() : ''
      if (query !== '') {
        // Every whitespace-separated word must occur — the built-in server's rule.
        // Not a phrase match: "退款 流程" finds a chunk mentioning both in any order.
        const words = query.split(/\s+/).filter((word) => word !== '').map((word) => word.toLowerCase())
        const hits = []

        // Split the document into paragraph-sized segments and keep the ones that
        // contain EVERY word. A single sliding window over the whole text would
        // match nearly any two words in a short document — "the whole file" is not
        // an answer to "where do these two terms meet". Segmenting is what makes
        // the result mean the terms occur together.
        const segments = []
        let cursor = 0
        for (const match of text.matchAll(/\n\s*\n/g)) {
          const end = match.index
          if (end > cursor) segments.push({ start: cursor, body: text.slice(cursor, end) })
          cursor = end + match[0].length
        }
        if (cursor < text.length) segments.push({ start: cursor, body: text.slice(cursor) })

        // A document with no blank-line structure is one segment; fall back to
        // sentence-sized windows so a long single paragraph is still scannable.
        if (segments.length === 1 && text.length > 800) {
          segments.length = 0
          const step = 600
          for (let start = 0; start < text.length; start += step) {
            segments.push({ start, body: text.slice(start, start + step + 200) })
          }
        }

        for (const segment of segments) {
          if (hits.length >= 20) break
          const lowerSegment = segment.body.toLowerCase()
          if (!words.every((word) => lowerSegment.includes(word))) continue
          const first = lowerSegment.indexOf(words[0])
          hits.push(`位置 ${segment.start + Math.max(0, first)}\n${segment.body.trim().replace(/\s+/g, ' ').slice(0, 800)}`)
        }
        if (hits.length === 0) {
          return {
            ok: false,
            total: 0,
            items: [],
            note: `文档里没有同时包含 ${words.join(' + ')} 的位置。减少关键词，或改用 grep_chunks 做正则匹配。`
          }
        }
        return { ok: true, total: hits.length, items: hits }
      }

      const offset = Number.isInteger(args?.offset) && args.offset > 0 ? args.offset : 0
      const limit = Number.isInteger(args?.limit) && args.limit > 0 ? args.limit : 20_000
      const slice = text.slice(offset, offset + limit)
      const clipped = clip(slice)
      const next = offset + limit
      const more = next < text.length
      const value = { ok: true, text: clipped.text, ...(clipped.truncated || more ? { truncated: true } : {}) }
      if (more) {
        value.next_offset = next
        value.note = `\n全文 ${text.length} 字；用 offset=${next} 继续读。`
      }
      return value
    }
  }

  return [listDocuments, readDocument]
}
