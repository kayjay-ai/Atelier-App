#!/usr/bin/env bash
# Ship a committed version of the API to the Droplet and make it live.
# Run from the repo root (Git Bash on Windows, or any Unix shell):
#   deploy/droplet/deploy.sh            # deploys HEAD
#   deploy/droplet/deploy.sh <git-ref>  # deploys a branch, tag or commit
# Only committed files are shipped (git archive); the server never needs
# access to the private GitHub repo. Override the target with ATELIER_HOST.
set -euo pipefail

HOST="${ATELIER_HOST:-root@64.227.155.17}"
# On Windows, use Windows' OpenSSH so the key loaded in its ssh-agent service is used
# (Git Bash's own ssh can't see that agent). Override with SSH=/path/to/ssh.
WIN_SSH=/c/Windows/System32/OpenSSH/ssh.exe
if [ -z "${SSH:-}" ]; then [ -x "$WIN_SSH" ] && SSH="$WIN_SSH" || SSH=ssh; fi
ssh() { "$SSH" "$@"; }
REF="${1:-HEAD}"
SHA="$(git rev-parse --short "$REF")"
RELEASE="$(date -u +%Y%m%d-%H%M%S)-$SHA"
PATHS=(package.json package-lock.json frontend/package.json backend deploy/droplet)

if [ "$REF" = HEAD ] && [ -n "$(git status --porcelain -- "${PATHS[@]}")" ]; then
  echo "Note: uncommitted changes in these paths are NOT deployed (shipping $SHA):" >&2
  git status --short -- "${PATHS[@]}" >&2
fi

echo "== upload $RELEASE to $HOST"
git archive --format=tar "$REF" "${PATHS[@]}" \
  | ssh "$HOST" "mkdir -p /srv/atelier/releases/$RELEASE && tar -x -C /srv/atelier/releases/$RELEASE"

ssh "$HOST" "bash /srv/atelier/releases/$RELEASE/deploy/droplet/activate.sh $RELEASE"
