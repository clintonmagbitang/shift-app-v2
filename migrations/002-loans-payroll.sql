BEGIN;
CREATE TABLE IF NOT EXISTS employee_loan_ledger_v2 (
 id BIGSERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
 transaction_date DATE NOT NULL, type TEXT NOT NULL CHECK(type IN ('advance','repayment')),
 amount NUMERIC(12,2) NOT NULL CHECK(amount > 0), reference TEXT NOT NULL DEFAULT '',
 remarks TEXT NOT NULL DEFAULT '', created_by INTEGER NOT NULL REFERENCES users(id),
 request_id UUID NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS employee_loan_ledger_v2_user_date ON employee_loan_ledger_v2(user_id,transaction_date,id);
CREATE TABLE IF NOT EXISTS payroll_records_v2 (
 id BIGSERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
 cutoff_from DATE NOT NULL, cutoff_to DATE NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','finalized')),
 snapshot JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(user_id,cutoff_from,cutoff_to), CHECK(cutoff_to >= cutoff_from)
);
ALTER TABLE employee_advance_ledger_v2 ADD COLUMN IF NOT EXISTS payroll_record_id BIGINT REFERENCES payroll_records_v2(id);
ALTER TABLE employee_loan_ledger_v2 ADD COLUMN IF NOT EXISTS payroll_record_id BIGINT REFERENCES payroll_records_v2(id);
CREATE UNIQUE INDEX IF NOT EXISTS advance_payroll_posting_v2 ON employee_advance_ledger_v2(payroll_record_id) WHERE payroll_record_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS loan_payroll_posting_v2 ON employee_loan_ledger_v2(payroll_record_id) WHERE payroll_record_id IS NOT NULL;
COMMIT;
