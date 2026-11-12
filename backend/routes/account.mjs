import express from 'express'
import { getCreditStatus } from '../lib/credits.mjs'
import { getMembership, membershipEnabled } from '../lib/membership.mjs'
import { logAppEvent } from '../lib/clients.mjs'
import { serviceDb, isMissingSchema } from '../lib/db.mjs'
import { callerOf } from '../lib/identity.mjs'
import { allow, clientIp } from '../lib/rateLimit.mjs'
import { sendEmail } from '../lib/email.mjs'

// Accounts: embed-partner credit status, B2C membership, sign-in helpers,
// account deletion, and lifecycle events the app reports.
const router = express.Router()
export default router

// ---------------------------------------------------------------------------
// GET /api/credits
// ---------------------------------------------------------------------------
router.get('/api/credits', async (req, res) => {
  const { companyId, userId, guestId, referrerOrigin } = req.query
  try {
    const status = await getCreditStatus({
      companyId: companyId ?? null,
      userId: userId ?? null,
      guestId: guestId ?? null,
      referrerOrigin: referrerOrigin ?? null,
    })
    return res.json(status)
  } catch (err) {
    console.error('[Atelier] Credit status failed:', err.message)
    return res.status(500).json({ enabled: true, error: err.message })
  }
})

// ---------------------------------------------------------------------------
// Membership (consumer free/premium tier) — requires a Supabase auth token
// ---------------------------------------------------------------------------

// GET /api/membership — current user's plan + remaining free try-ons
router.get('/api/membership', async (req, res) => {
  if (!membershipEnabled()) {
    return res.json({ enabled: false, plan: 'premium', tryonUsed: 0, tryonLimit: -1, remaining: null })
  }
  const { user } = await callerOf(req)
  if (!user) return res.status(401).json({ error: 'Sign in to view your membership.' })
  try {
    const membership = await getMembership(user.id)
    return res.json({ enabled: true, ...membership })
  } catch (err) {
    console.error('[Atelier] Membership fetch failed:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

// NOTE: the old mock POST /api/membership/upgrade (instant free "premium") and
// POST /api/membership/cancel were removed with the ₹499 plan. Credits are now
// only ever added by the Cashfree-verified /api/payments flow below.

// ---------------------------------------------------------------------------
// POST /api/events — lifecycle events the server can't see itself (spec §6):
// the app writes customer folders straight to Supabase, so it reports them here.
// ---------------------------------------------------------------------------
const CLIENT_EVENTS = {
  b2b: new Set(['customer_captured', 'garment_selected', 'result_saved', 'result_shared']),
  b2c: new Set(['profile_completed', 'garment_added', 'paywall_viewed']),
}

router.post('/api/events', async (req, res) => {
  const { event, folderId, metadata } = req.body || {}
  const { user, store: company, device } = await callerOf(req)
  const channel = company ? 'b2b' : 'b2c'
  if (typeof event !== 'string' || !CLIENT_EVENTS[channel].has(event)) {
    return res.status(400).json({ error: `Unknown ${channel} event.` })
  }
  let meta = null
  if (metadata && typeof metadata === 'object' && JSON.stringify(metadata).length <= 2000) meta = metadata
  await logAppEvent({
    event, channel, userId: user?.id, clientId: company?.clientId, companyId: company?.companyId, deviceId: device?.id,
    folderId: typeof folderId === 'string' && /^[0-9a-f-]{36}$/i.test(folderId) ? folderId : null,
    metadata: meta,
  })
  return res.json({ ok: true })
})

// ---------------------------------------------------------------------------
// POST /api/account/delete — B2C "Delete account" (spec §3.2). Removes the
// user's photos and try-on images from Storage, then the auth user; every table
// row (profile, membership, history, purchases, usage) cascades from it.
// Company logins are managed by the Atelier admin and can't delete themselves.
// ---------------------------------------------------------------------------
async function removeUserFolder(db, bucket, userId) {
  for (;;) {
    const { data, error } = await db.storage.from(bucket).list(userId, { limit: 1000 })
    if (error) {
      if (/not found/i.test(error.message)) return
      throw error
    }
    if (!data?.length) return
    const { error: rmErr } = await db.storage.from(bucket).remove(data.map((f) => `${userId}/${f.name}`))
    if (rmErr) throw rmErr
    if (data.length < 1000) return
  }
}

// ---------------------------------------------------------------------------
// POST /api/auth/account-type  { email } → { type: 'company' | 'personal' }
// Lets the sign-in page show the date-of-birth field to personal accounts only.
// The current app no longer calls it (the user picks Personal / Company on the
// sign-in page); it stays for installed builds that still do. Unknown emails answer 'personal' (no "does this account exist?" leak); the
// answer only decides which fields are shown — routing after sign-in still
// uses the signed-in account (store_for_user). Rate-limited per IP.
// ---------------------------------------------------------------------------
const ACCOUNT_TYPE_LIMIT = 30 // lookups per IP per 10 minutes
router.post('/api/auth/account-type', async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Enter a valid email.' })
  }
  if (!allow('account-type', clientIp(req), ACCOUNT_TYPE_LIMIT, 10 * 60_000)) {
    return res.status(429).json({ error: 'Too many attempts — try again in a few minutes.' })
  }

  const db = serviceDb()
  if (!db) return res.json({ type: 'personal' })
  const { data, error } = await db.rpc('account_type_for_email', { p_email: email })
  if (error) {
    // Migration not applied yet → behave like before (no DOB field gating).
    console.warn('[Atelier] account_type_for_email failed:', error.message)
    return res.json({ type: 'personal' })
  }
  return res.json({ type: data === 'company' ? 'company' : 'personal' })
})

// ---------------------------------------------------------------------------
// POST /api/auth/password-reset  { email } → { sent: true, resendInSec }
// "Forgot password" for shoppers and store logins. Supabase makes the one-time
// code (admin generateLink, which sends nothing) and we email it ourselves
// (lib/email.mjs); the app then calls supabase.auth.verifyOtp({ type:
// 'recovery' }) and updateUser({ password }). The answer is the same whether
// or not the email has an account. An organization owner's login is reset only
// through the owner portal (its own codes, session rules and audit), so an
// owner gets an email pointing there instead.
// ---------------------------------------------------------------------------
export const RESET_COOLDOWN_SEC = 60
const RESET_SENT = { sent: true, resendInSec: RESET_COOLDOWN_SEC }
const ilikeExact = (s) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`)

router.post('/api/auth/password-reset', async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Enter a valid email.' })
  }
  if (!allow('pw-reset-ip', clientIp(req), 10, 15 * 60_000) || !allow('pw-reset-email', email, 5, 60 * 60_000)) {
    return res.status(429).json({ error: 'Too many attempts — try again in a few minutes.', code: 'too_many' })
  }
  if (!allow('pw-reset-cooldown', email, 1, RESET_COOLDOWN_SEC * 1000)) {
    return res.status(429).json({ error: 'Wait a moment before asking for another code.', code: 'cooldown', retryInSec: RESET_COOLDOWN_SEC })
  }
  const db = serviceDb()
  if (!db) return res.status(503).json({ error: 'Password reset isn’t available right now.' })

  const failed = (why) => {
    console.error('[Atelier] password reset email not sent:', why)
    return res.status(503).json({ error: 'We couldn’t send the code right now. Try again in a few minutes.', code: 'email_failed' })
  }
  const delivered = (r) => r.status === 'sent' || (r.status === 'skipped' && process.env.NODE_ENV !== 'production')

  try {
    const { data: owner, error: ownerErr } = await db.from('b2b_owners').select('owner_id, activated_at')
      .ilike('email', ilikeExact(email)).limit(1).maybeSingle()
    if (ownerErr && !isMissingSchema(ownerErr)) throw ownerErr
    if (owner?.activated_at) {
      const base = (process.env.APP_PUBLIC_URL || '').replace(/\/$/, '')
      const r = await sendEmail({
        to: email, subject: 'Resetting your Atelier owner password',
        body: 'Someone asked to reset the password for this email on the Atelier sign-in page.\n\n' +
          'This email is an organization owner login, so its password is reset from the owner portal: ' +
          'choose Company › Owner on the sign-in page, then “Forgot password?”. You’ll need your store code.\n\n' +
          'If you didn’t ask for this, you can ignore this email — nothing has changed.',
        link: base ? { url: `${base}/owner/forgot`, label: 'Reset owner password' } : null,
      })
      return delivered(r) ? res.json(RESET_SENT) : failed(r.error)
    }

    const { data, error } = await db.auth.admin.generateLink({ type: 'recovery', email })
    if (error) {
      // No account for this email: answer as if a code went out.
      if (error.code === 'user_not_found' || error.status === 404 || /not found/i.test(error.message ?? '')) return res.json(RESET_SENT)
      throw error
    }
    const code = data?.properties?.email_otp
    if (!code) throw new Error('generateLink returned no email_otp')
    const r = await sendEmail({
      to: email, subject: 'Your Atelier password reset code', code,
      body: `Your code is ${code}. Enter it in Atelier to choose a new password. It works once and expires in 1 hour.\n\n` +
        'If you didn’t ask for this, you can ignore this email — your password stays the same without the code.',
    })
    return delivered(r) ? res.json(RESET_SENT) : failed(r.error)
  } catch (err) {
    console.error('[Atelier] password reset failed:', err?.message)
    return res.status(503).json({ error: 'Password reset isn’t available right now. Try again in a few minutes.' })
  }
})

router.post('/api/account/delete', async (req, res) => {
  const { user, store: company, storeError } = await callerOf(req)
  if (!user) return res.status(401).json({ error: 'Sign in again to delete your account.' })
  const db = serviceDb()
  if (!db) return res.status(503).json({ error: 'Account deletion is not available right now.' })
  if (storeError) return res.status(503).json({ error: 'Account deletion is not available right now.' })
  if (company) return res.status(403).json({ error: 'Company logins are managed by Atelier — contact support.' })
  // An organization owner's login (owner portal) is managed by Atelier too.
  const { data: owner, error: ownerErr } = await db.from('b2b_owners').select('owner_id').eq('user_id', user.id).maybeSingle()
  if (ownerErr && !isMissingSchema(ownerErr)) return res.status(503).json({ error: 'Account deletion is not available right now.' })
  if (owner) return res.status(403).json({ error: 'This email is an organization owner login, which is managed by Atelier — contact support.' })
  try {
    await removeUserFolder(db, 'user-photos', user.id)
    await removeUserFolder(db, 'try-on-results', user.id)
    const { error } = await db.auth.admin.deleteUser(user.id)
    if (error) throw error
    console.info(`[Atelier] account deleted: ${user.id}`)
    return res.json({ ok: true })
  } catch (err) {
    console.error('[Atelier] account delete failed:', err?.message)
    return res.status(500).json({ error: 'Could not delete your account — please try again or contact support.' })
  }
})
