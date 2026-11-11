import express from 'express'
import { domainOf } from './lib/safeFetch.mjs'
import { logUsage } from './lib/usage.mjs'
import { logAppEvent } from './lib/clients.mjs'
import { callerOf } from './lib/identity.mjs'
import accountRoutes from './routes/account.mjs'
import paymentsRoutes, { webhookHandler } from './routes/payments.mjs'
import embedRoutes from './routes/embed.mjs'
import b2bRoutes from './routes/b2b.mjs'
import aiRoutes from './routes/ai.mjs'
import adminRoutes from './routes/admin.mjs'
import ownerRoutes from './routes/owner.mjs'

// =============================================================================
// The Express app: shared middleware, then one route module per area.
//   routes/account.mjs   membership, partner credit status, sign-in helpers, events, delete account
//   routes/payments.mjs  B2C credit packs + the Cashfree webhook (lib/payments.mjs)
//   routes/embed.mjs     website-embed SSO, history, partner API
//   routes/b2b.mjs       store app session, notices, Plan & Credits, iPad checkout pages
//   routes/ai.mjs        style, colour, size, verdict, safety, garment-from-link, try-on
//   routes/admin.mjs     daily job, admin notifications (shared-secret endpoints)
//   routes/owner.mjs     owner portal (/api/owner/*) and the store manager's invite link
// Who is calling is worked out once per request: lib/identity.mjs.
// =============================================================================

// CORS: the web app and this API are on different origins, so the browser blocks
// calls unless we echo an allowed Origin. Localhost covers dev; production
// origins come from CORS_ALLOWED_ORIGINS (comma-separated), no code change needed.
const DEV_ORIGINS = [
  'http://localhost:5173', // Vite web app
  'http://localhost:5174', // alternate web port
  'http://localhost:8081', // Expo web
  'http://localhost:8082',
  'http://localhost:5199', // VERVE retail demo
]

// One usage_events row per AI feature call, written after the response is sent
// so it never slows or breaks the feature. Status comes from the response:
// every AI route marks a fallback with `fallback: true` (lib/ai.mjs).
const FEATURE_ROUTES = {
  '/api/style': 'style',
  '/api/color': 'color',
  '/api/size': 'size',
  '/api/verdict': 'verdict',
  '/api/tryon': 'tryon',
  '/api/garment/from-url': 'garment_from_url',
}
const INPUT_SOURCES = new Set(['link', 'screenshot', 'upload', 'gallery', 'camera', 'catalog'])

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
    const { user, store, device } = await callerOf(req)
    const sourceUrl = feature === 'garment_from_url' ? rb.url : (rb.productUrl || rb.garmentImageUrl || null)
    const source = INPUT_SOURCES.has(rb.inputSource) ? rb.inputSource
      : feature === 'garment_from_url' ? 'link'
      : rb.productId ? 'catalog'
      : rb.garmentImageUrl ? 'link'
      : null

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
        ...(body.fallbackReason ? { fallbackReason: body.fallbackReason } : {}),
      },
      columns: {
        channel: store ? 'b2b' : 'b2c',
        company_id: store?.companyId ?? null,
        store_id: store?.clientId ?? null,
        device_id: device?.id ?? null,
        credits_used: feature === 'tryon' && status === 'success' ? 1 : 0,
        brand: rb.garmentBrand || body.brand || null,
        source,
        source_url: typeof sourceUrl === 'string' ? sourceUrl.slice(0, 1000) : null,
        domain: typeof sourceUrl === 'string' ? domainOf(sourceUrl) : null,
      },
    })

    if (code === 402) {
      await logAppEvent({
        event: 'credit_limit_hit', userId: user?.id, clientId: store?.clientId,
        companyId: store?.companyId, deviceId: device?.id, metadata: { feature },
      })
    }
  } catch (err) {
    console.warn('[Atelier] recordUsage failed:', err?.message)
  }
}

export function createApp() {
  const app = express()
  const allowedOrigins = [
    ...DEV_ORIGINS,
    ...(process.env.CORS_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  ]

  app.use((req, res, next) => {
    const origin = req.headers.origin
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Atelier-Device')
    if (req.method === 'OPTIONS') return res.sendStatus(204)
    next()
  })

  // The webhook needs the RAW body (its signature covers the exact bytes), so it
  // is registered before express.json().
  app.post('/api/payments/webhook', express.raw({ type: '*/*', limit: '2mb' }), webhookHandler)

  app.use(express.json({ limit: '25mb' }))

  // Request log: every route, every status.
  app.use((req, res, next) => {
    const start = Date.now()
    res.on('finish', () => {
      const ms = Date.now() - start
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'log'
      console[level](`[Atelier] ${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`)
    })
    next()
  })

  app.use((req, res, next) => {
    const feature = req.method === 'POST' ? FEATURE_ROUTES[req.path] : null
    if (!feature) return next()
    const json = res.json.bind(res)
    res.json = (body) => { res.locals.responseBody = body; return json(body) }
    res.on('finish', () => { recordUsage(req, res, feature) })
    next()
  })

  app.get('/', (_req, res) => res.redirect('/api/health'))
  app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }))
  // Plain /health for platform health checks (and quick "is it alive?" curls).
  app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }))

  app.use(accountRoutes)
  app.use(paymentsRoutes)
  app.use(embedRoutes)
  app.use(b2bRoutes)
  app.use(adminRoutes)
  app.use(ownerRoutes)
  app.use(aiRoutes)

  // Errors thrown synchronously or passed to next(err) (e.g. a malformed JSON
  // body): answer with JSON instead of Express's HTML error page.
  app.use((err, _req, res, _next) => {
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body.' })
    console.error('[Atelier] unhandled route error:', err?.message)
    if (!res.headersSent) res.status(500).json({ error: 'Something went wrong — please try again.' })
  })

  return app
}
