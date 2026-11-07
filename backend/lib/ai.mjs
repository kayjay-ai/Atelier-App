import { GoogleGenAI } from '@google/genai'
import { extractJson } from './json.mjs'

// =============================================================================
// Gemini calls for the AI features. Every text feature (style, colour, size,
// verdict, safety) asks for JSON the same way and gets one of two outcomes:
//   { ok: true, data }                 — parsed and accepted
//   { ok: false, reason }              — no_key | rate_limit | failed
// and a fallback response is always marked the same way (markFallback), so the
// app never has to recognise a canned answer by its text.
// =============================================================================

export const TEXT_MODEL = process.env.TEXT_MODEL || 'gemini-2.5-flash'

// Try-on image cost tier. `economy` (default) uses Gemini 3.1 Flash Lite Image;
// `standard` uses the Pro image model. Flip with one env line — no code change.
export const IMAGE_QUALITY = (process.env.IMAGE_QUALITY || 'economy').toLowerCase()
const STANDARD_IMAGE_MODEL = process.env.IMAGE_MODEL || 'gemini-3-pro-image-preview'
const ECONOMY_IMAGE_MODEL = process.env.IMAGE_MODEL_ECONOMY || 'gemini-3.1-flash-lite-image'
export const IMAGE_MODEL = IMAGE_QUALITY === 'standard' ? STANDARD_IMAGE_MODEL : ECONOMY_IMAGE_MODEL

/** Client for the text features (falls back to the free text key). Null when no key. */
export function textClient() {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_TEXT_API_KEY
  return apiKey ? new GoogleGenAI({ apiKey }) : null
}

/** Client for try-on image generation (needs the billed key). Null when no key. */
export function imageClient() {
  const apiKey = process.env.GEMINI_API_KEY
  return apiKey ? new GoogleGenAI({ apiKey }) : null
}

/** A data URI (or bare base64) as a Gemini inline image part. */
export function imagePart(dataUrl, defaultMime = 'image/jpeg') {
  const m = /^data:(.+);base64,(.*)$/.exec(dataUrl || '')
  return { inlineData: { mimeType: m ? m[1] : defaultMime, data: m ? m[2] : dataUrl } }
}

/** The client's measurements as one prompt sentence (null when missing). */
export function measurementsLine(m, lead = 'Client measurements') {
  if (!m) return null
  return `${lead}: height ${m.heightCm}cm, weight ${m.weightKg}kg, chest ${m.chestIn}in, waist ${m.waistIn}in, hip ${m.hipIn}in. Fit preference: ${m.fitPreference}.`
}

export function isRateLimit(err) {
  return err?.status === 429 || /RESOURCE_EXHAUSTED|429/i.test(String(err?.message))
}

/** Status / type / message of a Gemini SDK error, for logs and dev responses. */
export function describeGeminiError(err) {
  return {
    status: err?.status ?? err?.response?.status ?? null,
    type: err?.name ?? err?.error?.status ?? 'Error',
    message: err?.error?.message ?? err?.message ?? String(err),
  }
}

/**
 * Ask Gemini for a JSON answer.
 * @param {{ label: string, system?: string, parts: object[], accept: (data: any) => boolean, client?: object|null, model?: string }} p
 *   accept — returns true when the parsed answer is usable (may normalise it in place)
 *   client — injectable for tests; defaults to textClient()
 */
export async function askJson({ label, system, parts, accept, client = textClient(), model = TEXT_MODEL }) {
  if (!client) {
    console.info(`[Atelier] ${label}: no Gemini key configured — serving the fallback.`)
    return { ok: false, reason: 'no_key' }
  }
  try {
    const resp = await client.models.generateContent({
      model,
      contents: [{ role: 'user', parts }],
      config: { ...(system ? { systemInstruction: system } : {}), responseMimeType: 'application/json' },
    })
    const data = extractJson(resp.text ?? '')
    if (!data || !accept(data)) throw new Error(`Could not parse ${label} response`)
    return { ok: true, data }
  } catch (err) {
    if (isRateLimit(err)) {
      console.info(`[Atelier] ${label}: rate limit hit (429) — the app retries shortly.`)
      return { ok: false, reason: 'rate_limit' }
    }
    console.error(`[Atelier] ${label} failed, serving the fallback:`, err?.message)
    return { ok: false, reason: 'failed' }
  }
}

/**
 * Mark a fallback answer. The canned fields stay (older app builds show them);
 * newer builds read `fallback` / `retryable` instead of matching the text, and
 * never save a fallback as a real result.
 */
export function markFallback(body, reason) {
  return { ...body, fallback: true, fallbackReason: reason, retryable: reason !== 'no_key' }
}
