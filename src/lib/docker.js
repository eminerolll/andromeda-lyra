// Docker yardimcilari. prod_apps_dir DB'den; ayar yoksa endpoint'ler "disabled" doner.

const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const config = require("./config");

function prodDir() {
  return config.get("prod_apps_dir"); // null ise docker projeleri devre disi
}

function run(cmd, cb) {
  exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => cb(err, stdout, stderr));
}

function dockerAvailable(cb) {
  run("docker version --format '{{.Server.Version}}'", (err, stdout) => cb(!err, stdout.trim()));
}

function listContainers(cb) {
  run("docker ps -a --format '{{json .}}'", (err, stdout) => {
    if (err) return cb(err, []);
    const containers = stdout
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean)
      .map((c) => ({
        id: c.ID,
        name: c.Names,
        image: c.Image,
        status: c.Status,
        state: c.State,
        ports: c.Ports,
        created: c.CreatedAt,
        project: c.Labels ? parseComposeProject(c.Labels) : null
      }));
    cb(null, containers);
  });
}

function parseComposeProject(labels) {
  const m = labels.match(/com\.docker\.compose\.project=([^,]+)/);
  return m ? m[1] : null;
}

function containerStats(cb) {
  run("docker stats --no-stream --format '{{json .}}'", (err, stdout) => {
    if (err) return cb(err, []);
    const stats = stdout
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean)
      .map((s) => ({
        id: s.ID,
        name: s.Name,
        cpu: s.CPUPerc,
        mem: s.MemUsage,
        memPerc: s.MemPerc,
        netIO: s.NetIO
      }));
    cb(null, stats);
  });
}

function findComposeFile(dir) {
  const defaults = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
  for (const f of defaults) if (fs.existsSync(path.join(dir, f))) return f;
  try {
    const entries = fs.readdirSync(dir);
    const prodFirst = entries.filter((f) => /^(docker-)?compose\.prod\.ya?ml$/i.test(f));
    if (prodFirst.length) return prodFirst[0];
    const any = entries.filter((f) => /^(docker-)?compose\..+\.ya?ml$/i.test(f));
    if (any.length) return any[0];
  } catch (_) {}
  return null;
}

function listProdProjects(cb) {
  const dir = prodDir();
  if (!dir) return cb(null, []);
  fs.readdir(dir, { withFileTypes: true }, (err, entries) => {
    if (err) {
      if (err.code === "ENOENT") return cb(null, []);
      return cb(err, []);
    }
    const projects = entries
      .filter((e) => e.isDirectory())
      .map((e) => {
        const sub = path.join(dir, e.name);
        const composeFile = findComposeFile(sub);
        const hasDockerfile = fs.existsSync(path.join(sub, "Dockerfile"));
        return { name: e.name, path: sub, composeFile, hasCompose: !!composeFile, hasDockerfile };
      });
    cb(null, projects);
  });
}

function containerAction(id, action, cb) {
  const allowed = ["start", "stop", "restart"];
  if (!allowed.includes(action)) return cb(new Error("Gecersiz islem"));
  if (!/^[a-zA-Z0-9_.-]+$/.test(id)) return cb(new Error("Gecersiz container id"));
  run("docker " + action + " " + id, cb);
}

function containerLogs(id, tail, cb) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(id)) return cb(new Error("Gecersiz container id"));
  const n = parseInt(tail) || 200;
  run("docker logs --tail " + n + " " + id + " 2>&1", cb);
}

function composeFileFlag(dir) {
  const cf = findComposeFile(dir);
  if (!cf) return null;
  const defaults = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
  return defaults.includes(cf) ? "" : " -f " + cf;
}

function composeAction(project, action, cb) {
  const dir = prodDir();
  if (!dir) return cb(new Error("prod_apps_dir ayarlanmamis"));
  const allowed = ["up", "down", "build", "pull", "restart"];
  if (!allowed.includes(action)) return cb(new Error("Gecersiz islem"));
  if (!/^[a-zA-Z0-9_.-]+$/.test(project)) return cb(new Error("Gecersiz proje adi"));
  const sub = path.join(dir, project);
  if (!fs.existsSync(sub)) return cb(new Error("Proje bulunamadi"));
  const flag = composeFileFlag(sub);
  if (flag === null) return cb(new Error("Compose dosyasi bulunamadi"));
  const cmd =
    action === "up"
      ? "up -d --build"
      : action === "down"
        ? "down"
        : action === "build"
          ? "build"
          : action === "pull"
            ? "pull"
            : "restart";
  run("cd " + sub + " && docker compose" + flag + " " + cmd + " 2>&1", cb);
}

function composeLogs(project, tail, cb) {
  const dir = prodDir();
  if (!dir) return cb(new Error("prod_apps_dir ayarlanmamis"));
  if (!/^[a-zA-Z0-9_.-]+$/.test(project)) return cb(new Error("Gecersiz proje adi"));
  const sub = path.join(dir, project);
  if (!fs.existsSync(sub)) return cb(new Error("Proje bulunamadi"));
  const flag = composeFileFlag(sub);
  if (flag === null) return cb(new Error("Compose dosyasi bulunamadi"));
  const n = parseInt(tail) || 200;
  run("cd " + sub + " && docker compose" + flag + " logs --tail " + n + " 2>&1", cb);
}

module.exports = {
  prodDir,
  listContainers,
  containerStats,
  listProdProjects,
  containerAction,
  containerLogs,
  composeAction,
  composeLogs,
  dockerAvailable
};
