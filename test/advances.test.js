const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { advancesRouter, validateTransaction } = require('../server/advances');
const valid = { user_id: 2, type: 'advance', amount: '2000.50', transaction_date: '2026-09-05', request_id: 'e859d084-fdfa-4475-8801-e6402f7a5a58' };
test('rejects invalid money, dates, employee IDs, and transaction types', () => {
  for (const patch of [{ amount: '-1' }, { amount: '0' }, { amount: '1.001' }, { amount: '1e3' }, { transaction_date: '2026-02-30' }, { user_id: 1.5 }, { type: 'other' }, { reference: {} }]) {
    assert.throws(() => validateTransaction({ ...valid, ...patch }));
  }
  assert.equal(validateTransaction(valid).amount, '2000.50');
});
async function harness(t, { role = 'employee', enabled = true, sql = async () => [] } = {}) {
  const app = express(); app.use(express.json());
  app.use('/advances', advancesRouter({ sql, enabled,
    requireAuth(req, res, next) { if (!role) return res.sendStatus(401); req.user = { id: 2, role }; next(); },
    requireAdmin(req, res, next) { if (req.user.role !== 'admin') return res.sendStatus(403); next(); }
  }));
  const server = await new Promise((resolve, reject) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); s.on('error', reject); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return (suffix = '', options) => fetch(`http://127.0.0.1:${server.address().port}/advances${suffix}`, options);
}
test('employee cannot request another employee ledger', async t => {
  let values;
  const request = await harness(t, { sql: async (strings, ...args) => { values = args; return []; } });
  const response = await request('?user_id=999'); assert.equal(response.status, 200); assert.deepEqual(values, [2]);
});
test('employee cannot record transactions or list employees', async t => {
  const request = await harness(t, { sql: async () => { assert.fail('Database must not be queried'); } });
  assert.equal((await request('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(valid) })).status, 403);
  assert.equal((await request('/employees')).status, 403);
});
test('unauthenticated and unconfigured requests cannot access ledger', async t => {
  assert.equal((await (await harness(t, { role: null }))()).status, 401);
  assert.equal((await (await harness(t, { enabled: false }))()).status, 503);
});
test('admin saves validated transaction and duplicate retry does not insert twice', async t => {
  let inserted = false;
  const request = await harness(t, { role: 'admin', sql: async (strings) => {
    const query = strings.join('?');
    if (query.includes('FROM users')) return [{ id: 2 }];
    if (query.includes('INSERT')) { if (inserted) return []; inserted = true; return [{ id: 9 }]; }
    return [{ id: 9 }];
  } });
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(valid) };
  assert.equal((await request('', options)).status, 201);
  const retry = await request('', options); assert.equal(retry.status, 200); assert.equal((await retry.json()).duplicate, true);
});
test('database failure returns a safe error without financial or credential details', async t => {
  const request = await harness(t, { sql: async () => { throw new Error('secret database details'); } });
  const response = await request(); assert.equal(response.status, 500); assert.ok(!(await response.text()).includes('secret'));
});
