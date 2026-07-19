#!/bin/bash
# Локальный прод-инстанс CRM на нашем сервере (порт 3050) — независим от Render.
# Идемпотентный: если жив — ничего не делает. Для crontab (@reboot и */5).
PORT=3011
LOG=/tmp/crm-local-prod.log
cd /home/client/workspace/svs-beauty-space/backend || exit 1
# force-restart: `local-prod.sh restart` — перезапуск навіть якщо живий (застосувати нові зміни коду)
if [ "$1" != "restart" ] && [ "$1" != "force" ]; then
  if curl -sf -m 5 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then exit 0; fi
fi
# подчистить зомби на порту
PIDS=$(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u)
for pid in $PIDS; do kill "$pid" 2>/dev/null; done
sleep 1
PORT=$PORT setsid nohup node shop-api.js >> "$LOG" 2>&1 &
sleep 25
if curl -sf -m 5 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "[$(date '+%F %H:%M')] started ok" >> "$LOG"
else
  echo "[$(date '+%F %H:%M')] START FAILED" >> "$LOG"
  exit 1
fi
