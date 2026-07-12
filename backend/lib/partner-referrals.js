/* Партнёрская программа «приведи салон» (рост SaaS).
 * Реферер приглашает салон по своему коду. Приглашённый оплачивает первый счёт →
 * реферер получает награду (+N дней подписки). Платформенные таблицы без tenant-RLS —
 * связь МЕЖДУ салонами; работаем под владельческим пулом (getPool в runAs(null)/платформа). */
const { getPool } = require('../db-pg');

async function getSettings() {
  const r = await getPool().query(`SELECT * FROM partner_program_settings WHERE id=1`);
  return r.rows[0] || { enabled: true, reward_type: 'days', reward_value: 30, referred_bonus_days: 14 };
}

// Реф-код салона (для ссылки /signup?ref=CODE). Бэкфилл в 259, но добираем на лету.
async function getReferralCode(tenantId) {
  const pool = getPool();
  let r = (await pool.query(`SELECT referral_code FROM tenants WHERE id=$1`, [tenantId])).rows[0];
  if (r && r.referral_code) return r.referral_code;
  const code = String(tenantId).replace(/-/g, '').slice(0, 8).toUpperCase();
  await pool.query(`UPDATE tenants SET referral_code=$2 WHERE id=$1 AND referral_code IS NULL`, [tenantId, code]);
  return code;
}

// Разрешить реф-код в tenant_id реферера.
async function resolveReferrer(refCode) {
  if (!refCode) return null;
  const r = (await getPool().query(
    `SELECT id FROM tenants WHERE referral_code=$1 LIMIT 1`, [String(refCode).trim().toUpperCase()])).rows[0];
  return r ? r.id : null;
}

// Зафиксировать переход по рефералке при создании нового салона.
// Вызывается из public-signup ПОСЛЕ createTenant, если был ?ref=.
async function registerReferral(refCode, newTenantId, newTenantName) {
  const s = await getSettings();
  if (!s.enabled) return null;
  const referrerId = await resolveReferrer(refCode);
  if (!referrerId || referrerId === newTenantId) return null; // нельзя пригласить себя
  try {
    const r = await getPool().query(
      `INSERT INTO partner_referrals (referrer_tenant_id, referred_tenant_id, ref_code, status,
         reward_type, reward_value, referred_name)
       VALUES ($1,$2,$3,'pending',$4,$5,$6)
       ON CONFLICT (referred_tenant_id) WHERE referred_tenant_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [referrerId, newTenantId, String(refCode).toUpperCase(), s.reward_type, s.reward_value, newTenantName || null]);
    return r.rows[0] ? r.rows[0].id : null;
  } catch (e) { console.error('[partner:register]', e.message); return null; }
}

// Приглашённый салон оплатил первый счёт → квалифицируем и награждаем реферера.
// Вызывается из billing.recordPayment при первой успешной оплате подписки.
async function onReferredPaid(referredTenantId) {
  const pool = getPool();
  // Атомарно захватываем реферал: UPDATE ... WHERE status='pending' RETURNING — только ОДИН
  // из параллельных вызовов переведёт pending→qualified и получит строку. Второй получит
  // 0 строк и выйдет → награда не начисляется дважды (гонка двух Mono-вебхуков одного салона).
  const ref = (await pool.query(
    `UPDATE partner_referrals SET status='qualified', qualified_at=now()
      WHERE referred_tenant_id=$1 AND status='pending' RETURNING *`,
    [referredTenantId])).rows[0];
  if (!ref) return null;
  try {
    if (ref.reward_type === 'days') {
      // +N дней к текущему периоду подписки реферера (и к лицензии — доступ)
      const days = Math.round(Number(ref.reward_value) || 30);
      await pool.query(
        `UPDATE subscriptions_saas SET current_period_end = GREATEST(current_period_end, now()) + ($2||' days')::interval,
                updated_at=now() WHERE tenant_id=$1`, [ref.referrer_tenant_id, days]);
      await pool.query(
        `UPDATE tenant_licenses SET expires_at = GREATEST(COALESCE(expires_at, now()), now()) + ($2||' days')::interval
          WHERE tenant_id=$1`, [ref.referrer_tenant_id, days]).catch(() => {});
    }
    await pool.query(`UPDATE partner_referrals SET status='rewarded', rewarded_at=now() WHERE id=$1`, [ref.id]);
    console.log(`[partner:reward] referrer=${ref.referrer_tenant_id} +${ref.reward_value} ${ref.reward_type} за ${referredTenantId}`);
  } catch (e) { console.error('[partner:reward]', e.message); }
  return ref.id;
}

// Сводка для салона: его код, ссылка, приглашённые, начисленная награда.
async function summaryFor(tenantId, baseUrl) {
  const code = await getReferralCode(tenantId);
  const pool = getPool();
  const rows = (await pool.query(
    `SELECT referred_name, status, reward_type, reward_value, created_at, qualified_at
       FROM partner_referrals WHERE referrer_tenant_id=$1 ORDER BY created_at DESC LIMIT 100`,
    [tenantId])).rows;
  const rewarded = rows.filter(r => r.status === 'rewarded');
  const s = await getSettings();
  return {
    enabled: s.enabled,
    code,
    link: (baseUrl || '') + '/signup?ref=' + code,
    reward_text: s.reward_type === 'days' ? `+${s.reward_value} днів підписки за кожен оплачений салон` : `${s.reward_value} винагорода`,
    invited: rows.length,
    qualified: rows.filter(r => ['qualified', 'rewarded'].includes(r.status)).length,
    rewarded_count: rewarded.length,
    rewarded_days: s.reward_type === 'days' ? rewarded.reduce((a, r) => a + Number(r.reward_value || 0), 0) : 0,
    list: rows,
  };
}

module.exports = { getSettings, getReferralCode, resolveReferrer, registerReferral, onReferredPaid, summaryFor };
