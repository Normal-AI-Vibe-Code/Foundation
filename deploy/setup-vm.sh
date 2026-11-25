#!/usr/bin/env bash
# Make a fresh Ubuntu 24.04 VM ready to run a hosted Foundation (docs/hosting.md).
#
#   curl -fsSL https://raw.githubusercontent.com/joshleong/Foundation/main/deploy/setup-vm.sh -o setup-vm.sh
#   less setup-vm.sh          # read it first
#   sudo bash setup-vm.sh
#
# It installs Docker from Ubuntu's own packages, opens only SSH, 80 and 443 in the firewall, puts the
# repo in /opt/foundation, and makes deploy/.env from the template (readable by root only). It starts
# nothing: you fill in deploy/.env, point DNS at this machine, and run the one command it prints.
# Safe to run again: it updates the checkout and leaves an existing deploy/.env alone.
set -euo pipefail

REPO="${FOUNDATION_REPO:-https://github.com/joshleong/Foundation.git}"
DIR="${FOUNDATION_DIR:-/opt/foundation}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this as root: sudo bash $0" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends ca-certificates git ufw docker.io docker-compose-v2
systemctl enable --now docker

# only what a hosted Foundation needs from outside: SSH, and the web (443/udp is HTTP/3)
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone "$REPO" "$DIR"
fi

ENV_FILE="$DIR/deploy/.env"
ENV_STEP="Check"
if [ ! -f "$ENV_FILE" ]; then
  cp "$DIR/deploy/foundation.env.example" "$ENV_FILE"
  ENV_STEP="Fill in"
fi
# it will hold the Google client's secret
chmod 600 "$ENV_FILE"

ADDRESS="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"

cat <<EOF

  Ready. Three things are left, and they are yours:

  1. DNS: an A record for the server's name pointing at this machine${ADDRESS:+ ($ADDRESS)}.
  2. $ENV_STEP $ENV_FILE
       FOUNDATION_DOMAIN, FOUNDATION_ALLOWLIST, FOUNDATION_ADMIN_EMAILS,
       GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET   (docs/hosting.md says how to make the Google client)
  3. Start it:
       cd $DIR && docker compose -f deploy/compose.yml up -d --build
       docker compose -f deploy/compose.yml logs -f foundation

  The first build takes a few minutes and wants about 4 GB of memory.
  To update later: cd $DIR && git pull && docker compose -f deploy/compose.yml up -d --build
EOF
