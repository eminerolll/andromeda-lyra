// .env dosya yonetimi. Global env settings'te, proje env'leri dosyada.

const express = require("express");
const fs = require("fs");
const path = require("path");
const config = require("../lib/config");
const { settings } = require("../db/repos");

const router = express.Router();

const PROJECT_NAME_RE = /^[a-zA-Z0-9_.-]+$/;
function isValidProjectName(name) {
  if (!name || typeof name !== "string") return false;
  if (name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\")) return false;
  return PROJECT_NAME_RE.test(name);
}

const ENV_FILE_RE = /^\.env(\..+)?$/;

const EXCLUDE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt",
  ".cache", ".turbo", ".parcel-cache", "coverage", ".venv", "venv",
  "__pycache__", ".pytest_cache", "vendor", ".idea", ".vscode"
]);

function findEnvFiles(rootDir, maxDepth = 4) {
  const results = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDE_DIRS.has(entry.name)) continue;
        walk(full, depth + 1);
      } else if (entry.isFile() && ENV_FILE_RE.test(entry.name)) {
        results.push(full);
      }
    }
  };
  walk(rootDir, 0);
  return results;
}

function parseEnvFile(content) {
  const entries = [];
  for (const line of content.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) {
      entries.push({ type: "comment", raw: line });
      continue;
    }
    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) {
      entries.push({ type: "comment", raw: line });
      continue;
    }
    const key = line.substring(0, eqIndex).trim();
    let value = line.substring(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    entries.push({ type: "var", key, value });
  }
  return entries;
}

function serializeEnvFile(entries) {
  return entries.map(e => e.type === "comment" ? e.raw : (e.key + "=" + e.value)).join("\n");
}

function resolveEnvFile(projDir, relPath) {
  if (typeof relPath !== "string" || !relPath) return null;
  const baseName = path.basename(relPath);
  if (!ENV_FILE_RE.test(baseName)) return null;
  const absPath = path.resolve(projDir, relPath);
  if (absPath !== projDir && !absPath.startsWith(projDir + path.sep)) return null;
  return absPath;
}

// Global env

router.get("/api/env/global", (req, res) => {
  const globalEnv = settings.get("global_env", {}) || {};
  const vars = Object.entries(globalEnv).map(([key, val]) => ({
    key, value: val.value, sensitive: !!val.sensitive
  }));
  res.json(vars);
});

router.put("/api/env/global", (req, res) => {
  const { vars } = req.body || {};
  if (!Array.isArray(vars)) return res.status(400).json({ error: "vars array gerekli" });
  const next = {};
  for (const v of vars) {
    if (v.key && v.key.trim()) {
      next[v.key.trim()] = { value: v.value || "", sensitive: !!v.sensitive };
    }
  }
  settings.set("global_env", next);
  res.json({ success: true });
});

// Project env

router.get("/api/env/project/:name", (req, res) => {
  if (!isValidProjectName(req.params.name)) return res.status(400).json({ error: "Gecersiz proje adi" });
  const projDir = path.join(config.get("projects_dir"), req.params.name);
  if (!fs.existsSync(projDir)) return res.status(404).json({ error: "Proje bulunamadi" });

  try {
    const envFiles = findEnvFiles(projDir);
    const result = envFiles.map(fullPath => {
      const relativePath = path.relative(projDir, fullPath).split(path.sep).join("/");
      let vars = [];
      try {
        const content = fs.readFileSync(fullPath, "utf8");
        vars = parseEnvFile(content).filter(e => e.type === "var").map(e => ({ key: e.key, value: e.value }));
      } catch (_) {}
      return { relativePath, vars };
    });
    result.sort((a, b) => {
      if (a.relativePath === ".env") return -1;
      if (b.relativePath === ".env") return 1;
      return a.relativePath.localeCompare(b.relativePath);
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/api/env/project/:name", (req, res) => {
  if (!isValidProjectName(req.params.name)) return res.status(400).json({ error: "Gecersiz proje adi" });
  const { filePath, vars } = req.body || {};
  if (!Array.isArray(vars)) return res.status(400).json({ error: "vars array gerekli" });
  if (typeof filePath !== "string" || !filePath) return res.status(400).json({ error: "filePath gerekli" });

  const projDir = path.join(config.get("projects_dir"), req.params.name);
  if (!fs.existsSync(projDir)) return res.status(404).json({ error: "Proje bulunamadi" });

  const absPath = resolveEnvFile(projDir, filePath);
  if (!absPath) return res.status(400).json({ error: "Gecersiz dosya yolu" });

  let entries = [];
  if (fs.existsSync(absPath)) entries = parseEnvFile(fs.readFileSync(absPath, "utf8"));

  const newVars = new Map(vars.map(v => [String(v.key || "").trim(), String(v.value || "")]));
  newVars.delete("");
  const seen = new Set();

  entries = entries.map(e => {
    if (e.type === "var" && newVars.has(e.key)) {
      seen.add(e.key);
      return { type: "var", key: e.key, value: newVars.get(e.key) };
    }
    if (e.type === "var" && !newVars.has(e.key)) return null;
    return e;
  }).filter(Boolean);

  for (const [key, value] of newVars) {
    if (!seen.has(key)) entries.push({ type: "var", key, value });
  }

  const parentDir = path.dirname(absPath);
  if (!fs.existsSync(parentDir)) {
    try { fs.mkdirSync(parentDir, { recursive: true }); } catch (_) {}
  }
  fs.writeFileSync(absPath, serializeEnvFile(entries) + "\n");
  res.json({ success: true });
});

router.delete("/api/env/project/:name", (req, res) => {
  if (!isValidProjectName(req.params.name)) return res.status(400).json({ error: "Gecersiz proje adi" });
  const { filePath } = req.body || {};
  if (typeof filePath !== "string" || !filePath) return res.status(400).json({ error: "filePath gerekli" });
  const projDir = path.join(config.get("projects_dir"), req.params.name);
  const absPath = resolveEnvFile(projDir, filePath);
  if (!absPath) return res.status(400).json({ error: "Gecersiz dosya yolu" });
  if (!fs.existsSync(absPath)) return res.status(404).json({ error: "Dosya bulunamadi" });
  try {
    fs.unlinkSync(absPath);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
