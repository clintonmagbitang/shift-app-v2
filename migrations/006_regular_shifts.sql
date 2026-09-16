BEGIN;
CREATE TABLE IF NOT EXISTS calendar_default_days_v2 (
 shift_date DATE NOT NULL,
 area TEXT NOT NULL CHECK(area IN ('barista','kitchen')),
 PRIMARY KEY(shift_date,area),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMIT;
