# Atelier

Virtual try-on and styling for shoppers (B2C) and in-store iPads (B2B).

| Folder | What it is | Deploys to |
|---|---|---|
| [`frontend/`](frontend/) | Expo app (expo-router) for iOS, Android and web | web: Cloudflare · native: EAS |
| [`backend/`](backend/) | Express API: Gemini AI, credits, Cashfree payments, embed SSO, daily job | DigitalOcean |
| [`supabase/`](supabase/) | SQL migrations and schema snapshots (database + auth) | Supabase SQL editor |
| [`docs/design/`](docs/design/) | Design mockups the app's theme follows | not deployed |

The repo is one npm workspace: a single `npm install` at the root installs both apps, and
there is one lockfile (`package-lock.json`).

## First-time setup

Needs Node 22 or later.

```bash
npm install
cp frontend/.env.example frontend/.env    # public app settings (EXPO_PUBLIC_*)
cp backend/.env.example backend/.env      # server secrets (Gemini, Supabase service role, Cashfree)
```

Fill in both `.env` files. Every backend key is optional: missing keys switch features off
instead of crashing (no Supabase means no credit gating, no Gemini means demo images).

**Why two `.env` files:** everything in `frontend/.env` is built into the public app bundle,
so it may only hold `EXPO_PUBLIC_*` values. Secrets live only in `backend/.env`, on the server.

## Daily workflow

| Command (run from the repo root) | Does |
|---|---|
| `npm run dev` | Starts the API (http://localhost:8787, restarts on change) and Expo together |
| `npm run dev:api` | API only |
| `npm run dev:app` | Expo only (interactive: press `w` for web, `i`/`a` for simulators) |
| `npm test` | Backend tests, then the app's unit tests (no database, Gemini or Cashfree needed) |
| `npm run typecheck` | TypeScript check of the app |
| `npm run build:web` | Static web build into `frontend/dist/` |
| `npm start` | Runs the API the way production does |
| `npm run job:daily` | Daily maintenance job (expire folders, suspend lapsed plans, credit emails) |

On a physical device, set `EXPO_PUBLIC_API_URL=http://<your-LAN-IP>:8787` in `frontend/.env`.
API check: `GET /api/health` returns `{ "ok": true }`.

To add a package, name the workspace: `npm install <pkg> -w backend`, or
`npx expo install <pkg>` from inside `frontend/` (it picks the version matching the Expo SDK).

## Database

Supabase holds the data and auth. There is no migration runner: paste a file from
`supabase/migrations/` into the Supabase SQL editor. Every migration is idempotent (safe to
re-run), and the backend keeps working when a newer migration hasn't been applied yet. New
migrations must keep both properties.

## How the pieces talk

- The app calls the API at `EXPO_PUBLIC_API_URL` through `frontend/lib/api.ts`, and reads
  its own rows straight from Supabase with the anon key (row-level security applies).
- The API uses the Supabase service-role key, only through `backend/lib/db.mjs`. It is the
  only writer of credits, payments and membership.
- Payments: the API creates Cashfree orders and verifies them server-to-server; the app never
  decides an amount. Cashfree calls `<API_PUBLIC_URL>/api/payments/webhook`.
- The product catalog lives in `backend/data/products.json`.

### Backend layout

| Path | What it holds |
|---|---|
| `backend/index.mjs` | Starts the server |
| `backend/app.mjs` | Shared middleware (CORS, webhook raw body, logging, usage log), mounts the routes |
| `backend/routes/` | One file per area: `account`, `payments`, `embed`, `b2b`, `ai`, `admin` |
| `backend/lib/identity.mjs` | Who is calling (user, store, iPad), worked out once per request |
| `backend/lib/features.mjs` | Every AI feature and its toggles and costs |
| `backend/lib/ai.mjs` | Gemini calls and marked stand-in answers |
| `backend/lib/spend.mjs` | Charging and refunding credits on every ledger |
| `backend/lib/payments.mjs` | Cashfree payments for credit packs and store billing, one webhook |
| `backend/test/` | `node:test` suites (`npm test`) |

Business terms (store, plan credits, top-up credits, stand-in, ...) are defined in [`GLOSSARY.md`](GLOSSARY.md).

## Production

**API (`backend/`)**: runs on a DigitalOcean Droplet behind Caddy; setup, deploy and
rollback are in [`deploy/droplet/README.md`](deploy/droplet/README.md) (`bash deploy/droplet/deploy.sh`).
- Install `npm ci -w backend --omit=dev`, start `npm start` (listens on `0.0.0.0:$PORT`). Node 22.
- Set the variables from `backend/.env.example` on the host, in particular `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `CORS_ALLOWED_ORIGINS` (the web app's origin), `API_PUBLIC_URL`
  and `APP_PUBLIC_URL`.
- Register `<API_PUBLIC_URL>/api/payments/webhook` in the Cashfree dashboard.
- Health check: `/health` or `/api/health`.
- Once a day, run `npm run job:daily`, or call `POST /api/jobs/daily` with the `X-Job-Secret` header.

**Web app (`frontend/`)**
- Build `npm ci && npm run build:web`, then serve `frontend/dist/` as static files.
- Set the `EXPO_PUBLIC_*` variables in the build environment (they are baked in at build time).

**iOS / Android:** EAS Build from `frontend/` (`eas build --profile <name>`); profiles and
their env are in `frontend/eas.json`.
