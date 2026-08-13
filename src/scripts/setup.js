// Lyra setup bootstrap — ELLE calistirma yolu.
//
// Onerilen yol install.sh'tir: systemd unit'i kurar, Lyra'yi kurulum modunda
// servis olarak baslatir ve sihirbaz bitince deterministik olarak normal moda
// gecirir. Bu script Lyra'yi on planda baslatir; sihirbazin sonundaki
// "systemctl restart lyra" adimi ancak unit kuruluysa calisir.
//
// Default mode: setup token uretir, sunucuyu setup-mode'da baslatir
// (HTTP port 80, /setup wizard ekrani). Kullanici browser'da bitirir.
//
// Headless yol: --cli flag ile terminal sihirbazi (scripts/setup-cli.js).
// Tarayici sihirbaziyla ayni sorulari sorar ve ayni cekirdegi kullanir
// (lib/setup-core.js) — iki ayri kurulum gercekligi yok.
//
// Kullanim:
//   sudo npm run setup       # browser-based (default, port 80 icin root)
//   npm run setup -- --cli   # terminal sihirbazi (headless)

require("dotenv").config();

const args = process.argv.slice(2);
const useCli = args.includes("--cli");

if (useCli) {
  // Terminal sihirbazi (kendi main()'ini calistirir ve process'i sonlandirir)
  require("./setup-cli");
  return;
}

// Browser-mode bootstrap
const { migrate } = require("../db/migrate");
const { users } = require("../db/repos");
const setupToken = require("../lib/setup-token");
const dnsCheck = require("../lib/dns-check");

async function main() {
  console.log("\n╔═══════════════════════════════════════════════════╗");
  console.log("║          Lyra Kurulum Sihirbazı                    ║");
  console.log("╚═══════════════════════════════════════════════════╝\n");

  // 1. DB hazirla
  console.log("→ Veritabani hazirlaniyor...");
  migrate();

  // 2. Kullanici zaten kurulu mu?
  if (users.exists()) {
    console.log("\n  ⚠ Kurulum daha once tamamlanmis (kullanici mevcut).");
    console.log("    Yeniden kurmak icin:");
    console.log("      sudo systemctl stop lyra   (varsa)");
    console.log("      rm -rf $LYRA_HOME/lyra.db  (DB sil)");
    console.log("      npm run setup\n");
    process.exit(0);
  }

  // 3. Ayricalikli porta bind edebilecek miyiz? EACCES ile yarida olmek yerine
  //    kullaniciya ne yapacagini soyle.
  const wantedPort = parseInt(process.env.LYRA_SETUP_PORT || "80", 10);
  if (wantedPort < 1024 && process.getuid && process.getuid() !== 0) {
    console.error(`\n  ✗ Port ${wantedPort} icin root yetkisi gerekiyor.`);
    console.error("    Sunlardan birini yap:");
    console.error("      sudo npm run setup");
    console.error("      LYRA_SETUP_PORT=8080 npm run setup");
    console.error("    Ya da tam kurulum icin: sudo bash install.sh\n");
    process.exit(1);
  }

  // 4. Setup token uret
  const token = setupToken.generate();
  setupToken.save(token);

  // 5. Sunucu IP'sini bul (kullaniciya gostermek icin)
  const publicIp = await dnsCheck.getPublicIp();
  const localIps = getLocalIps();

  // 6. Setup-mode bilgisini stdout'a bas (renkli, hizali)
  const ESC = String.fromCharCode(27);
  const cyan = (s) => `${ESC}[1;36m${s}${ESC}[0m`;
  const dim = (s) => `${ESC}[2m${s}${ESC}[0m`;

  const setupPort = process.env.LYRA_SETUP_PORT || "80";
  const portSuffix = setupPort === "80" ? "" : `:${setupPort}`;

  console.log("");
  console.log(dim("\u2500".repeat(60)));
  console.log("  Tarayicidan kuruluma devam et:");
  console.log("");
  if (publicIp) console.log(`    ${cyan(`http://${publicIp}${portSuffix}`)}`);
  for (const ip of localIps) console.log(`    ${cyan(`http://${ip}${portSuffix}`)}`);
  console.log("");
  console.log("  Kurulum token'i (browser'a yapistir):");
  console.log("");
  console.log(`    ${cyan(token)}`);
  console.log("");
  console.log(dim("  (Token sadece kurulum icin, 1 saat sonra silinir)"));
  console.log(dim("\u2500".repeat(60)));
  console.log("");
  // 7. setup-mode env flag ile server'i baslat
  process.env.LYRA_SETUP_MODE = "1";
  // Setup port: 80 default (sudo gerekir), env override mumkun
  if (!process.env.LYRA_SETUP_PORT) process.env.LYRA_SETUP_PORT = "80";

  // 8. Server'i baslat (require ile inline, ayri process degil)
  require("../server");
}

function getLocalIps() {
  const os = require("os");
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

main().catch((err) => {
  console.error("\n  ✗ Kurulum hatasi:", err.message);
  process.exit(1);
});
