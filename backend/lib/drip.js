/* lib/drip.js — MKT-03 Drip-цепочки.
   Кампания type='drip' имеет упорядоченные campaign_steps. При запуске резолвим
   аудиторию сегмента → создаём campaign_enrollments по клиенту. Планировщик
   processDrip() раз за тик берёт enrollment'ы с next_run_at<=now, проверяет
   условие/конверсию, ставит текущий шаг в Notification Hub и двигает на следующий.

   Условный выход: если клиент сделал запись (appointments после entered_at) и
   campaign.exit_on_conversion → enrollment.status='exited', reason='converted'.
   Условие шага: condition_type='not_converted' пропускает шаг если клиент уже
   сконвертил; 'converted' — наоборот. 'clicked'/'not_clicked' зарезервированы
   (нет трекинга кликов) → ведут себя как 'none'.
   A/B: step.variants=[{variant,body,template_key,weight}] → стики-вариант на клиента. */
const { getPool } = require('../db-pg');
const hub = require('./notification-hub');
const seg = require('./segments');

const ACTIVE_APPT = ['pending', 'confirmed', 'booked', 'done'];

// ── Шаги (CRUD-хелперы) ──────────────────────────────────────────────
async function listSteps(campaignId) {
  const r = await getPool().query(
    `SELECT * FROM campaign_steps WHERE campaign_id=$1 ORDER BY step_number ASC`, [campaignId]);
  return r.rows;
}

async function addStep(campaignId, s = {}) {
  const pool = getPool();
  // если step_number не задан — добавляем в конец
  let n = s.step_number;
  if (!n) {
    const m = await pool.query(`SELECT COALESCE(MAX(step_number),0)+1 AS n FROM campaign_steps WHERE campaign_id=$1`, [campaignId]);
    n = m.rows[0].n;
  }
  const r = await pool.query(
    `INSERT INTO campaign_steps(campaign_id, step_number, delay_hours, channel, template_key, body, vars, condition_type, variants, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,true)) RETURNING *`,
    [campaignId, n, s.delay_hours || 0, s.channel || 'any', s.template_key || null,
     s.body || null, JSON.stringify(s.vars || {}), s.condition_type || 'none',
     s.variants ? JSON.stringify(s.variants) : null, s.is_active]);
  return r.rows[0];
}

async function updateStep(stepId, patch = {}) {
  const cols = [], vals = []; let i = 1;
  for (const k of ['delay_hours', 'channel', 'template_key', 'body', 'condition_type', 'is_active']) {
    if (patch[k] !== undefined) { cols.push(`${k}=$${i++}`); vals.push(patch[k]); }
  }
  if (patch.vars !== undefined) { cols.push(`vars=$${i++}`); vals.push(JSON.stringify(patch.vars)); }
  if (patch.variants !== undefined) { cols.push(`variants=$${i++}`); vals.push(patch.variants ? JSON.stringify(patch.variants) : null); }
  if (!cols.length) return null;
  cols.push('updated_at=NOW()');
  vals.push(stepId);
  const r = await getPool().query(
    `UPDATE campaign_steps SET ${cols.join(', ')} WHERE id=$${i} RETURNING *`, vals);
  return r.rows[0] || null;
}

async function deleteStep(stepId) {
  const r = await getPool().query(`DELETE FROM campaign_steps WHERE id=$1 RETURNING id`, [stepId]);
  return r.rowCount > 0;
}

// ── A/B: выбрать стики-вариант по весам ──────────────────────────────
function pickVariant(variants) {
  if (!Array.isArray(variants) || !variants.length) return null;
  const total = variants.reduce((a, v) => a + (Number(v.weight) > 0 ? Number(v.weight) : 1), 0);
  let x = Math.random() * total;
  for (const v of variants) { x -= (Number(v.weight) > 0 ? Number(v.weight) : 1); if (x <= 0) return v.variant || 'A'; }
  return variants[0].variant || 'A';
}

// Контент шага с учётом A/B-варианта клиента.
function stepContent(step, variant) {
  if (Array.isArray(step.variants) && step.variants.length && variant) {
    const v = step.variants.find(x => (x.variant || 'A') === variant);
    if (v) return { body: v.body ?? step.body, template_key: v.template_key ?? step.template_key };
  }
  return { body: step.body, template_key: step.template_key };
}

// ── Запуск цепочки: зачисляем аудиторию ──────────────────────────────
async function enroll(campaignId) {
  const pool = getPool();
  const c = (await pool.query(`SELECT * FROM campaigns WHERE id=$1`, [campaignId])).rows[0];
  if (!c) throw new Error('not-found');
  if (c.type !== 'drip') throw new Error('not-a-drip');
  if (c.status === 'running' || c.status === 'done') throw new Error('already-' + c.status);

  const steps = await listSteps(campaignId);
  if (!steps.length) throw new Error('no-steps');
  const hasAB = steps.some(s => Array.isArray(s.variants) && s.variants.length);

  const segment = c.segment_id
    ? (await pool.query(`SELECT * FROM segments WHERE id=$1`, [c.segment_id])).rows[0]
    : { type: 'preset', preset_key: c.preset_key };
  if (!segment) throw new Error('segment-not-found');
  const members = await seg.membersOf(segment, { limit: 5000 });

  // первый шаг: next_run_at = now + delay первого шага
  const firstDelay = steps[0].delay_hours || 0;
  let enrolled = 0;
  for (const m of members) {
    const variant = hasAB ? pickVariant(steps.find(s => s.variants)?.variants) : null;
    const r = await pool.query(
      `INSERT INTO campaign_enrollments(campaign_id, client_id, current_step, status, variant, next_run_at, entered_at)
       VALUES ($1,$2,0,'active',$3, NOW() + ($4 || ' hours')::interval, NOW())
       ON CONFLICT (campaign_id, client_id) DO NOTHING RETURNING id`,
      [campaignId, m.id, variant, String(firstDelay)]);
    if (r.rowCount) enrolled++;
  }
  await pool.query(
    `UPDATE campaigns SET status='running', launched_at=NOW(), audience_size=$2, updated_at=NOW() WHERE id=$1`,
    [campaignId, enrolled]);
  return { audience: members.length, enrolled };
}

// Сделал ли клиент конверсию (запись) после входа в цепочку?
async function convertedSince(clientId, since) {
  const r = await getPool().query(
    `SELECT 1 FROM appointments WHERE client_id=$1 AND created_at >= $2 AND status = ANY($3) LIMIT 1`,
    [clientId, since, ACTIVE_APPT]);
  return r.rowCount > 0;
}

// ── Тик планировщика: обработать готовые enrollment'ы ────────────────
let _dripRunning = false;
async function processDrip(limit = 200) {
  if (_dripRunning) return { skipped: 'busy' };
  _dripRunning = true;
  const pool = getPool();
  let sent = 0, exited = 0, completed = 0, skipped = 0;
  try {
    const due = (await pool.query(
      `SELECT e.*, c.exit_on_conversion, c.channel AS camp_channel, c.vars AS camp_vars
         FROM campaign_enrollments e
         JOIN campaigns c ON c.id = e.campaign_id
        WHERE e.status='active' AND e.next_run_at IS NOT NULL AND e.next_run_at <= NOW()
        ORDER BY e.next_run_at ASC LIMIT $1`, [limit])).rows;

    for (const e of due) {
      const steps = await listSteps(e.campaign_id);
      const nextNo = (e.current_step || 0) + 1;
      const step = steps.find(s => s.step_number === nextNo && s.is_active !== false);

      // конверсия → выход (если включено на кампании)
      const converted = await convertedSince(e.client_id, e.entered_at);
      if (converted && e.exit_on_conversion) {
        await pool.query(`UPDATE campaign_enrollments SET status='exited', exit_reason='converted', converted_at=NOW(), updated_at=NOW() WHERE id=$1`, [e.id]);
        exited++; continue;
      }
      // цепочка закончилась
      if (!step) {
        await pool.query(`UPDATE campaign_enrollments SET status='completed', updated_at=NOW() WHERE id=$1`, [e.id]);
        completed++; continue;
      }

      // условие шага
      const cond = step.condition_type || 'none';
      const passCond =
        cond === 'converted' ? converted :
        cond === 'not_converted' ? !converted : true; // none/clicked/not_clicked → пропуск

      if (passCond) {
        const { body, template_key } = stepContent(step, e.variant);
        const ch = (step.channel && step.channel !== 'any') ? step.channel
                 : (e.camp_channel && e.camp_channel !== 'any' ? e.camp_channel : undefined);
        const r = await hub.enqueue({
          clientId: e.client_id,
          channel: ch,
          templateKey: template_key || undefined,
          body: template_key ? undefined : body,
          vars: { ...(e.camp_vars || {}), ...(step.vars || {}) },
          category: 'marketing', priority: 'low',
          source: 'campaign:' + e.campaign_id,
          dedupKey: `drip:${e.campaign_id}:client:${e.client_id}:step:${step.step_number}`,
        });
        if (r.id) sent++; else skipped++;
      } else { skipped++; }

      // двигаем на следующий шаг
      const nextStep = steps.find(s => s.step_number === nextNo + 1 && s.is_active !== false);
      if (nextStep) {
        await pool.query(
          `UPDATE campaign_enrollments
             SET current_step=$2, last_step_at=NOW(), enqueued=enqueued+$3,
                 next_run_at=NOW() + ($4 || ' hours')::interval, updated_at=NOW()
           WHERE id=$1`,
          [e.id, nextNo, passCond ? 1 : 0, String(nextStep.delay_hours || 0)]);
      } else {
        await pool.query(
          `UPDATE campaign_enrollments
             SET current_step=$2, last_step_at=NOW(), enqueued=enqueued+$3,
                 status='completed', next_run_at=NULL, updated_at=NOW()
           WHERE id=$1`,
          [e.id, nextNo, passCond ? 1 : 0]);
        completed++;
      }
    }
    return { due: due.length, sent, exited, completed, skipped };
  } finally { _dripRunning = false; }
}

// Воронка прохождения по шагам + сводка статусов.
async function funnel(campaignId) {
  const pool = getPool();
  const byStatus = (await pool.query(
    `SELECT status, COUNT(*)::int n FROM campaign_enrollments WHERE campaign_id=$1 GROUP BY status`, [campaignId])).rows;
  const byStep = (await pool.query(
    `SELECT current_step, COUNT(*)::int n FROM campaign_enrollments WHERE campaign_id=$1 GROUP BY current_step ORDER BY current_step`, [campaignId])).rows;
  const steps = await listSteps(campaignId);
  const reached = steps.map(s => ({
    step_number: s.step_number,
    // достигли шага = current_step >= step_number
    reached: byStep.filter(r => r.current_step >= s.step_number).reduce((a, r) => a + r.n, 0),
  }));
  const status = {}; byStatus.forEach(r => status[r.status] = r.n);
  return { campaign_id: Number(campaignId), by_status: status, by_step: byStep, step_funnel: reached };
}

module.exports = {
  listSteps, addStep, updateStep, deleteStep,
  enroll, processDrip, funnel, pickVariant, stepContent,
};
