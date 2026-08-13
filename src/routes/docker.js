// Docker container ve compose yonetimi. prod_apps_dir ayarlanmamissa endpoint'ler bos doner.

const express = require("express");
const docker = require("../lib/docker");

const router = express.Router();

router.get("/api/docker/status", (req, res) => {
  const enabled = !!docker.prodDir();
  docker.dockerAvailable((ok, version) => {
    res.json({ available: ok, version, enabled });
  });
});

router.get("/api/docker/containers", (req, res) => {
  docker.listContainers((err, containers) => {
    if (err) return res.status(500).json({ error: err.message });
    docker.containerStats((statsErr, stats) => {
      const statsMap = {};
      if (!statsErr) for (const s of stats) statsMap[s.id] = s;
      const merged = containers.map((c) => ({
        ...c,
        stats: statsMap[c.id.substring(0, 12)] || statsMap[c.id] || null
      }));
      res.json({ containers: merged });
    });
  });
});

router.get("/api/docker/projects", (req, res) => {
  if (!docker.prodDir()) return res.json({ enabled: false, projects: [] });
  docker.listProdProjects((err, projects) => {
    if (err) return res.status(500).json({ error: err.message });
    docker.listContainers((cErr, containers) => {
      const byProject = {};
      if (!cErr) {
        for (const c of containers) {
          if (!c.project) continue;
          if (!byProject[c.project]) byProject[c.project] = [];
          byProject[c.project].push(c);
        }
      }
      const result = projects.map((p) => ({ ...p, containers: byProject[p.name] || [] }));
      res.json({ enabled: true, projects: result, prodDir: docker.prodDir() });
    });
  });
});

router.post("/api/docker/container/:id/:action", (req, res) => {
  const { id, action } = req.params;
  docker.containerAction(id, action, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    res.json({ success: true });
  });
});

router.get("/api/docker/container/:id/logs", (req, res) => {
  const tail = req.query.tail || 200;
  docker.containerLogs(req.params.id, tail, (err, stdout) => {
    if (err) return res.status(400).json({ error: err.message });
    res.json({ logs: stdout });
  });
});

router.post("/api/docker/project/:name/:action", (req, res) => {
  const { name, action } = req.params;
  docker.composeAction(name, action, (err, stdout) => {
    if (err) return res.status(400).json({ error: err.message, output: stdout });
    res.json({ success: true, output: stdout });
  });
});

router.get("/api/docker/project/:name/logs", (req, res) => {
  const tail = req.query.tail || 200;
  docker.composeLogs(req.params.name, tail, (err, stdout) => {
    if (err) return res.status(400).json({ error: err.message });
    res.json({ logs: stdout });
  });
});

module.exports = router;
