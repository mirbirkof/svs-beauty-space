#!/bin/bash
# Локальный прод-инстанс CRM на нашем сервере (порт 3050) — независим от Render.
# Идемпотентный: если жив — ничего не делает. Для crontab (@reboot и */5).
PORT=3011
LOG=/tmp/crm-local-prod.log
APP_DIR=/home/client/workspace/svs-beauty-space/backend
cd "$APP_DIR" || exit 1

# Один запуск за раз: без блокировки крон */5 мог наплодить параллельные старты,
# пока предыдущий 25с ждал health → лишние инстансы с живыми внутренними кронами.
exec 9>/tmp/crm-local-prod.lock
flock -n 9 || exit 0

# force-restart: `local-prod.sh restart` — перезапуск навіть якщо живий (застосувати нові зміни коду)
if [ "$1" != "restart" ] && [ "$1" != "force" ]; then
  if curl -sf -m 5 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    # порт жив, но рядом могли остаться «немые» дубли — снимаем их
    for pid in $(pgrep -x -f "node shop-api.js"); do
      [ "$(readlink -f /proc/$pid/cwd 2>/dev/null)" = "$APP_DIR" ] || continue
      ss -ltnp 2>/dev/null | grep -q "pid=$pid," && continue
      kill "$pid" 2>/dev/null
      echo "[$(date '+%F %H:%M')] killed orphan $pid" >> "$LOG"
    done
    exit 0
  fi
fi
# подчистить ВСЕ инстансы приложения (а не только слушающего порт: зависший на старте
# процесс порт не держит, но продолжает крутить внутренние таймеры → дубли рассылок)
for pid in $(pgrep -x -f "node shop-api.js"); do
  [ "$(readlink -f /proc/$pid/cwd 2>/dev/null)" = "$APP_DIR" ] && kill "$pid" 2>/dev/null
done
sleep 3
for pid in $(pgrep -x -f "node shop-api.js"); do
  [ "$(readlink -f /proc/$pid/cwd 2>/dev/null)" = "$APP_DIR" ] && kill -9 "$pid" 2>/dev/null
done
sleep 1
PORT=$PORT setsid nohup node shop-api.js >> "$LOG" 2>&1 &
sleep 25
if curl -sf -m 5 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "[$(date '+%F %H:%M')] started ok" >> "$LOG"
else
  echo "[$(date '+%F %H:%M')] START FAILED" >> "$LOG"
  exit 1
fi
