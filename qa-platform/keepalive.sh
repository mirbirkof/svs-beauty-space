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

# ── 2. Neon failover daemon — ОТКЛЮЧЁН 13.07.2026 (Босс: Neon не используем, лимиты жёг) ──
# База переехала на Supabase; failover-на-Neon устарел, sync был сломан (pr.cols.join),
# health-пинги каждые 2 мин не давали Neon заснуть → расход compute 24/7.
# Резервные копии теперь: ночной pg_dump (cron), см. ops/db-backup.sh.
