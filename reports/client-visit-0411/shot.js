// client-visit-0411 скріни: адмінка ПК 1280 на QA-сервері — картка клієнта (клікабельна хронологія, формули з порівнянням),
// деталь візиту, форма «Формула», формула у вікні запису журналу. Фікстури створюються тут і прибираються в кінці (лише QA, лише свої id).
process.chdir('/home/client/workspace/svs-beauty-space/backend');
require('/home/client/workspace/svs-beauty-space/backend/node_modules/dotenv').config({ path: '/home/client/workspace/svs-beauty-space/backend/.env' });
if (process.env.QA_DB_URL) { process.env.DATABASE_URL = process.env.QA_DB_URL; process.env.DATABASE_URL_APP = process.env.QA_DB_URL; }
const { chromium } = require('/home/client/workspace/node_modules/playwright/index.js');
const { startQaServer } = require('/home/client/workspace/svs-beauty-space/backend/test/_qa-server.js');
const { Client } = require('/home/client/workspace/svs-beauty-space/backend/node_modules/pg');
const out = '/home/client/workspace/svs-beauty-space/reports/client-visit-0411';
const TENANT = '00000000-0000-0000-0000-000000000001';
const res = {};
const F = { appts: [], clients: [], masters: [], services: [] };
let db, S;
const q = async (sql, p) => (await db.query(sql, p)).rows;
const kyivTs = (shift, hour) => `((((now() AT TIME ZONE 'Europe/Kyiv')::date + ${Number(shift)}) + time '${hour}') AT TIME ZONE 'Europe/Kyiv')`;
const api = async (method, url, body) => {
  const r = await fetch(S.base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Admin-Token': S.token }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};

async function fixtures() {
  F.master = (await q(`INSERT INTO masters (name, active, provides_services, tenant_id) VALUES ('Анжела (QA)',true,true,$1) RETURNING id`, [TENANT]))[0].id;
  F.masters.push(F.master);
  const svc = async (n, p) => { const id = (await q(`INSERT INTO services (name, duration_min, price, active, tenant_id) VALUES ($1,60,$2,true,$3) RETURNING id`, [n, p, TENANT]))[0].id; F.services.push(id); return id; };
  const sRoot = await svc('Фарбування коренів', 1500), sTone = await svc('Тонування довжини', 1200), sCut = await svc('Стрижка кінчиків', 800);
  F.client = (await q(`INSERT INTO clients (name, phone, tenant_id, source) VALUES ('Олена Коваль',$1,$2,'qa-cvd') RETURNING id`,
    ['3809' + String(Date.now() % 100000000).padStart(8, '0'), TENANT]))[0].id;
  F.clients.push(F.client);
  const visit = async (shift, items, notes, pay) => {
    const total = items.reduce((s, x) => s + x[1], 0);
    const id = (await q(`INSERT INTO appointments (client_id, master_id, service_id, starts_at, ends_at, status, price, real_amount, payment_method, tenant_id, source, notes)
      VALUES ($1,$2,$3, ${kyivTs(shift, '11:00')}, ${kyivTs(shift, '14:00')}, 'done', $4, $4, $5, $6, 'qa-test', $7) RETURNING id`,
      [F.client, F.master, items[0][0], total, pay, TENANT, notes]))[0].id;
    F.appts.push(id);
    let h = 11;
    for (const [sid, price] of items) {
      await q(`INSERT INTO appointment_services (appointment_id, service_id, master_id, starts_at, duration_min, price, tenant_id)
               VALUES ($1,$2,$3, ${kyivTs(shift, String(h).padStart(2, '0') + ':00')}, 60, $4, $5)`, [id, sid, F.master, price, TENANT]);
      h++;
    }
    return id;
  };
  F.v1 = await visit(-70, [[sRoot, 1500], [sTone, 1200]], 'Сивина ~30%, просила тепліше', 'card');
  F.v2 = await visit(-35, [[sRoot, 1500], [sTone, 1200], [sCut, 800]], 'Сивина прокрашена, тон рівний', 'cash');
  F.v3 = await visit(-2, [[sRoot, 1500], [sCut, 800]], 'Корені 3 см', 'card');
  // для правдоподібного скріну — фарба/окисник у грамах (товари з price_per_gram), інакше будь-які
  let v = await q(`SELECT pv.id FROM product_variants pv JOIN products p ON p.id=pv.product_id WHERE pv.tenant_id=$1 AND p.price_per_gram IS NOT NULL ORDER BY pv.id LIMIT 2`, [TENANT]);
  if (!v.length) v = await q(`SELECT id FROM product_variants WHERE tenant_id=$1 ORDER BY id LIMIT 2`, [TENANT]);
  for (const [i, x] of v.entries()) {
    await q(`INSERT INTO appointment_materials (appointment_id, variant_id, qty_used, billable, tenant_id) VALUES ($1,$2,$3,false,$4)`, [F.v2, x.id, i ? 60 : 40, TENANT]);
  }
  res.materials_rows = v.length;
  const f1 = await api('POST', '/api/medical/formulas', { appointment_id: F.v1, total_amount_g: 90, result_rating: 4, result_notes: 'Корінь трохи холодний', zones: [
    { zone: 'Корінь', brand: 'Wella Koleston', shade: '6/0', amount_g: 30, oxidant_pct: 6, time_min: 35 },
    { zone: 'Корінь', brand: 'Wella Koleston', shade: '7/1', amount_g: 30, oxidant_pct: 6, time_min: 35 },
    { zone: 'Довжина', brand: 'Wella Color Touch', shade: '8/71', amount_g: 30, oxidant_pct: 1.9, time_min: 20 }] });
  const f2 = await api('POST', '/api/medical/formulas', { appointment_id: F.v2, total_amount_g: 100, result_rating: 5, result_notes: 'Тепло, сивина 100%', zones: [
    { zone: 'Корінь', brand: 'Wella Koleston', shade: '6/0', amount_g: 30, oxidant_pct: 6, time_min: 40 },
    { zone: 'Корінь', brand: 'Wella Koleston', shade: '7/3', amount_g: 30, oxidant_pct: 6, time_min: 40 },
    { zone: 'Довжина', brand: 'Wella Color Touch', shade: '8/73', amount_g: 40, oxidant_pct: 1.9, time_min: 20 }] });
  res.formula_posts = [f1.status, f2.status];
}

async function cleanup() {
  if (!db) return;
  const steps = [
    ['formulas', `DELETE FROM coloring_formulas WHERE client_id = ANY($1::int[])`, [F.clients]],
    ['materials', `DELETE FROM appointment_materials WHERE appointment_id = ANY($1::int[])`, [F.appts]],
    ['appt_services', `DELETE FROM appointment_services WHERE appointment_id = ANY($1::int[])`, [F.appts]],
    ['appointments', `DELETE FROM appointments WHERE id = ANY($1::int[])`, [F.appts]],
    ['services', `DELETE FROM services WHERE id = ANY($1::int[])`, [F.services]],
    ['masters', `DELETE FROM masters WHERE id = ANY($1::int[])`, [F.masters]],
    ['clients', `DELETE FROM clients WHERE id = ANY($1::int[])`, [F.clients]],
  ];
  for (const [n, sql, p] of steps) { try { await q(sql, p); } catch (e) { console.error('[cleanup]', n, e.message); } }
  await db.end();
}

(async () => {
  db = new Client({ connectionString: process.env.QA_DB_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  S = await startQaServer({ port: Number(process.env.CVD_SHOT_PORT || 3074) });
  const b = await chromium.launch();
  try {
    await fixtures();
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.addInitScript((t) => { localStorage.setItem('svs_admin_token', t); localStorage.setItem('svs_user', JSON.stringify({ id: 1, role: 'owner', name: 'QA' })); }, S.token);
    await p.goto(S.base + '/admin/index.html', { waitUntil: 'networkidle' }); await p.waitForTimeout(1500);

    // 1. Картка клієнта: таблиця візитів з послугами і 🎨, хронологія
    await p.evaluate((id) => openClientCard(id), F.client);
    await p.waitForSelector('#ccFormulas table', { timeout: 15000 }); await p.waitForTimeout(800);
    res.card_clickable_rows = await p.$$eval('#clientCardBody .cc-ev-click', a => a.length);
    await p.screenshot({ path: out + '/01a-client-card-top-1280.png' });
    await p.$eval('#clientCardBody tr.cc-ev-click', e => { const t = e.closest('table'); (t.previousElementSibling || t).scrollIntoView({ block: 'start' }); });
    await p.waitForTimeout(400);
    await p.screenshot({ path: out + '/01-client-card-history-1280.png' });
    // 2. Блок «Формули» з порівнянням двох візитів
    await p.$eval('#ccFormulas', e => e.scrollIntoView({ block: 'start' })); await p.waitForTimeout(400);
    res.compare_text = await p.$eval('#ccFmlCmp', e => e.innerText.split('\n').filter(Boolean));
    await p.screenshot({ path: out + '/02-formulas-compare-1280.png' });
    // 3. Клік по візиту в хронології → деталь візиту (з формулою)
    const tl = await p.$$('#clientCardBody div.cc-ev-click');
    res.timeline_clickable = tl.length;
    const target = await p.$(`#clientCardBody div.cc-ev-click[onclick="openVisitDetail(${F.v2})"]`);
    await (target || tl[0]).evaluate(e => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(400);
    await p.screenshot({ path: out + '/02b-timeline-clickable-1280.png' });
    await (target || tl[0]).click();
    await p.waitForSelector('#visitDetailModal table', { timeout: 15000 }); await p.waitForTimeout(700);
    res.detail_v2 = await p.$eval('#visitDetailBody', e => e.innerText.split('\n').filter(Boolean));
    await p.screenshot({ path: out + '/03-visit-detail-1280.png' });
    await p.$eval('#visitDetailBody', e => { const m = e.closest('.modal'); if (m) m.scrollTop = m.scrollHeight; }); await p.waitForTimeout(300);
    await p.screenshot({ path: out + '/04-visit-detail-formula-1280.png' });
    await p.evaluate(() => closeVisitDetail());

    // 5. Свіжий візит без формули → «➕ Записати формулу» → форма з передзаповненими зонами з минулого разу
    await p.evaluate((id) => openVisitDetail(id), F.v3);
    await p.waitForSelector('#visitDetailModal table', { timeout: 15000 }); await p.waitForTimeout(500);
    await p.click('#visitDetailBody button:has-text("Записати формулу")');
    await p.waitForSelector('#fRows .fz-shade', { timeout: 10000 }); await p.waitForTimeout(400);
    await p.$eval('#fRows', (box) => { const s = box.querySelectorAll('.fz-shade'); if (s[1]) { s[1].value = '7/31'; s[1].dispatchEvent(new Event('input', { bubbles: true })); } });
    await p.fill('#fNotes', 'Корені 3 см, сивина ~35%').catch(() => {});
    res.form_rows = await p.$$eval('#fRows .fz-shade', a => a.map(x => x.value));
    await p.screenshot({ path: out + '/05-formula-form-1280.png' });
    await p.click('#fSaveBtn'); await p.waitForTimeout(1500);
    await p.waitForSelector('#visitDetailModal table', { timeout: 15000 }); await p.waitForTimeout(500);
    res.saved_v3 = (await api('GET', `/api/medical/formulas?appointment_id=${F.v3}`)).body;
    res.saved_v3 = res.saved_v3 && res.saved_v3.items && res.saved_v3.items.map(f => ({ id: f.id, appt: f.appointment_id, client: f.client_id, shades: (f.zones || []).map(z => z.shade) }));
    await p.evaluate(() => closeVisitDetail());

    // 6. Журнал записів: вікно візиту → блок «Формула фарбування»
    const d3 = (await q(`SELECT ((starts_at AT TIME ZONE 'Europe/Kyiv')::date)::text d FROM appointments WHERE id=$1`, [F.v3]))[0].d;
    await p.evaluate(async (d) => { go('journal'); document.getElementById('journalDate').value = d; await loadJournal(); }, d3);
    await p.waitForTimeout(1500);
    await p.evaluate((id) => openAppt(id), F.v3); await p.waitForSelector('#apptFormula table', { timeout: 15000 }).catch(() => {});
    await p.$eval('#apptFormula', e => e.scrollIntoView({ block: 'center' })).catch(() => {});
    await p.waitForTimeout(500);
    res.journal_formula = await p.$eval('#apptFormula', e => e.innerText.split('\n').filter(Boolean)).catch(() => null);
    await p.screenshot({ path: out + '/06-journal-appt-formula-1280.png' });
    res.page_errors = errs;
    await ctx.close();
  } finally {
    await b.close();
    try { await S.stop(); } catch (_) {}
    await cleanup();
  }
  console.log(JSON.stringify(res, null, 1));
  process.exit(0);
})().catch(async (e) => { console.error('ERR', e.stack); console.log(JSON.stringify(res)); try { await cleanup(); } catch (_) {} process.exit(1); });
