import { api, toast, events, escapeHtml } from "./app.js";
import { runGitOp, promptAndCommit, promptAndCheckout, promptAndCreateBranch, confirmAndResetHard } from "./git-ops.js";

let currentProject = null;
let projects = [];

async function loadProjectList() {
  try {
    projects = await api("/api/projects");
    const select = document.getElementById("gitProjectSelect");
    select.innerHTML = '<option value="">Proje sec...</option>' +
      projects.map(p => '<option value="' + escapeHtml(p.name) + '"' + (p.name === currentProject ? " selected" : "") + ">" + escapeHtml(p.name) + "</option>").join("");
  } catch (e) {}
}

async function loadGitData() {
  if (!currentProject) {
    document.getElementById("gitContent").innerHTML = '<div style="text-align:center; padding:40px; color:var(--text-muted);">Bir proje sec</div>';
    return;
  }

  try {
    const [status, log, diff] = await Promise.all([
      api("/api/git/" + currentProject + "/status"),
      api("/api/git/" + currentProject + "/log").catch(() => []),
      api("/api/git/" + currentProject + "/diff").catch(() => ({ unstaged: "", staged: "", files: [] }))
    ]);

    if (!status.isGit) {
      document.getElementById("gitContent").innerHTML = '<div style="text-align:center; padding:40px; color:var(--text-muted);">Bu proje bir git deposu degil</div>';
      return;
    }

    renderGitDashboard(status, log, diff);
  } catch (e) {
    toast(e.message, "error");
  }
}

function renderGitDashboard(status, log, diff) {
  const container = document.getElementById("gitContent");

  // Branch adi, commit mesajlari ve dosya yollari klonlanmis repo'dan gelir;
  // yani tamamen ucuncu taraf kontrolunde. Hepsi escapeHtml'den gecer.

  // Status header
  let html = '<div class="git-header">';
  html += '<div style="display:flex; align-items:center; gap:12px;">';
  html += '<span style="font-family:var(--mono); font-size:14px; font-weight:600; color:var(--accent);">' + escapeHtml(status.branch) + "</span>";
  if (status.ahead || status.behind) {
    html += '<span style="font-size:12px; color:var(--text-muted);">';
    if (status.ahead) html += '<span style="color:var(--green);">&uarr;' + status.ahead + "</span> ";
    if (status.behind) html += '<span style="color:var(--orange);">&darr;' + status.behind + "</span>";
    html += "</span>";
  }
  html += "</div>";
  html += '<div style="display:flex; gap:12px; font-size:12px; color:var(--text-muted);">';
  if (status.staged) html += '<span style="color:var(--green);">' + status.staged + " staged</span>";
  if (status.unstaged) html += '<span style="color:var(--orange);">' + status.unstaged + " unstaged</span>";
  if (status.untracked) html += '<span style="color:var(--text-muted);">' + status.untracked + " untracked</span>";
  html += "</div>";
  if (status.lastCommit) {
    html += '<div style="margin-left:auto; font-size:12px; color:var(--text-muted);">Son: ' + escapeHtml(status.lastCommit.message) + "</div>";
  }
  html += '<div style="margin-left:auto; display:flex; gap:6px; flex-wrap:wrap;">';
  html += '<button class="btn btn-sm" data-git-action="fetch">Fetch</button>';
  html += '<button class="btn btn-sm" data-git-action="pull">Pull</button>';
  html += '<button class="btn btn-sm" data-git-action="push">Push</button>';
  html += '<button class="btn btn-sm" data-git-action="commit">Commit</button>';
  html += '<button class="btn btn-sm" data-git-action="stash">Stash</button>';
  html += '<button class="btn btn-sm" data-git-action="stash-pop">Pop</button>';
  html += '<button class="btn btn-sm" data-git-action="checkout">Checkout</button>';
  html += '<button class="btn btn-sm" data-git-action="create-branch">Yeni Branch</button>';
  html += '<button class="btn btn-sm" data-git-action="reset-hard" style="color:var(--red);">Reset</button>';
  html += "</div>";
  html += "</div>";

  // Two-column layout: files + log
  html += '<div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">';

  // Changed files
  html += '<div>';
  html += '<div class="section-label">Degisiklikler (' + diff.files.length + ")</div>";
  html += '<div class="log-list">';
  if (diff.files.length === 0) {
    html += '<div style="padding:16px; text-align:center; color:var(--text-muted); font-size:12px;">Degisiklik yok</div>';
  } else {
    for (const f of diff.files) {
      const statusColor = f.status.includes("M") ? "var(--orange)" : f.status.includes("A") ? "var(--green)" : f.status === "D" ? "var(--red)" : f.status === "?" ? "var(--text-muted)" : "var(--text)";
      html += '<div class="log-entry"><span style="color:' + statusColor + '; min-width:24px; font-weight:600;">' + escapeHtml(f.status) + '</span><span class="log-msg">' + escapeHtml(f.file) + "</span></div>";
    }
  }
  html += "</div></div>";

  // Commit log
  html += '<div>';
  html += '<div class="section-label">Gecmis</div>';
  html += '<div class="log-list">';
  if (Array.isArray(log) && log.length) {
    for (const c of log) {
      if (c.hash) {
        html += '<div class="log-entry">';
        if (c.graph) html += '<span class="log-graph">' + escapeHtml(c.graph) + "</span>";
        html += '<span class="log-hash">' + escapeHtml(c.hash) + "</span>";
        html += '<span class="log-msg">' + escapeHtml(c.message) + "</span>";
        html += '<span class="log-date">' + escapeHtml(c.date ? c.date.split(" ")[0] : "") + "</span>";
        html += "</div>";
      }
    }
  } else {
    html += '<div style="padding:16px; text-align:center; color:var(--text-muted); font-size:12px;">Commit yok</div>';
  }
  html += "</div></div>";

  html += "</div>"; // close grid

  // Diff view
  const hasDiff = diff.unstaged || diff.staged;
  if (hasDiff) {
    html += '<div class="diff-view" style="margin-top:16px;">';
    if (diff.staged) {
      html += '<div class="diff-header">Staged Degisiklikler</div>';
      html += '<div class="diff-content">' + renderDiff(diff.staged) + "</div>";
    }
    if (diff.unstaged) {
      html += '<div class="diff-header">Unstaged Degisiklikler</div>';
      html += '<div class="diff-content">' + renderDiff(diff.unstaged) + "</div>";
    }
    html += "</div>";
  }

  container.innerHTML = html;

  // Unified git action button handler
  container.querySelectorAll("[data-git-action]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const action = btn.dataset.gitAction;
      if (action === "commit") {
        await promptAndCommit(currentProject);
      } else if (action === "checkout") {
        await promptAndCheckout(currentProject);
      } else if (action === "create-branch") {
        await promptAndCreateBranch(currentProject);
      } else if (action === "reset-hard") {
        await confirmAndResetHard(currentProject);
      } else {
        await runGitOp(currentProject, action);
      }
      // Refresh git tab data after operation completes
      setTimeout(() => loadGitData(), 500);
    });
  });
}

function renderDiff(diffText) {
  if (!diffText) return "";
  return diffText.split("\n").map(line => {
    const escaped = escapeHtml(line);
    if (line.startsWith("+") && !line.startsWith("+++")) {
      return '<div class="diff-line add">' + escaped + "</div>";
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      return '<div class="diff-line del">' + escaped + "</div>";
    } else if (line.startsWith("@@")) {
      return '<div class="diff-line hunk">' + escaped + "</div>";
    }
    return '<div class="diff-line">' + escaped + "</div>";
  }).join("");
}

// Update git tab badge
async function updateBadge() {
  let totalChanges = 0;
  try {
    const projects = await api("/api/projects");
    for (const p of projects.slice(0, 10)) { // limit to first 10 for performance
      try {
        const git = await api("/api/projects/" + p.name + "/git");
        if (git.isGit && git.changes) totalChanges += git.changes;
      } catch (e) {}
    }
  } catch (e) {}

  const badge = document.getElementById("gitBadge");
  if (badge) {
    badge.textContent = totalChanges;
    badge.style.display = totalChanges > 0 ? "" : "none";
  }
}

export function init() {
  const select = document.getElementById("gitProjectSelect");
  select.addEventListener("change", () => {
    currentProject = select.value || null;
    loadGitData();
  });

  // Listen for project selection from other tabs
  events.on("project:select", (data) => {
    if (data.tab === "git") {
      currentProject = data.project;
      loadProjectList();
      loadGitData();
    }
  });
}

export function activate() {
  loadProjectList();
  if (currentProject) {
    loadGitData();
  }
  updateBadge();
}
