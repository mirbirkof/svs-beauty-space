#!/bin/bash
# Сторож QA-loop: замена системного cron (нет прав на spool). Каждые 30с поднимает loop, если он упал.
# Проверка по comm==node, чтобы не спутать с bash/awk (их comm != node).
# Панель управления живёт на Render (svs-shop-api.onrender.com/admin/qa.html) — тут её держать не нужно.
# Запуск: setsid bash qa-daemon.sh >/dev/null 2>&1 </dev/null & disown
QA="$HOME/workspace/svs-beauty-space/qa-platform"
while true; do
  c=$(ps -eo comm,args | awk '$1=="node" && /run\.js --loop/{n++} END{print n+0}')
  if [ "${c:-0}" -eq 0 ]; then
    cd "$QA" && bash keepalive.sh >>/tmp/qa-platform.log 2>&1
    echo "[qa-daemon $(date '+%F %T')] loop поднят" >> /tmp/qa-daemon.log
  fi
  sleep 30
done
