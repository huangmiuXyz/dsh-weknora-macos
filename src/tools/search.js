/**
 * The three SEARCH tools, mirroring WeKnora's built-in MCP server.
 *
 * `weknora_list_knowledge_bases` answers "what is in scope"; `search_knowledge`
 * takes a `mode` because semantic and keyword retrieval fail differently; and
 * `grep_chunks` is a regex over chunk text, for the identifiers and error codes
 * embeddings miss. Collapsing them would lose those distinctions — grep's regex
 * is not `search`'s ranking, and `mode` has no equivalent elsewhere.
 *
 * Source of the surface: `internal/mcpserver/tools_retrieve.go` in WeKnora.
 */
import {
  DEFAULT_LIMIT,
  GREP_CANDIDATES,
  MAX_LIMIT,
  RESULT_SCHEMA,
  EXCERPT_PAD,
  kbLine,
  pageSize,
  passageLine,
  run
} from './shared.js'

/**
 * Build the search tools.
 *
 * @param {object} options
 * @param {() => Promise<{baseUrl: string, apiKey: string}>} options.accessors
 */
export function searchTools({ accessors }) {
  const listKnowledgeBases = {
    name: 'weknora_list_knowledge_bases',
    description:
      '列出可访问的知识库，含 id、名称、描述和它支持哪些检索方式（semantic / keyword / wiki）。先调这个了解范围；' +
      '其他工具既接受 id 也接受准确名称。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: RESULT_SCHEMA,
      render: (_a, v) => [
        {
          type: 'text',
          text:
            v.items.length === 0
              ? (v.note ?? '（没有知识库）')
              : `${v.items.join('\n')}\n\n共 ${v.total} 个。`
        }
      ]
    },
    async execute(_args, exec) {
      const data = await run('weknora_list_knowledge_bases', {}, { signal: exec?.signal, accessors })
      const list = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : []
      return { ok: list.length > 0, total: list.length, items: list.map(kbLine) }
    }
  }

  const searchKnowledge = {
    name: 'weknora_search_knowledge',
    description:
      '在范围内的知识库里检索最相关的片段，返回文档 id、标题和原文。mode=hybrid（默认）同时用语义和关键词；' +
      'semantic 按意思排；keyword 精确匹配术语、编号、代码或名称。只知道大意时用它，知道原文时用 grep_chunks。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: '自然语言问题、主题，或要精确匹配的术语' },
        mode: {
          type: 'string',
          enum: ['hybrid', 'semantic', 'keyword'],
          description: 'hybrid（默认）/ semantic / keyword'
        },
        limit: { type: 'number', description: `返回片段数，默认 ${DEFAULT_LIMIT}，最大 ${MAX_LIMIT}` },
        knowledge_base_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '限定知识库 id 或名称；省略则搜范围内全部'
        },
        knowledge_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '限定 1~100 个文档 id（来自 list_documents 或上次检索结果），在排序前生效'
        }
      }
    },
    output: {
      schema: RESULT_SCHEMA,
      render: (_a, v) => [
        {
          type: 'text',
          text:
            v.items.length === 0
              ? (v.note ?? '（没有检索到片段）')
              : `${v.items.join('\n\n')}\n\n共 ${v.total} 段。`
        }
      ]
    },
    async execute(args, exec) {
      const query = typeof args?.query === 'string' ? args.query.trim() : ''
      if (query === '') throw new Error('query 必填')

      const limit = Math.min(pageSize(args?.limit, DEFAULT_LIMIT), MAX_LIMIT)
      const params = { query, match_count: limit }
      if (Array.isArray(args?.knowledge_base_ids) && args.knowledge_base_ids.length > 0) {
        params.knowledge_base_ids = args.knowledge_base_ids
      }
      if (Array.isArray(args?.knowledge_ids) && args.knowledge_ids.length > 0) {
        params.knowledge_ids = args.knowledge_ids
      }
      // `mode` maps onto the REST switches: semantic-only disables keyword
      // matching, keyword-only disables vector matching.
      const mode = typeof args?.mode === 'string' ? args.mode : 'hybrid'
      if (mode === 'semantic') params.disable_keywords_match = true
      if (mode === 'keyword') params.disable_vector_match = true

      const data = await run('weknora_search_knowledge', params, { signal: exec?.signal, accessors })
      const hits = Array.isArray(data) ? data : []
      if (hits.length === 0) {
        return {
          ok: false,
          total: 0,
          items: [],
          note: '没有检索到片段。换个说法重试，或改用 grep_chunks 精确匹配；也可能这几个知识库没有开启检索索引。'
        }
      }
      return { ok: true, total: hits.length, items: hits.map(passageLine) }
    }
  }

  const grepChunks = {
    name: 'weknora_grep_chunks',
    description:
      '对范围内知识库的文本分块做不区分大小写的正则匹配。适合精确术语、编号、错误码、产品名——语义检索容易漏的那些。' +
      '候选来自关键词索引（没有关键词索引的库改用语义索引），由本工具在返回的分块上做正则过滤，并报告实际检查了多少块。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: '不区分大小写的正则；不是合法正则时按字面量匹配'
        },
        limit: { type: 'number', description: `返回片段数，默认 ${DEFAULT_LIMIT}，最大 ${MAX_LIMIT}` },
        knowledge_base_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '限定知识库 id 或名称'
        }
      }
    },
    output: {
      schema: RESULT_SCHEMA,
      render: (_a, v) => [
        {
          type: 'text',
          text:
            v.items.length === 0
              ? (v.note ?? '（没有匹配）')
              : `${v.items.join('\n\n')}\n\n共 ${v.total} 处匹配。`
        }
      ]
    },
    async execute(args, exec) {
      const expression = typeof args?.query === 'string' ? args.query.trim() : ''
      if (expression === '') throw new Error('query 必填')
      const limit = Math.min(pageSize(args?.limit, DEFAULT_LIMIT), MAX_LIMIT)

      // A pattern that is not valid regex is matched literally — the same rule
      // the built-in server documents.
      let matcher
      let literal = false
      try {
        matcher = new RegExp(expression, 'i')
      } catch {
        // Not a usable regex (an unbalanced bracket, a trailing backslash): match
        // the text verbatim, which is what a caller typing a phrase means.
        literal = true
        matcher = new RegExp(expression.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      }

      // Pull candidates with the literal words from the pattern: a chunk that
      // contains none of them cannot match, so this is a prefilter, not a guess.
      // The prefilter must use only WHOLE words from the pattern. Pasting the raw
      // expression would send regex metacharacters (`a(b`, `C++`) to the keyword
      // index, which tokenises on punctuation and returns nothing — the caller
      // would then see "no match" for text that plainly contains the term.
      const terms = expression.match(/[A-Za-z0-9_]{2,}|[\u4e00-\u9fa5]{2,}/g)
      const prefilter =
        terms === null || terms.length === 0
          ? // Nothing word-like in the pattern (`^\d+$`): there is no keyword to
            // search on, so fall back to the expression's literal remainder.
            expression.replace(/[^A-Za-z0-9_\u4e00-\u9fa5]/g, ' ').trim() || expression
          : terms.slice(0, 4).join(' ')
      const params = { query: prefilter, match_count: GREP_CANDIDATES }
      if (Array.isArray(args?.knowledge_base_ids) && args.knowledge_base_ids.length > 0) {
        params.knowledge_base_ids = args.knowledge_base_ids
      }

      const data = await run('weknora_search_knowledge', params, { signal: exec?.signal, accessors })
      const candidates = (Array.isArray(data) ? data : []).map((hit, index) => ({
        hit,
        text: String(hit?.content ?? ''),
        index
      }))
      const matched = candidates.filter((entry) => matcher.test(entry.text))

      if (matched.length === 0) {
        return {
          ok: false,
          total: 0,
          items: [],
          note:
            `在 ${candidates.length} 个候选分块里没有匹配 ${literal ? '（按字面量）' : ''}"${expression}"。` +
            `可以：换个更短的词；用 knowledge_base_ids 收窄；或用 search_knowledge 换语义检索。`
        }
      }

      const shown = matched.slice(0, limit).map((entry) => {
        const at = entry.text.search(matcher)
        const start = Math.max(0, at - EXCERPT_PAD)
        const end = Math.min(entry.text.length, at + EXCERPT_PAD * 2)
        const excerpt = `${start > 0 ? '…' : ''}${entry.text.slice(start, end).replace(/\s+/g, ' ')}${end < entry.text.length ? '…' : ''}`
        return passageLine(entry.hit, entry.index).split('\n')[0] + `\n${excerpt}`
      })

      return {
        ok: true,
        total: matched.length,
        items: shown,
        ...(matched.length > limit
          ? { note: `共 ${matched.length} 处匹配，已显示前 ${limit} 处；加大 limit 或收窄范围可看到更多。` }
          : {})
      }
    }
  }

  return [listKnowledgeBases, searchKnowledge, grepChunks]
}
