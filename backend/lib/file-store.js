/* ════════════════════════════════════════════════════════════════
   Общее хранилище файлов — чтобы несколько серверов (основной + резервный
   Render) видели ОДНИ И ТЕ ЖЕ файлы клиентов. Без него файлы лежат на диске
   каждого сервера отдельно и при переключении «пропадают».

   Как работает:
   ── Если задано S3-совместимое хранилище (BACKUP_S3_* / FILES_S3_*) — файл
      при загрузке дублируется в облако, а при отдаче, если на этом сервере
      его нет (файл залил другой сервер) — тянется из облака. Диск = кэш.
   ── Если хранилище не настроено — работает по-старому, локально (fallback,
      ничего не ломается).

   Переиспользует готовый S3-клиент (lib/s3-upload.js, SigV4, без зависимостей).
   Файлы кладутся под отдельный префикс crm-files/ — не мешаются с бэкапами.
   ════════════════════════════════════════════════════════════════ */
const s3 = require('./s3-upload');

const FILE_PREFIX = 'crm-files/';

// Общее хранилище доступно? (те же ключи, что у офсайт-бэкапов).
function shared() {
  return s3.isConfigured();
}

// Залить файл в облако. Возвращает true если залито, false если хранилище выкл.
async function put(relKey, buffer, contentType) {
  if (!shared()) return false;
  await s3.uploadObject(FILE_PREFIX + relKey, buffer, contentType || 'application/octet-stream');
  return true;
}

// Скачать файл из облака (Buffer). Бросает если нет/не настроено.
async function getBuffer(relKey) {
  return s3.getObject(FILE_PREFIX + relKey);
}

module.exports = { shared, put, getBuffer, FILE_PREFIX };
