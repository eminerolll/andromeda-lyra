// Canli port tarama (REST + WebSocket).
// Sistem portlari + gizlenecek process'ler settings'ten okunur.

const express = require("express");
const { scanPorts } = require("../lib/port-scanner");
const config = require("../lib/config");
const { settings, services } = require("../db/repos");

const router = express.Router();

const DEFAULT_SYSTEM_PORTS = [22, 53, 80, 443, 631];
const DEFAULT_HIDDEN_PROCESSES = [
  "sshd",
  "systemd-resolve",
  "systemd",
  "cloudflared",
  "nginx",
  "cupsd",
  "cups-browsed"
];

const SCAN_INTERVAL = 5000;
let lastPorts = [];
const portClients = new Set();
let scanTimer = null;

function getSystemPorts() {
  const fromSettings = settings.get("system_ports", DEFAULT_SYSTEM_PORTS);
  // Kayitli servislerin portlari runtime'da da korunur: setup oncesi kurulmus
  // sistemlerde system_ports seed edilmemis olabilir, code-server "dev port"
  // gorunup panelden oldurulebiliyordu.
  const servicePorts = services
    .list()
    .map((s) => s.port)
    .filter(Boolean);
  // Lyra'nin kendisi de sistem portu sayilsin
  return [...new Set([...(fromSettings || []), ...servicePorts, config.PORT])];
}

function getHiddenProcesses() {
  return settings.get("hidden_processes", DEFAULT_HIDDEN_PROCESSES) || [];
}

function classify(ports) {
  const sysPorts = new Set(getSystemPorts());
  const hidden = new Set(getHiddenProcesses());
  const isSystem = (p) => sysPorts.has(p.port) || hidden.has(p.process);
  return {
    user: ports.filter((p) => !isSystem(p)),
    system: ports.filter((p) => isSystem(p))
  };
}

router.get("/api/ports", (req, res) => {
  scanPorts((ports) => res.json(classify(ports)));
});

router.post("/api/ports/:port/kill", (req, res) => {
  const port = parseInt(req.params.port);
  const sysPorts = new Set(getSystemPorts());
  if (sysPorts.has(port)) {
    return res.status(403).json({ error: "Sistem portlari durdurulamaz" });
  }
  const hidden = new Set(getHiddenProcesses());
  scanPorts((ports) => {
    const entry = ports.find((p) => p.port === port);
    if (!entry || !entry.pid) return res.status(404).json({ error: "Port bulunamadi" });
    if (hidden.has(entry.process))
      return res.status(403).json({ error: "Sistem servisleri durdurulamaz" });
    try {
      process.kill(entry.pid, "SIGTERM");
      setTimeout(() => {
        try {
          process.kill(entry.pid, "SIGKILL");
        } catch (_) {}
      }, 5000);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
});

function handleConnection(ws) {
  portClients.add(ws);
  scanPorts((ports) => {
    ws.send(JSON.stringify({ event: "update", ...classify(ports) }));
  });
  ws.on("close", () => portClients.delete(ws));
}

function startScanner() {
  if (scanTimer) return;
  scanTimer = setInterval(() => {
    if (portClients.size === 0) return;
    scanPorts((ports) => {
      const json = JSON.stringify(ports);
      const lastJson = JSON.stringify(lastPorts);
      if (json === lastJson) return;
      lastPorts = ports;
      const msg = JSON.stringify({ event: "update", ...classify(ports) });
      for (const client of portClients) {
        if (client.readyState === 1) client.send(msg);
      }
    });
  }, SCAN_INTERVAL);
}

function stopScanner() {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
}

module.exports = router;
module.exports.DEFAULT_SYSTEM_PORTS = DEFAULT_SYSTEM_PORTS;
module.exports.handleConnection = handleConnection;
module.exports.startScanner = startScanner;
module.exports.stopScanner = stopScanner;
