// Lyra icin systemd unit dosyasi uretici.
//
// Kullanim:
//   sudo node scripts/generate-systemd.js \
//        --user lyra --workdir /opt/lyra/src \
//        --home /var/lib/lyra --port 3000 --projects-dir /home/lyra/projects
//   node scripts/generate-systemd.js --print
//
// Unit adi "lyra" sabittir (routes/setup.js ve settings.lyra_service_name ayni
// adi kullanir). --name ile degistirilirse cagiranin o ayari da guncellemesi
// gerekir.

const fs = require("fs");
const os = require("os");
const path = require("path");

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : fallback;
}
const printOnly = args.includes("--print");
const user = arg("user", os.userInfo().username);
const workdir = path.resolve(arg("workdir", path.resolve(__dirname, "..")));
const serviceName = arg("name", "lyra");
const lyraHome = arg("home", process.env.LYRA_HOME || "/var/lib/lyra");
const lyraPort = arg("port", process.env.LYRA_PORT || "3000");
const projectsDir = arg("projects-dir", path.join("/home", user, "projects"));
// Bu scripti calistiran node — "command -v node" PATH'e bagimli, sudo altinda
// farkli cikabiliyordu.
const nodePath = arg("node", process.execPath);
const out = arg("out", `/etc/systemd/system/${serviceName}.service`);

const unit = `# Lyra service — auto-generated
# DOSYAYI ELLE DUZENLEME — yeniden uretmek icin:
#   sudo node ${path.join(workdir, "scripts", "generate-systemd.js")} --user ${user} --workdir ${workdir}
# Kurulum modu drop-in'i: /etc/systemd/system/${serviceName}.service.d/setup-mode.conf

[Unit]
Description=Lyra developer environment launcher
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${workdir}
ExecStart=${nodePath} ${path.join(workdir, "server.js")}
Restart=on-failure
RestartSec=5

# Bootstrap ayarlari. src/.env de ayni degerleri tasir; systemd'nin verdigi
# degerler oncelikli (dotenv mevcut env'i ezmez).
Environment=NODE_ENV=production
Environment=LYRA_HOME=${lyraHome}
Environment=LYRA_PORT=${lyraPort}

# Loglama systemd journal'a
StandardOutput=journal
StandardError=journal

# Guvenlik sertlestirmesi — asagidaki ikisi BILEREK yok:
#   ProtectHome=       : Lyra projeler dizinine repo klonlar, commit atar,
#                        .env ve not dosyasi yazar. Home read-only olursa
#                        panelin yarisi calismaz.
#   NoNewPrivileges=   : port tarayici ve reverse proxy yonetimi
#                        /etc/sudoers.d/${serviceName} ile kisitlanmis sudo cagirir;
#                        setuid sudo NoNewPrivileges altinda calismaz.
ProtectSystem=full
PrivateTmp=yes
# ProtectSystem=full /etc'yi read-only yapar; Caddy/cloudflared config'lerini
# Lyra yazabilmeli. "-" oneki: dizin yoksa unit yine de baslar.
ReadWritePaths=-${lyraHome}
ReadWritePaths=-${projectsDir}
ReadWritePaths=-/etc/caddy
ReadWritePaths=-/etc/cloudflared

[Install]
WantedBy=multi-user.target
`;

if (printOnly) {
  process.stdout.write(unit);
  process.exit(0);
}

if (process.getuid && process.getuid() !== 0) {
  console.error("Bu script root yetkisi ister. `sudo node scripts/generate-systemd.js` calistirin.");
  console.error("Icerigi gormek icin: node scripts/generate-systemd.js --print");
  process.exit(1);
}

const dir = path.dirname(out);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
fs.writeFileSync(out, unit, { mode: 0o644 });
console.log(`Yazildi: ${out}`);
console.log(`Etkinlestirmek icin:`);
console.log(`  sudo systemctl daemon-reload`);
console.log(`  sudo systemctl enable --now ${serviceName}`);
