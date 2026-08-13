const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const LYRA_HOME = path.resolve(process.env.LYRA_HOME || "./data");
const DB_PATH = path.join(LYRA_HOME, "lyra.db");

if (!fs.existsSync(LYRA_HOME)) {
  fs.mkdirSync(LYRA_HOME, { recursive: true, mode: 0o700 });
}

const db = new Database(DB_PATH);
fs.chmodSync(DB_PATH, 0o600);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

module.exports = { db, DB_PATH, LYRA_HOME };
