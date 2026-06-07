#!/bin/bash
# Daily backup loop — запускает db-backup.sh раз в 24 часа.
DIR="$HOME/workspace/svs-beauty-space/backend"
LOG="/tmp/db-backup.log"
echo "[$(date)] === backup loop started, pid=$$ ===" >> "$LOG"
while true; do
  (cd "$DIR" && /usr/bin/node scripts/db-backup.js >> "$LOG" 2>&1) || echo "[$(date)] backup failed" >> "$LOG"
  sleep 86400
done
