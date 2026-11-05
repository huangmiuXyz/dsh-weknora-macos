/**
 * Turn WeKnora's Swagger document into the frozen catalog this plugin ships.
 *
 * Parsing an OpenAPI document is a solved problem, so this script does NOT parse
 * one. `openapi-mcp-generator` (MIT) already resolves `$ref`s, flattens
 * parameters, and merges a request body into a JSON Schema 2020-12 input schema —
 * work a hand-rolled reader would get subtly wrong. What that library cannot know
 * is specific to *this* deployment:
 *
 *   1. which operations a workspace API key can actually reach, and which the
 *      bundled Lite build can serve (its `verdict` rules);
 *   2. a model-facing name and a capability group for each;
 *   3. how deep a nested config object may be before the schema costs more
 *      context than it earns (`truncate`).
 *
 * Those three are the whole of this file. Everything else is the library's.
 *
 * Run it when the bundled WeKnora version changes:
 *   node scripts/gen-catalog.mjs <path-to-docs/swagger.json>
 *
 * Prerequisites (devDependencies): openapi-mcp-generator, swagger2openapi.
 * The output is committed: the plugin ships as a tarball and must not depend on
 * a Go source tree, or on a network install, at package build time.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getToolsFromOpenApi } from 'openapi-mcp-generator'
import converter from 'swagger2openapi'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(HERE, '..', 'src', 'api-catalog.js')

/**
 * Why an operation is not in the catalog.
 *
 * Every rule is a hard constraint of this deployment, not a preference:
 *   - the route is registered outside an `apiKeyGroup`, so WeKnora's API-key
 *     gate denies it by default and only a signed-in JWT can call it;
 *   - Lite reports the feature unsupported (`not_supported_in_lite`);
 *   - the bundled build has no `desktop` tag, so the sandbox manager is a stub;
 *   - the route is a file stream, a login flow, or an anonymous embed surface
 *     that does not speak `X-API-Key` at all.
 *
 * A tool that exists but can never succeed is worse than no tool: the model
 * spends a turn discovering the 403.
 */
const EXCLUSIONS = [
  [/^\/(auth|me)(\/|$)/, 'auth-session'],
  [/^\/tenants(\/|$)/, 'jwt-only'],
  [/^\/(automations|automation-runs|notifications)(\/|$)/, 'jwt-only'],
  [/^\/system\/admin(\/|$)/, 'platform-admin'],
  [/^\/organizations(\/|$)/, 'lite-unsupported'],
  [/^\/(sandbox-configs|skills)(\/|$)/, 'sandbox-stub'],
  [/^\/agent(\/|$)/, 'in-session-callback'],
  [/^\/mcp-oauth(\/|$)/, 'in-session-callback'],
  [/^\/local-browser(\/|$)/, 'browser-session'],
  [/^\/(files|r)(\/|$)/, 'file-stream'],
  [/^\/embed(\/|$)/, 'embed-anonymous'],
  [/^\/im\/callback(\/|$)/, 'im-callback'],
  [/\/graph-search$/, 'neo4j-disabled'],
  [/^\/(health|swagger)(\/|$)/, 'infrastructure']
]

/**
 * Which tools each capability group contains — WRITTEN BY HAND, one name at a
 * time.
 *
 * This is a list, not a rule. Deriving groups from the path kept splitting one
 * resource family across several groups (the knowledge-base family landed in
 * `search`, `documents`, `faq`, and `chat` at once), so a model asking for
 * "the knowledge base tools" got a third of them and had to discover the rest.
 * A list cannot do that: a tool is in exactly the groups it is written in, and
 * a tool that is in NO group fails the generator instead of silently becoming
 * unreachable.
 *
 * Editing groups means editing this table. That is the point — the cost of a
 * wrong grouping shows up here, where it can be read, not in a regex whose
 * behaviour depends on rule order.
 *
 * The generator verifies: every group's names exist, every catalog tool is
 * claimed by exactly one group, and a group is never empty.
 */
const GROUP_MEMBERS = {
  /** Knowledge-base lifecycle and retrieval: the family a RAG caller needs first. */
  knowledge: [
    'weknora_create_knowledge_base',
    'weknora_list_knowledge_bases',
    'weknora_get_knowledge_base',
    'weknora_update_knowledge_base',
    'weknora_replace_knowledge_base',
    'weknora_delete_knowledge_base',
    'weknora_pin_knowledge_base',
    'weknora_duplicate_knowledge_base',
    'weknora_copy_knowledge_base',
    'weknora_get_knowledge_base_copy_progress',
    'weknora_generate_knowledge_base_profile',
    'weknora_list_knowledge_bases_activity',
    'weknora_list_knowledge_bases_move_targets',
    'weknora_search_knowledge',
    'weknora_recall_knowledge_base',
    'weknora_recall_knowledge_base_with_body',
    'weknora_search_documents_by_name'
  ],

  /** Documents inside a knowledge base: import, parse, organise, delete. */
  documents: [
    'weknora_create_knowledge_base_knowledge_file',
    'weknora_create_knowledge_base_knowledge_url',
    'weknora_create_knowledge_base_knowledge_manual',
    'weknora_list_knowledge_bases_knowledge',
    'weknora_delete_knowledge_base_knowledge',
    'weknora_download_knowledge_base_knowledge_batch',
    'weknora_list_knowledge_bases_knowledge_folders',
    'weknora_update_knowledge_base_knowledge_folder',
    'weknora_get_knowledge',
    'weknora_update_knowledge',
    'weknora_delete_knowledge',
    'weknora_update_knowledge_manual',
    'weknora_list_knowledge_batch',
    'weknora_delete_knowledge_batch',
    'weknora_reparse_knowledge',
    'weknora_reparse_knowledge_batch_all',
    'weknora_create_knowledge_cancel_parse',
    'weknora_list_knowledge_spans',
    'weknora_preview_knowledge',
    'weknora_download_knowledge',
    'weknora_move_knowledge',
    'weknora_move_knowledge_to_folder',
    'weknora_get_knowledge_move_progress',
    'weknora_update_knowledge_tag',
    'weknora_update_knowledge_image',
    'weknora_list_knowledge_base_images',
    'weknora_list_knowledge_bases_images',
    'weknora_list_image_attrs_schema'
  ],

  /** Chunk-level reads and edits, plus the chunking dry run. */
  chunks: [
    'weknora_list_knowledge_chunks',
    'weknora_get_chunk_by_id',
    'weknora_update_chunk',
    'weknora_delete_knowledge_chunks',
    'weknora_delete_chunk',
    'weknora_delete_chunk_by_id_questions',
    'weknora_list_chunks_revisions',
    'weknora_revert_chunk',
    'weknora_preview_chunking'
  ],

  /** FAQ entries attached to a knowledge base. */
  faq: [
    'weknora_list_knowledge_bases_faq_entries',
    'weknora_get_knowledge_base_faq_entry',
    'weknora_create_knowledge_base_faq_entry',
    'weknora_create_knowledge_base_faq_entry_quick',
    'weknora_update_knowledge_base_faq_entries',
    'weknora_replace_knowledge_base_faq_entry',
    'weknora_delete_knowledge_base_faq_entry',
    'weknora_update_knowledge_base_faq_entry_fields',
    'weknora_update_knowledge_base_faq_entry_tag',
    'weknora_create_knowledge_base_faq_entry_similar_questions',
    'weknora_search_knowledge_base_faq',
    'weknora_export_knowledge_base_faq_entry',
    'weknora_get_faq_import_progress',
    'weknora_update_knowledge_base_faq_import_last_result_display'
  ],

  /** Knowledge-base tags. Small on purpose: tags are a write-side concern. */
  tags: [
    'weknora_list_knowledge_bases_tags',
    'weknora_create_knowledge_base_tag',
    'weknora_update_knowledge_base_tag',
    'weknora_delete_knowledge_base_tag'
  ],

  /** Sharing a knowledge base or an agent with an organisation. */
  shares: [
    'weknora_list_knowledge_bases_shares',
    'weknora_create_knowledge_base_share',
    'weknora_update_knowledge_base_share',
    'weknora_delete_knowledge_base_share',
    'weknora_delete_agent_share',
    'weknora_list_shared_agents',
    'weknora_list_shared_knowledge_bases'
  ],

  /** Wiki pages maintained by the wiki pipeline. */
  wiki: [
    'weknora_list_knowledgebase_wiki_pages',
    'weknora_get_knowledgebase_wiki_page',
    'weknora_create_knowledgebase_wiki_page',
    'weknora_update_knowledgebase_wiki_page',
    'weknora_delete_knowledgebase_wiki_page',
    'weknora_update_knowledgebase_wiki_move_page',
    'weknora_list_knowledgebase_wiki_folders',
    'weknora_create_knowledgebase_wiki_folder',
    'weknora_update_knowledgebase_wiki_folder',
    'weknora_delete_knowledgebase_wiki_folder',
    'weknora_get_knowledgebase_wiki_revision',
    'weknora_revert_knowledgebase_wiki',
    'weknora_list_knowledgebase_wiki_index',
    'weknora_list_knowledgebase_wiki_graph',
    'weknora_list_knowledgebase_wiki_stats',
    'weknora_list_knowledgebase_wiki_issues',
    'weknora_update_knowledgebase_wiki_issue_status',
    'weknora_lint_knowledgebase_wiki',
    'weknora_fix_knowledgebase_wiki_auto',
    'weknora_create_knowledgebase_wiki_rebuild_links',
    'weknora_search_wiki_pages',
    'weknora_search_wiki'
  ],

  /** Sessions, messages, and the two chat endpoints. */
  chat: [
    'weknora_create_session',
    'weknora_list_sessions',
    'weknora_get_session',
    'weknora_update_session',
    'weknora_delete_session',
    'weknora_delete_session_batch',
    'weknora_pin_session',
    'weknora_unpin_session',
    'weknora_fork_session',
    'weknora_rewind_session',
    'weknora_stop_session',
    'weknora_generate_session_title',
    'weknora_list_messages_load',
    'weknora_delete_message',
    'weknora_delete_session_message',
    'weknora_search_message',
    'weknora_list_messages_chat_history_stats',
    'weknora_get_session_continue_stream',
    'weknora_list_sessions_steer',
    'weknora_create_session_steer',
    'weknora_create_session_steer_inject',
    'weknora_delete_session_steer',
    'weknora_list_sessions_artifacts',
    'weknora_list_sessions_messages_artifacts',
    'weknora_delete_session_message_artifact',
    'weknora_download_session_message_artifact',
    'weknora_list_sessions_messages_suggestions',
    'weknora_create_session_message_suggestion',
    'weknora_create_session_suggestion_event',
    'weknora_list_artifacts',
    'weknora_delete_artifact',
    'weknora_chat_knowledge',
    'weknora_chat_agent'
  ],

  /** Custom agents and the metadata a caller needs to configure one. */
  agents: [
    'weknora_create_agent',
    'weknora_list_agents',
    'weknora_get_agent',
    'weknora_update_agent',
    'weknora_replace_agent',
    'weknora_delete_agent',
    'weknora_copy_agent',
    'weknora_list_agents_tools',
    'weknora_list_agents_type_presets',
    'weknora_list_agents_placeholders',
    'weknora_list_agents_suggested_questions'
  ],

  /** Chat, embedding, rerank, VLM and ASR model configuration. */
  models: [
    'weknora_create_model',
    'weknora_list_models',
    'weknora_get_model',
    'weknora_update_model',
    'weknora_replace_model',
    'weknora_delete_model',
    'weknora_copy_model',
    'weknora_list_models_providers',
    'weknora_get_model_provider',
    'weknora_resolve_model_catalog',
    'weknora_list_models_weknoracloud_status'
  ],

  /** Vector stores, storage backends, and web-search providers. */
  infra: [
    'weknora_list_vector_stores',
    'weknora_create_vector_store',
    'weknora_get_vector_store',
    'weknora_update_vector_store',
    'weknora_delete_vector_store',
    'weknora_test_vector_store_config',
    'weknora_test_vector_store_saved',
    'weknora_list_vector_stores_types',
    'weknora_list_storage_backends',
    'weknora_create_storage_backend',
    'weknora_get_storage_backend',
    'weknora_update_storage_backend',
    'weknora_update_storage_backend_default',
    'weknora_delete_storage_backend',
    'weknora_test_storage_backend_config',
    'weknora_test_storage_backend_saved',
    'weknora_list_storage_backends_types',
    'weknora_list_web_search_providers',
    'weknora_list_web_search_provider_configs',
    'weknora_get_web_search_provider',
    'weknora_update_web_search_provider',
    'weknora_replace_web_search_provider',
    'weknora_delete_web_search_provider',
    'weknora_test_web_search_provider_config',
    'weknora_test_web_search_provider_saved',
    'weknora_list_web_search_providers_types'
  ],

  /** External data sources: connect, sync, inspect. */
  datasource: [
    'weknora_list_datasource',
    'weknora_create_datasource',
    'weknora_get_datasource',
    'weknora_update_datasource',
    'weknora_delete_datasource',
    'weknora_validate_datasource',
    'weknora_create_datasource_validate_credentials',
    'weknora_list_datasource_types',
    'weknora_list_datasource_resources',
    'weknora_create_datasource_resource_ancestors',
    'weknora_sync_datasource',
    'weknora_pause_datasource',
    'weknora_resume_datasource',
    'weknora_update_datasource_sync_setting',
    'weknora_list_datasource_logs',
    'weknora_get_datasource_log'
  ],

  /** MCP services and endpoints, plus the IM channels that front them. */
  mcp: [
    'weknora_list_mcp_services',
    'weknora_create_mcp_service',
    'weknora_get_mcp_service',
    'weknora_update_mcp_service',
    'weknora_delete_mcp_service',
    'weknora_test_mcp_service',
    'weknora_update_mcp_service_credentials',
    'weknora_delete_mcp_service_credentials',
    'weknora_list_mcp_services_tools',
    'weknora_list_mcp_services_resources',
    'weknora_list_mcp_services_metadata',
    'weknora_refresh_mcp_service_metadata',
    'weknora_update_mcp_service_tool_approvals',
    'weknora_create_mcp_service_oauth_authorize_url',
    'weknora_create_mcp_service_oauth_assertion',
    'weknora_list_mcp_services_oauth_status',
    'weknora_list_mcp_services_oauth_callback',
    'weknora_delete_mcp_service_oauth_token',
    'weknora_list_mcp_endpoints',
    'weknora_create_mcp_endpoint',
    'weknora_get_mcp_endpoint',
    'weknora_update_mcp_endpoint',
    'weknora_delete_mcp_endpoint',
    'weknora_create_mcp_endpoint_rotate_token',
    'weknora_list_mcp_endpoints_tools',
    'weknora_update_im_channel',
    'weknora_delete_im_channel',
    'weknora_toggle_im_channel',
    'weknora_create_wechat_qrcode',
    'weknora_create_wechat_qrcode_status'
  ],

  /** Deployment capabilities, setup checks, evaluation, and favourites. */
  system: [
    'weknora_list_system_info',
    'weknora_list_system_capabilities',
    'weknora_list_system_parser_engines',
    'weknora_check_system_parser_engine',
    'weknora_check_system_sandbox',
    'weknora_list_system_storage_engine_status',
    'weknora_check_system_storage_engine',
    'weknora_create_system_docreader_reconnect',
    'weknora_get_initialization_config',
    'weknora_update_initialization_config',
    'weknora_create_initialization_initialize',
    'weknora_check_initialization_asr',
    'weknora_test_initialization_embedding',
    'weknora_test_initialization_multimodal',
    'weknora_check_initialization_remote',
    'weknora_check_initialization_rerank',
    'weknora_create_initialization_extract_text_relation',
    'weknora_create_initialization_extract_fabri_tag',
    'weknora_create_initialization_extract_fabri_text',
    'weknora_list_initialization_ollama_status',
    'weknora_list_initialization_ollama_models',
    'weknora_check_initialization_ollama_model',
    'weknora_download_initialization_ollama_model',
    'weknora_get_initialization_ollama_download_progress',
    'weknora_list_initialization_ollama_download_tasks',
    'weknora_create_weknoracloud_credentials',
    'weknora_create_evaluation',
    'weknora_list_evaluation',
    'weknora_list_user_favorites',
    'weknora_create_user_favorite',
    'weknora_delete_user_favorite'
  ],

  /** Cross-session long-term memory. */
  memory: [
    'weknora_list_memory_items',
    'weknora_create_memory_item',
    'weknora_update_memory_item',
    'weknora_delete_memory_item',
    'weknora_delete_memory_items',
    'weknora_create_memory_item_confirm',
    'weknora_reject_memory_item',
    'weknora_list_memory_topics',
    'weknora_delete_memory_topic',
    'weknora_promote_memory_topic',
    'weknora_list_memory_documents',
    'weknora_delete_memory_document',
    'weknora_list_memory_settings',
    'weknora_update_memory_setting',
    'weknora_consolidate_memory',
    'weknora_export_memory'
  ]
}

/** Trailing path words that name an action rather than a resource. */
const ACTION_WORDS = new Set([
  'copy', 'duplicate', 'test', 'check', 'validate', 'sync', 'pause', 'resume', 'run',
  'stop', 'cancel', 'reparse', 'revert', 'rebuild', 'install', 'uninstall', 'rotate',
  'refresh', 'generate', 'export', 'import', 'move', 'pin', 'fork', 'rewind', 'toggle',
  'read', 'leave', 'promote', 'revoke', 'preview', 'download', 'resolve', 'approve',
  'reject', 'accept', 'decline', 'regenerate', 'search', 'chat', 'ask', 'fix', 'lint',
  'debug', 'consolidate', 'classify', 'validate-trigger'
])

/** Singular forms, so `/knowledge-bases/{id}` reads `knowledge_base`, not `bases`. */
const SINGULAR = {
  bases: 'base', agents: 'agent', models: 'model', sessions: 'session',
  messages: 'message', chunks: 'chunk', entries: 'entry', pages: 'page',
  folders: 'folder', tags: 'tag', shares: 'share', items: 'item', topics: 'topic',
  files: 'file', images: 'image', documents: 'document', automations: 'automation',
  providers: 'provider', backends: 'backend', stores: 'store', services: 'service',
  endpoints: 'endpoint', channels: 'channel', skills: 'skill', runs: 'run',
  issues: 'issue', revisions: 'revision', invitations: 'invitation', members: 'member',
  grants: 'grant', logs: 'log', resources: 'resource', events: 'event', jobs: 'job',
  users: 'user', settings: 'setting', types: 'type', tools: 'tool', keys: 'key',
  artifacts: 'artifact', attachments: 'attachment', suggestions: 'suggestion',
  favorites: 'favorite', variables: 'variable', pipelines: 'pipeline',
  organizations: 'organization', notifications: 'notification', engines: 'engine',
  definitions: 'definition', sandboxes: 'sandbox', tickets: 'ticket'
}

const singularize = (word) => SINGULAR[word] ?? word
const isParam = (segment) => segment.startsWith('{')

/** Only the requests this plugin can actually issue. */
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete'])
const METHOD_VERB = { get: 'get', post: 'create', put: 'update', patch: 'update', delete: 'delete' }

/**
 * Routes whose derived name would be ambiguous, spelled out.
 *
 * Two operations are reachable as "search" and mean different things:
 * `/knowledge-search` is the RAG retrieval endpoint (recall → rerank → merge),
 * while `/knowledge/search` lists document cards by filename keyword. Word
 * splitting collapses both to `search_knowledge`, and a model that picks the
 * wrong one gets a plausible-looking answer from the wrong subsystem. An explicit
 * table is honest about that; a general rule that special-cases hyphenation kept
 * producing a `_post` suffix that reads like an accident.
 */
const NAME_OVERRIDES = new Map([
  // Two routes reachable as "search" mean different things: the first is RAG
  // retrieval, the second lists document cards by filename.
  ['POST /knowledge-search', 'weknora_search_knowledge'],
  ['GET /knowledge/search', 'weknora_search_documents_by_name'],
  ['POST /wiki-search', 'weknora_search_wiki'],
  ['GET /knowledgebase/{kb_id}/wiki/search', 'weknora_search_wiki_pages'],
  // Recall is not search: it exposes raw vector+keyword scores with no rerank.
  ['GET /knowledge-bases/{id}/hybrid-search', 'weknora_recall_knowledge_base'],
  // GET exists only for callers that cannot send a body; the POST is canonical.
  ['POST /knowledge-bases/{id}/hybrid-search', 'weknora_recall_knowledge_base_with_body'],

  // --- Routes whose HTTP verb contradicts what they do -----------------------
  // The derived verb comes from the method, but these handlers read or move
  // rather than create. A tool named `create_*` that only lists is not just
  // awkward — the model picks it expecting a write and gets a read.
  ['GET /chunks/{knowledge_id}', 'weknora_list_knowledge_chunks'],
  ['POST /knowledge-bases/{id}/images', 'weknora_list_knowledge_base_images'],
  ['POST /knowledge/folder', 'weknora_move_knowledge_to_folder'],
  ['POST /chunker/preview', 'weknora_preview_chunking'],
  ['POST /knowledge/batch-delete', 'weknora_delete_knowledge_batch'],
  ['POST /knowledge/batch-reparse', 'weknora_reparse_knowledge_batch_all'],
  ['POST /chunks/{knowledge_id}/{id}/revert', 'weknora_revert_chunk'],
  ['POST /sessions/{session_id}/title', 'weknora_generate_session_title'],

  // --- A method suffix cannot tell these apart -------------------------------
  // Sorted out by what actually differs: whether the route acts on a saved
  // instance or a configuration that was never stored, and whether it touches
  // one item or the whole collection.
  ['POST /storage-backends/test', 'weknora_test_storage_backend_config'],
  ['POST /storage-backends/{id}/test', 'weknora_test_storage_backend_saved'],
  ['POST /vector-stores/test', 'weknora_test_vector_store_config'],
  ['POST /vector-stores/{id}/test', 'weknora_test_vector_store_saved'],
  ['POST /web-search-providers/test', 'weknora_test_web_search_provider_config'],
  ['POST /web-search-providers/{id}/test', 'weknora_test_web_search_provider_saved'],
  ['DELETE /chunks/{knowledge_id}', 'weknora_delete_knowledge_chunks'],
  ['DELETE /chunks/{knowledge_id}/{id}', 'weknora_delete_chunk'],
  ['DELETE /memory/items', 'weknora_delete_memory_items'],
  ['DELETE /memory/items/{id}', 'weknora_delete_memory_item'],
  ['POST /sessions/{session_id}/pin', 'weknora_pin_session'],
  ['DELETE /sessions/{id}/pin', 'weknora_unpin_session'],
  ['GET /web-search/providers', 'weknora_list_web_search_providers'],
  ['GET /web-search-providers', 'weknora_list_web_search_provider_configs'],
  // PATCH is a partial update, PUT replaces the record; the method suffix said
  // nothing a caller could act on.
  ['PATCH /knowledge-bases/{id}', 'weknora_update_knowledge_base'],
  ['PUT /knowledge-bases/{id}', 'weknora_replace_knowledge_base'],
  ['PATCH /agents/{id}', 'weknora_update_agent'],
  ['PUT /agents/{id}', 'weknora_replace_agent'],
  ['PATCH /models/{id}', 'weknora_update_model'],
  ['PUT /models/{id}', 'weknora_replace_model'],
  ['PATCH /web-search-providers/{id}', 'weknora_update_web_search_provider'],
  ['PUT /web-search-providers/{id}', 'weknora_replace_web_search_provider'],
  ['PATCH /knowledge-bases/{id}/faq/entries', 'weknora_update_knowledge_base_faq_entries'],
  ['PUT /knowledge-bases/{id}/faq/entries/{entry_id}', 'weknora_replace_knowledge_base_faq_entry'],
  ['POST /knowledge-bases/{id}/faq/entries', 'weknora_create_knowledge_base_faq_entry'],
  ['POST /knowledge-bases/{id}/faq/entry', 'weknora_create_knowledge_base_faq_entry_quick']
])

/**
 * One model-facing tool name: `weknora_<verb>_<resource>`.
 *
 * Every path segment contributes, because dropping the leading ones made
 * `/shared-knowledge-bases` and `/knowledge-bases` derive the same name. A
 * trailing action word supplies the verb (`/agents/{id}/copy` → `copy_agent`);
 * otherwise the HTTP method does, with GET distinguishing a collection listing
 * from an item read by whether the path ends in a parameter. A `list_` verb keeps
 * its noun plural; every other verb reads singular.
 */
function toolName(method, pathTemplate) {
  const override = NAME_OVERRIDES.get(`${method.toUpperCase()} ${pathTemplate}`)
  if (override !== undefined) return override

  const segments = pathTemplate
    .split('/')
    .filter((segment) => segment !== '' && !isParam(segment))
    .flatMap((segment) => segment.split('-'))
  const last = segments.at(-1) ?? ''
  const action = ACTION_WORDS.has(last) ? last : ''

  let verb
  if (action !== '') verb = action
  else if (method === 'get') {
    const endsInParam = (pathTemplate.split('/').filter(Boolean).at(-1) ?? '').startsWith('{')
    verb = endsInParam ? 'get' : 'list'
  } else verb = METHOD_VERB[method] ?? method

  const nouns = action === '' ? segments : segments.slice(0, -1)
  const resource = verb === 'list' ? nouns.join('_') : nouns.map(singularize).join('_')

  return `weknora_${verb}_${resource === '' ? 'root' : resource}`
}

/**
 * Cap one schema's nesting so a document entity cannot cost a quarter megabyte.
 *
 * Measured on WeKnora 0.9.0: untruncated input schemas total 283 KB across the
 * kept operations, and seven of them exceed 10 KB because a create route accepts
 * a whole `KnowledgeBase` entity — including fields the server ignores on input
 * (`id`, `created_at`, `tenant_id`).
 *
 * The depth is counted from the REQUEST BODY, not from the schema root: the
 * extractor wraps every body in one `requestBody` property, and a Go struct then
 * wraps its own fields in an `allOf` branch, so a raw depth of 3 left
 * `chunking_config` as `{ type: 'object' }` with none of its fields — the model
 * could see the knob but not turn it. Counting from the body keeps two levels of
 * real configuration visible while still collapsing the entity backlinks.
 */
const BODY_PROPERTY = 'requestBody'
const MAX_DEPTH = 4

/**
 * Inline every `allOf`, because the harness schema subset does not accept it.
 *
 * The extractor emits `allOf` as a `$ref` wrapper: most nodes carry exactly one
 * branch describing the referenced type, with sibling keywords beside it. The
 * harness accepts only type/oneOf/properties/required/additionalProperties/items/
 * enum/const, so a surviving `allOf` makes `ctx.tools.register()` REJECT the
 * whole tool definition — which is how a tool silently fails to appear.
 *
 * Sibling keywords win over the branch: that is the OpenAPI rule (the branch is
 * the base, the sibling is the override), and it is what keeps a field's
 * `description` and `enum` from being shadowed by the referenced entity.
 */
function collapseAllOf(node) {
  if (node === null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(collapseAllOf)
  const out = { ...node }
  if (out.allOf !== undefined) {
    const merged = {}
    for (const branch of out.allOf) {
      const collapsed = collapseAllOf(branch)
      if (collapsed === null || typeof collapsed !== 'object') continue
      // Deeper keys first, so an explicit sibling below still wins.
      for (const [key, value] of Object.entries(collapsed)) {
        if (key === 'properties' && merged.properties !== undefined) {
          merged.properties = { ...collapsed.properties, ...merged.properties }
        } else if (key === 'required' && Array.isArray(merged.required)) {
          merged.required = [...new Set([...collapsed.required, ...merged.required])]
        } else merged[key] = value
      }
    }
    delete out.allOf
    for (const [key, value] of Object.entries(out)) {
      if (key === 'properties' && merged.properties !== undefined) {
        merged.properties = { ...value, ...merged.properties }
      } else if (key === 'required' && Array.isArray(merged.required)) {
        merged.required = [...new Set([...value, ...merged.required])]
      } else merged[key] = value
    }
    for (const [key, value] of Object.entries(merged)) {
      out[key] = Array.isArray(value) || typeof value === 'object' ? collapseAllOf(value) : value
    }
  }
  if (out.properties !== undefined) {
    const properties = {}
    for (const [key, value] of Object.entries(out.properties)) properties[key] = collapseAllOf(value)
    out.properties = properties
  }
  for (const keyword of ['items', 'anyOf', 'oneOf']) {
    if (out[keyword] === undefined) continue
    out[keyword] = Array.isArray(out[keyword])
      ? out[keyword].map(collapseAllOf)
      : collapseAllOf(out[keyword])
  }
  return out
}

/**
 * Keywords the harness enforces, copied from its documented subset.
 *
 * Anything else makes `assertSupportedJsonSchema()` reject the schema, and a
 * rejected schema means the tool is never registered — silently, from the model's
 * point of view. The extractor copies every `x-*` vendor extension through, and
 * Swagger numbers (`minimum`, `maxItems`, …) are outside the subset, so this
 * project has to drop them explicitly rather than hope the document is clean.
 */
const ALLOWED_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples'
])

/** Values that leaked in as property names from `x-enum-varnames`. */
const looksLikeEnumName = (key) => /^[A-Z][A-Za-z0-9_]*$/.test(key) && !key.includes(' ')

/**
 * Reduce a schema to the enforced subset.
 *
 * Two things are dropped and one is repaired:
 *
 *   - every keyword outside {@link ALLOWED_KEYWORDS}: `x-agent*` annotations,
 *     `minimum`/`maximum`/`minItems`/`maxItems`, `x-enum-varnames`;
 *   - `additionalProperties` that is a SCHEMA rather than a boolean, because the
 *     subset only accepts the boolean form (`true` keeps the map open);
 *   - property names that are really enum values (`ModelSourceOpenAI`), which
 *     appear because Swagger put `x-enum-varnames` beside `enum` and the
 *     extractor's cycle-breaking turned them into fields.
 *
 * Constraints like `minimum` are dropped rather than translated: the model reads
 * the description, and a value outside the range is rejected by WeKnora with a
 * message this plugin already renders. Losing a numeric bound costs less than
 * losing the tool.
 */
function sanitize(node) {
  if (node === null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(sanitize)

  const out = {}
  for (const [key, value] of Object.entries(node)) {
    if (!ALLOWED_KEYWORDS.has(key)) continue
    if (key === 'additionalProperties' && typeof value === 'object' && value !== null) {
      out[key] = true
      continue
    }
    if (key === 'properties' && value !== null && typeof value === 'object') {
      const properties = {}
      for (const [name, schema] of Object.entries(value)) {
        if (looksLikeEnumName(name)) continue
        properties[name] = sanitize(schema)
      }
      out[key] = properties
      continue
    }
    if (key === 'required' && Array.isArray(value)) {
      out[key] = value
      continue
    }
    out[key] = typeof value === 'object' ? sanitize(value) : value
  }

  // `required` may name a property that sanitize just removed; a leftover name
  // fails validation with a message that points at the wrong node.
  if (Array.isArray(out.required) && out.properties !== undefined) {
    out.required = out.required.filter((name) => name in out.properties)
  }
  if (out.oneOf !== undefined && (!Array.isArray(out.oneOf) || out.oneOf.length < 2)) {
    // `oneOf` needs at least two branches; a degenerate one becomes an open node.
    const single = Array.isArray(out.oneOf) && out.oneOf.length === 1 ? out.oneOf[0] : null
    delete out.oneOf
    if (single !== null && typeof single === 'object') Object.assign(out, single)
  }
  return out
}

function truncate(node, depth = 0) {
  if (node === null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map((item) => truncate(item, depth))
  if (depth >= MAX_DEPTH) {
    // Keep only what still tells the model the value's shape and type; the
    // entity's own fields have already appeared at an outer level.
    const flattened = { type: node.type ?? 'object' }
    if (node.enum !== undefined) flattened.enum = node.enum
    if (typeof node.description === 'string') flattened.description = trim(node.description, 100)
    if (node.type === 'array') flattened.items = { type: node.items?.type ?? 'object' }
    return flattened
  }
  const out = { ...node }
  if (out.properties !== undefined) {
    const properties = {}
    for (const [key, value] of Object.entries(out.properties)) properties[key] = truncate(value, depth + 1)
    out.properties = properties
  }
  for (const keyword of ['items', 'additionalProperties']) {
    if (out[keyword] !== undefined && typeof out[keyword] === 'object') {
      out[keyword] = truncate(out[keyword], depth + 1)
    }
  }
  // `anyOf`/`oneOf` describe the same value in branches, so a branch costs no
  // level. `allOf` is already inlined by collapseAllOf before this runs.
  for (const keyword of ['anyOf', 'oneOf']) {
    if (out[keyword] !== undefined) out[keyword] = out[keyword].map((branch) => truncate(branch, depth))
  }
  return out
}

/**
 * Truncate a tool schema, counting depth from its request body.
 *
 * The read-only strip applies to the BODY only: path and query parameters are
 * merged into the same `properties` map, and `/agents/{id}` carries an `id` that
 * is the whole point of the call. Dropping it would every item-level tool.
 */
function truncateSchema(schema) {
  const body = schema?.properties?.[BODY_PROPERTY]
  if (body === undefined) return truncate(schema, 0)
  return {
    ...schema,
    properties: { ...schema.properties, [BODY_PROPERTY]: dropReadOnly(truncate(body, 0)) }
  }
}

/**
 * Fields a create/update route exposes only because it reuses the entity struct.
 *
 * They are server-assigned (`id`, `tenant_id`, timestamps), computed
 * (`knowledge_count`, `is_processing`), or derived (`generated_profile`), so a
 * caller that sends one is either ignored or actively wrong. WeKnora's own
 * Swagger flags them `readOnly`; the extractor keeps them in the input schema
 * anyway. Removing them from a request-body schema is the one place this script
 * drops information the document contains — measured on WeKnora 0.9.0 it also
 * removed 15 of the 36 `knowledge-bases` body fields, most of the schema's cost.
 */
const READ_ONLY_FIELDS = new Set([
  'id', 'tenant_id', 'created_at', 'updated_at', 'deleted_at',
  'creator_id', 'creator_name', 'knowledge_count', 'share_count', 'processing_count',
  'is_processing', 'is_temporary', 'generated_profile', 'pinned_at', 'is_pinned'
])

/** Strip server-assigned fields from every object level of a body schema. */
function dropReadOnly(node) {
  if (node === null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(dropReadOnly)
  const out = { ...node }
  if (out.properties !== undefined) {
    const properties = {}
    for (const [key, value] of Object.entries(out.properties)) {
      if (READ_ONLY_FIELDS.has(key)) continue
      properties[key] = dropReadOnly(value)
    }
    out.properties = properties
    if (Array.isArray(out.required)) {
      out.required = out.required.filter((name) => name in properties)
    }
  }
  for (const keyword of ['items', 'allOf', 'anyOf', 'oneOf']) {
    if (out[keyword] === undefined) continue
    out[keyword] = Array.isArray(out[keyword])
      ? out[keyword].map(dropReadOnly)
      : dropReadOnly(out[keyword])
  }
  return out
}

/** Collapse whitespace and cut to `limit`, preferring a sentence end. */
function trim(text, limit) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return flat
  const cut = flat.slice(0, limit)
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('。'), cut.lastIndexOf('; '), cut.lastIndexOf('：'))
  return (stop > limit * 0.5 ? cut.slice(0, stop + 1) : cut).trim()
}

const verdict = (pathTemplate) => EXCLUSIONS.find(([pattern]) => pattern.test(pathTemplate))?.[1] ?? ''

/** Tool name → its group, inverted once from the hand-written table. */
const GROUP_BY_TOOL = new Map()
for (const [group, names] of Object.entries(GROUP_MEMBERS)) {
  for (const name of names) {
    if (GROUP_BY_TOOL.has(name)) {
      throw new Error(`tool ${name} is listed in both "${GROUP_BY_TOOL.get(name)}" and "${group}"`)
    }
    GROUP_BY_TOOL.set(name, group)
  }
}

/**
 * Build the catalog from the tools the library extracted.
 *
 * A GET whose path ends in a parameter and a GET whose path does not can derive
 * the same name on a pathological route; a collision is resolved with the HTTP
 * method and reported, so a future WeKnora version renaming a route is noticed
 * here rather than when a tool registration throws.
 */
export function buildCatalog(tools) {
  const kept = []
  const byReason = new Map()
  let excluded = 0

  for (const tool of tools) {
    const reason = verdict(tool.pathTemplate)
    if (reason !== '') {
      excluded += 1
      byReason.set(reason, (byReason.get(reason) ?? 0) + 1)
      continue
    }
    kept.push({
      name: toolName(tool.method, tool.pathTemplate),
      method: tool.method.toUpperCase(),
      path: tool.pathTemplate,
      // The hand-written table is the authority; a tool it does not name is an
      // ERROR, because an ungrouped tool could never be revealed. Resolved after
      // the name is final (overrides and collision suffixes included), so the
      // check below can tell a typo from a missing entry.
      group: '',
      // BOTH fields are kept. The Swagger summary is a label (`知识搜索`); the
      // description is the sentence that tells a model WHEN to pick this tool
      // (`外部检索首选；可覆盖召回参数与 rerank`). Collapsing them to one short
      // string — which an earlier version did by preferring whichever was
      // non-empty — threw away the only text that distinguishes two tools with
      // similar names.
      title: trim(tool.title ?? '', 80),
      description: trim(tool.description ?? '', 400),
      schema: sanitize(truncateSchema(collapseAllOf(tool.inputSchema)))
    })
  }

  kept.sort((a, b) => a.name.localeCompare(b.name) || a.method.localeCompare(b.method))
  const seen = new Map()
  for (const tool of kept) {
    const count = seen.get(tool.name) ?? 0
    seen.set(tool.name, count + 1)
    if (count > 0) tool.name = `${tool.name}_${tool.method.toLowerCase()}`
  }
  const collisions = [...seen.entries()].filter(([, count]) => count > 1).map(([name]) => name)

  // Attach groups from the hand-written table, and fail loudly on any gap: an
  // unknown name in the table is a typo here, and a catalog tool with no group
  // could never be revealed by `weknora_get_tools`.
  const missing = []
  for (const tool of kept) {
    const group = GROUP_BY_TOOL.get(tool.name)
    if (group === undefined) {
      missing.push(tool.name)
      continue
    }
    tool.group = group
  }
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} catalog tool(s) are missing from GROUP_MEMBERS:\n  ${missing.join('\n  ')}`
    )
  }
  const stray = [...GROUP_BY_TOOL.keys()].filter((name) => !kept.some((tool) => tool.name === name))
  if (stray.length > 0) {
    throw new Error(
      `${stray.length} GROUP_MEMBERS entr(ies) name no catalog tool (typo or renamed):\n  ${stray.join('\n  ')}`
    )
  }

  return { kept, excluded, byReason, collisions }
}

/** The committed module: generated data, no hand-written logic. */
function emit({ kept, excluded, byReason, collisions }, meta) {
  const groups = new Map()
  for (const tool of kept) {
    if (!groups.has(tool.group)) groups.set(tool.group, [])
    groups.get(tool.group).push(tool.name)
  }
  const groupLines = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, names]) => `  ${group}: ${JSON.stringify(names)},`)
    .join('\n')

  const opLines = kept
    .map(
      (tool) =>
        `  [${JSON.stringify(tool.name)}, ${JSON.stringify(tool.method)}, ${JSON.stringify(
          tool.path
        )}, ${JSON.stringify(tool.group)}, ${JSON.stringify(tool.title)}, ${JSON.stringify(
          tool.description
        )}, ${JSON.stringify(tool.schema)}],`
    )
    .join('\n')

  const reasonLine = [...byReason.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${count} ${reason}`)
    .join(', ')

  return `/**
 * WeKnora REST catalog — GENERATED, DO NOT EDIT.
 *
 * Source: ${meta.source} (WeKnora ${meta.version})
 * Extracted by openapi-mcp-generator, filtered and named by scripts/gen-catalog.mjs.
 * Regenerate when the bundled WeKnora version changes; a hand edit is overwritten.
 *
 * ${meta.total} Swagger operations → ${kept.length} tools, ${excluded} excluded
 * (${reasonLine}).
 *
 * Each row is [name, METHOD, pathTemplate, group, title, description, inputSchema].
 * The title is the Swagger summary (a label); the description is the prose that
 * says what the call does and when to reach for it. The schema is JSON Schema
 * 2020-12 with paths and the request body flattened into one object, truncated to
 * ${MAX_DEPTH} levels (see gen-catalog.mjs).
 *
 * Excluded operations are unreachable with a workspace API key, or unservable by
 * the bundled Lite build; the EXCLUSIONS table in gen-catalog.mjs carries the
 * reason attached to each rule.${collisions.length > 0 ? `\n *\n * Name collisions resolved with an HTTP-method suffix: ${collisions.join(', ')}` : ''}
 */

/** Capability groups: the unit \`weknora_get_tools\` is asked for. */
export const GROUPS = {
${groupLines}
}

/** Every catalog row. */
export const OPERATIONS = [
${opLines}
]

/** Name → row, built once so a lookup is not a linear scan. */
export const OPERATIONS_BY_NAME = new Map(OPERATIONS.map((row) => [row[0], row]))

/** The group names a caller may request, in declaration order. */
export const GROUP_NAMES = Object.freeze(Object.keys(GROUPS))
`
}

const swaggerPath = process.argv[2]
if (swaggerPath === undefined) {
  console.error('usage: node scripts/gen-catalog.mjs <path-to-docs/swagger.json>')
  process.exit(2)
}

const swagger = JSON.parse(fs.readFileSync(swaggerPath, 'utf8'))

// WeKnora publishes Swagger 2.0; the extractor speaks OpenAPI 3. Convert into a
// temp file rather than memory because the converter's own `$ref` patching is
// exercised through its file path, and warnOnly keeps a single odd parameter
// from aborting an otherwise valid document.
const openapiPath = path.join(os.tmpdir(), `weknora-openapi-${process.pid}.json`)
const converted = await converter.convertObj(swagger, { patch: true, warnOnly: true })
fs.writeFileSync(openapiPath, JSON.stringify(converted.openapi), 'utf8')

try {
  const tools = await getToolsFromOpenApi(openapiPath, { dereference: true })
  const built = buildCatalog(tools)
  const total = Object.values(swagger.paths ?? {}).reduce(
    (sum, methods) => sum + Object.keys(methods).filter((method) => METHODS.has(method)).length,
    0
  )
  fs.writeFileSync(
    OUT,
    emit(built, {
      source: `${path.basename(path.dirname(path.dirname(path.resolve(swaggerPath))))}/docs/swagger.json`,
      version: swagger.info?.version ?? 'unknown',
      total
    }),
    'utf8'
  )
  const bytes = Buffer.byteLength(fs.readFileSync(OUT, 'utf8'))
  console.log(`catalog: ${built.kept.length} tools, ${Math.round(bytes / 1024)} KB → ${path.relative(process.cwd(), OUT)}`)
  if (built.collisions.length > 0) console.log(`collisions: ${built.collisions.join(', ')}`)
} finally {
  fs.rmSync(openapiPath, { force: true })
}
