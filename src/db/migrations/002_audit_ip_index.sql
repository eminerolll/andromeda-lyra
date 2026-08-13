-- Auto-ban sayimi artik (event_type, ip, ts) uzerinden yapiliyor.
-- 001'deki tekil idx_audit_event indeksi bu sorgu icin yeterli degil.

CREATE INDEX IF NOT EXISTS idx_audit_event_ip_ts ON audit_log(event_type, ip, ts);
