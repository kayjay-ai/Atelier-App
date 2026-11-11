import { serviceDb, isMissingSchema } from './db.mjs'
import { sendEmail, emailBypass } from './email.mjs'
import { allow } from './rateLimit.mjs'
import { OwnerError, audit } from './ownerAuth.mjs'
import { notifyOwner } from './ownerNotify.mjs'
import {
  newSecret, inviteToken, inviteIdOf, inviteTokenMatches, normEmail, isEmail, passwordProblems,
} from './ownerSecrets.mjs'

// =============================================================================
// The owner's stores: dashboard numbers, the store table and detail drawer,
// Add Store (store + manager invite in one step) and the invite lifecycle.
// Store status comes from the database view b2b_owner_stores
// (supabase/migrations/owner-portal.sql) — never re-derived here. Every call
// is scoped to the owner's organization: a store id from another company is
// "not found".
//
// A store's login is its manager's email (b2b_stores.store_email, unique), so
// one email manages at most one store. The manager accepts the invite at
// /invite?token=… in the web app (acceptInvite), which sets up that login
// and moves the store Invited → Pending; its first package moves it to Active.
// =============================================================================

export const STATUSES = ['invited', 'pending', 'active', 'low_credits', 'expired', 'invite_expired', 'deactivated']
const ATTENTION = new Set(['low_credits', 'invite_expired', 'expired'])
const STATUS_ORDER = Object.fromEntries(STATUSES.map((s, i) => [s, i]))
const INVITE_MS = 7 * 86_400_000
export const PAGE_SIZE = 20
const NOT_SET_UP = 'The owner portal isn’t set up yet — contact Atelier support.'
const INVALID_INVITE = 'This invite is no longer valid. Ask the owner for a new one.'
const IST_MS = 5.5 * 3_600_000

function db() {
  const client = serviceDb()
  if (!client) throw new OwnerError(503, 'no_database', 'The owner portal is not available right now.')
  return client
}

function check(error) {
  if (!error) return
  if (isMissingSchema(error)) throw new OwnerError(503, 'not_set_up', NOT_SET_UP)
  throw error
}

const ilikeExact = (s) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`)
const auditCtx = (ctx) => ({ ownerId: ctx.owner.owner_id, companyId: ctx.company.company_id })
const orgName = (c) => c.brand_name || c.company_name

/**
 * Email delivery as stored on the invite: in production "not configured" counts
 * as not delivered — except in test mode (emailBypass), where the owner is
 * handed the link to share instead.
 */
const deliveryOf = (r) => (r.status === 'sent' ? 'sent'
  : r.status === 'skipped' && (process.env.NODE_ENV !== 'production' || emailBypass()) ? 'skipped' : 'failed')

// ── Rows ─────────────────────────────────────────────────────────────────────

function toRow(r) {
  const status = r.owner_status
  const emailNotDelivered = status === 'invited' && r.invite_email_status === 'failed'
  const hasPackage = !!(r.renewal_at || r.trial_ends_at)
  return {
    id: r.store_id,
    name: r.store_name,
    city: r.city ?? '', state: r.state ?? '', address: r.store_address ?? '', pincode: r.pincode ?? '',
    location: [r.city, r.state].filter(Boolean).join(', '),
    managerName: r.manager_name ?? '', managerEmail: r.manager_email ?? '', managerPhone: r.manager_phone ?? '',
    status,
    needsAttention: ATTENTION.has(status) || emailNotDelivered,
    emailNotDelivered,
    devices: r.devices_connected ?? 0,
    packageName: hasPackage ? (r.plan_name ?? (r.trial_ends_at && !r.renewal_at ? 'Free trial' : r.subscription_plan)) : null,
    creditsUsed: r.credits_used ?? 0,
    creditsTotal: r.package_credits || (r.credits_used ?? 0) + (r.usable_credits ?? 0),
    usableCredits: r.usable_credits ?? 0,
    topupCredits: r.topup_credits ?? 0,
    lastPaymentAt: r.last_payment_at ?? null,
    renewalAt: r.renewal_at ?? null,
    trialEndsAt: r.trial_ends_at ?? null,
    createdAt: r.created_at,
    invitedAt: r.invite_sent_at ?? r.invited_at ?? null,
    activatedAt: r.activated_at ?? null,
    deactivatedAt: r.deactivated_at ?? null,
    invite: r.invite_id
      ? { id: r.invite_id, status: r.invite_status, sentAt: r.invite_sent_at, expiresAt: r.invite_expires_at, emailStatus: r.invite_email_status }
      : null,
  }
}

async function loadRows(companyId) {
  const { data, error } = await db().from('b2b_owner_stores').select('*').eq('company_id', companyId)
  check(error)
  return data ?? []
}

async function rowFor(ctx, storeId) {
  if (typeof storeId !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(storeId)) {
    throw new OwnerError(404, 'not_found', 'This store isn’t in your organization.')
  }
  const { data, error } = await db().from('b2b_owner_stores').select('*')
    .eq('company_id', ctx.company.company_id).eq('store_id', storeId).maybeSingle()
  check(error)
  if (!data) throw new OwnerError(404, 'not_found', 'This store isn’t in your organization.')
  return data
}

/** Start of the current month in India time, as an ISO timestamp. */
function monthStartIso() {
  const ist = new Date(Date.now() + IST_MS)
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - IST_MS).toISOString()
}

async function usageSince(companyId, sinceIso, storeId = null) {
  const { data, error } = await db().rpc('owner_credit_usage', { p_company_id: companyId, p_since: sinceIso, p_store_id: storeId })
  check(error)
  return data ?? []
}

// ── Home ─────────────────────────────────────────────────────────────────────

export async function summary(ctx) {
  const rows = (await loadRows(ctx.company.company_id)).map(toRow)
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]))
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
  const live = rows.filter((r) => r.status === 'active' || r.status === 'low_credits')
  const used = (await usageSince(ctx.company.company_id, monthStartIso())).reduce((n, u) => n + Math.max(0, u.used), 0)
  const available = rows.filter((r) => !['invited', 'invite_expired', 'deactivated'].includes(r.status))
    .reduce((n, r) => n + r.usableCredits, 0)
  return {
    totalStores: rows.length,
    byStatus,
    connectedDevices: live.reduce((n, r) => n + r.devices, 0),
    creditsUsedThisMonth: used,
    creditsUsedPct: used + available > 0 ? Math.round((used / (used + available)) * 100) : 0,
    needsAttention: rows.filter((r) => r.needsAttention).length,
  }
}

const SORTS = {
  name: (r) => r.name.toLowerCase(),
  location: (r) => r.location.toLowerCase(),
  manager: (r) => r.managerEmail.toLowerCase(),
  status: (r) => STATUS_ORDER[r.status] ?? 99,
  devices: (r) => r.devices,
  package: (r) => (r.packageName ?? '').toLowerCase(),
  credits: (r) => r.creditsUsed,
  lastPayment: (r) => (r.lastPaymentAt ? Date.parse(r.lastPaymentAt) : 0),
  created: (r) => Date.parse(r.createdAt ?? 0),
}

/**
 * The store table: search (name, location, manager), status filter (several;
 * 'attention' = needs attention), sort by any column, 20 per page. Default
 * order: needs attention first, then newest.
 */
export async function queryStores(ctx, { search, status, sort, dir, page } = {}) {
  let rows = (await loadRows(ctx.company.company_id)).map(toRow)
  const q = String(search ?? '').trim().toLowerCase().slice(0, 100)
  if (q) {
    rows = rows.filter((r) => [r.name, r.location, r.address, r.managerEmail, r.managerName, r.id]
      .some((v) => String(v).toLowerCase().includes(q)))
  }
  const wanted = String(status ?? '').split(',').map((s) => s.trim()).filter((s) => STATUSES.includes(s) || s === 'attention')
  if (wanted.length) rows = rows.filter((r) => wanted.includes(r.status) || (wanted.includes('attention') && r.needsAttention))

  const key = SORTS[sort] ? sort : null
  const sign = dir === 'asc' ? 1 : -1
  rows.sort((a, b) => {
    if (key) {
      const x = SORTS[key](a), y = SORTS[key](b)
      if (x !== y) return (x < y ? -1 : 1) * sign
    } else if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1
    return Date.parse(b.createdAt ?? 0) - Date.parse(a.createdAt ?? 0)
  })
  const total = rows.length
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const p = Math.min(Math.max(1, Number.parseInt(page, 10) || 1), pages)
  return { stores: rows.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE), total, page: p, pageSize: PAGE_SIZE, pages }
}

// ── Store detail drawer ──────────────────────────────────────────────────────

const ONLINE_MS = 2 * 60_000 // the store app checks in every 30 s
const istDay = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10)

export async function storeDetail(ctx, storeId) {
  const r = await rowFor(ctx, storeId)
  const supabase = db()
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const [devices, subs, pays, usage] = await Promise.all([
    supabase.from('b2b_devices').select('*').eq('store_id', storeId).order('last_seen', { ascending: false, nullsFirst: false }).limit(200),
    supabase.from('b2b_subscriptions').select('plan_id, started_at, renewal_at, payment_ref, invoice_url')
      .eq('store_id', storeId).order('started_at', { ascending: false }).limit(100),
    supabase.from('b2b_payments').select('*').eq('store_id', storeId).in('status', ['paid', 'failed', 'review'])
      .order('created_at', { ascending: false }).limit(100),
    usageSince(ctx.company.company_id, since, storeId),
  ])
  check(devices.error)
  if (subs.error && !isMissingSchema(subs.error)) throw subs.error
  if (pays.error && !isMissingSchema(pays.error)) throw pays.error

  const now = Date.now()
  const byDay = new Map(usage.map((u) => [String(u.day).slice(0, 10), Math.max(0, u.used)]))
  const series = []
  for (let i = 29; i >= 0; i--) {
    const day = istDay(now - i * 86_400_000)
    series.push({ day, used: byDay.get(day) ?? 0 })
  }
  const subRows = subs.data ?? []
  const current = subRows.find((s) => s.renewal_at === r.renewal_at) ?? subRows[0] ?? null
  const row = toRow(r)
  return {
    store: row,
    devices: (devices.data ?? []).map((d) => ({
      id: d.device_id,
      name: d.device_name || (d.device_code ? `Device ${d.device_code}` : 'Device'),
      type: d.device_type || d.platform || 'tablet',
      lastActiveAt: d.last_seen ?? null,
      online: d.status === 'active' && !d.signed_out_at && !!d.last_seen && now - Date.parse(d.last_seen) < ONLINE_MS,
      blocked: d.status === 'inactive',
    })),
    credits: {
      packageName: row.packageName,
      packageCredits: row.creditsTotal,
      used: row.creditsUsed,
      remaining: row.usableCredits,
      topup: row.topupCredits,
      startsAt: row.packageName ? (current?.started_at ?? null) : null,
      endsAt: r.renewal_at ?? r.trial_ends_at ?? null,
    },
    usage: series,
    payments: (pays.data ?? []).map((p) => ({
      id: p.order_id,
      date: p.paid_at ?? p.created_at,
      package: p.item_name,
      amount: Number(p.amount_inr),
      currency: 'INR',
      method: p.payment_method ?? null,
      last4: p.method_last4 ?? null,
      status: p.status === 'paid' ? 'paid' : p.status === 'failed' ? 'failed' : 'on_hold',
      invoiceUrl: subRows.find((s) => s.payment_ref === p.order_id)?.invoice_url ?? null,
    })),
  }
}

// ── Add Store ────────────────────────────────────────────────────────────────

function clean(v, max) {
  return String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max + 1)
}

/** Field-by-field check of the Add Store form. Throws with every message at once. */
export function validateStoreForm(input, ownerEmail) {
  const f = input && typeof input === 'object' ? input : {}
  const v = {
    storeName: clean(f.storeName, 80),
    city: clean(f.city, 60),
    state: clean(f.state, 60),
    address: clean(f.address, 200),
    pincode: clean(f.pincode, 10).replace(/\s/g, ''),
    managerName: clean(f.managerName, 80),
    managerEmail: normEmail(f.managerEmail),
    countryCode: clean(f.countryCode || '+91', 5),
    managerPhone: String(f.managerPhone ?? '').replace(/[^\d]/g, ''),
    note: String(f.note ?? '').trim(),
  }
  const fields = {}
  if (v.storeName.length < 2 || v.storeName.length > 80) fields.storeName = 'Enter a store name of 2–80 characters.'
  if (v.city.length < 2 || v.city.length > 60) fields.city = 'Enter the city.'
  if (v.state.length < 2 || v.state.length > 60) fields.state = 'Choose the state.'
  if (v.address.length > 200) fields.address = 'Keep the address under 200 characters.'
  if (v.pincode && !/^\d{6}$/.test(v.pincode)) fields.pincode = 'A PIN code has 6 digits.'
  if (!v.managerName || v.managerName.length > 80) fields.managerName = 'Enter the store manager’s name.'
  if (!isEmail(v.managerEmail)) fields.managerEmail = 'Enter a valid email address.'
  else if (ownerEmail && v.managerEmail === normEmail(ownerEmail)) fields.managerEmail = 'Use the manager’s own email, not yours.'
  if (!/^\+\d{1,4}$/.test(v.countryCode)) fields.managerPhone = 'Choose a country code like +91.'
  else if (v.managerPhone && (v.managerPhone.length < 6 || v.managerPhone.length > 14)) fields.managerPhone = 'Enter a valid phone number.'
  else if (v.countryCode === '+91' && v.managerPhone && !/^[6-9]\d{9}$/.test(v.managerPhone)) fields.managerPhone = 'Enter a 10-digit mobile number.'
  if (v.note.length > 300) fields.note = 'Keep the note under 300 characters.'
  if (Object.keys(fields).length) {
    throw new OwnerError(400, 'invalid', Object.values(fields)[0], { fields })
  }
  return { ...v, phone: v.managerPhone ? `${v.countryCode} ${v.managerPhone}` : null }
}

/** Is this email already a login elsewhere on Atelier (another company's store, or an owner)? */
async function emailTakenElsewhere(email, companyId) {
  const supabase = db()
  const [stores, owners] = await Promise.all([
    supabase.from('b2b_stores').select('store_id, company_id').ilike('store_email', ilikeExact(email)).limit(1),
    supabase.from('b2b_companies').select('company_id').ilike('manager_email', ilikeExact(email)).limit(1),
  ])
  check(stores.error)
  check(owners.error)
  if ((stores.data ?? []).some((s) => s.company_id !== companyId)) return true
  return (owners.data ?? []).length > 0
}

function inviteUrl(appBase, inviteId, nonce) {
  return `${String(appBase).replace(/\/$/, '')}/invite?token=${inviteToken(inviteId, nonce)}`
}

async function sendInviteEmail(ctx, invite, store, appBase) {
  const who = ctx.owner.name || orgName(ctx.company)
  const first = String(invite.manager_name || '').split(' ')[0] || 'there'
  return sendEmail({
    to: invite.manager_email,
    subject: `${orgName(ctx.company)} invited you to manage ${store.store_name} on Atelier`,
    body: `Hi ${first},\n\n${who} has invited you to manage ${store.store_name}${store.city ? ` (${store.city})` : ''} ` +
      'on Atelier, the virtual try-on app for your store’s iPads.' +
      (invite.note ? `\n\nA note from ${who}:\n“${invite.note}”` : '') +
      '\n\nAccept the invite to set up your store login. The link works once and expires in 7 days.',
    link: { url: inviteUrl(appBase, invite.id, invite.token_nonce), label: 'Accept invite' },
  })
}

/** Send (or re-send) an invite with a fresh link; the old link stops working. */
async function issueInvite(ctx, store, { inviteId, managerName, managerEmail, managerPhone, note }, appBase) {
  const supabase = db()
  const nonce = newSecret(24)
  const now = new Date()
  const fields = {
    manager_name: managerName, manager_email: managerEmail, manager_phone: managerPhone ?? null,
    token_nonce: nonce, status: 'sent', email_status: 'sent', email_error: null,
    sent_at: now.toISOString(), expires_at: new Date(now.getTime() + INVITE_MS).toISOString(),
  }
  const { data: invite, error } = inviteId
    ? await supabase.from('b2b_store_invites').update(fields).eq('id', inviteId).select('*').single()
    : await supabase.from('b2b_store_invites').insert({
      ...fields, store_id: store.store_id, company_id: ctx.company.company_id, note: note || null, created_by: ctx.owner.owner_id,
    }).select('*').single()
  check(error)
  const sent = await sendInviteEmail(ctx, invite, store, appBase)
  const emailStatus = deliveryOf(sent)
  if (emailStatus !== 'sent') {
    await supabase.from('b2b_store_invites').update({ email_status: emailStatus, email_error: sent.error?.slice(0, 300) ?? null }).eq('id', invite.id)
    if (emailStatus === 'failed') console.warn(`[Atelier] invite email for ${store.store_id} not delivered:`, sent.error)
  }
  await supabase.from('b2b_stores').update({ invited_at: now.toISOString() }).eq('store_id', store.store_id)
  // Test mode: no email went out, so the owner gets the link to pass on.
  const testInviteUrl = emailStatus === 'skipped' && emailBypass() ? inviteUrl(appBase, invite.id, invite.token_nonce) : undefined
  return { inviteId: invite.id, emailStatus, ...(testInviteUrl ? { testInviteUrl } : {}) }
}

export async function addStore(ctx, input, { appBase }) {
  const v = validateStoreForm(input, ctx.owner.email)
  if (!allow('owner-invites', ctx.owner.owner_id, 30, 3_600_000)) {
    throw new OwnerError(429, 'too_many', 'You’ve sent a lot of invites. Try again in an hour.')
  }
  const rows = (await loadRows(ctx.company.company_id)).map(toRow)
  if (rows.some((r) => r.name.toLowerCase() === v.storeName.toLowerCase())) {
    throw new OwnerError(409, 'duplicate_name', `You already have a store called ${v.storeName}.`, { fields: { storeName: 'A store with this name already exists.' } })
  }
  const same = rows.find((r) => r.managerEmail.toLowerCase() === v.managerEmail)
  if (same?.status === 'invited') {
    throw new OwnerError(409, 'invite_pending', 'An invite is already pending for this email.', { storeId: same.id, fields: { managerEmail: 'An invite is already pending for this email.' } })
  }
  if (same) {
    throw new OwnerError(409, 'manages_store', `This person already manages ${same.name}. Each store needs its own manager email.`, {
      storeId: same.id, fields: { managerEmail: `Already the manager of ${same.name}.` },
    })
  }
  if (await emailTakenElsewhere(v.managerEmail, ctx.company.company_id)) {
    throw new OwnerError(409, 'email_in_use', 'This email is already used by another Atelier account. Use a different one.', { fields: { managerEmail: 'Already used by another Atelier account.' } })
  }

  const supabase = db()
  let store = null
  for (let attempt = 0; attempt < 2 && !store; attempt++) {
    const { data: storeId, error: idErr } = await supabase.rpc('owner_new_store_id', { p_company_id: ctx.company.company_id, p_city: v.city })
    if (idErr && /company_code/.test(idErr.message)) {
      throw new OwnerError(409, 'no_company_code', 'Your organization has no store code yet — contact Atelier support.')
    }
    check(idErr)
    const { data, error } = await supabase.from('b2b_stores').insert({
      store_id: storeId, company_id: ctx.company.company_id, store_name: v.storeName, store_email: v.managerEmail,
      store_address: v.address || null, city: v.city, state: v.state, pincode: v.pincode || null,
      manager_name: v.managerName, manager_phone: v.phone, subscription_plan: null, invited_at: new Date().toISOString(),
    }).select('store_id, store_name, city').single()
    if (error?.code === '23505') {
      if (/email/i.test(`${error.message} ${error.details ?? ''}`)) {
        throw new OwnerError(409, 'email_in_use', 'This email is already used by another Atelier account. Use a different one.', { fields: { managerEmail: 'Already used by another Atelier account.' } })
      }
      continue // store id taken by a parallel request: pick the next one
    }
    check(error)
    store = data
  }
  if (!store) throw new Error('addStore: could not allocate a store id')

  let sent
  try {
    sent = await issueInvite(ctx, store, {
      managerName: v.managerName, managerEmail: v.managerEmail, managerPhone: v.phone, note: v.note,
    }, appBase)
  } catch (err) {
    await supabase.from('b2b_stores').delete().eq('store_id', store.store_id).is('activated_at', null)
    throw err
  }
  await audit(auditCtx(ctx), 'invite_sent', store.store_id, { email: v.managerEmail, emailStatus: sent.emailStatus })
  return { store: toRow(await rowFor(ctx, store.store_id)), emailStatus: sent.emailStatus, testInviteUrl: sent.testInviteUrl }
}

// ── Invite lifecycle and store actions ───────────────────────────────────────

export async function resendInvite(ctx, storeId, { appBase }) {
  const r = await rowFor(ctx, storeId)
  if (r.owner_status !== 'invited' && r.owner_status !== 'invite_expired') {
    throw new OwnerError(409, 'not_invited', 'This store’s manager has already accepted the invite.')
  }
  if (!allow('owner-invites', ctx.owner.owner_id, 30, 3_600_000)) {
    throw new OwnerError(429, 'too_many', 'You’ve sent a lot of invites. Try again in an hour.')
  }
  const sent = await issueInvite(ctx, r, {
    inviteId: r.invite_id ?? undefined,
    managerName: r.manager_name || 'Store manager', managerEmail: normEmail(r.manager_email), managerPhone: r.manager_phone,
  }, appBase)
  await audit(auditCtx(ctx), 'invite_resent', storeId, { emailStatus: sent.emailStatus })
  return { store: toRow(await rowFor(ctx, storeId)), emailStatus: sent.emailStatus, testInviteUrl: sent.testInviteUrl }
}

export async function inviteLink(ctx, storeId, { appBase }) {
  const r = await rowFor(ctx, storeId)
  if (r.owner_status !== 'invited' || !r.invite_id) {
    throw new OwnerError(409, 'not_invited', 'There’s no open invite for this store. Resend it to get a new link.')
  }
  const { data, error } = await db().from('b2b_store_invites').select('id, token_nonce').eq('id', r.invite_id).single()
  check(error)
  return { url: inviteUrl(appBase, data.id, data.token_nonce), expiresAt: r.invite_expires_at }
}

export async function changeInviteEmail(ctx, storeId, email, { appBase }) {
  const r = await rowFor(ctx, storeId)
  if (r.owner_status !== 'invited') throw new OwnerError(409, 'not_invited', 'The manager email can only be changed while the invite is open.')
  const e = normEmail(email)
  if (!isEmail(e)) throw new OwnerError(400, 'invalid', 'Enter a valid email address.', { fields: { managerEmail: 'Enter a valid email address.' } })
  if (e === normEmail(ctx.owner.email)) throw new OwnerError(400, 'invalid', 'Use the manager’s own email, not yours.', { fields: { managerEmail: 'Use the manager’s own email, not yours.' } })
  if (e === normEmail(r.manager_email)) return { store: toRow(r), emailStatus: r.invite_email_status }
  const rows = await loadRows(ctx.company.company_id)
  const other = rows.find((x) => x.store_id !== storeId && normEmail(x.manager_email) === e)
  if (other) throw new OwnerError(409, 'manages_store', `This person already manages ${other.store_name}.`, { fields: { managerEmail: `Already the manager of ${other.store_name}.` } })
  if (await emailTakenElsewhere(e, ctx.company.company_id)) {
    throw new OwnerError(409, 'email_in_use', 'This email is already used by another Atelier account.', { fields: { managerEmail: 'Already used by another Atelier account.' } })
  }
  const { error } = await db().from('b2b_stores').update({ store_email: e, updated_at: new Date().toISOString() })
    .eq('store_id', storeId).is('activated_at', null)
  if (error?.code === '23505') throw new OwnerError(409, 'email_in_use', 'This email is already used by another Atelier account.')
  check(error)
  const sent = await issueInvite(ctx, r, {
    inviteId: r.invite_id ?? undefined, managerName: r.manager_name || 'Store manager', managerEmail: e, managerPhone: r.manager_phone,
  }, appBase)
  await audit(auditCtx(ctx), 'invite_email_changed', storeId, { from: r.manager_email, to: e })
  return { store: toRow(await rowFor(ctx, storeId)), emailStatus: sent.emailStatus, testInviteUrl: sent.testInviteUrl }
}

/** Revoke (open invite) or Delete (expired invite): the never-activated store is removed. */
export async function removeInvitedStore(ctx, storeId, { action }) {
  const r = await rowFor(ctx, storeId)
  const allowed = action === 'revoke' ? ['invited'] : ['invite_expired', 'invited']
  if (!allowed.includes(r.owner_status) || r.activated_at) {
    throw new OwnerError(409, 'not_invited', 'Only stores whose invite hasn’t been accepted can be removed.')
  }
  const supabase = db()
  if (r.invite_id) await supabase.from('b2b_store_invites').update({ status: 'revoked' }).eq('id', r.invite_id)
  const { error } = await supabase.from('b2b_stores').delete().eq('store_id', storeId)
    .eq('company_id', ctx.company.company_id).is('activated_at', null)
  check(error)
  await audit(auditCtx(ctx), action === 'revoke' ? 'invite_revoked' : 'store_deleted', storeId, { name: r.store_name, email: r.manager_email })
  return { ok: true }
}

/** Deactivate: the store's iPads are signed out and locked; remaining credits are frozen. */
export async function deactivateStore(ctx, storeId) {
  const r = await rowFor(ctx, storeId)
  if (!['active', 'pending', 'low_credits', 'expired'].includes(r.owner_status)) {
    throw new OwnerError(409, 'cannot_deactivate', 'This store can’t be deactivated.')
  }
  const supabase = db()
  const { error } = await supabase.rpc('set_store_status', {
    p_store_id: storeId, p_status: 'inactive', p_admin_id: null, p_note: `deactivated by owner ${ctx.owner.email}`, p_trial_ends_at: null,
  })
  check(error)
  await supabase.from('b2b_stores').update({ deactivated_at: new Date().toISOString() }).eq('store_id', storeId)
  const { data: devices } = await supabase.from('b2b_devices').update({ status: 'sign_out_requested' })
    .eq('store_id', storeId).eq('status', 'active').select('device_id')
  await audit(auditCtx(ctx), 'store_deactivated', storeId, {
    name: r.store_name, devicesSignedOut: devices?.length ?? 0, creditsFrozen: r.usable_credits,
  })
  return { store: toRow(await rowFor(ctx, storeId)) }
}

// ── The manager's side: accepting an invite (public, token in the link) ──────

async function inviteForToken(token) {
  const id = inviteIdOf(token)
  if (!id) return null
  const { data, error } = await db().from('b2b_store_invites')
    .select('*, b2b_stores(store_id, store_name, city, store_email, activated_at, status, company_id), b2b_companies(company_name, brand_name)')
    .eq('id', id).maybeSingle()
  check(error)
  if (!data || !inviteTokenMatches(token, data.id, data.token_nonce)) return null
  return data
}

function assertOpen(inv) {
  const s = inv?.b2b_stores
  if (inv?.status === 'accepted' || s?.activated_at) {
    throw new OwnerError(409, 'already_accepted', 'This invite has already been accepted. Sign in with your store login.')
  }
  const open = inv && inv.status === 'sent' && Date.parse(inv.expires_at) > Date.now() && s &&
    s.status !== 'inactive' && normEmail(s.store_email) === normEmail(inv.manager_email)
  if (!open) throw new OwnerError(410, 'invalid_invite', INVALID_INVITE)
}

async function authUserFor(email) {
  const { data, error } = await db().rpc('owner_auth_user_for_email', { p_email: email })
  check(error)
  return data ?? null
}

export async function readInvite(token, { ip }) {
  if (!inviteIdOf(token)) throw new OwnerError(410, 'invalid_invite', INVALID_INVITE)
  if (!allow('invite-read', ip, 60, 15 * 60_000)) throw new OwnerError(429, 'too_many', 'Too many attempts. Try again in 15 minutes.')
  const inv = await inviteForToken(token)
  assertOpen(inv)
  return {
    storeName: inv.b2b_stores.store_name,
    city: inv.b2b_stores.city ?? '',
    organization: inv.b2b_companies ? orgName(inv.b2b_companies) : '',
    managerName: inv.manager_name,
    managerEmail: inv.manager_email,
    hasAccount: !!(await authUserFor(inv.manager_email)),
    expiresAt: inv.expires_at,
  }
}

/**
 * The manager accepts: their store login is created (or their existing Atelier
 * account becomes the store login), the store moves to Pending and the owner
 * is told.
 */
export async function acceptInvite(token, { password }, { ip }) {
  if (!inviteIdOf(token)) throw new OwnerError(410, 'invalid_invite', INVALID_INVITE)
  if (!allow('invite-accept', ip, 20, 15 * 60_000)) throw new OwnerError(429, 'too_many', 'Too many attempts. Try again in 15 minutes.')
  const inv = await inviteForToken(token)
  assertOpen(inv)
  const email = normEmail(inv.manager_email)
  const existing = await authUserFor(email)
  if (!existing) {
    const problems = passwordProblems(password)
    if (problems.length) throw new OwnerError(400, 'weak_password', 'Choose a stronger password.', { problems })
  }

  const supabase = db()
  const { data: claimed, error: cErr } = await supabase.from('b2b_store_invites')
    .update({ status: 'accepted', accepted_at: new Date().toISOString() }).eq('id', inv.id).eq('status', 'sent').select('id')
  check(cErr)
  if (!claimed?.length) throw new OwnerError(410, 'invalid_invite', INVALID_INVITE)
  try {
    if (existing) {
      // They proved they own the inbox by opening the link: confirm the email
      // (store logins must be confirmed). Their password is left as it is.
      const { error } = await supabase.auth.admin.updateUserById(existing, { email_confirm: true })
      if (error) throw error
    } else {
      const { error } = await supabase.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { name: inv.manager_name },
      })
      if (error) throw error
    }
    const { error: sErr } = await supabase.from('b2b_stores')
      .update({ activated_at: new Date().toISOString(), manager_name: inv.manager_name, updated_at: new Date().toISOString() })
      .eq('store_id', inv.store_id).is('activated_at', null)
    check(sErr)
  } catch (err) {
    await supabase.from('b2b_store_invites').update({ status: 'sent', accepted_at: null }).eq('id', inv.id)
    throw err
  }

  const storeName = inv.b2b_stores.store_name
  const first = String(inv.manager_name || '').split(' ')[0] || inv.manager_email
  notifyOwner({
    companyId: inv.company_id, category: 'store_activity', storeId: inv.store_id, storeName,
    title: 'Invite accepted',
    body: `${first} accepted your invite. ${storeName} is now Pending — it becomes Active once it buys a credit package.`,
    link: { screen: 'store', storeId: inv.store_id }, dedupeKey: `accepted:${inv.id}`,
  })
  return { email, storeName, hadAccount: !!existing }
}
