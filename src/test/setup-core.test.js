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
    expect(core.validateFinalize(body, { totpVerified: false }).errors.join(" "))
      .toMatch(/2FA dogrulamasi/);
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

  it("runStep basari/hata durumunu ve not'u kaydeder", async () => {
    const core = require("../lib/setup-core");
    const seen = [];
    const p = core.createProgress({ onUpdate: (s) => seen.push(`${s.key}:${s.status}`) });
    p.start("lan", "http://127.0.0.1:3000");

    expect(await p.runStep("firewall", async () => "kural yok")).toBe(true);
    expect(p.step("firewall").status).toBe("ok");
    expect(p.step("firewall").note).toBe("kural yok");

    expect(await p.runStep("setup-mode-off", async () => {
      throw new Error("patladi");
    })).toBe(false);
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

    const applied = core.applyFinalize(baseBody({
      appName: "Panelim",
      projectsDir: "/srv/projects",
      integrations: { github: { token: "gh_abc" } }
    }));

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

    const applied = core.applyFinalize(baseBody({
      accessMode: "cf-api",
      domain: "ornek.com",
      cfApiToken: "t",
      cfHostMode: "subdomain",
      cfPanelSubdomain: "panel"
    }));

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
  });
});
