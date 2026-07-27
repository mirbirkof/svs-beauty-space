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
      SMOKE_BASE="http://127.0.0.1:3011" \
      /usr/bin/node /home/client/workspace/svs-beauty-space/$SCRIPT 2>&1)
CODE=$?
echo "[$(date '+%F %H:%M')] mode=$MODE code=$CODE" >> /tmp/ui-smoke-cron.log
notify(){ curl -s -m 10 -X POST http://127.0.0.1:3005/notify \
    -H "Content-Type: application/json" -H "x-notify-token: jarvis-restart-2026" \
    -d "{\"text\":\"$1\"}" >/dev/null 2>&1 || echo "$OUT" | tail -20 >> /tmp/ui-smoke-cron-fails.log; }
if [ "$CODE" != "0" ]; then
  FAILS=$(echo "$OUT" | grep -E "FAIL|ПРОБЛЕМЫ|\[-\]" | head -5 | tr '\n' ' ')
  # Критичні вузли — те, від яких напряму залежать гроші/запис: каса, оплата, журнал, послуги.
  CRIT=$(echo "$OUT" | grep -oE "cash-today|cashbox|pay[a-z_-]*|schedule|appointment[s]?|unsettled|journal|master-links" | sort -u | tr '\n' ' ')
  # Живий прод? health <> критичний фейл: якщо health лежить — прод завис/впав.
  PROD_DOWN=0; curl -sf -m 5 http://127.0.0.1:3011/health >/dev/null 2>&1 || PROD_DOWN=1
  if [ "$PROD_DOWN" = "1" ]; then
    # ПРОД ЛЕЖИТЬ → самолікування: штатний рестарт і повторна перевірка.
    bash /home/client/workspace/svs-beauty-space/ops/local-prod.sh restart >/dev/null 2>&1
    if curl -sf -m 5 http://127.0.0.1:3011/health >/dev/null 2>&1; then
      notify "✅ CRM ПРОД падав ($FAILS) — я перезапустив, зараз здоровий. Перевір чи все на місці."
    else
      notify "🚨 CRM ПРОД ЛЕЖИТЬ ($FAILS). Рестарт НЕ допоміг — Jarvis, розберись негайно, клієнти не бачать систему!"
    fi
  elif [ -n "$CRIT" ]; then
    # Прод живий, але критичний вузол віддає помилку → це баг коду, рестарт не лікує → гучний сигнал.
    notify "🚨 CRM: критичний вузол віддає помилку ($CRIT| $FAILS). Прод живий, але каса/оплата/журнал зламані — Jarvis, терміновий розбір коду."
  else
    # Некритичне (другорядна сторінка) → звичайний тихий алерт.
    notify "⚠️ CRM робо-сторож ($MODE): другорядна проблема. $FAILS"
  fi
fi
