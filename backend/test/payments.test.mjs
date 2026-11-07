import './helpers.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizePhone } from '../lib/cashfree.mjs'

test('normalizePhone: 10-digit Indian mobile from what people type', () => {
  assert.equal(normalizePhone('9876543210'), '9876543210')
  assert.equal(normalizePhone('+91 98765 43210'), '9876543210')
  assert.equal(normalizePhone('091-98765-43210'.replace(/^0/, '')), '9876543210')
  assert.equal(normalizePhone('09876543210'), '9876543210')
  assert.equal(normalizePhone(' 98765-43210 '), '9876543210')
})

test('normalizePhone: rejects anything Cashfree would refuse', () => {
  assert.equal(normalizePhone(''), null)
  assert.equal(normalizePhone(null), null)
  assert.equal(normalizePhone('12345'), null)
  assert.equal(normalizePhone('1234567890'), null) // mobiles start with 6-9
  assert.equal(normalizePhone('98765432101'), null)
})
