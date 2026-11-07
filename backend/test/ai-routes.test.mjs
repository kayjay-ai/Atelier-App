import { startApp, post } from './helpers.mjs'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

// With no Gemini key every AI feature answers with a MARKED fallback, so the app
// can tell it apart from a real answer without matching its text.
let app
before(async () => { app = await startApp() })
after(async () => { await app.close() })

const IMG = 'data:image/jpeg;base64,AAAA'
const MEASUREMENTS = { heightCm: 170, weightKg: 65, chestIn: 36, waistIn: 30, hipIn: 38, fitPreference: 'true-to-size' }

function assertFallback(body, reason = 'no_key') {
  assert.equal(body.fallback, true)
  assert.equal(body.fallbackReason, reason)
  assert.equal(body.retryable, reason !== 'no_key')
}

test('style: marked fallback, canned report kept for older app builds', async () => {
  const r = await post(app.url, '/api/style', { photoBase64: IMG })
  assert.equal(r.status, 200)
  assertFallback(r.body)
  assert.ok(r.body.archetype)
})

test('color: photo required (400, before any charge)', async () => {
  assert.equal((await post(app.url, '/api/color', {})).status, 400)
  const r = await post(app.url, '/api/color', { photoBase64: IMG })
  assertFallback(r.body)
  assert.ok(r.body.undertone)
})

test('size: validation, then a marked fallback', async () => {
  assert.equal((await post(app.url, '/api/size', {})).status, 400)
  assert.equal((await post(app.url, '/api/size', { measurements: MEASUREMENTS })).status, 400)
  const r = await post(app.url, '/api/size', { measurements: MEASUREMENTS, garmentImageBase64: IMG })
  assertFallback(r.body)
  assert.equal(r.body.caveat, 'No AI key configured.')
})

test('size (legacy catalog shape): heuristic answer, marked as a fallback', async () => {
  const garment = { name: 'Shirt', sizeChart: [{ size: 'M', chestIn: [36, 38], waistIn: [30, 32] }] }
  const r = await post(app.url, '/api/size', { measurements: MEASUREMENTS, garment })
  assert.equal(r.status, 200)
  assertFallback(r.body)
  assert.ok(r.body.size)
})

test('verdict: validation, then a marked fallback', async () => {
  assert.equal((await post(app.url, '/api/verdict', {})).status, 400)
  const r = await post(app.url, '/api/verdict', { garmentImageBase64: IMG })
  assertFallback(r.body)
  assert.equal(r.body.call, 'Maybe')
})

test('safety: keyword screen blocks; otherwise fails open', async () => {
  assert.equal((await post(app.url, '/api/safety/check', { name: 'Red bikini' })).body.safe, false)
  assert.equal((await post(app.url, '/api/safety/check', { name: 'Wool coat' })).body.safe, true)
  const r = await post(app.url, '/api/safety/check', { name: 'Wool coat', imageBase64: IMG })
  assert.equal(r.body.safe, true)
  assert.equal(r.body.fallback, true)
})

test('try-on: validation runs before any charge, and a missing key is not retryable', async () => {
  const noPhoto = await post(app.url, '/api/tryon', { garmentImageBase64: IMG })
  assert.equal(noPhoto.status, 400)
  assert.equal(noPhoto.body.error.type, 'MissingUserPhoto')
  assert.equal(noPhoto.body.retryable, false)

  const noKey = await post(app.url, '/api/tryon', { userPhotoBase64: IMG, garmentImageBase64: IMG })
  assert.equal(noKey.status, 200)
  assert.equal(noKey.body.fallback, true)
  assert.equal(noKey.body.retryable, false)
  assert.equal(noKey.body.error.type, 'MissingApiKey')
})
