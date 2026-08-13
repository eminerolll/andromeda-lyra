// Kayitli olmayan servis (ornegin kurulumu basarisiz olmus code-server)
// istendiginde ne backend dashboard'a dusmeli ne de frontend aktif link
// gostermeli. Iki katman da ayni yonlendirmeyi vermeli.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { freshHome, cleanup, require } from "./setup.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function collectResponse() {
  const written = { code: null, body: "" };
  return {
    written,
    res: {
      writeHead: (code) => {
        written.code = code;
      },
      end: (body) => {
        written.body = body || "";
      }
    }
  };
}

describe("host-tabanli servis subdomain'leri", () => {
  let home;
  let proxy;
  let pathProxy;
  let config;
  let services;

  beforeEach(() => {
    home = freshHome();
    require("../db/migrate").migrate();
    config = require("../lib/config");
    proxy = require("../lib/proxy");
    pathProxy = require("../lib/path-proxy");
    services = require("../db/repos").services;
    config.set("base_domain", "indiedir.online");
    config.set("public_access", true);
  });
  afterEach(() => {
    cleanup(home);
  });

  it("bilinen servis subdomain'lerini path katmaninin route tanimina eslestirir", () => {
    expect(proxy.serviceHostRoute("code.indiedir.online")).toMatchObject({
      kind: "service",
      type: "code-server"
    });
    expect(proxy.serviceHostRoute("files.indiedir.online")).toMatchObject({
      type: "filebrowser"
    });
    expect(proxy.serviceHostRoute("db.indiedir.online:443")).toMatchObject({ type: "dbgate" });
  });

  it("apex host ve ilgisiz host'lar dashboard'a dusmeye devam eder", () => {
    expect(proxy.serviceHostRoute("indiedir.online")).toBeNull();
    expect(proxy.serviceHostRoute("www.indiedir.online")).toBeNull();
    expect(proxy.serviceHostRoute("baska.example.com")).toBeNull();
    expect(proxy.serviceHostRoute("")).toBeNull();
    // dev-{port} kendi dalinda cozulur, bu kontrole girmez
    expect(proxy.serviceHostRoute("dev-5173.indiedir.online")).toBeNull();
  });

  it("kayitli olmayan servis icin path katmaniyla ayni 503 mesajini uretir", () => {
    const hostRoute = proxy.serviceHostRoute("code.indiedir.online");
    const hostRes = collectResponse();
    pathProxy.forwardWeb({ url: "/#projects", headers: {} }, hostRes.res, hostRoute);

    const pathRes = collectResponse();
    pathProxy.forwardWeb({ url: "/code/", headers: {} }, pathRes.res, pathProxy.match("/code/"));

    expect(hostRes.written.code).toBe(503);
    expect(hostRes.written.body).toContain("code-server kurulu degil");
    expect(hostRes.written.body).toContain("Ayarlar > Servisler");
    // Mesaj tek yerde uretiliyor: iki katman birebir ayni metni donmeli
    expect(hostRes.written.body).toBe(pathRes.written.body);
  });

  it("servis kayitliyken host yolu porta cozulur ve URL soyulmaz", () => {
    services.add({
      unit_name: "code-server",
      display_name: "code-server",
      type: "code-server",
      port: 8080,
      enabled: 1
    });
    expect(proxy.findTargetPort("code.indiedir.online")).toBe(8080);
    // Host-tabanli istekte soyulacak bir on ek yok
    expect(proxy.serviceHostRoute("code.indiedir.online").prefix).toBe("");
  });

  it("servis devre disi birakilinca yeniden 503 dalina duser", () => {
    const s = services.add({
      unit_name: "code-server",
      display_name: "code-server",
      type: "code-server",
      port: 8080,
      enabled: 1
    });
    services.update(s.id, { enabled: 0 });
    expect(proxy.findTargetPort("code.indiedir.online")).toBeNull();
    expect(proxy.serviceHostRoute("code.indiedir.online")).not.toBeNull();
  });

  it("server.js host dalinda dashboard yerine bu kontrolu kullanir", () => {
    const src = fs.readFileSync(path.join(packageRoot, "server.js"), "utf8");
    expect(src).toContain("proxyLib.serviceHostRoute(host)");
    // Web dalinda path katmaninin hata uretici yolu cagriliyor
    expect(src).toContain("pathProxy.forwardWeb(req, res, svcRoute)");
  });
});

describe("frontend servis linkleri", () => {
  let app;

  beforeEach(async () => {
    app = await import("../public/js/app.js");
    app.appConfig.services = [];
    app.appConfig.publicAccess = true;
    app.appConfig.baseDomain = "indiedir.online";
  });

  it("kayitli servis yokken hasService false doner", () => {
    expect(app.hasService("code")).toBe(false);
    expect(app.hasService("files")).toBe(false);
  });

  it("kayitli ve etkin servis icin true, devre disi icin false doner", () => {
    app.appConfig.services = [{ type: "code-server", port: 8080, enabled: true }];
    expect(app.hasService("code")).toBe(true);
    expect(app.servicePort("code")).toBe(8080);

    app.appConfig.services = [{ type: "code-server", port: 8080, enabled: false }];
    expect(app.hasService("code")).toBe(false);
    expect(app.servicePort("code")).toBeNull();
  });

  it("eksik servis ipucu kullaniciyi Ayarlar > Servisler'e yonlendirir", () => {
    const hint = app.serviceMissingHint("code");
    expect(hint).toContain("code-server kurulu degil");
    expect(hint).toContain("Ayarlar > Servisler");
  });

  it("link uretimi hasService kontrolunun arkasinda kalir", () => {
    const src = fs.readFileSync(path.join(packageRoot, "public", "js", "app.js"), "utf8");
    expect(src).toContain('if (hasService("code")) codeLink.href');
    expect(src).toContain('markServiceUnavailable(codeLink, "code")');

    const projects = fs.readFileSync(path.join(packageRoot, "public", "js", "projects.js"), "utf8");
    expect(projects).toContain('const codeReady = hasService("code")');

    const ports = fs.readFileSync(path.join(packageRoot, "public", "js", "ports.js"), "utf8");
    expect(ports).toContain('hasService("code") ? servicePort("code") : null');
  });
});

describe("setup sihirbazi 2FA bolumu", () => {
  const html = fs.readFileSync(path.join(packageRoot, "public", "setup.html"), "utf8");

  it("2FA kutusu varsayilan isaretli gelir", () => {
    expect(html).toMatch(/id="adm-2fa"\s+checked/);
  });

  it("QR akisi tek fonksiyondan yurutulur, change tek kod yolu degildir", () => {
    expect(html).toContain("async function syncTotpSection()");
    expect(html).toContain('$("adm-2fa").addEventListener("change", syncTotpSection)');
    expect(html).toContain("if (n === 3) syncTotpSection();");
  });

  it("totp-init tek yerde cagrilir ve tek sefer calisir (secret korunur)", () => {
    const calls = html.match(/\/api\/setup\/totp-init/g) || [];
    expect(calls.length).toBe(1);
    expect(html).toContain("if (totpInitialized) return;");
  });
});
