import { createClient } from '@supabase/supabase-js'

// =============================================================================
// The server's one Supabase connection. Service role: bypasses RLS, so the
// server is the sole writer of credits, payments, membership and usage.
//
// Env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. VITE_SUPABASE_URL is still
// accepted as the URL, for .env files written before the rename.
// Returns null when either is unset; callers then degrade (local dev).
// =============================================================================

let client = null
let clientFor = ''

export function supabaseUrl() {
  return (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim()
}

/** The shared service-role client, or null when Supabase isn't configured. */
export function serviceDb() {
  const url = supabaseUrl()
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
  if (!url || !key) return null
  if (!client || clientFor !== `${url}\n${key}`) {
    client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
    clientFor = `${url}\n${key}`
  }
  return client
}

/** True when a PostgREST / Postgres error means a migration hasn't been applied (missing column / table / function). */
export function isMissingSchema(err) {
  return !!err && (/^(42703|42P01|42883|PGRST20[0-5])$/.test(String(err.code ?? '')) ||
    /does not exist|schema cache|could not find the (table|function|column)/i.test(String(err.message ?? '')))
}
