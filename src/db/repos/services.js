// Yonetilen servisler tablosu (systemd unit'leri).

const { db } = require("../index");

function list({ enabledOnly = false } = {}) {
  const sql = enabledOnly
    ? "SELECT * FROM services WHERE enabled = 1 ORDER BY type, unit_name"
    : "SELECT * FROM services ORDER BY type, unit_name";
  return db.prepare(sql).all().map(parseRow);
}

function getById(id) {
  const row = db.prepare("SELECT * FROM services WHERE id = ?").get(id);
  return row ? parseRow(row) : null;
}

function getByUnit(unitName) {
  const row = db.prepare("SELECT * FROM services WHERE unit_name = ?").get(unitName);
  return row ? parseRow(row) : null;
}

function getByType(type) {
  return db
    .prepare("SELECT * FROM services WHERE type = ? ORDER BY unit_name")
    .all(type)
    .map(parseRow);
}

function add({
  unit_name,
  display_name,
  type,
  port = null,
  subdomain = null,
  enabled = 1,
  config = null
}) {
  const cfg = config ? JSON.stringify(config) : null;
  const info = db
    .prepare(
      `
    INSERT INTO services (unit_name, display_name, type, port, subdomain, enabled, config, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(unit_name, display_name, type, port, subdomain, enabled ? 1 : 0, cfg, Date.now());
  return getById(info.lastInsertRowid);
}

function update(id, patch) {
  const allowed = ["unit_name", "display_name", "type", "port", "subdomain", "enabled", "config"];
  const fields = [];
  const values = [];
  for (const k of allowed) {
    if (patch[k] !== undefined) {
      fields.push(`${k} = ?`);
      values.push(k === "config" && patch[k] != null ? JSON.stringify(patch[k]) : patch[k]);
    }
  }
  if (!fields.length) return getById(id);
  values.push(id);
  db.prepare(`UPDATE services SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getById(id);
}

function remove(id) {
  db.prepare("DELETE FROM services WHERE id = ?").run(id);
}

function parseRow(row) {
  return {
    ...row,
    enabled: !!row.enabled,
    config: row.config ? safeJson(row.config) : null
  };
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch (_) {
    return null;
  }
}

module.exports = { list, getById, getByUnit, getByType, add, update, remove };
