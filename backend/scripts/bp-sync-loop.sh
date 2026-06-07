#!/bin/bash
# BeautyPro sync loop: каждые 15 минут запускает синхронизацию клиентов.
DIR="$HOME/workspace/svs-beauty-space/backend"
LOG="/tmp/bp-sync.log"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }
log "=== bp-sync-loop started, pid=$$ ==="
while true; do
  log "--- running batch sync ---"
  (cd "$DIR" && /usr/bin/node scripts/bp-sync-clients.js >> "$LOG" 2>&1)
  log "--- batch done, sleeping 15min ---"
  sleep 900
done
