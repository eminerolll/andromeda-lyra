// Uretilen systemd unit'i ve sudoers dosyasi regresyon testleri.
// Scriptler --print ile hicbir sey yazmadan icerigi stdout'a basar.

import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import { require } from "./setup.js";

function runScript(rel, args) {
  return execFileSync(process.execPath, [require.resolve(rel), "--print", ...args], {
    encoding: "utf8"
  });
}

describe("generate-systemd", () => {
  const unit = runScript("../scripts/generate-systemd.js", [
    "--user",
    "lyra",
    "--workdir",
    "/opt/lyra/src",
    "--home",
    "/var/lib/lyra",
    "--port",
    "3000",
    "--projects-dir",
    "/home/lyra/projects"
  ]);

  it("ProtectHome yazmaz — projeler dizini home altinda ve yazilabilir olmali", () => {
    expect(unit).not.toMatch(/^ProtectHome=/m);
  });

  it("NoNewPrivileges yazmaz — kisitli sudo cagirilari setuid ister", () => {
    expect(unit).not.toMatch(/^NoNewPrivileges=/m);
  });

  it("bootstrap env degiskenlerini unit'e yazar", () => {
    expect(unit).toMatch(/^Environment=LYRA_HOME=\/var\/lib\/lyra$/m);
    expect(unit).toMatch(/^Environment=LYRA_PORT=3000$/m);
    expect(unit).toMatch(/^Environment=NODE_ENV=production$/m);
  });

  it("veri ve projeler dizinlerini yazilabilir isaretler", () => {
    expect(unit).toMatch(/^ReadWritePaths=-\/var\/lib\/lyra$/m);
    expect(unit).toMatch(/^ReadWritePaths=-\/home\/lyra\/projects$/m);
  });

  it("ProtectSystem=full kalir ama /etc/caddy yazilabilir", () => {
    expect(unit).toMatch(/^ProtectSystem=full$/m);
    expect(unit).toMatch(/^ReadWritePaths=-\/etc\/caddy$/m);
  });

  it("dogru kullanici ve ExecStart uretir", () => {
    expect(unit).toMatch(/^User=lyra$/m);
    expect(unit).toMatch(/^WorkingDirectory=.*opt.lyra.src$/m);
  });
});

describe("generate-sudoers", () => {
  const rules = runScript("../scripts/generate-sudoers.js", ["--user", "lyra", "--name", "lyra"]);

  it("her satir tek kullaniciya baglidir", () => {
    for (const line of rules.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      expect(line.startsWith("lyra ALL=(root) NOPASSWD: ")).toBe(true);
    }
  });

  it("genis wildcard'li cloudflared kurallari kalmadi", () => {
    // "cp * /etc/cloudflared/config.yml" ve "cp <config> *" root'a esdegerdi.
    expect(rules).not.toMatch(/cp \* \/etc\/cloudflared/);
    expect(rules).not.toMatch(/cp \/etc\/cloudflared\/config\.yml \*/);
    expect(rules).not.toMatch(/install -m 644 \* /);
  });

  it("kurulum modundan cikis komutlarini icerir", () => {
    expect(rules).toMatch(/rm -f \/etc\/systemd\/system\/lyra\.service\.d\/setup-mode\.conf/);
    expect(rules).toMatch(/rm -f \/etc\/sudoers\.d\/lyra-setup/);
    expect(rules).toMatch(/systemctl daemon-reload/);
    expect(rules).toMatch(/systemctl restart lyra/);
  });

  it("NOPASSWD: ALL vermez", () => {
    expect(rules).not.toMatch(/NOPASSWD: ALL/);
  });

  it("--setup dosyasi gecici oldugunu acikca yazar", () => {
    const setup = runScript("../scripts/generate-sudoers.js", ["--user", "lyra", "--setup"]);
    expect(setup).toMatch(/NOPASSWD: ALL/);
    expect(setup).toMatch(/GECICI/);
    expect(setup).toMatch(/rm -f \/etc\/sudoers\.d\/lyra-setup/);
  });
});

// install.sh metin regresyonlari. Scripti calistirmadan (root/systemd ister)
// kurulum akisinin bozulmadigini dogruluyoruz; asil kabuk dogrulamasi
// shellcheck + "bash -n" ile CI disinda yapiliyor.
describe("install.sh erisim yontemi akisi", () => {
  // require test/setup.js'te yaratildi: goreli yol o dosyaya gore cozulur.
  const script = fs.readFileSync(require.resolve("../../install.sh"), "utf8");

  it("uc erisim yontemini de tanir", () => {
    expect(script).toMatch(/--access <cf-api\|direct\|cli>/);
    expect(script).toMatch(/ACCESS_METHOD="cf-api"/);
    expect(script).toMatch(/ACCESS_METHOD="direct"/);
    expect(script).toMatch(/ACCESS_METHOD="cli"/);
  });

  it("bulut tespitini kendi modulunden yapar (bash tarafinda kopya yok)", () => {
    expect(script).toMatch(/node "\$SRC_DIR\/lib\/cloud-detect\.js"/);
    // Metadata adresi bash icinde elle sorgulanmiyor olmali (yorumda gecebilir).
    expect(script).not.toMatch(/(curl|wget)[^\n]*169\.254\.169\.254/);
  });

  it("bulut tespit edilirse 'disaridan erisilebilir' varsayilan olmaz", () => {
    expect(script).toMatch(/DEFAULT_CHOICE=2/);
    expect(script).toMatch(/DEFAULT_CHOICE=1/);
  });

  it("tunnel drop-in'i kurulum portu ve ayricalikli bind icermez", () => {
    const tunnelBlock = script.slice(
      script.indexOf("# Lyra kurulum modu (tunnel)"),
      script.indexOf("# Lyra kurulum modu — install.sh")
    );
    expect(tunnelBlock).toMatch(/Environment=LYRA_SETUP_MODE=1/);
    expect(tunnelBlock).not.toMatch(/LYRA_SETUP_PORT/);
    expect(tunnelBlock).not.toMatch(/AmbientCapabilities/);
    expect(tunnelBlock).not.toMatch(/ProtectSystem=off/);
  });

  it("port 80 acma yalnizca 'direct' yontemine ait", () => {
    const ufwLine = script.indexOf('ufw allow "${LYRA_SETUP_PORT}/tcp"');
    const directCase = script.indexOf("  direct)");
    const cliCase = script.indexOf("  cli)");
    expect(ufwLine).toBeGreaterThan(directCase);
    expect(ufwLine).toBeLessThan(cliCase);
  });

  it("Cloudflare token'i cocuk process'in argv'sine yazilmaz", () => {
    // Token yalnizca 0600 gecici dosya uzerinden gecer.
    expect(script).toMatch(/--cf-api-token-file "\$CF_TOKEN_FILE"/);
    expect(script).not.toMatch(/cmd\+=\(--cf-api-token "/);
    expect(script).toMatch(/chmod 600 "\$CF_TOKEN_FILE"/);
    expect(script).toMatch(/trap cleanup_token_file EXIT/);
  });

  it("tunnel kurulumunu sihirbaz cekirdegine devreder", () => {
    expect(script).toMatch(/scripts\/setup-cli\.js --provision-tunnel/);
    // Cloudflare API cagrilari bash'te tekrar edilmiyor.
    expect(script).not.toMatch(/api\.cloudflare\.com/);
  });

  it("cli yontemi sihirbazi dogrudan baslatir", () => {
    expect(script).toMatch(/node scripts\/setup-cli\.js \)/);
  });
});
