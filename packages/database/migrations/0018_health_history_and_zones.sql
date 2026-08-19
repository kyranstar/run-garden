-- Coach-input roadmap 1+2+4 (docs/reports/2026-08-18-coach-input-audit.md):
-- the dayDetail wire keys we discarded become per-day history, and the
-- athlete's own zone definitions get a home.
ALTER TABLE daily_health ADD COLUMN sleep_hrv_base REAL;
ALTER TABLE daily_health ADD COLUMN load_ratio REAL;
ALTER TABLE daily_health ADD COLUMN acute_ti REAL;
ALTER TABLE daily_health ADD COLUMN chronic_ti REAL;
ALTER TABLE daily_health ADD COLUMN day_load REAL;
ALTER TABLE daily_health ADD COLUMN vo2max REAL;

CREATE TABLE athlete_zones (
  user_id TEXT PRIMARY KEY,
  max_hr REAL,
  lthr REAL,
  ltsp REAL,
  lthr_zones TEXT,
  ltsp_zones TEXT,
  updated_at TEXT NOT NULL
);
