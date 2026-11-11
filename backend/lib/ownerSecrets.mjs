import crypto from 'crypto'

// =============================================================================
// Owner portal secrets: one-time codes, activation/reset tokens and invite
// links. All are keyed by a server-only key, so the database never holds a
// usable code, token or link:
//   OWNER_TOKEN_SECRET when set, otherwise a key derived from the service-role
//   key (rotating that key then also voids open invite links and codes).
// =============================================================================

function serverKey() {
  const own = (process.env.OWNER_TOKEN_SECRET || '').trim()
  if (own) return own
  const service = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
  if (!service) return null
  return crypto.createHmac('sha256', service).update('atelier-owner-portal-v1').digest('hex')
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** Keyed hash of a value for one purpose ('otp', 'token', 'invite'). */
export function keyedHash(purpose, value) {
  const key = serverKey()
  if (!key) throw new Error('owner portal: no server key (set SUPABASE_SERVICE_ROLE_KEY or OWNER_TOKEN_SECRET)')
  return crypto.createHmac('sha256', key).update(`${purpose}:${value}`).digest('hex')
}

/** Constant-time comparison of two hex / text strings. */
export function sameSecret(a, b) {
  const x = Buffer.from(String(a ?? ''))
  const y = Buffer.from(String(b ?? ''))
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y)
}

/** A 6-digit one-time code. */
export const newOtp = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')

/** A random, URL-safe secret (activation / reset token, invite nonce). */
export const newSecret = (bytes = 32) => b64url(crypto.randomBytes(bytes))

// ── Invite links ─────────────────────────────────────────────────────────────
// token = <invite id without dashes>.<HMAC(id, nonce)>. A new nonce (resend,
// email change) voids every older link of that invite.
export function inviteToken(inviteId, nonce) {
  const id = String(inviteId).replace(/-/g, '')
  return `${id}.${b64url(Buffer.from(keyedHash('invite', `${id}:${nonce}`), 'hex'))}`
}

/** The invite id inside a token, or null when it isn't shaped like one. */
export function inviteIdOf(token) {
  const m = /^([0-9a-f]{32})\.[A-Za-z0-9_-]{20,80}$/.exec(String(token ?? ''))
  if (!m) return null
  const h = m[1]
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export const inviteTokenMatches = (token, inviteId, nonce) => sameSecret(token, inviteToken(inviteId, nonce))

// ── Passwords ────────────────────────────────────────────────────────────────
export const PASSWORD_RULES = [
  { id: 'length', label: 'At least 8 characters', test: (p) => p.length >= 8 },
  { id: 'upper', label: 'One uppercase letter', test: (p) => /[A-Z]/.test(p) },
  { id: 'lower', label: 'One lowercase letter', test: (p) => /[a-z]/.test(p) },
  { id: 'number', label: 'One number', test: (p) => /[0-9]/.test(p) },
  { id: 'symbol', label: 'One symbol', test: (p) => /[^A-Za-z0-9]/.test(p) },
]

/** The rules a password doesn't meet yet (empty = acceptable). */
export function passwordProblems(password) {
  const p = typeof password === 'string' ? password : ''
  const unmet = PASSWORD_RULES.filter((r) => !r.test(p)).map((r) => r.label)
  if (p.length > 72) unmet.push('At most 72 characters')
  return unmet
}

// ── Small validators ─────────────────────────────────────────────────────────
export const normEmail = (e) => String(e ?? '').trim().toLowerCase()
export const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254
export const normCode = (c) => String(c ?? '').trim().toUpperCase().replace(/\s+/g, '')

/** r••••@brand.com */
export function maskEmail(email) {
  const [user, domain] = String(email).split('@')
  if (!domain) return '••••'
  return `${user.slice(0, 1)}••••@${domain}`
}

/** "Chrome on Windows" from a User-Agent header. */
export function describeUserAgent(ua) {
  const s = String(ua ?? '')
  if (!s) return 'Unknown device'
  const browser = /Edg\//.test(s) ? 'Edge'
    : /OPR\/|Opera/.test(s) ? 'Opera'
    : /Firefox\//.test(s) ? 'Firefox'
    : /CriOS|Chrome\//.test(s) ? 'Chrome'
    : /Safari\//.test(s) ? 'Safari'
    : /Expo|okhttp|CFNetwork|Darwin/.test(s) ? 'Atelier app'
    : 'Browser'
  const os = /iPad/.test(s) ? 'iPad'
    : /iPhone/.test(s) ? 'iPhone'
    : /Android/.test(s) ? 'Android'
    : /Windows/.test(s) ? 'Windows'
    : /Mac OS X|Macintosh/.test(s) ? 'Mac'
    : /Linux/.test(s) ? 'Linux'
    : null
  return os ? `${browser} on ${os}` : browser
}
