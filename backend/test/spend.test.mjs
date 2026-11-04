import './helpers.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSpender } from '../lib/spend.mjs'

// The spend module through its interface, with fake ledgers that record calls.
function fakeLedgers({ partner = { ok: true, charged: 1, ledgerId: 'L1', status: { companyRemaining: 9 } }, store = { allowed: true, creditsBalance: 41 }, member = { allowed: true, membership: { creditsBalance: 2 } } } = {}) {
  const calls = []
  return {
    calls,
    ledgers: {
      partner: {
        charge: async (ctx, action) => { calls.push(['partner.charge', ctx.companyId, action]); return partner },
        refund: async (ctx, charge) => { calls.push(['partner.refund', ctx.companyId, charge.ledgerId]) },
        status: async () => ({ companyRemaining: 9 }),
      },
      store: {
        charge: async (id, opts) => { calls.push(['store.charge', id, opts.feature]); return store },
        refund: async (id) => { calls.push(['store.refund', id]) },
      },
      member: {
        charge: async (id) => { calls.push(['member.charge', id]); return member },
        refund: async (id) => { calls.push(['member.refund', id]) },
      },
    },
  }
}

const storeCaller = { user: { id: 'u1' }, store: { clientId: 's1' }, device: { id: 'd1' } }
const memberCaller = { user: { id: 'u2' } }

test('embed partner: charged, and refunded exactly once on failure', async () => {
  const { ledgers, calls } = fakeLedgers()
  const spend = await createSpender(ledgers).reserve({ feature: 'style', body: { companyId: 'verve', userId: 'x' } })
  assert.equal(spend.ok, true)
  assert.equal(spend.ledger, 'partner')
  assert.deepEqual(spend.balances().credits, { companyRemaining: 9 })
  await spend.refund()
  await spend.refund()
  assert.deepEqual(calls, [['partner.charge', 'verve', 'style'], ['partner.refund', 'verve', 'L1']])
})

test('embed partner: out of credits is a 402 paywall', async () => {
  const { ledgers } = fakeLedgers({ partner: { ok: false, error: 'used up', code: 'CompanyBalanceExceeded' } })
  const spend = await createSpender(ledgers).reserve({ feature: 'tryon', body: { companyId: 'verve', userId: 'x' } })
  assert.equal(spend.ok, false)
  assert.equal(spend.status, 402)
  assert.equal(spend.body.paywall, true)
})

test('embed partner: a free feature charges nothing', async () => {
  const { ledgers, calls } = fakeLedgers()
  const spend = await createSpender(ledgers).reserve({ feature: 'size', body: { companyId: 'verve', userId: 'x' } })
  assert.equal(spend.ok, true)
  assert.deepEqual(calls, [])
})

test('store: try-on spends a store credit and reports the balance', async () => {
  const { ledgers, calls } = fakeLedgers()
  const spend = await createSpender(ledgers).reserve({ feature: 'tryon', caller: storeCaller })
  assert.equal(spend.ledger, 'store')
  assert.deepEqual(spend.balances().client, { creditsBalance: 41 })
  await spend.refund()
  assert.deepEqual(calls, [['store.charge', 's1', 'tryon'], ['store.refund', 's1']])
})

test('store: no credits → 402, expired plan → 403 pointing at Plan & Credits', async () => {
  let r = await createSpender(fakeLedgers({ store: { allowed: false, reason: 'no_credits' } }).ledgers).reserve({ feature: 'tryon', caller: storeCaller })
  assert.equal(r.status, 402)
  r = await createSpender(fakeLedgers({ store: { allowed: false, reason: 'expired' } }).ledgers).reserve({ feature: 'tryon', caller: storeCaller })
  assert.equal(r.status, 403)
  assert.match(r.body.message, /Plan & Credits/)
})

test('member: out of credits → 402 with the membership', async () => {
  const { ledgers } = fakeLedgers({ member: { allowed: false, membership: { creditsBalance: 0 } } })
  const r = await createSpender(ledgers).reserve({ feature: 'tryon', caller: memberCaller })
  assert.equal(r.status, 402)
  assert.deepEqual(r.body.membership, { creditsBalance: 0 })
})

test('store and member ledgers are only charged for try-ons', async () => {
  const { ledgers, calls } = fakeLedgers()
  const r = await createSpender(ledgers).reserve({ feature: 'style', caller: storeCaller })
  assert.equal(r.ledger, 'none')
  assert.deepEqual(calls, [])
})

test('a failing ledger answers 503 (store) or fails open (member)', async () => {
  const boom = async () => { throw new Error('db down') }
  const { ledgers } = fakeLedgers()
  const r = await createSpender({ ...ledgers, store: { ...ledgers.store, charge: boom } }).reserve({ feature: 'tryon', caller: storeCaller })
  assert.equal(r.status, 503)
  const m = await createSpender({ ...ledgers, member: { ...ledgers.member, charge: boom } }).reserve({ feature: 'tryon', caller: memberCaller })
  assert.equal(m.ok, true)
})
