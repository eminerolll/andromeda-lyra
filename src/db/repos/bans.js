// IP ban tablosu. Memory cache ile hizli istek-yolu kontrolu.
// LAN/loopback whitelist (RFC1918) burada degil; ban.js middleware'inde.

const { db } = require("../index");

const cache = new Set();
const meta = new Map();
let loaded = false;

function load() {
  cache.clear();
  meta.clear();
  const rows = db.prepare("SELECT * FROM bans").all();
  for (const r of rows) {
    if (r.expires_at && r.expires_at < Date.now()) {
      db.prepare("DELETE FROM bans WHERE ip = ?").run(r.ip);
      continue;
    }
    cache.add(r.ip);
    meta.set(r.ip, r);
  }
  loaded = true;
}

function isBanned(ip) {
  if (!loaded) load();
  if (!cache.has(ip)) return false;
  const m = meta.get(ip);
  if (m && m.expires_at && m.expires_at < Date.now()) {
    unban(ip);
    return false;
  }
  return true;
}

function ban(ip, { reason = null, durationMs = null, by = "auto" } = {}) {
  const now = Date.now();
  const expires = durationMs ? now + durationMs : null;
  db.prepare(`
    INSERT INTO bans (ip, reason, banned_at, expires_at, banned_by)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(ip) DO UPDATE SET
      reason = excluded.reason,
      banned_at = excluded.banned_at,
      expires_at = excluded.expires_at,
      banned_by = excluded.banned_by
  `).run(ip, reason, now, expires, by);
  cache.add(ip);
  meta.set(ip, { ip, reason, banned_at: now, expires_at: expires, banned_by: by });
}

function unban(ip) {
  db.prepare("DELETE FROM bans WHERE ip = ?").run(ip);
  cache.delete(ip);
  meta.delete(ip);
}

// Suresi dolmus kayitlar listede olu satir olarak gorunuyordu — once temizle.
function purgeExpired() {
  const now = Date.now();
  const expired = [];
  for (const m of meta.values()) {
    if (m.expires_at && m.expires_at < now) expired.push(m.ip);
  }
  for (const ip of expired) unban(ip);
}

function list() {
  if (!loaded) load();
  purgeExpired();
  return Array.from(meta.values()).sort((a, b) => b.banned_at - a.banned_at);
}

function getMeta(ip) {
  if (!loaded) load();
  const m = meta.get(ip);
  if (!m) return null;
  if (m.expires_at && m.expires_at < Date.now()) {
    unban(ip);
    return null;
  }
  return m;
}

module.exports = { load, isBanned, ban, unban, list, getMeta };
