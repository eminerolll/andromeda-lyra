// Git islemleri: status/log/diff + exec (pull/push/commit/checkout/...).
// Conflict tespiti EN+TR pattern'lariyla.

const express = require("express");
const fs = require("fs");
const path = require("path");
const { execFileSync, execFile, spawn } = require("child_process");
const config = require("../lib/config");

const router = express.Router();

const PROJECT_NAME_RE = /^[a-zA-Z0-9_.-]+$/;
function isValidProjectName(name) {
  if (!name || typeof name !== "string") return false;
  if (name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\")) return false;
  return PROJECT_NAME_RE.test(name);
}

function projectPath(name) {
  return path.join(config.get("projects_dir"), name);
}

function gitCmd(projPath, args) {
  return execFileSync("git", ["-C", projPath, ...args], {
    stdio: ["pipe", "pipe", "ignore"]
  }).toString().trim();
}

function validateProject(req, res) {
  const name = req.params.name || req.params.project;
  if (!isValidProjectName(name)) {
    res.status(400).json({ error: "Gecersiz proje adi" });
    return null;
  }
  const projPath = projectPath(name);
  if (!fs.existsSync(projPath)) {
    res.status(404).json({ error: "Proje bulunamadi" });
    return null;
  }
  return projPath;
}

router.get("/api/projects/:name/git", (req, res) => {
  const projPath = validateProject(req, res);
  if (!projPath) return;
  try {
    const status = {};
    try { status.branch = gitCmd(projPath, ["branch", "--show-current"]); } catch (_) { return res.json({ isGit: false }); }
    try { status.remote = gitCmd(projPath, ["remote", "get-url", "origin"]); } catch (_) { status.remote = null; }
    try {
      status.ahead = parseInt(gitCmd(projPath, ["rev-list", "@{u}..HEAD", "--count"]));
      status.behind = parseInt(gitCmd(projPath, ["rev-list", "HEAD..@{u}", "--count"]));
    } catch (_) { status.ahead = 0; status.behind = 0; }
    try { status.changes = gitCmd(projPath, ["status", "--porcelain"]).split("\n").filter(l => l).length; } catch (_) { status.changes = 0; }
    status.isGit = true;
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/projects/:name/pull", (req, res) => {
  const projPath = validateProject(req, res);
  if (!projPath) return;
  execFile("git", ["-C", projPath, "pull"], { timeout: 60000 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: stderr || stdout || err.message });
    res.json({ success: true, output: (stdout + stderr).trim() });
  });
});

router.post("/api/projects/:name/push", (req, res) => {
  const projPath = validateProject(req, res);
  if (!projPath) return;
  execFile("git", ["-C", projPath, "push"], { timeout: 60000 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: stderr || stdout || err.message });
    res.json({ success: true, output: (stdout + stderr).trim() });
  });
});

router.get("/api/git/:project/status", (req, res) => {
  const projPath = validateProject(req, res);
  if (!projPath) return;
  try {
    let branch;
    try { branch = gitCmd(projPath, ["branch", "--show-current"]); } catch (_) { return res.json({ isGit: false }); }

    let remote = null;
    try { remote = gitCmd(projPath, ["remote", "get-url", "origin"]); } catch (_) {}

    let ahead = 0, behind = 0;
    try {
      ahead = parseInt(gitCmd(projPath, ["rev-list", "@{u}..HEAD", "--count"]));
      behind = parseInt(gitCmd(projPath, ["rev-list", "HEAD..@{u}", "--count"]));
    } catch (_) {}

    let staged = 0, unstaged = 0, untracked = 0;
    try {
      const porcelain = gitCmd(projPath, ["status", "--porcelain"]);
      for (const line of porcelain.split("\n").filter(l => l)) {
        const x = line[0]; const y = line[1];
        if (x === "?") untracked++;
        else {
          if (x !== " ") staged++;
          if (y !== " ") unstaged++;
        }
      }
    } catch (_) {}

    let lastCommit = null;
    try {
      const log = gitCmd(projPath, ["log", "-1", "--format=%H%n%s%n%ai%n%an"]);
      const parts = log.split("\n");
      lastCommit = { hash: parts[0], message: parts[1], date: parts[2], author: parts[3] };
    } catch (_) {}

    res.json({
      isGit: true, branch, remote, ahead, behind,
      staged, unstaged, untracked,
      totalChanges: staged + unstaged + untracked,
      lastCommit
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/api/git/:project/log", (req, res) => {
  const projPath = validateProject(req, res);
  if (!projPath) return;
  const count = Math.min(parseInt(req.query.count) || 30, 100);
  try {
    const log = gitCmd(projPath, ["log", "--oneline", "--graph", "-" + count, "--format=%h|%s|%ai|%an"]);
    const lines = log.split("\n").filter(l => l);
    const commits = lines.map(line => {
      const graphMatch = line.match(/^([*|/\\ ]+)/);
      const graph = graphMatch ? graphMatch[1] : "";
      const rest = line.slice(graph.length);
      const parts = rest.split("|");
      if (parts.length >= 4) {
        return { graph: graph.trimEnd(), hash: parts[0].trim(), message: parts[1], date: parts[2], author: parts[3] };
      }
      return { graph: graph.trimEnd(), raw: rest };
    });
    res.json(commits);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/api/git/:project/diff", (req, res) => {
  const projPath = validateProject(req, res);
  if (!projPath) return;
  try {
    let unstaged = "";
    try { unstaged = gitCmd(projPath, ["diff"]); } catch (_) {}
    let staged = "";
    try { staged = gitCmd(projPath, ["diff", "--staged"]); } catch (_) {}
    let files = [];
    try {
      const porcelain = gitCmd(projPath, ["status", "--porcelain"]);
      files = porcelain.split("\n").filter(l => l).map(line => ({
        status: line.substring(0, 2).trim(),
        file: line.substring(3)
      }));
    } catch (_) {}
    res.json({ unstaged, staged, files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

function runGit(projPath, args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    let stdout = "", stderr = "";
    const proc = spawn("git", ["-C", projPath, ...args], { timeout: timeoutMs, env: GIT_ENV });
    proc.stdout.on("data", c => stdout += c.toString());
    proc.stderr.on("data", c => stderr += c.toString());
    proc.on("close", code => resolve({ stdout, stderr, exitCode: code || 0 }));
    proc.on("error", err => resolve({ stdout, stderr: err.message, exitCode: 1 }));
  });
}

function detectConflict(stdout, stderr, action) {
  const combined = stdout + "\n" + stderr;
  const pullOverwrite = [
    /would be overwritten by (merge|checkout)/i,
    /Please commit your changes or stash them/i,
    /yerel değişikliklerin üzerine yazılacak/i,
    /değişikliklerinizi işleyin veya zulalayın/i,
    /untracked working tree files would be overwritten/i,
    /izlenmeyen çalışma ağacı dosyalarının üzerine yazılacak/i,
    /taşıyın veya kaldırın/i
  ];
  const mergeConflict = [
    /CONFLICT \(content\)/i,
    /Automatic merge failed/i,
    /Otomatik birleştirme başarısız/i
  ];
  const pushRejected = [
    /\[rejected\]/i,
    /non-fast-forward/i,
    /Updates were rejected/i,
    /Güncellemeler reddedildi/i
  ];
  const authFailed = [
    /Authentication failed/i,
    /could not read Username/i,
    /Permission denied \(publickey\)/i,
    /Kimlik doğrulama başarısız/i
  ];
  const matches = (pats) => pats.some(re => re.test(combined));

  if (action === "pull" || action === "stash-pull" || action === "discard-pull") {
    if (matches(pullOverwrite)) return "pull-overwrite";
    if (matches(mergeConflict)) return "pull-merge";
  }
  if (action === "push" || action === "pull-then-push") {
    if (matches(pushRejected)) return "push-rejected";
  }
  if (matches(authFailed)) return "auth-failed";
  return null;
}

function getAffectedFiles(projPath) {
  try {
    const out = execFileSync("git", ["-C", projPath, "status", "--porcelain"], {
      stdio: ["pipe", "pipe", "pipe"]
    }).toString();
    return out.split("\n").filter(l => l).map(line => ({
      status: line.substring(0, 2).trim(),
      file: line.substring(3)
    }));
  } catch (_) {
    return [];
  }
}

router.post("/api/git/:project/exec", async (req, res) => {
  const projPath = validateProject(req, res);
  if (!projPath) return;

  const { action, message, branch } = req.body || {};
  if (!action || typeof action !== "string") {
    return res.status(400).json({ error: "action gerekli" });
  }
  if (branch && !/^[a-zA-Z0-9_.\-/]+$/.test(branch)) {
    return res.status(400).json({ error: "Gecersiz branch adi" });
  }

  const filesBefore = getAffectedFiles(projPath);
  let result = { stdout: "", stderr: "", exitCode: 0 };

  try {
    if (action === "pull") result = await runGit(projPath, ["pull"]);
    else if (action === "push") result = await runGit(projPath, ["push"]);
    else if (action === "fetch") result = await runGit(projPath, ["fetch", "--all"]);
    else if (action === "stash") result = await runGit(projPath, ["stash", "push", "-u", "-m", message || "lyra-stash"]);
    else if (action === "stash-pop") result = await runGit(projPath, ["stash", "pop"]);
    else if (action === "reset-hard") result = await runGit(projPath, ["reset", "--hard", "HEAD"]);
    else if (action === "commit") {
      if (!message || !message.trim()) return res.status(400).json({ error: "commit icin message gerekli" });
      const addResult = await runGit(projPath, ["add", "-A"]);
      result = addResult.exitCode !== 0 ? addResult : await runGit(projPath, ["commit", "-m", message]);
    }
    else if (action === "checkout") {
      if (!branch) return res.status(400).json({ error: "branch gerekli" });
      result = await runGit(projPath, ["checkout", branch]);
    }
    else if (action === "create-branch") {
      if (!branch) return res.status(400).json({ error: "branch gerekli" });
      result = await runGit(projPath, ["checkout", "-b", branch]);
    }
    else if (action === "stash-pull") {
      const stashResult = await runGit(projPath, ["stash", "push", "-u", "-m", "lyra-auto-stash"]);
      result.stdout += "$ git stash push\n" + stashResult.stdout;
      result.stderr += stashResult.stderr;
      if (stashResult.exitCode !== 0 && !/No local changes to save/.test(stashResult.stdout + stashResult.stderr)) {
        result.exitCode = stashResult.exitCode;
      } else {
        const pullResult = await runGit(projPath, ["pull"]);
        result.stdout += "\n$ git pull\n" + pullResult.stdout;
        result.stderr += pullResult.stderr;
        result.exitCode = pullResult.exitCode;
        if (!/No local changes to save/.test(stashResult.stdout + stashResult.stderr)) {
          const popResult = await runGit(projPath, ["stash", "pop"]);
          result.stdout += "\n$ git stash pop\n" + popResult.stdout;
          result.stderr += popResult.stderr;
          if (popResult.exitCode !== 0) result.exitCode = popResult.exitCode;
        }
      }
    }
    else if (action === "discard-pull") {
      const resetResult = await runGit(projPath, ["reset", "--hard", "HEAD"]);
      result.stdout += "$ git reset --hard HEAD\n" + resetResult.stdout;
      result.stderr += resetResult.stderr;
      const cleanResult = await runGit(projPath, ["clean", "-fd"]);
      result.stdout += "\n$ git clean -fd\n" + cleanResult.stdout;
      result.stderr += cleanResult.stderr;
      if (resetResult.exitCode === 0 && cleanResult.exitCode === 0) {
        const pullResult = await runGit(projPath, ["pull"]);
        result.stdout += "\n$ git pull\n" + pullResult.stdout;
        result.stderr += pullResult.stderr;
        result.exitCode = pullResult.exitCode;
      } else {
        result.exitCode = resetResult.exitCode || cleanResult.exitCode;
      }
    }
    else if (action === "pull-then-push") {
      const pullResult = await runGit(projPath, ["pull"]);
      result.stdout += "$ git pull\n" + pullResult.stdout;
      result.stderr += pullResult.stderr;
      if (pullResult.exitCode === 0) {
        const pushResult = await runGit(projPath, ["push"]);
        result.stdout += "\n$ git push\n" + pushResult.stdout;
        result.stderr += pushResult.stderr;
        result.exitCode = pushResult.exitCode;
      } else {
        result.exitCode = pullResult.exitCode;
      }
    }
    else if (action === "force-push") result = await runGit(projPath, ["push", "--force-with-lease"]);
    else return res.status(400).json({ error: "Bilinmeyen action: " + action });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const conflict = detectConflict(result.stdout, result.stderr, action);
  res.json({
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    conflict: conflict !== null,
    conflictType: conflict,
    filesBefore,
    action
  });
});

module.exports = router;
