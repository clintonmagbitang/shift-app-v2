const express = require('express');

function validateTransaction(body) {
  const userId = Number(body.user_id);
  if (!Number.isSafeInteger(userId) || userId < 1) throw new Error('Choose an employee.');
  if (!['advance', 'repayment'].includes(body.type)) throw new Error('Choose advance or repayment.');
  const amount = String(body.amount ?? '');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) throw new Error('Enter a positive amount with up to two decimal places.');
  const date = body.transaction_date;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('Enter a valid transaction date.');
  if (date <= '2026-04-30') throw new Error('Use the April 30 opening balance for earlier amounts. Enter transactions from May 1, 2026 onward.');
  if (typeof body.request_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.request_id)) throw new Error('Invalid submission ID. Reload the page.');
  for (const field of ['reference', 'remarks']) {
    if (body[field] !== undefined && (typeof body[field] !== 'string' || body[field].length > 500)) throw new Error(`${field} must be at most 500 characters.`);
  }
  return { userId, amount, date, type: body.type, requestId: body.request_id, reference: (body.reference || '').trim(), remarks: (body.remarks || '').trim() };
}

function loansRouter({ sql, requireAuth, requireAdmin, enabled }) {
  const router = express.Router();
  router.use(requireAuth);
  router.use((req, res, next) => {
    if (!enabled) return res.status(503).json({ error: 'Loans is waiting for the separate V2 development database to be configured.' });
    if (!['admin', 'employee'].includes(req.user.role)) return res.status(403).json({ error: 'Access denied.' });
    next();
  });
  router.get('/employees', requireAdmin, async (req, res) => {
    try {
      res.json(await sql`SELECT id, name FROM users WHERE role = 'employee' ORDER BY name, id`);
    } catch { res.status(500).json({ error: 'Unable to load employees.' }); }
  });
  router.get('/', async (req, res) => {
    const userId = req.user.role === 'admin' ? Number(req.query.user_id) : Number(req.user.id);
    if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).json({ error: 'Choose an employee.' });
    try {
      const rows = await sql`
        SELECT id, transaction_date::text, type, amount::text, reference, remarks, is_opening,
          CASE WHEN type = 'advance' THEN amount ELSE 0 END::text AS debit,
          CASE WHEN type = 'repayment' THEN amount ELSE 0 END::text AS credit,
          (SUM(CASE WHEN type = 'advance' THEN amount ELSE -amount END)
            OVER (ORDER BY transaction_date, id ROWS UNBOUNDED PRECEDING))::text AS balance
        FROM (
          SELECT id,user_id,transaction_date,type,amount,reference,remarks,false AS is_opening FROM employee_loan_ledger_v2
          UNION ALL
          SELECT -id,user_id,as_of AS transaction_date,CASE WHEN balance >= 0 THEN 'advance' ELSE 'repayment' END AS type,
            ABS(balance) AS amount,'Opening balance' AS reference,'Closing balance as of April 30, 2026' AS remarks,true AS is_opening
          FROM employee_ledger_openings_v2 WHERE ledger = 'loans'
        ) ledger WHERE user_id = ${userId}
        ORDER BY transaction_date, id`;
      res.json({ transactions: rows, balance: rows.length ? rows[rows.length - 1].balance : '0.00' });
    } catch { res.status(500).json({ error: 'Unable to load loans. Check that the V2 migration has been applied.' }); }
  });
  router.post('/opening', requireAdmin, async (req,res) => {
    const userId = Number(req.body.user_id);
    const balance = String(req.body.balance ?? '');
    if (!Number.isSafeInteger(userId) || userId < 1 || !/^-?\d{1,9}(\.\d{1,2})?$/.test(balance)) return res.status(400).json({error:'Choose an employee and enter a balance with up to two decimal places.'});
    try {
      const employees = await sql`SELECT id FROM users WHERE id = ${userId} AND role = 'employee'`;
      if (!employees.length) return res.status(400).json({error:'Employee not found.'});
      const rows = await sql`INSERT INTO employee_ledger_openings_v2(user_id,ledger,balance,created_by)
        VALUES(${userId},'loans',${balance},${req.user.id})
        ON CONFLICT(user_id,ledger) DO NOTHING RETURNING id`;
      if (!rows.length) {
        const existing = await sql`SELECT id FROM employee_ledger_openings_v2 WHERE user_id=${userId} AND ledger='loans' AND balance=${balance}::numeric`;
        if (!existing.length) return res.status(409).json({error:'An opening balance is already saved. It cannot be overwritten; record a dated correction instead.'});
      }
      res.status(rows.length ? 201 : 200).json({ok:true});
    } catch { res.status(500).json({error:'Unable to save opening balance. You can retry safely.'}); }
  });
  router.post('/', requireAdmin, async (req, res) => {
    let tx;
    try { tx = validateTransaction(req.body); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    try {
      const employees = await sql`SELECT id FROM users WHERE id = ${tx.userId} AND role = 'employee'`;
      if (!employees.length) return res.status(400).json({ error: 'Employee not found.' });
      const rows = await sql`
        INSERT INTO employee_loan_ledger_v2 (user_id, transaction_date, type, amount, reference, remarks, created_by, request_id)
        VALUES (${tx.userId}, ${tx.date}, ${tx.type}, ${tx.amount}, ${tx.reference}, ${tx.remarks}, ${req.user.id}, ${tx.requestId}::uuid)
        ON CONFLICT (request_id) DO NOTHING RETURNING id`;
      if (!rows.length) {
        const existing = await sql`SELECT id FROM employee_loan_ledger_v2 WHERE request_id = ${tx.requestId}::uuid
          AND user_id = ${tx.userId} AND transaction_date = ${tx.date}::date AND type = ${tx.type}
          AND amount = ${tx.amount}::numeric AND reference = ${tx.reference} AND remarks = ${tx.remarks} AND created_by = ${req.user.id}`;
        if (!existing.length) return res.status(409).json({ error: 'This submission ID was already used for a different transaction.' });
        return res.json({ id: existing[0].id, duplicate: true });
      }
      res.status(201).json({ id: rows[0].id });
    } catch { res.status(500).json({ error: 'Unable to save the transaction. You can retry safely.' }); }
  });
  return router;
}
module.exports = { loansRouter, validateTransaction };
