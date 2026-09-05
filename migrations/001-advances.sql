BEGIN;
CREATE TABLE IF NOT EXISTS employee_advance_ledger_v2 (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  transaction_date DATE NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('advance', 'repayment')),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  reference TEXT NOT NULL DEFAULT '' CHECK (length(reference) <= 500),
  remarks TEXT NOT NULL DEFAULT '' CHECK (length(remarks) <= 500),
  created_by INTEGER NOT NULL REFERENCES users(id),
  request_id UUID NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS employee_advance_ledger_v2_user_date ON employee_advance_ledger_v2(user_id, transaction_date, id);
COMMIT;
