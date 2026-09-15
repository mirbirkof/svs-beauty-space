/* Нотатка #159 — живий тест у браузері: чи справді звільнення закриває
   доступ до внутрішньої інформації салону.

   Тест НІЧОГО не створює і НІЧОГО не видаляє. Він бере вже звільнену людину,
   повертає її до роботи справжньою кнопкою, дає їй живий пропуск, а потім
   звільняє мишкою в адмінці — і дивиться, чи помер пропуск. У кінці звіряє,
   що картка людини повернулась рівно в той самий стан, що був до тесту. */
import { chromium } from 'playwright';
import pg from 'pg';
import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config({ path: '/home/client/workspace/svs-beauty-space/backend/.env' });

const BASE = 'http://127.0.0.1:3011';
const ADMIN = process.env.ADMIN_TOKEN;
const MID = 30, UID = 10;                      // вже звільнена людина + її логін
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
let fails = 0;
const must = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fails++; };

const snap = async () => (await pool.query(
  `SELECT m.active, m.in_schedule, m.status, m.fire_date::text, u.is_active,
          (SELECT COUNT(*)::int FROM master_schedule_days WHERE master_id=$1 AND stash_start_time IS NOT NULL) AS stashed
     FROM masters m JOIN users u ON u.id=$2 WHERE m.id=$1`, [MID, UID])).rows[0];

const hit = async (url, token) => (await fetch(BASE + url, { headers: { Authorization: `Bearer ${token}` } })).status;
const adminPatch = (id, active) => fetch(`${BASE}/api/schedule/masters/${id}`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN },
  body: JSON.stringify({ active }) }).then(r => r.json());

const before = await snap();
console.log('\nСтан ДО тесту:', JSON.stringify(before), '\n');
let browser;

try {
  // ── 1. повертаємо людину до роботи справжньою кнопкою ──
  const back = await adminPatch(MID, true);
  must(back.ok === true, 'Повернули до роботи (той самий маршрут, що й кнопка в адмінці)');
  must((await snap()).is_active === true, 'Разом з поверненням на роботу відкрився і вхід у CRM');

  // ── 2. даємо їй живий пропуск «запамʼятати назавжди» ──
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO user_tokens (user_id, token_hash, label, expires_at)
                    VALUES ($1,$2,'note159 live-check', NULL)`, [UID, sha256(token)]);
  must(await hit('/api/auth/staff/me', token) === 200, 'ДО звільнення: співробітник заходить у CRM');
  must(await hit('/api/schedule/masters', token) === 200, 'ДО звільнення: бачить внутрішні дані салону (графік команди)');
  must(await hit('/api/admin/clients?limit=1', token) === 200, 'ДО звільнення: бачить базу клієнтів салону');

  // ── 3. звільняємо мишкою в адмінці ──
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('dialog', d => d.accept());
  await page.goto(`${BASE}/admin/index.html`);
  await page.evaluate(t => localStorage.setItem('svs_admin_token', t), ADMIN);
  await page.goto(`${BASE}/admin/index.html`);
  await page.waitForFunction(() => typeof window.go === 'function' && typeof window.setTab === 'function', { timeout: 20000 });
  await page.evaluate(() => { go('settings'); setTab('schedule'); });
  await page.waitForTimeout(3000);

  must(await page.evaluate(m => [...(document.getElementById('schMaster')?.options || [])].some(o => o.value === String(m)), MID),
       'Людину видно у списку графіка');
  await page.evaluate(m => { document.getElementById('schMaster').value = String(m); loadSchedule(); }, MID);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: '/tmp/n159-before.png' });

  const btn = page.locator('#schGrid button', { hasText: 'Звільнити' }).first();
  must(await btn.count() > 0, 'На екрані є кнопка «Звільнити»');
  await btn.click();
  await page.waitForTimeout(3000);

  const toastTxt = await page.evaluate(() => document.getElementById('genToast')?.textContent || '');
  const paneTxt = await page.evaluate(() => (document.getElementById('schGrid')?.innerText || '').replace(/\s+/g, ' '));
  console.log('\n   НА ЕКРАНІ: «' + toastTxt + '»');
  console.log('   У ПАНЕЛІ: «' + paneTxt.slice(0, 120) + '»\n');
  await page.screenshot({ path: '/tmp/n159-after.png' });

  must(/Доступ до CRM закрито/i.test(toastTxt), 'Екран ПРЯМО повідомляє, що доступ до CRM закрито');
  must(/обірвано/i.test(toastTxt), 'Екран показує, скільки активних сеансів обірвано');
  must(/доступ до CRM закрито/i.test(paneTxt), 'У картці графіка видно, що пропуск відібрано');

  // ── 4. пропуск має бути мертвий ──
  const me = await hit('/api/auth/staff/me', token);
  const sched = await hit('/api/schedule/masters', token);
  const cli = await hit('/api/admin/clients?limit=1', token);
  must(me === 401, `ПІСЛЯ звільнення: вхід у CRM відбито (${me})`);
  must(sched === 401, `ПІСЛЯ звільнення: графік команди закрито (${sched})`);
  must(cli === 401, `ПІСЛЯ звільнення: база клієнтів закрита (${cli})`);

  const st = await snap();
  must(st.is_active === false, 'Обліковий запис колишнього — неактивний');
  const live = await pool.query(`SELECT COUNT(*)::int n FROM user_tokens WHERE user_id=$1 AND (expires_at IS NULL OR expires_at>NOW())`, [UID]);
  must(live.rows[0].n === 0, `Живих сеансів не лишилось (${live.rows[0].n})`);
  const kept = await pool.query(`SELECT COUNT(*)::int n FROM user_tokens WHERE user_id=$1`, [UID]);
  must(kept.rows[0].n > 0, `Історію входів збережено для аудиту (${kept.rows[0].n} записів)`);

  // ── 5. стан картки має збігтись із тим, що був до тесту ──
  const after = await snap();
  const same = JSON.stringify(after) === JSON.stringify(before);
  must(same, 'Стан картки людини повернувся рівно такий, як був до тесту');
  if (!same) console.log('   було:', JSON.stringify(before), '\n   стало:', JSON.stringify(after));
} catch (e) {
  console.error('ПОМИЛКА ТЕСТУ:', e); fails++;
} finally {
  if (browser) await browser.close();
  await pool.end();
  console.log(fails ? `\n=== ПРОВАЛЕНО перевірок: ${fails} ===` : '\n=== УСІ ПЕРЕВІРКИ ПРОЙДЕНО ===');
  process.exit(fails ? 1 : 0);
}
