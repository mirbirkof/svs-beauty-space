#!/bin/bash
# Самоподъём QA-loop: если процесс не запущен — стартует. Ставится в cron (каждые 5 мин).
# Переживает рестарт машины (cron поднимет), не плодит дублей (проверка pgrep).
QA_DIR="$HOME/workspace/svs-beauty-space/qa-platform"
LOG="/tmp/qa-platform.log"
if pgrep -f "run.js --loop" >/dev/null 2>&1; then
  exit 0   # уже работает
fi
cd "$QA_DIR" || exit 1
QA_COOLDOWN_MS=600000 nohup node run.js --loop >> "$LOG" 2>&1 &
echo "[keepalive $(date '+%F %T')] QA-loop поднят (PID $!)" >> "$LOG"
