const test=require('node:test'),assert=require('node:assert/strict');
const {scheduledAmounts,initialAmounts,validateDefaults}=require('../server/payroll-defaults');
test('each contribution is applied only to its selected half',()=>{
  const record={sss:500,sss_half:'first',philhealth:300,philhealth_half:'second',pagibig:100,pagibig_half:'both'};
  assert.deepEqual(scheduledAmounts(record,'2026-09-01'),{sss:500,philhealth:0,pagibig:100});
  assert.deepEqual(scheduledAmounts(record,'2026-09-16'),{sss:0,philhealth:300,pagibig:100});
});
test('vale is capped at positive balance; loan copies the prior amount independently',()=>{
  for(const [balance,expected] of [[500,500],[5000,1000],[0,0],[-500,0]]){
    const values=initialAmounts({balances:{advances:balance},previous_loan_amount:2100,withholding_defaults:{sss:300}});
    assert.equal(values.vale_amount,expected);assert.equal(values.loan_amount,2100);
  }
});
test('withholding defaults reject historical effective dates and invalid schedules',()=>{
  const body={effective_from:'2026-09-01',sss:100,philhealth:200,pagibig:300,sss_half:'first',philhealth_half:'second',pagibig_half:'both'};
  assert.equal(validateDefaults(body).date,'2026-09-01');
  for(const patch of [{effective_from:'2026-08-16'},{effective_from:'2026-09-10'},{sss:-1},{sss_half:'monthly'}])assert.throws(()=>validateDefaults({...body,...patch}));
});
