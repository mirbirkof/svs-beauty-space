#!/bin/bash
# Сторож QA-loop: замена системного cron (нет прав на spool). Каждые 30с поднимает loop, если он упал.
# Проверка по comm==node, чтобы не спутать с bash/awk (их comm != node).
# Панель управления живёт на Render (svs-shop-api.onrender.com/admin/qa.html) — тут её держать не нужно.
# Запуск: setsid bash qa-daemon.sh >/dev/null 2>&1 </dev/null & disown
QA="$HOME/workspace/svs-beauty-space/qa-platform"
# Защита от дублей: flock + PID-файл (watchdog проверяет PID-файл, а не pgrep — pgrep ловит чужие процессы).
# ВАЖНО: дети (staging/loop/worker) НЕ должны наследовать fd лока — иначе после смерти
# сторожа лок держат внуки (chromium!) и новый сторож не поднимается. Урок 02.07.
# v2 в имени: старый /tmp/qa-daemon.flock отравлен — его держат уже запущенные внуки.
exec 201>/tmp/qa-daemon.v2.flock
flock -n 201 || exit 0
echo $$ > /tmp/qa-daemon.pid
while true; do
  # 1) тест-цикл (loop)
  c=$(ps -eo comm,args | awk '$1=="node" && /run\.js --loop/{n++} END{print n+0}')
  if [ "${c:-0}" -eq 0 ]; then
    cd "$QA" && bash keepalive.sh >>/tmp/qa-platform.log 2>&1 201>&-
    echo "[qa-daemon $(date '+%F %T')] loop поднят" >> /tmp/qa-daemon.log
  fi
  # 2) fix-worker (разбирает очередь «Исправить» / «Деплоить» из панели)
  w=$(ps -eo comm,args | awk '$1=="node" && /fix-worker\.js loop/{n++} END{print n+0}')
  if [ "${w:-0}" -eq 0 ]; then
    cd "$QA" && setsid bash -c 'exec node fix-worker.js loop' >>/tmp/qa-fix-worker.log 2>&1 </dev/null 201>&- &
    echo "[qa-daemon $(date '+%F %T')] fix-worker поднят" >> /tmp/qa-daemon.log
  fi
  # 3) постоянный staging на песочнице (порт 3025) — достижимый API для активных тестов (API/Security/UI)
  if ! curl -sf http://127.0.0.1:3025/health >/dev/null 2>&1; then
    cd "$QA" && setsid node staging.js start >>/tmp/qa-staging.log 2>&1 </dev/null 201>&- &
    echo "[qa-daemon $(date '+%F %T')] staging поднимается" >> /tmp/qa-daemon.log
  fi
  # 4) сборщик утечек: chromium старше 10 мин = зомби (циклы длятся 1-2 мин).
  # Утечка возможна если run.js/worker убит посреди проверки — finally не срабатывает.
  # Ищем по comm (имени бинарника), НЕ по cmdline — чтобы не зацепить чужие процессы.
  ps -eo pid,etimes,comm --no-headers | awk '$3 ~ /^chrom/ && $2 > 600 {print $1}' | while read zpid; do
    kill -9 "$zpid" 2>/dev/null && echo "[qa-daemon $(date '+%F %T')] убит зомби-chromium $zpid" >> /tmp/qa-daemon.log
  done
  # 5) ротация логов: qa-staging.log > 3000 строк → оставляем 500 последних
  if [ "$(wc -l < /tmp/qa-staging.log 2>/dev/null)" -gt 3000 ]; then
    tail -500 /tmp/qa-staging.log > /tmp/qa-staging.log.tmp && mv /tmp/qa-staging.log.tmp /tmp/qa-staging.log
  fi
  sleep 30
done
