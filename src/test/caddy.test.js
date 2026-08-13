import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { freshHome, cleanup, require } from "./setup.js";

describe("caddy buildCaddyfile", () => {
  let home;

  beforeEach(() => {
    home = freshHome();
    require("../db/migrate").migrate();
  });
  afterEach(() => {
    cleanup(home);
  });

  it("emits the apex block and the email global", () => {
    const caddy = require("../lib/caddy");
    const out = caddy.buildCaddyfile({ domain: "example.com", email: "a@b.c" });
    expect(out).toContain("\temail a@b.c");
    expect(out).toContain("example.com {");
    expect(out).toContain("\treverse_proxy 127.0.0.1:3000");
  });

  // Wildcard (*.example.com) kullanilmiyor: DNS-01 challenge gerektirir.
  // Bilinen subdomain'ler tek tek listelenir, hepsi Lyra'ya proxy'lenir.
  it("emits one block per known subdomain, never a wildcard", () => {
    const caddy = require("../lib/caddy");
    const out = caddy.buildCaddyfile({
      domain: "example.com",
      subdomains: ["code.example.com", "files.example.com"]
    });
    expect(out).toContain("code.example.com {");
    expect(out).toContain("files.example.com {");
    expect(out).not.toContain("*.");
    // Servis portuna degil, Lyra'ya proxy: auth bariyeri Lyra'da
    expect(out.match(/reverse_proxy 127\.0\.0\.1:3000/g)).toHaveLength(3);
  });

  it("does not duplicate the apex if it appears in subdomains", () => {
    const caddy = require("../lib/caddy");
    const out = caddy.buildCaddyfile({
      domain: "example.com",
      subdomains: ["example.com", "code.example.com"]
    });
    expect(out.match(/^example\.com \{/gm)).toHaveLength(1);
  });

  it("derives subdomains from registered services", () => {
    const caddy = require("../lib/caddy");
    const { settings, services } = require("../db/repos");
    settings.setMany({ base_domain: "example.com" });
    services.add({
      unit_name: "code-server",
      display_name: "Code Server",
      type: "code-server",
      port: 8080
    });
    services.add({
      unit_name: "dbgate",
      display_name: "DbGate",
      type: "dbgate",
      port: 8081,
      enabled: 0
    });
    // Sadece enabled servisler icin blok uretilir
    expect(caddy.knownSubdomains()).toEqual(["code.example.com"]);
  });

  it("returns no subdomains when there is no domain", () => {
    const caddy = require("../lib/caddy");
    expect(caddy.knownSubdomains()).toEqual([]);
  });
});
