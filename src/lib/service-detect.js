// Sistemde hangi servisler kurulu, hangileri calisiyor — tespit et.
// systemctl + komut bulma kombinasyonu.

const { execSync } = require("child_process");

const KNOWN_SERVICES = [
  {
    type: "code-server",
    unit_candidates: ["code-server", "code-server@", "code-server.service"],
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
    description: "Public access via Cloudflare"
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

function tryExec(cmd) {
  try {
    return { ok: true, out: execSync(cmd, { stdio: ["pipe", "pipe", "pipe"], timeout: 3000 }).toString().trim() };
  } catch (err) {
    return { ok: false, out: (err.stdout || "").toString().trim(), err: err.message };
  }
}

function commandExists(name) {
  return tryExec(`command -v ${name}`).ok;
}

function unitExists(unit) {
  const r = tryExec(`systemctl list-unit-files ${unit}.service --no-legend 2>/dev/null`);
  return r.ok && r.out.length > 0;
}

function unitActive(unit) {
  const r = tryExec(`systemctl is-active ${unit} 2>/dev/null`);
  return r.out === "active";
}

function findUnit(candidates) {
  for (const c of candidates) {
    if (unitExists(c)) return c;
  }
  return null;
}

function detectAll() {
  return KNOWN_SERVICES.map(svc => {
    const unit = findUnit(svc.unit_candidates);
    const binary_present = commandExists(svc.binary);
    const active = unit ? unitActive(unit) : false;
    return {
      type: svc.type,
      display_name: svc.display_name,
      description: svc.description,
      unit_name: unit,
      binary_present,
      installed: !!unit || binary_present,
      active,
      default_port: svc.default_port
    };
  });
}

function detectInstalled() {
  return detectAll().filter(s => s.installed);
}

module.exports = { detectAll, detectInstalled, KNOWN_SERVICES };
