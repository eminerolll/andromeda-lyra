// Uretilen systemd unit'i ve sudoers dosyasi regresyon testleri.
// Scriptler --print ile hicbir sey yazmadan icerigi stdout'a basar.

import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "child_process";
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

  // NORMAL modda Lyra paket kurmaz: kurulum fazi icin acilan delik buraya
  // sizmamali. Sizarsa panel omru boyunca /usr yazilabilir kalirdi.
  it("normal mod unit'i sertlestirilmis kalir — kurulum gevsemesi sizmaz", () => {
    expect(unit).not.toMatch(/^ProtectSystem=off$/m);
    expect(unit).not.toMatch(/^ReadWritePaths=-?\/usr/m);
    expect(unit).not.toMatch(/^ReadWritePaths=-?\/var\/lib\/dpkg/m);
  });

  // Faz 8'de kurulum drop-in'inden ProtectSystem=off kaldirildi, Faz 9'da
  // /usr'a yazan servis kurucular eklendi — baglanti kurulmadi ve kurulum
  // dpkg "Read-only file system" ile coktu. Unit'in kendisi de neden
  // gevsetildigini soylemeli.
  it("ProtectSystem satiri kurulum fazi istisnasini acikca anlatir", () => {
    expect(unit).toMatch(/service-installer\.js/);
    expect(unit).toMatch(/Read-only file system/);
    expect(unit).toMatch(/setup-mode/);
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

// ─────────────────────────────────────────────────────────────────────────────
// REGRESYON KILIDI — "Read-only file system" kurulum cokmesi.
//
// Gercek olay: Oracle Cloud sunucusunda sihirbazdan code-server + filebrowser
// secildi, ikisi de coktu:
//   dpkg: unable to create '/usr/bin/code-server.dpkg-new': Read-only file system
//   install: cannot create '/usr/local/bin/filebrowser': Read-only file system
//
// Sebep mimari/RAM/disk degil: ana unit'teki ProtectSystem=full /usr'i salt
// okunur MOUNT eder ve kurulum Lyra'nin process agacinda o namespace'i miras
// alir — sudo kurtarmaz. Kurulum modu drop-in'i bunu ProtectSystem=off ile
// ezmek zorunda.
//
// Bu blok degismezi kilitler: drop-in yazan HER dal servis kurulumunun
// ihtiyac duydugu yazma iznini vermeli. Biri satiri tekrar kaldirirsa build
// burada kirilir.
describe("install.sh kurulum modu drop-in'i servis kurulumuna izin verir", () => {
  const script = fs.readFileSync(require.resolve("../../install.sh"), "utf8");

  // Heredoc govdeleri. Fonksiyonun ustundeki aciklama yorumu kapsam disi
  // kalsin diye dilimler heredoc baslik satirlarindan aliniyor.
  const tunnelBlock = script.slice(
    script.indexOf("# Lyra kurulum modu (tunnel)"),
    script.indexOf("# Lyra kurulum modu — install.sh")
  );
  const directBlock = script.slice(
    script.indexOf("# Lyra kurulum modu — install.sh"),
    script.indexOf('chmod 644 "$DROPIN_FILE"')
  );
  const branches = [
    ["tunnel", tunnelBlock],
    ["direct", directBlock]
  ];

  it("her iki dal da gercekten drop-in govdesi", () => {
    for (const [name, block] of branches) {
      expect(block, name).toContain("[Service]");
      expect(block, name).toMatch(/Environment=LYRA_SETUP_MODE=1/);
    }
  });

  it("her iki dal da /usr'i yazilabilir birakir", () => {
    for (const [name, block] of branches) {
      // ProtectSystem=off ya da /usr + /usr/local'i acan ReadWritePaths.
      // (systemd'de ReadWritePaths=, ProtectSystem='in uzerine yazar.)
      const off = /^ProtectSystem=off$/m.test(block);
      const rw =
        /^ReadWritePaths=.*\/usr\b/m.test(block) && /^ReadWritePaths=.*\/usr\/local\b/m.test(block);
      expect(off || rw, `${name}: /usr yazilabilir degil — dpkg "Read-only file system" der`).toBe(
        true
      );
    }
  });

  it("her iki dal da satirin NEDEN orada oldugunu yazar", () => {
    for (const [name, block] of branches) {
      expect(block, name).toMatch(/service-installer\.js/);
      expect(block, name).toMatch(/Read-only file system/);
    }
  });

  it("drop-in gecici kalir — sihirbaz bitince silinme yolu duruyor", () => {
    expect(script).toMatch(/rm -f "\$DROPIN_FILE"/);
    for (const [name, block] of branches) {
      expect(block, name).toContain("GECICI");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REGRESYON KILIDI — uninstall.sh TTY yoklugunu otomatik onay saymaz.
//
// Gercek olay (2026-08-14): canli sunucuda "once silinecekler listesini bir
// goreyim" niyetiyle `bash uninstall.sh < /dev/null` calistirildi. Scriptteki
//   [[ -t 0 ]] || ASSUME_YES=1
// satiri TTY yoklugunu onay sayiyordu: liste basildi ve arkasindan kurulum
// GERCEKTEN silindi. Otomasyonun zaten --yes bayragi oldugu icin bu kisayol
// hicbir sey kazandirmiyor, kazara silmeye kapi aciyordu.
describe("uninstall.sh onay kapisi", () => {
  const scriptPath = require.resolve("../../uninstall.sh");
  const script = fs.readFileSync(scriptPath, "utf8");

  // Eski satir aciklama yorumunda ornek olarak geciyor; sayim yalnizca
  // calisan koda bakmali.
  const code = script
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");

  it("ASSUME_YES yalnizca --yes bayragiyla acilir", () => {
    // Tek bir yerde 1 yapilir, o da bayrak dali. TTY dali geri gelirse patlar.
    expect(code.match(/ASSUME_YES=1/g) || []).toHaveLength(1);
    expect(code).toMatch(/-y\|--yes\|--non-interactive\)\s*ASSUME_YES=1/);
    expect(code).not.toMatch(/-t\s+0\s*\]\]\s*\|\|\s*ASSUME_YES=1/);
  });

  it("TTY yoksa onay isteyip durur", () => {
    expect(script).toMatch(/ASSUME_YES"\s*-ne\s*1\s*&&\s*!\s*-t\s*0/);
    expect(script).toMatch(/fail "Girdi bir terminal degil/);
  });

  it("satirin NEDEN orada oldugunu yazar", () => {
    expect(script).toMatch(/\[\[ -t 0 \]\] \|\| ASSUME_YES=1/); // yorumdaki eski hali
    expect(script).toMatch(/--yes bayragi var/);
  });

  // Metin denetimi yetmez: davranisi da dogruluyoruz. TTY kapisi root
  // kontrolunden ve tum dizin hesaplarindan ONCE geldigi icin bu cagri
  // root'suz calisir ve dosya sistemine hic dokunmaz.
  it.skipIf(process.platform === "win32")("stdin boru iken silmeden cikar", () => {
    const r = spawnSync("bash", [scriptPath], { input: "", encoding: "utf8" });
    expect(r.status).not.toBe(0);
    const out = `${r.stdout || ""}${r.stderr || ""}`;
    expect(out).toMatch(/terminal degil/);
    expect(out).toMatch(/--yes/);
    expect(out).toMatch(/Hicbir sey silinmedi/);
  });

  it.skipIf(process.platform === "win32")("--yes ile TTY kapisina takilmaz", () => {
    // --yes verilince onay kapisi gecilir; bir sonraki kapi root kontrolu.
    // (Testi root olarak kosarsan bu senaryo atlanir — silme yapmayalim.)
    const r = spawnSync("bash", [scriptPath, "--yes"], { input: "", encoding: "utf8" });
    const out = `${r.stdout || ""}${r.stderr || ""}`;
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    expect(out).not.toMatch(/terminal degil/);
    expect(out).toMatch(/root olarak calismali/);
  });
});
