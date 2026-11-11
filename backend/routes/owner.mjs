import express from 'express'
import { ownerOf } from '../lib/identity.mjs'
import { clientIp } from '../lib/rateLimit.mjs'
import {
  OwnerError, startVerification, resendCode, confirmCode, tokenStatus, setPassword, login, logout,
  getProfile, updateProfile, changePassword, listSessions, revokeOtherSessions,
} from '../lib/ownerAuth.mjs'
import {
  summary, queryStores, storeDetail, addStore, resendInvite, inviteLink, changeInviteEmail,
  removeInvitedStore, deactivateStore, readInvite, acceptInvite,
} from '../lib/ownerStores.mjs'
import { listNotifications, unreadCount, setRead, markAllRead, deleteNotification } from '../lib/ownerNotify.mjs'

// The owner portal (lib/ownerAuth.mjs, lib/ownerStores.mjs, lib/ownerNotify.mjs)
// and the store manager's invite page. Signed-in owner routes resolve the
// caller with ownerOf(req) (lib/identity.mjs) and only ever touch the owner's
// own organization.
const router = express.Router()
export default router

const appBaseOf = (req) => (process.env.APP_PUBLIC_URL || req.headers.origin || 'http://localhost:8081').replace(/\/$/, '')
const clientOf = (req) => ({ ip: clientIp(req), userAgent: String(req.headers['user-agent'] ?? '').slice(0, 400) })

function fail(res, err, what) {
  if (res.headersSent) return
  if (err instanceof OwnerError) return res.status(err.status).json({ error: err.message, code: err.code, ...err.extra })
  console.error(`[Atelier] ${what} failed:`, err?.message)
  return res.status(500).json({ error: 'Something went wrong — please try again.' })
}

/** A route that answers with whatever `fn` returns (or { ok: true }). */
const route = (what, fn) => async (req, res) => {
  try {
    const out = await fn(req, res)
    if (!res.headersSent) res.json(out ?? { ok: true })
  } catch (err) {
    fail(res, err, what)
  }
}

/** A route for a signed-in owner: `fn(ctx, req, res)`. */
const ownerRoute = (what, fn) => route(what, async (req, res) => {
  const { ctx, reason, error } = await ownerOf(req)
  if (!ctx) {
    if (reason === 'error') {
      console.error('[Atelier] owner session check failed:', error?.message)
      return void res.status(503).json({ error: 'The owner portal is not available right now. Try again shortly.', code: 'unavailable' })
    }
    return void res.status(401).json({ error: 'Your session expired. Sign in again.', code: 'session_expired' })
  }
  if (ctx.company.status === 'inactive') {
    return void res.status(403).json({ error: 'Your organization’s Atelier access is paused — contact Atelier support.', code: 'company_inactive' })
  }
  return fn(ctx, req, res)
})

const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {})
const purposeOf = (p) => (p === 'reset' ? 'reset' : 'activation')

// ── Activation, login, forgot password ───────────────────────────────────────
// Screen A. Body: { org_code (or code), email }.
router.post('/api/owner/activate/verify', route('owner verify', (req) => {
  const b = body(req)
  return startVerification({ code: b.org_code ?? b.code, email: b.email, purpose: 'activation', ...clientOf(req) })
}))

// Forgot password: same check as activation. Body: { org_code, email }.
router.post('/api/owner/forgot', route('owner forgot', (req) => {
  const b = body(req)
  return startVerification({ code: b.org_code ?? b.code, email: b.email, purpose: 'reset', ...clientOf(req) })
}))

// Screen B. Body: { email, purpose }.
router.post('/api/owner/otp/resend', route('owner resend', (req) => {
  const b = body(req)
  return resendCode({ email: b.email, purpose: purposeOf(b.purpose), ...clientOf(req) })
}))

// Screen B. Body: { email, code, purpose } → { token } for Screen C.
router.post('/api/owner/otp/confirm', route('owner confirm', (req) => {
  const b = body(req)
  return confirmCode({ email: b.email, code: b.code, purpose: purposeOf(b.purpose), ...clientOf(req) })
}))

// Screen C, when the tab regains focus. Body: { token } → { valid, reason? }.
router.post('/api/owner/token/status', route('owner token status', (req) => tokenStatus(body(req).token)))

// Screen C. Body: { token, password } → { session } (the app adopts it).
router.post('/api/owner/password', route('owner password', (req) => {
  const b = body(req)
  return setPassword({ token: b.token, password: b.password, ...clientOf(req) })
}))

// Body: { email, password, remember } → { session }.
router.post('/api/owner/login', route('owner login', (req) => {
  const b = body(req)
  return login({ email: b.email, password: b.password, remember: b.remember === true, ...clientOf(req) })
}))

router.post('/api/owner/logout', ownerRoute('owner logout', (ctx) => logout(ctx)))

// ── The portal ───────────────────────────────────────────────────────────────
// Who is signed in, their organization and the unread badge (the app shell).
router.get('/api/owner/me', ownerRoute('owner me', async (ctx) => ({
  ...(await getProfile(ctx)), unread: await unreadCount(ctx),
})))

router.get('/api/owner/dashboard/summary', ownerRoute('owner summary', (ctx) => summary(ctx)))

// Query: search, status (comma-separated; 'attention' = needs attention), sort, dir, page.
router.get('/api/owner/stores', ownerRoute('owner stores', (ctx, req) => queryStores(ctx, req.query)))
router.get('/api/owner/stores/:id', ownerRoute('owner store detail', (ctx, req) => storeDetail(ctx, req.params.id)))

// Add Store + invite. Body: { storeName, city, state, address, pincode, managerName,
// managerEmail, countryCode, managerPhone, note }.
router.post('/api/owner/stores', ownerRoute('owner add store', (ctx, req) => addStore(ctx, body(req), { appBase: appBaseOf(req) })))

router.post('/api/owner/stores/:id/invite/resend', ownerRoute('owner resend invite', (ctx, req) =>
  resendInvite(ctx, req.params.id, { appBase: appBaseOf(req) })))
router.get('/api/owner/stores/:id/invite/link', ownerRoute('owner invite link', (ctx, req) =>
  inviteLink(ctx, req.params.id, { appBase: appBaseOf(req) })))
// Edit manager email (only while Invited). Body: { email }.
router.patch('/api/owner/stores/:id/invite', ownerRoute('owner change invite email', (ctx, req) =>
  changeInviteEmail(ctx, req.params.id, body(req).email, { appBase: appBaseOf(req) })))
// Revoke an open invite (the store is removed).
router.delete('/api/owner/stores/:id/invite', ownerRoute('owner revoke invite', (ctx, req) =>
  removeInvitedStore(ctx, req.params.id, { action: 'revoke' })))
// Delete a store whose invite expired unused.
router.delete('/api/owner/stores/:id', ownerRoute('owner delete store', (ctx, req) =>
  removeInvitedStore(ctx, req.params.id, { action: 'delete' })))
router.post('/api/owner/stores/:id/deactivate', ownerRoute('owner deactivate store', (ctx, req) =>
  deactivateStore(ctx, req.params.id)))

// Profile: name, phone and notification preferences are editable.
router.get('/api/owner/profile', ownerRoute('owner profile', (ctx) => getProfile(ctx)))
router.patch('/api/owner/profile', ownerRoute('owner profile update', (ctx, req) => {
  const b = body(req)
  return updateProfile(ctx, { name: b.name, phone: b.phone, notifyPrefs: b.notifyPrefs })
}))
// Body: { current, next }.
router.post('/api/owner/profile/password', ownerRoute('owner change password', (ctx, req) => {
  const b = body(req)
  return changePassword(ctx, { current: b.current, next: b.next })
}))
router.get('/api/owner/sessions', ownerRoute('owner sessions', async (ctx) => ({ sessions: await listSessions(ctx) })))
router.delete('/api/owner/sessions', ownerRoute('owner sign out others', (ctx) => revokeOtherSessions(ctx)))

// Notifications. Query: category, unread_only, cursor.
router.get('/api/owner/notifications', ownerRoute('owner notifications', (ctx, req) => listNotifications(ctx, {
  category: req.query.category, unreadOnly: req.query.unread_only === 'true' || req.query.unread_only === '1', cursor: req.query.cursor,
})))
router.get('/api/owner/notifications/unread-count', ownerRoute('owner unread', async (ctx) => ({ count: await unreadCount(ctx) })))
router.post('/api/owner/notifications/read-all', ownerRoute('owner read all', (ctx) => markAllRead(ctx)))
// Body: { read: boolean }.
router.patch('/api/owner/notifications/:id', ownerRoute('owner notification read', async (ctx, req) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new OwnerError(404, 'not_found', 'Notification not found.')
  if (!await setRead(ctx, req.params.id, body(req).read !== false)) throw new OwnerError(404, 'not_found', 'Notification not found.')
}))
router.delete('/api/owner/notifications/:id', ownerRoute('owner notification delete', async (ctx, req) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new OwnerError(404, 'not_found', 'Notification not found.')
  if (!await deleteNotification(ctx, req.params.id)) throw new OwnerError(404, 'not_found', 'Notification not found.')
}))

// ── Store manager: the invite link (/invite?token=… in the web app) ──────────
router.get('/api/invites/:token', route('read invite', (req) => readInvite(req.params.token, clientOf(req))))
// Body: { password } (not needed when the email already has an Atelier account).
router.post('/api/invites/:token/accept', route('accept invite', (req) =>
  acceptInvite(req.params.token, { password: body(req).password }, clientOf(req))))
