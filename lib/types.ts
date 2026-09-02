export interface Measurements {
  heightCm: number
  chestIn: number
  waistIn: number
  hipIn: number
  fitPreference: 'snug' | 'true-to-size' | 'relaxed'
}

export interface ColorSwatch {
  name: string
  hex: string
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
  picks: any[]
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

export interface SafetyResult {
  safe: boolean
  reason?: string  // human-readable if blocked
}
