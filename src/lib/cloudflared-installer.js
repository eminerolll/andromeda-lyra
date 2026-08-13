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

const SERVICE_UNIT = "cloudflared";
const LEGACY_CONFIG = "/etc/cloudflared/config.yml";

// systemd unit metni. Yoksa null. `systemctl cat` root gerektirmez.
function serviceUnitText() {
  try {
    return execSync(`systemctl cat ${SERVICE_UNIT} 2>/dev/null`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch (_) {
    return null;
  }
}

// Connector token base64'lenmis bir JSON'dur: {"a":hesap,"t":tunnel,"s":secret}.
// Token'in KENDISI hicbir yere yazilmaz; yalnizca tunnel id'si disari verilir.
function tunnelIdFromToken(token) {
  try {
    const parsed = JSON.parse(Buffer.from(String(token), "base64").toString("utf8"));
    const id = parsed && parsed.t;
    return typeof id === "string" && id.length >= 20 ? id : null;
  } catch (_) {
    return null;
  }
}

// Unit'in ExecStart'i iki bicimden birini tasir:
//   ... tunnel run --token <base64>      (token yontemi — bizim kullandigimiz)
//   ... tunnel run <UUID>                (kimlik dosyasi yontemi)
function tunnelIdFromUnit(text) {
  if (!text) return null;
  const withToken = text.match(/--token[= ]\s*([A-Za-z0-9_+/=-]{40,})/);
  if (withToken) {
    const id = tunnelIdFromToken(withToken[1]);
    if (id) return id;
  }
  const byId = text.match(/tunnel\s+run\s+([0-9a-fA-F-]{36})/);
  return byId ? byId[1] : null;
}

// Eski (config dosyasi tabanli) kurulumlarda tunnel id'si buradadir.
function tunnelIdFromConfig() {
  try {
    const text = fs.readFileSync(LEGACY_CONFIG, "utf8");
    const m = text.match(/^\s*tunnel:\s*([0-9a-fA-F-]{36})\s*$/m);
    return m ? m[1] : null;
  } catch (_) {
    return null;
  }
}

// Sistemde ZATEN bir cloudflared servisi var mi, hangi tunnel'a bagli?
//
// Bunu bilmek zorundayiz: "cloudflared service install" mevcut bir unit
// uzerine calistiginda hata verir. Kurulum bunu sessizce yiyip yarida
// kalmasin diye tunnel yaratmadan ONCE bakiyoruz (bkz. lib/setup-core.js).
function detectService() {
  const text = serviceUnitText();
  if (!text) return { present: false, active: false, tunnelId: null };
  return {
    present: true,
    active: isServiceActive(),
    tunnelId: tunnelIdFromUnit(text) || tunnelIdFromConfig()
  };
}

// Mevcut servisi anlatan tek satir. Token gecmez, yalnizca tunnel id'si.
function describeService(svc) {
  const parts = [svc.active ? "calisiyor" : "durmus"];
  if (svc.tunnelId) parts.push(`bagli tunnel: ${svc.tunnelId}`);
  return parts.join(", ");
}

// Connector token ile cloudflared servisini install et + start.
// Token CF dashboard'da tunnel olusturulurken alinir.
//
// replace: sistemde zaten bir cloudflared servisi varsa ne yapilacagi.
// Varsayilan HAYIR — sessizce devralmak baskasinin tunnel'ini kesebilir.
async function installService({ token, onLog, replace = false }) {
  const log = onLog || (() => {});
  if (!token || token.length < 50) {
    return { ok: false, error: "Gecersiz connector token" };
  }

  const existing = detectService();
  if (existing.present) {
    if (!replace) {
      return {
        ok: false,
        existingService: existing,
        error:
          `Bu sunucuda zaten bir cloudflared servisi var (${describeService(existing)}). ` +
          "Uzerine kurmak 'cloudflared service install' komutunu patlatir; sessizce " +
          "devralmiyoruz. Degistirmek icin --replace-cloudflared ver, ya da once elle " +
          "kaldir: sudo cloudflared service uninstall"
      };
    }
    log(`Mevcut cloudflared servisi kaldiriliyor (${describeService(existing)})...`);
    const removed = await uninstallService({ onLog: log });
    if (!removed.ok) {
      return {
        ok: false,
        existingService: existing,
        error: `Mevcut cloudflared servisi kaldirilamadi: ${removed.error}`
      };
    }
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
  return { ok: true, replacedService: existing.present ? existing : null };
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
  SERVICE_UNIT,
  isInstalled,
  getVersion,
  install,
  installService,
  isServiceActive,
  detectService,
  describeService,
  tunnelIdFromToken,
  tunnelIdFromUnit,
  uninstallService
};
