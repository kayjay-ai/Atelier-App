import crypto from 'crypto'
import { cashfreeConfigured, cashfreeMode, createOrder, getOrder } from './cashfree.mjs'
import { serviceDb, isMissingSchema } from './db.mjs'

// =============================================================================
// B2B in-app payments — a store pays for a plan or a credit top-up through
// Cashfree (supabase/migrations/b2b-payments.sql has the billing rules).
//
// Trust model: the server decides WHAT is bought and for HOW MUCH (from the
// b2b_plans / b2b_topup_packs tables) and writes it to b2b_payments, which no
// client can write. Credits are applied only after Cashfree confirms the order
// server-to-server AND the paid amount matches, by apply_b2b_payment(), which
// flips created→paid atomically — so a webhook and the status poll can both
// run without double-granting.
// =============================================================================

// Same-plan renewals and downgrades open this many days before the cycle ends
// (each plan payment starts a new cycle that day, so earlier would forfeit days).
// apply_b2b_payment() re-checks this at pay time via app_settings
// 'b2b_renew_window_days' (default 3) — change both together.
export const RENEW_WINDOW_DAYS = 3
const DAY_MS = 86_400_000

// Plan and pack prices are EXCLUSIVE of GST; the store pays price + GST.
export const GST_RATE = 0.18
const paise = (n) => Math.round(Number(n) * 100)
/** { base, gst, total } in rupees, rounded to the paisa. */
export function withGst(base) {
  const gst = paise(base * GST_RATE) / 100
  return { base, gst, total: (paise(base) + paise(gst)) / 100 }
}

export class BillingError extends Error {
  constructor(status, message, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

// Built-in Terms (backend/legal/b2b-terms.html, served at /legal/b2b-terms).
// Bump this together with the version line in that file whenever it changes —
// stores must then accept the new version before their next payment.
export const BUILTIN_TERMS_VERSION = '2026-11-03'

/**
 * The Terms the store must accept before paying: B2B_TERMS_URL when set (your
 * own page, versioned by B2B_TERMS_VERSION), otherwise the built-in page.
 * @param {string} apiBase  public base URL of this API (for the built-in page)
 */
export function termsConfig(apiBase) {
  const url = (process.env.B2B_TERMS_URL || '').trim()
  if (url) return { url, version: (process.env.B2B_TERMS_VERSION || '1').trim() }
  if (!apiBase) return null
  return { url: `${apiBase.replace(/\/$/, '')}/legal/b2b-terms`, version: BUILTIN_TERMS_VERSION }
}

function db() {
  const client = serviceDb()
  if (!client) throw new BillingError(503, 'Payments are not available right now.', 'no_database')
  return client
}

// When b2b-payments.sql isn't applied (isMissingSchema), billing reports itself
// as switched off instead of failing.
const NOT_SET_UP = 'Online payment isn’t switched on yet — contact Atelier support.'

const STORE_COLS = 'store_id, store_name, company_id, status, subscription_plan, credits_balance, trial_ends_at, renewal_at, ' +
  'b2b_companies(status, company_name, brand_name, primary_contact, manager_email)'

/** The store row; `noMigration` is true when b2b-payments.sql hasn't been applied. */
async function loadStore(supabase, storeId) {
  const query = (cols) => supabase.from('b2b_stores').select(cols).eq('store_id', storeId).maybeSingle()
  let noMigration = false
  let { data, error } = await query(`${STORE_COLS}, topup_credits`)
  if (error && isMissingSchema(error)) {
    noMigration = true
    ;({ data, error } = await query(STORE_COLS))
  }
  if (error) throw error
  if (!data) throw new BillingError(404, 'Store not found.', 'unknown_store')
  return { ...data, topup_credits: data.topup_credits ?? 0, noMigration }
}

async function loadCatalog(supabase, currentPlanId) {
  const [plans, packs, current, grace] = await Promise.all([
    supabase.from('b2b_plans').select('id, name, price_inr, cycle, credits_included').eq('active', true).order('price_inr'),
    supabase.from('b2b_topup_packs').select('id, credits, price_inr').eq('active', true).order('credits'),
    currentPlanId
      ? supabase.from('b2b_plans').select('id, name, price_inr, credits_included').eq('id', currentPlanId).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from('app_settings').select('value').eq('key', 'b2b_grace_days').maybeSingle(),
  ])
  if (plans.error) throw plans.error
  if (packs.error && !isMissingSchema(packs.error)) throw packs.error
  return {
    plans: plans.data ?? [],
    packs: packs.error ? [] : packs.data ?? [],
    currentPlan: current.data ?? null,
    graceDays: Number(grace.data?.value) || 7,
  }
}

async function suspendedByExpiry(supabase, storeId) {
  const { data, error } = await supabase.rpc('store_suspended_by_expiry', { p_store_id: storeId })
  if (error) {
    if (isMissingSchema(error)) return false
    throw error
  }
  return data === true
}

const fmtDate = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })

/**
 * What this store may buy right now, and why not when it can't. Server-side
 * source of truth — the app only displays it; createB2BOrder re-checks it.
 */
function eligibility(store, catalog, byExpiry) {
  const now = Date.now()
  const company = store.b2b_companies ?? {}
  const renewalAt = store.renewal_at ? new Date(store.renewal_at).getTime() : null
  const activeCycle = !!store.subscription_plan && renewalAt !== null && renewalAt > now

  let blocked = null
  if (company.status === 'inactive' || store.status === 'inactive') blocked = 'Your account is paused — contact Atelier support.'
  else if (store.status === 'suspended' && !byExpiry) blocked = 'Your account is on hold — contact Atelier support.'

  const plans = catalog.plans.map((p) => {
    if (blocked) return { ...p, action: null, allowed: false, reason: blocked }
    if (!activeCycle) return { ...p, action: store.subscription_plan === p.id ? 'renew' : 'choose', allowed: true, reason: null }
    const currentPrice = catalog.currentPlan?.price_inr ?? 0
    if (p.id !== store.subscription_plan && p.price_inr > currentPrice) {
      return { ...p, action: 'upgrade', allowed: true, reason: null }
    }
    const opensAt = renewalAt - RENEW_WINDOW_DAYS * DAY_MS
    const action = p.id === store.subscription_plan ? 'renew' : 'switch'
    if (now >= opensAt) return { ...p, action, allowed: true, reason: null }
    return {
      ...p, action, allowed: false,
      reason: action === 'renew' ? `You can renew from ${fmtDate(opensAt)}.` : `You can switch to ${p.name} from ${fmtDate(opensAt)}.`,
    }
  })

  // Top-ups only make sense while the store can actually spend credits.
  const trialLive = store.trial_ends_at && !store.renewal_at && new Date(store.trial_ends_at).getTime() > now
  const inGrace = renewalAt !== null && renewalAt + catalog.graceDays * DAY_MS > now
  let topupReason = blocked
  if (!topupReason && store.status === 'suspended') topupReason = 'Renew your plan first — top-ups are added on top of an active plan.'
  if (!topupReason && !trialLive && !inGrace) {
    topupReason = store.subscription_plan || store.renewal_at
      ? 'Renew your plan first — top-ups are added on top of an active plan.'
      : 'Choose a plan first — top-ups are added on top of an active plan.'
  }
  const packs = catalog.packs.map((k) => ({ ...k, allowed: !topupReason, reason: topupReason }))

  return { plans, packs }
}

// Plan credits of a cycle that has ended are already gone (the DB expires
// them lazily), so report them as 0 even before that runs.
function balances(store) {
  const total = store.credits_balance ?? 0
  const topup = Math.min(store.topup_credits ?? 0, total)
  const ended = store.renewal_at && new Date(store.renewal_at).getTime() <= Date.now()
  const plan = ended ? 0 : total - topup
  return { planCredits: plan, topupCredits: topup, totalCredits: plan + topup }
}

async function recentPayments(supabase, storeId) {
  const { data, error } = await supabase
    .from('b2b_payments')
    .select('order_id, kind, item_id, item_name, amount_inr, credits, status, created_at, paid_at')
    .eq('store_id', storeId).in('status', ['paid', 'failed', 'review'])
    .order('created_at', { ascending: false }).limit(20)
  if (error) {
    if (isMissingSchema(error)) return []
    throw error
  }
  return data ?? []
}

/** Everything the Plan & Credits screen needs, for the signed-in store. */
export async function billingOverview(storeId, { apiBase } = {}) {
  const supabase = db()
  const store = await loadStore(supabase, storeId)
  const [catalog, byExpiry, payments] = await Promise.all([
    loadCatalog(supabase, store.subscription_plan),
    store.status === 'suspended' ? suspendedByExpiry(supabase, storeId) : false,
    store.noMigration ? [] : recentPayments(supabase, storeId),
  ])
  let { plans, packs } = eligibility(store, catalog, byExpiry)
  if (store.noMigration) {
    plans = plans.map((p) => ({ ...p, allowed: false, reason: NOT_SET_UP }))
    packs = []
  }
  const terms = termsConfig(apiBase)
  return {
    enabled: cashfreeConfigured() && !!terms && !store.noMigration,
    setup: { cashfree: cashfreeConfigured(), terms: !!terms, database: !store.noMigration },
    mode: cashfreeMode(),
    gstInclusive: false,
    gstRate: GST_RATE,
    renewWindowDays: RENEW_WINDOW_DAYS,
    terms,
    store: {
      planId: store.subscription_plan,
      planName: catalog.currentPlan?.name ?? store.subscription_plan,
      planCreditsIncluded: catalog.currentPlan?.credits_included ?? 0,
      renewalAt: store.renewal_at,
      trialEndsAt: store.trial_ends_at,
      ...balances(store),
    },
    plans: plans.map((p) => ({
      id: p.id, name: p.name, priceInr: p.price_inr, gstInr: withGst(p.price_inr).gst, totalInr: withGst(p.price_inr).total,
      cycle: p.cycle, credits: p.credits_included,
      current: p.id === store.subscription_plan, action: p.action, allowed: p.allowed, reason: p.reason,
    })),
    packs: packs.map((k) => ({
      id: k.id, credits: k.credits, priceInr: k.price_inr, gstInr: withGst(k.price_inr).gst, totalInr: withGst(k.price_inr).total,
      allowed: k.allowed, reason: k.reason,
    })),
    payments: payments.map((x) => ({
      orderId: x.order_id, kind: x.kind, itemName: x.item_name, amountInr: Number(x.amount_inr), credits: x.credits,
      status: x.status, createdAt: x.created_at, paidAt: x.paid_at,
    })),
  }
}

// Cashfree needs a 10-digit customer phone; production orders use the
// company's real contact number.
function customerPhone(company) {
  const digits = String(company?.primary_contact ?? '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '')
  if (/^\d{10}$/.test(digits)) return digits
  if (cashfreeMode() === 'sandbox') return '9999999999'
  throw new BillingError(400, 'Your company has no valid contact phone on file — ask Atelier support to add one before paying.', 'no_phone')
}

/**
 * Create a Cashfree order for a plan or top-up. The item, price and credits are
 * looked up here — the client only names the item and confirms the Terms.
 */
export async function createB2BOrder({ user, storeId, kind, itemId, acceptTerms, termsVersion, platform, apiBase, appBase, ip, userAgent }) {
  if (!cashfreeConfigured()) throw new BillingError(503, 'Payments are not set up yet.', 'not_configured')
  const terms = termsConfig(apiBase)
  if (!terms) throw new BillingError(503, 'Payments are not set up yet.', 'no_terms')
  if (acceptTerms !== true || termsVersion !== terms.version) {
    throw new BillingError(400, 'Please accept the Terms & Conditions to continue.', 'terms_required')
  }
  if (kind !== 'plan' && kind !== 'topup') throw new BillingError(400, 'Unknown purchase.', 'bad_kind')
  if (typeof itemId !== 'string' || !itemId) throw new BillingError(400, 'Unknown purchase.', 'bad_item')

  const supabase = db()
  const store = await loadStore(supabase, storeId)
  if (store.noMigration) throw new BillingError(503, 'Payments are not set up yet.', 'no_migration')
  const catalog = await loadCatalog(supabase, store.subscription_plan)
  const byExpiry = store.status === 'suspended' ? await suspendedByExpiry(supabase, storeId) : false
  const { plans, packs } = eligibility(store, catalog, byExpiry)

  const item = kind === 'plan' ? plans.find((p) => p.id === itemId) : packs.find((k) => k.id === itemId)
  if (!item) throw new BillingError(400, 'That option is no longer available.', 'unknown_item')
  if (!item.allowed) throw new BillingError(409, item.reason || 'That option is not available right now.', 'not_allowed')

  const { base, gst, total: amount } = withGst(item.price_inr)
  const credits = kind === 'plan' ? item.credits_included : item.credits
  const itemName = kind === 'plan' ? `${item.name} plan (monthly)` : `${item.credits.toLocaleString('en-IN')} top-up credits`
  const phone = customerPhone(store.b2b_companies)
  const orderId = `b2b_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`

  // Record the order and the Terms acceptance BEFORE Cashfree knows about it, so
  // a payment can never arrive for an order we have no row for.
  const { error: payErr } = await supabase.from('b2b_payments').insert({
    order_id: orderId, store_id: storeId, company_id: store.company_id, user_id: user.id,
    kind, item_id: itemId, item_name: itemName, amount_inr: amount, base_amount_inr: base, gst_inr: gst,
    credits, terms_version: terms.version,
  })
  if (payErr) throw payErr
  const { error: termsErr } = await supabase.from('b2b_terms_acceptances').insert({
    store_id: storeId, user_id: user.id, terms_version: terms.version, terms_url: terms.url, order_id: orderId,
    ip: ip ? String(ip).slice(0, 64) : null, user_agent: userAgent ? String(userAgent).slice(0, 300) : null,
  })
  if (termsErr) throw termsErr

  const returnUrl = platform === 'web'
    ? `${appBase}/store/plan?order_id={order_id}`
    : `${apiBase}/pay/b2b/return?order_id={order_id}`
  const notifyUrl = process.env.API_PUBLIC_URL ? `${process.env.API_PUBLIC_URL}/api/payments/webhook` : undefined

  let order
  try {
    order = await createOrder({
      orderId, amount, currency: 'INR',
      customerId: storeId, customerEmail: user.email, customerPhone: phone,
      returnUrl, notifyUrl, orderNote: `Atelier B2B — ${itemName}`,
    })
  } catch (err) {
    await supabase.from('b2b_payments').update({ status: 'failed', result: { error: err.message } }).eq('order_id', orderId)
    throw err
  }
  await supabase.from('b2b_payments').update({ cf_order_id: order.cfOrderId ?? null }).eq('order_id', orderId)

  console.log(`[Atelier] b2b order ${orderId}: store ${storeId} ${kind} ${itemId} ₹${base} + GST ₹${gst} = ₹${amount} → +${credits} (${cashfreeMode()})`)
  return { orderId, paymentSessionId: order.paymentSessionId, mode: cashfreeMode(), amountInr: amount, baseAmountInr: base, gstInr: gst, credits, itemName }
}

/**
 * Ask Cashfree (server-to-server) whether an order is paid and, if it is and
 * the amount matches, apply it. Safe to call any number of times.
 * @param {{ storeId?: string }} opts  storeId: reject orders of another store.
 */
export async function verifyAndApplyB2BOrder(orderId, { storeId } = {}) {
  const supabase = db()
  const { data: pay, error } = await supabase
    .from('b2b_payments').select('order_id, store_id, amount_inr, status, result').eq('order_id', orderId).maybeSingle()
  if (error) {
    if (isMissingSchema(error)) throw new BillingError(404, 'Order not found.', 'unknown_order')
    throw error
  }
  if (!pay) throw new BillingError(404, 'Order not found.', 'unknown_order')
  if (storeId && pay.store_id !== storeId) throw new BillingError(403, 'This order belongs to another store.', 'not_yours')
  if (pay.status === 'paid') return { status: 'paid', result: pay.result }
  // Held for Atelier to check by hand — don't re-fetch or re-log it every poll.
  if (pay.status === 'review') return { status: 'review', result: null }

  const order = await getOrder(orderId)
  const cfStatus = String(order.orderStatus || '').toUpperCase()
  if (cfStatus === 'PAID') {
    const currency = String(order.raw?.order_currency || 'INR').toUpperCase()
    if (paise(order.orderAmount) !== paise(pay.amount_inr) || currency !== 'INR') {
      // Never grant on a mismatch — hold it for manual review instead.
      console.error(`[Atelier] b2b order ${orderId}: AMOUNT MISMATCH paid=${order.orderAmount} ${currency} expected=${pay.amount_inr} INR — held for review`)
      const result = { error: 'amount_mismatch', paid: order.orderAmount, currency }
      const { error: holdErr } = await supabase.from('b2b_payments')
        .update({ status: 'review', result }).eq('order_id', orderId).eq('status', 'created')
      if (holdErr) {
        // Older b2b-payments.sql without the 'review' status: keep the evidence at least.
        await supabase.from('b2b_payments').update({ result }).eq('order_id', orderId)
      }
      return { status: 'review', result: null }
    }
    const { data, error: applyErr } = await supabase.rpc('apply_b2b_payment', { p_order_id: orderId })
    if (applyErr) throw applyErr
    if (data?.held) {
      console.error(`[Atelier] b2b order ${orderId}: PAID but held for review`, JSON.stringify(data.result))
      return { status: 'review', result: null }
    }
    if (data?.applied) console.log(`[Atelier] b2b order ${orderId}: applied`, JSON.stringify(data.result))
    return { status: 'paid', result: data?.result ?? null }
  }
  if (cfStatus === 'EXPIRED' || cfStatus === 'TERMINATED') {
    await supabase.from('b2b_payments').update({ status: 'failed' }).eq('order_id', orderId).eq('status', 'created')
    return { status: 'failed', result: null }
  }
  return { status: 'pending', result: null }
}

export const isB2BOrderId = (orderId) => typeof orderId === 'string' && orderId.startsWith('b2b_')
