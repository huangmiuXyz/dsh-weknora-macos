/**
 * The child-process adapter: the host's `ctx.subprocess` seam, and nothing else.
 *
 * The supervisor does not care how a process is spawned, only that it can watch its
 * output, terminate it, and wait for the managed range to go quiet. The seam gives
 * exactly that: the harness owns the process range (so a service teardown reaps a
 * forgotten server), the parent environment arrives scrubbed, and `terminate()`
 * plus `waitForExit()` are the only verbs needed.
 */
import { KILL_GRACE_MS } from './protocol.js'

/** Split a stream into lines once, so both the log file and the ring get lines. */
export function lineAssembler(onLine) {
  let buffer = ''
  return (chunk) => {
    buffer += String(chunk)
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      onLine(buffer.slice(0, index).replace(/\r$/, ''))
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
    }
    // A single enormous line (a panic dump) must not grow without bound.
    if (buffer.length > 16_384) {
      onLine(buffer)
      buffer = ''
    }
  }
}

/** Adapter over the host seam. `spawn` throws synchronously for an invalid spec. */
export function subprocessSpawner(service) {
  if (service === undefined || typeof service?.spawn !== 'function') {
    throw new Error('ctx.subprocess is not available in this composition')
  }
  return {
    kind: 'subprocess',
    async spawn({ exe, cwd, env, onLine, onExit }) {
      const handle = service.spawn({
        argv: [exe],
        cwd,
        // All dispositions explicit: the seam applies no defaults. Piped streams
        // are ours to drain, which is what feeds the log file and the error tail.
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: KILL_GRACE_MS,
        env
      })
      const collect = lineAssembler(onLine)
      handle.stdout?.on('data', collect)
      handle.stderr?.on('data', collect)
      handle.done.then(
        (outcome) => onExit({ code: outcome?.exitCode ?? null, signal: outcome?.signal ?? null }),
        (error) => onExit({ error: String(error?.message ?? error) })
      )
      return {
        kind: 'subprocess',
        terminate() {
          try {
            handle.terminate()
          } catch {
            /* already gone */
          }
        },
        async waitExit(timeoutMs) {
          try {
            return await handle.waitForExit(AbortSignal.timeout(timeoutMs))
          } catch {
            return false
          }
        }
      }
    }
  }
}