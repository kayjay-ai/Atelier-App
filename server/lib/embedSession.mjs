import crypto from 'crypto'
import { signJwt, verifyJwt } from './jwt.mjs'
import { serviceDb } from './db.mjs'

// =============================================================================
// Embed SSO session + client-scoped storage. Everything here runs server-side and
// is keyed by the VERIFIED (client_id, external_user_id) — never a client-supplied
// identity. Atelier session tokens are HS256 JWTs signed with ATELIER_EMBED_SECRET.
// =============================================================================

const SESSION_SECRET = process.env.ATELIER_EMBED_SECRET || 'dev-atelier-embed-session-secret-change-me'
const SESSION_TTL_SEC = Number(process.env.EMBED_SESSION_TTL_SEC ?? 3600) // 1h; refreshable

const missingTable = (msg) => !!msg && /does not exist|schema cache|could not find the table/i.test(msg)

/** Deterministic UUID from (client_id, external_user_id) — stable fallback identity
 *  when the embed_users table isn't present, so the same client user always maps to
 *  the same Atelier id even without persistence. */
function deterministicUserId(clientId, externalUserId) {
  const h = crypto.createHash('sha256').update(`${clientId}:${externalUserId}`).digest('hex')
  return [h.slice(0, 8), h.slice(8, 12), '4' + h.slice(13, 16), '8' + h.slice(17, 20), h.slice(20, 32)].join('-')
}

/**
 * Find-or-create the Atelier user for (client_id, external_user_id). Persists to
 * `embed_users` when available; otherwise falls back to a deterministic id so SSO
 * still works before the migration is applied. Returns the atelier_user_id.
 */
export async function findOrCreateEmbedUser(clientId, externalUserId, { name, email } = {}) {
  const fallbackId = deterministicUserId(clientId, externalUserId)
  const db = serviceDb()
  if (!db) return fallbackId

  try {
    const { data: existing, error } = await db
      .from('embed_users')
      .select('atelier_user_id')
      .eq('client_id', clientId)
      .eq('external_user_id', externalUserId)
      .maybeSingle()
    if (error) { if (missingTable(error.message)) return fallbackId; throw error }
    if (existing?.atelier_user_id) return existing.atelier_user_id

    const atelierUserId = fallbackId
    const { error: insErr } = await db.from('embed_users').insert({
      atelier_user_id: atelierUserId,
      client_id: clientId,
      external_user_id: externalUserId,
      name: name ?? null,
      email: email ?? null,
    })
    if (insErr && !/duplicate key/i.test(insErr.message) && !missingTable(insErr.message)) throw insErr
    return atelierUserId
  } catch (err) {
    console.warn('[Atelier] findOrCreateEmbedUser fell back (no persistence):', err.message)
    return fallbackId
  }
}

/** Mint a short-lived Atelier embed SESSION token (held in the iframe's memory).
 *  `features` (enabled_features map) is embedded so the server can enforce per-call
 *  and the frontend can hide disabled features — no extra round-trip. */
export function mintSession({ atelierUserId, clientId, externalUserId, name, email, features }) {
  return signJwt(
    { sub: atelierUserId, cid: clientId, ext: externalUserId, name: name ?? null, email: email ?? null, feat: features ?? null, kind: 'embed' },
    SESSION_SECRET,
    { expiresInSec: SESSION_TTL_SEC },
  )
}

/** Verify an Atelier embed session token from an Authorization header. Returns the
 *  session claims { atelierUserId, clientId, externalUserId, name, email, features } or null. */
export function verifySession(token) {
  try {
    const p = verifyJwt(token, SESSION_SECRET)
    if (p.kind !== 'embed' || !p.sub || !p.cid || !p.ext) return null
    return { atelierUserId: p.sub, clientId: p.cid, externalUserId: p.ext, name: p.name, email: p.email, features: p.feat ?? null }
  } catch {
    return null
  }
}

/** Extract + verify the embed session from a request's Authorization: Bearer header. */
export function embedSessionFromRequest(req) {
  const h = req.headers?.authorization || ''
  const m = /^Bearer\s+(.+)$/i.exec(h)
  return m ? verifySession(m[1].trim()) : null
}

export const SESSION_LIFETIME_SEC = SESSION_TTL_SEC

/** Save a generation scoped to the session's (client_id, external_user_id). */
export async function saveEmbedGeneration(session, { kind, imageUrl, result, productName }) {
  const db = serviceDb()
  if (!db) return null
  try {
    const { data, error } = await db.from('embed_generations').insert({
      client_id: session.clientId,
      external_user_id: session.externalUserId,
      atelier_user_id: session.atelierUserId,
      kind, // 'tryon' | 'size' | 'verdict'
      image_url: imageUrl ?? null,
      result: result ?? null,
      product_name: productName ?? null,
    }).select('id, created_at').maybeSingle()
    if (error) { if (missingTable(error.message)) return null; throw error }
    return data
  } catch (err) {
    console.warn('[Atelier] saveEmbedGeneration failed:', err.message)
    return null
  }
}

/** List generations for a (client_id, external_user_id). Server-scoped, newest first. */
export async function listEmbedGenerations(clientId, externalUserId, limit = 100) {
  const db = serviceDb()
  if (!db) return []
  try {
    const { data, error } = await db
      .from('embed_generations')
      .select('id, kind, image_url, result, product_name, created_at')
      .eq('client_id', clientId)
      .eq('external_user_id', externalUserId)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) { if (missingTable(error.message)) return []; throw error }
    return data ?? []
  } catch (err) {
    console.warn('[Atelier] listEmbedGenerations failed:', err.message)
    return []
  }
}
