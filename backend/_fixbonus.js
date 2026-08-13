require('dotenv').config();
const rec = require('./lib/bonus-reconcile');
(async()=>{ try{ const d = await rec.reconcileBonusCounters({dryRun:true}); console.log('DRY', JSON.stringify(d));
 const r = await rec.reconcileBonusCounters({}); console.log('FIX', JSON.stringify(r)); }catch(e){console.error('ERR',e.message);} process.exit(0); })();
