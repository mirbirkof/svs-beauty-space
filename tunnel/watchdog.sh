#!/bin/bash
# Tunnel watchdog: проверяет здоровье shop-tunnel каждые 60с,
# поднимает заново при падении, обновляет current-url.txt.

TUNNEL_DIR="$HOME/workspace/svs-beauty-space/tunnel"
URL_FILE="$TUNNEL_DIR/current-url.txt"
LOG="$TUNNEL_DIR/watchdog.log"
TUNNEL_LOG="$TUNNEL_DIR/shop-tunnel.log"
SHOP_PORT=3011

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

start_tunnel() {
  log "Starting tunnel..."
  pkill -f "ssh.*-R 80:localhost:$SHOP_PORT" 2>/dev/null
  sleep 2
  : > "$TUNNEL_LOG"
  (nohup ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=60 \
    -o ExitOnForwardFailure=yes \
    -R 80:localhost:$SHOP_PORT nokey@localhost.run \
    > "$TUNNEL_LOG" 2>&1 & disown)
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 2
    URL=$(strings "$TUNNEL_LOG" 2>/dev/null | grep -oE "https://[a-z0-9]+\.lhr\.life" | head -1)
    if [ -n "$URL" ]; then
      echo "$URL" > "$URL_FILE"
      log "Tunnel up: $URL"
      # Авто-апдейт URL у loader-і вітрини
      LOADER="$HOME/workspace/svs-beauty-space/js/shop-data-live.js"
      if [ -f "$LOADER" ]; then
        sed -i "s#https://[a-z0-9]\+\.lhr\.life#$URL#g" "$LOADER"
        log "Loader URL updated to $URL"
        # Auto-commit + push
        (cd "$HOME/workspace/svs-beauty-space" && \
          git add tunnel/current-url.txt js/shop-data-live.js 2>/dev/null && \
          git commit -m "[watchdog] tunnel rotation: $URL" --quiet 2>/dev/null && \
          timeout 20 git push origin main 2>&1 | tail -1) >> "$LOG"
      fi
      return 0
    fi
  done
  log "Failed to start tunnel after 20s"
  return 1
}

check_health() {
  URL=$(cat "$URL_FILE" 2>/dev/null)
  [ -z "$URL" ] && return 1
  CODE=$(curl -s -m 8 -o /dev/null -w "%{http_code}" "$URL/api/shop/readiness")
  [ "$CODE" = "200" ] && return 0
  return 1
}

# main loop
log "=== Watchdog started, pid=$$ ==="
while true; do
  if ! check_health; then
    log "Health check FAILED, restarting tunnel"
    start_tunnel || log "Restart failed, will retry in 60s"
  fi
  sleep 60
done
