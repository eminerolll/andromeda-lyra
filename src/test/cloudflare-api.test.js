// Cloudflare API istemcisi testleri. fetch mock'lanir — gercek ag cagrisi YOK.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { require } from "./setup.js";

const cf = require("../lib/cloudflare-api");

const TOKEN = "cf-test-token-0123456789abcdef";
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const ZONE_ID = "fedcba9876543210fedcba9876543210";
const TUNNEL_ID = "11111111-2222-3333-4444-555555555555";

let calls;
let originalFetch;

// Sirayla verilen cevaplari donduren fetch mock'u.
function mockFetch(responses) {
  const queue = [...responses];
  global.fetch = vi.fn(async (url, opts = {}) => {
    calls.push({
      url,
      method: opts.method || "GET",
      headers: opts.headers || {},
      body: opts.body ? JSON.parse(opts.body) : null
    });
    const next = queue.shift();
    if (!next) throw new Error(`Beklenmeyen fetch: ${url}`);
    if (typeof next === "function") return next();
    return {
      status: next.status || 200,
      json: async () => next.json
    };
  });
}

function ok(result) {
  return { status: 200, json: { success: true, errors: [], messages: [], result } };
}

function fail(status, errors) {
  return { status, json: { success: false, errors, messages: [], result: null } };
}

beforeEach(() => {
  calls = [];
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("cloudflare-api / token", () => {
  it("aktif token'i kabul eder ve Bearer basligi gonderir", async () => {
    mockFetch([ok({ id: "tok1", status: "active" })]);
    const r = await cf.verifyToken(TOKEN);
    expect(r.status).toBe("active");
    expect(calls[0].url).toBe("https://api.cloudflare.com/client/v4/user/tokens/verify");
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("aktif olmayan token'i reddeder", async () => {
    mockFetch([ok({ id: "tok1", status: "disabled" })]);
    await expect(cf.verifyToken(TOKEN)).rejects.toThrow(/aktif degil/i);
  });

  it("cok kisa token'da ag cagrisi bile yapmaz", async () => {
    mockFetch([]);
    await expect(cf.verifyToken("kisa")).rejects.toThrow(/eksik veya cok kisa/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("cloudflare-api / hata cevirisi", () => {
  it("yetki hatasinda eksik izni Turkce olarak soyler", async () => {
    mockFetch([fail(403, [{ code: 9109, message: "Unauthorized to access requested resource" }])]);
    let err;
    try {
      await cf.createTunnel(TOKEN, ACCOUNT_ID, "lyra");
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(err.message).toContain("Token bu kaynaga erisemiyor");
    expect(err.message).toContain("Account > Cloudflare Tunnel > Edit");
    expect(err.codes).toEqual([9109]);
  });

  it("DNS yetki hatasinda Zone > DNS > Edit izni onerilir", async () => {
    mockFetch([fail(403, [{ code: 10000, message: "Authentication error" }])]);
    await expect(cf.listDnsRecords(TOKEN, ZONE_ID)).rejects.toThrow(/Zone > DNS > Edit/);
  });

  it("bilinmeyen kodda Cloudflare'in kendi mesajini kodla birlikte gosterir", async () => {
    mockFetch([fail(400, [{ code: 4242, message: "something odd" }])]);
    await expect(cf.listAccounts(TOKEN)).rejects.toThrow(/something odd \(kod 4242\)/);
  });

  it("ag hatasinda anlasilir mesaj verir ve token'i sizdirmaz", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED using ${TOKEN}`);
    });
    let err;
    try {
      await cf.verifyToken(TOKEN);
    } catch (e) {
      err = e;
    }
    expect(err.message).toMatch(/ulasilamadi/i);
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain("<token>");
  });

  it("JSON olmayan cevabi anlasilir hataya cevirir", async () => {
    global.fetch = vi.fn(async () => ({
      status: 502,
      json: async () => { throw new Error("not json"); }
    }));
    await expect(cf.verifyToken(TOKEN)).rejects.toThrow(/beklenmeyen bir cevap.*502/i);
  });
});

describe("cloudflare-api / hesap ve zone", () => {
  it("tek hesabi otomatik secer", async () => {
    mockFetch([ok([{ id: ACCOUNT_ID, name: "Kisisel" }])]);
    const r = await cf.resolveAccount(TOKEN);
    expect(r.account.id).toBe(ACCOUNT_ID);
  });

  it("birden fazla hesapta sessizce secim yapmaz", async () => {
    mockFetch([ok([
      { id: ACCOUNT_ID, name: "Kisisel" },
      { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "Sirket" }
    ])]);
    const r = await cf.resolveAccount(TOKEN);
    expect(r.account).toBe(null);
    expect(r.accounts).toHaveLength(2);
  });

  // Hesap hicbir yoldan cozulemediginde mesaj YANILTICI OLMAMALI: /accounts'un
  // bos donmesi token'in yetersizligi degil, Account Settings: Read izninin
  // olmayisidir. Kullaniciya hesap id'sini elle girebilecegi soylenir.
  it("hicbir yoldan hesap cozulemezse elle girme yonergesi verir", async () => {
    mockFetch([ok([])]);
    let err;
    try {
      await cf.resolveAccount(TOKEN);
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(err.message).toContain("Account Settings: Read");
    expect(err.message).toContain("elle girebilirsin");
    expect(err.message).not.toMatch(/hicbir Cloudflare hesabina erisemiyor/i);
  });

  it("bos hesap listesi tek basina hata degildir", async () => {
    mockFetch([ok([])]);
    await expect(cf.listAccounts(TOKEN)).resolves.toEqual([]);
  });

  it("zone'u isme gore bulur ve zone'un hesabini birlikte dondurur", async () => {
    mockFetch([ok([{
      id: ZONE_ID,
      name: "example.com",
      status: "active",
      account: { id: ACCOUNT_ID, name: "Kisisel" }
    }])]);
    const zone = await cf.findZone(TOKEN, "  HTTPS://Example.com/  ");
    expect(zone).toEqual({
      id: ZONE_ID,
      name: "example.com",
      status: "active",
      account: { id: ACCOUNT_ID, name: "Kisisel" }
    });
    expect(calls[0].url).toContain("/zones?name=example.com");
  });

  it("zone bulunamazsa apex uyarisiyla birlikte hata verir", async () => {
    mockFetch([ok([])]);
    await expect(cf.findZone(TOKEN, "example.com")).rejects.toThrow(/bulunamadi[\s\S]*apex/i);
  });
});

// Canli olarak yasanan durum: onerdigimiz dar kapsamli token (Cloudflare
// Tunnel: Edit + DNS: Edit) ile GET /accounts hata degil, success:true + BOS
// liste donuyor — cunku hesap listeleme "Account Settings: Read" istiyor. Ayni
// token account-scoped tunnel islemlerini sorunsuz yapabiliyor. Bu yuzden hesap
// id'si zone'dan turetilmeli ve akis devam etmeli.
describe("cloudflare-api / dar kapsamli token ile hesap kesfi", () => {
  const ZONE = {
    id: ZONE_ID,
    name: "example.com",
    status: "active",
    account: { id: ACCOUNT_ID, name: "Kisisel" }
  };

  it("GET /accounts bos donerken hesap id'si zone'dan turetilir ve akis devam eder", async () => {
    // Sadece zone cagrisi mock'lanir; /accounts hic cagrilmamali.
    mockFetch([
      ok([ZONE]),
      ok({ id: TUNNEL_ID, name: "lyra-example-com" })
    ]);

    const zone = await cf.findZone(TOKEN, "example.com");
    const { account, source } = await cf.resolveAccount(TOKEN, null, { zone });

    expect(account).toEqual({ id: ACCOUNT_ID, name: "Kisisel" });
    expect(source).toBe("zone");
    expect(calls).toHaveLength(1);
    expect(calls.some(c => c.url.includes("/accounts?"))).toBe(false);

    // Akis kesilmiyor: cozulen hesapla tunnel olusturulabiliyor.
    const tunnel = await cf.createTunnel(TOKEN, account.id, "lyra-example-com");
    expect(tunnel.id).toBe(TUNNEL_ID);
    expect(calls[1].url).toContain(`/accounts/${ACCOUNT_ID}/cfd_tunnel`);
  });

  it("zone'dan hesap geldiginde /accounts'a hic dusmez", async () => {
    mockFetch([]);
    const r = await cf.resolveAccount(TOKEN, null, { zone: ZONE });
    expect(r.account.id).toBe(ACCOUNT_ID);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("elle verilen hesap id'si zone'daki hesabin onune gecer", async () => {
    const manual = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    mockFetch([]);
    const r = await cf.resolveAccount(TOKEN, manual, { zone: ZONE });
    expect(r.account.id).toBe(manual);
    expect(r.source).toBe("manual");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("elle verilen id zone'daki hesapla ayniysa hesap adi korunur", async () => {
    mockFetch([]);
    const r = await cf.resolveAccount(TOKEN, ACCOUNT_ID, { zone: ZONE });
    expect(r.account).toEqual({ id: ACCOUNT_ID, name: "Kisisel" });
  });

  it("zone'da hesap yoksa yedek olarak /accounts denenir", async () => {
    mockFetch([ok([{ id: ACCOUNT_ID, name: "Kisisel" }])]);
    const r = await cf.resolveAccount(TOKEN, null, {
      zone: { id: ZONE_ID, name: "example.com", status: "active" }
    });
    expect(r.account.id).toBe(ACCOUNT_ID);
    expect(r.source).toBe("list");
    expect(calls[0].url).toContain("/accounts?");
  });

  it("yedek yol yetki hatasi verse bile yanlis mesaj yerine elle girme yonergesi cikar", async () => {
    mockFetch([fail(403, [{ code: 9109, message: "Unauthorized to access requested resource" }])]);
    await expect(cf.resolveAccount(TOKEN)).rejects.toThrow(/Account Settings: Read/);
  });
});

describe("cloudflare-api / tunnel", () => {
  it("tunnel'i remotely-managed olarak ve 32 baytlik base64 secret ile olusturur", async () => {
    mockFetch([ok({ id: TUNNEL_ID, name: "lyra-example-com" })]);
    const t = await cf.createTunnel(TOKEN, ACCOUNT_ID, "lyra-example-com");
    expect(t.id).toBe(TUNNEL_ID);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/cfd_tunnel`);
    expect(calls[0].body.name).toBe("lyra-example-com");
    expect(calls[0].body.config_src).toBe("cloudflare");
    expect(Buffer.from(calls[0].body.tunnel_secret, "base64")).toHaveLength(32);
  });

  it("connector token'i dondurur", async () => {
    const connector = "e".repeat(120);
    mockFetch([ok(connector)]);
    const t = await cf.getTunnelToken(TOKEN, ACCOUNT_ID, TUNNEL_ID);
    expect(t).toBe(connector);
    expect(calls[0].url).toContain(`/cfd_tunnel/${TUNNEL_ID}/token`);
  });

  it("gecersiz tunnel id'yi path'e koymadan reddeder", async () => {
    mockFetch([]);
    await expect(cf.getTunnelToken(TOKEN, ACCOUNT_ID, "../../evil")).rejects.toThrow(/Gecersiz tunnel id/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("tunnel siler", async () => {
    mockFetch([ok({})]);
    await cf.deleteTunnel(TOKEN, ACCOUNT_ID, TUNNEL_ID);
    expect(calls[0].method).toBe("DELETE");
  });
});

describe("cloudflare-api / ingress", () => {
  it("wildcard once, apex sonra, catch-all EN SONDA olacak sekilde kurar", () => {
    const rules = cf.buildIngress({ domain: "example.com", port: 3000 });
    expect(rules).toEqual([
      { hostname: "*.example.com", service: "http://localhost:3000" },
      { hostname: "example.com", service: "http://localhost:3000" },
      { service: "http_status:404" }
    ]);
    expect(cf.isCatchAll(rules[rules.length - 1])).toBe(true);
  });

  it("apex istenmediginde apex kuralini eklemez ama catch-all yine sonda kalir", () => {
    const rules = cf.buildIngress({ domain: "example.com", port: 3000, includeApex: false });
    expect(rules.map(r => r.hostname)).toEqual(["*.example.com", undefined]);
    expect(rules[rules.length - 1].service).toBe("http_status:404");
  });

  it("PUT govdesini {config:{ingress}} seklinde gonderir", async () => {
    mockFetch([ok({ config: {} })]);
    const rules = cf.buildIngress({ domain: "example.com", port: 3000 });
    await cf.putIngress(TOKEN, ACCOUNT_ID, TUNNEL_ID, rules);
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toContain(`/cfd_tunnel/${TUNNEL_ID}/configurations`);
    expect(calls[0].body).toEqual({ config: { ingress: rules } });
  });

  it("son eleman catch-all degilse gondermeyi reddeder", async () => {
    mockFetch([]);
    const bad = [
      { service: "http_status:404" },
      { hostname: "example.com", service: "http://localhost:3000" }
    ];
    await expect(cf.putIngress(TOKEN, ACCOUNT_ID, TUNNEL_ID, bad)).rejects.toThrow(/son elemani.*catch-all/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("mevcut ingress'i ve remotely-managed bilgisini okur", async () => {
    mockFetch([ok({ source: "cloudflare", config: { ingress: [{ service: "http_status:404" }] } })]);
    const r = await cf.getIngress(TOKEN, ACCOUNT_ID, TUNNEL_ID);
    expect(r.source).toBe("cloudflare");
    expect(r.ingress).toHaveLength(1);
  });
});

describe("cloudflare-api / DNS cakisma tespiti", () => {
  const cname = `${TUNNEL_ID}.cfargotunnel.com`;

  it("kayit yoksa olusturur", async () => {
    mockFetch([
      ok([]),
      ok({ id: "rec1", type: "CNAME", name: "example.com", content: cname, proxied: true })
    ]);
    const r = await cf.upsertDnsRecord(
      TOKEN, ZONE_ID,
      { type: "CNAME", name: "@", content: cname, proxied: true },
      { zoneName: "example.com" }
    );
    expect(r.action).toBe("created");
    expect(calls[0].url).toContain("name=example.com");
    expect(calls[1].method).toBe("POST");
    expect(calls[1].body.name).toBe("example.com");
  });

  it("wildcard adini zone ile birlestirir", async () => {
    mockFetch([ok([]), ok({ id: "rec2" })]);
    await cf.upsertDnsRecord(
      TOKEN, ZONE_ID,
      { type: "CNAME", name: "*", content: cname, proxied: true },
      { zoneName: "example.com" }
    );
    expect(calls[1].body.name).toBe("*.example.com");
  });

  // Gercek kullanici tuzagi: apex'te eski hosting saglayicisindan kalmis bir A
  // kaydi. Onay olmadan ne silinir ne degistirilir.
  it("apex'te mevcut A kaydi varsa onaysiz DOKUNMAZ ve kaydin detayini soyler", async () => {
    mockFetch([
      ok([{ id: "old", type: "A", name: "example.com", content: "203.0.113.10", proxied: true }])
    ]);
    let err;
    try {
      await cf.upsertDnsRecord(
        TOKEN, ZONE_ID,
        { type: "CNAME", name: "@", content: cname, proxied: true },
        { zoneName: "example.com" }
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(cf.CloudflareDnsConflictError);
    expect(err.conflict).toBe(true);
    expect(err.conflicts).toHaveLength(1);
    expect(err.conflicts[0].content).toBe("203.0.113.10");
    expect(err.message).toContain("A example.com -> 203.0.113.10");
    expect(err.message).toContain("uzerine yaz");
    // Sadece listeleme yapildi; hicbir yazma cagrisi yok.
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
  });

  it("overwrite ile mevcut kaydin uzerine yazar, fazlalari siler", async () => {
    mockFetch([
      ok([
        { id: "old1", type: "A", name: "example.com", content: "203.0.113.10", proxied: true },
        { id: "old2", type: "A", name: "example.com", content: "203.0.113.11", proxied: true }
      ]),
      ok({ id: "old1", type: "CNAME", name: "example.com", content: cname, proxied: true }),
      ok({ id: "old2" })
    ]);
    const r = await cf.upsertDnsRecord(
      TOKEN, ZONE_ID,
      { type: "CNAME", name: "@", content: cname, proxied: true },
      { zoneName: "example.com", overwrite: true }
    );
    expect(r.action).toBe("replaced");
    expect(r.replaced).toHaveLength(2);
    expect(calls[1].method).toBe("PUT");
    expect(calls[1].url).toContain("/dns_records/old1");
    expect(calls[1].body.type).toBe("CNAME");
    expect(calls[2].method).toBe("DELETE");
    expect(calls[2].url).toContain("/dns_records/old2");
  });

  it("istenen kayit zaten duruyorsa hicbir sey yazmaz", async () => {
    mockFetch([
      ok([{ id: "rec", type: "CNAME", name: "*.example.com", content: cname, proxied: true }])
    ]);
    const r = await cf.upsertDnsRecord(
      TOKEN, ZONE_ID,
      { type: "CNAME", name: "*", content: cname, proxied: true },
      { zoneName: "example.com" }
    );
    expect(r.action).toBe("unchanged");
    expect(calls).toHaveLength(1);
  });

  it("zoneName verilmediyse zone'u id ile cozer", async () => {
    mockFetch([
      ok({ id: ZONE_ID, name: "example.com", status: "active" }),
      ok([]),
      ok({ id: "rec3" })
    ]);
    await cf.upsertDnsRecord(
      TOKEN, ZONE_ID,
      { type: "CNAME", name: "@", content: cname, proxied: true }
    );
    expect(calls[0].url).toContain(`/zones/${ZONE_ID}`);
    expect(calls[2].body.name).toBe("example.com");
  });
});

describe("cloudflare-api / yardimcilar", () => {
  it("tunnel CNAME hedefini uretir", () => {
    expect(cf.tunnelCname(TUNNEL_ID)).toBe(`${TUNNEL_ID}.cfargotunnel.com`);
  });

  it("gecersiz domain'i normalize etmez", () => {
    expect(cf.normalizeDomain("not a domain")).toBe(null);
    expect(cf.normalizeDomain("localhost")).toBe(null);
    expect(cf.normalizeDomain("Example.COM.")).toBe("example.com");
  });

  it("toFqdn zone ekini iki kez eklemez", () => {
    expect(cf.toFqdn("@", "example.com")).toBe("example.com");
    expect(cf.toFqdn("*", "example.com")).toBe("*.example.com");
    expect(cf.toFqdn("lyra", "example.com")).toBe("lyra.example.com");
    expect(cf.toFqdn("lyra.example.com", "example.com")).toBe("lyra.example.com");
  });
});
