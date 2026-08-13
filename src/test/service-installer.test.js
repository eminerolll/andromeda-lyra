// lib/service-installer.js — Lyra'nin yonettigi servisleri kurmasi.
//
// Testler MOCK'LU: hicbiri gercekten paket kurmaz. Dogrulanan sey uretilen
// yapilandirmalar, destek matrisi ve karar mantigi.
//
// En onemli blok "loopback degismezi": kurulan hicbir servis 127.0.0.1
// disina bind edilmemeli. Lyra login + 2FA + ban katmanini sagladigi icin bu
// servisler kendi auth'unu kapatiyor; bu ancak loopback'te dogru. Bu testler
// "0.0.0.0'a bind + auth kapali" birlesiminin sessizce uretilmesini engeller.

import { describe, it, expect } from "vitest";
import { require } from "./setup.js";

const installer = require("../lib/service-installer");

// Gereksinim kontrolleri sistemi yokluyor (docker var mi?). Testlerin
// sonucunun makineye gore degismemesi icin kontrolu degistirip geri aliyoruz.
// Senkron ve asenkron fn'ler icin ayni sekilde calisir.
function withRequirement(id, present, fn) {
  const original = installer.REQUIREMENTS[id].check;
  const restore = () => {
    installer.REQUIREMENTS[id].check = original;
  };
  installer.REQUIREMENTS[id].check = () => present;
  let out;
  try {
    out = fn();
  } catch (err) {
    restore();
    throw err;
  }
  if (out && typeof out.then === "function") return out.finally(restore);
  restore();
  return out;
}

describe("service-installer — loopback degismezi", () => {
  const generated = [
    installer.buildCodeServerConfig({ port: 8080 }),
    installer.buildFilebrowserUnit({
      user: "lyra",
      port: 8082,
      root: "/home/lyra",
      database: "/home/lyra/.filebrowser/filebrowser.db"
    }),
    installer.buildDbgateUnit({
      port: 8081,
      image: "dbgate/dbgate",
      container: "lyra-dbgate",
      volume: "lyra-dbgate-data"
    })
  ];

  // Yorum satirlari degismezi anlatiyor ("0.0.0.0'a acmak ... demektir");
  // kontrol edilen sey calisan direktifler.
  const directives = (text) =>
    text
      .split("\n")
      .filter((l) => !/^\s*[#;]/.test(l))
      .join("\n");

  it("uretilen hicbir yapilandirma 0.0.0.0'a bind etmez", () => {
    for (const text of generated) {
      expect(directives(text)).not.toMatch(/0\.0\.0\.0/);
      expect(directives(text)).toContain("127.0.0.1");
    }
  });

  it("code-server loopback'e bind eder ve auth'u ancak bu yuzden kapatir", () => {
    const cfg = installer.buildCodeServerConfig({ port: 8080 });
    expect(cfg).toMatch(/^bind-addr: 127\.0\.0\.1:8080$/m);
    expect(cfg).toMatch(/^auth: none$/m);
    expect(cfg).toMatch(/^cert: false$/m);
  });

  it("filebrowser unit'i -a 127.0.0.1 ile baslar", () => {
    const unit = installer.buildFilebrowserUnit({
      user: "lyra",
      port: 8082,
      root: "/home/lyra",
      database: "/home/lyra/.filebrowser/filebrowser.db"
    });
    expect(unit).toMatch(/ExecStart=\S+ -a 127\.0\.0\.1 -p 8082 /);
    expect(unit).toContain("--noauth");
    expect(unit).toMatch(/^User=lyra$/m);
  });

  it("dbgate port publish'i loopback'e sabitler (host'suz -p uretmez)", () => {
    const unit = installer.buildDbgateUnit({
      port: 8081,
      image: "dbgate/dbgate",
      container: "lyra-dbgate",
      volume: "lyra-dbgate-data"
    });
    expect(unit).toContain("-p 127.0.0.1:8081:3000");
    // "-p 8081:3000" konteyneri tum arayuzlere acardi.
    expect(unit).not.toMatch(/-p 8081:3000/);
  });

  it("mongod bindIp'si yalnizca loopback degerlerini kabul eder", () => {
    const conf = "net:\n  port: 27017\n  bindIp: 127.0.0.1\n";
    expect(installer.mongodBindIp(conf)).toBe("127.0.0.1");
    expect(installer.isLoopbackBind(installer.mongodBindIp(conf))).toBe(true);

    const open = "net:\n  bindIp: 0.0.0.0\n";
    expect(installer.isLoopbackBind(installer.mongodBindIp(open))).toBe(false);

    const mixed = "net:\n  bindIp: 127.0.0.1,10.0.0.5\n";
    expect(installer.isLoopbackBind(installer.mongodBindIp(mixed))).toBe(false);

    expect(installer.isLoopbackBind(installer.mongodBindIp("net:\n  port: 27017\n"))).toBe(false);
    expect(installer.isLoopbackBind("127.0.0.1, ::1")).toBe(true);
  });
});

describe("service-installer — mimari destek matrisi", () => {
  const types = ["code-server", "filebrowser", "dbgate", "mongod"];

  it("amd64 (x64) ve arm64 desteklenir", () => {
    for (const type of types) {
      expect(installer.isSupported(type, "x64")).toBe(true);
      expect(installer.isSupported(type, "arm64")).toBe(true);
    }
  });

  it("dogrulanmis paketi olmayan mimarilerde hicbir servis kurulmaz", () => {
    for (const arch of ["arm", "ia32", "ppc64", "s390x"]) {
      for (const type of types) {
        expect(installer.isSupported(type, arch)).toBe(false);
      }
    }
  });

  it("desteklenmeyen mimaride secenek SEBEBIYLE devre disi kalir", () => {
    const st = installer.installability("code-server", { arch: "ppc64" });
    expect(st.installable).toBe(false);
    expect(st.arch_supported).toBe(false);
    expect(st.reason).toMatch(/mimaride/);
    expect(st.reason).toContain("ppc64");
  });

  it("bilinmeyen servis kurulabilir sayilmaz", () => {
    expect(installer.isSupported("redis", "x64")).toBe(false);
    expect(installer.installability("redis").installable).toBe(false);
    expect(installer.get("redis")).toBeNull();
  });
});

describe("service-installer — gereksinimler", () => {
  it("dbgate Docker ister; Docker yoksa devre disi ve sebep yazili", () => {
    expect(installer.requirements("dbgate")).toContain("docker");
    withRequirement("docker", false, () => {
      const st = installer.installability("dbgate", { arch: "arm64" });
      expect(st.installable).toBe(false);
      expect(st.missing).toEqual(["docker"]);
      expect(st.reason).toMatch(/Docker/);
      // Docker'i otomatik kurmuyoruz — sebep bunu acikca soylemeli.
      expect(st.reason).toMatch(/otomatik kurmaz/);
    });
  });

  it("Docker varsa dbgate kurulabilir", () => {
    withRequirement("docker", true, () => {
      expect(installer.installability("dbgate", { arch: "arm64" }).installable).toBe(true);
    });
  });

  it("Docker yokken dbgate kurulumu hicbir sey calistirmadan hata doner", async () => {
    const r = await withRequirement("docker", false, () => installer.install("dbgate"));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Docker/);
  });

  it("bilinmeyen servis kurulumu exception sizdirmaz", async () => {
    const r = await installer.install("redis");
    expect(r).toEqual({ ok: false, error: "Bilinmeyen servis: redis" });
  });

  it("code-server ve filebrowser ek gereksinim istemez", () => {
    expect(installer.requirements("code-server")).toEqual([]);
    expect(installer.requirements("filebrowser")).toEqual([]);
  });
});

describe("service-installer — MongoDB apt deposu", () => {
  it("yayinlanan dist'leri tanir", () => {
    expect(installer.mongoRepo({ ID: "ubuntu", VERSION_CODENAME: "noble" })).toMatchObject({
      id: "ubuntu",
      codename: "noble",
      component: "multiverse"
    });
    expect(installer.mongoRepo({ ID: "debian", VERSION_CODENAME: "bookworm" })).toMatchObject({
      component: "main"
    });
  });

  it("yayinlanmayan dagitim/surumde null doner", () => {
    expect(installer.mongoRepo({ ID: "debian", VERSION_CODENAME: "bullseye" })).toBeNull();
    expect(installer.mongoRepo({ ID: "alpine", VERSION_CODENAME: "" })).toBeNull();
    expect(installer.mongoRepo({})).toBeNull();
  });

  it("sources.list satiri imzali ve iki mimarilidir", () => {
    const repo = installer.mongoRepo({ ID: "ubuntu", VERSION_CODENAME: "jammy" });
    const line = installer.buildMongoSourceList(repo);
    expect(line).toContain(`signed-by=${installer.MONGO_KEYRING}`);
    expect(line).toContain("arch=amd64,arm64");
    expect(line).toContain("repo.mongodb.org/apt/ubuntu jammy/mongodb-org/8.0 multiverse");
  });

  it("depo yoksa mongod devre disi ve sebep yazili", () => {
    withRequirement("mongodb-repo", false, () => {
      const st = installer.installability("mongod", { arch: "arm64" });
      expect(st.installable).toBe(false);
      expect(st.missing).toContain("mongodb-repo");
      expect(st.reason).toMatch(/apt deposu yayinlamiyor/);
    });
  });
});

describe("service-installer — katalog ve host bilgisi", () => {
  it("code-server varsayilan acik, digerleri kapali", () => {
    const byType = Object.fromEntries(installer.list().map((s) => [s.type, s]));
    expect(byType["code-server"].default_selected).toBe(true);
    expect(byType["filebrowser"].default_selected).toBe(false);
    expect(byType["dbgate"].default_selected).toBe(false);
    expect(byType["mongod"].default_selected).toBe(false);
  });

  it("her servisin RAM tahmini, portu ve kurulum kaynagi bellidir", () => {
    for (const svc of installer.list()) {
      expect(svc.est_ram_mb).toBeGreaterThan(0);
      expect(svc.default_port).toBeGreaterThan(0);
      expect(String(svc.source).length).toBeGreaterThan(10);
    }
    expect(installer.estimateRamMb("code-server")).toBe(200);
    expect(installer.estimateRamMb("redis")).toBeNull();
  });

  it("unit adi code-server icin kullaniciya baglidir", () => {
    expect(installer.unitName("code-server", "ubuntu")).toBe("code-server@ubuntu");
    expect(installer.unitName("filebrowser", "ubuntu")).toBe("filebrowser");
    expect(installer.unitName("redis", "ubuntu")).toBeNull();
  });

  it("host bilgisi sihirbazin RAM/disk/mimari satirini besler", () => {
    const h = installer.hostInfo();
    expect(h.totalMemMb).toBeGreaterThan(0);
    expect(h.freeMemMb).toBeGreaterThan(0);
    expect(typeof h.arch).toBe("string");
    expect(typeof h.docker).toBe("boolean");
  });
});

describe("service-installer — os-release ayristirma", () => {
  it("tirnakli degerleri temizler", () => {
    // Gercek dosyayi okur; en azindan ayristirmanin patlamadigini dogrula.
    const rel = installer.osRelease();
    expect(typeof rel).toBe("object");
    for (const v of Object.values(rel)) {
      expect(v.startsWith('"')).toBe(false);
    }
  });
});
