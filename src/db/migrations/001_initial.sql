-- Lyra ilk schema
-- Tum runtime config ve state burada. .env sadece bootstrap icin.

PRAGMA foreign_keys = ON;

-- Migration takibi
CREATE TABLE IF NOT EXISTS _migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at INTEGER NOT NULL
);

-- Genel anahtar-deger ayarlar
-- Ornekler:
--   base_domain        -> "example.com"
--   public_access      -> "true" / "false"
--   subdomain_pattern  -> "code,files,db,dev-{port}"
--   app_name           -> "Andromeda"
--   projects_dir       -> "/home/user/projeler"
--   secondary_disk     -> "/mnt/data" (opsiyonel)
--   prod_apps_dir      -> "/opt/prod-apps" (opsiyonel)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Yonetilen servisler (systemd)
-- type: "core" | "code-server" | "cloudflared" | "filebrowser" | "dbgate" | "mongod" | "custom"
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_name TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  type TEXT NOT NULL,
  port INTEGER,
  subdomain TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_services_type ON services(type);
CREATE INDEX IF NOT EXISTS idx_services_enabled ON services(enabled);

-- Kullanicilar (v1: tek kullanici, ama tablo cok-kullaniciyi destekliyor)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

-- IP banlar (gecici veya kalici)
CREATE TABLE IF NOT EXISTS bans (
  ip TEXT PRIMARY KEY,
  reason TEXT,
  banned_at INTEGER NOT NULL,
  expires_at INTEGER,
  banned_by TEXT NOT NULL DEFAULT 'auto'
);

CREATE INDEX IF NOT EXISTS idx_bans_expires ON bans(expires_at);

-- Olay gunlugu (login, ban, ayar degisikligi, vs.)
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  ip TEXT,
  user_id INTEGER,
  details TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_log(event_type);

-- Dis servis entegrasyonlari (telegram, github, cloudflare, vs.)
-- config alani plaintext JSON. Bu bilincli bir karar: sifreleme anahtari da
-- ayni kullanicinin okuyabildigi bir yerde durmak zorunda oldugu icin gercek
-- koruma saglamaz. Koruma dosya izinlerinden gelir (DB 0600, LYRA_HOME 0700).
-- Gerekce ve operator sorumluluklari: SECURITY.md, db/repos/integrations.js
CREATE TABLE IF NOT EXISTS integrations (
  name TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  config TEXT,
  updated_at INTEGER NOT NULL
);
