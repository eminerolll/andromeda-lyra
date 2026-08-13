#!/usr/bin/env node
// "lyra" — kurulum sonrasi yasam dongusu komutu.
//
// install.sh bunu /usr/local/bin/lyra olarak symlink'ler. Alt komutlar mevcut
// scriptlere/modullere baglanir; burada is mantigi kopyalanmaz:
//   status       -> lib/health.js + db/repos/settings
//   update       -> git + npm ci + db/migrate + systemctl
//   uninstall    -> <kok>/uninstall.sh
//   reset-admin  -> scripts/reset-admin.js
//   logs         -> journalctl
//   connect      -> <kok>/lyra-connect

const fs = require("fs");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");

// bin/ -> src/ -> <kurulum koku>
const SRC_DIR = path.resolve(__dirname, "..");
const ROOT_DIR = path.resolve(SRC_DIR, "..");
const UNIT_NAME = "lyra";

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
const step = (s) => console.log(`\n${cyan("▸ " + s)}`);

function die(msg, lines = []) {
  console.error(`\n${red("✗")} ${msg}`);
  for (const l of lines) console.error(`    ${l}`);
  console.error("");
  process.exit(1);
}

function isRoot() {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

function requireRoot(cmd) {
  if (isRoot()) return;
  die(`"lyra ${cmd}" root yetkisi gerektiriyor.`, [`Soyle calistir: sudo lyra ${cmd}`]);
}

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { stdio: "inherit", ...opts });
  if (r.error) die(`${cmd} calistirilamadi: ${r.error.message}`);
  return typeof r.status === "number" ? r.status : 1;
}

function capture(cmd, argv, opts = {}) {
  try {
    return execFileSync(cmd, argv, { encoding: "utf8", timeout: 10000, ...opts }).trim();
  } catch (err) {
    return ((err && err.stdout) || "").toString().trim();
  }
}

function version() {
  try {
    return require("../package.json").version || "0.0.0";
  } catch (_) {
    return "bilinmiyor";
  }
}

// Lyra hangi Linux kullanicisi olarak calisiyor? Once systemd unit'ine,
// olmazsa kaynak agacinin sahibine bakariz. sudo "#UID" bicimini kabul eder.
function serviceUser() {
  const fromUnit = capture("systemctl", ["show", "-p", "User", "--value", UNIT_NAME]);
  if (fromUnit) return fromUnit;
  try {
    return `#${fs.statSync(SRC_DIR).uid}`;
  } catch (_) {
    return null;
  }
}

// Komutu servis kullanicisi olarak calistir. Servis kullanicisi zaten bizsek
// (ya da root ise) araya sudo koymuyoruz.
function runAsService(cmd, argv, { cwd = SRC_DIR, env = {} } = {}) {
  const user = serviceUser();
  const asRoot = !user || user === "root" || user === "#0";
  if (asRoot) {
    return run(cmd, argv, { cwd, env: { ...process.env, ...env } });
  }
  const envPairs = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  return run("sudo", ["-u", user, "-H", "env", ...envPairs, cmd, ...argv], { cwd });
}

// .env'i kurulum dizininden yukle (cwd'den bagimsiz olsun diye).
// dotenv mevcut process.env degerlerini EZMEZ: systemd Environment= kazanir.
function loadEnv() {
  try {
    require("dotenv").config({ path: path.join(SRC_DIR, ".env") });
  } catch (_) {
    // Bagimliliklar kurulmamis olabilir; env ile devam.
  }
}

// ─────────────────────────── lyra status ───────────────────────────

function fmtStatus(s) {
  if (!s) return dim("bilinmiyor");
  if (s === "active") return green(s);
  if (s === "inactive" || s === "unknown") return dim(s);
  return red(s);
}

function cmdStatus() {
  loadEnv();

  let health = null;
  let healthError = null;
  try {
    health = require("../lib/health").summary();
  } catch (err) {
    healthError = err && err.message ? err.message : String(err);
  }

  console.log(`\n${cyan("Lyra")} ${version()}   ${dim(ROOT_DIR)}`);

  if (!health) {
    console.log("");
    warn(`Durum okunamadi: ${healthError}`);
    console.log(`  Veritabani hazir degilse: ${dim("sudo lyra update")} ya da kurulumu tamamla.`);
    console.log(`  Servis: ${fmtStatus(capture("systemctl", ["is-active", UNIT_NAME]) || null)}\n`);
    return 1;
  }

  const { settings } = require("../db/repos");
  const config = require("../lib/config");
  const setupDone = config.isSetupComplete();
  const accessMode = settings.get("access_mode") || (setupDone ? "bilinmiyor" : "—");
  const panelHost = settings.get("panel_host") || settings.get("base_domain") || null;
  const bind = config.get("bind_address");

  let panelUrl;
  if (!setupDone) panelUrl = dim("kurulum tamamlanmadi");
  else if (panelHost) panelUrl = `https://${panelHost}`;
  else if (bind === "0.0.0.0") panelUrl = `http://<sunucu-ip>:${config.PORT}`;
  else panelUrl = `http://127.0.0.1:${config.PORT}`;

  const row = (k, v) => console.log(`  ${dim(k.padEnd(14))} ${v}`);
  console.log("");
  row("Servis", `${health.lyra.serviceName}.service — ${fmtStatus(health.lyra.serviceStatus)}`);
  row("Kurulum", setupDone ? green("tamamlandi") : yellow("TAMAMLANMADI"));
  row("Erisim modu", accessMode);
  row("Panel", panelUrl);
  row("Bind", `${bind}:${config.PORT}`);
  row(
    "Veritabani",
    `${path.join(config.LYRA_HOME, "lyra.db")} ${dim(
      health.lyra.dbSizeKb === null ? "(yok)" : `(${health.lyra.dbSizeKb} KB)`
    )}`
  );
  row("Node", `${health.lyra.nodeVersion} ${dim(`· RSS ${health.lyra.memory.rss} MB`)}`);
  row("Host", `${health.host.hostname} ${dim(`· ${health.host.platform}/${health.host.arch}`)}`);

  if (health.auxServices.length) {
    row(
      "Yardimci",
      health.auxServices.map((s) => `${s.unit_name} — ${fmtStatus(s.status)}`).join("  ")
    );
  }

  if (health.services.length) {
    console.log(`\n  ${dim("Kayitli servisler")}`);
    for (const s of health.services) {
      console.log(
        `    ${s.display_name}${s.port ? dim(` :${s.port}`) : ""} — ${fmtStatus(s.status)}`
      );
    }
  }
  console.log("");
  return 0;
}

// ─────────────────────────── lyra update ───────────────────────────

function cmdUpdate(argv) {
  requireRoot("update");
  const skipPull = argv.includes("--skip-pull");
  const unknown = argv.filter((a) => a !== "--skip-pull");
  if (unknown.length) die(`Bilinmeyen secenek: ${unknown[0]}`, ["Kullanim: sudo lyra update [--skip-pull]"]);

  loadEnv();
  const hasGit = fs.existsSync(path.join(ROOT_DIR, ".git"));

  step("Kaynak kodu");
  if (skipPull) {
    info("--skip-pull verildi, kod cekilmedi.");
  } else if (!hasGit) {
    // Elle kopyalanmis kurulum: cekilecek remote yok. Yarim is yapip
    // "guncellendi" demek yerine ne yapmasi gerektigini soyluyoruz.
    die(`${ROOT_DIR} bir git deposu degil — kod otomatik guncellenemez.`, [
      "Bu kurulum elle kopyalanmis (tar/scp/rsync).",
      "Yeni surumu ayni dizine kopyala, sonra:",
      "",
      "  sudo lyra update --skip-pull",
      "",
      "Boylece bagimliliklar, migrasyonlar ve servis restart'i calisir."
    ]);
  } else {
    const branch = capture("git", ["-C", ROOT_DIR, "rev-parse", "--abbrev-ref", "HEAD"]) || "main";
    info(`git pull --ff-only origin ${branch}`);
    // Depo servis kullanicisina ait, git'i root calistiriyor: "dubious ownership".
    const safe = ["-c", `safe.directory=${ROOT_DIR}`, "-C", ROOT_DIR];
    if (run("git", [...safe, "fetch", "--quiet", "origin"]) !== 0) die("git fetch basarisiz.");
    if (run("git", [...safe, "pull", "--quiet", "--ff-only", "origin", branch]) !== 0) {
      die("git pull --ff-only basarisiz.", [
        "Yerel degisiklik varsa once temizle:",
        `  git -C ${ROOT_DIR} status`
      ]);
    }
    ok(`Kod guncel (${branch} @ ${capture("git", [...safe, "rev-parse", "--short", "HEAD"])})`);
  }

  step("Bagimliliklar");
  const npmArgs = fs.existsSync(path.join(SRC_DIR, "package-lock.json"))
    ? ["ci", "--omit=dev", "--no-audit", "--no-fund"]
    : ["install", "--omit=dev", "--no-audit", "--no-fund"];
  if (npmArgs[0] === "install") warn("package-lock.json yok — npm install kullaniliyor.");
  if (runAsService("npm", npmArgs) !== 0) die("npm bagimliliklari kurulamadi.");
  ok("Bagimliliklar kuruldu");

  step("Veritabani");
  const home = process.env.LYRA_HOME || "/var/lib/lyra";
  if (runAsService("npm", ["run", "--silent", "migrate"], { env: { LYRA_HOME: home } }) !== 0) {
    die("Migrasyonlar uygulanamadi.");
  }
  ok("Migrasyonlar uygulandi");

  step("Servis");
  if (run("systemctl", ["restart", UNIT_NAME]) !== 0) {
    die(`${UNIT_NAME}.service yeniden baslatilamadi.`, [`sudo journalctl -u ${UNIT_NAME} -n 50 --no-pager`]);
  }
  const active = capture("systemctl", ["is-active", UNIT_NAME]) === "active";
  if (!active) {
    run("journalctl", ["-u", UNIT_NAME, "-n", "30", "--no-pager"]);
    die(`${UNIT_NAME}.service ayaga kalkmadi (yukaridaki loga bak).`);
  }
  ok(`${UNIT_NAME}.service calisiyor`);
  console.log(`\n  Durum: ${dim("lyra status")}\n`);
  return 0;
}

// ─────────────────────────── Digerleri ───────────────────────────

function cmdUninstall(argv) {
  const script = path.join(ROOT_DIR, "uninstall.sh");
  if (!fs.existsSync(script)) {
    die(`uninstall.sh bulunamadi: ${script}`, ["Kurulum agaci eksik gorunuyor."]);
  }
  requireRoot("uninstall");
  return run("bash", [script, ...argv]);
}

function cmdResetAdmin(argv) {
  loadEnv();
  const script = path.join(SRC_DIR, "scripts", "reset-admin.js");
  if (!fs.existsSync(script)) die(`reset-admin.js bulunamadi: ${script}`);
  // Root isek servis kullanicisina dusuyoruz: DB yan dosyalari (-wal/-shm)
  // root'a ait olarak yaratilirsa servis yazamaz hale gelir.
  const home = process.env.LYRA_HOME || "/var/lib/lyra";
  if (isRoot()) {
    return runAsService(process.execPath, [script, ...argv], { env: { LYRA_HOME: home } });
  }
  return run(process.execPath, [script, ...argv], {
    cwd: SRC_DIR,
    env: { ...process.env, LYRA_HOME: home }
  });
}

function cmdLogs(argv) {
  const args = argv.length ? argv : ["-f"];
  return run("journalctl", ["-u", UNIT_NAME, ...args]);
}

function cmdConnect(argv) {
  const script = path.join(ROOT_DIR, "lyra-connect");
  if (!fs.existsSync(script)) die(`lyra-connect bulunamadi: ${script}`);
  return run("bash", [script, ...argv]);
}

function usage() {
  console.log(`
${cyan("lyra")} — Andromeda Lyra yonetim komutu (${version()})

Kullanim: lyra <komut> [secenekler]

Komutlar:
  status                 Servis durumu, erisim modu, panel adresi, DB boyutu
  update [--skip-pull]   Kodu guncelle, bagimliliklar + migrasyon, servisi restart
                         --skip-pull: kodu sen kopyaladin, git'e dokunma
  logs [journalctl-arg]  Servis loglari (varsayilan: -f)
  reset-admin [arg]      Sifre / 2FA / ban sifirlama (scripts/reset-admin.js)
  connect [arg]          Uzak sunucuya SSH tunnel (laptop tarafi yardimcisi)
  uninstall [--keep-data] [--yes]
                         Lyra'yi sistemden kaldir
  --version              Surum
  --help                 Bu yardim

Root gerektirenler: update, uninstall

Ornekler:
  lyra status
  sudo lyra update
  sudo lyra update --skip-pull      # elle kopyalanmis kurulum
  lyra logs -n 100 --no-pager
  sudo lyra uninstall --keep-data
`);
}

// ─────────────────────────── Main ───────────────────────────

function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      usage();
      return 0;
    case "--version":
    case "-v":
    case "version":
      console.log(version());
      return 0;
    case "status":
      return cmdStatus();
    case "update":
      return cmdUpdate(rest);
    case "uninstall":
      return cmdUninstall(rest);
    case "reset-admin":
      return cmdResetAdmin(rest);
    case "logs":
      return cmdLogs(rest);
    case "connect":
      return cmdConnect(rest);
    default:
      die(`Bilinmeyen komut: ${cmd}`, ["Komut listesi: lyra --help"]);
      return 1;
  }
}

process.exit(main());
