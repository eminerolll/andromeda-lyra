// "Uzaktan eris" panel — sidebar'a localhost mod icin SSH komutu, LAN/public icin URL
// Sidebar'da "Hizli Erisim"in altina yerlesir.

import { api, toast, escapeHtml } from "./app.js";

export async function init() {
  // Sadece dashboard'da (login sonrasi) calis
  if (!document.getElementById("systemInfo")) return;

  try {
    const info = await api("/api/connect-info");
    render(info);
  } catch (_) {
    // sessizce gec
  }
}

function render(info) {
  const sidebar = document.querySelector(".sidebar");
  if (!sidebar) return;

  const card = document.createElement("div");
  card.innerHTML = `
    <div class="section-label">Uzaktan Erişim</div>
    <div class="side-card" id="connectInfoCard"></div>
  `;
  sidebar.appendChild(card);

  const inner = card.querySelector("#connectInfoCard");
  let html = "";

  if (info.bindAddress === "127.0.0.1" || info.accessMode === "localhost") {
    html = `
      <div style="font-size:12px; color:var(--text-muted); margin-bottom:8px;">
        🔒 Localhost modu — başka cihazdan erişmek için SSH tunnel kur:
      </div>
      <div style="position:relative;">
        <code style="display:block; background:var(--bg); padding:10px; border-radius:6px; font-size:11px; word-break:break-all; padding-right:32px; line-height:1.4; color:var(--text);">${escapeHtml(info.sshCommand || "")}</code>
        <button class="btn btn-icon btn-ghost" id="copySsh" title="Kopyala" style="position:absolute; top:4px; right:4px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
      </div>
      <div style="font-size:11px; color:var(--text-muted); margin-top:8px;">
        Sonra tarayıcı: <code style="font-size:11px;">http://localhost:${info.port}</code>
      </div>
    `;
  } else if (info.bindAddress === "0.0.0.0") {
    html = `
      <div style="font-size:12px; color:var(--text-muted); margin-bottom:8px;">
        🏠 LAN modu — bu URL'lerden erişebilirsin:
      </div>
      ${(info.finalUrls || [])
        .map(
          (u) => `
        <a href="${escapeHtml(u)}" target="_blank" class="quick-link">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
          ${escapeHtml(u)}
        </a>
      `
        )
        .join("")}
    `;
  } else if (info.finalUrls && info.finalUrls.length) {
    html = `
      <div style="font-size:12px; color:var(--text-muted); margin-bottom:8px;">🌍 Public erişim:</div>
      ${info.finalUrls
        .map(
          (u) => `
        <a href="${escapeHtml(u)}" target="_blank" class="quick-link">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>
          ${escapeHtml(u)}
        </a>
      `
        )
        .join("")}
    `;
  } else {
    html = '<div style="font-size:12px; color:var(--text-muted);">Erişim bilgisi yok</div>';
  }

  inner.innerHTML = html;

  // Copy button
  const copyBtn = inner.querySelector("#copySsh");
  if (copyBtn) {
    copyBtn.addEventListener("click", () => {
      navigator.clipboard
        .writeText(info.sshCommand)
        .then(() => {
          toast("SSH komutu kopyalandı");
        })
        .catch(() => {
          toast("Kopyalanamadı", "error");
        });
    });
  }
}
