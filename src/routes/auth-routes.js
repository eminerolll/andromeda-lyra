// Login, logout, password change, 2FA setup/verify/disable.

const express = require("express");
const QRCode = require("qrcode");
const path = require("path");

const auth = require("../lib/auth");
const ban = require("../lib/ban");
const notifier = require("../lib/notifier");
const config = require("../lib/config");
const { users, integrations } = require("../db/repos");

const router = express.Router();

// Login page (basit placeholder; UI sonra port edilecek)
router.get("/login", (req, res) => {
  if (req.session && req.session.userId) return res.redirect("/");
  const loginHtml = path.join(__dirname, "..", "public", "login.html");
  const fs = require("fs");
  if (fs.existsSync(loginHtml)) {
    return res.sendFile(loginHtml);
  }
  // fallback minimal form
  res.type("html").send(`
    <!doctype html><meta charset="utf-8"><title>Lyra Login</title>
    <form method="POST" action="/api/login" onsubmit="event.preventDefault();fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u.value,password:p.value,totp:t.value})}).then(r=>r.json()).then(j=>{if(j.success)location.href='/';else if(j.needs2FA)alert('TOTP gerekli');else alert(j.error||'hata')})">
      <input id="u" placeholder="kullanici"><br>
      <input id="p" type="password" placeholder="sifre"><br>
      <input id="t" placeholder="TOTP (varsa)"><br>
      <button>Giris</button>
    </form>
  `);
});

// Login API
router.post("/api/login", auth.rateLimiter, (req, res) => {
  const { username, password, totp } = req.body || {};
  const ip = req.ip;

  if (!username || !password) {
    return res.status(400).json({ error: "Kullanici adi ve sifre gerekli" });
  }

  const result = auth.authenticate({ username, password, totpToken: totp });
  if (!result.ok) {
    auth.recordAttempt(ip);
    if (result.reason === "totp_required") {
      // Sifre dogru ama 2FA istiyoruz
      return res.json({ needs2FA: true });
    }
    notifier.loginFail({ ip, username, reason: result.reason });
    ban.maybeAutoBan(ip);
    if (result.reason === "invalid_totp") {
      return res.status(401).json({ error: "Gecersiz dogrulama kodu" });
    }
    return res.status(401).json({ error: "Yanlis kullanici adi veya sifre" });
  }

  req.session.userId = result.user.id;
  req.session.username = result.user.username;
  auth.clearAttempts(ip);
  notifier.loginSuccess({ ip, userId: result.user.id });
  res.json({ success: true });
});

router.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// Mevcut kullanici bilgisi
router.get("/api/me", auth.requireAuth, (req, res) => {
  const u = users.findById(req.session.userId);
  if (!u) return res.status(401).json({ error: "Yetkisiz" });
  res.json({
    id: u.id,
    username: u.username,
    totpEnabled: !!u.totp_enabled,
    lastLoginAt: u.last_login_at
  });
});

// Sifre degistir
router.post("/api/settings/password", auth.requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 12) {
    return res.status(400).json({ error: "Yeni sifre en az 12 karakter olmali" });
  }
  const u = users.findById(req.session.userId);
  if (!u || !users.verifyPassword(u, currentPassword || "")) {
    return res.status(401).json({ error: "Mevcut sifre yanlis" });
  }
  users.setPassword(u.id, newPassword);
  notifier.settingChanged({ key: "password", userId: u.id, ip: req.ip });
  res.json({ success: true });
});

// 2FA durumu (auth gereksiz, login akisi icin)
router.get("/api/2fa/status", (req, res) => {
  const u = users.getAdmin();
  res.json({ enabled: !!(u && u.totp_enabled) });
});

// 2FA setup baslat — pending secret session'da tutulur
router.post("/api/2fa/setup", auth.requireAuth, (req, res) => {
  const u = users.findById(req.session.userId);
  if (!u) return res.status(401).json({ error: "Yetkisiz" });
  const t = auth.generateTotp(u.username);
  QRCode.toDataURL(t.otpauth, (err, qr) => {
    if (err) return res.status(500).json({ error: "QR olusturulamadi" });
    req.session.pendingTotpSecret = t.secret;
    res.json({ qr, secret: t.secret });
  });
});

// 2FA dogrula + aktif et
router.post("/api/2fa/verify", auth.requireAuth, (req, res) => {
  const { code } = req.body || {};
  const secret = req.session.pendingTotpSecret;
  if (!secret) return res.status(400).json({ error: "Once setup baslatin" });
  if (!auth.verifyTotp(secret, code || "")) {
    return res.status(401).json({ error: "Gecersiz kod" });
  }
  users.setTotp(req.session.userId, { secret, enabled: true });
  delete req.session.pendingTotpSecret;
  notifier.settingChanged({
    key: "totp_enabled",
    newValue: true,
    userId: req.session.userId,
    ip: req.ip
  });
  res.json({ success: true });
});

// 2FA kapat (mevcut kodu dogrulayarak)
router.post("/api/2fa/disable", auth.requireAuth, (req, res) => {
  const { code } = req.body || {};
  const u = users.findById(req.session.userId);
  if (!u || !u.totp_enabled) return res.status(400).json({ error: "2FA zaten kapali" });
  if (!auth.verifyTotp(u.totp_secret, code || "")) {
    return res.status(401).json({ error: "Gecersiz kod" });
  }
  users.disableTotp(u.id);
  notifier.settingChanged({ key: "totp_enabled", newValue: false, userId: u.id, ip: req.ip });
  res.json({ success: true });
});

// Settings ozeti (sadece public bilgi)
router.get("/api/settings", auth.requireAuth, (req, res) => {
  const gh = integrations.get("github");
  res.json({
    appName: config.get("app_name"),
    publicAccess: !!config.get("public_access"),
    baseDomain: config.get("base_domain"),
    githubUser: (gh && gh.config && gh.config.user) || null,
    githubConnected: !!(gh && gh.enabled)
  });
});

module.exports = router;
