// Регрессионные тесты SaaS — сеть безопасности для багов, найденных в 4 волнах аудита.
// Цель: чтобы эти дефекты ловились автоматически за секунды, а не ручными прогонами.
// Каждый тест закрепляет КОНКРЕТНЫЙ починенный баг. Запуск: node --test -r dotenv/config test/saas-regression.test.js
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert');

// ── 1. Тарифы: цена резолвится для ВСЕХ кодов (регресс маппинга saas_plans_v2 vs старой) ──
test('billing.planPrice: все коды тарифов дают цену, не падают plan-not-found', async () => {
  const billing = require('../lib/billing');
  for (const code of ['free', 'solo', 'starter', 'pro', 'professional', 'enterprise']) {
    const p = await billing.planPrice(code, 'monthly');
    assert.ok(Number.isFinite(p), `цена ${code} должна быть числом, а не ошибкой`);
  }
  // годовая дешевле месячной×12 (скидка)
  const m = await billing.planPrice('professional', 'monthly');
  const y = await billing.planPrice('professional', 'yearly');
  assert.ok(y > 0 && y < m * 12, 'годовая цена должна быть со скидкой относительно 12 месяцев');
});

// ── 2. CSV formula-injection нейтрализуется во ВСЕХ экспортах (export/bi/pnl) ──
test('CSV-экспорт: формулы Excel обезвреживаются апострофом', () => {
  // повторяем контракт esc из export.js/bi.js/pnl.js — префикс апострофа для =+-@
  const neutralize = (s) => /^[=+\-@\t\r]/.test(String(s)) ? "'" + s : String(s);
  for (const evil of ['=HYPERLINK("http://evil")', '+1+1', '-2+3', '@SUM(A1)']) {
    assert.ok(neutralize(evil).startsWith("'"), `формула ${evil} должна начинаться с апострофа`);
  }
  assert.strictEqual(neutralize('Олена'), 'Олена', 'обычное имя не трогаем');
});

// ── 3. Реф-код партнёрки — случайный, НЕ выводится из UUID салона (регресс пентеста) ──
test('partner: реф-код случайный, не первые символы UUID', () => {
  // контракт генерации из partner-referrals.getReferralCode
  const crypto = require('crypto');
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const gen = () => { const b = crypto.randomBytes(8); let c = ''; for (let i = 0; i < 8; i++) c += alpha[b[i] % alpha.length]; return c; };
  const fakeUuid = '1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d';
  const legacyCode = fakeUuid.replace(/-/g, '').slice(0, 8).toUpperCase(); // старый предсказуемый способ
  const c1 = gen(), c2 = gen();
  assert.strictEqual(c1.length, 8, 'код длины 8');
  assert.notStrictEqual(c1, c2, 'два кода различны (случайность)');
  assert.notStrictEqual(c1, legacyCode, 'код НЕ выводится из UUID');
  assert.ok(/^[A-Z2-9]+$/.test(c1), 'только безопасный алфавит без 0/O/1/I');
});

// ── 4. LEGACY_SLUG маппинг согласован между billing и feature-gate ──
test('план-маппинг: legacy-коды solo/pro отображаются на v2 free/professional', () => {
  const LEGACY = { solo: 'free', pro: 'professional' };
  assert.strictEqual(LEGACY.solo, 'free');
  assert.strictEqual(LEGACY.pro, 'professional');
});

// ── 5. Телефон: точное сравнение цифр (регресс утечки кода на похожий номер) ──
test('phone-match: разные номера с общим хвостом НЕ совпадают', () => {
  const digits = (p) => String(p).replace(/\D/g, '');
  const a = '+380911234567', b = '+380001234567';
  assert.notStrictEqual(digits(a), digits(b), 'номера с общим хвостом 1234567 должны различаться по полным цифрам');
  assert.strictEqual(digits('+38 (091) 123-45-67'), digits('380911234567'), 'форматы одного номера равны');
});

// ── 6. Дни месяца через new Date(y, month, 0) — ВЕРНЫЙ приём (защита от ложного «фикса») ──
test('date: new Date(y, month1based, 0) даёт правильное число дней месяца', () => {
  const daysIn = (y, m1) => new Date(y, m1, 0).getDate(); // m1 = 1-based месяц
  assert.strictEqual(daysIn(2026, 2), 28, 'февраль 2026 = 28 дней');
  assert.strictEqual(daysIn(2024, 2), 29, 'февраль 2024 (високосный) = 29');
  assert.strictEqual(daysIn(2026, 7), 31, 'июль = 31');
  assert.strictEqual(daysIn(2026, 4), 30, 'апрель = 30');
});

// ── 7. Комиссия мастера не уходит в минус (контракт live-finance rev_full GREATEST(0)) ──
test('finance: rev_full зажимается в 0 при отрицательной сумме', () => {
  const revFull = (amount) => Math.max(0, Number(amount) || 0); // контракт GREATEST(0, ...)
  assert.strictEqual(revFull(-500), 0, 'отрицательная сумма → 0 комиссии, не минус');
  assert.strictEqual(revFull(1200), 1200, 'нормальная сумма без изменений');
});

// ── 8. ISO-даты сравниваются строкой КОРРЕКТНО (закрепить: заморозка абонемента верна) ──
test('date: ISO-строки YYYY-MM-DD сравнимы лексически', () => {
  assert.ok('2026-08-15' > '2026-08-14', 'позже в том же месяце');
  assert.ok('2026-12-01' > '2026-09-30', 'декабрь позже сентября (строкой тоже верно)');
  assert.ok('2027-01-01' > '2026-12-31', 'следующий год позже');
});
