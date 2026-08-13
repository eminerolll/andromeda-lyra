import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { freshHome, cleanup, require } from "./setup.js";

describe("db migration runner", () => {
  let home;

  beforeEach(() => { home = freshHome(); });
  afterEach(() => { cleanup(home); });

  it("creates schema and is idempotent", () => {
    const { migrate } = require("../db/migrate");
    migrate();
    const { db } = require("../db");

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    const names = tables.map(t => t.name);

    expect(names).toContain("settings");
    expect(names).toContain("services");
    expect(names).toContain("users");
    expect(names).toContain("bans");
    expect(names).toContain("audit_log");
    expect(names).toContain("integrations");
    expect(names).toContain("_migrations");

    // Migration sayisi, migrations/ altindaki .sql dosya sayisiyla eslesmeli.
    // Sabit sayi yazma — her yeni migration'da test kirilir.
    const fs = require("fs");
    const migrationsDir = new URL("../db/migrations/", import.meta.url);
    const migrationCount = fs
      .readdirSync(migrationsDir)
      .filter(f => f.endsWith(".sql")).length;

    const before = db.prepare("SELECT COUNT(*) AS c FROM _migrations").get();
    expect(before.c).toBe(migrationCount);

    // Re-run is a no-op
    migrate();
    const after = db.prepare("SELECT COUNT(*) AS c FROM _migrations").get();
    expect(after.c).toBe(migrationCount);
  });
});
