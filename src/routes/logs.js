// Servis loglari (journalctl stream). Servis listesi DB'den okunur,
// eklenmis "core" servis: lyra'nin kendisi (settings.lyra_service_name varsa).

const express = require("express");
const { spawn, execFileSync } = require("child_process");
const readline = require("readline");
const config = require("../lib/config");
const { services, settings } = require("../db/repos");

const router = express.Router();

const MAX_CONCURRENT_STREAMS = 3;
const MAX_LINE_LENGTH = 10 * 1024;
let activeStreams = 0;

function listSources() {
  // Servis tablosundaki enabled olanlar + opsiyonel core unit
  const out = [];
  const lyraUnit = settings.get("lyra_service_name", null);
  if (lyraUnit) {
    out.push({ name: lyraUnit, description: config.get("app_name") || "Lyra" });
  }
  for (const s of services.list({ enabledOnly: true })) {
    if (s.unit_name) out.push({ name: s.unit_name, description: s.display_name });
  }
  // ssh genelde ayri istenir; opsiyonel olarak da ekle
  out.push({ name: "ssh", description: "OpenSSH server" });
  return out;
}

function getServiceStatus(name) {
  // name db'den (admin girdisi) geliyor: execFile + arg dizisi ile shell'e
  // hic ugramiyor. "is-active" inactive unit'ler icin sifir olmayan cikis kodu
  // dondurur ama durumu yine de stdout'a basar; bu davranis e.stdout ile
  // korunuyor (asagida).
  let stdout = "",
    stderr = "";
  try {
    stdout = execFileSync("systemctl", ["is-active", name], {
      stdio: ["ignore", "pipe", "pipe"]
    })
      .toString()
      .trim();
  } catch (e) {
    stdout = ((e.stdout || "").toString() || "").trim();
    stderr = ((e.stderr || "").toString() || "").trim();
  }
  if (!stdout && (stderr.includes("not-found") || stderr.includes("could not be found")))
    return null;
  if (!stdout) {
    try {
      // eski "2>/dev/null" yerine stderr stdio'da yutuluyor.
      const list = execFileSync(
        "systemctl",
        ["list-unit-files", name + ".service", "--no-legend"],
        {
          stdio: ["ignore", "pipe", "ignore"]
        }
      )
        .toString()
        .trim();
      if (!list) return null;
    } catch (_) {
      return null;
    }
    return "inactive";
  }
  return stdout;
}

router.get("/api/logs/sources", (req, res) => {
  const out = [];
  const seen = new Set();
  for (const svc of listSources()) {
    if (seen.has(svc.name)) continue;
    seen.add(svc.name);
    const status = getServiceStatus(svc.name);
    if (status === null) continue;
    out.push({ name: svc.name, description: svc.description, status });
  }
  res.json(out);
});

function isAllowedSource(name) {
  return listSources().some((s) => s.name === name);
}

function handleConnection(ws, req) {
  const url = new URL(req.url, "http://localhost");
  const source = url.searchParams.get("source");

  if (!source || !isAllowedSource(source)) {
    ws.send(JSON.stringify({ type: "error", message: "Gecersiz kaynak" }));
    return ws.close();
  }
  if (activeStreams >= MAX_CONCURRENT_STREAMS) {
    ws.send(
      JSON.stringify({
        type: "error",
        message: "Maksimum " + MAX_CONCURRENT_STREAMS + " log stream acik olabilir"
      })
    );
    return ws.close();
  }

  activeStreams++;

  const proc = spawn("journalctl", [
    "-u",
    source,
    "-n",
    "200",
    "-f",
    "--output=short-iso",
    "--no-pager"
  ]);

  const rlOut = readline.createInterface({ input: proc.stdout });
  rlOut.on("line", (line) => {
    if (ws.readyState !== 1) return;
    const text = line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + "..." : line;
    ws.send(JSON.stringify({ type: "line", text }));
  });

  const rlErr = readline.createInterface({ input: proc.stderr });
  rlErr.on("line", (line) => {
    if (ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: "error", message: line }));
  });

  proc.on("close", (code) => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "closed", code }));
      ws.close();
    }
    activeStreams = Math.max(0, activeStreams - 1);
  });

  proc.on("error", (err) => {
    if (ws.readyState === 1) {
      ws.send(
        JSON.stringify({ type: "error", message: "journalctl baslatilamadi: " + err.message })
      );
      ws.close();
    }
  });

  let killed = false;
  const cleanup = () => {
    if (killed) return;
    killed = true;
    try {
      proc.kill("SIGTERM");
    } catch (_) {}
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch (_) {}
    }, 5000);
  };
  ws.on("close", cleanup);
  ws.on("error", cleanup);
}

module.exports = router;
module.exports.handleConnection = handleConnection;
module.exports.getServiceStatus = getServiceStatus;
