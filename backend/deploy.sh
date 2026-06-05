#!/bin/bash
# ═══════════════════════════════════════════════════════
# SVS Backend deploy на DO дроплет
# Запустить ОДИН РАЗ после того как:
#   1. Заполнен ~/workspace/svs-beauty-space/backend/.env
#   2. DNS api.svsbeauty.com → 159.223.233.150 прописан
# ═══════════════════════════════════════════════════════
set -e
cd "$(dirname "$0")"

DOMAIN="${BOOKING_DOMAIN:-api.svsbeauty.com}"

echo "[1/5] npm install"
npm install --omit=dev

echo "[2/5] Init DB schema"
node -e "require('./db'); require('./routes/booking'); console.log('Schema ready');"

echo "[3/5] PM2 (install if missing)"
which pm2 >/dev/null || sudo npm i -g pm2

echo "[4/5] Start/reload backend"
pm2 describe svs-backend >/dev/null 2>&1 && pm2 reload svs-backend || pm2 start server.js --name svs-backend
pm2 save

echo "[5/5] Caddy reverse proxy (auto-HTTPS)"
if ! which caddy >/dev/null; then
  echo "Installing Caddy..."
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
  sudo apt-get update && sudo apt-get install -y caddy
fi

sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$DOMAIN {
  reverse_proxy 127.0.0.1:3001
  encode gzip
  header {
    -Server
    X-Content-Type-Options nosniff
    X-Frame-Options DENY
    Referrer-Policy strict-origin-when-cross-origin
  }
}
EOF

sudo systemctl reload caddy || sudo systemctl restart caddy

echo ""
echo "✓ Backend живой на https://$DOMAIN"
echo ""
echo "Установи Telegram webhook:"
echo "  curl -s \"https://api.telegram.org/bot\$TELEGRAM_BOT_TOKEN/setWebhook?url=https://$DOMAIN/api/booking/telegram\""
echo ""
echo "Проверь health:"
echo "  curl https://$DOMAIN/api/health"
