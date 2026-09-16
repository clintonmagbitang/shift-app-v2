const test=require('node:test'),assert=require('node:assert/strict');
const {createDeposits}=require('../server/payroll-deposits'),{context}=require('../server/payroll');
function fixture({status='finalized',bank=true}={}){
  const snapshot={days:[{basic_pay:500}],summary:{total_income:7000},payroll_record:{final_income:5500,sss:500,vale_amount:1000,bank_ref:''}};
  const original=JSON.parse(JSON.stringify(snapshot));const queries=[];
  const query=async(sql,args)=>{queries.push({sql,args});
    if(sql.startsWith('SELECT id,status'))return {rows:[{id:5,status,snapshot:JSON.parse(JSON.stringify(snapshot)),revision:'r1'}]};
    if(sql.startsWith('SELECT id,bank_name')){assert.deepEqual(args,[9,2]);return {rows:bank?[{id:9,bank_name:'Test Bank',account_number:'0012345'}]:[]};}
    if(sql.startsWith('UPDATE payroll_records')){Object.assign(snapshot,JSON.parse(args[0]));return {rows:[{revision:'r2'}]};}
    return {rows:[]};};
  const handler=createDeposits({pool:{query,connect:async()=>({query,release(){}})},context});
  async function call(body={}){let code=200,data;await handler.confirm({user:{id:7},body:{user_id:2,from:'2026-09-01',to:'2026-09-15',bank_account_id:9,reference:'DEP-123',expected_revision:'r1',...body}},{status(n){code=n;return this;},json(value){data=value;}});return {code,data};}
  return {call,snapshot,original,queries,handler};
}
test('deposit confirmation changes only reference metadata and preserves payroll amounts and account leading zeroes',async()=>{
 const h=fixture(),result=await h.call();assert.equal(result.code,200);
 assert.deepEqual(h.snapshot.days,h.original.days);assert.deepEqual(h.snapshot.summary,h.original.summary);
 assert.deepEqual(h.snapshot.payroll_record,{...h.original.payroll_record,bank_ref:'DEP-123'});
 assert.equal(h.snapshot.deposit_confirmation.account_number,'0012345');assert.equal(h.snapshot.deposit_confirmation.confirmed_by,7);assert.equal(h.snapshot.deposit_history.length,1);
 assert.equal(h.queries.some(q=>/employee_.*ledger/.test(q.sql)),false);
});
test('drafts, stale revisions, invalid references, and another employee bank account cannot be confirmed',async()=>{
 for(const [options,body,expected] of [[{status:'draft'},{},409],[{},{expected_revision:'old'},409],[{bank:false},{},400],[{},{reference:' '},400]]){
 const h=fixture(options);assert.equal((await h.call(body)).code,expected);assert.equal(h.queries.some(q=>q.sql.startsWith('UPDATE')),false);
 }
});
test('summary queries only finalized payroll for the selected cutoff and uses saved net pay',async()=>{
 const h=fixture();await h.handler.summary({query:{from:'2026-09-01',to:'2026-09-15'}},{json(){},status(){return this;}});
 const query=h.queries[0];assert.match(query.sql,/p.status='finalized'/);assert.match(query.sql,/final_income/);assert.deepEqual(query.args,['2026-09-01','2026-09-15']);
});
