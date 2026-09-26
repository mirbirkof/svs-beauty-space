#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════
   ИНВЕНТАРИЗАЦИЯ: дозаполнение проведённых актов (Босс 26.09: «факт сохраняется, но не
   переносится в остатки»).

   Запуск:
     node svs-beauty-space/ops/inv-reconcile-2609.js           → --dry (по умолчанию, ничего не пишет)
     node svs-beauty-space/ops/inv-reconcile-2609.js --apply   → всё в ОДНОЙ транзакции
   БД: DATABASE_URL из backend/.env (или DB_URL=... для песочницы).

   ЧТО ДЕЛАЕТ
   1) колонка inventory_audit_items.applied_qty (как миграция 307, идемпотентно);
   2) для ПРОВЕДЁННЫХ актов заполняет applied_qty по ФАКТИЧЕСКИМ движениям 'inventory_audit'
      (ref_id = акт, variant_id): одна подсчитанная строка на вариант → applied = сумма движений;
      несколько (след склейки дублей) → applied = diff каждой строки, только если сумма diff
      совпадает с суммой движений, иначе строка в «на ручную проверку», ничего не трогаем;
   3) строки, где расхождение (diff) ≠ применённому (факт внесли ПОСЛЕ проведения — PATCH не
      смотрел на статус акта), ДОПРИМЕНЯЕТ: stock_qty += (diff − applied), движение
      'inventory_audit' с пометкой, applied = diff, total_diff акта += разница × собівартість;
   4) пустые незавершённые акты из списка EMPTY_DUPES (0 подсчитано, дубли двойного клика 25.09)
      → status 'cancelled' + пометка в notes. Ничего не удаляется. Акт №8 НЕ трогается (решение Босса).
   Перед --apply: бэкап всех затронутых строк → ops/_inv_reconcile_backup_2609.json; запись в audit_log.
   ИНВАРИАНТ после (иначе ROLLBACK): по каждому проведённому акту и варианту сумма applied_qty =
   сумме движений 'inventory_audit'.
   ═══════════════════════════════════════════════════════════════ */
const path = require('path');
const fs = require('fs');
const BACKEND = path.join(__dirname, '..', 'backend');
require(path.join(BACKEND, 'node_modules', 'dotenv')).config({ path: path.join(BACKEND, '.env') });
const { Client } = require(path.join(BACKEND, 'node_modules', 'pg'));

const APPLY = process.argv.includes('--apply');
const DB_URL = process.env.DB_URL || process.env.DATABASE_URL;
const BACKUP = process.env.INV_BACKUP || path.join(__dirname, '_inv_reconcile_backup_2609.json');
const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-000000000001';
const EMPTY_DUPES = (process.env.INV_EMPTY_DUPES || '11,12,13,14,15').split(',').map(Number).filter(Boolean);
const NOTE_APPLIED = 'доприменено 26.09: факт внесено після проведення акту';
const NOTE_CANCEL = 'авто-скасовано 26.09: порожній дубль подвійного кліку (0 підраховано)';
const r3 = (x) => Math.round(Number(x) * 1000) / 1000;

(async () => {
  const db = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  try {
    await db.query('BEGIN');
    await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT]);
    await db.query(`ALTER TABLE inventory_audit_items ADD COLUMN IF NOT EXISTS applied_qty NUMERIC(12,3)`);

    const audits = await q(`SELECT id, completed_at, total_diff FROM inventory_audits WHERE status='completed' ORDER BY id FOR UPDATE`);
    const auditIds = audits.map((a) => a.id);
    const items = auditIds.length ? await q(
      `SELECT i.*, i.diff_qty::float AS d, i.applied_qty::float AS ap FROM inventory_audit_items i
        WHERE i.audit_id = ANY($1::int[]) AND i.actual_qty IS NOT NULL ORDER BY i.audit_id, i.variant_id, i.id FOR UPDATE`, [auditIds]) : [];
    const moves = auditIds.length ? await q(
      `SELECT ref_id AS audit_id, variant_id, SUM(delta)::float AS s, COUNT(*)::int AS n FROM stock_movements
        WHERE reason='inventory_audit' AND ref_id = ANY($1::int[]) GROUP BY 1,2`, [auditIds]) : [];
    const mv = new Map(moves.map((m) => [m.audit_id + ':' + m.variant_id, m.s]));
    const groups = new Map();
    for (const it of items) { const k = it.audit_id + ':' + it.variant_id; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it); }

    const setApplied = []; const toApply = []; const manual = [];
    for (const [k, rows] of groups) {
      const moved = r3(mv.get(k) || 0);
      if (rows.length === 1) {
        const it = rows[0];
        if (it.ap == null || r3(it.ap) !== moved) setApplied.push({ id: it.id, applied: moved });
        if (r3(it.d || 0) !== moved) toApply.push({ it, applied: moved, delta: r3((it.d || 0) - moved) });
      } else {
        const sumD = r3(rows.reduce((s, x) => s + (x.d || 0), 0));
        if (sumD === moved) { for (const it of rows) if (it.ap == null || r3(it.ap) !== r3(it.d || 0)) setApplied.push({ id: it.id, applied: r3(it.d || 0) }); }
        else manual.push({ key: k, rows: rows.map((x) => ({ id: x.id, actual: x.actual_qty, diff: x.d })), moved });
      }
    }
    // варианты без подсчёта, но с движением (не должно быть) → на проверку
    for (const m of moves) if (!groups.has(m.audit_id + ':' + m.variant_id)) manual.push({ key: m.audit_id + ':' + m.variant_id, rows: [], moved: m.s });

    const empties = EMPTY_DUPES.length ? await q(
      `SELECT a.id, a.status, a.notes, a.started_at,
              (SELECT COUNT(*) FROM inventory_audit_items i WHERE i.audit_id=a.id AND i.actual_qty IS NOT NULL)::int AS counted
         FROM inventory_audits a WHERE a.id = ANY($1::int[]) FOR UPDATE`, [EMPTY_DUPES]) : [];
    const toCancel = empties.filter((a) => a.status === 'in_progress' && a.counted === 0);
    const skipCancel = empties.filter((a) => !toCancel.includes(a));

    const varIds = [...new Set(toApply.map((x) => x.it.variant_id))];
    const variants = varIds.length ? await q(`SELECT id, stock_qty FROM product_variants WHERE id = ANY($1::int[]) FOR UPDATE`, [varIds]) : [];
    console.log(JSON.stringify({ mode: APPLY ? 'APPLY' : 'DRY', completed_audits: auditIds, counted_rows: items.length,
      applied_backfill: setApplied.length,
      to_apply: toApply.map((x) => ({ audit: x.it.audit_id, item: x.it.id, variant: x.it.variant_id, name: x.it.product_name,
        expected: Number(x.it.expected_qty), actual: Number(x.it.actual_qty), diff: x.it.d, already: x.applied, delta: x.delta,
        stock_before: Number((variants.find((v) => v.id === x.it.variant_id) || {}).stock_qty) })),
      manual, cancel: toCancel.map((a) => a.id), not_cancelled: skipCancel.map((a) => ({ id: a.id, status: a.status, counted: a.counted })) }, null, 2));

    if (!APPLY) { await db.query('ROLLBACK'); return; }

    fs.writeFileSync(BACKUP, JSON.stringify({ at: new Date().toISOString(), audits, items, moves, variants, empties }, null, 1));
    for (const s of setApplied) await db.query(`UPDATE inventory_audit_items SET applied_qty=$2 WHERE id=$1`, [s.id, s.applied]);
    for (const x of toApply) {
      await db.query(`UPDATE product_variants SET stock_qty = GREATEST(0, COALESCE(stock_qty,0) + $1) WHERE id=$2`, [x.delta, x.it.variant_id]);
      await db.query(`INSERT INTO stock_movements (variant_id, delta, reason, ref_id, notes, tenant_id) VALUES ($1,$2,'inventory_audit',$3,$4,$5)`,
        [x.it.variant_id, x.delta, x.it.audit_id, NOTE_APPLIED, TENANT]);
      await db.query(`UPDATE inventory_audit_items SET applied_qty=diff_qty WHERE id=$1`, [x.it.id]);
      await db.query(`UPDATE inventory_audits SET total_diff = COALESCE(total_diff,0) + $1 WHERE id=$2`, [x.delta * Number(x.it.cost_per_unit || 0), x.it.audit_id]);
    }
    for (const a of toCancel) {
      await db.query(`UPDATE inventory_audits SET status='cancelled', notes = CASE WHEN COALESCE(notes,'')='' THEN $2 ELSE notes || ' · ' || $2 END WHERE id=$1`, [a.id, NOTE_CANCEL]);
    }
    // инвариант
    const bad = await q(
      `WITH ia AS (SELECT audit_id, variant_id, SUM(COALESCE(applied_qty,0)) ap FROM inventory_audit_items WHERE audit_id = ANY($1::int[]) GROUP BY 1,2),
            m AS (SELECT ref_id AS audit_id, variant_id, SUM(delta) s FROM stock_movements WHERE reason='inventory_audit' AND ref_id = ANY($1::int[]) GROUP BY 1,2)
       SELECT COALESCE(ia.audit_id,m.audit_id) a, COALESCE(ia.variant_id,m.variant_id) v, ia.ap, m.s FROM ia FULL JOIN m USING (audit_id, variant_id)
        WHERE COALESCE(ia.ap,0) <> COALESCE(m.s,0)`, [auditIds]);
    if (bad.length && !manual.length) throw new Error('инвариант нарушен: ' + JSON.stringify(bad));
    await db.query(`INSERT INTO audit_log (user_label, action, entity, meta, tenant_id) VALUES ('ops/inv-reconcile-2609','inventory.reconcile','audit',$1,$2)`,
      [JSON.stringify({ applied: toApply.map((x) => ({ audit: x.it.audit_id, variant: x.it.variant_id, delta: x.delta })), cancelled: toCancel.map((a) => a.id), backfill: setApplied.length }), TENANT]);
    await db.query('COMMIT');
    console.log('APPLIED. backup →', BACKUP, '; invariant mismatches:', bad.length);
  } catch (e) {
    try { await db.query('ROLLBACK'); } catch (_) {}
    console.error('ROLLBACK:', e.message); process.exitCode = 1;
  } finally { await db.end(); }
})();
