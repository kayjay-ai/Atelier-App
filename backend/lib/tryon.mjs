import crypto from 'crypto'
import sharp from 'sharp'
import { safeFetch } from './safeFetch.mjs'
import { TRYON_INSTRUCTION, TRYON_PLAN_INSTRUCTION, TRYON_VERIFY_INSTRUCTION, HEAD_DETECT_INSTRUCTION } from './prompts.mjs'
import { solidColorSwatchDataUrl } from './colorSwatch.mjs'

const FALLBACK_IMAGE_MODEL = process.env.IMAGE_MODEL_FALLBACK || 'gemini-2.5-flash-image'
const TRYON_TIMEOUT_MS = 90_000
// QA pass on every try-on (TRYON_VERIFY=false turns it off). Costs one cheap
// text-model call, plus one extra image generation only when the check fails.
const VERIFY_ENABLED = (process.env.TRYON_VERIFY ?? 'true') !== 'false'
const VERIFY_MODEL = process.env.TRYON_VERIFY_MODEL || process.env.TEXT_MODEL || 'gemini-2.5-flash'
const VERIFY_TIMEOUT_MS = 30_000

// Cost lever: request a compact 3:4 portrait that matches the app's try-on view
// (rendered at 3/4 aspect), so we don't emit pixels the UI just discards. Only
// aspectRatio is sent — `imageSize` is unreliable with the installed @google/genai
// (0.3.x) and triggered API errors, while aspectRatio works for both image models.
const TRYON_ASPECT = process.env.TRYON_ASPECT || '3:4'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Gemini image models return intermittent 500/INTERNAL and 503/UNAVAILABLE; these
// are transient and succeed on a quick retry.
const isTransient = (err) => {
  const status = err?.status ?? err?.response?.status
  return status === 500 || status === 503 || /INTERNAL|UNAVAILABLE|overloaded|\b50[03]\b/i.test(String(err?.message))
}

export function dataUrlToInlinePart(dataUrl) {
  const match = /^data:(.+);base64,(.*)$/.exec(dataUrl || '')
  if (match) return { inlineData: { mimeType: match[1], data: match[2] } }
  return { inlineData: { mimeType: 'image/png', data: dataUrl } }
}

export function describeDataUrl(dataUrl) {
  const match = /^data:(.+);base64,(.*)$/.exec(dataUrl || '')
  const mimeType = match ? match[1] : 'unknown'
  const base64 = match ? match[2] : dataUrl || ''
  const bytes = Math.floor((base64.length * 3) / 4)
  return { mimeType, bytes, base64 }
}

function hashBase64(base64) {
  return crypto.createHash('sha256').update(base64 || '').digest('hex')
}

// The pre-generation plan as explicit instructions (see TRYON_PLAN_INSTRUCTION).
function planText(plan) {
  if (!plan) return ''
  const lines = [
    `GARMENT PLAN — the item is a ${plan.category === 'full_body' ? 'full-body garment' : plan.category}: ${plan.garment}.`,
    plan.details && `Reproduce: ${plan.details}.`,
    plan.replace && `REPLACE only: ${plan.replace}.`,
    plan.keep && `KEEP exactly as in IMAGE 1: ${plan.keep}.`,
    `Their tattoos: ${plan.customerTattoos || 'none'} — they stay visible only where their skin stays uncovered; the garment hides whatever it covers. Never shorten or change the garment to show a tattoo, and add no other tattoos.`,
  ]
  return lines.filter(Boolean).join(' ')
}

// ── Input preparation ─────────────────────────────────────────────────────────
// The image model copies the clearest face it sees. A garment model's large,
// sharp face beats a small customer face in a busy photo, so we add an enlarged
// close-up of the customer's face. (Blanking out the garment model's head was
// tried and made things worse: the model pasted the customer's head onto the
// headless figure.)

function validBox(box) {
  return Array.isArray(box) && box.length === 4 && box.every((n) => Number.isFinite(n))
    && box[2] > box[0] && box[3] > box[1]
}

// [ymin, xmin, ymax, xmax] in 0–1000 → pixel rect, padded by `pad` × box size.
function boxToRect(box, width, height, pad) {
  const [y0, x0, y1, x1] = box.map((n) => Math.min(1000, Math.max(0, n)) / 1000)
  const bw = (x1 - x0) * width
  const bh = (y1 - y0) * height
  const left = Math.max(0, Math.floor(x0 * width - bw * pad.x))
  const top = Math.max(0, Math.floor(y0 * height - bh * pad.top))
  const right = Math.min(width, Math.ceil(x1 * width + bw * pad.x))
  const bottom = Math.min(height, Math.ceil(y1 * height + bh * pad.bottom))
  return { left, top, width: right - left, height: bottom - top }
}

const toDataUrl = (buf) => `data:image/jpeg;base64,${buf.toString('base64')}`
const fromDataUrl = (dataUrl) => Buffer.from(describeDataUrl(dataUrl).base64, 'base64')

// Close-up of the customer's head, enlarged so the face is as clear as possible.
async function cropCustomerFace(userDataUrl, box) {
  const img = sharp(fromDataUrl(userDataUrl)).rotate()
  const { width, height } = await img.metadata()
  const r = boxToRect(box, width, height, { x: 0.5, top: 0.3, bottom: 0.5 })
  if (r.width < 8 || r.height < 8) return null
  return toDataUrl(await img.extract(r).resize({ width: 512, height: 512, fit: 'inside' }).jpeg({ quality: 92 }).toBuffer())
}

async function faceCloseUp(userPhotoBase64, customerHead) {
  if (!customerHead) return null
  try {
    return await cropCustomerFace(userPhotoBase64, customerHead)
  } catch (err) {
    console.warn('[Atelier] face close-up skipped:', err?.message || err)
    return null
  }
}

function buildTryOnParts({ userPhotoBase64, garmentBase64, faceRef, garmentName, garmentColor, garmentColorHex, correction = '', plan = null }) {
  const swatch = garmentColorHex ? solidColorSwatchDataUrl(garmentColorHex) : null
  const colorLabel = garmentColor || 'the selected colour'
  const hexLabel = garmentColorHex ? ` (${garmentColorHex})` : ''

  const colorRule = swatch
    ? `COLOUR IS MANDATORY: dress the person in ${colorLabel}${hexLabel}. IMAGE 2 is for silhouette, cut, ribbing, and fabric texture ONLY — completely IGNORE the colour shown in IMAGE 2. IMAGE 3 is the exact target colour swatch — match it precisely on the garment.`
    : garmentColor
      ? `The shopper selected "${garmentColor}". Render the garment in exactly this colour even if IMAGE 2 shows a different shade.`
      : `Match the garment colour from IMAGE 2 exactly.`

  // Only tell the model to ignore IMAGE 2's colour when another colour is
  // supplied — otherwise it contradicts "match the colour from IMAGE 2".
  const garmentLabel = swatch || garmentColor
    ? `IMAGE 2 — GARMENT reference for SHAPE and TEXTURE only (${garmentName || 'see photo'}). Do NOT copy the colour from this image.`
    : `IMAGE 2 — GARMENT reference (${garmentName || 'see photo'}): copy its shape, texture, print and colour.`

  const parts = [
    { text: 'IMAGE 1 — the PERSON (keep face, hair, skin, body shape, pose, and background unchanged):' },
    dataUrlToInlinePart(userPhotoBase64),
  ]
  if (faceRef) {
    parts.push({ text: 'FACE CLOSE-UP of the same IMAGE 1 person — the face in the output must be exactly this face (same features, age, hair or baldness, glasses):' })
    parts.push(dataUrlToInlinePart(faceRef))
  }
  parts.push({ text: garmentLabel }, dataUrlToInlinePart(garmentBase64))

  if (swatch) {
    parts.push({
      text: `IMAGE 3 — TARGET COLOUR SWATCH for ${colorLabel}${hexLabel}. The garment on the person must be this exact colour:`,
    })
    parts.push(dataUrlToInlinePart(swatch))
  }

  parts.push({
    text: `${TRYON_INSTRUCTION} ${colorRule} Garment: ${garmentName || 'the provided garment'}.${plan ? ` ${planText(plan)}` : ''}${correction ? ` ${correction}` : ''} Output ONLY the final edited photo of the IMAGE 1 person.`,
  })

  return parts
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error(message), { name: 'Timeout' })), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

function extractImageFromResponse(response) {
  const feedback = response?.promptFeedback
  if (feedback?.blockReason) {
    throw Object.assign(
      new Error(`Try-on was blocked (${feedback.blockReason}). Try a different photo.`),
      { name: 'SafetyBlocked' },
    )
  }

  const candidate = response?.candidates?.[0]
  const finish = candidate?.finishReason
  if (finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT' || finish === 'IMAGE_SAFETY') {
    throw Object.assign(
      new Error('Try-on was blocked by safety filters. Try a clearer, front-facing full-body photo.'),
      { name: 'SafetyBlocked' },
    )
  }

  const parts = candidate?.content?.parts ?? []
  const imagePart = parts.find((p) => p.inlineData?.data)
  if (!imagePart) {
    const textPart = parts.find((p) => p.text)?.text?.trim()
    throw Object.assign(
      new Error(textPart || 'No image returned by the model'),
      { name: 'NoImageReturned', modelText: textPart },
    )
  }

  return imagePart
}

async function generateWithModel(ai, model, parts) {
  // Ask for a compact portrait so the model doesn't emit an oversized image the UI
  // would just downscale. Valid imageConfig fields are honoured by the API; older
  // SDKs that don't map them simply ignore the field (no error, just no size change).
  const imageConfig = { aspectRatio: TRYON_ASPECT }
  return withTimeout(
    ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts }],
      config: { responseModalities: ['IMAGE'], imageConfig },
    }),
    TRYON_TIMEOUT_MS,
    'Try-on is taking too long. Please try again in a moment.',
  )
}

export function tryOnUserMessage(err) {
  if (err?.name === 'SafetyBlocked') return err.message
  if (err?.name === 'Timeout') return err.message
  if (err?.name === 'EchoedInput') {
    return 'The model returned an unchanged photo. Try again with a clearer full-body image.'
  }
  if (err?.name === 'IdentityFailed') {
    return 'We couldn’t keep your face accurate with this photo. Try a clearer, closer photo facing the camera, without sunglasses.'
  }
  if (err?.name === 'NoImageReturned') {
    return 'We could not generate a try-on image. Use a clear, front-facing full-body photo and try again.'
  }
  if (/billing|quota|permission|PERMISSION_DENIED|RESOURCE_EXHAUSTED/i.test(String(err?.message))) {
    return 'Try-on quota or billing limit reached. Check your Google AI Studio billing settings.'
  }
  return null
}

// One JSON answer from the cheap vision model (plan, detection and QA passes).
async function askVisionJson(ai, parts, label, thinkingBudget = 0) {
  const response = await withTimeout(
    ai.models.generateContent({
      model: VERIFY_MODEL,
      contents: [{ role: 'user', parts }],
      config: { responseMimeType: 'application/json', temperature: 0, thinkingConfig: { thinkingBudget } },
    }),
    VERIFY_TIMEOUT_MS,
    `${label} timeout`,
  )
  const text = response?.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text
  return JSON.parse(text)
}

/**
 * Work out what the garment is and which of the customer's clothes it replaces.
 * Returns null when this can't run — generation then uses the generic rules.
 */
async function planTryOn(ai, userPhotoBase64, garmentBase64, garmentName) {
  try {
    const plan = await askVisionJson(ai, [
      { text: 'IMAGE 1 — the customer:' },
      dataUrlToInlinePart(userPhotoBase64),
      { text: `IMAGE 2 — the garment photo${garmentName && garmentName !== 'garment' ? ` (product name: ${garmentName})` : ''}:` },
      dataUrlToInlinePart(garmentBase64),
      { text: TRYON_PLAN_INSTRUCTION },
    ], 'plan')
    return plan?.garment && plan?.category ? plan : null
  } catch (err) {
    console.warn('[Atelier] try-on plan skipped:', (err?.message || String(err)).slice(0, 120))
    return null
  }
}

/**
 * Box of the main person's head ([ymin, xmin, ymax, xmax], 0–1000), or null.
 * A small thinking budget makes the boxes markedly tighter at the same latency.
 */
async function detectHead(ai, dataUrl) {
  try {
    const found = await askVisionJson(ai, [dataUrlToInlinePart(dataUrl), { text: HEAD_DETECT_INSTRUCTION }], 'detect', 1024)
    const box = Array.isArray(found) ? found[0]?.box_2d : null
    return validBox(box) ? box : null
  } catch (err) {
    console.warn('[Atelier] head detection skipped:', (err?.message || String(err)).slice(0, 120))
    return null
  }
}

/**
 * Ask a vision model whether the try-on kept the customer's identity, framing,
 * the clothing it should keep, and the whole garment. Returns null when the
 * check itself can't run — the result then ships unchecked.
 */
async function verifyTryOn(ai, userPhotoBase64, garmentBase64, resultDataUrl, plan) {
  try {
    const v = await askVisionJson(ai, [
      { text: 'IMAGE 1 — the customer:' },
      dataUrlToInlinePart(userPhotoBase64),
      { text: 'IMAGE 2 — the garment reference:' },
      dataUrlToInlinePart(garmentBase64),
      { text: 'IMAGE 3 — the generated try-on:' },
      dataUrlToInlinePart(resultDataUrl),
      ...(plan ? [{ text: `Intended change: the item is a ${plan.category}: ${plan.garment}. It replaces: ${plan.replace || 'n/a'}. It must keep: ${plan.keep || 'n/a'}.` }] : []),
      { text: TRYON_VERIFY_INSTRUCTION },
    ], 'verify')
    const failures = []
    if (v.sameCustomer === false || v.garmentModelFaceVisible === true) failures.push('identity')
    if (v.anatomyOk === false) failures.push('artifact')
    if (v.backgroundPreserved === false) failures.push('background')
    if (v.framingPreserved === false) failures.push('framing')
    if (v.garmentApplied === false) failures.push('garment')
    else if (v.garmentComplete === false || v.leftoverClothing === true) failures.push('completeness')
    if (v.missingClothing === true) failures.push('kept')
    return { failures, issue: v.issue || '' }
  } catch (err) {
    console.warn('[Atelier] try-on verify skipped:', (err?.message || String(err)).slice(0, 120))
    return null
  }
}

// Extra instruction for the retry, naming exactly what the first attempt got wrong.
function correctionFor(failures, issue) {
  const notes = {
    identity: 'PREVIOUS ATTEMPT FAILED: the face, hair, skin or tattoos did not match IMAGE 1. The face, head, hair, skin tone and tattoos MUST be copied exactly from IMAGE 1 — nothing of the IMAGE 2 model may appear.',
    artifact: 'PREVIOUS ATTEMPT FAILED: the image was malformed (extra or missing body parts, two figures merged, or visible editing seams). Output ONE natural, complete person — the IMAGE 1 person in their own pose.',
    background: 'PREVIOUS ATTEMPT FAILED: the background changed. Keep the exact background of IMAGE 1 — do not use the IMAGE 2 background.',
    framing: 'PREVIOUS ATTEMPT FAILED: body parts were cropped or missing. Keep the full framing of IMAGE 1 — everything visible in IMAGE 1 must stay visible.',
    garment: 'PREVIOUS ATTEMPT FAILED: the garment was not applied. The person MUST be wearing the garment from IMAGE 2.',
    completeness: 'PREVIOUS ATTEMPT FAILED: part of the garment was missing or changed, or old clothing still showed. Reproduce the whole garment from IMAGE 2 — same sleeves, neckline, straps, length and print — and remove all clothing it replaces.',
    kept: 'PREVIOUS ATTEMPT FAILED: clothing the garment does not cover disappeared (e.g. bare legs). Keep every piece of IMAGE 1 clothing the garment does not cover — e.g. their trousers under a top — exactly as in IMAGE 1.',
  }
  const detail = issue ? ` (Reviewer note: ${issue.slice(0, 200)})` : ''
  return failures.map((f) => notes[f]).join(' ') + detail
}

// A wrong face is the worst failure a shopper can see — it outweighs the rest.
const severity = (failures) => failures.reduce((n, f) => n + (f === 'identity' ? 10 : 1), 0)
const MAX_RETRIES = 1
const MAX_IDENTITY_RETRIES = 2

/**
 * Run virtual try-on via Gemini image models. Plans the edit, prepares the
 * inputs, generates (primary model, then fallback), QA-checks the result and
 * regenerates with a correction when it fails — up to twice for a wrong face.
 * A result the check says shows someone else's face is never returned.
 * @returns {{ image: string, model: string }}
 */
export async function runTryOnGeneration(ai, primaryModel, payload) {
  const { userPhotoBase64, resolvedGarmentBase64, garmentName, garmentColor, garmentColorHex } = payload
  const [plan, customerHead] = VERIFY_ENABLED
    ? await Promise.all([
      planTryOn(ai, userPhotoBase64, resolvedGarmentBase64, garmentName),
      detectHead(ai, userPhotoBase64),
    ])
    : [null, null]
  if (plan) console.log(`[Atelier] try-on plan: ${plan.category} "${plan.garment}" — replace: ${plan.replace} — keep: ${plan.keep}`)
  const faceRef = await faceCloseUp(userPhotoBase64, customerHead)
  console.log(`[Atelier] try-on inputs: face close-up ${faceRef ? 'added' : 'not added'}`)
  const build = (correction) => buildTryOnParts({
    userPhotoBase64, garmentBase64: resolvedGarmentBase64, faceRef,
    garmentName, garmentColor, garmentColorHex, correction, plan,
  })

  const first = await generateTryOn(ai, primaryModel, build(), payload)
  if (!VERIFY_ENABLED) return first

  // QA always compares against the original garment photo, so it can tell
  // whether the garment model's face leaked into the result.
  let best = { ...first, check: await verifyTryOn(ai, userPhotoBase64, resolvedGarmentBase64, first.image, plan) }
  if (!best.check) {
    console.log('[Atelier] try-on QA: unchecked')
    return first
  }

  for (let retry = 1; best.check.failures.length > 0; retry++) {
    const identity = best.check.failures.includes('identity')
    if (retry > (identity ? MAX_IDENTITY_RETRIES : MAX_RETRIES)) break
    console.warn(`[Atelier] try-on QA failed (${best.check.failures.join(', ')}): ${best.check.issue} — regenerating (${retry})`)
    let next
    try {
      next = await generateTryOn(ai, best.model, build(correctionFor(best.check.failures, best.check.issue)), payload)
    } catch (err) {
      console.warn('[Atelier] try-on retry failed:', err?.message || err)
      break
    }
    const check = await verifyTryOn(ai, userPhotoBase64, resolvedGarmentBase64, next.image, plan)
    console.log(`[Atelier] try-on retry ${retry} QA: ${check ? (check.failures.join(', ') || 'passed') : 'unchecked'}`)
    if (!check) break
    if (severity(check.failures) < severity(best.check.failures)) best = { ...next, check }
  }

  if (best.check.failures.includes('identity')) {
    throw Object.assign(new Error(`try-on kept failing identity QA: ${best.check.issue}`), { name: 'IdentityFailed' })
  }
  console.log(`[Atelier] try-on QA: ${best.check.failures.length ? `shipping with ${best.check.failures.join(', ')}` : 'passed'}`)
  return { image: best.image, model: best.model }
}

async function generateTryOn(ai, primaryModel, parts, payload) {
  const { userPhotoBase64, resolvedGarmentBase64, garmentColor, garmentColorHex } = payload
  const userPhoto = describeDataUrl(userPhotoBase64)
  const garmentImage = describeDataUrl(resolvedGarmentBase64)

  const models = [primaryModel]
  if (FALLBACK_IMAGE_MODEL && FALLBACK_IMAGE_MODEL !== primaryModel) {
    models.push(FALLBACK_IMAGE_MODEL)
  }

  let lastErr
  for (const model of models) {
    // One quick retry per model to ride out transient 500/503 from the image API.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`[Atelier] try-on: model=${model} (attempt ${attempt}), garment=${garmentImage.bytes}b, user=${userPhoto.bytes}b, color=${garmentColor || 'n/a'}${garmentColorHex ? ` ${garmentColorHex}` : ''}`)
        const response = await generateWithModel(ai, model, parts)
        const imagePart = extractImageFromResponse(response)

        const resultHash = hashBase64(imagePart.inlineData.data)
        if (resultHash === hashBase64(garmentImage.base64) || resultHash === hashBase64(userPhoto.base64)) {
          throw Object.assign(new Error('Model echoed an input image instead of generating a new one'), {
            name: 'EchoedInput',
          })
        }

        const mimeType = imagePart.inlineData.mimeType || 'image/png'
        return {
          image: `data:${mimeType};base64,${imagePart.inlineData.data}`,
          model,
        }
      } catch (err) {
        lastErr = err
        if (err?.name === 'SafetyBlocked') throw err
        if (attempt < 2 && isTransient(err)) {
          console.warn(`[Atelier] try-on ${model} transient error — retrying:`, (err?.message || '').slice(0, 60))
          await sleep(800)
          continue
        }
        console.warn(`[Atelier] try-on failed with ${model}:`, err?.message || err)
        break // move on to the fallback model (if any)
      }
    }
  }

  throw lastErr ?? new Error('Try-on generation failed')
}

export async function fetchGarmentAsDataUrl(garmentImageUrl) {
  const garmentRes = await safeFetch(garmentImageUrl) // user-supplied URL
  if (!garmentRes.ok) throw new Error(`HTTP ${garmentRes.status}`)
  const mimeType = garmentRes.headers.get('content-type') || 'image/jpeg'
  if (/svg|text\/html/i.test(mimeType)) {
    throw new Error(`Garment URL is not a raster image (${mimeType})`)
  }
  const buf = Buffer.from(await garmentRes.arrayBuffer())
  return `data:${mimeType};base64,${buf.toString('base64')}`
}
