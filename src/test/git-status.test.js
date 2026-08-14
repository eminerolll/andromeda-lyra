import { describe, it, expect } from "vitest";
import { require } from "./setup.js";

// ─────────────────────────────────────────────────────────────────────────────
// REGRESYON KILIDI — porcelain satirinin basindaki bosluk anlamlidir.
//
// Gercek olay: routes/git.js icindeki gitCmd() tum git ciktisina .trim()
// uyguluyordu. `git status --porcelain` formatinda ilk iki sutun durum
// kodudur ve BOSLUK da bir degerdir:
//
//   "M  a.js"  staged
//   " M a.js"  yalnizca calisma agacinda
//
// Ciktinin basindaki bosluk silinince tum sutunlar bir kaydi:
//   " M src/cart.js" -> "M src/cart.js"
//     * dosya adi   -> "rc/cart.js"   (ilk harf yendi)
//     * X sutunu    -> 'M'            (unstaged degisiklik "staged" sayildi)
//
// Panelde "1 staged" yazarken diff basligi "Unstaged Degisiklikler" diyordu;
// dosya adi da yanlis gosteriliyordu.

const gitStatus = require("../lib/git-status");

describe("git-status — porcelain ayristirma", () => {
  it("yalnizca calisma agacindaki degisikligi staged saymaz", () => {
    const [e] = gitStatus.parse(" M src/cart.js");
    expect(e.file).toBe("src/cart.js");
    expect(e.staged).toBe(false);
    expect(e.unstaged).toBe(true);
    expect(e.untracked).toBe(false);
  });

  it("staged degisikligi dogru okur", () => {
    const [e] = gitStatus.parse("M  src/cart.js");
    expect(e.file).toBe("src/cart.js");
    expect(e.staged).toBe(true);
    expect(e.unstaged).toBe(false);
  });

  it("hem staged hem unstaged olani ikisinde de sayar", () => {
    const [e] = gitStatus.parse("MM src/cart.js");
    expect(e.staged).toBe(true);
    expect(e.unstaged).toBe(true);
  });

  it("takip edilmeyen dosyayi ayirir", () => {
    const [e] = gitStatus.parse("?? NOTES.md");
    expect(e.file).toBe("NOTES.md");
    expect(e.untracked).toBe(true);
    expect(e.staged).toBe(false);
    expect(e.unstaged).toBe(false);
  });

  it("dosya adinin ilk harfini asla yemez", () => {
    // Bug tam olarak buydu: bosluk ile baslayan her satirda ilk harf gidiyordu.
    for (const [line, beklenen] of [
      [" M src/cart.js", "src/cart.js"],
      [" D readme.md", "readme.md"],
      ["A  index.js", "index.js"],
      ["?? scripts/build.sh", "scripts/build.sh"],
      [" M a.js", "a.js"]
    ]) {
      expect(gitStatus.parse(line)[0].file, line).toBe(beklenen);
    }
  });

  it("bosluk iceren yollari korur", () => {
    expect(gitStatus.parse(" M src/my file.js")[0].file).toBe("src/my file.js");
  });

  it("yeniden adlandirma satirini oldugu gibi tasir", () => {
    const [e] = gitStatus.parse('R  eski.js -> "yeni.js"');
    expect(e.status).toBe("R");
    expect(e.file).toBe('eski.js -> "yeni.js"');
  });
});

describe("git-status — sayimlar", () => {
  const ciktı = [
    "M  staged-olan.js",
    " M calisma-agacinda.js",
    "MM ikisi-birden.js",
    "?? yeni-dosya.md",
    "?? baska-yeni.md"
  ].join("\n");

  it("staged / unstaged / untracked dogru dagilir", () => {
    const c = gitStatus.counts(ciktı);
    expect(c.staged).toBe(2); // "M " ve "MM"
    expect(c.unstaged).toBe(2); // " M" ve "MM"
    expect(c.untracked).toBe(2);
  });

  it("bos cikti sifir verir", () => {
    expect(gitStatus.counts("")).toEqual({ staged: 0, unstaged: 0, untracked: 0, total: 0 });
  });

  it("sondaki newline sayimi bozmaz", () => {
    expect(gitStatus.counts(" M a.js\n").unstaged).toBe(1);
  });

  it("toFiles UI'in bekledigi bicimi verir", () => {
    expect(gitStatus.toFiles(" M src/cart.js\n?? NOTES.md")).toEqual([
      { status: "M", file: "src/cart.js" },
      { status: "??", file: "NOTES.md" }
    ]);
  });
});

describe("routes/git.js — porcelain cagrilari trim edilmiyor", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "routes", "git.js"), "utf8");

  it("her --porcelain cagrisi trim:false tasiyor", () => {
    // gitCmd(..., ["status", "--porcelain"]) cagrilarinin hepsi trim'i kapatmali.
    const cagrilar = src.match(/gitCmd\([^)]*"--porcelain"[^)]*\)/g) || [];
    expect(cagrilar.length).toBeGreaterThan(0);
    for (const c of cagrilar) {
      expect(c, `trim:false eksik -> ${c}`).toMatch(/trim:\s*false/);
    }
  });

  it("elle sutun kirpma (substring(3)) kalmadi", () => {
    expect(src).not.toMatch(/substring\(3\)/);
  });
});
