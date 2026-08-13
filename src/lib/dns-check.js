// DNS pre-check: kullanicinin verdigi FQDN'i resolve eder ve sunucunun
// public IP'siyle karsilastirir. Setup wizard'da Caddy/CF Tunnel öncesi
// kullanilir.

const dns = require("dns").promises;
const https = require("https");

const PUBLIC_IP_SOURCES = [
  "https://api.ipify.org",
  "https://ifconfig.me/ip",
  "https://checkip.amazonaws.com"
];

function fetchUrl(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data.trim()));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

// Sunucunun public IP'sini bul. Birden fazla kaynak dener.
async function getPublicIp() {
  for (const src of PUBLIC_IP_SOURCES) {
    try {
      const ip = await fetchUrl(src);
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
    } catch (_) {}
  }
  return null;
}

// FQDN'i A ve AAAA olarak resolve et.
async function resolveDomain(fqdn) {
  const result = { v4: [], v6: [], error: null };
  try {
    result.v4 = await dns.resolve4(fqdn);
  } catch (err) {
    if (err.code === "ENODATA" || err.code === "ENOTFOUND") {
      // OK, sadece IPv6 olabilir
    } else {
      result.error = err.code || err.message;
    }
  }
  try {
    result.v6 = await dns.resolve6(fqdn);
  } catch (_) {}
  return result;
}

// Domain'in sunucuyu gosterip gostermedigini kontrol et.
// Donus: { ok, publicIp, resolvedV4, resolvedV6, message }
async function check(fqdn) {
  if (!fqdn || typeof fqdn !== "string") {
    return { ok: false, message: "FQDN gerekli" };
  }
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(fqdn)) {
    return { ok: false, message: "Gecersiz domain formati" };
  }

  const publicIp = await getPublicIp();
  const resolved = await resolveDomain(fqdn);

  if (resolved.error) {
    return {
      ok: false,
      publicIp,
      resolvedV4: [],
      resolvedV6: [],
      message: `DNS resolve edilemedi: ${resolved.error}`
    };
  }
  if (!resolved.v4.length && !resolved.v6.length) {
    return {
      ok: false,
      publicIp,
      resolvedV4: [],
      resolvedV6: [],
      message: "Bu domain icin A veya AAAA kaydi bulunamadi. DNS henuz yayilmamis olabilir."
    };
  }

  // Public IP biliniyorsa eslesme kontrolu (IPv4)
  if (publicIp && resolved.v4.length) {
    if (resolved.v4.includes(publicIp)) {
      return {
        ok: true,
        publicIp,
        resolvedV4: resolved.v4,
        resolvedV6: resolved.v6,
        message: "DNS sunucuya yonlendirilmis."
      };
    }
    return {
      ok: false,
      publicIp,
      resolvedV4: resolved.v4,
      resolvedV6: resolved.v6,
      message: `DNS baska IP'ye gidiyor (${resolved.v4.join(", ")}). Sunucu IP: ${publicIp}`
    };
  }

  // Public IP'yi bulamadiysak, en azindan domain resolve oluyor
  return {
    ok: true,
    publicIp,
    resolvedV4: resolved.v4,
    resolvedV6: resolved.v6,
    message: publicIp
      ? "DNS resolve oldu, IP eslesmesi dogrulanamadi."
      : "Sunucu public IP'si tespit edilemedi (offline olabilir). DNS dogrulamasi atlandi."
  };
}

// Tek bir FQDN'i, onceden bilinen public IP ile karsilastir.
// check()'in aksine public IP'yi kendisi cekmez — toplu kontrolde tekrar tekrar
// disari cikmamak icin.
async function checkAgainstIp(fqdn, publicIp) {
  const resolved = await resolveDomain(fqdn);
  const found = resolved.v4.length > 0 || resolved.v6.length > 0;

  if (!found) {
    return {
      host: fqdn,
      ok: false,
      resolvedV4: resolved.v4,
      resolvedV6: resolved.v6,
      message: "A/AAAA kaydi yok"
    };
  }
  if (publicIp && resolved.v4.length && !resolved.v4.includes(publicIp)) {
    return {
      host: fqdn,
      ok: false,
      resolvedV4: resolved.v4,
      resolvedV6: resolved.v6,
      message: `Baska IP'ye gidiyor (${resolved.v4.join(", ")})`
    };
  }
  return {
    host: fqdn,
    ok: true,
    resolvedV4: resolved.v4,
    resolvedV6: resolved.v6,
    message: publicIp ? "Sunucuya yonlendirilmis" : "Resolve oldu (IP eslesmesi dogrulanamadi)"
  };
}

// Apex + subdomain'leri birlikte kontrol et.
//
// Neden gerekli: Caddy her host blogu icin ayri sertifika alir. code.<domain>
// gibi bir kaydin DNS'i yoksa o blok icin sertifika alinamaz ve kullanici
// bunu ancak journalctl'de gorur. Sihirbaz eksikleri onceden listelemeli.
async function checkAll(domain, subdomains = []) {
  const apex = await check(domain);
  if (!domain || apex.publicIp === undefined) {
    return { apex, publicIp: null, subdomains: [] };
  }
  const publicIp = apex.publicIp || null;
  const results = [];
  for (const sub of subdomains) {
    if (!sub) continue;
    results.push(await checkAgainstIp(`${sub}.${domain}`, publicIp));
  }
  return { apex, publicIp, subdomains: results };
}

module.exports = { check, checkAll, checkAgainstIp, getPublicIp, resolveDomain };
