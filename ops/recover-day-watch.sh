#!/usr/bin/env bash
# Сторож застрявшего дня 08.07: как только old-forest (квота Neon) оживёт —
# перенести кассу/визиты/услуги дня в ЖИВУЮ базу (Supabase). Идемпотентно.
# Ставится в cron каждые 30 мин; при PRIMARY_DOWN выходит за секунды.
cd /home/client/workspace/svs-beauty-space || exit 1
ENV=backend/.env.bak-neon-20260710
OLD_APP=$(grep "^DATABASE_URL_APP=" "$ENV" | cut -d= -f2-)
SB=$(grep "^DATABASE_URL=" backend/.env | cut -d= -f2-)
[ -z "$OLD_APP" ] || [ -z "$SB" ] && exit 1
OUT=$(DATABASE_URL_APP="$OLD_APP" DATABASE_URL="$SB" NEON_BACKUP_URL="" node ops/recover-day.js 2026-07-08 2>&1)
echo "$(date -u +%FT%T) $OUT" >> /tmp/recover-day-watch.log
if ! echo "$OUT" | grep -q PRIMARY_DOWN; then
  # день доехал — сообщить и снять себя с крона
  curl -s "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" -d chat_id="${TG_BOSS_CHAT}" --data-urlencode text="✅ День 08.07 восстановлен в кассе: old-forest ожил, recover-day отработал. $OUT" >/dev/null 2>&1
  crontab -l 2>/dev/null | grep -v recover-day-watch | crontab -
fi
