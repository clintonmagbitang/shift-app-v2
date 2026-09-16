const {Pool}=require('pg');
const {ledgerAsOf}=require('./ledger-date');
const START='2026-09-16';
const patterns={barista:[['08:00','17:00',1],['10:00','19:00',1],['12:00','21:00',2]],kitchen:[['07:00','16:00',1],['08:00','17:00',2],['12:00','21:00',3]]};
function weekDates(week){if(!ledgerAsOf(week))throw Error('Choose a valid week.');const start=new Date(week+'T00:00:00Z');return Array.from({length:7},(_,i)=>new Date(start.getTime()+i*86400000).toISOString().slice(0,10)).filter(d=>d>=START);}
function shiftValues(body){
 const start=String(body.start_time||''),end=String(body.end_time||''),slots=Number(body.slots);
 if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(start)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(end)||start>=end||!Number.isSafeInteger(slots)||slots<1||slots>100)throw Error('Enter valid same-day start/end times and 1–100 slots.');
 return {start,end,slots};
}
function regularShifts({connectionString,pool=new Pool({connectionString})}) {
 async function ensureWeek(week){
  const dates=weekDates(week);if(!dates.length)return;
  const c=await pool.connect();try{await c.query('BEGIN');
   const admin=await c.query("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1");if(!admin.rows.length)throw Error('Admin account required.');
   for(const date of dates)for(const [area,rows] of Object.entries(patterns)){
    const added=await c.query('INSERT INTO calendar_default_days_v2(shift_date,area) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING area',[date,area]);
    if(!added.rows.length)continue;
    const existing=await c.query('SELECT id FROM shifts WHERE shift_date=$1::date AND area=$2 LIMIT 1',[date,area]);
    if(existing.rows.length)continue;
    for(const [start,end,slots] of rows)await c.query('INSERT INTO shifts(shift_date,area,start_time,end_time,slots,created_by) VALUES($1,$2,$3,$4,$5,$6)',[date,area,start,end,slots,admin.rows[0].id]);
   }await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 }
 async function edit(req,res){
  const id=Number(req.params.id);let values;
  try{if(!Number.isSafeInteger(id)||id<1)throw Error('Invalid shift.');values=shiftValues(req.body);}catch(e){return res.status(400).json({error:e.message});}
  let c;try{c=await pool.connect();await c.query('BEGIN');const shift=await c.query('SELECT id FROM shifts WHERE id=$1 FOR UPDATE',[id]);
   if(!shift.rows.length){await c.query('ROLLBACK');return res.status(404).json({error:'Shift no longer exists.'});}
   const attendance=await c.query('SELECT id FROM timesheets WHERE shift_id=$1 LIMIT 1',[id]);
   if(attendance.rows.length){await c.query('ROLLBACK');return res.status(409).json({error:'This shift already has a timesheet. Its scheduled hours cannot be changed.'});}
   const claims=await c.query("SELECT COUNT(*)::int AS count FROM shift_assignments WHERE shift_id=$1 AND status IN ('pending','approved')",[id]);
   if(values.slots<claims.rows[0].count){await c.query('ROLLBACK');return res.status(409).json({error:'Slots cannot be fewer than the pending and approved claims.'});}
   await c.query('UPDATE shifts SET start_time=$1,end_time=$2,slots=$3 WHERE id=$4',[values.start,values.end,values.slots,id]);await c.query('COMMIT');res.json({ok:true});
  }catch{if(c)await c.query('ROLLBACK').catch(()=>{});res.status(500).json({error:'Unable to update shift.'});}finally{c?.release();}
 }
 return {ensureWeek,edit};
}
module.exports={regularShifts,patterns,weekDates,shiftValues};
