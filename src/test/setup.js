// Test setup: gercek SQLite ile gercek migrasyon. Her test gecici klasorde.
// LYRA_HOME her testten once ayri bir tmp dizine yonlendirilir.

import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);

// Bu dosya <paket-koku>/test/setup.js konumunda; db/ ve lib/ o kokun
// dogrudan altindaki kardes dizinler. Kok dizinin adi "src" olmak zorunda
// degil — kopyalandigi dizin adindan bagimsiz calismasi icin bu dosyanin
// kendi konumundan (import.meta.url) mutlak yol hesapliyoruz, "/src/"
// literaline bagli kalmiyoruz.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbDirPrefix = path.join(packageRoot, "db") + path.sep;
const libDirPrefix = path.join(packageRoot, "lib") + path.sep;

export function freshHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyra-test-"));
  process.env.LYRA_HOME = dir;
  // Modul cache'inde kalmis db connection olabilir — temizle.
  // Mutlak yol karsilastirmasi kullaniliyor (dizin adina bagli degil).
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(dbDirPrefix) || k.startsWith(libDirPrefix)) {
      delete require.cache[k];
    }
  }
  return dir;
}

export function cleanup(dir) {
  if (dir && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export { require };
