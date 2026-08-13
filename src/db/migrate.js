// Migration runner: db/migrations/*.sql dosyalarini sirayla calistirir.
// Her migration bir kere uygulanir; _migrations tablosunda kaydi tutulur.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { db, DB_PATH } = require("./index");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

function ensureMigrationsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL
    );
  `);
}

function getApplied() {
  return new Set(
    db
      .prepare("SELECT name FROM _migrations ORDER BY id")
      .all()
      .map((r) => r.name)
  );
}

function listMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function applyMigration(name) {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), "utf8");
  const tx = db.transaction(() => {
    db.exec(sql);
    db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(name, Date.now());
  });
  tx();
}

function migrate() {
  ensureMigrationsTable();
  const applied = getApplied();
  const all = listMigrations();
  const pending = all.filter((m) => !applied.has(m));

  if (pending.length === 0) {
    console.log(`[migrate] Hicbir migration beklemede degil. (${all.length} uygulanmis)`);
    console.log(`[migrate] DB: ${DB_PATH}`);
    return;
  }

  for (const name of pending) {
    process.stdout.write(`[migrate] uygulaniyor: ${name} ... `);
    try {
      applyMigration(name);
      console.log("OK");
    } catch (err) {
      console.log("HATA");
      console.error(err);
      process.exit(1);
    }
  }
  console.log(`[migrate] ${pending.length} migration uygulandi.`);
  console.log(`[migrate] DB: ${DB_PATH}`);
}

if (require.main === module) {
  migrate();
}

module.exports = { migrate };
