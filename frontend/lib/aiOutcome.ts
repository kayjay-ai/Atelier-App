import type { AiFallbackFlags, TryOnResult } from './types'

// ─── AI answers: real or stand-in ─────────────────────────────────────────────
// When Gemini is unavailable the API still answers, with a stand-in marked
// `fallback: true` (backend/lib/ai.mjs). A stand-in is shown, never saved as a
// real result. Pure module (no React Native), so it is unit-tested directly.
//
// Older API builds (before the marked fallbacks) are recognised by their canned
// text below. Delete LEGACY_FALLBACK_TEXT once every deployed API runs the new code.
const LEGACY_FALLBACK_TEXT = {
  sizeCaveats: ['AI analysis unavailable right now.', 'No AI key configured.'],
  verdictWhy: ['—', 'Unable to analyse — no AI key configured.'],
}

type Legacy = { caveat?: string; whyItWorks?: string; message?: string }

/** True when this answer is a stand-in, not a real AI result. */
export function isFallback(r: (AiFallbackFlags & Legacy) | null | undefined): boolean {
  if (!r) return false
  if (r.fallback === true) return true
  if (r.fallback === false) return false
  return (!!r.caveat && LEGACY_FALLBACK_TEXT.sizeCaveats.includes(r.caveat))
    || (r.whyItWorks !== undefined && LEGACY_FALLBACK_TEXT.verdictWhy.includes(r.whyItWorks))
}

/** True when a stand-in is worth retrying shortly (busy / rate limit), false for e.g. a missing key. */
export function isRetryable(r: (AiFallbackFlags & Legacy) | null | undefined): boolean {
  if (!r || !isFallback(r)) return false
  if (typeof r.retryable === 'boolean') return r.retryable
  // Older API builds: the busy answers were the retryable ones.
  return /busy|unavailable right now/i.test(`${r.message ?? ''} ${r.caveat ?? ''} ${(r as any).verdict ?? ''}`)
}

export type TryOnOutcome =
  | { kind: 'image'; image: string; result: TryOnResult }
  | { kind: 'paywall'; message: string; result: TryOnResult }
  | { kind: 'failed'; message: string; retryable: boolean; result: TryOnResult }

const NOT_GENERATED = 'The try-on could not be generated. No credit was used.'
const OUT_OF_CREDITS = "You're out of credits. Buy more to keep generating:"

/** What a try-on response means for the screen. */
export function tryOnOutcome(r: TryOnResult): TryOnOutcome {
  if (r.paywall) return { kind: 'paywall', message: r.message ?? OUT_OF_CREDITS, result: r }
  if (r.fallback || !r.image) {
    return { kind: 'failed', message: r.message ?? NOT_GENERATED, retryable: isRetryable({ fallback: true, ...r }), result: r }
  }
  return { kind: 'image', image: r.image, result: r }
}
