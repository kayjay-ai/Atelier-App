import path from 'path'
import { fileURLToPath } from 'url'
import { serviceDb } from '../lib/db.mjs'
import { cashfreeConfigured } from '../lib/cashfree.mjs'
import { kindOf } from '../lib/payments.mjs'

// =============================================================================
// Payment safety net. A paid order is normally applied by Cashfree's webhook or
// by the app's status check right after checkout. If both are missed (webhook
// down AND the customer closed the tab), the order would stay 'created' while
// the customer was charged. This asks Cashfree about every recent unfinished
// order and applies the paid ones, with the same idempotent verifyAndApply the
// webhook uses, so running it any number of times never double-grants.
//
// Runs every 30 minutes from cron (`npm run job:reconcile`, deploy/droplet) and
// as a step of the daily job.
// =============================================================================

const MIN_AGE_MS = 10 * 60_000          // leave fresh checkouts to the webhook / app
const MAX_AGE_MS = 3 * 24 * 60 * 60_000 // Cashfree orders expire well before this

async function unfinishedOrderIds(db) {
  const from = new Date(Date.now() - MAX_AGE_MS).toISOString()
  const to = new Date(Date.now() - MIN_AGE_MS).toISOString()
  const [b2b, b2c] = await Promise.all([
    db.from('b2b_payments').select('order_id').eq('status', 'created').gte('created_at', from).lte('created_at', to).limit(200),
    db.from('purchases').select('cashfree_order_id').eq('status', 'created').gte('created_at', from).lte('created_at', to).limit(200),
  ])
  if (b2b.error) throw b2b.error
  if (b2c.error) throw b2c.error
  return [
    ...(b2b.data ?? []).map((r) => r.order_id),
    ...(b2c.data ?? []).map((r) => r.cashfree_order_id),
  ].filter(Boolean)
}

/** @returns {Promise<{ checked: number, applied: number, failed: number, skipped?: boolean }>} */
export async function reconcilePayments() {
  const db = serviceDb()
  if (!db || !cashfreeConfigured()) return { checked: 0, applied: 0, failed: 0, skipped: true }
  const ids = await unfinishedOrderIds(db)
  let applied = 0
  let failed = 0
  for (const orderId of ids) {
    const kind = kindOf(orderId)
    if (!kind) continue
    try {
      const r = await kind.verifyAndApply(orderId)
      if (r?.granted || (kind.name === 'storeBilling' && r?.status === 'paid')) {
        applied++
        console.log(`[Atelier] reconcile: applied paid order ${orderId}`)
      }
    } catch (err) {
      failed++
      console.warn(`[Atelier] reconcile: ${orderId} not checked: ${err?.message}`)
    }
  }
  return { checked: ids.length, applied, failed }
}

// `npm run job:reconcile` (from the repo root). Loads .env only when run as a
// script: importing this module (jobs/daily.mjs) must not change the environment.
if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  import('dotenv/config')
    .then(() => reconcilePayments())
    .then((r) => { console.log('[Atelier] reconcile finished:', JSON.stringify(r)); process.exit(r.failed ? 1 : 0) })
    .catch((err) => { console.error(err); process.exit(1) })
}
