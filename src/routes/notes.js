// Proje basi .notes.md dosyasi (markdown notlar).

const express = require("express");
const fs = require("fs");
const path = require("path");
const config = require("../lib/config");

const router = express.Router();

const MAX_NOTE_SIZE = 1024 * 1024;
const PROJECT_NAME_RE = /^[a-zA-Z0-9_.-]+$/;

function isValidProjectName(name) {
  if (!name || typeof name !== "string") return false;
  if (name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\")) return false;
  return PROJECT_NAME_RE.test(name);
}

function notePath(projectName) {
  return path.join(config.get("projects_dir"), projectName, ".notes.md");
}

function projectExists(projectName) {
  return fs.existsSync(path.join(config.get("projects_dir"), projectName));
}

router.get("/api/notes/:project", (req, res) => {
  const projectName = req.params.project;
  if (!isValidProjectName(projectName)) return res.status(400).json({ error: "Gecersiz proje adi" });
  if (!projectExists(projectName)) return res.status(404).json({ error: "Proje bulunamadi" });
  const p = notePath(projectName);
  if (!fs.existsSync(p)) return res.json({ content: "" });
  try {
    res.json({ content: fs.readFileSync(p, "utf8") });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/api/notes/:project", (req, res) => {
  const projectName = req.params.project;
  if (!isValidProjectName(projectName)) return res.status(400).json({ error: "Gecersiz proje adi" });
  if (!projectExists(projectName)) return res.status(404).json({ error: "Proje bulunamadi" });
  const { content } = req.body || {};
  if (typeof content !== "string") return res.status(400).json({ error: "content string olmali" });
  if (Buffer.byteLength(content, "utf8") > MAX_NOTE_SIZE) return res.status(413).json({ error: "Not cok buyuk (max 1MB)" });
  try {
    fs.writeFileSync(notePath(projectName), content, "utf8");
    res.json({ success: true, size: Buffer.byteLength(content, "utf8") });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
