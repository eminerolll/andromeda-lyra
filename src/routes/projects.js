// Proje CRUD: list, create (template ile), clone (stream), delete, rename, pin.

const express = require("express");
const fs = require("fs");
const path = require("path");
const { execSync, execFileSync, spawn } = require("child_process");
const config = require("../lib/config");
const { settings } = require("../db/repos");

const router = express.Router();

function projectsDir() {
  return config.get("projects_dir");
}

const PROJECT_NAME_RE = /^[a-zA-Z0-9_.-]+$/;
function isValidProjectName(name) {
  if (!name || typeof name !== "string") return false;
  if (name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\")) return false;
  return PROJECT_NAME_RE.test(name);
}

function getPinnedSet() {
  const arr = settings.get("pinned_projects", []);
  return new Set(Array.isArray(arr) ? arr : []);
}

function setPinned(arr) {
  settings.set("pinned_projects", arr);
}

function parseGitProgress(line) {
  const match = line.match(/(\d+)%/);
  const percent = match ? parseInt(match[1]) : null;
  let phase = null;
  if (line.includes("Enumerating")) phase = "Nesneler sayiliyor";
  else if (line.includes("Counting")) phase = "Nesneler sayiliyor";
  else if (line.includes("Compressing")) phase = "Sikistiriliyor";
  else if (line.includes("Receiving")) phase = "Indiriliyor";
  else if (line.includes("Resolving")) phase = "Delta cozumleniyor";
  else if (line.includes("Cloning")) phase = "Baglaniyor";
  return { percent, phase, raw: line.trim() };
}

function streamClone(gitUrl, projectPath, repoName, req, res, branch) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (data) => res.write("data: " + JSON.stringify(data) + "\n\n");
  const branchInfo = branch ? " (" + branch + ")" : "";
  send({ phase: "Baglaniyor", percent: 0, raw: "git clone baslatiliyor..." + branchInfo });

  const args = ["clone", "--progress"];
  if (branch) args.push("--branch", branch);
  args.push(gitUrl, projectPath);
  const proc = spawn("git", args, { timeout: 300000 });

  proc.stderr.on("data", (chunk) => {
    const lines = chunk.toString().split(/[\r\n]+/).filter(Boolean);
    for (const line of lines) send(parseGitProgress(line));
  });

  proc.stdout.on("data", (chunk) => {
    send({ raw: chunk.toString().trim() });
  });

  proc.on("close", (code) => {
    send({ done: true, success: code === 0, name: repoName, path: projectPath, error: code !== 0 ? "Clone basarisiz (exit " + code + ")" : null });
    res.end();
  });

  proc.on("error", (err) => {
    send({ done: true, success: false, error: err.message });
    res.end();
  });

  req.on("close", () => { proc.kill(); });
}

router.get("/api/projects", (req, res) => {
  try {
    const dir = projectsDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const pinned = getPinnedSet();
    const items = fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => {
        const fullPath = path.join(dir, d.name);
        const stat = fs.statSync(fullPath);
        let type = "Bos";
        if (fs.existsSync(path.join(fullPath, "package.json"))) type = "Node.js";
        else if (fs.existsSync(path.join(fullPath, "requirements.txt"))) type = "Python";
        else if (fs.existsSync(path.join(fullPath, "Cargo.toml"))) type = "Rust";
        else if (fs.existsSync(path.join(fullPath, "go.mod"))) type = "Go";

        let branch = null;
        try {
          branch = execFileSync("git", ["-C", fullPath, "branch", "--show-current"], {
            stdio: ["pipe", "pipe", "ignore"]
          }).toString().trim();
        } catch (_) {}

        let size = "?";
        try {
          size = execFileSync("du", ["-sh", fullPath], {
            stdio: ["pipe", "pipe", "ignore"]
          }).toString().split("\t")[0];
        } catch (_) {}

        return {
          name: d.name, type, branch, size,
          modified: stat.mtime, path: fullPath,
          pinned: pinned.has(d.name)
        };
      })
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return new Date(b.modified) - new Date(a.modified);
      });
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/api/projects/:name/pin", (req, res) => {
  if (!isValidProjectName(req.params.name)) {
    return res.status(400).json({ error: "Gecersiz proje adi" });
  }
  const projectPath = path.join(projectsDir(), req.params.name);
  if (!fs.existsSync(projectPath)) {
    return res.status(404).json({ error: "Proje bulunamadi" });
  }
  const { pinned } = req.body || {};
  const current = settings.get("pinned_projects", []);
  let next;
  if (pinned) {
    next = current.includes(req.params.name) ? current : [...current, req.params.name];
  } else {
    next = current.filter(n => n !== req.params.name);
  }
  setPinned(next);
  res.json({ success: true, pinned: !!pinned });
});

router.post("/api/projects", (req, res) => {
  const { name, template } = req.body || {};
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    return res.status(400).json({ error: "Gecersiz proje adi. Sadece harf, rakam, - ve _" });
  }
  const projectPath = path.join(projectsDir(), name);
  if (fs.existsSync(projectPath)) {
    return res.status(409).json({ error: "Bu isimde proje zaten var." });
  }
  try {
    fs.mkdirSync(projectPath, { recursive: true });
    execSync("git init", { cwd: projectPath });
    if (template === "nodejs") {
      execSync("npm init -y", { cwd: projectPath });
    } else if (template === "python") {
      fs.writeFileSync(path.join(projectPath, "main.py"), "# " + name + "\n");
      fs.writeFileSync(path.join(projectPath, "requirements.txt"), "");
    } else if (template === "react") {
      execSync("npx create-react-app . --use-npm", { cwd: projectPath, timeout: 120000 });
    } else if (template === "nextjs") {
      execSync("npx create-next-app . --use-npm --yes", { cwd: projectPath, timeout: 120000 });
    }
    res.json({ success: true, name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/clone", (req, res) => {
  const { url, name } = req.body || {};
  if (!url) return res.status(400).json({ error: "URL gerekli" });
  const repoName = name || url.split("/").pop().replace(".git", "");
  const projectPath = path.join(projectsDir(), repoName);
  if (fs.existsSync(projectPath)) {
    return res.status(409).json({ error: "Bu isimde klasor zaten var." });
  }
  streamClone(url, projectPath, repoName, req, res);
});

router.delete("/api/projects/:name", (req, res) => {
  if (!isValidProjectName(req.params.name)) {
    return res.status(400).json({ error: "Gecersiz proje adi" });
  }
  const projectPath = path.join(projectsDir(), req.params.name);
  if (!fs.existsSync(projectPath)) {
    return res.status(404).json({ error: "Proje bulunamadi" });
  }
  try {
    fs.rmSync(projectPath, { recursive: true, force: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/api/projects/:name", (req, res) => {
  if (!isValidProjectName(req.params.name)) {
    return res.status(400).json({ error: "Gecersiz proje adi" });
  }
  const { newName } = req.body || {};
  if (!isValidProjectName(newName)) {
    return res.status(400).json({ error: "Gecersiz yeni isim" });
  }
  const dir = projectsDir();
  const oldPath = path.join(dir, req.params.name);
  const newPath = path.join(dir, newName);
  if (!fs.existsSync(oldPath)) return res.status(404).json({ error: "Proje bulunamadi" });
  if (fs.existsSync(newPath)) return res.status(409).json({ error: "Bu isim zaten kullaniliyor" });
  try {
    fs.renameSync(oldPath, newPath);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.streamClone = streamClone;
module.exports = router;
