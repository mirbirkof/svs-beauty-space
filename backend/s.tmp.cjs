const {Client}=require("pg");
(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});await c.connect();
 const cols=(await c.query("SELECT column_name FROM information_schema.columns WHERE table_name='settings'")).rows.map(r=>r.column_name);
 console.log('settings cols:',cols.join(','));
 const sample=(await c.query("SELECT * FROM settings LIMIT 3")).rows;
 console.log('sample:',JSON.stringify(sample).slice(0,300));
 await c.end()})().catch(e=>{console.error("FAIL",e.message)});
