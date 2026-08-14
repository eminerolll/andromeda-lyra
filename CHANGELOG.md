# Değişiklik Günlüğü

Bu projedeki tüm kayda değer değişiklikler bu dosyada belgelenir.

Biçim [Keep a Changelog](https://keepachangelog.com/tr/1.1.0/) temel alınarak
hazırlanmıştır ve proje [Semantic Versioning](https://semver.org/lang/tr/)
kurallarına uyar.

## [0.1.1] - 2026-08-14

### Düzeltildi

- `uninstall.sh` stdin bir terminal değilken onay sormadan siliyordu. `[[ -t 0 ]] || ASSUME_YES=1` satırı TTY yokluğunu otomatik onay sayıyordu; "önce silinecekler listesini bir göreyim" niyetiyle `bash uninstall.sh < /dev/null` çalıştıran kullanıcı listeyi görüp arkasından gerçek silmeyi de alıyordu. Artık TTY yoksa script hata verip açık onay istiyor: otomasyon zaten `--yes` ile çalıştığı için hiçbir kullanım kapanmıyor, kazara silme kapanıyor. Regresyon `test/scripts.test.js` → "uninstall.sh onay kapisi" ile kilitlendi (hem metin hem gerçek çalıştırma).

## [0.1.0] - 2026-08-14

İlk yayınlanan sürüm. Ubuntu 20.04 ve 22.04 üzerinde, Docker konteynerinde,
WSL2'de ve gerçek bir Oracle Cloud VM'inde uçtan uca doğrulandı.

### Eklendi

#### Kurulum

- `install.sh` ile tek komutla kurulum: root ister, Node 20 ve derleme araçlarını kendisi kurar, kodu `/opt/lyra`'ya yerleştirir, idempotent çalışır.
- `.env` (`0600`, üç bootstrap anahtarı) ve `/var/lib/lyra` (`0700`) üretimi; systemd unit'i ve sudoers dosyası sihirbazdan önce kurulur.
- Erişim yöntemi kurulumun **başında** sorulur: `cf-api` (Cloudflare domain), `direct` (`http://<ip>`), `cli` (terminal sihirbazı).
- `lib/cloud-detect.js`: Oracle, AWS (IMDSv2), GCP ve Azure metadata servislerini imza doğrulamalı tespit eder; bulut algılanırsa `direct` varsayılan olmaz ve kapalı gelen port uyarısı basılır.
- Tarayıcı tabanlı kurulum sihirbazı: token doğrulama, admin oluşturma, 2FA, servis seçimi, DNS kontrolü, canlı adım takibi (`GET /api/setup/progress`) ve gerçek hata gösterimi.
- `dns-check.checkAll` apex ve subdomain kayıtlarını denetleyip eksikleri açıkça listeler.
- `lib/firewall.js` ile UFW kural yönetimi (kurulu değilse no-op).
- Sihirbaz bitince Lyra kendi kendine normal moda geçer (`systemd-run --on-active` transient unit'i).
- Üç dağıtım yolu belgelendi: SSH tüneli, kendi ters proxy'n (nginx/Caddy) ve Cloudflare Tunnel.
- `lyra-connect`: laptop tarafında SSH tüneli açıp tarayıcıyı başlatan yardımcı script (`add`/`list`/`remove` ile kayıtlı sunucular).

#### Cloudflare otomasyonu

- Bir API token + bir domain ile tam otomasyon: zone keşfi, tunnel oluşturma, wildcard ingress, DNS CNAME kayıtları, `cloudflared` indirme ve servis kurulumu — Cloudflare panelinde tek tık gerekmez.
- Tunnel `config_src: "cloudflare"` ile uzaktan yönetilen olarak oluşturulur; yerel `config.yml` ile çelişki oluşmaz.
- Hesap kimliği zone cevabından türetilir; token'ın `Account Settings: Read` iznine ihtiyacı yoktur (`Account > Cloudflare Tunnel > Edit` + `Zone > DNS > Edit` yeterli).
- DNS çakışma koruması üç katmanlı: `upsertDnsRecord` içinde tespit, `/api/setup/cf-preflight` ön kontrolü ve sihirbaz arayüzünde ayrı onay kutusu. Mevcut apex ve `www` kayıtları onaysız değiştirilmez.
- `cloudflared` servis çakışması tespiti (`detectService`): unit var mı, aktif mi, hangi tunnel'a bağlı — kontrol Cloudflare'de hiçbir kaynak yaratılmadan önce yapılır.
- `resolveTunnel`: aynı adlı tunnel bulunduğunda devral / yeniden oluştur / durdur kararı. Aktif bağlantısı olan tunnel hiçbir bayrakla devralınamaz.
- Kurulum zinciri yarıda kalırsa geride kalan kaynaklar (tunnel, DNS kayıtları, servis) somut temizleme adresleriyle raporlanır; otomatik geri alma bilinçli olarak yoktur.
- Tunnel sekmesi üç modlu (`detectMode()`): **API** (ingress ve DNS Cloudflare API üzerinden), **Local** (`/etc/cloudflared/config.yml`), **Remote** (salt-okunur, Mod A'ya yükseltme yolu açıklanır).
- Tunnel sekmesinden hostname eklendiğinde ingress kuralı ve DNS kaydı birlikte açılır; catch-all kural listenin sonunda kalır, panel host'u ve wildcard kaydı korumalıdır.

#### Servisler

- Servisler sihirbazdan kurulabilir: `code-server` (resmî `.deb`), `filebrowser` (GitHub release tarball), `dbgate` (Docker imajı), `mongod` (apt 8.0) — amd64 ve arm64 için.
- Her servisin RAM ve disk gereksinimi gerçek değerlerle gösterilir; seçim boş RAM'i aşarsa uyarır, engellemez.
- Desteklenmeyen mimaride seçenek gizlenmez, sebebiyle birlikte devre dışı bırakılır.
- Kısmi başarısızlık izole edilir: her servis ayrı adımdır ve yalnızca başarılı kurulum `services` tablosuna yazılır.
- Kurulum sonrası servis eklemek için `sudo lyra install-service <tip>` (ayrı root process, systemd namespace mirası almaz).
- Servis kurulumları erişim katmanından önce çalışır, böylece bilinen subdomain'ler Caddyfile'a girer.

#### Panel

- Yedi sekme: Projeler, Portlar, Git, Ortam, Loglar, Docker (opsiyonel), Tunnel (opsiyonel).
- Projeler: GitHub repo klonlama, şablondan oluşturma (Node, Python, React, Next), favori, yeniden adlandırma, silme, code-server'da açma.
- Portlar: çalışan dev portlarının canlı listesi (proje / RAM / uptime), tek tıkla açma, takılan process'i durdurma.
- Git: status, log, diff, pull/push/commit/checkout ve İngilizce + Türkçe git çıktısı için conflict tespiti.
- Ortam: proje `.env` dosyaları (monorepo destekli) ve global ortam değişkenleri.
- Loglar: kayıtlı her systemd unit için canlı `journalctl` akışı.
- `lib/path-proxy.js`: `/code/`, `/files/`, `/db/` ve `/dev/{port}/` yolları domain olmadan çalışır; WebSocket dalı dahil.
- Ban yönetim paneli (`GET/POST/DELETE /api/bans`) — kilitlenen kullanıcı SSH'a gerek kalmadan kurtulabilir.
- Sistem Durumu ve Olay Geçmişi panelleri panele bağlandı.

#### Yapılandırma ve kimlik doğrulama

- SQLite (WAL) tabanlı yapılandırma: `settings`, `services`, `users`, `sessions`, `bans`, `audit_log`, `integrations`. Varsayılan konum `/var/lib/lyra/lyra.db` (`0600`).
- `.env` yalnızca bootstrap için üç anahtar tutar: `LYRA_HOME`, `LYRA_PORT`, `NODE_ENV`.
- Şifre (≥12 karakter) + opsiyonel TOTP 2FA; varsayılan kimlik bilgisi yoktur, admin oluşturulana kadar uygulama hizmet vermez.
- Başarısız girişlerden sonra otomatik IP ban (eşik ve süre yapılandırılabilir); `requireAuth` ve WebSocket upgrade yolunda `api_unauth` sayacı.
- Oturumlar aynı SQLite veritabanında saklanır; çerez `httpOnly`, `sameSite=lax` ve yalnızca public modda `secure`.

#### Komut satırı

- `lyra` komutu: `status`, `update`, `uninstall`, `reset-admin`, `logs`, `install-service`, `connect`, `version`.
- `lyra update` `.git` bulunmayan kurulumda yarım iş yapmayı reddeder ve `--skip-pull` yolunu gösterir.
- `lyra reset-admin` root'ken servis kullanıcısına düşer, böylece `-wal`/`-shm` dosyaları root sahipli kalmaz.
- Headless kurulum (`scripts/setup-cli.js`): interaktif mod (tarayıcıyla aynı sorular, terminalde TOTP secret + `otpauth://` URI) ve tam non-interactive mod (`--mode`, `--domain`, `--user` …; eksik alanları topluca listeleyip reddeder).
- Sihirbazın tüm mantığı `src/lib/setup-core.js`'te toplandı; CLI ve tarayıcı aynı fonksiyonları çağırır ve bunu doğrulayan bir test vardır.
- `uninstall.sh`: silinecekleri listeler, onay ister (varsayılan hayır), `--keep-data` ile veriyi korur, `/`, `/etc`, `/opt` gibi yolları reddeder; Cloudflare kaynaklarına, Caddy'ye ve projeler dizinine dokunmaz, yalnızca bildirir.

#### Proje altyapısı

- AGPL-3.0 lisansı.
- Dokümantasyon: `README.md`, `INSTALL.md`, `CONTRIBUTING.md`, `SECURITY.md` ve `docs/` altında architecture, install, configuration, deployment, security.
- 335 birim testi (vitest), ESLint, Prettier ve shellcheck.
- GitHub Actions CI: Node 20.x + 22.x matrisi, lint + format check + test.

### Düzeltildi

- Servis kurulumu systemd sandbox'ına takılıyor, `code-server` ve `filebrowser` "Read-only file system" ile patlıyordu; kurulum drop-in'ine her iki erişim dalında da `ProtectSystem=off` kondu (normal unit `ProtectSystem=full` kalır, drop-in sihirbaz bitince silinir).
- Servis kayıtlı değilken `code.<domain>` isteği sessizce dashboard'a düşüyordu; host yolu artık path-proxy'nin kendi route tanımını kullanıyor ve iki yoldan dönen 503 bayt bayt aynı. Kayıtsız servisin arayüzdeki linki artık `href` üretmiyor.
- 2FA QR kodu adımın ilk açılışında görünmüyordu (yalnızca `change` olayına bağlıydı); onay kutusu kapatılıp açıldığında yeni secret üretilmiyor.
- Servis kurulum hataları kullanılamaz haldeydi — `summarizeOutput()` ANSI ve `\r` gürültüsünü ayıklıyor, son 20 anlamlı satırı ve 2000 karakter sınırını uyguluyor; tam çıktı `lyra logs` ile journal'da kalıyor.
- code-server WebSocket'i 1006 ile kopuyordu: `changeOrigin: true` `Host`'u `127.0.0.1:8080` yaptığı için code-server `Origin` karşılaştırmasında upgrade'i reddediyordu. Yönetilen servisler artık orijinal `Host`'u görüyor, `dev-{port}` önizlemeleri `127.0.0.1`'e yazılıyor.
- Yeniden kurulumda sistemde duran `cloudflared.service` yüzünden `cloudflared service install` patlıyor ve kurulum yarıda kalıyordu.
- Tunnel adı çakıştığında rastgele son ekli kopya tunnel üretiliyor, başarısız denemeler hesapta ölü tunnel bırakıyordu.
- `install.sh`, `uninstall.sh`, `lyra-connect` ve `src/bin/lyra.js` depoya `100644` olarak işlenmişti (Windows'ta `core.filemode=false`); klonlayan kullanıcı `sudo ./install.sh` deyince "command not found" alıyordu → `100755`.
- `systemd-run --on-active=3` çağrısı `AccuracySec` belirtmediği için timer 3–63 saniye arasında tetikleniyor, başarılı kurulum "başarısız" raporlanabiliyordu → `AccuracySec=1s` ve bekleme süresi 90 saniye.
- Dar kapsamlı Cloudflare token'larında `GET /accounts` sessizce boş dönüyor ve kullanıcı var olmayan bir izin sorununu düzeltmeye yönlendiriliyordu.
- `NoNewPrivileges=yes` setuid `sudo`'yu engellediği için systemd altında port tarama ve proxy yönetimi çalışmıyordu; direktif kaldırıldı.
- Public modda Caddy hiçbir zaman kurulamıyordu (sihirbaz port 80'i tutarken postinst servisi başlatmaya çalışıyor); kurulum boyunca `systemctl mask caddy` uygulanıyor.
- Wildcard ingress kaydı silinmek istendiğinde "korumalı kayıt" yerine "geçersiz hostname" hatası dönüyordu; `isValidHostname()` artık `*.<domain>` biçimini kabul ediyor.
- Ingress ile DNS arasında büyük/küçük harf ayrışması vardı; `normalizeHostname()` dispatcher seviyesinde her iki modda uygulanıyor.
- Kimliksiz istek code-server subdomain'ine yönlendiriliyordu, artık apex'e gidiyor.
- `GET /api/setup/system-user` gerçek Linux kullanıcısı yerine yanlış değer döndürüyordu.
- `uninstall.sh` içindeki çıplak `daemon-reload` hatası `set -e` altında scripti yarıda kesiyordu.
- Auto-ban, `audit.countSince` IP filtresi olmadığı için masum IP'leri banlayabiliyordu (migration `002_audit_ip_index.sql`).
- LAN modunda proxy erken `return` yüzünden tamamen kapalıydı; code-server terminali ve LSP için gereken WebSocket dalı eksikti.
- WebSocket hata işleyicisi sokete HTTP gövdesi yazıyordu; handshake tamamlanmadıysa 502 satırı yazılıp destroy, 101 sonrası yalnızca destroy uygulanıyor.
- `.gitattributes` yokken `core.autocrlf=true` ile bir sonraki klonda tüm dosyalar CRLF'ye dönüşecek ve `install.sh` `bad interpreter: ^M` ile ölecekti; `* text=auto eol=lf` eklenip 47 dosya normalize edildi.
- `test/setup.js` modül cache temizliği `/src/` dizin adı literaline bağlıydı ve farklı adlı dizinde sahte `UNIQUE constraint` hataları üretiyordu.

### Güvenlik

- Notlar sekmesinde stored XSS kapatıldı: klonlanan bir repo `.notes.md` içinde ham HTML veya `javascript:` URL'i gönderebiliyordu. `marked` renderer'ı override edildi — `html` escape ediliyor, `link`/`image` yalnızca `http(s)`, `mailto`, `#` ve göreli yollara izin veriyor.
- Klonlanan repo veya sistem çıktısı kontrolündeki diğer alanlar escape edildi: commit mesajları ve branch adları, `ss` çıktısındaki process adları, attribute içine basılan servis adları, projeler, ayarlar ve docker görünümleri. Beş kopya `escapeHtml` tekilleştirildi.
- Cloudflare connector token'ı `sudo` argv'si üzerinden journald'a düz metin yazılıyordu; token artık stdin'den geçiriliyor.
- Cloudflare API token'ı yalnızca `Authorization` başlığında taşınıyor ve ağ hatası mesajları token'a karşı temizleniyor (`scrub`); `install.sh` yolunda token `mktemp` ile üretilen `0600` dosyadan okunuyor, argv'ye ve child env'ine girmiyor.
- Kurulan her servis yalnızca `127.0.0.1`'e bind ediliyor ve kendi auth'unu kapatıyor; dışarıya tek kapı Lyra'nın login + 2FA + ban katmanı. Üretilen yapılandırmalarda `0.0.0.0` bulunamayacağı testle kilitli.
- `mongod` yapılandırması değiştirilmiyor, `bindIp` doğrulanıyor; loopback dışındaysa servis başlatılmıyor ve sebep raporlanıyor.
- Kalıcı sudoers girdisi (`/etc/sudoers.d/lyra`) yalnızca gereken komutları sabit yollar ve dar wildcard'larla whitelist'liyor; `cp * /etc/cloudflared/config.yml` kaldırıldı.
- Kurulum fazı için yazılan geçici `/etc/sudoers.d/lyra-setup` sihirbaz bitince siliniyor; kurulum yarıda kalırsa elle silinmesi gerektiği belgelendi.
- Dış CDN bağımlılığı kaldırıldı: `marked` vendor'landı (sha256 kayıtlı), fontlar `latin` + `latin-ext` alt kümesiyle gömüldü; CSP'den jsdelivr, Google Fonts ve `api.github.com` çıkarıldı.
- HSTS yalnızca `public_access` ve `base_domain` ayarlıyken gönderiliyor.
- Kabuk ayrıştırmasını devre dışı bırakmak için `lib/caddy.js`, `lib/health.js` ve `routes/logs.js` `execFile`'a çevrildi.
- Entegrasyon token'ları bilinçli olarak şifrelenmiyor; anahtarı saklayacak ikinci bir güven alanı olmadığı için yanıltıcı vaatler kaldırılıp gerekçe `SECURITY.md` ve `docs/security.md`'ye yazıldı.

[0.1.1]: https://github.com/eminerolll/andromeda-lyra/releases/tag/v0.1.1
[0.1.0]: https://github.com/eminerolll/andromeda-lyra/releases/tag/v0.1.0
