require('dotenv').config();
const { resyncWriteOff } = require('./lib/consumables');
(async()=>{
  try { const r = await resyncWriteOff(5455); console.log('RESULT', JSON.stringify(r)); }
  catch(e){ console.error('ERR', e.message); }
  process.exit(0);
})();
