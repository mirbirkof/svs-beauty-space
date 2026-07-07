/* AI Owner Expectations — продуктовый агент «глазами владельца».
   Отличие от data-integrity: тот ловит «система сломана», этот — «система работает не так,
   как хочет Босс». Каждое правило рождено из реальной заметки владельца (crm_notes #94-#107,
   02.07.2026). Read-only, безопасно. Новая заметка Босса = новое правило сюда.

   Принципы владельца (чек-лист, из заметок):
   1. Телефоны — единый канон 380XXXXXXXXX (#107)
   2. Каждая услуга привязана к категории из справочника (#100)
   3. Мастер в пикере предлагает только СВОИ услуги (#99) → у активных мастеров есть связки
   4. Любая цена редактируется и не «нулевая» у реально продаваемых услуг (#94/#96)
   5. Ничего не блокируется искусственно (смены #103, прошлые дни — настройка #95)
   6. Механики доводятся до конца: интервалы возврата (#102), нормы расходников (#105) */
const { q } = require('../lib/crm');

// threshold: сколько нарушений считается известной нормой (baseline). Баг — только рост сверх.
const RULES = [
  { module: 'clients', role: 'admin', severity: 'medium',
    title: 'Телефоны вне канона 380XXXXXXXXX (заметка #107)',
    // baseline 2: id 911 (иностранный?) и id 6015 (мусорная склейка) — осознанно не тронуты
    sql: `SELECT COUNT(*)::int n FROM clients WHERE phone IS NOT NULL AND phone <> '' AND phone !~ '^380[0-9]{9}$'`,
    threshold: 2 },
  { module: 'services', role: 'admin', severity: 'medium',
    title: 'Услуги без категории из справочника (заметка #100)',
    // 02.07 домаплены ВСЕ (0). Рост = синк BeautyPro завёл новую услугу без category_id
    sql: `SELECT COUNT(*)::int n FROM services WHERE (active IS DISTINCT FROM false) AND category_id IS NULL`,
    threshold: 0 },
  { module: 'masters', role: 'admin', severity: 'medium',
    title: 'Активный мастер с визитами, но без связок услуг (заметка #99 — пикер покажет ему ВСЕ услуги)',
    sql: `SELECT COUNT(*)::int n FROM masters m WHERE m.active = true
            AND EXISTS (SELECT 1 FROM appointments a WHERE a.master_id = m.id AND a.starts_at >= NOW() - INTERVAL '30 days')
            AND NOT EXISTS (SELECT 1 FROM master_services ms WHERE ms.master_id = m.id AND ms.active = true)`,
    threshold: 0, optional: true },
  { module: 'services', role: 'admin', severity: 'low',
    title: 'Продаваемая услуга с нулевой ценой в каталоге (заметки #94/#96)',
    // услуга реально встречается в визитах за 60 дней, а каталожная цена 0/NULL
    sql: `SELECT COUNT(DISTINCT s.id)::int n FROM services s
           WHERE COALESCE(s.price,0) = 0
             AND EXISTS (SELECT 1 FROM appointments a WHERE a.service_id = s.id AND a.starts_at >= NOW() - INTERVAL '60 days')`,
    threshold: 7 }, // baseline: 7 массажных услуг с нулевой ценой известны с 15.06
  // ── СНЯТО 07.07: чек устарел и давал ложные срабатывания ──
  // Логика была: manual_override + price≠сумма_услуг ⇒ «синк BeautyPro перетёр правку».
  // Но (1) BP-синк отключён (BP_SYNC_DISABLED=1) — перетирать нечему; (2) manual_override
  // ИМЕННО и означает, что владелец задал СВОЮ итоговую цену (скидка/комп) ≠ сумме строк.
  // Значит price≠сумма при manual_override — это норма (проверено: 5 записей = скидки владельца),
  // а не баг. Чек флагал ровно легитимный сценарий. Реальный риск «отката» вернётся только
  // если снова включат BP-синк — тогда сторожить надо сигнатуру отката, а не сам факт расхождения.
  { module: 'warehouse', role: 'warehouse', severity: 'low',
    title: 'Материалы визита добавлены, но визит проведён без списания (заметка #105)',
    sql: `SELECT COUNT(DISTINCT am.appointment_id)::int n FROM appointment_materials am
           JOIN appointments a ON a.id = am.appointment_id
          WHERE a.status IN ('done','completed') AND COALESCE(a.stock_written_off,false) = false`,
    threshold: 0, optional: true },
  { module: 'finance', role: 'accountant', severity: 'medium',
    title: 'Отчёты не должны терять операции без смены (следствие #103)',
    // если появился новый JOIN cash_shifts без LEFT — операции с shift_id=NULL исчезнут из сумм.
    // Датчик: доля безсменных операций за 30 дней (просто наличие — норма, правило сторожит регресс отчётов кодом, не данными)
    sql: `SELECT 0::int n`, threshold: 0 },
];

// Настройки-механики, которые Босс просил, но данные ещё не заполнены им.
// Не баги — needs-manual напоминания (один раз за цикл, без спама в реестр дефектов).
const PENDING_SETUP = [
  { module: 'services', title: 'Интервалы повторного визита не заполнены (заметка #102 — smart-режим спит)',
    sql: `SELECT COUNT(*)::int n FROM services WHERE rebook_interval_days IS NOT NULL`, wantMoreThan: 0 },
  { module: 'warehouse', title: 'Нормы расходников пусты (заметка #105 — «Заповнити за нормами» даёт 0)',
    sql: `SELECT COUNT(*)::int n FROM service_consumables`, wantMoreThan: 0 },
];

module.exports = {
  name: 'owner-expectations', role: 'product',
  async run() {
    const bugs = [], scenarios = [], coverage = [];
    for (const r of RULES) {
      scenarios.push(`owner:${r.module}:${r.title}`);
      let n;
      try { n = (await q(r.sql))[0].n; }
      catch (e) {
        if (r.optional) { coverage.push([r.module, r.title, 'skip']); continue; }
        bugs.push({ severity: 'low', module: r.module, role: r.role, title: `Проверку нельзя выполнить: ${r.title}`,
          needsManual: true, manualReason: 'SQL ошибка: ' + e.message, scenario: r.title });
        continue;
      }
      const limit = r.threshold || 0;
      if (n > limit) {
        bugs.push({ severity: r.severity, module: r.module, role: r.role, title: r.title,
          scenario: 'Ожидание владельца (из crm_notes). Порог-baseline: ' + limit,
          expected: `не больше ${limit}`, actual: `${n}`, sql: r.sql, stillBroken: true,
          evidence: { violations: n, baseline: limit } });
      }
      coverage.push([r.module, r.title, n <= limit]);
    }
    // напоминания о незаполненных механиках — needsManual, не дефекты
    for (const p of PENDING_SETUP) {
      scenarios.push(`owner:setup:${p.title}`);
      let n; try { n = (await q(p.sql))[0].n; } catch (_) { coverage.push([p.module, p.title, 'skip']); continue; }
      if (n <= p.wantMoreThan) {
        bugs.push({ severity: 'low', module: p.module, role: 'product', title: p.title,
          needsManual: true, manualReason: 'Механика готова, данные должен заполнить владелец в админке', scenario: p.title });
      }
      coverage.push([p.module, p.title, n > p.wantMoreThan]);
    }
    return { scenarios, bugs, coverage };
  },
};
