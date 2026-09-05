const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('node:crypto');
const { neon } = require('@neondatabase/serverless');
(async () => {
 const config=require('./v2-config')(),sql=neon(config.DATABASE_URL);
 const [admin]=await sql`SELECT id FROM users WHERE role='admin' LIMIT 1`;
 const [user]=await sql`SELECT id FROM users u WHERE role='employee' AND daily_rate>0
 AND NOT EXISTS(SELECT 1 FROM employee_ledger_openings_v2 o WHERE o.user_id=u.id)
 AND NOT EXISTS(SELECT 1 FROM payroll_records_v2 p WHERE p.user_id=u.id AND cutoff_from IN (DATE '2026-04-16',DATE '2026-05-01')) LIMIT 1`;
 assert.ok(user,'Need an employee with unused opening balances and test cutoffs.');
 const token=role=>jwt.sign({id:role==='admin'?admin.id:user.id,role},config.JWT_SECRET,{expiresIn:'5m'});
 async function call(path,body,role='admin') {
  const res=await fetch(`http://127.0.0.1:${config.PORT}${path}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token(role)}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  return {status:res.status,body:await res.json()};
 }
 const ledger=module=>call(`/api/v2/${module}?user_id=${user.id}`);
 const april={user_id:user.id,from:'2026-04-16',to:'2026-04-30',vale_amount:'500.00',loan_amount:'100.00'};
 const may={...april,from:'2026-05-01',to:'2026-05-15'};
 try {
  const before=await ledger('advances');
  assert.equal((await call('/api/v2/advances/opening',{user_id:user.id,balance:'2000.00'},'employee')).status,403);
  assert.equal((await call('/api/v2/advances/opening',{user_id:user.id,balance:'2000.00'})).status,201);
  assert.equal((await call('/api/v2/advances/opening',{user_id:user.id,balance:'2000.00'})).status,200);
  assert.equal((await call('/api/v2/advances/opening',{user_id:user.id,balance:'9000.00'})).status,409);
  assert.equal((await call('/api/v2/loans/opening',{user_id:user.id,balance:'0'})).status,201);
  assert.equal(Number((await ledger('advances')).body.balance),Number(before.body.balance)+2000);
  assert.equal((await call('/api/v2/advances',{user_id:user.id,amount:'10',type:'advance',transaction_date:'2026-04-30',request_id:randomUUID()})).status,400);
  assert.equal((await call('/admin/payroll-finalize',{...april,to:'2026-05-15'})).status,400);
  const afterOpening=await ledger('advances');
  assert.equal((await call('/admin/payroll-finalize',april)).status,200);
  assert.deepEqual((await ledger('advances')).body,afterOpening.body);
  assert.equal((await call('/admin/payroll-finalize',may)).status,200);
  assert.equal(Number((await ledger('advances')).body.balance),Number(afterOpening.body.balance)-500);
  const mine=await call(`/api/v2/advances?user_id=${admin.id}`,undefined,'employee');
  assert.ok(mine.body.transactions.some(t=>t.is_opening && t.transaction_date==='2026-04-30'));
  console.log('PASS: opening balance, zero balance, retry, overwrite protection, employee permissions, April no posting, May posting, and boundary checks.');
 } finally {
  for(const name of ['employee_advance_ledger_v2','employee_loan_ledger_v2']) {
   // Identifiers are fixed constants; values are bound parameters.
   await sql.query(`DELETE FROM ${name} WHERE payroll_record_id IN (SELECT id FROM payroll_records_v2 WHERE user_id=$1 AND cutoff_from IN (DATE '2026-04-16',DATE '2026-05-01'))`,[user.id]);
  }
  await sql`DELETE FROM payroll_records_v2 WHERE user_id=${user.id} AND cutoff_from IN (DATE '2026-04-16',DATE '2026-05-01')`;
  await sql`DELETE FROM employee_ledger_openings_v2 WHERE user_id=${user.id}`;
  console.log('Removed only the disposable opening balances and payroll test records.');
 }
})().catch(error=>{console.error('Opening balance verification failed:',error.code || error.message);process.exitCode=1;});
