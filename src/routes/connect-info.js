// SSH tunnel "Connect from another device" UX panel'i icin endpoint.
// Localhost modunda dashboard ust kismindaki kartin verisini doner.

const express = require("express");
const os = require("os");
const { execSync } = require("child_process");
const config = require("../lib/config");
const dnsCheck = require("../lib/dns-check");

const router = express.Router();

// /api/connect-info — sunucu erisim bilgileri (auth gerektirir, server.js'te mount)
router.get("/api/connect-info", async (req, res) => {
  const accessMode = config.get("access_mode") || "localhost";
  const bindAddr = config.get("bind_address") || "127.0.0.1";
  const port = config.PORT;

  const info = {
    accessMode,
    bindAddress: bindAddr,
    port,
    hostname: os.hostname(),
    sshUser: process.env.USER || os.userInfo().username,
    sshPort: 22,
    publicIp: null,
    lanIps: getLanIps(),
    sshCommand: null,
    finalUrls: []
  };

  // SSH portunu sshd'den al
  try {
    const sshConfig = execSync("ss -tlnp 2>/dev/null | grep ':22\\b'", {
      stdio: ["ignore", "pipe", "ignore"]
    }).toString();
    if (sshConfig) info.sshPort = 22;
    // Custom SSH portu varsa baska turlu tespit edilir, simdilik 22 default
  } catch (_) {}

  // Public IP (asenkron)
  try {
    info.publicIp = await dnsCheck.getPublicIp();
  } catch (_) {}

  // SSH komutunu uret (localhost mod icin)
  if (accessMode === "localhost" || bindAddr === "127.0.0.1") {
    const targetIp = info.publicIp || info.lanIps[0] || "<sunucu-ip>";
    info.sshCommand = `ssh -L ${port}:127.0.0.1:${port} -p ${info.sshPort} ${info.sshUser}@${targetIp}`;
    info.finalUrls = [`http://localhost:${port}`];
  } else if (bindAddr === "0.0.0.0") {
    // LAN modu
    info.finalUrls = info.lanIps.map((ip) => `http://${ip}:${port}`);
    if (info.publicIp) info.finalUrls.push(`http://${info.publicIp}:${port}`);
  } else if (config.get("public_access") && config.get("base_domain")) {
    info.finalUrls = [`https://${config.get("base_domain")}`];
  }

  res.json(info);
});

function getLanIps() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

module.exports = router;
