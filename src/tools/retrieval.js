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
 * Two deliberate departures, both because this plugin talks REST, not MCP:
 *
 *   1. Grep filters candidates LOCALLY. The REST search endpoint ranks chunks by
 *      relevance and cannot take a regex, so the tool states how many chunks it
 *      actually inspected — "no match" becomes a fact about the text rather than
 *      a guess about the retriever.
 *   2. `read_document` pages by CHARACTER offset instead of a chunk cursor,
 *      because `/knowledge/{id}/preview` returns parsed text and a caller quoting
 *      a passage thinks in characters.
 *
 * The implementation is split across `search.js` (lookup + search + grep),
 * `documents.js` (list + read), and `shared.js` (the REST call and the line
 * formatters), so no single file carries all five.
 */
import { searchTools } from './search.js'
import { documentTools } from './documents.js'

export { RESULT_SCHEMA } from './shared.js'

/**
 * Build all five retrieval tools.
 *
 * @param {object} options
 * @param {() => Promise<{baseUrl: string, apiKey: string}>} options.accessors
 *   Read at CALL time: the port is only known once the server answers, and the
 *   key may be saved between two calls.
 * @returns {object[]} ready to hand to `ctx.tools.register`
 */
export function retrievalTools({ accessors }) {
  return [...searchTools({ accessors }), ...documentTools({ accessors })]
}
