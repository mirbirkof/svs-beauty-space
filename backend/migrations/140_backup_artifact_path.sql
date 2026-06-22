-- 140: реальный артефакт бэкапа (аудит 22.06, Critical «backup — заглушка»).
-- Раньше /api/backup/run не создавал файла: писал выдуманный size_bytes (rows*512)
-- и checksum от счётчиков строк. Теперь run делает настоящий gzip-снимок данных
-- тенанта и сохраняет путь к артефакту здесь.
ALTER TABLE backup_runs ADD COLUMN IF NOT EXISTS artifact_path TEXT;
