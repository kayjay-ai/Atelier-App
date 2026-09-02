import type { Measurements, TryOnResult, SizeResult, VerdictResult, ColorAnalysisResult, StyleResult, Membership, SafetyResult, PurchaseType, PricingOption } from './types'
import { supabase } from './supabaseClient'

const BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8787'

async function authHeaders(): Promise<Record<string, string>> {
  try {
    const { data } = await supabase.auth.getSession()
    const token = data.session?.access_token
    return token ? { Authorization: `Bearer ${token}` } : {}
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
    try { detail = (await res.json())?.error ?? '' } catch {}
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
): Promise<TryOnResult> {
  return post<TryOnResult>('/api/tryon', {
    garmentImageBase64,
    garmentName: garmentName || 'garment',
    userPhotoBase64,
  })
}

export async function fetchSizeAssist(payload: {
  measurements: Measurements
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
export async function createPayment(type: PurchaseType): Promise<CreatePaymentResult> {
  const res = await fetch(`${BASE}/api/payments/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ type }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error || 'Could not start checkout.')
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
  if (!res.ok) throw new Error(body?.error || 'Could not verify payment.')
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
