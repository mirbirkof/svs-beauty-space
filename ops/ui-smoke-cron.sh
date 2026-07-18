#!/bin/bash
# Робо-сторож CRM (Босс, 18.07.2026): чередование двух режимов, алерт только при провале.
# :07 — CORE: критичные инварианты (цены, суммы, услуги в записи, разделы) — всегда одни и те же.
# :37 — EXPLORE: coverage-guided разведка (Босс: «преобладают новые комбинации, старые реже») —
#        каждый раз 8 давно-не-проверенных/новых комбинаций из матрицы 47 страниц+действий.
cd /home/client/workspace/svs-beauty-space/backend
set -a; source .env 2>/dev/null; set +a
MIN=$(date +%M)
if [ "$MIN" -lt 20 ]; then MODE=core; SCRIPT=ops/ui-smoke.mjs; else MODE=explore; SCRIPT=ops/ui-explore.mjs; fi
OUT=$(PLAYWRIGHT_BROWSERS_PATH=/home/client/workspace/.ms-playwright ADMIN_TOKEN="$ADMIN_TOKEN" \
      /usr/bin/node /home/client/workspace/svs-beauty-space/$SCRIPT 2>&1)
CODE=$?
echo "[$(date '+%F %H:%M')] mode=$MODE code=$CODE" >> /tmp/ui-smoke-cron.log
if [ "$CODE" != "0" ]; then
  FAILS=$(echo "$OUT" | grep -E "FAIL|ПРОБЛЕМЫ|\[-\]" | head -5 | tr '\n' ' ')
  curl -s -m 10 -X POST http://127.0.0.1:3005/notify \
    -H "Content-Type: application/json" -H "x-notify-token: jarvis-restart-2026" \
    -d "{\"text\":\"⚠️ CRM робо-сторож ($MODE): найдена проблема. $FAILS\"}" >/dev/null 2>&1 \
    || echo "$OUT" | tail -20 >> /tmp/ui-smoke-cron-fails.log
fi
