import {
  api,
  toast,
  openModal,
  closeModals,
  timeAgo,
  events,
  switchTab,
  serviceUrl,
  hasService,
  markServiceUnavailable,
  escapeHtml,
  showSkeleton,
  showSkeletonIfEmpty,
  clearBusy
} from "./app.js";
import { openNotes } from "./notes.js";
import { runGitOp } from "./git-ops.js";
import { openSettings } from "./settings.js";

// Proje acma linki: domain varsa code subdomain'i, yoksa /code path'i
function codeUrl(folder) {
  return serviceUrl("code") + "/?folder=" + encodeURIComponent(folder);
}

let githubRepos = [];

function typeBadge(type) {
  if (!type || type === "Bos") return "";
  const cls =
    { "Node.js": "type-nodejs", Python: "type-python", Rust: "type-rust", Go: "type-go" }[type] ||
    "";
  return '<span class="card-type ' + cls + '">' + escapeHtml(type) + "</span>";
}

async function loadProjects() {
  const grid = document.getElementById("projectsGrid");
  // Iskelet istekten ONCE basilir: "Henuz proje yok" bos durumu, istek
  // donmeden bir an gorunup kaybolmasin.
  showSkeletonIfEmpty(grid, "cards", 6);
  try {
    const projects = await api("/api/projects");
    clearBusy(grid);
    if (!projects.length) {
      grid.innerHTML =
        '<div class="empty-state"><svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg><p>Henuz proje yok</p><span class="hint">Ctrl+N ile yeni proje olustur</span></div>';
      return;
    }
    // code-server kayitli degilse "Ac" link olarak uretilmez; markup sonrasi
    // markServiceUnavailable ile devre disi gorunume alinir.
    const codeReady = hasService("code");
    // Kart icerigi klonlanmis repo'dan gelebilir (branch adi, dosya adlari);
    // metin de nitelik de escapeHtml'den gecer.
    grid.innerHTML = projects
      .map(
        (p, i) => `
      <div class="project-card${p.pinned ? " pinned" : ""}" style="animation-delay:${i * 0.04}s">
        <button class="card-pin-btn${p.pinned ? " pinned" : ""}" data-action="pin" data-project="${escapeHtml(p.name)}" data-pinned="${p.pinned ? "1" : "0"}" title="${p.pinned ? "Sabitlemeyi kaldır" : "Sabitle"}">
          <svg viewBox="0 0 24 24" fill="${p.pinned ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24z"/></svg>
        </button>
        <div class="card-top">
          <div class="card-name">${escapeHtml(p.name)}</div>
          ${typeBadge(p.type)}
        </div>
        <div class="card-meta">
          ${p.branch ? `<span><svg viewBox="0 0 24 24"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>${escapeHtml(p.branch)}</span>` : ""}
          <span><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>${timeAgo(p.modified)}</span>
          <span><svg viewBox="0 0 24 24"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>${escapeHtml(p.size)}</span>
        </div>
        <div class="card-actions">
          <a${codeReady ? ` href="${escapeHtml(codeUrl(p.path))}" target="_blank"` : ""} class="btn-open" data-code-link>
            <svg viewBox="0 0 24 24" style="width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:2;margin-right:4px;vertical-align:middle"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
            Ac
          </a>
          <div class="separator"></div>
          <button class="btn-action green" data-action="pull" data-project="${escapeHtml(p.name)}">
            <svg viewBox="0 0 24 24"><polyline points="7 13 12 18 17 13"/><line x1="12" y1="6" x2="12" y2="18"/></svg>
            <span class="tooltip">Pull</span>
          </button>
          <button class="btn-action purple" data-action="push" data-project="${escapeHtml(p.name)}">
            <svg viewBox="0 0 24 24"><polyline points="7 11 12 6 17 11"/><line x1="12" y1="6" x2="12" y2="18"/></svg>
            <span class="tooltip">Push</span>
          </button>
          <button class="btn-action" data-action="git-tab" data-project="${escapeHtml(p.name)}">
            <svg viewBox="0 0 24 24"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
            <span class="tooltip">Git</span>
          </button>
          <button class="btn-action" data-action="notes" data-project="${escapeHtml(p.name)}">
            <svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
            <span class="tooltip">Notlar</span>
          </button>
          <button class="btn-action" data-action="rename" data-project="${escapeHtml(p.name)}">
            <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            <span class="tooltip">Yeniden Adlandir</span>
          </button>
          <button class="btn-action red" data-action="delete" data-project="${escapeHtml(p.name)}">
            <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            <span class="tooltip">Sil</span>
          </button>
        </div>
      </div>
    `
      )
      .join("");

    // Event delegation for card actions
    grid.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", handleCardAction);
    });
    if (!codeReady) {
      grid.querySelectorAll("[data-code-link]").forEach((el) => markServiceUnavailable(el, "code"));
    }
  } catch (e) {
    // Iskelet burada mutlaka kaldirilmali: aksi halde hata durumunda ekran
    // sonsuza kadar "yukleniyor" gibi parildar.
    clearBusy(grid);
    grid.innerHTML =
      '<div class="empty-state"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><p>Projeler yuklenemedi</p><span class="hint">' +
      escapeHtml(e.message) +
      "</span></div>";
    toast(e.message, "error");
  }
}

async function togglePin(project, currentlyPinned) {
  try {
    await api("/api/projects/" + encodeURIComponent(project) + "/pin", {
      method: "PUT",
      body: { pinned: !currentlyPinned }
    });
    toast(currentlyPinned ? project + " sabitleme kaldirildi" : project + " sabitlendi");
    loadProjects();
  } catch (e) {
    toast(e.message, "error");
  }
}

function handleCardAction(e) {
  const btn = e.currentTarget;
  const action = btn.dataset.action;
  const project = btn.dataset.project;

  switch (action) {
    case "pin":
      togglePin(project, btn.dataset.pinned === "1");
      break;
    case "pull":
      gitPull(project);
      break;
    case "push":
      gitPush(project);
      break;
    case "git-tab":
      switchTab("git");
      events.emit("project:select", { project, tab: "git" });
      break;
    case "notes":
      openNotes(project);
      break;
    case "rename":
      openRenameModal(project);
      break;
    case "delete":
      deleteProject(project);
      break;
  }
}

function tempClass(celsius) {
  if (isNaN(celsius)) return "";
  return celsius > 75 ? "hot" : celsius > 55 ? "warm" : "cool";
}

function pctColor(pct) {
  return pct > 85 ? "var(--red)" : pct > 70 ? "var(--orange)" : "var(--accent)";
}

async function loadSystem() {
  const sysEl = document.getElementById("systemInfo");
  // Bu fonksiyon 30 saniyede bir tekrar cagriliyor: iskelet yalnizca kart
  // henuz bosken basilir, yoksa sistem kutusu her donguda parildardi.
  showSkeletonIfEmpty(sysEl, "info", 8);
  try {
    const s = await api("/api/system");
    clearBusy(sysEl);
    const cpuTempVal = parseFloat(s.cpuTemp);
    const cpuClass = tempClass(cpuTempVal);
    const memPct = parseInt(s.memory.percent);
    const diskPct = parseInt(s.disk.percent);

    let html = "";
    html += `<div class="info-row"><span class="info-label">CPU Sicaklik</span><span class="info-value ${cpuClass}">${s.cpuTemp}</span></div>`;

    // GPU row (only if nvidia-smi exists)
    if (s.gpu) {
      const gpuTempVal = parseFloat(s.gpu.temp);
      const gpuClass = tempClass(gpuTempVal);
      const vramPct = s.gpu.memTotal ? Math.round((s.gpu.memUsed / s.gpu.memTotal) * 100) : 0;
      html += `<div class="info-row"><span class="info-label">GPU</span><span class="info-value ${gpuClass}" title="${s.gpu.name}">${s.gpu.temp} / ${s.gpu.util}</span></div>`;
      html += `<div class="info-row"><span class="info-label">VRAM</span><span class="info-value">${s.gpu.memUsed} / ${s.gpu.memTotal} MB</span></div>`;
      html += `<div class="bar-track"><div class="bar-fill" style="width:${vramPct}%; background:${pctColor(vramPct)}"></div></div>`;
    }

    // CPU + load average (1/5/15 min)
    const load = s.loadAvg || ["?", "?", "?"];
    html += `<div class="info-row" style="margin-top:6px"><span class="info-label">CPU</span><span class="info-value">${s.cpuCores} cekirdek</span></div>`;
    html += `<div class="info-row"><span class="info-label">Load</span><span class="info-value" title="1dk / 5dk / 15dk ortalama">${load[0]} / ${load[1]} / ${load[2]}</span></div>`;

    // RAM
    html += `<div class="info-row" style="margin-top:6px"><span class="info-label">RAM</span><span class="info-value">${s.memory.used} / ${s.memory.total}</span></div>`;
    html += `<div class="bar-track"><div class="bar-fill" style="width:${memPct}%; background:${pctColor(memPct)}"></div></div>`;

    // Main disk
    html += `<div class="info-row" style="margin-top:6px"><span class="info-label">Disk /</span><span class="info-value">${s.disk.used} / ${s.disk.total}</span></div>`;
    html += `<div class="bar-track"><div class="bar-fill" style="width:${diskPct}%; background:${pctColor(diskPct)}"></div></div>`;

    // Ikinci disk — backend alan adi secondaryDisk (eskiden dataDisk okunuyordu)
    if (s.secondaryDisk) {
      const dataPct = parseInt(s.secondaryDisk.percent);
      const label = s.secondaryDiskPath || "ikinci disk";
      html += `<div class="info-row" style="margin-top:6px"><span class="info-label">Disk ${label}</span><span class="info-value">${s.secondaryDisk.used} / ${s.secondaryDisk.total}</span></div>`;
      html += `<div class="bar-track"><div class="bar-fill" style="width:${dataPct}%; background:${pctColor(dataPct)}"></div></div>`;
    }

    html += `<div class="info-row" style="margin-top:6px"><span class="info-label">Uptime</span><span class="info-value">${s.uptime}</span></div>`;

    document.getElementById("systemInfo").innerHTML = html;
  } catch (e) {
    // Sessiz gecmek iskeleti ekranda birakirdi; ilk yukleme basarisizsa
    // kutuyu sebebiyle birlikte kapatiyoruz.
    clearBusy(sysEl);
    if (sysEl && sysEl.querySelector(".skeleton")) {
      sysEl.innerHTML =
        '<div class="info-row"><span class="info-label">Sistem bilgisi alinamadi</span></div>';
    }
  }
}

// Git operations — use new modal with conflict resolution
function gitPull(name) {
  runGitOp(name, "pull");
}

function gitPush(name) {
  runGitOp(name, "push");
}

// Clone with streaming progress
async function streamCloneUI(apiUrl, body, repoName) {
  closeModals();
  openModal("progress");
  const icon = document.getElementById("progressIcon");
  const phase = document.getElementById("progressPhase");
  const detail = document.getElementById("progressDetail");
  const barFill = document.getElementById("progressBarFill");
  const pctText = document.getElementById("progressPercent");
  const log = document.getElementById("progressLog");
  const actions = document.getElementById("progressActions");
  const openBtn = document.getElementById("progressOpenBtn");
  icon.className = "progress-icon spinning";
  icon.innerHTML =
    '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10"/><polyline points="12 6 12 12 16 14"/></svg>';
  phase.textContent = repoName + " klonlaniyor...";
  detail.textContent = "";
  barFill.className = "progress-bar-fill indeterminate";
  barFill.style.width = "0%";
  barFill.style.background = "";
  pctText.textContent = "";
  log.innerHTML = "";
  actions.style.display = "none";
  openBtn.style.display = "";

  try {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const data = JSON.parse(line.slice(6));
          if (data.phase) phase.textContent = data.phase;
          if (data.percent !== null && data.percent !== undefined) {
            barFill.classList.remove("indeterminate");
            barFill.style.width = data.percent + "%";
            pctText.textContent = data.percent + "%";
          }
          if (data.raw) {
            detail.textContent = data.raw.slice(0, 80);
            const div = document.createElement("div");
            div.textContent = data.raw;
            log.appendChild(div);
            log.scrollTop = log.scrollHeight;
          }
          if (data.done) {
            if (data.success) {
              icon.className = "progress-icon done";
              icon.innerHTML =
                '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="8 12 11 15 16 9"/></svg>';
              phase.textContent = repoName + " klonlandi!";
              barFill.classList.remove("indeterminate");
              barFill.style.width = "100%";
              pctText.textContent = "100%";
              // data.path her zaman backend'ten gelir; fallback yok
              if (hasService("code")) openBtn.href = codeUrl(data.path || "");
              else markServiceUnavailable(openBtn, "code");
              actions.style.display = "flex";
              loadProjects();
            } else {
              icon.className = "progress-icon fail";
              icon.innerHTML =
                '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
              phase.textContent = "Klonlama basarisiz";
              detail.textContent = data.error || "";
              barFill.classList.remove("indeterminate");
              barFill.style.width = "100%";
              barFill.style.background = "var(--red)";
              actions.style.display = "flex";
              openBtn.style.display = "none";
            }
          }
        } catch (e) {}
      }
    }
  } catch (e) {
    icon.className = "progress-icon fail";
    icon.innerHTML =
      '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
    phase.textContent = "Baglanti hatasi";
    detail.textContent = e.message;
    actions.style.display = "flex";
    openBtn.style.display = "none";
  }
}

// GitHub
async function loadGithubBadge() {
  try {
    const s = await api("/api/settings");
    const el = document.getElementById("githubBadge");
    if (s.githubUser) {
      const user = escapeHtml(encodeURIComponent(s.githubUser));
      el.innerHTML =
        '<div class="github-badge" id="githubBadgeBtn"><img src="https://github.com/' +
        user +
        '.png?size=48" alt=""><span>@' +
        escapeHtml(s.githubUser) +
        "</span></div>";
      document
        .getElementById("githubBadgeBtn")
        .addEventListener("click", () => openModal("github"));
    } else {
      el.innerHTML = "";
    }
  } catch (e) {}
}

async function loadGithubRepos() {
  const list = document.getElementById("repoList");
  showSkeleton(list, "rows", 6);
  try {
    const s = await api("/api/settings");
    clearBusy(list);
    if (!s.githubUser) {
      list.innerHTML =
        '<div style="text-align:center; padding:30px; color:var(--text-muted)"><p>GitHub bagli degil</p><button class="btn btn-primary" id="goToSettingsBtn" style="margin-top:10px">Ayarlardan Baglan</button></div>';
      document.getElementById("goToSettingsBtn").addEventListener("click", () => {
        closeModals();
        openSettings();
      });
      return;
    }
    document.getElementById("githubModalSubtitle").textContent = "@" + s.githubUser + " depolari";
    showSkeleton(list, "rows", 6);
    githubRepos = await api("/api/github/repos");
    clearBusy(list);
    renderRepos(githubRepos);
  } catch (e) {
    list.innerHTML =
      '<div style="text-align:center; color:var(--red); padding:20px;">' +
      escapeHtml(e.message) +
      "</div>";
  }
}

function renderRepos(repos) {
  const list = document.getElementById("repoList");
  if (!repos.length) {
    list.innerHTML =
      '<div style="text-align:center; color:var(--text-muted); padding:20px;">Repo bulunamadi</div>';
    return;
  }
  // Repo adi/aciklamasi/dili GitHub API'sinden gelir (org repo'larinda baskasi
  // yazmis olabilir) — hepsi escape edilir.
  list.innerHTML = repos
    .map(
      (r) => `
    <div class="repo-item">
      <div class="repo-info">
        <div class="repo-name">${escapeHtml(r.name)} ${r.isPrivate ? '<span class="private-badge">PRIVATE</span>' : ""}</div>
        ${r.description ? '<div class="repo-desc">' + escapeHtml(r.description) + "</div>" : ""}
        <div class="repo-meta">
          ${r.language ? "<span>" + escapeHtml(r.language) + "</span>" : ""}
          <span>${timeAgo(r.updatedAt)}</span>
          ${r.stars ? "<span>* " + escapeHtml(r.stars) + "</span>" : ""}
        </div>
      </div>
      <button class="btn btn-primary btn-sm" data-clone-repo="${escapeHtml(r.fullName)}" data-clone-url="${escapeHtml(r.cloneUrl)}" data-clone-name="${escapeHtml(r.name)}">Klonla</button>
    </div>
  `
    )
    .join("");
  list.querySelectorAll("[data-clone-repo]").forEach((btn) => {
    btn.addEventListener("click", () =>
      selectRepoForClone(btn.dataset.cloneRepo, btn.dataset.cloneUrl, btn.dataset.cloneName)
    );
  });
}

let pendingClone = {};

async function selectRepoForClone(fullName, cloneUrl, name) {
  pendingClone = { fullName, cloneUrl, name };
  closeModals();
  openModal("branch");
  const select = document.getElementById("branchSelect");
  const loading = document.getElementById("branchLoading");
  const cloneBtn = document.getElementById("branchCloneBtn");
  document.getElementById("branchModalTitle").textContent = name;
  document.getElementById("branchModalSubtitle").textContent = "Klonlanacak branch'i sec";
  document.getElementById("branchCloneName").value = "";
  select.innerHTML = "";
  select.style.display = "none";
  loading.style.display = "block";
  cloneBtn.disabled = true;
  try {
    const data = await api("/api/github/branches?repo=" + encodeURIComponent(fullName));
    // Branch adlari repo sahibinin kontrolunde; git ref'leri "<" ve ">" kabul eder.
    select.innerHTML = data.branches
      .map(
        (b) =>
          '<option value="' +
          escapeHtml(b) +
          '"' +
          (b === data.defaultBranch ? " selected" : "") +
          ">" +
          escapeHtml(b) +
          (b === data.defaultBranch ? " (varsayilan)" : "") +
          "</option>"
      )
      .join("");
    select.style.display = "";
    loading.style.display = "none";
    cloneBtn.disabled = false;
  } catch (e) {
    loading.innerHTML =
      '<span style="color:var(--red)">Branch\'ler yuklenemedi: ' +
      escapeHtml(e.message) +
      "</span>";
    cloneBtn.disabled = false;
  }
}

// Rename
function openRenameModal(name) {
  document.getElementById("renameOld").value = name;
  document.getElementById("renameNew").value = name;
  document.getElementById("renameSubtitle").textContent = name + " projesini yeniden adlandir";
  openModal("rename");
}

async function deleteProject(name) {
  if (!confirm(name + " projesini silmek istedigine emin misin?")) return;
  try {
    await api("/api/projects/" + name, { method: "DELETE" });
    toast(name + " silindi");
    loadProjects();
  } catch (e) {
    toast(e.message, "error");
  }
}

// Ayarlar modali (GitHub entegrasyonu, 2FA, sifre) settings.js'in sorumlulugunda.

// Public API
export function init() {
  loadProjects();
  loadSystem();
  loadGithubBadge();
  setInterval(loadSystem, 30000);

  // Form handlers
  document.getElementById("newProjectForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/projects", {
        method: "POST",
        body: {
          name: document.getElementById("newName").value,
          template: document.getElementById("newTemplate").value
        }
      });
      toast("Proje olusturuldu");
      closeModals();
      document.getElementById("newName").value = "";
      loadProjects();
    } catch (e) {
      toast(e.message, "error");
    }
  });

  document.getElementById("cloneForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = document.getElementById("cloneUrl").value;
    const name =
      document.getElementById("cloneName").value || url.split("/").pop().replace(".git", "");
    streamCloneUI("/api/clone", { url, name }, name);
  });

  document.getElementById("renameForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/projects/" + document.getElementById("renameOld").value, {
        method: "PUT",
        body: { newName: document.getElementById("renameNew").value }
      });
      toast("Yeniden adlandirildi");
      closeModals();
      loadProjects();
    } catch (e) {
      toast(e.message, "error");
    }
  });

  // Header button handlers
  document.getElementById("btnGithub").addEventListener("click", () => {
    openModal("github");
    loadGithubRepos();
  });
  document.getElementById("btnClone").addEventListener("click", () => openModal("clone"));
  document.getElementById("btnNewProject").addEventListener("click", () => openModal("new"));
  document.getElementById("btnRefresh").addEventListener("click", () => {
    loadProjects();
    loadSystem();
  });
  // btnSettings settings.js tarafindan baglaniyor
  document.getElementById("btnLogout").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" });
    window.location.href = "/login";
  });

  // Branch clone
  document.getElementById("branchCloneBtn").addEventListener("click", () => {
    const branch = document.getElementById("branchSelect").value;
    const name = document.getElementById("branchCloneName").value || pendingClone.name;
    streamCloneUI("/api/github/clone", { cloneUrl: pendingClone.cloneUrl, name, branch }, name);
  });

  document.getElementById("branchBackBtn").addEventListener("click", () => {
    closeModals();
    openModal("github");
  });

  // Repo search
  document.getElementById("repoSearch").addEventListener("input", () => {
    const q = document.getElementById("repoSearch").value.toLowerCase();
    renderRepos(
      githubRepos.filter(
        (r) => r.name.toLowerCase().includes(q) || (r.description || "").toLowerCase().includes(q)
      )
    );
  });

  // Refresh event
  events.on("refresh", () => {
    loadProjects();
    loadSystem();
  });
}

export function activate() {
  // Called when tab becomes active — refresh data
  loadProjects();
}
