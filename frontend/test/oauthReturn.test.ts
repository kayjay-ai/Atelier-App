import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readAuthReturn } from '../lib/oauthReturn.ts'

test('implicit flow: session tokens after #', () => {
  assert.deepEqual(
    readAuthReturn('atelier://auth#access_token=abc.def&expires_in=3600&refresh_token=r1&token_type=bearer'),
    { kind: 'tokens', accessToken: 'abc.def', refreshToken: 'r1' },
  )
})

test('PKCE flow: a code to exchange', () => {
  assert.deepEqual(readAuthReturn('atelier://auth?code=xyz-123'), { kind: 'code', code: 'xyz-123' })
})

test('provider errors are reported, decoded', () => {
  assert.deepEqual(
    readAuthReturn('atelier://auth#error=access_denied&error_description=User+cancelled%20login'),
    { kind: 'error', message: 'User cancelled login' },
  )
  assert.deepEqual(readAuthReturn('atelier://auth?error=server_error'), { kind: 'error', message: 'server_error' })
})

test('nothing usable', () => {
  assert.deepEqual(readAuthReturn('atelier://auth'), { kind: 'none' })
  assert.deepEqual(readAuthReturn('atelier://auth#access_token=only'), { kind: 'none' })
})
