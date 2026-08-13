require('dotenv').config();
const { Pool } = require('pg');
const url = process.env.DATABASE_URL;
const pool = new Pool({ connectionString:url, ssl:{rejectUnauthorized:false} });
const rules=[
  [/манікюр|педикюр|нігт/i,'Нігтьовий сервіс'],
  [/вій|брів|брови/i,'Брови та вії'],
  [/масаж|ліфтинг|детокс|лімфо|drain|sculpt|booty|корекція (нижньої|зони)|метаболічн|baланс|launch|обличчя/i,'Масаж та тіло'],
  [/стрижк|фарбуванн|миття|біовирівнюванн|холодне відновленн|контур|голови|чубчик|кінчик/i,'Перукарські послуги'],
];
(async()=>{
  const rows=(await pool.query(`SELECT id,name FROM services WHERE category ~ '^[0-9a-f]{8}-'`)).rows;
  let n=0;
  for(const s of rows){
    let cat='Інші послуги';
    for(const [re,c] of rules){ if(re.test(s.name)){cat=c;break;} }
    await pool.query(`UPDATE services SET category=$1 WHERE id=$2`,[cat,s.id]); n++;
  }
  const dist=(await pool.query(`SELECT category,count(*) FROM services GROUP BY category ORDER BY 2 DESC`)).rows;
  console.log('fixed',n);console.log(JSON.stringify(dist));
  await pool.end();
})().catch(e=>{console.error(e.message);process.exit(1)});
