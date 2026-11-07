import { getUserFromRequest, membershipEnabled } from './membership.mjs'
import { getClientContext, findDevice, deviceKeyFromRequest } from './clients.mjs'

// =============================================================================
// Who is calling, worked out at most once per request (routes, gates and the
// usage log all ask). Never throws:
//   user         — the Supabase auth user, or null (no token / bad token / no DB)
//   tokenInvalid — a Bearer token was sent but didn't verify (with a DB configured)
//   store        — the B2B store this user signs in for (getClientContext), or null
//   storeError   — the store lookup failed (callers choose fail-open or 503)
//   device       — this iPad's b2b_devices row (X-Atelier-Device), stores only
// =============================================================================

const cache = new WeakMap()

/** @returns {Promise<{ user: object|null, tokenInvalid: boolean, store: object|null, storeError: Error|null, device: object|null }>} */
export function callerOf(req) {
  if (!cache.has(req)) cache.set(req, resolve(req))
  return cache.get(req)
}

async function resolve(req) {
  const hasToken = /^Bearer\s+/i.test(req.headers?.authorization || '')
  const user = hasToken ? await getUserFromRequest(req) : null
  let store = null
  let storeError = null
  if (user) {
    try {
      store = await getClientContext(user.id)
    } catch (err) {
      storeError = err
    }
  }
  let device = null
  if (store) {
    try {
      device = await findDevice(store.clientId, deviceKeyFromRequest(req))
    } catch {
      device = null
    }
  }
  return { user, tokenInvalid: hasToken && !user && membershipEnabled(), store, storeError, device }
}
