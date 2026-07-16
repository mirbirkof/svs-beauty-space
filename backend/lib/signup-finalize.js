/* lib/signup-finalize.js — единая финализация регистрации (Босс 16.07.2026).
 * Вынесено из routes/public-signup.js, чтобы одну и ту же логику вызывали:
 *   - прямой путь (устаревающий),
 *   - путь ПОСЛЕ верификации телефона через Telegram.
 * Идемпотентность: если data.tenant_id уже задан — салон создан, повторно не создаём.
 * Вход: провалидированные поля (см. buildSignupData). Возврат: объект логина.
 */
const tm = require('./tenant-mgmt');

async function finalizeSignup(data) {
  const {
    salonName, ownerName, phone, password_hash, email,
    accountType, planCode, cycle, needTrial, country, lang, refCode, consentIp,
  } = data;

  // createTenant умеет принять готовый хеш (passwordHash) или пароль. Передаём хеш.
  const r = await tm.createTenant(salonName, {
    phone, passwordHash: password_hash, owner_name: ownerName, email,
    plan_code: planCode, cycle, trial: needTrial, country, lang,
  }, { id: null, source: 'public-signup-verified' });

  const { getPool } = require('../db-pg');
  // GDPR: доказательство согласия
  try {
    await getPool().query(
      `UPDATE tenants SET consent_given_at = NOW(), consent_source = $2, consent_ip = $3, consent_version = $4 WHERE id = $1`,
      [r.tenant.id, 'public-signup', consentIp || null, 'offer+dpa-2026-07']);
  } catch (e) { console.error('[signup-finalize/consent]', e.message); }

  // Партнёрская программа
  try {
    if (refCode) await require('./partner-referrals').registerReferral(refCode, r.tenant.id, salonName);
  } catch (e) { console.error('[signup-finalize/referral]', e.message); }

  // Лицензия онлайн-записи
  try {
    const mod = await getPool().query(`SELECT id, trial_days FROM module_catalog WHERE code = 'online_booking'`);
    if (mod.rowCount) {
      await getPool().query(
        `INSERT INTO licenses (tenant_id, module_id, license_type, status, activated_at, expires_at)
         VALUES ($1, $2, $3, 'active', NOW(), $4) ON CONFLICT DO NOTHING`,
        [r.tenant.id, mod.rows[0].id, needTrial ? 'trial' : 'subscription',
         needTrial ? new Date(Date.now() + (Number(mod.rows[0].trial_days) || 14) * 864e5) : null]);
    }
  } catch (e) { console.error('[signup-finalize/license]', e.message); }

  // Мастер-одиночка: карточка мастера + соло-режим + дефолтный график
  if (accountType === 'solo') {
    try {
      const { runAs } = require('./tenant');
      await runAs(r.tenant.id, async () => {
        const pool = getPool();
        await pool.query(
          `INSERT INTO masters (name, phone, specialty, active, provides_services)
           VALUES ($1, $2, NULL, true, true) ON CONFLICT DO NOTHING`, [ownerName, phone]);
        await pool.query(
          `UPDATE users u SET master_id = m.id FROM masters m
            WHERE m.phone = $1 AND u.phone = $1 AND u.master_id IS NULL`, [phone]);
        const { setSetting } = require('./settings');
        await setSetting('solo_master_mode', true, null);
        await pool.query(`UPDATE tenant_onboarding SET account_type='solo' WHERE tenant_id=$1`, [r.tenant.id]);
        try { await tm.completeStep(r.tenant.id, 'employees'); } catch (_) {}
        await pool.query(
          `INSERT INTO master_schedule_days (master_id, work_date, start_time, end_time, source)
           SELECT m.id, gs::date, '09:00', '18:00', 'signup-default'
             FROM masters m, generate_series(CURRENT_DATE, CURRENT_DATE + 89, '1 day') gs
            WHERE m.phone = $1 AND EXTRACT(ISODOW FROM gs) < 7
           ON CONFLICT DO NOTHING`, [phone]);
      });
    } catch (e) { console.error('[signup-finalize/solo]', e.message); }
  }

  return {
    ok: true, slug: r.slug, salon_name: r.tenant.name, tenant_id: r.tenant.id,
    login: { phone, tenant_slug: r.slug, header: 'X-Tenant-Slug: ' + r.slug },
    login_url: '/admin/?tenant=' + encodeURIComponent(r.slug),
    subscription: r.subscription,
    trial_ends_at: r.subscription ? r.subscription.trial_ends_at : null,
  };
}

module.exports = { finalizeSignup };
