# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

# Repo layout

One npm workspace (root `package.json`, one `package-lock.json`). See `README.md` for commands.

- `frontend/`: the Expo app (expo-router; `app/`, `components/`, `lib/`, `public/`, `assets/`).
  It calls the backend through `frontend/lib/api.ts` at `EXPO_PUBLIC_API_URL`.
  Add packages with `npx expo install <pkg>` from `frontend/`, so versions match the SDK.
- `backend/`: the Express API (`index.mjs`, `lib/`, `jobs/`, `data/`, `legal/`, `scripts/`).
  Never import backend code from the frontend, or frontend code from the backend.
  All database access goes through `backend/lib/db.mjs` (`serviceDb()`, `isMissingSchema()`); don't create Supabase clients elsewhere.
- `supabase/`: SQL migrations and schema snapshots. There is no runner: paste a migration into the Supabase SQL editor to apply it.
  Migrations must be idempotent, and backend code must tolerate a migration that isn't applied yet.
- `docs/design/`: the design mockups (`1.svg`–`5.svg`) that `frontend/lib/theme.ts` and `frontend/lib/ui.tsx` follow.

Env: `frontend/.env` holds only `EXPO_PUBLIC_*` values, because they are bundled into the public app.
Secrets go in `backend/.env`. Each has a `.env.example`; keep it in step when adding a variable.

Run locally with `npm run dev` from the root (API on :8787 plus Expo), and check with `npm run typecheck` and `npm run build:web`.
The product catalog lives only in `backend/data/products.json`.
