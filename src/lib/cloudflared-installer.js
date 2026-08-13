// Cloudflare Tunnel — connector token yontemi. Kullanici CF dashboard'da
// tunnel olusturup hostname'leri ekler, sadece token'i Lyra'ya verir.
// Lyra cloudflared'i kurar + token ile baslatir. Tunnel state CF'te.

const { execSync } = require("child_process");
const fs = require("fs");

function isInstalled() {
  try {
    execSync("command -v cloudflared", { stdio: "ignore" });
    return true;
  } catch (_) {
    return false;
  }
}

function getVersion() {
  try {
    return execSync("cloudflared --version 2>&1", { encoding: "utf8" }).trim();
  } catch (_) {
    return null;
  }
}

// cloudflared'i official .deb'den kur. Sudo gerekir.
async function install({ onLog }) {
  const log = onLog || (() => {});

  if (isInstalled()) {
    log("cloudflared zaten kurulu, kurulum atlandi.");
    return { ok: true, alreadyInstalled: true };
  }

  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}.deb`;
  const tmp = `/tmp/cloudflared-${Date.now()}.deb`;

  log(`cloudflared indiriliyor (${arch})...`);
  try {
    execSync(`curl -fsSL -o ${tmp} ${url}`, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    return { ok: false, error: `Indirme basarisiz: ${err.message}` };
  }

  log("cloudflared kuruluyor...");
  try {
    execSync(`sudo dpkg -i ${tmp}`, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    return { ok: false, error: `Kurulum basarisiz: ${err.message}` };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {}
  }

  log(`cloudflared kuruldu: ${getVersion() || "version unknown"}`);
  return { ok: true };
}

// Connector token ile cloudflared servisini install et + start.
// Token CF dashboard'da tunnel olusturulurken alinir.
async function installService({ token, onLog }) {
  const log = onLog || (() => {});
  if (!token || token.length < 50) {
    return { ok: false, error: "Gecersiz connector token" };
  }

  log("cloudflared servisi olusturuluyor...");
  // Token bir kimlik bilgisidir: tunnel'a tam erisim verir. sudo calistirdigi
  // komutu argv'siyle birlikte journald'a yazar, yani token'i dogrudan
  // "sudo cloudflared service install <TOKEN>" seklinde vermek onu sistem
  // log'una KALICI olarak duz metin yazar. Bunun yerine sudo'ya sabit bir
  // shell komutu veriyoruz ve token'i stdin'den geciriyoruz; journal'da
  // yalnizca asagidaki script metni kalir.
  //
  // BILINEN SINIRLAMA: "cloudflared service install" token'i argv disinda
  // kabul etmiyor (--token-file bu alt komutta tanimsiz; TUNNEL_TOKEN /
  // TUNNEL_TOKEN_FILE env ve config.yml "token:" anahtari da yok sayiliyor —
  // cloudflared 2026.7.3 ile dogrulandi). Bu yuzden token, komut calistigi
  // birkac saniye boyunca cloudflared'in kendi argv'sinde, yani "ps"
  // ciktisinda gorunur. Kalici journal sizintisi giderildi, gecici ps
  // gorunurlugu duruyor. Bkz. SECURITY.md.
  const privScript =
    'IFS= read -r LYRA_CF_TOKEN; exec cloudflared service install "$LYRA_CF_TOKEN"';
  try {
    execSync(`sudo -n /bin/sh -c '${privScript}'`, {
      input: `${token}\n`,
      stdio: ["pipe", "pipe", "pipe"]
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }

  log("cloudflared aktif edildi.");
  return { ok: true };
}

function isServiceActive() {
  try {
    const out = execSync("systemctl is-active cloudflared 2>/dev/null", {
      stdio: ["ignore", "pipe", "ignore"]
    })
      .toString()
      .trim();
    return out === "active";
  } catch (_) {
    return false;
  }
}

// Token revoke veya tunnel sil — sadece servisi kaldirir, CF'te tunnel durur
async function uninstallService({ onLog }) {
  const log = onLog || (() => {});
  log("cloudflared servisi kaldiriliyor...");
  try {
    execSync("sudo cloudflared service uninstall", {
      stdio: ["ignore", "pipe", "pipe"]
    });
    log("Kaldirildi.");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  isInstalled,
  getVersion,
  install,
  installService,
  isServiceActive,
  uninstallService
};
