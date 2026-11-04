import './helpers.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { askJson, markFallback, imagePart } from '../lib/ai.mjs'
import { kindOf } from '../lib/payments.mjs'

// lib/ai.mjs through its interface, with a fake Gemini client.
const fakeClient = (reply) => ({
  models: { generateContent: async () => (typeof reply === 'function' ? reply() : { text: reply }) },
})

test('askJson: accepted answer', async () => {
  const out = await askJson({ label: 't', parts: [], accept: (d) => !!d.size, client: fakeClient('{"size":"M"}') })
  assert.deepEqual(out, { ok: true, data: { size: 'M' } })
})

test('askJson: no key, rejected answer, rate limit, error', async () => {
  assert.equal((await askJson({ label: 't', parts: [], accept: () => true, client: null })).reason, 'no_key')
  assert.equal((await askJson({ label: 't', parts: [], accept: (d) => !!d.size, client: fakeClient('{"other":1}') })).reason, 'failed')
  const limited = fakeClient(() => { const e = new Error('RESOURCE_EXHAUSTED'); e.status = 429; throw e })
  assert.equal((await askJson({ label: 't', parts: [], accept: () => true, client: limited })).reason, 'rate_limit')
  const broken = fakeClient(() => { throw new Error('boom') })
  assert.equal((await askJson({ label: 't', parts: [], accept: () => true, client: broken })).reason, 'failed')
})

test('markFallback keeps the canned fields and adds the flags', () => {
  assert.deepEqual(markFallback({ a: 1 }, 'rate_limit'), { a: 1, fallback: true, fallbackReason: 'rate_limit', retryable: true })
  assert.equal(markFallback({}, 'no_key').retryable, false)
})

test('imagePart reads data URIs and bare base64', () => {
  assert.deepEqual(imagePart('data:image/png;base64,QUJD'), { inlineData: { mimeType: 'image/png', data: 'QUJD' } })
  assert.deepEqual(imagePart('QUJD'), { inlineData: { mimeType: 'image/jpeg', data: 'QUJD' } })
})

test('payments: the order id picks the product kind', () => {
  assert.equal(kindOf('b2b_1793_abcd').name, 'storeBilling')
  assert.equal(kindOf('atelier_1793_xyz').name, 'creditPack')
  assert.equal(kindOf(undefined), null)
})
