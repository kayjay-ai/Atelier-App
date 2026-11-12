import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sendEmail, emailProviders, renderEmail } from '../lib/email.mjs'

const KEYS = ['RESEND_API_KEY', 'NOTIFY_FROM_EMAIL', 'SMTP_USER', 'SMTP_PASS', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'NODE_ENV']

/** Run `fn` with exactly these email settings (everything else unset), then restore. */
async function withEnv(env, fn) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  const savedFetch = globalThis.fetch
  for (const k of KEYS) delete process.env[k]
  Object.assign(process.env, env)
  try {
    return await fn()
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    globalThis.fetch = savedFetch
  }
}

test('senders: Resend only with a from address, SMTP with user + password, Resend first', async () => {
  await withEnv({}, () => assert.deepEqual(emailProviders(), []))
  await withEnv({ RESEND_API_KEY: 're_x' }, () => assert.deepEqual(emailProviders(), []))
  await withEnv({ SMTP_USER: 'a@gmail.com', SMTP_PASS: 'p' }, () => assert.deepEqual(emailProviders(), ['smtp']))
  await withEnv({ RESEND_API_KEY: 're_x', NOTIFY_FROM_EMAIL: 'hi@brand.com', SMTP_USER: 'a@gmail.com', SMTP_PASS: 'p' },
    () => assert.deepEqual(emailProviders(), ['resend', 'smtp']))
})

test('nothing set up → skipped, and nothing is sent', async () => {
  await withEnv({ NODE_ENV: 'production' }, async () => {
    const r = await sendEmail({ to: 'a@b.com', subject: 'Hi', body: 'x' })
    assert.equal(r.status, 'skipped')
  })
})

test('Resend is called with a named sender and both bodies', async () => {
  await withEnv({ RESEND_API_KEY: 're_x', NOTIFY_FROM_EMAIL: 'hello@brand.com' }, async () => {
    let sent
    globalThis.fetch = async (url, init) => { sent = { url, ...JSON.parse(init.body) }; return new Response('{}', { status: 200 }) }
    const r = await sendEmail({ to: 'a@b.com', subject: 'Code', body: 'Use it.', code: '123456' })
    assert.equal(r.status, 'sent')
    assert.equal(r.provider, 'resend')
    assert.equal(sent.url, 'https://api.resend.com/emails')
    assert.equal(sent.from, 'Atelier <hello@brand.com>')
    assert.deepEqual(sent.to, ['a@b.com'])
    assert.match(sent.text, /123456/)
    assert.match(sent.html, /123456/)
  })
})

test('a failed Resend falls back to SMTP; both failing reports both errors', async () => {
  await withEnv({
    RESEND_API_KEY: 're_x', NOTIFY_FROM_EMAIL: 'hello@brand.com',
    SMTP_USER: 'a@gmail.com', SMTP_PASS: 'p', SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_SECURE: 'false',
  }, async () => {
    globalThis.fetch = async () => new Response('domain not verified', { status: 403 })
    const r = await sendEmail({ to: 'a@b.com', subject: 'Hi', body: 'x' })
    assert.equal(r.status, 'failed')
    assert.match(r.error, /resend: Resend 403/)
    assert.match(r.error, /smtp: /)
  })
})

test('the HTML layout escapes what it is given', () => {
  const { html, text } = renderEmail({
    subject: 'Hi', body: 'Hello <b>you</b>\n\nSecond', link: { url: 'https://x.test/?a=1&b="2"', label: 'Open' }, code: '<1>',
  })
  assert.ok(!html.includes('<b>you</b>'))
  assert.match(html, /Hello &lt;b&gt;you&lt;\/b&gt;/)
  assert.match(html, /href="https:\/\/x.test\/\?a=1&amp;b=&quot;2&quot;"/)
  assert.match(text, /Open: https:\/\/x.test/)
  assert.match(text, /Your code: <1>/)
})
