#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#   SVS Beauty World — упаковка/распаковка файлов uploads для переезда.
#   Файлы (фото клиентов, документы, AI-видео) НЕ в Postgres — на диске.
#   БД-бэкап их не содержит, переносить надо отдельно.
#
#   Упаковать (на СТАРОМ сервере):   bash scripts/uploads-pack.sh pack
#   Распаковать (на НОВОМ сервере):  bash scripts/uploads-pack.sh unpack uploads-YYYY-MM-DD.tar.gz
# ═══════════════════════════════════════════════════════════════════
set -e
UPLOADS_DIR="${UPLOADS_DIR:-$(cd "$(dirname "$0")/.." && pwd)/uploads}"
CMD="$1"

case "$CMD" in
  pack)
    OUT="uploads-$(date '+%Y-%m-%d_%H-%M').tar.gz"
    if [ ! -d "$UPLOADS_DIR" ]; then echo "нет папки: $UPLOADS_DIR"; exit 1; fi
    tar -czf "$OUT" -C "$UPLOADS_DIR" .
    N=$(tar -tzf "$OUT" | grep -vc '/$' || true)
    echo "[+] упаковано $N файлов из $UPLOADS_DIR → $OUT ($(du -h "$OUT" | cut -f1))"
    echo "    перенеси этот файл на новый сервер и распакуй."
    ;;
  unpack)
    ARCHIVE="$2"
    if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then echo "укажи архив: unpack <file.tar.gz>"; exit 1; fi
    mkdir -p "$UPLOADS_DIR"
    tar -xzf "$ARCHIVE" -C "$UPLOADS_DIR"
    N=$(find "$UPLOADS_DIR" -type f | wc -l)
    echo "[+] распаковано в $UPLOADS_DIR — теперь там $N файлов"
    ;;
  *)
    echo "Использование: $0 {pack|unpack <archive>}"
    exit 1
    ;;
esac
