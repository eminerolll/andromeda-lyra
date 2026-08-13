// Gercek WebSocket proxy testi. Sahte upstream WS sunucusu kaldirilir, istek
// Lyra'nin proxy fonksiyonlarindan gecirilir ve UPSTREAM'E ULASAN Host/Origin
// basliklari dogrulanir.
//
// Neden onemli: code-server WS upgrade'ini authenticateOrigin() ile korur
// (coder/code-server src/node/http.ts) — getHost(req) ile Origin'in host'u
// esit degilse 403 doner, tarayici "WebSocket close with status code 1006"
// gosterir. changeOrigin:true Host'u 127.0.0.1:PORT'a yeniden yazdigi icin
// tam olarak bu esitligi bozuyordu.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { freshHome, cleanup, require } from "./setup.js";

const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

// Upstream: baglantiyi kabul eden, upgrade isteginin basliklarini kaydeden sunucu.
function startUpstream() {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => res.end("ok"));
    const wss = new WebSocketServer({ server });
    wss.on("connection", (ws, req) => {
      seen.push(req.headers);
      ws.send("hello");
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, wss, seen, port: server.address().port })
    );
  });
}

// Lyra tarafi: verilen upgrade handler'i kullanan gercek HTTP sunucusu.
function startLyra(onUpgrade) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => res.end("lyra"));
    server.on("upgrade", onUpgrade);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function close(...servers) {
  return Promise.all(servers.filter(Boolean).map((s) => new Promise((r) => s.close(() => r()))));
}

// Tarayicinin yaptigini taklit et: Host + Origin baslikli gercek WS handshake.
function connect(port, path, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("WS baglantisi zaman asimina ugradi"));
    }, 5000);
    ws.on("message", (data) => {
      clearTimeout(timer);
      ws.close();
      resolve(String(data));
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe("proxy WebSocket basliklari", () => {
  let home, upstream, lyra;

  beforeEach(async () => {
    home = freshHome();
    require("../db/migrate").migrate();
    upstream = await startUpstream();
  });

  afterEach(async () => {
    await close(lyra && lyra.server, upstream && upstream.server);
    lyra = null;
    cleanup(home);
  });

  it("path yolunda servise orijinal Host'u iletir (code-server Origin kontrolu gecer)", async () => {
    const { services } = require("../db/repos");
    services.add({
      unit_name: "code-server",
      display_name: "code-server",
      type: "code-server",
      port: upstream.port
    });
    const pathProxy = require("../lib/path-proxy");

    lyra = await startLyra((req, socket, head) => {
      const m = pathProxy.match(req.url);
      if (m) pathProxy.forwardWs(req, socket, head, m);
      else socket.destroy();
    });

    const msg = await connect(lyra.port, "/code/stable-abc/socket", {
      host: "indiedir.online",
      origin: "https://indiedir.online"
    });

    expect(msg).toBe("hello");
    expect(upstream.seen).toHaveLength(1);
    // Kritik: Host yeniden yazilmadi, Origin ile ayni kaldi.
    expect(upstream.seen[0].host).toBe("indiedir.online");
    expect(upstream.seen[0].origin).toBe("https://indiedir.online");
    // code-server'in authenticateOrigin() karsilastirmasinin aynisi
    expect(new URL(upstream.seen[0].origin).host).toBe(upstream.seen[0].host);
    // Prefix soyuldu
    expect(upstream.seen[0]["sec-websocket-key"]).toBeTruthy();
  });

  it("path yolunda dev onizlemesine 127.0.0.1 Host'u yazar (allowedHosts icin)", async () => {
    const { services } = require("../db/repos");
    // isAllowedDevPort kayitli servis portlarini da kabul eder — ss'e bagimli kalma
    services.add({
      unit_name: "devsrv",
      display_name: "dev",
      type: "other",
      port: upstream.port
    });
    const pathProxy = require("../lib/path-proxy");

    lyra = await startLyra((req, socket, head) => {
      const m = pathProxy.match(req.url);
      if (m) pathProxy.forwardWs(req, socket, head, m);
      else socket.destroy();
    });

    const msg = await connect(lyra.port, `/dev/${upstream.port}/`, {
      host: "indiedir.online",
      origin: "https://indiedir.online"
    });

    expect(msg).toBe("hello");
    expect(upstream.seen[0].host).toBe(`127.0.0.1:${upstream.port}`);
  });

  it("host yolunda servis subdomain'inde orijinal Host korunur", async () => {
    const config = require("../lib/config");
    config.set("base_domain", "indiedir.online");
    config.set("public_access", true);
    const { services } = require("../db/repos");
    services.add({
      unit_name: "code-server",
      display_name: "code-server",
      type: "code-server",
      port: upstream.port
    });
    const proxyLib = require("../lib/proxy");

    lyra = await startLyra((req, socket, head) => {
      const host = (req.headers.host || "").split(":")[0];
      const port = proxyLib.findTargetPort(host);
      if (port) proxyLib.forwardWs(req, socket, head, port);
      else socket.destroy();
    });

    const msg = await connect(lyra.port, "/stable-abc/socket", {
      host: "code.indiedir.online",
      origin: "https://code.indiedir.online"
    });

    expect(msg).toBe("hello");
    expect(upstream.seen[0].host).toBe("code.indiedir.online");
    expect(new URL(upstream.seen[0].origin).host).toBe(upstream.seen[0].host);
  });

  it("host yolunda dev-{port} subdomain'inde Host yeniden yazilir", async () => {
    const config = require("../lib/config");
    config.set("base_domain", "indiedir.online");
    config.set("public_access", true);
    const proxyLib = require("../lib/proxy");

    lyra = await startLyra((req, socket, head) => {
      const host = (req.headers.host || "").split(":")[0];
      const port = proxyLib.findTargetPort(host);
      if (port) proxyLib.forwardWs(req, socket, head, port);
      else socket.destroy();
    });

    const msg = await connect(lyra.port, "/", {
      host: `dev-${upstream.port}.indiedir.online`,
      origin: `https://dev-${upstream.port}.indiedir.online`
    });

    expect(msg).toBe("hello");
    expect(upstream.seen[0].host).toBe(`127.0.0.1:${upstream.port}`);
  });

  it("upstream olmeyse sokete HTTP govdesi yazilmaz, baglanti kapatilir", async () => {
    const { services } = require("../db/repos");
    // Dinlenmeyen bir port: upstream'i kapatip onun portunu kullan
    const deadPort = upstream.port;
    await close(upstream.server);
    upstream.server = null;
    services.add({
      unit_name: "code-server",
      display_name: "code-server",
      type: "code-server",
      port: deadPort
    });
    const pathProxy = require("../lib/path-proxy");

    lyra = await startLyra((req, socket, head) => {
      const m = pathProxy.match(req.url);
      if (m) pathProxy.forwardWs(req, socket, head, m);
      else socket.destroy();
    });

    // Ham socket ile handshake gonder; donen baytlarda proxy hata metni olmamali
    const net = require("net");
    const raw = await new Promise((resolve, reject) => {
      const chunks = [];
      const s = net.connect(lyra.port, "127.0.0.1", () => {
        s.write(
          "GET /code/socket HTTP/1.1\r\nHost: indiedir.online\r\n" +
            "Origin: https://indiedir.online\r\nUpgrade: websocket\r\n" +
            "Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
        );
      });
      s.on("data", (d) => chunks.push(d));
      s.on("close", () => resolve(Buffer.concat(chunks).toString()));
      s.on("error", reject);
      setTimeout(() => s.destroy(), 3000);
    });

    expect(raw).not.toContain("101");
    expect(raw).not.toContain("code-server baglanti hatasi");
    if (raw) expect(raw.startsWith("HTTP/1.1 502")).toBe(true);
  });
});
