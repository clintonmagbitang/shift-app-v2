BEGIN;
CREATE TABLE IF NOT EXISTS employee_pay_rates_v2 (
 id BIGSERIAL PRIMARY KEY,
 user_id INTEGER NOT NULL REFERENCES users(id),
 effective_from DATE NOT NULL,
 daily_rate NUMERIC(12,2) NOT NULL CHECK(daily_rate >= 0),
 created_by INTEGER REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(user_id,effective_from)
);
-- Preserve the existing rate as the baseline; older unrecorded rates cannot be inferred.
INSERT INTO employee_pay_rates_v2(user_id,effective_from,daily_rate)
SELECT id,DATE '0001-01-01',COALESCE(daily_rate,0) FROM users u
WHERE NOT EXISTS (SELECT 1 FROM employee_pay_rates_v2 r WHERE r.user_id=u.id);
COMMIT;
