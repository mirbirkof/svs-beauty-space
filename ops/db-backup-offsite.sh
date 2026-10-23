#!/bin/bash
# db-backup-offsite.sh — КОПИЯ БАЗЫ CRM ВНЕ СЕРВЕРА (23.10.2026, аудит п.3).
# Берёт суточный дамп ~/workspace/.db-backups/YYYY-MM-DD (его делает ops/db-backup.js в 03:30),
# шифрует (gpg AES-256, ключ ~/.config/crm-backup/passphrase — ТОЛЬКО на сервере, в git/GitHub его нет)
# и кладёт файлом релиза в ПРИВАТНЫЙ отдельный репозиторий mirbirkof/crm-db-backup.
# Почему релизом, а не коммитом: 8.5 МБ/день в истории git = раздутый репозиторий (как основной, 3.78 ГБ).
# Внешние копии НЕ удаляются этим скриптом. Повторный запуск за тот же день — пропуск.
# Восстановление: скачать db-YYYY-MM-DD.tar.gpg →
#   gpg --batch --passphrase-file ~/.config/crm-backup/passphrase -d db-….tar.gpg | tar x
set -u
REPO=mirbirkof/crm-db-backup
SRC_ROOT=/home/client/workspace/.db-backups
KEY=/home/client/.config/crm-backup/passphrase
LOG=/home/client/workspace/logs/crm-db-offsite.log
DAY="${1:-$(date -u +%F)}"
mkdir -p "$(dirname "$LOG")"
say() { echo "[$(date '+%F %H:%M:%S')] $*" >> "$LOG"; echo "$*"; }
fail() {
  say "FAIL $DAY: $*"
  curl -s -m 10 -X POST http://127.0.0.1:3005/notify -H "x-notify-token: jarvis-restart-2026" \
    -H "Content-Type: text/plain" --data-binary "🔴 <b>Копия базы CRM вне сервера не ушла</b> ($DAY): $*. Локальные копии целы." >/dev/null 2>&1
  exit 1
}
TOKEN=$(grep -o 'https://[^:]*:[^@]*@github.com' /home/client/.git-credentials 2>/dev/null | head -1 | sed 's#https://[^:]*:\([^@]*\)@.*#\1#')
[ -n "$TOKEN" ] || fail "нет токена GitHub"
[ -s "$KEY" ] || fail "нет ключа шифрования"
[ -d "$SRC_ROOT/$DAY" ] || fail "нет локального дампа за $DAY"
API=https://api.github.com/repos/$REPO
H=(-H "Authorization: token $TOKEN" -H "Accept: application/vnd.github+json")
TAG="db-$DAY"
code=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "${H[@]}" "$API/releases/tags/$TAG")
[ "$code" = "200" ] && { say "skip $DAY: уже есть"; exit 0; }

TMP=$(mktemp -d /tmp/crm-offsite.XXXX); trap 'rm -rf "$TMP"' EXIT
OUT="$TMP/$TAG.tar.gpg"
tar -C "$SRC_ROOT" -cf - "$DAY" | gpg --batch --yes --quiet --symmetric --cipher-algo AES256 \
  --passphrase-file "$KEY" -o "$OUT" || fail "шифрование не удалось"
SZ=$(stat -c %s "$OUT"); SHA=$(sha256sum "$OUT" | awk '{print $1}')
[ "$SZ" -gt 1048576 ] || fail "архив подозрительно мал ($SZ байт)"

rel=$(curl -s -m 30 "${H[@]}" -X POST "$API/releases" \
  -d "{\"tag_name\":\"$TAG\",\"name\":\"CRM DB $DAY\",\"body\":\"gpg AES256, sha256 $SHA, $SZ bytes\"}")
RID=$(printf '%s' "$rel" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
[ -n "$RID" ] || fail "релиз не создан: $(printf '%s' "$rel" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("message","?"))' 2>/dev/null)"
up=$(curl -s -m 600 "${H[@]}" -H "Content-Type: application/octet-stream" --data-binary @"$OUT" \
  "https://uploads.github.com/repos/$REPO/releases/$RID/assets?name=$TAG.tar.gpg")
USZ=$(printf '%s' "$up" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("size",""))' 2>/dev/null)
[ "$USZ" = "$SZ" ] || fail "загрузка не подтверждена (размер ${USZ:-?} ≠ $SZ)"
say "ok $DAY: $SZ байт, sha256 $SHA → $REPO релиз $TAG"
