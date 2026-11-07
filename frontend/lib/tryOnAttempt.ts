import type { TryOnResult } from './types'
import { tryOnOutcome, type TryOnOutcome } from './aiOutcome.ts'

// ─── One try-on attempt ───────────────────────────────────────────────────────
// The steps the shopper app (app/(tabs)/index.tsx) and the store app
// (app/store/index.tsx) share: call the API, apply the balance the server
// reports, work out what the answer means, and save a real image. Each app
// plugs in its own pieces (ports): which balance to update and where results
// are saved (shopper history in Supabase, or the customer's folder). Screens
// keep their own UI state. Pure module (no React Native), so it is unit-tested.

export interface TryOnPorts {
  /** The API request (lib/api.ts fetchTryOn with the screen's arguments). */
  call: () => Promise<TryOnResult>
  /** Put the server's new balance into app state; called for every answer, paywalls included. */
  applyBalance?: (r: TryOnResult) => void
  /** Save a real generated image. Never called for stand-ins, demo or debug images. */
  save?: (image: string, r: TryOnResult) => Promise<unknown>
}

export interface TryOnAttempt {
  outcome: TryOnOutcome
  /** The save, when one started: await it to report a failed save. */
  saved: Promise<unknown> | null
}

export async function runTryOnAttempt(ports: TryOnPorts): Promise<TryOnAttempt> {
  let r: TryOnResult
  try {
    r = await ports.call()
  } catch (e: any) {
    // Network / server error: the server refunds a credit it took, so nothing is lost.
    const message = e?.message ?? 'The try-on could not be generated. No credit was used.'
    return { outcome: { kind: 'failed', message, retryable: false, result: { fallback: true, message } }, saved: null }
  }
  ports.applyBalance?.(r)
  const outcome = tryOnOutcome(r)
  const saved = outcome.kind === 'image' && ports.save && !r.demo && !r.debug
    ? ports.save(outcome.image, r)
    : null
  return { outcome, saved }
}
