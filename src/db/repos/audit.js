// Olay kaydi. Login, ban, ayar degisikligi vs.

const { db } = require("../index");

function log({ event_type, ip = null, user_id = null, details = null }) {
  db.prepare(`
    INSERT INTO audit_log (ts, event_type, ip, user_id, details)
    VALUES (?, ?, ?, ?, ?)
  `).run(Date.now(), event_type, ip, user_id, details ? JSON.stringify(details) : null);
}

function recent({ limit = 100, eventType = null } = {}) {
  if (eventType) {
    return db.prepare("SELECT * FROM audit_log WHERE event_type = ? ORDER BY ts DESC LIMIT ?").all(eventType, limit).map(parse);
  }
  return db.prepare("SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?").all(limit).map(parse);
}

// eventType tek string veya string dizisi olabilir.
// ip verilirse sayim sadece o IP'ye daraltilir — auto-ban icin sart,
// yoksa baska IP'lerin hatalari masum bir IP'yi banlatir.
function countSince({ eventType, sinceMs, ip = null }) {
  const types = Array.isArray(eventType) ? eventType : [eventType];
  const placeholders = types.map(() => "?").join(", ");
  let sql = `SELECT COUNT(*) AS c FROM audit_log WHERE event_type IN (${placeholders}) AND ts >= ?`;
  const params = [...types, sinceMs];
  if (ip) {
    sql += " AND ip = ?";
    params.push(ip);
  }
  return db.prepare(sql).get(...params).c;
}

function parse(row) {
  return { ...row, details: row.details ? safeJson(row.details) : null };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch (_) { return null; }
}

module.exports = { log, recent, countSince };
