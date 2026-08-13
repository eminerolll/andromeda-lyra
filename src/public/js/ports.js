import { api, toast, devPreviewUrl, serviceUrl, servicePort, escapeHtml } from "./app.js";

let ws = null;
let portData = { user: [], system: [] };

function connectWs() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(proto + "//" + location.host + "/ws/ports");

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.event === "update") {
        portData = { user: msg.user, system: msg.system };
        render();
        updateBadge();
      }
    } catch (err) {}
  };

  ws.onclose = () => {
    setTimeout(connectWs, 5000);
  };
}

function updateBadge() {
  const badge = document.getElementById("portsBadge");
  if (badge) {
    const count = portData.user.length;
    badge.textContent = count;
    badge.style.display = count > 0 ? "" : "none";
  }
}

function render() {
  const container = document.getElementById("portsContent");
  if (!container) return;

  let html = "";

  // User ports
  html += '<div class="section-label" style="margin-bottom:12px;">Aktif Portlar (' + portData.user.length + ")</div>";

  if (portData.user.length === 0) {
    html += '<div style="text-align:center; padding:30px; color:var(--text-muted); font-size:13px;">Aktif dev server yok</div>';
  } else {
    html += '<table class="ports-table"><thead><tr><th>Port</th><th>Proses</th><th>Proje</th><th>RAM</th><th>Uptime</th><th></th></tr></thead><tbody>';
    // process/project alanlari `ss -tlnp` ciktisindan gelir: host'ta calisan
    // herhangi bir proses (ornegin klonlanmis bir repo'nun dev server'i)
    // kendi adini secebilir, o yuzden escape sart.
    for (const p of portData.user) {
      // Domain yoksa da calisir: path-tabanli /dev/{port}/ fallback'i var
      const url = escapeHtml(devPreviewUrl(p.port) + "/");
      html += "<tr>";
      html += '<td><a class="port-link" href="' + url + '" target="_blank">' + escapeHtml(p.port) + "</a></td>";
      html += "<td>" + escapeHtml(p.process || "?") + "</td>";
      html += "<td>" + (p.project ? escapeHtml(p.project) : '<span style="color:var(--text-muted)">-</span>') + "</td>";
      html += "<td>" + escapeHtml(p.memory || "?") + "</td>";
      html += "<td>" + escapeHtml(p.uptime || "?") + "</td>";
      html += '<td style="text-align:right;">';
      html += '<a href="' + url + '" target="_blank" class="btn btn-sm" style="margin-right:4px;">Ac</a>';
      html += '<button class="btn btn-sm" style="color:var(--red);" data-kill-port="' + escapeHtml(p.port) + '">Durdur</button>';
      html += "</td></tr>";
    }
    html += "</tbody></table>";
  }

  // System ports
  html += '<div class="section-label" style="margin-top:24px; margin-bottom:12px;">Sistem</div>';
  html += '<table class="ports-table"><thead><tr><th>Port</th><th>Proses</th><th>RAM</th><th></th></tr></thead><tbody>';
  const codePort = servicePort("code");
  for (const p of portData.system) {
    html += "<tr>";
    html += "<td>" + escapeHtml(p.port) + "</td>";
    html += "<td>" + escapeHtml(p.process || "?") + "</td>";
    html += "<td>" + escapeHtml(p.memory || "?") + "</td>";
    html += '<td style="text-align:right;">';
    if (codePort && p.port === codePort) {
      html += '<a href="' + escapeHtml(serviceUrl("code") + "/") + '" target="_blank" class="btn btn-sm">Ac</a>';
    }
    html += "</td></tr>";
  }
  html += "</tbody></table>";

  container.innerHTML = html;

  // Kill button handlers
  container.querySelectorAll("[data-kill-port]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const port = btn.dataset.killPort;
      if (!confirm(port + " portundaki prosesi durdurmak istedigine emin misin?")) return;
      try {
        await api("/api/ports/" + port + "/kill", { method: "POST" });
        toast("Port " + port + " durduruldu");
      } catch (e) { toast(e.message, "error"); }
    });
  });
}

export function init() {
  connectWs();
}

export function activate() {
  render();
}
