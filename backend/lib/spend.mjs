import { consumeCredits, refundCredits, creditContextFromBody, getCreditStatus } from './credits.mjs'
import { consumeClientCredit, refundClientCredit } from './clients.mjs'
import { reserveTryOn, refundTryOn } from './membership.mjs'
import { featureSpec } from './features.mjs'
import { ATELIER_BUSY_MESSAGE } from './fallbacks.mjs'

// =============================================================================
// Spending credits on an AI call: one module for every ledger a caller can
// spend from.
//   partner — a website-embed partner (body.companyId) → lib/credits.mjs
//   store   — a B2B store login                       → lib/clients.mjs
//   member  — a B2C member                            → lib/membership.mjs
// Store and member ledgers are charged for try-ons only (features.mjs `ledgers`).
//
//   const spend = await spender.reserve({ feature, body, caller })
//   if (!spend.ok) return res.status(spend.status).json(spend.body)
//   ...run the AI call...
//   on failure:  await spend.refund()          (idempotent)
//   on success:  res.json({ ...result, ...spend.balances() })
//
// Call reserve AFTER validating the request, so a bad request never costs a credit.
// =============================================================================

export const realLedgers = {
  partner: {
    charge: (ctx, action) => consumeCredits({ ...ctx, action }),
    refund: (ctx, charge) => refundCredits({ companyId: ctx.companyId, ledgerId: charge.ledgerId, credits: charge.charged }),
    status: (ctx) => getCreditStatus(ctx),
  },
  store: {
    charge: (storeId, opts) => consumeClientCredit(storeId, opts),
    refund: (storeId, opts) => refundClientCredit(storeId, opts),
  },
  member: {
    charge: (userId) => reserveTryOn(userId),
    refund: (userId) => refundTryOn(userId),
  },
}

const busy = (type, err) => ({
  ok: false,
  status: 503,
  body: { fallback: true, retryable: true, message: ATELIER_BUSY_MESSAGE, error: { status: 503, type, message: err?.message } },
})

const STORE_REFUSED = {
  trial_ended: 'Your free trial has ended — choose a plan in Plan & Credits.',
  expired: 'Your plan has expired — renew it in Plan & Credits.',
  not_activated: 'Your store isn’t activated yet — contact Atelier support.',
  feature_disabled: 'This feature is switched off for your store — contact Atelier support.',
}

export function createSpender(ledgers = realLedgers) {
  /**
   * @param {{ feature: string, body?: object, caller?: { user?: object, store?: object, device?: object } }} p
   * @returns {Promise<{ ok: true, ledger: string, refund: () => Promise<void>, balances: () => object } | { ok: false, status: number, body: object }>}
   */
  async function reserve({ feature, body = {}, caller = {} }) {
    const spec = featureSpec(feature)
    const partnerCtx = creditContextFromBody(body)

    // Embed partners pay per call from their own pool, whoever the user is.
    if (partnerCtx.companyId) {
      if (spec.partnerCost <= 0) {
        return granted('partner', null, { credits: await ledgers.partner.status(partnerCtx).catch(() => null) })
      }
      let charge
      try {
        charge = await ledgers.partner.charge(partnerCtx, feature)
      } catch (err) {
        console.error('[Atelier] partner credit charge failed:', err?.message)
        return busy('CreditCheckFailed', err)
      }
      if (!charge.ok) {
        return {
          ok: false,
          status: 402,
          body: {
            fallback: true,
            paywall: true,
            message: charge.error,
            error: { status: 402, type: charge.code ?? 'CreditsExceeded', message: charge.error },
            credits: charge.status ?? null,
          },
        }
      }
      return granted('partner', () => ledgers.partner.refund(partnerCtx, charge), { credits: charge.status ?? null })
    }

    if (!spec.ledgers) return granted('none', null, {})

    const { store, user, device } = caller
    if (store) {
      const opts = { feature, deviceId: device?.id ?? null }
      let spend
      try {
        spend = await ledgers.store.charge(store.clientId, opts)
      } catch (err) {
        console.error('[Atelier] store credit charge failed:', err?.message)
        return busy('CreditCheckFailed', err)
      }
      if (!spend.allowed) {
        console.info(`[Atelier] ${feature}: store ${store.clientId} refused (${spend.reason})`)
        if (spend.reason === 'no_credits') {
          return {
            ok: false,
            status: 402,
            body: { fallback: true, paywall: true, message: 'Credits used up — upgrade your plan or add credits.', client: { creditsBalance: 0 } },
          }
        }
        const msg = STORE_REFUSED[spend.reason] ?? 'Your account is paused — contact Atelier support.'
        return { ok: false, status: 403, body: { fallback: true, error: msg, message: msg, reason: spend.reason } }
      }
      return granted('store', () => ledgers.store.refund(store.clientId, opts), { client: { creditsBalance: spend.creditsBalance } })
    }

    if (user) {
      let reservation
      try {
        reservation = await ledgers.member.charge(user.id)
      } catch (err) {
        // Fail open (e.g. migration not yet applied) so paying users aren't blocked.
        console.error('[Atelier] member credit charge failed — allowing this call:', err?.message)
        return granted('member', null, { membership: null })
      }
      if (!reservation.allowed) {
        console.info(`[Atelier] ${feature}: member ${user.id} is out of credits`)
        return {
          ok: false,
          status: 402,
          body: {
            fallback: true,
            paywall: true,
            message: "You're out of credits. Buy more to keep generating — ₹15 for one, or a credit pack.",
            membership: reservation.membership,
          },
        }
      }
      return granted('member', () => ledgers.member.refund(user.id), { membership: reservation.membership ?? null })
    }

    // Anonymous (no token, e.g. the web demo): nothing to charge.
    return granted('none', null, {})
  }

  function granted(ledger, undo, balanceFields) {
    let refunded = false
    return {
      ok: true,
      ledger,
      async refund() {
        if (refunded || !undo) return
        refunded = true
        try {
          await undo()
        } catch (err) {
          console.warn(`[Atelier] ${ledger} refund failed:`, err?.message)
        }
      },
      // Same response fields as before: credits (partner), client (store), membership (member).
      balances: () => ({ credits: null, membership: null, client: null, ...balanceFields }),
    }
  }

  return { reserve }
}

export const spender = createSpender()
