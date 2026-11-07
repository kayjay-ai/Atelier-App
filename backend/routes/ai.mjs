import express from 'express'
import fs from 'fs'
import path from 'path'
import { TRYON_DIR } from '../lib/catalog.mjs'
import { styleSystemPrompt, sizeSystemPrompt, sizeImageSystemPrompt, colorSystemPrompt, verdictSystemPrompt } from '../lib/prompts.mjs'
import { recommendSize } from '../lib/sizeHeuristic.mjs'
import { STYLE_FALLBACK, COLOR_FALLBACK, ATELIER_BUSY_MESSAGE } from '../lib/fallbacks.mjs'
import { describeDataUrl, fetchGarmentAsDataUrl, runTryOnGeneration, tryOnUserMessage } from '../lib/tryon.mjs'
import { askJson, markFallback, imagePart, measurementsLine, imageClient, IMAGE_MODEL, describeGeminiError } from '../lib/ai.mjs'
import { spender } from '../lib/spend.mjs'
import { featureSpec } from '../lib/features.mjs'
import { creditContextFromBody } from '../lib/credits.mjs'
import { clientActive } from '../lib/clients.mjs'
import { membershipEnabled } from '../lib/membership.mjs'
import { verifySession } from '../lib/embedSession.mjs'
import { callerOf } from '../lib/identity.mjs'
import { garmentFromUrl } from '../lib/garmentFromUrl.mjs'

// =============================================================================
// The AI features. Every one runs the same steps, in this order:
//   1. gates     — embed-partner toggle, B2B store paused / feature off (features.mjs)
//   2. validate  — a bad request is refused before anything is charged
//   3. reserve   — spend a credit (lib/spend.mjs; free features charge nothing)
//   4. ask       — the Gemini call (lib/ai.mjs)
//   5. answer    — the result, or a marked fallback with the credit refunded
// =============================================================================

const router = express.Router()
export default router

const hasBearer = (req) => /^Bearer\s+/i.test(req.headers.authorization || '')

/** True when an embed session (X-Embed-Session) has this feature switched off. */
function embedFeatureOff(req, embedKey) {
  const raw = req.headers['x-embed-session']
  if (!raw) return false
  const session = verifySession(String(raw))
  if (!session) return false // invalid/expired embed token → the feature keeps its own gating
  if (session.features?.[embedKey] === false) {
    console.info(`[Atelier] blocked ${embedKey} for ${session.clientId}:${session.externalUserId} (disabled)`)
    return true
  }
  return false
}

function storeBlockedMessage(store, storeKey) {
  if (!clientActive(store)) return 'Your account is paused — contact Atelier support.'
  if (store.features[storeKey] === false) return 'This feature is not enabled for your company.'
  return null
}

/**
 * Step 1. Sends the refusal and returns true when the caller may not use `feature`.
 * A failed store lookup lets the call through (the free features) unless
 * `storeLookupRequired` (try-on, which spends the store's credits).
 */
async function gateBlocked(req, res, feature, { storeLookupRequired = false } = {}) {
  const spec = featureSpec(feature)
  if (spec.embedKey && embedFeatureOff(req, spec.embedKey)) {
    res.status(403).json({ error: 'feature_disabled', message: 'This feature is not enabled for your account.' })
    return true
  }
  if (!spec.storeKey || !membershipEnabled() || !hasBearer(req)) return false
  const { store, storeError } = await callerOf(req)
  if (storeError) {
    console.error(`[Atelier] company lookup failed (${feature}):`, storeError.message)
    if (!storeLookupRequired) return false
    res.status(503).json({
      fallback: true, retryable: true, message: ATELIER_BUSY_MESSAGE,
      error: { status: 503, type: 'CompanyLookupFailed', message: storeError.message },
    })
    return true
  }
  const blocked = store && storeBlockedMessage(store, spec.storeKey)
  if (!blocked) return false
  console.info(`[Atelier] blocked ${feature} for company ${store.clientId}: ${blocked}`)
  res.status(403).json({ fallback: true, error: blocked, message: blocked })
  return true
}

/** Steps 1–5 for the text features (JSON answers). */
async function textFeature(req, res, { feature, validate, ask, fallback }) {
  if (await gateBlocked(req, res, feature)) return
  const body = req.body || {}
  const invalid = validate?.(body)
  if (invalid) return res.status(400).json(invalid)
  const caller = featureSpec(feature).ledgers ? await callerOf(req) : {}
  const spend = await spender.reserve({ feature, body, caller })
  if (!spend.ok) return res.status(spend.status).json(spend.body)
  const out = await ask(body)
  if (out.ok) return res.json(out.data)
  await spend.refund()
  return res.json(markFallback(fallback(body, out.reason), out.reason))
}

// ── Style ("Style me") ──────────────────────────────────────────────────────
router.post('/api/style', (req, res) => textFeature(req, res, {
  feature: 'style',
  ask: ({ measurements, occasion, photoBase64 }) => askJson({
    label: 'Style',
    system: styleSystemPrompt(),
    parts: [
      ...(photoBase64 ? [imagePart(photoBase64)] : []),
      {
        text: `${measurementsLine(measurements, 'Measurements') ?? 'No measurements provided.'}
Occasion: ${occasion || 'everyday'}
${photoBase64 ? 'A photo of the client is attached — read their colouring and proportions directly from it.' : 'No photo provided — work from measurements alone.'}

Please give me your stylist's read on what I should be wearing.`,
      },
    ],
    accept: (d) => {
      if (!d.archetype) return false
      if (!Array.isArray(d.picks)) d.picks = []
      return true
    },
  }),
  fallback: () => STYLE_FALLBACK,
}))

// ── Colour analysis ─────────────────────────────────────────────────────────
router.post('/api/color', (req, res) => textFeature(req, res, {
  feature: 'color',
  validate: ({ photoBase64 }) => (photoBase64 ? null : { error: 'A photo is required for colour analysis.', message: ATELIER_BUSY_MESSAGE }),
  ask: ({ photoBase64 }) => askJson({
    label: 'Colour',
    system: colorSystemPrompt(),
    parts: [imagePart(photoBase64), { text: 'Please analyse my colouring and recommend a palette.' }],
    accept: (d) => {
      if (!d.undertone) return false
      if (!Array.isArray(d.picks)) d.picks = []
      return true
    },
  }),
  fallback: () => COLOR_FALLBACK,
}))

// ── Size Assist ─────────────────────────────────────────────────────────────
// Two request shapes: the legacy catalog one ({ measurements, garment } with a
// size chart) and the current bring-your-own one ({ measurements,
// garmentImageBase64, garmentName, sizeChartText }).
const SIZE_FALLBACK = {
  no_key: { size: 'M', confidence: 'low', explanation: 'Size assistant unavailable — add your measurements and try again.', caveat: 'No AI key configured.' },
  other: { size: 'M', confidence: 'low', explanation: 'Could not analyse the garment image — try pasting the size chart below for a better result.', caveat: 'AI analysis unavailable right now.' },
}

router.post('/api/size', (req, res) => {
  const legacy = !!req.body?.garment && !req.body?.garmentImageBase64
  return textFeature(req, res, {
    feature: 'size',
    validate: ({ measurements, garmentImageBase64 }) => {
      if (!measurements) return { error: 'measurements is required.' }
      if (!legacy && !garmentImageBase64) return { error: 'garmentImageBase64 is required for image-based sizing.' }
      return null
    },
    ask: legacy
      ? ({ measurements, garment }) => askJson({
          label: 'Size (catalog)',
          system: sizeSystemPrompt(),
          parts: [{
            text: `Garment: ${garment.name || 'this piece'}
Fabric: ${garment.fabric || 'unknown'}
Fit: ${garment.fit || 'unknown'}
Size chart: ${JSON.stringify(garment.sizeChart || [])}
${measurementsLine(measurements, 'Client')}`,
          }],
          accept: (d) => !!d.size,
        })
      : ({ measurements, garmentImageBase64, garmentName, sizeChartText }) => askJson({
          label: 'Size (image)',
          system: sizeImageSystemPrompt(),
          parts: [
            imagePart(garmentImageBase64),
            {
              text: `Garment name: ${garmentName || 'unknown'}${sizeChartText ? `\nRetailer size chart (pasted by user):\n${sizeChartText}` : '\nNo size chart provided — infer from the garment image.'}

${measurementsLine(measurements)}`,
            },
          ],
          accept: (d) => !!d.size,
        }),
    // The catalog path falls back to the size-chart heuristic, the image path to a canned answer.
    fallback: ({ measurements, garment }, reason) => (legacy
      ? recommendSize(measurements, garment.sizeChart || [])
      : SIZE_FALLBACK[reason === 'no_key' ? 'no_key' : 'other']),
  })
})

// ── "Should I buy it?" ──────────────────────────────────────────────────────
router.post('/api/verdict', (req, res) => textFeature(req, res, {
  feature: 'verdict',
  validate: ({ garmentImageBase64 }) => (garmentImageBase64 ? null : { error: 'garmentImageBase64 is required.' }),
  ask: ({ garmentImageBase64, userPhotoBase64, measurements, palette, garmentName, garmentBrand, garmentDescription }) => {
    const context = []
    if (garmentName) context.push(`Garment: ${garmentName}`)
    if (garmentBrand) context.push(`Brand: ${garmentBrand}`)
    if (garmentDescription) context.push(`Description: ${garmentDescription}`)
    if (measurements) context.push(measurementsLine(measurements))
    if (palette) context.push(`Client colour profile: ${palette.season}, ${palette.undertone} undertone. Flattering colours: ${palette.flatteringColors?.map((c) => c.name).join(', ')}.`)
    if (userPhotoBase64) context.push('A photo of the client is provided as the second image — read their colouring and proportions directly from it.')
    if (context.length === 0) context.push('No client profile provided — judge purely by the garment itself.')
    return askJson({
      label: 'Verdict',
      system: verdictSystemPrompt(),
      parts: [
        imagePart(garmentImageBase64),
        ...(userPhotoBase64 ? [imagePart(userPhotoBase64)] : []),
        { text: context.join('\n') },
      ],
      accept: (d) => !!d.call,
    })
  },
  fallback: (_body, reason) => (reason === 'no_key'
    ? { call: 'Maybe', verdict: 'Style assistant is unavailable right now.', whyItWorks: 'Unable to analyse — no AI key configured.', theCatch: '—', wearItWith: '—' }
    : { call: 'Maybe', verdict: 'The assistant is busy — try again in a moment.', whyItWorks: '—', theCatch: '—', wearItWith: '—' }),
}))

// ── Garment safety screen ───────────────────────────────────────────────────
// A keyword screen, then a vision check. Fails open: an unclear or failed check
// never blocks a garment.
const BLOCKED_KEYWORDS = [
  'lingerie', 'bikini', 'underwear', 'swimwear', 'swimsuit', 'thong', 'bra', 'panties',
  'g-string', 'g string', 'knicker', 'negligee', 'bodysuit sheer', 'sheer bodysuit',
  'see-through', 'see through', 'transparent', 'nipple', 'corset', 'pasties',
  'bathing suit', 'one-piece swim', 'trunks', 'speedo', 'boardshort',
]

router.post('/api/safety/check', async (req, res) => {
  const { imageBase64, name = '', description = '' } = req.body || {}
  const combined = `${name} ${description}`.toLowerCase()
  if (BLOCKED_KEYWORDS.some((kw) => combined.includes(kw))) {
    return res.json({
      safe: false,
      reason: "This piece isn't supported for virtual try-on. We focus on outerwear, tops, bottoms, dresses, and accessories.",
    })
  }
  if (!imageBase64) return res.json({ safe: true })
  const out = await askJson({
    label: 'Safety check',
    parts: [
      imagePart(imageBase64),
      { text: 'Classify this garment image. Reply with JSON only: {"safe": true} if it is regular clothing (outerwear, tops, bottoms, dresses, shoes, accessories, activewear). Reply with {"safe": false, "reason": "<one sentence>"} if it is lingerie, underwear, swimwear, bikini, or explicitly revealing/sheer garments. When uncertain, reply {"safe": true}.' },
    ],
    accept: (d) => typeof d.safe === 'boolean',
  })
  return res.json(out.ok ? out.data : markFallback({ safe: true }, out.reason))
})

// ── Garment from a product link ─────────────────────────────────────────────
router.post('/api/garment/from-url', async (req, res) => {
  const { url } = req.body || {}
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url is required.' })
  const { status, body } = await garmentFromUrl(url)
  return res.status(status).json(body)
})

// ── Virtual try-on ──────────────────────────────────────────────────────────
// Same steps as the text features, plus: a debug stub, pre-generated demo images,
// and a fetch of the garment when only its URL was sent.
const tryOnFailed = (status, type, message, { retryable = true, text = ATELIER_BUSY_MESSAGE } = {}) => ({
  status,
  body: { fallback: true, retryable, message: text, error: { status, type, message } },
})

router.post('/api/tryon', async (req, res) => {
  const body = req.body || {}
  const { userPhotoBase64, garmentImageBase64, garmentImageUrl, garmentColor, garmentColorHex, garmentName, productId, forceLive } = body
  const send = ({ status, body: out }) => res.status(status).json(out)

  if (embedFeatureOff(req, featureSpec('tryon').embedKey)) {
    return res.status(403).json({ error: 'feature_disabled', message: 'This feature is not enabled for your account.' })
  }

  // DEBUG_TRYON: skip the paid image API entirely and return an instant stub
  // (labelled DEBUG in the app). No Gemini call, no credit, no membership gate.
  if ((process.env.DEBUG_TRYON ?? 'false') === 'true') {
    console.log('[Atelier] /api/tryon: DEBUG STUB returned — no Gemini image call, no credit consumed')
    return res.json({
      image: garmentImageBase64 || garmentImageUrl || userPhotoBase64 || null,
      debug: true, demo: false, credits: null, membership: null,
      message: 'Debug stub — no try-on image was generated.',
    })
  }

  // Embed partners pay from their own pool, so their users skip the member and
  // store gates. Everyone else: a bad token is refused rather than treated as
  // anonymous, and a store login honours its status, feature toggle and iPad block.
  let caller = {}
  if (!creditContextFromBody(body).companyId) {
    caller = await callerOf(req)
    if (caller.tokenInvalid) {
      return res.status(401).json({
        fallback: true,
        message: 'Your session expired — please sign in again to keep trying things on.',
        error: { status: 401, type: 'InvalidToken', message: 'Invalid or expired Supabase token.' },
      })
    }
    if (await gateBlocked(req, res, 'tryon', { storeLookupRequired: true })) return
    if (caller.device?.status === 'blocked') {
      const msg = 'This iPad has been blocked — contact your Atelier admin.'
      return res.status(403).json({ fallback: true, error: msg, message: msg })
    }
  }

  // Pre-generated demo images (DEMO_MODE, catalog products): free.
  const demoMode = (process.env.DEMO_MODE ?? 'true') !== 'false'
  if (demoMode && productId && !forceLive && !garmentImageUrl) {
    if (fs.existsSync(path.join(TRYON_DIR, `${productId}.png`))) {
      return res.json({ image: `/tryon/${productId}.png`, demo: true, credits: null })
    }
  }

  // Validate before charging.
  if (!userPhotoBase64) {
    console.info('[Atelier] /api/tryon called without a user photo — refusing to generate.')
    return send(tryOnFailed(400, 'MissingUserPhoto', 'userPhotoBase64 was not provided.', {
      retryable: false, text: 'Add a photo to your profile so I can fit this to you.',
    }))
  }
  const ai = imageClient()
  if (!ai) {
    console.info('[Atelier] GEMINI_API_KEY not set — try-on cannot run live.')
    return res.json({
      fallback: true, retryable: false, message: ATELIER_BUSY_MESSAGE,
      error: { status: null, type: 'MissingApiKey', message: 'GEMINI_API_KEY is not set.' },
    })
  }
  if (!garmentImageBase64 && !garmentImageUrl) {
    return send(tryOnFailed(400, 'MissingGarmentImage', 'garmentImageBase64 or garmentImageUrl was not provided.', { retryable: false }))
  }
  let resolvedGarmentBase64 = garmentImageBase64
  if (!resolvedGarmentBase64) {
    try {
      resolvedGarmentBase64 = await fetchGarmentAsDataUrl(garmentImageUrl)
    } catch (err) {
      return send(tryOnFailed(502, 'GarmentFetchFailed', err instanceof Error ? err.message : 'Failed to fetch garment image'))
    }
  }

  const userPhoto = describeDataUrl(userPhotoBase64)
  const garmentImage = describeDataUrl(resolvedGarmentBase64)
  console.log(`[Atelier] /api/tryon: user photo (${userPhoto.mimeType}, ${userPhoto.bytes} bytes), garment (${garmentImage.mimeType}, ${garmentImage.bytes} bytes), product=${productId || 'n/a'}`)

  const spend = await spender.reserve({ feature: 'tryon', body, caller })
  if (!spend.ok) return res.status(spend.status).json(spend.body)

  try {
    const { image, model } = await runTryOnGeneration(ai, IMAGE_MODEL, {
      userPhotoBase64, resolvedGarmentBase64, garmentName, garmentColor, garmentColorHex,
    })
    console.log(`[Atelier] /api/tryon: success with ${model}`)
    // model: which Gemini image model produced it (shown in the app's console).
    return res.json({ image, model, demo: false, ...spend.balances() })
  } catch (err) {
    await spend.refund()
    const errorInfo = describeGeminiError(err)
    const friendly = tryOnUserMessage(err)
    console.error('[Atelier] Try-on generation failed:', errorInfo, err?.modelText ? `model: ${err.modelText}` : '')
    if (/billing|quota|permission|PERMISSION_DENIED|RESOURCE_EXHAUSTED/i.test(String(errorInfo.message))) {
      console.error('[Atelier] Hint: ensure billing is enabled on your Google AI Studio / Cloud project for image-generation models.')
    }
    // A specific reason (e.g. the photo was refused) won't change on retry; "busy" will.
    return res.json({ fallback: true, retryable: !friendly, message: friendly ?? ATELIER_BUSY_MESSAGE, error: errorInfo })
  }
})
