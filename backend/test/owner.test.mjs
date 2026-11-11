import { startApp, post, get } from './helpers.mjs'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

process.env.OWNER_TOKEN_SECRET = 'test-owner-secret'

const { inviteToken, inviteIdOf, inviteTokenMatches, passwordProblems, maskEmail, describeUserAgent, keyedHash } =
  await import('../lib/ownerSecrets.mjs')
const { validateStoreForm } = await import('../lib/ownerStores.mjs')
const { prefsOf, cleanPrefs } = await import('../lib/ownerNotify.mjs')

const INVITE_ID = '3f2b8c1e-9a4d-4c3b-8e2f-1a2b3c4d5e6f'

test('invite links: round trip, and a new nonce voids the old link', () => {
  const token = inviteToken(INVITE_ID, 'nonce-1')
  assert.equal(inviteIdOf(token), INVITE_ID)
  assert.ok(inviteTokenMatches(token, INVITE_ID, 'nonce-1'))
  assert.ok(!inviteTokenMatches(token, INVITE_ID, 'nonce-2'), 'resend / email change voids the old link')
  const tampered = token.slice(0, -2) + (token.endsWith('A') ? 'BB' : 'AA')
  assert.ok(!inviteTokenMatches(tampered, INVITE_ID, 'nonce-1'))
  assert.equal(inviteIdOf('not-a-token'), null)
  assert.equal(inviteIdOf(`${'g'.repeat(32)}.${'a'.repeat(40)}`), null)
})

test('codes and tokens are keyed hashes, never the value itself', () => {
  const h = keyedHash('otp', 'a@b.com:activation:123456')
  assert.match(h, /^[0-9a-f]{64}$/)
  assert.ok(!h.includes('123456'))
  assert.notEqual(h, keyedHash('otp', 'a@b.com:reset:123456'))
})

test('password rules: 8+ characters, upper, lower, number, symbol', () => {
  assert.deepEqual(passwordProblems('Atelier#2026'), [])
  assert.equal(passwordProblems('short').length, 4)
  assert.ok(passwordProblems('alllowercase1!').includes('One uppercase letter'))
  assert.ok(passwordProblems('NoSymbol123').includes('One symbol'))
  assert.ok(passwordProblems(undefined).length >= 5)
})

test('masked email and device names', () => {
  assert.equal(maskEmail('riya@brand.com'), 'r••••@brand.com')
  assert.equal(describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'), 'Chrome on Windows')
  assert.equal(describeUserAgent('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'), 'Safari on iPad')
})

const FORM = {
  storeName: 'Lahore Road', city: 'Mumbai', state: 'Maharashtra', address: '', pincode: '',
  managerName: 'Priya Shah', managerEmail: 'Priya@Brand.com', countryCode: '+91', managerPhone: '98765 43210', note: '',
}

test('Add Store form: clean input passes and is normalised', () => {
  const v = validateStoreForm(FORM, 'owner@brand.com')
  assert.equal(v.managerEmail, 'priya@brand.com')
  assert.equal(v.phone, '+91 9876543210')
})

test('Add Store form: every problem is reported per field', () => {
  try {
    validateStoreForm({ ...FORM, storeName: 'A', city: '', managerEmail: 'OWNER@brand.com', note: 'x'.repeat(301), pincode: '12' }, 'owner@brand.com')
    assert.fail('should have thrown')
  } catch (err) {
    assert.equal(err.status, 400)
    assert.deepEqual(Object.keys(err.extra.fields).sort(), ['city', 'managerEmail', 'note', 'pincode', 'storeName'])
    assert.match(err.extra.fields.managerEmail, /not yours/)
  }
})

test('notification preferences: defaults on; account can never be turned off', () => {
  const d = prefsOf(null)
  assert.equal(d.email, true)
  assert.ok(Object.values(d.categories).every(Boolean))
  const p = cleanPrefs({ categories: { deals: false, account: false, bogus: false }, email: false }, null)
  assert.equal(p.categories.deals, false)
  assert.equal(p.categories.account, true)
  assert.equal(p.email, false)
  assert.ok(!('bogus' in p.categories))
})

test('test mode (codes shown in the app) is on only while email is not set up', async () => {
  const { emailBypass } = await import('../lib/email.mjs')
  const saved = { k: process.env.RESEND_API_KEY, f: process.env.NOTIFY_FROM_EMAIL, b: process.env.OWNER_EMAIL_BYPASS }
  try {
    process.env.RESEND_API_KEY = ''; process.env.NOTIFY_FROM_EMAIL = ''; process.env.OWNER_EMAIL_BYPASS = ''
    assert.equal(emailBypass(), true)
    process.env.OWNER_EMAIL_BYPASS = 'false'
    assert.equal(emailBypass(), false, 'can be switched off by hand')
    process.env.OWNER_EMAIL_BYPASS = ''
    process.env.RESEND_API_KEY = 're_x'; process.env.NOTIFY_FROM_EMAIL = 'a@b.com'
    assert.equal(emailBypass(), false, 'off by itself once email is set up')
  } finally {
    process.env.RESEND_API_KEY = saved.k ?? ''; process.env.NOTIFY_FROM_EMAIL = saved.f ?? ''; process.env.OWNER_EMAIL_BYPASS = saved.b ?? ''
  }
})

let app
before(async () => { app = await startApp() })
after(async () => { await app.close() })

test('owner routes refuse anyone without an owner session', async () => {
  for (const path of ['/api/owner/me', '/api/owner/stores', '/api/owner/dashboard/summary', '/api/owner/notifications']) {
    const r = await get(app.url, path)
    assert.equal(r.status, 401, path)
    assert.equal(r.body.code, 'session_expired')
  }
  const fake = await get(app.url, '/api/owner/me', { Authorization: 'Bearer a.b.c' })
  assert.equal(fake.status, 401)
})

test('public owner routes validate before touching anything', async () => {
  const verify = await post(app.url, '/api/owner/activate/verify', { org_code: 'TEST', email: 'nope' })
  assert.equal(verify.status, 400)
  assert.equal(verify.body.code, 'mismatch') // one generic message for code / email
  const login = await post(app.url, '/api/owner/login', { email: 'x@y.com' })
  assert.equal(login.status, 401)
  assert.equal(login.body.error, 'Email or password is incorrect.')
  const token = await post(app.url, '/api/owner/password', { token: 'short', password: 'Atelier#2026' })
  assert.equal(token.status, 410)
})

test('a bad invite link is reported as no longer valid', async () => {
  const r = await get(app.url, '/api/invites/garbage')
  assert.equal(r.status, 410)
  assert.equal(r.body.code, 'invalid_invite')
})

test('CORS allows the methods the owner portal uses', async () => {
  const res = await fetch(`${app.url}/api/owner/notifications/x`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:8081' } })
  assert.equal(res.status, 204)
  assert.match(res.headers.get('access-control-allow-methods'), /PATCH/)
  assert.match(res.headers.get('access-control-allow-methods'), /DELETE/)
})
