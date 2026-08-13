// IP ban middleware. RFC1918 LAN + loopback whitelist hardcoded (universal).
// Ban listesi DB'den memory cache'e yuklenir.

const { bans, audit } = require("../db/repos");
const config = require("./config");

// Auto-ban iki ayri sayac kullanir:
//   login_fail  -> login formundan gelen hatali denemeler, dusuk esik (auto_ban_after)
//   api_unauth  -> kimlik tasimayan /api/* ve WS 401'leri, yuksek esik (auto_ban_api_after)
// Tek sayacta birlestirilirse dashboard'in acilistaki API cagirilari
// kullaniciyi kendi esigiyle banlar.
const LOGIN_EVENTS = ["login_fail"];
const API_EVENTS = ["api_unauth"];

const ALWAYS_WHITELIST = [
  /^127\./,
  /^::1$/,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./
];

function isWhitelisted(ip) {
  if (!ip) return true;
  return ALWAYS_WHITELIST.some(re => re.test(ip));
}

function normalizeIp(ip) {
  if (!ip) return null;
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  return ip;
}

function isBanned(ip) {
  ip = normalizeIp(ip);
  if (!ip || isWhitelisted(ip)) return false;
  return bans.isBanned(ip);
}

// opts.userId verilirse audit kaydi o kullaniciya baglanir (panelden manuel ban).
function ban(ip, opts = {}) {
  ip = normalizeIp(ip);
  if (!ip || isWhitelisted(ip)) return false;
  const { userId = null, ...banOpts } = opts;
  bans.ban(ip, banOpts);
  audit.log({ event_type: "ip_banned", ip, user_id: userId, details: banOpts });
  return true;
}

function unban(ip, opts = {}) {
  ip = normalizeIp(ip);
  if (!ip) return;
  bans.unban(ip);
  audit.log({ event_type: "ip_unbanned", ip, user_id: opts.userId || null });
}

function middleware(req, res, next) {
  const ip = normalizeIp(req.ip);
  if (isBanned(ip)) {
    return res.status(403).json({ error: "IP banlandi" });
  }
  next();
}

// Ham req'ten istemci IP'si (proxy yolu ve WebSocket upgrade, Express disi)
function requestIp(req) {
  const fwd = req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"];
  return normalizeIp(fwd ? fwd.split(",")[0].trim() : req.socket.remoteAddress);
}

// Ham req'lerden ban kontrol (proxy yolu, Express middleware'ini bypass eder)
function isRequestBanned(req) {
  return isBanned(requestIp(req));
}

// Yetkisiz istek kaydi + auto-ban degerlendirmesi.
// Sadece /api/* 401'leri ve WS upgrade reddi icin cagrilir; HTML sayfa
// redirect'lerinde CAGRILMAZ — normal tarayici gezintisi kullaniciyi banlamamali.
//
// opts.hasSession: istek bir oturum cookie'si tasiyorsa (suresi dolmus/gecersiz
// oturum) sayac beslenmez. Bu istek kor tarama degil, giris yapmis olan ama
// oturumu dusmus kullanicidir; tek sayfa yuklemesinde kendini banlayamamali.
function noteUnauthorized(ip, details = null, opts = {}) {
  ip = normalizeIp(ip);
  if (!ip || isWhitelisted(ip)) return;
  if (opts.hasSession) return;
  audit.log({ event_type: "api_unauth", ip, details });
  maybeAutoBanApi(ip);
}

// Auto-ban: ayni IP'den pencere icinde limit asilirsa banla.
// Sayim IP'ye daraltilmali; global sayim masum IP'leri banlar.
function evaluate(ip, events, threshold, reason) {
  ip = normalizeIp(ip);
  if (!ip || isWhitelisted(ip)) return;
  const windowMs = (config.get("auto_ban_window_minutes") || 10) * 60 * 1000;
  const since = Date.now() - windowMs;
  const count = audit.countSince({ eventType: events, sinceMs: since, ip });
  if (count >= threshold) {
    const dur = (config.get("auto_ban_duration_minutes") || 60) * 60 * 1000;
    ban(ip, { reason, durationMs: dur, by: "auto" });
  }
}

// Login formundan gelen hatali denemeler icin (dusuk esik).
function maybeAutoBan(ip) {
  evaluate(ip, LOGIN_EVENTS, config.get("auto_ban_after") || 3, "auto: too many failed logins");
}

// Kimliksiz API/WS istekleri icin (yuksek esik).
function maybeAutoBanApi(ip) {
  evaluate(ip, API_EVENTS, config.get("auto_ban_api_after") || 15, "auto: too many unauthorized API requests");
}

module.exports = {
  isWhitelisted, isBanned, ban, unban,
  middleware, isRequestBanned, requestIp,
  maybeAutoBan, maybeAutoBanApi, noteUnauthorized, normalizeIp
};
