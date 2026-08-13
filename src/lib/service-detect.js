// Sistemde hangi servisler kurulu, hangileri calisiyor — tespit et.
// Ayrica: kurulu DEGILSE Lyra onu kurabilir mi? (bkz. lib/service-installer.js)
//
// Sihirbaz bu iki bilgiyi birlikte kullanir: kurulu olan "kayitli" olur,
// kurulu olmayan ama kurulabilen "kurulacak" olur, kurulamayan ise SEBEBIYLE
// birlikte devre disi gorunur.
//
// Komutlar execFile + arguman dizisi ile calisir; shell'e hicbir deger
// string olarak gecmez.

const os = require("os");
const { execFileSync } = require("child_process");
const installer = require("./service-installer");

const KNOWN_SERVICES = [
  {
    type: "code-server",
    unit_candidates: ["code-server"],
    // code-server systemd sablonu ornek unit ile calisir: code-server@<user>.
    unit_instance: (user) => `code-server@${user}`,
    binary: "code-server",
    default_port: 8080,
    display_name: "Code Server",
    description: "VS Code IDE in browser"
  },
  {
    type: "cloudflared",
    unit_candidates: ["cloudflared"],
    binary: "cloudflared",
    default_port: null,
    display_name: "Cloudflare Tunnel",
    description: "Public access via Cloudflare",
    // Erisim modu adiminda kuruluyor; servis listesinden kurulmaz.
    install_note: "Erisim modu adiminda kuruluyor."
  },
  {
    type: "filebrowser",
    unit_candidates: ["filebrowser", "filebrowser-quantum"],
    binary: "filebrowser",
    default_port: 8082,
    display_name: "Filebrowser",
    description: "Web file manager"
  },
  {
    type: "dbgate",
    unit_candidates: ["dbgate"],
    binary: "dbgate",
    default_port: 8081,
    display_name: "DbGate",
    description: "Database management UI"
  },
  {
    type: "mongod",
    unit_candidates: ["mongod"],
    binary: "mongod",
    default_port: 27017,
    display_name: "MongoDB",
    description: "MongoDB server"
  }
];

function systemctl(args) {
  try {
    return {
      ok: true,
      out: execFileSync("systemctl", args, {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000
      })
        .toString()
        .trim()
    };
  } catch (err) {
    return { ok: false, out: ((err.stdout || "").toString() || "").trim() };
  }
}

function commandExists(name) {
  return !!installer.resolveBinary(name);
}

function unitExists(unit) {
  const r = systemctl(["list-unit-files", `${unit}.service`, "--no-legend"]);
  return r.ok && r.out.length > 0;
}

// Ornek unit'ler (code-server@ubuntu) list-unit-files ciktisinda her zaman
// gorunmez; "systemctl cat" sablondan uretir.
function instanceUnitExists(unit) {
  return systemctl(["cat", unit]).ok;
}

function unitActive(unit) {
  return systemctl(["is-active", unit]).out === "active";
}

function currentUser() {
  try {
    return os.userInfo().username;
  } catch (_) {
    return process.env.SUDO_USER || process.env.USER || "root";
  }
}

function findUnit(svc, user) {
  if (svc.unit_instance) {
    const inst = svc.unit_instance(user);
    if (instanceUnitExists(inst)) return inst;
  }
  for (const c of svc.unit_candidates) {
    if (unitExists(c)) return c;
  }
  return null;
}

function detectAll() {
  const user = currentUser();
  return KNOWN_SERVICES.map((svc) => {
    const unit = findUnit(svc, user);
    const binary_present = commandExists(svc.binary);
    const active = unit ? unitActive(unit) : false;
    const installed = !!unit || binary_present;
    // Kurulabilirlik: mimari + gereksinimler. "Zaten kurulu" bilgisinden
    // BAGIMSIZ — cagiran ikisini birlikte degerlendirir (bkz. setup-core
    // servicesToInstall: kurulu olan tekrar kurulmaz).
    const inst = installer.installability(svc.type);
    const reason = svc.install_note || inst.reason;
    return {
      type: svc.type,
      display_name: svc.display_name,
      description: svc.description,
      unit_name: unit,
      binary_present,
      installed,
      active,
      default_port: svc.default_port,
      // Kurulum bilgileri
      installable: svc.install_note ? false : inst.installable,
      arch_supported: inst.arch_supported,
      requires: inst.requires,
      missing_requirements: inst.missing,
      install_reason: svc.install_note ? svc.install_note : installed ? null : reason,
      est_ram_mb: inst.est_ram_mb,
      est_disk_mb: inst.est_disk_mb,
      default_selected: inst.default_selected,
      install_source: inst.source || null
    };
  });
}

function detectInstalled() {
  return detectAll().filter((s) => s.installed);
}

module.exports = { detectAll, detectInstalled, KNOWN_SERVICES };
