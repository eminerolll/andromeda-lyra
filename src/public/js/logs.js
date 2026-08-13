import { api, toast, escapeHtml } from "./app.js";

const MAX_LINES = 2000;
const PAUSE_QUEUE_LIMIT = 500;
const RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY = 2000;

let sources = [];
let activeSource = null;
let ws = null;
let reconnectAttempts = 0;
let paused = false;
let pauseQueue = [];
let levelFilter = "all";
let searchText = "";
let searchDebounce = null;
let autoScroll = true;
let lineCount = 0;

function detectLevel(text) {
  if (/\b(error|ERR|ERROR|fatal|FATAL)\b/.test(text)) return "error";
  if (/\b(warn|WARN|WARNING|warning)\b/.test(text)) return "warn";
  if (/\b(debug|DEBUG|trace)\b/.test(text)) return "debug";
  return "info";
}

function lineMatchesFilters(level, text) {
  if (levelFilter !== "all" && level !== levelFilter) return false;
  if (searchText && !text.toLowerCase().includes(searchText)) return false;
  return true;
}

function appendLine(text) {
  const view = document.getElementById("logsView");
  if (!view) return;

  const level = detectLevel(text);
  const el = document.createElement("div");
  el.className = "log-line log-" + level;
  el.dataset.level = level;
  el.dataset.text = text.toLowerCase();
  el.innerHTML = escapeHtml(text);

  if (!lineMatchesFilters(level, text)) {
    el.classList.add("hidden");
  }

  view.appendChild(el);
  lineCount++;

  while (lineCount > MAX_LINES) {
    const first = view.firstElementChild;
    if (!first) break;
    view.removeChild(first);
    lineCount--;
  }

  if (autoScroll) {
    view.scrollTop = view.scrollHeight;
  }
}

function handleLine(text) {
  if (paused) {
    pauseQueue.push(text);
    if (pauseQueue.length > PAUSE_QUEUE_LIMIT) pauseQueue.shift();
    updatePauseIndicator();
    return;
  }
  appendLine(text);
}

function updatePauseIndicator() {
  const btn = document.getElementById("logsPauseBtn");
  if (!btn) return;
  if (paused) {
    btn.textContent = "Resume (" + pauseQueue.length + ")";
    btn.classList.add("active");
  } else {
    btn.textContent = "Pause";
    btn.classList.remove("active");
  }
}

function clearView() {
  const view = document.getElementById("logsView");
  if (view) view.innerHTML = "";
  lineCount = 0;
  pauseQueue = [];
  updatePauseIndicator();
}

function applyFilters() {
  const view = document.getElementById("logsView");
  if (!view) return;
  for (const el of view.children) {
    const level = el.dataset.level;
    const text = el.dataset.text || "";
    if (lineMatchesFilters(level, text)) {
      el.classList.remove("hidden");
    } else {
      el.classList.add("hidden");
    }
  }
  if (autoScroll) view.scrollTop = view.scrollHeight;
}

function getWsUrl(source) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return proto + "//" + location.host + "/ws/logs?source=" + encodeURIComponent(source);
}

function connect(source) {
  if (ws) {
    try { ws.close(); } catch (e) {}
    ws = null;
  }

  clearView();
  activeSource = source;
  reconnectAttempts = 0;

  openWebSocket(source);
}

function openWebSocket(source) {
  ws = new WebSocket(getWsUrl(source));

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === "line") {
        handleLine(msg.text);
      } else if (msg.type === "error") {
        appendLine("[HATA] " + msg.message);
      } else if (msg.type === "closed") {
        appendLine("[Stream kapandi, exit " + msg.code + "]");
      }
    } catch (err) {}
  };

  ws.onclose = () => {
    if (activeSource !== source) return;
    if (reconnectAttempts < RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      appendLine("[Yeniden baglaniliyor... " + reconnectAttempts + "/" + RECONNECT_ATTEMPTS + "]");
      setTimeout(() => {
        if (activeSource === source) openWebSocket(source);
      }, RECONNECT_DELAY);
    } else {
      appendLine("[Baglanti kesildi]");
    }
  };

  ws.onerror = () => {};
}

async function loadSources() {
  try {
    sources = await api("/api/logs/sources");
    renderSources();

    if (sources.length > 0 && !activeSource) {
      selectSource(sources[0].name);
    } else if (sources.length === 0) {
      const container = document.getElementById("logsView");
      if (container) container.innerHTML = '<div style="padding:20px; text-align:center; color:var(--text-muted);">Sistemde log okunabilecek servis bulunamadi</div>';
    }
  } catch (e) {
    toast(e.message, "error");
  }
}

function renderSources() {
  const container = document.getElementById("logsSources");
  if (!container) return;
  const items = sources.map(s => {
    const dotClass = s.status === "active" ? "active" : s.status === "failed" ? "failed" : s.status === "activating" ? "activating" : "inactive";
    const activeCls = s.name === activeSource ? " active" : "";
    // unit adi / aciklama DB'den (servis tablosu) gelir ve tirnakli
    // nitelik icine yazilir — escape sart.
    return '<div class="logs-source' + activeCls + '" data-source="' + escapeHtml(s.name) + '" title="' + escapeHtml(s.description) + ' (' + escapeHtml(s.status) + ')">' +
      '<span class="logs-source-dot ' + dotClass + '"></span>' +
      '<span>' + escapeHtml(s.name) + '</span>' +
      '</div>';
  }).join("");
  container.innerHTML = '<div class="logs-sources-title">Kaynaklar</div>' + items;

  container.querySelectorAll("[data-source]").forEach(el => {
    el.addEventListener("click", () => selectSource(el.dataset.source));
  });
}

function selectSource(name) {
  if (activeSource === name) return;
  activeSource = name;
  renderSources();
  connect(name);
}

function setupToolbar() {
  const searchInput = document.getElementById("logsSearch");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        searchText = searchInput.value.toLowerCase();
        applyFilters();
      }, 300);
    });
  }

  document.querySelectorAll(".logs-filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".logs-filter-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      levelFilter = btn.dataset.level;
      applyFilters();
    });
  });

  const pauseBtn = document.getElementById("logsPauseBtn");
  if (pauseBtn) {
    pauseBtn.addEventListener("click", () => {
      paused = !paused;
      if (!paused && pauseQueue.length > 0) {
        const queue = pauseQueue.slice();
        pauseQueue = [];
        for (const line of queue) appendLine(line);
      }
      updatePauseIndicator();
    });
  }

  const clearBtn = document.getElementById("logsClearBtn");
  if (clearBtn) {
    clearBtn.addEventListener("click", clearView);
  }

  const view = document.getElementById("logsView");
  if (view) {
    view.addEventListener("scroll", () => {
      const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 50;
      autoScroll = atBottom;
      const autoBtn = document.getElementById("logsAutoscrollBtn");
      if (autoBtn) autoBtn.style.display = autoScroll ? "none" : "";
    });
  }

  const autoBtn = document.getElementById("logsAutoscrollBtn");
  if (autoBtn) {
    autoBtn.addEventListener("click", () => {
      autoScroll = true;
      if (view) view.scrollTop = view.scrollHeight;
      autoBtn.style.display = "none";
    });
  }
}

export function init() {
  setupToolbar();
}

export function activate() {
  loadSources();
}
