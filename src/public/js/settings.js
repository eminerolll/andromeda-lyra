// Settings modal — 6 sekme: Genel / Erişim / Servisler / Güvenlik / Entegrasyonlar / Hesap

import { api, toast, closeModals, escapeHtml } from "./app.js";

let initialized = false;
let currentTab = "general";

// Public init: app.js bunu cagirir, modalSettings acildiginda calisir
export function init() {
  if (initialized) return;
  initialized = true;

  // Tab switcher
  document.querySelectorAll(".settings-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  // Form submit'leri
  bindForm("settingsGeneralForm", saveGeneral);
  bindForm("settingsAccessForm", saveAccess);
  document.getElementById("btnSaveSecurity")?.addEventListener("click", saveSecurity);
  bindForm("changePasswordForm", changePassword);

  // Servis ekleme
  document.getElementById("btnAddService")?.addEventListener("click", addServicePrompt);

  // Ban yonetimi
  document.getElementById("btnAddBan")?.addEventListener("click", addBan);

  // Olay gecmisi
  document.getElementById("btnReloadAudit")?.addEventListener("click", loadAuditLog);
  document.getElementById("auditFilter")?.addEventListener("change", loadAuditLog);

  // Settings butonu opening
  document.getElementById("btnSettings")?.addEventListener("click", () => openSettings());
  document.getElementById("settingsCloseBtn")?.addEventListener("click", closeModals);

  // Bind_address degisirse public_access uyarisi
  document.getElementById("setBind_address")?.addEventListener("change", checkRestartHint);
  document.getElementById("setPublic_access")?.addEventListener("change", checkRestartHint);
}

export async function openSettings() {
  closeModals();
  document.getElementById("modalSettings").classList.add("active");
  switchTab(currentTab);
  await Promise.all([
    loadHealthSummary(),
    loadGeneral(),
    loadAccess(),
    loadServices(),
    loadSecurity(),
    loadBans(),
    loadAuditLog(),
    loadIntegrations(),
    load2FA()
  ]);
}

function switchTab(name) {
  currentTab = name;
  document.querySelectorAll(".settings-tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === name);
  });
  document.querySelectorAll(".settings-tab-pane").forEach((p) => {
    p.style.display = p.id === `settings-tab-${name}` ? "" : "none";
  });
}

function bindForm(id, handler) {
  const f = document.getElementById(id);
  if (!f) return;
  f.addEventListener("submit", (e) => {
    e.preventDefault();
    handler();
  });
}

// ─── Sistem Durumu ───
async function loadHealthSummary() {
  const el = document.getElementById("healthSummary");
  if (!el) return;
  try {
    const h = await api("/api/health-summary");
    const rows = [
      ["Sürüm", `v${h.lyra.version} (Node ${h.lyra.nodeVersion})`],
      ["Lyra servisi", `${h.lyra.serviceName} — ${h.lyra.serviceStatus || "bilinmiyor"}`],
      ["Lyra uptime", formatDuration(h.lyra.uptime)],
      ["Bellek (RSS)", `${h.lyra.memory.rss} MB`],
      ["Veritabanı", h.lyra.dbSizeKb == null ? "-" : `${h.lyra.dbSizeKb} KB`],
      ["Host", `${h.host.hostname} (${h.host.platform}/${h.host.arch})`],
      ["CPU / Load", `${h.host.cpuCount} çekirdek — ${h.host.loadAvg.join(" / ")}`],
      ["RAM", `${h.host.totalMemMb - h.host.freeMemMb} / ${h.host.totalMemMb} MB`],
      ["Host uptime", formatDuration(h.host.uptimeSec)]
    ];

    const allServices = [...(h.services || []), ...(h.auxServices || [])];
    const serviceRows = allServices.map((s) => [
      s.display_name + (s.port ? ` :${s.port}` : ""),
      `<span style="color:${s.status === "active" ? "var(--green)" : "var(--red)"}">${escapeHtml(s.status || "bilinmiyor")}</span>`
    ]);

    el.innerHTML =
      rows.map(([k, v]) => infoRow(k, escapeHtml(v))).join("") +
      (serviceRows.length
        ? '<div style="margin-top:10px; font-size:12px; color:var(--text-muted);">Servisler</div>' +
          serviceRows.map(([k, v]) => infoRow(escapeHtml(k), v)).join("")
        : "");
  } catch (e) {
    el.innerHTML = `<div style="color:var(--red)">${escapeHtml(e.message)}</div>`;
  }
}

function infoRow(label, valueHtml) {
  return `<div class="info-row"><span class="info-label">${label}</span><span class="info-value">${valueHtml}</span></div>`;
}

function formatDuration(sec) {
  if (sec == null || isNaN(sec)) return "-";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}g ${h}s`;
  if (h) return `${h}s ${m}dk`;
  return `${m}dk`;
}

// ─── Genel ───
async function loadGeneral() {
  try {
    const data = await api("/api/settings/general");
    setVal("setApp_name", data.app_name);
    setVal("setProjects_dir", data.projects_dir);
    setVal("setSecondary_disk", data.secondary_disk);
    setVal("setProd_apps_dir", data.prod_apps_dir);
  } catch (e) {
    console.error("loadGeneral:", e);
  }
}

async function saveGeneral() {
  const body = {
    app_name: getVal("setApp_name"),
    projects_dir: getVal("setProjects_dir"),
    secondary_disk: getVal("setSecondary_disk"),
    prod_apps_dir: getVal("setProd_apps_dir")
  };
  try {
    await api("/api/settings/general", { method: "PUT", body });
    toast("Genel ayarlar kaydedildi");
  } catch (e) {
    toast(e.message, "error");
  }
}

// ─── Erişim ───
let accessOriginal = {};

async function loadAccess() {
  try {
    const data = await api("/api/settings/access");
    accessOriginal = { ...data };
    setVal("setBind_address", data.bind_address || "127.0.0.1");
    document.getElementById("setPublic_access").checked = !!data.public_access;
    setVal("setBase_domain", data.base_domain);
    setVal("setSubdomain_code", data.subdomain_code);
    setVal("setSubdomain_files", data.subdomain_files);
    setVal("setSubdomain_db", data.subdomain_db);
    setVal("setSubdomain_dev_pattern", data.subdomain_dev_pattern);
    document.getElementById("accessRestartHint").style.display = "none";
  } catch (e) {
    console.error("loadAccess:", e);
  }
}

function checkRestartHint() {
  const newBind = getVal("setBind_address");
  const newPublic = document.getElementById("setPublic_access").checked;
  const changed =
    newBind !== accessOriginal.bind_address || newPublic !== !!accessOriginal.public_access;
  document.getElementById("accessRestartHint").style.display = changed ? "" : "none";
}

async function saveAccess() {
  const body = {
    bind_address: getVal("setBind_address"),
    public_access: document.getElementById("setPublic_access").checked,
    base_domain: getVal("setBase_domain"),
    subdomain_code: getVal("setSubdomain_code"),
    subdomain_files: getVal("setSubdomain_files"),
    subdomain_db: getVal("setSubdomain_db"),
    subdomain_dev_pattern: getVal("setSubdomain_dev_pattern")
  };
  try {
    const r = await api("/api/settings/access", { method: "PUT", body });
    if (r.requiresRestart) {
      toast("Kaydedildi — Lyra restart ister", "warning");
    } else {
      toast("Erişim ayarları kaydedildi");
    }
    accessOriginal = body;
    document.getElementById("accessRestartHint").style.display = "none";
  } catch (e) {
    toast(e.message, "error");
  }
}

// ─── Servisler ───
async function loadServices() {
  const list = document.getElementById("servicesList");
  if (!list) return;
  try {
    const data = await api("/api/services");
    if (!data.services.length) {
      list.innerHTML =
        '<div style="text-align:center; padding:20px; color:var(--text-muted);">Henüz servis kayıtlı değil.</div>';
      return;
    }
    list.innerHTML =
      '<table class="ports-table"><thead><tr><th>Unit</th><th>İsim</th><th>Type</th><th>Port</th><th>Durum</th><th></th></tr></thead><tbody>' +
      data.services
        .map(
          (s) => `
        <tr>
          <td><code style="font-family:var(--mono); font-size:12px;">${escapeHtml(s.unit_name)}</code></td>
          <td>${escapeHtml(s.display_name)}</td>
          <td>${escapeHtml(s.type)}</td>
          <td>${s.port || "-"}</td>
          <td>
            <label style="display:inline-flex; align-items:center; gap:6px; cursor:pointer;">
              <input type="checkbox" ${s.enabled ? "checked" : ""} data-toggle-id="${s.id}">
              ${s.enabled ? "aktif" : "pasif"}
            </label>
          </td>
          <td><button class="btn btn-sm" data-remove-id="${s.id}" style="color:var(--red)">Sil</button></td>
        </tr>
      `
        )
        .join("") +
      "</tbody></table>";

    list.querySelectorAll("[data-toggle-id]").forEach((el) => {
      el.addEventListener("change", () => toggleService(parseInt(el.dataset.toggleId), el.checked));
    });
    list.querySelectorAll("[data-remove-id]").forEach((el) => {
      el.addEventListener("click", () => removeService(parseInt(el.dataset.removeId)));
    });
  } catch (e) {
    list.innerHTML = `<div style="color:var(--red)">${escapeHtml(e.message)}</div>`;
  }
}

async function toggleService(id, enabled) {
  try {
    await api(`/api/services/${id}`, { method: "PUT", body: { enabled: enabled ? 1 : 0 } });
    loadServices();
  } catch (e) {
    toast(e.message, "error");
  }
}

async function removeService(id) {
  if (!confirm("Bu servisi silmek istediğine emin misin?")) return;
  try {
    await api(`/api/services/${id}`, { method: "DELETE" });
    toast("Servis silindi");
    loadServices();
  } catch (e) {
    toast(e.message, "error");
  }
}

async function addServicePrompt() {
  const unit = prompt("systemd unit name (örn. code-server)");
  if (!unit) return;
  const display = prompt("Görünen ad", unit);
  if (!display) return;
  const type = prompt(
    "Type (code-server / cloudflared / filebrowser / dbgate / mongod / custom)",
    "custom"
  );
  if (!type) return;
  const port = prompt("Port (opsiyonel)", "");
  try {
    await api("/api/services", {
      method: "POST",
      body: { unit_name: unit, display_name: display, type, port: port ? parseInt(port) : null }
    });
    toast("Servis eklendi");
    loadServices();
  } catch (e) {
    toast(e.message, "error");
  }
}

// ─── Güvenlik ───
async function loadSecurity() {
  try {
    const data = await api("/api/settings/security");
    setVal("setRate_limit_attempts", data.rate_limit_attempts);
    setVal("setRate_limit_window_minutes", data.rate_limit_window_minutes);
    setVal("setAuto_ban_after", data.auto_ban_after);
    setVal("setAuto_ban_api_after", data.auto_ban_api_after);
    setVal("setAuto_ban_window_minutes", data.auto_ban_window_minutes);
    setVal("setAuto_ban_duration_minutes", data.auto_ban_duration_minutes);
    setVal("setSession_ttl_days", data.session_ttl_days);
  } catch (e) {
    console.error("loadSecurity:", e);
  }
}

async function saveSecurity() {
  const body = {
    rate_limit_attempts: getVal("setRate_limit_attempts"),
    rate_limit_window_minutes: getVal("setRate_limit_window_minutes"),
    auto_ban_after: getVal("setAuto_ban_after"),
    auto_ban_api_after: getVal("setAuto_ban_api_after"),
    auto_ban_window_minutes: getVal("setAuto_ban_window_minutes"),
    auto_ban_duration_minutes: getVal("setAuto_ban_duration_minutes"),
    session_ttl_days: getVal("setSession_ttl_days")
  };
  try {
    await api("/api/settings/security", { method: "PUT", body });
    toast("Güvenlik ayarları kaydedildi");
  } catch (e) {
    toast(e.message, "error");
  }
}

// ─── Banlı IP'ler ───
async function loadBans() {
  const list = document.getElementById("bansList");
  if (!list) return;
  try {
    const data = await api("/api/bans");
    if (!data.bans.length) {
      list.innerHTML = '<div style="padding:12px 0; color:var(--text-muted);">Banlı IP yok.</div>';
      return;
    }
    list.innerHTML =
      '<table class="ports-table"><thead><tr><th>IP</th><th>Sebep</th><th>Banlandı</th><th>Bitiş</th><th>Kaynak</th><th></th></tr></thead><tbody>' +
      data.bans
        .map(
          (b) => `
        <tr>
          <td><code style="font-family:var(--mono); font-size:12px;">${escapeHtml(b.ip)}</code></td>
          <td>${escapeHtml(b.reason || "-")}</td>
          <td>${formatTs(b.banned_at)}</td>
          <td>${b.expires_at ? formatTs(b.expires_at) : "kalıcı"}</td>
          <td>${escapeHtml(b.banned_by || "-")}</td>
          <td><button class="btn btn-sm" data-unban-ip="${escapeHtml(b.ip)}">Kaldır</button></td>
        </tr>
      `
        )
        .join("") +
      "</tbody></table>";

    list.querySelectorAll("[data-unban-ip]").forEach((el) => {
      el.addEventListener("click", () => removeBan(el.dataset.unbanIp));
    });
  } catch (e) {
    list.innerHTML = `<div style="color:var(--red)">${escapeHtml(e.message)}</div>`;
  }
}

async function addBan() {
  const ip = getVal("banIp").trim();
  if (!ip) return toast("IP adresi gerekli", "error");
  const reason = getVal("banReason").trim();
  const durationMinutes = getVal("banDuration").trim();
  try {
    await api("/api/bans", {
      method: "POST",
      body: { ip, reason: reason || undefined, durationMinutes: durationMinutes || undefined }
    });
    toast(`${ip} banlandı`);
    setVal("banIp", "");
    setVal("banReason", "");
    setVal("banDuration", "");
    loadBans();
  } catch (e) {
    toast(e.message, "error");
  }
}

async function removeBan(ip) {
  if (!confirm(`${ip} adresinin banını kaldırmak istediğine emin misin?`)) return;
  try {
    await api(`/api/bans/${encodeURIComponent(ip)}`, { method: "DELETE" });
    toast(`${ip} banı kaldırıldı`);
    loadBans();
  } catch (e) {
    toast(e.message, "error");
  }
}

// ─── Olay geçmişi (audit log) ───
async function loadAuditLog() {
  const el = document.getElementById("auditLogList");
  if (!el) return;
  const eventType = getVal("auditFilter");
  el.textContent = "Yükleniyor...";
  try {
    const query = eventType ? `?limit=50&event_type=${encodeURIComponent(eventType)}` : "?limit=50";
    const data = await api("/api/audit-log" + query);
    if (!data.events.length) {
      el.innerHTML = '<div style="color:var(--text-muted);">Kayıt yok.</div>';
      return;
    }
    el.innerHTML = data.events
      .map(
        (ev) => `
      <div style="display:flex; gap:8px; padding:3px 0; border-bottom:1px solid var(--border);">
        <span style="color:var(--text-muted); white-space:nowrap;">${formatTs(ev.ts)}</span>
        <span style="color:var(--accent); white-space:nowrap;">${escapeHtml(ev.event_type)}</span>
        <span style="color:var(--text-muted); white-space:nowrap;">${escapeHtml(ev.ip || "-")}</span>
        <span style="opacity:0.8; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(ev.details ? JSON.stringify(ev.details) : "")}</span>
      </div>
    `
      )
      .join("");
  } catch (e) {
    el.innerHTML = `<div style="color:var(--red)">${escapeHtml(e.message)}</div>`;
  }
}

function formatTs(ms) {
  if (!ms) return "-";
  return new Date(ms).toLocaleString("tr-TR");
}

// ─── Entegrasyonlar ───
async function loadIntegrations() {
  // GitHub
  await loadIntegration("github", "githubSettingsContent", {
    fields: [{ key: "token", label: "Personal Access Token", type: "password" }],
    description: "repo:read scope yeterli"
  });

  // Telegram
  await loadIntegration("telegram", "telegramSettingsContent", {
    fields: [
      { key: "botToken", label: "Bot Token", type: "password" },
      { key: "ownerChatId", label: "Chat ID", type: "text" }
    ],
    description: "BotFather'dan bot oluştur, /start ile chat ID al"
  });

  // Cloudflare
  await loadIntegration("cloudflare", "cloudflareSettingsContent", {
    fields: [{ key: "apiToken", label: "API Token", type: "password" }],
    description: "Zone.DNS:Edit scope (CF Tunnel ingress yönetimi için)"
  });
}

async function loadIntegration(name, containerId, opts) {
  const el = document.getElementById(containerId);
  if (!el) return;
  try {
    const data = await api(`/api/integrations/${name}`);
    const cfg = data.config || {};
    const inputs = opts.fields
      .map(
        (f) => `
      <div class="form-group">
        <label class="form-label">${f.label}</label>
        <input type="${f.type}" class="form-input" data-int-key="${f.key}" value="${escapeHtml(cfg[f.key] || "")}">
      </div>
    `
      )
      .join("");
    el.innerHTML = `
      <div style="margin-bottom:8px;">
        <label style="display:flex; align-items:center; gap:8px;">
          <input type="checkbox" data-int-enabled ${data.enabled ? "checked" : ""}>
          Aktif
        </label>
      </div>
      ${inputs}
      <div style="font-size:12px; color:var(--text-muted); margin-bottom:12px;">${opts.description}</div>
      <button class="btn btn-primary btn-sm" data-int-save="${name}">Kaydet</button>
      <button class="btn btn-sm" data-int-remove="${name}" style="color:var(--red);">Sil</button>
    `;
    el.querySelector(`[data-int-save="${name}"]`).addEventListener("click", () =>
      saveIntegration(name, el, opts)
    );
    el.querySelector(`[data-int-remove="${name}"]`).addEventListener("click", () =>
      removeIntegration(name)
    );
  } catch (e) {
    el.innerHTML = `<div style="color:var(--red)">${escapeHtml(e.message)}</div>`;
  }
}

async function saveIntegration(name, container, opts) {
  const enabled = container.querySelector("[data-int-enabled]").checked;
  const config = {};
  for (const f of opts.fields) {
    config[f.key] = container.querySelector(`[data-int-key="${f.key}"]`).value;
  }
  try {
    await api(`/api/integrations/${name}`, { method: "PUT", body: { enabled, config } });
    toast(`${name} kaydedildi`);
  } catch (e) {
    toast(e.message, "error");
  }
}

async function removeIntegration(name) {
  if (!confirm(`${name} entegrasyonunu silmek istediğine emin misin?`)) return;
  try {
    await api(`/api/integrations/${name}`, { method: "DELETE" });
    toast("Silindi");
    loadIntegrations();
  } catch (e) {
    toast(e.message, "error");
  }
}

// ─── 2FA ───
async function load2FA() {
  const el = document.getElementById("twoFAContent");
  if (!el) return;
  try {
    const me = await api("/api/me");
    if (me.totpEnabled) {
      el.innerHTML = `
        <div style="margin-bottom:12px; color:var(--text);">2FA aktif ✓</div>
        <div class="form-group"><label class="form-label">Mevcut TOTP kodu</label><input type="text" class="form-input" id="totpDisableCode" placeholder="000000" maxlength="6"></div>
        <button class="btn" id="btnDisable2FA" style="color:var(--red)">2FA'yı Devre Dışı Bırak</button>
      `;
      document.getElementById("btnDisable2FA").addEventListener("click", disable2FA);
    } else {
      el.innerHTML = '<button class="btn btn-primary" id="btnEnable2FA">2FA Aktif Et</button>';
      document.getElementById("btnEnable2FA").addEventListener("click", enable2FA);
    }
  } catch (e) {
    el.innerHTML = `<div style="color:var(--red)">${escapeHtml(e.message)}</div>`;
  }
}

async function enable2FA() {
  try {
    const r = await api("/api/2fa/setup", { method: "POST" });
    const el = document.getElementById("twoFAContent");
    el.innerHTML = `
      <div style="background:white; padding:12px; border-radius:8px; width:fit-content; margin-bottom:12px;">
        <img src="${r.qr}" style="display:block; max-width:180px;">
      </div>
      <div style="font-family:var(--mono); font-size:12px; color:var(--text-muted); margin-bottom:12px;">${r.secret}</div>
      <div class="form-group"><label class="form-label">Doğrulama Kodu</label><input type="text" class="form-input" id="totpVerifyCode" placeholder="000000" maxlength="6"></div>
      <button class="btn btn-primary" id="btnVerify2FA">Aktif Et</button>
    `;
    document.getElementById("btnVerify2FA").addEventListener("click", verify2FA);
  } catch (e) {
    toast(e.message, "error");
  }
}

async function verify2FA() {
  const code = document.getElementById("totpVerifyCode").value;
  try {
    await api("/api/2fa/verify", { method: "POST", body: { code } });
    toast("2FA aktif edildi");
    load2FA();
  } catch (e) {
    toast(e.message, "error");
  }
}

async function disable2FA() {
  const code = document.getElementById("totpDisableCode").value;
  try {
    await api("/api/2fa/disable", { method: "POST", body: { code } });
    toast("2FA kapatıldı");
    load2FA();
  } catch (e) {
    toast(e.message, "error");
  }
}

// ─── Şifre değiştirme ───
async function changePassword() {
  const currentPassword = document.getElementById("currentPassword").value;
  const newPassword = document.getElementById("newPassword").value;
  if (newPassword.length < 12) return toast("Yeni şifre en az 12 karakter olmalı", "error");
  try {
    await api("/api/settings/password", {
      method: "POST",
      body: { currentPassword, newPassword }
    });
    toast("Şifre değiştirildi");
    document.getElementById("currentPassword").value = "";
    document.getElementById("newPassword").value = "";
  } catch (e) {
    toast(e.message, "error");
  }
}

// ─── Yardımcılar ───
function getVal(id) {
  const el = document.getElementById(id);
  return el ? el.value : "";
}
function setVal(id, v) {
  const el = document.getElementById(id);
  if (el) el.value = v == null ? "" : v;
}
