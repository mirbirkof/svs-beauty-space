#!/bin/bash
# Туннель CRM наружу через serveo (:3011). Идемпотентный — для crontab (@reboot и */3).
# Если ключ зарегистрирован Боссом (console.serveo.net) — получает ПОСТОЯННЫЙ zvetlacrm.serveo.net.
set -u
exec 9>/tmp/serveo-tunnel.lock
flock -n 9 || exit 0
KEY=/home/client/.ssh/serveo_key
LOG=/tmp/serveo-ssh.log
STATE=/tmp/serveo-current-url.txt
notify(){ curl -s -m 10 -X POST http://127.0.0.1:3005/notify -H "x-restart-token: x" -H "x-notify-token: jarvis-restart-2026" --data "$1" >/dev/null 2>&1; }
# Адрес берём ТОЛЬКО из строки "Forwarding HTTP traffic from ..." — иначе regex цеплял
# рекламную ссылку serveo (console.serveo.net) из подсказки в логе и сторож проверял чужой сайт.
url_from_log(){ grep -a "Forwarding HTTP traffic from" "$LOG" 2>/dev/null | grep -oE "https://[a-z0-9-]+\.serveo(usercontent)?\.(com|net)" | tail -1; }
# Живой туннель = на том конце НАША CRM. Кода 200 недостаточно: чужой сайт тоже отдаёт 200.
tunnel_alive(){ curl -s -m 12 "$1/health" 2>/dev/null | grep -q "svs-shop-api"; }

CUR=$(cat "$STATE" 2>/dev/null || true)
case "$CUR" in *console.serveo.net*|"") CUR="" ;; esac
# постоянный домен приоритетнее запасного: пока он жив — все ссылки в системе ведут на него
write_live(){ mkdir -p /home/client/workspace/svs-beauty-space/tunnel; echo "$1" > /home/client/workspace/svs-beauty-space/tunnel/current-url.txt; }
if [ -n "$CUR" ] && tunnel_alive "$CUR"; then exit 0; fi

pkill -f "serveo_key -R zvetlacrm" 2>/dev/null
sleep 2
setsid nohup ssh -i "$KEY" -R zvetlacrm:80:localhost:3011 \
  -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes \
  serveo.net > "$LOG" 2>&1 &
sleep 12
NEW=$(url_from_log)
if [ -n "$NEW" ] && tunnel_alive "$NEW"; then
  if [ "$NEW" != "$CUR" ]; then
    echo "$NEW" > "$STATE"
    # Молча: уведомления об адресе шлёт ТОЛЬКО public-url-watch.sh (антиспам, приказ Босса 11.08).
    :
  fi
fi
