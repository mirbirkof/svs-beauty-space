/* Сквозной аудит консистентности CRM. Только чтение — ничего не меняет.
   Ищет: дубли, осиротевшие привязки, рассинхрон агрегатов, мусор. */
require('dotenv').config();
const { Client } = require('pg');

const q = async (c, sql, p = []) => (await c.query(sql, p)).rows;
const has = async (c, t) => (await c.query(
  `SELECT 1 FROM information_schema.tables WHERE table_name=$1`, [t])).rowCount > 0;
const col = async (c, t, name) => (await c.query(
  `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`, [t, name])).rowCount > 0;

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const out = [];
  const sec = (t) => out.push('\n━━ ' + t + ' ━━');
  const ok = (m) => out.push('  [+] ' + m);
  const bad = (m) => out.push('  [-] ' + m);

  try {
    // ═══ КЛИЕНТЫ ═══
    sec('КЛИЕНТЫ');
    const cdup = await q(c, `SELECT regexp_replace(phone,'\\D','','g') p, count(*) n FROM clients
       WHERE phone IS NOT NULL AND phone<>'' GROUP BY 1 HAVING count(*)>1`);
    cdup.length ? bad(`дубли по телефону: ${cdup.length} номеров (${cdup.reduce((a,x)=>a+ +x.n,0)} карточек)`) : ok('дублей по телефону нет');
    const ctest = await q(c, `SELECT count(*) n FROM clients WHERE name ILIKE '%test%' OR phone ILIKE '%000000%'`);
    +ctest[0].n ? bad(`тестовых карточек: ${ctest[0].n}`) : ok('тестового мусора нет');
    const cnull = await q(c, `SELECT count(*) n FROM clients WHERE (name IS NULL OR name='') AND (phone IS NULL OR phone='')`);
    +cnull[0].n ? bad(`пустых карточек (без имени и телефона): ${cnull[0].n}`) : ok('пустых карточек нет');
    const ctot = await q(c, `SELECT count(*) n FROM clients`);
    ok(`всего клиентов: ${ctot[0].n}`);

    // ═══ ЗАПИСИ / ВИЗИТЫ ═══
    sec('ЗАПИСИ / ВИЗИТЫ');
    if (await has(c, 'appointment_services')) {
      const orphSvc = await q(c, `SELECT count(*) n FROM appointment_services a
        LEFT JOIN services s ON s.id=a.service_id WHERE a.service_id IS NOT NULL AND s.id IS NULL`);
      +orphSvc[0].n ? bad(`записи на удалённые услуги: ${orphSvc[0].n}`) : ok('все записи ссылаются на живые услуги');
      if (await has(c, 'masters')) {
        const orphM = await q(c, `SELECT count(*) n FROM appointment_services a
          LEFT JOIN masters m ON m.id=a.master_id WHERE a.master_id IS NOT NULL AND m.id IS NULL`);
        +orphM[0].n ? bad(`записи на несуществующих мастеров: ${orphM[0].n}`) : ok('все записи ссылаются на живых мастеров');
      }
      const negP = await q(c, `SELECT count(*) n FROM appointment_services WHERE price<0`);
      +negP[0].n ? bad(`записи с отрицательной ценой: ${negP[0].n}`) : ok('отрицательных цен нет');
    }
    if (await has(c, 'appointments')) {
      const aorph = await q(c, `SELECT count(*) n FROM appointment_services a
        LEFT JOIN appointments ap ON ap.id=a.appointment_id WHERE a.appointment_id IS NOT NULL AND ap.id IS NULL`);
      +aorph[0].n ? bad(`услуги-записи без родительской записи: ${aorph[0].n}`) : ok('связь услуга↔запись цела');
    }

    // ═══ МАСТЕРА ═══
    sec('МАСТЕРА');
    if (await has(c, 'masters')) {
      const mdup = await q(c, `SELECT lower(trim(name)) k,count(*) n FROM masters WHERE name IS NOT NULL GROUP BY 1 HAVING count(*)>1`);
      mdup.length ? bad(`дубли мастеров по имени: ${mdup.map(x=>x.k+'×'+x.n).join(', ')}`) : ok('дублей мастеров нет');
      const mtest = await q(c, `SELECT count(*) n FROM masters WHERE name ILIKE '%test%'`);
      +mtest[0].n ? bad(`тестовых мастеров: ${mtest[0].n}`) : ok('тестовых мастеров нет');
    }

    // ═══ ЗАРПЛАТА ═══
    sec('ЗАРПЛАТА');
    if (await has(c, 'payroll_schemes')) {
      const sdup = await q(c, `SELECT master_id,count(*) n FROM payroll_schemes GROUP BY master_id HAVING count(*)>1`);
      sdup.length ? bad(`мастера с дублем схемы: ${sdup.length}`) : ok('по одной схеме на мастера');
      if (await has(c, 'masters')) {
        const sorph = await q(c, `SELECT count(*) n FROM payroll_schemes ps LEFT JOIN masters m ON m.id=ps.master_id::int
          WHERE ps.master_id ~ '^[0-9]+$' AND m.id IS NULL`);
        +sorph[0].n ? bad(`схемы ЗП на удалённых мастеров: ${sorph[0].n}`) : ok('все схемы привязаны к живым мастерам');
        bad('тип master_id в payroll_schemes = TEXT, а в masters = INTEGER (косметика, JOIN требует каста)');
      }
      const noScheme = await q(c, `SELECT count(*) n FROM masters m LEFT JOIN payroll_schemes ps ON ps.master_id::int=m.id AND ps.is_active
        WHERE (m.active IS NOT FALSE) AND ps.master_id ~ '^[0-9]+$' AND ps.id IS NULL`);
      +noScheme[0].n ? bad(`активных мастеров БЕЗ схемы ЗП: ${noScheme[0].n}`) : ok('у каждого активного мастера есть схема ЗП');
    }

    // ═══ КАССА / ФИНАНСЫ ═══
    sec('КАССА / ФИНАНСЫ');
    const cashT = (await q(c, `SELECT table_name FROM information_schema.tables WHERE table_name ~ 'cash|payment|finance|transaction'`)).map(r=>r.table_name);
    ok(`финансовые таблицы: ${cashT.join(', ')||'нет'}`);
    for (const t of cashT) {
      if (await col(c, t, 'amount')) {
        const nn = await q(c, `SELECT count(*) n FROM ${t} WHERE amount IS NULL`);
        if (+nn[0].n) bad(`${t}: строк с пустой суммой ${nn[0].n}`);
      }
    }

    // ═══ СКЛАД ═══
    sec('СКЛАД');
    if (await has(c, 'products')) {
      const pdup = await q(c, `SELECT lower(trim(name)) k,count(*) n FROM products WHERE name IS NOT NULL GROUP BY 1 HAVING count(*)>1`);
      pdup.length ? bad(`дубли товаров: ${pdup.length} названий`) : ok('дублей товаров нет');
      const pneg = await col(c,'products','stock') ? await q(c, `SELECT count(*) n FROM products WHERE stock<0`) : [{n:0}];
      +pneg[0].n ? bad(`товары с отрицательным остатком: ${pneg[0].n}`) : ok('отрицательных остатков нет');
    } else ok('таблицы products нет (склад в другой схеме)');

    out.push('\n━━ ИТОГ: аудит завершён ━━');
  } catch (e) {
    out.push('ERR: ' + e.message);
  } finally { await c.end(); }
  console.log(out.join('\n'));
})();
