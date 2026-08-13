// GitHub entegrasyonu: token kayit, repo/branch listeleme, clone.
// Token integrations.github.config.token icinde tutulur.

const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const config = require("../lib/config");
const { integrations } = require("../db/repos");

const router = express.Router();

const GIT_CREDENTIALS_PATH = path.join(os.homedir(), ".git-credentials");
const userAgent = () => (config.get("app_name") || "Lyra") + "-Launcher";

// streamClone projects.js'den enjekte edilir
let streamClone = null;
router.setStreamClone = function (fn) {
  streamClone = fn;
};

function getToken() {
  const i = integrations.get("github");
  return i && i.enabled && i.config ? i.config.token : null;
}

function getUser() {
  const i = integrations.get("github");
  return i && i.config ? i.config.user : null;
}

router.post("/api/settings/github", async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: "Token gerekli" });
  try {
    const response = await fetch("https://api.github.com/user", {
      headers: { Authorization: "Bearer " + token, "User-Agent": userAgent() }
    });
    if (!response.ok) return res.status(401).json({ error: "Gecersiz token" });
    const user = await response.json();

    integrations.set("github", {
      enabled: true,
      config: {
        token,
        user: user.login,
        name: user.name,
        avatar: user.avatar_url
      }
    });

    try {
      execFileSync("git", ["config", "--global", "credential.helper", "store"]);
      execFileSync("git", ["config", "--global", "user.name", user.name || user.login]);
      execFileSync("git", [
        "config",
        "--global",
        "user.email",
        user.email || user.login + "@users.noreply.github.com"
      ]);
      fs.writeFileSync(
        GIT_CREDENTIALS_PATH,
        "https://" + user.login + ":" + token + "@github.com\n",
        { mode: 0o600 }
      );
    } catch (e) {
      // git config opsiyonel — token DB'de kayitli olduktan sonra bile clone calisir (URL'ye embed)
    }

    res.json({ success: true, user: user.login, name: user.name, avatar: user.avatar_url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/api/settings/github", (req, res) => {
  integrations.remove("github");
  try {
    fs.unlinkSync(GIT_CREDENTIALS_PATH);
  } catch (_) {}
  res.json({ success: true });
});

router.get("/api/github/repos", async (req, res) => {
  const token = getToken();
  if (!token) return res.status(400).json({ error: "GitHub bagli degil" });
  try {
    const page = req.query.page || 1;
    const search = req.query.search || "";
    const url =
      "https://api.github.com/user/repos?per_page=30&page=" +
      page +
      "&sort=updated&affiliation=owner,collaborator,organization_member";
    const response = await fetch(url, {
      headers: { Authorization: "Bearer " + token, "User-Agent": userAgent() }
    });
    if (!response.ok) return res.status(response.status).json({ error: "GitHub API hatasi" });
    let repos = await response.json();
    if (search) {
      repos = repos.filter((r) => r.full_name.toLowerCase().includes(search.toLowerCase()));
    }
    res.json(
      repos.map((r) => ({
        name: r.name,
        fullName: r.full_name,
        description: r.description,
        language: r.language,
        stars: r.stargazers_count,
        isPrivate: r.private,
        cloneUrl: r.clone_url,
        updatedAt: r.updated_at
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/api/github/branches", async (req, res) => {
  const token = getToken();
  if (!token) return res.status(400).json({ error: "GitHub bagli degil" });
  const { repo } = req.query;
  if (!repo) return res.status(400).json({ error: "repo parametresi gerekli" });
  try {
    const headers = { Authorization: "Bearer " + token, "User-Agent": userAgent() };
    const response = await fetch(
      "https://api.github.com/repos/" + repo + "/branches?per_page=100",
      { headers }
    );
    if (!response.ok) return res.status(response.status).json({ error: "GitHub API hatasi" });
    const branches = await response.json();
    const repoRes = await fetch("https://api.github.com/repos/" + repo, { headers });
    const repoData = await repoRes.json();
    res.json({
      defaultBranch: repoData.default_branch || "main",
      branches: branches.map((b) => b.name)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/github/clone", (req, res) => {
  const { cloneUrl, name, branch } = req.body || {};
  if (!cloneUrl) return res.status(400).json({ error: "URL gerekli" });
  const token = getToken();
  const user = getUser();
  const repoName = name || cloneUrl.split("/").pop().replace(".git", "");
  const projectPath = path.join(config.get("projects_dir"), repoName);
  if (fs.existsSync(projectPath)) {
    return res.status(409).json({ error: "Bu isimde klasor zaten var." });
  }
  let authUrl = cloneUrl;
  if (token && user && cloneUrl.includes("github.com")) {
    authUrl = cloneUrl.replace("https://", "https://" + user + ":" + token + "@");
  }
  if (!streamClone) {
    return res.status(500).json({ error: "streamClone bagli degil" });
  }
  streamClone(authUrl, projectPath, repoName, req, res, branch || null);
});

module.exports = router;
