const test = require('node:test');
const assert = require('node:assert/strict');
const {createPayroll} = require('../server/payroll');
function harness() {
  let record, revision=0, posts=[];
  const query=async(sql,args=[])=>{
    if(sql.startsWith('SELECT status') || sql.startsWith('SELECT id,status'))return {rows:record?[record]:[]};
    if(sql.startsWith('INSERT INTO payroll_records')){
      record={id:1,status:args[3],snapshot:JSON.parse(args[4]),revision:String(++revision)};
      return {rows:[{id:1,revision:record.revision}]};
    }
    if(sql.startsWith('INSERT INTO employee_')) posts.push({sql,args});
    return {rows:[]};
  };
  const client={query,release(){}};
  const payroll=createPayroll({pool:{query,connect:async()=>client},compute:async(req,res)=>res.json({employee:{id:req.query.user_id},days:[{date:'2026-05-15'}],summary:{total_basic:10000,total_overtime:500,total_income:10500}})});
  async function call(method,body={},role='admin'){
    let code=200,data;const res={status(n){code=n;return this;},json(d){data=d;}};
    await payroll[method]({body,query:{user_id:2,from:'2026-05-01',to:'2026-05-15'},user:{id:2,role}},res,...(method==='save'?[body.finalize===true]:[]));return {code,data};
  }
  return {call,posts};
}
const base={user_id:2,from:'2026-05-01',to:'2026-05-15',expected_revision:null,sss:500,vale_amount:1000,loan_amount:200,other_adjustment:50};
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
