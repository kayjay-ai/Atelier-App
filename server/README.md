# Atelier API (`server/`)

The Express backend for the Atelier app: AI features (Gemini), credits, B2C/B2B payments
(Cashfree), embed SSO, and the daily maintenance job. Database and auth are Supabase.
It is a self-contained Node package (own `package.json` and `node_modules`), so it can be
deployed on its own with this folder as the root.

Moved here from the `Atelier` website repo (`Atelier/server`), which is now frozen. Make
backend changes here only.

## Layout

```
index.mjs        every route (Express app; exports `app`, listens on $PORT)
lib/             helpers: credits, membership, b2bBilling, cashfree, tryon, prompts, ...
jobs/daily.mjs   daily maintenance (expire folders, suspend plans, credit emails)
legal/           built-in B2B Terms page served at /legal/b2b-terms
data/            products.json (catalog for AI prompts) + tryon/ demo images
scripts/         seed-tryon, setup-supabase-storage
```

SQL migrations live at the repo root in `../supabase/migrations/` (paste into the Supabase
SQL editor; each file is idempotent).

## Run locally

```bash
cp .env.example .env     # first time; fill in keys (all optional — features degrade gracefully)
npm install              # first time
npm run dev              # http://localhost:8787  (dev:watch restarts on file changes)
```

From the repo root the same commands are `npm run api:install` and `npm run api`.
Check it is up: `GET /api/health` → `{ "ok": true }`.

The app reaches it through `EXPO_PUBLIC_API_URL` in the root `.env`
(`http://localhost:8787` for Expo web/simulator, `http://<your-LAN-IP>:8787` for a device).

## Production

- Build: `npm install`  Start: `npm start` (listens on `0.0.0.0:$PORT`). Node 22.
- Set the env vars from `.env.example` on the host. In particular `CORS_ALLOWED_ORIGINS`
  (the web app's origin), `API_PUBLIC_URL` and `APP_PUBLIC_URL`, and register
  `<API_PUBLIC_URL>/api/payments/webhook` in the Cashfree dashboard.
- Health check path: `/health` or `/api/health`.
- Run `npm run job:daily` once a day (cron), or call `POST /api/jobs/daily` with the
  `X-Job-Secret` header.
