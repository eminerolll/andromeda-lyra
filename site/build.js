// GitHub Pages icin statik site ureticisi.
//
// Dis bagimlilik YOK: markdown donusturucu olarak repoda zaten vendor'lanmis
// marked kullaniliyor (src/public/vendor/marked.min.js). Boylece site, panelin
// kendisiyle ayni "ucuncu tarafa istek gitmez" ilkesini koruyor.
//
// Cikti: _site/
//   index.html          site/index.html (tanitim sayfasi)
//   docs/<ad>.html      docs/*.md + kokteki INSTALL/CONTRIBUTING/... dosyalari
//   assets/             logo, ekran goruntuleri, font
//
// Calistirma: node site/build.js

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "_site");
const marked = require(
  path.join(ROOT, "src", "public", "vendor", "marked.min.js"),
);

// ── Markdown -> guvenli HTML ────────────────────────────────────────────────
// Panelin notes.js'indeki ile ayni gerekce: kaynak dosyalar bizim olsa da ham
// HTML'i gecirmenin bir faydasi yok, kapatiyoruz.
const renderer = new marked.Renderer();
renderer.html = (t) => escapeHtml(typeof t === "string" ? t : t.text || "");
marked.setOptions({ renderer, headerIds: true, mangle: false });

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Repo ici .md linkleri uretilen .html yollarina cevrilir; aksi halde site
// icindeki her link ziyaretciyi GitHub'a atardi.
//
// Esleme ACIK tutuluyor, yol desenine gore tahmin edilmiyor: dokumanlar
// birbirine "./docs/x.md", "../INSTALL.md", "x.md" gibi farkli oneklerle
// baglaniyor ve onek bazli regex'ler bunlarin bir kismini sessizce kaciriyordu.
// Burada yalnizca DOSYA ADI'na bakiliyor, onek ne olursa olsun.
const LINK_MAP = {
  "README.md": "../index.html",
  "INSTALL.md": "./install-guide.html",
  "SECURITY.md": "./security-policy.html",
  "CONTRIBUTING.md": "./contributing.html",
  "CHANGELOG.md": "./changelog.html",
  "install.md": "./install.html",
  "architecture.md": "./architecture.html",
  "configuration.md": "./configuration.html",
  "deployment.md": "./deployment.html",
  "security.md": "./security.html",
};

const eslenmeyen = new Set();

function rewriteLinks(html) {
  return html.replace(/href="([^"]+?\.md)(#[^"]*)?"/gi, (tam, yol, kesit) => {
    const hedef = LINK_MAP[yol.split("/").pop()];
    if (!hedef) {
      // Sessizce birakmak kirik link uretir; build sonunda uyariyoruz.
      eslenmeyen.add(yol);
      return tam;
    }
    return `href="${hedef}${kesit || ""}"`;
  });
}

const NAV = [
  ["install", "Kurulum"],
  ["architecture", "Mimari"],
  ["configuration", "Yapılandırma"],
  ["deployment", "Dağıtım"],
  ["security", "Güvenlik"],
  ["changelog", "Değişiklikler"],
  ["contributing", "Katkı"],
];

function shell({ title, body, active, depth }) {
  const base = depth ? "../" : "./";
  const nav = NAV.map(
    ([slug, label]) =>
      `<a href="${base}docs/${slug}.html"${slug === active ? ' class="active"' : ""}>${label}</a>`,
  ).join("");
  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="theme-color" content="#D97757">
<link rel="icon" href="${base}assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${base}assets/style.css">
</head>
<body>
<header class="site-head">
  <a class="brand" href="${base}index.html">
    <img src="${base}assets/logo-lockup.svg" alt="Lyra" height="26">
  </a>
  <nav>${nav}<a class="gh" href="https://github.com/eminerolll/andromeda-lyra">GitHub</a></nav>
</header>
${body}
<footer class="site-foot">
  <p>AGPL-3.0 · <a href="https://github.com/eminerolll/andromeda-lyra">github.com/eminerolll/andromeda-lyra</a></p>
</footer>
</body>
</html>
`;
}

// ── Cikti hazirligi ─────────────────────────────────────────────────────────
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "docs"), { recursive: true });
fs.mkdirSync(path.join(OUT, "assets"), { recursive: true });

// Varliklar
const assets = [
  ["docs/images/logo-lockup.svg", "logo-lockup.svg"],
  ["docs/images/projects.jpg", "projects.jpg"],
  ["docs/images/ports.jpg", "ports.jpg"],
  ["docs/images/git.jpg", "git.jpg"],
  ["docs/images/login.jpg", "login.jpg"],
  ["src/public/favicon.svg", "favicon.svg"],
  ["src/public/brand/og-image.png", "og-image.png"],
  ["src/public/fonts/Newsreader-Medium.woff2", "Newsreader-Medium.woff2"],
];
for (const [from, to] of assets) {
  const src = path.join(ROOT, from);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT, "assets", to));
  else console.warn("! varlik yok:", from);
}
fs.copyFileSync(
  path.join(__dirname, "style.css"),
  path.join(OUT, "assets", "style.css"),
);

// ── Dokuman sayfalari ───────────────────────────────────────────────────────
const docSources = [
  ["docs/install.md", "install", "Kurulum"],
  ["docs/architecture.md", "architecture", "Mimari"],
  ["docs/configuration.md", "configuration", "Yapılandırma"],
  ["docs/deployment.md", "deployment", "Dağıtım"],
  ["docs/security.md", "security", "Güvenlik"],
  ["CHANGELOG.md", "changelog", "Değişiklikler"],
  ["CONTRIBUTING.md", "contributing", "Katkı"],
  ["INSTALL.md", "install-guide", "Kurulum Rehberi"],
  ["SECURITY.md", "security-policy", "Güvenlik Politikası"],
];

let uretilen = 0;
for (const [rel, slug, title] of docSources) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) {
    console.warn("! dokuman yok:", rel);
    continue;
  }
  const md = fs.readFileSync(src, "utf8");
  const body = `<main class="doc"><article>${rewriteLinks(marked.parse(md))}</article></main>`;
  fs.writeFileSync(
    path.join(OUT, "docs", slug + ".html"),
    shell({ title: `${title} — Lyra`, body, active: slug, depth: 1 }),
  );
  uretilen++;
}

// ── Tanitim sayfasi ─────────────────────────────────────────────────────────
const landing = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
fs.writeFileSync(
  path.join(OUT, "index.html"),
  shell({
    title: "Lyra — Self-hosted geliştirici ortamı paneli",
    body: landing,
    depth: 0,
  }),
);

// Jekyll'in _ ile baslayan klasorleri yok saymasini engelle
fs.writeFileSync(path.join(OUT, ".nojekyll"), "");

console.log(`_site hazir: ${uretilen} dokuman + tanitim sayfasi`);

if (eslenmeyen.size) {
  // Kirik link uretmektense build'i durduruyoruz: yeni bir dokuman eklendiginde
  // LINK_MAP'e yazilmasi gerektigi burada anlasilsin.
  console.error("\nEslenmemis .md linkleri (LINK_MAP'e ekle):");
  for (const y of eslenmeyen) console.error("  " + y);
  process.exit(1);
}
