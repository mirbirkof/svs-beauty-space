require('dotenv').config({path:__dirname+'/.env'});
const {Client}=require('pg');
(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});await c.connect();
const sqls=process.argv.slice(2);
for(const s of sqls){try{const r=await c.query(s);console.log('>>',s.slice(0,90));console.table(r.rows);}catch(e){console.log('ERR',e.message)}}
await c.end();})();
