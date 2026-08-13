import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { freshHome, cleanup, require } from "./setup.js";

describe("config", () => {
  let home;

  beforeEach(() => {
    home = freshHome();
    require("../db/migrate").migrate();
  });
  afterEach(() => { cleanup(home); });

  it("reads from settings, falls back to defaults", () => {
    const config = require("../lib/config");
    expect(config.get("app_name")).toBe("Andromeda"); // default
    config.set("app_name", "TestApp");
    expect(config.get("app_name")).toBe("TestApp");
  });

  it("isSetupComplete reflects user existence", () => {
    const config = require("../lib/config");
    const users = require("../db/repos/users");
    expect(config.isSetupComplete()).toBe(false);
    users.create({ username: "admin", password: "supersecret123" });
    expect(config.isSetupComplete()).toBe(true);
  });

  it("buildHostname combines subdomain + base_domain", () => {
    const config = require("../lib/config");
    config.set("base_domain", "example.com");
    expect(config.buildHostname("code")).toBe("code.example.com");
    expect(config.buildHostname("files")).toBe("files.example.com");
    expect(config.buildHostname("dev", 5173)).toBe("dev-5173.example.com");
  });

  it("parseHostname inverse of buildHostname", () => {
    const config = require("../lib/config");
    config.set("base_domain", "example.com");
    expect(config.parseHostname("code.example.com")).toEqual({ type: "code" });
    expect(config.parseHostname("files.example.com")).toEqual({ type: "files" });
    expect(config.parseHostname("dev-3000.example.com")).toEqual({ type: "dev", port: 3000 });
    expect(config.parseHostname("unknown.example.com")).toBeNull();
    expect(config.parseHostname("foo.other.com")).toBeNull();
  });

  it("buildHostname returns null without base_domain", () => {
    const config = require("../lib/config");
    expect(config.buildHostname("code")).toBeNull();
  });

  it("bind_address default is 127.0.0.1", () => {
    const config = require("../lib/config");
    expect(config.get("bind_address")).toBe("127.0.0.1");
  });
});
