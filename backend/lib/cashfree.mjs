import crypto from 'crypto'

// =============================================================================
// Cashfree Payments (PG Orders API) — server-side only. Secrets never leave here.
//
// Model: one-time credit purchases (₹15 / ₹350 / ₹700 → +1 / +30 / +100 credits).
// Amounts/credits are owned by lib/pricing.mjs (single source of truth); this
// module is just the Cashfree HTTP + signature plumbing.
//
// API version + endpoints confirmed against docs (2026): Orders create/get.
// Webhook signature: base64(HMAC-SHA256(`${timestamp}${rawBody}`, secret)) over
// the RAW body, headers x-webhook-timestamp / x-webhook-signature, keyed with the
// API secret key. Verified before any credit grant.
// =============================================================================

export const API_VERSION = '2026-01-01'

const ENV = (process.env.CASHFREE_ENV || 'sandbox').toLowerCase()
const IS_PROD = ENV === 'production'
const BASE_URL = IS_PROD ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg'

const APP_ID = process.env.CASHFREE_APP_ID || ''
const SECRET_KEY = process.env.CASHFREE_SECRET_KEY || ''
// Cashfree PG webhooks are signed with the API secret key. Some merchants set a
// distinct webhook secret in the dashboard — honour it if provided, else fall
// back to the API secret key (the documented default).
const WEBHOOK_SECRET = process.env.CASHFREE_WEBHOOK_SECRET || SECRET_KEY

/**
 * A 10-digit Indian mobile number from what the customer typed ("+91 98765 43210",
 * "098765 43210", ...), or null. Cashfree requires customer_phone on every order.
 */
export function normalizePhone(input) {
  const digits = String(input ?? '').replace(/\D/g, '').replace(/^(?:91|0)(?=\d{10}$)/, '')
  return /^[6-9]\d{9}$/.test(digits) ? digits : null
}

export function cashfreeConfigured() {
  return !!(APP_ID && SECRET_KEY)
}

/** Public, non-secret bits the client may know (checkout SDK mode). */
export function cashfreeMode() {
  return IS_PROD ? 'production' : 'sandbox'
}

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    'x-api-version': API_VERSION,
    'x-client-id': APP_ID,
    'x-client-secret': SECRET_KEY,
  }
}

async function cfFetch(path, init) {
  const res = await fetch(`${BASE_URL}${path}`, init)
  const text = await res.text()
  let body
  try { body = text ? JSON.parse(text) : {} } catch { body = { raw: text } }
  if (!res.ok) {
    const msg = body?.message || body?.error_description || `Cashfree ${res.status}`
    const err = new Error(msg)
    err.status = res.status
    err.body = body
    throw err
  }
  return body
}

/**
 * Create a Cashfree order server-side. Returns only what the client needs to open
 * checkout (payment_session_id) plus our identifiers. customer_id must be 3–50
 * alphanumeric, so the Supabase UUID is stripped of hyphens; the authoritative
 * user_id ↔ order mapping is persisted separately (purchases table).
 */
export async function createOrder({ orderId, amount, currency = 'INR', customerId, customerEmail, customerPhone, returnUrl, notifyUrl, orderNote = 'Atelier credits' }) {
  const phone = normalizePhone(customerPhone)
  if (IS_PROD && !phone) {
    throw Object.assign(new Error('A valid 10-digit mobile number is required to pay.'), { status: 400, code: 'no_phone' })
  }
  const order_meta = {}
  if (returnUrl) order_meta.return_url = returnUrl
  if (notifyUrl) order_meta.notify_url = notifyUrl

  const payload = {
    order_id: orderId,
    order_amount: amount,
    order_currency: currency,
    customer_details: {
      customer_id: String(customerId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 50),
      customer_email: customerEmail || undefined,
      // Required by Cashfree: the customer's real number in production; the
      // placeholder is only for sandbox testing.
      customer_phone: phone || '9999999999',
    },
    order_note: orderNote,
    ...(Object.keys(order_meta).length ? { order_meta } : {}),
  }

  const body = await cfFetch('/orders', { method: 'POST', headers: authHeaders(), body: JSON.stringify(payload) })
  return {
    orderId,
    paymentSessionId: body.payment_session_id,
    cfOrderId: body.cf_order_id,
    orderStatus: body.order_status,
  }
}

/** Server-side order status check. order_status === 'PAID' means success. */
export async function getOrder(orderId) {
  const body = await cfFetch(`/orders/${encodeURIComponent(orderId)}`, { method: 'GET', headers: authHeaders() })
  return {
    orderId: body.order_id,
    cfOrderId: body.cf_order_id,
    orderStatus: body.order_status, // ACTIVE | PAID | EXPIRED | TERMINATED | ...
    orderAmount: body.order_amount,
    raw: body,
  }
}

/**
 * Verify a Cashfree webhook signature over the RAW request body.
 * signature === base64(HMAC-SHA256(`${timestamp}${rawBody}`, secret)).
 * rawBody must be the exact bytes received (Buffer or string), never re-serialized.
 */
export function verifyWebhookSignature(rawBody, timestamp, signature) {
  if (!signature || !timestamp || !WEBHOOK_SECRET) return false
  const payload = `${timestamp}${rawBody instanceof Buffer ? rawBody.toString('utf8') : rawBody}`
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('base64')
  try {
    const a = Buffer.from(expected)
    const b = Buffer.from(signature)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}
