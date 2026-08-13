// Reverse proxy yardimcilari. DB-driven hostname routing.
// Servis tablosundan {subdomain, port} eslestirmesi okur, http-proxy ile yonlendirir.

const httpProxy = require("http-proxy");
const config = require("./config");
const pathProxy = require("./path-proxy");
const { services } = require("../db/repos");

// changeOrigin GLOBAL OLARAK KAPALI. Yonetilen servisler orijinal Host'u gormeli:
// code-server WebSocket upgrade'ini authenticateOrigin() ile korur ve
// getHost(req) !== new URL(origin).host oldugunda 403 doner (kaynak:
// coder/code-server src/node/http.ts, wsRouter'da ensureOrigin middleware'i).
// Host'u 127.0.0.1:8080'e yeniden yazmak upgrade'i dusurur; HTTP calistigi icin
// arayuz gelir ama tarayici "WebSocket close with status code 1006" gosterir.
// Host yeniden yazimi sadece dev-{port} hedeflerinde yapilir (bkz. targetOptions).
const proxy = httpProxy.createProxyServer({ ws: true });

proxy.on("error", (err, req, res) => {
  const msg = (err && err.message) || "bilinmeyen";
  console.error(
    `[proxy] ${(req && req.headers && req.headers.host) || "?"}${(req && req.url) || ""}: ${msg}`
  );
  if (res && typeof res.writeHead === "function") {
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Proxy hata: " + msg);
  } else {
    // WebSocket yolunda ucuncu parametre ham socket'tir, response degil.
    // Sokete duz metin yazmak tarayiciya bozuk cerceve gonderir.
    failSocket(res);
  }
});

// WS upgrade'i basarisiz oldugunda soketi duzgun kapat. Handshake henuz
// gonderilmediyse (bytesWritten === 0) hala gecerli bir HTTP yaniti yazilabilir;
// 101 gonderildikten sonra HTTP metni cerceveleri bozar, sadece kapatilir.
function failSocket(socket) {
  if (!socket || typeof socket.destroy !== "function" || socket.destroyed) return;
  if (socket.writable && socket.bytesWritten === 0) {
    socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  }
  socket.destroy();
}

// parseHostname tipi -> services tablosundaki tip
const HOST_TYPE_TO_SERVICE = { code: "code-server", files: "filebrowser", db: "dbgate" };

// Host'a gore hedef port bul.
// Onerilen siralama: services tablosundaki subdomain eslesmesi -> dev-{port} pattern
function findTargetPort(host) {
  if (!host) return null;
  host = host.split(":")[0];

  // dev-{port}.base_domain
  const parsed = config.parseHostname(host);
  if (parsed && parsed.type === "dev") return parsed.port;

  // type bazli (code/files/db) — services tablosundan ilk enabled olanin port'u
  if (parsed && HOST_TYPE_TO_SERVICE[parsed.type]) {
    const list = services.getByType(HOST_TYPE_TO_SERVICE[parsed.type]);
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

// Host bilinen bir servis subdomain'ine (code./files./db.) ait mi?
// Ait ama servis kayitli degilse findTargetPort null doner ve istek dashboard'a
// duserdi — kullanici "IDE'yi ac" deyip sessizce ana ekrana geri gelirdi.
// Donen tanim path-tabanli katmanin route tanimidir: 503 metni orada
// (path-proxy SERVICE_ROUTES + resolvePort) tek yerde uretilir, burada
// kopyalanmaz. prefix bos birakilir; host-tabanli istekte URL'in soyulacak
// bir on eki yok, boylece servis kayitliysa forward da bozulmaz.
function serviceHostRoute(host) {
  if (!host) return null;
  const parsed = config.parseHostname(host.split(":")[0]);
  if (!parsed) return null;
  const type = HOST_TYPE_TO_SERVICE[parsed.type];
  if (!type) return null;
  const route = pathProxy.SERVICE_ROUTES.find((r) => r.type === type);
  return route ? { kind: "service", ...route, prefix: "" } : null;
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

// Dev server'lar (Vite, webpack-dev-server) gelen Host'u allowedHosts listesine
// karsi kontrol eder; dev-3000.alanadi.com gibi bir Host'u reddederler ama
// 127.0.0.1'i her zaman kabul ederler. Bu yuzden Host yeniden yazimi SADECE
// dev-{port} hedeflerinde korunur. Yonetilen servisler (code-server, filebrowser,
// dbgate) Origin/Host esitligi bekledigi icin orijinal Host'u alir.
function isDevHost(host) {
  const parsed = config.parseHostname((host || "").split(":")[0]);
  return !!(parsed && parsed.type === "dev");
}

function targetOptions(req, port) {
  return {
    target: "http://127.0.0.1:" + port,
    changeOrigin: isDevHost(req && req.headers && req.headers.host)
  };
}

function forwardWeb(req, res, port) {
  proxy.web(req, res, targetOptions(req, port));
}

function forwardWs(req, socket, head, port) {
  proxy.ws(req, socket, head, targetOptions(req, port));
}

module.exports = {
  findTargetPort,
  serviceHostRoute,
  isPublicBypassPath,
  targetOptions,
  forwardWeb,
  forwardWs,
  proxy
};
