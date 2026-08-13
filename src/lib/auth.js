// Auth: session middleware (SQLite store), password verify, TOTP 2FA, rate limiter.

const crypto = require("crypto");
const path = require("path");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const { authenticator } = require("otplib");

const config = require("./config");
// ban.js sadece db/repos + config'e bagli, auth.js'i geri require etmiyor —
// dairesel bagimlilik yok, lazy require gerekmiyor.
const ban = require("./ban");
const { users, settings } = require("../db/repos");

// express-session varsayilan cookie adi. buildSessionMiddleware'de
// degistirilmiyor; hasSessionCookie bu adi arar.
const SESSION_COOKIE_NAME = "connect.sid";

// Istek bir oturum cookie'si tasiyor mu? Tasiyorsa istek sahibi daha once
// giris yapmis (oturumu dusmus) bir kullanicidir — kor tarama degil.
// ban.noteUnauthorized bu ayrimi auto-ban sayacini beslerken kullanir.
function hasSessionCookie(req) {
  const raw = req && req.headers && req.headers.cookie;
  if (!raw) return false;
  return raw.split(";").some(c => c.trim().startsWith(SESSION_COOKIE_NAME + "="));
}

// Session secret: yoksa uret + DB'ye kaydet
function getSessionSecret() {
  let s = settings.get("session_secret");
  if (!s) {
    s = crypto.randomBytes(32).toString("hex");
    settings.set("session_secret", s);
  }
  return s;
}

function buildSessionMiddleware() {
  const ttlDays = config.get("session_ttl_days") || 30;
  const baseDomain = config.get("base_domain");
  const publicAccess = !!config.get("public_access");

  const cookie = {
    maxAge: ttlDays * 24 * 60 * 60 * 1000,
    sameSite: "lax",
    httpOnly: true,
    secure: publicAccess && !!baseDomain
  };
  // Subdomain'ler arasinda paylasilan cookie sadece public mode + base_domain varsa
  if (publicAccess && baseDomain) {
    cookie.domain = "." + baseDomain;
  }

  return session({
    store: new SQLiteStore({
      db: "lyra.db",
      dir: config.LYRA_HOME,
      table: "sessions"
    }),
    secret: getSessionSecret(),
    resave: false,
    saveUninitialized: false,
    cookie
  });
}

// Rate limiter: in-memory, IP basina pencere icinde max deneme.
const attempts = new Map();

function rateLimiter(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const windowMs = (config.get("rate_limit_window_minutes") || 15) * 60 * 1000;
  const max = config.get("rate_limit_attempts") || 5;

  const list = (attempts.get(ip) || []).filter(t => now - t < windowMs);
  if (list.length >= max) {
    return res.status(429).json({ error: "Cok fazla deneme. Bir sure sonra tekrar deneyin." });
  }
  attempts.set(ip, list);
  next();
}

function recordAttempt(ip) {
  const list = attempts.get(ip) || [];
  list.push(Date.now());
  attempts.set(ip, list);
}

function clearAttempts(ip) {
  attempts.delete(ip);
}

// Password + opsiyonel 2FA dogrula
function authenticate({ username, password, totpToken }) {
  const user = users.findByUsername(username);
  if (!user) return { ok: false, reason: "invalid_credentials" };
  if (!users.verifyPassword(user, password)) return { ok: false, reason: "invalid_credentials" };

  if (user.totp_enabled) {
    if (!totpToken) return { ok: false, reason: "totp_required" };
    const valid = authenticator.verify({ token: totpToken, secret: user.totp_secret });
    if (!valid) return { ok: false, reason: "invalid_totp" };
  }

  users.touchLogin(user.id);
  return { ok: true, user };
}

// TOTP secret + otpauth URI uret (QR icin)
function generateTotp(username) {
  const secret = authenticator.generateSecret();
  const issuer = config.get("app_name") || "Lyra";
  const otpauth = authenticator.keyuri(username, issuer, secret);
  return { secret, otpauth };
}

function verifyTotp(secret, token) {
  return authenticator.verify({ token, secret });
}

// Express middleware: oturum yoksa 401/redirect.
// Sadece /api/* 401'leri auto-ban sayacini besler — saldirgan login formunu hic
// kullanmadan API uzerinden sinirsiz deneme yapabiliyordu. HTML redirect'i
// beslemez, cunku giris yapmamis bir tarayici gezintisi ban sebebi degildir.
// Cookie tasiyan istekler de sayilmaz (bkz. hasSessionCookie).
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  if (req.path.startsWith("/api/")) {
    ban.noteUnauthorized(req.ip, { path: req.path }, { hasSession: hasSessionCookie(req) });
    return res.status(401).json({ error: "Yetkisiz" });
  }
  return res.redirect("/login");
}

// Setup tamamlanmadiysa setup sayfasina yonlendir
function requireSetupComplete(req, res, next) {
  if (config.isSetupComplete()) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(503).json({ error: "Setup tamamlanmamis. `npm run setup` calistir." });
  }
  return res.status(503).type("text/plain").send("Lyra kurulumu tamamlanmamis. Once `npm run setup` calistirin.");
}

module.exports = {
  buildSessionMiddleware, hasSessionCookie,
  rateLimiter, recordAttempt, clearAttempts,
  authenticate,
  generateTotp, verifyTotp,
  requireAuth, requireSetupComplete
};
