/* Послуги майстра «з нуля» (Босс 13.10: «додав нового майстра — а в послугах каша, продумай логіку від початку до кінця»).
   КОРІНЬ: майстер без звʼязок master_services → журнал/пікери показували ВЕСЬ каталог салону (манікюрниці — фарбування волосся).
   Тут одне джерело правди для трьох місць:
     1) створення майстра (employees / admin / users) — autoLinkNew: звʼязки з категорій його спеціальності, source='auto_specialty';
     2) GET by-master без звʼязок — suggestFor: що запропонувати (спеціальність + те, що майстер реально робив у візитах);
     3) пікери послуг — замість «весь каталог» беруть suggested.service_ids.
   Нічого не видаляє і не чіпає майстрів, у яких звʼязки вже є. */
const RULES = [ // спеціальність (regex) → категорії services.category
  [/манік|педик|нігт|nail/i, ['Нігті']],
  [/перукар|колорист|стиліст|барбер|волос|hair/i, ['Волосся', 'Перукарські послуги']],
  [/леш|lash|вій|вії|нарощ/i, ['Вії', 'Брови та вії']],
  [/бров|brow/i, ['Брови', 'Брови та вії']],
  [/візаж|визаж|макія|макия|make ?up/i, ['Макіяж', 'Визаж']],
  [/масаж|массаж|спа|spa|тіл/i, ['Масаж та тіло']],
];
function categoriesFor(specialty) {
  const s = String(specialty || ''); const out = [];
  for (const [re, cats] of RULES) if (re.test(s)) for (const c of cats) if (!out.includes(c)) out.push(c);
  return out;
}
async function suggestFor(db, masterId) {
  const m = (await db.query('SELECT id, specialty, provides_services FROM masters WHERE id=$1', [masterId])).rows[0];
  if (!m) return null;
  const cats = categoriesFor(m.specialty);
  const bySpec = cats.length ? (await db.query(
    `SELECT id, category FROM services WHERE deleted_at IS NULL AND active IS NOT FALSE AND COALESCE(is_material,false)=false AND category = ANY($1)`, [cats])).rows : [];
  const byFact = (await db.query(
    `SELECT DISTINCT s.id, s.category FROM appointments a JOIN services s ON s.id = a.service_id
      WHERE a.master_id=$1 AND s.deleted_at IS NULL AND COALESCE(s.is_material,false)=false
     UNION
     SELECT DISTINCT s.id, s.category FROM appointment_services x JOIN appointments a ON a.id = x.appointment_id JOIN services s ON s.id = x.service_id
      WHERE COALESCE(x.master_id, a.master_id)=$1 AND s.deleted_at IS NULL AND COALESCE(s.is_material,false)=false`, [masterId])).rows;
  const ids = new Set([...bySpec, ...byFact].map(r => Number(r.id)));
  const catCount = {}; for (const r of [...bySpec, ...byFact.filter(r => !bySpec.some(b => Number(b.id) === Number(r.id)))]) { const k = r.category || 'Без категорії'; catCount[k] = (catCount[k] || 0) + 1; }
  return { specialty: m.specialty || null, categories: cats, by_fact: byFact.length, service_ids: [...ids],
    groups: Object.entries(catCount).map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n),
    source: cats.length && byFact.length ? 'specialty+fact' : cats.length ? 'specialty' : byFact.length ? 'fact' : 'none' };
}
// Новий майстер: звʼязки за спеціальністю. Лише якщо надає послуги і звʼязок ще 0 (повторний виклик нічого не дублює).
async function autoLinkNew(db, masterId) {
  try {
    const m = (await db.query('SELECT specialty, COALESCE(provides_services,true) AS ps FROM masters WHERE id=$1', [masterId])).rows[0];
    if (!m || !m.ps) return { added: 0, categories: [] };
    const have = (await db.query('SELECT COUNT(*)::int n FROM master_services WHERE master_id=$1', [masterId])).rows[0].n;
    if (have) return { added: 0, categories: [], skipped: 'has-links' };
    const cats = categoriesFor(m.specialty); if (!cats.length) return { added: 0, categories: [] };
    const r = await db.query(
      `INSERT INTO master_services (master_id, service_id, source, active)
       SELECT $1, s.id, 'auto_specialty', true FROM services s
        WHERE s.deleted_at IS NULL AND s.active IS NOT FALSE AND COALESCE(s.is_material,false)=false AND s.category = ANY($2)
       ON CONFLICT (tenant_id, master_id, service_id) DO NOTHING RETURNING id`, [masterId, cats]);
    return { added: r.rowCount, categories: cats };
  } catch (e) { console.error('[master-svc] autoLinkNew', e.message); return { added: 0, categories: [], error: true }; } // створення майстра не валимо
}
module.exports = { categoriesFor, suggestFor, autoLinkNew, RULES };
