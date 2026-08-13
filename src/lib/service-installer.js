// Panelin yonettigi servisleri KURAR.
//
// Lyra cloudflared'i (lib/cloudflared-installer.js) ve Caddy'yi (lib/caddy.js)
// zaten kuruyor; bu modul ayni deseni yonetilen servisler icin uygular.
// Sihirbazin "Servisler" adimi boylece "kurulu olani kaydet"ten
// "sec, kur, kaydet"e doner.
//
// ─────────────────────── GUVENLIK DEGISMEZI ───────────────────────
// Kurulan her servis YALNIZCA 127.0.0.1'e bind edilir.
//
// Lyra login + 2FA + IP ban katmanini sagladigi icin bu servisler kendi
// auth'unu kapatabilir — ama bu YALNIZCA loopback'te olduklari icin
// dogrudur. "0.0.0.0'a bind + auth kapali" internete acik kimliksiz bir
// IDE demektir; bu birlesim burada uretilemez.
//
// Uretilen her yapilandirma saf fonksiyonlarda durur (buildCodeServerConfig,
// buildFilebrowserUnit, buildDbgateUnit) ve test altindadir
// (test/service-installer.test.js — "loopback degismezi").
//
// Kabuk kullanilmaz: her komut execFile + arguman dizisi ile calisir, hicbir
// kullanici/sistem degeri shell'e string olarak gecmez.

const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Tum servisler bu adrese bind edilir. Tek bir sabit: testler bunun
// disina cikan yapilandirmayi yakalar.
const LOOPBACK = "127.0.0.1";

// Node'un mimari adi -> paket/imaj mimarisi. Listede olmayan bir mimaride
// (armv7, riscv64, ...) hicbir servis kurulmaz: dogrulanmis paketimiz yok.
const ARCH_ALIASES = { x64: "amd64", arm64: "arm64" };

// ─────────────────────────── Kabuk yardimcilari ───────────────────────────

// execFile + arguman dizisi. Exception sizdirmaz; { ok, out, error } doner.
function run(file, args, { timeout = 600000, env } = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout, maxBuffer: 8 * 1024 * 1024, env: env || process.env },
      (err, stdout, stderr) => {
        const out = (stdout || "").toString();
        if (err) {
          const msg = (stderr || "").toString().trim() || err.message;
          return resolve({ ok: false, out, error: msg });
        }
        resolve({ ok: true, out });
      }
    );
  });
}

const sudo = (args, opts) => run("sudo", ["-n", ...args], opts);

// PATH'te calistirilabilir dosya ara. "command -v" bir shell builtin'i;
// onun yerine dosya sisteminde bakiyoruz (shell'e hic ugramadan).
function resolveBinary(name) {
  const fromPath = String(process.env.PATH || "").split(path.delimiter);
  const dirs = [...fromPath, "/usr/local/bin", "/usr/bin", "/bin", "/snap/bin"];
  for (const dir of dirs) {
    if (!dir) continue;
    const full = path.join(dir, name);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch (_) {}
  }
  return null;
}

function tmpFile(prefix, ext = "") {
  return path.join(os.tmpdir(), `lyra-${prefix}-${process.pid}-${Date.now()}${ext}`);
}

function rmQuiet(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch (_) {}
}

// Icerigi once tmp'e yaz, sonra "sudo install" ile hedefe koy (caddy.js ile
// ayni desen: hedef yol da icerik de shell'e ugramaz).
async function sudoInstallFile(content, target, mode = "644") {
  const tmp = tmpFile("file");
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    const r = await sudo(["install", "-m", mode, tmp, target], { timeout: 30000 });
    if (!r.ok) return { ok: false, error: `${target} yazilamadi: ${r.error}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `${target} yazilamadi: ${err.message}` };
  } finally {
    rmQuiet(tmp);
  }
}

function osRelease() {
  const out = {};
  try {
    for (const line of fs.readFileSync("/etc/os-release", "utf8").split("\n")) {
      const i = line.indexOf("=");
      if (i > 0)
        out[line.slice(0, i).trim()] = line
          .slice(i + 1)
          .trim()
          .replace(/^"|"$/g, "");
    }
  } catch (_) {}
  return out;
}

function currentUserInfo() {
  try {
    const u = os.userInfo();
    return { user: u.username, home: u.homedir || os.homedir() };
  } catch (_) {
    return { user: process.env.USER || "root", home: os.homedir() || "/root" };
  }
}

// ─────────────────────────── Gereksinimler ───────────────────────────
//
// Bir gereksinim saglanmiyorsa servis sihirbazda DEVRE DISI gorunur ve
// SEBEBI yazilir. Sessizce gizlenmez.

const REQUIREMENTS = {
  docker: {
    label: "Docker",
    // Docker'i OTOMATIK KURMUYORUZ: agir bir bagimlilik ve kullanicinin
    // sistem tercihi. Yoksa secenek devre disi kalir.
    check: () => !!resolveBinary("docker"),
    reason: "Docker kurulu degil — Lyra Docker'i otomatik kurmaz."
  },
  apt: {
    label: "APT (Debian/Ubuntu)",
    check: () => !!resolveBinary("apt-get"),
    reason: "apt-get yok — bu paket yalnizca Debian/Ubuntu tabanli sistemlerde kurulabilir."
  },
  "mongodb-repo": {
    label: "MongoDB apt deposu",
    check: () => !!mongoRepo(),
    reason: "MongoDB bu dagitim surumu icin resmi apt deposu yayinlamiyor."
  }
};

// ─────────────────────────── MongoDB apt deposu ───────────────────────────
//
// repo.mongodb.org'da 8.0 icin yayinlanan dist'ler (2026-08 itibariyle
// dogrulandi: Release dosyalari "Architectures: arm64 amd64" diyor).
const MONGO_VERSION = "8.0";
const MONGO_KEYRING = `/usr/share/keyrings/mongodb-server-${MONGO_VERSION}.gpg`;
const MONGO_LIST = `/etc/apt/sources.list.d/mongodb-org-${MONGO_VERSION}.list`;
const MONGO_KEY_URL = `https://pgp.mongodb.com/server-${MONGO_VERSION}.asc`;
const MONGO_DISTS = {
  ubuntu: {
    url: "https://repo.mongodb.org/apt/ubuntu",
    component: "multiverse",
    codenames: ["focal", "jammy", "noble"]
  },
  debian: {
    url: "https://repo.mongodb.org/apt/debian",
    component: "main",
    codenames: ["bookworm"]
  }
};

// Bu makine icin MongoDB deposu var mi? Yoksa null.
function mongoRepo(rel = osRelease()) {
  const id = String(rel.ID || "").toLowerCase();
  const codename = String(rel.VERSION_CODENAME || "").toLowerCase();
  const dist = MONGO_DISTS[id];
  if (!dist || !codename || !dist.codenames.includes(codename)) return null;
  return { id, codename, url: dist.url, component: dist.component };
}

function buildMongoSourceList(repo) {
  return (
    `deb [ arch=amd64,arm64 signed-by=${MONGO_KEYRING} ] ` +
    `${repo.url} ${repo.codename}/mongodb-org/${MONGO_VERSION} ${repo.component}\n`
  );
}

// /etc/mongod.conf icindeki bindIp degeri. Degistirmiyoruz — DOGRULUYORUZ.
function mongodBindIp(conf) {
  const m = String(conf || "").match(/^\s*bindIp:\s*(.+?)\s*$/m);
  if (!m) return null;
  return m[1].replace(/#.*$/, "").replace(/["']/g, "").trim() || null;
}

function isLoopbackBind(value) {
  if (!value) return false;
  const parts = String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return false;
  return parts.every((p) => p === "127.0.0.1" || p === "::1" || p === "localhost");
}

// ─────────────────────── Uretilen yapilandirmalar ───────────────────────
//
// Hepsi saf fonksiyon: girdi -> metin. Loopback degismezi burada test edilir.

function buildCodeServerConfig({ port }) {
  // auth: none GUVENLI, cunku bind-addr loopback: disaridan tek yol Lyra'nin
  // login + 2FA + ban katmani. Bu iki satir birlikte degistirilmemeli.
  return [
    "# Lyra tarafindan yazildi.",
    "# bind-addr loopback oldugu icin auth kapali: disaridan tek erisim yolu",
    "# Lyra'nin login + 2FA + IP ban katmanidir. Bu dosyayi 0.0.0.0'a acmak",
    "# kimliksiz bir IDE'yi internete acmak demektir.",
    `bind-addr: ${LOOPBACK}:${port}`,
    "auth: none",
    "cert: false",
    ""
  ].join("\n");
}

function buildFilebrowserUnit({
  user,
  port,
  root,
  database,
  binary = "/usr/local/bin/filebrowser"
}) {
  return [
    "[Unit]",
    "Description=File Browser (Lyra)",
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    `User=${user}`,
    // --noauth: erisim Lyra'nin arkasindan geliyor (bkz. bastaki degismez).
    // -a ${LOOPBACK}: disaridan dogrudan baglanti yok.
    `ExecStart=${binary} -a ${LOOPBACK} -p ${port} -r ${root} -d ${database} --noauth`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    ""
  ].join("\n");
}

function buildDbgateUnit({ port, image, container, volume, docker = "/usr/bin/docker" }) {
  // Port publish MUTLAKA loopback'e: "-p 8081:3000" (host'suz) konteyneri
  // tum arayuzlere acardi.
  return [
    "[Unit]",
    "Description=DbGate (Lyra)",
    "After=docker.service network.target",
    "Requires=docker.service",
    "",
    "[Service]",
    "Type=simple",
    `ExecStartPre=-${docker} rm -f ${container}`,
    `ExecStart=${docker} run --rm --name ${container} ` +
      `-p ${LOOPBACK}:${port}:3000 -v ${volume}:/root/.dbgate ${image}`,
    `ExecStop=${docker} stop ${container}`,
    "Restart=on-failure",
    "RestartSec=10",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    ""
  ].join("\n");
}

// ─────────────────────────── Kurulumlar ───────────────────────────

const CODE_SERVER_INSTALL_URL = "https://code-server.dev/install.sh";
const FILEBROWSER_RELEASE = (arch) =>
  `https://github.com/filebrowser/filebrowser/releases/latest/download/linux-${arch}-filebrowser.tar.gz`;
const DBGATE_IMAGE = "dbgate/dbgate";
const DBGATE_CONTAINER = "lyra-dbgate";
const DBGATE_VOLUME = "lyra-dbgate-data";

async function installCodeServer({ onLog, user, home, port }) {
  const log = onLog || (() => {});
  const unit = `code-server@${user}`;

  if (resolveBinary("code-server")) {
    log("code-server binary'si zaten var — indirme atlandi.");
  } else {
    const script = tmpFile("code-server-install", ".sh");
    log("code-server resmi kurulum scripti indiriliyor...");
    const dl = await run("curl", ["-fsSL", "-o", script, CODE_SERVER_INSTALL_URL], {
      timeout: 120000
    });
    if (!dl.ok) {
      rmQuiet(script);
      return { ok: false, error: `Kurulum scripti indirilemedi: ${dl.error}` };
    }
    log("code-server kuruluyor (resmi .deb)...");
    const r = await sudo(["sh", script]);
    rmQuiet(script);
    if (!r.ok) return { ok: false, error: `Kurulum basarisiz: ${r.error}` };
  }

  // Yapilandirma servis kullanicisinin home'una yazilir; code-server@<user>
  // unit'i tam olarak bu dosyayi okur.
  const dir = path.join(home, ".config", "code-server");
  const file = path.join(dir, "config.yaml");
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, buildCodeServerConfig({ port }), { mode: 0o600 });
  } catch (err) {
    return { ok: false, error: `config.yaml yazilamadi (${file}): ${err.message}` };
  }
  log(`Yapilandirma: ${file} (bind ${LOOPBACK}:${port}, auth none)`);

  const en = await sudo(["systemctl", "enable", "--now", unit], { timeout: 120000 });
  if (!en.ok) return { ok: false, error: `${unit} baslatilamadi: ${en.error}` };
  return { ok: true, unit_name: unit, port };
}

async function installFilebrowser({ onLog, user, home, port, arch }) {
  const log = onLog || (() => {});
  const unit = "filebrowser";
  const binary = "/usr/local/bin/filebrowser";

  if (resolveBinary("filebrowser")) {
    log("filebrowser binary'si zaten var — indirme atlandi.");
  } else {
    const tarball = tmpFile("filebrowser", ".tar.gz");
    const dir = tmpFile("filebrowser-x");
    log(`filebrowser indiriliyor (linux-${arch})...`);
    const dl = await run("curl", ["-fsSL", "-o", tarball, FILEBROWSER_RELEASE(arch)], {
      timeout: 180000
    });
    if (!dl.ok) {
      rmQuiet(tarball);
      return { ok: false, error: `Indirme basarisiz: ${dl.error}` };
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      rmQuiet(tarball);
      return { ok: false, error: `Gecici dizin olusturulamadi: ${err.message}` };
    }
    const untar = await run("tar", ["-xzf", tarball, "-C", dir, "filebrowser"], { timeout: 60000 });
    rmQuiet(tarball);
    if (!untar.ok) {
      rmQuiet(dir);
      return { ok: false, error: `Arsiv acilamadi: ${untar.error}` };
    }
    const inst = await sudo(["install", "-m", "755", path.join(dir, "filebrowser"), binary], {
      timeout: 30000
    });
    rmQuiet(dir);
    if (!inst.ok) return { ok: false, error: `Binary kurulamadi: ${inst.error}` };
  }

  const dataDir = path.join(home, ".filebrowser");
  const database = path.join(dataDir, "filebrowser.db");
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    return { ok: false, error: `Veri dizini olusturulamadi (${dataDir}): ${err.message}` };
  }

  const written = await sudoInstallFile(
    buildFilebrowserUnit({ user, port, root: home, database, binary }),
    `/etc/systemd/system/${unit}.service`
  );
  if (!written.ok) return written;
  log(`systemd unit yazildi: ${unit}.service (bind ${LOOPBACK}:${port}, auth kapali)`);

  const reload = await sudo(["systemctl", "daemon-reload"], { timeout: 60000 });
  if (!reload.ok) return { ok: false, error: `daemon-reload basarisiz: ${reload.error}` };
  const en = await sudo(["systemctl", "enable", "--now", unit], { timeout: 120000 });
  if (!en.ok) return { ok: false, error: `${unit} baslatilamadi: ${en.error}` };
  return { ok: true, unit_name: unit, port };
}

async function installDbgate({ onLog, port }) {
  const log = onLog || (() => {});
  const unit = "dbgate";
  const docker = resolveBinary("docker");
  if (!docker) return { ok: false, error: REQUIREMENTS.docker.reason };

  log(`${DBGATE_IMAGE} imaji cekiliyor...`);
  const pull = await sudo([docker, "pull", DBGATE_IMAGE]);
  if (!pull.ok) return { ok: false, error: `Imaj cekilemedi: ${pull.error}` };

  const written = await sudoInstallFile(
    buildDbgateUnit({
      port,
      image: DBGATE_IMAGE,
      container: DBGATE_CONTAINER,
      volume: DBGATE_VOLUME,
      docker
    }),
    `/etc/systemd/system/${unit}.service`
  );
  if (!written.ok) return written;
  log(`systemd unit yazildi: ${unit}.service (publish ${LOOPBACK}:${port})`);

  const reload = await sudo(["systemctl", "daemon-reload"], { timeout: 60000 });
  if (!reload.ok) return { ok: false, error: `daemon-reload basarisiz: ${reload.error}` };
  const en = await sudo(["systemctl", "enable", "--now", unit], { timeout: 180000 });
  if (!en.ok) return { ok: false, error: `${unit} baslatilamadi: ${en.error}` };
  return { ok: true, unit_name: unit, port };
}

async function installMongod({ onLog, port }) {
  const log = onLog || (() => {});
  const unit = "mongod";
  const repo = mongoRepo();
  if (!repo) return { ok: false, error: REQUIREMENTS["mongodb-repo"].reason };

  if (resolveBinary("mongod")) {
    log("mongod binary'si zaten var — paket kurulumu atlandi.");
  } else {
    const key = tmpFile("mongodb-key", ".asc");
    log("MongoDB imza anahtari indiriliyor...");
    const dl = await run("curl", ["-fsSL", "-o", key, MONGO_KEY_URL], { timeout: 120000 });
    if (!dl.ok) {
      rmQuiet(key);
      return { ok: false, error: `Anahtar indirilemedi: ${dl.error}` };
    }
    // gpg --dearmor -o: boru hattina (pipe) gerek yok, dolayisiyla shell de yok.
    const dearmor = await sudo(["gpg", "--batch", "--yes", "--dearmor", "-o", MONGO_KEYRING, key], {
      timeout: 60000
    });
    rmQuiet(key);
    if (!dearmor.ok) return { ok: false, error: `Anahtar yazilamadi: ${dearmor.error}` };

    const list = await sudoInstallFile(buildMongoSourceList(repo), MONGO_LIST);
    if (!list.ok) return list;
    log(`apt deposu eklendi: ${repo.id} ${repo.codename} (mongodb-org/${MONGO_VERSION})`);

    const update = await sudo(["apt-get", "update"]);
    if (!update.ok) return { ok: false, error: `apt-get update basarisiz: ${update.error}` };

    log("mongodb-org kuruluyor (bu birkac dakika surebilir)...");
    const inst = await sudo([
      "env",
      "DEBIAN_FRONTEND=noninteractive",
      "apt-get",
      "install",
      "-y",
      "mongodb-org"
    ]);
    if (!inst.ok) return { ok: false, error: `Kurulum basarisiz: ${inst.error}` };
  }

  // mongod'un varsayilani zaten 127.0.0.1. Degistirmiyoruz — DOGRULUYORUZ.
  // Loopback disina acilmissa servisi BASLATMIYORUZ: kimlik dogrulamasiz bir
  // veritabanini agda acmaktansa kurulumu yarim birakip soylemek dogru.
  let bindIp = null;
  try {
    bindIp = mongodBindIp(fs.readFileSync("/etc/mongod.conf", "utf8"));
  } catch (err) {
    return { ok: false, error: `/etc/mongod.conf okunamadi: ${err.message}` };
  }
  if (!isLoopbackBind(bindIp)) {
    return {
      ok: false,
      error:
        `/etc/mongod.conf bindIp degeri loopback disinda (${bindIp || "bos"}). ` +
        `Servis baslatilmadi: bindIp'yi ${LOOPBACK} yapip "sudo systemctl enable --now mongod" calistir.`
    };
  }
  log(`/etc/mongod.conf bindIp dogrulandi: ${bindIp}`);

  const en = await sudo(["systemctl", "enable", "--now", unit], { timeout: 180000 });
  if (!en.ok) return { ok: false, error: `${unit} baslatilamadi: ${en.error}` };
  return { ok: true, unit_name: unit, port };
}

// ─────────────────────────── Katalog ───────────────────────────
//
// est_ram_mb: calisirken beklenen yerlesik bellek (kaba). Sihirbaz secimin
// toplamini bos RAM ile karsilastirip UYARIR — engellemez.

const CATALOG = [
  {
    type: "code-server",
    display_name: "code-server",
    description: "Tarayicida VS Code",
    default_port: 8080,
    est_ram_mb: 200,
    est_disk_mb: 350,
    // Panelin amiral gemisi: "/code/" linki arayuzde zaten duruyor.
    default_selected: true,
    arch_supported: ["x64", "arm64"],
    requires: [],
    source: "https://code-server.dev/install.sh (coder/code-server resmi scripti, .deb)",
    unit_of: ({ user }) => `code-server@${user}`,
    install: installCodeServer
  },
  {
    type: "filebrowser",
    display_name: "filebrowser",
    description: "Dosya yonetimi",
    default_port: 8082,
    est_ram_mb: 30,
    est_disk_mb: 40,
    default_selected: false,
    arch_supported: ["x64", "arm64"],
    requires: [],
    source:
      "github.com/filebrowser/filebrowser releases (linux-<arch>-filebrowser.tar.gz) + Lyra'nin yazdigi systemd unit'i",
    unit_of: () => "filebrowser",
    install: installFilebrowser
  },
  {
    type: "dbgate",
    display_name: "DbGate",
    description: "Veritabani arayuzu",
    default_port: 8081,
    est_ram_mb: 150,
    est_disk_mb: 450,
    // Bir istemci: ortada veritabani yoksa bos arayuz. Varsayilan kapali.
    default_selected: false,
    arch_supported: ["x64", "arm64"],
    requires: ["docker"],
    source: "docker.io/dbgate/dbgate (amd64 + arm64) + Lyra'nin yazdigi systemd unit'i",
    unit_of: () => "dbgate",
    install: installDbgate
  },
  {
    type: "mongod",
    display_name: "MongoDB",
    description: "Veritabani",
    default_port: 27017,
    est_ram_mb: 500,
    est_disk_mb: 600,
    // Bir veritabani motoru "her ihtimale karsi" kurulmaz.
    default_selected: false,
    // arm64 paketleri var; MongoDB 5.0+ ARMv8.2-A ister (Oracle A1 = Neoverse
    // N1, uygun). Eski ARMv8.0 kartlarda paket kurulur ama calismaz.
    arch_supported: ["x64", "arm64"],
    requires: ["apt", "mongodb-repo"],
    source: `repo.mongodb.org/apt (mongodb-org ${MONGO_VERSION}, amd64 + arm64)`,
    unit_of: () => "mongod",
    install: installMongod
  }
];

function list() {
  return CATALOG.map((s) => ({ ...s }));
}

function get(type) {
  return CATALOG.find((s) => s.type === type) || null;
}

function estimateRamMb(type) {
  const svc = get(type);
  return svc ? svc.est_ram_mb : null;
}

function requirements(type) {
  const svc = get(type);
  return svc ? [...svc.requires] : [];
}

// Bu mimaride kurulabilir mi? (Gereksinimlerden bagimsiz.)
function isSupported(type, arch = process.arch) {
  const svc = get(type);
  if (!svc) return false;
  if (!ARCH_ALIASES[arch]) return false;
  return svc.arch_supported.includes(arch);
}

function missingRequirements(type) {
  return requirements(type).filter((id) => {
    const req = REQUIREMENTS[id];
    return req ? !req.check() : true;
  });
}

// Sihirbazin secenegi acip acmayacagini belirleyen tek karar noktasi.
// installable false ise reason DOLU olur — secenek sebebiyle birlikte
// devre disi gosterilir, sessizce gizlenmez.
function installability(type, { arch = process.arch } = {}) {
  const svc = get(type);
  if (!svc) {
    return {
      installable: false,
      arch_supported: false,
      requires: [],
      missing: [],
      reason: "Lyra bu servisi kurmuyor.",
      est_ram_mb: null,
      est_disk_mb: null,
      default_selected: false
    };
  }
  const archOk = isSupported(type, arch);
  const missing = archOk ? missingRequirements(type) : [];
  let reason = null;
  if (!archOk) {
    reason = `Bu mimaride (${arch}) paket yok.`;
  } else if (missing.length) {
    reason = missing.map((id) => (REQUIREMENTS[id] ? REQUIREMENTS[id].reason : id)).join(" ");
  }
  return {
    installable: archOk && !missing.length,
    arch_supported: archOk,
    requires: [...svc.requires],
    missing,
    reason,
    est_ram_mb: svc.est_ram_mb,
    est_disk_mb: svc.est_disk_mb,
    default_selected: svc.default_selected,
    source: svc.source
  };
}

// Sihirbazin "Sunucu: 1.0 GB RAM (0.6 GB bos) · 40 GB disk · aarch64"
// satirini besleyen gercek degerler.
function hostInfo() {
  let diskFreeMb = null;
  let diskTotalMb = null;
  try {
    const st = fs.statfsSync("/");
    diskFreeMb = Math.round((st.bavail * st.bsize) / 1048576);
    diskTotalMb = Math.round((st.blocks * st.bsize) / 1048576);
  } catch (_) {}
  return {
    arch: process.arch,
    archLabel: ARCH_ALIASES[process.arch] || process.arch,
    totalMemMb: Math.round(os.totalmem() / 1048576),
    freeMemMb: Math.round(os.freemem() / 1048576),
    diskFreeMb,
    diskTotalMb,
    docker: REQUIREMENTS.docker.check()
  };
}

// Kurulan servisin systemd unit adi (code-server ornek unit'i kullaniciya bagli).
function unitName(type, user) {
  const svc = get(type);
  if (!svc) return null;
  return svc.unit_of({ user: user || currentUserInfo().user });
}

// Tek servis kur. Exception sizdirmaz: her yol { ok, error } doner.
async function install(type, { onLog, user, home } = {}) {
  const svc = get(type);
  if (!svc) return { ok: false, error: `Bilinmeyen servis: ${type}` };

  const state = installability(type);
  if (!state.installable) return { ok: false, error: state.reason };

  const who = currentUserInfo();
  const ctx = {
    onLog,
    user: user || who.user,
    home: home || who.home,
    port: svc.default_port,
    arch: ARCH_ALIASES[process.arch]
  };

  try {
    const r = await svc.install(ctx);
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || "Kurulum basarisiz" };
    return { ok: true, unit_name: r.unit_name, port: r.port, display_name: svc.display_name };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

module.exports = {
  LOOPBACK,
  ARCH_ALIASES,
  CATALOG,
  REQUIREMENTS,
  MONGO_KEYRING,
  MONGO_LIST,
  MONGO_DISTS,
  list,
  get,
  isSupported,
  estimateRamMb,
  requirements,
  missingRequirements,
  installability,
  hostInfo,
  unitName,
  install,
  resolveBinary,
  osRelease,
  mongoRepo,
  buildMongoSourceList,
  mongodBindIp,
  isLoopbackBind,
  buildCodeServerConfig,
  buildFilebrowserUnit,
  buildDbgateUnit
};
