# Glossary

The words the code uses for Atelier's business. Module and variable names follow
these terms; when one changes meaning, update it here.

## Who uses Atelier

- **Member**: a shopper with an Atelier account (B2C). Spends their own credits.
  `memberships` table, `backend/lib/membership.mjs`.
- **Company**: a retail brand that buys Atelier for its stores. `b2b_companies`.
- **Store**: one of a company's shops, signed in on in-store iPads. Its credits are
  shared by every iPad. `b2b_stores`. Older code calls the store the "client"
  (`clientId` is the store id).
- **Device**: one registered iPad of a store. `b2b_devices`.
- **Embed partner**: a website that embeds Atelier (white-label iframe). Pays per AI
  call from its own pool. `companies` + `credit_ledger`, `backend/lib/credits.mjs`.
  (Not the same as a B2B company.)

## Credits

- **Ledger**: where a caller's credits are spent from: partner, store or member.
  `backend/lib/spend.mjs` charges and refunds all three behind one interface.
- **Plan credits**: a store's credits for the current billing cycle. They expire when
  the cycle ends and never carry over.
- **Top-up credits**: credits a store bought on top of its plan. They never expire and
  are spent after plan credits.
- **Usable credits**: what a store can spend right now: plan credits (0 once the
  cycle has ended) plus top-up credits. Computed only by the `b2b_store_credits` view.
- **Effective status**: a store's state as the app shows it: active, trial,
  suspended or revoked. Computed only in the database (`store_effective_status()`).
- **Credit pack**: a member's one-time credit purchase (₹15 / ₹350 / ₹700).
- **Store billing**: a store's plan payments and top-ups (`backend/lib/b2bBilling.mjs`).
  Credit packs and store billing are the two product kinds in `backend/lib/payments.mjs`.

## AI features

- **Feature**: one AI capability: try-on, style, color, size, verdict, safety. Its
  name in every other vocabulary (embed toggle, store toggle, partner cost) is in
  `backend/lib/features.mjs`.
- **Try-on attempt**: one try-on from the app: call, apply the reported balance,
  read the outcome, save a real image. `frontend/lib/tryOnAttempt.ts`, shared by the
  shopper and store apps.
- **Stand-in** (fallback): the answer an AI feature gives when Gemini is unavailable.
  Marked `fallback: true` by the API; shown, never saved as a real result.
  `backend/lib/ai.mjs` marks it, `frontend/lib/aiOutcome.ts` reads it.
