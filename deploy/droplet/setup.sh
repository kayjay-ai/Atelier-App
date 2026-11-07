#!/usr/bin/env bash
# One-time setup of the DigitalOcean Droplet that runs the Atelier API.
# Safe to re-run: every step checks before it changes anything.
#
# Run on the server as root:
#   bash setup.sh <api-host>        e.g. bash setup.sh 64-227-155-17.sslip.io
#
# Leaves: Node 22, pm2 (as user `atelier`, started on boot), Caddy serving
# https://<api-host> -> 127.0.0.1:8787, firewall open only for ssh/http/https,
# swap, and a daily cron for `npm run job:daily`. See deploy/droplet/README.md.
set -euo pipefail

API_HOST="${1:?usage: setup.sh <api-host>}"
APP_USER=atelier
APP_DIR=/srv/atelier
export DEBIAN_FRONTEND=noninteractive
# Run as the app user from its home (it can't read root's working directory).
as_app() { sudo -u "$APP_USER" -H bash -c "cd ~ && $1"; }

echo "== packages"
apt-get update -q
apt-get upgrade -y -q
apt-get install -y -q curl ca-certificates gnupg ufw debian-keyring debian-archive-keyring apt-transport-https

echo "== swap (npm ci and sharp need more than 1 GB at peak)"
if ! swapon --show | grep -q '^/swapfile'; then
  [ -f /swapfile ] || fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab

echo "== Node 22"
if ! node -v 2>/dev/null | grep -q '^v22\.'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi
command -v pm2 >/dev/null || npm install -g pm2@6

echo "== Caddy"
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi
HERE="$(cd "$(dirname "$0")" && pwd)"
sed "s/API_HOST/${API_HOST}/" "$HERE/Caddyfile" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy || systemctl restart caddy

echo "== firewall (the API port 8787 stays private; Caddy fronts it)"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "== app user and folders"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$APP_USER"
mkdir -p "$APP_DIR/releases" "$APP_DIR/shared"
[ -f "$APP_DIR/shared/backend.env" ] || install -m 600 /dev/null "$APP_DIR/shared/backend.env"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 600 "$APP_DIR/shared/backend.env"

echo "== pm2 on boot, with log rotation"
pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER" >/dev/null
systemctl start "pm2-$APP_USER"   # the boot service owns the pm2 daemon
as_app "pm2 describe pm2-logrotate" >/dev/null 2>&1 || as_app "pm2 install pm2-logrotate"

echo "== daily job: 21:30 UTC = 03:00 IST (server clock is UTC)"
cat > /etc/cron.d/atelier-daily <<EOF
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
30 21 * * * $APP_USER cd $APP_DIR/current && npm run job:daily >> $APP_DIR/shared/daily.log 2>&1
EOF
chmod 644 /etc/cron.d/atelier-daily

echo "== done. Next: fill $APP_DIR/shared/backend.env, then run deploy/droplet/deploy.sh from your machine."
