import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isFallback, isRetryable, tryOnOutcome } from '../lib/aiOutcome.ts'
import { runTryOnAttempt } from '../lib/tryOnAttempt.ts'

// lib/aiOutcome.ts and lib/tryOnAttempt.ts through their interfaces.

test('marked stand-ins are fallbacks; real answers are not', () => {
  assert.equal(isFallback({ fallback: true }), true)
  assert.equal(isFallback({ fallback: false, caveat: 'AI analysis unavailable right now.' }), false)
  assert.equal(isFallback({ size: 'M', confidence: 'high' } as any), false)
  assert.equal(isFallback(null), false)
})

test('older API builds: stand-ins recognised by their canned text', () => {
  assert.equal(isFallback({ caveat: 'AI analysis unavailable right now.' }), true)
  assert.equal(isFallback({ whyItWorks: '—' }), true)
  assert.equal(isRetryable({ caveat: 'AI analysis unavailable right now.' }), true)
  assert.equal(isRetryable({ caveat: 'No AI key configured.' }), false)
})

test('retryable follows the flag', () => {
  assert.equal(isRetryable({ fallback: true, retryable: true }), true)
  assert.equal(isRetryable({ fallback: true, retryable: false }), false)
  assert.equal(isRetryable({ fallback: false, retryable: true }), false)
})

test('try-on outcome: image, paywall, failed', () => {
  assert.equal(tryOnOutcome({ image: 'data:x' }).kind, 'image')
  assert.equal(tryOnOutcome({ paywall: true, fallback: true }).kind, 'paywall')
  const failed = tryOnOutcome({ fallback: true, retryable: true, message: 'busy' })
  assert.deepEqual([failed.kind, (failed as any).retryable, (failed as any).message], ['failed', true, 'busy'])
  assert.equal(tryOnOutcome({}).kind, 'failed') // no image at all
})

function ports(result: any, { failCall = false } = {}) {
  const log: string[] = []
  return {
    log,
    ports: {
      call: async () => { if (failCall) throw new Error('offline'); return result },
      applyBalance: (r: any) => { log.push(`balance:${r.client?.creditsBalance ?? r.membership?.creditsBalance ?? '-'}`) },
      save: async (image: string) => { log.push(`save:${image}`); return 'row-1' },
    },
  }
}

test('attempt: a real image applies the balance and is saved', async () => {
  const { ports: p, log } = ports({ image: 'img', client: { creditsBalance: 7 } })
  const { outcome, saved } = await runTryOnAttempt(p)
  assert.equal(outcome.kind, 'image')
  assert.equal(await saved, 'row-1')
  assert.deepEqual(log, ['balance:7', 'save:img'])
})

test('attempt: stand-ins, demo and debug images are never saved', async () => {
  for (const r of [{ fallback: true, message: 'busy' }, { image: 'img', demo: true }, { image: 'img', debug: true }]) {
    const { ports: p, log } = ports(r)
    const { saved } = await runTryOnAttempt(p)
    assert.equal(saved, null)
    assert.ok(!log.some((l) => l.startsWith('save')), JSON.stringify(r))
  }
})

test('attempt: a paywall still applies the balance the server reports', async () => {
  const { ports: p, log } = ports({ paywall: true, fallback: true, client: { creditsBalance: 0 } })
  const { outcome } = await runTryOnAttempt(p)
  assert.equal(outcome.kind, 'paywall')
  assert.deepEqual(log, ['balance:0'])
})

test('attempt: a network error is a failed, non-retryable outcome', async () => {
  const { ports: p, log } = ports(null, { failCall: true })
  const { outcome, saved } = await runTryOnAttempt(p)
  assert.equal(outcome.kind, 'failed')
  assert.equal((outcome as any).message, 'offline')
  assert.equal(saved, null)
  assert.deepEqual(log, [])
})
