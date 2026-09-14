const {Pool} = require('pg');
const {ledgerAsOf} = require('./ledger-date');
const keys = ['sss','philhealth','pagibig'];
function validateDefaults(body) {
  const date = ledgerAsOf(body.effective_from);
  if (!date || date < '2026-09-01' || !['01','16'].includes(date.slice(8))) throw new Error('Choose a cutoff starting on the 1st or 16th, from September 2026 onward.');
  const values={};
  for(const key of keys){const value=String(body[key]??'');if(!/^\d{1,9}(\.\d{1,2})?$/.test(value))throw new Error('Enter nonnegative amounts with up to two decimal places.');values[key]=Number(value);if(!['first','second','both'].includes(body[key+'_half']))throw new Error('Choose first half, second half, or both for each deduction.');values[key+'_half']=body[key+'_half'];}
  return {date,values};
}
async function payrollBasis(pool,ctx) {
  const result = await pool.query(`SELECT ledger,SUM(amount)::text AS balance FROM (
    SELECT ledger,balance AS amount FROM employee_ledger_openings_v2 WHERE user_id=$1 AND as_of <= $2::date
    UNION ALL SELECT 'advances',CASE WHEN type='advance' THEN amount ELSE -amount END FROM employee_advance_ledger_v2 WHERE user_id=$1 AND transaction_date <= $2::date
    UNION ALL SELECT 'loans',CASE WHEN type='advance' THEN amount ELSE -amount END FROM employee_loan_ledger_v2 WHERE user_id=$1 AND transaction_date <= $2::date
  ) entries GROUP BY ledger`,[ctx.userId,ctx.to]);
  const balances={advances:0,loans:0};for(const row of result.rows)balances[row.ledger]=Number(row.balance);
  const defaults=await pool.query('SELECT sss,philhealth,pagibig,sss_half,philhealth_half,pagibig_half,effective_from::text FROM employee_withholding_defaults_v2 WHERE user_id=$1 AND effective_from <= $2::date ORDER BY effective_from DESC LIMIT 1',[ctx.userId,ctx.from]);
  const prior=await pool.query("SELECT snapshot->'payroll_record'->>'loan_amount' AS loan_amount FROM payroll_records_v2 WHERE user_id=$1 AND cutoff_to=$2::date - 1 ORDER BY cutoff_from DESC LIMIT 1",[ctx.userId,ctx.from]);
  return {balances,withholding_defaults:scheduledAmounts(defaults.rows[0],ctx.from),previous_loan_amount:Number(prior.rows[0]?.loan_amount || 0),balance_as_of:ctx.to};
}
function scheduledAmounts(record={},from) {
  const half=Number(from.slice(8))<=15?'first':'second';
  return Object.fromEntries(keys.map(key=>[key,record[key+'_half']==='both' || record[key+'_half']===half ? Number(record[key] || 0):0]));
}
function initialAmounts(basis) {
  return {...basis.withholding_defaults,vale_amount:Math.min(1000,Math.max(0,basis.balances.advances)),loan_amount:basis.previous_loan_amount};
}
function defaultsRouter({connectionString,requireAuth,requireAdmin}) {
  const router=require('express').Router(),pool=new Pool({connectionString});router.use(requireAuth,requireAdmin);
  router.get('/',async(req,res)=>{
    let date;try{date=ledgerAsOf(req.query.from);if(!date)throw new Error();}catch{return res.status(400).json({error:'Choose a valid cutoff.'});}
    try{
      const result=await pool.query(`SELECT u.id,u.name,d.effective_from::text,COALESCE(d.sss,0) AS sss,COALESCE(d.philhealth,0) AS philhealth,COALESCE(d.pagibig,0) AS pagibig,
        COALESCE(d.sss_half,'both') AS sss_half,COALESCE(d.philhealth_half,'both') AS philhealth_half,COALESCE(d.pagibig_half,'both') AS pagibig_half
        FROM users u LEFT JOIN LATERAL (SELECT * FROM employee_withholding_defaults_v2 WHERE user_id=u.id AND effective_from <= $1::date ORDER BY effective_from DESC LIMIT 1) d ON TRUE
        WHERE u.role='employee' AND u.status='active' ORDER BY u.name,u.id`,[date]);res.json(result.rows);
    }catch{res.status(500).json({error:'Unable to load withholding defaults.'});}
  });
  router.post('/:id',async(req,res)=>{
    let data;try{data=validateDefaults(req.body);}catch(e){return res.status(400).json({error:e.message});}
    try{
      const result=await pool.query(`INSERT INTO employee_withholding_defaults_v2(user_id,effective_from,sss,philhealth,pagibig,updated_by,sss_half,philhealth_half,pagibig_half)
        SELECT id,$2,$3,$4,$5,$6,$7,$8,$9 FROM users WHERE id=$1 AND role='employee' AND status='active'
        ON CONFLICT(user_id,effective_from) DO UPDATE SET sss=EXCLUDED.sss,philhealth=EXCLUDED.philhealth,pagibig=EXCLUDED.pagibig,sss_half=EXCLUDED.sss_half,philhealth_half=EXCLUDED.philhealth_half,pagibig_half=EXCLUDED.pagibig_half,updated_by=EXCLUDED.updated_by,updated_at=NOW() RETURNING user_id`,[req.params.id,data.date,data.values.sss,data.values.philhealth,data.values.pagibig,req.user.id,data.values.sss_half,data.values.philhealth_half,data.values.pagibig_half]);
      if(!result.rows.length)return res.status(404).json({error:'Active employee not found.'});res.json({ok:true});
    }catch{res.status(500).json({error:'Unable to save withholding defaults.'});}
  });return router;
}
module.exports={payrollBasis,defaultsRouter,validateDefaults,scheduledAmounts,initialAmounts};
