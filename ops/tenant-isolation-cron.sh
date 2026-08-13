#!/usr/bin/env bash
# Щоденний сторож ізоляції орендарів. Мовчить, коли чисто; кричить у Telegram, коли ні.
# Порушення ізоляції в SaaS — найдорожча помилка (салон бачить чужі гроші й клієнтів),
# тому сигнал іде НЕ в лог, який ніхто не читає, а прямо Босу.
set -uo pipefail
cd /home/client/workspace/svs-beauty-space || exit 2

# Аудит 13.08: раніше було `node ... | grep -v dotenv` і CODE=$? брав код GREP'а, а не node.
# grep майже завжди повертає 0 → сторож НІКОЛИ не піднімав тривогу, тобто був сліпий.
# Тепер беремо код саме node (PIPESTATUS), фільтрація логу на це не впливає.
OUT=$(/usr/bin/node ops/tenant-isolation-check.js 2>&1); CODE=$?
OUT=$(echo "$OUT" | grep -v 'dotenv@')

echo "[$(date '+%F %T')] exit=$CODE"
echo "$OUT"

if [ "$CODE" -ne 0 ]; then
  # /notify движка Jarvis — те саме, чим користуються фонові задачі
  BODY=$(printf '🔴 <b>Ізоляція салонів: проблема</b>\n<pre>%s</pre>' "$(echo "$OUT" | tail -12)")
  curl -s -m 10 -X POST http://127.0.0.1:3005/notify \
    -H 'Content-Type: application/json' \
    --data "$(node -e 'process.stdout.write(JSON.stringify({text:process.argv[1]}))' "$BODY")" >/dev/null 2>&1
fi
exit "$CODE"
