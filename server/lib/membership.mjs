import { FREE_CREDITS, purchaseFor } from './pricing.mjs'
import { serviceDb } from './db.mjs'

/** One-time free credit allowance for a new account (see pricing.mjs). */
export const FREE_TRYON_LIMIT = FREE_CREDITS

/** True when Supabase is configured — otherwise gating is disabled (local dev). */
export function membershipEnabled() {
  return !!serviceDb()
}

function extractBearer(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || ''
  const m = /^Bearer\s+(.+)$/i.exec(header)
  return m ? m[1].trim() : null
}

// One token check per request: several handlers (company gate, try-on, the
// activity log) ask for the same user.
const userCache = new WeakMap()

/** Verify a Supabase access token and return the auth user (or null). */
export function getUserFromRequest(req) {
  if (req && typeof req === 'object') {
    if (!userCache.has(req)) userCache.set(req, verifyUser(req))
    return userCache.get(req)
  }
  return verifyUser(req)
}

async function verifyUser(req) {
  const token = extractBearer(req)
  if (!token) return null
  const admin = serviceDb()
  if (!admin) return null
  try {
    const { data, error } = await admin.auth.getUser(token)
    if (error || !data?.user) return null
    return data.user
  } catch {
    return null
  }
}

function shape(row) {
  // `memberships.plan` is the SINGLE SOURCE OF TRUTH for premium — the admin portal
  // writes plan='premium' here (set-plan). plan is also set to a purchase type by
  // add_credits. Premium = unlimited (bypasses the credit balance); otherwise the
  // credit-purchase model applies and the balance gates & displays.
  const plan = row?.plan ?? null
  const isPremium = plan === 'premium'
  const creditsBalance = row?.credits_balance ?? FREE_CREDITS
  return {
    plan,
    isPremium,
    creditsBalance,
    freeCreditsUsed: !!row?.free_credits_used,
    // legacy field kept for older clients; premium is effectively unlimited.
    remaining: isPremium ? null : creditsBalance,
  }
}

// Columns added by supabase/migrations/credit-packs.sql. If that migration hasn't
// run, selecting them errors — degrade so nothing crashes.
const CREDIT_COLS = 'plan, credits_balance, free_credits_used'
const isMissingCreditCol = (msg) => !!msg && /credits_balance|free_credits_used|column .* does not exist|schema cache/i.test(msg)

/** Read a user's current credit balance. Falls back to the free default if missing. */
export async function getMembership(userId) {
  const admin = serviceDb()
  if (!admin) return null
  let { data, error } = await admin.from('memberships').select(CREDIT_COLS).eq('user_id', userId).maybeSingle()
  if (error && isMissingCreditCol(error.message)) {
    // Migration not applied yet — report the free default rather than erroring.
    return shape({ plan: null, credits_balance: FREE_CREDITS })
  }
  if (error) throw error
  if (!data) return shape({ plan: null, credits_balance: FREE_CREDITS })
  return shape(data)
}

/** Atomically spend one credit. Returns { allowed, membership }. */
export async function reserveTryOn(userId) {
  const admin = serviceDb()
  if (!admin) return { allowed: true, membership: null }
  // Premium (admin-granted, plan='premium') is unlimited — never consume a credit
  // or block, regardless of credits_balance. plan is the source of truth.
  const current = await getMembership(userId)
  if (current?.isPremium) return { allowed: true, membership: current }
  const { data, error } = await admin.rpc('consume_tryon', { p_user_id: userId })
  if (error) throw error
  return {
    allowed: !!data?.allowed,
    membership: shape({ plan: data?.plan, credits_balance: data?.credits_balance }),
  }
}

/** Return a reserved try-on (used when generation ultimately fails). */
export async function refundTryOn(userId) {
  const admin = serviceDb()
  if (!admin) return
  try {
    await admin.rpc('refund_tryon', { p_user_id: userId })
  } catch (err) {
    console.warn('[Atelier] refundTryOn failed:', err?.message)
  }
}


// ── Cashfree credit purchases (service-role only) ────────────────────────────

/**
 * Record an order we just created (status 'created') in `purchases`. This ties the
 * Cashfree order to the user + the exact credits to grant, and is the idempotency
 * ledger: cashfree_order_id is unique and the created→paid flip is atomic.
 */
export async function createPurchase(userId, { orderId, type, amountInr, credits }) {
  const admin = serviceDb()
  if (!admin) return
  const { error } = await admin.from('purchases').insert({
    user_id: userId,
    type,
    amount_inr: amountInr,
    credits_granted: credits,
    cashfree_order_id: orderId,
    status: 'created',
  })
  if (error) throw error
}

/** Who does this order belong to? Used by webhook + status to map order → user. */
export async function getPurchaseUser(orderId) {
  const admin = serviceDb()
  if (!admin) return null
  const { data, error } = await admin
    .from('purchases')
    .select('user_id, status, type, credits_granted')
    .eq('cashfree_order_id', orderId)
    .maybeSingle()
  if (error) throw error
  return data ?? null
}

/**
 * Grant credits for a VERIFIED order. Idempotent: the purchases row is flipped
 * created→paid atomically with `.neq('status','paid')`; only the first caller
 * matches a row and adds credits, so duplicate webhook/status calls never
 * double-grant. Credits are added to the balance via add_credits (service role).
 *
 * @returns {{ granted: boolean, userId: string|null, membership: object|null }}
 */
export async function grantCredits(orderId, { paidAmount } = {}) {
  const admin = serviceDb()
  if (!admin) return { granted: false, userId: null, membership: null }

  // Verify before granting: the amount Cashfree actually charged must equal the
  // amount this order was created for, and the credits must not exceed what
  // that pack gives. (Rows are server-written since lock-down-purchases.sql;
  // this also protects orders created before that migration ran.)
  const pending = await getPurchaseUser(orderId)
  if (pending && pending.status !== 'paid') {
    const { data: row, error: rowErr } = await admin
      .from('purchases').select('amount_inr').eq('cashfree_order_id', orderId).maybeSingle()
    if (rowErr) throw rowErr
    const paise = (n) => Math.round(Number(n) * 100)
    if (!Number.isFinite(Number(paidAmount)) || paise(paidAmount) !== paise(row?.amount_inr)) {
      console.error(`[Atelier] grantCredits: order ${orderId} AMOUNT MISMATCH paid=${paidAmount} expected=${row?.amount_inr} — not granted`)
      return { granted: false, userId: pending.user_id, membership: null, review: true }
    }
    const pack = await purchaseFor(pending.type)
    if (!pack || pending.credits_granted > pack.credits) {
      console.error(`[Atelier] grantCredits: order ${orderId} credits ${pending.credits_granted} exceed pack ${pending.type} (${pack?.credits}) — not granted`)
      return { granted: false, userId: pending.user_id, membership: null, review: true }
    }
  }

  const { data: rows, error } = await admin
    .from('purchases')
    .update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('cashfree_order_id', orderId)
    .neq('status', 'paid')
    .select('user_id, credits_granted, type')

  if (error) throw error

  if (!rows || rows.length === 0) {
    // Already paid (idempotent no-op) or unknown order. Return current balance if we can.
    const existing = await getPurchaseUser(orderId)
    console.log(`[Atelier] grantCredits: order ${orderId} not newly granted (already paid or unknown).`)
    return { granted: false, userId: existing?.user_id ?? null, membership: existing?.user_id ? await getMembership(existing.user_id) : null }
  }

  const row = rows[0]
  const { error: addErr } = await admin.rpc('add_credits', {
    p_user_id: row.user_id,
    p_amount: row.credits_granted,
    p_plan: row.type,
  })
  if (addErr) throw addErr

  console.log(`[Atelier] grantCredits: +${row.credits_granted} credits to ${row.user_id} for order ${orderId} (${row.type})`)
  return { granted: true, userId: row.user_id, membership: await getMembership(row.user_id) }
}
