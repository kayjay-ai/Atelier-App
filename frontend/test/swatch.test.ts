import { test } from 'node:test'
import assert from 'node:assert/strict'
import { swatchHex } from '../lib/swatch.ts'

test('swatchHex: a saved hex without its # still draws', () => {
  assert.equal(swatchHex('FFDAB9'), '#FFDAB9')
  assert.equal(swatchHex('#ffdab9'), '#FFDAB9')
  assert.equal(swatchHex(' 0x90ee90 '), '#90EE90')
  assert.equal(swatchHex('#abc'), '#AABBCC')
})

test('swatchHex: anything else is no colour', () => {
  for (const bad of [undefined, null, '', 'peach', '#12345', 'rgb(1,2,3)']) assert.equal(swatchHex(bad), undefined)
})
