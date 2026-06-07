#!/bin/bash
# SVS Beauty World — Daily PG backup
# Запускается из db-backup-loop.sh раз в 24 часа.
# Делает pg_dump в backups/YYYY-MM-DD.sql.gz, оставляет последние 14 дней.

set -e
DIR="$HOME/workspace/svs-beauty-space"
BACKUP_DIR="$DIR/backups"
ENV_FILE="$DIR/backend/.env"
LOG="/tmp/db-backup.log"

mkdir -p "$BACKUP_DIR"
DATE=$(date '+%Y-%m-%d_%H-%M')
DB_URL=$(grep "^DATABASE_URL=" "$ENV_FILE" | cut -d= -f2- | tr -d '"')

if [ -z "$DB_URL" ]; then
  echo "[$(date)] ERROR: DATABASE_URL not set" >> "$LOG"
  exit 1
fi

OUT="$BACKUP_DIR/$DATE.sql.gz"
echo "[$(date)] dumping → $OUT" >> "$LOG"

if pg_dump "$DB_URL" --no-owner --no-acl 2>>"$LOG" | gzip > "$OUT"; then
  SIZE=$(du -h "$OUT" | cut -f1)
  echo "[$(date)] OK ($SIZE)" >> "$LOG"
else
  echo "[$(date)] FAILED" >> "$LOG"
  rm -f "$OUT"
  exit 1
fi

# Ротация: оставляем последние 14 файлов
cd "$BACKUP_DIR"
ls -1t *.sql.gz 2>/dev/null | tail -n +15 | xargs -r rm -f
echo "[$(date)] rotation done, kept $(ls -1 *.sql.gz | wc -l) files" >> "$LOG"
