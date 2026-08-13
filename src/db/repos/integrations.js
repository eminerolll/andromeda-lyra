// Dis servis entegrasyonlari: telegram, github, cloudflare credentials.
//
// config alani PLAINTEXT JSON olarak saklanir ve bu bilincli bir karardir,
// gecici bir durum degil. Sifreleme eklenmedi cunku anahtarin gidebilecegi
// her yer (ayni DB, LYRA_HOME altinda 0600 bir dosya, systemd
// EnvironmentFile) Lyra process'inin kendi kullanicisi tarafindan
// okunabilir. DB'yi okuyabilen saldirgan zaten o kullanicidir; anahtari da
// okur. Yani sifreleme gercek bir saldirgani durdurmaz, sadece denetimde
// iyi gorunur.
//
// Korunma DOSYA IZINLERINDEN gelir: DB 0600, LYRA_HOME 0700, Lyra
// unprivileged calisir. Tehdit modeli ve operatorun yapmasi gerekenler
// (token rotasyonu, dar scope) icin bkz. SECURITY.md > "Entegrasyon
// token'lari rest'te plaintext".

const { db } = require("../index");

function get(name) {
  const row = db.prepare("SELECT * FROM integrations WHERE name = ?").get(name);
  if (!row) return null;
  return {
    name: row.name,
    enabled: !!row.enabled,
    config: row.config ? safeJson(row.config) : null,
    updated_at: row.updated_at
  };
}

function set(name, { enabled = false, config = null }) {
  const cfg = config ? JSON.stringify(config) : null;
  db.prepare(`
    INSERT INTO integrations (name, enabled, config, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      enabled = excluded.enabled,
      config = excluded.config,
      updated_at = excluded.updated_at
  `).run(name, enabled ? 1 : 0, cfg, Date.now());
  return get(name);
}

function isEnabled(name) {
  const row = db.prepare("SELECT enabled FROM integrations WHERE name = ?").get(name);
  return !!(row && row.enabled);
}

function list() {
  return db.prepare("SELECT name, enabled, updated_at FROM integrations ORDER BY name").all()
    .map(r => ({ ...r, enabled: !!r.enabled }));
}

function remove(name) {
  db.prepare("DELETE FROM integrations WHERE name = ?").run(name);
}

function safeJson(s) {
  try { return JSON.parse(s); } catch (_) { return null; }
}

module.exports = { get, set, isEnabled, list, remove };
