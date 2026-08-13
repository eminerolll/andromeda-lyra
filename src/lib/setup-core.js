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

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const caddy = require("./caddy");
const cloudflared = require("./cloudflared-installer");
const cfApi = require("./cloudflare-api");
const firewall = require("./firewall");
const detect = require("./service-detect");
const installer = require("./service-installer");
const config = require("./config");
const { settings, services, users, integrations } = require("../db/repos");

// install.sh + scripts/generate-systemd.js unit'i "lyra" adiyla kuruyor.
const LYRA_UNIT_NAME = "lyra";
// install.sh bu drop-in'i yazar (bkz. install.sh -> kurulum modu bolumu).
const SETUP_DROPIN = `/etc/systemd/system/${LYRA_UNIT_NAME}.service.d/setup-mode.conf`;
// Kurulum fazinin gecici tam-yetki sudoers dosyasi
// (scripts/generate-sudoers.js --setup).
const SETUP_SUDOERS = "/etc/sudoers.d/lyra-setup";
// Sihirbazin dinledigi port. Tunnel modunda AYRI bir kurulum portu YOKTUR:
// ingress zaten localhost:LYRA_PORT'a bakar, sihirbaz dogrudan orada calisir.
// O yuzden varsayilan 80 degil, Lyra'nin kendi portudur; 80'i yalnizca
// install.sh "makine disaridan erisilebilir" modunda acikca verir
// (bkz. server.js — ayni kural).
const SETUP_PORT = parseInt(process.env.LYRA_SETUP_PORT || String(config.PORT), 10);
// Kurulum sihirbazi Lyra'nin normal portunda calisiyorsa kapatilacak gecici
// port de yoktur.
const HAS_SEPARATE_SETUP_PORT = SETUP_PORT !== config.PORT;

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

// Ayni ADDA tunnel bulunursa ne yapilacak? Varsayilan "fail": karar
// verilmeden hicbir sey devralinmaz, silinmez.
const TUNNEL_EXISTING_MODES = ["fail", "reuse", "recreate"];

// Domain'den turetilen varsayilan tunnel adi.
function defaultTunnelName(domain) {
  return domain ? `lyra-${domain.replace(/\./g, "-")}` : null;
}

// Cloudflare tunnel adi: harf/rakam/tire/alt cizgi/nokta, 1-64 karakter.
function normalizeTunnelName(input) {
  const s = String(input === undefined || input === null ? "" : input).trim();
  if (!s) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s) ? s : null;
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
    overwriteDns: !!body.cfOverwriteDns,
    // Tunnel adi verilmediyse domain'den turetilir; gecersiz ad null kalir ve
    // dogrulamada yakalanir.
    tunnelName: body.cfTunnelName
      ? normalizeTunnelName(body.cfTunnelName)
      : defaultTunnelName(domain),
    tunnelExisting: TUNNEL_EXISTING_MODES.includes(body.cfTunnelExisting)
      ? body.cfTunnelExisting
      : "fail",
    replaceCloudflared: !!body.cfReplaceCloudflared
  };
}

const DNS_ACTION_TR = {
  created: "olusturuldu",
  unchanged: "zaten dogruydu",
  replaced: "uzerine yazildi"
};

const TUNNEL_ACTION_TR = {
  created: "olusturuldu",
  reused: "devralindi (mevcut tunnel yeniden yapilandirildi)",
  recreated: "silinip yeniden olusturuldu"
};

// Yarida kalan cf-api zinciri geride NE BIRAKTI?
//
// Otomatik geri alma (rollback) YAPMIYORUZ: kullanicinin hesabindaki
// kaynaklari silmek — hele devraldigimiz bir tunnel'i — geri alinamaz zarar
// verebilir. Bunun yerine ne olustugunu ve nereden temizlenecegini soyluyoruz.
function cfLeftoverReport(state, plan) {
  const items = [];
  if (state.tunnel) {
    items.push(
      `tunnel : ${state.tunnel.name} (${state.tunnel.id})` +
        (state.tunnelReused ? "  [mevcut tunnel devralindi — Lyra yaratmadi, silme]" : "")
    );
  }
  if (state.dnsWritten.length) items.push(`DNS    : ${state.dnsWritten.join(", ")}`);
  if (state.serviceInstalled) items.push("servis : cloudflared (bu sunucuda kuruldu ve calisiyor)");
  if (!items.length) return null;

  const acc = state.accountId || "<hesap-id>";
  const hints = [];
  if (state.tunnel && !state.tunnelReused) {
    hints.push(`Tunnel : https://one.dash.cloudflare.com/${acc}/networks/tunnels`);
  }
  if (state.dnsWritten.length) {
    hints.push(`DNS    : https://dash.cloudflare.com/${acc}/${plan.domain}/dns`);
  }
  if (state.serviceInstalled) hints.push("Sunucu : sudo cloudflared service uninstall");
  return { items, hints };
}

// Raporu iki arayuzun da ayni sekilde basabilecegi duz satirlara cevir.
function formatLeftovers(report) {
  if (!report || !report.items || !report.items.length) return [];
  const lines = ["Kurulum yarida kaldi. Su kaynaklar olustu:"];
  for (const item of report.items) lines.push(`    ${item}`);
  if (report.hints.length) {
    lines.push("Tekrar denemeden once temizlemek istersen:");
    for (const hint of report.hints) lines.push(`    ${hint}`);
  }
  return lines;
}

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
  if (!plan.tunnelName) throw new Error("Gecersiz tunnel adi (ornek: lyra-ornek-com)");

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

  // Ayni adda tunnel + bu sunucudaki mevcut cloudflared servisi. Ikisi de
  // KURULUM BASLAMADAN once gorulmeli: gercek dunyada bu iki cakisma yarida
  // kalmis kurulumlar ve hesapta olu tunnel'lar birakti.
  const existingTunnel = await cfApi.findTunnelByName(plan.token, account.id, plan.tunnelName);

  return {
    ok: true,
    account,
    accounts,
    zone,
    hosts,
    records,
    conflicts,
    tunnelName: plan.tunnelName,
    existingTunnel: existingTunnel
      ? { ...existingTunnel, hasConnections: cfApi.tunnelHasConnections(existingTunnel) }
      : null,
    cloudflaredService: cloudflared.detectService(),
    // Apex doluysa varsayilan oneri: apex kaydina hic dokunma, paneli
    // wildcard uzerinden alt alan adinda ac.
    recommendation: apexBlocked && !panelBlocked ? "subdomain" : "apex"
  };
}

// Ayni ADDA tunnel varsa ne yapilir?
//
// ESKI DAVRANIS (kaldirildi): rastgele son ekli bir KOPYA yaratmak. Gercek
// kullanimda bu, iki basarisiz denemede hesapta iki olu tunnel birakti
// (lyra-x-beb1, lyra-x-d2b8) ve kullanici sebebini goremedi.
//
// SIMDI:
//   - aktif baglantisi varsa  -> HER ZAMAN dur. Tunnel baska bir makinede
//     canli olabilir; devralmak o sistemi keser. Bu karar bayrakla
//     gecilemez, cunku zarari geri alinamaz.
//   - baglantisi yoksa        -> tunnelExisting'e bak:
//       reuse    : mevcut tunnel devralinir, ingress yeniden yazilir
//       recreate : silinip yeniden yaratilir
//       fail     : (varsayilan) durur, secenekleri soyler
async function resolveTunnel(plan, accountId, log) {
  const existing = await cfApi.findTunnelByName(plan.token, accountId, plan.tunnelName);
  if (!existing) {
    const created = await cfApi.createTunnel(plan.token, accountId, plan.tunnelName);
    return { tunnel: created, action: "created" };
  }

  if (cfApi.tunnelHasConnections(existing)) {
    throw new Error(
      `"${existing.name}" adinda bir tunnel zaten var ve AKTIF: ${existing.connections} baglanti ` +
        `(durum: ${existing.status || "bilinmiyor"}, id: ${existing.id}). Bu tunnel baska bir ` +
        "makinede calisiyor olabilir; devralmak o sistemin erisimini keser, o yuzden " +
        "otomatik devralmiyoruz. Once oradaki cloudflared'i durdur " +
        "(sudo cloudflared service uninstall), ya da --cf-tunnel-name <ad> ile farkli bir ad kullan."
    );
  }

  if (plan.tunnelExisting === "reuse") {
    log(`Mevcut tunnel devralindi: ${existing.name} (${existing.id})`);
    return { tunnel: existing, action: "reused" };
  }

  if (plan.tunnelExisting === "recreate") {
    log(`Mevcut tunnel siliniyor: ${existing.name} (${existing.id})`);
    await cfApi.deleteTunnel(plan.token, accountId, existing.id);
    const created = await cfApi.createTunnel(plan.token, accountId, plan.tunnelName);
    return { tunnel: created, action: "recreated" };
  }

  throw new Error(
    `"${existing.name}" adinda bir tunnel zaten var (id: ${existing.id}, aktif baglanti yok). ` +
      "Kopya tunnel uretmiyoruz; ne yapilacagi acikca secilmeli: " +
      "--cf-tunnel-existing reuse (mevcut tunnel'i devral, ingress'i yeniden yaz) | " +
      "--cf-tunnel-existing recreate (sil ve yeniden yarat) | " +
      "--cf-tunnel-name <ad> (farkli ad kullan)."
  );
}

// Mevcut cloudflared servisi kurulumu sessizce patlatmasin: tunnel
// YARATILMADAN once bakiyoruz, boylece "fail" durumunda hesapta hicbir sey
// birakmiyoruz.
function assertCloudflaredUsable(plan) {
  const svc = cloudflared.detectService();
  if (!svc.present) return null;
  if (plan.replaceCloudflared) return svc;
  throw new Error(
    `Bu sunucuda zaten bir cloudflared servisi var (${cloudflared.describeService(svc)}). ` +
      "Uzerine kurmak 'cloudflared service install' komutunu patlatir ve kurulum yarida kalir; " +
      "sessizce devralmiyoruz. Mevcut servisi degistirmek icin --replace-cloudflared ver " +
      "(kaldirilip yeni token ile yeniden kurulur), ya da once elle kaldir: " +
      "sudo cloudflared service uninstall"
  );
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

// ─────────── Kurulum ONCESI hazirlanmis Cloudflare kurulumu ───────────
//
// install.sh "Cloudflare domain'im var" secenegini secen kullanicida tunnel'i
// SIHIRBAZDAN ONCE kurar: boylece sihirbaz hicbir port acmadan
// https://<panel_host> uzerinden acilir. Bu bayrak iki sihirbaza da
// "Cloudflare adimi bitti, tekrar calistirma" der.
const CF_PROVISIONED_KEY = "cf_provisioned";

// Kurulum oncesi tunnel kurulmus mu? Kurulduysa domain/panel host bilgisi
// ayarlardan gelir — sihirbaz bunlari kullaniciya tekrar sormaz.
function cfProvisionedInfo() {
  try {
    if (!settings.get(CF_PROVISIONED_KEY)) return null;
    const domain = settings.get("base_domain");
    const panelHost = settings.get("panel_host");
    if (!domain || !panelHost) return null;
    return { domain, panelHost };
  } catch (_) {
    return null;
  }
}

function isCfProvisioned() {
  return !!cfProvisionedInfo();
}

// ─────────────────────────── Servis secimi ───────────────────────────
//
// Sihirbazin servis adimi TEK bir liste uzerinden calisir: kullanici neyi
// isaretlerse o servis panelde yonetilir. Isaretlenen servis kurulu degilse
// ve bu makinede kurulabiliyorsa Lyra onu KURAR (bkz. runPostSetup), sonra
// kaydeder. Kurulu olan tekrar kurulmaz — secim idempotent.

function normalizeSelection(selected) {
  return Array.isArray(selected) ? selected.map(String).filter(Boolean) : [];
}

// Secilenlerden hangileri gercekten kurulacak?
function servicesToInstall(selected, detected) {
  const list = detected || detect.detectAll();
  return normalizeSelection(selected).filter((type) => {
    const d = list.find((s) => s.type === type);
    return !!d && !d.installed && !!d.installable;
  });
}

// Servisi services tablosuna yaz (varsa guncelle). Hem kurulum oncesi
// (zaten kurulu servisler) hem kurulum sonrasi ayni yoldan gecer.
function registerService({ type, unit_name, display_name, port }) {
  const unit = unit_name || type;
  const row = { display_name, type, port: port === undefined ? null : port, enabled: 1 };
  const existing = services.getByUnit(unit);
  if (existing) {
    services.update(existing.id, row);
  } else {
    services.add({ unit_name: unit, subdomain: null, ...row });
  }
}

// ─────────────────────────── Dogrulama + seed ───────────────────────────

// Sihirbaz govdesini dogrula. Tarayici tarafinda 2FA dogrulamasi session'da,
// CLI tarafinda terminalde yapilir; sonucu totpVerified ile geliyor.
//
// cfProvisioned: Cloudflare kurulumu sihirbazdan ONCE (install.sh) yapildiysa
// cf-api modunda token/domain body'de gelmez — o alanlar burada da istenmez.
function validateFinalize(
  body,
  { totpVerified = false, cfProvisioned = isCfProvisioned(), detected = null } = {}
) {
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
  const cfPlan = body.accessMode === "cf-api" && !cfProvisioned ? cfPlanFromBody(body) : null;
  if (cfPlan) {
    if (!cfPlan.token) errors.push("Cloudflare API token gerekli");
    if (!cfPlan.domain) errors.push("Gecerli bir domain gerekli (ornek: example.com)");
    if (!cfPlan.panelSub) errors.push("Gecersiz alt alan adi (ornek: lyra)");
    if (!cfPlan.tunnelName) errors.push("Gecersiz tunnel adi (ornek: lyra-ornek-com)");
    // Sessizce varsayilana kacmiyoruz: gecersiz bir deger "fail"e dusup
    // kullaniciyi neden durdugunu anlamadan birakirdi.
    if (
      body.cfTunnelExisting !== undefined &&
      body.cfTunnelExisting !== null &&
      !TUNNEL_EXISTING_MODES.includes(body.cfTunnelExisting)
    ) {
      errors.push(
        `Bilinmeyen tunnel cakisma davranisi: ${body.cfTunnelExisting} ` +
          `(gecerli: ${TUNNEL_EXISTING_MODES.join(", ")})`
      );
    }
  }
  if (body.user && body.user.enable2FA && !totpVerified) {
    errors.push("2FA dogrulamasi tamamlanmali");
  }
  if (!appName) errors.push("Uygulama adi gerekli");
  if (!projectsDir) errors.push("Projeler dizini gerekli");

  // Servis secimi. Bos listede sistem hic yoklanmaz (testler ve "servis
  // istemiyorum" akisi bedava kalsin diye).
  if (body.services !== undefined && !Array.isArray(body.services)) {
    errors.push("services bir liste olmali");
  } else if (Array.isArray(body.services) && body.services.length) {
    const list = detected || detect.detectAll();
    for (const type of normalizeSelection(body.services)) {
      const d = list.find((s) => s.type === type);
      if (!d) {
        errors.push(`Bilinmeyen servis: ${type}`);
      } else if (!d.installed && !d.installable) {
        errors.push(
          `${d.display_name} bu sunucuda kurulamaz: ${d.install_reason || "sebep bilinmiyor"}`
        );
      }
    }
  }

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
function applyFinalize(body, { totpSecret = null, cfProvisioned = isCfProvisioned() } = {}) {
  const accessMode = body.accessMode;
  // Tunnel kurulum oncesi yapildiysa domain/panel host'un dogru kaynagi
  // ayarlardir; sihirbaz bunlari tekrar sormadigi icin body'de yoktur.
  const cfDone = accessMode === "cf-api" && cfProvisioned ? cfProvisionedInfo() : null;
  const cfPlan = accessMode === "cf-api" && !cfDone ? cfPlanFromBody(body) : null;
  const appName = String(body.appName || "").trim();
  const projectsDir = String(body.projectsDir || "").trim();

  // bind_address mapping. cf-api dahil tunnel modlarinda Lyra loopback'te
  // kalir; baglanti cloudflared uzerinden localhost'a gelir.
  const bindAddress = accessMode === "lan" ? "0.0.0.0" : "127.0.0.1";
  const publicAccess =
    accessMode === "public" || accessMode === "cf-tunnel" || accessMode === "cf-api";

  // cf-api'de domain normalize edilmis haliyle yazilir; panel_host apex ya da
  // secilen alt alan adidir (wildcard ingress ikisini de karsilar).
  const baseDomain = cfDone ? cfDone.domain : cfPlan ? cfPlan.domain : body.domain;
  const panelHost = cfDone ? cfDone.panelHost : cfPlan ? cfPlan.panelHost : body.domain || null;

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

  // 3. Servisler. Zaten kurulu olanlar HEMEN kaydedilir; kurulacak olanlar
  //    kurulum adiminda basarili olduklarinda kaydedilir (bkz. runPostSetup) —
  //    kurulmamis bir servisi "yonetiliyor" diye yazmak yalan olurdu.
  const selected = normalizeSelection(body.services);
  const pendingInstall = [];
  if (selected.length) {
    const detected = detect.detectAll();
    for (const type of selected) {
      const s = detected.find((d) => d.type === type);
      if (!s) continue;
      if (!s.installed && s.installable) {
        pendingInstall.push(type);
        continue;
      }
      if (!s.installed) continue;
      registerService({
        type: s.type,
        unit_name: s.unit_name,
        display_name: s.display_name,
        port: s.default_port
      });
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
  // Kurulacak servislerin portlari da simdiden sistem portu sayilir: aksi
  // halde kurulumdan sonra code-server "dev portu" gorunup panelden
  // oldurulebilirdi.
  const pendingPorts = pendingInstall
    .map((type) => {
      const svc = installer.get(type);
      return svc ? svc.default_port : null;
    })
    .filter(Boolean);
  settings.setMany({
    system_ports: [
      ...new Set([...DEFAULT_SYSTEM_PORTS, config.PORT, ...registeredPorts, ...pendingPorts])
    ],
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
    finalUrl: deriveFinalUrl(accessMode, panelHost),
    // Kurulum sonrasi adimlara verilecek liste (buildSteps + runPostSetup
    // AYNI listeyi almali, yoksa adim anahtarlari tutmaz).
    installServices: pendingInstall
  };
}

// ─────────────────────────── Post-setup ilerleme ───────────────────────────

// mode "cf-provision": install.sh'in sihirbazdan ONCE calistirdigi Cloudflare
// kurulumu. Kurulum sonrasi adimlari (firewall/mod degisimi/restart) icermez —
// onlar sihirbaz bitince calisir.
//
// cfProvisioned: cf-api modunda Cloudflare adimlari kurulum oncesinde
// tamamlandiysa listeye hic girmez (tekrar calistirilmaz).
//
// installServices: sihirbazda secilen ve kurulmasi gereken servisler. Her biri
// AYRI bir adim olur (service-install:code-server gibi); biri patlarsa
// digerleri ve kurulumun geri kalani devam eder.
function buildSteps(mode, { cfProvisioned = false, installServices = [] } = {}) {
  const steps = [];
  const serviceSteps = () => {
    for (const type of installServices) {
      const svc = installer.get(type);
      steps.push({
        key: `service-install:${type}`,
        label: `${svc ? svc.display_name : type} kuruluyor`
      });
    }
  };
  const cfApiSteps = () => {
    steps.push({ key: "cf-verify", label: "Cloudflare token ve domain dogrulaniyor" });
    steps.push({ key: "cf-tunnel", label: "Tunnel olusturuluyor" });
    steps.push({ key: "cf-ingress", label: "Tunnel yonlendirmesi (ingress) yaziliyor" });
    steps.push({ key: "cf-dns", label: "DNS kayitlari olusturuluyor" });
    steps.push({ key: "cloudflared-install", label: "cloudflared kuruluyor" });
    steps.push({ key: "cloudflared-service", label: "Tunnel servisi baslatiliyor" });
  };

  if (mode === "cf-provision") {
    cfApiSteps();
    return steps.map((s) => ({ ...s, status: "pending", error: null, note: null }));
  }

  // SIRA ONEMLI: servisler erisim katmanindan ONCE kurulur. Caddyfile
  // subdomain bloklarini KAYITLI servislerden uretiyor (caddy.knownSubdomains);
  // servisler sonra kurulsaydi yeni kurulanlarin subdomain'i Caddyfile'a
  // hic girmezdi.
  serviceSteps();
  if (mode === "public") {
    steps.push({ key: "caddy-install", label: "Caddy kuruluyor" });
    steps.push({ key: "caddy-config", label: "Caddyfile yaziliyor, sertifika isteniyor" });
  } else if (mode === "cf-api") {
    if (!cfProvisioned) cfApiSteps();
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
    steps: [],
    // Yarida kalan Cloudflare zincirinin geride biraktiklari (bkz.
    // cfLeftoverReport). null = geride bir sey yok.
    leftovers: null
  };

  const notify = (step) => {
    if (onUpdate) onUpdate(step, p);
  };

  p.start = (mode, finalUrl, opts = {}) => {
    p.active = true;
    p.finished = false;
    p.restarting = false;
    p.startedAt = Date.now();
    p.finishedAt = null;
    p.finalUrl = finalUrl || null;
    p.steps = buildSteps(mode, opts);
    p.leftovers = null;
    return p;
  };

  p.step = (key) => p.steps.find((s) => s.key === key) || null;

  p.setLeftovers = (report) => {
    p.leftovers = report && report.items && report.items.length ? report : null;
    return p.leftovers;
  };

  p.payload = () => ({
    active: p.active,
    finished: p.finished,
    restarting: p.restarting,
    failed: p.steps.some((s) => s.status === "failed"),
    finalUrl: p.finalUrl,
    leftovers: p.leftovers,
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
    connectorToken: null,
    // Geride ne birakildiginin kaydi (bkz. cfLeftoverReport). Otomatik geri
    // alma YOK; kullaniciya durustce ne olustugu soylenir.
    tunnel: null,
    tunnelReused: false,
    dnsWritten: [],
    serviceInstalled: false
  };
  let ok;

  ok = await progress.runStep("cf-verify", async () => {
    // SIRA ONEMLI: yerel cloudflared cakismasi Cloudflare'de HICBIR SEY
    // yaratilmadan once yakalanmali.
    const replacing = assertCloudflaredUsable(plan);
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
    const parts = [`Hesap: ${account.name || account.id}`, `Zone: ${zone.name} (${zone.status})`];
    if (replacing) parts.push("mevcut cloudflared servisi degistirilecek");
    const note = parts.join(" · ");
    return zone.status === "active"
      ? note
      : `${note} — zone aktif degil, nameserver yayilmasi tamamlanana kadar adres calismayabilir`;
  });

  if (ok) {
    ok = await progress.runStep("cf-tunnel", async () => {
      const { tunnel, action } = await resolveTunnel(plan, state.accountId, log);
      state.tunnelId = tunnel.id;
      state.tunnel = { id: tunnel.id, name: tunnel.name };
      state.tunnelReused = action === "reused";
      state.connectorToken = await cfApi.getTunnelToken(plan.token, state.accountId, tunnel.id);
      saveCfIntegration({ tunnelId: tunnel.id, tunnelName: tunnel.name });
      log(`Tunnel ${TUNNEL_ACTION_TR[action]}: ${tunnel.name} (${tunnel.id})`);
      return `${tunnel.name} · ${tunnel.id} · ${TUNNEL_ACTION_TR[action]}`;
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
        if (r.action !== "unchanged") state.dnsWritten.push(shown);
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
      const r = await cloudflared.installService({
        token: state.connectorToken,
        onLog: log,
        replace: plan.replaceCloudflared
      });
      if (!r.ok) throw new Error(r.error || "cloudflared servisi olusturulamadi");
      state.serviceInstalled = true;
      return `Panel adresi: https://${plan.panelHost}`;
    });
  }

  // Zincir yarida kaldiysa: geride ne kaldigini SOYLE. Otomatik geri alma yok
  // (bkz. cfLeftoverReport).
  if (!ok) {
    const report = cfLeftoverReport(state, plan);
    if (report) {
      progress.setLeftovers(report);
      for (const line of formatLeftovers(report)) log(line);
    }
  }

  return ok;
}

// Cloudflare kurulumunu SIHIRBAZDAN ONCE calistir (install.sh secenek 1).
//
// Sihirbazin cf-api adimlariyla ayni zincir kullanilir (runCfApiSteps) — burada
// kopya yok. Fark: kurulum sonrasi adimlar (firewall, mod degisimi, restart)
// calismaz, cunku sihirbaz daha baslamadi.
//
// Basarili olursa ayarlar seed edilir ve cf_provisioned bayragi yazilir;
// sihirbaz bu bayragi gorup erisim modu adimini atlar.
async function provisionCloudflare(body, { log, onUpdate } = {}) {
  const emit = log || (() => {});
  const plan = cfPlanFromBody(body);
  if (!plan.token) throw new Error("Cloudflare API token gerekli");
  if (!plan.domain) throw new Error("Gecerli bir domain gerekli (ornek: example.com)");
  if (!plan.panelSub) throw new Error("Gecersiz alt alan adi (ornek: lyra)");

  const progress = createProgress({ onUpdate });
  progress.start("cf-provision", `https://${plan.panelHost}`);

  const ok = await runCfApiSteps(body, progress, emit);
  progress.finish();
  if (!ok) return { ok: false, progress };

  settings.setMany({
    access_mode: "cf-api",
    base_domain: plan.domain,
    panel_host: plan.panelHost,
    public_access: true,
    // Baglanti cloudflared uzerinden localhost'a gelir; disari acilan port yok.
    bind_address: "127.0.0.1",
    [CF_PROVISIONED_KEY]: true
  });

  return { ok: true, progress, panelHost: plan.panelHost, finalUrl: `https://${plan.panelHost}` };
}

// Secilen servisleri kur. Her servis AYRI bir adim.
//
// BIRI PATLARSA DIGERLERI DEVAM EDER: donguden cikilmaz, hata yalnizca kendi
// adiminda "failed" olarak durur. Kurulumun geri kalani (firewall / kurulum
// modundan cikis / restart) da etkilenmez — bir servis yuzunden panel
// kurulumu cokmez.
//
// Yalnizca BASARILI kurulum services tablosuna yazilir; kurulmamis bir
// servisi "yonetiliyor" diye kaydetmek yalan olurdu.
async function runServiceInstalls(installServices, progress, { log, user, home } = {}) {
  const emit = log || (() => {});
  const who = user && home ? { user, home } : systemUserInfo();
  const results = [];
  for (const type of installServices) {
    const stepOk = await progress.runStep(`service-install:${type}`, async () => {
      const r = await installer.install(type, { onLog: emit, user: who.user, home: who.home });
      if (!r.ok) throw new Error(r.error || "Kurulum basarisiz");
      registerService({
        type,
        unit_name: r.unit_name,
        display_name: r.display_name,
        port: r.port
      });
      return `${r.unit_name} · ${installer.LOOPBACK}:${r.port}`;
    });
    results.push({ type, ok: stepOk });
  }
  return results;
}

// Kurulum sonrasi zincir.
//
// transition:
//   "self"   — sihirbazi Lyra'nin KENDISI calistiriyor (tarayici modu).
//              "systemctl restart lyra" bizi oldurur, o yuzden gecisi
//              systemd-run ile bagimsiz bir transient unit'e devrediyoruz.
//   "direct" — sihirbaz ayri bir process (CLI). Gecisi kendimiz yapabiliriz;
//              restart'i bekler ve sonucu dogrulariz.
async function runPostSetup(
  mode,
  body,
  progress,
  { log, transition = "self", cfProvisioned = isCfProvisioned(), installServices = [] } = {}
) {
  const emit = log || ((m) => console.log(`[setup-post] ${m}`));
  let ok = true;

  // Servisler ONCE kurulur: Caddyfile'in subdomain bloklari kayitli
  // servislerden uretiliyor (bkz. buildSteps'teki ayni not).
  if (installServices.length) {
    await runServiceInstalls(installServices, progress, { log: emit });
  }

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
    // Tunnel install.sh tarafindan kurulduysa adimlar listede yok; tekrar
    // calistirmak ikinci bir tunnel acar ve DNS'i bozardi.
    if (cfProvisioned) {
      emit("Cloudflare kurulumu kurulum oncesinde tamamlanmis — adimlar atlandi.");
    } else {
      ok = await runCfApiSteps(body, progress, emit);
    }
  } else if (mode === "cf-tunnel") {
    ok = await progress.runStep("cloudflared-install", async () => {
      const r = await cloudflared.install({ onLog: emit });
      if (!r.ok) throw new Error(r.error || "cloudflared kurulamadi");
      return r.alreadyInstalled ? "Zaten kuruluydu" : null;
    });
    if (ok) {
      ok = await progress.runStep("cloudflared-service", async () => {
        // Elle verilen connector token'da da ayni kural: mevcut servis
        // sessizce devralinmaz (bkz. cloudflared-installer.installService).
        const r = await cloudflared.installService({
          token: body.cfToken,
          onLog: emit,
          replace: !!body.cfReplaceCloudflared
        });
        if (!r.ok) throw new Error(r.error || "cloudflared servisi olusturulamadi");
        return r.replacedService ? "Mevcut cloudflared servisi degistirildi" : null;
      });
    }
  }

  if (ok) {
    ok = await progress.runStep("firewall", async () => {
      // Tunnel modunda ayri bir kurulum portu hic acilmadi (sihirbaz Lyra'nin
      // kendi portunda calisti) — kapatilacak kural da yok.
      const closed = HAS_SEPARATE_SETUP_PORT
        ? firewall.closeSetupPort(SETUP_PORT, { onLog: emit })
        : { applied: false, reason: "ayri-kurulum-portu-yok" };
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
  HAS_SEPARATE_SETUP_PORT,
  ACCESS_MODES,
  DEFAULT_PANEL_SUBDOMAIN,
  TUNNEL_EXISTING_MODES,
  CF_PROVISIONED_KEY,
  cfProvisionedInfo,
  isCfProvisioned,
  provisionCloudflare,
  homeOfUser,
  systemUserInfo,
  ensureProjectsDir,
  normalizePanelSub,
  normalizeTunnelName,
  defaultTunnelName,
  cfPlanFromBody,
  cfPreflight,
  resolveTunnel,
  assertCloudflaredUsable,
  cfLeftoverReport,
  formatLeftovers,
  validateFinalize,
  applyFinalize,
  servicesToInstall,
  registerService,
  runServiceInstalls,
  deriveFinalUrl,
  buildSteps,
  createProgress,
  runPostSetup,
  cleanupSetupPrivileges,
  systemdUnitExists,
  systemdUnitActive
};
