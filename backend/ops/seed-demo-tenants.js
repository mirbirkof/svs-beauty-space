/* ops/seed-demo-tenants.js — демо-тенанты «Режима керуючого» (Босс, 18.07.2026).
 * Проблема: предпросмотр вертикали показывал ФОРМЫ чужой вертикали с ДАННЫМИ салона
 * Босса — путало и настораживало (его слова). Правильно: переключение = вход в
 * ОТДЕЛЬНЫЙ полноценный демо-салон вертикали со своими демо-данными.
 * Идемпотентно: существующий demo-слаг не пересоздаётся, демо-данные не дублируются.
 * Владелец демо = телефон Босса + ЕГО password_hash (копия хеша, пароль неизвестен) —
 * его обычный логин открывает демо-салоны через штатный «выбор салонов».
 * Запуск: node -r dotenv/config ops/seed-demo-tenants.js
 */
require('dotenv').config();
const { getPool } = require('../db-pg');
const { runAs, DEFAULT_TENANT_ID } = require('../lib/tenant');
const tm = require('../lib/tenant-mgmt');

const DEMOS = [
  { slug: 'demo-dental', name: 'Демо Стоматологія', bt: 'dental' },
  { slug: 'demo-fitness', name: 'Демо Фітнес', bt: 'fitness' },
  { slug: 'demo-wellness', name: 'Демо Велнес', bt: 'wellness' },
];

async function main() {
  const pool = getPool();
  // Владелец платформы (салон Босса, дефолтный тенант): телефон + хеш
  const owner = (await pool.query(
    `SELECT u.phone, u.password_hash, u.email, u.display_name
       FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.tenant_id = $1 AND r.code = 'owner' AND u.is_active
      ORDER BY u.id LIMIT 1`, [DEFAULT_TENANT_ID])).rows[0];
  if (!owner) throw new Error('platform owner not found');

  for (const d of DEMOS) {
    let t = (await pool.query(`SELECT id, slug FROM tenants WHERE slug = $1`, [d.slug])).rows[0];
    if (!t) {
      // createTenant сам генерит слаг из имени — после создания принудительно ставим канонный demo-слаг
      const r = await tm.createTenant(d.name, {
        phone: owner.phone, passwordHash: owner.password_hash, owner_name: owner.display_name || 'Керуючий',
        email: owner.email, plan_code: 'enterprise', trial: false, business_type: d.bt,
      }, { id: null, source: 'seed-demo' });
      await pool.query(`UPDATE tenants SET slug = $1, is_internal = TRUE WHERE id = $2`, [d.slug, r.tenant.id]);
      t = { id: r.tenant.id, slug: d.slug };
      console.log('created', d.slug, t.id);
    } else {
      await pool.query(`UPDATE tenants SET business_type = $2, is_internal = TRUE, status = 'active' WHERE id = $1`, [t.id, d.bt]);
      console.log('exists', d.slug, t.id);
    }

    await runAs(t.id, async () => {
      const q = (sql, p) => pool.query(sql, p);
      const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
      const mkMaster = async (name, spec) => {
        const ex = await one(`SELECT id FROM masters WHERE name = $1`, [name]);
        if (ex) return ex.id;
        return (await one(`INSERT INTO masters (name, specialty, active, provides_services) VALUES ($1,$2,true,true) RETURNING id`, [name, spec])).id;
      };
      const mkService = async (name, dur, price) => {
        const ex = await one(`SELECT id FROM services WHERE name = $1`, [name]);
        if (ex) return ex.id;
        return (await one(`INSERT INTO services (name, duration_min, price, active) VALUES ($1,$2,$3,true) RETURNING id`, [name, dur, price])).id;
      };
      const mkClient = async (name, phone) => {
        const ex = await one(`SELECT id FROM clients WHERE name = $1`, [name]);
        if (ex) return ex.id;
        return (await one(`INSERT INTO clients (name, phone, source) VALUES ($1,$2,'salon') RETURNING id`, [name, phone])).id;
      };
      const appt = async (masterId, serviceId, clientId, daysAhead, hour, durMin, status, roomId) => {
        const st = new Date(); st.setDate(st.getDate() + daysAhead); st.setHours(hour, 0, 0, 0);
        const en = new Date(+st + durMin * 60000);
        const ex = await one(`SELECT id FROM appointments WHERE master_id=$1 AND starts_at=$2`, [masterId, st.toISOString()]);
        if (ex) return ex.id;
        return (await one(
          `INSERT INTO appointments (client_id, master_id, service_id, starts_at, ends_at, status, price, source, room_id)
           VALUES ($1,$2,$3,$4,$5,$6,(SELECT price FROM services WHERE id=$3),'admin',$7) RETURNING id`,
          [clientId, masterId, serviceId, st.toISOString(), en.toISOString(), status, roomId || null])).id;
      };

      if (d.bt === 'dental') {
        const doc1 = await mkMaster('Лікар Марина Коваль', 'Терапевт-стоматолог');
        const doc2 = await mkMaster('Лікар Андрій Шевчук', 'Ортопед');
        const sCons = await mkService('Консультація + огляд', 30, 400);
        const sTreat = await mkService('Лікування карієсу', 60, 1800);
        const sCrown = await mkService('Встановлення коронки', 90, 7500);
        const p1 = await mkClient('Ірина Демченко (демо)', '380670000101');
        const p2 = await mkClient('Олег Демків (демо)', '380670000102');
        // зубні карти
        for (const [cid, teeth] of [[p1, [[16, 'caries'], [25, 'filling'], [36, 'crown']]], [p2, [[11, 'filling'], [46, 'pulpitis'], [48, 'extracted']]]]) {
          for (const [no, st] of teeth) {
            await q(`INSERT INTO dental_teeth (client_id, tooth_no, status) VALUES ($1,$2,$3)
                     ON CONFLICT (client_id, tooth_no) DO UPDATE SET status=EXCLUDED.status`, [cid, no, st]);
          }
        }
        // план лікування з етапами
        const plan = await one(`SELECT id FROM dental_plans WHERE client_id=$1 AND title=$2`, [p2, 'Протезування 46']);
        if (!plan) {
          const pl = await one(
            `INSERT INTO dental_plans (client_id, title, diagnosis, status, total_estimate) VALUES ($1,$2,$3,'in_progress',9300) RETURNING id`,
            [p2, 'Протезування 46', 'Пульпіт 46, потребує коронки']);
          await q(`INSERT INTO dental_plan_stages (plan_id, position, title, teeth, estimate, status) VALUES
                   ($1,0,'Лікування каналів',ARRAY[46],1800,'done'),
                   ($1,1,'Встановлення коронки',ARRAY[46],7500,'scheduled')`, [pl.id]);
        }
        await appt(doc1, sCons, p1, 1, 10, 30, 'booked');
        await appt(doc1, sTreat, p1, 1, 11, 60, 'booked');
        await appt(doc2, sCrown, p2, 2, 14, 90, 'booked');
        await appt(doc1, sCons, p2, -7, 12, 30, 'done');
      }

      if (d.bt === 'fitness') {
        const tr1 = await mkMaster('Тренер Оксана Литвин', 'Йога');
        const tr2 = await mkMaster('Тренер Максим Бондар', 'Функціональний тренінг');
        await mkService('Персональне тренування', 60, 700);
        const c1 = await mkClient('Наталія Савчук (демо)', '380670000201');
        const c2 = await mkClient('Дмитро Клименко (демо)', '380670000202');
        const ct = await one(`SELECT id FROM fitness_class_types WHERE name='Ранкова йога'`)
          || await one(`INSERT INTO fitness_class_types (name, duration_min, default_capacity) VALUES ('Ранкова йога',60,12) RETURNING id`);
        const ct2 = await one(`SELECT id FROM fitness_class_types WHERE name='Кросфіт WOD'`)
          || await one(`INSERT INTO fitness_class_types (name, duration_min, default_capacity) VALUES ('Кросфіт WOD',45,10) RETURNING id`);
        for (let day = 1; day <= 3; day++) {
          for (const [tid, trainer, hour] of [[ct.id, tr1, 8], [ct2.id, tr2, 18]]) {
            const st = new Date(); st.setDate(st.getDate() + day); st.setHours(hour, 0, 0, 0);
            const en = new Date(+st + 3600000);
            const ex = await one(`SELECT id FROM fitness_classes WHERE class_type_id=$1 AND starts_at=$2`, [tid, st.toISOString()]);
            if (!ex) {
              const cl = await one(
                `INSERT INTO fitness_classes (class_type_id, trainer_id, starts_at, ends_at, capacity) VALUES ($1,$2,$3,$4,12) RETURNING id`,
                [tid, trainer, st.toISOString(), en.toISOString()]);
              await q(`INSERT INTO fitness_class_bookings (class_id, client_id, status) VALUES ($1,$2,'booked'),($1,$3,'booked')
                       ON CONFLICT DO NOTHING`, [cl.id, c1, c2]).catch(() => {});
            }
          }
        }
        const sp = await one(`SELECT id FROM subscription_plans WHERE name='Демо 8 візитів'`);
        if (!sp) await q(`INSERT INTO subscription_plans (name, type, visits_included, duration_days, price, active)
                          VALUES ('Демо 8 візитів','visits',8,30,1600,true)`).catch(() => {});
      }

      if (d.bt === 'wellness') {
        const m1 = await mkMaster('Масажист Юлія Тарасенко', 'Масаж');
        const m2 = await mkMaster('Масажист Роман Гнатюк', 'СПА');
        const sMass = await mkService('Класичний масаж 60 хв', 60, 900);
        const sSpa = await mkService('СПА-програма для пари', 90, 2600);
        await q(`UPDATE services SET buffer_after=15 WHERE id=$1 AND COALESCE(buffer_after,0)=0`, [sMass]);
        const c1 = await mkClient('Вікторія Мельник (демо)', '380670000301');
        const c2 = await mkClient('Павло Мельник (демо)', '380670000302');
        const room1 = await one(`SELECT id FROM rooms WHERE name='Couples Suite (демо)'`)
          || await one(`INSERT INTO rooms (name, capacity, active) VALUES ('Couples Suite (демо)',2,true) RETURNING id`);
        const room2 = await one(`SELECT id FROM rooms WHERE name='Кабінет 1 (демо)'`)
          || await one(`INSERT INTO rooms (name, capacity, active) VALUES ('Кабінет 1 (демо)',1,true) RETURNING id`);
        await q(`INSERT INTO service_room_requirements (service_id, requires_room) VALUES ($1,true)
                 ON CONFLICT (service_id) DO NOTHING`, [sMass]);
        await appt(m1, sMass, c1, 1, 11, 60, 'booked', room2.id || room2);
        // парна бронь у couples-кабінеті
        const a1 = await appt(m1, sSpa, c1, 2, 15, 90, 'booked', room1.id || room1);
        const a2 = await appt(m2, sSpa, c2, 2, 15, 90, 'booked', room1.id || room1);
        const g = await one(`SELECT g.id FROM booking_groups g JOIN booking_group_items i ON i.group_id=g.id WHERE i.appointment_id=$1`, [a1]);
        if (!g) {
          const gr = await one(`INSERT INTO booking_groups (kind, room_id) VALUES ('couples',$1) RETURNING id`, [room1.id || room1]);
          await q(`INSERT INTO booking_group_items (group_id, appointment_id) VALUES ($1,$2),($1,$3) ON CONFLICT DO NOTHING`, [gr.id, a1, a2]);
        }
      }
    });
    console.log('seeded', d.slug);
  }
  console.log('DONE');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
