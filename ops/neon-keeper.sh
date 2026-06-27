#!/usr/bin/env bash
# Lightweight keeper for the neon-failover daemon.
# Bridges the window until the main watchdog (watchdog-jarvis.sh) is reloaded
# with its neon block. Sleep-based loop survives the tool sandbox. The daemon's
# own pidfile guard prevents duplicates if the watchdog also relaunches it.
KPID="/tmp/neon-keeper.pid"
# single-instance: exit if another live keeper holds the pidfile
if [ -f "$KPID" ]; then
  old="$(cat "$KPID" 2>/dev/null)"
  if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then exit 0; fi
fi
echo $$ > "$KPID"
trap 'rm -f "$KPID"; exit 0' SIGTERM SIGINT EXIT

REPO="/home/client/workspace/svs-beauty-space"
while true; do
  if ! pgrep -f "neon-failover.js --daemon" >/dev/null 2>&1; then
    cd "$REPO" && setsid bash -c 'exec node ops/neon-failover.js --daemon >> /tmp/neon-failover.log 2>&1' < /dev/null &
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] keeper: (re)launched neon-failover daemon" >> /tmp/neon-keeper.log
  fi
  sleep 60
done
