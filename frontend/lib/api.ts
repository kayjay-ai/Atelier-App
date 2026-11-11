import type { Measurements, CustomerMeasurements, TryOnResult, SizeResult, VerdictResult, ColorAnalysisResult, StyleResult, Membership, SafetyResult, PurchaseType, PricingOption } from './types'
import { supabase } from './supabaseClient'
import { deviceKeySync, getDeviceKey, deviceName, devicePlatform, appVersion } from './device'

const BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8787'

async function authHeaders(): Promise<Record<string, string>> {
  try {
    const { data } = await supabase.auth.getSession()
    const token = data.session?.access_token
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
    // Lets the server attribute B2B usage to this iPad (devices table).
    const device = deviceKeySync()
    if (device) headers['X-Atelier-Device'] = device
    return headers
  } catch {
    return {}
  }
}

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/health`, { method: 'GET' })
    return res.ok
  } catch {
    return false
  }
}

/**
 * The readable reason in an API error reply. Replies carry a sentence in
 * `message` and/or `error`, but `error` is sometimes a details object
 * ({ status, type, message }) — never show that as "[object Object]".
 */
function errorText(body: any): string {
  if (!body || typeof body !== 'object') return ''
  if (typeof body.message === 'string' && body.message) return body.message
  if (typeof body.error === 'string') return body.error
  if (typeof body.error?.message === 'string') return body.error.message
  return ''
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(body),
    })
  } catch (e: any) {
    console.error(`[Atelier] Network error calling ${BASE}${path}:`, e?.message)
    throw new Error(`Cannot reach the Atelier server at ${BASE}. Make sure the API server is running on port 8787.`)
  }
  if (!res.ok && res.status !== 402) {
    let detail = ''
    try { detail = errorText(await res.json()) } catch {}
    console.error(`[Atelier] ${path} returned ${res.status}`, detail)
    throw new Error(detail || `Server error ${res.status} on ${path}`)
  }
  return res.json() as Promise<T>
}

export async function fetchGarmentFromUrl(url: string): Promise<{
  imageBase64: string
  name?: string
  brand?: string
  price?: string
  description?: string
  sizeChartText?: string
  error?: string
}> {
  return post('/api/garment/from-url', { url })
}

export async function checkGarmentSafety(payload: {
  imageBase64?: string
  name?: string
  description?: string
}): Promise<SafetyResult> {
  try {
    return await post<SafetyResult>('/api/safety/check', payload)
  } catch {
    // Fail open if safety endpoint unreachable (never silently block)
    return { safe: true }
  }
}

export async function fetchColorAnalysis(photoBase64: string): Promise<ColorAnalysisResult> {
  return post<ColorAnalysisResult>('/api/color', { photoBase64 })
}

export async function fetchStyleAnalysis(payload: {
  photoBase64?: string
  measurements?: Measurements
  occasion?: string
}): Promise<StyleResult> {
  return post<StyleResult>('/api/style', payload)
}

export async function fetchTryOn(
  garmentImageBase64: string,
  garmentName: string,
  userPhotoBase64?: string,
  // For the admin Activity page only: where the garment came from.
  context: { inputSource?: 'link' | 'screenshot' | 'gallery'; productUrl?: string; garmentBrand?: string } = {},
): Promise<TryOnResult> {
  const r = await post<TryOnResult & { model?: string }>('/api/tryon', {
    garmentImageBase64,
    garmentName: garmentName || 'garment',
    userPhotoBase64,
    ...context,
  })
  // Older backends don't send it — "not reported" means the API runs pre-3.1 code.
  if (r.image) console.info(`[Atelier] try-on image model: ${r.model ?? 'not reported (old backend)'}`)
  return r
}

export async function fetchSizeAssist(payload: {
  measurements: Measurements | CustomerMeasurements
  garmentImageBase64: string
  garmentName?: string
  sizeChartText?: string
}): Promise<SizeResult> {
  return post<SizeResult>('/api/size', payload)
}

export async function fetchMembership(): Promise<Membership | null> {
  try {
    const res = await fetch(`${BASE}/api/membership`, {
      method: 'GET',
      headers: { ...(await authHeaders()) },
    })
    if (!res.ok) return null
    return (await res.json()) as Membership
  } catch {
    return null
  }
}

// ── Cashfree credit purchases ───────────────────────────────────────────────
// Credits are NEVER granted here — these only start checkout and ask the SERVER
// to verify. The balance is set server-side after Cashfree confirms the payment.

export interface CreatePaymentResult {
  orderId: string
  paymentSessionId: string
  mode: 'sandbox' | 'production'
  type: PurchaseType
  amount: number
  credits: number
  currency: string
}

/** Public pricing (single source of truth lives on the server). */
export async function fetchPricing(): Promise<{ freeCredits: number; options: PricingOption[] } | null> {
  try {
    const res = await fetch(`${BASE}/api/payments/pricing`, { method: 'GET' })
    if (!res.ok) return null
    return (await res.json()) as { freeCredits: number; options: PricingOption[] }
  } catch {
    return null
  }
}

/** Ask the server to create a Cashfree order for a purchase type. Secrets stay server-side. */
export async function createPayment(type: PurchaseType, phone?: string): Promise<CreatePaymentResult> {
  const res = await fetch(`${BASE}/api/payments/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ type, phone }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(errorText(body) || 'Could not start checkout.')
  return body as CreatePaymentResult
}

/** Server-verified payment status. `membership` reflects the server-side credit grant. */
export async function getPaymentStatus(orderId: string): Promise<{
  paid: boolean
  orderStatus: string
  membership: Membership | null
}> {
  const res = await fetch(`${BASE}/api/payments/status/${encodeURIComponent(orderId)}`, {
    method: 'GET',
    headers: { ...(await authHeaders()) },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(errorText(body) || 'Could not verify payment.')
  return body as { paid: boolean; orderStatus: string; membership: Membership | null }
}

export async function fetchVerdict(payload: {
  garmentImageBase64: string
  userPhotoBase64?: string
  measurements?: Measurements
  palette?: Pick<ColorAnalysisResult, 'undertone' | 'season' | 'flatteringColors'>
  garmentName?: string
  garmentBrand?: string
  garmentDescription?: string
}): Promise<VerdictResult> {
  return post<VerdictResult>('/api/verdict', payload)
}

// ─── B2B store session + events ───────────────────────────────────────────────

export interface StoreSession {
  device: { id: string; storeId: string | null; name: string | null; status: 'active' | 'blocked' | 'sign_out_requested' } | null
  signOut: boolean
  settings: { lowCreditPct: number; graceDays: number }
  notice: { id: string; template: string; subject: string | null; body: string | null; linkUrl: string | null; sentAt: string } | null
}

/**
 * Register this iPad with the server and fetch device status, thresholds and any
 * admin message. `heartbeat` refreshes without logging a new session.
 * Returns null when the server can't be reached — the app keeps working.
 */
export async function startStoreSession(heartbeat = false): Promise<StoreSession | null> {
  try {
    const deviceKey = await getDeviceKey()
    const res = await fetch(`${BASE}/api/b2b/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ deviceKey, deviceName: deviceName(), platform: devicePlatform(), appVersion: appVersion(), heartbeat }),
    })
    if (!res.ok) return null
    return (await res.json()) as StoreSession
  } catch {
    return null
  }
}

export async function dismissStoreNotice(id: string): Promise<void> {
  try {
    await fetch(`${BASE}/api/b2b/notice/${encodeURIComponent(id)}/dismiss`, {
      method: 'POST',
      headers: { ...(await authHeaders()) },
    })
  } catch {}
}

export type AppEvent =
  | 'customer_captured' | 'garment_selected' | 'result_saved' | 'result_shared'  // B2B
  | 'profile_completed' | 'garment_added' | 'paywall_viewed'                     // B2C

/** Fire-and-forget analytics event for the admin dashboard. Never throws. */
export function postEvent(event: AppEvent, data: { folderId?: string; metadata?: Record<string, unknown> } = {}): void {
  void (async () => {
    try {
      await fetch(`${BASE}/api/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ event, ...data }),
      })
    } catch {}
  })()
}

// ─── B2C account ──────────────────────────────────────────────────────────────

/** Permanently delete the signed-in consumer account (server removes photos + data). */
export async function deleteAccount(): Promise<void> {
  const res = await fetch(`${BASE}/api/account/delete`, {
    method: 'POST',
    headers: { ...(await authHeaders()) },
  })
  if (!res.ok) {
    let msg = ''
    try { msg = errorText(await res.json()) } catch {}
    throw new Error(msg || `Could not delete your account (${res.status}).`)
  }
}

// ─── B2B payments (Cashfree) ─────────────────────────────────────────────────
// The server decides prices, credits and what this store may buy; the app only
// names the item, confirms the Terms, and asks the server to verify afterwards.

export interface B2BPlanOption {
  id: string
  name: string
  priceInr: number      // excl. GST
  gstInr: number
  totalInr: number      // what the store is charged
  cycle: 'monthly' | 'annual'
  credits: number
  current: boolean
  action: 'choose' | 'upgrade' | 'renew' | 'switch' | null
  allowed: boolean
  reason: string | null
}

export interface B2BTopupPack {
  id: string
  credits: number
  priceInr: number      // excl. GST
  gstInr: number
  totalInr: number      // what the store is charged
  allowed: boolean
  reason: string | null
}

export interface B2BPayment {
  orderId: string
  kind: 'plan' | 'topup'
  itemName: string
  amountInr: number     // total charged, incl. GST
  credits: number
  status: 'paid' | 'failed' | 'review'   // review = received, held for Atelier to check
  createdAt: string
  paidAt: string | null
}

export interface B2BBilling {
  enabled: boolean
  setup?: { cashfree: boolean; terms: boolean; database?: boolean } // missing on older servers
  mode: 'sandbox' | 'production'
  gstInclusive: boolean
  gstRate: number
  renewWindowDays: number
  terms: { url: string; version: string } | null
  store: {
    planId: string | null
    planName: string | null
    planCreditsIncluded: number
    renewalAt: string | null
    trialEndsAt: string | null
    planCredits: number
    topupCredits: number
    totalCredits: number
  }
  plans: B2BPlanOption[]
  packs: B2BTopupPack[]
  payments: B2BPayment[]
}

export interface B2BOrder {
  orderId: string
  paymentSessionId: string
  mode: 'sandbox' | 'production'
  amountInr: number     // total charged, incl. GST
  baseAmountInr: number
  gstInr: number
  credits: number
  itemName: string
  /** iPad / phone: the page to open for checkout (the web app's /pay/checkout). */
  checkoutUrl?: string | null
}

export type B2BPaymentStatus = { status: 'paid' | 'pending' | 'failed' | 'review'; result: Record<string, unknown> | null }

async function getJson<T>(path: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, { headers: await authHeaders() })
  } catch {
    throw new Error(`Cannot reach the Atelier server at ${BASE}.`)
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(errorText(body) || `Server error ${res.status}`)
  return body as T
}

export function fetchB2BBilling(): Promise<B2BBilling> {
  return getJson<B2BBilling>('/api/b2b/billing')
}

export function createB2BOrder(payload: {
  kind: 'plan' | 'topup'
  itemId: string
  acceptTerms: boolean
  termsVersion: string
  platform: 'web' | 'native'
}): Promise<B2BOrder> {
  return post<B2BOrder>('/api/b2b/payments', payload)
}

export function fetchB2BPaymentStatus(orderId: string): Promise<B2BPaymentStatus> {
  return getJson<B2BPaymentStatus>(`/api/b2b/payments/${encodeURIComponent(orderId)}`)
}

/** Hosted checkout page on the API, opened in an in-app browser on iPad. */
export function b2bCheckoutUrl(paymentSessionId: string): string {
  return `${BASE}/pay/b2b/checkout?session=${encodeURIComponent(paymentSessionId)}`
}

// ─── Owner portal (/api/owner/*, backend/routes/owner.mjs) ────────────────────

/** An API refusal with its machine-readable code and any extra fields (e.g. per-field errors). */
export class ApiError extends Error {
  status: number
  code: string | null
  extra: Record<string, any>
  constructor(status: number, message: string, code: string | null, extra: Record<string, any>) {
    super(message)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

async function ownerCall<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown, auth = true): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(auth ? await authHeaders() : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new ApiError(0, 'Can’t reach Atelier right now. Check your connection and try again.', 'network', {})
  }
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const { error: _error, code, ...extra } = json ?? {}
    throw new ApiError(res.status, errorText(json) || `Server error ${res.status}`, typeof code === 'string' ? code : null, extra)
  }
  return json as T
}

export type OwnerPurpose = 'activation' | 'reset'
export interface OwnerSessionTokens { accessToken: string; refreshToken: string; expiresAt: number; sessionExpiresAt: string }
/** testCode: only in the API's temporary test mode (email not set up) — shown on screen instead of emailed. */
export interface CodeSent { maskedEmail: string; resendInSec: number; expiresInSec: number; testCode?: string }

export const ownerVerify = (orgCode: string, email: string, purpose: OwnerPurpose) =>
  ownerCall<CodeSent>('POST', purpose === 'reset' ? '/api/owner/forgot' : '/api/owner/activate/verify', { org_code: orgCode, email }, false)
export const ownerResendCode = (email: string, purpose: OwnerPurpose) =>
  ownerCall<CodeSent>('POST', '/api/owner/otp/resend', { email, purpose }, false)
export const ownerConfirmCode = (email: string, code: string, purpose: OwnerPurpose) =>
  ownerCall<{ token: string; expiresInSec: number }>('POST', '/api/owner/otp/confirm', { email, code, purpose }, false)
export const ownerTokenStatus = (token: string) =>
  ownerCall<{ valid: boolean; reason?: 'token_expired' | 'already_active'; purpose?: OwnerPurpose }>('POST', '/api/owner/token/status', { token }, false)
export const ownerSetPassword = (token: string, password: string) =>
  ownerCall<{ session: OwnerSessionTokens }>('POST', '/api/owner/password', { token, password }, false)
export const ownerLogin = (email: string, password: string, remember: boolean) =>
  ownerCall<{ session: OwnerSessionTokens }>('POST', '/api/owner/login', { email, password, remember }, false)
export const ownerLogout = () => ownerCall<{ ok: true }>('POST', '/api/owner/logout', {})

export type OwnerNotificationCategory = 'purchases' | 'payments' | 'store_activity' | 'deals' | 'gift_cards' | 'account'
export interface NotifyPrefs {
  categories: Record<OwnerNotificationCategory, boolean>
  email: boolean
  inApp: true
}
export interface OwnerProfile {
  owner: { id: string; name: string; email: string; phone: string; activatedAt: string | null }
  organization: { id: string; name: string; legalName: string; logoUrl: string | null; code: string }
  totalStores: number
  notifyPrefs: NotifyPrefs
}
export const fetchOwnerMe = () => ownerCall<OwnerProfile & { unread: number }>('GET', '/api/owner/me')
export const updateOwnerProfile = (patch: { name?: string; phone?: string; notifyPrefs?: Partial<NotifyPrefs> }) =>
  ownerCall<OwnerProfile>('PATCH', '/api/owner/profile', patch)
export const changeOwnerPassword = (current: string, next: string) =>
  ownerCall<{ ok: true }>('POST', '/api/owner/profile/password', { current, next })

export interface OwnerSession { id: string; device: string; createdAt: string; lastActiveAt: string; expiresAt: string; remember: boolean; current: boolean }
export const fetchOwnerSessions = () => ownerCall<{ sessions: OwnerSession[] }>('GET', '/api/owner/sessions')
export const signOutOtherOwnerSessions = () => ownerCall<{ ok: true }>('DELETE', '/api/owner/sessions')

export type OwnerStoreStatus = 'invited' | 'pending' | 'active' | 'low_credits' | 'expired' | 'invite_expired' | 'deactivated'
export interface OwnerStoreRow {
  id: string
  name: string
  city: string
  state: string
  address: string
  pincode: string
  location: string
  managerName: string
  managerEmail: string
  managerPhone: string
  status: OwnerStoreStatus
  needsAttention: boolean
  emailNotDelivered: boolean
  devices: number
  packageName: string | null
  creditsUsed: number
  creditsTotal: number
  usableCredits: number
  topupCredits: number
  lastPaymentAt: string | null
  renewalAt: string | null
  trialEndsAt: string | null
  createdAt: string
  invitedAt: string | null
  activatedAt: string | null
  deactivatedAt: string | null
  invite: { id: string; status: string; sentAt: string; expiresAt: string; emailStatus: string } | null
}
export interface OwnerSummary {
  totalStores: number
  byStatus: Record<OwnerStoreStatus, number>
  connectedDevices: number
  creditsUsedThisMonth: number
  creditsUsedPct: number
  needsAttention: number
}
export type OwnerSortKey = 'name' | 'location' | 'manager' | 'status' | 'devices' | 'package' | 'credits' | 'lastPayment' | 'created'
export interface OwnerStoreQuery { search?: string; status?: string[]; sort?: OwnerSortKey | null; dir?: 'asc' | 'desc'; page?: number }
export interface OwnerStorePage { stores: OwnerStoreRow[]; total: number; page: number; pageSize: number; pages: number }
export interface OwnerStoreDetail {
  store: OwnerStoreRow
  devices: { id: string; name: string; type: string; lastActiveAt: string | null; online: boolean; blocked: boolean }[]
  credits: { packageName: string | null; packageCredits: number; used: number; remaining: number; topup: number; startsAt: string | null; endsAt: string | null }
  usage: { day: string; used: number }[]
  payments: { id: string; date: string; package: string; amount: number; currency: string; method: string | null; last4: string | null; status: 'paid' | 'failed' | 'on_hold'; invoiceUrl: string | null }[]
}
export interface AddStoreInput {
  storeName: string
  city: string
  state: string
  address: string
  pincode: string
  managerName: string
  managerEmail: string
  countryCode: string
  managerPhone: string
  note: string
}
/** testInviteUrl: only in the API's temporary test mode (email not set up) — the link to pass on by hand. */
type InviteResult = { store: OwnerStoreRow; emailStatus: 'sent' | 'failed' | 'skipped'; testInviteUrl?: string }

export const fetchOwnerSummary = () => ownerCall<OwnerSummary>('GET', '/api/owner/dashboard/summary')
export function fetchOwnerStores(q: OwnerStoreQuery): Promise<OwnerStorePage> {
  const params = new URLSearchParams()
  if (q.search) params.set('search', q.search)
  if (q.status?.length) params.set('status', q.status.join(','))
  if (q.sort) params.set('sort', q.sort)
  if (q.dir) params.set('dir', q.dir)
  if (q.page) params.set('page', String(q.page))
  const qs = params.toString()
  return ownerCall<OwnerStorePage>('GET', `/api/owner/stores${qs ? `?${qs}` : ''}`)
}
const storePath = (id: string) => `/api/owner/stores/${encodeURIComponent(id)}`
export const fetchOwnerStore = (id: string) => ownerCall<OwnerStoreDetail>('GET', storePath(id))
export const addOwnerStore = (input: AddStoreInput) => ownerCall<InviteResult>('POST', '/api/owner/stores', input)
export const resendStoreInvite = (id: string) => ownerCall<InviteResult>('POST', `${storePath(id)}/invite/resend`, {})
export const fetchStoreInviteLink = (id: string) => ownerCall<{ url: string; expiresAt: string }>('GET', `${storePath(id)}/invite/link`)
export const changeStoreInviteEmail = (id: string, email: string) => ownerCall<InviteResult>('PATCH', `${storePath(id)}/invite`, { email })
export const revokeStoreInvite = (id: string) => ownerCall<{ ok: true }>('DELETE', `${storePath(id)}/invite`)
export const deleteInvitedStore = (id: string) => ownerCall<{ ok: true }>('DELETE', storePath(id))
export const deactivateOwnerStore = (id: string) => ownerCall<{ store: OwnerStoreRow }>('POST', `${storePath(id)}/deactivate`, {})

export interface OwnerNotificationLink { screen: 'store' | 'profile' | 'offer' | 'gift_card' | 'add-store'; storeId?: string; section?: string }
export interface OwnerNotification {
  id: string
  category: OwnerNotificationCategory
  title: string
  body: string
  storeId: string | null
  storeName: string | null
  link: OwnerNotificationLink | null
  data: { expiresAt?: string | null; cta?: string | null; code?: string | null; amountInr?: number | null } | null
  read: boolean
  createdAt: string
}
export function fetchOwnerNotifications(q: { category?: OwnerNotificationCategory | null; unreadOnly?: boolean; cursor?: string | null }) {
  const params = new URLSearchParams()
  if (q.category) params.set('category', q.category)
  if (q.unreadOnly) params.set('unread_only', 'true')
  if (q.cursor) params.set('cursor', q.cursor)
  const qs = params.toString()
  return ownerCall<{ items: OwnerNotification[]; nextCursor: string | null }>('GET', `/api/owner/notifications${qs ? `?${qs}` : ''}`)
}
export const fetchOwnerUnread = () => ownerCall<{ count: number }>('GET', '/api/owner/notifications/unread-count')
export const setOwnerNotificationRead = (id: string, read: boolean) =>
  ownerCall<{ ok: true }>('PATCH', `/api/owner/notifications/${encodeURIComponent(id)}`, { read })
export const markAllOwnerNotificationsRead = () => ownerCall<{ ok: true }>('POST', '/api/owner/notifications/read-all', {})
export const deleteOwnerNotification = (id: string) => ownerCall<{ ok: true }>('DELETE', `/api/owner/notifications/${encodeURIComponent(id)}`)

// ─── Store manager: accepting an owner's invite (/invite?token=…) ─────────────
export interface StoreInvite { storeName: string; city: string; organization: string; managerName: string; managerEmail: string; hasAccount: boolean; expiresAt: string }
export const fetchStoreInvite = (token: string) => ownerCall<StoreInvite>('GET', `/api/invites/${encodeURIComponent(token)}`, undefined, false)
export const acceptStoreInvite = (token: string, password?: string) =>
  ownerCall<{ email: string; storeName: string; hadAccount: boolean }>('POST', `/api/invites/${encodeURIComponent(token)}/accept`, { password }, false)
