/**
 * Config normalization for one `weknora` row.
 *
 * The row lives in `cordis.patch.yml`, so the values arrive as plain YAML — no
 * schema layer stands between a user's edit and this file. Every field is
 * therefore validated here and clamped to a range that keeps the tool honest:
 * a timeout of `0` would make a first boot look like a crash, and a bad port
 * would fail the bind after the server had already started working.
 */
import { DEFAULT_CONFIG } from './protocol.js'

function asInteger(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseInt(value.trim(), 10)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/** A loopback-ish host: no scheme, no path, no port suffix. */
function normalizeHost(value) {
  if (typeof value !== 'string') return DEFAULT_CONFIG.host
  const trimmed = value
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
  if (trimmed === '' || trimmed.includes('/') || trimmed.includes(':')) return DEFAULT_CONFIG.host
  return trimmed
}

/** Extra child environment: string values only, so nothing surprising is serialized. */
function normalizeExtraEnv(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const env = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    if (typeof raw === 'string') env[key] = raw
  }
  return env
}

export function normalizeConfig(raw = {}) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    host: normalizeHost(input.host),
    port: clamp(asInteger(input.port, DEFAULT_CONFIG.port), 0, 65_535),
    dataDir: typeof input.dataDir === 'string' ? input.dataDir.trim() : '',
    startupTimeoutMs: clamp(
      asInteger(input.startupTimeoutMs, DEFAULT_CONFIG.startupTimeoutMs),
      5_000,
      600_000
    ),
    stopOnDispose: typeof input.stopOnDispose === 'boolean' ? input.stopOnDispose : true,
    extraEnv: normalizeExtraEnv(input.extraEnv)
  }
}