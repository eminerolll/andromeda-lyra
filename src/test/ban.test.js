import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { freshHome, cleanup, require } from "./setup.js";

describe("ban", () => {
  let home;

  beforeEach(() => {
    home = freshHome();
    require("../db/migrate").migrate();
  });
  afterEach(() => {
    cleanup(home);
  });

  it("RFC1918 ranges always whitelisted", () => {
    const ban = require("../lib/ban");
    expect(ban.isWhitelisted("127.0.0.1")).toBe(true);
    expect(ban.isWhitelisted("10.0.0.5")).toBe(true);
    expect(ban.isWhitelisted("172.16.1.2")).toBe(true);
    expect(ban.isWhitelisted("172.31.255.255")).toBe(true);
    expect(ban.isWhitelisted("192.168.0.1")).toBe(true);
    expect(ban.isWhitelisted("::1")).toBe(true);
    expect(ban.isWhitelisted("8.8.8.8")).toBe(false);
    expect(ban.isWhitelisted("172.32.0.1")).toBe(false);
    expect(ban.isWhitelisted("172.15.0.1")).toBe(false);
  });

  it("ipv4-mapped ipv6 normalized", () => {
    const ban = require("../lib/ban");
    expect(ban.normalizeIp("::ffff:8.8.8.8")).toBe("8.8.8.8");
  });

  it("ban does not affect whitelisted IPs", () => {
    const ban = require("../lib/ban");
    require("../db/repos/bans").load();
    ban.ban("192.168.1.5"); // should be no-op (LAN)
    expect(ban.isBanned("192.168.1.5")).toBe(false);
  });

  it("public IP can be banned and unbanned", () => {
    const ban = require("../lib/ban");
    require("../db/repos/bans").load();
    ban.ban("203.0.113.5", { reason: "test" });
    expect(ban.isBanned("203.0.113.5")).toBe(true);
    ban.unban("203.0.113.5");
    expect(ban.isBanned("203.0.113.5")).toBe(false);
  });

  // Regresyon: countSince'te IP filtresi yokken baska IP'lerin hatalari
  // masum bir IP'yi ilk denemesinde banliyordu.
  it("failed logins from other IPs do not ban an innocent IP", () => {
    const ban = require("../lib/ban");
    const audit = require("../db/repos/audit");
    require("../db/repos/bans").load();

    for (const ip of ["203.0.113.1", "203.0.113.2", "203.0.113.3", "203.0.113.4"]) {
      audit.log({ event_type: "login_fail", ip });
    }
    // Masum IP ilk kez hata yapiyor (varsayilan esik 3)
    audit.log({ event_type: "login_fail", ip: "198.51.100.7" });
    ban.maybeAutoBan("198.51.100.7");

    expect(ban.isBanned("198.51.100.7")).toBe(false);
  });

  it("auto-bans after threshold failures from the same IP", () => {
    const ban = require("../lib/ban");
    const audit = require("../db/repos/audit");
    require("../db/repos/bans").load();

    for (let i = 0; i < 3; i++) audit.log({ event_type: "login_fail", ip: "198.51.100.9" });
    ban.maybeAutoBan("198.51.100.9");

    expect(ban.isBanned("198.51.100.9")).toBe(true);
  });

  // api_unauth kendi (yuksek) esigini kullanir. Login esigini beslerse
  // dashboard'in acilistaki API cagirilari kullaniciyi banlar.
  it("api_unauth does not count toward the login_fail threshold", () => {
    const ban = require("../lib/ban");
    const audit = require("../db/repos/audit");
    require("../db/repos/bans").load();

    audit.log({ event_type: "login_fail", ip: "198.51.100.11" });
    for (let i = 0; i < 5; i++) {
      ban.noteUnauthorized("198.51.100.11", { path: "/api/projects" });
    }
    expect(ban.isBanned("198.51.100.11")).toBe(false);
  });

  it("api_unauth auto-bans only after its own higher threshold", () => {
    const ban = require("../lib/ban");
    const config = require("../lib/config");
    require("../db/repos/bans").load();

    const threshold = config.get("auto_ban_api_after");
    expect(threshold).toBe(15);

    for (let i = 0; i < threshold - 1; i++) {
      ban.noteUnauthorized("198.51.100.12", { path: "/api/projects" });
    }
    expect(ban.isBanned("198.51.100.12")).toBe(false);

    ban.noteUnauthorized("198.51.100.12", { path: "/api/projects" });
    expect(ban.isBanned("198.51.100.12")).toBe(true);
  });

  // Regresyon: oturumu dusmus kullanici tek sayfa yuklemesinde (3+ API cagirisi)
  // kendini banliyordu. Cookie tasiyan istekler sayaci beslemez.
  it("requests carrying a session cookie never feed the api counter", () => {
    const ban = require("../lib/ban");
    const audit = require("../db/repos/audit");
    require("../db/repos/bans").load();

    for (let i = 0; i < 50; i++) {
      ban.noteUnauthorized("198.51.100.13", { path: "/api/projects" }, { hasSession: true });
    }
    expect(ban.isBanned("198.51.100.13")).toBe(false);
    expect(audit.countSince({ eventType: "api_unauth", sinceMs: 0, ip: "198.51.100.13" })).toBe(0);
  });

  it("hasSessionCookie distinguishes expired sessions from blind scans", () => {
    const auth = require("../lib/auth");
    expect(auth.hasSessionCookie({ headers: {} })).toBe(false);
    expect(auth.hasSessionCookie({ headers: { cookie: "theme=dark" } })).toBe(false);
    expect(auth.hasSessionCookie({ headers: { cookie: "connect.sid=s%3Aabc" } })).toBe(true);
    expect(auth.hasSessionCookie({ headers: { cookie: "theme=dark; connect.sid=s%3Aabc" } })).toBe(
      true
    );
  });

  it("noteUnauthorized ignores whitelisted IPs", () => {
    const ban = require("../lib/ban");
    require("../db/repos/bans").load();
    for (let i = 0; i < 5; i++) ban.noteUnauthorized("192.168.1.50", { path: "/api/x" });
    expect(ban.isBanned("192.168.1.50")).toBe(false);
  });
});

describe("ban routes", () => {
  let home;
  let server;

  beforeEach(() => {
    home = freshHome();
    require("../db/migrate").migrate();
  });
  afterEach(() => {
    if (server) server.close();
    server = null;
    cleanup(home);
  });

  // routes/bans.js kendi bagimliliklarini require ederken taze DB modullerini
  // almali; freshHome sadece db/lib cache'ini temizliyor.
  async function startBanApi() {
    delete require.cache[require.resolve("../routes/bans")];
    const express = require("express");
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.session = { userId: null, username: "admin" };
      next();
    });
    app.use(require("../routes/bans"));
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }

  it("lists, creates and removes bans over HTTP", async () => {
    const base = await startBanApi();

    let res = await fetch(`${base}/api/bans`);
    expect(res.status).toBe(200);
    expect((await res.json()).bans).toEqual([]);

    res = await fetch(`${base}/api/bans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ip: "203.0.113.77", reason: "test", durationMinutes: 30 })
    });
    expect(res.status).toBe(200);

    res = await fetch(`${base}/api/bans`);
    const listed = (await res.json()).bans;
    expect(listed).toHaveLength(1);
    expect(listed[0].ip).toBe("203.0.113.77");
    expect(listed[0].expires_at).toBeGreaterThan(Date.now());

    res = await fetch(`${base}/api/bans/203.0.113.77`, { method: "DELETE" });
    expect(res.status).toBe(200);

    res = await fetch(`${base}/api/bans`);
    expect((await res.json()).bans).toEqual([]);
  });

  it("rejects invalid IPs and whitelisted ranges", async () => {
    const base = await startBanApi();

    let res = await fetch(`${base}/api/bans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ip: "not-an-ip" })
    });
    expect(res.status).toBe(400);

    res = await fetch(`${base}/api/bans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ip: "999.1.1.1" })
    });
    expect(res.status).toBe(400);

    res = await fetch(`${base}/api/bans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ip: "192.168.1.10" })
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when unbanning an IP that is not banned", async () => {
    const base = await startBanApi();
    const res = await fetch(`${base}/api/bans/203.0.113.200`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
