/* INF-06 Backup & Recovery — резервное копирование и восстановление.
 *
 * Прагматично для управляемой БД (Render/Neon делают физический PITR на уровне
 * платформы): здесь — учёт прогонов бэкапа, retention-политика, restore-workflow
 * (запрос→подтверждение→восстановление→верификация) и GDPR data-portability
 * (машиночитаемый экспорт данных тенанта). Прогон снимает логический срез:
 * считает таблицы и строки, фиксирует размер/контрольную сумму.
 *
 * GET  /api/backup/config            — политика бэкапа
 * PUT  /api/backup/config            — изменить политику
 * GET  /api/backup/runs              — история прогонов
 * POST /api/backup/run               — запустить бэкап (логический снимок)
 * POST /api/backup/retention/apply   — применить retention (удалить устаревшие записи прогонов)
 * GET  /api/backup/restore           — заявки на восстановление
 * POST /api/backup/restore           — создать заявку
 * PATCH /api/backup/restore/:id      — продвинуть статус workflow
 * GET  /api/backup/export            — GDPR-экспорт данных тенанта (JSON)
 */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');
const { runBackup, s3Configured, validateSnapshot } = require('../lib/backup-core');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const pool = getPool();

const READ = requirePerm('backup.read');
const MANAGE = requirePerm('backup.manage');

// Ключевые таблицы тенанта для снимка/экспорта
const TENANT_TABLES = [
  'appointments','clients','masters','services','orders','order_items',
  'payments','loyalty_accounts','inventory_items','crm_notes'
];

async function existingTables(list) {
  const r = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_name = ANY($1)`, [list]);
  return r.rows.map(x => x.table_name);
}

// ── Конфиг ───────────────────────────────────────────
router.get('/config', READ, async (req, res) => {
  try {
    let r = await pool.query(`SELECT * FROM backup_config ORDER BY id LIMIT 1`);
    if (!r.rowCount) r = await pool.query(`INSERT INTO backup_config DEFAULT VALUES RETURNING *`);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/config', MANAGE, async (req, res) => {
  try {
    const b = req.body || {};
    const cur = await pool.query(`SELECT id FROM backup_config ORDER BY id LIMIT 1`);
    if (!cur.rowCount) await pool.query(`INSERT INTO backup_config DEFAULT VALUES`);
    const r = await pool.query(
      `UPDATE backup_config SET
         schedule=COALESCE($1,schedule), retention_days=COALESCE($2,retention_days),
         encrypt=COALESCE($3,encrypt), geo_regions=COALESCE($4,geo_regions), updated_at=NOW()
       WHERE id=(SELECT id FROM backup_config ORDER BY id LIMIT 1) RETURNING *`,
      [b.schedule||null, b.retention_days||null, b.encrypt,
       b.geo_regions ? JSON.stringify(b.geo_regions) : null]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Прогоны ──────────────────────────────────────────
router.get('/runs', READ, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM backup_runs ORDER BY started_at DESC LIMIT 100`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/run', MANAGE, async (req, res) => {
  const type = (req.body && req.body.backup_type) || 'full';
  const cfg = await pool.query(`SELECT encrypt, geo_regions FROM backup_config ORDER BY id LIMIT 1`);
  const encrypt = cfg.rowCount ? cfg.rows[0].encrypt : true;
  const region = cfg.rowCount && cfg.rows[0].geo_regions?.[0] ? cfg.rows[0].geo_regions[0] : 'eu-central';
  const run = await pool.query(
    `INSERT INTO backup_runs (backup_type,status,region,encrypted) VALUES ($1,'running',$2,$3) RETURNING id`,
    [type, region, encrypt]);
  const runId = run.rows[0].id;
  try {
    const tables = await existingTables(TENANT_TABLES);
    // Реальный gzip-снимок данных + выгрузка во внешнее хранилище (если настроено).
    // pool.query здесь tenant-scoped (RLS) → снимок только данных текущего салона.
    const out = await runBackup({
      queryFn: (text, params) => pool.query(text, params),
      tables, label: 'tenant', uploadToS3: true,
    });
    const r = await pool.query(
      `UPDATE backup_runs SET status='success', size_bytes=$1, tables_count=$2, rows_count=$3,
         checksum=$4, artifact_path=$5, finished_at=NOW() WHERE id=$6 RETURNING *`,
      [out.size_bytes, out.tables, out.rows, out.checksum, out.artifact_path, runId]);
    await logAction({ user: req.user, action: 'backup.run', entity: 'backup_runs', entity_id: runId, ip: req.ip,
      meta: { uploaded: out.uploaded, artifact: out.artifact_path } });
    res.status(201).json({ ...r.rows[0],
      offsite: out.uploaded,
      warning: out.uploaded ? undefined : 'снимок только локальный (эфемерный диск Render); задайте BACKUP_S3_* для внешнего хранилища' });
  } catch (e) {
    await pool.query(`UPDATE backup_runs SET status='failed', error=$1, finished_at=NOW() WHERE id=$2`,
      [String(e.message).slice(0,300), runId]);
    res.status(500).json({ error: e.message });
  }
});

router.post('/retention/apply', MANAGE, async (req, res) => {
  try {
    const cfg = await pool.query(`SELECT retention_days FROM backup_config ORDER BY id LIMIT 1`);
    const days = cfg.rowCount ? cfg.rows[0].retention_days : 30;
    const r = await pool.query(
      `DELETE FROM backup_runs WHERE started_at < NOW() - ($1 || ' days')::interval AND status='success' RETURNING id`,
      [days]);
    res.json({ ok: true, retention_days: days, removed: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Restore workflow ─────────────────────────────────
const RESTORE_FLOW = { requested:'approved', approved:'restoring', restoring:'restored', restored:'verified' };

// ── GET /api/backup/restore/verify — проверка ВОССТАНОВИМОСТИ последнего снимка ──
// Dry-run: распаковывает свежий gzip-снимок, считает строки по таблицам, ловит битые.
// Закрывает дыру «бэкап делается, но никто не знает, восстановится ли он».
// Без записи в БД — безопасно вызывать в любой момент.
router.get('/restore/verify', READ, async (req, res) => {
  try {
    const dir = path.resolve(__dirname, '../../backups');
    let files = [];
    try {
      files = fs.readdirSync(dir)
        .filter(f => f.endsWith('.json.gz'))
        .map(f => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
    } catch (_) {}
    if (!files.length) {
      return res.json({ ok: false, reason: 'no-local-snapshot',
        hint: 'Запусти POST /api/backup/run, затем повтори проверку.' });
    }
    const latest = path.join(dir, files[0].f);
    const report = await validateSnapshot({ localPath: latest });
    await logAction({ user: req.user, action: 'backup.restore.verify', ip: req.ip });
    res.json({ snapshot_file: files[0].f, ...report });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/restore', READ, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM backup_restore_requests ORDER BY created_at DESC LIMIT 100`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/restore', MANAGE, async (req, res) => {
  try {
    const b = req.body || {};
    const r = await pool.query(
      `INSERT INTO backup_restore_requests (backup_run_id,point_in_time,reason,requested_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [b.backup_run_id||null, b.point_in_time||null, b.reason||null, req.user?.id||null]);
    await logAction({ user: req.user, action: 'backup.restore.request', entity: 'backup_restore_requests', entity_id: r.rows[0].id, ip: req.ip });
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/restore/:id', MANAGE, async (req, res) => {
  try {
    const b = req.body || {};
    const cur = await pool.query(`SELECT status FROM backup_restore_requests WHERE id=$1`, [req.params.id]);
    if (!cur.rowCount) return res.status(404).json({ error: 'not_found' });
    let next = b.status;
    if (b.action === 'advance') next = RESTORE_FLOW[cur.rows[0].status] || cur.rows[0].status;
    if (b.action === 'reject') next = 'rejected';
    const r = await pool.query(
      `UPDATE backup_restore_requests SET status=$1, approved_by=COALESCE(approved_by,$2), updated_at=NOW()
       WHERE id=$3 RETURNING *`,
      [next, req.user?.id||null, req.params.id]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GDPR data portability ────────────────────────────
router.get('/export', MANAGE, async (req, res) => {
  try {
    const tables = await existingTables(TENANT_TABLES);
    const dump = {};
    for (const t of tables) {
      const r = await pool.query(`SELECT * FROM ${t} LIMIT 100000`);
      dump[t] = r.rows;
    }
    await logAction({ user: req.user, action: 'backup.gdpr.export', ip: req.ip });
    res.setHeader('Content-Disposition', `attachment; filename="tenant-export-${Date.now()}.json"`);
    res.json({ exported_at: new Date().toISOString(), format: 'gdpr-portability-json', tables: dump });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
