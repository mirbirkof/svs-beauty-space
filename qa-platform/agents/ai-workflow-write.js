/* AI Administrator/Client (ДЕСТРУКТИВНЫЙ, только QA-ветка) — полный цикл с РЕАЛЬНОЙ записью.
   Лид → клиент → запись → проведение → касса → проверка целостности → очистка.
   Пишет ТОЛЬКО в изолированную Neon-ветку (qaQ). Никогда не касается прода. Самоочистка после прогона. */
const { qaQ } = require('../lib/crm');
const cfg = require('../config');

module.exports = {
  name: 'ai-workflow-write', role: 'administrator',
  async run({ regression } = {}) {
    const scenarios = [], bugs = [], coverage = [];
    if (!cfg.allowDestructive) {
      return { scenarios: ['workflow-write:gated'], coverage: [['workflow', 'write-cycle', 'skip']],
        bugs: [{ severity: 'low', module: 'workflow', role: 'administrator', title: 'Полный workflow с записью не выполнен (нет QA-ветки)', needsManual: true, manualReason: 'QA_DB_URL не задан' }] };
    }
    if (regression) return { scenarios: [], bugs: [], coverage: [] };

    const tag = 'QATEST_' + Date.now();
    let clientId = null, apptId = null;
    try {
      // 1) Лид → клиент
      scenarios.push('workflow:create-client');
      clientId = (await qaQ(`INSERT INTO clients (name, phone) VALUES ($1,$2) RETURNING id`, [tag, '+380000' + (Date.now() % 1000000)]))[0].id;
      coverage.push(['workflow', 'create-client', !!clientId]);

      // 2) Запись (берём реального мастера из ветки)
      scenarios.push('workflow:create-appointment');
      const master = (await qaQ(`SELECT id FROM masters WHERE active IS NOT FALSE LIMIT 1`))[0];
      apptId = (await qaQ(
        `INSERT INTO appointments (client_id, master_id, starts_at, ends_at, status, price)
         VALUES ($1,$2, NOW()+INTERVAL '1 hour', NOW()+INTERVAL '2 hours', 'booked', 500) RETURNING id`,
        [clientId, master?.id || null]))[0].id;
      coverage.push(['workflow', 'create-appointment', !!apptId]);

      // 3) Проведение визита
      scenarios.push('workflow:complete-appointment');
      await qaQ(`UPDATE appointments SET status='done', real_amount=500 WHERE id=$1`, [apptId]);
      const done = (await qaQ(`SELECT status, real_amount FROM appointments WHERE id=$1`, [apptId]))[0];
      if (done.status !== 'done') bugs.push({ severity: 'high', module: 'workflow', role: 'administrator',
        title: 'Проведение визита не сохранило статус done', scenario: 'UPDATE status=done', expected: 'done', actual: done.status, stillBroken: true });
      coverage.push(['workflow', 'complete-appointment', done.status === 'done']);

      // 4) Касса по визиту
      scenarios.push('workflow:cash-operation');
      await qaQ(`INSERT INTO cash_operations (type, category, amount, method, ref_type, master_id, ext_ref, created_at)
                 VALUES ('in','sale_service',500,'cash','qa_test',$1,$2,NOW())`, [master?.id || null, tag]);
      const cash = (await qaQ(`SELECT COALESCE(SUM(amount),0)::int s FROM cash_operations WHERE ext_ref=$1`, [tag]))[0].s;
      if (cash !== 500) bugs.push({ severity: 'high', module: 'workflow', role: 'accountant',
        title: 'Касса по тестовому визиту не сошлась', scenario: 'INSERT cash 500 → SUM', expected: '500', actual: String(cash), stillBroken: true });
      coverage.push(['workflow', 'cash-recorded', cash === 500]);

    } catch (e) {
      bugs.push({ severity: 'critical', module: 'workflow', role: 'administrator',
        title: 'Полный workflow упал с ошибкой', scenario: 'lead→client→appointment→done→cash',
        expected: 'цикл проходит', actual: e.message, errorStack: e.stack, stillBroken: true });
    } finally {
      // 5) Самоочистка — тестовые данные не копятся даже в QA-ветке
      try {
        await qaQ(`DELETE FROM cash_operations WHERE ext_ref=$1`, [tag]);
        if (apptId) await qaQ(`DELETE FROM appointments WHERE id=$1`, [apptId]);
        if (clientId) await qaQ(`DELETE FROM clients WHERE id=$1`, [clientId]);
        scenarios.push('workflow:cleanup');
        coverage.push(['workflow', 'self-cleanup', true]);
      } catch (_) { /* очистка best-effort */ }
    }
    return { scenarios, bugs, coverage };
  },
};
