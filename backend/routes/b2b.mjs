import express from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { cashfreeMode } from '../lib/cashfree.mjs'
import { touchDevice, logAppEvent, getSettings, latestTabletNotice } from '../lib/clients.mjs'
import { BillingError, billingOverview, createB2BOrder, verifyAndApplyB2BOrder } from '../lib/b2bBilling.mjs'
import { ATELIER_BUSY_MESSAGE } from '../lib/fallbacks.mjs'
import { serviceDb } from '../lib/db.mjs'
import { callerOf } from '../lib/identity.mjs'

// The B2B store app: session/heartbeat, admin notices, Plan & Credits billing,
// the hosted checkout pages for the iPad, and the B2B Terms page.
const router = express.Router()
export default router
const LEGAL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'legal')

// ---------------------------------------------------------------------------
// POST /api/b2b/session — the store app calls this when it opens (and as a
// heartbeat while in use). Registers the iPad, logs device_session_started,
// and returns what the app needs that isn't readable through RLS.
// ---------------------------------------------------------------------------
router.post('/api/b2b/session', async (req, res) => {
  const { user, store: company, storeError } = await callerOf(req)
  if (!user) return res.status(401).json({ error: 'Sign in again.' })
  if (storeError) {
    console.error('[Atelier] /api/b2b/session: company lookup failed:', storeError.message)
    return res.status(503).json({ error: ATELIER_BUSY_MESSAGE })
  }
  if (!company) return res.status(403).json({ error: 'Not a company account.' })

  const { deviceKey, deviceName, platform, appVersion, heartbeat } = req.body || {}
  const key = typeof deviceKey === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(deviceKey) ? deviceKey : null
  let device = null
  if (key) {
    try {
      device = await touchDevice(company.clientId, key, {
        userId: user.id,
        name: typeof deviceName === 'string' ? deviceName.slice(0, 80) : null,
        platform: typeof platform === 'string' ? platform.slice(0, 40) : null,
        appVersion: typeof appVersion === 'string' ? appVersion.slice(0, 40) : null,
      })
    } catch (err) {
      console.warn('[Atelier] /api/b2b/session: device upsert failed:', err.message)
    }
  }
  if (!heartbeat) {
    logAppEvent({
      event: 'device_session_started', userId: user.id, clientId: company.clientId,
      companyId: company.companyId, deviceId: device?.id, metadata: { platform, appVersion, newDevice: !!device?.isNew },
    })
  }

  const [settings, notice] = await Promise.all([getSettings(), latestTabletNotice(company.clientId)])
  return res.json({
    device: device ? { id: device.id, storeId: device.storeId, name: device.name, status: device.status } : null,
    signOut: device?.status === 'sign_out_requested',
    settings: {
      lowCreditPct: Number(settings.b2b_low_credit_pct) || 20,
      graceDays: Number(settings.b2b_grace_days) || 7,
    },
    notice: notice
      ? { id: notice.id, template: notice.template, subject: notice.subject, body: notice.body, linkUrl: notice.link_url, sentAt: notice.sent_at }
      : null,
  })
})

// POST /api/b2b/notice/:id/dismiss — staff closed a tablet message.
router.post('/api/b2b/notice/:id/dismiss', async (req, res) => {
  const { user, store: company } = await callerOf(req)
  if (!user) return res.status(401).json({ error: 'Sign in again.' })
  const db = serviceDb()
  if (!company || !db) return res.status(403).json({ error: 'Not a company account.' })
  const now = new Date().toISOString()
  const { error } = await db.from('notifications')
    .update({ dismissed_at: now, opened_at: now })
    .eq('id', req.params.id).eq('recipient_type', 'b2b_store').eq('recipient_id', company.clientId)
  if (error) return res.status(500).json({ error: error.message })
  return res.json({ ok: true })
})

// ---------------------------------------------------------------------------
// B2B payments (Cashfree) — a store buys a plan or a credit top-up in the app.
// Rules + trust model: lib/b2bBilling.mjs and supabase/migrations/b2b-payments.sql.
// ---------------------------------------------------------------------------

// The signed-in store, or a response has been sent.
async function requireStore(req, res) {
  const { user, store: company } = await callerOf(req)
  if (!user) {
    res.status(401).json({ error: 'Sign in again.' })
    return null
  }
  if (!company) {
    res.status(403).json({ error: 'Not a company account.' })
    return null
  }
  return { user, storeId: company.clientId }
}

// Public base URL of this API (checkout return page, built-in Terms page).
const publicApiBase = (req) => process.env.API_PUBLIC_URL || `${req.protocol}://${req.get('host')}`

function billingFailed(res, err, what) {
  if (err instanceof BillingError) return res.status(err.status).json({ error: err.message, code: err.code })
  console.error(`[Atelier] ${what} failed:`, err?.message, err?.body ?? '')
  return res.status(502).json({ error: 'Something went wrong with the payment service. Please try again.' })
}

// GET /api/b2b/billing — plans, top-up packs, what this store may buy, Terms, history.
router.get('/api/b2b/billing', async (req, res) => {
  const who = await requireStore(req, res)
  if (!who) return
  try {
    return res.json(await billingOverview(who.storeId, { apiBase: publicApiBase(req) }))
  } catch (err) {
    return billingFailed(res, err, 'b2b billing overview')
  }
})

// POST /api/b2b/payments  { kind: 'plan'|'topup', itemId, acceptTerms, termsVersion, platform }
router.post('/api/b2b/payments', async (req, res) => {
  const who = await requireStore(req, res)
  if (!who) return
  const { kind, itemId, acceptTerms, termsVersion, platform } = req.body || {}
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  try {
    const order = await createB2BOrder({
      user: who.user, storeId: who.storeId, kind, itemId, acceptTerms, termsVersion,
      platform: platform === 'web' ? 'web' : 'native',
      apiBase: publicApiBase(req),
      appBase: process.env.APP_PUBLIC_URL || req.headers.origin || 'http://localhost:8081',
      ip: fwd[fwd.length - 1] || req.socket?.remoteAddress,
      userAgent: req.headers['user-agent'],
    })
    return res.json(order)
  } catch (err) {
    return billingFailed(res, err, 'b2b create order')
  }
})

// GET /api/b2b/payments/:orderId — verify with Cashfree and apply if paid.
router.get('/api/b2b/payments/:orderId', async (req, res) => {
  const who = await requireStore(req, res)
  if (!who) return
  try {
    return res.json(await verifyAndApplyB2BOrder(req.params.orderId, { storeId: who.storeId }))
  } catch (err) {
    return billingFailed(res, err, 'b2b payment status')
  }
})

// Hosted checkout for the native iPad app, opened in an in-app browser: loads
// Cashfree's web SDK for a server-created session, and Cashfree returns to
// /pay/b2b/return, which hands control back to the app (atelier:// link).
const SAFE_TOKEN = /^[A-Za-z0-9_\-.=]{8,400}$/
function payPage(res, title, body) {
  res.set({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  })
  return res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>body{font-family:system-ui,sans-serif;background:#f6f3ee;color:#2b2622;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px;text-align:center}a{color:#4a3f35;font-weight:600}</style></head><body>${body}</body></html>`)
}

// B2B Terms & Conditions of Payment (used when B2B_TERMS_URL is not set).
const B2B_TERMS_HTML = fs.readFileSync(path.join(LEGAL_DIR, 'b2b-terms.html'), 'utf8')
router.get('/legal/b2b-terms', (_req, res) => {
  res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' })
  return res.send(B2B_TERMS_HTML)
})

router.get('/pay/b2b/checkout', (req, res) => {
  const session = String(req.query.session ?? '')
  if (!SAFE_TOKEN.test(session)) return payPage(res, 'Payment', '<p>This payment link is invalid. Please start again from the app.</p>')
  const mode = cashfreeMode()
  return payPage(res, 'Atelier — Payment', `<p id="msg">Opening secure payment…</p>
<script src="https://sdk.cashfree.com/js/v3/cashfree.js"></script>
<script>
  try {
    Cashfree({ mode: ${JSON.stringify(mode)} }).checkout({ paymentSessionId: ${JSON.stringify(session)}, redirectTarget: '_self' })
  } catch (e) {
    document.getElementById('msg').textContent = 'Could not open the payment page. Please go back to the app and try again.'
  }
</script>`)
})

router.get('/pay/b2b/return', (req, res) => {
  const orderId = String(req.query.order_id ?? '')
  const safe = /^b2b_[A-Za-z0-9_]{1,80}$/.test(orderId) ? orderId : ''
  const back = `atelier://store/plan${safe ? `?order_id=${encodeURIComponent(safe)}` : ''}`
  return payPage(res, 'Atelier — Payment', `<div><p>Payment submitted — returning to Atelier…</p>
<p><a href="${back}">Return to the app</a></p></div>
<script>location.replace(${JSON.stringify(back)})</script>`)
})
