// Lyra terminal kurulum sihirbazi (headless kurulum).
//
// Tarayici sihirbazinin sordugu her seyi terminalde sorar ve AYNI cekirdegi
// kullanir: dogrulama, Cloudflare on-kontrolu, DB seed'i ve kurulum sonrasi
// adimlar lib/setup-core.js'te tanimli (bkz. routes/setup.js). Burada sadece
// sorularin nasil soruldugu ve ciktinin nasil basildigi var.
//
// Iki mod:
//   interaktif      : node scripts/setup-cli.js
//                     npm run setup -- --cli
//   non-interactive : node scripts/setup-cli.js --yes --mode ... (Ansible vb.)
//
// Non-interactive modda eksik zorunlu alan varsa kurulum BASLAMAZ; hangi
// bayragin eksik oldugu tek tek yazilir. Sessizce varsayilana kacilmaz.
//
// Ucuncu bir giris noktasi daha var:
//   node scripts/setup-cli.js --provision-tunnel
// install.sh bunu "Cloudflare domain'im var" secildiginde SIHIRBAZDAN ONCE
// calistirir: token/zone dogrulanir, tunnel + ingress + DNS kurulur,
// cloudflared servis olur. Sonrasinda sihirbaz (tarayici ya da terminal)
// https://<panel-host> uzerinden acilir ve Cloudflare adimini tekrar sormaz.
// Kullanilan zincir sihirbazinkiyle AYNI (lib/setup-core.js).

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

// ─────────────────────────── Cikti yardimcilari ───────────────────────────

const TTY = process.stdout.isTTY;
const ESC = String.fromCharCode(27);
const paint = (code, s) => (TTY ? `${ESC}[${code}m${s}${ESC}[0m` : String(s));
const cyan = (s) => paint("1;36", s);
const green = (s) => paint("0;32", s);
const red = (s) => paint("0;31", s);
const yellow = (s) => paint("0;33", s);
const dim = (s) => paint("2", s);

const ok = (s) => console.log(`${green("✓")} ${s}`);
const warn = (s) => console.log(`${yellow("!")} ${s}`);
const info = (s) => console.log(`${dim("-")} ${s}`);
const head = (s) => console.log(`\n${cyan("▸ " + s)}`);

function die(msg, lines = []) {
  console.error(`\n${red("✗")} ${msg}`);
  for (const l of lines) console.error(`    ${l}`);
  console.error("");
  process.exit(1);
}

// ─────────────────────────── Arguman ayristirma ───────────────────────────

const VALUE_OPTS = {
  "--mode": "mode",
  "--domain": "domain",
  "--email": "email",
  "--cf-token": "cfToken",
  "--cf-api-token": "cfApiToken",
  // Token'i argv'de tasimamak icin tercih edilen yol: 0600 bir dosyanin YOLU.
  "--cf-api-token-file": "cfApiTokenFile",
  "--cf-account-id": "cfAccountId",
  "--cf-host-mode": "cfHostMode",
  "--cf-panel-subdomain": "cfPanelSubdomain",
  "--user": "username",
  "--password": "password",
  "--projects-dir": "projectsDir",
  "--app-name": "appName",
  "--services": "services",
  "--telegram-token": "telegramToken",
  "--telegram-chat-id": "telegramChatId",
  "--github-token": "githubToken"
};

const BOOL_OPTS = {
  "--provision-tunnel": "provisionTunnel",
  "--cf-overwrite-dns": "cfOverwriteDns",
  "--2fa": "want2fa",
  "--no-2fa": "no2fa",
  "--no-services": "noServices",
  "--yes": "yes",
  "-y": "yes",
  "--non-interactive": "yes",
  // "npm run setup -- --cli" bu bayragi buraya kadar tasiyor; yok sayilir.
  "--cli": "cli",
  "--help": "help",
  "-h": "help"
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (BOOL_OPTS[a]) {
      out[BOOL_OPTS[a]] = true;
      continue;
    }
    if (VALUE_OPTS[a]) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) {
        die(`${a} bir deger bekliyor.`, ["Yardim: node scripts/setup-cli.js --help"]);
      }
      out[VALUE_OPTS[a]] = v;
      i++;
      continue;
    }
    // "--opt=deger" bicimi
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq > 2 && VALUE_OPTS[a.slice(0, eq)]) {
      out[VALUE_OPTS[a.slice(0, eq)]] = a.slice(eq + 1);
      continue;
    }
    die(`Bilinmeyen secenek: ${a}`, ["Yardim: node scripts/setup-cli.js --help"]);
  }
  return out;
}

function usage() {
  console.log(`
Lyra terminal kurulum sihirbazi

Kullanim:
  node scripts/setup-cli.js                 interaktif sihirbaz
  npm run setup -- --cli                    ayni sey
  node scripts/setup-cli.js --yes [...]     tam non-interactive (otomasyon)
  node scripts/setup-cli.js --provision-tunnel
                                            SADECE Cloudflare tunnel'i kur
                                            (install.sh sihirbazdan once cagirir)

Erisim modu (zorunlu, non-interactive):
  --mode <public|lan|localhost|cf-tunnel|cf-api|manual>

Moda ozel:
  --domain <alan.adi>            public, cf-api
  --email <adres>                public (Let's Encrypt bildirimi)
  --cf-token <token>             cf-tunnel connector token'i
  --cf-api-token <token>         cf-api API token'i
                                 (LYRA_CF_API_TOKEN env'i ya da
                                  --cf-api-token-file tercih edilir — komut
                                  satiri "ps" ciktisinda gorunur)
  --cf-api-token-file <yol>      token'i 0600 bir dosyadan oku
  --cf-account-id <id>           cf-api (token birden fazla hesaba erisiyorsa)
  --cf-host-mode <apex|subdomain>  panel apex'te mi alt alan adinda mi (varsayilan: apex)
  --cf-panel-subdomain <ad>      subdomain modunda panel adi (varsayilan: lyra)
  --cf-overwrite-dns             cakisan DNS kayitlarinin uzerine yaz

Panel:
  --app-name <ad>                panel basligi
  --projects-dir <mutlak/yol>    projelerin duracagi dizin

Yonetici hesabi:
  --user <kullanici>
  --password <sifre>             en az 12 karakter
                                 (LYRA_ADMIN_PASSWORD env'i tercih edilir —
                                  komut satiri "ps" ciktisinda gorunur)
  --2fa | --no-2fa               non-interactive modda biri ZORUNLU

Opsiyonel:
  --services <tip,tip>           kaydedilecek servisler (ornek: code-server,mongod)
  --no-services                  hicbir servis kaydetme
  --telegram-token <token>       Telegram bot token'i
  --telegram-chat-id <id>        Telegram sahibi chat id'si
  --github-token <token>         GitHub personal access token

Diger:
  -y, --yes, --non-interactive   hicbir sey sorma
  -h, --help                     bu yardim

Ornek (tam non-interactive):
  sudo -u lyra node scripts/setup-cli.js --yes \\
    --mode cf-api --domain ornek.com --cf-api-token "$CF_TOKEN" \\
    --app-name Lyra --projects-dir /home/lyra/projects \\
    --user admin --no-2fa
  # sifre: LYRA_ADMIN_PASSWORD env'i ile verilir
`);
}

// ─────────────────────────── Ortak yardimcilar ───────────────────────────

const args = parseArgs(process.argv.slice(2));

// --help'i agir modullerden ONCE karsiliyoruz: db/index.js require edildigi an
// LYRA_HOME dizinini yaratir. "setup-cli.js --help" root olarak calistirildiginda
// /var/lib/lyra'yi root'a ait olarak yaratmasi kurulumu bozardi.
if (args.help) {
  usage();
  process.exit(0);
}

const prompts = require("prompts");

const { migrate } = require("../db/migrate");
const { users } = require("../db/repos");
const auth = require("../lib/auth");
const detect = require("../lib/service-detect");
const dnsCheck = require("../lib/dns-check");
const config = require("../lib/config");
const core = require("../lib/setup-core");

const onCancel = () => {
  console.error("\nIptal edildi. Hicbir sey yazilmadi.");
  process.exit(130);
};

const ask = (questions) => prompts(questions, { onCancel });

function password(fromArgs) {
  const env = process.env.LYRA_ADMIN_PASSWORD;
  if (env) return env;
  if (fromArgs) {
    warn(
      '--password komut satirindan verildi; "ps" ciktisinda gorunur. ' +
        "LYRA_ADMIN_PASSWORD env'i daha guvenli."
    );
    return fromArgs;
  }
  return null;
}

// Cloudflare API token'i: dosya > env > bayrak. Bayrak "ps" ciktisinda
// gorunur, o yuzden uyariyla kabul edilir (bkz. password()).
function cfApiToken() {
  if (args.cfApiTokenFile) {
    try {
      const t = require("fs").readFileSync(args.cfApiTokenFile, "utf8").trim();
      if (t) return t;
      die(`Cloudflare API token dosyasi bos: ${args.cfApiTokenFile}`);
    } catch (err) {
      die(`Cloudflare API token dosyasi okunamadi (${args.cfApiTokenFile}): ${err.message}`);
    }
  }
  const env = process.env.LYRA_CF_API_TOKEN;
  if (env && env.trim()) return env.trim();
  if (args.cfApiToken) {
    warn(
      '--cf-api-token komut satirindan verildi; "ps" ciktisinda gorunur. ' +
        "LYRA_CF_API_TOKEN env'i ya da --cf-api-token-file daha guvenli."
    );
    return args.cfApiToken.trim();
  }
  return null;
}

function parseServiceList(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ─────────────────────────── Non-interactive akis ───────────────────────────

function buildBodyNonInteractive() {
  const missing = [];
  const need = (cond, msg) => {
    if (!cond) missing.push(msg);
  };

  const mode = args.mode || null;
  need(mode, "--mode <public|lan|localhost|cf-tunnel|cf-api|manual>");
  if (mode && !core.ACCESS_MODES.includes(mode)) {
    die(`Bilinmeyen erisim modu: ${mode}`, [`Gecerli modlar: ${core.ACCESS_MODES.join(", ")}`]);
  }

  if (mode === "public") {
    need(args.domain, "--domain <alan.adi>            (public modu icin)");
    need(args.email, "--email <adres>                (public modu icin)");
  }
  if (mode === "cf-tunnel") {
    need(args.cfToken, "--cf-token <connector-token>   (cf-tunnel modu icin)");
  }
  const cfToken = mode === "cf-api" ? cfApiToken() : null;
  if (mode === "cf-api") {
    need(cfToken, "--cf-api-token <token>  ya da LYRA_CF_API_TOKEN env'i");
    need(args.domain, "--domain <alan.adi>            (cf-api modu icin)");
  }

  need(args.appName, "--app-name <ad>");
  need(args.projectsDir, "--projects-dir <mutlak/yol>");
  need(args.username, "--user <kullanici>");

  const pass = password(args.password);
  need(pass, "--password <sifre>  ya da LYRA_ADMIN_PASSWORD env'i");

  if (!args.want2fa && !args.no2fa) {
    missing.push("--2fa ya da --no-2fa  (varsayilana kacmiyoruz, acikca sec)");
  }
  if (args.want2fa && args.no2fa) {
    die("--2fa ve --no-2fa birlikte verilemez.");
  }

  if (missing.length) {
    die(
      "Non-interactive kurulum icin eksik zorunlu alanlar var:",
      missing.concat(["", "Tam liste: node scripts/setup-cli.js --help"])
    );
  }

  const services = args.noServices ? [] : parseServiceList(args.services);
  if (!args.noServices && !args.services) {
    info("Servis kaydi yapilmayacak (--services ile ekleyebilirsin).");
  }

  const integrations = {};
  if (args.telegramToken || args.telegramChatId) {
    if (!args.telegramToken || !args.telegramChatId) {
      die("Telegram icin --telegram-token ve --telegram-chat-id birlikte verilmeli.");
    }
    integrations.telegram = { botToken: args.telegramToken, ownerChatId: args.telegramChatId };
  }
  if (args.githubToken) integrations.github = { token: args.githubToken };

  return {
    accessMode: mode,
    domain: args.domain || null,
    email: args.email || null,
    cfToken: args.cfToken || null,
    cfApiToken: cfToken,
    cfAccountId: args.cfAccountId || null,
    cfHostMode: args.cfHostMode === "subdomain" ? "subdomain" : "apex",
    cfPanelSubdomain: args.cfPanelSubdomain || null,
    cfOverwriteDns: !!args.cfOverwriteDns,
    appName: args.appName,
    projectsDir: args.projectsDir,
    user: { username: args.username, password: pass, enable2FA: !!args.want2fa },
    services,
    integrations
  };
}

// Non-interactive + 2FA: kodu dogrulatacak kimse yok. Secret'i uretip ekrana
// basiyoruz; kaybedilirse kurtarma yolu reset-admin.
function nonInteractiveTotp(username) {
  const t = auth.generateTotp(username);
  console.log("");
  console.log(yellow("  ┌─ 2FA (TOTP) ───────────────────────────────────────────"));
  console.log(yellow("  │ ") + "Bu secret'i SIMDI authenticator uygulamana ekle.");
  console.log(yellow("  │ ") + "Kaybedersen paneldeki tek yolun kalmaz; sunucuda:");
  console.log(yellow("  │ ") + dim("  lyra reset-admin --disable-2fa"));
  console.log(yellow("  │"));
  console.log(yellow("  │ ") + "secret : " + cyan(t.secret));
  console.log(yellow("  │ ") + "otpauth: " + cyan(t.otpauth));
  console.log(yellow("  └────────────────────────────────────────────────────────"));
  console.log("");
  return t.secret;
}

// ─────────────────────────── Interaktif akis ───────────────────────────

async function askAccessMode() {
  head("Erisim modu");
  const { mode } = await ask({
    type: "select",
    name: "mode",
    message: "Lyra'ya nereden erisilecek?",
    choices: [
      { title: "Public — kendi domain'in, Caddy ile otomatik HTTPS", value: "public" },
      {
        title: "Cloudflare (otomatik) — API token ver, tunnel + DNS'i Lyra kursun",
        value: "cf-api"
      },
      {
        title: "Cloudflare Tunnel (elle) — dashboard'dan aldigin connector token",
        value: "cf-tunnel"
      },
      { title: "LAN — yerel agdaki makineler erisir", value: "lan" },
      { title: "Localhost — sadece SSH tunnel ile (en kapali)", value: "localhost" },
      { title: "Manuel — reverse proxy'yi kendim yonetecegim", value: "manual" }
    ],
    initial: 0
  });
  return mode;
}

async function askPublic(body) {
  const a = await ask([
    {
      type: "text",
      name: "domain",
      message: "Domain (ornek: ornek.com)",
      validate: (v) =>
        /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(String(v).trim()) ? true : "Gecerli bir domain yaz"
    },
    {
      type: "text",
      name: "email",
      message: "Let's Encrypt bildirim e-postasi",
      validate: (v) => (String(v).includes("@") ? true : "Gecerli bir e-posta yaz")
    }
  ]);
  body.domain = a.domain.trim();
  body.email = a.email.trim();

  info("DNS kontrol ediliyor...");
  try {
    const r = await dnsCheck.checkAll(
      body.domain,
      [
        config.get("subdomain_code"),
        config.get("subdomain_files"),
        config.get("subdomain_db")
      ].filter(Boolean)
    );
    if (r.apex && r.apex.ok) {
      ok(`${body.domain} bu sunucuyu gosteriyor (${(r.apex.resolvedV4 || []).join(", ") || "?"})`);
    } else {
      warn(`${body.domain}: ${(r.apex && r.apex.message) || "DNS dogrulanamadi"}`);
      warn("DNS hazir degilse Caddy sertifika alamaz.");
      const { go } = await ask({
        type: "confirm",
        name: "go",
        message: "Yine de devam edilsin mi?",
        initial: false
      });
      if (!go) die("DNS hazir olunca tekrar calistir.");
    }
  } catch (err) {
    warn(`DNS kontrolu yapilamadi: ${err.message}`);
  }
}

async function askCfTunnel(body) {
  const a = await ask({
    type: "password",
    name: "cfToken",
    message: "Cloudflare connector token'i (dashboard > Zero Trust > Tunnels)",
    validate: (v) => (String(v).trim().length >= 50 ? true : "Token cok kisa gorunuyor")
  });
  body.cfToken = a.cfToken.trim();
}

// preset: install.sh token/domain'i onceden vermis olabilir (dosya/env/bayrak).
// Verilmeyen alan sorulur; geri kalan akis (preflight, hesap secimi, apex
// cakismasi, uzerine yazma onayi) her iki yolda da AYNIDIR.
async function askCfApi(body, preset = {}) {
  const questions = [];
  if (!preset.token) {
    questions.push({
      type: "password",
      name: "cfApiToken",
      message: "Cloudflare API token'i (Zone:DNS:Edit + Account:Tunnel:Edit)",
      validate: (v) => (String(v).trim() ? true : "Token gerekli")
    });
  }
  if (!preset.domain) {
    questions.push({
      type: "text",
      name: "domain",
      message: "Domain (Cloudflare'da kayitli zone)",
      validate: (v) => (String(v).trim() ? true : "Domain gerekli")
    });
  }
  const a = questions.length ? await ask(questions) : {};
  body.cfApiToken = preset.token || a.cfApiToken.trim();
  body.domain = preset.domain || a.domain.trim();
  if (preset.accountId) body.cfAccountId = preset.accountId;
  body.cfHostMode = "apex";
  body.cfPanelSubdomain = core.DEFAULT_PANEL_SUBDOMAIN;

  info("Cloudflare token'i, zone ve mevcut DNS kayitlari kontrol ediliyor...");
  let pre;
  try {
    pre = await core.cfPreflight(core.cfPlanFromBody(body));
  } catch (err) {
    die(`Cloudflare on-kontrolu basarisiz: ${err.message}`);
  }

  if (pre.needsAccountChoice) {
    const { accountId } = await ask({
      type: "select",
      name: "accountId",
      message: "Token birden fazla hesaba erisiyor — hangisi?",
      choices: pre.accounts.map((acc) => ({ title: `${acc.name || acc.id}`, value: acc.id }))
    });
    body.cfAccountId = accountId;
    try {
      pre = await core.cfPreflight(core.cfPlanFromBody(body));
    } catch (err) {
      die(`Cloudflare on-kontrolu basarisiz: ${err.message}`);
    }
  }

  ok(`Hesap: ${pre.account.name || pre.account.id} · Zone: ${pre.zone.name} (${pre.zone.status})`);
  if (pre.zone.status !== "active") {
    warn("Zone aktif degil — nameserver yayilmasi bitene kadar adres calismayabilir.");
  }

  if (pre.conflicts.length) {
    warn("Bu hostlarda zaten DNS kaydi var:");
    for (const c of pre.conflicts) {
      for (const r of c.records) {
        console.log(`    ${c.host}  ${r.type}  ${r.content}`);
      }
    }
  }

  const { hostMode } = await ask({
    type: "select",
    name: "hostMode",
    message: "Panel hangi adreste dursun?",
    choices: [
      { title: `Apex — https://${pre.zone.name}`, value: "apex" },
      {
        title: `Alt alan adi — https://<ad>.${pre.zone.name} (apex kaydina dokunmaz)`,
        value: "subdomain"
      }
    ],
    initial: pre.recommendation === "subdomain" ? 1 : 0
  });
  body.cfHostMode = hostMode;

  if (hostMode === "subdomain") {
    const { sub } = await ask({
      type: "text",
      name: "sub",
      message: "Panel alt alan adi",
      initial: core.DEFAULT_PANEL_SUBDOMAIN,
      validate: (v) => (core.normalizePanelSub(v) ? true : "Gecersiz alt alan adi (ornek: lyra)")
    });
    body.cfPanelSubdomain = core.normalizePanelSub(sub);
  }

  const plan = core.cfPlanFromBody(body);
  const blocking = pre.conflicts.filter(
    (c) => c.host === plan.panelHost || c.host === `*.${plan.domain}`
  );
  if (blocking.length) {
    const { overwrite } = await ask({
      type: "confirm",
      name: "overwrite",
      message: `Kullanilacak host(lar)da kayit var (${blocking.map((c) => c.host).join(", ")}). Uzerine yazilsin mi?`,
      initial: false
    });
    if (!overwrite) {
      die("DNS cakismasi cozulmedi.", [
        "Cloudflare'da kaydi sil ya da baska bir alt alan adi sec, sonra tekrar calistir."
      ]);
    }
    body.cfOverwriteDns = true;
  }
}

async function askPanel(body) {
  head("Panel");
  const sys = core.systemUserInfo();
  info(`Lyra "${sys.user}" kullanicisi olarak calisiyor.`);
  const a = await ask([
    { type: "text", name: "appName", message: "Uygulama adi", initial: "Andromeda" },
    {
      type: "text",
      name: "projectsDir",
      message: "Projeler dizini",
      initial: sys.suggestedProjectsDir,
      validate: (v) => (String(v).trim().startsWith("/") ? true : "Mutlak bir yol olmali")
    }
  ]);
  body.appName = a.appName.trim();
  body.projectsDir = a.projectsDir.trim();
}

async function askAdmin(body) {
  head("Yonetici hesabi");
  const a = await ask([
    {
      type: "text",
      name: "username",
      message: "Kullanici adi",
      initial: "admin",
      validate: (v) => (String(v).trim().length >= 3 ? true : "En az 3 karakter")
    },
    {
      type: "password",
      name: "p1",
      message: "Sifre (en az 12 karakter)",
      validate: (v) => (String(v).length >= 12 ? true : "En az 12 karakter")
    },
    { type: "password", name: "p2", message: "Sifre tekrari" }
  ]);
  if (a.p1 !== a.p2) die("Sifreler eslesmedi.");
  body.user = { username: a.username.trim(), password: a.p1, enable2FA: false };

  const { want } = await ask({
    type: "confirm",
    name: "want",
    message: "Iki adimli dogrulama (TOTP) acilsin mi?",
    initial: true
  });
  if (!want) return null;

  const t = auth.generateTotp(body.user.username);
  console.log("");
  console.log("  Authenticator uygulamana ekle:");
  console.log("    secret : " + cyan(t.secret));
  console.log("    otpauth: " + cyan(t.otpauth));
  console.log("");

  for (let attempt = 1; attempt <= 3; attempt++) {
    const { code } = await ask({
      type: "text",
      name: "code",
      message: `Uygulamadaki 6 haneli kod (deneme ${attempt}/3)`
    });
    if (auth.verifyTotp(t.secret, String(code || "").trim())) {
      ok("2FA dogrulandi.");
      body.user.enable2FA = true;
      return t.secret;
    }
    warn("Kod dogrulanmadi.");
  }
  die("2FA dogrulanamadi.", [
    "Sunucu saati dogru mu? (timedatectl)",
    "2FA'siz devam etmek icin tekrar calistir."
  ]);
  return null;
}

async function askServices(body) {
  head("Servisler");
  let detected = [];
  try {
    detected = detect.detectAll().filter((s) => s.installed);
  } catch (err) {
    warn(`Servis tespiti yapilamadi: ${err.message}`);
  }
  if (!detected.length) {
    info("Kurulu bilinen servis bulunamadi — atlaniyor.");
    body.services = [];
    return;
  }
  const { picked } = await ask({
    type: "multiselect",
    name: "picked",
    message: "Panelde yonetilecek servisleri sec (bosluk ile isaretle)",
    choices: detected.map((s) => ({
      title: `${s.display_name}${s.active ? " (calisiyor)" : ""}`,
      value: s.type,
      selected: s.active
    })),
    instructions: false
  });
  body.services = picked || [];
}

async function askIntegrations(body) {
  head("Entegrasyonlar (opsiyonel)");
  const integrations = {};

  const { tg } = await ask({
    type: "confirm",
    name: "tg",
    message: "Telegram guvenlik bildirimleri kurulsun mu?",
    initial: false
  });
  if (tg) {
    const a = await ask([
      { type: "password", name: "botToken", message: "Bot token'i (@BotFather)" },
      { type: "text", name: "ownerChatId", message: "Senin chat id'in (@userinfobot)" }
    ]);
    if (a.botToken && a.ownerChatId) {
      integrations.telegram = {
        botToken: a.botToken.trim(),
        ownerChatId: String(a.ownerChatId).trim()
      };
    }
  }

  const { gh } = await ask({
    type: "confirm",
    name: "gh",
    message: "GitHub token'i eklensin mi (repo klonlama)?",
    initial: false
  });
  if (gh) {
    const a = await ask({
      type: "password",
      name: "token",
      message: "GitHub personal access token"
    });
    if (a.token) integrations.github = { token: a.token.trim() };
  }

  body.integrations = integrations;
}

async function buildBodyInteractive() {
  const body = {
    accessMode: null,
    services: [],
    integrations: {}
  };

  // Tunnel kurulum oncesinde (install.sh) kurulduysa erisim modu zaten belli:
  // tekrar sormak yeni bir tunnel acmaya davet olurdu.
  const cf = core.cfProvisionedInfo();
  if (cf) {
    head("Erisim modu");
    ok(`Cloudflare: yapilandirildi — panel https://${cf.panelHost}`);
    info("Tunnel kurulumdan once kuruldu; bu adim atlandi.");
    body.accessMode = "cf-api";
  } else {
    body.accessMode = await askAccessMode();
    if (!body.accessMode) die("Erisim modu secilmedi.");

    if (body.accessMode === "public") await askPublic(body);
    else if (body.accessMode === "cf-tunnel") await askCfTunnel(body);
    else if (body.accessMode === "cf-api") await askCfApi(body);
  }

  await askPanel(body);
  const totpSecret = await askAdmin(body);
  await askServices(body);
  await askIntegrations(body);

  return { body, totpSecret };
}

// ─────────────────────────── Ozet + calistirma ───────────────────────────

function printSummary(body) {
  head("Ozet");
  const rows = [
    ["Erisim modu", body.accessMode],
    ["Domain", body.domain || "—"],
    ["Uygulama adi", body.appName],
    ["Projeler dizini", body.projectsDir],
    ["Yonetici", body.user.username],
    ["2FA", body.user.enable2FA ? "acik" : "kapali"],
    ["Servisler", body.services && body.services.length ? body.services.join(", ") : "—"],
    ["Entegrasyonlar", Object.keys(body.integrations || {}).join(", ") || "—"]
  ];
  for (const [k, v] of rows) console.log(`  ${dim(k.padEnd(16))} ${v}`);
}

function makeProgressPrinter() {
  let lineOpen = false;
  return (step) => {
    if (step.status === "pending") return;
    if (step.status === "running") {
      process.stdout.write(`  ${step.label} ... `);
      lineOpen = true;
      return;
    }
    if (!lineOpen) process.stdout.write(`  ${step.label} ... `);
    lineOpen = false;
    if (step.status === "ok") {
      console.log(green("✓"));
      if (step.note) console.log(`      ${dim(step.note)}`);
    } else {
      console.log(red("✗"));
      if (step.error) console.log(`      ${red(step.error)}`);
    }
  };
}

async function run(body, totpSecret) {
  // install.sh tunnel'i sihirbazdan once kurduysa cf-api modunda token
  // sorulmaz, dogrulanmaz ve kurulum sonrasi adimlarda tekrarlanmaz.
  const cfProvisioned = core.isCfProvisioned();
  const { errors } = core.validateFinalize(body, {
    totpVerified: !!totpSecret,
    cfProvisioned
  });
  if (errors.length) die("Kurulum bilgileri eksik/gecersiz:", errors);

  const dirCheck = core.ensureProjectsDir(body.projectsDir);
  if (!dirCheck.ok) die(dirCheck.error);

  head("Kurulum");
  const applied = core.applyFinalize(body, { totpSecret, cfProvisioned });
  ok("Ayarlar, yonetici hesabi ve servis kayitlari yazildi.");

  const progress = core.createProgress({ onUpdate: makeProgressPrinter() });
  progress.start(applied.accessMode, applied.finalUrl, { cfProvisioned });

  console.log("");
  // transition "direct": bu process servisin kendisi degil, gecisi kendimiz
  // yapip sonucunu dogrulayabiliriz (tarayici modunda systemd-run gerekiyordu).
  const success = await core.runPostSetup(body.accessMode, body, progress, {
    log: (m) => console.log(`      ${dim(m)}`),
    transition: "direct",
    cfProvisioned
  });

  console.log("");
  if (success) {
    ok("Kurulum tamamlandi.");
    console.log(`\n  Panel: ${cyan(applied.finalUrl)}\n`);
    console.log(`  Durum : ${dim("lyra status")}`);
    console.log(`  Log   : ${dim("lyra logs")}\n`);
    return 0;
  }

  warn("Kurulum sonrasi adimlarin bir kismi basarisiz oldu.");
  console.log(`  Yonetici hesabi ve ayarlar yazildi; yukaridaki ${red("✗")} satirlarini duzeltip`);
  console.log("  ilgili adimi elle tamamlayabilirsin. Servis durumu: " + dim("lyra status") + "\n");
  return 1;
}

// ──────────────── Sadece tunnel kurulumu (--provision-tunnel) ────────────────
//
// install.sh sihirbazdan ONCE cagirir. Basarisiz olursa hicbir sey kurulmamis
// olur ve install.sh secenek menusune geri doner (cikis kodu 1); kullanici
// vazgecerse 130 doner ve install.sh kurulumu iptal eder.

function provisionFlagBody() {
  const token = cfApiToken();
  const missing = [];
  if (!token) missing.push("--cf-api-token <token>  ya da LYRA_CF_API_TOKEN env'i");
  if (!args.domain) missing.push("--domain <alan.adi>");
  if (missing.length) {
    die(
      "Cloudflare tunnel kurulumu icin eksik zorunlu alanlar var:",
      missing.concat(["", "Tam liste: node scripts/setup-cli.js --help"])
    );
  }
  return {
    accessMode: "cf-api",
    cfApiToken: token,
    domain: args.domain,
    cfAccountId: args.cfAccountId || null,
    cfHostMode: args.cfHostMode === "subdomain" ? "subdomain" : "apex",
    cfPanelSubdomain: args.cfPanelSubdomain || core.DEFAULT_PANEL_SUBDOMAIN,
    cfOverwriteDns: !!args.cfOverwriteDns
  };
}

// Non-interactive on-kontrol: soracak kimse yok, karar bayraklarda olmali.
async function provisionPreflightNonInteractive(body) {
  let pre;
  try {
    pre = await core.cfPreflight(core.cfPlanFromBody(body));
  } catch (err) {
    die(`Cloudflare on-kontrolu basarisiz: ${err.message}`, ["Hicbir sey kurulmadi."]);
  }
  if (pre.needsAccountChoice) {
    die(
      "Token birden fazla Cloudflare hesabina erisiyor; hangisi kullanilacak belirsiz.",
      ["--cf-account-id <id> ile sec:"].concat(
        pre.accounts.map((a) => `  ${a.id}  ${a.name || ""}`)
      )
    );
  }
  const plan = core.cfPlanFromBody(body);
  const blocking = pre.conflicts.filter(
    (c) => c.host === plan.panelHost || c.host === `*.${plan.domain}`
  );
  if (blocking.length && !body.cfOverwriteDns) {
    const rows = [];
    for (const c of blocking) {
      for (const r of c.records) rows.push(`  ${c.host}  ${r.type}  ${r.content}`);
    }
    die(
      "Kullanilacak host(lar)da zaten DNS kaydi var — onayin olmadan uzerine yazmiyoruz:",
      rows.concat([
        "",
        "Secenekler:",
        "  --cf-host-mode subdomain --cf-panel-subdomain <ad>   (apex kaydina dokunmaz)",
        "  --cf-overwrite-dns                                   (mevcut kaydin uzerine yaz)"
      ])
    );
  }
  return pre;
}

async function provisionTunnel() {
  console.log("\n" + cyan("Lyra — Cloudflare tunnel kurulumu"));

  const interactive = !args.yes && !!process.stdin.isTTY;
  // Bayraklari agir islerden once dogrula.
  const flagBody = interactive ? null : provisionFlagBody();

  migrate();
  if (users.exists()) {
    die("Kurulum daha once tamamlanmis (yonetici hesabi mevcut).", [
      "Tunnel ayarlari icin panel > Tunnel sekmesini kullan."
    ]);
  }
  if (core.isCfProvisioned()) {
    const cf = core.cfProvisionedInfo();
    ok(`Cloudflare zaten kurulmus — panel https://${cf.panelHost}`);
    info("Tekrar kurulmadi. Sihirbaza bu adresten devam et.");
    return 0;
  }

  let body;
  if (interactive) {
    body = { accessMode: "cf-api" };
    // Sihirbazin cf-api adimiyla AYNI fonksiyon: preflight, hesap secimi,
    // apex cakismasi ve uzerine yazma onayi burada da ayni sekilde isler.
    await askCfApi(body, {
      token: cfApiToken(),
      domain: args.domain || null,
      accountId: args.cfAccountId || null
    });
  } else {
    body = flagBody;
    await provisionPreflightNonInteractive(body);
  }

  const plan = core.cfPlanFromBody(body);
  head("Cloudflare kurulumu");
  info(`Panel adresi: https://${plan.panelHost}`);
  console.log("");

  let result;
  try {
    result = await core.provisionCloudflare(body, {
      log: (m) => console.log(`      ${dim(m)}`),
      onUpdate: makeProgressPrinter()
    });
  } catch (err) {
    die(`Cloudflare kurulumu basarisiz: ${err && err.message ? err.message : err}`);
  }

  console.log("");
  if (!result.ok) {
    warn("Cloudflare kurulumu tamamlanamadi — yukaridaki ✗ satirina bak.");
    console.log("  Hicbir kalici ayar yazilmadi; duzeltip tekrar deneyebilirsin.\n");
    return 1;
  }
  ok(`Tunnel hazir: ${cyan(result.finalUrl)}`);
  return 0;
}

// ─────────────────────────── Main ───────────────────────────

async function main() {
  if (args.provisionTunnel) return provisionTunnel();

  console.log("\n" + cyan("Lyra — terminal kurulum sihirbazi"));

  const nonInteractive = !!args.yes || !process.stdin.isTTY;
  if (nonInteractive && !args.yes) {
    die("Terminal interaktif degil (stdin bir TTY degil).", [
      "Non-interactive kurulum icin --yes ve zorunlu bayraklari ver:",
      "  node scripts/setup-cli.js --help"
    ]);
  }

  // Non-interactive: bayraklari migrasyondan ONCE dogrula, eksikse hizli ol.
  const flagBody = nonInteractive ? buildBodyNonInteractive() : null;

  migrate();

  if (users.exists()) {
    die("Kurulum daha once tamamlanmis (yonetici hesabi mevcut).", [
      "Sifre/2FA sifirlamak icin : lyra reset-admin",
      `Sifirdan kurmak icin      : servisi durdur, ${config.LYRA_HOME}/lyra.db dosyasini sil,`,
      "                            sonra bu komutu tekrar calistir."
    ]);
  }

  if (nonInteractive) {
    const totpSecret = flagBody.user.enable2FA ? nonInteractiveTotp(flagBody.user.username) : null;
    printSummary(flagBody);
    return run(flagBody, totpSecret);
  }

  const { body, totpSecret } = await buildBodyInteractive();
  printSummary(body);
  const { go } = await ask({
    type: "confirm",
    name: "go",
    message: "Kurulum baslatilsin mi?",
    initial: true
  });
  if (!go) {
    console.log("\nIptal edildi. Hicbir sey yazilmadi.\n");
    return 130;
  }
  return run(body, totpSecret);
}

main()
  .then((code) => process.exit(code || 0))
  .catch((err) => {
    console.error(`\n${red("✗")} Kurulum hatasi: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });
