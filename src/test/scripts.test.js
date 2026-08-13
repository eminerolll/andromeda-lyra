// Uretilen systemd unit'i ve sudoers dosyasi regresyon testleri.
// Scriptler --print ile hicbir sey yazmadan icerigi stdout'a basar.

import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { require } from "./setup.js";

function runScript(rel, args) {
  return execFileSync(process.execPath, [require.resolve(rel), "--print", ...args], {
    encoding: "utf8"
  });
}

describe("generate-systemd", () => {
  const unit = runScript("../scripts/generate-systemd.js", [
    "--user", "lyra",
    "--workdir", "/opt/lyra/src",
    "--home", "/var/lib/lyra",
    "--port", "3000",
    "--projects-dir", "/home/lyra/projects"
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
