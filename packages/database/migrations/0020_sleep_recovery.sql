-- Sleep/recovery phase 1 (2026-08-19): store two dashboard fields the client
-- already fetched and discarded. base ± sd is the athlete's personal
-- sleep-HRV band; full_recovery_hours is stamped onto the current day only.
ALTER TABLE daily_health ADD COLUMN sleep_hrv_sd REAL;
ALTER TABLE daily_health ADD COLUMN full_recovery_hours REAL;
