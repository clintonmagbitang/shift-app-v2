const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const deductions = ['vale_amount','loan_amount','other_amount','withholding_tax','sss','philhealth','pagibig'];
function context(input) {
  const userId = Number(input.user_id);
  if (!Number.isSafeInteger(userId) || userId < 1) throw new Error('Choose an employee.');
  for (const date of [input.from, input.to]) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date) throw new Error('Invalid cutoff date.');
  }
  if (input.to < input.from || (Date.parse(input.to)-Date.parse(input.from))/86400000 > 62) throw new Error('Choose a cutoff of at most 63 days.');
  if (input.from <= '2026-04-30' && input.to > '2026-04-30') throw new Error('Choose separate cutoffs before and after the April 30 opening balance.');
  return { userId, from: input.from, to: input.to };
}
function adjustments(input) {
  const result = {};
  for (const key of [...deductions, 'other_adjustment']) {
    const value = String(input[key] ?? 0);
    const pattern = key === 'other_adjustment' ? /^-?\d{1,9}(\.\d{1,2})?$/ : /^\d{1,9}(\.\d{1,2})?$/;
    if (!pattern.test(value)) throw new Error(`Invalid ${key}: use an amount with up to two decimal places.`);
    result[key] = Number(value);
  }
  for (const key of ['vale_ref','loan_ref','other_particulars','bank_ref','remarks']) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 500)) throw new Error(`${key} must be at most 500 characters.`);
    result[key] = input[key] || '';
  }
  return result;
}
function createPayroll({ connectionString, compute }) {
  const pool = new Pool({ connectionString });
  async function calculation(ctx) {
    let code = 200; let payload;
    await compute({ query: { user_id: ctx.userId, from: ctx.from, to: ctx.to } }, {
      status(value) { code = value; return this; }, json(value) { payload = value; }
    });
    if (code !== 200 || !payload) throw new Error(payload?.error || 'Payroll calculation failed.');
    return payload;
  }
  async function preview(req, res) {
    try {
      const ctx = context({ ...req.query, user_id: req.user.role === 'admin' ? req.query.user_id : req.user.id });
      const { rows } = await pool.query('SELECT status,snapshot FROM payroll_records_v2 WHERE user_id=$1 AND cutoff_from=$2 AND cutoff_to=$3', [ctx.userId,ctx.from,ctx.to]);
      if (rows.length && rows[0].status === 'finalized') return res.json(rows[0].snapshot);
      if (req.user.role !== 'admin') return res.status(404).json({ error: 'No finalized V2 payslip for this cutoff yet.' });
      const payload = await calculation(ctx);
      // A legacy finalized record has no V2 posting or immutable daily snapshot.
      payload.payroll_record = rows.length ? rows[0].snapshot.payroll_record : { ...payload.payroll_record, status: 'draft' };
      res.json(payload);
    } catch (error) { res.status(400).json({ error: error.message.startsWith('Invalid') || error.message.startsWith('Choose') ? error.message : 'Unable to load payroll for this cutoff.' }); }
  }
  async function save(req, res, finalize = true) {
    let ctx, values;
    try { ctx = context(req.body); values = adjustments(req.body); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    let client;
    try {
      client = await pool.connect(); await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`payroll:${ctx.userId}:${ctx.from}:${ctx.to}`]);
      const existing = await client.query('SELECT id,status FROM payroll_records_v2 WHERE user_id=$1 AND cutoff_from=$2 AND cutoff_to=$3 FOR UPDATE', [ctx.userId,ctx.from,ctx.to]);
      if (existing.rows[0]?.status === 'finalized') {
        await client.query('ROLLBACK'); return res.status(409).json({ error: 'Payroll is finalized. Unlock it before making changes.' });
      }
      const payload = await calculation(ctx);
      const cents = n => Math.round(Number(n) * 100);
      const basic = cents(payload.summary.total_basic), overtime = cents(payload.summary.total_overtime);
      const net = basic + overtime - deductions.reduce((sum,key) => sum+cents(values[key]),0) + cents(values.other_adjustment);
      const status = finalize ? 'finalized' : 'draft';
      payload.summary = { total_basic: basic/100, total_overtime: overtime/100, total_income: (basic+overtime)/100 };
      payload.payroll_record = { ...values, final_basic: basic/100, final_overtime: overtime/100, final_income: net/100, status, cutoff_from: ctx.from, cutoff_to: ctx.to };
      const saved = await client.query(`INSERT INTO payroll_records_v2(user_id,cutoff_from,cutoff_to,status,snapshot)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,cutoff_from,cutoff_to) DO UPDATE SET status=EXCLUDED.status,snapshot=EXCLUDED.snapshot,updated_at=NOW() RETURNING id`, [ctx.userId,ctx.from,ctx.to,status,JSON.stringify(payload)]);
      const id = saved.rows[0].id;
      if (finalize && ctx.from > '2026-04-30') {
        for (const [table,key,reference] of [['employee_advance_ledger_v2','vale_amount','vale_ref'],['employee_loan_ledger_v2','loan_amount','loan_ref']]) {
          if (values[key] > 0) await client.query(`INSERT INTO ${table}(user_id,transaction_date,type,amount,reference,remarks,created_by,request_id,payroll_record_id)
            VALUES($1,$2,'repayment',$3,$4,$5,$6,$7,$8)`, [ctx.userId,ctx.to,values[key],values[reference],`Payroll ${ctx.from} to ${ctx.to}`,req.user.id,randomUUID(),id]);
        }
      }
      await client.query('COMMIT'); res.json({ ok: true, status });
    } catch { if (client) await client.query('ROLLBACK').catch(() => {}); res.status(500).json({ error: 'Payroll could not be saved. No partial ledger postings were kept.' }); }
    finally { if (client) client.release(); }
  }
  async function unlock(req,res) {
    let ctx;
    try { ctx = context(req.body); } catch(error) { return res.status(400).json({ error:error.message }); }
    let client;
    try {
      client = await pool.connect(); await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`payroll:${ctx.userId}:${ctx.from}:${ctx.to}`]);
      const result = await client.query('SELECT id FROM payroll_records_v2 WHERE user_id=$1 AND cutoff_from=$2 AND cutoff_to=$3 FOR UPDATE',[ctx.userId,ctx.from,ctx.to]);
      if (!result.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({error:'V2 payroll record not found.'}); }
      const id = result.rows[0].id;
      await client.query('DELETE FROM employee_advance_ledger_v2 WHERE payroll_record_id=$1',[id]);
      await client.query('DELETE FROM employee_loan_ledger_v2 WHERE payroll_record_id=$1',[id]);
      await client.query(`UPDATE payroll_records_v2 SET status='draft', snapshot=jsonb_set(snapshot,'{payroll_record,status}','"draft"'),updated_at=NOW() WHERE id=$1`,[id]);
      await client.query('COMMIT'); res.json({ok:true});
    } catch { if(client) await client.query('ROLLBACK').catch(()=>{}); res.status(500).json({error:'Unable to unlock payroll. No partial changes were kept.'}); }
    finally { if(client) client.release(); }
  }
  async function history(req,res) {
    try {
      const result = await pool.query("SELECT cutoff_from::text,cutoff_to::text FROM payroll_records_v2 WHERE user_id=$1 AND status='finalized' ORDER BY cutoff_from DESC",[req.user.id]);
      res.json(result.rows);
    } catch { res.status(500).json({error:'Unable to load payroll history.'}); }
  }
  return { preview, save, unlock, history };
}
module.exports = { createPayroll, context, adjustments };
