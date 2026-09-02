import type { PricingOption } from './types'

// Client mirror of the server's pricing (server/lib/pricing.mjs). The SERVER is the
// source of truth — the actual charge amount is computed server-side from the
// purchase `type`, never sent by the client — but these defaults let the UI render
// instantly and offline. The Premium screen also fetches GET /api/payments/pricing
// and prefers that if it differs.

export const FREE_CREDITS = 3

export const PRICING_OPTIONS: PricingOption[] = [
  { type: 'per_generation', label: 'Pay per generation', blurb: 'One generation, on demand', amountInr: 15, credits: 1 },
  { type: 'pack_30', label: 'Starter pack', blurb: '30 credits', amountInr: 350, credits: 30 },
  { type: 'pack_100', label: 'Value pack', blurb: '100 credits', amountInr: 700, credits: 100 },
]

export const inr = (n: number) => `₹${n}`
