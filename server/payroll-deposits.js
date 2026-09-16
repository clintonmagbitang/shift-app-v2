function createDeposits({pool,context}) {
  async function summary(req,res) {
    try {
      const ctx=context({...req.query,user_id:1});
      const result=await pool.query(`SELECT p.user_id,u.name,p.updated_at::text AS revision,
        p.snapshot->'payroll_record'->>'final_income' AS net_pay,
        p.snapshot->'payroll_record'->>'bank_ref' AS bank_ref,
        p.snapshot->'deposit_confirmation' AS deposit_confirmation,
        COALESCE((SELECT json_agg(json_build_object('id',b.id,'bank_name',b.bank_name,'account_number',b.account_number) ORDER BY b.id) FROM user_bank_accounts b WHERE b.user_id=u.id),'[]') AS bank_accounts
        FROM payroll_records_v2 p JOIN users u ON u.id=p.user_id
        WHERE p.status='finalized' AND p.cutoff_from=$1 AND p.cutoff_to=$2 ORDER BY u.name,u.id`,[ctx.from,ctx.to]);
      res.json(result.rows);
    }catch{res.status(400).json({error:'Unable to load the finalized payroll summary.'});}
  }
  async function confirm(req,res) {
    let ctx;const reference=typeof req.body.reference==='string'?req.body.reference.trim():'';
    try{ctx=context(req.body);}catch(e){return res.status(400).json({error:e.message});}
    const bankId=Number(req.body.bank_account_id);
    if(!reference || reference.length>500 || !Number.isSafeInteger(bankId) || bankId<1)return res.status(400).json({error:'Choose a bank account and enter a deposit reference of at most 500 characters.'});
    let client;
    try {
      client=await pool.connect();await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`payroll:${ctx.userId}:${ctx.from}:${ctx.to}`]);
      const result=await client.query('SELECT id,status,snapshot,updated_at::text AS revision FROM payroll_records_v2 WHERE user_id=$1 AND cutoff_from=$2 AND cutoff_to=$3 FOR UPDATE',[ctx.userId,ctx.from,ctx.to]);
      const record=result.rows[0];
      if(!record || record.status!=='finalized'){await client.query('ROLLBACK');return res.status(409).json({error:'Only finalized payroll can have a deposit confirmed. Reload the summary.'});}
      if(record.revision!==req.body.expected_revision){await client.query('ROLLBACK');return res.status(409).json({error:'This payroll changed. Reload the summary before confirming.'});}
      const bank=await client.query('SELECT id,bank_name,account_number FROM user_bank_accounts WHERE id=$1 AND user_id=$2',[bankId,ctx.userId]);
      if(!bank.rows[0]?.account_number || !bank.rows[0]?.bank_name){await client.query('ROLLBACK');return res.status(400).json({error:'Add complete bank details to the employee profile first.'});}
      const snapshot=record.snapshot;
      const confirmation={reference,...bank.rows[0],net_pay:snapshot.payroll_record.final_income,confirmed_at:new Date().toISOString(),confirmed_by:req.user.id};
      snapshot.payroll_record.bank_ref=reference;
      snapshot.deposit_confirmation=confirmation;
      snapshot.deposit_history=[...(snapshot.deposit_history||[]),confirmation];
      const saved=await client.query('UPDATE payroll_records_v2 SET snapshot=$1,updated_at=NOW() WHERE id=$2 RETURNING updated_at::text AS revision',[JSON.stringify(snapshot),record.id]);
      await client.query('COMMIT');res.json({ok:true,revision:saved.rows[0].revision,deposit_confirmation:confirmation});
    }catch{if(client)await client.query('ROLLBACK').catch(()=>{});res.status(500).json({error:'Unable to confirm the deposit reference. Please reload to check its status before retrying.'});}
    finally{client?.release();}
  }
  return {summary,confirm};
}
module.exports={createDeposits};
