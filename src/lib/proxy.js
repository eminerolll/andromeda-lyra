// Reverse proxy yardimcilari. DB-driven hostname routing.
// Servis tablosundan {subdomain, port} eslestirmesi okur, http-proxy ile yonlendirir.

const httpProxy = require("http-proxy");
const config = require("./config");
const { services } = require("../db/repos");

const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true });

proxy.on("error", (err, req, res) => {
  if (res && res.writeHead) res.writeHead(502, { "Content-Type": "text/plain" });
  if (res && res.end) res.end("Proxy hata: " + (err.message || "bilinmeyen"));
});

// Host'a gore hedef port bul.
// Onerilen siralama: services tablosundaki subdomain eslesmesi -> dev-{port} pattern
function findTargetPort(host) {
  if (!host) return null;
  host = host.split(":")[0];

  // dev-{port}.base_domain
  const parsed = config.parseHostname(host);
  if (parsed && parsed.type === "dev") return parsed.port;

  // type bazli (code/files/db) — services tablosundan ilk enabled olanin port'u
  if (parsed && (parsed.type === "code" || parsed.type === "files" || parsed.type === "db")) {
    const typeMap = { code: "code-server", files: "filebrowser", db: "dbgate" };
    const list = services.getByType(typeMap[parsed.type]);
    const enabled = list.find((s) => s.enabled && s.port);
    if (enabled) return enabled.port;
  }

  // Direkt subdomain eslesmesi (kullanici custom subdomain ayarlamissa)
  const all = services.list({ enabledOnly: true });
  for (const s of all) {
    if (s.subdomain && s.port) {
      const fullHost = config.get("base_domain")
        ? `${s.subdomain}.${config.get("base_domain")}`
        : null;
      if (fullHost && host === fullHost) return s.port;
    }
  }

  return null;
}

function isPublicBypassPath(host, url) {
  // Filebrowser share linkleri auth gerektirmez
  const baseDomain = config.get("base_domain");
  if (!baseDomain) return false;
  const filesHost = `${config.get("subdomain_files")}.${baseDomain}`;
  if (
    host === filesHost &&
    (url.startsWith("/share/") ||
      url.startsWith("/public/") ||
      url.startsWith("/api/public/") ||
      url.startsWith("/static/"))
  )
    return true;
  return false;
}

function forwardWeb(req, res, port) {
  proxy.web(req, res, { target: "http://127.0.0.1:" + port });
}

function forwardWs(req, socket, head, port) {
  proxy.ws(req, socket, head, { target: "http://127.0.0.1:" + port });
}

module.exports = { findTargetPort, isPublicBypassPath, forwardWeb, forwardWs, proxy };
