// Sudoers entry generator. Blanket passwordless sudo yerine sadece Lyra'nin
// gerek duydugu komutlara izin veren kisitli bir sudoers dosyasi uretir.
//
// Iki dosya uretir:
//   /etc/sudoers.d/lyra        — KALICI, dar kapsam (asagidaki RULES listesi)
//   /etc/sudoers.d/lyra-setup  — GECICI, kurulum fazi (--setup ile)
//
// Kullanim:
//   sudo node scripts/generate-sudoers.js [--user lyra] [--name lyra] [--out ...]
//   sudo node scripts/generate-sudoers.js --user lyra --setup
//   node scripts/generate-sudoers.js --print

const fs = require("fs");
const os = require("os");
const path = require("path");

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : fallback;
}
const printOnly = args.includes("--print");
const setupMode = args.includes("--setup");
const user = arg("user", os.userInfo().username);
const serviceName = arg("name", "lyra");
const defaultOut = setupMode ? "/etc/sudoers.d/lyra-setup" : "/etc/sudoers.d/lyra";
const out = arg("out", defaultOut);

// Izin verilen komutlar. Wildcard'lar bilerek dar: kaynak VE hedef sabit.
// (Onceki surumde "/usr/bin/cp /etc/cloudflared/config.yml *" vardi — icerigi
// panelden duzenlenebilen bir dosyayi root olarak herhangi bir yola yazmak
// demek, yani pratikte tam root. Artik sadece backup adina yaziliyor.)
const RULES = [
  // --- Port scanner: sudo'lu ss (baska kullanicilarin PID'lerini gormek icin)
  "/usr/sbin/ss -tlnp",
  "/usr/bin/ss -tlnp",
  "/bin/ss -tlnp",

  // --- Cloudflared config oku
  "/usr/bin/cat /etc/cloudflared/config.yml",
  "/bin/cat /etc/cloudflared/config.yml",

  // --- Cloudflared config yedekle / geri yukle (yalnizca .bak.<timestamp>)
  "/usr/bin/cp /etc/cloudflared/config.yml /etc/cloudflared/config.yml.bak.[0-9]*",
  "/bin/cp /etc/cloudflared/config.yml /etc/cloudflared/config.yml.bak.[0-9]*",
  "/usr/bin/cp /etc/cloudflared/config.yml.bak.[0-9]* /etc/cloudflared/config.yml",
  "/bin/cp /etc/cloudflared/config.yml.bak.[0-9]* /etc/cloudflared/config.yml",

  // --- Cloudflared config yaz (kaynak lib/cloudflare.js'in urettigi tmp dosya)
  "/usr/bin/install -m 644 /tmp/cloudflared-config-[0-9]*.yml /etc/cloudflared/config.yml",

  // --- Cloudflared servis kontrol + DNS route
  "/usr/bin/systemctl restart cloudflared",
  "/bin/systemctl restart cloudflared",
  "/usr/local/bin/cloudflared tunnel --origincert /root/.cloudflared/cert.pem route dns *",

  // --- Caddy (public mod): Caddyfile yaz, dogrula, reload
  "/usr/bin/install -m 644 /tmp/Caddyfile.lyra.[0-9]* /etc/caddy/Caddyfile",
  "/usr/bin/caddy validate --config /etc/caddy/Caddyfile",
  "/usr/bin/systemctl reload caddy",
  "/bin/systemctl reload caddy",
  "/usr/bin/systemctl restart caddy",
  "/bin/systemctl restart caddy",

  // --- Firewall durumu (kural yazma kurulum fazinda, lyra-setup ile yapilir)
  "/usr/sbin/ufw status",

  // --- Kurulum modundan cikis: drop-in'i sil, daemon-reload, kendini restart et.
  //     routes/setup.js finalize sonrasi bu uc komutu calistirir.
  `/usr/bin/rm -f /etc/systemd/system/${serviceName}.service.d/setup-mode.conf`,
  `/bin/rm -f /etc/systemd/system/${serviceName}.service.d/setup-mode.conf`,
  "/usr/bin/rm -f /etc/sudoers.d/lyra-setup",
  "/bin/rm -f /etc/sudoers.d/lyra-setup",
  "/usr/bin/systemctl daemon-reload",
  "/bin/systemctl daemon-reload",
  `/usr/bin/systemctl restart ${serviceName}`,
  `/bin/systemctl restart ${serviceName}`
];

function buildPersistent() {
  const header = [
    "# Lyra sudoers entry — auto-generated",
    "# DOSYAYI ELLE DUZENLEME — yeniden uretmek icin:",
    "#   sudo node scripts/generate-sudoers.js --user " + user,
    "# Bu satirlar yalnizca burada listelenen komutlari sifresiz calistirma izni verir.",
    ""
  ];
  const body = RULES.map(cmd => `${user} ALL=(root) NOPASSWD: ${cmd}`);
  return [...header, ...body, ""].join("\n");
}

function buildSetup() {
  return [
    "# Lyra KURULUM sudoers dosyasi — GECICI, tam yetki.",
    "#",
    "# Kurulum fazinda Caddy/cloudflared apt+dpkg ile kurulur, apt kaynak listesi",
    "# ve GPG anahtari yazilir, systemd/firewall degistirilir. Bu islerin komut",
    "# listesiyle daraltilmasi anlamsiz: 'apt-get install *' zaten tam root'tur.",
    "# Bu yuzden kurulum fazi acikca ayricalikli, ve KISA OMURLU tutulur.",
    "#",
    "# Dosyayi kurulum sihirbazi bittiginde Lyra kendisi siler",
    "# (routes/setup.js -> setup-mode-off adimi).",
    "# Kurulum yarida kalirsa elle sil:",
    "#   sudo rm -f " + out,
    "",
    `${user} ALL=(root) NOPASSWD: ALL`,
    ""
  ].join("\n");
}

const content = setupMode ? buildSetup() : buildPersistent();

if (printOnly) {
  process.stdout.write(content);
  process.exit(0);
}

if (process.getuid && process.getuid() !== 0) {
  console.error("Bu script root yetkisi ister. `sudo node scripts/generate-sudoers.js` calistirin.");
  console.error("Veya icerigi gormek icin: node scripts/generate-sudoers.js --print");
  process.exit(1);
}

const dir = path.dirname(out);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o755 });

const tmp = out + ".tmp";
fs.writeFileSync(tmp, content, { mode: 0o440 });

// visudo ile sentaks dogrulamasi
const { execFileSync } = require("child_process");
try {
  execFileSync("visudo", ["-cf", tmp], { stdio: ["ignore", "pipe", "pipe"] });
} catch (err) {
  fs.unlinkSync(tmp);
  console.error("visudo dogrulamasi basarisiz — sudoers dosyasi yazilmadi.");
  console.error(err.stderr ? err.stderr.toString() : err.message);
  process.exit(2);
}

fs.renameSync(tmp, out);
fs.chmodSync(out, 0o440);

console.log(`Yazildi: ${out}`);
console.log(`Kullanici: ${user}`);
console.log(setupMode ? "Kapsam: GECICI tam yetki (kurulum bitince silinir)" : `Komut sayisi: ${RULES.length}`);
