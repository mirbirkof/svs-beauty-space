/* Контроль змін: хто за графіком на зміні, хто реально працює в CRM, стан каси.
   Підключається як /api/shift-control у shop-api.js */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');
const sc = require('../lib/shift-control');

const router = express.Router();

// GET /api/shift-control/status — картина зміни «зараз»
router.get('/status', requirePerm(), async (req, res) => {
  try {
    const pool = getPool();
    const [win, onShift, shift] = await Promise.all([
      sc.todayWindow(), sc.onShiftNow(), sc.openShift(),
    ]);
    const audit = await pool.query(
      `SELECT user_id, display_name, verdict, seen_count, first_seen_at, last_seen_at
         FROM shift_login_audit WHERE work_date = CURRENT_DATE
        ORDER BY last_seen_at DESC`);
    let cash = null;
    if (shift) {
      const expected = await sc.expectedCash(shift.id, shift.opening_cash);
      cash = {
        id: shift.id, opened_at: shift.opened_at, auto_opened: shift.auto_opened,
        opening_cash: Number(shift.opening_cash), expected_cash: expected,
        opened_by_user_id: shift.opened_by_user_id,
      };
    }
    // Приватність: хто працює поза своєю зміною — справа ВЛАСНИКА, а не всієї команди.
    // Рядовий співробітник бачить графік і касу, але не чужі вердикти.
    const isOwner = Array.isArray(req.user?.permissions)
      ? req.user.permissions.includes('*') : false;
    const mine = audit.rows.filter(r => r.user_id === req.user?.id);
    res.json({
      window: win,
      on_shift: onShift,                       // хто МАЄ бути за графіком
      working_now: isOwner ? audit.rows : mine,   // хто РЕАЛЬНО працює в CRM + вердикт
      anomalies: isOwner
        ? audit.rows.filter(r => r.verdict === 'off_shift' || r.verdict === 'no_schedule')
        : [],
      cash_shift: cash,
    });
  } catch (e) {
    console.error('[shift-control/status]', e.message);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'internal' : e.message });
  }
});

// POST /api/shift-control/run — прогнати автопілот зараз (кнопка для власника)
router.post('/run', requirePerm('cashbox.write'), async (req, res) => {
  try { res.json({ ok: true, result: await sc.tick() }); }
  catch (e) {
    console.error('[shift-control/run]', e.message);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'internal' : e.message });
  }
});

module.exports = router;
