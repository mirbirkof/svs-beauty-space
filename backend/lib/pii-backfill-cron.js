/* Фоновая дошифровка ПД клиентов (GDPR).
   Раз в тик заполняет phone_enc (AES-256-GCM) + phone_bidx (HMAC blind index) для клиентов,
   у кого их ещё нет (новые из ЛЮБОГО пути вставки — booking/admin/import/sync/…).
   БЕЗОПАСНО: пишет только теневые колонки, открытый clients.phone не трогает, вставку клиента
   не блокирует (крутится отдельно в фоне). Без PII_KEY — тихий no-op. */
const { getPool } = require('../db-pg');
const pii = require('./pii-crypto');

let timer = null;

async function sweepOnce(limit = 500) {
  if (!pii.available()) return 0;
  const pool = getPool();
  let done = 0;
  try {
    // Системный воркер: без tenant-контекста запрос идёт ролью подключения (BYPASSRLS) —
    // видим клиентов всех салонов. Пишем ТОЛЬКО теневые колонки, открытый phone не трогаем.
    const rows = (await pool.query(
      `SELECT id, phone FROM clients
        WHERE phone IS NOT NULL AND phone <> '' AND phone_bidx IS NULL
        LIMIT $1`, [limit]
    )).rows;
    for (const r of rows) {
      try {
        const enc = pii.encrypt(r.phone);
        const bidx = pii.phoneBidx(r.phone);
        if (!bidx) continue;
        await pool.query(`UPDATE clients SET phone_enc = $1, phone_bidx = $2 WHERE id = $3`, [enc, bidx, r.id]);
        done++;
      } catch (_) { /* один битый телефон не должен ронять свип */ }
    }
  } catch (e) {
    try { require('./sentry').capture(e, { kind: 'cron', job: 'pii-backfill' }); } catch (_) {}
  }
  if (done) console.log(`[pii] дошифровано телефонов: ${done}`);
  return done;
}

function startCron() {
  if (timer) return;
  if (!pii.available()) { console.log('[pii] PII_KEY не задан — дошифровка выключена (no-op)'); return; }
  // первый прогон через 60с после старта, дальше каждые 10 мин
  setTimeout(() => { sweepOnce().catch(() => {}); }, 60 * 1000);
  timer = setInterval(() => { sweepOnce().catch(() => {}); }, 10 * 60 * 1000);
  console.log('[pii] фоновая дошифровка новых телефонов включена (каждые 10 мин)');
}

module.exports = { startCron, sweepOnce };
