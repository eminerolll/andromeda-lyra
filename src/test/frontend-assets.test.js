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
