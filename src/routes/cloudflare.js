// Cloudflare Tunnel API. Uc mod da (api / local / remote) buradan servis
// edilir; mod tespiti lib/cloudflare.js -> detectMode() icinde, tek yerde.
// Entegrasyon kapaliysa yonetim endpoint'leri 503 doner.

const express = require("express");
const cf = require("../lib/cloudflare");

const router = express.Router();

function requireEnabled(req, res, next) {
  if (!cf.isEnabled()) {
    return res.status(503).json({ error: "cloudflare entegrasyonu kapali", enabled: false });
  }
  next();
}

// Hata cevabi. Token hicbir kosulda govdeye girmez; cloudflare-api.js zaten
// mesajlari token'a karsi temizliyor.
function fail(res, err) {
  const body = { error: err && err.message ? err.message : String(err) };
  if (err && err.conflict) {
    body.conflict = true;
    body.needsOverwrite = true;
    body.conflicts = err.conflicts || [];
    return res.status(409).json(body);
  }
  if (err && err.needsTunnelId) body.needsTunnelId = true;
  if (err && err.needsDomain) body.needsDomain = true;
  if (err && err.needsAccountChoice) {
    body.needsAccountChoice = true;
    body.accounts = err.accounts || [];
  }
  res.status(400).json(body);
}

router.get("/api/cf/health", requireEnabled, (req, res) => {
  cf.healthForAllIngress((err, data) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(data);
  });
});

// Sekmenin acilis cagrisi. requireEnabled YOK: entegrasyon kapaliyken de
// "neden kapali / nasil acilir" bilgisi verilebilmeli. `enabled` alani
// sekmenin gorunurlugunu, `integrationEnabled` yonetim izinini anlatir.
router.get("/api/cf/status", (req, res) => {
  const mode = cf.detectMode();
  if (!cf.isVisible()) {
    return res.json({ enabled: false, integrationEnabled: false, active: false, ...mode });
  }
  cf.tunnelStatus((err, status) => {
    res.json({
      enabled: true,
      integrationEnabled: cf.isEnabled(),
      active: !!(status && status.active),
      ...mode
    });
  });
});

router.get("/api/cf/ingress", requireEnabled, (req, res) => {
  const mode = cf.detectMode();
  if (!mode.canManage) {
    return res.json({ entries: [], mode: mode.mode, readOnly: true, note: mode.note });
  }
  cf.listIngress((err, entries, source) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ entries, mode: mode.mode, readOnly: false, source: source || null });
  });
});

router.post("/api/cf/ingress", requireEnabled, (req, res) => {
  const { hostname, port, autoDns, overwriteDns } = req.body || {};
  cf.addIngress(hostname, port, { dns: !!autoDns, overwriteDns: !!overwriteDns }, (err, meta) => {
    if (err) return fail(res, err);
    res.json({ success: true, ...meta });
  });
});

router.delete("/api/cf/ingress/:hostname", requireEnabled, (req, res) => {
  cf.removeIngress(req.params.hostname, { dns: req.query.dns === "1" }, (err, meta) => {
    if (err) return fail(res, err);
    res.json({ success: true, ...meta });
  });
});

router.get("/api/cf/settings", (req, res) => {
  cf.getSettingsMasked((err, s) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(s);
  });
});

router.post("/api/cf/settings/token", (req, res) => {
  const { token } = req.body || {};
  cf.saveToken(token, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    res.json({ success: true });
  });
});

router.delete("/api/cf/settings/token", (req, res) => {
  cf.clearToken((err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// Mod C -> Mod A yukseltmesi: token kaydedildikten sonra hesap/zone/tunnel
// bilgilerini tamamlar. requireEnabled YOK — kesif zaten entegrasyonu acar.
router.post("/api/cf/discover", (req, res) => {
  const { tunnelId, domain } = req.body || {};
  cf.discoverConnection({ tunnelId, domain })
    .then(r => res.json({ success: true, ...r }))
    .catch(err => fail(res, err));
});

module.exports = router;
