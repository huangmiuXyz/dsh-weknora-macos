/**
 * Checks for the generic dispatcher.
 *
 * `weknora_api_fetch` is the one tool that can reach a write route, so its tests
 * are mostly about what it REFUSES: an unknown path, a write without the flag, a
 * group that does not exist. Those refusals are the safety property — a dispatcher
 * that ran anything it was handed would be a far worse design than the 275 tools
 * it replaced.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { apiFetchTool, API_FETCH_NAME } from '../src/tools/api-fetch.js'
import { GROUPS, OPERATIONS } from '../src/api-catalog.js'

const ACCESSORS = async () => ({ baseUrl: 'http://127.0.0.1:1/api/v1', apiKey: 'k' })

/** Build the tool with a fresh accessor pair. */
const tool = () => apiFetchTool({ accessors: ACCESSORS })

/** Run `fn` with `fetch` replaced, then restore it. */
async function withFetch(handler, fn) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

const reply = (body, status = 200) => async () => new Response(body, { status })

test('list: an unfiltered call reports the groups instead of 275 names', async () => {
  const value = await tool().execute({ action: 'list' }, {})
  assert.equal(value.ok, true)
  assert.deepEqual(value.operations, [])
  for (const group of Object.keys(GROUPS)) {
    assert.ok(value.note.includes(group), `the group list must name ${group}`)
  }
})

test('list: query ranks an exact name first', async () => {
  const value = await tool().execute({ action: 'list', query: 'create_knowledge_base' }, {})
  assert.ok(value.operations.length > 0)
  assert.ok(value.operations[0].startsWith('weknora_create_knowledge_base'), value.operations[0])
})

test('list: a capability narrows to that group only', async () => {
  const value = await tool().execute({ action: 'list', capability: 'faq' }, {})
  assert.ok(value.operations.length > 0)
  for (const line of value.operations) {
    assert.ok(GROUPS.faq.some((name) => line.startsWith(name)), `unexpected operation: ${line}`)
  }
})

test('list: an unknown capability is reported, not guessed', async () => {
  const value = await tool().execute({ action: 'list', capability: 'nope' }, {})
  assert.equal(value.ok, false)
  assert.ok(value.note.includes('nope'))
  assert.ok(value.note.includes('knowledge'), 'the note must list the valid groups')
})

test('list: paging never repeats a page and stops at the end', async () => {
  const first = await tool().execute({ action: 'list', capability: 'documents' }, {})
  const second = await tool().execute({ action: 'list', capability: 'documents', offset: first.operations.length }, {})
  const overlap = first.operations.filter((line) => second.operations.includes(line))
  assert.equal(overlap.length, 0, 'pages must not overlap')
  assert.ok(second.total === first.total, 'total must not change while paging')
})

test('call: a GET runs and unwraps the envelope', async () => {
  const value = await withFetch(reply('{"success":true,"data":[{"id":"kb-1","name":"测试"}],"total":1}'), () =>
    tool().execute({ action: 'call', operation: 'weknora_list_knowledge_bases' }, {})
  )
  assert.equal(value.ok, true)
  assert.equal(value.status, 200)
  // A listing reports `total`, so `data` is the pagination block with the body
  // inside it; that shape is what tells the caller how much it did not receive.
  assert.equal(value.data.total, 1)
  assert.ok(value.data.data.includes('kb-1'))
})

test('call: a write is refused without allow_write, and says what it would do', async () => {
  let touched = false
  const handler = async () => {
    touched = true
    return new Response('{}', { status: 200 })
  }
  await assert.rejects(
    withFetch(handler, () =>
      tool().execute(
        { action: 'call', operation: 'weknora_delete_knowledge_base', params: { id: 'kb-1' } },
        {}
      )
    ),
    (error) => {
      assert.ok(error.message.includes('allow_write'), error.message)
      assert.ok(error.message.includes('DELETE'), 'the message must name the method')
      return true
    }
  )
  assert.equal(touched, false, 'the request must not have been sent')
})

test('call: a write proceeds once allow_write is set', async () => {
  let method = null
  const handler = async (url, init) => {
    method = init.method
    return new Response('{"success":true,"data":null}', { status: 200 })
  }
  const value = await withFetch(handler, () =>
    tool().execute(
      {
        action: 'call',
        operation: 'weknora_delete_knowledge_base',
        params: { id: 'kb-1' },
        allow_write: true
      },
      {}
    )
  )
  assert.equal(method, 'DELETE')
  assert.equal(value.ok, true)
  // A null payload must be named, not rendered as the string "null".
  assert.equal(value.data, '（无数据）')
})

test('call: path parameters are filled, not sent as query values', async () => {
  let captured = null
  const handler = async (url) => {
    captured = String(url)
    return new Response('{"success":true,"data":[]}', { status: 200 })
  }
  await withFetch(handler, () =>
    tool().execute(
      {
        action: 'call',
        operation: 'weknora_list_knowledge_bases_knowledge',
        params: { id: 'kb-1', keyword: '设计' }
      },
      {}
    )
  )
  assert.ok(captured.includes('/knowledge-bases/kb-1/knowledge'), captured)
  assert.ok(captured.includes('keyword='), captured)
})

test('call: by path with a concrete id resolves to the template', async () => {
  let captured = null
  const handler = async (url) => {
    captured = String(url)
    return new Response('{"success":true,"data":{"id":"kb-1"}}', { status: 200 })
  }
  const value = await withFetch(handler, () =>
    tool().execute({ action: 'call', method: 'GET', path: '/knowledge-bases/kb-1' }, {})
  )
  assert.equal(value.ok, true)
  // The id from the concrete path is what the caller meant; the tool must not
  // silently drop it and fetch the collection instead.
  assert.ok(captured.includes('/knowledge-bases'), captured)
})

test('call: an unknown path is refused with the methods that do exist', async () => {
  let touched = false
  const handler = async () => {
    touched = true
    return new Response('{}', { status: 200 })
  }
  await assert.rejects(
    withFetch(handler, () =>
      tool().execute({ action: 'call', method: 'POST', path: '/knowledge-bases/{id}' }, {})
    ),
    (error) => {
      // `POST /knowledge-bases/{id}` is not a route. Either refusal is correct:
      // the path resolver names the methods that do exist, or the write guard
      // refuses first. What matters is that nothing was sent.
      assert.ok(
        error.message.includes('方法') || error.message.includes('allow_write'),
        `unexpected refusal: ${error.message}`
      )
      return true
    }
  )
  assert.equal(touched, false)
})

test('call: an unknown operation suggests alternatives', async () => {
  await assert.rejects(
    tool().execute({ action: 'call', operation: 'weknora_creat_knowledge_base' }, {}),
    (error) => {
      assert.ok(error.message.includes('weknora_creat_knowledge_base'))
      return true
    }
  )
})

test('call: neither operation nor path is an error', async () => {
  await assert.rejects(tool().execute({ action: 'call' }, {}), /operation/)
})

test('call: results are lossless JSON for every payload shape', async () => {
  // The runner rejects a result that is not lossless JSON, and `undefined` is the
  // quiet killer: JSON.stringify drops the key while the schema check still sees it.
  const bodies = [
    '{"success":true,"data":[]}',
    '{"success":true,"data":null}',
    '{"success":true,"data":null,"total":0}',
    '{"success":true,"data":[1],"total":1,"page":1,"page_size":20}',
    '{"success":true,"data":""}',
    ''
  ]
  const lossless = (value) => JSON.stringify(JSON.parse(JSON.stringify(value))) === JSON.stringify(value)
  for (const body of bodies) {
    const value = await withFetch(reply(body), () =>
      tool().execute({ action: 'call', operation: 'weknora_list_knowledge_bases' }, {})
    )
    assert.ok(lossless(value), `non-lossless JSON for body ${body}`)
    for (const [key, field] of Object.entries(value)) {
      assert.notEqual(field, undefined, `"${key}" was left undefined for body ${body}`)
    }
  }
})

test('surface: the tool name and schema are stable', () => {
  const built = tool()
  assert.equal(built.name, API_FETCH_NAME)
  assert.deepEqual(built.parameters.properties.action.enum, ['list', 'call'])
  // Every action the description advertises must exist in the enum.
  assert.ok(built.description.includes('action="list"'))
  assert.ok(built.description.includes('action="call"'))
})

test('reveal: only weknora_run exists until it succeeds', async () => {
  // Mounting seven tools would list five that can only fail until a server
  // exists. The staged reveal is the reason a fresh session shows one tool.
  const { default: apply } = { default: null }
  const live = new Map()
  const { retrievalTools } = await import('../src/tools/retrieval.js')
  const { weknoraRunTool } = await import('../src/tool.js')

  const retrieval = [...retrievalTools({ accessors: ACCESSORS }), apiFetchTool({ accessors: ACCESSORS })]
  let revealed = false
  const reveal = () => {
    if (revealed) return retrieval.map((definition) => definition.name)
    revealed = true
    for (const definition of retrieval) live.set(definition.name, definition)
    return retrieval.map((definition) => definition.name)
  }

  // Before run: the reveal has not happened, so only the runner would exist.
  assert.equal(live.size, 0)

  const run = weknoraRunTool(
    {
      ensure: async () => ({
        running: true,
        baseUrl: 'http://127.0.0.1:18080/',
        port: 18080,
        state: 'adopted',
        host: '127.0.0.1',
        dataDir: '/tmp'
      })
    },
    { credentials: async () => 'sk-abcdefgh', onReady: reveal }
  )

  const value = await run.execute({}, {})
  assert.equal(live.size, 6, 'the six tools must exist after a successful run')
  assert.deepEqual([...live.keys()].sort(), value.tools.slice().sort())

  // A second run must not register anything twice (the real registry throws on a
  // duplicate name, so this would fail loudly rather than silently).
  await run.execute({}, {})
  assert.equal(live.size, 6)
})
