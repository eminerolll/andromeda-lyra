// Browser-based setup wizard endpoint'leri. Sadece setup tamamlanmadan
// aktif. Token middleware ile korunur — token verify edildikten sonra
// session.setupAuthorized = true olur, sonraki request'lerde tekrar
// gerekmez.
//
// Bu dosya SADECE HTTP katmanidir. Dogrulama, Cloudflare on-kontrolu, DB
// seed'i ve kurulum sonrasi adimlar lib/setup-core.js'te; terminal sihirbazi
// (scripts/setup-cli.js) ayni fonksiyonlari cagirir.
//
// Kurulum modundan normal moda gecis DETERMINISTIK:
//   install.sh systemd unit'i setup'tan ONCE kurar ve kurulum modunu bir
//   drop-in ile acar. Finalize bitince Lyra drop-in'i siler, daemon-reload
//   yapar ve kendini restart eder. "process.exit(0) yap, birileri restart
//   eder" varsayimi yok.

const express = require("express");
const QRCode = require("qrcode");

const setupToken = require("../lib/setup-token");
const auth = require("../lib/auth");
const dnsCheck = require("../lib/dns-check");
const detect = require("../lib/service-detect");
const config = require("../lib/config");
const core = require("../lib/setup-core");
const { users } = require("../db/repos");

const router = express.Router();

// Kurulum sonrasi adimlarin canli durumu. Tek kurulum akisi oldugu icin
// modul seviyesinde tutuluyor. Restart'tan sonra kaybolur — istemci kopmayi
// "yeniden basliyor" olarak yorumlar (bkz. public/setup.html pollProgress).
const postSetup = core.createProgress();

// Setup tamamlandi mi? — kullanici yoksa setup acik
function setupOpen() {
  return !users.exists();
}

// Token middleware — /api/setup/* endpoint'leri icin
function requireSetupAuth(req, res, next) {
  if (!setupOpen()) {
    return res.status(403).json({ error: "Kurulum tamamlanmis." });
  }
  if (req.session && req.session.setupAuthorized) return next();
  return res.status(401).json({ error: "Token gerekli", needsToken: true });
}

// ─────────────────────────── Endpoint'ler ───────────────────────────

// Sunucu durumu (token'siz erisilebilir, sadece "kurulum acik mi" bilgisi)
router.get("/api/setup/status", (req, res) => {
  res.json({
    open: setupOpen(),
    authorized: !!(req.session && req.session.setupAuthorized),
    tokenExists: setupToken.exists()
  });
});

// Public IP — wizard'da sunucu IP'sini gostermek icin
router.get("/api/setup/public-ip", async (req, res) => {
  if (!setupOpen()) return res.status(403).json({ error: "Kurulum tamamlanmis." });
  try {
    const ip = await dnsCheck.getPublicIp();
    res.json({ publicIp: ip });
  } catch (_) {
    res.json({ publicIp: null });
  }
});

// Token dogrulama
router.post("/api/setup/verify-token", (req, res) => {
  if (!setupOpen()) return res.status(403).json({ error: "Kurulum tamamlanmis." });
  const { token } = req.body || {};
  if (!setupToken.verify(token)) {
    return res.status(401).json({ error: "Gecersiz veya suresi dolmus token" });
  }
  req.session.setupAuthorized = true;
  req.session.save(() => res.json({ success: true }));
});

// Lyra'nin calistigi Linux kullanicisi + onerilen projeler dizini.
// Wizard bu degeri form'a on-doldurur; panel kullanici adiyla karistirilmamali.
router.get("/api/setup/system-user", requireSetupAuth, (req, res) => {
  res.json(core.systemUserInfo());
});

// DNS check (Caddy oncesi). Apex + Caddy'nin sertifika alacagi subdomain'ler.
router.post("/api/setup/dns-check", requireSetupAuth, async (req, res) => {
  const { domain } = req.body || {};
  if (!domain) return res.status(400).json({ error: "domain gerekli" });

  const subs = [
    config.get("subdomain_code"),
    config.get("subdomain_files"),
    config.get("subdomain_db")
  ].filter(Boolean);

  const result = await dnsCheck.checkAll(domain, subs);
  // Geriye donuk uyum: apex sonucu ust seviyede kalir.
  res.json({ ...result.apex, subdomains: result.subdomains });
});

// Cloudflare API modu on-kontrolu (bkz. lib/setup-core.js -> cfPreflight).
router.post("/api/setup/cf-preflight", requireSetupAuth, async (req, res) => {
  try {
    res.json(await core.cfPreflight(core.cfPlanFromBody(req.body || {})));
  } catch (err) {
    res.status(400).json({ error: err && err.message ? err.message : String(err) });
  }
});

// Servis tespit
router.get("/api/setup/services-detected", requireSetupAuth, (req, res) => {
  res.json({ services: detect.detectAll() });
});

// 2FA secret + QR uret (admin user adimi)
router.post("/api/setup/totp-init", requireSetupAuth, async (req, res) => {
  const { username } = req.body || {};
  if (!username || username.length < 3) {
    return res.status(400).json({ error: "Kullanici adi en az 3 karakter" });
  }
  const t = auth.generateTotp(username);
  try {
    const qr = await QRCode.toDataURL(t.otpauth);
    req.session.pendingSetup = req.session.pendingSetup || {};
    req.session.pendingSetup.totpSecret = t.secret;
    req.session.save(() => res.json({ secret: t.secret, qr }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2FA kodu dogrula (admin oluşturmadan once)
router.post("/api/setup/totp-verify", requireSetupAuth, (req, res) => {
  const { code } = req.body || {};
  const secret = req.session.pendingSetup && req.session.pendingSetup.totpSecret;
  if (!secret) return res.status(400).json({ error: "Once /totp-init cagir" });
  if (!auth.verifyTotp(secret, code || "")) {
    return res.status(401).json({ error: "Gecersiz kod" });
  }
  req.session.pendingSetup.totpVerified = true;
  req.session.save(() => res.json({ success: true }));
});

// Kurulum sonrasi adimlarin canli durumu.
// requireSetupAuth KULLANILMAZ: finalize'dan sonra kullanici olustugu icin
// setupOpen() false doner ve bu endpoint erisilemez olurdu.
router.get("/api/setup/progress", (req, res) => {
  const allowed = req.session && (req.session.setupAuthorized || req.session.setupProgress);
  if (!allowed) return res.status(401).json({ error: "Yetkisiz" });
  res.json(postSetup.payload());
});

// Setup'i tamamla — tum ayarlar tek istek
// Gelen body:
// {
//   accessMode: "public" | "lan" | "localhost" | "cf-tunnel" | "cf-api" | "manual",
//   domain, email,                         (public icin)
//   cfToken,                                (cf-tunnel icin)
//   cfApiToken, cfHostMode, cfPanelSubdomain, cfOverwriteDns,   (cf-api icin)
//   appName, projectsDir,
//   user: { username, password, enable2FA },
//   services: [type, type, ...],            (registered services)
//   integrations: { telegram?, github? }
// }
router.post("/api/setup/finalize", requireSetupAuth, async (req, res) => {
  if (!setupOpen()) return res.status(403).json({ error: "Kurulum tamamlanmis." });

  const body = req.body || {};
  const totpVerified = !!(req.session.pendingSetup && req.session.pendingSetup.totpVerified);

  const { errors } = core.validateFinalize(body, { totpVerified });
  if (errors.length) return res.status(400).json({ errors });

  // Projeler dizini yazilabilir mi? Sessizce kabul etmiyoruz — yanlis yol
  // panelin yarisini (clone, commit, .env, notlar) calismaz hale getirir.
  const dirCheck = core.ensureProjectsDir(String(body.projectsDir || "").trim());
  if (!dirCheck.ok) return res.status(400).json({ errors: [dirCheck.error] });

  try {
    const totpSecret = req.session.pendingSetup ? req.session.pendingSetup.totpSecret : null;
    const applied = core.applyFinalize(body, { totpSecret });

    setupToken.invalidate();
    delete req.session.pendingSetup;
    delete req.session.setupAuthorized;
    // Kullanici olustugu an setupOpen() false olur; /progress'i okuyabilmek
    // icin ayri bir izin bayragi.
    req.session.setupProgress = true;

    postSetup.start(applied.accessMode, applied.finalUrl);

    res.json({
      success: true,
      finalUrl: applied.finalUrl,
      steps: postSetup.payload().steps
    });

    // Async: Caddy / cloudflared kurulumu + firewall + restart.
    // Istemci /api/setup/progress ile canli izler.
    setImmediate(() =>
      core.runPostSetup(applied.accessMode, body, postSetup, { transition: "self" })
    );
  } catch (err) {
    console.error("[setup/finalize] hata:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.setupOpen = setupOpen;
module.exports.requireSetupAuth = requireSetupAuth;
module.exports.systemUserInfo = core.systemUserInfo;
module.exports.ensureProjectsDir = core.ensureProjectsDir;
module.exports.buildSteps = core.buildSteps;
module.exports.cleanupSetupPrivileges = core.cleanupSetupPrivileges;
module.exports.SETUP_DROPIN = core.SETUP_DROPIN;
module.exports.SETUP_SUDOERS = core.SETUP_SUDOERS;
