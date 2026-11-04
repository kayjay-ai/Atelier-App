import express from 'express'
import { verifyJwt } from '../lib/jwt.mjs'
import { resolveClient, resolveClientByApiKey, enabledFeatures } from '../lib/embedClients.mjs'
import {
  findOrCreateEmbedUser,
  mintSession,
  embedSessionFromRequest,
  saveEmbedGeneration,
  listEmbedGenerations,
  SESSION_LIFETIME_SEC,
} from '../lib/embedSession.mjs'

const router = express.Router()
export default router

// ===========================================================================
// EMBED SSO — white-label iframe. A registered client's backend mints a signed
// JWT for its logged-in user; the iframe hands it here; we verify server-side and
// issue a short-lived Atelier session token (held in the iframe's memory, sent as
// Authorization: Bearer — NO third-party cookies). All data is scoped to the
// verified (client_id, external_user_id), never a client-supplied value.
// ===========================================================================

// POST /api/embed/session — verify the client's signed token, find-or-create the
// Atelier user for (client_id, external_user_id), and issue an Atelier session token.
router.post('/api/embed/session', async (req, res) => {
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
router.post('/api/embed/refresh', async (req, res) => {
  const session = embedSessionFromRequest(req)
  if (!session) return res.status(401).json({ error: 'invalid_session', message: 'Session is missing or expired — re-authenticate.' })
  // Re-read the client's toggles on refresh so an admin change propagates within a session.
  const client = await resolveClient(session.clientId)
  const features = client ? enabledFeatures(client) : session.features
  const token = mintSession({ ...session, features })
  return res.json({ token, expiresIn: SESSION_LIFETIME_SEC, enabledFeatures: features })
})

// GET /api/embed/me — who the iframe is authenticated as + enabled features.
router.get('/api/embed/me', (req, res) => {
  const session = embedSessionFromRequest(req)
  if (!session) return res.status(401).json({ error: 'invalid_session' })
  return res.json({ externalUserId: session.externalUserId, name: session.name ?? null, clientId: session.clientId, enabledFeatures: session.features })
})

// GET /api/embed/config — the client's enabled AI features (for the embed UI).
router.get('/api/embed/config', (req, res) => {
  const session = embedSessionFromRequest(req)
  if (!session) return res.status(401).json({ error: 'invalid_session' })
  return res.json({ enabledFeatures: session.features })
})

// GET /api/embed/history — the signed-in embed user's own generations (scoped to
// their verified (client_id, external_user_id) from the session token).
router.get('/api/embed/history', async (req, res) => {
  const session = embedSessionFromRequest(req)
  if (!session) return res.status(401).json({ error: 'invalid_session' })
  const items = await listEmbedGenerations(session.clientId, session.externalUserId)
  return res.json({ items })
})

// POST /api/embed/history — record a generation for the signed-in embed user. The
// scope (client_id, external_user_id) comes from the VERIFIED session, not the body.
router.post('/api/embed/history', async (req, res) => {
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
router.get('/api/partner/users/:externalUserId/history', async (req, res) => {
  const apiKey = req.headers['x-client-api-key']
  const client = await resolveClientByApiKey(apiKey)
  if (!client) return res.status(401).json({ error: 'invalid_api_key', message: 'A valid X-Client-Api-Key is required.' })
  const { externalUserId } = req.params
  const items = await listEmbedGenerations(client.client_id, externalUserId)
  console.log(`[Atelier] partner history: ${client.client_id}:${externalUserId} → ${items.length} rows`)
  return res.json({ clientId: client.client_id, externalUserId, items })
})
