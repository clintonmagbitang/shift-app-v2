const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const {neon} = require('@neondatabase/serverless');
(async()=>{
 const config=require('./v2-config')(); const sql=neon(config.DATABASE_URL);
 const [admin]=await sql`SELECT id FROM users WHERE role='admin' LIMIT 1`;
 const employees=await sql`SELECT id FROM users WHERE role='employee' AND daily_rate>0 ORDER BY id LIMIT 2`;
 assert.ok(admin && employees.length===2);
 const user=employees[0]; const from='2099-01-01',to='2099-01-15';
 const existing=await sql`SELECT id FROM payroll_records_v2 WHERE user_id=${user.id} AND cutoff_from=${from}::date AND cutoff_to=${to}::date`;
 assert.equal(existing.length,0,'Disposable test cutoff must be unused.');
 const token=(role,id)=>jwt.sign({role,id},config.JWT_SECRET,{expiresIn:'5m'});
 async function call(path,body,auth=token('admin',admin.id)){
  const response=await fetch(`http://127.0.0.1:${config.PORT}${path}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${auth}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,body:await response.json()};
 }
 const payload={user_id:user.id,from,to,vale_amount:'500.00',loan_amount:'200.00',withholding_tax:'50.00',sss:'25.00',philhealth:'10.00',pagibig:'5.00',other_amount:'2.00',other_adjustment:'100.00',remarks:'Disposable integration test',final_income:999999};
 const ctx=`?user_id=${user.id}&from=${from}&to=${to}`;
 try{
  assert.equal((await call('/api/v2/loans'+`?user_id=${user.id}`)).status,200);
  assert.equal((await call('/admin/payroll-draft',payload)).status,200);
  let posts=await sql`SELECT id FROM employee_advance_ledger_v2 WHERE payroll_record_id IN (SELECT id FROM payroll_records_v2 WHERE user_id=${user.id} AND cutoff_from=${from}::date)`;assert.equal(posts.length,0);
  assert.equal((await call('/api/v2/my-payroll'+ctx,undefined,token('employee',user.id))).status,404);
  const attempts=await Promise.all([call('/admin/payroll-finalize',payload),call('/admin/payroll-finalize',payload)]);
  assert.deepEqual(attempts.map(r=>r.status).sort(),[200,409]);
  let preview=await call('/admin/payroll-preview'+ctx);assert.equal(preview.status,200);
  const pr=preview.body.payroll_record;
  assert.equal(pr.final_income,Math.round((preview.body.summary.total_income-792+100)*100)/100);
  assert.equal(pr.withholding_tax,50);
  const own=await call('/api/v2/my-payroll'+ctx,undefined,token('employee',user.id));assert.deepEqual(own.body,preview.body);
  assert.equal((await call('/api/v2/my-payroll'+ctx,undefined,token('employee',employees[1].id))).status,404);
  assert.equal((await call('/admin/payroll-finalize',payload,token('employee',user.id))).status,403);
  posts=await sql`SELECT amount::text FROM employee_advance_ledger_v2 WHERE payroll_record_id IN (SELECT id FROM payroll_records_v2 WHERE user_id=${user.id} AND cutoff_from=${from}::date)`;assert.deepEqual(posts.map(r=>r.amount),['500.00']);
  let loans=await sql`SELECT amount::text FROM employee_loan_ledger_v2 WHERE payroll_record_id IN (SELECT id FROM payroll_records_v2 WHERE user_id=${user.id} AND cutoff_from=${from}::date)`;assert.deepEqual(loans.map(r=>r.amount),['200.00']);
  assert.equal((await call('/admin/payroll-unlock',payload)).status,200);
  posts=await sql`SELECT id FROM employee_advance_ledger_v2 WHERE payroll_record_id IN (SELECT id FROM payroll_records_v2 WHERE user_id=${user.id} AND cutoff_from=${from}::date)`;assert.equal(posts.length,0);
  assert.equal((await call('/api/v2/my-payroll'+ctx,undefined,token('employee',user.id))).status,404);
  assert.equal((await call('/admin/payroll-finalize',{...payload,vale_amount:'600.00'})).status,200);
  posts=await sql`SELECT amount::text FROM employee_advance_ledger_v2 WHERE payroll_record_id IN (SELECT id FROM payroll_records_v2 WHERE user_id=${user.id} AND cutoff_from=${from}::date)`;assert.deepEqual(posts.map(r=>r.amount),['600.00']);
  await call('/admin/payroll-unlock',payload);
  assert.equal((await call('/admin/payroll-finalize',payload,token('admin',2147483647))).status,500);
  preview=await call('/admin/payroll-preview'+ctx);assert.equal(preview.body.payroll_record.status,'draft');
  posts=await sql`SELECT id FROM employee_advance_ledger_v2 WHERE payroll_record_id IN (SELECT id FROM payroll_records_v2 WHERE user_id=${user.id} AND cutoff_from=${from}::date)`;assert.equal(posts.length,0);
  console.log('PASS: draft, authoritative net pay, manual deductions, concurrent finalization, both ledger postings, read-only employee isolation, unlock/refinalize, and failure rollback.');
 }finally{
  await sql`DELETE FROM employee_advance_ledger_v2 WHERE payroll_record_id IN (SELECT id FROM payroll_records_v2 WHERE user_id=${user.id} AND cutoff_from=${from}::date AND cutoff_to=${to}::date)`;
  await sql`DELETE FROM employee_loan_ledger_v2 WHERE payroll_record_id IN (SELECT id FROM payroll_records_v2 WHERE user_id=${user.id} AND cutoff_from=${from}::date AND cutoff_to=${to}::date)`;
  await sql`DELETE FROM payroll_records_v2 WHERE user_id=${user.id} AND cutoff_from=${from}::date AND cutoff_to=${to}::date`;
  console.log('Removed disposable 2099 payroll test records from the development branch.');
 }
})().catch(error=>{console.error('Payroll integration check failed:',error.code || error.message);process.exitCode=1;});
