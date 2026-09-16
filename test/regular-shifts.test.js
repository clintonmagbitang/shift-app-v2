const test=require('node:test'),assert=require('node:assert/strict');
const {regularShifts,weekDates,patterns,shiftValues}=require('../server/regular-shifts');
test('schedule starts September 16 with four barista and six kitchen slots daily',()=>{
 assert.deepEqual(weekDates('2026-09-14'),['2026-09-16','2026-09-17','2026-09-18','2026-09-19','2026-09-20']);
 assert.equal(patterns.barista.reduce((n,r)=>n+r[2],0),4);assert.equal(patterns.kitchen.reduce((n,r)=>n+r[2],0),6);
 assert.deepEqual(patterns.kitchen[2],['12:00','21:00',3]);assert.throws(()=>weekDates('2026-02-30'));
});
test('reopening a week preserves scheduled days and does not restore deleted defaults',async()=>{
 const markers=new Set(),inserted=[];
 const query=async(sql,args=[])=>{
  if(sql.startsWith('SELECT id FROM users'))return {rows:[{id:7}]};
  if(sql.startsWith('INSERT INTO calendar_default')){const key=args.join('|');if(markers.has(key))return {rows:[]};markers.add(key);return {rows:[{area:args[1]}]};}
  if(sql.startsWith('SELECT id FROM shifts'))return {rows:args[0]==='2026-09-16'&&args[1]==='barista'?[{id:99}]:[]};
  if(sql.startsWith('INSERT INTO shifts'))inserted.push(args);
  return {rows:[]};
 };
 const api=regularShifts({pool:{connect:async()=>({query,release(){}})}});
 await api.ensureWeek('2026-09-14');assert.equal(inserted.length,27);assert.ok(inserted.every(r=>r[0]>='2026-09-16'));assert.ok(!inserted.some(r=>r[0]==='2026-09-16'&&r[1]==='barista'));
 inserted.length=0;await api.ensureWeek('2026-09-14');assert.equal(inserted.length,0);
});
test('editing rejects invalid times, insufficient slots, and shifts with attendance',async()=>{
 assert.throws(()=>shiftValues({start_time:'21:00',end_time:'12:00',slots:3}));
 for(const attendance of [true,false]){
  const queries=[];const api=regularShifts({pool:{connect:async()=>({release(){},query:async(sql)=>{queries.push(sql);if(sql.startsWith('SELECT id FROM shifts'))return {rows:[{id:1}]};if(sql.startsWith('SELECT id FROM timesheets'))return {rows:attendance?[{id:4}]:[]};if(sql.startsWith('SELECT COUNT'))return {rows:[{count:3}]};return {rows:[]};}})}});
  let status;await api.edit({params:{id:1},body:{start_time:'08:00',end_time:'17:00',slots:2}},{status(n){status=n;return this;},json(){}});assert.equal(status,409);assert.ok(!queries.some(q=>q.startsWith('UPDATE')));
 }
});
