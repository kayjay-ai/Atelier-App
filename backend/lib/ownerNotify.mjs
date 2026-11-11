import { serviceDb, isMissingSchema } from './db.mjs'
import { sendEmail } from './email.mjs'

// =============================================================================
// The owner's notification feed (b2b_owner_notifications, kept 90 days) and the
// emails that go with it. Notifications are created here, on the server, when
// the event happens — never by the app.
//
// Preferences (b2b_owners.notify_prefs, Profile → Notification preferences):
//   categories.<name> false → no feed item and no email for that category.
//   email false             → feed only.
// Account & security can't be turned off. Critical items (payment failed,
// package expired, new sign-in, password changed, account locked) always
// appear and always go by email too.
// =============================================================================

export const CATEGORIES = ['purchases', 'payments', 'store_activity', 'deals', 'gift_cards', 'account']
const OPTIONAL = ['purchases', 'payments', 'store_activity', 'deals', 'gift_cards']

/** Preferences with defaults filled in (everything on). */
export function prefsOf(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const categories = Object.fromEntries(OPTIONAL.map((c) => [c, r.categories?.[c] !== false]))
  return { categories: { ...categories, account: true }, email: r.email !== false, inApp: true }
}

/** Accept only known preference fields from a PATCH. */
export function cleanPrefs(input, current) {
  const base = prefsOf(current)
  if (!input || typeof input !== 'object') return base
  const categories = { ...base.categories }
  for (const c of OPTIONAL) if (typeof input.categories?.[c] === 'boolean') categories[c] = input.categories[c]
  return { categories: { ...categories, account: true }, email: typeof input.email === 'boolean' ? input.email : base.email, inApp: true }
}

const appBase = () => (process.env.APP_PUBLIC_URL || '').replace(/\/$/, '')

/**
 * Post one notification to a company's owner (and email it when the rules say so).
 * @param {object} n
 * @param {string} n.companyId
 * @param {'purchases'|'payments'|'store_activity'|'deals'|'gift_cards'|'account'} n.category
 * @param {string} n.title     short headline (also the email subject)
 * @param {string} n.body      one line; the store name in it is shown in bold
 * @param {string} [n.storeId]
 * @param {string} [n.storeName]
 * @param {object} [n.link]    { screen: 'store'|'profile'|'offer'|'gift_card', storeId?, section? }
 * @param {object} [n.data]    offers / gift cards: { expiresAt, cta, code, amountInr }
 * @param {string} [n.dedupeKey] the same key is never posted twice for a company
 * @param {boolean} [n.critical]
 * @param {boolean} [n.noEmail]   feed only (the caller sends its own email)
 * @returns {Promise<{ posted: boolean, reason?: string, id?: string }>}
 */
export async function notifyOwner(n) {
  const db = serviceDb()
  if (!db || !n?.companyId) return { posted: false, reason: 'no_database' }
  try {
    const { data: owner, error: oErr } = await db.from('b2b_owners')
      .select('owner_id, email, name, activated_at, notify_prefs').eq('company_id', n.companyId).maybeSingle()
    if (oErr) throw oErr
    const prefs = prefsOf(owner?.notify_prefs)
    if (!n.critical && n.category !== 'account' && prefs.categories[n.category] === false) {
      return { posted: false, reason: 'turned_off' }
    }
    const { data: row, error } = await db.from('b2b_owner_notifications').insert({
      company_id: n.companyId, owner_id: owner?.owner_id ?? null, category: n.category,
      title: String(n.title).slice(0, 200), body: String(n.body).slice(0, 1000),
      store_id: n.storeId ?? null, store_name: n.storeName ?? null,
      link: n.link ?? null, data: n.data ?? null, dedupe_key: n.dedupeKey ?? null,
    }).select('id').single()
    if (error) {
      if (error.code === '23505') return { posted: false, reason: 'duplicate' }
      throw error
    }
    if (!n.noEmail && owner?.activated_at && owner.email && (n.critical || prefs.email)) {
      const url = appBase() ? `${appBase()}/owner/notifications` : null
      const r = await sendEmail({
        to: owner.email, subject: n.title, body: n.body,
        link: url ? { url, label: 'Open your Atelier owner portal' } : null,
      })
      if (r.status === 'failed') console.warn('[Atelier] owner notification email failed:', r.error)
    }
    return { posted: true, id: row.id }
  } catch (err) {
    if (!isMissingSchema(err)) console.warn('[Atelier] notifyOwner failed:', err?.message)
    return { posted: false, reason: 'error' }
  }
}

// ── The feed ─────────────────────────────────────────────────────────────────

const FEED_COLS = 'id, category, title, body, store_id, store_name, link, data, is_read, created_at, expires_at'

const toItem = (r) => ({
  id: r.id, category: r.category, title: r.title, body: r.body,
  storeId: r.store_id, storeName: r.store_name, link: r.link ?? null, data: r.data ?? null,
  read: r.is_read, createdAt: r.created_at,
})

/**
 * One page of the feed, newest first. cursor = the last item's `${createdAt}|${id}`.
 * @returns {Promise<{ items: object[], nextCursor: string|null }>}
 */
export async function listNotifications(ctx, { category, unreadOnly, cursor, limit = 20 } = {}) {
  const db = serviceDb()
  const size = Math.min(Math.max(Number(limit) || 20, 1), 50)
  let q = db.from('b2b_owner_notifications').select(FEED_COLS)
    .eq('company_id', ctx.company.company_id).gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(size + 1)
  if (category && CATEGORIES.includes(category)) q = q.eq('category', category)
  if (unreadOnly) q = q.eq('is_read', false)
  if (cursor) {
    const [at, id] = String(cursor).split('|')
    if (at && !Number.isNaN(Date.parse(at)) && /^[0-9a-f-]{36}$/.test(id ?? '')) {
      q = q.or(`created_at.lt."${at}",and(created_at.eq."${at}",id.lt.${id})`)
    }
  }
  const { data, error } = await q
  if (error) throw error
  const rows = data ?? []
  const page = rows.slice(0, size)
  const last = page[page.length - 1]
  return { items: page.map(toItem), nextCursor: rows.length > size && last ? `${last.created_at}|${last.id}` : null }
}

export async function unreadCount(ctx) {
  const db = serviceDb()
  const { count, error } = await db.from('b2b_owner_notifications').select('id', { count: 'exact', head: true })
    .eq('company_id', ctx.company.company_id).eq('is_read', false).gt('expires_at', new Date().toISOString())
  if (error) throw error
  return count ?? 0
}

/** Mark one item read / unread. false when it isn't this organization's. */
export async function setRead(ctx, id, read) {
  const db = serviceDb()
  const { data, error } = await db.from('b2b_owner_notifications').update({ is_read: !!read })
    .eq('id', id).eq('company_id', ctx.company.company_id).select('id')
  if (error) throw error
  return (data ?? []).length > 0
}

export async function markAllRead(ctx) {
  const db = serviceDb()
  const { error } = await db.from('b2b_owner_notifications').update({ is_read: true })
    .eq('company_id', ctx.company.company_id).eq('is_read', false)
  if (error) throw error
}

export async function deleteNotification(ctx, id) {
  const db = serviceDb()
  const { data, error } = await db.from('b2b_owner_notifications').delete()
    .eq('id', id).eq('company_id', ctx.company.company_id).select('id')
  if (error) throw error
  return (data ?? []).length > 0
}

// ── Events from elsewhere in the API ─────────────────────────────────────────

const inr = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

async function paymentWithStore(db, orderId) {
  const { data } = await db.from('b2b_payments')
    .select('order_id, store_id, company_id, kind, item_name, amount_inr, credits, b2b_stores(store_name, company_id)')
    .eq('order_id', orderId).maybeSingle()
  if (!data) return null
  const companyId = data.company_id ?? data.b2b_stores?.company_id
  return companyId ? { ...data, companyId, storeName: data.b2b_stores?.store_name ?? data.store_id } : null
}

/** A store's plan or top-up payment was applied. Never throws. */
export async function onStorePaid(orderId) {
  const db = serviceDb()
  if (!db) return
  try {
    const p = await paymentWithStore(db, orderId)
    if (!p) return
    const what = p.kind === 'plan'
      ? `the ${p.item_name.replace(/\s*\(monthly\)$/, '')} package (${Number(p.credits).toLocaleString('en-IN')} credits)`
      : `${Number(p.credits).toLocaleString('en-IN')} top-up credits`
    await notifyOwner({
      companyId: p.companyId, category: 'purchases', storeId: p.store_id, storeName: p.storeName,
      title: `${p.storeName} made a purchase`,
      body: `${p.storeName} bought ${what} for ${inr(p.amount_inr)}.`,
      link: { screen: 'store', storeId: p.store_id, section: 'credits' },
      dedupeKey: `paid:${orderId}`,
    })
  } catch (err) {
    console.warn('[Atelier] onStorePaid failed:', err?.message)
  }
}

/** A payment attempt for a store's order failed (Cashfree webhook). Never throws. */
export async function onStorePaymentFailed(orderId, attemptId) {
  const db = serviceDb()
  if (!db) return
  try {
    const p = await paymentWithStore(db, orderId)
    if (!p) return
    await notifyOwner({
      companyId: p.companyId, category: 'payments', storeId: p.store_id, storeName: p.storeName, critical: true,
      title: `Payment failed at ${p.storeName}`,
      body: `Payment of ${inr(p.amount_inr)} by ${p.storeName} failed.`,
      link: { screen: 'store', storeId: p.store_id, section: 'payments' },
      dedupeKey: `failed:${attemptId || orderId}`,
    })
  } catch (err) {
    console.warn('[Atelier] onStorePaymentFailed failed:', err?.message)
  }
}

// ── Periodic checks (daily job + the 30-minute reconcile run) ────────────────

const today = () => new Date().toISOString().slice(0, 10)

/**
 * Turn state changes nobody "clicked" into feed items: invites that expired,
 * stores low on / out of credits, packages that ended, new devices. Every item
 * has a dedupe key, so running this often is safe. Also deletes items past 90
 * days, old codes and ended sessions.
 */
export async function ownerSweep() {
  const db = serviceDb()
  if (!db) return { skipped: 'no_database' }
  const report = { invitesExpired: 0, posted: 0, cleaned: 0 }
  const now = new Date().toISOString()

  // Invites unused for 7 days.
  const { data: lapsed, error: lErr } = await db.from('b2b_store_invites')
    .select('id, store_id, company_id, manager_email, b2b_stores(store_name, activated_at)')
    .eq('status', 'sent').lt('expires_at', now).limit(500)
  if (lErr) {
    if (isMissingSchema(lErr)) return { skipped: 'owner-portal.sql not applied' }
    throw lErr
  }
  for (const i of lapsed ?? []) {
    await db.from('b2b_store_invites').update({ status: 'expired' }).eq('id', i.id).eq('status', 'sent')
    report.invitesExpired++
    if (i.b2b_stores?.activated_at) continue
    const storeName = i.b2b_stores?.store_name ?? i.store_id
    const r = await notifyOwner({
      companyId: i.company_id, category: 'store_activity', storeId: i.store_id, storeName,
      title: 'An invite expired',
      body: `Your invite to ${i.manager_email} for ${storeName} expired unused.`,
      link: { screen: 'store', storeId: i.store_id }, dedupeKey: `invite_expired:${i.id}`,
    })
    if (r.posted) report.posted++
  }

  // Credits and package state, from the owner view (status computed in the database).
  const { data: stores, error: sErr } = await db.from('b2b_owner_stores')
    .select('store_id, company_id, store_name, owner_status, usable_credits, package_credits, renewal_at, trial_ends_at')
    .in('owner_status', ['low_credits', 'expired'])
  if (sErr) throw sErr
  for (const s of stores ?? []) {
    const cycle = s.renewal_at ?? s.trial_ends_at ?? 'none'
    let r
    if (s.owner_status === 'low_credits') {
      const pct = s.package_credits > 0 ? Math.round((s.usable_credits / s.package_credits) * 100) : 0
      r = await notifyOwner({
        companyId: s.company_id, category: 'purchases', storeId: s.store_id, storeName: s.store_name,
        title: `${s.store_name} is low on credits`,
        body: `${s.store_name} is down to ${pct}% of its credits (${s.usable_credits.toLocaleString('en-IN')} of ${s.package_credits.toLocaleString('en-IN')} left).`,
        link: { screen: 'store', storeId: s.store_id, section: 'credits' }, dedupeKey: `low:${s.store_id}:${cycle}`,
      })
    } else {
      const ended = (s.renewal_at && Date.parse(s.renewal_at) <= Date.now()) ||
        (!s.renewal_at && s.trial_ends_at && Date.parse(s.trial_ends_at) <= Date.now())
      r = await notifyOwner({
        companyId: s.company_id, category: 'purchases', storeId: s.store_id, storeName: s.store_name, critical: true,
        title: ended ? `${s.store_name}'s package expired` : `${s.store_name} is out of credits`,
        body: ended
          ? `${s.store_name}'s package expired and wasn't renewed.`
          : `${s.store_name} has used all its credits — new try-ons are paused until it renews or tops up.`,
        link: { screen: 'store', storeId: s.store_id, section: 'credits' },
        dedupeKey: `${ended ? 'expired' : 'zero'}:${s.store_id}:${cycle}`,
      })
    }
    if (r.posted) report.posted++
  }

  // Devices first seen in the last 24 hours, one item per store per day.
  const since = new Date(Date.now() - 86_400_000).toISOString()
  const { data: devices, error: dErr } = await db.from('b2b_devices')
    .select('store_id, b2b_stores(store_name, company_id)').gte('first_seen_at', since).limit(1000)
  if (dErr && !isMissingSchema(dErr)) throw dErr
  const perStore = new Map()
  for (const d of devices ?? []) {
    if (!d.b2b_stores?.company_id) continue
    const e = perStore.get(d.store_id) ?? { n: 0, name: d.b2b_stores.store_name, companyId: d.b2b_stores.company_id }
    e.n++
    perStore.set(d.store_id, e)
  }
  for (const [storeId, e] of perStore) {
    const key = `devices:${storeId}:${today()}`
    const body = `${e.n} new device${e.n === 1 ? '' : 's'} connected to ${e.name}.`
    const r = await notifyOwner({
      companyId: e.companyId, category: 'store_activity', storeId, storeName: e.name,
      title: `New device${e.n === 1 ? '' : 's'} at ${e.name}`, body,
      link: { screen: 'store', storeId, section: 'devices' }, dedupeKey: key,
    })
    if (r.posted) report.posted++
    else if (r.reason === 'duplicate') {
      // More devices joined since this morning's item: update its count.
      await db.from('b2b_owner_notifications').update({ body, title: `New device${e.n === 1 ? '' : 's'} at ${e.name}` })
        .eq('company_id', e.companyId).eq('dedupe_key', key).neq('body', body)
    }
  }

  // Housekeeping.
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString()
  const monthAgo = new Date(Date.now() - 31 * 86_400_000).toISOString()
  const cleanups = await Promise.all([
    db.from('b2b_owner_notifications').delete({ count: 'exact' }).lt('expires_at', now),
    db.from('b2b_owner_otps').delete({ count: 'exact' }).lt('created_at', dayAgo),
    db.from('b2b_owner_sessions').delete({ count: 'exact' }).lt('expires_at', monthAgo),
  ])
  for (const c of cleanups) {
    if (c.error) console.warn('[Atelier] owner sweep cleanup failed:', c.error.message)
    else report.cleaned += c.count ?? 0
  }
  return report
}
