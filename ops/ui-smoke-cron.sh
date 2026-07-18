#!/bin/bash
# Робо-сторож ключевых действий админки (Босс, 18.07.2026). Крон каждые 30 мин.
# Гоняет Playwright-смоук; при ПРОВАЛЕ шлёт алерт Боссу в Telegram через движок Jarvis.
# Молчит когда всё зелёное — не спамит.
cd /home/client/workspace/svs-beauty-space/backend
set -a; source .env 2>/dev/null; set +a
OUT=$(PLAYWRIGHT_BROWSERS_PATH=/home/client/workspace/.ms-playwright ADMIN_TOKEN="$ADMIN_TOKEN" \
      /usr/bin/node /home/client/workspace/svs-beauty-space/ops/ui-smoke.mjs 2>&1)
CODE=$?
echo "[$(date '+%F %H:%M')] code=$CODE" >> /tmp/ui-smoke-cron.log
if [ "$CODE" != "0" ]; then
  FAILS=$(echo "$OUT" | grep -E "FAIL|ПРОВАЛ" | head -5 | tr '\n' ' ')
  # алерт Боссу через notify-эндпоинт движка Jarvis (тот же канал, что bg-run --notify)
  curl -s -m 10 -X POST http://127.0.0.1:3005/notify \
    -H "Content-Type: application/json" -H "x-notify-token: jarvis-restart-2026" \
    -d "{\"text\":\"⚠️ CRM UI-сторож: ключевое действие СЛОМАНО. $FAILS\"}" >/dev/null 2>&1 \
    || echo "$OUT" | tail -20 >> /tmp/ui-smoke-cron-fails.log
fi
