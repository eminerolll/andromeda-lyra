// Sistem bilgisi: CPU/sicaklik/RAM/disk/uptime/GPU.

const express = require("express");
const os = require("os");
const fs = require("fs");
const { execFileSync } = require("child_process");
const config = require("../lib/config");

const router = express.Router();

function readCpuTemp() {
  try {
    const zonesDir = "/sys/class/thermal";
    const zones = fs.readdirSync(zonesDir).filter(n => n.startsWith("thermal_zone"));
    let chosen = null;
    for (const z of zones) {
      try {
        const type = fs.readFileSync(`${zonesDir}/${z}/type`, "utf8").trim();
        if (/x86_pkg_temp|coretemp|cpu/i.test(type)) {
          chosen = z;
          break;
        }
      } catch (_) {}
    }
    chosen = chosen || "thermal_zone0";
    const raw = fs.readFileSync(`${zonesDir}/${chosen}/temp`, "utf8");
    return (parseInt(raw) / 1000).toFixed(1);
  } catch {
    return null;
  }
}

function readDf(mountPath) {
  try {
    const out = execFileSync("df", ["-h", mountPath], {
      stdio: ["pipe", "pipe", "ignore"]
    }).toString().trim();
    const lastLine = out.split("\n").pop();
    const parts = lastLine.split(/\s+/);
    return { total: parts[1], used: parts[2], available: parts[3], percent: parts[4] };
  } catch {
    return null;
  }
}

function readGpu() {
  try {
    const out = execFileSync("nvidia-smi", [
      "--query-gpu=name,temperature.gpu,memory.used,memory.total,utilization.gpu",
      "--format=csv,noheader,nounits"
    ], {
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 3000
    }).toString().trim();
    const firstLine = out.split("\n")[0];
    const [name, temp, memUsed, memTotal, util] = firstLine.split(",").map(s => s.trim());
    return {
      name: (name || "GPU").replace(/^NVIDIA\s+GeForce\s+/, ""),
      temp: temp ? temp + "°C" : "?",
      memUsed: memUsed ? parseInt(memUsed) : 0,
      memTotal: memTotal ? parseInt(memTotal) : 0,
      util: util ? util + "%" : "?"
    };
  } catch {
    return null;
  }
}

router.get("/api/system", (req, res) => {
  try {
    const cpuTemp = readCpuTemp();
    const uptime = os.uptime();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const loadAvg = os.loadavg();

    const diskInfo = readDf("/") || {};
    const secondaryPath = config.get("secondary_disk");
    const secondaryDisk = secondaryPath ? readDf(secondaryPath) : null;
    const gpu = readGpu();

    res.json({
      hostname: os.hostname(),
      cpuTemp: cpuTemp !== null ? cpuTemp + "°C" : null,
      uptime: Math.floor(uptime / 3600) + "s " + Math.floor((uptime % 3600) / 60) + "dk",
      memory: {
        total: (totalMem / 1024 / 1024 / 1024).toFixed(1) + " GB",
        used: ((totalMem - freeMem) / 1024 / 1024 / 1024).toFixed(1) + " GB",
        percent: (((totalMem - freeMem) / totalMem) * 100).toFixed(0) + "%"
      },
      disk: diskInfo,
      secondaryDisk,
      secondaryDiskPath: secondaryPath,
      loadAvg: loadAvg.map(l => l.toFixed(2)),
      cpuCores: os.cpus().length,
      gpu
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
