/**
 * Shared vocabulary: the one tool this plugin injects, the config defaults, and
 * the handful of constants both halves of the lifecycle agree on.
 *
 * The plugin imports nothing from the harness at runtime — the tool definition in
 * `tool.js` mirrors the documented `ToolDefinition` shape structurally — so this
 * module is plain data and stays testable without a Cordis context.
 */

/** The model-facing tool. One tool, one job: make the server reachable. */
export const TOOL_NAME = 'weknora_run'

/** Defaults merged under the row's `config`, so a bare row still starts. */
export const DEFAULT_CONFIG = Object.freeze({
  host: '127.0.0.1',
  port: 18080,
  dataDir: '',
  startupTimeoutMs: 120_000,
  stopOnDispose: true,
  extraEnv: Object.freeze({})
})

/** Paths below `$DSH_HOME`. */
export const RUNTIME_DIR = 'weknora'
/** The executable's file name. This package ships macOS builds only. */
export const EXE_BASENAME = 'WeKnora-lite'
/** Generated dotenv file; the child is started with `ENV_FILE` pointing at it. */
export const ENV_FILE_NAME = 'weknora.env'
/** Where the supervisor records the child it owns. */
export const STATE_FILE_NAME = 'run.json'
/** Full child output for one run, truncated on every start. */
export const LOG_FILE_NAME = 'server.log'

/**
 * Keys the child needs from its dotenv file.
 *
 * This is intentionally the Lite edition's working set: sqlite for both the
 * database and retrieval, local file storage, memory stream manager, and no
 * graph/RAG services. Missing any of them is what makes a bare binary panic with
 * an empty driver name, so the generated file always states all of them.
 */
export const ENV_TEMPLATE_KEYS = Object.freeze([
  'DB_DRIVER',
  'DB_PATH',
  'RETRIEVE_DRIVER',
  'STORAGE_TYPE',
  'LOCAL_STORAGE_BASE_DIR',
  'STREAM_MANAGER_TYPE',
  'OLLAMA_BASE_URL',
  'SYSTEM_AES_KEY',
  'JWT_SECRET',
  'NEO4J_ENABLE',
  'WEKNORA_SANDBOX_MODE',
  'ENABLE_GRAPH_RAG',
  'DISABLE_REGISTRATION',
  'CONCURRENCY_POOL_SIZE',
  'GIN_MODE',
  'LOG_LEVEL'
])

/** Keys whose value is a secret: generated once, then kept verbatim. */
export const SECRET_ENV_KEYS = Object.freeze(['SYSTEM_AES_KEY', 'JWT_SECRET'])

/** `SYSTEM_AES_KEY` is used as a 32-byte AES key, so it is 32 ASCII characters. */
export const SECRET_LENGTH = 32

/** How often a starting child is asked whether it is ready. */
export const READY_POLL_MS = 300
/** One probe timeout; a healthy loopback server answers in milliseconds. */
export const PROBE_TIMEOUT_MS = 1_500
/** After a kill, how long the exit is awaited before `taskkill` force-fails it. */
export const KILL_GRACE_MS = 5_000
/** Child output lines kept in memory for diagnosing a failed start. */
export const LOG_RING_LINES = 300
/** Lines quoted in a start failure. */
export const LOG_TAIL_LINES = 20

/**
 * How long one `weknora_run` call waits for the card's key before answering.
 *
 * The call is the thing the card hangs off, so "wait for the user" means this
 * tool stays pending; five minutes covers a browser trip to create the key
 * without holding a turn hostage forever.
 */
export const KEY_WAIT_MS = 5 * 60_000

/** The three ways `weknora_run` can answer. */
export const RUN_STATES = Object.freeze(['started', 'already-running', 'adopted'])