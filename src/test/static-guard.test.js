import { describe, it, expect } from "vitest";
import { require } from "./setup.js";

// ─────────────────────────────────────────────────────────────────────────────
// REGRESYON KILIDI — HTML sayfalari statik olarak servis edilmemeli.
//
// Gercek olay: express.static auth kapilarindan ONCE calisiyordu, bu yuzden
// "/index.html" panelin iskeletini oturum acmadan veriyordu. "/" requireAuth'a
// tabiydi, ama ayni dosya adiyla dogrudan istendiginde serbest geciyordu —
// yani ayni sayfanin iki farkli kapisi vardi. API'ler korumali oldugu icin veri
// sizmiyordu, ama kapinin yalnizca bir tarafinin kilitli olmasi kendi basina
// bir hataydi.
//
// Bu testin ikinci isi kadar onemli: VARLIKLARIN acik kaldigini dogrulamak.
// Engel .html yerine tum statik dosyalari kapsasaydi giris ekrani CSS'siz
// kalirdi — kullanici oturum acamadan once onlari yuklemek zorunda.

function run(path) {
  const blockDirectHtml = require("../lib/static-guard");
  const sonuc = { status: null, body: null, type: null, nextCalled: false };
  const res = {
    status(code) {
      sonuc.status = code;
      return res;
    },
    type(t) {
      sonuc.type = t;
      return res;
    },
    send(b) {
      sonuc.body = b;
      return res;
    }
  };
  blockDirectHtml({ path }, res, () => {
    sonuc.nextCalled = true;
  });
  return sonuc;
}

describe("static-guard — HTML dosyalarina dogrudan erisim", () => {
  const engellenen = ["/index.html", "/login.html", "/setup.html", "/js/../index.html"];

  it.each(engellenen)("%s icin 404 doner, statik middleware'e ulasmaz", (p) => {
    const r = run(p);
    expect(r.status).toBe(404);
    expect(r.nextCalled).toBe(false);
  });

  it("buyuk harfli uzanti da engellenir", () => {
    // Windows/macOS dosya sistemleri buyuk-kucuk harf ayirmaz; kucuk harfe
    // cevirmeden bakarsak "/INDEX.HTML" kapiyi atlatirdi.
    for (const p of ["/INDEX.HTML", "/Index.Html", "/login.HTML"]) {
      expect(run(p).status, p).toBe(404);
    }
  });
});

describe("static-guard — varliklar acik kalir", () => {
  // Giris ekrani oturum acilmadan once bunlari yukluyor.
  const gecmesiGerekenler = [
    "/css/tokens.css",
    "/css/base.css",
    "/js/app.js",
    "/fonts/inter-latin.woff2",
    "/fonts/Newsreader-Medium.woff2",
    "/favicon.ico",
    "/favicon.svg",
    "/brand/logo-mark.svg",
    "/site.webmanifest",
    "/apple-touch-icon.png",
    "/vendor/marked.min.js"
  ];

  it.each(gecmesiGerekenler)("%s statik middleware'e gecer", (p) => {
    const r = run(p);
    expect(r.nextCalled).toBe(true);
    expect(r.status).toBe(null);
  });

  it("HTML sayfalarinin kendi route'lari etkilenmez", () => {
    // "/" ve "/login" uzanti tasimadigi icin bu middleware'den gecer;
    // kimlik dogrulamasi kendi route'larinda yapilir.
    for (const p of ["/", "/login", "/healthz", "/api/projects"]) {
      expect(run(p).nextCalled, p).toBe(true);
    }
  });
});

describe("server.js — koruma statik middleware'den once", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

  it("blockDirectHtml, express.static'ten once kayitli", () => {
    const guard = src.indexOf("app.use(blockDirectHtml)");
    const statik = src.indexOf("express.static(");
    expect(guard).toBeGreaterThan(-1);
    expect(statik).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(statik);
  });
});
