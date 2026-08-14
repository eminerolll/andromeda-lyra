import { api, toast, events, escapeHtml, showSkeletonIfEmpty, clearBusy } from "./app.js";

let currentProject = null;
let globalVars = [];
// projectFiles: [{ relativePath, vars: [{key, value}] }]
let projectFiles = [];
let revealedKeys = new Set();

async function loadProjectList() {
  try {
    const projects = await api("/api/projects");
    const select = document.getElementById("envProjectSelect");
    select.innerHTML =
      '<option value="">Proje sec...</option>' +
      projects
        .map(
          (p) =>
            '<option value="' +
            escapeHtml(p.name) +
            '"' +
            (p.name === currentProject ? " selected" : "") +
            ">" +
            escapeHtml(p.name) +
            "</option>"
        )
        .join("");
  } catch (e) {}
}

async function loadEnvData() {
  showSkeletonIfEmpty("envContent", "rows", 6);
  try {
    globalVars = await api("/api/env/global");
  } catch (e) {
    globalVars = [];
  }

  if (currentProject) {
    try {
      projectFiles = await api("/api/env/project/" + encodeURIComponent(currentProject));
    } catch (e) {
      projectFiles = [];
    }
  } else {
    projectFiles = [];
  }

  revealedKeys.clear();
  clearBusy("envContent");
  render();
}

function maskValue(value, revealKey) {
  if (revealedKeys.has(revealKey)) return value;
  if (!value) return "";
  if (value.length <= 4) return "***";
  return "***" + value.slice(-4);
}

function renderEnvRow(key, value, scope, fileIdx, sensitive) {
  const revealKey = scope + ":" + (fileIdx != null ? fileIdx : "") + ":" + key;
  const shouldMask = sensitive || scope === "global";
  const displayValue = shouldMask ? maskValue(value, revealKey) : value;

  let html = '<div class="env-row">';
  html += '<span class="env-key">' + escapeHtml(key) + "</span>";
  html += '<span class="env-value">' + escapeHtml(displayValue) + "</span>";
  html += '<div class="env-actions">';
  if (shouldMask) {
    html +=
      '<button class="btn btn-sm btn-ghost" data-reveal="' +
      escapeHtml(revealKey) +
      '">' +
      (revealedKeys.has(revealKey) ? "Gizle" : "Goster") +
      "</button>";
  }
  html +=
    '<button class="btn btn-sm btn-ghost" data-edit-key="' +
    escapeHtml(key) +
    '" data-scope="' +
    scope +
    '"' +
    (fileIdx != null ? ' data-file-idx="' + fileIdx + '"' : "") +
    ">Duzenle</button>";
  html +=
    '<button class="btn btn-sm btn-ghost" style="color:var(--red);" data-delete-key="' +
    escapeHtml(key) +
    '" data-scope="' +
    scope +
    '"' +
    (fileIdx != null ? ' data-file-idx="' + fileIdx + '"' : "") +
    ">Sil</button>";
  html += "</div></div>";
  return html;
}

function render() {
  const container = document.getElementById("envContent");
  let html = "";

  // Global vars
  html += '<div class="env-section">';
  html += '<div class="env-section-title">Global Degiskenler</div>';
  if (globalVars.length === 0) {
    html +=
      '<div style="padding:12px; color:var(--text-muted); font-size:12px;">Global degisken yok</div>';
  } else {
    for (const v of globalVars) {
      html += renderEnvRow(v.key, v.value, "global", null, v.sensitive);
    }
  }
  html += "</div>";

  // Project env files (monorepo support: multiple .env files)
  if (currentProject) {
    if (projectFiles.length === 0) {
      html += '<div class="env-section">';
      html += '<div class="env-section-title">Proje Env Dosyalari</div>';
      html +=
        '<div style="padding:12px; color:var(--text-muted); font-size:12px;">Bu projede .env dosyasi bulunamadi.</div>';
      html += "</div>";
    } else {
      for (let i = 0; i < projectFiles.length; i++) {
        const file = projectFiles[i];
        html += '<div class="env-section">';
        html +=
          '<div class="env-section-title" style="display:flex; align-items:center; justify-content:space-between;">';
        html +=
          '<span><code style="color:var(--accent);">' +
          escapeHtml(file.relativePath) +
          "</code> (" +
          file.vars.length +
          " degisken)</span>";
        html +=
          '<button class="btn btn-sm" data-copy-file="' + i + '">.env olarak kopyala</button>';
        html += "</div>";
        if (file.vars.length === 0) {
          html +=
            '<div style="padding:12px; color:var(--text-muted); font-size:12px;">Bos dosya</div>';
        } else {
          for (const v of file.vars) {
            html += renderEnvRow(v.key, v.value, "project", i);
          }
        }
        html += "</div>";
      }
    }
  }

  container.innerHTML = html;

  // Event handlers
  container.querySelectorAll("[data-reveal]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.reveal;
      if (revealedKeys.has(key)) {
        revealedKeys.delete(key);
      } else {
        revealedKeys.add(key);
        setTimeout(() => {
          revealedKeys.delete(key);
          render();
        }, 10000);
      }
      render();
    });
  });

  container.querySelectorAll("[data-edit-key]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.editKey;
      const scope = btn.dataset.scope;
      const fileIdx = btn.dataset.fileIdx != null ? parseInt(btn.dataset.fileIdx) : null;
      startEdit(key, scope, fileIdx);
    });
  });

  container.querySelectorAll("[data-delete-key]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.deleteKey;
      const scope = btn.dataset.scope;
      const fileIdx = btn.dataset.fileIdx != null ? parseInt(btn.dataset.fileIdx) : null;
      deleteVar(key, scope, fileIdx);
    });
  });

  container.querySelectorAll("[data-copy-file]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.copyFile);
      const file = projectFiles[idx];
      if (!file) return;
      const text = file.vars.map((v) => v.key + "=" + v.value).join("\n");
      navigator.clipboard.writeText(text).then(() => toast(file.relativePath + " kopyalandi"));
    });
  });

  // Populate file selector in add form
  populateFileSelector();
}

function populateFileSelector() {
  const select = document.getElementById("envNewFile");
  if (!select) return;

  if (!currentProject) {
    select.innerHTML = '<option value="__global__">Global</option>';
    return;
  }

  let html = '<option value="__global__">Global</option>';
  for (const file of projectFiles) {
    html +=
      '<option value="' +
      escapeHtml(file.relativePath) +
      '">' +
      escapeHtml(file.relativePath) +
      "</option>";
  }
  html += '<option value="__new__">+ Yeni .env dosyasi...</option>';
  select.innerHTML = html;
}

function startEdit(key, scope, fileIdx) {
  let entry;
  if (scope === "global") {
    entry = globalVars.find((v) => v.key === key);
  } else {
    const file = projectFiles[fileIdx];
    if (!file) return;
    entry = file.vars.find((v) => v.key === key);
  }
  if (!entry) return;

  const newValue = prompt(key + " icin yeni deger:", entry.value);
  if (newValue === null) return;

  entry.value = newValue;

  if (scope === "global") {
    saveGlobal();
  } else {
    saveProjectFile(fileIdx);
  }
}

async function deleteVar(key, scope, fileIdx) {
  if (!confirm(key + " degiskenini silmek istedigine emin misin?")) return;

  if (scope === "global") {
    globalVars = globalVars.filter((v) => v.key !== key);
    await saveGlobal();
  } else {
    const file = projectFiles[fileIdx];
    if (!file) return;
    file.vars = file.vars.filter((v) => v.key !== key);
    await saveProjectFile(fileIdx);
  }
}

async function saveGlobal() {
  try {
    await api("/api/env/global", { method: "PUT", body: { vars: globalVars } });
    toast("Global kaydedildi");
    loadEnvData();
  } catch (e) {
    toast(e.message, "error");
  }
}

async function saveProjectFile(fileIdx) {
  const file = projectFiles[fileIdx];
  if (!file || !currentProject) return;
  try {
    await api("/api/env/project/" + encodeURIComponent(currentProject), {
      method: "PUT",
      body: { filePath: file.relativePath, vars: file.vars }
    });
    toast(file.relativePath + " kaydedildi");
    loadEnvData();
  } catch (e) {
    toast(e.message, "error");
  }
}

async function addVar(e) {
  e.preventDefault();
  const fileValue = document.getElementById("envNewFile").value;
  const key = document.getElementById("envNewKey").value.trim();
  const value = document.getElementById("envNewValue").value;
  const sensitive = document.getElementById("envNewSensitive").checked;

  if (!key) {
    toast("Anahtar gerekli", "error");
    return;
  }

  if (fileValue === "__global__") {
    globalVars.push({ key, value, sensitive });
    await saveGlobal();
  } else {
    if (!currentProject) {
      toast("Once bir proje sec", "error");
      return;
    }

    let targetFile = fileValue;
    if (fileValue === "__new__") {
      const newPath = prompt("Yeni env dosyasinin yolu (ornek: frontend/.env veya .env.local):");
      if (!newPath || !newPath.trim()) return;
      targetFile = newPath.trim();
      // Basic validation - must end in .env or .env.*
      if (!/(?:^|\/)\.env(\..+)?$/.test(targetFile)) {
        toast("Dosya adi .env veya .env.<variant> olmali", "error");
        return;
      }
    }

    // Find or create file entry
    let file = projectFiles.find((f) => f.relativePath === targetFile);
    if (!file) {
      file = { relativePath: targetFile, vars: [] };
      projectFiles.push(file);
    }
    file.vars.push({ key, value });

    try {
      await api("/api/env/project/" + encodeURIComponent(currentProject), {
        method: "PUT",
        body: { filePath: file.relativePath, vars: file.vars }
      });
      toast(key + " eklendi (" + file.relativePath + ")");
      document.getElementById("envNewKey").value = "";
      document.getElementById("envNewValue").value = "";
      loadEnvData();
    } catch (e) {
      toast(e.message, "error");
    }
  }
}

export function init() {
  const select = document.getElementById("envProjectSelect");
  select.addEventListener("change", () => {
    currentProject = select.value || null;
    loadEnvData();
  });

  document.getElementById("envAddForm").addEventListener("submit", addVar);

  events.on("project:select", (data) => {
    if (data.tab === "env") {
      currentProject = data.project;
      loadProjectList();
      loadEnvData();
    }
  });
}

export function activate() {
  loadProjectList();
  loadEnvData();
}
