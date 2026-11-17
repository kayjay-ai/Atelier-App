import type { PricingOption } from './types'

// Client mirror of the server's pricing (backend/lib/pricing.mjs). The SERVER is the
// source of truth — the actual charge amount is computed server-side from the
// purchase `type`, never sent by the client — but these defaults let the UI render
// instantly and offline. The Premium screen also fetches GET /api/payments/pricing
// and prefers that if it differs.

export const FREE_CREDITS = 3

export const PRICING_OPTIONS: PricingOption[] = [
  { type: 'per_generation', label: 'Starter', blurb: 'One try-on, on demand', amountInr: 15, credits: 1 },
  { type: 'pack_30', label: 'Plus', blurb: '30 try-ons', amountInr: 350, credits: 30 },
  { type: 'pack_100', label: 'Pro', blurb: '100 try-ons', amountInr: 700, credits: 100 },
]

// Indian digit grouping everywhere: ₹18,000 · ₹1,26,000
export const inr = (n: number) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
