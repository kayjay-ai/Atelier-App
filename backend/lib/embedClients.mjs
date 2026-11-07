import { serviceDb } from './db.mjs'
// =============================================================================
// Partner client registry (provisioning). A client is a retailer allowed to embed
// Atelier. Each has: client_id, a signing `secret` (shared HMAC secret used to
// verify the client's SSO tokens), `allowed_origins` (exact origins allowed to
// frame Atelier + hand off tokens), an `api_key` (for the server-to-server partner
// history API), a display `name`, and an `active` flag.
//
// Source of truth is server-side ONLY (never the client bundle):
//   • a built-in `demo` client for local testing, and
//   • any clients supplied via the EMBED_CLIENTS_JSON env var (JSON array).
// Swap this module for a Supabase `embed_clients` table read later if desired —
// the rest of the code only calls getClient / originAllowed / clientForApiKey.
// =============================================================================

function loadClients() {
  const list = []

  // Built-in demo client (local dev + the VERVE retail demo on :5199).
  list.push({
    client_id: 'demo',
    secret: process.env.EMBED_DEMO_SECRET || 'dev-embed-shared-secret-change-me',
    api_key: process.env.EMBED_DEMO_API_KEY || 'demo-partner-api-key-change-me',
    allowed_origins: (process.env.EMBED_DEMO_ORIGINS || 'http://localhost:5199,http://localhost:5173,http://localhost:8081')
      .split(',').map((s) => s.trim()).filter(Boolean),
    name: 'Demo Retailer',
    active: true,
  })

  // Additional clients from env (production provisioning), JSON array of the same shape.
  if (process.env.EMBED_CLIENTS_JSON) {
    try {
      const extra = JSON.parse(process.env.EMBED_CLIENTS_JSON)
      for (const c of Array.isArray(extra) ? extra : []) {
        if (c?.client_id && c?.secret) {
          list.push({
            client_id: c.client_id,
            secret: c.secret,
            api_key: c.api_key || null,
            allowed_origins: Array.isArray(c.allowed_origins) ? c.allowed_origins : [],
            name: c.name || c.client_id,
            active: c.active !== false,
          })
        }
      }
    } catch (err) {
      console.error('[Atelier] EMBED_CLIENTS_JSON is not valid JSON — ignoring:', err.message)
    }
  }

  const byId = new Map()
  for (const c of list) byId.set(c.client_id, c)
  return byId
}

const CLIENTS = loadClients()

/** Look up an active client by id, or null. */
export function getClient(clientId) {
  const c = CLIENTS.get(clientId)
  return c && c.active ? c : null
}

/** True if `origin` is exactly in the client's allowlist. */
export function originAllowed(clientId, origin) {
  const c = getClient(clientId)
  if (!c || !origin) return false
  return c.allowed_origins.includes(origin)
}

/** Resolve the client owning a server-to-server partner API key (constant-ish scan). */
export function clientForApiKey(apiKey) {
  if (!apiKey) return null
  for (const c of CLIENTS.values()) {
    if (c.active && c.api_key && c.api_key === apiKey) return c
  }
  return null
}

/** All allowed origins across active clients (for CSP frame-ancestors defaults). */
export function allEmbedOrigins() {
  const s = new Set()
  for (const c of CLIENTS.values()) if (c.active) c.allowed_origins.forEach((o) => s.add(o))
  return [...s]
}

// ── Per-client AI feature toggles ────────────────────────────────────────────
// Every feature defaults to ON, so a client with no explicit config behaves as
// today. Keys: virtual_tryon, size_assist, style_color_assist.
export const FEATURE_KEYS = ['virtual_tryon', 'size_assist', 'style_color_assist']

/** Normalise a client's enabled_features to a full boolean map (missing → true). */
export function enabledFeatures(client) {
  const raw = client?.enabled_features ?? {}
  const out = {}
  for (const k of FEATURE_KEYS) out[k] = raw[k] !== false // default true
  return out
}

// ── Supabase-backed registry (so the admin portal can register/edit clients) ──
// The DB row wins; the config client (demo) is the fallback. Cached briefly so a
// generation path doesn't hit the DB every call.

const CACHE_TTL_MS = 30_000
const cache = new Map() // key → { at, value }
const cached = (key) => { const e = cache.get(key); return e && Date.now() - e.at < CACHE_TTL_MS ? e.value : undefined }
const putCache = (key, value) => { cache.set(key, { at: Date.now(), value }); return value }

function normalizeRow(row) {
  if (!row) return null
  return {
    client_id: row.client_id,
    name: row.name,
    secret: row.secret,
    api_key: row.api_key ?? null,
    allowed_origins: row.allowed_origins ?? [],
    active: row.active !== false,
    enabled_features: row.enabled_features ?? {},
  }
}

/** Resolve a client by id: Supabase embed_clients first, else the config registry. */
export async function resolveClient(clientId) {
  if (!clientId) return null
  const key = `id:${clientId}`
  const hit = cached(key)
  if (hit !== undefined) return hit
  const db = serviceDb()
  if (db) {
    try {
      const { data, error } = await db.from('embed_clients').select('*').eq('client_id', clientId).maybeSingle()
      if (!error && data) return putCache(key, data.active ? normalizeRow(data) : null)
    } catch { /* fall through to config */ }
  }
  return putCache(key, getClient(clientId)) // config fallback (includes defaults → all features on)
}

/** Resolve the client owning a partner API key: Supabase first, else config. */
export async function resolveClientByApiKey(apiKey) {
  if (!apiKey) return null
  const db = serviceDb()
  if (db) {
    try {
      const { data, error } = await db.from('embed_clients').select('*').eq('api_key', apiKey).eq('active', true).maybeSingle()
      if (!error && data) return normalizeRow(data)
    } catch { /* fall through */ }
  }
  return clientForApiKey(apiKey)
}
