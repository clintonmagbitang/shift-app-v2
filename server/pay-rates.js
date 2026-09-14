const { Pool } = require('pg');
const { ledgerAsOf } = require('./ledger-date');
function rateOn(rates, date, fallback = 0) {
  const eligible = rates.filter(r => r.effective_from <= date).sort((a,b) => b.effective_from.localeCompare(a.effective_from));
  return Number(eligible[0]?.daily_rate ?? fallback);
}
function payRatesRouter({connectionString, requireAuth, requireAdmin}) {
  const router = require('express').Router();
  const pool = new Pool({connectionString});
  router.use(requireAuth, requireAdmin);
  router.get('/:id', async(req,res) => {
    try {
      const result = await pool.query('SELECT effective_from::text,daily_rate FROM employee_pay_rates_v2 WHERE user_id=$1 ORDER BY effective_from DESC',[req.params.id]);
      res.json(result.rows);
    } catch { res.status(500).json({error:'Unable to load rate history.'}); }
  });
  router.post('/:id', async(req,res) => {
    let date;
    try { date = ledgerAsOf(req.body.effective_from); } catch {}
    const amount = String(req.body.daily_rate ?? '');
    if (!date || date < '2026-05-01' || !/^\d{1,9}(\.\d{1,2})?$/.test(amount) || Number(amount)<=0) return res.status(400).json({error:'Enter a positive daily rate and an effective date from May 1, 2026 onward.'});
    let client;
    try {
      client = await pool.connect(); await client.query('BEGIN');
      const user = await client.query('SELECT daily_rate FROM users WHERE id=$1 FOR UPDATE',[req.params.id]);
      if (!user.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({error:'Employee not found.'}); }
      await client.query("INSERT INTO employee_pay_rates_v2(user_id,effective_from,daily_rate) VALUES($1,'0001-01-01',$2) ON CONFLICT DO NOTHING",[req.params.id,user.rows[0].daily_rate || 0]);
      const saved = await client.query('INSERT INTO employee_pay_rates_v2(user_id,effective_from,daily_rate,created_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id',[req.params.id,date,amount,req.user.id]);
      if (!saved.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({error:'A rate already exists on that date. Choose a new effective date.'}); }
      await client.query("UPDATE users SET daily_rate=(SELECT daily_rate FROM employee_pay_rates_v2 WHERE user_id=$1 AND effective_from <= (NOW() AT TIME ZONE 'Asia/Manila')::date ORDER BY effective_from DESC LIMIT 1) WHERE id=$1",[req.params.id]);
      await client.query('COMMIT'); res.json({ok:true});
    } catch { if(client) await client.query('ROLLBACK').catch(()=>{}); res.status(500).json({error:'Unable to save rate. No rate changes were kept.'}); }
    finally { client?.release(); }
  });
  return router;
}
module.exports = {rateOn,payRatesRouter};
