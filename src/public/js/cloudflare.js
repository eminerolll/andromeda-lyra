import { api, toast, escapeHtml, showSkeletonIfEmpty, clearBusy } from "./app.js";

// Tunnel sekmesi. Uc mod var, hangisinde oldugumuzu sunucu soyler
// (/api/cf/status -> detectMode):
//   api    — ingress Cloudflare API'sinden okunur/yazilir
//   local  — ingress sunucudaki config.yml'den yonetilir (v1 mirasi)
//   remote — tunnel uzaktan yonetiliyor, token yok: salt-okunur
let status = {
  enabled: false,
  integrationEnabled: false,
  active: false,
  mode: "remote",
  canManage: false
};
let entries = [];
let settings = { hasToken: false, tokenPreview: null, zoneDomain: null, tunnelId: null };
let health = {};
let readOnly = false;
let ingressSource = null;

// app.js'teki api() sadece hata METNINI firlatir; DNS cakismasinda cakisan
// kayitlarin listesine de ihtiyacimiz var, o yuzden yazma cagrilarinda ham
// cevabi okuyoruz.
async function cfFetch(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (res.status === 401) {
    window.location.href = "/login";
    return { ok: false, status: 401, data: {} };
  }
  let data = {};
  try {
    data = await res.json();
  } catch (_) {
    data = {};
  }
  return { ok: res.ok, status: res.status, data };
}

async function loadAll() {
  showSkeletonIfEmpty("cfContent", "rows", 5);
  try {
    status = await api("/api/cf/status");
    settings = await api("/api/cf/settings");
    entries = [];
    readOnly = !status.canManage;
    ingressSource = null;

    if (status.canManage && status.integrationEnabled) {
      const i = await api("/api/cf/ingress");
      entries = i.entries || [];
      readOnly = !!i.readOnly;
      ingressSource = i.source || null;
    }
    clearBusy("cfContent");
    render();
    if (status.canManage && status.integrationEnabled) loadHealth();
  } catch (e) {
    const container = document.getElementById("cfContent");
    clearBusy(container);
    if (container) {
      container.innerHTML =
        '<div style="padding:40px; text-align:center; color:var(--red);">Yuklenemedi: ' +
        escapeHtml(e.message) +
        "</div>";
    }
  }
}

async function loadHealth() {
  try {
    const h = await api("/api/cf/health");
    health = h.health || {};
    updateHealthDots();
  } catch (_) {}
}

function healthColor(level) {
  if (level === "green") return "var(--green)";
  if (level === "yellow") return "var(--orange)";
  if (level === "red") return "var(--red)";
  return "var(--text-muted)";
}

function updateHealthDots() {
  document.querySelectorAll("[data-health-host]").forEach((el) => {
    const host = el.dataset.healthHost;
    const h = health[host];
    if (!h) {
      el.style.color = "var(--text-muted)";
      el.title = "kontrol ediliyor";
    } else {
      el.style.color = healthColor(h.level);
      el.title = h.code
        ? h.code + (h.latency ? " (" + h.latency + "ms)" : "")
        : h.reason || "bilinmiyor";
    }
  });
}

const MODE_LABEL = {
  api: "Cloudflare API ile yonetiliyor",
  local: "Yerel config.yml ile yonetiliyor",
  remote: "Uzaktan yonetiliyor (salt-okunur)"
};

function infoBox(text, color) {
  return (
    '<div style="font-size:12px; color:' +
    (color || "var(--text-muted)") +
    '; margin-bottom:16px; padding:10px 12px; background:var(--bg-input); border-radius:6px;">' +
    text +
    "</div>"
  );
}

function renderHeader() {
  const dot = status.active
    ? '<span style="color:var(--green);">●</span>'
    : '<span style="color:var(--red);">●</span>';
  const statusText = status.active ? "Cloudflare tunnel aktif" : "Tunnel calismiyor";

  let html = "";
  html +=
    '<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; flex-wrap:wrap; gap:8px;">';
  html +=
    '<div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">' +
    dot +
    " <span>" +
    statusText +
    "</span>";
  html +=
    '<span class="badge" style="font-size:11px; color:var(--text-muted); border:1px solid var(--border); padding:2px 8px; border-radius:10px;">' +
    escapeHtml(MODE_LABEL[status.mode] || status.mode) +
    "</span>";
  if (settings.tunnelId) {
    html +=
      '<span style="color:var(--text-muted); font-size:11px; font-family:JetBrains Mono, monospace;">' +
      escapeHtml(settings.tunnelId) +
      "</span>";
  }
  html += "</div>";
  html += '<button class="btn btn-sm" id="cfSettingsBtn">API Ayarlari</button>';
  html += "</div>";
  return html;
}

function renderTokenPanel(alwaysOpen) {
  let html =
    '<div id="cfSettingsPanel" class="side-card" style="margin-bottom:16px;' +
    (alwaysOpen ? "" : " display:none;") +
    '">';
  html += '<div class="section-label" style="margin-bottom:8px;">Cloudflare API Token</div>';
  html += '<div style="font-size:12px; color:var(--text-muted); margin-bottom:12px;">';
  html +=
    status.mode === "local"
      ? "Yerel modda ekleme icin token gerekmez (cert.pem kullanilir). Token yalnizca ingress silerken DNS kaydini otomatik silmek icin kullanilir."
      : "Token ile ingress ve DNS kayitlari dogrudan Cloudflare API'sinden yonetilir. Gerekli izinler: Account &gt; Cloudflare Tunnel &gt; Edit, Zone &gt; Zone &gt; Read, Zone &gt; DNS &gt; Edit.";
  html += "</div>";

  if (settings.hasToken) {
    html +=
      '<div style="margin-bottom:12px; font-size:13px;">Token: <span style="font-family:JetBrains Mono, monospace;">' +
      escapeHtml(settings.tokenPreview) +
      "</span>";
    if (settings.zoneDomain) {
      html +=
        ' &middot; Zone: <span style="color:var(--green);">' +
        escapeHtml(settings.zoneDomain) +
        "</span>";
    }
    html += "</div>";
    html +=
      '<button class="btn btn-sm" id="cfTokenClear" style="color:var(--red);">Token\'i Sil</button>';
  } else {
    html += '<form id="cfTokenForm" style="display:flex; gap:8px; flex-wrap:wrap;">';
    html +=
      '<input type="password" class="form-input" id="cfTokenInput" placeholder="Cloudflare API token..." style="flex:1; min-width:220px;" required>';
    html += '<button type="submit" class="btn btn-primary">Kaydet</button>';
    html += "</form>";
  }
  html += "</div>";
  return html;
}

// Mod C: durumu oldugu gibi anlat, sahte bir duzenleme arayuzu gosterme.
function renderRemote() {
  let html = renderHeader();
  html += infoBox(escapeHtml(status.note || ""), "var(--orange)");
  html += renderTokenPanel(true);

  html += '<div class="section-label" style="margin-bottom:12px;">Baglantiyi Kesfet</div>';
  html +=
    '<form id="cfDiscoverForm" class="side-card" style="display:flex; flex-wrap:wrap; gap:12px; align-items:end; margin-bottom:12px;">';
  html += '<div class="form-group" style="margin-bottom:0; flex:1; min-width:200px;">';
  html += '<label class="form-label">Tunnel ID (bulunamazsa)</label>';
  html +=
    '<input type="text" class="form-input" id="cfDiscoverTunnel" placeholder="otomatik kesfedilir">';
  html += "</div>";
  html += '<div class="form-group" style="margin-bottom:0; flex:1; min-width:180px;">';
  html += '<label class="form-label">Domain</label>';
  html +=
    '<input type="text" class="form-input" id="cfDiscoverDomain" placeholder="' +
    escapeHtml(settings.zoneDomain || "example.com") +
    '">';
  html += "</div>";
  html +=
    '<button type="submit" class="btn btn-primary"' +
    (settings.hasToken ? "" : ' disabled title="Once token kaydet"') +
    ">Kesfet</button>";
  html += "</form>";
  html += infoBox(
    "Kesif sirasinda tunnel id sunucudaki cloudflared servisinden okunmaya calisilir. " +
      "Bulunamazsa Cloudflare panelindeki tunnel id'sini yukariya elle gir — Lyra bir deger uydurmaz."
  );
  return html;
}

function renderTable() {
  // Catch-all her zaman en sonda gosterilir.
  const rows = [...entries.filter((e) => !e.isCatchAll), ...entries.filter((e) => e.isCatchAll)];
  let html =
    '<div class="section-label" style="margin-bottom:12px;">Mevcut Ingress (' +
    rows.length +
    ")</div>";

  if (!rows.length) {
    html +=
      '<div style="text-align:center; padding:30px; color:var(--text-muted);">Kayit yok</div>';
    return html;
  }

  html +=
    '<table class="ports-table"><thead><tr><th>Hostname</th><th>Servis</th><th>Tip</th><th></th></tr></thead><tbody>';
  for (const e of rows) {
    const hostname = e.hostname || "(catch-all)";
    const tip = e.isCatchAll
      ? "fallback"
      : e.isWildcard
        ? "wildcard"
        : e.isProtected
          ? "korumali"
          : "normal";
    const tipColor = e.isProtected
      ? "var(--orange)"
      : e.isCatchAll || e.isWildcard
        ? "var(--text-muted)"
        : "var(--green)";
    const pingable =
      e.hostname &&
      !e.isCatchAll &&
      !e.isWildcard &&
      e.service &&
      /^http:\/\/(localhost|127\.0\.0\.1):/.test(e.service);
    const deletable = !readOnly && e.hostname && !e.isProtected && !e.isWildcard && !e.isCatchAll;

    html += "<tr>";
    html += "<td>";
    if (pingable) {
      html +=
        '<span data-health-host="' +
        escapeHtml(e.hostname) +
        '" style="margin-right:6px; color:var(--text-muted);" title="kontrol ediliyor">●</span>';
    }
    html += escapeHtml(hostname) + "</td>";
    html +=
      '<td style="font-family:JetBrains Mono, monospace; font-size:12px;">' +
      escapeHtml(e.service || "-") +
      "</td>";
    html += '<td style="color:' + tipColor + '; font-size:12px;">' + tip + "</td>";
    html += '<td style="text-align:right;">';
    if (e.hostname && !e.isCatchAll) {
      html +=
        '<a href="https://' +
        encodeURI(e.hostname) +
        '" target="_blank" class="btn btn-sm" style="margin-right:4px;">Ac</a>';
    }
    if (deletable) {
      html +=
        '<button class="btn btn-sm" data-remove="' +
        escapeHtml(e.hostname) +
        '" style="color:var(--red);">Sil</button>';
    }
    html += "</td></tr>";
  }
  html += "</tbody></table>";
  return html;
}

function renderManaged() {
  let html = renderHeader();

  if (!status.integrationEnabled) {
    html += infoBox(
      "Cloudflare entegrasyonu kapali; ingress goruntulenemez. Ayarlar &gt; Entegrasyonlar'dan ac.",
      "var(--orange)"
    );
    return html;
  }

  html += renderTokenPanel(false);

  if (status.mode === "api" && ingressSource && ingressSource !== "cloudflare") {
    html += infoBox(
      "Uyari: Cloudflare bu tunnel'in yapilandirmasini &quot;" +
        escapeHtml(ingressSource) +
        "&quot; olarak bildiriyor. Buradan yazilan ingress cloudflared tarafindan yok sayilabilir.",
      "var(--orange)"
    );
  }

  html += '<div class="section-label" style="margin-bottom:12px;">Yeni Tunnel Ekle</div>';
  html +=
    '<form id="cfAddForm" class="side-card" style="display:flex; flex-wrap:wrap; gap:12px; align-items:end; margin-bottom:12px;">';
  html += '<div class="form-group" style="margin-bottom:0; flex:2; min-width:220px;">';
  html += '<label class="form-label">Hostname</label>';
  html +=
    '<input type="text" class="form-input" id="cfHostname" placeholder="app.' +
    escapeHtml(settings.zoneDomain || "example.com") +
    '" required>';
  html += "</div>";
  html += '<div class="form-group" style="margin-bottom:0; flex:1; min-width:100px;">';
  html += '<label class="form-label">Local Port</label>';
  html +=
    '<input type="number" class="form-input" id="cfPort" placeholder="8090" min="1" max="65535" required>';
  html += "</div>";
  html += '<div class="form-group" style="margin-bottom:0;">';
  html +=
    '<label style="font-size:12px; display:flex; align-items:center; gap:6px; padding-bottom:8px;">';
  html += '<input type="checkbox" id="cfAutoDns" checked>';
  html += " DNS kaydi olustur";
  html += "</label>";
  html += "</div>";
  html += '<button type="submit" class="btn btn-primary">Ekle</button>';
  html += "</form>";

  html += infoBox(
    status.mode === "api"
      ? "Yeni kural wildcard kuralindan once, catch-all her zaman en sonda tutulur. DNS kaydi tunnel'a CNAME olarak yazilir; ayni isimde baska bir kayit varsa uzerine yazmadan once onayin sorulur."
      : "DNS kaydi cloudflared CLI ile olusturulur (token gerekmez). Silerken DNS kaydini temizlemek icin API token gerekir."
  );

  html += renderTable();
  return html;
}

function render() {
  const container = document.getElementById("cfContent");
  if (!container) return;

  if (!status.enabled) {
    container.innerHTML =
      '<div style="padding:40px; text-align:center; color:var(--text-muted);">' +
      "Cloudflare entegrasyonu kapali.</div>";
    return;
  }

  container.innerHTML = status.canManage ? renderManaged() : renderRemote();
  attachHandlers(container);
  updateHealthDots();
}

function conflictText(host, conflicts) {
  const lines = (conflicts || []).map((r) => `${r.type} ${r.name} -> ${r.content}`);
  return (
    host +
    " icin zaten DNS kaydi var:\n" +
    lines.join("\n") +
    "\n\nMevcut kaydin uzerine yazilsin mi? (Iptal edersen hicbir sey degismez)"
  );
}

async function submitAdd(root, hostname, port, autoDns, overwriteDns) {
  const r = await cfFetch("/api/cf/ingress", {
    method: "POST",
    body: { hostname, port, autoDns, overwriteDns }
  });
  if (r.ok) {
    toast(hostname + " eklendi" + (r.data.dns ? " + DNS" : ""));
    root.querySelector("#cfHostname").value = "";
    root.querySelector("#cfPort").value = "";
    setTimeout(loadAll, status.mode === "api" ? 500 : 3500);
    return;
  }
  if (r.status === 409 && r.data.needsOverwrite && !overwriteDns) {
    if (confirm(conflictText(hostname, r.data.conflicts))) {
      return submitAdd(root, hostname, port, autoDns, true);
    }
    toast("Iptal edildi — DNS kaydina dokunulmadi");
    return;
  }
  toast(r.data.error || "Eklenemedi", "error");
}

function attachHandlers(root) {
  const settingsBtn = root.querySelector("#cfSettingsBtn");
  const panel = root.querySelector("#cfSettingsPanel");
  if (settingsBtn && panel) {
    settingsBtn.addEventListener("click", () => {
      panel.style.display = panel.style.display === "none" ? "" : "none";
    });
  }

  const tokenForm = root.querySelector("#cfTokenForm");
  if (tokenForm) {
    tokenForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const token = root.querySelector("#cfTokenInput").value.trim();
      const r = await cfFetch("/api/cf/settings/token", { method: "POST", body: { token } });
      if (!r.ok) return toast(r.data.error || "Token kaydedilemedi", "error");
      toast("Token kaydedildi");
      // Mod C'de token tek basina yetmez: hesap/zone/tunnel bilgisi de lazim.
      if (!status.canManage) await runDiscover({});
      loadAll();
    });
  }

  const tokenClear = root.querySelector("#cfTokenClear");
  if (tokenClear) {
    tokenClear.addEventListener("click", async () => {
      if (!confirm("API token'i sil? Sekme salt-okunur moda doner.")) return;
      const r = await cfFetch("/api/cf/settings/token", { method: "DELETE" });
      if (!r.ok) return toast(r.data.error || "Silinemedi", "error");
      toast("Token silindi");
      loadAll();
    });
  }

  const discoverForm = root.querySelector("#cfDiscoverForm");
  if (discoverForm) {
    discoverForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = discoverForm.querySelector("button[type=submit]");
      btn.disabled = true;
      await runDiscover({
        tunnelId: root.querySelector("#cfDiscoverTunnel").value.trim(),
        domain: root.querySelector("#cfDiscoverDomain").value.trim()
      });
      btn.disabled = false;
      loadAll();
    });
  }

  const form = root.querySelector("#cfAddForm");
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const hostname = root.querySelector("#cfHostname").value.trim();
      const port = parseInt(root.querySelector("#cfPort").value);
      const autoDns = root.querySelector("#cfAutoDns").checked;
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      btn.textContent = "Ekleniyor...";
      try {
        await submitAdd(root, hostname, port, autoDns, false);
      } finally {
        btn.disabled = false;
        btn.textContent = "Ekle";
      }
    });
  }

  root.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const host = btn.dataset.remove;
      if (!confirm(host + " ingress kaydi silinsin mi?")) return;
      // DNS kaydi sessizce silinmez; ayrica soruluyor.
      const dropDns =
        settings.hasToken &&
        confirm(
          host +
            " icin DNS kaydi da silinsin mi?\n\n" +
            "Hayir dersen ingress silinir, DNS kaydi Cloudflare'de kalir."
        );
      btn.disabled = true;
      const r = await cfFetch(
        "/api/cf/ingress/" + encodeURIComponent(host) + (dropDns ? "?dns=1" : ""),
        { method: "DELETE" }
      );
      btn.disabled = false;
      if (!r.ok) return toast(r.data.error || "Silinemedi", "error");
      toast(host + " silindi" + (r.data.dnsWarning ? " — " + r.data.dnsWarning : ""));
      setTimeout(loadAll, status.mode === "api" ? 500 : 3500);
    });
  });
}

async function runDiscover(body) {
  const r = await cfFetch("/api/cf/discover", { method: "POST", body });
  if (r.ok) {
    toast("Baglanti kuruldu: tunnel " + (r.data.tunnelId || "").slice(0, 8) + "...");
    return true;
  }
  toast(r.data.error || "Kesif basarisiz", "error");
  return false;
}

export function init() {
  loadAll();
}

export function activate() {
  loadAll();
}
