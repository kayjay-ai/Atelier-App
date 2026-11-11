import { serviceDb, passwordAuthClient, isMissingSchema } from './db.mjs'
import { sendEmail, emailBypass } from './email.mjs'
import { allow } from './rateLimit.mjs'
import { notifyOwner, prefsOf, cleanPrefs } from './ownerNotify.mjs'
import {
  keyedHash, sameSecret, newOtp, newSecret, passwordProblems,
  normEmail, isEmail, normCode, maskEmail, describeUserAgent,
} from './ownerSecrets.mjs'

// =============================================================================
// Owner accounts (supabase/migrations/owner-portal.sql).
//
// An owner activates once: store code (b2b_companies.company_code) + the email
// Atelier registered for them (b2b_companies.manager_email) → a 6-digit code by
// email → a password. That creates (or reuses) a Supabase Auth user. After
// that they sign in with email + password, always THROUGH THIS API, which:
//   • locks sign-in for 15 minutes after 5 wrong passwords and emails a notice;
//   • records the Supabase session in b2b_owner_sessions with its lifetime
//     (24 hours, or 30 days with "Keep me signed in").
// The owner API only accepts a Supabase token whose session is recorded there
// and not ended, so a session started any other way can't use it.
// Forgot password = the same code steps with purpose 'reset'.
// =============================================================================

export class OwnerError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

const MIN = 60_000
export const OTP_TTL_MS = 10 * MIN
export const OTP_MAX_ATTEMPTS = 5
export const RESEND_COOLDOWN_MS = MIN
export const MAX_RESENDS = 3           // per 30 minutes
export const TOKEN_TTL_MS = 15 * MIN
export const SESSION_SHORT_MS = 24 * 60 * MIN
export const SESSION_LONG_MS = 30 * 24 * 60 * MIN
export const LOGIN_MAX_FAILS = 5
export const LOCK_MS = 15 * MIN
const WINDOW_MS = 15 * MIN

const MISMATCH = 'We couldn’t verify that store code and email. Check both and try again.'
const TOO_MANY = 'Too many attempts. Try again in 15 minutes.'
const BAD_LOGIN = 'Email or password is incorrect.'
const NOT_SET_UP = 'The owner portal isn’t set up yet — contact Atelier support.'
const NOT_ACTIVE = 'Your account isn’t active yet.'
const PAUSED = 'Your organization’s Atelier access is paused — contact Atelier support.'
// b2b_owners.status is the admin panel's: 'blocked' stops activation, sign-in and every owner call.
const BLOCKED = 'Your owner account is blocked — contact Atelier support.'

function db() {
  const client = serviceDb()
  if (!client) throw new OwnerError(503, 'no_database', 'The owner portal is not available right now.')
  return client
}

/** Throw a database error, as "not set up" when the migration isn't applied. */
function check(error) {
  if (!error) return
  if (isMissingSchema(error)) {
    // Say exactly what is missing, so a half-applied owner-portal.sql is easy to spot.
    console.error(`[Atelier] owner portal: database not set up (${error.code ?? "?"}): ${error.message}`)
    throw new OwnerError(503, 'not_set_up', NOT_SET_UP)
  }
  throw error
}

const ilikeExact = (s) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`)
const COMPANY_COLS = 'company_id, company_name, brand_name, logo_url, company_code, manager_email, primary_contact_name, primary_contact, status'

async function companyForEmail(email) {
  const { data, error } = await db().from('b2b_companies').select(COMPANY_COLS)
    .ilike('manager_email', ilikeExact(email)).limit(1)
  check(error)
  return data?.[0] ?? null
}

async function companyForCodeAndEmail(code, email) {
  if (!/^[A-Z0-9]{3,12}$/.test(code)) return null
  const { data, error } = await db().from('b2b_companies').select(COMPANY_COLS).eq('company_code', code).limit(1)
  check(error)
  const company = data?.[0]
  return company && normEmail(company.manager_email) === email ? company : null
}

async function ownerForCompany(companyId) {
  const { data, error } = await db().from('b2b_owners').select('*').eq('company_id', companyId).maybeSingle()
  check(error)
  return data ?? null
}

async function isStoreLogin(email) {
  const { data, error } = await db().from('b2b_stores').select('store_id').ilike('store_email', ilikeExact(email)).limit(1)
  check(error)
  return (data ?? []).length > 0
}

/** Write one audit row. Never throws. */
export async function audit({ ownerId, companyId }, action, targetStoreId = null, metadata = null) {
  try {
    const { error } = await db().from('b2b_owner_audit').insert({
      owner_id: ownerId ?? null, company_id: companyId ?? null, action, target_store_id: targetStoreId, metadata,
    })
    if (error) throw error
  } catch (err) {
    console.warn('[Atelier] owner audit failed:', err?.message)
  }
}
const auditCtx = (ctx) => ({ ownerId: ctx.owner.owner_id, companyId: ctx.company.company_id })

function limit(name, key, n, windowMs = WINDOW_MS) {
  if (!allow(name, key, n, windowMs)) throw new OwnerError(429, 'too_many', TOO_MANY)
}

// ── One-time codes ───────────────────────────────────────────────────────────

const otpHash = (email, purpose, code) => keyedHash('otp', `${email}:${purpose}:${code}`)

async function issueCode(companyId, email, purpose) {
  const supabase = db()
  const now = new Date()
  // One active code per email: a new one voids the others.
  check((await supabase.from('b2b_owner_otps').update({ consumed_at: now.toISOString() })
    .eq('email', email).eq('purpose', purpose).is('consumed_at', null)).error)
  const code = newOtp()
  const { data: row, error } = await supabase.from('b2b_owner_otps').insert({
    company_id: companyId, email, purpose, code_hash: otpHash(email, purpose, code),
    expires_at: new Date(now.getTime() + OTP_TTL_MS).toISOString(),
  }).select('id').single()
  check(error)

  const reset = purpose === 'reset'
  const sent = await sendEmail({
    to: email,
    subject: reset ? 'Your Atelier password reset code' : 'Your Atelier verification code',
    body: `Your code is ${code}. It expires in 10 minutes.\n\n` +
      (reset ? 'Use it to set a new password for your Atelier owner account.' : 'Use it to activate your Atelier owner account.') +
      '\n\nIf you didn’t ask for this, you can ignore this email — nothing changes without the code.',
  })
  // Test mode (email not set up yet — lib/email.mjs emailBypass): the app shows the code.
  const testCode = sent.status === 'skipped' && emailBypass() ? code : undefined
  if (sent.status === 'failed' || (sent.status === 'skipped' && process.env.NODE_ENV === 'production' && !testCode)) {
    await supabase.from('b2b_owner_otps').update({ consumed_at: new Date().toISOString() }).eq('id', row.id)
    console.error('[Atelier] owner code email not sent:', sent.error)
    throw new OwnerError(503, 'email_failed', 'We couldn’t send the code right now. Try again in a few minutes.')
  }
  if (testCode) console.warn(`[Atelier] owner portal TEST MODE: ${purpose} code for ${maskEmail(email)} shown in the app (email not set up)`)
  return {
    maskedEmail: maskEmail(email), resendInSec: RESEND_COOLDOWN_MS / 1000, expiresInSec: OTP_TTL_MS / 1000,
    ...(testCode ? { testCode } : {}),
  }
}

/**
 * Screen A (activation) and Forgot password: check code + email, then email a code.
 * @param {{ code: string, email: string, purpose: 'activation'|'reset', ip: string }} p
 */
export async function startVerification({ code, email, purpose, ip }) {
  const e = normEmail(email)
  const c = normCode(code)
  if (!isEmail(e) || !c) throw new OwnerError(400, 'mismatch', MISMATCH)
  limit('owner-verify-ip', ip, 20)
  limit('owner-verify-email', e, 5)

  const company = await companyForCodeAndEmail(c, e)
  if (!company) throw new OwnerError(400, 'mismatch', MISMATCH)
  if (company.status === 'inactive') throw new OwnerError(403, 'company_inactive', PAUSED)
  let owner = await ownerForCompany(company.company_id)
  if (owner?.status === 'blocked') throw new OwnerError(403, 'owner_blocked', BLOCKED)
  if (purpose === 'activation' && owner?.activated_at) {
    throw new OwnerError(409, 'already_active', 'This account is already active. Log in instead.')
  }
  if (purpose === 'reset' && !owner?.activated_at) {
    throw new OwnerError(409, 'not_activated', NOT_ACTIVE)
  }
  if (await isStoreLogin(e)) {
    throw new OwnerError(409, 'store_login', 'This email is used as a store login, so it can’t also be the owner login. Ask Atelier support to change the owner email.')
  }

  const supabase = db()
  if (!owner) {
    const { error } = await supabase.from('b2b_owners').insert({
      company_id: company.company_id, email: e,
      name: company.primary_contact_name || null, phone: company.primary_contact || null,
      notify_prefs: prefsOf(null),
    })
    if (error && error.code !== '23505') check(error) // 23505: created by a parallel request
  } else if (!owner.activated_at && owner.email !== e) {
    check((await supabase.from('b2b_owners').update({ email: e, updated_at: new Date().toISOString() }).eq('owner_id', owner.owner_id)).error)
  }
  return issueCode(company.company_id, e, purpose)
}

/** Screen B: "Resend code" (60 s apart, at most 3 resends per 30 minutes). */
export async function resendCode({ email, purpose, ip }) {
  const e = normEmail(email)
  if (!isEmail(e) || !['activation', 'reset'].includes(purpose)) throw new OwnerError(400, 'restart', 'Start again — enter your store code and email.')
  limit('owner-resend-ip', ip, 15)
  const since = new Date(Date.now() - 30 * MIN).toISOString()
  const { data: rows, error } = await db().from('b2b_owner_otps')
    .select('id, company_id, created_at, token_hash').eq('email', e).eq('purpose', purpose)
    .gte('created_at', since).order('created_at', { ascending: false }).limit(10)
  check(error)
  const latest = rows?.[0]
  if (!latest || latest.token_hash) throw new OwnerError(410, 'restart', 'Start again — enter your store code and email.')
  const wait = RESEND_COOLDOWN_MS - (Date.now() - Date.parse(latest.created_at))
  if (wait > 0) throw new OwnerError(429, 'cooldown', 'Wait a moment before asking for another code.', { retryInSec: Math.ceil(wait / 1000) })
  if (rows.length >= 1 + MAX_RESENDS) {
    throw new OwnerError(429, 'too_many_resends', 'You’ve asked for too many codes. Try again in 30 minutes.')
  }
  const owner = await ownerForCompany(latest.company_id)
  if (purpose === 'activation' && owner?.activated_at) throw new OwnerError(409, 'already_active', 'This account is already active. Log in instead.')
  return issueCode(latest.company_id, e, purpose)
}

/** Screen B: check the 6-digit code → a 15-minute token for Screen C. */
export async function confirmCode({ email, code, purpose, ip }) {
  const e = normEmail(email)
  const c = String(code ?? '').replace(/\D/g, '')
  if (!isEmail(e) || !['activation', 'reset'].includes(purpose)) throw new OwnerError(400, 'restart', 'Start again — enter your store code and email.')
  limit('owner-confirm-ip', ip, 40)
  limit('owner-confirm-email', e, 15)

  const supabase = db()
  const since = new Date(Date.now() - 30 * MIN).toISOString()
  const { data: rows, error } = await supabase.from('b2b_owner_otps')
    .select('id, code_hash, expires_at, attempts, consumed_at, token_hash, created_at').eq('email', e).eq('purpose', purpose)
    .gte('created_at', since).order('created_at', { ascending: false }).limit(10)
  check(error)
  const live = (rows ?? []).find((r) => !r.consumed_at)
  const expired = () => new OwnerError(410, 'expired', 'This code has expired. Send a new one.')
  if (!live) throw expired()
  if (Date.parse(live.expires_at) <= Date.now()) {
    await supabase.from('b2b_owner_otps').update({ consumed_at: new Date().toISOString() }).eq('id', live.id)
    throw expired()
  }
  const hash = /^\d{6}$/.test(c) ? otpHash(e, purpose, c) : null
  if (!hash || !sameSecret(hash, live.code_hash)) {
    // A code from an older email (replaced by a resend) is reported as expired.
    if (hash && (rows ?? []).some((r) => r.id !== live.id && sameSecret(hash, r.code_hash))) throw expired()
    const attempts = live.attempts + 1
    const left = OTP_MAX_ATTEMPTS - attempts
    await supabase.from('b2b_owner_otps').update({
      attempts, ...(left <= 0 ? { consumed_at: new Date().toISOString() } : {}),
    }).eq('id', live.id)
    if (left <= 0) throw new OwnerError(400, 'too_many_tries', 'That code isn’t right, and it can’t be used again. Send a new one.')
    throw new OwnerError(400, 'wrong_code', `That code isn’t right. ${left} attempt${left === 1 ? '' : 's'} left.`, { attemptsLeft: left })
  }
  const token = newSecret()
  const { data: used, error: uErr } = await supabase.from('b2b_owner_otps').update({
    consumed_at: new Date().toISOString(), token_hash: keyedHash('token', token),
    token_expires_at: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
  }).eq('id', live.id).is('consumed_at', null).select('id')
  check(uErr)
  if (!used?.length) throw expired()
  return { token, expiresInSec: TOKEN_TTL_MS / 1000 }
}

async function tokenRow(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null
  const { data, error } = await db().from('b2b_owner_otps').select('*')
    .eq('token_hash', keyedHash('token', token)).maybeSingle()
  check(error)
  return data ?? null
}

/** Screen C, checked when the tab regains focus: is this token still usable? */
export async function tokenStatus(token) {
  const row = await tokenRow(token)
  if (!row || row.token_used_at || Date.parse(row.token_expires_at) <= Date.now()) {
    const owner = row ? await ownerForCompany(row.company_id) : null
    if (row?.purpose === 'activation' && owner?.activated_at) return { valid: false, reason: 'already_active' }
    return { valid: false, reason: 'token_expired' }
  }
  if (row.purpose === 'activation') {
    const owner = await ownerForCompany(row.company_id)
    if (owner?.activated_at) return { valid: false, reason: 'already_active' }
  }
  return { valid: true, purpose: row.purpose }
}

// ── Supabase sessions ────────────────────────────────────────────────────────

const claimsOf = (accessToken) => {
  try {
    return JSON.parse(Buffer.from(String(accessToken).split('.')[1], 'base64url').toString('utf8'))
  } catch {
    return {}
  }
}

/** A Supabase session for this email + password, or null. */
async function passwordSession(email, password) {
  const client = passwordAuthClient()
  if (!client) throw new OwnerError(503, 'no_database', 'The owner portal is not available right now.')
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error || !data?.session) return null
  return data.session
}

/** End one Supabase session (e.g. the one a password check opened). */
async function endAuthSession(userId, sessionId) {
  if (!userId || !sessionId) return
  const { error } = await db().rpc('owner_revoke_auth_sessions', { p_user_id: userId, p_keep: null, p_only: sessionId })
  if (error) console.warn('[Atelier] ending a check session failed:', error.message)
}

/** True when the password is the owner's current one (the check session is ended at once). */
async function passwordIsCurrent(email, password, userId) {
  const s = await passwordSession(email, password)
  if (!s) return false
  await endAuthSession(userId ?? s.user?.id, claimsOf(s.access_token).session_id)
  return true
}

/**
 * Record a Supabase session as an owner session and return what the app needs
 * to adopt it (supabase.auth.setSession). New browser → "New sign-in" alert.
 */
async function startOwnerSession(owner, session, { remember, userAgent, ip, alertNewDevice }) {
  const sid = claimsOf(session.access_token).session_id
  if (!sid) throw new Error('owner sign-in: the Supabase token has no session_id')
  const supabase = db()
  const device = describeUserAgent(userAgent)
  let known = true
  if (alertNewDevice) {
    const { data: prior } = await supabase.from('b2b_owner_sessions').select('user_agent')
      .eq('owner_id', owner.owner_id).order('created_at', { ascending: false }).limit(50)
    known = !prior?.length || prior.some((p) => describeUserAgent(p.user_agent) === device)
  }
  const expiresAt = new Date(Date.now() + (remember ? SESSION_LONG_MS : SESSION_SHORT_MS)).toISOString()
  check((await supabase.from('b2b_owner_sessions').insert({
    session_id: sid, owner_id: owner.owner_id, user_id: session.user.id, remember: !!remember,
    expires_at: expiresAt, user_agent: userAgent ? String(userAgent).slice(0, 400) : null, ip: ip ? String(ip).slice(0, 64) : null,
  })).error)
  if (!known) {
    notifyOwner({
      companyId: owner.company_id, category: 'account', critical: true,
      title: 'New sign-in to your owner account',
      body: `New sign-in from ${device}. If this wasn’t you, change your password in Profile → Security.`,
      link: { screen: 'profile', section: 'security' },
    })
  }
  return {
    accessToken: session.access_token, refreshToken: session.refresh_token,
    expiresAt: session.expires_at, sessionExpiresAt: expiresAt,
  }
}

/**
 * The owner session behind a Supabase token, or null when it isn't one (never
 * recorded, signed out, past its 24 h / 30 day lifetime, owner not active).
 * Used by lib/identity.mjs (ownerOf).
 */
export async function findOwnerSession(userId, sessionId) {
  const supabase = serviceDb()
  if (!supabase || !userId || !sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) return null
  const { data: row, error } = await supabase.from('b2b_owner_sessions')
    .select('*, b2b_owners(*, b2b_companies(' + COMPANY_COLS + '))').eq('session_id', sessionId).maybeSingle()
  if (error) {
    if (isMissingSchema(error)) return null
    throw error
  }
  if (!row || row.user_id !== userId || row.revoked_at || Date.parse(row.expires_at) <= Date.now()) return null
  const owner = row.b2b_owners
  if (!owner?.activated_at || owner.user_id !== userId || !owner.b2b_companies || owner.status === 'blocked') return null
  if (Date.now() - Date.parse(row.last_seen_at) > 5 * MIN) {
    supabase.from('b2b_owner_sessions').update({ last_seen_at: new Date().toISOString() }).eq('session_id', sessionId)
      .then(({ error: e }) => { if (e) console.warn('[Atelier] owner session touch failed:', e.message) })
  }
  const { b2b_companies: company, ...ownerRow } = owner
  const { b2b_owners: _o, ...session } = row
  return { session, owner: ownerRow, company }
}

// ── Screen C: create / reset the password ────────────────────────────────────

/**
 * Activation: creates (or reuses) the Supabase user, activates the owner and
 * signs them in. Reset: changes the password, ends every other session, signs in.
 */
export async function setPassword({ token, password, userAgent, ip }) {
  limit('owner-password-ip', ip, 20)
  const row = await tokenRow(token)
  const expired = new OwnerError(410, 'token_expired', 'Your session expired. Verify again.')
  if (!row || Date.parse(row.token_expires_at ?? 0) <= Date.now()) throw expired
  const company = (await db().from('b2b_companies').select(COMPANY_COLS).eq('company_id', row.company_id).maybeSingle()).data
  const owner = await ownerForCompany(row.company_id)
  if (!company || !owner) throw expired
  if (row.purpose === 'activation' && owner.activated_at) {
    throw new OwnerError(409, 'already_active', 'Your account is already active. Log in instead.')
  }
  if (row.token_used_at) throw expired
  const problems = passwordProblems(password)
  if (problems.length) throw new OwnerError(400, 'weak_password', 'Choose a stronger password.', { problems })
  if (row.purpose === 'reset' && (!owner.activated_at || !owner.user_id)) throw new OwnerError(409, 'not_activated', NOT_ACTIVE)
  if (row.purpose === 'reset' && await passwordIsCurrent(owner.email, password, owner.user_id)) {
    throw new OwnerError(400, 'same_password', 'Your new password can’t be the same as your current one.')
  }

  const supabase = db()
  // Use the token exactly once, even with two tabs submitting together.
  const { data: claimed, error: cErr } = await supabase.from('b2b_owner_otps')
    .update({ token_used_at: new Date().toISOString() }).eq('id', row.id).is('token_used_at', null).select('id')
  check(cErr)
  if (!claimed?.length) {
    const again = await ownerForCompany(row.company_id)
    if (row.purpose === 'activation' && again?.activated_at) throw new OwnerError(409, 'already_active', 'Your account is already active. Log in instead.')
    throw expired
  }
  const release = () => supabase.from('b2b_owner_otps').update({ token_used_at: null }).eq('id', row.id)

  if (row.purpose === 'activation') {
    let userId
    try {
      const { data: existing, error: eErr } = await supabase.rpc('owner_auth_user_for_email', { p_email: row.email })
      check(eErr)
      if (existing) {
        const { error } = await supabase.auth.admin.updateUserById(existing, { password, email_confirm: true })
        if (error) throw error
        userId = existing
      } else {
        const { data, error } = await supabase.auth.admin.createUser({
          email: row.email, password, email_confirm: true, user_metadata: { name: owner.name || company.primary_contact_name || '' },
        })
        if (error) throw error
        userId = data.user.id
      }
      const { error: oErr } = await supabase.from('b2b_owners').update({
        user_id: userId, email: row.email, activated_at: new Date().toISOString(), email_verified_at: new Date().toISOString(),
        failed_logins: 0, failed_login_since: null, locked_until: null, updated_at: new Date().toISOString(),
      }).eq('owner_id', owner.owner_id)
      if (oErr?.code === '23505') throw new OwnerError(409, 'email_in_use', 'This email already owns another organization on Atelier — contact Atelier support.')
      check(oErr)
    } catch (err) {
      await release()
      throw err
    }
    await audit({ ownerId: owner.owner_id, companyId: owner.company_id }, 'account_activated')
    const name = company.brand_name || company.company_name
    sendEmail({
      to: row.email, subject: 'Your Atelier owner account is active',
      body: `Your owner account for ${name} is active. Sign in with ${row.email} and the password you just created.\n\n` +
        'From the owner portal you can invite your stores and follow their devices, credits and payments.',
    }).then((r) => { if (r.status === 'failed') console.warn('[Atelier] activation email failed:', r.error) })
    notifyOwner({
      companyId: owner.company_id, category: 'account', noEmail: true,
      title: 'Your owner account is active', body: `Welcome to Atelier. Invite your first store from Add Store.`,
      link: { screen: 'add-store' },
    })
  } else {
    try {
      const { error } = await supabase.auth.admin.updateUserById(owner.user_id, { password })
      if (error) throw error
    } catch (err) {
      await release()
      throw err
    }
    await supabase.rpc('owner_revoke_auth_sessions', { p_user_id: owner.user_id, p_keep: null, p_only: null })
    await supabase.from('b2b_owner_sessions').update({ revoked_at: new Date().toISOString() })
      .eq('owner_id', owner.owner_id).is('revoked_at', null)
    await supabase.from('b2b_owners').update({
      failed_logins: 0, failed_login_since: null, locked_until: null, updated_at: new Date().toISOString(),
    }).eq('owner_id', owner.owner_id)
    await audit({ ownerId: owner.owner_id, companyId: owner.company_id }, 'password_reset')
    notifyOwner({
      companyId: owner.company_id, category: 'account', critical: true,
      title: 'Your password was changed',
      body: 'Your Atelier owner password was changed and every other device was signed out. If this wasn’t you, contact Atelier support right away.',
      link: { screen: 'profile', section: 'security' },
    })
  }

  const fresh = await ownerForCompany(row.company_id)
  const session = await passwordSession(fresh.email, password)
  if (!session) throw new OwnerError(502, 'sign_in_failed', 'Your password is set, but signing in failed. Log in with your new password.')
  return { session: await startOwnerSession(fresh, session, { remember: false, userAgent, ip, alertNewDevice: false }) }
}

// ── Owner login / logout ─────────────────────────────────────────────────────

export async function login({ email, password, remember, userAgent, ip }) {
  const e = normEmail(email)
  if (!isEmail(e) || typeof password !== 'string' || !password) throw new OwnerError(401, 'bad_credentials', BAD_LOGIN)
  limit('owner-login-ip', ip, 30)
  const company = await companyForEmail(e)
  if (!company) throw new OwnerError(401, 'bad_credentials', BAD_LOGIN)
  const owner = await ownerForCompany(company.company_id)
  if (!owner?.activated_at || !owner.user_id) throw new OwnerError(403, 'not_activated', NOT_ACTIVE)
  if (company.status === 'inactive') throw new OwnerError(403, 'company_inactive', PAUSED)
  if (owner.status === 'blocked') throw new OwnerError(403, 'owner_blocked', BLOCKED)
  if (owner.locked_until && Date.parse(owner.locked_until) > Date.now()) {
    throw new OwnerError(429, 'locked', TOO_MANY, { retryInSec: Math.ceil((Date.parse(owner.locked_until) - Date.now()) / 1000) })
  }

  const supabase = db()
  const session = await passwordSession(owner.email, password)
  if (!session || session.user?.id !== owner.user_id) {
    if (session) await endAuthSession(session.user?.id, claimsOf(session.access_token).session_id)
    const inWindow = owner.failed_login_since && Date.now() - Date.parse(owner.failed_login_since) < WINDOW_MS
    const count = (inWindow ? owner.failed_logins : 0) + 1
    const locks = count >= LOGIN_MAX_FAILS
    await supabase.from('b2b_owners').update(locks
      ? { failed_logins: 0, failed_login_since: null, locked_until: new Date(Date.now() + LOCK_MS).toISOString() }
      : { failed_logins: count, failed_login_since: inWindow ? owner.failed_login_since : new Date().toISOString() },
    ).eq('owner_id', owner.owner_id)
    if (locks) {
      notifyOwner({
        companyId: owner.company_id, category: 'account', critical: true,
        title: 'Sign-in to your owner account was locked',
        body: 'We locked sign-in to your Atelier owner account for 15 minutes after 5 wrong passwords. If this wasn’t you, reset your password from the sign-in page.',
        link: { screen: 'profile', section: 'security' },
      })
      throw new OwnerError(429, 'locked', TOO_MANY, { retryInSec: LOCK_MS / 1000 })
    }
    throw new OwnerError(401, 'bad_credentials', BAD_LOGIN)
  }
  await supabase.from('b2b_owners').update({
    failed_logins: 0, failed_login_since: null, locked_until: null, last_login_at: new Date().toISOString(),
  }).eq('owner_id', owner.owner_id)
  return { session: await startOwnerSession(owner, session, { remember, userAgent, ip, alertNewDevice: true }) }
}

export async function logout(ctx) {
  const supabase = db()
  await supabase.from('b2b_owner_sessions').update({ revoked_at: new Date().toISOString() }).eq('session_id', ctx.session.session_id)
  await endAuthSession(ctx.user.id, ctx.session.session_id)
}

// ── Profile ──────────────────────────────────────────────────────────────────

export async function getProfile(ctx) {
  const { count, error } = await db().from('b2b_stores').select('store_id', { count: 'exact', head: true })
    .eq('company_id', ctx.company.company_id)
  check(error)
  const o = ctx.owner
  const c = ctx.company
  return {
    owner: { id: o.owner_id, name: o.name ?? '', email: o.email, phone: o.phone ?? '', activatedAt: o.activated_at },
    organization: {
      id: c.company_id, name: c.brand_name || c.company_name, legalName: c.company_name,
      logoUrl: c.logo_url ?? null, code: c.company_code,
    },
    totalStores: count ?? 0,
    notifyPrefs: prefsOf(o.notify_prefs),
  }
}

export async function updateProfile(ctx, { name, phone, notifyPrefs }) {
  const patch = {}
  if (name !== undefined) {
    const n = String(name ?? '').trim()
    if (n.length < 1 || n.length > 80) throw new OwnerError(400, 'bad_name', 'Enter your name (up to 80 characters).', { field: 'name' })
    patch.name = n
  }
  if (phone !== undefined) {
    const p = String(phone ?? '').trim()
    if (p && !/^\+?[0-9 ()-]{6,20}$/.test(p)) throw new OwnerError(400, 'bad_phone', 'Enter a valid phone number.', { field: 'phone' })
    patch.phone = p || null
  }
  if (notifyPrefs !== undefined) patch.notify_prefs = cleanPrefs(notifyPrefs, ctx.owner.notify_prefs)
  if (!Object.keys(patch).length) return getProfile(ctx)
  patch.updated_at = new Date().toISOString()
  const { data, error } = await db().from('b2b_owners').update(patch).eq('owner_id', ctx.owner.owner_id).select('*').single()
  check(error)
  if (patch.name !== undefined || patch.phone !== undefined) await audit(auditCtx(ctx), 'profile_updated', null, { name: patch.name, phone: patch.phone })
  return getProfile({ ...ctx, owner: data })
}

/** Profile → Security → Change password. Ends every other session. */
export async function changePassword(ctx, { current, next }) {
  limit('owner-change-password', ctx.owner.owner_id, 5)
  if (typeof current !== 'string' || !current) throw new OwnerError(400, 'wrong_password', 'Enter your current password.', { field: 'current' })
  const problems = passwordProblems(next)
  if (problems.length) throw new OwnerError(400, 'weak_password', 'Choose a stronger password.', { problems, field: 'next' })
  if (current === next) throw new OwnerError(400, 'same_password', 'Your new password can’t be the same as your current one.', { field: 'next' })
  if (!await passwordIsCurrent(ctx.owner.email, current, ctx.user.id)) {
    throw new OwnerError(400, 'wrong_password', 'Your current password is incorrect.', { field: 'current' })
  }
  const supabase = db()
  const { error } = await supabase.auth.admin.updateUserById(ctx.user.id, { password: next })
  if (error) throw error
  await revokeOtherSessions(ctx, { quiet: true })
  await audit(auditCtx(ctx), 'password_changed')
  notifyOwner({
    companyId: ctx.company.company_id, category: 'account', critical: true,
    title: 'Your password was changed',
    body: 'Your Atelier owner password was changed and your other devices were signed out. If this wasn’t you, contact Atelier support right away.',
    link: { screen: 'profile', section: 'security' },
  })
}

export async function listSessions(ctx) {
  const { data, error } = await db().from('b2b_owner_sessions').select('*')
    .eq('owner_id', ctx.owner.owner_id).is('revoked_at', null).gt('expires_at', new Date().toISOString())
    .order('last_seen_at', { ascending: false }).limit(50)
  check(error)
  return (data ?? []).map((s) => ({
    id: s.session_id, device: describeUserAgent(s.user_agent), createdAt: s.created_at,
    lastActiveAt: s.last_seen_at, expiresAt: s.expires_at, remember: s.remember,
    current: s.session_id === ctx.session.session_id,
  }))
}

/** "Sign out of all other devices". */
export async function revokeOtherSessions(ctx, { quiet = false } = {}) {
  const supabase = db()
  const { error } = await supabase.rpc('owner_revoke_auth_sessions', {
    p_user_id: ctx.user.id, p_keep: ctx.session.session_id, p_only: null,
  })
  check(error)
  check((await supabase.from('b2b_owner_sessions').update({ revoked_at: new Date().toISOString() })
    .eq('owner_id', ctx.owner.owner_id).neq('session_id', ctx.session.session_id).is('revoked_at', null)).error)
  if (!quiet) await audit(auditCtx(ctx), 'sessions_revoked')
}
