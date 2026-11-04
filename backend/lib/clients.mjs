import { serviceDb, isMissingSchema } from './db.mjs'

// =============================================================================
// B2B stores (supabase/migrations/b2b-integration.sql, on the admin schema
// b2b_companies → b2b_stores → b2b_devices). A login is a store account iff its
// confirmed email is a b2b_stores.store_email. The store's credit pool is spent
// and refunded only here (service role) — never by the app.
//
// Naming: the rest of the server calls a store the "client" (clientId = the
// store_id), so the store app and the API share one vocabulary.
// =============================================================================

export const CLIENT_FEATURES = ['tryon', 'style', 'size']

/**
 * A store's status and spendable credits, from the database (one implementation:
 * the b2b_store_credits view, supabase/migrations/b2b-store-credits.sql). Before
 * that migration: status from store_effective_status() and the raw balance.
 */
async function storeState(db, storeId, rawBalance) {
  const { data, error } = await db.from('b2b_store_credits')
    .select('effective_status, usable_credits').eq('store_id', storeId).maybeSingle()
  if (!error && data) return { status: data.effective_status, usableCredits: data.usable_credits }
  if (error && !isMissingSchema(error)) throw error
  const { data: status, error: sErr } = await db.rpc('store_effective_status', { p_store_id: storeId })
  if (sErr) throw sErr
  return { status, usableCredits: rawBalance }
}

/**
 * The store a user signs in for, or null for a B2C user (or when the migration
 * hasn't been applied). Features default to ON when no row exists.
 * @returns {Promise<null | { clientId: string, companyId: string|null, status: string, creditsBalance: number, features: Record<string, boolean> }>}
 */
export async function getClientContext(userId) {
  const db = serviceDb()
  if (!db || !userId) return null

  const { data: storeId, error } = await db.rpc('store_for_user', { p_user_id: userId })
  if (error) {
    if (isMissingSchema(error)) return null
    throw error
  }
  if (!storeId) return null

  const [{ data: store, error: sErr }, { data: rows, error: fErr }] = await Promise.all([
    db.from('b2b_stores')
      .select('store_id, company_id, credits_balance')
      .eq('store_id', storeId).maybeSingle(),
    db.from('b2b_store_features').select('feature, enabled').eq('store_id', storeId),
  ])
  if (sErr) throw sErr
  if (fErr) throw fErr
  if (!store) return null

  const state = await storeState(db, store.store_id, store.credits_balance ?? 0)
  const features = Object.fromEntries(CLIENT_FEATURES.map((f) => [f, true]))
  for (const r of rows ?? []) features[r.feature] = r.enabled !== false

  return {
    clientId: store.store_id,
    companyId: store.company_id ?? null,
    status: state.status,
    creditsBalance: state.usableCredits,
    features,
  }
}

/** True when the store may use the app at all (suspended / paused → false). */
export function clientActive(ctx) {
  return ctx.status === 'active' || ctx.status === 'trial'
}

/**
 * Atomically spend one store credit (and write the ledger). Refuses paused
 * stores, ended trials and plans past renewal + grace days.
 * Returns { allowed, reason, creditsBalance }; reason ∈ no_credits | inactive |
 * trial_ended | expired | unknown_store.
 */
export async function consumeClientCredit(clientId, { feature = 'tryon', deviceId = null } = {}) {
  const db = serviceDb()
  if (!db) return { allowed: true, reason: null, creditsBalance: null }
  const { data, error } = await db.rpc('consume_store_credit', {
    p_store_id: clientId, p_feature: feature, p_device_id: deviceId,
  })
  if (error) throw error
  return {
    allowed: !!data?.allowed,
    reason: data?.reason ?? null,
    creditsBalance: data?.credits_balance ?? 0,
  }
}

/** Give a store credit back (generation failed). Best-effort. */
export async function refundClientCredit(clientId, { feature = 'tryon', deviceId = null } = {}) {
  const db = serviceDb()
  if (!db) return
  try {
    const { error } = await db.rpc('refund_store_credit', {
      p_store_id: clientId, p_feature: feature, p_device_id: deviceId,
    })
    if (error) throw error
  } catch (err) {
    console.warn('[Atelier] refundClientCredit failed:', err?.message)
  }
}

// ─── Devices (iPads) — b2b_devices, tracked, never limited ───────────────────
// The app sends a per-install random key in the X-Atelier-Device header.
// b2b_devices.status: 'inactive' = blocked by the admin (the app shows
// "blocked"), 'sign_out_requested' = remote sign-out.

export function deviceKeyFromRequest(req) {
  const raw = req.headers?.['x-atelier-device']
  const key = typeof raw === 'string' ? raw.trim() : ''
  return /^[A-Za-z0-9_-]{8,64}$/.test(key) ? key : null
}

const appStatus = (status) => (status === 'inactive' ? 'blocked' : status)

/** The registered device for this store + key, or null. Never throws. */
export async function findDevice(clientId, deviceKey) {
  const db = serviceDb()
  if (!db || !clientId || !deviceKey) return null
  try {
    const { data } = await db.from('b2b_devices')
      .select('device_id, store_id, status, device_name')
      .eq('store_id', clientId).eq('device_key', deviceKey).maybeSingle()
    return data ? { id: data.device_id, store_id: data.store_id, status: appStatus(data.status), name: data.device_name } : null
  } catch {
    return null
  }
}

/**
 * Register / refresh a device at the start of a session. A device the admin
 * asked to sign out is reset to active (the app signs out on this response).
 * @returns {Promise<{ id: string, storeId: string, status: string, name: string|null, isNew: boolean } | null>}
 */
export async function touchDevice(clientId, deviceKey, { userId, name, platform, appVersion } = {}) {
  const db = serviceDb()
  if (!db) return null
  const existing = await findDevice(clientId, deviceKey)
  const now = new Date().toISOString()
  if (!existing) {
    const { data, error } = await db.from('b2b_devices').insert({
      store_id: clientId, device_key: deviceKey, device_name: name || null,
      device_type: platform === 'ios' || platform === 'web' ? 'iPad' : platform || null,
      platform: platform || null, app_version: appVersion || null, last_user_id: userId || null,
      first_seen_at: now, last_seen: now,
    }).select('device_id, store_id, status, device_name').single()
    if (error) throw error
    return { id: data.device_id, storeId: data.store_id, status: appStatus(data.status), name: data.device_name, isNew: true }
  }
  const patch = { last_seen: now, last_user_id: userId || null, platform: platform || null, app_version: appVersion || null }
  if (!existing.name && name) patch.device_name = name
  if (existing.status === 'sign_out_requested') patch.status = 'active'
  const { error } = await db.from('b2b_devices').update(patch).eq('device_id', existing.id)
  if (error) throw error
  return { id: existing.id, storeId: existing.store_id, status: existing.status, name: existing.name ?? name ?? null, isNew: false }
}

// ─── Events + settings ───────────────────────────────────────────────────────

/** Record one lifecycle event (spec §6). Fire-and-forget: never throws. */
export async function logAppEvent({ event, channel, userId, clientId, companyId, deviceId, folderId, metadata }) {
  const db = serviceDb()
  if (!db || !event) return
  try {
    const { error } = await db.from('app_events').insert({
      event,
      channel: channel || (clientId ? 'b2b' : 'b2c'),
      user_id: userId ?? null,
      company_id: companyId ?? null,
      store_id: clientId ?? null,
      device_id: deviceId ?? null,
      folder_id: folderId ?? null,
      metadata: metadata ?? null,
    })
    if (error) throw error
  } catch (err) {
    console.warn('[Atelier] logAppEvent failed:', err?.message)
  }
}

/** app_settings values as plain JS (defaults when the table is missing). */
export async function getSettings() {
  const defaults = { b2b_low_credit_pct: 20, b2b_grace_days: 7, b2c_low_credit_left: 1, plan_ending_days: 7,
    notify_auto: { low_credits: true, out_of_credits: true, plan_ending: true }, notify_cooldown_hours: 24 }
  const db = serviceDb()
  if (!db) return defaults
  try {
    const { data, error } = await db.from('app_settings').select('key, value')
    if (error) throw error
    const out = { ...defaults }
    for (const r of data ?? []) out[r.key] = r.value
    return out
  } catch {
    return defaults
  }
}

/** Latest undismissed tablet message for a store (last 7 days), or null. */
export async function latestTabletNotice(clientId) {
  const db = serviceDb()
  if (!db || !clientId) return null
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const { data } = await db.from('notifications')
      .select('id, template, subject, body, link_url, sent_at')
      .eq('recipient_type', 'b2b_store').eq('recipient_id', clientId).eq('channel', 'tablet')
      .eq('status', 'sent').is('dismissed_at', null).gte('sent_at', since)
      .order('sent_at', { ascending: false }).limit(1).maybeSingle()
    return data ?? null
  } catch {
    return null
  }
}

