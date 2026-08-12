#!/bin/bash
# Локальный прод-инстанс CRM на нашем сервере (порт 3050) — независим от Render.
# Идемпотентный: если жив — ничего не делает. Для crontab (@reboot и */5).
PORT=3011
LOG=/tmp/crm-local-prod.log
APP_DIR=/home/client/workspace/svs-beauty-space/backend
cd "$APP_DIR" || exit 1

# Один запуск за раз: без блокировки крон */5 мог наплодить параллельные старты,
# пока предыдущий 25с ждал health → лишние инстансы с живыми внутренними кронами.
# Крон — неблокирующий (занято = просто пропустить тик), ручной restart — ЖДЁТ до 90с,
# иначе `local-prod.sh restart` молча выходил бы, не применив новый код.
LOCK=/tmp/crm-local-prod.lock
exec 9>"$LOCK"
# Замок держит ТОЛЬКО другой запуск этого скрипта. Если его унаследовал сам сервер
# (старт до фикса 9>&-), это не конкурент — иначе рестарт навсегда заблокирован собой же.
lock_held_by_server() {
  for p in $(fuser "$LOCK" 2>/dev/null); do
    [ "$(ps -o comm= -p "$p" 2>/dev/null)" = "node" ] && return 0
  done
  return 1
}
if [ "$1" = "restart" ] || [ "$1" = "force" ]; then
  flock -w 90 9 || lock_held_by_server || { echo "[$(date '+%F %H:%M')] restart: lock busy 90s, abort" >> "$LOG"; exit 1; }
else
  flock -n 9 || lock_held_by_server || exit 0
fi

# force-restart: `local-prod.sh restart` — перезапуск навіть якщо живий (застосувати нові зміни коду)
if [ "$1" != "restart" ] && [ "$1" != "force" ]; then
  if curl -sf -m 5 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    # порт жив, но рядом могли остаться «немые» дубли — снимаем их
    for pid in $(pgrep -f "node .*shop-api\.js"); do
      [ "$(readlink -f /proc/$pid/cwd 2>/dev/null)" = "$APP_DIR" ] || continue
      ss -ltnp 2>/dev/null | grep -q "pid=$pid," && continue
      kill "$pid" 2>/dev/null
      echo "[$(date '+%F %H:%M')] killed orphan $pid" >> "$LOG"
    done
    exit 0
  fi
fi
# ВАЖНО (11.08): было pgrep -x -f "node shop-api.js" — точное совпадение строки запуска.
# Прод, поднятый с ПОЛНЫМ путём (node /path/shop-api.js), под шаблон не попадал → restart
# «успешно» выходил, НЕ применив новый код. Теперь ищем по шаблону пути.
# подчистить ВСЕ инстансы приложения (а не только слушающего порт: зависший на старте
# процесс порт не держит, но продолжает крутить внутренние таймеры → дубли рассылок)
for pid in $(pgrep -f "node .*shop-api\.js"); do
  [ "$(readlink -f /proc/$pid/cwd 2>/dev/null)" = "$APP_DIR" ] && kill "$pid" 2>/dev/null
done
sleep 3
for pid in $(pgrep -f "node .*shop-api\.js"); do
  [ "$(readlink -f /proc/$pid/cwd 2>/dev/null)" = "$APP_DIR" ] && kill -9 "$pid" 2>/dev/null
done
sleep 1
# 9>&- ОБЯЗАТЕЛЬНО: без закрытия дескриптора сервер наследует flock и держит его вечно →
# ни крон, ни ручной restart больше не могут взять замок, сторож фактически мёртв
# (поймано 26.07 сразу после введения flock).
# CRM_REUSEPORT=1 ОБЯЗАТЕЛЕН (29.07): деплой без простоя ставит новый инстанс рядом на
# тот же порт, а ядро разрешает это ТОЛЬКО если флаг выставили ВСЕ сокеты на порту.
# Прод, поднятый без флага, блокирует выкатку рядом (EADDRINUSE) — проверено фактом.
PORT=$PORT CRM_REUSEPORT=1 setsid nohup node shop-api.js >> "$LOG" 2>&1 9>&- &
sleep 25
if curl -sf -m 5 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "[$(date '+%F %H:%M')] started ok" >> "$LOG"
else
  echo "[$(date '+%F %H:%M')] START FAILED" >> "$LOG"
  exit 1
fi
