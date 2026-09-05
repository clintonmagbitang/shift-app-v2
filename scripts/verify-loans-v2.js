const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const jwt = require('jsonwebtoken');
const { neon } = require('@neondatabase/serverless');
(async () => {
  const config = require('./v2-config')();
  const sql = neon(config.DATABASE_URL);
  const admins = await sql`SELECT id FROM users WHERE role = 'admin' LIMIT 1`;
  const employees = await sql`SELECT id FROM users WHERE role = 'employee' ORDER BY id LIMIT 2`;
  assert.ok(admins.length && employees.length > 1, 'Need admin and two employee records for isolation verification.');
  const adminToken = jwt.sign({ id: admins[0].id, role: 'admin' }, config.JWT_SECRET, { expiresIn: '5m' });
  const employeeToken = jwt.sign({ id: employees[0].id, role: 'employee' }, config.JWT_SECRET, { expiresIn: '5m' });
  const base = `http://127.0.0.1:${config.PORT}/api/v2/loans`;
  async function call(token, path = '', body) {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  const ids = [randomUUID(), randomUUID()];
  try {
    const before = await call(adminToken, `?user_id=${employees[0].id}`); assert.equal(before.status, 200);
    const advance = { user_id: employees[0].id, type: 'advance', amount: '2000.00', transaction_date: '2026-09-05', reference: 'Disposable V2 integration check', request_id: ids[0] };
    assert.equal((await call(adminToken, '', advance)).status, 201);
    assert.equal((await call(adminToken, '', advance)).body.duplicate, true);
    const repayment = { ...advance, type: 'repayment', amount: '500.00', request_id: ids[1] };
    assert.equal((await call(adminToken, '', repayment)).status, 201);
    const after = await call(adminToken, `?user_id=${employees[0].id}`);
    assert.equal(Number(after.body.balance), Number(before.body.balance) + 1500);
    assert.equal(after.body.transactions.length, before.body.transactions.length + 2);
    const own = await call(employeeToken, `?user_id=${employees[1].id}`);
    assert.deepEqual(own.body, after.body);
    assert.equal((await call(employeeToken, '', advance)).status, 403);
    console.log('PASS: persisted loans/repayments, 1500 balance change, duplicate retry protection, employee isolation and write rejection.');
  } finally {
    await sql`DELETE FROM employee_loan_ledger_v2 WHERE request_id IN (${ids[0]}::uuid, ${ids[1]}::uuid)`;
    console.log('Removed only the two disposable integration-test transactions from the development branch.');
  }
})().catch(() => { console.error('V2 integration verification failed.'); process.exitCode = 1; });
