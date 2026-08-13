// Tunnel sekmesi (Faz 3b) testleri: mod tespiti, catch-all'un sonda kalmasi,
// korumali host'lar, DNS cakismasinda onaysiz yazmama ve Mod C -> Mod A kesfi.
//
// Gercek Cloudflare API'sine cagri YOK: global.fetch mock'lanir.
// child_process.exec de mock'lanir; hicbir sistem komutu calismaz.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { freshHome, cleanup, require } from "./setup.js";

const TOKEN = "cf-test-token-0123456789abcdef";
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const ZONE_ID = "fedcba9876543210fedcba9876543210";
const TUNNEL_ID = "11111111-2222-3333-4444-555555555555";
// DNS kayit id'si de Cloudflare formatinda olmali: cloudflare-api.js path'e
// giren kimlikleri dogruluyor, kisa bir id ("rec1") reddedilir.
const RECORD_ID = "aaaaaaaabbbbbbbbccccccccdddddddd";
const CNAME = `${TUNNEL_ID}.cfargotunnel.com`;

let home;
let calls;
let originalFetch;
let cp;
let originalExec;
let execHandler;

// Faz 3a'nin urettigi ingress: wildcard once, apex sonra, catch-all EN SONDA.
function baseIngress() {
  return [
    { hostname: "*.example.com", service: "http://localhost:3000" },
    { hostname: "example.com", service: "http://localhost:3000" },
    { service: "http_status:404" }
  ];
}

function ok(result) {
  return { status: 200, json: { success: true, errors: [], messages: [], result } };
}

function mockFetch(responses) {
  const queue = [...responses];
  global.fetch = vi.fn(async (url, opts = {}) => {
    calls.push({
      url,
      method: opts.method || "GET",
      body: opts.body ? JSON.parse(opts.body) : null
    });
    const next = queue.shift();
    if (!next) throw new Error(`Beklenmeyen fetch: ${url}`);
    return { status: next.status || 200, json: async () => next.json };
  });
}

// exec cagrilarini komut metnine gore cevaplar. Varsayilan: her komut hata
// verir (sunucuda cloudflared/sudo yokmus gibi).
function mockExec(handler) {
  execHandler = handler || (() => ({ err: new Error("komut yok") }));
}

// lib/cloudflare exec'i require aninda destructure ettigi icin modul
// yuklenmeden ONCE child_process.exec degistirilmeli.
function loadLib() {
  cp = require("child_process");
  if (!originalExec) originalExec = cp.exec;
  cp.exec = (cmd, opts, cb) => {
    const done = typeof opts === "function" ? opts : cb;
    const r = execHandler(cmd) || {};
    process.nextTick(() => done(r.err || null, r.stdout || "", r.stderr || ""));
  };
  return require("../lib/cloudflare");
}

function setIntegration(config, enabled = true) {
  const { integrations } = require("../db/repos");
  integrations.set("cloudflare", { enabled, config });
}

function apiConfig(extra = {}) {
  return {
    apiToken: TOKEN,
    accountId: ACCOUNT_ID,
    zoneId: ZONE_ID,
    zoneDomain: "example.com",
    tunnelId: TUNNEL_ID,
    ...extra
  };
}

// settings'e domain bilgisi: protectedHosts bunlardan turer.
function setDomain(panelHost = "lyra.example.com") {
  const { settings } = require("../db/repos");
  settings.setMany({ base_domain: "example.com", panel_host: panelHost });
}

// Var olmayan bir yol: localConfigExists() false donsun (Mod A / Mod C).
function noLocalConfig() {
  const { settings } = require("../db/repos");
  settings.set("cloudflared_config_path", path.join(home, "yok", "config.yml"));
}

// Gercekten var olan bir dosya: Mod B (yerel yonetilen tunnel).
function withLocalConfig() {
  const { settings } = require("../db/repos");
  const p = path.join(home, "config.yml");
  fs.writeFileSync(p, "tunnel: abc-123\ningress:\n  - service: http_status:404\n");
  settings.set("cloudflared_config_path", p);
  return p;
}

function listIngress(cf) {
  return new Promise((resolve, reject) => {
    cf.listIngress((err, entries, source) => (err ? reject(err) : resolve({ entries, source })));
  });
}

function addIngress(cf, hostname, port, opts) {
  return new Promise((resolve, reject) => {
    cf.addIngress(hostname, port, opts || {}, (err, meta) => (err ? reject(err) : resolve(meta)));
  });
}

function removeIngress(cf, hostname, opts) {
  return new Promise((resolve, reject) => {
    cf.removeIngress(hostname, opts || {}, (err, meta) => (err ? reject(err) : resolve(meta)));
  });
}

beforeEach(() => {
  home = freshHome();
  require("../db/migrate").migrate();
  calls = [];
  originalFetch = global.fetch;
  mockExec(null);
});

afterEach(() => {
  global.fetch = originalFetch;
  if (cp && originalExec) cp.exec = originalExec;
  vi.restoreAllMocks();
  cleanup(home);
});

describe("cloudflare / mod tespiti", () => {
  it("Mod A: token + hesap + tunnel varsa API modu ve yonetilebilir", () => {
    setIntegration(apiConfig());
    const cf = loadLib();
    noLocalConfig();
    const m = cf.detectMode();
    expect(m.mode).toBe(cf.MODE.API);
    expect(m.canManage).toBe(true);
    expect(m.tunnelId).toBe(TUNNEL_ID);
  });

  it("Mod B: token yok ama config.yml varsa yerel mod", () => {
    const cf = loadLib();
    const p = withLocalConfig();
    const m = cf.detectMode();
    expect(m.mode).toBe(cf.MODE.LOCAL);
    expect(m.canManage).toBe(true);
    expect(m.hasLocalConfig).toBe(true);
    expect(m.configPath).toBe(p);
  });

  // Faz 3a "cf-api" kurulumunda config.yml de duruyor olabilir; API bilgisi
  // varsa o kazanmali, yoksa var olmayan bir dosya duzenlenmeye calisilir.
  it("API bilgisi varsa config.yml dursa bile Mod A kazanir", () => {
    setIntegration(apiConfig());
    const cf = loadLib();
    withLocalConfig();
    expect(cf.detectMode().mode).toBe(cf.MODE.API);
  });

  it("Mod C: ne token ne config.yml varsa salt-okunur ve durust uyari verir", () => {
    const cf = loadLib();
    noLocalConfig();
    const m = cf.detectMode();
    expect(m.mode).toBe(cf.MODE.REMOTE);
    expect(m.canManage).toBe(false);
    expect(m.note).toMatch(/uzaktan yonetiliyor/i);
    expect(m.note).toMatch(/API token/i);
  });

  it("token var ama hesap/tunnel eksikse kesfet yonlendirmesi verir", () => {
    setIntegration({ apiToken: TOKEN });
    const cf = loadLib();
    noLocalConfig();
    const m = cf.detectMode();
    expect(m.mode).toBe(cf.MODE.REMOTE);
    expect(m.canManage).toBe(false);
    expect(m.hasToken).toBe(true);
    expect(m.note).toMatch(/kesfet/i);
  });

  it("cf-tunnel kurulumunda entegrasyon kapali olsa da sekme gorunur, yonetim kapali kalir", () => {
    const { settings } = require("../db/repos");
    const cf = loadLib();
    settings.set("access_mode", "cf-tunnel");
    noLocalConfig();
    expect(cf.isVisible()).toBe(true);
    expect(cf.isEnabled()).toBe(false);
  });

  it("entegrasyon kapaliyken yazma cagrilari reddedilir", async () => {
    setIntegration(apiConfig(), false);
    const cf = loadLib();
    noLocalConfig();
    mockFetch([]);
    await expect(addIngress(cf, "app.example.com", 8090)).rejects.toThrow(/entegrasyonu kapali/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("Mod C'de ingress yazilamaz ve neden yazilamadigi soylenir", async () => {
    const { settings } = require("../db/repos");
    const cf = loadLib();
    settings.set("cloudflared_enabled", true);
    noLocalConfig();
    mockFetch([]);
    await expect(addIngress(cf, "app.example.com", 8090)).rejects.toThrow(/uzaktan yonetiliyor/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("cloudflare / catch-all her zaman sonda", () => {
  it("catch-all listenin sonuna itilir", () => {
    const cf = loadLib();
    const out = cf.withCatchAllLast([
      { service: "http_status:404" },
      { hostname: "a.example.com", service: "http://localhost:1" }
    ]);
    expect(out).toHaveLength(2);
    expect(out[out.length - 1].hostname).toBeUndefined();
    expect(out[out.length - 1].service).toBe("http_status:404");
  });

  it("catch-all hic yoksa uretilir", () => {
    const cf = loadLib();
    const out = cf.withCatchAllLast([{ hostname: "a.example.com", service: "http://localhost:1" }]);
    expect(out[out.length - 1]).toEqual({ service: "http_status:404" });
  });

  it("yeni kural wildcard'dan once girer, catch-all sonda kalir", () => {
    const cf = loadLib();
    const out = cf.insertRule(baseIngress(), { hostname: "app.example.com", service: "http://localhost:8090" });
    expect(out.map(r => r.hostname)).toEqual([
      "app.example.com",
      "*.example.com",
      "example.com",
      undefined
    ]);
    expect(out[out.length - 1].service).toBe("http_status:404");
  });

  it("wildcard yoksa kural sona, catch-all yine en sona eklenir", () => {
    const cf = loadLib();
    const out = cf.insertRule(
      [{ hostname: "example.com", service: "http://localhost:3000" }, { service: "http_status:404" }],
      { hostname: "app.example.com", service: "http://localhost:8090" }
    );
    expect(out.map(r => r.hostname)).toEqual(["example.com", "app.example.com", undefined]);
  });

  it("catch-all hostname'siz oldugu icin silinemez", async () => {
    setIntegration(apiConfig());
    const cf = loadLib();
    setDomain();
    noLocalConfig();
    mockFetch([]);
    await expect(removeIngress(cf, "")).rejects.toThrow(/Gecersiz hostname/);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("cloudflare / korumali host'lar", () => {
  it("panel host'u, apex, wildcard ve code alt alan adi korumalidir", () => {
    const cf = loadLib();
    setDomain("lyra.example.com");
    const prot = cf.protectedHosts();
    expect(prot).toContain("example.com");
    expect(prot).toContain("*.example.com");
    expect(prot).toContain("lyra.example.com");
    expect(prot).toContain("code.example.com");
  });

  it("panel host'u silinemez ve hicbir API cagrisi yapilmaz", async () => {
    setIntegration(apiConfig());
    const cf = loadLib();
    setDomain("lyra.example.com");
    noLocalConfig();
    mockFetch([]);
    await expect(removeIngress(cf, "lyra.example.com")).rejects.toThrow(/Korumali kayit silinemez/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("apex silinemez", async () => {
    setIntegration(apiConfig());
    const cf = loadLib();
    setDomain();
    noLocalConfig();
    mockFetch([]);
    await expect(removeIngress(cf, "example.com")).rejects.toThrow(/Korumali kayit silinemez/);
  });

  it("wildcard silinemez (Mod A: korumali mesaji, gecersiz degil)", async () => {
    setIntegration(apiConfig());
    const cf = loadLib();
    setDomain();
    noLocalConfig();
    mockFetch([]);
    await expect(removeIngress(cf, "*.example.com")).rejects.toThrow(/Korumali kayit silinemez: \*\.example\.com/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("wildcard silinemez (Mod B: korumali mesaji, gecersiz degil)", async () => {
    const { settings } = require("../db/repos");
    settings.set("cloudflared_enabled", true);
    const cf = loadLib();
    setDomain();
    const p = path.join(home, "config.yml");
    fs.writeFileSync(
      p,
      "tunnel: abc-123\ningress:\n  - hostname: \"*.example.com\"\n    service: http://localhost:3000\n  - service: http_status:404\n"
    );
    settings.set("cloudflared_config_path", p);
    mockExec(cmd => (cmd.includes("cat " + p) ? { stdout: fs.readFileSync(p, "utf8") } : { err: new Error("komut yok") }));
    await expect(removeIngress(cf, "*.example.com")).rejects.toThrow(/Korumali kayit silinemez: \*\.example\.com/);
  });

  it("listede korumali ve catch-all kayitlari isaretlenir", async () => {
    setIntegration(apiConfig());
    const cf = loadLib();
    setDomain();
    noLocalConfig();
    mockFetch([ok({ source: "cloudflare", config: { ingress: baseIngress() } })]);
    const { entries, source } = await listIngress(cf);
    expect(source).toBe("cloudflare");
    expect(entries[0]).toMatchObject({ hostname: "*.example.com", isWildcard: true, isProtected: true });
    expect(entries[1]).toMatchObject({ hostname: "example.com", isProtected: true });
    expect(entries[2]).toMatchObject({ hostname: null, isCatchAll: true });
    expect(calls[0].url).toContain(`/cfd_tunnel/${TUNNEL_ID}/configurations`);
  });
});

describe("cloudflare / Mod A ingress yazma", () => {
  it("hostname ekler: DNS kaydini yazar, ingress'i wildcard'dan once koyar", async () => {
    setIntegration(apiConfig());
    const cf = loadLib();
    setDomain();
    noLocalConfig();
    mockFetch([
      ok({ source: "cloudflare", config: { ingress: baseIngress() } }),
      ok([]),
      ok({ id: "rec1", type: "CNAME", name: "app.example.com", content: CNAME, proxied: true }),
      ok({ config: {} })
    ]);

    const meta = await addIngress(cf, "app.example.com", 8090, { dns: true });
    expect(meta.dns).toBe(true);
    expect(meta.dnsAction).toBe("created");

    expect(calls[2].method).toBe("POST");
    expect(calls[2].body).toMatchObject({ type: "CNAME", name: "app.example.com", content: CNAME, proxied: true });

    expect(calls[3].method).toBe("PUT");
    expect(calls[3].body.config.ingress.map(r => r.hostname)).toEqual([
      "app.example.com",
      "*.example.com",
      "example.com",
      undefined
    ]);
    expect(calls[3].body.config.ingress[0].service).toBe("http://localhost:8090");
  });

  it("buyuk harfli hostname kucuk harfe normalize edilerek eklenir", async () => {
    setIntegration(apiConfig());
    const cf = loadLib();
    setDomain();
    noLocalConfig();
    mockFetch([
      ok({ source: "cloudflare", config: { ingress: baseIngress() } }),
      ok([]),
      ok({ id: "rec1", type: "CNAME", name: "app.example.com", content: CNAME, proxied: true }),
      ok({ config: {} })
    ]);

    const meta = await addIngress(cf, "App.EXAMPLE.com", 8090, { dns: true });
    expect(meta.dns).toBe(true);

    // DNS kaydi da kucuk harfle yazilir.
    expect(calls[2].body).toMatchObject({ type: "CNAME", name: "app.example.com", content: CNAME, proxied: true });
    expect(calls[3].body.config.ingress.map(r => r.hostname)).toEqual([
      "app.example.com",
      "*.example.com",
      "example.com",
      undefined
    ]);
  });

  it("DNS istenmezse hicbir DNS cagrisi yapilmaz", async () => {
    setIntegration(apiConfig());
    const cf = loadLib();
    setDomain();
    noLocalConfig();
    mockFetch([
      ok({ source: "cloudflare", config: { ingress: baseIngress() } }),
      ok({ config: {} })
    ]);
    const meta = await addIngress(cf, "app.example.com", 8090, { dns: false });
    expect(meta.dns).toBe(false);
    expect(calls.some(c => c.url.includes("dns_records"))).toBe(false);
  });

  it("ayni hostname iki kez eklenemez", async () => {
    setIntegration(apiConfig());
    const cf = loadLib();
    setDomain();
    noLocalConfig();
    mockFetch([ok({ source: "cloudflare", config: { ingress: baseIngress() } })]);
    await expect(addIngress(cf, "example.com", 8090, { dns: true })).rejects.toThrow(/zaten kayitli/i);
    expect(calls).toHaveLength(1);
  });

  it("zone disindaki hostname icin DNS kaydi olusturmayi reddeder", async () => {
    setIntegration(apiConfig());
    const cf = loadLib();
    setDomain();
    noLocalConfig();
    mockFetch([ok({ source: "cloudflare", config: { ingress: baseIngress() } })]);
    await expect(addIngress(cf, "app.baska.com", 8090, { dns: true }))
      .rejects.toThrow(/zone'unun altinda degil/i);
    expect(calls).toHaveLength(1);
  });

  it("normal kaydi siler, catch-all listede sonda kalir", async () => {
    setIntegration(apiConfig());
    const cf = loadLib();
    setDomain();
    noLocalConfig();
    const withApp = [
      { hostname: "app.example.com", service: "http://localhost:8090" },
      ...baseIngress()
    ];
    mockFetch([
      ok({ source: "cloudflare", config: { ingress: withApp } }),
      ok({ config: {} })
    ]);
    const meta = await removeIngress(cf, "app.example.com", { dns: false });
    expect(meta.dns).toBe(false);
    expect(calls[1].method).toBe("PUT");
    const sent = calls[1].body.config.ingress;
    expect(sent.map(r => r.hostname)).toEqual(["*.example.com", "example.com", undefined]);
    expect(sent[sent.length - 1].service).toBe("http_status:404");
  });

  it("buyuk harfli silme istegi kucuk harfli kaydi bulur", async () => {
    setIntegration(apiConfig());
    const cf = loadLib();
    setDomain();
    noLocalConfig();
    const withApp = [
      { hostname: "app.example.com", service: "http://localhost:8090" },
      ...baseIngress()
    ];
    mockFetch([
      ok({ source: "cloudflare", config: { ingress: withApp } }),
      ok({ config: {} })
    ]);
    const meta = await removeIngress(cf, "APP.EXAMPLE.COM", { dns: false });
    expect(meta.dns).toBe(false);
    expect(calls[1].method).toBe("PUT");
    const sent = calls[1].body.config.ingress;
    expect(sent.map(r => r.hostname)).toEqual(["*.example.com", "example.com", undefined]);
  });

  it("silerken DNS istenirse yalnizca tunnel CNAME'i silinir", async () => {
    setIntegration(apiConfig());
    const cf = loadLib();
    setDomain();
    noLocalConfig();
    mockFetch([
      ok({ source: "cloudflare", config: { ingress: [{ hostname: "app.example.com", service: "http://localhost:8090" }, ...baseIngress()] } }),
      ok({ config: {} }),
      ok([{ id: RECORD_ID, type: "CNAME", name: "app.example.com", content: CNAME, proxied: true }]),
      ok({})
    ]);
    const meta = await removeIngress(cf, "app.example.com", { dns: true });
    expect(meta.dns).toBe(true);
    expect(calls[3].method).toBe("DELETE");
    expect(calls[3].url).toContain(`/dns_records/${RECORD_ID}`);
  });

  it("baskasina ait DNS kaydina dokunmaz, uyari doner", async () => {
    setIntegration(apiConfig());
    const cf = loadLib();
    setDomain();
    noLocalConfig();
    mockFetch([
      ok({ source: "cloudflare", config: { ingress: [{ hostname: "app.example.com", service: "http://localhost:8090" }, ...baseIngress()] } }),
      ok({ config: {} }),
      ok([{ id: "rec1", type: "A", name: "app.example.com", content: "203.0.113.5", proxied: true }])
    ]);
    const meta = await removeIngress(cf, "app.example.com", { dns: true });
    expect(meta.dns).toBe(false);
    expect(meta.dnsWarning).toMatch(/bu tunnel'a ait degil/i);
    expect(calls.some(c => c.method === "DELETE")).toBe(false);
  });
});

describe("cloudflare / DNS cakismasinda onaysiz yazma yok", () => {
  it("mevcut A kaydi varsa ne DNS'e ne ingress'e yazar", async () => {
    setIntegration(apiConfig());
    const cf = loadLib();
    setDomain();
    noLocalConfig();
    const cfApi = require("../lib/cloudflare-api");
    mockFetch([
      ok({ source: "cloudflare", config: { ingress: baseIngress() } }),
      ok([{ id: "old", type: "A", name: "app.example.com", content: "203.0.113.5", proxied: true }])
    ]);

    let err;
    try {
      await addIngress(cf, "app.example.com", 8090, { dns: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(cfApi.CloudflareDnsConflictError);
    expect(err.conflict).toBe(true);
    expect(err.conflicts[0].content).toBe("203.0.113.5");
    // Sadece iki okuma yapildi; PUT/POST yok.
    expect(calls).toHaveLength(2);
    expect(calls.every(c => c.method === "GET")).toBe(true);
  });

  it("overwrite onaylandiginda mevcut kaydin uzerine yazar ve ingress'i tamamlar", async () => {
    setIntegration(apiConfig());
    const cf = loadLib();
    setDomain();
    noLocalConfig();
    mockFetch([
      ok({ source: "cloudflare", config: { ingress: baseIngress() } }),
      ok([{ id: "old", type: "A", name: "app.example.com", content: "203.0.113.5", proxied: true }]),
      ok({ id: "old", type: "CNAME", name: "app.example.com", content: CNAME, proxied: true }),
      ok({ config: {} })
    ]);
    const meta = await addIngress(cf, "app.example.com", 8090, { dns: true, overwriteDns: true });
    expect(meta.dnsAction).toBe("replaced");
    expect(calls[2].method).toBe("PUT");
    expect(calls[2].url).toContain("/dns_records/old");
    expect(calls[3].method).toBe("PUT");
    expect(calls[3].url).toContain("/configurations");
  });
});

describe("cloudflare / Mod C -> Mod A kesfi", () => {
  // Connector token base64 bir JSON'dur: { a: hesap, t: tunnel, s: secret }.
  function connectorToken() {
    return Buffer.from(JSON.stringify({ a: ACCOUNT_ID, t: TUNNEL_ID, s: "gizli-secret" }))
      .toString("base64");
  }

  function unitText() {
    return `# /etc/systemd/system/cloudflared.service\n[Service]\nExecStart=/usr/bin/cloudflared --no-autoupdate tunnel run --token ${connectorToken()}\n`;
  }

  it("connector token'dan hesap ve tunnel id'sini cikarir", () => {
    const cf = loadLib();
    expect(cf.connectorTokenIds(unitText())).toEqual({ accountId: ACCOUNT_ID, tunnelId: TUNNEL_ID });
    expect(cf.connectorTokenIds("ExecStart=/usr/bin/cloudflared tunnel run")).toBe(null);
    expect(cf.connectorTokenIds("--token " + "x".repeat(60))).toBe(null);
  });

  it("token eklendikten sonra tunnel id'yi cloudflared servisinden kesfeder ve moda yukselir", async () => {
    setIntegration({ apiToken: TOKEN });
    mockExec(cmd => (cmd.includes("systemctl cat") ? { stdout: unitText() } : { err: new Error("yok") }));
    const cf = loadLib();
    noLocalConfig();

    mockFetch([
      ok({ id: "tok1", status: "active" }),
      ok([{ id: ZONE_ID, name: "example.com", status: "active", account: { id: ACCOUNT_ID, name: "Kisisel" } }]),
      ok({ source: "cloudflare", config: { ingress: baseIngress() } })
    ]);

    const r = await cf.discoverConnection({ domain: "example.com" });
    expect(r.tunnelId).toBe(TUNNEL_ID);
    expect(r.accountId).toBe(ACCOUNT_ID);
    expect(r.tunnelIdSource).toBe("connector-token");
    expect(cf.detectMode().mode).toBe(cf.MODE.API);
    expect(cf.detectMode().canManage).toBe(true);

    // Token hicbir cevaba sizmamali.
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(JSON.stringify(r)).not.toContain("gizli-secret");
  });

  it("tunnel id kesfedilemezse uydurmaz, kullanicidan ister", async () => {
    setIntegration({ apiToken: TOKEN });
    const cf = loadLib();
    noLocalConfig();
    mockFetch([
      ok({ id: "tok1", status: "active" }),
      ok([{ id: ZONE_ID, name: "example.com", status: "active", account: { id: ACCOUNT_ID, name: "Kisisel" } }])
    ]);
    let err;
    try {
      await cf.discoverConnection({ domain: "example.com" });
    } catch (e) {
      err = e;
    }
    expect(err.needsTunnelId).toBe(true);
    expect(err.message).toMatch(/elle gir/i);
  });

  it("elle girilen tunnel id kabul edilir", async () => {
    setIntegration({ apiToken: TOKEN });
    const cf = loadLib();
    noLocalConfig();
    mockFetch([
      ok({ id: "tok1", status: "active" }),
      ok([{ id: ZONE_ID, name: "example.com", status: "active", account: { id: ACCOUNT_ID, name: "Kisisel" } }]),
      ok({ source: "cloudflare", config: { ingress: baseIngress() } })
    ]);
    const r = await cf.discoverConnection({ domain: "example.com", tunnelId: TUNNEL_ID });
    expect(r.tunnelIdSource).toBe("manual");
    expect(cf.detectMode().mode).toBe(cf.MODE.API);
  });

  it("token yoksa kesif yapilmaz", async () => {
    const cf = loadLib();
    noLocalConfig();
    mockFetch([]);
    await expect(cf.discoverConnection({})).rejects.toThrow(/token/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("tunnel yerel yonetiliyorsa API modunu acmaz", async () => {
    setIntegration({ apiToken: TOKEN });
    const cf = loadLib();
    noLocalConfig();
    mockFetch([
      ok({ id: "tok1", status: "active" }),
      ok([{ id: ZONE_ID, name: "example.com", status: "active", account: { id: ACCOUNT_ID, name: "Kisisel" } }]),
      ok({ source: "local", config: { ingress: [] } })
    ]);
    await expect(cf.discoverConnection({ domain: "example.com", tunnelId: TUNNEL_ID }))
      .rejects.toThrow(/config dosyasindan yonetiliyor/i);
    expect(cf.detectMode().mode).not.toBe(cf.MODE.API);
  });
});

describe("cloudflare / maskeli ayarlar", () => {
  it("token'in kendisini degil, yalnizca son 4 karakteri dondurur", async () => {
    setIntegration(apiConfig());
    const cf = loadLib();
    setDomain();
    noLocalConfig();
    const s = await new Promise((resolve, reject) => {
      cf.getSettingsMasked((err, out) => (err ? reject(err) : resolve(out)));
    });
    expect(s.hasToken).toBe(true);
    expect(s.tokenPreview).toBe("****" + TOKEN.slice(-4));
    expect(JSON.stringify(s)).not.toContain(TOKEN);
    expect(s.mode).toBe(cf.MODE.API);
    expect(s.tunnelId).toBe(TUNNEL_ID);
  });
});
