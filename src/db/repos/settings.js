// Key-value ayarlar. Domain, port'lar, brand vs.
// Value JSON-encoded saklanir; get() otomatik parse eder.

const { db } = require("../index");

function get(key, fallback = null) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch (_) {
    return row.value;
  }
}

function set(key, value) {
  const v = typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value);
  db.prepare(
    `
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `
  ).run(key, v, Date.now());
}

function getAll() {
  const rows = db.prepare("SELECT key, value FROM settings ORDER BY key").all();
  const out = {};
  for (const r of rows) {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch (_) {
      out[r.key] = r.value;
    }
  }
  return out;
}

function remove(key) {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

function setMany(obj) {
  const tx = db.transaction((entries) => {
    for (const [k, v] of entries) set(k, v);
  });
  tx(Object.entries(obj));
}

module.exports = { get, set, getAll, remove, setMany };
