// Kurulum sihirbazinin ORTAK cekirdegi.
//
// Iki arayuz de bu modulu kullanir:
//   - tarayici sihirbazi : routes/setup.js   (HTTP endpoint'leri)
//   - terminal sihirbazi : scripts/setup-cli.js
//
// Dogrulama, Cloudflare on-kontrolu, DB seed'i ve kurulum sonrasi adimlar
// YALNIZCA burada tanimlidir. Iki tarafta ayri kopya yok; farkli olan tek sey
// sorularin nasil soruldugu ve kurulum modundan cikisin kim tarafindan
// tetiklendigidir (bkz. runPostSetup -> transition).

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const caddy = require("./caddy");
const cloudflared = require("./cloudflared-installer");
const cfApi = require("./cloudflare-api");
const firewall = require("./firewall");
const detect = require("./service-detect");
const config = require("./config");
const { settings, services, users, integrations } = require("../db/repos");

// install.sh + scripts/generate-systemd.js unit'i "lyra" adiyla kuruyor.
const LYRA_UNIT_NAME = "lyra";
// install.sh bu drop-in'i yazar (bkz. install.sh -> kurulum modu bolumu).
const SETUP_DROPIN = `/etc/systemd/system/${LYRA_UNIT_NAME}.service.d/setup-mode.conf`;
// Kurulum fazinin gecici tam-yetki sudoers dosyasi
// (scripts/generate-sudoers.js --setup).
const SETUP_SUDOERS = "/etc/sudoers.d/lyra-setup";
const SETUP_PORT = parseInt(process.env.LYRA_SETUP_PORT || "80", 10);

// Desteklenen erisim modlari. CLI ve tarayici ayni listeden beslenir.
const ACCESS_MODES = ["public", "lan", "localhost", "cf-tunnel", "cf-api", "manual"];

// ─────────────────────────── Sistem kullanicisi ───────────────────────────

// /etc/passwd'den home dizini oku (os.userInfo() sadece calisan kullaniciyi verir).
function homeOfUser(username) {
  try {
    const passwd = fs.readFileSync("/etc/passwd", "utf8");
    for (const line of passwd.split("\n")) {
      const parts = line.split(":");
      if (parts[0] === username && parts[5]) return parts[5];
    }
  } catch (_) {}
  return null;
}

// Lyra hangi Linux kullanicisi olarak calisiyor? Projeler dizini bu
// kullanicinin home'unda olmali — panel kullanici adiyla ("admin") alakasi yok.
function systemUserInfo() {
  let username = null;
  let home = null;

  try {
    const info = os.userInfo();
    username = info.username;
    home = info.homedir || null;
  } catch (_) {}

  // `sudo npm run setup` ile elle baslatildiysa gercek kullanici SUDO_USER'da.
  if (process.env.SUDO_USER && process.env.SUDO_USER !== username) {
    username = process.env.SUDO_USER;
    home = homeOfUser(username) || `/home/${username}`;
  }

  if (!home && username) home = homeOfUser(username) || `/home/${username}`;
  if (!home) home = os.homedir() || "/root";

  return {
    user: username || "root",
    home,
    suggestedProjectsDir: path.join(home, "projects")
  };
}

// Projeler dizini gercekten yazilabilir mi? Yoksa dogru sahiplikle yarat.
// Lyra servis kullanicisi olarak calistigi icin olusturulan dizin dogrudan
// o kullaniciya ait olur.
function ensureProjectsDir(dir) {
  const who = systemUserInfo().user;
  if (!dir || !path.isAbsolute(dir)) {
    return {
      ok: false,
      error: "Projeler dizini mutlak bir yol olmali (ornek: /home/ubuntu/projects)"
    };
  }
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    } else if (!fs.statSync(dir).isDirectory()) {
      return { ok: false, error: `${dir} bir dizin degil.` };
    }
  } catch (err) {
    return {
      ok: false,
      error: `Projeler dizini olusturulamadi (${dir}): ${err.message}. Lyra "${who}" kullanicisi olarak calisiyor.`
    };
  }

  // accessSync yetmez: ProtectSystem/ReadOnlyPaths gibi mount kisitlari ancak
  // gercek yazmada ortaya cikar.
  const probe = path.join(dir, ".lyra-write-test");
  try {
    fs.writeFileSync(probe, "lyra");
    fs.unlinkSync(probe);
  } catch (err) {
    return {
      ok: false,
      error: `Projeler dizinine yazilamiyor (${dir}): ${err.message}. Lyra "${who}" kullanicisi olarak calisiyor; dizin sahipligini kontrol et.`
    };
  }
  return { ok: true };
}

// ─────────────────────────── Kabuk yardimcilari ───────────────────────────

// sudo -n ile tek komut. Shell yok, argumanlar dizi.
function sudo(argv, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile("sudo", ["-n", ...argv], { timeout }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || "").toString().trim() || err.message;
        return reject(new Error(`sudo ${argv.join(" ")}: ${msg}`));
      }
      resolve((stdout || "").toString());
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Lyra systemd unit'i kurulu mu? (install.sh kurar; elle baslatilan
// sihirbazda olmayabilir.)
function systemdUnitExists(unit = LYRA_UNIT_NAME) {
  return new Promise((resolve) => {
    execFile("systemctl", ["cat", unit], { timeout: 10000 }, (err) => resolve(!err));
  });
}

function systemdUnitActive(unit = LYRA_UNIT_NAME) {
  return new Promise((resolve) => {
    execFile("systemctl", ["is-active", unit], { timeout: 10000 }, (err, stdout) => {
      resolve((stdout || "").toString().trim() === "active");
    });
  });
}

// ─────────────────── Cloudflare API modu (accessMode: cf-api) ───────────────────

// Panelin duracagi alt alan adi. Apex'te cakisma varsa kullaniciya bunu
// oneriyoruz: apex kaydina hic dokunmadan wildcard uzerinden erisim.
const DEFAULT_PANEL_SUBDOMAIN = "lyra";

function normalizePanelSub(input) {
  const s = String(input === undefined || input === null ? "" : input)
    .trim()
    .toLowerCase();
  if (!s) return DEFAULT_PANEL_SUBDOMAIN;
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(s) ? s : null;
}

// cf-api govdesini tek yerde cozumle — preflight ve finalize ayni kurallari
// kullansin diye.
function cfPlanFromBody(body) {
  const domain = cfApi.normalizeDomain(body.domain);
  const hostMode = body.cfHostMode === "subdomain" ? "subdomain" : "apex";
  const panelSub = normalizePanelSub(body.cfPanelSubdomain);
  const panelHost =
    domain && panelSub ? (hostMode === "subdomain" ? `${panelSub}.${domain}` : domain) : null;
  return {
    token: String(body.cfApiToken || "").trim(),
    accountId: body.cfAccountId ? String(body.cfAccountId).trim() : null,
    domain,
    hostMode,
    panelSub,
    panelHost,
    overwriteDns: !!body.cfOverwriteDns
  };
}

const DNS_ACTION_TR = {
  created: "olusturuldu",
  unchanged: "zaten dogruydu",
  replaced: "uzerine yazildi"
};

// Cloudflare API modu on-kontrolu. Kurulum baslamadan once token/hesap/zone
// dogrulanir ve MEVCUT DNS kayitlari okunur. Amac: apex'te eski hosting'den
// kalmis bir A kaydi varsa kullanici bunu kurulum sirasinda degil, ONCESINDE
// gorsun ve ne yapilacagina kendisi karar versin.
//
// Hata durumunda throw eder; cagiran (HTTP 400 / CLI mesaji) kendi diline cevirir.
async function cfPreflight(plan) {
  if (!plan.token) throw new Error("Cloudflare API token gerekli");
  if (!plan.domain) throw new Error("Gecerli bir domain gerekli (ornek: example.com)");
  if (!plan.panelSub) throw new Error("Gecersiz alt alan adi (ornek: lyra)");

  await cfApi.verifyToken(plan.token);

  // SIRA ONEMLI: once zone, sonra hesap. Hesap id'si zone cevabindan gelir;
  // GET /accounts dar kapsamli token'da (Account Settings: Read yokken) bos
  // doner ve tek basina kullanilamaz.
  const zone = await cfApi.findZone(plan.token, plan.domain);

  const { account, accounts } = await cfApi.resolveAccount(plan.token, plan.accountId, { zone });
  if (!account) {
    return { needsAccountChoice: true, accounts };
  }

  const hosts = {
    apex: plan.domain,
    wildcard: `*.${plan.domain}`,
    panel: `${plan.panelSub}.${plan.domain}`
  };
  const records = {};
  for (const scope of Object.keys(hosts)) {
    const found = await cfApi.listDnsRecords(plan.token, zone.id, hosts[scope]);
    records[scope] = found.map((r) => ({
      ...r,
      isTunnel: /\.cfargotunnel\.com$/i.test(r.content || "")
    }));
  }

  const conflicts = Object.keys(hosts)
    .map((scope) => ({
      scope,
      host: hosts[scope],
      records: records[scope].filter((r) => !r.isTunnel)
    }))
    .filter((c) => c.records.length);

  const apexBlocked = conflicts.some((c) => c.scope === "apex");
  const panelBlocked = conflicts.some((c) => c.scope === "panel");

  return {
    ok: true,
    account,
    accounts,
    zone,
    hosts,
    records,
    conflicts,
    // Apex doluysa varsayilan oneri: apex kaydina hic dokunma, paneli
    // wildcard uzerinden alt alan adinda ac.
    recommendation: apexBlocked && !panelBlocked ? "subdomain" : "apex"
  };
}

// Ayni isimde tunnel varsa (yarida kalmis bir kurulumdan) kurulum burada
// tikanmasin diye bir kez rastgele son ekle tekrar deniyoruz. Cloudflare'in bu
// durumda dondurdugu kodu canli dogrulamadik; mesaj metnine bakiyoruz.
async function createTunnelOrRetry(token, accountId, baseName) {
  try {
    return await cfApi.createTunnel(token, accountId, baseName);
  } catch (err) {
    if (!/exist|duplicate|1015/i.test(err && err.message ? err.message : "")) throw err;
    const suffix = crypto.randomBytes(2).toString("hex");
    return cfApi.createTunnel(token, accountId, `${baseName}-${suffix}`);
  }
}

// Cloudflare entegrasyon kaydini guncelle. Token integrations tablosunda
// tutulur (settings'e duz metin serpistirilmez); Tunnel sekmesi buradan okur.
function saveCfIntegration(patch) {
  const cur = integrations.get("cloudflare");
  integrations.set("cloudflare", {
    enabled: true,
    config: { ...((cur && cur.config) || {}), ...patch }
  });
}

// ─────────────────────────── Dogrulama + seed ───────────────────────────

// Sihirbaz govdesini dogrula. Tarayici tarafinda 2FA dogrulamasi session'da,
// CLI tarafinda terminalde yapilir; sonucu totpVerified ile geliyor.
function validateFinalize(body, { totpVerified = false } = {}) {
  const errors = [];
  const appName = String(body.appName || "").trim();
  const projectsDir = String(body.projectsDir || "").trim();

  if (!body.user || !body.user.username || !body.user.password) {
    errors.push("Admin kullanici bilgileri eksik");
  }
  if (body.user && body.user.password && body.user.password.length < 12) {
    errors.push("Sifre en az 12 karakter olmali");
  }
  if (!body.accessMode) errors.push("Erisim modu secilmeli");
  else if (!ACCESS_MODES.includes(body.accessMode)) {
    errors.push(`Bilinmeyen erisim modu: ${body.accessMode} (gecerli: ${ACCESS_MODES.join(", ")})`);
  }
  if (body.accessMode === "public" && (!body.domain || !body.email)) {
    errors.push("Public mode icin domain ve email gerekli");
  }
  if (body.accessMode === "cf-tunnel" && !body.cfToken) {
    errors.push("CF Tunnel icin connector token gerekli");
  }
  const cfPlan = body.accessMode === "cf-api" ? cfPlanFromBody(body) : null;
  if (cfPlan) {
    if (!cfPlan.token) errors.push("Cloudflare API token gerekli");
    if (!cfPlan.domain) errors.push("Gecerli bir domain gerekli (ornek: example.com)");
    if (!cfPlan.panelSub) errors.push("Gecersiz alt alan adi (ornek: lyra)");
  }
  if (body.user && body.user.enable2FA && !totpVerified) {
    errors.push("2FA dogrulamasi tamamlanmali");
  }
  if (!appName) errors.push("Uygulama adi gerekli");
  if (!projectsDir) errors.push("Projeler dizini gerekli");

  return { errors, cfPlan, appName, projectsDir };
}

function deriveFinalUrl(mode, host) {
  if (mode === "public" && host) return `https://${host}`;
  if (mode === "cf-tunnel" && host) return `https://${host}`;
  if (mode === "cf-api" && host) return `https://${host}`;
  if (mode === "lan") return `http://<sunucu-ip>:${config.PORT}`;
  return `http://127.0.0.1:${config.PORT}`;
}

// Sihirbazin topladigi her seyi DB'ye yaz: ayarlar, admin, servisler,
// entegrasyonlar. Cagirmadan once validateFinalize + ensureProjectsDir.
function applyFinalize(body, { totpSecret = null } = {}) {
  const accessMode = body.accessMode;
  const cfPlan = accessMode === "cf-api" ? cfPlanFromBody(body) : null;
  const appName = String(body.appName || "").trim();
  const projectsDir = String(body.projectsDir || "").trim();

  // bind_address mapping. cf-api dahil tunnel modlarinda Lyra loopback'te
  // kalir; baglanti cloudflared uzerinden localhost'a gelir.
  const bindAddress = accessMode === "lan" ? "0.0.0.0" : "127.0.0.1";
  const publicAccess =
    accessMode === "public" || accessMode === "cf-tunnel" || accessMode === "cf-api";

  // cf-api'de domain normalize edilmis haliyle yazilir; panel_host apex ya da
  // secilen alt alan adidir (wildcard ingress ikisini de karsilar).
  const baseDomain = cfPlan ? cfPlan.domain : body.domain;
  const panelHost = cfPlan ? cfPlan.panelHost : body.domain || null;

  // 1. Settings
  settings.setMany({
    app_name: appName,
    projects_dir: projectsDir,
    bind_address: bindAddress,
    public_access: publicAccess,
    access_mode: accessMode,
    ...(baseDomain ? { base_domain: baseDomain } : {}),
    ...(panelHost ? { panel_host: panelHost } : {})
  });

  // 2. Admin kullanici
  users.create({
    username: body.user.username,
    password: body.user.password,
    totpSecret: body.user.enable2FA ? totpSecret : null,
    totpEnabled: !!body.user.enable2FA
  });

  // 3. Servisler
  if (Array.isArray(body.services) && body.services.length) {
    const detected = detect.detectAll();
    for (const type of body.services) {
      const s = detected.find((d) => d.type === type);
      if (!s) continue;
      const existing = services.getByUnit(s.unit_name);
      if (existing) {
        services.update(existing.id, {
          display_name: s.display_name,
          type: s.type,
          port: s.default_port,
          enabled: 1
        });
      } else {
        services.add({
          unit_name: s.unit_name || s.type,
          display_name: s.display_name,
          type: s.type,
          port: s.default_port,
          subdomain: null,
          enabled: 1
        });
      }
    }
  }

  // 3b. Ports ve Logs sekmelerinin ihtiyac duydugu ayarlari seed et.
  //     system_ports hic yazilmiyordu: code-server gibi servisler "dev port"
  //     gorunup panelden oldurulebiliyordu. lyra_service_name yazilmayinca
  //     Logs sekmesinde sadece ssh listeleniyordu.
  const { DEFAULT_SYSTEM_PORTS } = require("../routes/ports");
  const registeredPorts = services
    .list()
    .map((s) => s.port)
    .filter(Boolean);
  settings.setMany({
    system_ports: [...new Set([...DEFAULT_SYSTEM_PORTS, config.PORT, ...registeredPorts])],
    lyra_service_name: LYRA_UNIT_NAME
  });

  // 4. Entegrasyonlar
  if (body.integrations) {
    if (body.integrations.telegram && body.integrations.telegram.botToken) {
      integrations.set("telegram", {
        enabled: true,
        config: body.integrations.telegram
      });
    }
    if (body.integrations.github && body.integrations.github.token) {
      integrations.set("github", {
        enabled: true,
        config: body.integrations.github
      });
    }
  }

  return {
    accessMode,
    baseDomain: baseDomain || null,
    panelHost: panelHost || null,
    finalUrl: deriveFinalUrl(accessMode, panelHost)
  };
}

// ─────────────────────────── Post-setup ilerleme ───────────────────────────

function buildSteps(mode) {
  const steps = [];
  if (mode === "public") {
    steps.push({ key: "caddy-install", label: "Caddy kuruluyor" });
    steps.push({ key: "caddy-config", label: "Caddyfile yaziliyor, sertifika isteniyor" });
  } else if (mode === "cf-api") {
    steps.push({ key: "cf-verify", label: "Cloudflare token ve domain dogrulaniyor" });
    steps.push({ key: "cf-tunnel", label: "Tunnel olusturuluyor" });
    steps.push({ key: "cf-ingress", label: "Tunnel yonlendirmesi (ingress) yaziliyor" });
    steps.push({ key: "cf-dns", label: "DNS kayitlari olusturuluyor" });
    steps.push({ key: "cloudflared-install", label: "cloudflared kuruluyor" });
    steps.push({ key: "cloudflared-service", label: "Tunnel servisi baslatiliyor" });
  } else if (mode === "cf-tunnel") {
    steps.push({ key: "cloudflared-install", label: "cloudflared kuruluyor" });
    steps.push({ key: "cloudflared-service", label: "Tunnel servisi baslatiliyor" });
  }
  steps.push({ key: "firewall", label: "Firewall kurallari uygulaniyor" });
  steps.push({ key: "setup-mode-off", label: "Kurulum modu kapatiliyor" });
  steps.push({ key: "lyra-restart", label: "Lyra yeniden baslatiliyor" });
  return steps.map((s) => ({ ...s, status: "pending", error: null, note: null }));
}

// Kurulum sonrasi adimlarin canli durumu. Tarayici tarafinda tek bir ornek
// modul seviyesinde tutulur ve /api/setup/progress ile okunur; CLI kendi
// ornegini yaratip onUpdate ile terminale basar.
function createProgress({ onUpdate } = {}) {
  const p = {
    active: false,
    finished: false,
    restarting: false,
    startedAt: null,
    finishedAt: null,
    finalUrl: null,
    steps: []
  };

  const notify = (step) => {
    if (onUpdate) onUpdate(step, p);
  };

  p.start = (mode, finalUrl) => {
    p.active = true;
    p.finished = false;
    p.restarting = false;
    p.startedAt = Date.now();
    p.finishedAt = null;
    p.finalUrl = finalUrl || null;
    p.steps = buildSteps(mode);
    return p;
  };

  p.step = (key) => p.steps.find((s) => s.key === key) || null;

  p.payload = () => ({
    active: p.active,
    finished: p.finished,
    restarting: p.restarting,
    failed: p.steps.some((s) => s.status === "failed"),
    finalUrl: p.finalUrl,
    steps: p.steps.map((s) => ({
      key: s.key,
      label: s.label,
      status: s.status,
      error: s.error,
      note: s.note
    }))
  });

  p.setStatus = (key, status, { error = null, note = null } = {}) => {
    const step = p.step(key);
    if (!step) return null;
    step.status = status;
    if (error !== null) step.error = error;
    if (note !== null) step.note = String(note);
    notify(step);
    return step;
  };

  p.runStep = async (key, fn) => {
    const step = p.step(key);
    if (!step) return true;
    step.status = "running";
    notify(step);
    try {
      const note = await fn();
      if (note) step.note = String(note);
      step.status = "ok";
      notify(step);
      return true;
    } catch (err) {
      step.status = "failed";
      step.error = err && err.message ? err.message : String(err);
      notify(step);
      console.error(`[setup-post] ${key} basarisiz: ${step.error}`);
      return false;
    }
  };

  p.finish = () => {
    p.active = false;
    p.finished = true;
    p.finishedAt = Date.now();
    return p;
  };

  return p;
}

// Caddyfile diske yazildi ve bizim domain'i iceriyor mu? applyConfig hem
// validate hem reload hatasinda ayni sekli donuyor; ikisini ayirt etmek icin
// sonuca bakiyoruz (lib/caddy.js'e dokunmadan).
function caddyfileHasDomain(domain) {
  try {
    return fs.readFileSync(caddy.CADDYFILE, "utf8").includes(`${domain} {`);
  } catch (_) {
    return false;
  }
}

// Cloudflare API modu: tunnel'i, ingress'i ve DNS'i Lyra kendisi kurar.
// Connector token CF dashboard'dan degil API'den gelir; cloudflared'e yine
// stdin uzerinden verilir (bkz. cloudflared-installer.installService).
async function runCfApiSteps(body, progress, log) {
  const plan = cfPlanFromBody(body);
  const state = {
    accountId: null,
    zoneId: null,
    zoneName: null,
    tunnelId: null,
    connectorToken: null
  };
  let ok;

  ok = await progress.runStep("cf-verify", async () => {
    await cfApi.verifyToken(plan.token);
    // SIRA ONEMLI: hesap id'si zone cevabindan turetilir (bkz. cfPreflight).
    const zone = await cfApi.findZone(plan.token, plan.domain);
    const { account, accounts } = await cfApi.resolveAccount(plan.token, plan.accountId, { zone });
    if (!account) {
      throw new Error(
        `Token ${accounts.length} hesaba erisiyor; hangisinin kullanilacagi secilmeli. ` +
          "Sihirbazi bastan calistirip hesabi sec."
      );
    }
    state.accountId = account.id;
    state.zoneId = zone.id;
    state.zoneName = zone.name;
    saveCfIntegration({
      apiToken: plan.token,
      accountId: account.id,
      accountName: account.name || null,
      zoneId: zone.id,
      zoneDomain: zone.name
    });
    const note = `Hesap: ${account.name || account.id} · Zone: ${zone.name} (${zone.status})`;
    return zone.status === "active"
      ? note
      : `${note} — zone aktif degil, nameserver yayilmasi tamamlanana kadar adres calismayabilir`;
  });

  if (ok) {
    ok = await progress.runStep("cf-tunnel", async () => {
      const tunnel = await createTunnelOrRetry(
        plan.token,
        state.accountId,
        `lyra-${plan.domain.replace(/\./g, "-")}`
      );
      state.tunnelId = tunnel.id;
      state.connectorToken = await cfApi.getTunnelToken(plan.token, state.accountId, tunnel.id);
      saveCfIntegration({ tunnelId: tunnel.id, tunnelName: tunnel.name });
      log(`Tunnel olusturuldu: ${tunnel.name} (${tunnel.id})`);
      return `${tunnel.name} · ${tunnel.id}`;
    });
  }

  if (ok) {
    ok = await progress.runStep("cf-ingress", async () => {
      const ingress = cfApi.buildIngress({
        domain: plan.domain,
        port: config.PORT,
        // Apex'i kullanmiyorsak ingress'e de koymuyoruz: apex trafigi zaten
        // kullanicinin mevcut kaydina gidiyor.
        includeApex: plan.hostMode === "apex"
      });
      await cfApi.putIngress(plan.token, state.accountId, state.tunnelId, ingress);
      const hosts = ingress
        .filter((r) => r.hostname)
        .map((r) => r.hostname)
        .join(", ");
      return `${hosts} -> localhost:${config.PORT}`;
    });
  }

  if (ok) {
    ok = await progress.runStep("cf-dns", async () => {
      const content = cfApi.tunnelCname(state.tunnelId);
      const names = plan.hostMode === "apex" ? ["@", "*"] : [plan.panelSub, "*"];
      const notes = [];
      for (const name of names) {
        const r = await cfApi.upsertDnsRecord(
          plan.token,
          state.zoneId,
          { type: "CNAME", name, content, proxied: true },
          { overwrite: plan.overwriteDns, zoneName: state.zoneName }
        );
        const shown = (r.record && r.record.name) || cfApi.toFqdn(name, state.zoneName);
        notes.push(`${shown}: ${DNS_ACTION_TR[r.action] || r.action}`);
      }
      return notes.join(" · ");
    });
  }

  if (ok) {
    ok = await progress.runStep("cloudflared-install", async () => {
      const r = await cloudflared.install({ onLog: log });
      if (!r.ok) throw new Error(r.error || "cloudflared kurulamadi");
      return r.alreadyInstalled ? "Zaten kuruluydu" : null;
    });
  }

  if (ok) {
    ok = await progress.runStep("cloudflared-service", async () => {
      const r = await cloudflared.installService({ token: state.connectorToken, onLog: log });
      if (!r.ok) throw new Error(r.error || "cloudflared servisi olusturulamadi");
      return `Panel adresi: https://${plan.panelHost}`;
    });
  }

  return ok;
}

// Kurulum sonrasi zincir.
//
// transition:
//   "self"   — sihirbazi Lyra'nin KENDISI calistiriyor (tarayici modu).
//              "systemctl restart lyra" bizi oldurur, o yuzden gecisi
//              systemd-run ile bagimsiz bir transient unit'e devrediyoruz.
//   "direct" — sihirbaz ayri bir process (CLI). Gecisi kendimiz yapabiliriz;
//              restart'i bekler ve sonucu dogrulariz.
async function runPostSetup(mode, body, progress, { log, transition = "self" } = {}) {
  const emit = log || ((m) => console.log(`[setup-post] ${m}`));
  let ok = true;

  if (mode === "public") {
    ok = await progress.runStep("caddy-install", async () => {
      const fresh = !caddy.isInstalled();
      if (fresh) {
        // apt paketi kurulumun sonunda caddy.service'i baslatir. Kurulum
        // sihirbazi port 80'i tuttugu icin bu basarisiz olur ve apt hata
        // dondurur. Unit'i kurulum boyunca mask'lemek standart cozum;
        // kurulum modundan cikista caddy zaten restart ediliyor.
        await sudo(["systemctl", "mask", "caddy"]).catch(() => {});
      }
      try {
        const r = await caddy.install({ onLog: emit });
        if (!r.ok) throw new Error(r.error || "Caddy kurulamadi");
        return r.alreadyInstalled ? "Zaten kuruluydu" : null;
      } finally {
        if (fresh) await sudo(["systemctl", "unmask", "caddy"]).catch(() => {});
      }
    });
    if (ok) {
      ok = await progress.runStep("caddy-config", async () => {
        const r = await caddy.applyConfig({
          domain: body.domain,
          email: body.email,
          upstream: `127.0.0.1:${config.PORT}`,
          onLog: emit
        });
        if (r.ok) return null;
        // Reload/restart port 80 bizde oldugu icin basarisiz olabilir; dosya
        // yazilip "caddy validate"ten gectiyse sorun yok.
        if (caddyfileHasDomain(body.domain)) {
          return "Caddyfile yazildi, reload kurulum modundan cikista yapilacak";
        }
        throw new Error(r.error || "Caddyfile uygulanamadi");
      });
    }
  } else if (mode === "cf-api") {
    ok = await runCfApiSteps(body, progress, emit);
  } else if (mode === "cf-tunnel") {
    ok = await progress.runStep("cloudflared-install", async () => {
      const r = await cloudflared.install({ onLog: emit });
      if (!r.ok) throw new Error(r.error || "cloudflared kurulamadi");
      return r.alreadyInstalled ? "Zaten kuruluydu" : null;
    });
    if (ok) {
      ok = await progress.runStep("cloudflared-service", async () => {
        const r = await cloudflared.installService({ token: body.cfToken, onLog: emit });
        if (!r.ok) throw new Error(r.error || "cloudflared servisi olusturulamadi");
        return null;
      });
    }
  }

  if (ok) {
    ok = await progress.runStep("firewall", async () => {
      const closed = firewall.closeSetupPort(SETUP_PORT, { onLog: emit });
      const applied = firewall.applyAccessMode(mode, { port: config.PORT, onLog: emit });
      const parts = [];
      if (closed.applied) parts.push(`${SETUP_PORT}/tcp kapatildi`);
      parts.push(applied.summary);
      return parts.join(" · ");
    });
  }

  // Sihirbaz install.sh disinda (ornegin "sudo npm run setup") baslatilmis
  // olabilir; o zaman restart edecek bir unit yok.
  const hasUnit = ok ? await systemdUnitExists() : false;

  if (ok) {
    ok = await progress.runStep("setup-mode-off", async () => {
      if (!hasUnit) {
        return `${LYRA_UNIT_NAME}.service bulunamadi — otomatik gecis atlandi`;
      }
      if (transition === "direct") {
        // Ayri process'iz: drop-in'i silip daemon-reload yapmak bizi oldurmez.
        await sudo(["rm", "-f", SETUP_DROPIN]);
        await sudo(["systemctl", "daemon-reload"]);
        return "Kurulum modu drop-in'i kaldirildi";
      }
      // Gecisi KENDIMIZ yapamayiz: "systemctl restart lyra" bizi oldurur ve
      // sonrasinda calisacak komut kalmaz (detached child bile unit'in
      // cgroup'unda oldugu icin birlikte oldurulur). systemd-run ile gecisi
      // bizden bagimsiz, root bir transient unit'e devrediyoruz.
      const script = [
        `rm -f ${SETUP_DROPIN}`,
        "systemctl daemon-reload",
        // Lyra once restart olur: port 80'i birakir, normal portuna doner.
        `systemctl restart ${LYRA_UNIT_NAME}`,
        // Caddy ancak 80 bosaldiktan sonra ayaga kalkabilir.
        ...(mode === "public" ? ["systemctl restart caddy"] : []),
        `rm -f ${SETUP_SUDOERS}`
      ].join("; ");

      // AccuracySec sart: systemd'nin transient timer varsayilani 1 dakikadir,
      // yani "--on-active=3" aslinda 3-63 sn arasi herhangi bir an demek.
      // Olcumde 35 sn ve 54 sn gorduk. 1s ile timer gercekten ~3 sn'de tetiklenir.
      await sudo([
        "systemd-run",
        "--collect",
        "--unit",
        "lyra-setup-finish",
        "--description=Lyra kurulum modundan cikis",
        "--timer-property=AccuracySec=1s",
        "--on-active=3",
        "/bin/sh",
        "-c",
        script
      ]);
      return "Gecis planlandi (3 sn)";
    });
  }

  if (!ok) {
    progress.finish();
    emit("Kurulum sonrasi adimlar hatayla bitti — kurulum modu acik birakildi.");
    return false;
  }

  if (!hasUnit) {
    progress.setStatus("lyra-restart", "failed", {
      error:
        "Lyra systemd servisi olarak kurulu degil, otomatik gecis yapilamaz. " +
        "Bu process'i durdurup normal modda baslat (npm start), ya da tam kurulum " +
        "icin: sudo bash install.sh"
    });
    progress.finish();
    return false;
  }

  if (transition === "direct") {
    const restarted = await progress.runStep("lyra-restart", async () => {
      await sudo(["systemctl", "restart", LYRA_UNIT_NAME]);
      if (mode === "public") {
        await sudo(["systemctl", "restart", "caddy"]).catch((err) => {
          emit(`Caddy yeniden baslatilamadi: ${err.message}`);
        });
      }
      await sleep(2000);
      if (!(await systemdUnitActive())) {
        throw new Error(
          `${LYRA_UNIT_NAME}.service ayaga kalkmadi. Sunucuda: ` +
            `sudo journalctl -u ${LYRA_UNIT_NAME} -n 50 --no-pager`
        );
      }
      // Gecici tam-yetki sudoers dosyasi en son gider: yukaridaki komutlar ona
      // dayaniyor olabilir.
      await sudo(["rm", "-f", SETUP_SUDOERS]).catch(() => {});
      return `${LYRA_UNIT_NAME}.service normal modda calisiyor (port ${config.PORT})`;
    });
    progress.finish();
    return restarted;
  }

  // Bu noktadan sonra transient unit bizi yeniden baslatir. Istemci kopmayi
  // "yeniden basliyor" olarak yorumlar ve final adreste /healthz yoklar.
  progress.setStatus("lyra-restart", "running");
  progress.restarting = true;
  emit("Kurulum modundan cikis planlandi; Lyra birazdan yeniden baslatilacak.");

  // Hala buradaysak gecis olmamis demektir — sessizce beklemek yerine soyle.
  // Timer ~3 sn'de tetiklenmeli; 90 sn kemer+askı, yavas diskte servis
  // durdurma/baslatma uzarsa basarili kurulumu "basarisiz" damgalamayalim.
  await sleep(90000);
  progress.restarting = false;
  progress.setStatus("lyra-restart", "failed", {
    error:
      "Yeniden baslatma gerceklesmedi. Sunucuda: sudo systemctl status lyra-setup-finish; " +
      `sudo systemctl restart ${LYRA_UNIT_NAME}`
  });
  progress.finish();
  return false;
}

// Kurulum yarida kalirsa /etc/sudoers.d/lyra-setup dosyasi geride kalir.
// Normal mode acilisinda temizlenir (bkz. server.js).
function cleanupSetupPrivileges() {
  if (!fs.existsSync(SETUP_SUDOERS)) return;
  execFile("sudo", ["-n", "rm", "-f", SETUP_SUDOERS], { timeout: 10000 }, (err) => {
    if (err) {
      console.warn(
        `[lyra] Gecici kurulum sudoers dosyasi silinemedi (${SETUP_SUDOERS}). ` +
          "Varsa elle sil: sudo rm -f " +
          SETUP_SUDOERS
      );
    }
  });
}

module.exports = {
  LYRA_UNIT_NAME,
  SETUP_DROPIN,
  SETUP_SUDOERS,
  SETUP_PORT,
  ACCESS_MODES,
  DEFAULT_PANEL_SUBDOMAIN,
  homeOfUser,
  systemUserInfo,
  ensureProjectsDir,
  normalizePanelSub,
  cfPlanFromBody,
  cfPreflight,
  validateFinalize,
  applyFinalize,
  deriveFinalUrl,
  buildSteps,
  createProgress,
  runPostSetup,
  cleanupSetupPrivileges,
  systemdUnitExists,
  systemdUnitActive
};
