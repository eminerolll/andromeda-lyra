// Cloudflare Tunnel yardimcilari.
//
// UC MOD vardir ve tespit TEK yerde yapilir (detectMode). Rotalar ve UI
// oradan beslenir, kendi basina tahmin yurutmez:
//
//   "api"    Faz 3a kurulumu (accessMode: cf-api). Tunnel remotely-managed
//            (config_src: cloudflare) olarak acildi; ingress Cloudflare'de
//            durur ve /configurations ucundan okunup yazilir. Sunucudaki
//            /etc/cloudflared/config.yml bu tunnel icin KULLANILMAZ.
//   "local"  v1 mirasi. Ingress /etc/cloudflared/config.yml icinde; sudo ile
//            okunur/yazilir, cloudflared restart edilir. Davranis korunuyor.
//   "remote" Bare connector token (accessMode: cf-tunnel). cloudflared calisir
//            ama ne API token ne kullanilabilir config.yml var. Ingress
//            Cloudflare'de yonetiliyor, buradan okunamaz — sekme salt-okunur.
//            Cikis yolu: API token ekle + discoverConnection() -> "api".
//
// GUVENLIK: API token yalnizca cloudflare-api.js'e girer. Log'a, hata
// mesajina veya API cevabina yazilmaz; disari sadece maskeli onek gider.

const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");

const config = require("../lib/config");
const cfApi = require("./cloudflare-api");
const { settings, integrations } = require("../db/repos");

const MODE = { API: "api", LOCAL: "local", REMOTE: "remote" };

// cloudflared connector-token kurulumunda systemd unit'i --token ile calisir.
const CLOUDFLARED_UNIT = "cloudflared";

function defaults() {
  return {
    config_path: settings.get("cloudflared_config_path", "/etc/cloudflared/config.yml"),
    backup_dir: settings.get("cloudflared_backup_dir", "/etc/cloudflared"),
    cert_path: settings.get("cloudflared_cert_path", "/root/.cloudflared/cert.pem")
  };
}

// Yonetim endpoint'lerinin (requireEnabled) kapisi. Entegrasyon kapaliysa 503.
function isEnabled() {
  return !!settings.get("cloudflared_enabled", false) || integrations.isEnabled("cloudflare");
}

// Sekme hic gorunmeli mi? Entegrasyon kapali olsa bile tunnel ile kurulmus bir
// sistemde sekme acilmali: Mod C'nin "bu tunnel uzaktan yonetiliyor" aciklamasi
// ve token ekleme yolu ancak orada gosterilebilir. Yonetim yine de kapalidir.
function isVisible() {
  if (isEnabled()) return true;
  const mode = settings.get("access_mode", null);
  return mode === "cf-tunnel" || mode === "cf-api";
}

function protectedHosts() {
  // Panel bu host'lardan birinde duruyor; ingress'ten silinirse kullanici
  // kendini disari kilitler. Wildcard da korunur: alt alan adlarinin tamami
  // (dev-PORT, code, files...) onun uzerinden geliyor.
  const list = settings.get("cf_protected_hosts", []) || [];
  const base = config.get("base_domain");
  const auto = [
    base,
    base ? `*.${base}` : null,
    config.get("panel_host"),
    config.buildHostname("code")
  ].filter(Boolean);
  return [...new Set([...list, ...auto])];
}

function run(cmd, cb) {
  exec(cmd, { maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => cb(err, stdout, stderr));
}

function isValidHostname(h) {
  if (typeof h !== "string" || h.length > 253) return false;
  // Wildcard bicimi ("*.example.com") de gecerli kabul edilir; korumali kayit
  // kontrolu ancak boylece calisabilir. Yildiz sadece bastaki "*." icin izinli.
  const rest = h.startsWith("*.") ? h.slice(2) : h;
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(rest);
}

// Domain adlari buyuk/kucuk harf duyarsizdir; Cloudflare DNS kaydini kucuk
// harfe cevirerek saklar. Ingress karsilastirmalarinin (ekleme/silme) DNS ile
// ayrismamasi icin giris noktasinda tek yerde normalize edilir.
function normalizeHostname(h) {
  return typeof h === "string" ? h.trim().toLowerCase() : h;
}

function isValidPort(p) {
  const n = parseInt(p);
  return Number.isInteger(n) && n > 0 && n < 65536;
}

function getCfConfig() {
  const i = integrations.get("cloudflare");
  return (i && i.config) || {};
}

function setCfConfig(patch) {
  const cur = getCfConfig();
  integrations.set("cloudflare", {
    enabled: true,
    config: { ...cur, ...patch }
  });
  return { ...cur, ...patch };
}

// ─────────────────────────── Mod tespiti ───────────────────────────

function localConfigExists() {
  try {
    return fs.existsSync(defaults().config_path);
  } catch (_) {
    return false;
  }
}

// Sekmenin ve rotalarin tek dogru kaynagi.
function detectMode() {
  const c = getCfConfig();
  const hasToken = typeof c.apiToken === "string" && c.apiToken.trim().length >= 20;
  const hasAccount = !!c.accountId;
  const hasTunnel = !!c.tunnelId;
  const hasLocalConfig = localConfigExists();

  let mode;
  if (hasToken && hasAccount && hasTunnel) mode = MODE.API;
  else if (hasLocalConfig) mode = MODE.LOCAL;
  else mode = MODE.REMOTE;

  let note = null;
  if (mode === MODE.API) {
    note = "Ingress Cloudflare API uzerinden yonetiliyor.";
  } else if (mode === MODE.LOCAL) {
    note = `Ingress sunucudaki ${defaults().config_path} dosyasindan yonetiliyor.`;
  } else if (hasToken) {
    note =
      "API token var ama tunnel/hesap bilgisi eksik. \"Baglantiyi kesfet\" ile " +
      "tamamlanabilir; tunnel id kesfedilemezse elle girilmesi gerekir.";
  } else {
    note =
      "Bu tunnel Cloudflare'de uzaktan yonetiliyor; ingress buradan duzenlenemez. " +
      "Ayarlar > Entegrasyonlar bolumune bir Cloudflare API token'i eklersen bu " +
      "sekme yonetilebilir hale gelir.";
  }

  return {
    mode,
    canManage: mode !== MODE.REMOTE,
    hasToken,
    hasAccount,
    hasTunnel,
    hasZone: !!c.zoneId,
    hasLocalConfig,
    tunnelId: c.tunnelId || null,
    zoneDomain: c.zoneDomain || config.get("base_domain") || null,
    configPath: defaults().config_path,
    protectedHosts: protectedHosts(),
    note
  };
}

// ─────────────────── Mod B: yerel config.yml (v1 mirasi) ───────────────────

function readConfig(cb) {
  run("sudo -n cat " + defaults().config_path, (err, stdout) => {
    if (err) return cb(err);
    cb(null, stdout);
  });
}

function parseIngress(raw) {
  const lines = raw.split("\n");
  const entries = [];
  let inIngress = false;
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "ingress:" || trimmed.startsWith("ingress:")) { inIngress = true; continue; }
    if (!inIngress) continue;
    if (!line.startsWith(" ") && !line.startsWith("\t") && trimmed !== "") {
      inIngress = false;
      if (current) entries.push(current);
      current = null;
      continue;
    }
    const hostMatch = trimmed.match(/^-\s+hostname:\s*"?([^"]+)"?\s*$/);
    const serviceDashMatch = trimmed.match(/^-\s+service:\s*(.+)$/);
    const serviceMatch = trimmed.match(/^service:\s*(.+)$/);
    if (hostMatch) {
      if (current) entries.push(current);
      current = { hostname: hostMatch[1].trim(), service: null, lineStart: i };
    } else if (serviceDashMatch) {
      if (current) entries.push(current);
      current = { hostname: null, service: serviceDashMatch[1].trim(), lineStart: i };
    } else if (serviceMatch && current) {
      current.service = serviceMatch[1].trim();
      current.lineEnd = i;
    }
  }
  if (current) entries.push(current);
  return entries;
}

function listIngressLocal(cb) {
  readConfig((err, raw) => {
    if (err) return cb(err);
    cb(null, mapRules(parseIngress(raw)));
  });
}

function buildUpdatedConfig(raw, newHostname, newService) {
  const lines = raw.split("\n");
  const entries = parseIngress(raw);
  const insertBefore = entries.find(e => !e.hostname || (e.hostname && e.hostname.startsWith("*")));
  if (!insertBefore) throw new Error("Catch-all ingress bulunamadi");
  const insertLineIdx = insertBefore.lineStart;
  const newBlock = ["  - hostname: " + newHostname, "    service: " + newService];
  return [...lines.slice(0, insertLineIdx), ...newBlock, ...lines.slice(insertLineIdx)].join("\n");
}

function buildRemovedConfig(raw, hostname) {
  const lines = raw.split("\n");
  const entries = parseIngress(raw);
  const target = entries.find(e => e.hostname === hostname);
  if (!target) throw new Error("Hostname bulunamadi: " + hostname);
  if (protectedHosts().includes(hostname)) throw new Error("Korumali kayit silinemez: " + hostname);
  if (!target.hostname) throw new Error("Catch-all kaydi silinemez");
  const start = target.lineStart;
  const end = target.lineEnd != null ? target.lineEnd : target.lineStart;
  return [...lines.slice(0, start), ...lines.slice(end + 1)].join("\n");
}

function writeConfigAtomic(newContent, cb) {
  const cfg = defaults();
  const tmp = path.join(os.tmpdir(), "cloudflared-config-" + Date.now() + ".yml");
  fs.writeFile(tmp, newContent, (err) => {
    if (err) return cb(err);
    const ts = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
    const backup = cfg.backup_dir + "/config.yml.bak." + ts;
    run("sudo -n cp " + cfg.config_path + " " + backup, (cpErr) => {
      if (cpErr) { fs.unlink(tmp, () => {}); return cb(cpErr); }
      run("cloudflared tunnel --config " + tmp + " ingress validate 2>&1", (valErr, valOut) => {
        if (valErr) {
          fs.unlink(tmp, () => {});
          return cb(new Error("Config validation basarisiz: " + valOut));
        }
        run("sudo -n install -m 644 " + tmp + " " + cfg.config_path, (mvErr) => {
          fs.unlink(tmp, () => {});
          if (mvErr) return cb(mvErr);
          cb(null, { backup });
        });
      });
    });
  });
}

function restartTunnel(cb) {
  run("sudo -n systemctl restart cloudflared", (err, stdout, stderr) => {
    if (err) return cb(new Error(stderr || err.message));
    setTimeout(() => {
      run("systemctl is-active cloudflared", (activeErr, activeOut) => {
        cb(null, { active: (activeOut || "").trim() === "active" });
      });
    }, 1500);
  });
}

function rollback(backupPath, cb) {
  run("sudo -n cp " + backupPath + " " + defaults().config_path, (err) => {
    if (err) return cb(err);
    restartTunnel(cb);
  });
}

function applyConfigAsyncRestart(newContent, cb) {
  writeConfigAtomic(newContent, (wErr, meta) => {
    if (wErr) return cb(wErr);
    cb(null, { backup: meta.backup });
    setImmediate(() => {
      restartTunnel((rErr, status) => {
        if (rErr || !status.active) {
          rollback(meta.backup, () => {
            console.error("Tunnel restart basarisiz, config geri alindi:", rErr && rErr.message);
          });
        }
      });
    });
  });
}

function addIngressLocal(hostname, port, cb) {
  if (!isValidHostname(hostname)) return cb(new Error("Gecersiz hostname"));
  if (!isValidPort(port)) return cb(new Error("Gecersiz port"));
  readConfig((err, raw) => {
    if (err) return cb(err);
    const existing = parseIngress(raw);
    if (existing.some(e => e.hostname === hostname)) return cb(new Error("Bu hostname zaten kayitli"));
    let newContent;
    try { newContent = buildUpdatedConfig(raw, hostname, "http://localhost:" + parseInt(port)); }
    catch (e) { return cb(e); }
    applyConfigAsyncRestart(newContent, cb);
  });
}

function removeIngressLocal(hostname, cb) {
  if (!isValidHostname(hostname)) return cb(new Error("Gecersiz hostname"));
  readConfig((err, raw) => {
    if (err) return cb(err);
    let newContent;
    try { newContent = buildRemovedConfig(raw, hostname); }
    catch (e) { return cb(e); }
    applyConfigAsyncRestart(newContent, cb);
  });
}

function getLocalTunnelId(cb) {
  readConfig((err, raw) => {
    if (err) return cb(err);
    const m = raw.match(/^\s*tunnel:\s*([a-zA-Z0-9-]+)/m);
    cb(null, m ? m[1] : null);
  });
}

// cloudflared CLI + cert.pem ile DNS kaydi. Yerel modda token gerekmez.
function cloudflaredRouteDns(tunnelId, hostname, cb) {
  if (!/^[a-zA-Z0-9-]+$/.test(tunnelId)) return cb(new Error("Gecersiz tunnel id"));
  if (!isValidHostname(hostname)) return cb(new Error("Gecersiz hostname"));
  const cmd = "sudo -n cloudflared tunnel --origincert " + defaults().cert_path + " route dns " + tunnelId + " " + hostname + " 2>&1";
  run(cmd, (err, stdout, stderr) => {
    const out = (stdout || "") + (stderr || "");
    if (err) {
      if (/already exists/i.test(out) && /cfargotunnel/i.test(out)) return cb(null, { already: true, output: out });
      return cb(new Error("DNS route hatasi: " + out.trim().split("\n").slice(-3).join(" ")));
    }
    cb(null, { output: out });
  });
}

function addDnsAndIngressLocal(hostname, port, cb) {
  getLocalTunnelId((err, tunnelId) => {
    if (err) return cb(err);
    if (!tunnelId) return cb(new Error("Tunnel ID bulunamadi"));
    cloudflaredRouteDns(tunnelId, hostname, (dnsErr) => {
      if (dnsErr) return cb(dnsErr);
      addIngressLocal(hostname, port, (iErr, meta) => {
        if (iErr) return cb(iErr);
        cb(null, { ...meta, dns: true });
      });
    });
  });
}

function removeDnsAndIngressLocal(hostname, cb) {
  const c = getCfConfig();
  removeIngressLocal(hostname, (err, meta) => {
    if (err) return cb(err);
    if (!c.apiToken || !c.zoneId) return cb(null, { ...meta, dns: false });
    cfApi.listDnsRecords(c.apiToken, c.zoneId, hostname)
      .then(records => (records[0] ? cfApi.deleteDnsRecord(c.apiToken, c.zoneId, records[0].id) : null))
      .then(() => cb(null, { ...meta, dns: true }))
      .catch(e => cb(null, { ...meta, dns: false, dnsWarning: e.message }));
  });
}

// ─────────────────── Mod A: Cloudflare API ile yonetim ───────────────────

// Ingress kurallarini UI'nin bekledigi sekle cevirir. Iki mod da ayni sekli
// uretir; frontend tek bir tablo cizer.
function mapRules(rules) {
  const prot = new Set(protectedHosts());
  return (rules || []).map(r => ({
    hostname: r.hostname || null,
    service: r.service || null,
    isWildcard: !!(r.hostname && r.hostname.startsWith("*")),
    isCatchAll: !r.hostname,
    isProtected: !!(r.hostname && prot.has(r.hostname))
  }));
}

function apiCtx() {
  const c = getCfConfig();
  const token = String(c.apiToken || "").trim();
  if (token.length < 20) throw new Error("Cloudflare API token'i kayitli degil.");
  if (!c.accountId || !c.tunnelId) {
    throw new Error(
      "Cloudflare hesap/tunnel bilgisi eksik. Tunnel sekmesindeki \"Baglantiyi kesfet\" " +
      "adimini calistir."
    );
  }
  return {
    token,
    accountId: c.accountId,
    tunnelId: c.tunnelId,
    zoneId: c.zoneId || null,
    zoneDomain: c.zoneDomain || config.get("base_domain") || null
  };
}

// Catch-all (hostname'siz kural) HER ZAMAN son eleman kalir; Cloudflare aksi
// halde config'i reddeder ve ilk eslesen kural kazandigi icin sirasi onemlidir.
function withCatchAllLast(rules) {
  const named = (rules || []).filter(r => r && r.hostname);
  const catchAll = (rules || []).find(r => r && !r.hostname && r.service) || { service: "http_status:404" };
  return [...named, catchAll];
}

// Yeni kural wildcard'dan ONCE girmeli, yoksa "*.example.com" onu golgeler.
function insertRule(rules, rule) {
  const named = (rules || []).filter(r => r && r.hostname);
  const idx = named.findIndex(r => r.hostname.startsWith("*"));
  if (idx === -1) named.push(rule);
  else named.splice(idx, 0, rule);
  return withCatchAllLast([...named, ...(rules || []).filter(r => r && !r.hostname)]);
}

async function ensureZone(ctx) {
  if (ctx.zoneId && ctx.zoneDomain) return { zoneId: ctx.zoneId, zoneName: ctx.zoneDomain };
  const domain = cfApi.normalizeDomain(ctx.zoneDomain);
  if (!domain) {
    throw new Error("DNS islemi icin domain bilinmiyor: ayarlarda base_domain yok.");
  }
  const zone = await cfApi.findZone(ctx.token, domain);
  setCfConfig({ zoneId: zone.id, zoneDomain: zone.name });
  return { zoneId: zone.id, zoneName: zone.name };
}

async function upsertTunnelDns(ctx, hostname, overwrite) {
  const { zoneId, zoneName } = await ensureZone(ctx);
  if (hostname !== zoneName && !hostname.endsWith("." + zoneName)) {
    throw new Error(`"${hostname}" ${zoneName} zone'unun altinda degil; DNS kaydi olusturulamaz.`);
  }
  return cfApi.upsertDnsRecord(
    ctx.token,
    zoneId,
    { type: "CNAME", name: hostname, content: cfApi.tunnelCname(ctx.tunnelId), proxied: true },
    { overwrite: !!overwrite, zoneName }
  );
}

// Yalnizca bu tunnel'a bakan CNAME kayitlarini siler. Baskasina ait bir A/AAAA
// kaydini sessizce silmek kabul edilemez — dokunulmaz, uyari doner.
async function removeTunnelDns(ctx, hostname) {
  const { zoneId } = await ensureZone(ctx);
  const records = await cfApi.listDnsRecords(ctx.token, zoneId, hostname);
  const tunnelRecords = records.filter(r => /\.cfargotunnel\.com$/i.test(r.content || ""));
  if (!tunnelRecords.length) {
    return {
      removed: 0,
      warning: records.length
        ? `${hostname} icin bulunan DNS kaydi bu tunnel'a ait degil, dokunulmadi.`
        : `${hostname} icin DNS kaydi bulunamadi.`
    };
  }
  for (const r of tunnelRecords) {
    await cfApi.deleteDnsRecord(ctx.token, zoneId, r.id);
  }
  return { removed: tunnelRecords.length, warning: null };
}

async function listIngressApi() {
  const ctx = apiCtx();
  const r = await cfApi.getIngress(ctx.token, ctx.accountId, ctx.tunnelId);
  return { entries: mapRules(r.ingress), source: r.source };
}

async function addIngressApi(hostname, port, opts = {}) {
  const ctx = apiCtx();
  if (!isValidHostname(hostname)) throw new Error("Gecersiz hostname");
  if (!isValidPort(port)) throw new Error("Gecersiz port");

  const cur = await cfApi.getIngress(ctx.token, ctx.accountId, ctx.tunnelId);
  if (cur.ingress.some(r => r.hostname === hostname)) {
    throw new Error("Bu hostname zaten kayitli");
  }

  // DNS ONCE: cakisma varsa (ornegin baska bir A kaydi) ingress'e hic
  // dokunmadan durup kullaniciya soruyoruz.
  let dnsResult = null;
  if (opts.dns) dnsResult = await upsertTunnelDns(ctx, hostname, opts.overwriteDns);

  const next = insertRule(cur.ingress, { hostname, service: "http://localhost:" + parseInt(port, 10) });
  try {
    await cfApi.putIngress(ctx.token, ctx.accountId, ctx.tunnelId, next);
  } catch (err) {
    if (dnsResult && dnsResult.action === "created") {
      err.message += " (DNS kaydi olusturuldu ama ingress yazilamadi; tekrar dene)";
    }
    throw err;
  }

  return {
    mode: MODE.API,
    dns: !!dnsResult,
    dnsAction: dnsResult ? dnsResult.action : null,
    source: cur.source
  };
}

async function removeIngressApi(hostname, opts = {}) {
  const ctx = apiCtx();
  if (!isValidHostname(hostname)) throw new Error("Gecersiz hostname");
  if (protectedHosts().includes(hostname)) {
    throw new Error("Korumali kayit silinemez: " + hostname);
  }

  const cur = await cfApi.getIngress(ctx.token, ctx.accountId, ctx.tunnelId);
  const target = cur.ingress.find(r => r.hostname === hostname);
  if (!target) throw new Error("Hostname bulunamadi: " + hostname);

  const next = withCatchAllLast(cur.ingress.filter(r => r.hostname !== hostname));
  if (next.length < 2) {
    throw new Error("Ingress listesinde catch-all disinda en az bir kural kalmali.");
  }
  await cfApi.putIngress(ctx.token, ctx.accountId, ctx.tunnelId, next);

  let dns = false;
  let dnsWarning = null;
  if (opts.dns) {
    try {
      const r = await removeTunnelDns(ctx, hostname);
      dns = r.removed > 0;
      dnsWarning = r.warning;
    } catch (err) {
      dnsWarning = err.message;
    }
  }
  return { mode: MODE.API, dns, dnsWarning };
}

// ─────────────── Mod C -> Mod A: baglantiyi kesfet ───────────────

// Connector token base64 bir JSON'dur: { a: hesap id, t: tunnel id, s: secret }.
// Sadece a ve t okunur; token'in kendisi hicbir yere yazilmaz.
function connectorTokenIds(unitText) {
  const m = String(unitText || "").match(/--token[=\s]+([A-Za-z0-9_\-=+/]{40,})/);
  if (!m) return null;
  try {
    const json = JSON.parse(Buffer.from(m[1], "base64").toString("utf8"));
    const accountId = typeof json.a === "string" ? json.a : null;
    const tunnelId = typeof json.t === "string" ? json.t : null;
    if (!accountId && !tunnelId) return null;
    return { accountId, tunnelId };
  } catch (_) {
    return null;
  }
}

// Sunucuda tunnel kimligini bulmaya calis. Uydurma yok: bulunamazsa null
// doner ve kullanicidan istenir.
function readLocalTunnelIds() {
  return new Promise((resolve) => {
    const fromUnit = (unitText) => {
      const ids = connectorTokenIds(unitText);
      if (ids && ids.tunnelId) {
        return resolve({ accountId: ids.accountId, tunnelId: ids.tunnelId, source: "connector-token" });
      }
      getLocalTunnelId((err, tunnelId) => {
        resolve({
          accountId: ids ? ids.accountId : null,
          tunnelId: err ? null : tunnelId,
          source: !err && tunnelId ? "config.yml" : null
        });
      });
    };

    run(`systemctl cat ${CLOUDFLARED_UNIT} 2>/dev/null`, (err, stdout) => {
      if (!err && stdout && stdout.trim()) return fromUnit(stdout);
      run(`sudo -n systemctl cat ${CLOUDFLARED_UNIT} 2>/dev/null`, (e2, out2) => fromUnit(out2 || ""));
    });
  });
}

// Token eklendikten sonra hesap/zone/tunnel bilgilerini tamamlar. Basarili
// olursa mod "remote" -> "api" olur.
async function discoverConnection(opts = {}) {
  const c = getCfConfig();
  const token = String(c.apiToken || "").trim();
  if (token.length < 20) {
    throw new Error(
      "Once bir Cloudflare API token'i kaydet (Ayarlar > Entegrasyonlar ya da bu sekmedeki token alani)."
    );
  }
  await cfApi.verifyToken(token);

  const local = await readLocalTunnelIds();

  const domain = cfApi.normalizeDomain(opts.domain || c.zoneDomain || config.get("base_domain"));
  if (!domain) {
    const err = new Error("Zone domain'i bilinmiyor. Domain'i (ornek: example.com) elle gir.");
    err.needsDomain = true;
    throw err;
  }
  const zone = await cfApi.findZone(token, domain);

  let accountId = c.accountId || local.accountId || null;
  if (!accountId) {
    const { account, accounts } = await cfApi.resolveAccount(token, null, { zone });
    if (!account) {
      const err = new Error(
        `Token ${accounts.length} hesaba erisiyor; hangisinin kullanilacagi belirlenemedi. ` +
        "Hesap id'sini Cloudflare panelinden kopyalayip elle gir."
      );
      err.needsAccountChoice = true;
      err.accounts = accounts;
      throw err;
    }
    accountId = account.id;
  }

  const manualTunnel = String(opts.tunnelId || "").trim();
  const tunnelId = manualTunnel || c.tunnelId || local.tunnelId || null;
  if (!tunnelId) {
    const err = new Error(
      "Tunnel id sunucuda bulunamadi (cloudflared servisinde connector token ya da " +
      "config.yml yok). Cloudflare panelinde tunnel'in adresindeki id'yi kopyalayip elle gir."
    );
    err.needsTunnelId = true;
    throw err;
  }

  // Dogrulama: bu ucu okuyabiliyorsak token + hesap + tunnel uclusu gercekten
  // calisiyor demektir.
  const ing = await cfApi.getIngress(token, accountId, tunnelId);
  if (ing.source && ing.source !== "cloudflare") {
    throw new Error(
      `Bu tunnel Cloudflare'de degil, sunucudaki config dosyasindan yonetiliyor (source: ${ing.source}). ` +
      "API'den yazilan ingress cloudflared tarafindan yok sayilir; bu tunnel icin " +
      `${defaults().config_path} kullanilmali.`
    );
  }

  setCfConfig({ accountId, zoneId: zone.id, zoneDomain: zone.name, tunnelId });

  return {
    mode: MODE.API,
    accountId,
    tunnelId,
    zoneDomain: zone.name,
    tunnelIdSource: manualTunnel ? "manual" : (c.tunnelId ? "kayitli" : local.source || "bilinmiyor"),
    entries: mapRules(ing.ingress)
  };
}

// ─────────────────────────── Mod dagiticilari ───────────────────────────

const REMOTE_READONLY =
  "Bu tunnel Cloudflare'de uzaktan yonetiliyor; ingress buradan okunamaz ve " +
  "duzenlenemez. Bir Cloudflare API token'i ekleyip \"Baglantiyi kesfet\" dersen " +
  "sekme yonetilebilir hale gelir.";

function listIngress(cb) {
  if (!isEnabled()) return cb(null, []);
  const m = detectMode();
  if (m.mode === MODE.API) {
    return listIngressApi().then(r => cb(null, r.entries, r.source), err => cb(err));
  }
  if (m.mode === MODE.LOCAL) return listIngressLocal(cb);
  cb(null, []);
}

function addIngress(hostname, port, opts, cb) {
  if (typeof opts === "function") { cb = opts; opts = {}; }
  hostname = normalizeHostname(hostname);
  if (!isEnabled()) return cb(new Error("cloudflare entegrasyonu kapali"));
  const m = detectMode();
  if (m.mode === MODE.API) {
    return addIngressApi(hostname, port, opts).then(r => cb(null, r), err => cb(err));
  }
  if (m.mode === MODE.LOCAL) {
    return opts.dns
      ? addDnsAndIngressLocal(hostname, port, cb)
      : addIngressLocal(hostname, port, cb);
  }
  cb(new Error(REMOTE_READONLY));
}

function removeIngress(hostname, opts, cb) {
  if (typeof opts === "function") { cb = opts; opts = {}; }
  hostname = normalizeHostname(hostname);
  if (!isEnabled()) return cb(new Error("cloudflare entegrasyonu kapali"));
  const m = detectMode();
  if (m.mode === MODE.API) {
    return removeIngressApi(hostname, opts).then(r => cb(null, r), err => cb(err));
  }
  if (m.mode === MODE.LOCAL) {
    return opts.dns
      ? removeDnsAndIngressLocal(hostname, cb)
      : removeIngressLocal(hostname, cb);
  }
  cb(new Error(REMOTE_READONLY));
}

function tunnelStatus(cb) {
  run("systemctl is-active cloudflared", (err, stdout) => {
    cb(null, { active: (stdout || "").trim() === "active" });
  });
}

// Tunnel id: API modunda DB'den (sudo gerekmez), yerel modda config.yml'den.
function getTunnelId(cb) {
  if (!isEnabled()) return cb(null, null);
  const m = detectMode();
  if (m.tunnelId) return cb(null, m.tunnelId);
  if (m.mode === MODE.LOCAL) return getLocalTunnelId(cb);
  cb(null, null);
}

function getSettingsMasked(cb) {
  const c = getCfConfig();
  getTunnelId((err, tId) => {
    const m = detectMode();
    cb(null, {
      enabled: isEnabled(),
      visible: isVisible(),
      hasToken: m.hasToken,
      // Token'in kendisi disari cikmaz; sadece son 4 karakter gosterilir.
      tokenPreview: m.hasToken ? "****" + String(c.apiToken).slice(-4) : null,
      accountId: c.accountId || null,
      zoneId: c.zoneId || null,
      zoneDomain: m.zoneDomain,
      tunnelId: m.tunnelId || tId || null,
      configPath: m.configPath,
      mode: m.mode,
      canManage: m.canManage,
      protectedHosts: m.protectedHosts,
      note: m.note
    });
  });
}

function saveToken(token, cb) {
  if (!token || typeof token !== "string" || token.trim().length < 20) {
    return cb(new Error("Gecersiz token"));
  }
  // Zone bilgisi token degisince gecersizlesir; hesap/tunnel kimlikleri
  // token'a bagli olmadigi icin korunur (kesif tekrar calisabilsin).
  setCfConfig({ apiToken: token.trim(), zoneId: null, zoneDomain: null });
  cb(null);
}

function clearToken(cb) {
  integrations.remove("cloudflare");
  cb(null);
}

// ─────────────────────────── Health ───────────────────────────

const healthCache = new Map();
const HEALTH_TTL = 8000;

function pingLocalService(serviceUrl, cb) {
  const cached = healthCache.get(serviceUrl);
  if (cached && Date.now() - cached.at < HEALTH_TTL) return cb(cached.status);
  const m = serviceUrl && serviceUrl.match(/^http:\/\/(localhost|127\.0\.0\.1):(\d+)/);
  if (!m) return cb({ ok: null, reason: "not-local" });
  const port = parseInt(m[2]);
  const start = Date.now();
  const req = http.request({
    host: "127.0.0.1", port, path: "/", method: "HEAD", timeout: 2500
  }, (res) => {
    const latency = Date.now() - start;
    const code = res.statusCode || 0;
    res.resume();
    const status = { ok: code < 500, code, latency, level: code >= 500 ? "red" : code >= 400 ? "yellow" : "green" };
    healthCache.set(serviceUrl, { at: Date.now(), status });
    cb(status);
  });
  req.on("error", (err) => {
    const status = { ok: false, code: 0, reason: err.code || err.message, level: "red" };
    healthCache.set(serviceUrl, { at: Date.now(), status });
    cb(status);
  });
  req.on("timeout", () => {
    req.destroy();
    const status = { ok: false, code: 0, reason: "timeout", level: "red" };
    healthCache.set(serviceUrl, { at: Date.now(), status });
    cb(status);
  });
  req.end();
}

function healthForAllIngress(cb) {
  if (!isEnabled()) return cb(null, { health: {} });
  listIngress((err, entries) => {
    if (err) return cb(err);
    const targets = entries.filter(e => e.hostname && !e.isCatchAll && !e.isWildcard && e.service && /^http:\/\/(localhost|127\.0\.0\.1):/.test(e.service));
    let remaining = targets.length;
    const result = {};
    if (!remaining) return cb(null, { health: {} });
    for (const e of targets) {
      pingLocalService(e.service, (status) => {
        result[e.hostname] = { service: e.service, ...status };
        if (--remaining === 0) cb(null, { health: result });
      });
    }
  });
}

module.exports = {
  MODE,
  isEnabled,
  isVisible,
  detectMode,
  protectedHosts,
  listIngress,
  addIngress,
  removeIngress,
  discoverConnection,
  connectorTokenIds,
  withCatchAllLast,
  insertRule,
  mapRules,
  tunnelStatus,
  isValidHostname,
  isValidPort,
  getSettingsMasked,
  saveToken,
  clearToken,
  healthForAllIngress
};
