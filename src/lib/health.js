// Sistem ve servis saglik bilgisi. Settings > Genel altinda gosterilir.

const os = require("os");
const fs = require("fs");
const { execFileSync } = require("child_process");
const config = require("./config");
const { services } = require("../db/repos");

function getLyraVersion() {
  try {
    const pkg = require("../package.json");
    return pkg.version || "0.0.0";
  } catch (_) {
    return "unknown";
  }
}

function getNodeMemoryMB() {
  const m = process.memoryUsage();
  return {
    rss: Math.round(m.rss / 1024 / 1024),
    heapUsed: Math.round(m.heapUsed / 1024 / 1024),
    heapTotal: Math.round(m.heapTotal / 1024 / 1024)
  };
}

function getServiceStatus(unitName) {
  if (!unitName) return null;
  // unit adi DB'den (admin girdisi) geliyor: execFile + arg dizisi ile
  // shell'e hic ugramiyor. Eski "2>/dev/null" yerine stderr stdio'da yutuluyor.
  try {
    const out = execFileSync("systemctl", ["is-active", unitName], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000
    })
      .toString()
      .trim();
    return out || "unknown";
  } catch (e) {
    const out = ((e.stdout || "").toString() || "").trim();
    return out || null;
  }
}

function summary() {
  const dbPath = config.LYRA_HOME ? config.LYRA_HOME + "/lyra.db" : null;
  let dbSize = null;
  try {
    if (dbPath && fs.existsSync(dbPath)) {
      const stat = fs.statSync(dbPath);
      dbSize = Math.round(stat.size / 1024); // KB
    }
  } catch (_) {}

  const lyraServiceName = require("../db/repos/settings").get("lyra_service_name") || "lyra";

  // Kayitli servislerin systemd durumlari
  const serviceStates = services.list({ enabledOnly: true }).map((s) => ({
    type: s.type,
    unit_name: s.unit_name,
    display_name: s.display_name,
    port: s.port,
    status: getServiceStatus(s.unit_name)
  }));

  // Onemli yardimci servisler (caddy, cloudflared)
  const auxServices = ["caddy", "cloudflared"]
    .map((unit) => ({
      unit_name: unit,
      display_name: unit,
      status: getServiceStatus(unit)
    }))
    .filter((s) => s.status !== null);

  return {
    lyra: {
      version: getLyraVersion(),
      uptime: Math.floor(process.uptime()),
      pid: process.pid,
      nodeVersion: process.version,
      memory: getNodeMemoryMB(),
      dbSizeKb: dbSize,
      serviceName: lyraServiceName,
      serviceStatus: getServiceStatus(lyraServiceName)
    },
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      cpuCount: os.cpus().length,
      loadAvg: os.loadavg().map((n) => Math.round(n * 100) / 100),
      totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
      freeMemMb: Math.round(os.freemem() / 1024 / 1024),
      uptimeSec: Math.floor(os.uptime())
    },
    services: serviceStates,
    auxServices
  };
}

module.exports = { summary, getServiceStatus, getLyraVersion };
