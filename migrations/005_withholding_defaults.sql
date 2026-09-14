BEGIN;
CREATE TABLE IF NOT EXISTS employee_withholding_defaults_v2 (
 user_id INTEGER NOT NULL REFERENCES users(id),
 effective_from DATE NOT NULL CHECK(effective_from >= DATE '2026-09-01'),
 sss NUMERIC(12,2) NOT NULL CHECK(sss >= 0),
 philhealth NUMERIC(12,2) NOT NULL CHECK(philhealth >= 0),
 pagibig NUMERIC(12,2) NOT NULL CHECK(pagibig >= 0),
 sss_half TEXT NOT NULL DEFAULT 'both' CHECK(sss_half IN ('first','second','both')),
 philhealth_half TEXT NOT NULL DEFAULT 'both' CHECK(philhealth_half IN ('first','second','both')),
 pagibig_half TEXT NOT NULL DEFAULT 'both' CHECK(pagibig_half IN ('first','second','both')),
 updated_by INTEGER NOT NULL REFERENCES users(id),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(user_id,effective_from)
);
COMMIT;
