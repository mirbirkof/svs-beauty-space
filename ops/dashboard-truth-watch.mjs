#!/usr/bin/env node
/* ops/dashboard-truth-watch.mjs — сторож ЭКРАНА, не только базы (Loop Engineering, слой 5).
 *
 * ПОЧЕМУ ПОЯВИЛСЯ (31.07.2026). Босс поймал баг «касса за месяц = 462 683» глазами за секунду,
 * а я не находил его инструментами часами. Причина не в лени — в слепой зоне: money-watch.js
 * и все прошлые сверки лезут ПРЯМО В БАЗУ (SQL), они по определению не видят то, что реально
 * нарисовано в браузере. Баг был не в деньгах (там всё сходилось), а в том, что дашборд запомнил
 * старый период в localStorage телефона и с тех пор не обновлял верхнюю границу. Ни один
 * SQL-сторож это физически не мог поймать — там не было localStorage.
 *
 * ЧТО ДЕЛАЕТ ЭТОТ СТОРОЖ ИНАЧЕ. Открывает настоящий Chromium с ПОСТОЯННЫМ профилем на диске
 * (userDataDir), как настоящий телефон Босса — localStorage, куки, состояние между запусками
 * НЕ сбрасываются. Заходит в живую админку, читает цифры ГЛАЗАМИ (из DOM, как их видит человек),
 * и сверяет с независимым прямым запросом к API за тот же «сегодняшний» период. Если экран и
 * бэкенд разошлись — это и есть класс бага, который никакая проверка базы не ловит.
 *
 * Запуск: PLAYWRIGHT_BROWSERS_PATH=~/workspace/.ms-playwright node ops/dashboard-truth-watch.mjs [--dry]
 * Крон: каждые 6 часов — если период где-то замёрзнет, поймаем в тот же день, не через 4 дня.
 */
import { chromium } from 'playwright';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.CRM_BASE || 'http://127.0.0.1:3011';
const DRY = process.argv.includes('--dry') || process.env.MONEY_WATCH_DRY === '1';
const PROFILE_DIR = join(__dirname, '.truth-watch-profile'); // ПОСТОЯННЫЙ — не чистим между запусками

function readToken() {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN;
  const env = readFileSync(join(__dirname, '..', 'backend', '.env'), 'utf8');
  const m = env.match(/^ADMIN_TOKEN=(.*)$/m);
  if (!m) throw new Error('ADMIN_TOKEN not found');
  return m[1].trim().replace(/^["']|["']$/g, '');
}

function notify(text) {
  if (DRY) { console.log('--- DRY, не надіслано ---\n' + text); return; }
  try {
    execSync(
      `curl -s -m 15 -X POST http://127.0.0.1:3005/notify -H "x-notify-token: ${process.env.RESTART_TOKEN || 'jarvis-restart-2026'}" -H "Content-Type: application/json" -d @-`,
      { input: JSON.stringify({ text }) });
  } catch (e) { console.log('[dashboard-truth-watch] notify failed:', e.message); }
}

function money(v) { return Math.round(Number(v || 0)).toLocaleString('uk-UA') + ' ₴'; }
function kyivToday() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date()); }

async function main() {
  const TOK = readToken();
  const today = kyivToday();
  const monthFrom = today.slice(0, 7) + '-01';

  // ── Независимая правда: прямой запрос к API, за сегодняшний реальный месяц, всегда свежий ──
  const truthRes = await fetch(`${BASE}/api/reports/overview?fresh=1`, { headers: { 'X-Admin-Token': TOK } });
  if (!truthRes.ok) { console.log('[dashboard-truth-watch] API недоступен:', truthRes.status); process.exit(0); }
  const truth = await truthRes.json();
  if (!truth.revenue_month) { console.log('[dashboard-truth-watch] фінансів немає (без прав) — пропуск'); process.exit(0); }
  const truthTotal = Number(truth.revenue_month.total || 0);

  // ── Что реально нарисовано в браузере (постоянный профиль = как телефон Босса) ──
  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true, args: ['--no-sandbox'], viewport: { width: 412, height: 915 },
  });
  const p = browser.pages()[0] || await browser.newPage();
  let renderedTotal = null, renderedRangeText = null, jsErrors = [];
  p.on('pageerror', e => jsErrors.push(e.message));
  try {
    await p.goto(BASE + '/admin/', { waitUntil: 'domcontentloaded', timeout: 40000 });
    const needLogin = await p.locator('.login-card').isVisible().catch(() => false);
    if (needLogin) {
      await p.evaluate(t => localStorage.setItem('svs_admin_token', t), TOK);
      await p.goto(BASE + '/admin/', { waitUntil: 'networkidle', timeout: 60000 });
    }
    await p.waitForTimeout(2500);
    await p.evaluate(() => { try { go('dashboard'); } catch {} });
    await p.waitForTimeout(2000);
    // ищем карточку «Каса за місяць»/«Каса за період» и подпись выбранного диапазона —
    // ТЕКСТ КАК ВИДИТ ЧЕЛОВЕК, не внутреннее состояние JS
    const card = await p.locator('.kpi-card:has-text("Каса за")').first();
    const raw = await card.innerText({ timeout: 8000 }).catch(() => null);
    if (raw) {
      const numM = raw.replace(/ /g, ' ').match(/([\d ]{2,})\s*₴/);
      if (numM) renderedTotal = Number(numM[1].replace(/\s/g, ''));
    }
    renderedRangeText = await p.locator('#dashRangeLbl').innerText({ timeout: 3000 }).catch(() => null);
  } catch (e) {
    console.log('[dashboard-truth-watch] помилка читання екрану:', e.message);
  } finally {
    await browser.close();
  }

  if (renderedTotal == null) {
    console.log('[dashboard-truth-watch] не вдалось прочитати цифру з екрану — пропуск (можливо, змінилась вёрстка)');
    process.exit(0);
  }

  const diff = Math.abs(renderedTotal - truthTotal);
  const ts = new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit' }).format(new Date());
  console.log(`[dashboard-truth-watch] ${today} ${ts} — екран: ${money(renderedTotal)} (${renderedRangeText||'?'}) | правда API: ${money(truthTotal)} | різниця: ${money(diff)}`);

  if (diff > 50) {
    notify(
      `⚠️ <b>Дашборд показує НЕ те, що в базі</b>\n` +
      `Екран: ${money(renderedTotal)}${renderedRangeText ? ` (діапазон «${renderedRangeText}»)` : ''}\n` +
      `Реально (API, зараз): ${money(truthTotal)}\n` +
      `Різниця: ${money(diff)}\n` +
      `Перевір /admin — можливо, знову замерз період чи кеш.`
    );
  } else if (jsErrors.length) {
    notify(`⚠️ Дашборд відкрився з JS-помилками (${jsErrors.length}): ${jsErrors[0]}`);
  } else {
    console.log('[dashboard-truth-watch] чисто — екран = база');
  }
}

main().catch(e => { console.error('[dashboard-truth-watch] FATAL:', e.message); process.exit(1); });
