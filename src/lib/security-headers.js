// Guvenlik header'lari middleware. helmet kullanmak yerine manuel
// (kontrol bizde, harici bagimliligi az tutuyoruz).

const config = require("./config");

// CSP tek bir sabit: Lyra'nin tum statikleri kendi origin'inden servis edilir.
// Dis CDN yok — marked public/vendor/, fontlar public/fonts/ altinda.
//   'unsafe-inline' (script): index/login/setup sayfalarindaki inline
//                             <script> bloklari icin gerekli.
//   'unsafe-inline' (style):  sablonlardaki style="..." nitelikleri icin.
//   img-src github.com:       projects.js GitHub avatarini
//                             https://github.com/<user>.png adresinden ceker;
//                             bu adres avatars.githubusercontent.com'a
//                             redirect eder, o yuzden ikisi de listede.
//   img-src data:             2FA QR kodu data: URI olarak uretiliyor.
//   connect-src wss:          canli port/log WebSocket'leri.
// GitHub API cagrilari tarayicidan degil sunucudan yapilir; bu yuzden
// connect-src'de api.github.com yok.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: https://github.com https://avatars.githubusercontent.com",
  "connect-src 'self' wss:",
  "frame-ancestors 'self'"
].join("; ");

function securityHeaders(req, res, next) {
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), interest-cohort=()"
  );

  // HSTS yalnizca gercekten HTTPS ile servis edildigimiz kurulumda gonderilir
  // (public mod + base_domain => onunde TLS terminate eden reverse proxy var).
  // LAN/localhost kurulumu duz HTTP: tarayici HSTS'i HTTP uzerinde yok sayar
  // ama ayni host'a daha once HTTPS ile girilmisse istenmeyen kilitlenme
  // yaratabilir, o yuzden hic gondermiyoruz.
  if (config.isPublicAccessReady()) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  res.setHeader("Content-Security-Policy", CSP);
  next();
}

module.exports = securityHeaders;
