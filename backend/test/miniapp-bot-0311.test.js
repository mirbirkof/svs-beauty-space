// Бот @Svs_beautybot після Mini App (Босс 03.11), на QA через дочірній харнес (_miniapp-bot-harness.js):
//  • /start нового клієнта → кнопка web_app на /p/app.html; вільний текст → ввічлива відповідь + web_app;
//  • відкат BOT_TEXT_BOOKING=1 (salon.miniapp=false) → старий текстовий сценарій, без web_app;
//  • власник → «👑» і те саме меню керування в обох режимах.
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const QA_URL = process.env.QA_DB_URL;
let R = null;
function harness() {
  if (R) return R;
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test',
    DATABASE_URL: QA_URL, QA_DB_URL: QA_URL, QA_STAGING: '1', CRM_DEFER_JOBS: '1',
    TELEGRAM_BOT_TOKEN: '', TELEGRAM_NOTIFY_TOKEN: '', ADMIN_TG_CHAT: '', MONO_TOKEN: '',
    PUBLIC_BASE_URL: 'https://qa.example.test', HARNESS_UID: String(7800000000 + Math.floor(Math.random() * 99999999)) };
  const r = spawnSync(process.execPath, [path.join(__dirname, '_miniapp-bot-harness.js')], { env, encoding: 'utf8', timeout: 90000 });
  const line = (r.stdout || '').split('\n').find(l => l.startsWith('RESULT='));
  assert.ok(line, 'харнес не віддав результат: ' + (r.stderr || '').split('\n').filter(l => !/ssl|libpq|postgresql\.org|trace-warn|prepare for/i.test(l)).join('\n'));
  R = JSON.parse(line.replace(/^RESULT=/, ''));
  return R;
}

test('/start і /menu клієнта → кнопка застосунку web_app', { skip: !QA_URL }, () => {
  const r = harness();
  assert.ok(r.startNew.n >= 1 && r.startNew.webApp && r.startNew.webAppUrlOk, JSON.stringify(r.startNew));
  assert.ok(r.menu.webApp, 'menu');
});

test('вільний текст → ввічлива відповідь з кнопкою застосунку', { skip: !QA_URL }, () => {
  const r = harness();
  assert.ok(r.freeText.n >= 1 && r.freeText.webApp, JSON.stringify(r.freeText));
});

test('старе нижнє меню («Записатись», «Мій кабінет») → клавіатура прибрана, ОДНЕ видиме повідомлення з кнопкою застосунку', { skip: !QA_URL }, () => {
  const r = harness();
  for (const k of ['oldMenuBook', 'oldMenuCab']) {
    const x = r[k];
    assert.ok(x.removeKb && x.webApp && x.visible === 1 && x.edits === 0, k + ' ' + JSON.stringify(x));
  }
});

test('кнопки нагадування: Буду / Перенести (у застосунок) / Скасувати; чужий запис не скасувати', { skip: !QA_URL }, () => {
  const x = harness().remind;
  assert.ok(!x.error, x.error);
  assert.match(x.ok.txt, /Дякуємо за підтвердження/);
  assert.ok(x.mv.webApp && /move=/.test(x.mv.txt), x.mv.txt);
  assert.match(x.foreign.txt, /неактуальний/); assert.strictEqual(x.foreignStatus, 'booked');
  assert.match(x.cn.txt, /Запис скасовано/); assert.strictEqual(x.cnStatus, 'cancelled');
  assert.match(x.again.txt, /неактуальний/);
  assert.ok(x.startKnown.n >= 1 && x.startKnown.webApp, 'start відомого: ' + JSON.stringify(x.startKnown.texts));
  assert.ok(x.admin.n >= 1 && x.admin.contactAdmin, 'адміністратор: ' + JSON.stringify(x.admin.texts));
});

test('відкат BOT_TEXT_BOOKING=1 → старий текстовий запис без web_app', { skip: !QA_URL }, () => {
  const r = harness();
  assert.ok(r.startOld.n >= 1 && !r.startOld.webApp, JSON.stringify(r.startOld));
  assert.ok(r.freeTextOld.n >= 1 && !r.freeTextOld.webApp, JSON.stringify(r.freeTextOld));
});

test('власник → «👑» і те саме меню керування в обох режимах', { skip: !QA_URL }, (t) => {
  const r = harness();
  if (!r.ownerNew) { t.skip('у QA немає власника з telegram_id'); return; }
  assert.ok(r.ownerNew.owner && r.ownerOld.owner, 'привітання власника');
  assert.ok(r.ownerNew.ownerKb.length >= 5, JSON.stringify(r.ownerNew.ownerKb));
  assert.deepStrictEqual(r.ownerNew.ownerKb, r.ownerOld.ownerKb, 'меню не змінилось від Mini App');
  assert.ok(r.ownerNew.ownerKb.some(x => /Звіт/.test(x)) && r.ownerNew.ownerKb.some(x => /Каса/.test(x)));
});
