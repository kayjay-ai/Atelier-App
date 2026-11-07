# API on the DigitalOcean Droplet

The API (`backend/`) runs on one Ubuntu 24.04 Droplet: Caddy terminates HTTPS and
proxies to Node 22 on `127.0.0.1:8787`, kept alive by pm2 as the `atelier` user.

| File | Runs where | Does |
|---|---|---|
| `setup.sh` | server, once (re-runnable) | Node 22, pm2, Caddy, firewall, swap, app user, daily cron |
| `deploy.sh` | your machine | `git archive` of the committed backend → server, then `activate.sh` |
| `activate.sh` | server | `npm ci` (backend only), switch `current`, restart, health check |
| `Caddyfile` | server | HTTPS for the API host |
| `ecosystem.config.cjs` | server | the pm2 process |

## Server layout

```
/srv/atelier/releases/<utc-time>-<sha>/   one folder per deploy (last 5 kept)
/srv/atelier/current -> releases/...      the live release
/srv/atelier/shared/backend.env           production secrets (linked as backend/.env)
/srv/atelier/shared/daily.log             output of the daily job
/srv/atelier/shared/reconcile.log         output of the payment safety net (every 30 min)
```

## First time

```bash
# 1. copy the scripts up and prepare the server
scp -r deploy/droplet root@64.227.155.17:/root/
ssh root@64.227.155.17 'bash /root/droplet/setup.sh 64-227-155-17.sslip.io'

# 2. production secrets: start from backend/.env.example, then set at least
#    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI keys,
#    CORS_ALLOWED_ORIGINS=<web app origin>, APP_PUBLIC_URL=<web app origin>,
#    API_PUBLIC_URL=https://64-227-155-17.sslip.io
scp backend/.env.production root@64.227.155.17:/srv/atelier/shared/backend.env
ssh root@64.227.155.17 'chown atelier: /srv/atelier/shared/backend.env && chmod 600 /srv/atelier/shared/backend.env'

# 3. deploy
bash deploy/droplet/deploy.sh
```

Then register `https://<api-host>/api/payments/webhook` in the Cashfree dashboard.

## Everyday

| Task | Command |
|---|---|
| Deploy the current commit | `bash deploy/droplet/deploy.sh` |
| Change a secret | edit `/srv/atelier/shared/backend.env`, then `sudo -u atelier -H pm2 restart atelier-api --update-env` |
| Logs | `sudo -u atelier -H pm2 logs atelier-api` |
| Roll back | `ls /srv/atelier/releases`, then `bash /srv/atelier/current/deploy/droplet/activate.sh <release>` |
| Run the daily job now | `cd /srv/atelier/current && sudo -u atelier -H npm run job:daily` |

The host `64-227-155-17.sslip.io` resolves to the Droplet's IP so Caddy can get a
certificate without a domain. When a real domain exists, point an A record at the
Droplet, re-run `setup.sh <new-host>`, and update `API_PUBLIC_URL`, the Cashfree
webhook and the app's `EXPO_PUBLIC_API_URL`.
