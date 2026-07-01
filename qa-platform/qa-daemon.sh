#!/bin/bash
# Сторож QA-loop: замена системного cron (нет прав на spool). Каждые 30с поднимает loop, если он упал.
# Проверка по comm==node, чтобы не спутать с bash/awk (их comm != node).
# Панель управления живёт на Render (svs-shop-api.onrender.com/admin/qa.html) — тут её держать не нужно.
# Запуск: setsid bash qa-daemon.sh >/dev/null 2>&1 </dev/null & disown
QA="$HOME/workspace/svs-beauty-space/qa-platform"
while true; do
  # 1) тест-цикл (loop)
  c=$(ps -eo comm,args | awk '$1=="node" && /run\.js --loop/{n++} END{print n+0}')
  if [ "${c:-0}" -eq 0 ]; then
    cd "$QA" && bash keepalive.sh >>/tmp/qa-platform.log 2>&1
    echo "[qa-daemon $(date '+%F %T')] loop поднят" >> /tmp/qa-daemon.log
  fi
  # 2) fix-worker (разбирает очередь «Исправить» / «Деплоить» из панели)
  w=$(ps -eo comm,args | awk '$1=="node" && /fix-worker\.js loop/{n++} END{print n+0}')
  if [ "${w:-0}" -eq 0 ]; then
    cd "$QA" && setsid bash -c 'exec node fix-worker.js loop' >>/tmp/qa-fix-worker.log 2>&1 </dev/null &
    echo "[qa-daemon $(date '+%F %T')] fix-worker поднят" >> /tmp/qa-daemon.log
  fi
  # 3) постоянный staging на песочнице (порт 3025) — достижимый API для активных тестов (API/Security/UI)
  if ! curl -sf http://127.0.0.1:3025/health >/dev/null 2>&1; then
    cd "$QA" && setsid node staging.js start >>/tmp/qa-staging.log 2>&1 </dev/null &
    echo "[qa-daemon $(date '+%F %T')] staging поднимается" >> /tmp/qa-daemon.log
  fi
  sleep 30
done
