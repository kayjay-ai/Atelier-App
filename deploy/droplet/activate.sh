#!/usr/bin/env bash
# Runs ON THE SERVER as root (deploy.sh calls it). Makes one release live:
# install backend dependencies, link the shared .env, switch `current`, restart
# pm2, check health, keep the last 5 releases.
#
# Roll back to an earlier release:
#   ssh root@<droplet> 'ls /srv/atelier/releases'
#   ssh root@<droplet> 'bash /srv/atelier/current/deploy/droplet/activate.sh <release>'
set -euo pipefail

RELEASE="${1:?usage: activate.sh <release-folder-name>}"
APP_USER=atelier
APP_DIR=/srv/atelier
DIR="$APP_DIR/releases/$RELEASE"
# Run as the app user from its home (it can't read root's working directory).
as_app() { sudo -u "$APP_USER" -H bash -c "cd ~ && $1"; }

[ -d "$DIR" ] || { echo "No release $DIR" >&2; exit 1; }
[ -s "$APP_DIR/shared/backend.env" ] || echo "WARNING: $APP_DIR/shared/backend.env is empty; the API will start with every feature off." >&2

chown -R "$APP_USER:$APP_USER" "$DIR"
ln -sfn "$APP_DIR/shared/backend.env" "$DIR/backend/.env"

if [ ! -d "$DIR/node_modules" ]; then
  echo "== npm ci (backend only)"
  as_app "cd '$DIR' && npm ci -w backend --omit=dev --no-audit --no-fund"
fi

echo "== switch current -> $RELEASE"
ln -sfnT "$DIR" "$APP_DIR/current"

echo "== restart"
as_app "pm2 startOrReload '$APP_DIR/current/deploy/droplet/ecosystem.config.cjs' --update-env && pm2 save"

echo "== health"
for _ in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:8787/api/health; then
    echo
    # Keep the 5 newest releases, and never the live one (it may be older after a rollback).
    ls -1dt "$APP_DIR"/releases/*/ | tail -n +6 | { grep -vxF "$DIR/" || true; } | xargs -r rm -rf
    echo "== live: $RELEASE"
    exit 0
  fi
  sleep 1
done
echo "Health check failed. Recent logs:" >&2
as_app "pm2 logs atelier-api --lines 40 --nostream" >&2 || true
exit 1
