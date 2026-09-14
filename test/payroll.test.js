const test = require('node:test');
const assert = require('node:assert/strict');
const {createPayroll} = require('../server/payroll');
function harness({from='2026-05-01',to='2026-05-15',legacyRecord}={}) {
  let record, revision=0, posts=[];
  const query=async(sql,args=[])=>{
    if(sql.startsWith('SELECT ledger'))return {rows:[{ledger:'advances',balance:'500.00'},{ledger:'loans',balance:'7000.00'}]};
    if(sql.startsWith('SELECT sss'))return {rows:[{sss:300,philhealth:200,pagibig:100,sss_half:'both',philhealth_half:'first',pagibig_half:'second'}]};
    if(sql.startsWith('SELECT snapshot'))return {rows:[{loan_amount:'2100'}]};
    if(sql.startsWith('SELECT status') || sql.startsWith('SELECT id,status'))return {rows:record?[record]:[]};
    if(sql.startsWith('INSERT INTO payroll_records')){
      record={id:1,status:args[3],snapshot:JSON.parse(args[4]),revision:String(++revision)};
      return {rows:[{id:1,revision:record.revision}]};
    }
    if(sql.startsWith('INSERT INTO employee_')) posts.push({sql,args});
    return {rows:[]};
  };
  const client={query,release(){}};
  const payroll=createPayroll({pool:{query,connect:async()=>client},compute:async(req,res)=>res.json({employee:{id:req.query.user_id},days:[{date:'2026-05-15'}],payroll_record:legacyRecord,summary:{total_basic:10000,total_overtime:500,total_income:10500}})});
  async function call(method,body={},role='admin'){
    let code=200,data;const res={status(n){code=n;return this;},json(d){data=d;}};
    await payroll[method]({body,query:{user_id:2,from,to},user:{id:2,role}},res,...(method==='save'?[body.finalize===true,body.merge===true]:[]));return {code,data};
  }
  return {call,posts};
}
const base={user_id:2,from:'2026-05-01',to:'2026-05-15',expected_revision:null,sss:500,vale_amount:1000,loan_amount:200,other_adjustment:50};
test('autosave can edit an older payroll with NULL reference fields without replacing deductions',async()=>{
  const h=harness({from:'2026-07-16',to:'2026-07-31',legacyRecord:{sss:350,philhealth:125,pagibig:100,vale_amount:0,loan_amount:2100,vale_ref:null,loan_ref:null,other_particulars:null,bank_ref:null,remarks:null}});
  const saved=await h.call('save',{user_id:2,from:'2026-07-16',to:'2026-07-31',merge:true,changes:{vale_amount:'1000.00'}});
  assert.equal(saved.code,200);assert.equal(saved.data.payroll_record.vale_amount,1000);
  assert.equal(saved.data.payroll_record.sss,350);assert.equal(saved.data.payroll_record.philhealth,125);assert.equal(saved.data.payroll_record.pagibig,100);assert.equal(saved.data.payroll_record.loan_amount,2100);
  for(const key of ['vale_ref','loan_ref','other_particulars','bank_ref','remarks'])assert.equal(saved.data.payroll_record[key],'');
  assert.equal(h.posts.length,0);
});
test('worksheet and individual preview share deductions; finalize posts once at cutoff and freezes snapshot',async()=>{
  const h=harness();
  assert.equal((await h.call('save',base)).code,200);
  const preview=(await h.call('preview')).data;
  assert.equal(preview.payroll_record.sss,500);
  assert.equal(preview.payroll_record.final_income,8850);
  assert.equal(h.posts.length,0);
  assert.equal((await h.call('preview',{},'employee')).code,404);
  assert.equal((await h.call('save',{...base,finalize:true,expected_revision:preview.revision})).code,200);
  assert.equal(h.posts.length,2);
  assert.equal(h.posts[0].args[1],'2026-05-15');
  assert.equal(h.posts[0].args[2],1000);
  assert.equal(h.posts[1].args[2],200);
  assert.equal((await h.call('preview',{},'employee')).data.payroll_record.status,'finalized');
  assert.equal((await h.call('save',{...base,finalize:true})).code,409);
  assert.equal(h.posts.length,2);
});
test('stale forms cannot overwrite a newer draft',async()=>{
  const h=harness();await h.call('save',base);
  assert.equal((await h.call('save',{...base,sss:900})).code,409);
  assert.equal((await h.call('preview')).data.payroll_record.sss,500);
});
test('new prospective payroll receives capped vale, prior loan, and scheduled withholding',async()=>{
  const h=harness({from:'2026-09-01',to:'2026-09-15'});const p=(await h.call('preview')).data;
  assert.equal(p.payroll_record.vale_amount,500);assert.equal(p.payroll_record.loan_amount,2100);
  assert.equal(p.payroll_record.sss,300);assert.equal(p.payroll_record.philhealth,200);assert.equal(p.payroll_record.pagibig,0);
  assert.equal(p.balances.loans,7000);assert.equal(p.balance_as_of,'2026-09-15');
});
test('new defaults never replace historical previews or saved drafts, including deliberate zero amounts',async()=>{
  const historical=harness();assert.equal((await historical.call('preview')).data.payroll_record.sss,undefined);
  await historical.call('save',{...base,sss:0,vale_amount:0});
  assert.equal((await historical.call('preview')).data.payroll_record.sss,0);
  assert.equal((await historical.call('preview')).data.payroll_record.vale_amount,0);
  const future=harness({from:'2026-09-01',to:'2026-09-15'});
  await future.call('save',{...base,from:'2026-09-01',to:'2026-09-15',sss:0,vale_amount:0});
  assert.equal((await future.call('preview')).data.payroll_record.sss,0);
  assert.equal((await future.call('preview')).data.payroll_record.vale_amount,0);
});
test('two-way field saves merge other edits and use the latest saved value for the same field',async()=>{
  const h=harness();await h.call('save',base);
  const body={user_id:2,from:base.from,to:base.to,merge:true};
  await h.call('save',{...body,changes:{sss:800}});
  await h.call('save',{...body,changes:{vale_amount:400}});
  await h.call('save',{...body,changes:{sss:900}});
  const p=(await h.call('preview')).data.payroll_record;
  assert.equal(p.sss,900);assert.equal(p.vale_amount,400);assert.equal(p.loan_amount,200);assert.equal(h.posts.length,0);
  assert.equal((await h.call('save',{...body,changes:{status:'finalized'}})).code,400);
});
