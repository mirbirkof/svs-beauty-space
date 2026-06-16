// Безопасный полный исторический бэкфилл BeautyPro: визиты + оплаты, помесячно.
// НИЧЕГО не удаляет. syncAppointments/syncSales идемпотентны по beautypro_id/ext_ref.
require('dotenv').config();
const m = require('./routes/beautypro-appointments-sync.js');

function months(fromY, fromM, toY, toM) {
  const out = [];
  let y = fromY, mo = fromM;
  while (y < toY || (y === toY && mo <= toM)) {
    const start = `${y}-${String(mo).padStart(2, '0')}-01`;
    const ny = mo === 12 ? y + 1 : y, nm = mo === 12 ? 1 : mo + 1;
    const endD = new Date(ny, nm - 1, 0).getDate(); // last day of mo
    const end = `${y}-${String(mo).padStart(2, '0')}-${String(endD).padStart(2, '0')}`;
    out.push([start, end]);
    y = ny; mo = nm;
  }
  return out;
}

(async () => {
  const wins = months(2025, 8, 2026, 7); // авг 2025 .. июль 2026
  let totA = { fetched: 0, created: 0, updated: 0 }, totS = { fetched: 0, created: 0 };
  for (const [from, to] of wins) {
    try {
      const a = await m.syncAppointments(from, to);
      totA.fetched += a.fetched || 0; totA.created += a.created || 0; totA.updated += a.updated || 0;
      console.log(`APPTS ${from}..${to}: fetched=${a.fetched} created=${a.created} updated=${a.updated} unlinked=${a.unlinked_clients}`);
    } catch (e) { console.log(`APPTS ${from}..${to} ERROR: ${e.message}`); }
    try {
      const s = await m.syncSales(from, to);
      totS.fetched += s.fetched || 0; totS.created += (s.created || 0);
      console.log(`SALES ${from}..${to}: ${JSON.stringify(s)}`);
    } catch (e) { console.log(`SALES ${from}..${to} ERROR: ${e.message}`); }
  }
  console.log('=== DONE. APPTS', JSON.stringify(totA), 'SALES', JSON.stringify(totS));
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
