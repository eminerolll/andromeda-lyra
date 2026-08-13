import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { freshHome, cleanup, require } from "./setup.js";

describe("setup-token", () => {
  let home;

  beforeEach(() => {
    home = freshHome();
    require("../db/migrate").migrate();
  });
  afterEach(() => {
    cleanup(home);
  });

  it("generates 16-char tokens with dashes", () => {
    const setupToken = require("../lib/setup-token");
    const t = setupToken.generate();
    expect(t).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it("save/verify roundtrip", () => {
    const setupToken = require("../lib/setup-token");
    const t = setupToken.generate();
    setupToken.save(t);
    expect(setupToken.verify(t)).toBe(true);
    expect(setupToken.verify("WRONG-TOKE-NXXX-XXXX")).toBe(false);
  });

  it("verify rejects tokens after invalidate", () => {
    const setupToken = require("../lib/setup-token");
    const t = setupToken.generate();
    setupToken.save(t);
    setupToken.invalidate();
    expect(setupToken.verify(t)).toBe(false);
    expect(setupToken.exists()).toBe(false);
  });

  it("verify is case-insensitive", () => {
    const setupToken = require("../lib/setup-token");
    const t = setupToken.generate();
    setupToken.save(t);
    expect(setupToken.verify(t.toLowerCase())).toBe(true);
  });

  it("verify rejects empty/null", () => {
    const setupToken = require("../lib/setup-token");
    setupToken.save(setupToken.generate());
    expect(setupToken.verify("")).toBe(false);
    expect(setupToken.verify(null)).toBe(false);
    expect(setupToken.verify(undefined)).toBe(false);
  });

  it("exists returns true after save, false after invalidate", () => {
    const setupToken = require("../lib/setup-token");
    expect(setupToken.exists()).toBe(false);
    setupToken.save(setupToken.generate());
    expect(setupToken.exists()).toBe(true);
    setupToken.invalidate();
    expect(setupToken.exists()).toBe(false);
  });
});
