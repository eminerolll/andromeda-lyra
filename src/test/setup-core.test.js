// lib/setup-core.js — tarayici sihirbazi (routes/setup.js) ile terminal
// sihirbazinin (scripts/setup-cli.js) PAYLASTIGI cekirdek.
//
// Bu testlerin varlik sebebi: iki arayuzun ayrisip ayri gerceklik
// uretmesini engellemek. Dogrulama/seed kurallari burada kirilirsa ikisi de
// kirilir — bu istenen davranis.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { freshHome, cleanup, require } from "./setup.js";

function baseBody(over = {}) {
  return {
    accessMode: "lan",
    appName: "Lyra",
    projectsDir: "/home/lyra/projects",
    user: { username: "admin", password: "supersecret1234", enable2FA: false },
    services: [],
    integrations: {},
    ...over
  };
}

describe("setup-core validateFinalize", () => {
  let home;
  beforeEach(() => {
    home = freshHome();
    require("../db/migrate").migrate();
  });
  afterEach(() => cleanup(home));

  it("gecerli lan govdesinde hata uretmez", () => {
    const core = require("../lib/setup-core");
    expect(core.validateFinalize(baseBody()).errors).toEqual([]);
  });

  it("kisa sifreyi reddeder", () => {
    const core = require("../lib/setup-core");
    const { errors } = core.validateFinalize(
      baseBody({ user: { username: "admin", password: "kisa", enable2FA: false } })
    );
    expect(errors.join(" ")).toMatch(/12 karakter/);
  });

  it("bilinmeyen erisim modunu reddeder", () => {
    const core = require("../lib/setup-core");
    const { errors } = core.validateFinalize(baseBody({ accessMode: "uzay" }));
    expect(errors.join(" ")).toMatch(/Bilinmeyen erisim modu/);
  });

  it("public modda domain ve email ister", () => {
    const core = require("../lib/setup-core");
    const { errors } = core.validateFinalize(baseBody({ accessMode: "public" }));
    expect(errors.join(" ")).toMatch(/domain ve email/);
  });

  it("cf-tunnel modda connector token ister", () => {
    const core = require("../lib/setup-core");
    const { errors } = core.validateFinalize(baseBody({ accessMode: "cf-tunnel" }));
    expect(errors.join(" ")).toMatch(/connector token/);
  });

  it("cf-api modda API token ve domain ister", () => {
    const core = require("../lib/setup-core");
    const { errors } = core.validateFinalize(baseBody({ accessMode: "cf-api" }));
    expect(errors.join(" ")).toMatch(/Cloudflare API token/);
    expect(errors.join(" ")).toMatch(/domain/i);
  });

  it("2FA istenmisse dogrulama yapilmadan gecmez", () => {
    const core = require("../lib/setup-core");
    const body = baseBody({
      user: { username: "admin", password: "supersecret1234", enable2FA: true }
    });
    expect(core.validateFinalize(body, { totpVerified: false }).errors.join(" ")).toMatch(
      /2FA dogrulamasi/
    );
    expect(core.validateFinalize(body, { totpVerified: true }).errors).toEqual([]);
  });

  it("uygulama adi ve projeler dizini zorunlu", () => {
    const core = require("../lib/setup-core");
    const { errors } = core.validateFinalize(baseBody({ appName: "  ", projectsDir: "" }));
    expect(errors).toContain("Uygulama adi gerekli");
    expect(errors).toContain("Projeler dizini gerekli");
  });
});

describe("setup-core cf plan", () => {
  let home;
  beforeEach(() => {
    home = freshHome();
    require("../db/migrate").migrate();
  });
  afterEach(() => cleanup(home));

  it("apex modunda panel host domain'in kendisidir", () => {
    const core = require("../lib/setup-core");
    const plan = core.cfPlanFromBody({ domain: "Ornek.COM", cfApiToken: "t" });
    expect(plan.domain).toBe("ornek.com");
    expect(plan.hostMode).toBe("apex");
    expect(plan.panelHost).toBe("ornek.com");
  });

  it("subdomain modunda panel host alt alan adidir", () => {
    const core = require("../lib/setup-core");
    const plan = core.cfPlanFromBody({
      domain: "ornek.com",
      cfApiToken: "t",
      cfHostMode: "subdomain",
      cfPanelSubdomain: "panel"
    });
    expect(plan.panelHost).toBe("panel.ornek.com");
  });

  it("gecersiz alt alan adi null doner", () => {
    const core = require("../lib/setup-core");
    expect(core.normalizePanelSub("-kotu-")).toBeNull();
    expect(core.normalizePanelSub("")).toBe(core.DEFAULT_PANEL_SUBDOMAIN);
  });
});

describe("setup-core adimlar ve ilerleme", () => {
  let home;
  beforeEach(() => {
    home = freshHome();
    require("../db/migrate").migrate();
  });
  afterEach(() => cleanup(home));

  it("moda gore adim listesi uretir", () => {
    const core = require("../lib/setup-core");
    const keys = (m) => core.buildSteps(m).map((s) => s.key);
    expect(keys("lan")).toEqual(["firewall", "setup-mode-off", "lyra-restart"]);
    expect(keys("public")).toContain("caddy-install");
    expect(keys("public")).toContain("caddy-config");
    expect(keys("cf-api")).toContain("cf-dns");
    expect(keys("cf-tunnel")).toContain("cloudflared-service");
    expect(keys("cf-tunnel")).not.toContain("cf-dns");
  });

  it("cf-provision modu SADECE Cloudflare adimlarini uretir", () => {
    const core = require("../lib/setup-core");
    // install.sh bunu sihirbazdan once calistirir: kurulum sonrasi adimlar
    // (firewall / mod degisimi / restart) o sirada calismamali.
    expect(core.buildSteps("cf-provision").map((s) => s.key)).toEqual([
      "cf-verify",
      "cf-tunnel",
      "cf-ingress",
      "cf-dns",
      "cloudflared-install",
      "cloudflared-service"
    ]);
  });

  it("cf-api tunnel onceden kurulduysa CF adimlari listeye girmez", () => {
    const core = require("../lib/setup-core");
    const keys = core.buildSteps("cf-api", { cfProvisioned: true }).map((s) => s.key);
    expect(keys).toEqual(["firewall", "setup-mode-off", "lyra-restart"]);
  });

  it("runStep basari/hata durumunu ve not'u kaydeder", async () => {
    const core = require("../lib/setup-core");
    const seen = [];
    const p = core.createProgress({ onUpdate: (s) => seen.push(`${s.key}:${s.status}`) });
    p.start("lan", "http://127.0.0.1:3000");

    expect(await p.runStep("firewall", async () => "kural yok")).toBe(true);
    expect(p.step("firewall").status).toBe("ok");
    expect(p.step("firewall").note).toBe("kural yok");

    expect(
      await p.runStep("setup-mode-off", async () => {
        throw new Error("patladi");
      })
    ).toBe(false);
    expect(p.step("setup-mode-off").status).toBe("failed");
    expect(p.step("setup-mode-off").error).toBe("patladi");

    expect(seen).toContain("firewall:running");
    expect(seen).toContain("firewall:ok");
    expect(seen).toContain("setup-mode-off:failed");

    const payload = p.payload();
    expect(payload.failed).toBe(true);
    expect(payload.finalUrl).toBe("http://127.0.0.1:3000");
    p.finish();
    expect(p.payload().finished).toBe(true);
  });

  // Ucuncu parti kurulum scriptleri (code-server'in resmi install.sh'i, Caddy,
  // cloudflared) hata metnine curl'un ilerleme cubugunu tasiyabilir. Kullaniciya
  // giden step.error KISA olmali; ham hali journal'a (console.error) gitmeli.
  it("runStep hata metnini ozetler, hamini journal'a birakir", async () => {
    const core = require("../lib/setup-core");
    const installer = require("../lib/service-installer");

    let noise = "";
    for (let i = 0; i < 3000; i++) noise += `#=#=# ${(i / 40).toFixed(1)}% ${"#".repeat(20)}\r`;
    const raw = `${noise}\nE: Sub-process /usr/bin/dpkg returned an error code (1)`;

    const journal = [];
    const originalError = console.error;
    console.error = (m) => journal.push(String(m));

    const p = core.createProgress();
    p.start("lan", "http://127.0.0.1:3000");
    try {
      await p.runStep("firewall", async () => {
        throw new Error(raw);
      });
    } finally {
      console.error = originalError;
    }

    const shown = p.step("firewall").error;
    expect(shown).toBe("E: Sub-process /usr/bin/dpkg returned an error code (1)");
    expect(shown.length).toBeLessThanOrEqual(
      installer.SUMMARY_MAX_CHARS + installer.SUMMARY_TRUNCATED_HINT.length + 1
    );
    // Ham cikti kaybolmadi: "lyra logs" ile okunabilecek yerde duruyor.
    expect(journal.join("\n")).toContain("#=#=#");
  });

  it("deriveFinalUrl moda gore adres uretir", () => {
    const core = require("../lib/setup-core");
    expect(core.deriveFinalUrl("public", "ornek.com")).toBe("https://ornek.com");
    expect(core.deriveFinalUrl("cf-api", "lyra.ornek.com")).toBe("https://lyra.ornek.com");
    expect(core.deriveFinalUrl("lan", null)).toMatch(/^http:\/\/<sunucu-ip>:/);
    expect(core.deriveFinalUrl("localhost", null)).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });
});

describe("setup-core applyFinalize", () => {
  let home;
  beforeEach(() => {
    home = freshHome();
    require("../db/migrate").migrate();
  });
  afterEach(() => cleanup(home));

  it("ayarlari, admin'i ve seed edilen anahtarlari yazar", () => {
    const core = require("../lib/setup-core");
    const { settings, users } = require("../db/repos");

    const applied = core.applyFinalize(
      baseBody({
        appName: "Panelim",
        projectsDir: "/srv/projects",
        integrations: { github: { token: "gh_abc" } }
      })
    );

    expect(applied.accessMode).toBe("lan");
    expect(settings.get("app_name")).toBe("Panelim");
    expect(settings.get("projects_dir")).toBe("/srv/projects");
    // lan modunda LAN'a bind edilir, tunnel modlarinda loopback'te kalinir.
    expect(settings.get("bind_address")).toBe("0.0.0.0");
    expect(settings.get("public_access")).toBe(false);
    // Ports ve Logs sekmelerinin ihtiyac duydugu seed'ler.
    expect(settings.get("lyra_service_name")).toBe("lyra");
    expect(Array.isArray(settings.get("system_ports"))).toBe(true);

    const admin = users.getAdmin();
    expect(admin.username).toBe("admin");
    expect(admin.totp_enabled).toBe(0);

    const { integrations } = require("../db/repos");
    expect(integrations.get("github").config.token).toBe("gh_abc");
  });

  it("cf-api modunda panel host ve loopback bind yazilir", () => {
    const core = require("../lib/setup-core");
    const { settings } = require("../db/repos");

    const applied = core.applyFinalize(
      baseBody({
        accessMode: "cf-api",
        domain: "ornek.com",
        cfApiToken: "t",
        cfHostMode: "subdomain",
        cfPanelSubdomain: "panel"
      })
    );

    expect(applied.panelHost).toBe("panel.ornek.com");
    expect(applied.finalUrl).toBe("https://panel.ornek.com");
    expect(settings.get("base_domain")).toBe("ornek.com");
    expect(settings.get("panel_host")).toBe("panel.ornek.com");
    expect(settings.get("bind_address")).toBe("127.0.0.1");
    expect(settings.get("public_access")).toBe(true);
  });

  it("2FA acikken secret kaydedilir, kapaliyken kaydedilmez", () => {
    const core = require("../lib/setup-core");
    const { users } = require("../db/repos");

    core.applyFinalize(
      baseBody({ user: { username: "admin", password: "supersecret1234", enable2FA: true } }),
      { totpSecret: "SECRET123" }
    );
    const admin = users.getAdmin();
    expect(admin.totp_enabled).toBe(1);
    expect(admin.totp_secret).toBe("SECRET123");
  });
});

describe("setup-core kurulum oncesi Cloudflare (cf_provisioned)", () => {
  let home;
  beforeEach(() => {
    home = freshHome();
    require("../db/migrate").migrate();
  });
  afterEach(() => cleanup(home));

  // install.sh tunnel'i kurdugunda yazdigi ayarlarin taklidi
  // (bkz. setup-core provisionCloudflare).
  function seedProvisioned(panelHost = "lyra.ornek.com", domain = "ornek.com") {
    const { settings } = require("../db/repos");
    settings.setMany({
      access_mode: "cf-api",
      base_domain: domain,
      panel_host: panelHost,
      public_access: true,
      bind_address: "127.0.0.1",
      cf_provisioned: true
    });
  }

  it("bayrak yokken isCfProvisioned false", () => {
    const core = require("../lib/setup-core");
    expect(core.isCfProvisioned()).toBe(false);
    expect(core.cfProvisionedInfo()).toBeNull();
  });

  it("bayrak varsa domain ve panel host'u doner", () => {
    const core = require("../lib/setup-core");
    seedProvisioned();
    expect(core.cfProvisionedInfo()).toEqual({
      domain: "ornek.com",
      panelHost: "lyra.ornek.com"
    });
  });

  it("panel_host eksikse yarim kurulumu 'kurulmus' saymaz", () => {
    const core = require("../lib/setup-core");
    const { settings } = require("../db/repos");
    settings.setMany({ cf_provisioned: true, base_domain: "ornek.com" });
    expect(core.isCfProvisioned()).toBe(false);
  });

  it("token/domain sorulmadigi icin finalize dogrulamasi bunlari istemez", () => {
    const core = require("../lib/setup-core");
    seedProvisioned();
    // Tarayici sihirbazi cf-api modunda ARTIK token gondermez.
    const { errors } = core.validateFinalize(baseBody({ accessMode: "cf-api" }));
    expect(errors).toEqual([]);
    // Bayrak yokken ayni govde reddedilmeli — kural gevsemis olmamali.
    const { settings } = require("../db/repos");
    settings.remove("cf_provisioned");
    expect(core.validateFinalize(baseBody({ accessMode: "cf-api" })).errors.join(" ")).toMatch(
      /Cloudflare API token/
    );
  });

  it("applyFinalize domain/panel host'u ayarlardan okur", () => {
    const core = require("../lib/setup-core");
    const { settings } = require("../db/repos");
    seedProvisioned("panel.ornek.com");

    const applied = core.applyFinalize(baseBody({ accessMode: "cf-api" }));
    expect(applied.panelHost).toBe("panel.ornek.com");
    expect(applied.finalUrl).toBe("https://panel.ornek.com");
    expect(settings.get("base_domain")).toBe("ornek.com");
    expect(settings.get("panel_host")).toBe("panel.ornek.com");
    expect(settings.get("bind_address")).toBe("127.0.0.1");
    expect(settings.get("public_access")).toBe(true);
  });
});

// Sihirbazin servis adimi: "sec, kur, kaydet". Testler MOCK'LU — hicbiri
// gercekten paket kurmaz; service-detect ve service-installer'in ilgili
// fonksiyonlari test icinde degistirilir (freshHome her testten once lib
// modul cache'ini temizledigi icin degisiklik sizmaz).
describe("setup-core servis secimi ve kurulumu", () => {
  let home;
  beforeEach(() => {
    home = freshHome();
    require("../db/migrate").migrate();
  });
  afterEach(() => cleanup(home));

  // detectAll ciktisinin taklidi.
  function svc(type, over = {}) {
    return {
      type,
      display_name: type,
      description: "",
      unit_name: null,
      binary_present: false,
      installed: false,
      active: false,
      default_port: 1234,
      installable: true,
      arch_supported: true,
      requires: [],
      missing_requirements: [],
      install_reason: null,
      est_ram_mb: 100,
      est_disk_mb: 100,
      default_selected: false,
      install_source: "test",
      ...over
    };
  }

  function mockDetect(rows) {
    const detect = require("../lib/service-detect");
    detect.detectAll = () => rows.map((r) => ({ ...r }));
    return detect;
  }

  const DETECTED = [
    svc("code-server", { default_selected: true }),
    svc("filebrowser"),
    svc("dbgate", {
      installable: false,
      requires: ["docker"],
      missing_requirements: ["docker"],
      install_reason: "Docker kurulu degil — Lyra Docker'i otomatik kurmaz."
    }),
    svc("mongod", { installed: true, unit_name: "mongod", active: true, default_port: 27017 })
  ];

  it("zaten kurulu servis tekrar kurulmaz, kurulamayan listeye girmez", () => {
    const core = require("../lib/setup-core");
    const pick = ["code-server", "filebrowser", "dbgate", "mongod", "yok-boyle"];
    expect(core.servicesToInstall(pick, DETECTED)).toEqual(["code-server", "filebrowser"]);
  });

  it("kurulacak her servis AYRI bir adim olur", () => {
    const core = require("../lib/setup-core");
    const keys = core
      .buildSteps("lan", { installServices: ["code-server", "filebrowser"] })
      .map((s) => s.key);
    expect(keys).toEqual([
      "service-install:code-server",
      "service-install:filebrowser",
      "firewall",
      "setup-mode-off",
      "lyra-restart"
    ]);
  });

  it("servisler erisim katmanindan ONCE kurulur (Caddyfile onlari gorsun)", () => {
    const core = require("../lib/setup-core");
    const keys = core.buildSteps("public", { installServices: ["code-server"] }).map((s) => s.key);
    expect(keys.indexOf("service-install:code-server")).toBeLessThan(keys.indexOf("caddy-config"));
  });

  it("servis secilmezse adim listesi degismez", () => {
    const core = require("../lib/setup-core");
    expect(core.buildSteps("lan").map((s) => s.key)).toEqual([
      "firewall",
      "setup-mode-off",
      "lyra-restart"
    ]);
  });

  it("dogrulama kurulamayan servisi sebebiyle reddeder", () => {
    const core = require("../lib/setup-core");
    const opts = { detected: DETECTED };
    expect(
      core.validateFinalize(baseBody({ services: ["code-server", "mongod"] }), opts).errors
    ).toEqual([]);

    const blocked = core.validateFinalize(baseBody({ services: ["dbgate"] }), opts).errors;
    expect(blocked.join(" ")).toMatch(/kurulamaz/);
    expect(blocked.join(" ")).toMatch(/Docker/);

    const unknown = core.validateFinalize(baseBody({ services: ["redis"] }), opts).errors;
    expect(unknown.join(" ")).toMatch(/Bilinmeyen servis: redis/);

    expect(core.validateFinalize(baseBody({ services: "code-server" }), opts).errors).toContain(
      "services bir liste olmali"
    );
  });

  it("applyFinalize kurulu olani hemen kaydeder, kurulacagi kuruluma birakir", () => {
    mockDetect(DETECTED);
    const core = require("../lib/setup-core");
    const { services, settings } = require("../db/repos");

    const applied = core.applyFinalize(baseBody({ services: ["code-server", "mongod"] }));

    // Kurulmamis servis "yonetiliyor" diye yazilmaz.
    expect(applied.installServices).toEqual(["code-server"]);
    expect(services.list().map((s) => s.type)).toEqual(["mongod"]);
    // Kurulacak servisin portu simdiden sistem portu sayilir (Ports sekmesi
    // onu "dev portu" gorup oldurmesin).
    expect(settings.get("system_ports")).toContain(8080);
  });

  it("bir kurulum patlarken digerleri devam eder", async () => {
    mockDetect(DETECTED);
    const installer = require("../lib/service-installer");
    const core = require("../lib/setup-core");
    const { services } = require("../db/repos");

    const calls = [];
    installer.install = async (type) => {
      calls.push(type);
      if (type === "filebrowser") return { ok: false, error: "indirme basarisiz" };
      return {
        ok: true,
        unit_name: type === "code-server" ? "code-server@lyra" : type,
        port: 9000,
        display_name: type
      };
    };

    const progress = core.createProgress();
    progress.start("lan", "http://127.0.0.1:3000", {
      installServices: ["code-server", "filebrowser", "mongod"]
    });

    const results = await core.runServiceInstalls(
      ["code-server", "filebrowser", "mongod"],
      progress,
      { user: "lyra", home }
    );

    // Ortadaki hata sonrakileri durdurmaz.
    expect(calls).toEqual(["code-server", "filebrowser", "mongod"]);
    expect(results).toEqual([
      { type: "code-server", ok: true },
      { type: "filebrowser", ok: false },
      { type: "mongod", ok: true }
    ]);
    expect(progress.step("service-install:code-server").status).toBe("ok");
    expect(progress.step("service-install:filebrowser").status).toBe("failed");
    expect(progress.step("service-install:filebrowser").error).toBe("indirme basarisiz");
    expect(progress.step("service-install:mongod").status).toBe("ok");

    // Yalnizca basarili kurulumlar kaydedilir.
    expect(
      services
        .list()
        .map((s) => s.unit_name)
        .sort()
    ).toEqual(["code-server@lyra", "mongod"]);
  });
});

// Faz 10 — gercek kullanimda ortaya cikan uc kusur:
//   1) sistemde zaten duran cloudflared servisi kurulumu patlatiyordu
//   2) ayni adda tunnel varsa rastgele son ekli KOPYA yaratiliyordu
//      (hesapta olu tunnel yigini)
//   3) zincir yarida kalinca geride ne kaldigi soylenmiyordu
//
// Testler MOCK'LU: Cloudflare API'sine ve sisteme HICBIR cagri yapilmaz.
describe("setup-core cf-api cakisma yonetimi", () => {
  let home;
  beforeEach(() => {
    home = freshHome();
    require("../db/migrate").migrate();
  });
  afterEach(() => cleanup(home));

  const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
  const ZONE_ID = "fedcba9876543210fedcba9876543210";
  const NEW_TUNNEL_ID = "11111111-2222-3333-4444-555555555555";
  const OLD_TUNNEL_ID = "99999999-8888-7777-6666-555555555555";
  const CONNECTOR_TOKEN = "connector-token-".padEnd(80, "x");

  function cfBody(over = {}) {
    return {
      accessMode: "cf-api",
      cfApiToken: "cf-test-token-0123456789abcdef",
      domain: "ornek.com",
      cfHostMode: "apex",
      ...over
    };
  }

  // Ag cagrisi yapan fonksiyonlarin taklidi. buildIngress / tunnelCname /
  // tunnelHasConnections gibi saf fonksiyonlar GERCEK kalir.
  function mockCfApi(over = {}) {
    const cfApi = require("../lib/cloudflare-api");
    const calls = { createTunnel: [], deleteTunnel: [], tunnelToken: [], dns: [], ingress: [] };
    const zone = {
      id: ZONE_ID,
      name: "ornek.com",
      status: "active",
      account: { id: ACCOUNT_ID, name: "Hesap" }
    };
    cfApi.verifyToken = async () => ({ id: "tok", status: "active" });
    cfApi.findZone = async () => zone;
    cfApi.resolveAccount = async () => ({
      account: zone.account,
      accounts: [zone.account],
      source: "zone"
    });
    cfApi.findTunnelByName = async () => null;
    cfApi.createTunnel = async (_t, _a, name) => {
      calls.createTunnel.push(name);
      return { id: NEW_TUNNEL_ID, name };
    };
    cfApi.deleteTunnel = async (_t, _a, id) => {
      calls.deleteTunnel.push(id);
      return { ok: true };
    };
    cfApi.getTunnelToken = async (_t, _a, id) => {
      calls.tunnelToken.push(id);
      return CONNECTOR_TOKEN;
    };
    cfApi.putIngress = async (_t, _a, _id, ingress) => {
      calls.ingress.push(ingress);
      return {};
    };
    cfApi.upsertDnsRecord = async (_t, _z, record) => {
      calls.dns.push(record.name);
      return { action: "created", record: { name: `${record.name}.ornek.com` } };
    };
    Object.assign(cfApi, over);
    return { cfApi, calls };
  }

  function mockCloudflared(over = {}) {
    const cfd = require("../lib/cloudflared-installer");
    const calls = { install: 0, installService: [] };
    cfd.detectService = () => ({ present: false, active: false, tunnelId: null });
    cfd.install = async () => {
      calls.install += 1;
      return { ok: true };
    };
    cfd.installService = async (opts) => {
      calls.installService.push({ replace: !!opts.replace, token: opts.token });
      return { ok: true };
    };
    Object.assign(cfd, over);
    return { cfd, calls };
  }

  function failedStep(progress) {
    return progress.payload().steps.find((s) => s.status === "failed") || null;
  }

  // ── Kusur 1: mevcut cloudflared servisi ──

  it("mevcut cloudflared servisi varken tunnel YARATILMADAN durur", async () => {
    const { calls: api } = mockCfApi();
    mockCloudflared({
      detectService: () => ({ present: true, active: true, tunnelId: OLD_TUNNEL_ID })
    });
    const core = require("../lib/setup-core");

    const r = await core.provisionCloudflare(cfBody());

    expect(r.ok).toBe(false);
    const step = failedStep(r.progress);
    expect(step.key).toBe("cf-verify");
    expect(step.error).toMatch(/zaten bir cloudflared servisi var/i);
    expect(step.error).toMatch(/--replace-cloudflared/);
    // Cloudflare'de hicbir sey olusmadi — dolayisiyla temizlenecek de bir sey yok.
    expect(api.createTunnel).toEqual([]);
    expect(r.progress.payload().leftovers).toBeNull();
  });

  it("--replace-cloudflared verilince mevcut servis degistirilerek devam eder", async () => {
    mockCfApi();
    const { calls: cfd } = mockCloudflared({
      detectService: () => ({ present: true, active: false, tunnelId: OLD_TUNNEL_ID })
    });
    const core = require("../lib/setup-core");

    const r = await core.provisionCloudflare(cfBody({ cfReplaceCloudflared: true }));

    expect(r.ok).toBe(true);
    // Karar asagiya kadar tasinir: installService mevcut servisi kaldirir.
    expect(cfd.installService).toEqual([{ replace: true, token: CONNECTOR_TOKEN }]);
  });

  // ── Kusur 2: ayni adda tunnel ──

  const activeTunnel = {
    id: OLD_TUNNEL_ID,
    name: "lyra-ornek-com",
    status: "healthy",
    connections: 4
  };
  const idleTunnel = {
    id: OLD_TUNNEL_ID,
    name: "lyra-ornek-com",
    status: "inactive",
    connections: 0
  };

  it("aktif baglantili ayni adli tunnel HICBIR ayarla devralinmaz", async () => {
    for (const mode of ["fail", "reuse", "recreate"]) {
      const { calls: api } = mockCfApi({ findTunnelByName: async () => ({ ...activeTunnel }) });
      mockCloudflared();
      const core = require("../lib/setup-core");

      const r = await core.provisionCloudflare(cfBody({ cfTunnelExisting: mode }));

      expect(r.ok).toBe(false);
      const step = failedStep(r.progress);
      expect(step.key).toBe("cf-tunnel");
      expect(step.error).toMatch(/AKTIF/);
      expect(step.error).toMatch(/4 baglanti/);
      // Ne devralma, ne silme, ne de kopya uretme.
      expect(api.createTunnel).toEqual([]);
      expect(api.deleteTunnel).toEqual([]);
      expect(api.tunnelToken).toEqual([]);
    }
  });

  it("baglantisiz ayni adli tunnelda varsayilan davranis durmaktir (fail)", async () => {
    const { calls: api } = mockCfApi({ findTunnelByName: async () => ({ ...idleTunnel }) });
    mockCloudflared();
    const core = require("../lib/setup-core");

    const r = await core.provisionCloudflare(cfBody());

    expect(r.ok).toBe(false);
    const step = failedStep(r.progress);
    expect(step.error).toMatch(/zaten var/);
    expect(step.error).toMatch(/--cf-tunnel-existing reuse/);
    // ESKI DAVRANISIN TESTI: rastgele son ekli kopya URETILMEZ.
    expect(api.createTunnel).toEqual([]);
    expect(api.deleteTunnel).toEqual([]);
  });

  it("reuse: baglantisiz tunnel devralinir, yenisi yaratilmaz", async () => {
    const { calls: api } = mockCfApi({ findTunnelByName: async () => ({ ...idleTunnel }) });
    mockCloudflared();
    const core = require("../lib/setup-core");

    const r = await core.provisionCloudflare(cfBody({ cfTunnelExisting: "reuse" }));

    expect(r.ok).toBe(true);
    expect(api.createTunnel).toEqual([]);
    expect(api.deleteTunnel).toEqual([]);
    // Token mevcut tunnel'dan alinir, ingress yeniden yazilir.
    expect(api.tunnelToken).toEqual([OLD_TUNNEL_ID]);
    expect(api.ingress.length).toBe(1);
    const { integrations } = require("../db/repos");
    expect(integrations.get("cloudflare").config.tunnelId).toBe(OLD_TUNNEL_ID);
  });

  it("recreate: baglantisiz tunnel silinip ayni adla yeniden yaratilir", async () => {
    const { calls: api } = mockCfApi({ findTunnelByName: async () => ({ ...idleTunnel }) });
    mockCloudflared();
    const core = require("../lib/setup-core");

    const r = await core.provisionCloudflare(cfBody({ cfTunnelExisting: "recreate" }));

    expect(r.ok).toBe(true);
    expect(api.deleteTunnel).toEqual([OLD_TUNNEL_ID]);
    expect(api.createTunnel).toEqual(["lyra-ornek-com"]);
  });

  it("farkli tunnel adi verilince cakisma olusmaz", async () => {
    const { calls: api } = mockCfApi({
      findTunnelByName: async (_t, _a, name) =>
        name === "lyra-ornek-com" ? { ...idleTunnel } : null
    });
    mockCloudflared();
    const core = require("../lib/setup-core");

    const r = await core.provisionCloudflare(cfBody({ cfTunnelName: "lyra-yedek" }));

    expect(r.ok).toBe(true);
    expect(api.createTunnel).toEqual(["lyra-yedek"]);
  });

  // ── Kusur 3: yarida kalan kurulumun raporu ──

  it("DNS adiminda patlarsa olusan tunnel ve DNS kayitlari raporlanir", async () => {
    let dnsCall = 0;
    mockCfApi({
      upsertDnsRecord: async () => {
        dnsCall += 1;
        if (dnsCall === 1) return { action: "created", record: { name: "ornek.com" } };
        throw new Error("DNS yazilamadi");
      }
    });
    mockCloudflared();
    const core = require("../lib/setup-core");

    const r = await core.provisionCloudflare(cfBody());

    expect(r.ok).toBe(false);
    const left = r.progress.payload().leftovers;
    expect(left).not.toBeNull();
    expect(left.items.join("\n")).toMatch(/tunnel : lyra-ornek-com \(11111111-/);
    expect(left.items.join("\n")).toMatch(/DNS +: ornek\.com/);
    // Somut temizleme yolu gosterilir; otomatik geri alma YOK.
    expect(left.hints.join("\n")).toMatch(/one\.dash\.cloudflare\.com/);
    expect(left.hints.join("\n")).toMatch(/dash\.cloudflare\.com\/.+\/ornek\.com\/dns/);

    const lines = core.formatLeftovers(left);
    expect(lines[0]).toMatch(/Kurulum yarida kaldi/);
    expect(lines.join("\n")).toMatch(/Tekrar denemeden once temizlemek istersen/);
  });

  it("devralinan tunnel raporda 'silme' notuyla isaretlenir", async () => {
    mockCfApi({
      findTunnelByName: async () => ({ ...idleTunnel }),
      putIngress: async () => {
        throw new Error("ingress yazilamadi");
      }
    });
    mockCloudflared();
    const core = require("../lib/setup-core");

    const r = await core.provisionCloudflare(cfBody({ cfTunnelExisting: "reuse" }));

    expect(r.ok).toBe(false);
    const left = r.progress.payload().leftovers;
    expect(left.items.join("\n")).toMatch(/devralindi — Lyra yaratmadi, silme/);
    // Devraldigimiz tunnel icin "sil" yonlendirmesi verilmez.
    expect(left.hints.join("\n")).not.toMatch(/networks\/tunnels/);
  });

  it("hicbir kaynak olusmadan patlarsa rapor da uretilmez", async () => {
    mockCfApi({
      verifyToken: async () => {
        throw new Error("token gecersiz");
      }
    });
    mockCloudflared();
    const core = require("../lib/setup-core");

    const r = await core.provisionCloudflare(cfBody());
    expect(r.ok).toBe(false);
    expect(r.progress.payload().leftovers).toBeNull();
  });

  it("cloudflared servisi kurulduktan sonraki hata servisi de raporlar", async () => {
    mockCfApi();
    mockCloudflared({
      installService: async () => ({ ok: false, error: "servis kurulamadi" })
    });
    const core = require("../lib/setup-core");

    const r = await core.provisionCloudflare(cfBody());
    expect(r.ok).toBe(false);
    // Servis kurulamadi -> "servis" satiri raporda OLMAMALI (yalan olurdu).
    const left = r.progress.payload().leftovers;
    expect(left.items.join("\n")).not.toMatch(/servis :/);
    expect(left.items.join("\n")).toMatch(/tunnel :/);
  });
});

describe("setup-core tunnel plani", () => {
  let home;
  beforeEach(() => {
    home = freshHome();
    require("../db/migrate").migrate();
  });
  afterEach(() => cleanup(home));

  it("tunnel adi domain'den turetilir, verilirse o kullanilir", () => {
    const core = require("../lib/setup-core");
    expect(core.cfPlanFromBody({ domain: "ornek.com" }).tunnelName).toBe("lyra-ornek-com");
    expect(core.cfPlanFromBody({ domain: "a.b.ornek.com" }).tunnelName).toBe("lyra-a-b-ornek-com");
    expect(core.cfPlanFromBody({ domain: "ornek.com", cfTunnelName: "elle" }).tunnelName).toBe(
      "elle"
    );
    expect(
      core.cfPlanFromBody({ domain: "ornek.com", cfTunnelName: "-kotu" }).tunnelName
    ).toBeNull();
  });

  it("cakisma davranisinin varsayilani 'fail'", () => {
    const core = require("../lib/setup-core");
    expect(core.cfPlanFromBody({ domain: "ornek.com" }).tunnelExisting).toBe("fail");
    expect(
      core.cfPlanFromBody({ domain: "ornek.com", cfTunnelExisting: "reuse" }).tunnelExisting
    ).toBe("reuse");
    // Gecersiz deger sessizce kabul edilmez; plan "fail"de kalir, dogrulama
    // ayrica hata verir.
    expect(
      core.cfPlanFromBody({ domain: "ornek.com", cfTunnelExisting: "sil" }).tunnelExisting
    ).toBe("fail");
  });

  it("dogrulama gecersiz cakisma davranisini ve tunnel adini reddeder", () => {
    const core = require("../lib/setup-core");
    const body = {
      accessMode: "cf-api",
      appName: "Lyra",
      projectsDir: "/home/lyra/projects",
      user: { username: "admin", password: "supersecret1234", enable2FA: false },
      cfApiToken: "token",
      domain: "ornek.com"
    };
    expect(core.validateFinalize({ ...body, cfTunnelExisting: "sil" }).errors.join(" ")).toMatch(
      /Bilinmeyen tunnel cakisma davranisi/
    );
    expect(core.validateFinalize({ ...body, cfTunnelName: "!!" }).errors.join(" ")).toMatch(
      /Gecersiz tunnel adi/
    );
    expect(core.validateFinalize({ ...body, cfTunnelExisting: "reuse" }).errors).toEqual([]);
  });
});

describe("setup-core ensureProjectsDir", () => {
  let home;
  beforeEach(() => {
    home = freshHome();
    require("../db/migrate").migrate();
  });
  afterEach(() => cleanup(home));

  it("goreli yolu reddeder", () => {
    const core = require("../lib/setup-core");
    const r = core.ensureProjectsDir("projeler");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/mutlak/);
  });

  it("olmayan dizini yaratir ve yazilabilirligi gercekten dener", () => {
    const core = require("../lib/setup-core");
    const path = require("path");
    const fs = require("fs");
    const dir = path.join(home, "projects");
    expect(core.ensureProjectsDir(dir)).toEqual({ ok: true });
    expect(fs.existsSync(dir)).toBe(true);
    // Yazma testi dosyasi geride birakilmaz.
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe("routes/setup re-export'lari", () => {
  let home;
  beforeEach(() => {
    home = freshHome();
    require("../db/migrate").migrate();
  });
  afterEach(() => cleanup(home));

  it("HTTP katmani cekirdegin ayni fonksiyonlarini disari verir", () => {
    const core = require("../lib/setup-core");
    const routes = require("../routes/setup");
    // Kopya degil, AYNI referans olmali — mantik cataliyorsa test kirilir.
    expect(routes.ensureProjectsDir).toBe(core.ensureProjectsDir);
    expect(routes.systemUserInfo).toBe(core.systemUserInfo);
    expect(routes.buildSteps).toBe(core.buildSteps);
    expect(routes.cleanupSetupPrivileges).toBe(core.cleanupSetupPrivileges);
    expect(routes.SETUP_SUDOERS).toBe(core.SETUP_SUDOERS);
    expect(routes.isCfProvisioned).toBe(core.isCfProvisioned);
    expect(routes.cfProvisionedInfo).toBe(core.cfProvisionedInfo);
  });
});
