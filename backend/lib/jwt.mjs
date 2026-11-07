import crypto from 'crypto'

// =============================================================================
// Minimal HS256 JWT (sign + verify) using Node crypto — no dependency.
// Used for BOTH directions of the embed SSO:
//   • verify the CLIENT's signed token (keyed by the client's shared secret), and
//   • mint/verify Atelier's own short-lived embed SESSION token (keyed by
//     ATELIER_EMBED_SECRET, server-only).
// HS256 (shared secret) only. RS256 (client public key) can be added later by
// swapping the verify step; the endpoints don't otherwise change.
// =============================================================================

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function b64urlJson(obj) {
  return b64url(JSON.stringify(obj))
}
function fromB64url(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4))
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}

function sign(headerB64, payloadB64, secret) {
  return b64url(crypto.createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest())
}

/** Sign an HS256 JWT. `expiresInSec` sets `exp` (and `iat`). */
export function signJwt(payload, secret, { expiresInSec = 3600 } = {}) {
  const now = Math.floor(Date.now() / 1000)
  const body = { iat: now, exp: now + expiresInSec, ...payload }
  const headerB64 = b64urlJson({ alg: 'HS256', typ: 'JWT' })
  const payloadB64 = b64urlJson(body)
  const sig = sign(headerB64, payloadB64, secret)
  return `${headerB64}.${payloadB64}.${sig}`
}

/**
 * Verify an HS256 JWT against `secret`. Returns the decoded payload, or throws
 * with a stable `.code` ('malformed' | 'bad_alg' | 'bad_signature' | 'expired').
 * Signature comparison is constant-time; `exp` is required and enforced.
 */
export function verifyJwt(token, secret, { maxLifetimeSec } = {}) {
  if (typeof token !== 'string' || token.split('.').length !== 3) {
    throw Object.assign(new Error('Malformed token'), { code: 'malformed' })
  }
  const [headerB64, payloadB64, sigB64] = token.split('.')

  let header, payload
  try {
    header = JSON.parse(fromB64url(headerB64).toString('utf8'))
    payload = JSON.parse(fromB64url(payloadB64).toString('utf8'))
  } catch {
    throw Object.assign(new Error('Malformed token'), { code: 'malformed' })
  }
  if (header?.alg !== 'HS256') {
    throw Object.assign(new Error('Unsupported alg'), { code: 'bad_alg' })
  }

  const expected = sign(headerB64, payloadB64, secret)
  const a = Buffer.from(expected)
  const b = Buffer.from(sigB64)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw Object.assign(new Error('Bad signature'), { code: 'bad_signature' })
  }

  const now = Math.floor(Date.now() / 1000)
  if (typeof payload.exp !== 'number' || payload.exp <= now) {
    throw Object.assign(new Error('Token expired'), { code: 'expired' })
  }
  // Reject over-long-lived client tokens (defense in depth): the client JWT must be
  // short-lived so a leaked token has a tiny window.
  if (maxLifetimeSec && typeof payload.iat === 'number' && payload.exp - payload.iat > maxLifetimeSec + 5) {
    throw Object.assign(new Error('Token lifetime too long'), { code: 'expired' })
  }
  return payload
}
