# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

# Repo layout

- Repo root: the Expo app (expo-router; `app/`, `components/`, `lib/`, `public/`).
  It calls the backend through `lib/api.ts` at `EXPO_PUBLIC_API_URL`.
- `server/`: the Express backend, a separate Node package with its own `package.json`.
  Never import server code from the app, or app code from the server. See `server/README.md`.
  Server secrets go in `server/.env`, never in the root `.env`, because `EXPO_PUBLIC_*` values are bundled into the app.
  All server database access goes through `server/lib/db.mjs` (`serviceDb()`, `isMissingSchema()`); don't create Supabase clients elsewhere.
- `docs/design/`: the design mockups (`1.svg`–`5.svg`) that `lib/theme.ts` and `lib/ui.tsx` follow.
- `supabase/`: SQL migrations and schema snapshots. There is no runner: paste a migration into the Supabase SQL editor to apply it.
  Server code tolerates a missing migration, so new migrations need the same tolerance.

Run it locally in two terminals: `npm run api` (backend on :8787) and `npm start` (Expo).
Use `npm run api:install` the first time.
The product catalog lives only in `server/data/products.json`; the app doesn't read it.
