# Güvenlik Notları

Bu, [`SECURITY.md`](../SECURITY.md)'nin (raporlama ve tehdit modeli)
operatöre yönelik tamamlayıcısı. Burada varsayılanlar, sertleştirme
kolları ve kabul edilen riskler listelenir.

## Varsayılanlar

- **Sadece loopback bind.** `server.listen(PORT, "127.0.0.1")`. OS bunu
  socket seviyesinde uygular — hiçbir firewall delik açımı Lyra'yı
  public arayüze çıkarmaz.
- **Default kimlik yok.** Uygulama veritabanında bir admin kullanıcı
  oluşana kadar küçük allowlist (`/login`, `/healthz`,
  `/setup-status`, `/api/branding`) dışında hiçbir şeye servis vermez.
- **Güçlü şifre tabanı.** Setup ≥12 karakter ister. "Atla" yok.
- **2FA önerilir.** TOTP setup sırasında sunulur ve commit'lenmeden
  doğrulanır.
- **`0600` secret'lar.** SQLite veritabanı ve `.env` sahibi-okuyabilir
  izinle yazılır. `LYRA_HOME` dizini `0700`.
- **Session cookie'ler.** `httpOnly`, `sameSite=lax`. `secure` flag
  sadece base domain'li public mode'da set edilir (yani HTTP localhost
  geliştirme çalışır ama production HTTPS gerektirir).
- **Auto-ban.** On dakika içinde üç başarısız giriş (yapılandırılabilir)
  60 dakikalık (yapılandırılabilir) ban tetikler. RFC1918 aralıkları
  ve loopback whitelist edilir, böylece LAN'dan kendini kilitleyemezsin.
- **Sıfır dış origin.** Panel hiçbir CDN'e, font servisine veya
  analytics'e bağlanmaz: `marked` `public/vendor/` altında, fontlar
  `public/fonts/` altında self-hosted. CSP `default-src 'self'` ile
  bunu zorlar. Tek istisna, GitHub entegrasyonu açıkken yüklenen
  GitHub avatar görseli (`img-src`). Sonuç: internete kapalı bir
  sunucuda panel eksiksiz çalışır ve sayfa yüklemeleri üçüncü
  taraflara sızmaz.
- **HSTS sadece HTTPS'te.** `Strict-Transport-Security` yalnızca
  public mode + `base_domain` yapılandırıldığında gönderilir; düz HTTP
  LAN kurulumunda gönderilmez.
- **Kısıtlı sudoers.** Opsiyonel sudoers entry'si Lyra'nın ihtiyacı
  olan komutları whitelist'ler (`ss -tlnp`, cloudflared config
  yazma, cloudflared restart) — asla `NOPASSWD: ALL` vermez.

## Sertleştirme kolları

Çevirebileceğin kollar (hepsi `settings` tablosunda; uygulamak için
Lyra'yı yeniden başlat):

| Ayar                        | Sıkı           | Gevşek         |
|-----------------------------|----------------|----------------|
| `rate_limit_attempts`       | 3              | 10             |
| `rate_limit_window_minutes` | 30             | 5              |
| `auto_ban_after`            | 2              | 5              |
| `auto_ban_duration_minutes` | 1440 (bir gün) | 15             |
| `session_ttl_days`          | 1              | 90             |

Uygulamanın sağladığından **daha yüksek** taban istiyorsan, edge'de
rate limit'li bir reverse proxy (veya CDN) çalıştır.

## Lyra'nın YAPMADIĞI şeyler

- **Audit-log retention politikası yok.** `audit_log` tablosu sonsuza
  kadar büyür. Önemsiyorsan cron'la temizle:
  ```sql
  DELETE FROM audit_log WHERE ts < (strftime('%s', 'now', '-90 days') * 1000);
  ```
- **Otomatik sertifika yönetimi yok.** Lyra HTTP servisi verir. TLS,
  reverse proxy'nde (Cloudflare Tunnel, Caddy, nginx, Tailscale Funnel
  — senin seçimin) terminate olur.
- **Per-route CSRF token yok.** Same-site cookie + CORS-default-deny
  yaygın durumu korur. Lyra'yı üçüncü taraf bir origin'e mount etmek
  daha fazla iş ister.
- **Rest'te secret şifreleme yok — ve planlanmıyor.** Telegram bot
  token'ları, GitHub PAT'leri, Cloudflare API token'ları SQLite
  veritabanında plaintext yaşar. DB dosyası `0600` ve sadece Lyra
  kullanıcısı okuyabilir. Şifreleme eklenmedi çünkü anahtarın
  gidebileceği her yer (aynı DB, `LYRA_HOME` altında `0600` dosya,
  systemd `EnvironmentFile` → `/proc/<pid>/environ`) aynı kullanıcı
  tarafından okunabilir: DB'yi okuyabilen anahtarı da okur. Gerekçenin
  tamamı ve operatör sorumlulukları için
  [`SECURITY.md`](../SECURITY.md#entegrasyon-tokenları-restte-plaintext).
  Yedek alırken `LYRA_HOME`'u şifrelemek senin işin.

## Lyra'nın savunduğu tehditler

- **`/api/login`'a credential stuffing.** Rate limiter + auto-ban.
- **Public hostname'i tarayan bot.** Reverse proxy Lyra'nın önündedir;
  kötü IP'ler uygulama katmanında banlanır çünkü Cloudflare trafiği
  loopback üzerinden gelir (UFW tek başına bunu engelleyemez).
- **Ağ gözlemcisi tarafından session theft.** Proxy'de TLS + secure
  cookie + httpOnly.
- **Kötü origin'den CSRF.** SameSite=lax cookie cross-site form
  post'unu engeller.
- **Proje adı üzerinden path traversal.** Sıkı regex
  `^[a-zA-Z0-9_.-]+$`, `..` yok, slash yok.
- **Shell concatenation üzerinden code injection.** Git, ss,
  journalctl, systemctl, curl, caddy ve cloudflared CLI'ları
  `execFile`/`spawn` ve arg array ile çağrılır — kullanıcı ya da DB
  kaynaklı hiçbir değer shell-interpolated string'e girmez. Geriye
  kalan `execSync` çağrıları gerçekten pipe/redirect isteyen, sadece
  sabit stringlerden oluşan kurulum komutlarıdır.

## Lyra'nın savunmadığı tehditler

- **Tehlikeye girmiş bağımlılıklar.** `npm audit` arkadaşın; bağımlılık
  yüzeyini küçük tutuyoruz ama upstream maintainer'ları doğrulayamayız.
- **Host'ta shell'i olan kullanıcı.** SQLite DB ve `.env`'i doğrudan
  okur. Lyra unprivileged çalışır; shell-seviyesinde tehlike Lyra'nın
  kapsamı dışında kalan game-over.
- **Side channel'lar** (timing saldırıları, kernel exploit'leri,
  donanım bug'ları).
- **Fiziksel erişim.** Saldırgan single-user mode'a boot edebilirse
  dosya izinleri yardım etmez.

## Önerilen deployment

1. Lyra'yı unprivileged systemd servisi olarak çalıştır
   (`generate-systemd.js` default'u).
2. Önüne **Cloudflare Tunnel** (port forwarding yok, public IP yok,
   DDoS exposure yok) **veya** Tailscale Funnel **veya** Let's Encrypt
   ile Caddy reverse proxy koy.
3. Public erişim gerekmiyorsa LAN-only mode'da kal.
   `public_access=false` default'u Lyra'nın içindeki tüm reverse-proxy
   code path'ini atlar.
4. Setup'ta 2FA aktif et. Atlama.
5. GitHub PAT ve Cloudflare API token'ı yıllık (veya bilgi sahibi olan
   biri ekipten ayrılınca) rotate et.
6. `audit_log`'u tut ve ara sıra incele:
   ```sql
   SELECT datetime(ts/1000, 'unixepoch'), event_type, ip, details
     FROM audit_log
     WHERE event_type IN ('login_fail', 'ip_banned')
     ORDER BY ts DESC LIMIT 50;
   ```
7. Lyra repo'sundaki güvenlik advisory'lerine abone ol.
