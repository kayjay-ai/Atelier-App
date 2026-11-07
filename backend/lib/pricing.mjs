import { serviceDb } from './db.mjs'

// =============================================================================
// SINGLE SOURCE OF TRUTH for credit pricing. UI reads this (via GET
// /api/payments/pricing), the Cashfree order amount is computed from it
// server-side (client never sends an amount), and the credit grant reads the
// credits value from the same table. Change prices/credits here only.
//
// Model: pay-per-credit, non-recurring. New accounts get FREE_CREDITS one-time,
// then buy more. Purchases ADD to the balance (packs stack). Nothing auto-renews.
// =============================================================================

/** One-time free allowance for a new account (NOT monthly). */
export const FREE_CREDITS = 3

/** The three purchase options. `type` is the stable id used everywhere. */
export const PRICING = {
  per_generation: {
    type: 'per_generation',
    label: 'Pay per generation',
    blurb: 'One generation, on demand',
    amountInr: 15,
    credits: 1,
  },
  pack_30: {
    type: 'pack_30',
    label: 'Starter pack',
    blurb: '30 credits',
    amountInr: 350,
    credits: 30,
  },
  pack_100: {
    type: 'pack_100',
    label: 'Value pack',
    blurb: '100 credits',
    amountInr: 700,
    credits: 100,
  },
}

// The admin can rename and re-price the three plans in public.premium_plans
// (supabase/migrations/b2c-app.sql). The table overrides PRICING above; when it
// is missing or unreachable, PRICING is used unchanged. Cached for a minute.
const CACHE_MS = 60_000
let cache = { at: 0, options: null }

async function loadOptions() {
  if (cache.options && Date.now() - cache.at < CACHE_MS) return cache.options
  let options = Object.values(PRICING).map((o) => ({ ...o, recommended: o.type === 'pack_30' }))
  const db = serviceDb()
  if (db) {
    try {
      const { data, error } = await db.from('premium_plans')
        .select('id, name, blurb, price_inr, credits, recommended, active, sort')
        .order('sort')
      if (error) throw error
      if (data?.length) {
        options = data
          .filter((r) => r.active && PRICING[r.id])
          .map((r) => ({
            type: r.id,
            label: r.name,
            blurb: r.blurb || `${r.credits} credit${r.credits === 1 ? '' : 's'}`,
            amountInr: r.price_inr,
            credits: r.credits,
            recommended: !!r.recommended,
          }))
      }
    } catch (err) {
      if (!/does not exist|schema cache|could not find/i.test(err?.message ?? '')) {
        console.warn('[Atelier] premium_plans unavailable, using built-in pricing:', err?.message)
      }
    }
  }
  cache = { at: Date.now(), options }
  return options
}

/** Look up an active purchase option by type, or null if unknown / switched off. */
export async function purchaseFor(type) {
  return (await loadOptions()).find((o) => o.type === type) ?? null
}

/** Public pricing payload for the client (no secrets). */
export async function pricingPayload() {
  return { freeCredits: FREE_CREDITS, options: await loadOptions() }
}
