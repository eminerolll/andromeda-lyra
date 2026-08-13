// Lyra ana sunucu. Iki modda calisir:
//   - SETUP MODE   (LYRA_SETUP_MODE=1): port 80'de minimal API (sadece setup endpoint'leri + setup.html)
//   - NORMAL MODE  (default): tam Lyra dashboard, auth, route'lar, proxy

require("dotenv").config();
const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");

const config = require("./lib/config");
const auth = require("./lib/auth");
const ban = require("./lib/ban");
const securityHeaders = require("./lib/security-headers");
const proxyLib = require("./lib/proxy");
const pathProxy = require("./lib/path-proxy");
const { bans, users } = require("./db/repos");

const SETUP_MODE = process.env.LYRA_SETUP_MODE === "1";
const SETUP_PORT = parseInt(process.env.LYRA_SETUP_PORT || "80", 10);

// Ban listesini yukle
bans.load();

const app = express();
app.set("trust proxy", "loopback");
app.use(ban.middleware);
app.use(securityHeaders);
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(auth.buildSessionMiddleware());
app.use(express.static(path.join(__dirname, "public"), { index: false }));

// Public minimal endpoints (her iki modda da)
app.get("/healthz", (req, res) => res.json({ ok: true }));
app.get("/setup-status", (req, res) => {
  res.json({ setupComplete: config.isSetupComplete() });
});
app.get("/api/branding", (req, res) => {
  res.json({ appName: config.get("app_name") || "Lyra" });
});

if (SETUP_MODE) {
  // ──────────────────────── SETUP MODE ────────────────────────
  // Sadece setup wizard ve onun API endpoint'leri aktif

  const setupRoutes = require("./routes/setup");
  app.use(setupRoutes);

  // Root → setup.html
  app.get("/", (req, res) => {
    if (users.exists()) {
      // Setup zaten tamamlanmis, normal mode'a yonlendir
      return res.type("text/plain").send(
        "Kurulum tamamlanmis. Lyra'yi yeniden baslat (LYRA_SETUP_MODE=1 olmadan)."
      );
    }
    res.sendFile(path.join(__dirname, "public", "setup.html"));
  });

  // 404 handler — diger her sey
  app.use((req, res) => {
    res.status(404).type("text/plain").send(
      "Lyra kurulum modunda. Sadece /setup ve /api/setup/* aktif.\n" +
      "Tarayicidan: http://<sunucu-ip>"
    );
  });

  const server = http.createServer(app);
  // Setup mode 0.0.0.0'a bind ki LAN'daki tarayicilar erisebilsin
  server.listen(SETUP_PORT, "0.0.0.0", () => {
    console.log(`Lyra setup-mode http://0.0.0.0:${SETUP_PORT} — kurulum bekliyor`);
  });
  return; // server.js durur; normal mode kismi calismaz
}

// ──────────────────────── NORMAL MODE ────────────────────────

// Route imports
const authRoutes = require("./routes/auth-routes");
const projectRoutes = require("./routes/projects");
const githubRoutes = require("./routes/github");
const systemRoutes = require("./routes/system");
const portRoutes = require("./routes/ports");
const gitRoutes = require("./routes/git");
const envRoutes = require("./routes/env");
const logRoutes = require("./routes/logs");
const notesRoutes = require("./routes/notes");
const dockerRoutes = require("./routes/docker");
const cfRoutes = require("./routes/cloudflare");
const settingsAdminRoutes = require("./routes/settings-admin");
const connectInfoRoutes = require("./routes/connect-info");
const banRoutes = require("./routes/bans");

githubRoutes.setStreamClone(projectRoutes.streamClone);

// Auth route'lari (login/logout/2fa) — auth gerektirmeyen kismi requireSetup'tan once
app.use(authRoutes);

// Setup tamamlanmamissa diger her sey kapali
app.use(auth.requireSetupComplete);

// Auth gerektiren route'lar
app.use(auth.requireAuth, projectRoutes);
app.use(auth.requireAuth, githubRoutes);
app.use(auth.requireAuth, systemRoutes);
app.use(auth.requireAuth, gitRoutes);
app.use(auth.requireAuth, portRoutes);
app.use(auth.requireAuth, envRoutes);
app.use(auth.requireAuth, logRoutes);
app.use(auth.requireAuth, notesRoutes);
app.use(auth.requireAuth, dockerRoutes);
app.use(auth.requireAuth, cfRoutes);
app.use(auth.requireAuth, settingsAdminRoutes);
app.use(auth.requireAuth, connectInfoRoutes);
app.use(auth.requireAuth, banRoutes);

app.get("/", auth.requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const sessionMw = auth.buildSessionMiddleware();

// Dashboard apex domain'de duruyor (bkz. lib/caddy.js, routes/setup.js).
// Login redirect'i code subdomain'ine degil apex'e gitmeli.
function loginLocation() {
  const base = config.get("base_domain");
  return config.get("public_access") && base ? "https://" + base + "/login" : "/login";
}

// /code/proxy/{port} -> dev preview adresi. Her zaman path formu uretilir:
// dev-{port} host'u wildcard sertifika ister, Caddy modunda alinamiyor
// (bkz. lib/caddy.js). Host-tabanli dev-{port} dali calismaya devam eder;
// wildcard'i kendi kuran kullanici o adresi dogrudan kullanabilir.
function devPreviewLocation({ port, tail }) {
  return "/dev/" + port + tail;
}

// Iki katman ayni anda aktif:
//   Katman 2 (host)  — sadece public mod + domain; proxy'lenen servis host'unda
//                      gelen /code, /files gibi yollar o servise aittir, once bakilir.
//   Katman 1 (path)  — her erisim modunda, domain gerektirmez.
function handleRequest(req, res) {
  if (ban.isRequestBanned(req)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "IP banlandi" }));
  }

  if (config.get("public_access")) {
    const host = (req.headers.host || "").split(":")[0];
    const targetPort = proxyLib.findTargetPort(host);
    if (targetPort) {
      if (proxyLib.isPublicBypassPath(host, req.url)) {
        return proxyLib.forwardWeb(req, res, targetPort);
      }
      return sessionMw(req, res, () => {
        if (req.session && req.session.userId) {
          proxyLib.forwardWeb(req, res, targetPort);
        } else {
          res.writeHead(302, { Location: loginLocation() });
          res.end();
        }
      });
    }
  }

  // code-server'in port-forward linkleri auth bariyerinden once yakalanir
  const codeProxy = pathProxy.matchCodeProxy(req.url);
  if (codeProxy) {
    res.writeHead(302, { Location: devPreviewLocation(codeProxy) });
    return res.end();
  }

  const pathMatch = pathProxy.match(req.url);
  if (pathMatch) {
    if (pathProxy.isBypassPath(pathMatch, req.url)) {
      return pathProxy.forwardWeb(req, res, pathMatch);
    }
    return sessionMw(req, res, () => {
      if (req.session && req.session.userId) {
        pathProxy.forwardWeb(req, res, pathMatch);
      } else {
        res.writeHead(302, { Location: "/login" });
        res.end();
      }
    });
  }

  return app(req, res);
}

server.removeAllListeners("request");
server.on("request", handleRequest);

server.on("upgrade", (req, socket, head) => {
  if (ban.isRequestBanned(req)) return socket.destroy();
  if (config.get("public_access")) {
    const host = (req.headers.host || "").split(":")[0];
    const targetPort = proxyLib.findTargetPort(host);
    if (targetPort) {
      sessionMw(req, {}, () => {
        if (req.session && req.session.userId) {
          proxyLib.forwardWs(req, socket, head, targetPort);
        } else {
          socket.destroy();
        }
      });
      return;
    }
  }

  // Path-tabanli yollarin upgrade dali. code-server'in terminali ve LSP'si
  // WebSocket olmadan calismaz — bu dal olmadan /code/ yarim calisir.
  const pathMatch = pathProxy.match(req.url);
  if (pathMatch) {
    sessionMw(req, {}, () => {
      if (req.session && req.session.userId) {
        pathProxy.forwardWs(req, socket, head, pathMatch);
      } else {
        ban.noteUnauthorized(ban.requestIp(req), { path: req.url }, {
          hasSession: auth.hasSessionCookie(req)
        });
        socket.destroy();
      }
    });
    return;
  }

  if (req.url.startsWith("/ws/ports") || req.url.startsWith("/ws/logs")) {
    sessionMw(req, {}, () => {
      if (req.session && req.session.userId) {
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      } else {
        // WS upgrade de auto-ban sayacini beslemeli; aksi halde saldirgan
        // login formuna hic dokunmadan sinirsiz deneme yapabilir.
        ban.noteUnauthorized(ban.requestIp(req), { path: req.url }, {
          hasSession: auth.hasSessionCookie(req)
        });
        socket.destroy();
      }
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws, req) => {
  if (req.url.startsWith("/ws/ports")) {
    portRoutes.handleConnection(ws, req);
  } else if (req.url.startsWith("/ws/logs")) {
    logRoutes.handleConnection(ws, req);
  } else {
    ws.close();
  }
});

// Kurulum fazinin gecici tam-yetki sudoers dosyasi normalde finalize sonunda
// silinir. Kurulum yarida kaldiysa geride kalmis olabilir — normal mode
// acilisinda temizle. (Kalici sudoers dosyasi bu silmeye izin verir.)
if (config.isSetupComplete()) {
  require("./routes/setup").cleanupSetupPrivileges();
}

const bindAddr = config.get("bind_address") || "127.0.0.1";
server.listen(config.PORT, bindAddr, () => {
  const setupOk = config.isSetupComplete();
  const status = setupOk ? "yapilandirilmis" : "KURULUM GEREKLI (npm run setup)";
  const accessHint = bindAddr === "0.0.0.0"
    ? `LAN'dan: http://<sunucu-ip>:${config.PORT}`
    : `Localhost: http://${bindAddr}:${config.PORT}`;
  console.log(`${config.get("app_name") || "Lyra"} ${accessHint} — ${status}`);
});

portRoutes.startScanner();
