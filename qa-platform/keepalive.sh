#!/bin/bash
# Самоподъём фоновых служб песочницы. Дёргается heartbeat'ом Jarvis каждые 5 мин.
# Переживает рестарт машины, не плодит дублей (pgrep-гарды). Без early-exit:
# каждая секция независима — падение одной службы не мешает подъёму другой.

# ── 1. QA-loop (автономная QA-платформа 24/7) ──
QA_DIR="$HOME/workspace/svs-beauty-space/qa-platform"
QA_LOG="/tmp/qa-platform.log"
# Точный шаблон именно node-процесса, чтобы не спутать с watcher'ом/эхом bash.
if ! pgrep -f "node run.js --loop" >/dev/null 2>&1; then
  cd "$QA_DIR" && QA_COOLDOWN_MS=600000 nohup node run.js --loop >> "$QA_LOG" 2>&1 &
  echo "[keepalive $(date '+%F %T')] QA-loop поднят (PID $!)" >> "$QA_LOG"
fi

# ── 2. Neon failover daemon: сторож базы (health 2 мин, снапшот в резерв 30 мин) ──
# Ключ NEON_BACKUP_URL приходит из окружения Jarvis-движка (в файлах его НЕТ — не терять!).
# Без ключа секция молча пропускается (лучше нет сторожа, чем сторож без резерва).
OPS_REPO="$HOME/workspace/svs-beauty-space"
NF_LOG="/tmp/neon-failover.log"
if [ -n "$NEON_BACKUP_URL" ] && ! pgrep -f "neon-failover.js --daemon" >/dev/null 2>&1; then
  cd "$OPS_REPO" && NODE_PATH="$OPS_REPO/backend/node_modules" DOTENV_CONFIG_PATH="$OPS_REPO/backend/.env" \
    nohup node -r dotenv/config ops/neon-failover.js --daemon >> "$NF_LOG" 2>&1 &
  echo "[keepalive $(date '+%F %T')] neon-failover поднят (PID $!)" >> "$NF_LOG"
fi
