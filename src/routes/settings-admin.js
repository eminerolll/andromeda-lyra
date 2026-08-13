// Settings yonetim endpoint'leri (post-setup, dashboard'da Settings modal'i icin).
// Tum endpoint'ler requireAuth gerektirir (server.js'te mount edilirken).

const express = require("express");
const config = require("../lib/config");
const dnsCheck = require("../lib/dns-check");
const health = require("../lib/health");
const { settings, services, integrations, audit } = require("../db/repos");

const router = express.Router();

// ─── Genel ayarlar ───

router.get("/api/settings/general", (req, res) => {
  res.json({
    app_name: config.get("app_name"),
    projects_dir: config.get("projects_dir"),
    secondary_disk: config.get("secondary_disk"),
    prod_apps_dir: config.get("prod_apps_dir")
  });
});

router.put("/api/settings/general", (req, res) => {
  const allowed = ["app_name", "projects_dir", "secondary_disk", "prod_apps_dir"];
  const body = req.body || {};
  const updates = {};
  for (const key of allowed) {
    if (body[key] !== undefined) updates[key] = body[key] === "" ? null : body[key];
  }
  settings.setMany(updates);
  audit.log({
    event_type: "setting_change",
    ip: req.ip,
    user_id: req.session.userId,
    details: { keys: Object.keys(updates), section: "general" }
  });
  res.json({ success: true, applied: updates });
});

// ─── Erisim ayarlari ───

router.get("/api/settings/access", (req, res) => {
  res.json({
    access_mode: config.get("access_mode"),
    bind_address: config.get("bind_address"),
    public_access: config.get("public_access"),
    base_domain: config.get("base_domain"),
    subdomain_code: config.get("subdomain_code"),
    subdomain_files: config.get("subdomain_files"),
    subdomain_db: config.get("subdomain_db"),
    subdomain_dev_pattern: config.get("subdomain_dev_pattern")
  });
});

router.put("/api/settings/access", (req, res) => {
  const allowed = [
    "access_mode", "bind_address", "public_access",
    "base_domain", "subdomain_code", "subdomain_files",
    "subdomain_db", "subdomain_dev_pattern"
  ];
  const body = req.body || {};
  const updates = {};
  for (const key of allowed) {
    if (body[key] !== undefined) {
      updates[key] = body[key] === "" ? null : body[key];
    }
  }
  settings.setMany(updates);
  audit.log({
    event_type: "setting_change",
    ip: req.ip,
    user_id: req.session.userId,
    details: { section: "access", keys: Object.keys(updates) }
  });
  res.json({
    success: true,
    applied: updates,
    requiresRestart: updates.bind_address !== undefined || updates.public_access !== undefined
  });
});

// DNS check (settings'ten domain degistirilirken)
router.post("/api/settings/access/dns-check", async (req, res) => {
  const { domain } = req.body || {};
  if (!domain) return res.status(400).json({ error: "domain gerekli" });
  const result = await dnsCheck.check(domain);
  res.json(result);
});

// ─── Guvenlik ayarlari ───

router.get("/api/settings/security", (req, res) => {
  res.json({
    rate_limit_attempts: config.get("rate_limit_attempts"),
    rate_limit_window_minutes: config.get("rate_limit_window_minutes"),
    auto_ban_after: config.get("auto_ban_after"),
    auto_ban_api_after: config.get("auto_ban_api_after"),
    auto_ban_window_minutes: config.get("auto_ban_window_minutes"),
    auto_ban_duration_minutes: config.get("auto_ban_duration_minutes"),
    session_ttl_days: config.get("session_ttl_days")
  });
});

router.put("/api/settings/security", (req, res) => {
  const allowed = [
    "rate_limit_attempts", "rate_limit_window_minutes",
    "auto_ban_after", "auto_ban_api_after",
    "auto_ban_window_minutes", "auto_ban_duration_minutes",
    "session_ttl_days"
  ];
  const body = req.body || {};
  const updates = {};
  for (const key of allowed) {
    if (body[key] !== undefined) {
      const n = parseInt(body[key], 10);
      if (Number.isNaN(n) || n < 1) {
        return res.status(400).json({ error: `${key} pozitif sayi olmali` });
      }
      updates[key] = n;
    }
  }
  settings.setMany(updates);
  audit.log({
    event_type: "setting_change",
    ip: req.ip,
    user_id: req.session.userId,
    details: { section: "security", keys: Object.keys(updates) }
  });
  res.json({ success: true, applied: updates });
});

// ─── Servisler CRUD ───

router.get("/api/services", (req, res) => {
  res.json({ services: services.list() });
});

router.post("/api/services", (req, res) => {
  const body = req.body || {};
  const required = ["unit_name", "display_name", "type"];
  for (const k of required) {
    if (!body[k]) return res.status(400).json({ error: `${k} gerekli` });
  }
  if (services.getByUnit(body.unit_name)) {
    return res.status(409).json({ error: "Bu unit_name zaten kayitli" });
  }
  const created = services.add({
    unit_name: body.unit_name,
    display_name: body.display_name,
    type: body.type,
    port: body.port || null,
    subdomain: body.subdomain || null,
    enabled: body.enabled !== false ? 1 : 0
  });
  audit.log({
    event_type: "service_add", ip: req.ip, user_id: req.session.userId,
    details: { unit_name: body.unit_name }
  });
  res.json({ success: true, service: created });
});

router.put("/api/services/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Gecersiz id" });
  const existing = services.getById(id);
  if (!existing) return res.status(404).json({ error: "Servis bulunamadi" });
  const updated = services.update(id, req.body || {});
  audit.log({
    event_type: "service_update", ip: req.ip, user_id: req.session.userId,
    details: { id, changes: Object.keys(req.body || {}) }
  });
  res.json({ success: true, service: updated });
});

router.delete("/api/services/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Gecersiz id" });
  const existing = services.getById(id);
  if (!existing) return res.status(404).json({ error: "Servis bulunamadi" });
  services.remove(id);
  audit.log({
    event_type: "service_remove", ip: req.ip, user_id: req.session.userId,
    details: { id, unit_name: existing.unit_name }
  });
  res.json({ success: true });
});

// ─── Entegrasyonlar CRUD ───

router.get("/api/integrations", (req, res) => {
  res.json({ integrations: integrations.list() });
});

router.get("/api/integrations/:name", (req, res) => {
  const i = integrations.get(req.params.name);
  if (!i) return res.json({ enabled: false, config: null });
  // Hassas degerleri masklayalim
  const masked = maskSensitive(req.params.name, i.config);
  res.json({ enabled: i.enabled, config: masked });
});

router.put("/api/integrations/:name", async (req, res) => {
  const allowed = ["telegram", "github", "cloudflare"];
  if (!allowed.includes(req.params.name)) {
    return res.status(400).json({ error: "Bilinmeyen entegrasyon" });
  }
  const body = req.body || {};
  // Mevcut config'i koruyup uzerine yaz (token degismediyse maskli geliyor olabilir)
  const existing = integrations.get(req.params.name);
  const newConfig = { ...(existing && existing.config ? existing.config : {}), ...(body.config || {}) };
  // Mask karakterleri varsa eski degeri koru
  for (const key of Object.keys(newConfig)) {
    if (typeof newConfig[key] === "string" && newConfig[key].includes("•")) {
      if (existing && existing.config && existing.config[key]) {
        newConfig[key] = existing.config[key];
      }
    }
  }

  // GitHub rozeti config.user'dan okunuyor; bu endpoint'ten sadece token
  // geldigi icin kullanici adi hic yazilmiyordu. Token degistiyse GitHub
  // API'sinden cek (routes/github.js ile ayni desen).
  if (req.params.name === "github" && newConfig.token) {
    const tokenChanged = !existing || !existing.config || existing.config.token !== newConfig.token;
    if (tokenChanged || !newConfig.user) {
      const gh = await fetchGithubUser(newConfig.token);
      if (!gh) return res.status(401).json({ error: "GitHub token dogrulanamadi" });
      newConfig.user = gh.login;
      newConfig.name = gh.name;
      newConfig.avatar = gh.avatar_url;
    }
  }

  // Handler async: Express 4 async throw'lari yakalamaz, istek asili kalirdi.
  try {
    integrations.set(req.params.name, {
      enabled: !!body.enabled,
      config: newConfig
    });
    audit.log({
      event_type: "integration_update", ip: req.ip, user_id: req.session.userId,
      details: { name: req.params.name, enabled: !!body.enabled }
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/api/integrations/:name", (req, res) => {
  integrations.remove(req.params.name);
  audit.log({
    event_type: "integration_remove", ip: req.ip, user_id: req.session.userId,
    details: { name: req.params.name }
  });
  res.json({ success: true });
});

async function fetchGithubUser(token) {
  try {
    const response = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: "Bearer " + token,
        "User-Agent": (config.get("app_name") || "Lyra") + "-Launcher"
      }
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (_) {
    return null;
  }
}

// Hassas alanlar
function maskSensitive(name, config) {
  if (!config) return null;
  const out = { ...config };
  const fields = {
    telegram: ["botToken"],
    github: ["token"],
    cloudflare: ["apiToken", "cfToken"]
  };
  for (const f of fields[name] || []) {
    if (out[f]) {
      out[f] = "•".repeat(8) + out[f].slice(-4);
    }
  }
  return out;
}

// ─── Health / Status ───

router.get("/api/health-summary", (req, res) => {
  res.json(health.summary());
});

router.get("/api/version", (req, res) => {
  res.json({
    version: health.getLyraVersion(),
    nodeVersion: process.version
  });
});

// ─── Audit log oku (son N kayit) ───

router.get("/api/audit-log", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
  const eventType = req.query.event_type || null;
  res.json({ events: audit.recent({ limit, eventType }) });
});

module.exports = router;
