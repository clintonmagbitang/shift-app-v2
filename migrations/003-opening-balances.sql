BEGIN;
CREATE TABLE IF NOT EXISTS employee_ledger_openings_v2 (
 id BIGSERIAL PRIMARY KEY,
 user_id INTEGER NOT NULL REFERENCES users(id),
 ledger TEXT NOT NULL CHECK (ledger IN ('advances','loans')),
 balance NUMERIC(12,2) NOT NULL,
 as_of DATE NOT NULL DEFAULT '2026-04-30' CHECK (as_of = DATE '2026-04-30'),
 created_by INTEGER NOT NULL REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(user_id,ledger)
);
COMMIT;
