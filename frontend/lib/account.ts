import { create } from 'zustand'
import { supabase } from './supabaseClient'
import type { Account, Client, ClientFeature, ClientStatus, Plan, Store } from './types'
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
  'store_id, store_name, store_address, city, state, pincode, subscription_plan, credits_balance, ' +
  'trial_ends_at, renewal_at, b2b_companies(company_name, brand_name, logo_url, gstin, manager_name, manager_email, primary_contact)'

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

/**
 * The store's status and what it can spend now, from the database: the
 * b2b_store_credits view (supabase/migrations/b2b-store-credits.sql) holds both
 * rules, for the app and the API alike. Before that migration: the status from
 * store_effective_status() and the raw balance.
 */
async function storeState(row: any): Promise<{ status: ClientStatus; usableCredits: number }> {
  const { data, error } = await supabase.from('b2b_store_credits')
    .select('effective_status, usable_credits').eq('store_id', row.store_id).maybeSingle<any>()
  if (!error && data) return { status: data.effective_status, usableCredits: data.usable_credits }
  if (error && !isMissingTable(error.message)) throw error
  const { data: status, error: sErr } = await supabase.rpc('store_effective_status', { p_store_id: row.store_id })
  if (sErr) throw sErr
  return { status: status as ClientStatus, usableCredits: row.credits_balance ?? 0 }
}

function toClient(row: any, state: { status: ClientStatus; usableCredits: number }): Client {
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
    usableCredits: state.usableCredits,
    status: state.status,
    trialEndsAt: row.trial_ends_at ?? null,
    renewalAt: row.renewal_at ?? null,
  }
}

/** Credits the store can spend right now (from the database; see storeState). */
export function usableCredits(client: Client): number {
  return client.usableCredits ?? client.creditsBalance
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
  const { data: row, error } = await byEmail(STORE_SELECT)
  if (error) {
    if (isMissingTable(error.message)) return { type: 'b2c_customer' }
    throw error
  }
  if (!row) return { type: 'b2c_customer' }

  const client = toClient(row, await storeState(row))
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
    // The server reports the balance right after a debit, which first drops any
    // expired plan credits, so at that moment the whole balance is spendable.
    const creditsBalance = Math.max(0, n)
    set({ account: { ...account, client: { ...account.client, creditsBalance, usableCredits: creditsBalance } } })
  },
  clear: () => set({ userId: null, email: null, account: null, session: null, loadedAt: 0 }),
  dismissNotice: () => {
    const session = get().session
    if (session) set({ session: { ...session, notice: null } })
  },
}))
