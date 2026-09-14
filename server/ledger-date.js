function ledgerAsOf(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new Error('Enter a valid as_of date in YYYY-MM-DD format.');
  }
  return value;
}
module.exports = { ledgerAsOf };
