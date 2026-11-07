import { cashfreeConfigured, cashfreeMode, createOrder, getOrder, normalizePhone, verifyWebhookSignature } from './cashfree.mjs'
import { purchaseFor } from './pricing.mjs'
import { createPurchase, getPurchaseUser, grantCredits } from './membership.mjs'
import { BillingError, verifyAndApplyB2BOrder, isB2BOrderId } from './b2bBilling.mjs'

// =============================================================================
// Cashfree payments, for two kinds of product behind one interface:
//   creditPack   — B2C credit packs (₹15 / ₹350 / ₹700 → +1 / +30 / +100);
//                  purchases table, credits added by add_credits (membership.mjs)
//   storeBilling — B2B plans and top-ups; b2b_payments, applied by
//                  apply_b2b_payment (b2bBilling.mjs, which owns its own rules)
//
// Every kind: verifyAndApply(orderId, owner) asks Cashfree server-to-server,
// checks the paid amount, and applies the order at most once (both kinds flip
// created→paid atomically), so the webhook and the app's status check can both
// run. One webhook serves both kinds; the order-id prefix picks the kind.
// Credits are never granted on the client's say-so.
// =============================================================================

export const creditPack = {
  name: 'creditPack',
  owns: (orderId) => typeof orderId === 'string' && !isB2BOrderId(orderId),

  /**
   * Create a Cashfree order for a credit pack. The amount comes from pricing,
   * never from the client.
   */
  async createOrder({ user, type, appUrl, phone }) {
    if (!cashfreeConfigured()) throw new BillingError(400, 'Payments are not configured on the server.', 'not_configured')
    const option = await purchaseFor(type)
    if (!option) throw new BillingError(400, 'Unknown purchase type.', 'unknown_item')
    // Cashfree requires the customer's mobile number (the app asks for it at checkout).
    const customerPhone = normalizePhone(phone) || normalizePhone(user.phone)
    if (!customerPhone && cashfreeMode() === 'production') {
      throw new BillingError(400, 'Enter a valid 10-digit mobile number to pay.', 'no_phone')
    }

    const orderId = `atelier_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const amount = option.amountInr
    const apiUrl = process.env.API_PUBLIC_URL || '' // public https base for the webhook (blank in local dev)
    const order = await createOrder({
      orderId,
      amount,
      currency: 'INR',
      customerId: user.id,
      customerEmail: user.email,
      customerPhone,
      orderNote: `Atelier: ${option.label} (${option.credits} credit${option.credits === 1 ? '' : 's'})`,
      returnUrl: `${appUrl}/premium?order_id={order_id}`,
      notifyUrl: apiUrl ? `${apiUrl}/api/payments/webhook` : undefined,
    })
    await createPurchase(user.id, { orderId, type: option.type, amountInr: amount, credits: option.credits })
    console.log(`[Atelier] payments/create: order ${orderId} for ${user.id} (${option.type}, ₹${amount} → +${option.credits}, ${cashfreeMode()})`)
    return { orderId, paymentSessionId: order.paymentSessionId, mode: cashfreeMode(), type: option.type, amount, credits: option.credits, currency: 'INR' }
  },

  /**
   * @param {{ userId?: string }} owner  userId: refuse another user's order
   * @returns {Promise<{ paid: boolean, orderStatus: string, granted: boolean, userId: string, membership: object|null }>}
   */
  async verifyAndApply(orderId, { userId } = {}) {
    const rec = await getPurchaseUser(orderId)
    if (!rec) throw new BillingError(userId ? 403 : 404, userId ? 'This order is not yours.' : 'Order not found.', 'unknown_order')
    if (userId && rec.user_id !== userId) throw new BillingError(403, 'This order is not yours.', 'not_yours')
    const order = await getOrder(orderId)
    const paid = String(order.orderStatus).toUpperCase() === 'PAID'
    // grantCredits checks the amount and is idempotent (atomic created→paid flip).
    const r = paid ? await grantCredits(orderId, { paidAmount: order.orderAmount }) : null
    return { paid, orderStatus: order.orderStatus, granted: !!r?.granted, userId: rec.user_id, membership: r?.membership ?? null }
  },
}

export const storeBilling = {
  name: 'storeBilling',
  owns: isB2BOrderId,
  // Plans and top-ups are created in b2bBilling.createB2BOrder (store-scoped rules).
  verifyAndApply: (orderId, { storeId } = {}) => verifyAndApplyB2BOrder(orderId, { storeId }),
}

const KINDS = [storeBilling, creditPack]

/** The product kind an order id belongs to. */
export function kindOf(orderId) {
  return KINDS.find((k) => k.owns(orderId)) ?? null
}

/**
 * POST /api/payments/webhook. Verifies Cashfree's signature over the raw body,
 * then re-checks the order with Cashfree before applying it.
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function handleWebhook({ rawBody, timestamp, signature }) {
  if (!verifyWebhookSignature(rawBody, timestamp, signature)) {
    console.warn('[Atelier] payments/webhook: SIGNATURE VERIFICATION FAILED — rejecting.')
    return { status: 401, body: { error: 'Invalid signature' } }
  }
  let event
  try {
    event = JSON.parse(rawBody.toString('utf8'))
  } catch {
    return { status: 400, body: { error: 'Bad payload' } }
  }

  const order = event?.data?.order ?? {}
  const payment = event?.data?.payment ?? {}
  const orderId = order.order_id
  const success =
    /PAYMENT_SUCCESS/i.test(event?.type || '') ||
    String(payment.payment_status || '').toUpperCase() === 'SUCCESS' ||
    String(order.order_status || '').toUpperCase() === 'PAID'
  console.log(`[Atelier] payments/webhook: verified type=${event?.type} order=${orderId} success=${success}`)

  const kind = success && orderId ? kindOf(orderId) : null
  if (kind) {
    try {
      await kind.verifyAndApply(orderId)
    } catch (err) {
      if (err instanceof BillingError && err.status < 500) {
        // Permanent (e.g. an order this environment never created): a retry can't
        // succeed, so acknowledge it instead of making Cashfree retry for days.
        console.warn(`[Atelier] payments/webhook: ignored (${err.code}): ${err.message}`)
        return { status: 200, body: { received: true, ignored: err.code } }
      }
      console.error('[Atelier] payments/webhook handling error:', err.message)
      // 500 → Cashfree retries later. Safe: both kinds apply idempotently, and a
      // 200 here would lose the credits of a paid order on a transient DB error.
      return { status: 500, body: { error: 'Temporary error — please retry.' } }
    }
  }
  return { status: 200, body: { ok: true } }
}
