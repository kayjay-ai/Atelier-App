# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

# Repo layout

One npm workspace (root `package.json`, one `package-lock.json`). See `README.md` for commands.

- `frontend/`: the Expo app (expo-router; `app/`, `components/`, `lib/`, `public/`, `assets/`).
  It calls the backend through `frontend/lib/api.ts` at `EXPO_PUBLIC_API_URL`.
  Add packages with `npx expo install <pkg>` from `frontend/`, so versions match the SDK.
- `backend/`: the Express API. `app.mjs` wires middleware and mounts `routes/<area>.mjs`; `index.mjs` only listens.
  Never import backend code from the frontend, or frontend code from the backend.
  All database access goes through `backend/lib/db.mjs` (`serviceDb()`, `isMissingSchema()`); don't create Supabase clients elsewhere.
  Get the caller with `callerOf(req)` (`lib/identity.mjs`), never by calling `getUserFromRequest`/`getClientContext` in a route.
  AI routes follow the steps in `routes/ai.mjs`: gate, validate, reserve credits (`lib/spend.mjs`), ask (`lib/ai.mjs`), answer or mark a stand-in and refund.
  Feature names, toggles and costs live only in `lib/features.mjs`. Payments go through `lib/payments.mjs`.
  A module must not change the environment when imported (no `dotenv` outside `index.mjs`).
- `supabase/`: SQL migrations and schema snapshots. There is no runner: paste a migration into the Supabase SQL editor to apply it.
  Migrations must be idempotent, and backend code must tolerate a migration that isn't applied yet.
- `docs/design/`: the design mockups (`1.svg`–`5.svg`) that `frontend/lib/theme.ts` and `frontend/lib/ui.tsx` follow.

Env: `frontend/.env` holds only `EXPO_PUBLIC_*` values, because they are bundled into the public app.
Secrets go in `backend/.env`. Each has a `.env.example`; keep it in step when adding a variable.

Run locally with `npm run dev` from the root (API on :8787 plus Expo), and check with `npm test`, `npm run typecheck` and `npm run build:web`.
API responses only ever gain fields: installed iPad and phone builds keep calling older shapes.
An AI stand-in answer is marked `fallback: true`; the app reads it through `frontend/lib/aiOutcome.ts` and never saves it.
Store status and usable credits come from the database (`b2b_store_credits` view); don't re-derive them in JS.
Business terms are in `GLOSSARY.md`.
The product catalog lives only in `backend/data/products.json`.
