import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { freshHome, cleanup, require } from "./setup.js";

describe("repos", () => {
  let home;

  beforeEach(() => {
    home = freshHome();
    require("../db/migrate").migrate();
  });
  afterEach(() => {
    cleanup(home);
  });

  describe("settings", () => {
    it("get/set roundtrips JSON values", () => {
      const settings = require("../db/repos/settings");
      settings.set("foo", { a: 1, b: "two" });
      expect(settings.get("foo")).toEqual({ a: 1, b: "two" });
    });

    it("returns fallback when key missing", () => {
      const settings = require("../db/repos/settings");
      expect(settings.get("missing", "default")).toBe("default");
    });

    it("setMany is atomic", () => {
      const settings = require("../db/repos/settings");
      settings.setMany({ a: 1, b: 2, c: 3 });
      expect(settings.get("a")).toBe(1);
      expect(settings.get("c")).toBe(3);
    });
  });

  describe("users", () => {
    it("creates user with hashed password", () => {
      const users = require("../db/repos/users");
      const u = users.create({ username: "admin", password: "supersecret123" });
      expect(u.id).toBeGreaterThan(0);
      expect(u.password_hash).not.toBe("supersecret123");
      expect(users.verifyPassword(u, "supersecret123")).toBe(true);
      expect(users.verifyPassword(u, "wrong")).toBe(false);
    });

    it("totp enable/disable", () => {
      const users = require("../db/repos/users");
      const u = users.create({ username: "admin", password: "supersecret123" });
      users.setTotp(u.id, { secret: "JBSWY3DPEHPK3PXP", enabled: true });
      const updated = users.findById(u.id);
      expect(updated.totp_enabled).toBe(1);
      users.disableTotp(u.id);
      const after = users.findById(u.id);
      expect(after.totp_enabled).toBe(0);
      expect(after.totp_secret).toBeNull();
    });

    it("exists() reflects user count", () => {
      const users = require("../db/repos/users");
      expect(users.exists()).toBe(false);
      users.create({ username: "admin", password: "supersecret123" });
      expect(users.exists()).toBe(true);
    });
  });

  describe("services", () => {
    it("add/list/getByType", () => {
      const services = require("../db/repos/services");
      services.add({
        unit_name: "code-server",
        display_name: "Code",
        type: "code-server",
        port: 8080
      });
      services.add({
        unit_name: "filebrowser",
        display_name: "Files",
        type: "filebrowser",
        port: 8082,
        enabled: 0
      });

      const all = services.list();
      expect(all.length).toBe(2);

      const enabled = services.list({ enabledOnly: true });
      expect(enabled.length).toBe(1);
      expect(enabled[0].unit_name).toBe("code-server");

      const codes = services.getByType("code-server");
      expect(codes.length).toBe(1);
    });
  });

  describe("bans", () => {
    it("ban/unban + cache", () => {
      const bans = require("../db/repos/bans");
      bans.load();
      expect(bans.isBanned("8.8.8.8")).toBe(false);
      bans.ban("8.8.8.8", { reason: "test" });
      expect(bans.isBanned("8.8.8.8")).toBe(true);
      bans.unban("8.8.8.8");
      expect(bans.isBanned("8.8.8.8")).toBe(false);
    });

    it("expiry", () => {
      const bans = require("../db/repos/bans");
      bans.load();
      bans.ban("9.9.9.9", { durationMs: -1000 }); // already expired
      expect(bans.isBanned("9.9.9.9")).toBe(false);
    });
  });

  describe("audit", () => {
    it("logs and queries by event", () => {
      const audit = require("../db/repos/audit");
      const users = require("../db/repos/users");
      const u = users.create({ username: "admin", password: "supersecret123" });
      audit.log({ event_type: "login_success", ip: "1.2.3.4", user_id: u.id });
      audit.log({ event_type: "login_fail", ip: "1.2.3.4", details: { reason: "bad" } });
      audit.log({ event_type: "login_fail", ip: "1.2.3.4" });

      const fails = audit.recent({ eventType: "login_fail" });
      expect(fails.length).toBe(2);

      const all = audit.recent();
      expect(all.length).toBe(3);

      const since = audit.countSince({ eventType: "login_fail", sinceMs: Date.now() - 60000 });
      expect(since).toBe(2);
    });
  });

  describe("integrations", () => {
    it("set/get/isEnabled/remove", () => {
      const integrations = require("../db/repos/integrations");
      expect(integrations.isEnabled("telegram")).toBe(false);
      integrations.set("telegram", { enabled: true, config: { botToken: "x", ownerChatId: "1" } });
      expect(integrations.isEnabled("telegram")).toBe(true);
      const got = integrations.get("telegram");
      expect(got.config.botToken).toBe("x");
      integrations.remove("telegram");
      expect(integrations.isEnabled("telegram")).toBe(false);
    });
  });
});
