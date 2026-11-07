import express from 'express'
import { getCreditStatus } from '../lib/credits.mjs'
import { getMembership, membershipEnabled } from '../lib/membership.mjs'
import { logAppEvent } from '../lib/clients.mjs'
import { serviceDb } from '../lib/db.mjs'
import { callerOf } from '../lib/identity.mjs'

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
// Unknown emails answer 'personal' (no "does this account exist?" leak); the
// answer only decides which fields are shown — routing after sign-in still
// uses the signed-in account (store_for_user). Rate-limited per IP.
// ---------------------------------------------------------------------------
const ACCOUNT_TYPE_LIMIT = 30 // lookups per IP per 10 minutes
const accountTypeHits = new Map()
router.post('/api/auth/account-type', async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Enter a valid email.' })
  }
  // Behind the reverse proxy (Caddy): the right-most X-Forwarded-For entry is the
  // one the proxy added (the caller can't forge it); otherwise every user shares one IP.
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const ip = fwd[fwd.length - 1] || req.socket?.remoteAddress || 'unknown'
  const now = Date.now()
  const hits = (accountTypeHits.get(ip) ?? []).filter((t) => now - t < 10 * 60_000)
  if (hits.length >= ACCOUNT_TYPE_LIMIT) return res.status(429).json({ error: 'Too many attempts — try again in a few minutes.' })
  hits.push(now)
  accountTypeHits.set(ip, hits)
  if (accountTypeHits.size > 10_000) accountTypeHits.clear() // keep memory bounded

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

router.post('/api/account/delete', async (req, res) => {
  const { user, store: company, storeError } = await callerOf(req)
  if (!user) return res.status(401).json({ error: 'Sign in again to delete your account.' })
  const db = serviceDb()
  if (!db) return res.status(503).json({ error: 'Account deletion is not available right now.' })
  if (storeError) return res.status(503).json({ error: 'Account deletion is not available right now.' })
  if (company) return res.status(403).json({ error: 'Company logins are managed by Atelier — contact support.' })
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
