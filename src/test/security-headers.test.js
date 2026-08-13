import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { freshHome, cleanup, require } from "./setup.js";

// Middleware'i sahte req/res ile calistirip gonderilen header'lari toplar.
function collectHeaders() {
  const securityHeaders = require("../lib/security-headers");
  const headers = {};
  const res = { setHeader: (k, v) => { headers[k] = v; } };
  let nextCalled = false;
  securityHeaders({}, res, () => { nextCalled = true; });
  expect(nextCalled).toBe(true);
  return headers;
}

describe("security headers", () => {
  let home;

  beforeEach(() => {
    home = freshHome();
    require("../db/migrate").migrate();
  });
  afterEach(() => {
    cleanup(home);
  });

  it("sends the baseline hardening headers", () => {
    const h = collectHeaders();
    expect(h["X-Frame-Options"]).toBe("SAMEORIGIN");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["Content-Security-Policy"]).toBeTruthy();
  });

  // HSTS duz HTTP kurulumda gonderilmemeli: tarayici zaten yok sayar ama
  // ayni host daha once HTTPS gorduyse istenmeyen kilitlenme yaratir.
  it("omits HSTS in LAN/localhost mode", () => {
    expect(collectHeaders()["Strict-Transport-Security"]).toBeUndefined();
  });

  it("omits HSTS when public_access is on but base_domain is missing", () => {
    const { settings } = require("../db/repos");
    settings.setMany({ public_access: true });
    expect(collectHeaders()["Strict-Transport-Security"]).toBeUndefined();
  });

  it("sends HSTS with includeSubDomains in public mode with a base domain", () => {
    const { settings } = require("../db/repos");
    settings.setMany({ public_access: true, base_domain: "example.com" });
    const hsts = collectHeaders()["Strict-Transport-Security"];
    expect(hsts).toContain("max-age=31536000");
    expect(hsts).toContain("includeSubDomains");
  });

  // Panel tum statiklerini kendi origin'inden servis eder; CSP'de hicbir
  // CDN/font origin'i kalmamali (airgap + gizlilik).
  it("allows no external script, style or font origin", () => {
    const csp = collectHeaders()["Content-Security-Policy"];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("font-src 'self'");
    for (const origin of ["cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"]) {
      expect(csp).not.toContain(origin);
    }
    // GitHub API cagrilari sunucudan yapilir, tarayicidan degil
    expect(csp).not.toContain("api.github.com");
    // Avatar gorseli gercekten GitHub'dan yukleniyor, o kalir
    expect(csp).toContain("img-src 'self' data: https://github.com");
  });
});
