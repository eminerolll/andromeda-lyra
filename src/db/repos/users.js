// Kullanici tablosu. v1'de tek admin var, ama tablo cok-kullaniciya hazir.

const bcrypt = require("bcryptjs");
const { db } = require("../index");

const BCRYPT_ROUNDS = 12;

function findByUsername(username) {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username) || null;
}

function findById(id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) || null;
}

function getAdmin() {
  return db.prepare("SELECT * FROM users ORDER BY id LIMIT 1").get() || null;
}

function exists() {
  return db.prepare("SELECT COUNT(*) AS c FROM users").get().c > 0;
}

function create({ username, password, totpSecret = null, totpEnabled = false }) {
  const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  const info = db
    .prepare(
      `
    INSERT INTO users (username, password_hash, totp_secret, totp_enabled, created_at)
    VALUES (?, ?, ?, ?, ?)
  `
    )
    .run(username, hash, totpSecret, totpEnabled ? 1 : 0, Date.now());
  return findById(info.lastInsertRowid);
}

function verifyPassword(user, password) {
  if (!user || !user.password_hash) return false;
  return bcrypt.compareSync(password, user.password_hash);
}

function setPassword(id, password) {
  const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, id);
}

function setTotp(id, { secret, enabled }) {
  db.prepare("UPDATE users SET totp_secret = ?, totp_enabled = ? WHERE id = ?").run(
    secret,
    enabled ? 1 : 0,
    id
  );
}

function disableTotp(id) {
  db.prepare("UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?").run(id);
}

function touchLogin(id) {
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(Date.now(), id);
}

module.exports = {
  findByUsername,
  findById,
  getAdmin,
  exists,
  create,
  verifyPassword,
  setPassword,
  setTotp,
  disableTotp,
  touchLogin
};
