// UFW (Uncomplicated Firewall) yardimcisi.
//
// Neden var: UFW acik bir VPS'te kurulum sihirbazi port 80'e bind olur ama
// disaridan erisilemez — kullanici token'i gorur, sayfayi acamaz. Ayni sekilde
// LAN modunda Lyra 0.0.0.0:3000'e bind olsa da UFW paketi duserdi.
//
// Tasarim kurallari:
//   - UFW kurulu degilse veya "inactive" ise hicbir sey yapilmaz (sessiz basari).
//     Kullanicinin arkasindan firewall aktif etmiyoruz.
//   - Tum komutlar execFile ile calisir; shell string interpolasyonu yok.
//   - Kurulum sirasinda acilan port, kapatilirken sadece bizim yazdigimiz
//     kural ise silinir (comment ile isaretlenir).
//   - Her adim onLog ile disari verilir; setup progress bunu gosterir.

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");

const UFW_PATHS = ["/usr/sbin/ufw", "/sbin/ufw", "/usr/bin/ufw"];

// Kurulum sirasinda actigimiz kurallari bu etiketle isaretleriz; kapatirken
// baskasinin kuralini silmemek icin ayni etikete bakariz.
const SETUP_COMMENT = "lyra-setup";
const PERSISTENT_COMMENT = "lyra";

function ufwBinary() {
  for (const p of UFW_PATHS) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return null;
}

function isAvailable() {
  return !!ufwBinary();
}

// sudo -n: sifre sorulmaz. Yetki yoksa hata firlatir, cagiran yakalar.
function ufw(args) {
  return execFileSync("sudo", ["-n", "ufw", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20000
  });
}

function statusText() {
  if (!isAvailable()) return null;
  try {
    return ufw(["status"]);
  } catch (_) {
    return null;
  }
}

function isActive() {
  const out = statusText();
  return !!out && /^Status:\s*active/im.test(out);
}

// "80/tcp   ALLOW  Anywhere   # lyra-setup" satirlarini ayristir.
function parseRules(text) {
  const rules = [];
  for (const line of (text || "").split("\n")) {
    const m = line.match(/^(\S+)\s+(ALLOW|DENY|REJECT|LIMIT)\b([^#]*)(?:#\s*(.*))?$/i);
    if (!m) continue;
    rules.push({
      target: m[1],
      action: m[2].toUpperCase(),
      rest: (m[3] || "").trim(),
      comment: (m[4] || "").trim()
    });
  }
  return rules;
}

function findPortRules(text, port) {
  const p = String(port);
  return parseRules(text).filter((r) => r.target === p || r.target === `${p}/tcp`);
}

// ---------- IPv4 subnet yardimcilari ----------

function ipToInt(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

// "192.168.1.50/24" -> "192.168.1.0/24"
function networkOf(cidr) {
  if (typeof cidr !== "string" || !cidr.includes("/")) return null;
  const [ip, bitsRaw] = cidr.split("/");
  const bits = parseInt(bitsRaw, 10);
  const asInt = ipToInt(ip);
  if (asInt === null || !Number.isInteger(bits) || bits < 1 || bits > 32) return null;
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return `${intToIp((asInt & mask) >>> 0)}/${bits}`;
}

// Sunucunun bagli oldugu yerel IPv4 agları. LAN modunda kural bunlara yazilir.
function localSubnets() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family !== "IPv4" || iface.internal) continue;
      const net = networkOf(iface.cidr || "");
      if (net && !out.includes(net)) out.push(net);
    }
  }
  return out;
}

// ---------- Kural uretimi (saf fonksiyon — test edilebilir) ----------

// Erisim moduna gore kalici UFW kurallari.
//   public    -> 80 + 443 (Caddy TLS terminate eder, Lyra loopback'te kalir)
//   lan       -> Lyra portu sadece yerel aglara
//   localhost -> hicbir kural (loopback firewall'dan gecmez)
//   cf-tunnel -> hicbir kural (baglanti cloudflared ile disari dogru kurulur)
//   manual    -> hicbir kural (reverse proxy kullanicinin sorumlulugunda)
function buildAccessModeRules(mode, { port, subnets = [] } = {}) {
  if (mode === "public") {
    return [
      ["allow", "80/tcp", "comment", PERSISTENT_COMMENT],
      ["allow", "443/tcp", "comment", PERSISTENT_COMMENT]
    ];
  }
  if (mode === "lan") {
    if (!port) return [];
    const nets = subnets.length ? subnets : [];
    if (!nets.length) {
      // Yerel ag tespit edilemediyse porta genel izin vermek yerine hicbir sey
      // yapma — sessizce internete acmak kabul edilemez.
      return [];
    }
    return nets.map((net) => [
      "allow",
      "from",
      net,
      "to",
      "any",
      "port",
      String(port),
      "proto",
      "tcp",
      "comment",
      PERSISTENT_COMMENT
    ]);
  }
  return [];
}

// ---------- Uygulama ----------

function noop() {}

// Kurulum sihirbazinin portunu ac (install.sh de ayni isi bash tarafinda yapar;
// bu fonksiyon idempotent oldugu icin iki kez cagrilmasi sorun degil).
function openSetupPort(port, { onLog } = {}) {
  const log = onLog || noop;
  if (!isAvailable()) return { applied: false, reason: "ufw-yok" };
  const text = statusText();
  if (!text || !/^Status:\s*active/im.test(text)) {
    return { applied: false, reason: "ufw-pasif" };
  }
  if (findPortRules(text, port).length) {
    log(`UFW: ${port}/tcp zaten acik, dokunulmadi.`);
    return { applied: false, reason: "zaten-acik" };
  }
  try {
    ufw(["allow", `${port}/tcp`, "comment", SETUP_COMMENT]);
    log(`UFW: ${port}/tcp acildi (kurulum icin).`);
    return { applied: true };
  } catch (err) {
    log(`UFW: ${port}/tcp acilamadi — ${err.message}`);
    return { applied: false, error: err.message };
  }
}

// Kurulum portunu kapat. Sadece kendi actigimiz kurali sileriz.
function closeSetupPort(port, { onLog } = {}) {
  const log = onLog || noop;
  if (!isAvailable()) return { applied: false, reason: "ufw-yok" };
  const text = statusText();
  if (!text || !/^Status:\s*active/im.test(text)) {
    return { applied: false, reason: "ufw-pasif" };
  }
  const rules = findPortRules(text, port);
  if (!rules.length) return { applied: false, reason: "kural-yok" };
  if (!rules.some((r) => r.comment === SETUP_COMMENT)) {
    log(`UFW: ${port}/tcp kurali bize ait degil, silinmedi.`);
    return { applied: false, reason: "yabanci-kural" };
  }
  try {
    ufw(["delete", "allow", `${port}/tcp`]);
    log(`UFW: ${port}/tcp kapatildi (kurulum bitti).`);
    return { applied: true };
  } catch (err) {
    log(`UFW: ${port}/tcp kapatilamadi — ${err.message}`);
    return { applied: false, error: err.message };
  }
}

// Secilen erisim moduna gore kalici kurallari yaz.
function applyAccessMode(mode, { port, onLog } = {}) {
  const log = onLog || noop;
  if (!isAvailable()) {
    return { applied: false, rules: [], summary: "UFW kurulu degil, firewall degistirilmedi." };
  }
  if (!isActive()) {
    return { applied: false, rules: [], summary: "UFW pasif, firewall degistirilmedi." };
  }

  const rules = buildAccessModeRules(mode, { port, subnets: localSubnets() });
  if (!rules.length) {
    log(`UFW: "${mode}" modu icin acilacak port yok.`);
    return { applied: false, rules: [], summary: `UFW aktif; "${mode}" modu ek port acmiyor.` };
  }

  const done = [];
  const failed = [];
  for (const args of rules) {
    try {
      ufw(args);
      log(`UFW: ufw ${args.join(" ")}`);
      done.push(args.join(" "));
    } catch (err) {
      log(`UFW kurali yazilamadi (${args.join(" ")}): ${err.message}`);
      failed.push(`${args.join(" ")} — ${err.message}`);
    }
  }

  if (failed.length) {
    throw new Error(`UFW kurallari yazilamadi: ${failed.join("; ")}`);
  }
  return {
    applied: true,
    rules: done,
    summary: `UFW kurallari yazildi: ${done.join(", ")}`
  };
}

module.exports = {
  SETUP_COMMENT,
  PERSISTENT_COMMENT,
  isAvailable,
  isActive,
  statusText,
  parseRules,
  findPortRules,
  networkOf,
  localSubnets,
  buildAccessModeRules,
  openSetupPort,
  closeSetupPort,
  applyAccessMode
};
