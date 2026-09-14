const {test} = require('node:test');
const assert = require('node:assert/strict');
const {ledgerAsOf} = require('../server/ledger-date');
test('cutoff date is optional for normal ledgers and preserves inclusive ISO dates',()=>{
 assert.equal(ledgerAsOf(undefined),null);
 assert.equal(ledgerAsOf('2026-05-15'),'2026-05-15');
 assert.equal(ledgerAsOf('2028-02-29'),'2028-02-29');
});
test('invalid or multiple cutoff dates are rejected instead of showing current balances',()=>{
 for(const value of ['', '2026-02-29','2026-05-32','May 15, 2026',['2026-05-15'],null]) assert.throws(()=>ledgerAsOf(value));
});
