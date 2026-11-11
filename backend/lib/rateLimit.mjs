// =============================================================================
// In-memory rate limits (one API process on the Droplet). A limit is a name, a
// count and a window; keys are an IP or an email. Memory stays bounded.
// =============================================================================

/**
 * The caller's IP. Behind the reverse proxy (Caddy) the right-most
 * X-Forwarded-For entry is the one the proxy added (the caller can't forge it).
 */
export function clientIp(req) {
  const fwd = String(req.headers?.['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return fwd[fwd.length - 1] || req.socket?.remoteAddress || 'unknown'
}

const buckets = new Map() // `${name}:${key}` → timestamps

/**
 * Count one attempt. Returns false when the key already used `limit` attempts
 * inside `windowMs` (the attempt is then not counted).
 */
export function allow(name, key, limit, windowMs) {
  const id = `${name}:${String(key).toLowerCase()}`
  const now = Date.now()
  const hits = (buckets.get(id) ?? []).filter((t) => now - t < windowMs)
  if (hits.length >= limit) {
    buckets.set(id, hits)
    return false
  }
  hits.push(now)
  buckets.set(id, hits)
  if (buckets.size > 20_000) buckets.clear()
  return true
}

/** Forget a key's attempts (e.g. after a successful sign-in). */
export function reset(name, key) {
  buckets.delete(`${name}:${String(key).toLowerCase()}`)
}
