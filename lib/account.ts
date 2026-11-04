import { create } from 'zustand'
import { supabase } from './supabaseClient'
import type { Account, Client, ClientFeature, Plan, Store } from './types'
import { isDemoCompanyEmail, demoAccount, demoReady, DEMO_CLIENT_ID } from './demoCompany'
import { startStoreSession, type StoreSession } from './api'
import { ensureDeviceRegistered } from './device'
import { signOutStore } from './heartbeat'

// ─── Account type routing ─────────────────────────────────────────────────────
// The interface is decided by the DATABASE, never by the sign-in method: a login
// is a store (B2B) account iff its confirmed email is a b2b_stores.store_email.
// RLS (supabase/migrations/b2b-integration.sql) only lets a store login read its
// own b2b_stores row, so the row coming back IS the answer. Everyone else is B2C.

const FEATURES: ClientFeature[] = ['tryon', 'style', 'size']

// Tables not created yet (migration not run) → every login is B2C.
const isMissingTable = (msg?: string) =>
  !!msg && /does not exist|schema cache|could not find the (table|function)/i.test(msg)

// Never select store_password_hash — the app has no use for it.
const STORE_SELECT =
  'store_id, store_name, store_address, city, state, pincode, subscription_plan, status, credits_balance, ' +
  'trial_ends_at, renewal_at, b2b_companies(company_name, brand_name, logo_url, gstin, manager_name, manager_email, primary_contact, status)'

function toPlan(row: any): Plan {
  return {
    id: row.id,
    name: row.name,
    priceInr: row.price_inr,
    cycle: row.cycle,
    creditsIncluded: row.credits_included,
    topupPriceInr: row.topup_price_inr ?? null,
  }
}

// b2b_stores.status + company status → what the app shows (matches
// store_effective_status() in SQL and the server).
function toStatus(row: any): Client['status'] {
  if (row.b2b_companies?.status === 'inactive' || row.status === 'inactive') return 'revoked'
  if (row.status === 'suspended') return 'suspended'
  if (row.trial_ends_at && !row.renewal_at) return 'trial'
  return 'active'
}

function toClient(row: any): Client {
  const c = row.b2b_companies ?? {}
  const address = [row.store_address, row.city, row.state, row.pincode].filter(Boolean).join(', ')
  return {
    id: row.store_id,
    companyName: c.brand_name || c.company_name || row.store_name,
    storeName: row.store_name,
    logoUrl: c.logo_url ?? null,
    contactName: c.manager_name ?? null,
    contactEmail: c.manager_email ?? null,
    contactPhone: c.primary_contact ?? null,
    gstin: c.gstin ?? null,
    billingAddress: address || null,
    planId: row.subscription_plan ?? null,
    creditsBalance: row.credits_balance ?? 0,
    topupCredits: typeof row.topup_credits === 'number' ? row.topup_credits : null,
    status: toStatus(row),
    trialEndsAt: row.trial_ends_at ?? null,
    renewalAt: row.renewal_at ?? null,
  }
}

/**
 * Credits the store can spend right now. Once the cycle's renewal date passes,
 * its plan credits have expired (the DB drops them lazily), so only top-up
 * credits are left — same rule as the server's billing overview.
 */
export function usableCredits(client: Client): number {
  const total = client.creditsBalance
  if (client.topupCredits == null) return total // migration not applied: no split known
  const ended = !!client.renewalAt && Date.parse(client.renewalAt) <= Date.now()
  return ended ? Math.min(client.topupCredits, total) : total
}

/** Resolve the signed-in user's account. Throws on a real (network/DB) failure. */
export async function fetchAccount(userId: string, email?: string | null): Promise<Account> {
  if (isDemoCompanyEmail(email)) { await demoReady(); return demoAccount() } // restores the saved credit balance too

  // RLS returns at most the caller's own store (matched on their confirmed
  // email). The email filter too, so routing stays right even before RLS is on.
  if (!email) return { type: 'b2c_customer' }
  const pattern = email.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`) // ilike = case-insensitive, exact
  const byEmail = (cols: string) =>
    supabase.from('b2b_stores').select(cols).ilike('store_email', pattern).maybeSingle<any>()
  let { data: row, error } = await byEmail(`${STORE_SELECT}, topup_credits`)
  // b2b-payments.sql not applied yet → no topup_credits column; read without it.
  if (error && /topup_credits/i.test(error.message)) ({ data: row, error } = await byEmail(STORE_SELECT))
  if (error) {
    if (isMissingTable(error.message)) return { type: 'b2c_customer' }
    throw error
  }
  if (!row) return { type: 'b2c_customer' }

  const client = toClient(row)
  const [plansRes, featuresRes, storesRes] = await Promise.all([
    supabase.from('b2b_plans').select('*').order('price_inr'),
    supabase.from('b2b_store_features').select('feature, enabled').eq('store_id', client.id),
    supabase.rpc('my_company_stores'),
  ])
  for (const r of [plansRes, featuresRes, storesRes]) if (r.error) throw r.error

  const plans = (plansRes.data ?? []).map(toPlan)
  const features = Object.fromEntries(FEATURES.map((f) => [f, true])) as Record<ClientFeature, boolean>
  for (const r of featuresRes.data ?? []) features[r.feature as ClientFeature] = r.enabled !== false
  const stores: Store[] = ((storesRes.data as any[]) ?? []).map((s) => ({
    id: s.store_id, name: s.store_name, city: s.city ?? null, address: s.store_address ?? null,
  }))

  return {
    type: 'b2b_company',
    role: 'admin',
    client,
    plan: plans.find((p) => p.id === client.planId) ?? null,
    plans,
    stores,
    features,
  }
}

/** Where a signed-in user lands. Guests use the B2C app. */
export function homeFor(account: Account | null): '/store' | '/(tabs)' {
  return account?.type === 'b2b_company' ? '/store' : '/(tabs)'
}

// Admin toggle / credit changes must reach the iPad within ~1 minute (spec §5.3),
// so screens call refresh() on focus; this throttles it to one fetch per 30 s.
const REFRESH_MIN_MS = 30_000

// Company logins also register the iPad with the server (device tracking,
// remote sign-out / block, admin messages). The demo company has no server side.
const isRealCompany = (a: Account | null) => a?.type === 'b2b_company' && a.client.id !== DEMO_CLIENT_ID

/** Admin "Sign out remotely": end this iPad's session (final heartbeat first). */
async function applyRemoteSignOut(session: StoreSession | null): Promise<boolean> {
  if (!session?.signOut) return false
  await signOutStore()
  return true
}

// Register the tablet in b2b_devices BEFORE the server session call, so the
// server finds the same row (by device key) instead of making its own.
async function storeSession(account: Account, heartbeat: boolean): Promise<StoreSession | null> {
  if (account.type === 'b2b_company') await ensureDeviceRegistered(account.client.id).catch(() => null)
  return startStoreSession(heartbeat)
}

interface AccountState {
  userId: string | null
  email: string | null
  account: Account | null
  /** B2B only: this iPad's registration + admin message; null for B2C / offline. */
  session: StoreSession | null
  loadedAt: number
  /** Resolve for the current session (null session → cleared). */
  load: () => Promise<Account | null>
  /** Re-fetch if older than the throttle window (or always with force). */
  refresh: (force?: boolean) => Promise<void>
  /** Apply a server-reported company balance (e.g. after a try-on). */
  setCreditsBalance: (n: number) => void
  clear: () => void
  /** Hide the admin message locally (the caller also tells the server). */
  dismissNotice: () => void
}

export const useAccountStore = create<AccountState>()((set, get) => ({
  userId: null,
  email: null,
  account: null,
  session: null,
  loadedAt: 0,
  load: async () => {
    const { data } = await supabase.auth.getSession()
    const userId = data.session?.user?.id ?? null
    const email = data.session?.user?.email ?? null
    if (!userId) {
      set({ userId: null, email: null, account: null, session: null, loadedAt: 0 })
      return null
    }
    const account = await fetchAccount(userId, email)
    const session = isRealCompany(account) ? await storeSession(account, false) : null
    if (await applyRemoteSignOut(session)) {
      set({ userId: null, email: null, account: null, session: null, loadedAt: 0 })
      return null
    }
    set({ userId, email, account, session, loadedAt: Date.now() })
    return account
  },
  refresh: async (force = false) => {
    const { userId, email, loadedAt } = get()
    if (!userId) return
    if (!force && Date.now() - loadedAt < REFRESH_MIN_MS) return
    try {
      const account = await fetchAccount(userId, email)
      const session = isRealCompany(account) ? await storeSession(account, true) : null
      if (await applyRemoteSignOut(session)) return // SIGNED_OUT listener clears the store
      if (get().userId === userId) set({ account, session: session ?? get().session, loadedAt: Date.now() })
    } catch (err) {
      console.warn('[Atelier] account refresh failed:', err)
    }
  },
  setCreditsBalance: (n) => {
    const account = get().account
    if (account?.type !== 'b2b_company') return
    const creditsBalance = Math.max(0, n)
    // Spending takes plan credits first, so top-ups only shrink to fit the total.
    const topupCredits = account.client.topupCredits == null ? account.client.topupCredits : Math.min(account.client.topupCredits, creditsBalance)
    set({ account: { ...account, client: { ...account.client, creditsBalance, topupCredits } } })
  },
  clear: () => set({ userId: null, email: null, account: null, session: null, loadedAt: 0 }),
  dismissNotice: () => {
    const session = get().session
    if (session) set({ session: { ...session, notice: null } })
  },
}))
