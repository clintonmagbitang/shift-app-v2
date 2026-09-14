const test = require('node:test');
const assert = require('node:assert/strict');
const {rateOn} = require('../server/pay-rates');
test('effective rates preserve earlier cutoffs and change on the exact start date', () => {
  const rates = [{effective_from:'0001-01-01',daily_rate:'500.00'},{effective_from:'2026-09-14',daily_rate:'600.00'},{effective_from:'2027-01-01',daily_rate:'650.00'}];
  assert.equal(rateOn(rates,'2026-05-15',600),500);
  assert.equal(rateOn(rates,'2026-09-13',600),500);
  assert.equal(rateOn(rates,'2026-09-14',500),600);
  assert.equal(rateOn(rates,'2026-09-15',650),600);
  assert.equal(rateOn(rates,'2027-01-01'),650);
});
test('a cutoff spanning a rate change uses the applicable rate for each day',()=>{
  const rates=[{effective_from:'0001-01-01',daily_rate:500},{effective_from:'2026-05-10',daily_rate:600}];
  let total=0; for(let day=1;day<=15;day++) total+=rateOn(rates,`2026-05-${String(day).padStart(2,'0')}`);
  assert.equal(total,9*500+6*600);
  assert.equal(rateOn([],'2026-05-01',450),450);
});
