/* AI Booking Guard — самостоятельность онлайн-записи (без BeautyPro).
   Стережёт критичный фикс 02.07: подтверждённая онлайн-запись ОБЯЗАНА попадать
   в наш журнал appointments (иначе мастер её не видит). BeautyPro отключён — мы сами.
   Read-only против прода + HTTP-проверка каталога записи на staging. */
const { q } = require('../lib/crm');
const cfg = require('../config');

module.exports = {
  name: 'booking-independence', role: 'client',
  async run() {
    const bugs = [], scenarios = [], coverage = [];

    // 1) Записи-сироты: подтверждена в online_bookings, но НЕ появилась в журнале мастера.
    //    Смотрим только свежие (после фикса 02.07) — старые созданы до прямой вставки.
    scenarios.push('booking:confirmed-has-appointment');
    // Матчимо надійно: спершу за прямим звʼязком bp_appointment_id (переживає перенос часу),
    // потім за client+час. Скасований візит не рахуємо живим — але тоді і онлайн-запис має бути
    // 'cancelled' (це робить фікс у schedule.js при відміні). Тож 'confirmed' без живого візиту = діра.
    const orphan = await q(`
      SELECT COUNT(*)::int n FROM online_bookings ob
       WHERE ob.status = 'confirmed'
         AND ob.created_at > '2026-07-02 14:00+03'
         AND ob.date_from > NOW() - INTERVAL '30 days'
         AND NOT EXISTS (
           SELECT 1 FROM appointments a
            WHERE a.status NOT IN ('cancelled')
              AND ( (ob.bp_appointment_id ~ '^[0-9]+$' AND a.id = ob.bp_appointment_id::int)
                 OR (a.client_id = ob.client_id AND a.starts_at = ob.date_from) ))`).catch(() => [{ n: 0 }]);
    if (orphan[0].n > 0) bugs.push({ severity: 'high', module: 'booking', role: 'client',
      title: 'Онлайн-запись подтверждена, но не попала в журнал мастера',
      scenario: 'online_bookings.confirmed без пары в appointments',
      expected: 'каждая подтверждённая запись видна мастеру в расписании',
      actual: `${orphan[0].n} записей-сирот`, stillBroken: true, evidence: { count: orphan[0].n },
      fix: 'Проверить resolveBookingIds/вставку в appointments в routes/booking.js (блок после online_bookings INSERT)' });
    coverage.push(['booking', 'confirmed-in-journal', orphan[0].n === 0]);

    // 2) Каталог записи отвечает из НАШЕЙ БД (не зависит от BeautyPro)
    scenarios.push('booking:catalog-independent');
    let catalogOk = false;
    if (cfg.stagingApi) {
      try {
        const r = await fetch(`${cfg.stagingApi}/api/booking/catalog`, { signal: AbortSignal.timeout(10000) });
        const j = r.ok ? await r.json() : null;
        catalogOk = !!(j && (j.services?.length || j.masters?.length));
      } catch (_) { catalogOk = false; }
      if (!catalogOk) bugs.push({ severity: 'high', module: 'booking', role: 'client',
        title: 'Каталог онлайн-записи не отвечает (клиент не может выбрать услугу)',
        scenario: 'GET /api/booking/catalog на staging', expected: '200 + услуги/мастера из нашей БД',
        actual: 'пусто или ошибка', stillBroken: true });
      coverage.push(['booking', 'catalog-alive', catalogOk]);
    }

    // 3) Утечка внутренних ошибок: /booking/services не должен отдавать тело BeautyPro-ошибки
    scenarios.push('booking:no-upstream-leak');
    if (cfg.stagingApi) {
      let leak = false;
      try {
        const r = await fetch(`${cfg.stagingApi}/api/booking/services`, { signal: AbortSignal.timeout(10000) });
        const body = await r.text();
        leak = /BeautyPro \d|application id|apiary/i.test(body); // сырая ошибка апстрима наружу
      } catch (_) {}
      if (leak) bugs.push({ severity: 'medium', module: 'booking', role: 'security',
        title: 'Внутренняя ошибка BeautyPro утекает клиенту', scenario: 'GET /api/booking/services',
        expected: 'аккуратный 503 без деталей', actual: 'тело ошибки апстрима в ответе', stillBroken: true });
      coverage.push(['booking', 'no-error-leak', !leak]);
    }

    return { scenarios, bugs, coverage };
  },
};
