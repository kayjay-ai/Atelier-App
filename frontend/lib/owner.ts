import { create } from 'zustand'
import { Platform, Share } from 'react-native'
import { supabase } from './supabaseClient'
import {
  ApiError, fetchOwnerMe, fetchOwnerUnread, ownerLogout,
  type OwnerProfile, type OwnerSessionTokens, type OwnerStoreStatus, type OwnerNotificationCategory,
} from './api'
import { Colors } from './theme'
import type { IconName } from './ui'

// ─── Owner portal state ───────────────────────────────────────────────────────
// The owner signs in THROUGH the API (lockout, 24 h / 30-day sessions — see
// backend/lib/ownerAuth.mjs), which hands back a Supabase session the app
// adopts. Every owner call then sends that token as usual; the API turns it
// down (401 session_expired) once the session has ended.

type Me = OwnerProfile & { unread: number }

interface OwnerState {
  me: Me | null
  unread: number
  status: 'idle' | 'loading' | 'ready' | 'signed_out' | 'error'
  error: string | null
  load: () => Promise<void>
  refreshUnread: () => Promise<void>
  setUnread: (n: number) => void
  setProfile: (p: OwnerProfile) => void
  clear: () => void
}

export const useOwnerStore = create<OwnerState>()((set, get) => ({
  me: null,
  unread: 0,
  status: 'idle',
  error: null,
  load: async () => {
    set({ status: get().me ? 'ready' : 'loading', error: null })
    const { data } = await supabase.auth.getSession()
    if (!data.session) { set({ me: null, status: 'signed_out' }); return }
    try {
      const me = await fetchOwnerMe()
      set({ me, unread: me.unread, status: 'ready' })
    } catch (e: any) {
      if (isSignedOutError(e)) { set({ me: null, status: 'signed_out' }); return }
      set({ status: get().me ? 'ready' : 'error', error: e?.message ?? 'Couldn’t load your account.' })
    }
  },
  refreshUnread: async () => {
    if (!get().me) return
    try {
      const { count } = await fetchOwnerUnread()
      set({ unread: count })
    } catch (e) {
      if (isSignedOutError(e)) set({ me: null, status: 'signed_out' })
    }
  },
  setUnread: (n) => set({ unread: Math.max(0, n) }),
  setProfile: (p) => { const me = get().me; if (me) set({ me: { ...me, ...p } }) },
  clear: () => set({ me: null, unread: 0, status: 'signed_out', error: null }),
}))

/** The API refused the session (never an owner session, ended, or expired). */
export const isSignedOutError = (e: unknown) =>
  e instanceof ApiError && (e.status === 401 || e.code === 'session_expired')

/** Use the session the API signed in. */
export async function adoptOwnerSession(s: OwnerSessionTokens) {
  const { error } = await supabase.auth.setSession({ access_token: s.accessToken, refresh_token: s.refreshToken })
  if (error) throw error
  useOwnerStore.setState({ status: 'idle' })
}

/** Log out: the API ends the session, then this device forgets it. */
export async function signOutOwner() {
  try { await ownerLogout() } catch {}
  await supabase.auth.signOut({ scope: 'local' })
  useOwnerStore.getState().clear()
}

/** After a 401: forget the dead session here (the server already ended it). */
export async function dropOwnerSession() {
  await supabase.auth.signOut({ scope: 'local' }).catch(() => {})
  useOwnerStore.getState().clear()
}

/**
 * For screens' catch blocks: a dead session sends the owner to sign-in (the
 * portal layout redirects, then returns them here); anything else becomes the
 * message to show.
 */
export function ownerErrorText(e: unknown): string {
  if (isSignedOutError(e)) {
    usePrefill.getState().put({ notice: 'Your session ended. Sign in again to continue.' })
    dropOwnerSession()
    return 'Your session ended.'
  }
  return (e as any)?.message ?? 'Something went wrong — please try again.'
}

// ─── Values carried between screens without putting them in the URL ──────────
// (The flow doc: no emails or tokens in URLs except the invite token.)
interface Prefill { ownerEmail?: string; storeEmail?: string; notice?: string }
export const usePrefill = create<{ value: Prefill; put: (p: Prefill) => void }>()((set, get) => ({
  value: {},
  put: (p) => set({ value: { ...get().value, ...p } }),
}))
/** Read and clear one carried value. */
export function takePrefill<K extends keyof Prefill>(key: K): Prefill[K] {
  const v = usePrefill.getState().value[key]
  usePrefill.setState({ value: { ...usePrefill.getState().value, [key]: undefined } })
  return v
}

/** Only owner pages are valid "come back here after sign-in" targets. */
export const safeNext = (next: unknown) =>
  typeof next === 'string' && /^\/owner\/(home|add-store|notifications|profile)(\?[\w=&%.-]*)?$/.test(next) ? next : '/owner/home'

// ─── Formatting (₹ and DD MMM YYYY, in the viewer's time zone) ────────────────
export const inr = (n: number) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
export const num = (n: number) => Number(n || 0).toLocaleString('en-IN')

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** DD MMM YYYY in the viewer's time zone (built by hand: some browsers write "Sept"). */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso) // a bare day is a local date
  if (Number.isNaN(d.getTime())) return '—'
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${fmtDate(iso)}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
}

export function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d === 1) return 'yesterday'
  if (d < 7) return `${d}d ago`
  return fmtDate(iso)
}

/** "9+" above nine. */
export const badgeText = (n: number) => (n > 9 ? '9+' : String(n))

// ─── Store status pills: one tone each for good, waiting, warning, inactive ───
export type Tone = 'good' | 'waiting' | 'warning' | 'inactive'
export const TONES: Record<Tone, { fg: string; bg: string }> = {
  good:     { fg: Colors.success, bg: Colors.successBg },
  waiting:  { fg: Colors.primaryDark, bg: Colors.primarySubtle },
  warning:  { fg: Colors.warning, bg: Colors.warningBg },
  inactive: { fg: Colors.textMuted, bg: Colors.bgSubtle },
}

export const STATUS_META: Record<OwnerStoreStatus, { label: string; tone: Tone; hint: string }> = {
  invited:        { label: 'Invited',        tone: 'waiting',  hint: 'Invite sent; the manager hasn’t accepted yet.' },
  pending:        { label: 'Pending',        tone: 'waiting',  hint: 'The manager set up their login; no credit package bought yet.' },
  active:         { label: 'Active',         tone: 'good',     hint: 'Paid package with credits remaining.' },
  low_credits:    { label: 'Low credits',    tone: 'warning',  hint: 'Under 10% of the package’s credits left.' },
  expired:        { label: 'Expired',        tone: 'warning',  hint: 'Package ended or credits ran out, and it wasn’t renewed.' },
  invite_expired: { label: 'Invite expired', tone: 'warning',  hint: 'The invite link went unused for 7 days.' },
  deactivated:    { label: 'Deactivated',    tone: 'inactive', hint: 'You removed this store.' },
}
export const STATUS_ORDER: OwnerStoreStatus[] = ['active', 'low_credits', 'pending', 'invited', 'invite_expired', 'expired', 'deactivated']
/** No devices, package, credits or payments exist yet. */
export const preActive = (s: OwnerStoreStatus) => s === 'invited' || s === 'invite_expired' || s === 'pending'

export const CATEGORY_META: Record<OwnerNotificationCategory, { label: string; icon: IconName }> = {
  purchases:      { label: 'Purchases & credits', icon: 'credits' },
  payments:       { label: 'Payments',            icon: 'payment' },
  store_activity: { label: 'Store activity',      icon: 'activity' },
  deals:          { label: 'Deals & offers',      icon: 'offer' },
  gift_cards:     { label: 'Gift cards',          icon: 'gift' },
  account:        { label: 'Account & security',  icon: 'shield' },
}

/** Copy to the clipboard on the web; share sheet on iPad / phone. */
export async function copyText(text: string): Promise<'copied' | 'shared' | 'failed'> {
  if (Platform.OS === 'web') {
    try {
      await navigator.clipboard.writeText(text)
      return 'copied'
    } catch {
      return 'failed'
    }
  }
  try {
    await Share.share({ message: text })
    return 'shared'
  } catch {
    return 'failed'
  }
}

/** Indian states and union territories, for the Add Store form. */
export const INDIAN_STATES = [
  'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh', 'Chhattisgarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir',
  'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya',
  'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
  'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
]

/** The rules the API enforces (backend/lib/ownerSecrets.mjs), for the live checklist. */
export const PASSWORD_RULES: { label: string; test: (p: string) => boolean }[] = [
  { label: 'At least 8 characters', test: (p) => p.length >= 8 },
  { label: 'One uppercase letter', test: (p) => /[A-Z]/.test(p) },
  { label: 'One lowercase letter', test: (p) => /[a-z]/.test(p) },
  { label: 'One number', test: (p) => /[0-9]/.test(p) },
  { label: 'One symbol', test: (p) => /[^A-Za-z0-9]/.test(p) },
]
export const passwordOk = (p: string) => PASSWORD_RULES.every((r) => r.test(p)) && p.length <= 72
