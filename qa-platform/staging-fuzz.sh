#!/bin/bash
# qa-platform/staging-fuzz.sh — отдельный тестовый инстанс CRM для ui-fuzz.mjs/ui-explore.mjs
# (15.08, по задаче Босса «фаззер должен реально входить в админку»).
#
# ОТДЕЛЬНЫЙ от staging.js (порт 3025, которым владеет qa-daemon.sh — НЕ трогаем его,
# он респаунится сторожем каждые 30с и делит PID-файл с QA-loop/fix-worker).
# Этот инстанс — порт 3037, своя PID-файл, та же изолированная песочная Neon-ветка
# (QA_DB_URL) что и у 3025 — запись сюда НЕ касается прода.
#
# Использование:
#   bash qa-platform/staging-fuzz.sh start   — поднять (если не поднят)
#   bash qa-platform/staging-fuzz.sh stop    — остановить
#   bash qa-platform/staging-fuzz.sh status  — health-check
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=3037
PIDFILE="$DIR/data/staging-3037.pid"
LOG=/tmp/qa-staging-3037.log
BASE="http://127.0.0.1:$PORT"

start() {
  if curl -sf -m 3 "$BASE/health" >/dev/null 2>&1; then
    echo "[staging-fuzz] уже поднят на $BASE"; return 0
  fi
  cd "$DIR" && node -e "
    const cfg = require('./config');
    const { spawn } = require('child_process');
    const fs = require('fs');
    const path = require('path');
    if (!cfg.qaDbUrl) { console.error('нет QA_DB_URL — песочница не настроена'); process.exit(1); }
    const BACKEND = path.join(__dirname, '../backend/shop-api.js');
    const env = { ...process.env,
      DATABASE_URL: cfg.qaDbUrl, DATABASE_URL_APP: cfg.qaDbUrl,
      PORT: '$PORT', SHOP_API_PORT: '$PORT',
      ADMIN_TG_CHAT: '', BOT_TOKEN: '', WIFE_BOT_TOKEN: '',
      NODE_ENV: 'staging', QA_STAGING: '1', ADMIN_TOKEN_BOOTSTRAP_ONLY: '0',
    };
    const out = fs.openSync('$LOG', 'a');
    const child = spawn('node', [BACKEND], { env, detached: true, stdio: ['ignore', out, out] });
    child.unref();
    fs.writeFileSync('$PIDFILE', String(child.pid));
    console.log('[staging-fuzz] spawned pid', child.pid);
  "
  for i in $(seq 1 60); do
    curl -sf -m 2 "$BASE/health" >/dev/null 2>&1 && { echo "[staging-fuzz] UP на $BASE"; return 0; }
    sleep 1.5
  done
  echo "[staging-fuzz] не поднялся за 90с — смотри $LOG" >&2
  return 1
}

stop() {
  if [ -f "$PIDFILE" ]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null && echo "[staging-fuzz] остановлен" || echo "[staging-fuzz] процесс уже мёртв"
    rm -f "$PIDFILE"
  else
    echo "[staging-fuzz] нечего останавливать"
  fi
}

status() {
  curl -sf -m 3 "$BASE/health" >/dev/null 2>&1 && echo "[staging-fuzz] UP $BASE" || echo "[staging-fuzz] DOWN"
}

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  *) echo "usage: $0 {start|stop|status}"; exit 1 ;;
esac
