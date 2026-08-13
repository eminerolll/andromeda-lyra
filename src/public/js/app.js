// Tab management and shared utilities

// App config (server'dan cekilir, init sirasinda doldurulur)
export const appConfig = {
  appName: "Lyra",
  publicAccess: false,
  baseDomain: null,
  // Kayitli servisler ({ type, port, enabled }) — link uretimi icin
  services: [],
  // Hangi tablar/servisler aktif
  enabled: { docker: false, cloudflare: false }
};

// Servis kisayolu -> { path, subdomain, type }. Tek dogru kaynak:
// link uretimi tum modullerde serviceUrl/devPreviewUrl uzerinden yapilir.
const SERVICE_LINKS = {
  code: { path: "/code", subdomain: "code", type: "code-server" },
  files: { path: "/files", subdomain: "files", type: "filebrowser" },
  db: { path: "/db", subdomain: "db", type: "dbgate" }
};

function usesSubdomains() {
  return !!(appConfig.publicAccess && appConfig.baseDomain);
}

// Servis kayitli ve acik mi?
export function hasService(key) {
  const def = SERVICE_LINKS[key];
  if (!def) return false;
  return appConfig.services.some(s => s.type === def.type && s.enabled !== false);
}

// Kayitli servisin portu (ornegin sistem port tablosunda code-server'i tanimak icin)
export function servicePort(key) {
  const def = SERVICE_LINKS[key];
  if (!def) return null;
  const found = appConfig.services.find(s => s.type === def.type && s.enabled !== false);
  return found ? found.port : null;
}

// Servis kok adresi (sondaki "/" YOK — cagiran taraf ekler).
// Domain varsa subdomain (Katman 2), yoksa path (Katman 1).
export function serviceUrl(key) {
  const def = SERVICE_LINKS[key];
  if (!def) return null;
  if (usesSubdomains()) return "https://" + def.subdomain + "." + appConfig.baseDomain;
  return def.path;
}

// Dev server preview adresi (sondaki "/" YOK). Named servislerin aksine
// dev-{port} host'u wildcard sertifika ister; Caddy modunda alinamadigi icin
// her modda path formu uretilir — LAN'da da, domain'de de calisir.
export function devPreviewUrl(port) {
  return "/dev/" + port;
}

// HTML escape — innerHTML ile string birlestiren TUM moduller bunu kullanir.
// & < > " ' hepsi kacirilir, yani hem metin hem de tirnakli nitelik ("...")
// baglaminda guvenli; ayri bir escapeAttr'a gerek yok.
export function escapeHtml(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Event bus for inter-module communication
export const events = {
  _listeners: {},
  on(event, fn) {
    (this._listeners[event] = this._listeners[event] || []).push(fn);
  },
  emit(event, data) {
    (this._listeners[event] || []).forEach(fn => fn(data));
  }
};

// API wrapper
export async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (res.status === 401 && !path.includes("/login")) {
    window.location.href = "/login";
    return;
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

// Toast notifications
export function toast(msg, type = "success") {
  const el = document.createElement("div");
  el.className = "toast " + type;
  el.textContent = msg;
  document.getElementById("toasts").appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// Modal management
export function openModal(type) {
  closeModals();
  const id = "modal" + type.charAt(0).toUpperCase() + type.slice(1);
  const el = document.getElementById(id);
  if (el) el.classList.add("active");
  setTimeout(() => {
    const input = document.querySelector(".modal-overlay.active .form-input");
    if (input) input.focus();
  }, 100);
}

export function closeModals() {
  document.querySelectorAll(".modal-overlay").forEach(m => m.classList.remove("active"));
}

// Time formatting
export function timeAgo(date) {
  const diff = (Date.now() - new Date(date)) / 1000;
  if (diff < 60) return "az once";
  if (diff < 3600) return Math.floor(diff / 60) + " dk once";
  if (diff < 86400) return Math.floor(diff / 3600) + " saat once";
  return Math.floor(diff / 86400) + " gun once";
}

// Tab system
const tabs = {};
let activeTab = null;

export function registerTab(name, module) {
  tabs[name] = { module, initialized: false };
}

export function switchTab(name) {
  if (activeTab === name) return;

  // Deactivate current tab
  document.querySelectorAll(".tab-content").forEach(el => el.classList.remove("active"));
  document.querySelectorAll(".tab-btn").forEach(el => el.classList.remove("active"));

  // Activate new tab
  const contentEl = document.getElementById("tab-" + name);
  const btnEl = document.querySelector('[data-tab="' + name + '"]');
  if (contentEl) contentEl.classList.add("active");
  if (btnEl) btnEl.classList.add("active");

  activeTab = name;
  window.location.hash = name;

  // Lazy init
  const tab = tabs[name];
  if (tab && !tab.initialized) {
    tab.module.init();
    tab.initialized = true;
  }

  // Activate callback
  if (tab && tab.module.activate) {
    tab.module.activate();
  }
}

async function loadAppConfig() {
  try {
    const settings = await api("/api/settings");
    appConfig.appName = settings.appName || "Lyra";
    appConfig.publicAccess = !!settings.publicAccess;
    appConfig.baseDomain = settings.baseDomain || null;
  } catch (_) {}

  // Kayitli servisler — hangi kisayollarin gosterilecegini belirler
  try {
    const data = await api("/api/services");
    appConfig.services = data.services || [];
  } catch (_) {}

  // Servislerin durumu (cf, docker)
  try {
    const cf = await fetch("/api/cf/status").then(r => r.json());
    appConfig.enabled.cloudflare = !!cf.enabled;
  } catch (_) {}
  try {
    const dk = await fetch("/api/docker/status").then(r => r.json());
    appConfig.enabled.docker = !!dk.enabled;
  } catch (_) {}
}

function applyBranding() {
  const el = document.getElementById("appName");
  if (el) el.textContent = appConfig.appName;
  document.title = appConfig.appName + " — Launcher";

  // Quick links: servis kayitliysa gosterilir. Domain sart degil —
  // path modunda ayni linkler /db, /files uzerinden calisir.
  const codeLink = document.getElementById("quickLinkCode");
  if (codeLink) codeLink.href = serviceUrl("code") + "/";

  const quick = document.getElementById("quickLinks");
  if (!quick) return;
  if (hasService("db")) {
    quick.insertAdjacentHTML("beforeend", `
      <a href="${serviceUrl("db")}/" target="_blank" class="quick-link">
        <svg viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>
        DbGate
      </a>
    `);
  }
  if (hasService("files")) {
    quick.insertAdjacentHTML("beforeend", `
      <a href="${serviceUrl("files")}/" target="_blank" class="quick-link">
        <svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        Dosyalar
      </a>
    `);
  }
}

function applyTabVisibility() {
  // Devre disi servislerin tablarini gizle
  if (!appConfig.enabled.cloudflare) {
    document.querySelector('[data-tab="cf"]')?.style.setProperty("display", "none");
    document.getElementById("tab-cf")?.style.setProperty("display", "none");
  }
  if (!appConfig.enabled.docker) {
    document.querySelector('[data-tab="docker"]')?.style.setProperty("display", "none");
    document.getElementById("tab-docker")?.style.setProperty("display", "none");
  }
}

// Initialize app
export async function initApp() {
  await loadAppConfig();
  applyBranding();
  applyTabVisibility();

  // Close modals on overlay click
  document.querySelectorAll(".modal-overlay").forEach(m => {
    m.addEventListener("click", (e) => {
      if (e.target === m) closeModals();
    });
  });

  // Tab bar click handlers
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key >= "1" && e.key <= "7") {
      e.preventDefault();
      const tabNames = ["projects", "ports", "git", "env", "logs", "docker", "cf"];
      const tab = tabNames[parseInt(e.key) - 1];
      // Devre disi tablar atlanir
      if (tab === "docker" && !appConfig.enabled.docker) return;
      if (tab === "cf" && !appConfig.enabled.cloudflare) return;
      switchTab(tab);
    }
    if (e.ctrlKey && e.key === "n") { e.preventDefault(); openModal("new"); }
    if (e.ctrlKey && e.key === "g") { e.preventDefault(); openModal("clone"); }
    if (e.ctrlKey && e.key === "r") { e.preventDefault(); events.emit("refresh"); }
    if (e.key === "Escape") closeModals();
  });

  // Restore tab from URL hash
  const hash = window.location.hash.slice(1);
  const validTabs = ["projects", "ports", "git", "env", "logs", "docker", "cf"];
  let initialTab = validTabs.includes(hash) ? hash : "projects";
  if (initialTab === "docker" && !appConfig.enabled.docker) initialTab = "projects";
  if (initialTab === "cf" && !appConfig.enabled.cloudflare) initialTab = "projects";
  switchTab(initialTab);
}
