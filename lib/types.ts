export interface Measurements {
  heightCm: number
  weightKg?: number            // optional on older saved profiles
  chestIn: number              // chest / bust
  waistIn: number
  hipIn: number
  usualSize?: string           // e.g. "M / 32"
  fitChosen?: boolean          // the user picked a fit (Profile completeness)
  // Stored values kept for compatibility; shown as Slim / Regular / Relaxed.
  fitPreference: 'snug' | 'true-to-size' | 'relaxed'
}

export const FIT_LABELS: Record<Measurements['fitPreference'], string> = {
  snug: 'Slim',
  'true-to-size': 'Regular',
  relaxed: 'Relaxed',
}

export interface ColorSwatch {
  name: string
  hex: string
  why?: string                 // one line on why it suits / doesn't suit
}

export interface Palette {
  name: string
  colors: ColorSwatch[]
}

export interface ColorAnalysisResult {
  undertone: 'warm' | 'cool' | 'neutral'
  season: string
  flatteringColors: ColorSwatch[]
  avoid: ColorSwatch[]
  narrative: string
}

// 'url' = came from a product URL (size chart may be available)
// 'upload' = user uploaded a photo (no size chart → size assist N/A)
export type GarmentSource = 'url' | 'upload'

export interface CapturedGarment {
  imageBase64: string
  name?: string
  brand?: string
  price?: string
  description?: string
  sourceUrl?: string
  source?: GarmentSource
  sizeChartText?: string  // auto-extracted when source === 'url'
}

export type PurchaseType = 'per_generation' | 'pack_30' | 'pack_100'

export interface PricingOption {
  type: PurchaseType
  label: string
  blurb: string
  amountInr: number
  credits: number
  recommended?: boolean
}

export interface Membership {
  // `plan` is the single source of truth for premium — the admin portal writes
  // plan='premium' (and add_credits sets a purchase type). Premium = unlimited.
  plan: string | null          // 'premium' (admin), a purchase type, or null (free)
  isPremium?: boolean          // derived server-side: plan === 'premium'
  creditsBalance: number
  freeCreditsUsed?: boolean
  enabled?: boolean
  remaining?: number | null    // legacy mirror; null when premium (unlimited)
}

export interface TryOnResult {
  image?: string
  demo?: boolean
  debug?: boolean
  cached?: boolean
  fallback?: boolean
  paywall?: boolean
  message?: string
  membership?: Membership | null
  client?: { creditsBalance: number } | null   // B2B company pool after this call
  error?: {
    status?: number | null
    type?: string
    message?: string
  }
}

export interface SizeResult {
  size: string
  confidence: 'high' | 'medium' | 'low'
  explanation: string
  caveat?: string
  detected?: {
    garmentType?: string
    fabric?: string
    fit?: string
  }
}

export interface StyleResult {
  archetype: string
  narrative: string
  palettes: Palette[]
  silhouettes: string[]
  silhouettesToAvoid?: string[]
  necklines?: string[]
  lengths?: string[]
  patterns?: string[]
  outfits?: { name: string; pieces: string }[]
  picks: any[]
}

/** The saved "Style me" report (profiles.style_profile). */
export interface StyleReport {
  color: ColorAnalysisResult
  style: StyleResult
  createdAt: string
}

export interface VerdictResult {
  call: 'Yes' | 'Maybe' | 'Skip'
  verdict: string
  whyItWorks: string
  theCatch: string
  wearItWith: string
}

export interface GarmentCheck {
  id: string
  createdAt: string
  garment: CapturedGarment
  tryOnResult?: TryOnResult
  sizeResult?: SizeResult
  verdictResult?: VerdictResult
}

// ─── B2B (in-store iPad) ─────────────────────────────────────────────────────

export type AccountType = 'b2b_company' | 'b2c_customer'
export type ClientFeature = 'tryon' | 'style' | 'size'
export type ClientStatus = 'active' | 'trial' | 'suspended' | 'revoked'

export interface Plan {
  id: string
  name: string
  priceInr: number
  cycle: 'monthly' | 'annual'
  creditsIncluded: number
  topupPriceInr: number | null
}

export interface Store {
  id: string
  name: string
  city: string | null
  address: string | null
}

// The signed-in STORE (b2b_stores row + its company). id = store_id.
export interface Client {
  id: string
  companyName: string
  storeName: string
  logoUrl: string | null
  contactName: string | null
  contactEmail: string | null
  contactPhone: string | null
  gstin: string | null
  billingAddress: string | null
  planId: string | null
  creditsBalance: number
  status: ClientStatus
  trialEndsAt: string | null
  renewalAt: string | null
}

export type Account =
  | { type: 'b2c_customer' }
  | {
      type: 'b2b_company'
      role: 'admin' | 'staff'
      client: Client
      plan: Plan | null
      plans: Plan[]
      stores: Store[]
      features: Record<ClientFeature, boolean>
    }

// Staff-entered measurements for a walk-in customer (spec §2.3 — fit is slim/regular/relaxed).
export interface CustomerMeasurements {
  heightCm: number
  weightKg: number
  chestIn: number
  waistIn: number
  hipIn: number
  fitPreference: 'slim' | 'regular' | 'relaxed'
}

export interface CustomerFolder {
  id: string
  customerName: string
  phone: string | null
  measurements: CustomerMeasurements | null
  photoPath: string | null
  photoUrl: string | null      // signed URL for display
  tryonCount: number
  createdAt: string
  expiresAt: string
}

export interface CustomerTryOn {
  id: string
  folderId: string
  garmentName: string | null
  garmentUrl: string | null
  resultUrl: string | null
  sizeResult: SizeResult | null
  createdAt: string
}

export interface SafetyResult {
  safe: boolean
  reason?: string  // human-readable if blocked
}
