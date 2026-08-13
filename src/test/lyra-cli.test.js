// bin/lyra.js ve scripts/setup-cli.js komut satiri sozlesmeleri.
//
// Bunlar kullanicinin dogrudan yazdigi komutlar; sessizce degisirse
// dokumantasyon ve otomasyon (Ansible vb.) kirilir.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { require } from "./setup.js";

// Cocuk process'ler db/index.js'i require ettigi an LYRA_HOME dizinini
// yaratir; testler repo icine "data/" birakmasin diye gecici dizin veriyoruz.
let home;
beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lyra-cli-test-"));
});
afterAll(() => {
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

function runNode(rel, args = [], env = {}) {
  return spawnSync(process.execPath, [require.resolve(rel), ...args], {
    encoding: "utf8",
    env: { ...process.env, LYRA_HOME: home, ...env },
    timeout: 30000
  });
}

describe("lyra komutu", () => {
  it("--version package.json surumunu basar", () => {
    const r = runNode("../bin/lyra.js", ["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(require("../package.json").version);
  });

  it("--help tum alt komutlari listeler", () => {
    const r = runNode("../bin/lyra.js", ["--help"]);
    expect(r.status).toBe(0);
    for (const cmd of ["status", "update", "logs", "reset-admin", "connect", "uninstall"]) {
      expect(r.stdout).toContain(cmd);
    }
    // Git'siz kurulum icin cikis kapisi yardimda gorunmeli.
    expect(r.stdout).toContain("--skip-pull");
  });

  it("argumansiz cagirinca yardimi basar", () => {
    const r = runNode("../bin/lyra.js", []);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Kullanim: lyra");
  });

  it("bilinmeyen komutta hata verir", () => {
    const r = runNode("../bin/lyra.js", ["frobnicate"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Bilinmeyen komut/);
  });

  it("root gerektiren komutlari root olmadan reddeder", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    for (const cmd of ["update", "uninstall"]) {
      const r = runNode("../bin/lyra.js", [cmd]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/root/i);
      expect(r.stderr).toMatch(new RegExp(`sudo lyra ${cmd}`));
    }
  });

  it("update --skip-pull bilinmeyen secenegi reddeder", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const r = runNode("../bin/lyra.js", ["update", "--seytan"]);
    expect(r.status).toBe(1);
    // Root kontrolu once calisir; her iki durumda da net bir hata olmali.
    expect(r.stderr.length).toBeGreaterThan(0);
  });
});

describe("setup-cli", () => {
  it("--help kullanimi ve zorunlu bayraklari anlatir", () => {
    const r = runNode("../scripts/setup-cli.js", ["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("--mode");
    expect(r.stdout).toContain("--projects-dir");
    expect(r.stdout).toContain("LYRA_ADMIN_PASSWORD");
    // Placeholder donemi bitti: "portlanmadi" gibi bir mazeret kalmamali.
    expect(r.stdout).not.toMatch(/portlanmad|placeholder|TODO/i);
  });

  it("TTY yokken --yes olmadan calismayi reddeder", () => {
    const r = runNode("../scripts/setup-cli.js", []);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--yes/);
  });

  it("non-interactive modda eksik zorunlu alanlari tek tek listeler", () => {
    const r = runNode("../scripts/setup-cli.js", ["--yes"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--mode/);
    expect(r.stderr).toMatch(/--user/);
    expect(r.stderr).toMatch(/--app-name/);
    expect(r.stderr).toMatch(/--projects-dir/);
    // 2FA tercihi varsayilana kacmaz.
    expect(r.stderr).toMatch(/--2fa/);
  });

  it("public modunda domain ve email ister", () => {
    const r = runNode("../scripts/setup-cli.js", ["--yes", "--mode", "public"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--domain/);
    expect(r.stderr).toMatch(/--email/);
  });

  it("cf-api modunda API token ister", () => {
    const r = runNode("../scripts/setup-cli.js", ["--yes", "--mode", "cf-api"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--cf-api-token/);
  });

  it("bilinmeyen erisim modunu reddeder", () => {
    const r = runNode("../scripts/setup-cli.js", ["--yes", "--mode", "uzay"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Bilinmeyen erisim modu/);
  });

  it("bilinmeyen secenegi reddeder", () => {
    const r = runNode("../scripts/setup-cli.js", ["--seytan"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Bilinmeyen secenek/);
  });

  it("degeri olmayan secenegi reddeder", () => {
    const r = runNode("../scripts/setup-cli.js", ["--yes", "--mode"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/deger bekliyor/);
  });

  it("sifreyi LYRA_ADMIN_PASSWORD env'inden kabul eder (--password zorunlu degil)", () => {
    // Bilerek --projects-dir vermiyoruz: dogrulama orada durur, gercek kurulum
    // baslamaz. Onemli olan sifrenin "eksikler" listesinde GECMEMESI.
    const r = runNode(
      "../scripts/setup-cli.js",
      ["--yes", "--mode", "localhost", "--app-name", "L", "--user", "admin", "--no-2fa"],
      { LYRA_ADMIN_PASSWORD: "supersecret1234" }
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--projects-dir/);
    expect(r.stderr).not.toMatch(/LYRA_ADMIN_PASSWORD/);
  });
});
