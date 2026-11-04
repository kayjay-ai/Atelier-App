import 'dotenv/config'
import express from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { GoogleGenAI } from '@google/genai'
import { extractJson } from './lib/json.mjs'
import { TRYON_DIR } from './lib/catalog.mjs'
import { styleSystemPrompt, sizeSystemPrompt, sizeImageSystemPrompt, colorSystemPrompt, verdictSystemPrompt } from './lib/prompts.mjs'
import { recommendSize } from './lib/sizeHeuristic.mjs'
import { STYLE_FALLBACK, COLOR_FALLBACK, ATELIER_BUSY_MESSAGE } from './lib/fallbacks.mjs'
import {
  describeDataUrl,
  fetchGarmentAsDataUrl,
  runTryOnGeneration,
  tryOnUserMessage,
} from './lib/tryon.mjs'
import {
  consumeCredits,
  creditContextFromBody,
  creditDeniedResponse,
  getCreditStatus,
} from './lib/credits.mjs'
import {
  getUserFromRequest,
  getMembership,
  reserveTryOn,
  refundTryOn,
  membershipEnabled,
  createPurchase,
  getPurchaseUser,
  grantCredits,
} from './lib/membership.mjs'
import {
  cashfreeConfigured,
  cashfreeMode,
  createOrder,
  getOrder,
  verifyWebhookSignature,
} from './lib/cashfree.mjs'
import { purchaseFor, pricingPayload } from './lib/pricing.mjs'
import {
  getClientContext, clientActive, consumeClientCredit, refundClientCredit,
  deviceKeyFromRequest, findDevice, touchDevice, logAppEvent, getSettings, latestTabletNotice,
} from './lib/clients.mjs'
import { logUsage } from './lib/usage.mjs'
import { safeFetch, domainOf, UnsafeUrlError } from './lib/safeFetch.mjs'
import { sendNotification } from './lib/notify.mjs'
import { runDailyJob } from './jobs/daily.mjs'
import { BillingError, billingOverview, createB2BOrder, verifyAndApplyB2BOrder, isB2BOrderId } from './lib/b2bBilling.mjs'
import crypto from 'crypto'
import { verifyJwt } from './lib/jwt.mjs'
import { getClient, originAllowed, clientForApiKey, resolveClient, resolveClientByApiKey, enabledFeatures } from './lib/embedClients.mjs'
import {
  findOrCreateEmbedUser,
  mintSession,
  embedSessionFromRequest,
  verifySession,
  saveEmbedGeneration,
  listEmbedGenerations,
  SESSION_LIFETIME_SEC,
} from './lib/embedSession.mjs'
import { serviceDb } from './lib/db.mjs'

const app = express()

// CORS — the frontend (Vercel) and this backend (Render) are on different origins,
// so the browser blocks calls unless we echo an allowed Origin. Localhost defaults
// cover dev; production origins come from CORS_ALLOWED_ORIGINS (comma-separated),
// set in Render to the exact Vercel domain(s) — no code change to add one.
const ALLOWED_ORIGINS = [
  'http://localhost:5173', // Vite web app
  'http://localhost:5174', // alternate web port
  'http://localhost:8081', // Expo mobile (web)
  'http://localhost:8082',
  'http://localhost:5199', // VERVE retail demo
  ...(process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean),
]
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Atelier-Device')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// ---------------------------------------------------------------------------
// POST /api/payments/webhook — Cashfree payment notification.
// MUST be registered BEFORE express.json() so it receives the RAW body: the
// signature is computed over the exact bytes Cashfree sent, so any re-serialization
// would break verification. Credits are granted ONLY here (or via the server-side
// status check) — never on the client's say-so.
// ---------------------------------------------------------------------------
app.post('/api/payments/webhook', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  const signature = req.headers['x-webhook-signature']
  const timestamp = req.headers['x-webhook-timestamp']
  const rawBody = req.body // Buffer

  if (!verifyWebhookSignature(rawBody, timestamp, signature)) {
    console.warn('[Atelier] payments/webhook: SIGNATURE VERIFICATION FAILED — rejecting.')
    return res.status(401).json({ error: 'Invalid signature' })
  }

  let event
  try {
    event = JSON.parse(rawBody.toString('utf8'))
  } catch {
    return res.status(400).json({ error: 'Bad payload' })
  }

  try {
    const order = event?.data?.order ?? {}
    const payment = event?.data?.payment ?? {}
    const orderId = order.order_id
    const success =
      /PAYMENT_SUCCESS/i.test(event?.type || '') ||
      String(payment.payment_status || '').toUpperCase() === 'SUCCESS' ||
      String(order.order_status || '').toUpperCase() === 'PAID'

    console.log(`[Atelier] payments/webhook: verified type=${event?.type} order=${orderId} success=${success}`)

    if (success && isB2BOrderId(orderId)) {
      // Re-checks the order with Cashfree (amount included) before applying.
      await verifyAndApplyB2BOrder(orderId)
    } else if (success && orderId) {
      const rec = await getPurchaseUser(orderId)
      if (rec?.user_id) {
        // Confirm with Cashfree server-to-server (status + amount) rather than
        // trusting the payload; grantCredits is idempotent (atomic created→paid
        // flip), so duplicate webhook events + the status endpoint can't double-grant.
        const order = await getOrder(orderId)
        if (String(order.orderStatus).toUpperCase() === 'PAID') {
          await grantCredits(orderId, { paidAmount: order.orderAmount })
        }
      } else {
        console.warn(`[Atelier] payments/webhook: no local purchase for ${orderId}`)
      }
    }
  } catch (err) {
    if (err instanceof BillingError && err.status < 500) {
      // Permanent (e.g. an order this environment never created): a retry can't
      // succeed, so acknowledge it instead of making Cashfree retry for days.
      console.warn(`[Atelier] payments/webhook: ignored (${err.code}): ${err.message}`)
      return res.status(200).json({ received: true, ignored: err.code })
    }
    console.error('[Atelier] payments/webhook handling error:', err.message)
    // 500 → Cashfree retries later. Safe: both grant paths are idempotent, and a
    // 200 here would lose the credits of a paid order on a transient DB error.
    return res.status(500).json({ error: 'Temporary error — please retry.' })
  }
  // Acknowledge receipt (signature already verified above).
  return res.json({ ok: true })
})

app.use(express.json({ limit: '25mb' }))

// GET /api/health
// Request logger — every route, every status
app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    const ms = Date.now() - start
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'log'
    console[level](`[Atelier] ${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`)
  })
  next()
})

// Activity log (admin Activity pages + every usage card): one usage_events row
// per AI feature call, written after the response is sent so it never slows or
// breaks the feature itself.
const FEATURE_ROUTES = {
  '/api/style': 'style',
  '/api/color': 'color',
  '/api/size': 'size',
  '/api/verdict': 'verdict',
  '/api/tryon': 'tryon',
  '/api/garment/from-url': 'garment_from_url',
}
const INPUT_SOURCES = new Set(['link', 'screenshot', 'upload', 'gallery', 'camera', 'catalog'])

app.use((req, res, next) => {
  const feature = req.method === 'POST' ? FEATURE_ROUTES[req.path] : null
  if (!feature) return next()
  const json = res.json.bind(res)
  res.json = (body) => { res.locals.responseBody = body; return json(body) }
  res.on('finish', () => { recordUsage(req, res, feature) })
  next()
})

async function recordUsage(req, res, feature) {
  try {
    const body = res.locals.responseBody || {}
    const code = res.statusCode
    const status = code === 402 ? 'paywall'
      : code === 401 ? 'denied'
      : code === 403 ? 'blocked'
      : code >= 400 ? 'error'
      : (body.fallback || body.demo || body.debug || body.error) ? 'fallback'
      : 'success'
    const rb = req.body || {}
    const user = await getUserFromRequest(req)
    const company = user ? await getClientContext(user.id).catch(() => null) : null
    const device = company ? await findDevice(company.clientId, deviceKeyFromRequest(req)) : null
    const sourceUrl = feature === 'garment_from_url' ? rb.url : (rb.productUrl || rb.garmentImageUrl || null)
    const source = INPUT_SOURCES.has(rb.inputSource) ? rb.inputSource
      : feature === 'garment_from_url' ? 'link'
      : rb.productId ? 'catalog'
      : rb.garmentImageUrl ? 'link'
      : null
    const creditsUsed = feature === 'tryon' && status === 'success' ? 1 : 0

    await logUsage({
      userId: user?.id ?? null,
      feature,
      status,
      productName: rb.garmentName || body.name || null,
      metadata: {
        http: code,
        ...(body.size ? { size: body.size } : {}),
        ...(body.call ? { call: body.call } : {}),
        ...(rb.occasion ? { occasion: rb.occasion } : {}),
      },
      columns: {
        channel: company ? 'b2b' : 'b2c',
        company_id: company?.companyId ?? null,
        store_id: company?.clientId ?? null,
        device_id: device?.id ?? null,
        credits_used: creditsUsed,
        brand: rb.garmentBrand || body.brand || null,
        source,
        source_url: typeof sourceUrl === 'string' ? sourceUrl.slice(0, 1000) : null,
        domain: typeof sourceUrl === 'string' ? domainOf(sourceUrl) : null,
      },
    })

    if (code === 402) {
      await logAppEvent({
        event: 'credit_limit_hit', userId: user?.id, clientId: company?.clientId,
        companyId: company?.companyId, deviceId: device?.id, metadata: { feature },
      })
    }
  } catch (err) {
    console.warn('[Atelier] recordUsage failed:', err?.message)
  }
}

app.get('/', (_req, res) => res.redirect('/api/health'))
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }))
// Plain /health for Render's health check (and quick "is the backend alive?" curls).
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }))

const PORT = process.env.PORT || 8787
const TEXT_MODEL = process.env.TEXT_MODEL || 'gemini-2.5-flash'
// Try-on image cost tier. `economy` (default) uses Gemini 3.1 Flash Lite Image;
// `standard` uses the Pro image model. Flip with one env line — no code change.
const IMAGE_QUALITY = (process.env.IMAGE_QUALITY || 'economy').toLowerCase()
const STANDARD_IMAGE_MODEL = process.env.IMAGE_MODEL || 'gemini-3-pro-image-preview'
const ECONOMY_IMAGE_MODEL = process.env.IMAGE_MODEL_ECONOMY || 'gemini-3.1-flash-lite-image'
const IMAGE_MODEL = IMAGE_QUALITY === 'standard' ? STANDARD_IMAGE_MODEL : ECONOMY_IMAGE_MODEL

function textAIClient() {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_TEXT_API_KEY
  if (!apiKey) return null
  return new GoogleGenAI({ apiKey })
}

function geminiClient() {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return null
  return new GoogleGenAI({ apiKey })
}

/** Extracts status/type/message from a Gemini SDK error for logging & dev responses. */
function describeGeminiError(err) {
  return {
    status: err?.status ?? err?.response?.status ?? null,
    type: err?.name ?? err?.error?.status ?? 'Error',
    message: err?.error?.message ?? err?.message ?? String(err),
  }
}

function isRateLimit(err) {
  return err?.status === 429 || /RESOURCE_EXHAUSTED|429/i.test(String(err?.message))
}

async function chargeCredits(req, res, action) {
  const ctx = creditContextFromBody(req.body)
  if (!ctx.companyId) return { ok: true, credits: null }

  const result = await consumeCredits({ ...ctx, action })
  if (!result.ok) {
    creditDeniedResponse(res, result)
    return { ok: false }
  }
  return { ok: true, credits: result.status }
}

// ---------------------------------------------------------------------------
// GET /api/credits
// ---------------------------------------------------------------------------
app.get('/api/credits', async (req, res) => {
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
app.get('/api/membership', async (req, res) => {
  if (!membershipEnabled()) {
    return res.json({ enabled: false, plan: 'premium', tryonUsed: 0, tryonLimit: -1, remaining: null })
  }
  const user = await getUserFromRequest(req)
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
// Cashfree payments — buy credits (₹15 / ₹350 / ₹700 → +1 / +30 / +100). One-time
// credit purchases (no auto-renew). Amounts come from lib/pricing.mjs; secrets stay
// server-side; credits are granted ONLY after server verification.
// ---------------------------------------------------------------------------

// GET /api/payments/pricing — public pricing (single source of truth) for the UI.
app.get('/api/payments/pricing', async (_req, res) => res.json(await pricingPayload()))

// POST /api/payments/create — create an order for a purchase type. The amount is
// derived server-side from pricing (client never sends an amount). Tied to the user.
app.post('/api/payments/create', async (req, res) => {
  if (!cashfreeConfigured()) return res.status(400).json({ error: 'Payments are not configured on the server.' })
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Sign in to buy credits.' })

  const option = await purchaseFor(req.body?.type)
  if (!option) return res.status(400).json({ error: 'Unknown purchase type.' })

  try {
    const orderId = `atelier_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const amount = option.amountInr
    const appUrl = process.env.APP_PUBLIC_URL || req.headers.origin || 'http://localhost:8081'
    const apiUrl = process.env.API_PUBLIC_URL || '' // public https base for the webhook (blank in local dev)
    const returnUrl = `${appUrl}/premium?order_id={order_id}`
    const notifyUrl = apiUrl ? `${apiUrl}/api/payments/webhook` : undefined

    const order = await createOrder({
      orderId,
      amount,
      currency: 'INR',
      customerId: user.id,
      customerEmail: user.email,
      customerPhone: req.body?.phone || user.phone || undefined,
      returnUrl,
      notifyUrl,
    })
    await createPurchase(user.id, { orderId, type: option.type, amountInr: amount, credits: option.credits })
    console.log(`[Atelier] payments/create: order ${orderId} for ${user.id} (${option.type}, ₹${amount} → +${option.credits}, ${cashfreeMode()})`)
    return res.json({
      orderId,
      paymentSessionId: order.paymentSessionId,
      mode: cashfreeMode(),
      type: option.type,
      amount,
      credits: option.credits,
      currency: 'INR',
    })
  } catch (err) {
    console.error('[Atelier] payments/create failed:', err.message, err.body ?? '')
    return res.status(502).json({ error: 'Could not start checkout. Please try again.' })
  }
})

// GET /api/payments/status/:orderId — server-side verification the client calls
// after returning from checkout (backup to the webhook). Grants credits if PAID.
app.get('/api/payments/status/:orderId', async (req, res) => {
  if (!cashfreeConfigured()) return res.status(400).json({ error: 'Payments are not configured.' })
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Sign in first.' })
  const { orderId } = req.params
  try {
    const rec = await getPurchaseUser(orderId)
    if (!rec || rec.user_id !== user.id) return res.status(403).json({ error: 'This order is not yours.' })

    const order = await getOrder(orderId) // server-to-server, secret-signed
    const paid = String(order.orderStatus).toUpperCase() === 'PAID'
    let membership = await getMembership(user.id)
    if (paid) {
      // Idempotent (atomic created→paid flip) — safe if the webhook already granted.
      const r = await grantCredits(orderId, { paidAmount: order.orderAmount })
      membership = r.membership ?? membership
    }
    console.log(`[Atelier] payments/status: order ${orderId} → ${order.orderStatus} (paid=${paid})`)
    return res.json({ orderId, orderStatus: order.orderStatus, paid, membership })
  } catch (err) {
    console.error('[Atelier] payments/status failed:', err.message)
    return res.status(502).json({ error: 'Could not check payment status.' })
  }
})

// ===========================================================================
// EMBED SSO — white-label iframe. A registered client's backend mints a signed
// JWT for its logged-in user; the iframe hands it here; we verify server-side and
// issue a short-lived Atelier session token (held in the iframe's memory, sent as
// Authorization: Bearer — NO third-party cookies). All data is scoped to the
// verified (client_id, external_user_id), never a client-supplied value.
// ===========================================================================

// POST /api/embed/session — verify the client's signed token, find-or-create the
// Atelier user for (client_id, external_user_id), and issue an Atelier session token.
app.post('/api/embed/session', async (req, res) => {
  const { token } = req.body || {}
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'missing_token', message: 'A signed client token is required.' })
  }
  // Peek the unverified client_id claim to select the verification secret. The
  // signature is verified against that client's secret immediately after.
  let clientId
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    clientId = claims.client_id
  } catch {
    return res.status(401).json({ error: 'invalid_token', message: 'Token is malformed.' })
  }
  const client = clientId ? await resolveClient(clientId) : null
  if (!client) {
    return res.status(401).json({ error: 'unknown_client', message: 'This client is not registered or is inactive.' })
  }

  let payload
  try {
    // maxLifetime enforces short-lived client tokens (≤5 min) — leaked tokens expire fast.
    payload = verifyJwt(token, client.secret, { maxLifetimeSec: 300 })
  } catch (err) {
    console.warn(`[Atelier] embed/session rejected (${err.code}) for client ${clientId}`)
    return res.status(401).json({ error: err.code === 'expired' ? 'token_expired' : 'invalid_token', message: 'Token could not be verified.' })
  }
  if (payload.client_id !== client.client_id) {
    return res.status(401).json({ error: 'client_mismatch', message: 'Token client_id does not match.' })
  }
  const externalUserId = payload.external_user_id || payload.sub
  if (!externalUserId) {
    return res.status(400).json({ error: 'missing_user', message: 'Token must carry external_user_id.' })
  }

  try {
    const atelierUserId = await findOrCreateEmbedUser(client.client_id, String(externalUserId), {
      name: payload.name, email: payload.email,
    })
    const features = enabledFeatures(client) // per-client AI toggles (default all on)
    const session = { atelierUserId, clientId: client.client_id, externalUserId: String(externalUserId), name: payload.name, email: payload.email, features }
    const atelierToken = mintSession(session)
    console.log(`[Atelier] embed/session: signed in ${client.client_id}:${externalUserId} features=${JSON.stringify(features)}`)
    return res.json({
      token: atelierToken,
      expiresIn: SESSION_LIFETIME_SEC,
      user: { externalUserId: String(externalUserId), name: payload.name ?? null, clientId: client.client_id },
      enabledFeatures: features,
    })
  } catch (err) {
    console.error('[Atelier] embed/session failed:', err.message)
    return res.status(500).json({ error: 'server_error', message: 'Could not establish the session.' })
  }
})

// POST /api/embed/refresh — issue a fresh Atelier session token from a still-valid
// one, so long sessions don't drop. (When fully expired, the iframe re-runs the
// postMessage handshake to get a new client token.)
app.post('/api/embed/refresh', async (req, res) => {
  const session = embedSessionFromRequest(req)
  if (!session) return res.status(401).json({ error: 'invalid_session', message: 'Session is missing or expired — re-authenticate.' })
  // Re-read the client's toggles on refresh so an admin change propagates within a session.
  const client = await resolveClient(session.clientId)
  const features = client ? enabledFeatures(client) : session.features
  const token = mintSession({ ...session, features })
  return res.json({ token, expiresIn: SESSION_LIFETIME_SEC, enabledFeatures: features })
})

// GET /api/embed/me — who the iframe is authenticated as + enabled features.
app.get('/api/embed/me', (req, res) => {
  const session = embedSessionFromRequest(req)
  if (!session) return res.status(401).json({ error: 'invalid_session' })
  return res.json({ externalUserId: session.externalUserId, name: session.name ?? null, clientId: session.clientId, enabledFeatures: session.features })
})

// GET /api/embed/config — the client's enabled AI features (for the embed UI).
app.get('/api/embed/config', (req, res) => {
  const session = embedSessionFromRequest(req)
  if (!session) return res.status(401).json({ error: 'invalid_session' })
  return res.json({ enabledFeatures: session.features })
})

// GET /api/embed/history — the signed-in embed user's own generations (scoped to
// their verified (client_id, external_user_id) from the session token).
app.get('/api/embed/history', async (req, res) => {
  const session = embedSessionFromRequest(req)
  if (!session) return res.status(401).json({ error: 'invalid_session' })
  const items = await listEmbedGenerations(session.clientId, session.externalUserId)
  return res.json({ items })
})

// POST /api/embed/history — record a generation for the signed-in embed user. The
// scope (client_id, external_user_id) comes from the VERIFIED session, not the body.
app.post('/api/embed/history', async (req, res) => {
  const session = embedSessionFromRequest(req)
  if (!session) return res.status(401).json({ error: 'invalid_session' })
  const { kind, imageUrl, result, productName } = req.body || {}
  if (!['tryon', 'size', 'verdict'].includes(kind)) {
    return res.status(400).json({ error: 'bad_kind', message: 'kind must be tryon | size | verdict.' })
  }
  const saved = await saveEmbedGeneration(session, { kind, imageUrl, result, productName })
  return res.json({ ok: true, saved })
})

// GET /api/partner/users/:externalUserId/history — server-to-server API for the
// CLIENT to retrieve their own user's generations. Authenticated with the client's
// API key (X-Client-Api-Key), and strictly scoped to that client_id.
app.get('/api/partner/users/:externalUserId/history', async (req, res) => {
  const apiKey = req.headers['x-client-api-key']
  const client = await resolveClientByApiKey(apiKey)
  if (!client) return res.status(401).json({ error: 'invalid_api_key', message: 'A valid X-Client-Api-Key is required.' })
  const { externalUserId } = req.params
  const items = await listEmbedGenerations(client.client_id, externalUserId)
  console.log(`[Atelier] partner history: ${client.client_id}:${externalUserId} → ${items.length} rows`)
  return res.json({ clientId: client.client_id, externalUserId, items })
})

// Per-client feature enforcement. If the request carries an embed session
// (X-Embed-Session header) whose client has `feature` disabled, reject BEFORE any
// generation or credit charge. Non-embed requests are unaffected (returns false).
// Enforcement is defense-in-depth: the embed UI also hides disabled features.
function embedFeatureBlocked(req, res, feature) {
  const raw = req.headers['x-embed-session']
  if (!raw) return false
  const session = verifySession(String(raw))
  if (!session) return false // invalid/expired embed token → endpoints keep their own gating
  const feats = session.features
  if (feats && feats[feature] === false) {
    console.info(`[Atelier] blocked ${feature} for ${session.clientId}:${session.externalUserId} (disabled)`)
    res.status(403).json({ error: 'feature_disabled', message: 'This feature is not enabled for your account.' })
    return true
  }
  return false
}

// B2B store logins (b2b_stores.store_email): a suspended company or a feature the admin
// switched off is refused server-side, not only hidden in the iPad UI.
function clientBlockedMessage(company, feature) {
  if (!clientActive(company)) return 'Your account is paused — contact Atelier support.'
  if (company.features[feature] === false) return 'This feature is not enabled for your company.'
  return null
}

// For the free features (style, size): resolve the signed-in company, if any, and
// reject when blocked. B2C and anonymous requests pass straight through.
async function companyFeatureBlocked(req, res, feature) {
  if (!membershipEnabled() || !/^Bearer\s+/i.test(req.headers.authorization || '')) return false
  const user = await getUserFromRequest(req)
  if (!user) return false
  let company
  try {
    company = await getClientContext(user.id)
  } catch (err) {
    console.error(`[Atelier] company lookup failed (${feature}):`, err.message)
    return false
  }
  const blocked = company && clientBlockedMessage(company, feature)
  if (!blocked) return false
  console.info(`[Atelier] blocked ${feature} for company ${company.clientId}: ${blocked}`)
  res.status(403).json({ error: blocked, message: blocked })
  return true
}

// Admin "Websites → Block": links from these domains are refused.
async function domainBlocked(url) {
  const domain = domainOf(url)
  const db = serviceDb()
  if (!domain || !db) return false
  try {
    const parent = domain.split('.').slice(-2).join('.')
    const { data } = await db.from('blocked_domains').select('domain').in('domain', [domain, parent])
    return (data ?? []).length > 0
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// POST /api/b2b/session — the store app calls this when it opens (and as a
// heartbeat while in use). Registers the iPad, logs device_session_started,
// and returns what the app needs that isn't readable through RLS.
// ---------------------------------------------------------------------------
app.post('/api/b2b/session', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Sign in again.' })
  let company
  try {
    company = await getClientContext(user.id)
  } catch (err) {
    console.error('[Atelier] /api/b2b/session: company lookup failed:', err.message)
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
app.post('/api/b2b/notice/:id/dismiss', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Sign in again.' })
  const company = await getClientContext(user.id).catch(() => null)
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
  const user = await getUserFromRequest(req)
  if (!user) {
    res.status(401).json({ error: 'Sign in again.' })
    return null
  }
  const company = await getClientContext(user.id).catch(() => null)
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
app.get('/api/b2b/billing', async (req, res) => {
  const who = await requireStore(req, res)
  if (!who) return
  try {
    return res.json(await billingOverview(who.storeId, { apiBase: publicApiBase(req) }))
  } catch (err) {
    return billingFailed(res, err, 'b2b billing overview')
  }
})

// POST /api/b2b/payments  { kind: 'plan'|'topup', itemId, acceptTerms, termsVersion, platform }
app.post('/api/b2b/payments', async (req, res) => {
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
app.get('/api/b2b/payments/:orderId', async (req, res) => {
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
const B2B_TERMS_HTML = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'legal', 'b2b-terms.html'), 'utf8')
app.get('/legal/b2b-terms', (_req, res) => {
  res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' })
  return res.send(B2B_TERMS_HTML)
})

app.get('/pay/b2b/checkout', (req, res) => {
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

app.get('/pay/b2b/return', (req, res) => {
  const orderId = String(req.query.order_id ?? '')
  const safe = /^b2b_[A-Za-z0-9_]{1,80}$/.test(orderId) ? orderId : ''
  const back = `atelier://store/plan${safe ? `?order_id=${encodeURIComponent(safe)}` : ''}`
  return payPage(res, 'Atelier — Payment', `<div><p>Payment submitted — returning to Atelier…</p>
<p><a href="${back}">Return to the app</a></p></div>
<script>location.replace(${JSON.stringify(back)})</script>`)
})

// ---------------------------------------------------------------------------
// POST /api/events — lifecycle events the server can't see itself (spec §6):
// the app writes customer folders straight to Supabase, so it reports them here.
// ---------------------------------------------------------------------------
const CLIENT_EVENTS = {
  b2b: new Set(['customer_captured', 'garment_selected', 'result_saved', 'result_shared']),
  b2c: new Set(['profile_completed', 'garment_added', 'paywall_viewed']),
}

app.post('/api/events', async (req, res) => {
  const { event, folderId, metadata } = req.body || {}
  const user = await getUserFromRequest(req)
  const company = user ? await getClientContext(user.id).catch(() => null) : null
  const channel = company ? 'b2b' : 'b2c'
  if (typeof event !== 'string' || !CLIENT_EVENTS[channel].has(event)) {
    return res.status(400).json({ error: `Unknown ${channel} event.` })
  }
  let meta = null
  if (metadata && typeof metadata === 'object' && JSON.stringify(metadata).length <= 2000) meta = metadata
  const device = company ? await findDevice(company.clientId, deviceKeyFromRequest(req)) : null
  await logAppEvent({
    event, channel, userId: user?.id, clientId: company?.clientId, companyId: company?.companyId, deviceId: device?.id,
    folderId: typeof folderId === 'string' && /^[0-9a-f-]{36}$/i.test(folderId) ? folderId : null,
    metadata: meta,
  })
  return res.json({ ok: true })
})

// ---------------------------------------------------------------------------
// Server-to-server endpoints (never called by the apps). Each needs its own
// shared secret in a header; unset secret → the endpoint is off.
// ---------------------------------------------------------------------------
function secretOk(req, header, envName) {
  const expected = process.env[envName]
  const given = req.headers[header]
  if (!expected || typeof given !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// POST /api/jobs/daily — run the daily maintenance job (folder expiry, plan
// expiry, credit notifications). For an external scheduler; Render's cron job
// runs `npm run job:daily` directly instead.
app.post('/api/jobs/daily', async (req, res) => {
  if (!secretOk(req, 'x-job-secret', 'JOBS_SECRET')) return res.status(401).json({ error: 'unauthorized' })
  try {
    return res.json(await runDailyJob())
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// POST /api/admin/notify — the admin dashboard's "Notify" / "Notify all"
// (spec §5.9). Body: { recipients: [{ type: 'b2b_store'|'b2c_user', id }],
// template, channels?, subject?, body?, sentBy? }. Respects the 24 h cooldown.
app.post('/api/admin/notify', async (req, res) => {
  if (!secretOk(req, 'x-admin-secret', 'ADMIN_API_SECRET')) return res.status(401).json({ error: 'unauthorized' })
  const { recipients, template, channels, subject, body, sentBy } = req.body || {}
  if (!Array.isArray(recipients) || recipients.length === 0 || recipients.length > 500) {
    return res.status(400).json({ error: 'recipients must be a list of 1–500 { type, id }' })
  }
  const results = []
  for (const r of recipients) {
    results.push({
      ...r,
      ...(await sendNotification({
        recipientType: r?.type, recipientId: r?.id, template, channels, subject, body,
        trigger: 'manual', sentBy: sentBy ?? null,
      })),
    })
  }
  return res.json({ sent: results.filter((r) => r.sent).length, results })
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
app.post('/api/auth/account-type', async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Enter a valid email.' })
  }
  // Behind Render's proxy: the right-most X-Forwarded-For entry is the one the
  // proxy added (the caller can't forge it); otherwise every user shares one IP.
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

app.post('/api/account/delete', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Sign in again to delete your account.' })
  const db = serviceDb()
  if (!db) return res.status(503).json({ error: 'Account deletion is not available right now.' })
  const company = await getClientContext(user.id).catch(() => null)
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

// ---------------------------------------------------------------------------
// POST /api/style
// ---------------------------------------------------------------------------
app.post('/api/style', async (req, res) => {
  if (embedFeatureBlocked(req, res, 'style_color_assist')) return
  if (await companyFeatureBlocked(req, res, 'style')) return
  const { measurements, occasion, photoBase64 } = req.body || {}
  const charge = await chargeCredits(req, res, 'style')
  if (!charge.ok) return

  const textAI = textAIClient()

  if (!textAI) {
    console.info('[Atelier] GEMINI_TEXT_API_KEY not set — serving canned style response.')
    return res.json(STYLE_FALLBACK)
  }

  const userText = `${
    measurements
      ? `Measurements: height ${measurements.heightCm}cm, weight ${measurements.weightKg}kg, chest ${measurements.chestIn}in, waist ${measurements.waistIn}in, hip ${measurements.hipIn}in. Fit preference: ${measurements.fitPreference}.`
      : 'No measurements provided.'
  }
Occasion: ${occasion || 'everyday'}
${photoBase64 ? 'A photo of the client is attached — read their colouring and proportions directly from it.' : 'No photo provided — work from measurements alone.'}

Please give me your stylist's read on what I should be wearing.`

  const parts = []
  if (photoBase64) {
    const m = /^data:(.+);base64,(.*)$/.exec(photoBase64)
    parts.push({ inlineData: { mimeType: m ? m[1] : 'image/jpeg', data: m ? m[2] : photoBase64 } })
  }
  parts.push({ text: userText })

  try {
    const resp = await textAI.models.generateContent({
      model: TEXT_MODEL,
      contents: [{ role: 'user', parts }],
      config: { systemInstruction: styleSystemPrompt(), responseMimeType: 'application/json' },
    })
    const parsed = extractJson(resp.text ?? '')
    if (!parsed || !parsed.archetype) throw new Error('Could not parse style response')
    if (!Array.isArray(parsed.picks)) parsed.picks = []
    return res.json(parsed)
  } catch (err) {
    if (isRateLimit(err)) {
      console.info('[Atelier] Style: free-tier rate limit hit (429) — client should retry shortly.')
    } else {
      console.error('[Atelier] Style assistant failed, serving fallback:', err.message)
    }
    return res.json(STYLE_FALLBACK)
  }
})

// ---------------------------------------------------------------------------
// POST /api/color
// ---------------------------------------------------------------------------
app.post('/api/color', async (req, res) => {
  if (embedFeatureBlocked(req, res, 'style_color_assist')) return
  const { photoBase64 } = req.body || {}
  const charge = await chargeCredits(req, res, 'color')
  if (!charge.ok) return

  const textAI = textAIClient()

  if (!photoBase64) {
    return res.status(400).json({ error: 'A photo is required for colour analysis.', message: ATELIER_BUSY_MESSAGE })
  }

  if (!textAI) {
    console.info('[Atelier] GEMINI_TEXT_API_KEY not set — serving canned colour analysis.')
    return res.json(COLOR_FALLBACK)
  }

  const m = /^data:(.+);base64,(.*)$/.exec(photoBase64)
  const mimeType = m ? m[1] : 'image/jpeg'
  const base64Data = m ? m[2] : photoBase64

  try {
    const resp = await textAI.models.generateContent({
      model: TEXT_MODEL,
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType, data: base64Data } },
          { text: 'Please analyse my colouring and recommend a palette.' },
        ],
      }],
      config: { systemInstruction: colorSystemPrompt(), responseMimeType: 'application/json' },
    })
    const parsed = extractJson(resp.text ?? '')
    if (!parsed || !parsed.undertone) throw new Error('Could not parse colour response')
    if (!Array.isArray(parsed.picks)) parsed.picks = []
    return res.json(parsed)
  } catch (err) {
    if (isRateLimit(err)) {
      console.info('[Atelier] Color: free-tier rate limit hit (429) — client should retry shortly.')
    } else {
      console.error('[Atelier] Colour assistant failed, serving fallback:', err.message)
    }
    return res.json(COLOR_FALLBACK)
  }
})

// ---------------------------------------------------------------------------
// POST /api/size
// ---------------------------------------------------------------------------
app.post('/api/size', async (req, res) => {
  if (embedFeatureBlocked(req, res, 'size_assist')) return
  if (await companyFeatureBlocked(req, res, 'size')) return
  // Supports both old catalog shape ({ measurements, garment }) and new BYO shape
  // ({ measurements, garmentImageBase64, garmentName, sizeChartText })
  const { measurements, garment, garmentImageBase64, garmentName, sizeChartText } = req.body || {}
  const textAI = textAIClient()

  if (!measurements) {
    return res.status(400).json({ error: 'measurements is required.' })
  }

  // Legacy catalog path (garment object with sizeChart)
  if (garment && !garmentImageBase64) {
    if (!textAI) return res.json(recommendSize(measurements, garment.sizeChart || []))
    const userContent = `Garment: ${garment.name || 'this piece'}
Fabric: ${garment.fabric || 'unknown'}
Fit: ${garment.fit || 'unknown'}
Size chart: ${JSON.stringify(garment.sizeChart || [])}
Client: height ${measurements.heightCm}cm, weight ${measurements.weightKg}kg, chest ${measurements.chestIn}in, waist ${measurements.waistIn}in, hip ${measurements.hipIn}in. Fit preference: ${measurements.fitPreference}`
    try {
      const resp = await textAI.models.generateContent({
        model: TEXT_MODEL,
        contents: [{ role: 'user', parts: [{ text: userContent }] }],
        config: { systemInstruction: sizeSystemPrompt(), responseMimeType: 'application/json' },
      })
      const parsed = extractJson(resp.text ?? '')
      if (!parsed || !parsed.size) throw new Error('Could not parse size response')
      return res.json(parsed)
    } catch (err) {
      return res.json(recommendSize(measurements, garment.sizeChart || []))
    }
  }

  // BYO-garment path: use garment image + optional pasted size chart text
  if (!garmentImageBase64) {
    return res.status(400).json({ error: 'garmentImageBase64 is required for image-based sizing.' })
  }

  if (!textAI) {
    return res.json({ size: 'M', confidence: 'low', explanation: 'Size assistant unavailable — add your measurements and try again.', caveat: 'No AI key configured.' })
  }

  const m = /^data:(.+);base64,(.*)$/.exec(garmentImageBase64)
  const mimeType = m ? m[1] : 'image/jpeg'
  const base64Data = m ? m[2] : garmentImageBase64

  const sizeText = `Garment name: ${garmentName || 'unknown'}${sizeChartText ? `\nRetailer size chart (pasted by user):\n${sizeChartText}` : '\nNo size chart provided — infer from the garment image.'}

Client measurements: height ${measurements.heightCm}cm, weight ${measurements.weightKg}kg, chest ${measurements.chestIn}in, waist ${measurements.waistIn}in, hip ${measurements.hipIn}in. Fit preference: ${measurements.fitPreference}.`

  try {
    const resp = await textAI.models.generateContent({
      model: TEXT_MODEL,
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType, data: base64Data } },
          { text: sizeText },
        ],
      }],
      config: { systemInstruction: sizeImageSystemPrompt(), responseMimeType: 'application/json' },
    })
    const parsed = extractJson(resp.text ?? '')
    if (!parsed || !parsed.size) throw new Error('Could not parse size response')
    return res.json(parsed)
  } catch (err) {
    if (isRateLimit(err)) {
      console.info('[Atelier] Size: rate limit hit.')
    } else {
      console.error('[Atelier] Size (image) failed:', err.message)
    }
    return res.json({ size: 'M', confidence: 'low', explanation: 'Could not analyse the garment image — try pasting the size chart below for a better result.', caveat: 'AI analysis unavailable right now.' })
  }
})

// ---------------------------------------------------------------------------
// POST /api/verdict — "Should I Buy It?"
// ---------------------------------------------------------------------------
app.post('/api/verdict', async (req, res) => {
  const { garmentImageBase64, userPhotoBase64, measurements, palette, garmentName, garmentBrand, garmentDescription } = req.body || {}

  if (!garmentImageBase64) {
    return res.status(400).json({ error: 'garmentImageBase64 is required.' })
  }

  const textAI = textAIClient()
  if (!textAI) {
    return res.json({
      call: 'Maybe',
      verdict: 'Style assistant is unavailable right now.',
      whyItWorks: 'Unable to analyse — no AI key configured.',
      theCatch: '—',
      wearItWith: '—',
    })
  }

  const garmentM = /^data:(.+);base64,(.*)$/.exec(garmentImageBase64)
  const parts = [
    { inlineData: { mimeType: garmentM ? garmentM[1] : 'image/jpeg', data: garmentM ? garmentM[2] : garmentImageBase64 } },
  ]
  if (userPhotoBase64) {
    const userM = /^data:(.+);base64,(.*)$/.exec(userPhotoBase64)
    parts.push({ inlineData: { mimeType: userM ? userM[1] : 'image/jpeg', data: userM ? userM[2] : userPhotoBase64 } })
  }

  const contextLines = []
  if (garmentName) contextLines.push(`Garment: ${garmentName}`)
  if (garmentBrand) contextLines.push(`Brand: ${garmentBrand}`)
  if (garmentDescription) contextLines.push(`Description: ${garmentDescription}`)
  if (measurements) contextLines.push(`Client measurements: height ${measurements.heightCm}cm, weight ${measurements.weightKg}kg, chest ${measurements.chestIn}in, waist ${measurements.waistIn}in, hip ${measurements.hipIn}in, fit preference: ${measurements.fitPreference}.`)
  if (palette) contextLines.push(`Client colour profile: ${palette.season}, ${palette.undertone} undertone. Flattering colours: ${palette.flatteringColors?.map(c => c.name).join(', ')}.`)
  if (userPhotoBase64) contextLines.push('A photo of the client is provided as the second image — read their colouring and proportions directly from it.')
  if (contextLines.length === 0) contextLines.push('No client profile provided — judge purely by the garment itself.')
  parts.push({ text: contextLines.join('\n') })

  try {
    const resp = await textAI.models.generateContent({
      model: TEXT_MODEL,
      contents: [{ role: 'user', parts }],
      config: { systemInstruction: verdictSystemPrompt(), responseMimeType: 'application/json' },
    })
    const parsed = extractJson(resp.text ?? '')
    if (!parsed || !parsed.call) throw new Error('Could not parse verdict response')
    return res.json(parsed)
  } catch (err) {
    if (isRateLimit(err)) {
      console.info('[Atelier] Verdict: rate limit hit.')
    } else {
      console.error('[Atelier] Verdict failed:', err.message)
    }
    return res.json({
      call: 'Maybe',
      verdict: 'The assistant is busy — try again in a moment.',
      whyItWorks: '—',
      theCatch: '—',
      wearItWith: '—',
    })
  }
})

// ---------------------------------------------------------------------------
// POST /api/garment/from-url — extract garment image and metadata from any URL
// ---------------------------------------------------------------------------
app.post('/api/garment/from-url', async (req, res) => {
  const { url } = req.body || {}
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url is required.' })
  }
  if (await domainBlocked(url)) {
    return res.json({
      imageBase64: '',
      blocked: true,
      error: 'Links from this site aren\'t supported — screenshot the piece and upload it instead.',
    })
  }

  const TIMEOUT_MS = 8000
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

  let html = ''
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    const pageRes = await safeFetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (!pageRes.ok) throw new Error(`Page responded ${pageRes.status}`)

    // If the URL points directly at an image, use it as-is instead of scraping HTML.
    const contentType = pageRes.headers.get('content-type')?.split(';')[0]?.trim() || ''
    if (contentType.startsWith('image/')) {
      const buf = Buffer.from(await pageRes.arrayBuffer())
      const imageBase64 = `data:${contentType};base64,${buf.toString('base64')}`
      let name
      try { name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || undefined } catch {}
      return res.json({ imageBase64, name })
    }

    html = await pageRes.text()
  } catch (err) {
    console.info(`[Atelier] garment/from-url: could not fetch ${url}: ${err.message}`)
    if (err instanceof UnsafeUrlError) {
      return res.status(400).json({ imageBase64: '', error: 'That link can’t be opened — paste a link to a public product page.' })
    }
    return res.json({
      imageBase64: '',
      error: `I couldn't reach that page — drop me a screenshot of the piece instead and I'll take it from there.`,
    })
  }

  // --- Extract image URL via fallback chain ---
  let imageUrl = ''

  // 1. OG / Twitter image meta tags
  const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
  if (ogMatch) imageUrl = ogMatch[1]

  if (!imageUrl) {
    const twMatch = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i)
    if (twMatch) imageUrl = twMatch[1]
  }

  // 2. JSON-LD Product schema
  if (!imageUrl) {
    const ldMatches = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    for (const m of ldMatches) {
      try {
        const data = JSON.parse(m[1])
        const items = Array.isArray(data) ? data : [data]
        for (const item of items) {
          const t = item['@type']
          if (t === 'Product' || (Array.isArray(t) && t.includes('Product'))) {
            const img = Array.isArray(item.image) ? item.image[0] : item.image
            if (img && typeof img === 'string') { imageUrl = img; break }
          }
        }
        if (imageUrl) break
      } catch {}
    }
  }

  // 3. Other well-known image hints: link rel=image_src / preload, itemprop=image
  if (!imageUrl) {
    const linkMatch = html.match(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i)
      || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']image_src["']/i)
      || html.match(/<link[^>]+rel=["']preload["'][^>]+as=["']image["'][^>]+href=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+itemprop=["']image["'][^>]+content=["']([^"']+)["']/i)
    if (linkMatch) imageUrl = linkMatch[1]
  }

  // 4. Largest <img> on page (by src string heuristic: prefer large/product/hero in path)
  if (!imageUrl) {
    const imgMatches = [
      ...html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi),
      ...html.matchAll(/<(?:img|source)[^>]+srcset=["']([^"'\s,]+)[^"']*["'][^>]*>/gi),
    ]
    const scored = imgMatches
      .map((m) => ({ src: m[1], score: /product|hero|main|large|zoom|full|pdp|featured/i.test(m[1]) ? 2 : m[1].match(/\d{3,}x\d{3,}/) ? 1 : 0 }))
      .sort((a, b) => b.score - a.score)
    if (scored[0]) imageUrl = scored[0].src
  }

  // 5. Last resort: any product-image-looking URL embedded in the raw HTML/JSON state.
  //    Catches SPA pages that inline image URLs in a __NEXT_DATA__ / preloaded-state blob.
  if (!imageUrl) {
    const raw = [...html.matchAll(/https?:\\?\/\\?\/[^"'\\\s)]+?\.(?:jpg|jpeg|png|webp)(?:\?[^"'\\\s)]*)?/gi)]
      .map((m) => m[0].replace(/\\\//g, '/'))
    const scored = raw
      .map((src) => ({ src, score: /product|media|image|cdn|catalog|large|zoom|hero/i.test(src) ? 2 : 1 }))
      .filter((x) => !/sprite|logo|icon|favicon|placeholder|thumb/i.test(x.src))
      .sort((a, b) => b.score - a.score)
    if (scored[0]) imageUrl = scored[0].src
  }

  if (!imageUrl) {
    // Distinguish a bot wall (Akamai / Cloudflare / PerimeterX interstitial) from a
    // page we simply couldn't parse — the user's next step is different.
    const blocked = /bm-verify|_sec\/verify|interstitial|akamai|perimeterx|px-captcha|captcha|cf-browser-verification|Just a moment|Attention Required|enable JavaScript/i.test(html)
      || html.length < 3000
    let host = 'This site'
    try { host = new URL(url).hostname.replace(/^www\./, '') } catch {}
    console.info(`[Atelier] garment/from-url: no image extracted from ${url} (${blocked ? 'bot-wall/empty shell' : 'no image tags'}, ${html.length}b)`)
    return res.json({
      imageBase64: '',
      blocked,
      error: blocked
        ? `${host} blocks automatic previews (bot protection), so I can't pull the image from the link. Screenshot the piece and upload it — that works perfectly.`
        : `I couldn't find the product image on that page — drop me a screenshot of the piece instead and I'll take it from there.`,
    })
  }

  // Resolve relative URLs
  try {
    imageUrl = new URL(imageUrl, url).href
  } catch {}

  // Download the image server-side to avoid CORS
  let imageBase64 = ''
  let mimeType = 'image/jpeg'
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    const imgRes = await safeFetch(imageUrl, { headers: { 'User-Agent': UA }, signal: ctrl.signal })
    clearTimeout(timer)
    if (!imgRes.ok) throw new Error(`Image responded ${imgRes.status}`)
    mimeType = imgRes.headers.get('content-type')?.split(';')[0] || 'image/jpeg'
    const buf = Buffer.from(await imgRes.arrayBuffer())
    imageBase64 = `data:${mimeType};base64,${buf.toString('base64')}`
  } catch (err) {
    console.info(`[Atelier] garment/from-url: could not download image ${imageUrl}: ${err.message}`)
    return res.json({
      imageBase64: '',
      error: `I couldn't reach that page — drop me a screenshot of the piece instead and I'll take it from there.`,
    })
  }

  // Extract metadata
  const metaContent = (name) => {
    const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'))
      || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${name}["']`, 'i'))
    return m ? m[1].trim() : undefined
  }

  const name = metaContent('og:title') || metaContent('twitter:title') || undefined
  const description = metaContent('og:description') || metaContent('twitter:description') || undefined

  // Try JSON-LD for brand/price
  let brand, price
  const ldMatches = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
  for (const m of ldMatches) {
    try {
      const data = JSON.parse(m[1])
      const items = Array.isArray(data) ? data : [data]
      for (const item of items) {
        const t = item['@type']
        if (t === 'Product' || (Array.isArray(t) && t.includes('Product'))) {
          if (item.brand?.name) brand = item.brand.name
          if (item.offers) {
            const offer = Array.isArray(item.offers) ? item.offers[0] : item.offers
            if (offer?.price) price = `${offer.price}${offer.priceCurrency ? ' ' + offer.priceCurrency : ''}`
          }
          break
        }
      }
      if (brand || price) break
    } catch {}
  }

  // Extract size chart text — look for common size-guide patterns in the page HTML
  let sizeChartText
  try {
    // 1. Tables whose headers mention sizing (XS/S/M/L/XL, chest, waist, shoulder, UK/EU/US sizes)
    const sizeTableRx = /<table[^>]*>([\s\S]*?)<\/table>/gi
    const tables = [...html.matchAll(sizeTableRx)]
    for (const tm of tables) {
      const thtml = tm[1]
      if (/\b(XS|S\/M|X?XL|chest|waist|hip|shoulder|bust|inseam|EU\s*\d|UK\s*\d|US\s*\d|\bsize\b)/i.test(thtml)) {
        // Strip tags, normalise whitespace
        const text = thtml.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim()
        if (text.length > 20 && text.length < 2000) { sizeChartText = text; break }
      }
    }
    // 2. Sections / divs with sizing keywords in class or id
    if (!sizeChartText) {
      const sectionRx = /<(?:section|div)[^>]+(?:class|id)=["'][^"']*size[^"']*["'][^>]*>([\s\S]{20,800}?)<\/(?:section|div)>/gi
      const sm = sectionRx.exec(html)
      if (sm) {
        const text = sm[1].replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim()
        if (text.length > 20) sizeChartText = text
      }
    }
    // 3. JSON-LD additionalProperty for size guide
    if (!sizeChartText) {
      for (const m of ldMatches) {
        try {
          const data = JSON.parse(m[1])
          const items = Array.isArray(data) ? data : [data]
          for (const item of items) {
            const props = item.additionalProperty || []
            const sg = props.find(p => /size/i.test(p.name || ''))
            if (sg?.value) { sizeChartText = String(sg.value); break }
          }
        } catch {}
        if (sizeChartText) break
      }
    }
  } catch {}

  return res.json({ imageBase64, name, brand, price, description, sizeChartText })
})

// ---------------------------------------------------------------------------
// POST /api/safety/check — classify garment for revealing content
// ---------------------------------------------------------------------------
const BLOCKED_KEYWORDS = [
  'lingerie','bikini','underwear','swimwear','swimsuit','thong','bra','panties',
  'g-string','g string','knicker','negligee','bodysuit sheer','sheer bodysuit',
  'see-through','see through','transparent','nipple','corset','pasties',
  'bathing suit','swimwear','one-piece swim','trunks','speedo','boardshort',
]

app.post('/api/safety/check', async (req, res) => {
  const { imageBase64, name = '', description = '' } = req.body || {}
  const combined = `${name} ${description}`.toLowerCase()

  // 1. Keyword screen — fast, no API call needed
  const hit = BLOCKED_KEYWORDS.find(kw => combined.includes(kw))
  if (hit) {
    return res.json({
      safe: false,
      reason: "This piece isn't supported for virtual try-on. We focus on outerwear, tops, bottoms, dresses, and accessories.",
    })
  }

  // 2. Vision check — ask Gemini to classify the garment
  const textAI = textAIClient()
  if (!textAI || !imageBase64) return res.json({ safe: true })

  try {
    const m = /^data:(.+);base64,(.*)$/.exec(imageBase64)
    const resp = await textAI.models.generateContent({
      model: TEXT_MODEL,
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: m ? m[1] : 'image/jpeg', data: m ? m[2] : imageBase64 } },
          { text: 'Classify this garment image. Reply with JSON only: {"safe": true} if it is regular clothing (outerwear, tops, bottoms, dresses, shoes, accessories, activewear). Reply with {"safe": false, "reason": "<one sentence>"} if it is lingerie, underwear, swimwear, bikini, or explicitly revealing/sheer garments. When uncertain, reply {"safe": true}.' },
        ],
      }],
      config: { responseMimeType: 'application/json' },
    })
    const parsed = extractJson(resp.text ?? '')
    if (parsed && typeof parsed.safe === 'boolean') return res.json(parsed)
  } catch (err) {
    console.warn('[Atelier] Safety check failed, defaulting to safe:', err.message)
  }

  return res.json({ safe: true })
})

// ---------------------------------------------------------------------------
// POST /api/tryon
// ---------------------------------------------------------------------------
app.post('/api/tryon', async (req, res) => {
  if (embedFeatureBlocked(req, res, 'virtual_tryon')) return
  const {
    userPhotoBase64,
    garmentImageBase64,
    garmentImageUrl,
    garmentColor,
    garmentColorHex,
    garmentName,
    productId,
    forceLive,
  } = req.body || {}

  // ── DEBUG_TRYON: skip the paid image API entirely. Return an instant stub
  //    (the garment/user image, labelled DEBUG on the client). No Gemini call,
  //    no credit, no membership gate. Size & verdict are unaffected — they have
  //    their own endpoints and always call the real (free-tier) API.
  if ((process.env.DEBUG_TRYON ?? 'false') === 'true') {
    const stub = garmentImageBase64 || garmentImageUrl || userPhotoBase64 || null
    console.log('[Atelier] /api/tryon: DEBUG STUB returned — no Gemini image call, no credit consumed')
    return res.json({
      image: stub,
      debug: true,
      demo: false,
      credits: null,
      membership: null,
      message: 'Debug stub — no try-on image was generated.',
    })
  }

  const charge = await chargeCredits(req, res, 'tryon')
  if (!charge.ok) return

  // Consumer membership gate. Skipped for the B2B companyId credit flow, and for
  // anonymous requests without a token (e.g. the web demo). The mobile app always
  // sends the signed-in user's token, so it is always gated. A token that is
  // present but invalid is rejected rather than silently treated as anonymous.
  const isCompanyFlow = charge.credits !== null
  const hasToken = /^Bearer\s+/i.test(req.headers.authorization || '')
  let member = null
  if (!isCompanyFlow && membershipEnabled() && hasToken) {
    member = await getUserFromRequest(req)
    if (!member) {
      return res.status(401).json({
        fallback: true,
        message: 'Your session expired — please sign in again to keep trying things on.',
        error: { status: 401, type: 'InvalidToken', message: 'Invalid or expired Supabase token.' },
      })
    }
  }

  // B2B company login → spends the company's shared credit pool (not the login's
  // personal B2C balance) and honours the company's feature toggle + status.
  let company = null
  if (member) {
    try {
      company = await getClientContext(member.id)
    } catch (err) {
      console.error('[Atelier] /api/tryon: company lookup failed:', err.message)
      return res.status(503).json({
        fallback: true,
        message: ATELIER_BUSY_MESSAGE,
        error: { status: 503, type: 'CompanyLookupFailed', message: err.message },
      })
    }
    const blocked = company && clientBlockedMessage(company, 'tryon')
    if (blocked) return res.status(403).json({ fallback: true, error: blocked, message: blocked })
  }

  // The iPad this request came from (unregistered devices are fine — the number
  // of iPads never blocks a session; only a device the admin blocked does).
  const device = company ? await findDevice(company.clientId, deviceKeyFromRequest(req)) : null
  if (device?.status === 'blocked') {
    const msg = 'This iPad has been blocked — contact your Atelier admin.'
    return res.status(403).json({ fallback: true, error: msg, message: msg })
  }

  const demoMode = (process.env.DEMO_MODE ?? 'true') !== 'false'

  if (demoMode && productId && !forceLive && !garmentImageUrl) {
    const pngPath = path.join(TRYON_DIR, `${productId}.png`)
    if (fs.existsSync(pngPath)) {
      return res.json({ image: `/tryon/${productId}.png`, demo: true, credits: charge.credits })
    }
  }

  if (!userPhotoBase64) {
    console.info('[Atelier] /api/tryon called without a user photo — refusing to generate.')
    return res.status(400).json({
      fallback: true,
      message: 'Add a photo to your profile so I can fit this to you.',
      error: { status: 400, type: 'MissingUserPhoto', message: 'userPhotoBase64 was not provided.' },
    })
  }

  const ai = geminiClient()
  if (!ai) {
    console.info('[Atelier] GEMINI_API_KEY not set — try-on cannot run live.')
    return res.json({
      fallback: true,
      message: ATELIER_BUSY_MESSAGE,
      error: { status: null, type: 'MissingApiKey', message: 'GEMINI_API_KEY is not set.' },
    })
  }

  if (!garmentImageBase64 && !garmentImageUrl) {
    return res.status(400).json({
      fallback: true,
      message: ATELIER_BUSY_MESSAGE,
      error: { status: 400, type: 'MissingGarmentImage', message: 'garmentImageBase64 or garmentImageUrl was not provided.' },
    })
  }

  let resolvedGarmentBase64 = garmentImageBase64
  if (!resolvedGarmentBase64 && garmentImageUrl) {
    try {
      resolvedGarmentBase64 = await fetchGarmentAsDataUrl(garmentImageUrl)
    } catch (err) {
      return res.status(502).json({
        fallback: true,
        message: ATELIER_BUSY_MESSAGE,
        error: {
          status: 502,
          type: 'GarmentFetchFailed',
          message: err instanceof Error ? err.message : 'Failed to fetch garment image',
        },
      })
    }
  }

  const userPhoto = describeDataUrl(userPhotoBase64)
  const garmentImage = describeDataUrl(resolvedGarmentBase64)
  console.log(
    `[Atelier] /api/tryon: user photo (${userPhoto.mimeType}, ${userPhoto.bytes} bytes), garment (${garmentImage.mimeType}, ${garmentImage.bytes} bytes), product=${productId || 'n/a'}`,
  )

  // Reserve one try-on against the free-tier limit before spending compute.
  // Refunded below if generation ultimately fails, so failures never burn a credit.
  let reservation = null
  if (company) {
    let spend
    try {
      spend = await consumeClientCredit(company.clientId, { feature: 'tryon', deviceId: device?.id ?? null })
    } catch (err) {
      console.error('[Atelier] consumeClientCredit failed:', err.message)
      return res.status(503).json({
        fallback: true,
        message: ATELIER_BUSY_MESSAGE,
        error: { status: 503, type: 'CreditCheckFailed', message: err.message },
      })
    }
    if (!spend.allowed) {
      console.info(`[Atelier] /api/tryon: company ${company.clientId} refused (${spend.reason})`)
      if (spend.reason === 'no_credits') {
        return res.status(402).json({
          fallback: true,
          paywall: true,
          message: 'Credits used up — upgrade your plan or add credits.',
          client: { creditsBalance: 0 },
        })
      }
      const msg = spend.reason === 'trial_ended'
        ? 'Your free trial has ended — contact Atelier to choose a plan.'
        : spend.reason === 'expired'
          ? 'Your plan has expired — contact Atelier to renew.'
          : 'Your account is paused — contact Atelier support.'
      return res.status(403).json({ fallback: true, error: msg, message: msg, reason: spend.reason })
    }
    company.creditsBalance = spend.creditsBalance
  } else if (member) {
    try {
      reservation = await reserveTryOn(member.id)
    } catch (err) {
      // Fail open (e.g. migration not yet applied) so paying users aren't blocked.
      console.error('[Atelier] reserveTryOn failed — allowing this try-on:', err.message)
      reservation = { allowed: true, membership: null }
    }
    if (!reservation.allowed) {
      console.info(`[Atelier] /api/tryon: out of credits for ${member.id}`)
      return res.status(402).json({
        fallback: true,
        paywall: true,
        message: "You're out of credits. Buy more to keep generating — ₹15 for one, or a credit pack.",
        membership: reservation.membership,
      })
    }
  }

  try {
    const { image, model } = await runTryOnGeneration(ai, IMAGE_MODEL, {
      userPhotoBase64,
      resolvedGarmentBase64,
      garmentName,
      garmentColor,
      garmentColorHex,
    })
    console.log(`[Atelier] /api/tryon: success with ${model}`)
    return res.json({
      image,
      model, // which Gemini image model produced it (shown in the app's console)
      demo: false,
      credits: charge.credits,
      membership: reservation?.membership ?? null,
      client: company ? { creditsBalance: company.creditsBalance } : null,
    })
  } catch (err) {
    if (company) await refundClientCredit(company.clientId, { feature: 'tryon', deviceId: device?.id ?? null })
    else if (member) await refundTryOn(member.id)
    const errorInfo = describeGeminiError(err)
    const friendly = tryOnUserMessage(err)
    console.error('[Atelier] Try-on generation failed:', errorInfo, err?.modelText ? `model: ${err.modelText}` : '')
    if (/billing|quota|permission|PERMISSION_DENIED|RESOURCE_EXHAUSTED/i.test(String(errorInfo.message))) {
      console.error(
        '[Atelier] Hint: ensure billing is enabled on your Google AI Studio / Cloud project for image-generation models.',
      )
    }
    return res.json({
      fallback: true,
      message: friendly ?? ATELIER_BUSY_MESSAGE,
      error: errorInfo,
    })
  }
})

// On Vercel (serverless) the platform invokes the exported Express `app` as the
// request handler — there is no long-running listener, so we skip app.listen().
// Locally (and on any Node host) we bind the port as usual.
if (!process.env.VERCEL) {
  // Bind 0.0.0.0 so platforms like Render can route external traffic to the port.
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Atelier] API server listening on http://0.0.0.0:${PORT}`)
    if (!process.env.GEMINI_TEXT_API_KEY) {
      console.error('[Atelier] ⚠️  MISSING: GEMINI_TEXT_API_KEY — Size, Style & Color features will return "AI unavailable" fallbacks.')
    } else {
      console.log(`[Atelier] GEMINI_TEXT_API_KEY loaded (model: ${TEXT_MODEL})`)
    }
    if (!process.env.GEMINI_API_KEY) {
      console.error('[Atelier] ⚠️  MISSING: GEMINI_API_KEY — Virtual Try-On will fail.')
    } else {
      console.log(`[Atelier] GEMINI_API_KEY loaded (IMAGE_QUALITY=${IMAGE_QUALITY}, model: ${IMAGE_MODEL})`)
    }
  })
}

// Exported so a Vercel serverless function (api/index.mjs) can mount the whole API.
export default app
