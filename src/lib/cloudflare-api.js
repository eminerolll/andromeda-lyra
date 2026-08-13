// Cloudflare API v4 istemcisi. Bagimliliksiz — Node 20'nin global fetch'i
// uzerine kurulu. Kurulum sihirbazinin "API token ile otomatik tunnel" akisi
// (accessMode: cf-api) bunu kullanir; Tunnel sekmesinin API'ye tasinmasi da
// (Faz 3b) ayni fonksiyonlari kullanabilsin diye rota/DB bagimliligi yok.
//
// GUVENLIK: API token yalnizca Authorization basliginda gecer. Hicbir log
// satirina, hata mesajina veya exception'a yazilmaz; ag hatalarinda disari
// verilen mesaj token'a karsi ayrica temizlenir (scrub).

const crypto = require("crypto");

const API_BASE = "https://api.cloudflare.com/client/v4";
const DEFAULT_TIMEOUT_MS = 20000;

// Token olustururken Cloudflare panelinde secilmesi gereken izinler.
// Yetki hatalarinda kullaniciya hangisinin eksik oldugunu soyleyebilmek icin.
// NOT: ACCOUNT (Account Settings > Read) yalnizca hesap LISTELEME icindir;
// tunnel/DNS islemleri icin gerekmez ve kurulum bunu sart kosmaz.
const PERM = {
  ACCOUNT: "Account > Account Settings > Read",
  TUNNEL: "Account > Cloudflare Tunnel > Edit",
  ZONE: "Zone > Zone > Read",
  DNS: "Zone > DNS > Edit"
};

// Sik gorulen Cloudflare hata kodlarinin Turkce karsiligi. Listede olmayan
// kodlarda Cloudflare'in kendi ingilizce mesaji kod numarasiyla gosterilir.
const ERROR_MESSAGES = {
  1000: "API token gecersiz.",
  1015: "Bu isimde bir kayit zaten var.",
  6003: "Istek basligi hatali — token okunamadi.",
  7003: "Istenen kayit bulunamadi.",
  9106: "Token gonderilmedi.",
  9109: "Token bu kaynaga erisemiyor.",
  10000: "Kimlik dogrulama hatasi — token gecersiz ya da yetkisiz.",
  81053: "Bu isimde bir DNS kaydi zaten var.",
  81057: "Ayni isim ve tipte bir DNS kaydi zaten var."
};

const AUTH_CODES = [1000, 6003, 9106, 9109, 10000];

class CloudflareError extends Error {
  constructor(message, { status = 0, codes = [], permission = null } = {}) {
    super(message);
    this.name = "CloudflareError";
    this.status = status;
    this.codes = codes;
    this.permission = permission;
  }
}

// DNS cakismasi ayri bir tip: cagiran taraf bunu "kullaniciya sor" olarak
// ele almali, genel bir API hatasi gibi degil.
class CloudflareDnsConflictError extends CloudflareError {
  constructor(message, conflicts) {
    super(message, { status: 409 });
    this.name = "CloudflareDnsConflictError";
    this.conflict = true;
    this.conflicts = conflicts;
  }
}

// Token bir sekilde bir hata metnine karisirsa disari cikmadan maskele.
function scrub(text, token) {
  if (text === null || text === undefined) return "";
  const out = String(text);
  if (!token) return out;
  return out.split(token).join("<token>");
}

// Path'e girecek kimlikler icin basit dogrulama. Cloudflare id'leri 32 hex
// (hesap/zone) veya UUID (tunnel) — ikisi de bu kaliba giriyor. Amac path
// injection'i kapatmak.
function assertId(value, label) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9-]{20,40}$/.test(value)) {
    throw new CloudflareError(`Gecersiz ${label}.`);
  }
  return value;
}

function buildApiError(errors, status, permission) {
  const list = Array.isArray(errors) ? errors : [];
  const codes = list.map((e) => e && e.code).filter(Boolean);

  const parts = list.map((e) => {
    const code = e && e.code;
    const known = ERROR_MESSAGES[code];
    const raw = (e && e.message) || "";
    if (known) return `${known} (${raw || "-"}, kod ${code})`;
    return raw
      ? `${raw}${code ? ` (kod ${code})` : ""}`
      : `bilinmeyen hata${code ? ` (kod ${code})` : ""}`;
  });

  let msg = parts.length ? parts.join(" · ") : `beklenmeyen cevap (HTTP ${status}).`;

  const authIssue = status === 401 || status === 403 || codes.some((c) => AUTH_CODES.includes(c));
  if (authIssue && permission) {
    msg += ` Token'da su izin eksik gorunuyor: ${permission}.`;
  }

  return new CloudflareError(`Cloudflare: ${msg}`, { status, codes, permission });
}

async function request(token, pathname, opts = {}) {
  const { method = "GET", body = null, timeout = DEFAULT_TIMEOUT_MS, permission = null } = opts;

  if (typeof token !== "string" || token.trim().length < 20) {
    throw new CloudflareError("Cloudflare API token'i eksik veya cok kisa.");
  }

  let res;
  try {
    res = await fetch(API_BASE + pathname, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout)
    });
  } catch (err) {
    const aborted = err && (err.name === "TimeoutError" || err.name === "AbortError");
    const reason = aborted
      ? `${Math.round(timeout / 1000)} saniyede cevap alinamadi`
      : scrub(err && err.message, token);
    throw new CloudflareError(
      `Cloudflare API'ye ulasilamadi (${method} ${pathname}): ${reason}. ` +
        "Sunucunun internet cikisini ve DNS ayarlarini kontrol et."
    );
  }

  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    data = null;
  }

  if (!data || typeof data !== "object") {
    throw new CloudflareError(`Cloudflare beklenmeyen bir cevap dondu (HTTP ${res.status}).`, {
      status: res.status
    });
  }

  if (!data.success) {
    throw buildApiError(data.errors, res.status, permission);
  }

  return data.result;
}

// ─────────────────────────── Token / hesap ───────────────────────────

// Token gecerli ve aktif mi?
async function verifyToken(token) {
  const result = await request(token, "/user/tokens/verify");
  const status = result && result.status;
  if (status !== "active") {
    throw new CloudflareError(
      `API token aktif degil (durum: ${status || "bilinmiyor"}). ` +
        "Cloudflare panelinden token'i yeniden etkinlestir ya da yenisini olustur."
    );
  }
  return { id: (result && result.id) || null, status };
}

// GET /accounts hesap listeleyebilmek icin "Account Settings: Read" ister.
// Onerdigimiz dar kapsamli token'da (Cloudflare Tunnel: Edit + DNS: Edit) bu
// izin yok ve Cloudflare hata degil, success:true + BOS liste doner. O yuzden
// bos liste burada hata degildir — hesap id'sinin birincil kaynagi zone'dur
// (bkz. resolveAccount).
async function listAccounts(token) {
  const result = await request(token, "/accounts?per_page=50", { permission: PERM.ACCOUNT });
  return (result || []).map((a) => ({ id: a.id, name: a.name }));
}

// Zone cevabindaki hesap bilgisi. Ekstra izin gerektirmez: /zones cevabi
// her zaman zone'un ait oldugu hesabi tasir.
function accountFromZone(zone) {
  const a = zone && zone.account;
  if (!a || typeof a.id !== "string" || !a.id) return null;
  return { id: a.id, name: a.name || null };
}

const ACCOUNT_UNRESOLVED =
  "Cloudflare hesap id'si belirlenemedi: domain'in zone kaydindan hesap bilgisi gelmedi ve " +
  "hesap listesi bos dondu. GET /accounts'un bos donmesi token'in yetersiz oldugu anlamina " +
  'gelmez — hesap LISTELEME icin "Account Settings: Read" izni gerekir, tunnel islemleri ' +
  "icin gerekmez. Hesap id'sini Cloudflare panelinde hesap ana sayfasinin adresinden " +
  "(dash.cloudflare.com/<hesap-id>) kopyalayip kurulum sihirbazina elle girebilirsin.";

// Hangi hesapla calisacagiz? Oncelik sirasi:
//   1) kullanicinin elle verdigi id — her zaman kazanir
//   2) zone cevabindaki account (opts.zone) — ekstra izin istemez, birincil yol
//   3) GET /accounts — yalnizca YEDEK; dar kapsamli token'da bos doner
// Yedek yolda birden fazla hesap varsa sessizce ilkini secmek yanlis hesapta
// tunnel acmak demektir — account null doner, secimi cagiran kullaniciya sorar.
async function resolveAccount(token, preferredId = null, opts = {}) {
  const zoneAccount = accountFromZone(opts.zone);

  if (preferredId) {
    const account =
      zoneAccount && zoneAccount.id === preferredId ? zoneAccount : { id: preferredId, name: null };
    return { account, accounts: [account], source: "manual" };
  }

  if (zoneAccount) {
    return { account: zoneAccount, accounts: [zoneAccount], source: "zone" };
  }

  // Zone'dan hesap gelmediyse (ornegin zone henuz bulunmadan cagrildiysa)
  // listelemeyi dene. Yetki hatasi da bos liste gibi ele alinir: asil mesaj
  // asagida, kullaniciyi hesap id'sini elle girmeye yonlendiren mesajdir.
  let accounts = [];
  try {
    accounts = await listAccounts(token);
  } catch (_) {
    accounts = [];
  }
  if (!accounts.length) throw new CloudflareError(ACCOUNT_UNRESOLVED);
  if (accounts.length === 1) return { account: accounts[0], accounts, source: "list" };
  return { account: null, accounts, source: "list" };
}

// ─────────────────────────── Zone ───────────────────────────

// "https://Example.COM/" -> "example.com". Gecersizse null.
function normalizeDomain(input) {
  if (typeof input !== "string") return null;
  const d = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "");
  const re = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
  return re.test(d) ? d : null;
}

async function findZone(token, domain) {
  const name = normalizeDomain(domain);
  if (!name) throw new CloudflareError("Gecerli bir domain girilmeli (ornek: example.com).");
  const result = await request(token, `/zones?name=${encodeURIComponent(name)}`, {
    permission: PERM.ZONE
  });
  const zone = (result || [])[0];
  if (!zone) {
    throw new CloudflareError(
      `"${name}" bu Cloudflare hesabinda bulunamadi. Domain'i once Cloudflare'e ekleyip ` +
        "nameserver'lari yonlendirmelisin. Buraya zone apex'i yazilmali " +
        "(example.com dogru, alt.example.com degil)."
    );
  }
  // account: hesap id'sinin birincil kaynagi. Cagiran taraf bunu
  // resolveAccount'a gecirir; boylece Account Settings: Read izni gerekmez.
  return { id: zone.id, name: zone.name, status: zone.status, account: accountFromZone(zone) };
}

async function getZone(token, zoneId) {
  const r = await request(token, `/zones/${assertId(zoneId, "zone id")}`, {
    permission: PERM.ZONE
  });
  return { id: r.id, name: r.name, status: r.status, account: accountFromZone(r) };
}

// ─────────────────────────── Tunnel ───────────────────────────

// Tunnel'i "remotely-managed" (config_src: cloudflare) olusturuyoruz: ingress
// ancak boyle /configurations ucundan yonetilebilir. Yerel yonetilen tunnel'da
// cloudflared kendi config.yml'ini okur, API'ye yazdigimiz ingress yok sayilir.
async function createTunnel(token, accountId, name) {
  const tunnelSecret = crypto.randomBytes(32).toString("base64");
  const result = await request(token, `/accounts/${assertId(accountId, "hesap id")}/cfd_tunnel`, {
    method: "POST",
    body: { name, tunnel_secret: tunnelSecret, config_src: "cloudflare" },
    permission: PERM.TUNNEL
  });
  return { id: result.id, name: result.name, secret: tunnelSecret };
}

// cloudflared'in tunnel'a baglanmak icin kullandigi connector token.
async function getTunnelToken(token, accountId, tunnelId) {
  const result = await request(
    token,
    `/accounts/${assertId(accountId, "hesap id")}/cfd_tunnel/${assertId(tunnelId, "tunnel id")}/token`,
    { permission: PERM.TUNNEL }
  );
  if (typeof result !== "string" || result.length < 50) {
    throw new CloudflareError("Cloudflare gecerli bir connector token dondurmedi.");
  }
  return result;
}

// Cloudflare'in tunnel kaydini tek bicime indir. connections dizisi canli
// connector'lari tasir; status "healthy" / "degraded" / "inactive" / "down".
function normalizeTunnel(t) {
  const conns = Array.isArray(t && t.connections) ? t.connections : [];
  return {
    id: (t && t.id) || null,
    name: (t && t.name) || null,
    status: (t && t.status) || null,
    connections: conns.length,
    createdAt: (t && t.created_at) || null,
    connsActiveAt: (t && t.conns_active_at) || null
  };
}

// Hesaptaki tunnel'lar. Silinmisler haric tutulur — Cloudflare onlari da
// listeler ve "ayni isim zaten var" karari yanlis cikardi.
async function listTunnels(token, accountId, opts = {}) {
  const params = new URLSearchParams({ is_deleted: "false", per_page: "50" });
  if (opts.name) params.set("name", String(opts.name));
  const result = await request(
    token,
    `/accounts/${assertId(accountId, "hesap id")}/cfd_tunnel?${params.toString()}`,
    { permission: PERM.TUNNEL }
  );
  return (result || []).map(normalizeTunnel);
}

// Ayni ADDA tunnel var mi? Cloudflare'in name filtresine korukoru guvenmiyoruz;
// donen kayitlarda tam eslesme ariyoruz.
async function findTunnelByName(token, accountId, name) {
  const wanted = String(name || "");
  if (!wanted) return null;
  const list = await listTunnels(token, accountId, { name: wanted });
  return list.find((t) => t.name === wanted) || null;
}

// Tunnel'da canli connector var mi? Yalnizca connections sayisina bakmak
// yetmez: Cloudflare bu diziyi bazen bos dondurup durumu status'te tasir.
function tunnelHasConnections(tunnel) {
  if (!tunnel) return false;
  if (Number(tunnel.connections) > 0) return true;
  return tunnel.status === "healthy" || tunnel.status === "degraded";
}

async function deleteTunnel(token, accountId, tunnelId) {
  await request(
    token,
    `/accounts/${assertId(accountId, "hesap id")}/cfd_tunnel/${assertId(tunnelId, "tunnel id")}`,
    { method: "DELETE", permission: PERM.TUNNEL }
  );
  return { ok: true };
}

// ─────────────────────────── Ingress ───────────────────────────

function isCatchAll(rule) {
  return !!rule && !rule.hostname && typeof rule.service === "string" && rule.service.length > 0;
}

// Ingress SIRALI bir listedir: ilk eslesen kural kazanir ve son eleman MUTLAKA
// hostname'siz catch-all olmalidir, yoksa Cloudflare config'i reddeder.
// Wildcard once gelir; apex ayri bir kural ister (*.example.com example.com'u
// kapsamaz).
function buildIngress({ domain, port, includeApex = true }) {
  const name = normalizeDomain(domain);
  if (!name) throw new CloudflareError("Ingress icin gecerli bir domain gerekli.");
  const p = parseInt(port, 10);
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    throw new CloudflareError("Ingress icin gecerli bir port gerekli.");
  }
  const service = `http://localhost:${p}`;
  const rules = [{ hostname: `*.${name}`, service }];
  if (includeApex) rules.push({ hostname: name, service });
  rules.push({ service: "http_status:404" });
  return rules;
}

async function putIngress(token, accountId, tunnelId, ingress) {
  if (!Array.isArray(ingress) || ingress.length < 2) {
    throw new CloudflareError("Ingress listesi en az bir kural ve bir catch-all icermeli.");
  }
  if (!isCatchAll(ingress[ingress.length - 1])) {
    throw new CloudflareError(
      "Ingress listesinin son elemani hostname'siz catch-all olmali (ornek: http_status:404)."
    );
  }
  if (ingress.slice(0, -1).some((r) => !r || !r.hostname || !r.service)) {
    throw new CloudflareError(
      "Catch-all disindaki tum ingress kurallarinda hostname ve service olmali."
    );
  }
  return request(
    token,
    `/accounts/${assertId(accountId, "hesap id")}/cfd_tunnel/${assertId(tunnelId, "tunnel id")}/configurations`,
    { method: "PUT", body: { config: { ingress } }, permission: PERM.TUNNEL }
  );
}

async function getIngress(token, accountId, tunnelId) {
  const result = await request(
    token,
    `/accounts/${assertId(accountId, "hesap id")}/cfd_tunnel/${assertId(tunnelId, "tunnel id")}/configurations`,
    { permission: PERM.TUNNEL }
  );
  const cfg = (result && result.config) || {};
  return {
    ingress: Array.isArray(cfg.ingress) ? cfg.ingress : [],
    // "cloudflare" = remotely-managed; "local" ise API'den yazdigimiz ingress
    // cloudflared tarafindan yok sayilir.
    source: (result && result.source) || null
  };
}

// ─────────────────────────── DNS ───────────────────────────

// "@" -> zone apex, "*" -> "*.zone", "lyra" -> "lyra.zone".
function toFqdn(name, zoneName) {
  if (!name || name === "@") return zoneName;
  if (name === "*") return `*.${zoneName}`;
  if (name === zoneName || name.endsWith(`.${zoneName}`)) return name;
  return `${name}.${zoneName}`;
}

async function listDnsRecords(token, zoneId, name = null) {
  const query = name ? `?per_page=50&name=${encodeURIComponent(name)}` : "?per_page=50";
  const result = await request(token, `/zones/${assertId(zoneId, "zone id")}/dns_records${query}`, {
    permission: PERM.DNS
  });
  return (result || []).map((r) => ({
    id: r.id,
    type: r.type,
    name: r.name,
    content: r.content,
    proxied: !!r.proxied,
    ttl: r.ttl
  }));
}

function describeConflict(target, existing) {
  const lines = existing.map(
    (r) => `${r.type} ${r.name} -> ${r.content}${r.proxied ? " (proxied)" : ""}`
  );
  return (
    `"${target.name}" icin zaten DNS kaydi var: ${lines.join(", ")}. ` +
    `Lyra buraya ${target.type} ${target.name} -> ${target.content} yazmak istiyor. ` +
    'Mevcut kaydi onayin olmadan degistirmiyoruz: ya "uzerine yaz" secenegini ' +
    "isaretle, ya da panel icin farkli bir alt alan adi kullan."
  );
}

// Cakisma tespiti burada. Gercek dunyada en sik tuzak apex'te eski hosting
// saglayicisindan kalan bir A kaydidir: Cloudflare tunnel CNAME'ini
// olusturamaz, kullanici sebebini gormeden 523 alir. Sessizce ezmek de
// sessizce basarisiz olmak da kabul edilemez — overwrite acik degilse
// CloudflareDnsConflictError firlatilir ve karar kullaniciya birakilir.
async function upsertDnsRecord(token, zoneId, record, opts = {}) {
  const { overwrite = false } = opts;
  const zoneName = opts.zoneName || (await getZone(token, zoneId)).name;

  const target = {
    type: String(record.type || "").toUpperCase(),
    name: toFqdn(record.name, zoneName),
    content: record.content,
    proxied: record.proxied !== false,
    ttl: 1
  };
  if (!target.type || !target.content) {
    throw new CloudflareError("DNS kaydi icin type ve content zorunlu.");
  }

  const existing = await listDnsRecords(token, zoneId, target.name);

  if (!existing.length) {
    const created = await request(token, `/zones/${zoneId}/dns_records`, {
      method: "POST",
      body: target,
      permission: PERM.DNS
    });
    return { action: "created", record: created };
  }

  // Zaten istedigimiz kayit duruyorsa dokunma (kurulum tekrar calistirilabilir).
  if (
    existing.length === 1 &&
    existing[0].type === target.type &&
    existing[0].content === target.content &&
    existing[0].proxied === target.proxied
  ) {
    return { action: "unchanged", record: existing[0] };
  }

  if (!overwrite) {
    throw new CloudflareDnsConflictError(describeConflict(target, existing), existing);
  }

  const [first, ...rest] = existing;
  const updated = await request(token, `/zones/${zoneId}/dns_records/${first.id}`, {
    method: "PUT",
    body: target,
    permission: PERM.DNS
  });
  for (const r of rest) {
    await request(token, `/zones/${zoneId}/dns_records/${r.id}`, {
      method: "DELETE",
      permission: PERM.DNS
    });
  }
  return { action: "replaced", record: updated, replaced: existing };
}

async function deleteDnsRecord(token, zoneId, recordId) {
  await request(
    token,
    `/zones/${assertId(zoneId, "zone id")}/dns_records/${assertId(recordId, "kayit id")}`,
    { method: "DELETE", permission: PERM.DNS }
  );
  return { ok: true };
}

// Tunnel CNAME hedefi.
function tunnelCname(tunnelId) {
  return `${assertId(tunnelId, "tunnel id")}.cfargotunnel.com`;
}

module.exports = {
  API_BASE,
  PERM,
  CloudflareError,
  CloudflareDnsConflictError,
  normalizeDomain,
  verifyToken,
  listAccounts,
  accountFromZone,
  resolveAccount,
  findZone,
  getZone,
  createTunnel,
  getTunnelToken,
  listTunnels,
  findTunnelByName,
  tunnelHasConnections,
  deleteTunnel,
  buildIngress,
  isCatchAll,
  putIngress,
  getIngress,
  toFqdn,
  listDnsRecords,
  upsertDnsRecord,
  deleteDnsRecord,
  tunnelCname
};
