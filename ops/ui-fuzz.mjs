/**
 * ui-fuzz.mjs — РЕЖИМ «НЕПРОТОРЕННОЕ» (15.08, по замечанию Босса)
 *
 * ПРИЧИНА: core гоняет одни и те же инварианты, explore перебирает РУЧНУЮ матрицу из
 * 47 комбинаций — она давно исчерпана, и две недели «всё чисто» означают не здоровье
 * системы, а то, что мы перестали пробовать новое. Езда по колее не находит багов:
 * ломается обычно там, где никто не ходил.
 *
 * ЧТО ДЕЛАЕТ ИНАЧЕ: не берёт готовый список. Заходит на страницу, САМ находит все живые
 * элементы (кнопки, вкладки, фильтры, поля), выбирает те, что раньше не трогали, и дёргает
 * их в случайном порядке. Матрица растёт сама: каждый новый элемент интерфейса
 * автоматически становится непроверенной комбинацией.
 *
 * ЧТО СЧИТАЕТ ПОЛОМКОЙ: ошибка JS на странице, ответ сервера 5xx, «undefined/NaN/
 * [object Object]» на экране, пустой экран после действия.
 *
 * БЕЗОПАСНОСТЬ (прод — живой салон Босса): дёргаем только то, что НЕ меняет данные.
 * Чёрный список — удаление, оплата, проведение, списание, отправка, сохранение, выход.
 * Поля заполняем странными значениями, но НЕ сохраняем: цель — реакция интерфейса.
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { loginIntoPage } from './qa-login.mjs';

// 15.08: дефолт — ИЗОЛИРОВАННЫЙ тестовый инстанс (песочная Neon-ветка, порт 3037,
// поднят qa-platform/staging.js-паттерном), НЕ прод. Живая база Босса — только если
// её явно попросили через SMOKE_BASE.
const BASE = process.env.SMOKE_BASE || process.env.QA_FUZZ_BASE || 'http://127.0.0.1:3037';
const TOKEN = process.env.ADMIN_TOKEN;
// Реальный сотрудник для настоящего входа (см. ops/qa-login.mjs) — если не задан,
// откатываемся на старый способ (ADMIN_TOKEN в localStorage), чтобы не сломать
// существующие вызовы без креды.
const QA_PHONE = process.env.QA_FUZZ_PHONE || process.env.QA_UI_PHONE;
const QA_PASSWORD = process.env.QA_FUZZ_PASSWORD || process.env.QA_UI_PASSWORD;
const COV = '/tmp/ui-fuzz-coverage.json';
const PICKS = Number(process.env.FUZZ_PICKS || 12);

const PAGES = ['dashboard', 'journal', 'clients', 'services', 'stock', 'shifts', 'pipeline',
  'loyalty', 'reports', 'team', 'settings', 'waitlist', 'svccats', 'suppliers'];

// НИЧЕГО из этого не трогаем на живой базе.
const FORBIDDEN = /(видал|удал|delete|оплат|провести|списа|надісл|отправ|збереж|сохран|save|вихід|выход|logout|скасув|отмен|архів|archiv)/i;

// Странные, но безобидные значения — проверяем реакцию интерфейса, не сохраняя.
const WEIRD = ['', '0', '-1', '999999999', 'ЁЁЁ ТЕСТ', '<b>x</b>', '2026-02-30', '   ', '@#$%^&*()', '9'.repeat(50)];

let cov = {};
try { if (existsSync(COV)) cov = JSON.parse(readFileSync(COV, 'utf8')); } catch {}

const problems = [], fresh = [];
const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await b.newPage();
const jsErrors = [], http5xx = [];
p.on('pageerror', e => jsErrors.push(e.message.slice(0, 140)));
p.on('response', r => { if (r.status() >= 500) http5xx.push(`${r.status()} ${r.url().split('?')[0].slice(-60)}`); });

try {
  // Настоящий вход (JWT сотрудника), а не подстановка ADMIN_TOKEN — иначе браузер
  // остаётся на экране логина, и все проверки ниже идут вслепую мимо интерфейса.
  if (QA_PHONE && QA_PASSWORD) {
    const { user } = await loginIntoPage(p, BASE, QA_PHONE, QA_PASSWORD);
    console.log(`[+] реальный вход выполнен: ${user.display_name || user.id} (role_id=${user.role_id})`);
  } else {
    console.log('[!] нет QA_FUZZ_PHONE/QA_FUZZ_PASSWORD — откат на legacy ADMIN_TOKEN (интерфейс может остаться на экране логина)');
    await p.goto(BASE + '/admin/', { waitUntil: 'domcontentloaded' });
    await p.evaluate(t => localStorage.setItem('svs_admin_token', t), TOKEN);
  }

  // случайная страница, приоритет — где меньше всего были
  const page = PAGES.map(x => ({ x, w: (Date.now() - (cov['page:' + x]?.last || 0)) * (0.5 + Math.random()) }))
    .sort((a, c) => c.w - a.w)[0].x;
  await p.goto(`${BASE}/admin/#${page}`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
  cov['page:' + page] = { last: Date.now() };

  // САМИ находим что дёргать — вот отличие от матрицы
  const elements = await p.evaluate(() => {
    const out = [];
    document.querySelectorAll('button, [role=tab], .tab, select, input:not([type=hidden]), a[href^="#"]').forEach((el, i) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;                        // невидимое не трогаем
      const label = (el.innerText || el.placeholder || el.name || el.id || el.className || '').trim().slice(0, 40);
      out.push({ i, tag: el.tagName.toLowerCase(), type: el.type || '', label });
    });
    return out;
  });

  const candidates = elements.filter(e => !FORBIDDEN.test(e.label));
  const scored = candidates.map(e => {
    const key = `${page}::${e.tag}:${e.label}`;
    if (!cov[key]) fresh.push(key);                             // элемент, которого раньше не видели
    return { e, key, w: (cov[key] ? Date.now() - cov[key].last : 1e12) * (0.5 + Math.random()) };
  }).sort((a, c) => c.w - a.w).slice(0, PICKS);

  for (const { e, key } of scored) {
    const before = jsErrors.length + http5xx.length;
    try {
      await p.evaluate(({ idx, weird }) => {
        const els = [...document.querySelectorAll('button, [role=tab], .tab, select, input:not([type=hidden]), a[href^="#"]')]
          .filter(x => { const r = x.getBoundingClientRect(); return r.width && r.height; });
        const el = els[idx]; if (!el) return;
        if (el.tagName === 'INPUT') { el.value = weird; el.dispatchEvent(new Event('input', { bubbles: true })); }
        else if (el.tagName === 'SELECT') { const o = el.options[Math.floor(Math.random() * el.options.length)]; if (o) { el.value = o.value; el.dispatchEvent(new Event('change', { bubbles: true })); } }
        else el.click();
      }, { idx: e.i, weird: WEIRD[Math.floor(Math.random() * WEIRD.length)] });
      await p.waitForTimeout(900);

      // мусор на экране = баг, который видит клиент
      const dirt = await p.evaluate(() => {
        const t = document.body.innerText || '';
        const m = t.match(/undefined|NaN|\[object Object\]|Infinity/);
        return { dirt: m ? m[0] : null, empty: t.trim().length < 40 };
      });
      if (dirt.dirt) problems.push(`${page} · «${e.label}» → на экране «${dirt.dirt}»`);
      if (dirt.empty) problems.push(`${page} · «${e.label}» → экран опустел`);
      if (jsErrors.length + http5xx.length > before) {
        problems.push(`${page} · «${e.label}» → ${[...jsErrors, ...http5xx].slice(-1)[0]}`);
      }
    } catch (err) {
      problems.push(`${page} · «${e.label}» → ${String(err.message).slice(0, 90)}`);
    }
    cov[key] = { last: Date.now() };
  }

  console.log(`страница: ${page} · элементов найдено: ${elements.length} · дёрнули: ${scored.length} · впервые видим: ${fresh.length}`);
  if (problems.length) { console.log('НАЙДЕНО:'); problems.forEach(x => console.log(' [-]', x)); }
  else console.log('чисто на этом проходе');
} finally {
  try { writeFileSync(COV, JSON.stringify(cov)); } catch {}
  await b.close();
}
process.exit(problems.length ? 1 : 0);
