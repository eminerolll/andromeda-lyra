// Path-tabanli reverse proxy (Katman 1). Domain, DNS veya TLS gerektirmez:
// Lyra'nin kendi portu uzerinden /code/, /files/, /db/ ve /dev/{port}/
// yollarini yerel servislere yonlendirir.
//
// Host-tabanli proxy (lib/proxy.js, Katman 2) buna EK olarak calisir; domain
// eklemek bu katmani devre disi birakmaz.

const httpProxy = require("http-proxy");
const config = require("./config");
const { scanPorts } = require("./port-scanner");
const { services } = require("../db/repos");

const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true });

// Hedefe ozel hata mesaji: forward oncesi req.lyraProxyError'a yazilir.
proxy.on("error", (err, req, res) => {
  const msg = (req && req.lyraProxyError) || "Baglanti hatasi";
  if (res && typeof res.writeHead === "function") {
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(msg);
  } else if (res && typeof res.destroy === "function") {
    // WebSocket yolunda ucuncu parametre ham socket
    res.destroy();
  }
});

// Prefix -> services tablosundaki tip. Kayitli/enabled degilse 503.
const SERVICE_ROUTES = [
  {
    prefix: "/code",
    type: "code-server",
    label: "code-server",
    missing: "code-server kurulu degil"
  },
  {
    prefix: "/files",
    type: "filebrowser",
    label: "Dosya yoneticisi",
    missing: "Dosya yoneticisi (filebrowser) kurulu degil"
  },
  {
    prefix: "/db",
    type: "dbgate",
    label: "Veritabani arayuzu",
    missing: "Veritabani arayuzu (dbgate) kurulu degil"
  }
];

// filebrowser share linkleri auth gerektirmez (host-tabanli proxy ile ayni liste)
const FILES_BYPASS = ["/share/", "/public/", "/api/public/", "/static/"];

const PORT_CACHE_TTL = 5000;
let livePorts = new Set();
let livePortsAt = 0;
let scanning = false;

// Prefix'i soyup kalan yolu dondur. "/code" -> "/", "/code?x" -> "/?x".
function pathAfter(url, prefix) {
  const rest = url.slice(prefix.length);
  if (!rest || rest[0] === "?") return "/" + rest;
  return rest;
}

// "/code" prefix'i "/codex" ile eslesmemeli.
function matchesPrefix(url, prefix) {
  if (!url.startsWith(prefix)) return false;
  const next = url[prefix.length];
  return next === undefined || next === "/" || next === "?";
}

// URL -> yonlendirme tanimi. Sadece string analizi; port cozumu forward'ta.
function match(url) {
  if (typeof url !== "string" || url[0] !== "/") return null;
  const dev = url.match(/^\/dev\/(\d+)(?=$|[/?])/);
  if (dev) {
    return { kind: "dev", port: parseInt(dev[1], 10), prefix: dev[0] };
  }
  for (const r of SERVICE_ROUTES) {
    if (matchesPrefix(url, r.prefix)) return { kind: "service", ...r };
  }
  return null;
}

// code-server'in kendi port-forward linkleri: /code/proxy/{port}/...
// Auth bariyerinden once yakalanir, dev preview adresine yonlendirilir.
function matchCodeProxy(url) {
  if (typeof url !== "string") return null;
  const m = url.match(/^\/code\/proxy\/(\d+)(?=$|[/?])/);
  if (!m) return null;
  return { port: parseInt(m[1], 10), tail: pathAfter(url, m[0]) };
}

function isBypassPath(m, url) {
  if (!m || m.kind !== "service" || m.type !== "filebrowser") return false;
  const rest = pathAfter(url, m.prefix);
  return FILES_BYPASS.some((p) => rest.startsWith(p));
}

function servicePort(type) {
  const found = services.getByType(type).find((s) => s.enabled && s.port);
  return found ? found.port : null;
}

// Canli dinlenen portlari kisa sureli cache'le; her istekte `ss` calistirmak pahali.
function withLivePorts(cb) {
  if (scanning || Date.now() - livePortsAt < PORT_CACHE_TTL) return cb(livePorts);
  scanning = true;
  scanPorts((ports) => {
    livePorts = new Set(ports.map((p) => p.port));
    livePortsAt = Date.now();
    scanning = false;
    cb(livePorts);
  });
}

// Keyfi porta proxy acilmaz: sadece kayitli servis portlari veya gercekten
// dinlenen portlar. Lyra'nin kendi portu dislanir (kendine proxy = dongu).
function isAllowedDevPort(port, live) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  if (port === config.PORT) return false;
  if (live && live.has(port)) return true;
  return services.list({ enabledOnly: true }).some((s) => s.port === port);
}

function resolvePort(m, cb) {
  if (m.kind === "dev") {
    return withLivePorts((live) => {
      if (!isAllowedDevPort(m.port, live)) {
        return cb({
          code: 503,
          message: `Dev server calismiyor: ${m.port} portunu dinleyen bir surec yok.`
        });
      }
      cb(null, m.port);
    });
  }
  const port = servicePort(m.type);
  if (!port) {
    return cb({
      code: 503,
      message: `${m.missing}. Ayarlar > Servisler bolumunden ekleyip etkinlestirin.`
    });
  }
  cb(null, port);
}

function errorLabel(m) {
  return m.kind === "dev" ? "Dev server calismiyor." : m.label + " baglanti hatasi";
}

function forwardWeb(req, res, m) {
  resolvePort(m, (err, port) => {
    if (err) {
      res.writeHead(err.code, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end(err.message);
    }
    req.url = pathAfter(req.url, m.prefix);
    req.lyraProxyError = errorLabel(m);
    proxy.web(req, res, { target: "http://127.0.0.1:" + port });
  });
}

// code-server terminal/LSP bu yoldan gecer; WebSocket olmadan calismaz.
function forwardWs(req, socket, head, m) {
  resolvePort(m, (err, port) => {
    if (err) return socket.destroy();
    req.url = pathAfter(req.url, m.prefix);
    req.lyraProxyError = errorLabel(m);
    proxy.ws(req, socket, head, { target: "http://127.0.0.1:" + port });
  });
}

module.exports = {
  SERVICE_ROUTES,
  match,
  matchCodeProxy,
  isBypassPath,
  forwardWeb,
  forwardWs,
  proxy
};
