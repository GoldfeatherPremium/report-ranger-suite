#!/usr/bin/env bash
# Contabo VPS bootstrap for the Turnitin worker.
# Tested on Ubuntu 22.04 / 24.04. Run as root.

set -euo pipefail

if [[ "$EUID" -ne 0 ]]; then
  echo "Run as root: sudo bash install.sh"
  exit 1
fi

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKER_DIR="$REPO_DIR/worker"

echo "==> Updating apt"
apt-get update -y
apt-get upgrade -y

echo "==> Installing Node.js 20"
if ! command -v node >/dev/null || [[ "$(node -v)" != v20* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "==> Installing system deps for Playwright/Chromium"
apt-get install -y \
  ca-certificates curl git wget gnupg \
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64 || \
  apt-get install -y libasound2

echo "==> Installing worker npm deps"
cd "$WORKER_DIR"
npm install --omit=dev
npx playwright install --with-deps chromium

echo "==> Building worker"
npm run build

if [[ ! -f "$WORKER_DIR/.env" ]]; then
  cp "$WORKER_DIR/.env.example" "$WORKER_DIR/.env"
  echo ""
  echo "===================================================================="
  echo "  Edit $WORKER_DIR/.env and fill in SUPABASE_SERVICE_ROLE_KEY etc."
  echo "===================================================================="
fi

echo "==> Installing systemd unit"
cp "$REPO_DIR/turnitin-worker.service" /etc/systemd/system/turnitin-worker.service
sed -i "s|__WORKER_DIR__|$WORKER_DIR|g" /etc/systemd/system/turnitin-worker.service
systemctl daemon-reload
systemctl enable turnitin-worker

echo ""
echo "Done. Next:"
echo "  1. nano $WORKER_DIR/.env"
echo "  2. systemctl restart turnitin-worker"
echo "  3. journalctl -u turnitin-worker -f"
