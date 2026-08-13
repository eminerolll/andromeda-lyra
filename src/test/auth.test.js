import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { authenticator } from "otplib";
import { freshHome, cleanup, require } from "./setup.js";

describe("auth", () => {
  let home;

  beforeEach(() => {
    home = freshHome();
    require("../db/migrate").migrate();
  });
  afterEach(() => { cleanup(home); });

  it("password-only authenticate succeeds", () => {
    const users = require("../db/repos/users");
    const auth = require("../lib/auth");
    users.create({ username: "admin", password: "supersecret123" });

    const r = auth.authenticate({ username: "admin", password: "supersecret123" });
    expect(r.ok).toBe(true);
    expect(r.user.username).toBe("admin");
  });

  it("wrong password fails", () => {
    const users = require("../db/repos/users");
    const auth = require("../lib/auth");
    users.create({ username: "admin", password: "supersecret123" });

    const r = auth.authenticate({ username: "admin", password: "nope" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_credentials");
  });

  it("totp required when enabled", () => {
    const users = require("../db/repos/users");
    const auth = require("../lib/auth");
    const u = users.create({ username: "admin", password: "supersecret123" });
    const secret = authenticator.generateSecret();
    users.setTotp(u.id, { secret, enabled: true });

    const r1 = auth.authenticate({ username: "admin", password: "supersecret123" });
    expect(r1.reason).toBe("totp_required");

    const code = authenticator.generate(secret);
    const r2 = auth.authenticate({ username: "admin", password: "supersecret123", totpToken: code });
    expect(r2.ok).toBe(true);

    const r3 = auth.authenticate({ username: "admin", password: "supersecret123", totpToken: "000000" });
    expect(r3.ok).toBe(false);
    expect(r3.reason).toBe("invalid_totp");
  });

  it("generateTotp/verifyTotp roundtrip", () => {
    const auth = require("../lib/auth");
    const t = auth.generateTotp("admin");
    const code = authenticator.generate(t.secret);
    expect(auth.verifyTotp(t.secret, code)).toBe(true);
    expect(auth.verifyTotp(t.secret, "000000")).toBe(false);
  });
});
