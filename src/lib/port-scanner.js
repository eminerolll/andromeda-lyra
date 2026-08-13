// Port tarayici. ss kullanir, sudo varsa daha fazla bilgi alir.
// projects_dir DB'den okunur — proje yolunu PID cwd'sinden tespit etmek icin.

const { exec } = require("child_process");
const fs = require("fs");
const config = require("./config");

function scanPorts(callback) {
  exec("sudo -n ss -tlnp 2>/dev/null || ss -tlnp", (err, stdout) => {
    if (err) return callback([]);

    const projectsDir = config.get("projects_dir") || "";
    const lines = stdout.split("\n").slice(1);
    const ports = [];

    for (const line of lines) {
      if (!line.trim()) continue;

      const parts = line.split(/\s+/);
      const localAddr = parts[3] || "";
      const portMatch = localAddr.match(/:(\d+)$/);
      if (!portMatch) continue;

      const port = parseInt(portMatch[1]);
      const pidMatch = line.match(/pid=(\d+)/);
      const nameMatch = line.match(/\("([^"]+)"/);
      const pid = pidMatch ? parseInt(pidMatch[1]) : null;
      const process_name = nameMatch ? nameMatch[1] : "unknown";

      if (ports.find((p) => p.port === port)) continue;

      let project = null;
      let memory = null;

      if (pid) {
        try {
          const cwd = fs.readlinkSync("/proc/" + pid + "/cwd");
          if (projectsDir && cwd.startsWith(projectsDir + "/")) {
            const rest = cwd.slice(projectsDir.length + 1);
            project = rest.split("/")[0];
          }
        } catch (_) {}

        try {
          const status = fs.readFileSync("/proc/" + pid + "/status", "utf8");
          const rssMatch = status.match(/VmRSS:\s+(\d+)\s+kB/);
          if (rssMatch) {
            const mb = Math.round(parseInt(rssMatch[1]) / 1024);
            memory = mb + "MB";
          }
        } catch (_) {}
      }

      let uptime = null;
      if (pid) {
        try {
          const stat = fs.statSync("/proc/" + pid);
          const seconds = Math.floor((Date.now() - stat.ctimeMs) / 1000);
          if (seconds < 60) uptime = seconds + "sn";
          else if (seconds < 3600) uptime = Math.floor(seconds / 60) + "dk";
          else uptime = Math.floor(seconds / 3600) + "sa";
        } catch (_) {}
      }

      ports.push({ port, pid, process: process_name, project, memory, uptime });
    }

    callback(ports);
  });
}

module.exports = { scanPorts };
