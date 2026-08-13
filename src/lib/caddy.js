// Caddy + Let's Encrypt yardımcısı. Public mode'un default backend'i.
// Kurulu degilse 'apt install caddy' calistirir. Caddyfile uretir, reload eder.

const { execSync, execFileSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const CADDYFILE = "/etc/caddy/Caddyfile";

function isInstalled() {
  try {
    execSync("command -v caddy", { stdio: "ignore" });
    return true;
  } catch (_) {
    return false;
  }
}

function isActive() {
  try {
    const out = execSync("systemctl is-active caddy 2>/dev/null", {
      stdio: ["ignore", "pipe", "ignore"]
    })
      .toString()
      .trim();
    return out === "active";
  } catch (_) {
    return false;
  }
}

function detectInstallMethod() {
  // Caddy'nin official deb repo'su mu, snap mi, manuel mi?
  if (fs.existsSync("/etc/apt/sources.list.d/caddy-stable.list")) return "apt-official";
  try {
    execSync("dpkg -l caddy 2>/dev/null | grep '^ii'", { stdio: "ignore" });
    return "apt-existing";
  } catch (_) {}
  return "missing";
}

// Caddy'yi official repo'dan kur. Sudo gerekir.
async function install({ onLog }) {
  const log = onLog || (() => {});

  if (isInstalled()) {
    log("Caddy zaten kurulu, kurulum atlandi.");
    return { ok: true, alreadyInstalled: true };
  }

  log("Caddy kuruluyor (official Caddy repo'sundan)...");

  const cmds = [
    "sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl",
    "curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg",
    "curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list",
    "sudo apt-get update",
    "sudo apt-get install -y caddy"
  ];

  for (const cmd of cmds) {
    log(`$ ${cmd}`);
    try {
      execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      log(`HATA: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  log("Caddy kuruldu.");
  return { ok: true };
}

// Bilinen subdomain'ler (apex disinda). Wildcard (*.domain) KULLANILMIYOR:
// Let's Encrypt wildcard sertifikasi DNS-01 challenge ister, Caddy'nin DNS-01
// destegi ise binary'ye derlenmis bir DNS provider plugin'i gerektirir
// (xcaddy + caddy-dns/...). apt'tan gelen standart caddy paketinde yok.
// Bu yuzden bilinen host'lar tek tek listelenir; HTTP-01 ile sertifika alirlar.
// dev-{port} sonsuz sayida olabilecegi icin listelenemez — dev preview
// path-tabanli /dev/{port}/ yolundan (lib/path-proxy.js) servis edilir.
function knownSubdomains() {
  // Lazy require: caddy.js kurulum sirasinda DB'siz de yuklenebilmeli.
  const config = require("./config");
  const { services } = require("../db/repos");
  const base = config.get("base_domain");
  if (!base) return [];

  const typeToSub = {
    "code-server": config.get("subdomain_code"),
    filebrowser: config.get("subdomain_files"),
    dbgate: config.get("subdomain_db")
  };

  const out = [];
  for (const s of services.list({ enabledOnly: true })) {
    if (!s.port) continue;
    const sub = s.subdomain || typeToSub[s.type];
    if (sub) out.push(`${sub}.${base}`);
  }
  return [...new Set(out)];
}

// Caddyfile uret (Lyra reverse proxy + Let's Encrypt).
// Tum host'lar Lyra'ya proxy'lenir; servis yonlendirmesini ve auth'u Lyra yapar
// (dogrudan servis portuna proxy'lemek auth bariyerini atlatirdi).
function buildCaddyfile({ domain, email, upstream = "127.0.0.1:3000", subdomains = [] }) {
  if (!domain) throw new Error("domain gerekli");
  const lines = [];
  if (email) {
    lines.push("{");
    lines.push(`\temail ${email}`);
    lines.push("}");
    lines.push("");
  }
  // Apex once: subdomain'lerden birinin DNS'i eksikse sertifikasi basarisiz
  // olur ama dashboard calismaya devam eder (Caddy blok basina sertifika alir).
  for (const host of [domain, ...subdomains.filter((h) => h && h !== domain)]) {
    lines.push(`${host} {`);
    lines.push(`\treverse_proxy ${upstream}`);
    lines.push("}");
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

// Caddyfile yaz + Caddy'yi reload et. Sudo gerekir.
async function applyConfig({ domain, email, upstream, subdomains, onLog }) {
  const log = onLog || (() => {});
  const subs = subdomains || knownSubdomains();
  const content = buildCaddyfile({ domain, email, upstream, subdomains: subs });
  if (subs.length) log(`Subdomain bloklari: ${subs.join(", ")}`);

  log(`Caddyfile yaziliyor: ${CADDYFILE}`);
  // Tmp'e yaz, sudo ile mv
  const tmp = `/tmp/Caddyfile.lyra.${Date.now()}`;
  fs.writeFileSync(tmp, content, { mode: 0o644 });

  try {
    // execFile + arg dizisi: tmp yolu ve CADDYFILE shell'e hic ugramaz.
    execFileSync("sudo", ["install", "-m", "644", tmp, CADDYFILE], {
      stdio: ["ignore", "pipe", "pipe"]
    });
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {}
  }

  log("Caddy validate ediliyor...");
  try {
    execFileSync("sudo", ["caddy", "validate", "--config", CADDYFILE], {
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (err) {
    log("HATA: Caddyfile validation basarisiz");
    return { ok: false, error: err.message };
  }

  log("Caddy reload...");
  try {
    execSync("sudo systemctl reload caddy", { stdio: ["ignore", "pipe", "pipe"] });
  } catch (_) {
    // reload basarisizsa restart dene
    try {
      execSync("sudo systemctl restart caddy", { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  log("Caddy yeniden yuklendi.");
  return { ok: true };
}

// Sertifika gercekten alindi mi diye Let's Encrypt cert'i bekle (uretim icin)
async function waitForCert(domain, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // execFile + arg dizisi: domain shell'e hic ugramaz. Eski komuttaki
    // "2>&1 || true" yerine stderr stdio ile yutuluyor, sifir-disi cikis
    // kodu da catch'te yutuluyor (donguye devam).
    let out = "";
    try {
      out = execFileSync("curl", ["-sI", "--max-time", "5", `https://${domain}/healthz`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      });
    } catch (err) {
      out = (err.stdout || "").toString();
    }
    if (/^HTTP\/[12](\.\d)? 2\d\d/.test(out)) return { ok: true };
    if (/^HTTP\/[12](\.\d)? 3\d\d/.test(out)) return { ok: true }; // redirect to login
    await new Promise((r) => setTimeout(r, 3000));
  }
  return { ok: false, error: "Sertifika dogrulanamadi (timeout)" };
}

module.exports = {
  CADDYFILE,
  isInstalled,
  isActive,
  detectInstallMethod,
  install,
  knownSubdomains,
  buildCaddyfile,
  applyConfig,
  waitForCert
};
