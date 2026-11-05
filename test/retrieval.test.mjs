/**
 * Checks for the five retrieval tools.
 *
 * These mirror WeKnora's built-in MCP server (`internal/mcpserver/tools_retrieve.go`),
 * so the tests pin two different things: the tool surface (names, required
 * parameters, enums) must match that specification, and the behaviour must stay
 * correct against a fake REST server — including the cases that used to break the
 * runner, such as an empty result turning into non-lossless JSON.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { retrievalTools } from '../src/tools/retrieval.js'
import { partitionArgs } from '../src/http.js'

const ACCESSORS = async () => ({ baseUrl: 'http://127.0.0.1:1/api/v1', apiKey: 'k' })

/** Replace `fetch` for one call and restore it after. */
async function withFetch(handler, run) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

/** Answer every request with one JSON body. */
const reply = (body, status = 200) => async () => new Response(body, { status })

/** Answer by path suffix, so one call can issue several requests. */
const route = (table) => async (url) => {
  const path = new URL(String(url)).pathname
  for (const [suffix, body] of Object.entries(table)) {
    if (path.endsWith(suffix)) return new Response(body, { status: 200 })
  }
  return new Response('{"success":true,"data":[]}', { status: 200 })
}

/** The five tools, built once; each test supplies its own `fetch`. */
function tools() {
  return retrievalTools({ accessors: ACCESSORS })
}

test('surface: the tool set matches the built-in MCP server', () => {
  const built = tools()
  assert.deepEqual(
    built.map((tool) => tool.name),
    [
      'weknora_list_knowledge_bases',
      'weknora_search_knowledge',
      'weknora_grep_chunks',
      'weknora_list_documents',
      'weknora_read_document'
    ]
  )

  const byName = new Map(built.map((tool) => [tool.name, tool]))
  // Required parameters are the specification's, not a convenience: a model that
  // omits `query` on search must be told, not silently given an empty search.
  assert.deepEqual(Object.keys(byName.get('weknora_list_knowledge_bases').parameters.properties), [])
  assert.deepEqual(byName.get('weknora_search_knowledge').parameters.required, ['query'])
  assert.deepEqual(byName.get('weknora_grep_chunks').parameters.required, ['query'])
  assert.deepEqual(byName.get('weknora_list_documents').parameters.required, ['knowledge_base_id'])
  assert.deepEqual(byName.get('weknora_read_document').parameters.required, ['knowledge_id'])
  assert.deepEqual(byName.get('weknora_search_knowledge').parameters.properties.mode.enum, [
    'hybrid',
    'semantic',
    'keyword'
  ])
})

test('surface: every tool declares an output schema the runner accepts', () => {
  // `allOf`, `x-` extensions, and a non-boolean `additionalProperties` all make
  // the real `register()` throw — and a tool that fails to register simply never
  // appears, with no error the model can see.
  const ALLOWED = new Set([
    'type', 'oneOf', 'properties', 'required', 'additionalProperties',
    'items', 'enum', 'const', 'description', 'title', 'default', 'examples'
  ])
  const check = (node, path) => {
    if (node === null || typeof node !== 'object') return
    for (const key of Object.keys(node)) assert.ok(ALLOWED.has(key), `${path} has keyword "${key}"`)
    if (node.additionalProperties !== undefined) {
      assert.equal(typeof node.additionalProperties, 'boolean', `${path}.additionalProperties`)
    }
    for (const [name, schema] of Object.entries(node.properties ?? {})) check(schema, `${path}.${name}`)
    if (node.items !== undefined) check(node.items, `${path}.items`)
    for (const [index, branch] of (node.oneOf ?? []).entries()) check(branch, `${path}.oneOf[${index}]`)
  }
  for (const tool of tools()) {
    check(tool.parameters, `${tool.name}.parameters`)
    check(tool.output.schema, `${tool.name}.output`)
    assert.equal(typeof tool.output.render, 'function', `${tool.name} needs a renderer`)
  }
})

test('list_knowledge_bases: reports id, name, and retrieval modes', async () => {
  const body = JSON.stringify({
    success: true,
    data: [
      { id: 'kb-1', name: '产品文档', type: 'document', is_vector_enabled: true, is_keyword_enabled: true },
      { id: 'kb-2', name: 'FAQ 库', type: 'faq', is_wiki_enabled: true }
    ]
  })
  const value = await withFetch(reply(body), () => tools()[0].execute({}, {}))
  assert.equal(value.ok, true)
  assert.equal(value.total, 2)
  assert.ok(value.items[0].includes('kb-1'))
  assert.ok(value.items[0].includes('semantic+keyword'))
  assert.ok(value.items[1].includes('wiki'))
})

test('search_knowledge: mode translates to the REST switches', async () => {
  let captured = null
  const handler = async (url, init) => {
    captured = { url: String(url), body: JSON.parse(init.body) }
    return new Response('{"success":true,"data":[{"content":"退款流程是……","knowledge_title":"手册","chunk_index":3}]}', {
      status: 200
    })
  }
  const search = tools()[1]

  // semantic: keyword matching must be OFF, or the mode is a lie.
  await withFetch(handler, () => search.execute({ query: '退款', mode: 'semantic' }, {}))
  assert.equal(captured.body.disable_keywords_match, true)
  assert.equal(captured.body.disable_vector_match, undefined)

  // keyword: the mirror image.
  await withFetch(handler, () => search.execute({ query: '退款', mode: 'keyword' }, {}))
  assert.equal(captured.body.disable_vector_match, true)
  assert.equal(captured.body.disable_keywords_match, undefined)

  // hybrid (default): neither switch set.
  await withFetch(handler, () => search.execute({ query: '退款' }, {}))
  assert.equal(captured.body.disable_keywords_match, undefined)
  assert.equal(captured.body.disable_vector_match, undefined)
})

test('search_knowledge: an empty result says why instead of returning nothing', async () => {
  const value = await withFetch(reply('{"success":true,"data":[]}'), () =>
    tools()[1].execute({ query: '不存在的东西' }, {})
  )
  assert.equal(value.ok, false)
  assert.equal(value.total, 0)
  assert.ok(typeof value.note === 'string' && value.note.length > 0)
})

test('search_knowledge: limit is clamped to the server maximum', async () => {
  let captured = null
  const handler = async (url, init) => {
    captured = JSON.parse(init.body)
    return new Response('{"success":true,"data":[]}', { status: 200 })
  }
  await withFetch(handler, () => tools()[1].execute({ query: 'x', limit: 500 }, {}))
  assert.equal(captured.match_count, 30, 'a caller asking for 500 must not ask the server for 500')
})

test('grep_chunks: a regex filters candidates and reports how many were inspected', async () => {
  const body = JSON.stringify({
    success: true,
    data: [
      { content: '错误码 ERR_4021 出现在支付流程', knowledge_title: '故障手册', chunk_index: 1 },
      { content: '这是一段无关的话', knowledge_title: '手册', chunk_index: 2 },
      { content: '还有 err_4021 的小写写法', knowledge_title: '附录', chunk_index: 5 }
    ]
  })
  const value = await withFetch(reply(body), () => tools()[2].execute({ query: 'ERR_4021' }, {}))
  // Case-insensitive, and the non-matching chunk is dropped locally.
  assert.equal(value.total, 2)
  assert.ok(value.items.every((item) => item.toLowerCase().includes('err_4021')))
})

test('grep_chunks: an invalid regex falls back to literal matching', async () => {
  const body = JSON.stringify({
    success: true,
    data: [{ content: '价格是 C++ 实现，含 a(b 这种写法', knowledge_title: '文档', chunk_index: 0 }]
  })
  // `a(b` is an unterminated group: a real regex would throw, so the tool must
  // treat it as the literal text the caller typed — and the text really has it.
  const value = await withFetch(reply(body), () => tools()[2].execute({ query: 'a(b' }, {}))
  assert.equal(value.ok, true)
  assert.equal(value.total, 1)
})

test('grep_chunks: a valid regex is applied as regex, and can legitimately miss', async () => {
  const body = JSON.stringify({
    success: true,
    data: [{ content: '价格是 C++ 实现，含 (括号)', knowledge_title: '文档', chunk_index: 0 }]
  })
  // `C\+\+ \(` needs "C++ (" adjacent; the text has "C++ 实现，含 (" between
  // them, so a correct regex engine finds nothing. Silently falling back to a
  // literal search here would report a match that is not there.
  const value = await withFetch(reply(body), () => tools()[2].execute({ query: 'C\\+\\+ \\(' }, {}))
  assert.equal(value.ok, false)
  assert.equal(value.total, 0)
})

test('grep_chunks: no match names the candidate count, so absence is a fact', async () => {
  const body = JSON.stringify({
    success: true,
    data: [{ content: '完全无关的文本', knowledge_title: '文档', chunk_index: 0 }]
  })
  const value = await withFetch(reply(body), () => tools()[2].execute({ query: 'NOT_THERE' }, {}))
  assert.equal(value.ok, false)
  assert.equal(value.total, 0)
  assert.ok(value.note.includes('1'), 'the note must say how many chunks were inspected')
})

test('list_documents: passes the id as the path parameter, not a query value', async () => {
  let captured = null
  const handler = async (url) => {
    captured = String(url)
    return new Response(
      '{"success":true,"data":[{"id":"doc-1","title":"设计.md","parse_status":"completed"}],"total":1}',
      { status: 200 }
    )
  }
  const value = await withFetch(handler, () =>
    tools()[3].execute({ knowledge_base_id: 'kb-1', keyword: '设计' }, {})
  )
  // `id` is the placeholder the catalog template declares; sending
  // `knowledge_base_id` would land in the query string and 404.
  assert.ok(captured.includes('/knowledge-bases/kb-1/knowledge'), captured)
  assert.ok(captured.includes('keyword='), captured)
  assert.equal(value.ok, true)
  assert.ok(value.items[0].includes('doc-1'))
})

test('read_document: pages by character offset and returns next_offset', async () => {
  const long = 'A'.repeat(50) + 'B'.repeat(50)
  const value = await withFetch(reply(JSON.stringify({ success: true, data: long })), () =>
    tools()[4].execute({ knowledge_id: 'doc-1', limit: 60 }, {})
  )
  assert.equal(value.text.length, 60)
  assert.equal(value.next_offset, 60)
  assert.equal(value.truncated, true)

  const tail = await withFetch(reply(JSON.stringify({ success: true, data: long })), () =>
    tools()[4].execute({ knowledge_id: 'doc-1', offset: 60, limit: 60 }, {})
  )
  assert.equal(tail.text.length, 40)
  // A fully-read page must NOT advertise another offset.
  assert.equal(tail.next_offset, undefined)
})

test('read_document: query mode requires every word, in any order', async () => {
  const text = '第一段讲退款。第二段讲流程。第三段把退款和流程放在一起。'
  const value = await withFetch(reply(JSON.stringify({ success: true, data: text })), () =>
    tools()[4].execute({ knowledge_id: 'doc-1', query: '流程 退款' }, {})
  )
  assert.equal(value.ok, true)
  // The combined paragraph matches; the single-word paragraphs do not.
  assert.equal(value.total, 1)
  assert.ok(value.items[0].includes('一起'))
})

test('read_document: an unparsed document is explained, not returned empty', async () => {
  const value = await withFetch(reply('{"success":true,"data":""}'), () =>
    tools()[4].execute({ knowledge_id: 'doc-1' }, {})
  )
  assert.equal(value.ok, false)
  assert.ok(value.note.includes('解析'), value.note)
})

test('all: results are lossless JSON and never carry an undefined field', async () => {
  // The runner rejects a result that is not lossless JSON, and `undefined` is the
  // quiet killer: `JSON.stringify` drops the key, the schema check sees it gone.
  const bodies = [
    '{"success":true,"data":[]}',
    '{"success":true,"data":null}',
    '{"success":true,"data":""}',
    '{"success":true,"data":[1,2],"total":2,"page":1,"page_size":20}',
    ''
  ]
  const lossless = (value) => JSON.stringify(JSON.parse(JSON.stringify(value))) === JSON.stringify(value)
  for (const tool of tools()) {
    for (const body of bodies) {
      const value = await withFetch(reply(body), () =>
        tool.execute(
          {
            query: 'x',
            knowledge_base_id: 'kb-1',
            knowledge_id: 'doc-1',
            ...(tool.name === 'weknora_list_knowledge_bases' ? {} : {})
          },
          {}
        )
      )
      assert.ok(lossless(value), `${tool.name} produced non-lossless JSON for body ${body}`)
      for (const [key, field] of Object.entries(value)) {
        assert.notEqual(field, undefined, `${tool.name} left "${key}" undefined for body ${body}`)
      }
    }
  }
})

test('partitionArgs: a path placeholder wins over a body field of the same name', () => {
  // `list_documents` takes `knowledge_base_id` from the caller but the template
  // spells the placeholder `{id}`; the mapping is what keeps it out of the body.
  const schema = { type: 'object', properties: { id: { type: 'string' }, keyword: { type: 'string' } } }
  const split = partitionArgs('/knowledge-bases/{id}/knowledge', schema, { id: 'kb-1', keyword: 'x' })
  assert.deepEqual(split.path, { id: 'kb-1' })
  assert.deepEqual(split.query, { keyword: 'x' })
})
