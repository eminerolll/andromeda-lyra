// Setup token: SSH'ta uretilir, browser wizard'a yapistirilir.
// Kurulum bitince invalidate edilir.

const crypto = require("crypto");
const { settings } = require("../db/repos");

const TOKEN_KEY = "_setup_token_hash";
const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 saat

function generate() {
  // 16 karakterli, gozle okunabilir token (4 grup, 4 karakter, dash ile ayrilmis)
  const charset = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // O, 0, I, 1 yok
  const buf = crypto.randomBytes(16);
  let raw = "";
  for (const b of buf) raw += charset[b % charset.length];
  return raw.match(/.{4}/g).join("-"); // ABCD-EFGH-JKLM-NPQR
}

function hash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function save(token) {
  settings.set(TOKEN_KEY, {
    hash: hash(token),
    expiresAt: Date.now() + TOKEN_TTL_MS,
    createdAt: Date.now()
  });
}

function verify(token) {
  if (!token || typeof token !== "string") return false;
  const stored = settings.get(TOKEN_KEY);
  if (!stored || !stored.hash) return false;
  if (stored.expiresAt && stored.expiresAt < Date.now()) {
    invalidate();
    return false;
  }
  const inputHash = hash(token.trim().toUpperCase());
  return crypto.timingSafeEqual(Buffer.from(stored.hash, "hex"), Buffer.from(inputHash, "hex"));
}

function invalidate() {
  settings.remove(TOKEN_KEY);
}

function exists() {
  const stored = settings.get(TOKEN_KEY);
  if (!stored || !stored.hash) return false;
  if (stored.expiresAt && stored.expiresAt < Date.now()) {
    invalidate();
    return false;
  }
  return true;
}

module.exports = { generate, save, verify, invalidate, exists, TOKEN_TTL_MS };
