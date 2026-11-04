import express from 'express'
import { cashfreeConfigured } from '../lib/cashfree.mjs'
import { pricingPayload } from '../lib/pricing.mjs'
import { getMembership } from '../lib/membership.mjs'
import { BillingError } from '../lib/b2bBilling.mjs'
import { creditPack, handleWebhook } from '../lib/payments.mjs'
import { callerOf } from '../lib/identity.mjs'

// B2C credit packs (the B2B store's plans and top-ups are in routes/b2b.mjs).
// Rules and trust model: lib/payments.mjs.
const router = express.Router()
export default router

/**
 * POST /api/payments/webhook. Mounted by app.mjs BEFORE express.json(), with
 * express.raw(): the signature covers the exact bytes Cashfree sent.
 */
export async function webhookHandler(req, res) {
  const { status, body } = await handleWebhook({
    rawBody: req.body, // Buffer
    timestamp: req.headers['x-webhook-timestamp'],
    signature: req.headers['x-webhook-signature'],
  })
  return res.status(status).json(body)
}

// GET /api/payments/pricing — public pricing (single source of truth) for the UI.
router.get('/api/payments/pricing', async (_req, res) => res.json(await pricingPayload()))

// POST /api/payments/create { type } — start checkout for a credit pack.
router.post('/api/payments/create', async (req, res) => {
  if (!cashfreeConfigured()) return res.status(400).json({ error: 'Payments are not configured on the server.' })
  const { user } = await callerOf(req)
  if (!user) return res.status(401).json({ error: 'Sign in to buy credits.' })
  try {
    return res.json(await creditPack.createOrder({
      user,
      type: req.body?.type,
      phone: req.body?.phone,
      appUrl: process.env.APP_PUBLIC_URL || req.headers.origin || 'http://localhost:8081',
    }))
  } catch (err) {
    if (err instanceof BillingError) return res.status(err.status).json({ error: err.message })
    console.error('[Atelier] payments/create failed:', err.message, err.body ?? '')
    return res.status(502).json({ error: 'Could not start checkout. Please try again.' })
  }
})

// GET /api/payments/status/:orderId — the app's check after checkout (backup to
// the webhook). Grants the credits if Cashfree says PAID.
router.get('/api/payments/status/:orderId', async (req, res) => {
  if (!cashfreeConfigured()) return res.status(400).json({ error: 'Payments are not configured.' })
  const { user } = await callerOf(req)
  if (!user) return res.status(401).json({ error: 'Sign in first.' })
  const { orderId } = req.params
  try {
    const r = await creditPack.verifyAndApply(orderId, { userId: user.id })
    console.log(`[Atelier] payments/status: order ${orderId} → ${r.orderStatus} (paid=${r.paid})`)
    return res.json({ orderId, orderStatus: r.orderStatus, paid: r.paid, membership: r.membership ?? (await getMembership(user.id)) })
  } catch (err) {
    if (err instanceof BillingError) return res.status(err.status).json({ error: err.message })
    console.error('[Atelier] payments/status failed:', err.message)
    return res.status(502).json({ error: 'Could not check payment status.' })
  }
})
