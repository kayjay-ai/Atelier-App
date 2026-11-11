import { startApp, post, get, routeList } from './helpers.mjs'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

// The API's public surface. Adding or removing a route should be a deliberate
// change to this list (the deployed apps call these paths).
const ROUTES = [
  'POST /api/payments/webhook', 'GET /', 'GET /api/health', 'GET /health',
  'GET /api/credits', 'GET /api/membership', 'POST /api/events', 'POST /api/auth/account-type', 'POST /api/account/delete',
  'GET /api/payments/pricing', 'POST /api/payments/create', 'GET /api/payments/status/:orderId',
  'POST /api/embed/session', 'POST /api/embed/refresh', 'GET /api/embed/me', 'GET /api/embed/config',
  'GET /api/embed/history', 'POST /api/embed/history', 'GET /api/partner/users/:externalUserId/history',
  'POST /api/b2b/session', 'POST /api/b2b/notice/:id/dismiss', 'GET /api/b2b/billing', 'POST /api/b2b/payments',
  'GET /api/b2b/payments/:orderId', 'GET /legal/b2b-terms', 'GET /pay/b2b/checkout', 'GET /pay/b2b/return',
  'POST /api/jobs/daily', 'POST /api/admin/notify', 'POST /api/admin/owner-notify',
  // Owner portal + the store manager's invite link (routes/owner.mjs)
  'POST /api/owner/activate/verify', 'POST /api/owner/forgot', 'POST /api/owner/otp/resend', 'POST /api/owner/otp/confirm',
  'POST /api/owner/token/status', 'POST /api/owner/password', 'POST /api/owner/login', 'POST /api/owner/logout',
  'GET /api/owner/me', 'GET /api/owner/dashboard/summary', 'GET /api/owner/stores', 'GET /api/owner/stores/:id',
  'POST /api/owner/stores', 'POST /api/owner/stores/:id/invite/resend', 'GET /api/owner/stores/:id/invite/link',
  'PATCH /api/owner/stores/:id/invite', 'DELETE /api/owner/stores/:id/invite', 'DELETE /api/owner/stores/:id',
  'POST /api/owner/stores/:id/deactivate', 'GET /api/owner/profile', 'PATCH /api/owner/profile',
  'POST /api/owner/profile/password', 'GET /api/owner/sessions', 'DELETE /api/owner/sessions',
  'GET /api/owner/notifications', 'GET /api/owner/notifications/unread-count', 'POST /api/owner/notifications/read-all',
  'PATCH /api/owner/notifications/:id', 'DELETE /api/owner/notifications/:id',
  'GET /api/invites/:token', 'POST /api/invites/:token/accept',
  'POST /api/style', 'POST /api/color', 'POST /api/size', 'POST /api/verdict', 'POST /api/safety/check',
  'POST /api/garment/from-url', 'POST /api/tryon',
]

test('serves exactly the expected routes', async () => {
  assert.deepEqual((await routeList()).sort(), [...ROUTES].sort())
})

let app
before(async () => { app = await startApp() })
after(async () => { await app.close() })

test('no route crashes on an empty, unauthenticated request', async () => {
  for (const r of ROUTES) {
    const [method, rawPath] = r.split(' ')
    if (rawPath === '/api/garment/from-url') continue // would fetch a URL
    const path = rawPath.replace(/:[A-Za-z]+/g, 'x')
    const res = method === 'GET' ? await get(app.url, path) : await post(app.url, path, {})
    assert.ok(res.status < 500, `${r} → ${res.status} ${JSON.stringify(res.body)}`)
  }
})

test('health', async () => {
  const r = await get(app.url, '/api/health')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
})

test('terms page is served', async () => {
  const res = await fetch(`${app.url}/legal/b2b-terms`)
  assert.equal(res.status, 200)
  assert.match(await res.text(), /<html/i)
})

test('malformed JSON gets a JSON 400', async () => {
  const res = await fetch(`${app.url}/api/style`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' })
  assert.equal(res.status, 400)
  assert.equal((await res.json()).error, 'Malformed JSON body.')
})

test('webhook rejects an unsigned call', async () => {
  const res = await fetch(`${app.url}/api/payments/webhook`, { method: 'POST', body: '{}' })
  assert.equal(res.status, 401)
})

test('signed-in-only routes refuse anonymous callers', async () => {
  assert.equal((await get(app.url, '/api/b2b/billing')).status, 401)
  assert.equal((await post(app.url, '/api/b2b/session', {})).status, 401)
  assert.equal((await post(app.url, '/api/account/delete', {})).status, 401)
})
