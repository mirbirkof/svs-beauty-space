/* ═══════════════════════════════════════════════════════
   Слияние дублей клиентов (client dedup / merge)

   Дубли возникают при синке с BeautyPro, ручном вводе и
   разном формате телефона ("+380.." vs "0..").

   findDuplicateClients(pool) — кандидаты-группы по нормализ.
       телефону и по email (сильные сигналы).
   mergeClients(client, primaryId, dupId) — внутри ТРАНЗАКЦИИ
       (caller делает BEGIN + applyTenant). Перецепляет ВСЕ
       ссылки на clients.id динамически (FK + soft-ref колонки
       client_id), сливает поля карточки, архивирует дубль.

   Динамика по системному каталогу = новые таблицы со ссылкой
   на клиента подхватываются автоматически, без правки кода.
   ═══════════════════════════════════════════════════════ */

// Колонки, ссылающиеся на clients.id: настоящие FK + «мягкие»
// ссылки (колонки client_id без FK, пишутся каналами до
// идентификации). Кэшируется на процесс — каталог стабилен.
let _refsCache = null;
async function discoverClientRefs(client) {
  if (_refsCache) return _refsCache;
  const fk = await client.query(`
    SELECT tc.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
       AND kcu.table_schema   = tc.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema    = tc.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND tc.table_schema    = 'public'
       AND ccu.table_name     = 'clients'
       AND ccu.column_name    = 'id'`);
  const soft = await client.query(`
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND data_type IN ('integer','bigint')
       AND column_name = 'client_id'`);
  const seen = new Set();
  const refs = [];
  for (const row of [...fk.rows, ...soft.rows]) {
    // не трогаем саму таблицу clients (там id, не ссылка)
    if (row.table_name === 'clients') continue;
    const key = row.table_name + '.' + row.column_name;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ table: row.table_name, col: row.column_name });
  }
  _refsCache = refs;
  return refs;
}

// Нормализация телефона до значащих цифр (последние 9) — чтобы
// "+380501234567" и "0501234567" считались одним номером.
const PHONE_NORM = `RIGHT(regexp_replace(COALESCE(phone,''), '\\D', '', 'g'), 9)`;

// Поиск кандидатов на слияние среди НЕархивированных клиентов.
async function findDuplicateClients(pool, { limit = 50 } = {}) {
  const byPhone = await pool.query(`
    WITH n AS (
      SELECT id, name, phone, email, total_spent, loyalty_points, last_visit_at,
             ${PHONE_NORM} AS k
        FROM clients
       WHERE deleted_at IS NULL AND COALESCE(phone,'') <> ''
    )
    SELECT k AS key, 'phone' AS reason,
           json_agg(json_build_object(
             'id', id, 'name', name, 'phone', phone, 'email', email,
             'total_spent', total_spent, 'loyalty_points', loyalty_points,
             'last_visit_at', last_visit_at) ORDER BY id) AS members
      FROM n
     WHERE length(k) >= 7
     GROUP BY k HAVING COUNT(*) > 1
     ORDER BY COUNT(*) DESC LIMIT $1`, [limit]);

  const byEmail = await pool.query(`
    SELECT lower(trim(email)) AS key, 'email' AS reason,
           json_agg(json_build_object(
             'id', id, 'name', name, 'phone', phone, 'email', email,
             'total_spent', total_spent, 'loyalty_points', loyalty_points,
             'last_visit_at', last_visit_at) ORDER BY id) AS members
      FROM clients
     WHERE deleted_at IS NULL AND COALESCE(trim(email),'') <> ''
     GROUP BY lower(trim(email)) HAVING COUNT(*) > 1
     ORDER BY COUNT(*) DESC LIMIT $1`, [limit]);

  return [...byPhone.rows, ...byEmail.rows];
}

// Слияние dupId → primaryId. Вызывать ВНУТРИ транзакции.
async function mergeClients(client, primaryId, dupId) {
  primaryId = parseInt(primaryId, 10);
  dupId = parseInt(dupId, 10);
  if (!primaryId || !dupId) throw new Error('bad-ids');
  if (primaryId === dupId) throw new Error('same-client');

  const both = await client.query(
    `SELECT * FROM clients WHERE id = ANY($1::int[]) AND deleted_at IS NULL`,
    [[primaryId, dupId]]);
  if (both.rowCount < 2) throw new Error('not-found');
  const primary = both.rows.find(r => r.id === primaryId);
  const dup = both.rows.find(r => r.id === dupId);
  if (!primary || !dup) throw new Error('not-found');

  // 1) Перецепляем все ссылки dup → primary.
  const refs = await discoverClientRefs(client);
  const moved = [];
  for (const { table, col } of refs) {
    await client.query('SAVEPOINT mv');
    try {
      const r = await client.query(
        `UPDATE "${table}" SET "${col}" = $1 WHERE "${col}" = $2`, [primaryId, dupId]);
      await client.query('RELEASE SAVEPOINT mv');
      if (r.rowCount) moved.push({ table, col, rows: r.rowCount });
    } catch (e) {
      // Конфликт unique/PK (у primary уже есть такая строка) —
      // дублирующая строка dup лишняя, удаляем её.
      await client.query('ROLLBACK TO SAVEPOINT mv');
      await client.query('SAVEPOINT mv2');
      try {
        const d = await client.query(`DELETE FROM "${table}" WHERE "${col}" = $1`, [dupId]);
        await client.query('RELEASE SAVEPOINT mv2');
        if (d.rowCount) moved.push({ table, col, deleted: d.rowCount });
      } catch (e2) {
        await client.query('ROLLBACK TO SAVEPOINT mv2');
        // не блокируем слияние из-за одной проблемной таблицы
      }
    }
  }

  // 2) Сливаем поля карточки на primary (fill-if-null + агрегаты).
  const mergedNotes = [primary.notes, dup.notes].filter(Boolean).join('\n').trim() || null;
  const tags = Array.from(new Set([...(primary.tags || []), ...(dup.tags || [])]));
  await client.query(`
    UPDATE clients SET
      name          = COALESCE(NULLIF(trim(name),''), $2),
      email         = COALESCE(email, $3),
      birthday      = COALESCE(birthday, $4),
      avatar        = COALESCE(avatar, $5),
      telegram_id   = COALESCE(telegram_id, $6),
      beautypro_id  = COALESCE(beautypro_id, $7),
      loyalty_points = COALESCE(loyalty_points,0) + COALESCE($8,0),
      total_spent    = COALESCE(total_spent,0)   + COALESCE($9,0),
      tags          = $10,
      notes         = $11,
      last_visit_at = GREATEST(last_visit_at, $12),
      created_at    = LEAST(created_at, $13),
      updated_at    = NOW()
    WHERE id = $1`,
    [primaryId, dup.name, dup.email, dup.birthday, dup.avatar, dup.telegram_id,
     dup.beautypro_id, dup.loyalty_points, dup.total_spent, tags, mergedNotes,
     dup.last_visit_at, dup.created_at]);

  // 3) Освобождаем уникальные поля дубля и архивируем его.
  await client.query(`
    UPDATE clients SET
      deleted_at  = NOW(), updated_at = NOW(),
      phone       = NULL, email = NULL, telegram_id = NULL,
      notes       = COALESCE(notes,'') || ' [merged → #' || $2 || ']'
    WHERE id = $1`, [dupId, primaryId]);

  return {
    primary_id: primaryId, duplicate_id: dupId,
    moved, points_added: dup.loyalty_points || 0,
    spent_added: Number(dup.total_spent || 0),
  };
}

module.exports = { findDuplicateClients, mergeClients, discoverClientRefs };
