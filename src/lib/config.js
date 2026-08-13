// Bootstrap config: .env'den paths/port, DB'den runtime ayarlar.
// Lyra calisirken bu modul tek dogru kaynaktir.

require("dotenv").config();
const path = require("path");
const { settings } = require("../db/repos");

const LYRA_HOME = path.resolve(process.env.LYRA_HOME || "./data");
const PORT = parseInt(process.env.LYRA_PORT || "3000", 10);
const NODE_ENV = process.env.NODE_ENV || "production";

// Default degerler. Setup wizard bunlari override eder.
// Bu degerler runtime'da DB'den okunur, yoksa fallback.
const DEFAULTS = {
  app_name: "Andromeda",
  // Bind address. Uc deger:
  //   "127.0.0.1" — sadece localhost (SSH tunnel ile eris)
  //   "0.0.0.0"   — LAN'daki tum makineler erisebilir
  //   ozel IP    — sadece o IP'den erisim (gelismis)
  bind_address: "127.0.0.1",
  base_domain: null, // ornek: "example.com"; null => LAN-only
  // Panelin kendisinin durdugu host. Genelde base_domain ile ayni; Cloudflare
  // API modunda apex baskasinin kaydiyla doluysa "lyra.example.com" olabilir.
  panel_host: null,
  public_access: false, // true ise BASE_DOMAIN gerekli (reverse proxy ile)
  subdomain_code: "code", // code-server icin
  subdomain_files: "files",
  subdomain_db: "db",
  subdomain_dev_pattern: "dev-{port}", // dev server preview
  projects_dir: path.join(process.env.HOME || "/home", "projeler"),
  secondary_disk: null, // ornek: "/mnt/data"
  prod_apps_dir: null, // ornek: "/opt/prod-apps"
  session_ttl_days: 30,
  rate_limit_attempts: 5,
  rate_limit_window_minutes: 15,
  auto_ban_after: 3, // n hatali login denemesi
  // Kimlik tasimayan /api/* ve WS 401'leri icin ayri (ve yuksek) esik.
  // Dashboard acilista birden fazla API cagirisi yapar; suresi dolmus
  // oturumu olan iyi niyetli kullanici tek sayfa yuklemesinde banlanmamali.
  auto_ban_api_after: 15,
  auto_ban_window_minutes: 10,
  auto_ban_duration_minutes: 60
};

function get(key) {
  const v = settings.get(key, undefined);
  if (v !== undefined && v !== null) return v;
  return DEFAULTS[key] !== undefined ? DEFAULTS[key] : null;
}

function set(key, value) {
  settings.set(key, value);
}

function snapshot() {
  // Tum mevcut + default degerleri birlestir
  const all = settings.getAll();
  const out = { ...DEFAULTS, ...all };
  return out;
}

// Public erisim icin gerekli ayarlar tam mi?
function isPublicAccessReady() {
  if (!get("public_access")) return false;
  return !!get("base_domain");
}

// Setup tamamlandi mi? (admin user var, base ayarlar yapilmis)
function isSetupComplete() {
  const { users } = require("../db/repos");
  return users.exists();
}

// Subdomain pattern -> hostname uretici
// type: "code" | "files" | "db" | "dev"
// portForDev: dev tipinde gerekli
function buildHostname(type, portForDev = null) {
  const base = get("base_domain");
  if (!base) return null;
  if (type === "code") return `${get("subdomain_code")}.${base}`;
  if (type === "files") return `${get("subdomain_files")}.${base}`;
  if (type === "db") return `${get("subdomain_db")}.${base}`;
  if (type === "dev") {
    const pat = get("subdomain_dev_pattern") || "dev-{port}";
    return `${pat.replace("{port}", String(portForDev))}.${base}`;
  }
  return null;
}

// Hostname -> { type, port? } eslestirmesi (reverse proxy icin)
function parseHostname(host) {
  const base = get("base_domain");
  if (!base || !host) return null;
  if (!host.endsWith("." + base)) return null;
  const sub = host.slice(0, host.length - base.length - 1);

  const codeSub = get("subdomain_code");
  const filesSub = get("subdomain_files");
  const dbSub = get("subdomain_db");
  const devPat = get("subdomain_dev_pattern") || "dev-{port}";
  const devRe = new RegExp("^" + devPat.replace("{port}", "(\\d+)") + "$");

  if (sub === codeSub) return { type: "code" };
  if (sub === filesSub) return { type: "files" };
  if (sub === dbSub) return { type: "db" };
  const m = sub.match(devRe);
  if (m) return { type: "dev", port: parseInt(m[1], 10) };
  return null;
}

module.exports = {
  LYRA_HOME,
  PORT,
  NODE_ENV,
  DEFAULTS,
  get,
  set,
  snapshot,
  isPublicAccessReady,
  isSetupComplete,
  buildHostname,
  parseHostname
};
