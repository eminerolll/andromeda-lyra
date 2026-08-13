// Git operation modal + runner. Reusable from project cards and Git tab.
// Shows command output, detects conflicts, offers resolution options.

import { api, toast, escapeHtml } from "./app.js";

let currentProject = null;
let currentAction = null;

function ensureModal() {
  let modal = document.getElementById("modalGitOp");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.className = "modal-overlay";
  modal.id = "modalGitOp";
  modal.innerHTML = `
    <div class="modal wide">
      <div class="modal-title" id="gitOpTitle">Git Islemi</div>
      <div class="modal-subtitle" id="gitOpSubtitle"></div>
      <div class="git-op-output" id="gitOpOutput"></div>
      <div class="git-op-conflict" id="gitOpConflict" style="display:none;">
        <div class="section-label" style="margin-top:16px;">Cozum Secenekleri</div>
        <div id="gitOpConflictButtons"></div>
      </div>
      <div class="modal-actions">
        <button class="btn" id="gitOpCloseBtn">Kapat</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelector("#gitOpCloseBtn").addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });
  return modal;
}

function closeModal() {
  const modal = document.getElementById("modalGitOp");
  if (modal) modal.classList.remove("active");
}

function openModal(title, subtitle) {
  const modal = ensureModal();
  modal.classList.add("active");
  document.getElementById("gitOpTitle").textContent = title || "Git Islemi";
  document.getElementById("gitOpSubtitle").textContent = subtitle || "";
  document.getElementById("gitOpOutput").innerHTML =
    '<div class="git-op-spinner">Calisiyor...</div>';
  document.getElementById("gitOpConflict").style.display = "none";
  document.getElementById("gitOpConflictButtons").innerHTML = "";
}

function renderOutput(result) {
  const out = document.getElementById("gitOpOutput");
  const stdout = result.stdout
    ? `<div class="git-op-stdout">${escapeHtml(result.stdout)}</div>`
    : "";
  const stderr = result.stderr
    ? `<div class="git-op-stderr">${escapeHtml(result.stderr)}</div>`
    : "";
  const statusBadge = result.ok
    ? '<span class="git-op-status ok">BASARILI (exit 0)</span>'
    : `<span class="git-op-status fail">BASARISIZ (exit ${result.exitCode})</span>`;

  const empty = !result.stdout && !result.stderr;
  out.innerHTML = `
    ${statusBadge}
    ${empty ? '<div class="git-op-stdout" style="opacity:0.5;">(cikti yok)</div>' : stdout + stderr}
  `;
}

function renderConflict(result) {
  const container = document.getElementById("gitOpConflict");
  const buttons = document.getElementById("gitOpConflictButtons");

  let html = "";
  const type = result.conflictType;

  if (type === "pull-overwrite") {
    html = `
      <div class="git-op-hint">Yerel dosyalar uzaktaki yeni dosyalarla cakisiyor. Guncellemeyi cekerse bunlar kaybolacakti. Ne yapmak istersin?</div>
      <div class="git-op-actions">
        <button class="btn btn-primary" data-resolve="stash-pull">Yerel dosyalarimi koru ve guncelle</button>
        <button class="btn" style="background:var(--red-soft); color:var(--red);" data-resolve="discard-pull">Yerel dosyalarimi sil ve guncelle</button>
      </div>
    `;
  } else if (type === "pull-merge") {
    html = `
      <div class="git-op-hint">Hem sende hem uzakta ayni dosyalarda farkli degisiklikler var. Bunlari manuel birlestirmen gerek. code-server'i ac, conflict'li dosyalari duzelt, sonra commit at. Veya guncelleme islemini iptal et.</div>
      <div class="git-op-actions">
        <button class="btn" data-resolve="reset-hard">Birlestirmeyi iptal et</button>
      </div>
    `;
  } else if (type === "push-rejected") {
    html = `
      <div class="git-op-hint">Uzakta senin olmayan yeni commit'ler var. Gonderebilmek icin once onlari cekmelisin. Veya kendi kodunu zorla yazabilirsin (ama uzaktaki commit'ler kaybolur).</div>
      <div class="git-op-actions">
        <button class="btn btn-primary" data-resolve="pull-then-push">Once uzaktakileri cek, sonra gonder</button>
        <button class="btn" style="background:var(--red-soft); color:var(--red);" data-resolve="force-push">Zorla gonder (uzaktaki commit'ler silinir)</button>
      </div>
    `;
  } else if (type === "auth-failed") {
    html = `
      <div class="git-op-hint">GitHub kimligin dogrulanmadi. Token'in suresi dolmus veya gecersiz olabilir. Ayarlar > GitHub Entegrasyonu bolumunden token'i yenile.</div>
    `;
  }

  if (html) {
    buttons.innerHTML = html;
    container.style.display = "";

    buttons.querySelectorAll("[data-resolve]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const resolveAction = btn.dataset.resolve;
        let newAction = resolveAction;
        if (resolveAction === "retry-pull") newAction = "pull";
        runGitOp(currentProject, newAction, { previousAction: currentAction });
      });
    });
  } else {
    container.style.display = "none";
  }
}

function actionTitle(action) {
  const titles = {
    pull: "Git Pull",
    push: "Git Push",
    fetch: "Git Fetch",
    stash: "Git Stash",
    "stash-pop": "Stash Pop",
    commit: "Git Commit",
    "reset-hard": "Hard Reset",
    "stash-pull": "Stash + Pull + Pop",
    "discard-pull": "Discard + Pull",
    "pull-then-push": "Pull then Push",
    "force-push": "Force Push",
    checkout: "Checkout",
    "create-branch": "Yeni Branch"
  };
  return titles[action] || action;
}

export async function runGitOp(project, action, options = {}) {
  currentProject = project;
  currentAction = action;
  const title = `${actionTitle(action)} — ${project}`;
  const subtitle = options.subtitle || "";

  openModal(title, subtitle);

  try {
    const body = { action };
    if (options.message) body.message = options.message;
    if (options.branch) body.branch = options.branch;

    const result = await api(`/api/git/${encodeURIComponent(project)}/exec`, {
      method: "POST",
      body
    });

    renderOutput(result);
    if (result.conflict) {
      renderConflict(result);
    }
  } catch (e) {
    const out = document.getElementById("gitOpOutput");
    out.innerHTML = `<span class="git-op-status fail">HATA</span><div class="git-op-stderr">${escapeHtml(e.message)}</div>`;
  }
}

// Shortcut helpers for common operations
export async function promptAndCommit(project) {
  const message = prompt("Commit mesaji:");
  if (!message || !message.trim()) return;
  await runGitOp(project, "commit", { message: message.trim() });
}

export async function promptAndCheckout(project) {
  const branch = prompt("Hangi branch'e gecmek istersin?");
  if (!branch || !branch.trim()) return;
  await runGitOp(project, "checkout", { branch: branch.trim() });
}

export async function promptAndCreateBranch(project) {
  const branch = prompt("Yeni branch adi:");
  if (!branch || !branch.trim()) return;
  await runGitOp(project, "create-branch", { branch: branch.trim() });
}

export async function confirmAndResetHard(project) {
  if (
    !confirm(`${project}: TUM yerel degisiklikler silinecek (git reset --hard HEAD). Emin misin?`)
  )
    return;
  await runGitOp(project, "reset-hard");
}
