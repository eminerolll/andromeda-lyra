import { api, toast, escapeHtml } from "./app.js";

const SAVE_DEBOUNCE_MS = 1000;

// Not icerigi <proje>/.notes.md dosyasindan okunur — yani klonlanmis bir
// repo bu dosyayi kendi icerigiyle gonderebilir. marked v12 ham HTML'i ve
// javascript: URL'lerini oldugu gibi gecirdiginden onizleme dogrudan
// innerHTML'e verilirse stored XSS olur. Asagidaki renderer override'lari
// bunu kapatir:
//   html  -> ham HTML hic render edilmez, metin olarak escape edilir
//   link/image -> yalnizca guvenli scheme'ler; digerleri duz metne duser
// (marked'da renderer override'i sadece `false` dondurdugunde varsayilana
//  duser; escapeHtml'in bos string dondurmesi bu yuzden sorun degil.)
const SAFE_URL_RE = /^(?:https?:|mailto:|#|\/|\.{1,2}\/)/i;
let markedConfigured = false;

function isSafeUrl(href) {
  return !!href && SAFE_URL_RE.test(String(href).trim());
}

export function configureMarked() {
  if (markedConfigured || typeof marked === "undefined") return;
  marked.use({
    renderer: {
      html(raw) { return escapeHtml(raw); },
      link(href, title, text) { return isSafeUrl(href) ? false : text; },
      image(href, title, text) { return isSafeUrl(href) ? false : escapeHtml(text); }
    }
  });
  markedConfigured = true;
}

let currentProject = null;
let saveTimer = null;
let pendingSave = null;
let modalEl = null;
let textareaEl = null;
let previewEl = null;
let statusEl = null;
let titleEl = null;

function ensureRefs() {
  if (!modalEl) modalEl = document.getElementById("modalNotes");
  if (!textareaEl) textareaEl = document.getElementById("notesTextarea");
  if (!previewEl) previewEl = document.getElementById("notesPreview");
  if (!statusEl) statusEl = document.getElementById("notesStatus");
  if (!titleEl) titleEl = document.getElementById("notesTitle");
}

function setStatus(text, color) {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.style.color = color || "";
}

function renderPreview(text) {
  if (!previewEl) return;
  if (typeof marked === "undefined") {
    previewEl.textContent = text;
    return;
  }
  configureMarked();
  try {
    previewEl.innerHTML = marked.parse(text || "");
  } catch (e) {
    previewEl.textContent = text;
  }
}

async function flushSave() {
  if (!pendingSave) return;
  const { project, content } = pendingSave;
  pendingSave = null;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    await api("/api/notes/" + encodeURIComponent(project), {
      method: "PUT",
      body: { content }
    });
    setStatus("Kaydedildi", "var(--green)");
  } catch (e) {
    setStatus("Kaydedilemedi: " + e.message, "var(--red)");
  }
}

function scheduleSave(project, content) {
  pendingSave = { project, content };
  setStatus("Yaziliyor...", "var(--orange)");
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
}

function handleInput(e) {
  const value = e.target.value;
  renderPreview(value);
  if (currentProject) scheduleSave(currentProject, value);
}

export async function openNotes(projectName) {
  ensureRefs();
  if (!modalEl) return;

  currentProject = projectName;
  titleEl.textContent = "Notlar - " + projectName;
  setStatus("", "");
  textareaEl.value = "";
  previewEl.innerHTML = "";

  modalEl.classList.add("active");

  try {
    const data = await api("/api/notes/" + encodeURIComponent(projectName));
    textareaEl.value = data.content || "";
    renderPreview(textareaEl.value);
    setTimeout(() => textareaEl.focus(), 50);
  } catch (e) {
    toast(e.message, "error");
  }
}

export async function closeNotes() {
  if (pendingSave) {
    await flushSave();
  }
  if (modalEl) modalEl.classList.remove("active");
  currentProject = null;
}

export function init() {
  ensureRefs();
  if (textareaEl) {
    textareaEl.addEventListener("input", handleInput);
  }
  const closeBtn = document.getElementById("notesCloseBtn");
  if (closeBtn) {
    closeBtn.addEventListener("click", closeNotes);
  }
  if (modalEl) {
    modalEl.addEventListener("click", (e) => {
      if (e.target === modalEl) closeNotes();
    });
  }
}

export function activate() {}
