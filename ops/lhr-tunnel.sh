#!/bin/bash
# Запасной туннель CRM наружу через localhost.run (:3011).
# Нужен когда serveo лежит (11.08.2026 serveo.net недоступен: порты 22/443 закрыты).
# Идемпотентный, для crontab */3. Пишет живой адрес в /tmp/lhr-crm-url.txt
set -u
exec 9>/tmp/lhr-crm.lock
flock -n 9 || exit 0
LOG=/tmp/lhr-crm.log
STATE=/tmp/lhr-crm-url.txt
notify(){ curl -s -m 10 -X POST http://127.0.0.1:3005/notify -H "x-restart-token: x" -H "x-notify-token: jarvis-restart-2026" --data "$1" >/dev/null 2>&1; }

alive(){ curl -s -m 12 -H "Host: ${1#https://}" "$1/health" 2>/dev/null | grep -q "svs-shop-api"; }

CUR=$(cat "$STATE" 2>/dev/null || true)
if [ -n "$CUR" ] && alive "$CUR"; then exit 0; fi

# старый ssh на localhost.run снять (только свой, по точному шаблону)
pgrep -f "nokey@localhost.run" >/dev/null && pkill -f "nokey@localhost.run"
sleep 2
: > "$LOG"
setsid nohup ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes \
  -R 80:localhost:3011 nokey@localhost.run >> "$LOG" 2>&1 &
sleep 18
NEW=$(grep -oE "https://[a-z0-9-]+\.lhr\.life" "$LOG" | tail -1)
if [ -n "$NEW" ] && alive "$NEW"; then
  if [ "$NEW" != "$CUR" ]; then
    echo "$NEW" > "$STATE"
    # Боссу про ротации запасного НЕ пишем (11.08): единственный источник уведомлений
    # об адресе — public-url-watch.sh, и тот шлёт одно сообщение только при падении/возврате постоянного.
  fi
  exit 0
fi
exit 1
