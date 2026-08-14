import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { require } from "./setup.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(packageRoot, "public");

function read(rel) {
  return fs.readFileSync(path.join(publicDir, rel), "utf8");
}

// Dis origin regresyon kalkani: panel internete kapali bir sunucuda da
// eksiksiz calismali, hicbir sayfa yuklemesi ucuncu tarafa sizmamali.
describe("frontend has no external asset dependency", () => {
  const pages = ["index.html", "login.html", "setup.html"];

  it.each(pages)("%s loads no CDN or font-service asset", (page) => {
    const html = read(page);
    for (const origin of [
      "fonts.googleapis.com",
      "fonts.gstatic.com",
      "cdn.jsdelivr.net",
      "unpkg.com"
    ]) {
      expect(html).not.toContain(origin);
    }
  });

  it.each(pages)("%s links the self-hosted font stylesheet", (page) => {
    expect(read(page)).toMatch(/href="\/?css\/fonts\.css"/);
  });

  it("index.html loads marked from the local vendor directory", () => {
    const html = read("index.html");
    expect(html).toContain('<script src="vendor/marked.min.js"></script>');
  });

  it("fonts.css only references local woff2 files", () => {
    const css = read("css/fonts.css");
    const urls = [...css.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(u.startsWith("../fonts/")).toBe(true);
      expect(fs.existsSync(path.join(publicDir, "css", u))).toBe(true);
    }
  });

  it("ships the license texts next to the vendored assets", () => {
    expect(fs.existsSync(path.join(publicDir, "vendor", "marked.LICENSE.txt"))).toBe(true);
    expect(fs.existsSync(path.join(publicDir, "fonts", "Inter-OFL.txt"))).toBe(true);
    expect(fs.existsSync(path.join(publicDir, "fonts", "JetBrainsMono-OFL.txt"))).toBe(true);
  });
});

// notes.js onizlemesi <proje>/.notes.md dosyasini render eder; bu dosya
// klonlanmis bir repo ile gelebilir. marked ham HTML'i varsayilan olarak
// gecirir, o yuzden renderer override'lari kapatilirsa stored XSS olur.
describe("notes markdown preview is hardened", () => {
  let marked;
  let render;

  beforeAll(async () => {
    marked = require("../public/vendor/marked.min.js");
    globalThis.marked = marked;
    const notes = await import("../public/js/notes.js");
    notes.configureMarked();
    render = (md) => marked.parse(md);
  });

  it("escapes block-level raw HTML instead of rendering it", () => {
    const out = render("a\n\n<img src=x onerror=alert(1)>\n\nb");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
  });

  it("escapes inline raw HTML", () => {
    const out = render("hi <b onmouseover=alert(1)>x</b>");
    expect(out).not.toContain("<b ");
    expect(out).toContain("&lt;b");
  });

  it("escapes script tags", () => {
    const out = render("<script>alert(1)</script>");
    expect(out.toLowerCase()).not.toContain("<script");
  });

  it("drops javascript: links down to plain text", () => {
    const out = render("[click](javascript:alert(1))");
    expect(out).not.toContain("javascript:");
    expect(out).toContain("click");
  });

  it("drops javascript: images down to plain text", () => {
    const out = render("![i](javascript:alert(1))");
    expect(out).not.toContain("<img");
  });

  it("still renders ordinary markdown and safe links", () => {
    const out = render("# Baslik\n\n**kalin** ve [ok](https://ok.example)\n\n- madde");
    expect(out).toContain("<h1>Baslik</h1>");
    expect(out).toContain("<strong>kalin</strong>");
    expect(out).toContain('<a href="https://ok.example">ok</a>');
    expect(out).toContain("<li>madde</li>");
  });

  it("keeps relative and anchor links working", () => {
    expect(render("[a](#bolum)")).toContain('href="#bolum"');
    expect(render("[a](./docs/x.md)")).toContain('href="./docs/x.md"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REGRESYON KILIDI — islevsiz (olu) butonlar.
//
// Gercek olay: "Yeni Proje" modalinda Iptal'e basmak hicbir sey yapmiyordu.
// Sebep, markup'ta id'si olan bir butona JS tarafinda listener baglanmamis
// olmasiydi. Ayni bosluk bes butonda birden vardi: newCancelBtn,
// cloneCancelBtn, renameCancelBtn, githubCloseBtn, progressCloseBtn. Modallar
// yalnizca Escape ya da disariya tiklama ile kapaniyordu; kullanicinin dogal
// olarak bastigi dugme olu duruyordu.
//
// Kilit iki katmanli: (1) her butonun bir davranisi olmali, (2) her modalin
// tiklanabilir bir kapatma yolu olmali.
describe("index.html — butonlarin davranisi var", () => {
  const html = read("index.html");
  const jsDir = path.join(publicDir, "js");
  // Yorumlar soyuluyor: app.js'in aciklamasi bu bug'i anlatirken olu butonlarin
  // id'lerini tek tek sayiyor. Ham metinde arasaydik, yalnizca yorumda gecen bir
  // id "isleyicisi var" sayilir ve test kendi anlattigi hatayi kacirirdi.
  const jsSource = fs
    .readdirSync(jsDir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => fs.readFileSync(path.join(jsDir, f), "utf8"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  // <button ... id="x" ...> — id ve varsa data-modal-close isareti birlikte.
  const buttons = [...html.matchAll(/<button\b([^>]*)>/g)].map((m) => m[1]);
  const withId = buttons
    .map((attrs) => ({
      id: (attrs.match(/\bid="([^"]+)"/) || [])[1],
      selfClosing: /\bdata-modal-close\b/.test(attrs)
    }))
    .filter((b) => b.id);

  it("markup'ta id tasiyan buton var (test bosa dusmesin)", () => {
    expect(withId.length).toBeGreaterThan(10);
  });

  it("her butonun ya JS'te bir isleyicisi ya data-modal-close isareti var", () => {
    const olu = withId.filter((b) => !b.selfClosing && !jsSource.includes(b.id)).map((b) => b.id);
    expect(olu, `Bu butonlara hicbir davranis bagli degil: ${olu.join(", ")}`).toEqual([]);
  });

  it("her modal tiklanabilir bir kapatma yolu sunuyor", () => {
    // Escape ve overlay tiklamasi her modalda var, ama kullanicinin gordugu
    // dugme de calismali. modalBranch'in "Geri" dugmesi kendi akisina donuyor,
    // modalNotes kapanirken not kaydediyor: ikisi de JS tarafinda baglaniyor.
    const ozelAkis = ["modalBranch", "modalNotes"];
    // Modal govdesini kapanis etiketiyle degil, bir sonraki modalin baslangici
    // ile siniriyoruz: girintiye bagli bir regex prettier bicimini degistirince
    // sessizce hicbir modal bulamaz hale gelirdi.
    const modals = html
      .split('<div class="modal-overlay" id="')
      .slice(1)
      .map((parca) => [parca.slice(0, parca.indexOf('"')), parca]);
    expect(modals.length).toBeGreaterThan(4);
    for (const [id, body] of modals) {
      if (ozelAkis.includes(id)) continue;
      expect(body, `${id} icinde data-modal-close tasiyan buton yok`).toMatch(/data-modal-close/);
    }
  });
});

// Kapatma delegasyonu app.js'te tek noktadan yapiliyor. Butona tek tek
// listener baglama donemine geri donulurse bu test uyarir.
describe("app.js — modal kapatma delegasyonu", () => {
  const appJs = fs.readFileSync(path.join(publicDir, "js", "app.js"), "utf8");

  it("data-modal-close icin delegated dinleyici var", () => {
    expect(appJs).toMatch(/closest\(["']\[data-modal-close\]["']\)/);
  });

  it("overlay disina tiklama hala kapatiyor", () => {
    expect(appJs).toMatch(/classList\.contains\(["']modal-overlay["']\)/);
  });

  it("Escape hala kapatiyor", () => {
    expect(appJs).toMatch(/e\.key === ["']Escape["'][\s\S]{0,40}closeModals\(\)/);
  });
});
