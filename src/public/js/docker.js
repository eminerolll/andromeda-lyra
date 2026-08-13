import { api, toast, escapeHtml } from "./app.js";

let projects = [];
let containers = [];
let ingress = [];
let health = {};
let refreshTimer = null;

async function loadAll() {
  try {
    const [pData, cData, iData] = await Promise.all([
      api("/api/docker/projects"),
      api("/api/docker/containers"),
      api("/api/cf/ingress").catch(() => ({ entries: [] }))
    ]);
    projects = pData.projects || [];
    containers = cData.containers || [];
    ingress = (iData.entries || []).filter((e) => e.hostname && !e.isCatchAll && !e.isWildcard);
    render();
    loadHealth();
  } catch (e) {
    const container = document.getElementById("dockerContent");
    if (container)
      container.innerHTML =
        '<div style="text-align:center; padding:40px; color:var(--red);">Docker yuklenemedi: ' +
        escapeHtml(e.message) +
        "</div>";
  }
}

async function loadHealth() {
  try {
    const h = await api("/api/cf/health");
    health = h.health || {};
    document.querySelectorAll("[data-dock-health]").forEach((el) => {
      const host = el.dataset.dockHealth;
      const hs = health[host];
      if (!hs) {
        el.style.color = "var(--text-muted)";
        return;
      }
      el.style.color =
        hs.level === "green"
          ? "var(--green, #4ade80)"
          : hs.level === "yellow"
            ? "var(--yellow, #fbbf24)"
            : "var(--red, #f87171)";
      el.title = hs.code ? hs.code + " (" + (hs.latency || "?") + "ms)" : hs.reason || "";
    });
  } catch (e) {}
}

// Extract bound host port from docker ports string like "127.0.0.1:8090->80/tcp, 3500/tcp"
function extractBoundPorts(portsStr) {
  if (!portsStr) return [];
  const ports = [];
  const re = /(?:\d+\.\d+\.\d+\.\d+:|\[?[0-9a-f:]+\]?:)?(\d+)->\d+\/tcp/gi;
  let m;
  while ((m = re.exec(portsStr)) !== null) ports.push(parseInt(m[1]));
  return ports;
}

function ingressForProject(project) {
  const ports = new Set();
  for (const c of project.containers || []) {
    for (const p of extractBoundPorts(c.ports)) ports.add(p);
  }
  return ingress.filter((e) => {
    const m = e.service && e.service.match(/:(\d+)/);
    return m && ports.has(parseInt(m[1]));
  });
}

function stateColor(state) {
  if (state === "running") return "var(--green, #4ade80)";
  if (state === "exited" || state === "dead") return "var(--red, #f87171)";
  if (state === "paused") return "var(--yellow, #fbbf24)";
  return "var(--text-muted)";
}

function render() {
  const container = document.getElementById("dockerContent");
  if (!container) return;

  let html = "";

  // Prod projects section
  html +=
    '<div class="section-label" style="margin-bottom:12px;">Prod Projeleri (' +
    projects.length +
    ")</div>";

  if (projects.length === 0) {
    html +=
      '<div style="text-align:center; padding:30px; color:var(--text-muted); font-size:13px;">/opt/prod-apps altinda proje yok</div>';
  } else {
    html += '<div class="projects-grid" style="margin-bottom:24px;">';
    for (const p of projects) {
      const running = p.containers.filter((c) => c.state === "running").length;
      const total = p.containers.length;
      const statusBadge =
        total === 0
          ? '<span style="color:var(--text-muted); font-size:12px;">Ayakta degil</span>'
          : '<span style="color:' +
            stateColor(running > 0 ? "running" : "exited") +
            '; font-size:12px;">' +
            running +
            "/" +
            total +
            " calisiyor</span>";

      html += '<div class="side-card" style="padding:16px;">';
      html +=
        '<div style="display:flex; justify-content:space-between; align-items:start; margin-bottom:8px;">';
      html += '<div style="font-weight:600; font-size:14px;">' + escapeHtml(p.name) + "</div>";
      html += statusBadge;
      html += "</div>";

      html += '<div style="font-size:11px; color:var(--text-muted); margin-bottom:12px;">';
      if (p.hasCompose)
        html +=
          '<span style="margin-right:8px;">✓ ' + escapeHtml(p.composeFile || "compose") + "</span>";
      if (p.hasDockerfile) html += "<span>✓ Dockerfile</span>";
      if (!p.hasCompose && !p.hasDockerfile)
        html += '<span style="color:var(--yellow, #fbbf24)">⚠ compose/Dockerfile yok</span>';
      html += "</div>";

      const tunnels = ingressForProject(p);
      if (tunnels.length) {
        html += '<div style="font-size:12px; margin-bottom:12px;">';
        for (const t of tunnels) {
          html += '<div style="display:flex; align-items:center; gap:6px; padding:2px 0;">';
          html +=
            '<span data-dock-health="' +
            escapeHtml(t.hostname) +
            '" style="color:var(--text-muted);" title="kontrol ediliyor">●</span>';
          html +=
            '<a href="https://' +
            escapeHtml(t.hostname) +
            '" target="_blank" style="color:var(--accent, #60a5fa); text-decoration:none;">' +
            escapeHtml(t.hostname) +
            "</a>";
          html += "</div>";
        }
        html += "</div>";
      }

      if (p.containers.length > 0) {
        html += '<div style="font-size:12px; margin-bottom:12px;">';
        for (const c of p.containers) {
          html +=
            '<div style="display:flex; justify-content:space-between; padding:4px 0; border-top:1px solid var(--border);">';
          html += '<span style="color:' + stateColor(c.state) + ';">●</span> ';
          html +=
            '<span style="flex:1; margin-left:6px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' +
            escapeHtml(c.name) +
            "</span>";
          html +=
            '<span style="color:var(--text-muted); font-size:11px;">' +
            escapeHtml(c.status) +
            "</span>";
          html += "</div>";
        }
        html += "</div>";
      }

      if (p.hasCompose) {
        const anyRunning = running > 0;
        html += '<div style="display:flex; gap:6px; flex-wrap:wrap;">';
        if (!anyRunning) {
          html +=
            '<button class="btn btn-sm btn-primary" data-compose="up" data-project="' +
            escapeHtml(p.name) +
            '">Baslat</button>';
          html +=
            '<button class="btn btn-sm" data-compose="build" data-project="' +
            escapeHtml(p.name) +
            '">Build</button>';
        } else {
          html +=
            '<button class="btn btn-sm" data-compose="restart" data-project="' +
            escapeHtml(p.name) +
            '">Restart</button>';
          html +=
            '<button class="btn btn-sm" data-compose="up" data-project="' +
            escapeHtml(p.name) +
            '" title="Rebuild & up">Yeniden Deploy</button>';
          html +=
            '<button class="btn btn-sm" data-compose="down" data-project="' +
            escapeHtml(p.name) +
            '" style="color:var(--red);">Durdur</button>';
        }
        html +=
          '<button class="btn btn-sm" data-compose-logs="' +
          escapeHtml(p.name) +
          '">Loglar</button>';
        html += "</div>";
      }

      html += "</div>";
    }
    html += "</div>";
  }

  // All containers section
  html +=
    '<div class="section-label" style="margin-bottom:12px; margin-top:24px;">Tum Container\'lar (' +
    containers.length +
    ")</div>";

  if (containers.length === 0) {
    html +=
      '<div style="text-align:center; padding:30px; color:var(--text-muted); font-size:13px;">Container yok</div>';
  } else {
    html +=
      '<table class="ports-table"><thead><tr><th>Ad</th><th>Image</th><th>Durum</th><th>Portlar</th><th>CPU</th><th>RAM</th><th></th></tr></thead><tbody>';
    for (const c of containers) {
      html += "<tr>";
      html +=
        '<td><span style="color:' +
        stateColor(c.state) +
        '; margin-right:6px;">●</span>' +
        escapeHtml(c.name) +
        "</td>";
      html += "<td>" + escapeHtml(c.image) + "</td>";
      html += "<td>" + escapeHtml(c.status) + "</td>";
      html += '<td style="font-size:11px;">' + escapeHtml(c.ports || "-") + "</td>";
      html += "<td>" + escapeHtml(c.stats ? c.stats.cpu : "-") + "</td>";
      html += "<td>" + escapeHtml(c.stats ? c.stats.mem : "-") + "</td>";
      html += '<td style="text-align:right; white-space:nowrap;">';
      if (c.state === "running") {
        html +=
          '<button class="btn btn-sm" data-container-action="restart" data-id="' +
          escapeHtml(c.id) +
          '" style="margin-right:4px;">Restart</button>';
        html +=
          '<button class="btn btn-sm" data-container-action="stop" data-id="' +
          escapeHtml(c.id) +
          '" style="color:var(--red); margin-right:4px;">Durdur</button>';
      } else {
        html +=
          '<button class="btn btn-sm btn-primary" data-container-action="start" data-id="' +
          escapeHtml(c.id) +
          '" style="margin-right:4px;">Baslat</button>';
      }
      html +=
        '<button class="btn btn-sm" data-container-logs="' +
        escapeHtml(c.id) +
        '" data-name="' +
        escapeHtml(c.name) +
        '">Log</button>';
      html += "</td></tr>";
    }
    html += "</tbody></table>";
  }

  container.innerHTML = html;
  attachHandlers(container);
}

function attachHandlers(root) {
  root.querySelectorAll("[data-container-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const action = btn.dataset.containerAction;
      const id = btn.dataset.id;
      btn.disabled = true;
      try {
        await api("/api/docker/container/" + id + "/" + action, { method: "POST" });
        toast("Container " + action);
        loadAll();
      } catch (e) {
        toast(e.message, "error");
      } finally {
        btn.disabled = false;
      }
    });
  });

  root.querySelectorAll("[data-compose]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const action = btn.dataset.compose;
      const project = btn.dataset.project;
      if (action === "down" && !confirm(project + " projesini durdur?")) return;
      btn.disabled = true;
      btn.textContent = "...";
      try {
        const r = await api("/api/docker/project/" + project + "/" + action, { method: "POST" });
        toast(project + " " + action + " tamam");
        if (r.output) showOutput(project + " / " + action, r.output);
        loadAll();
      } catch (e) {
        toast(e.message, "error");
      } finally {
        btn.disabled = false;
        render();
      }
    });
  });

  root.querySelectorAll("[data-compose-logs]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const project = btn.dataset.composeLogs;
      try {
        const r = await api("/api/docker/project/" + project + "/logs?tail=300");
        showOutput(project + " logs", r.logs);
      } catch (e) {
        toast(e.message, "error");
      }
    });
  });

  root.querySelectorAll("[data-container-logs]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.containerLogs;
      const name = btn.dataset.name;
      try {
        const r = await api("/api/docker/container/" + id + "/logs?tail=300");
        showOutput(name + " logs", r.logs);
      } catch (e) {
        toast(e.message, "error");
      }
    });
  });
}

function showOutput(title, text) {
  let modal = document.getElementById("dockerOutputModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "dockerOutputModal";
    modal.className = "modal-overlay";
    modal.innerHTML =
      '<div class="modal wide">' +
      '<div class="modal-title" id="dockerOutputTitle"></div>' +
      '<pre id="dockerOutputBody" style="max-height:60vh; overflow:auto; background:var(--bg-darker, #0f1115); padding:12px; border-radius:6px; font-size:12px; font-family:JetBrains Mono, monospace; white-space:pre-wrap; word-break:break-all;"></pre>' +
      '<div class="modal-actions"><button class="btn" id="dockerOutputClose">Kapat</button></div>' +
      "</div>";
    document.body.appendChild(modal);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.classList.remove("active");
    });
    modal
      .querySelector("#dockerOutputClose")
      .addEventListener("click", () => modal.classList.remove("active"));
  }
  modal.querySelector("#dockerOutputTitle").textContent = title;
  modal.querySelector("#dockerOutputBody").textContent = text || "(bos)";
  modal.classList.add("active");
}

export function init() {
  loadAll();
  refreshTimer = setInterval(() => {
    const tab = document.getElementById("tab-docker");
    if (tab && tab.classList.contains("active")) loadAll();
  }, 10000);
}

export function activate() {
  loadAll();
}
