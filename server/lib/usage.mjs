import { getUserFromRequest } from './membership.mjs'
import { serviceDb } from './db.mjs'

/** True when Supabase is configured — otherwise logging is a no-op (local dev). */
export function usageLoggingEnabled() {
  return !!serviceDb()
}

/**
 * Record one feature usage event. Fire-and-forget: never throws and never blocks
 * the response — a logging failure must not break the actual feature.
 *
 * @param {object}  opts
 * @param {import('express').Request} [opts.req]   Request to resolve the user from (if userId not given)
 * @param {string}  [opts.userId]                  Pre-resolved auth user id (skips token verification)
 * @param {string}   opts.feature                  style|size|color|verdict|tryon|garment_from_url
 * @param {string}  [opts.status]                  success|fallback|error|blocked|paywall|denied
 * @param {string}  [opts.productName]             Human-readable garment/product label
 * @param {object}  [opts.metadata]                Extra context (occasion, size, call, host, …)
 * @param {object}  [opts.columns]                 Extra columns from b2b-integration.sql (channel,
 *                                                 company_id, store_id, device_id, credits_used, brand,
 *                                                 source, source_url, domain)
 */
export async function logUsage({ req, userId, feature, status = 'success', productName, metadata, columns }) {
  const admin = serviceDb()
  if (!admin || !feature) return
  try {
    let uid = userId ?? null
    if (!uid && req) {
      const user = await getUserFromRequest(req)
      uid = user?.id ?? null
    }
    const row = {
      user_id: uid,
      feature,
      status,
      product_name: productName ?? null,
      metadata: metadata ?? null,
    }
    const { error } = await admin.from('usage_events').insert({ ...row, ...(columns ?? {}) })
    // b2b-integration.sql not applied yet → the extra columns don't exist; keep the base row.
    if (error && columns && /column|schema cache/i.test(error.message)) {
      await admin.from('usage_events').insert(row)
    } else if (error) {
      throw error
    }
  } catch (err) {
    console.warn('[Atelier] logUsage failed:', err?.message)
  }
}
