# Lyra Kurulumu (detaylı)

Tek yol var: `install.sh`. Script sistemi hazırlar, systemd unit'i ve
sudoers dosyalarını sihirbazdan **önce** kurar, kurulum sihirbazını
kendisi bir systemd servisi olarak port 80'de yayına alır. Kısa özet
için [`../INSTALL.md`](../INSTALL.md)'ye bak; bu dosya aynı akışı daha
ayrıntılı anlatır.

## 1. Tek komut installer

```bash
git clone https://github.com/eminerolll/andromeda-lyra.git lyra
cd lyra
sudo ./install.sh
```

Repo'yu klonlamadan, tek satırda:

```bash
curl -fsSL https://raw.githubusercontent.com/eminerolll/andromeda-lyra/main/install.sh | sudo LYRA_REPO=https://github.com/eminerolll/andromeda-lyra.git bash
```

`curl | sudo bash` akışında stdin script'in kendisi olduğu için hiçbir
soru sorulmaz — script otomatik olarak `--non-interactive` gibi davranır.

Script sırasıyla:

1. Root / distro (`apt` + `systemd`) / mimari (`x86_64` ya da `aarch64`)
   kontrolü, hedef Linux kullanıcısının tespiti.
2. Sistem paketleri (`git curl ca-certificates iproute2 build-essential
   sudo`) + Node.js 20 (NodeSource) — eksikse kurar, varsa dokunmaz.
3. Kaynak kodu `/opt/lyra`'ya alır (yerel checkout'tan kopya, `git clone`
   veya mevcut repo'yu `git pull --ff-only` ile günceller).
4. `npm ci --omit=dev` (lock dosyası yoksa `npm install --omit=dev`).
5. `.env` üretir (`LYRA_HOME=/var/lib/lyra`, `LYRA_PORT`, `NODE_ENV`) —
   dosya zaten varsa **üzerine yazmaz**. Veri dizinini oluşturur.
6. DB migrasyonlarını çalıştırır.
7. systemd unit'i ve **kalıcı** sudoers dosyasını (`/etc/sudoers.d/lyra`)
   yazar — bu adım kurulum sihirbazından önce gelir, bilinçli sıralama.
8. Kurulum daha önce tamamlanmadıysa: kurulum modu systemd drop-in'i +
   **geçici** sudoers dosyası (`/etc/sudoers.d/lyra-setup`) + gerekiyorsa
   UFW'de sihirbaz portunu açar + `systemctl enable --now lyra`.
9. Kurulum token'i üretir, tarayıcı adresini ve token'ı ekrana basar.

Kurulum daha önce tamamlanmışsa (yönetici hesabı zaten var), script
sihirbazı atlar ve sadece repo'yu güncelleyip servisi yeniden başlatır —
yani `sudo ./install.sh` **güncelleme komutu olarak da idempotenttir.**

### Ortam değişkenleri

| Değişken | Varsayılan | Amaç |
|----------|------------|------|
| `LYRA_REPO` | — | git repo URL'i (yerel checkout yoksa zorunlu) |
| `LYRA_DIR` | `/opt/lyra` | kurulum dizini |
| `LYRA_BRANCH` | `main` | git branch |
| `LYRA_USER` | `$SUDO_USER` | Lyra'nın çalışacağı Linux kullanıcısı |
| `LYRA_HOME` | `/var/lib/lyra` | veri dizini (SQLite DB, oturumlar) |
| `LYRA_PORT` | `3000` | panel portu |
| `LYRA_SETUP_PORT` | `80` | kurulum sihirbazı portu (doluysa değiştir) |

Bayraklar: `-y` / `--yes` / `--non-interactive` (hiçbir şey sorma),
`-h` / `--help`.

## 2. Tarayıcıdaki sihirbaz

Script bittiğinde ekrana adres(ler) ve 1 saat geçerli bir kurulum
token'ı basar. Laptop tarayıcısında bu adresi aç, token'ı yapıştır.
Sihirbaz adımları:

1. **Token** doğrulama
2. **Erişim modu** — Public / LAN / Localhost / CF Tunnel / Manuel
3. **Bağlantı + panel** — moda göre domain+email ya da CF connector
   token'ı; ayrıca uygulama adı ve projeler dizini
4. **Yönetici hesabı** — kullanıcı adı, şifre (≥12 karakter), TOTP QR
5. **Servisler** — sunucuda tespit edilen servisler (code-server,
   dbgate, filebrowser, cloudflared, mongod, docker, …)
6. **Entegrasyonlar** (opsiyonel) — Telegram bot, GitHub token
7. **İlerleme** — Caddy/cloudflared kurulumu, firewall, restart; her
   adımın durumu `/api/setup/progress` üzerinden canlı gösterilir

Son adımda Lyra kurulum modu drop-in'ini ve geçici sudoers dosyasını
kendisi siler, `daemon-reload` yapar ve **kendini yeniden başlatır** —
tarayıcı bu sırada bağlantı kopmasını "yeniden başlıyor" olarak
yorumlar ve yeni adreste `/healthz` yanıt verene kadar bekler.

Bir adım başarısız olursa kurulum modu **açık bırakılır**, ekranda ne
yapılması gerektiği net şekilde yazar.

## 3. Erişim katmanları

Kurulumdan sonra üç servis (code-server, dosya yöneticisi, veritabanı
arayüzü) ve dev server portları **her zaman** path-tabanlı olarak
erişilebilir, domain olsun olmasın:

- `/code/` → code-server
- `/files/` → dosya yöneticisi (filebrowser)
- `/db/` → veritabanı arayüzü (dbgate)
- `/dev/<port>/` → o anda dinlenen bir dev server portu

Bu, domain gerektirmeyen **Katman 1**'dir (`lib/path-proxy.js`).
Sihirbazda bir `base_domain` girilirse, **ek olarak** host-tabanlı
subdomain katmanı (`lib/proxy.js`) devreye girer: `code.<domain>`,
`files.<domain>`, `db.<domain>` gibi. Domain katmanı path katmanını
**devre dışı bırakmaz** — ikisi birlikte çalışır.

`dev-<port>` subdomain'leri hiçbir modda üretilmez (port sayısı
sınırsız olabileceğinden); dev server önizlemesi her zaman
`/dev/<port>/` path'inden servis edilir.

## 4. Setup wizard'ın sorduğu değerler

- **Erişim modu** — Public / LAN / Localhost / CF Tunnel / Manuel
  (bkz. `../INSTALL.md` bölüm 4 için her modun ayrıntısı)
- **Domain + email** (Public modda) — Caddy + Let's Encrypt için
- **CF connector token** (CF Tunnel modda)
- **Uygulama adı** — UI marka etiketi
- **Projeler dizini** — varsayılan olarak Lyra'nın çalıştığı Linux
  kullanıcısının home'u önerilir, sihirbazda değiştirilebilir
- **Yönetici hesabı** — kullanıcı adı (≥3 karakter), şifre (≥12
  karakter), opsiyonel TOTP 2FA (QR + 6 haneli kod doğrulaması
  zorunlu, atlanamaz)
- **Servis tespiti** — Lyra sunucuda `code-server`, `cloudflared`,
  `filebrowser`, `dbgate`, `mongod`, `docker` arar; hangilerini
  kaydedeceğini sen seçersin
- **Opsiyonel entegrasyonlar** — Telegram bot, GitHub personal access
  token

### Terminal sihirbazı (headless)

`src/scripts/setup-cli.js` yukarıdaki **aynı** soruları terminalde sorar.
İki arayüz de `src/lib/setup-core.js` üzerinden çalışır:

| Ortak fonksiyon | Ne yapar |
|-----------------|----------|
| `validateFinalize` | Alan doğrulaması (mod, şifre uzunluğu, moda özel zorunlular, 2FA) |
| `ensureProjectsDir` | Projeler dizinini yaratır ve gerçekten yazma denemesi yapar |
| `cfPlanFromBody` / `cfPreflight` | Cloudflare token/zone/hesap doğrulaması, mevcut DNS kayıtlarını okuma, apex-mi-subdomain önerisi |
| `applyFinalize` | Settings + admin + servisler + entegrasyonlar + `system_ports` / `lyra_service_name` seed'i |
| `buildSteps` / `createProgress` / `runPostSetup` | Caddy / cloudflared / firewall / kurulum modundan çıkış adımları |

`routes/setup.js` bu fonksiyonların HTTP sarmalayıcısıdır; CLI ise
terminal sarmalayıcısı. Doğrulama veya seed kuralı değişirse ikisi
birden değişir — kopya yok (`test/setup-core.test.js` bunu doğrular).

Tek gerçek fark, kurulum modundan çıkışın kim tarafından tetiklendiğidir
(`runPostSetup`'ın `transition` seçeneği):

- **`self`** (tarayıcı) — sihirbazı Lyra'nın kendisi çalıştırıyor.
  `systemctl restart lyra` kendini öldüreceği için geçiş `systemd-run`
  ile bağımsız bir transient unit'e devredilir.
- **`direct`** (CLI) — sihirbaz ayrı bir process. Geçiş doğrudan
  yapılır ve servisin ayağa kalktığı doğrulanır.

2FA'da QR yerine TOTP secret'ı ve `otpauth://` URI'si terminale basılır;
interaktif modda kod doğrulanmadan 2FA açılmaz. Non-interactive modda
`--2fa` verilirse secret ekrana basılır (kaybedilirse
`lyra reset-admin --disable-2fa`); `--2fa`/`--no-2fa`'dan biri
**zorunludur**, varsayılana kaçılmaz.

Bayrakların tam listesi: `node scripts/setup-cli.js --help` ve
`../INSTALL.md` → "Headless kurulum".

## 5. Sudoers — iki dosya

- **`/etc/sudoers.d/lyra`** — kalıcı, dar kapsamlı. Port tarayıcı
  (`ss -tlnp`), Caddyfile/cloudflared config yazma, ilgili servisleri
  reload etme, kendi unit'ini restart etme. Blanket `NOPASSWD: ALL`
  yok. `install.sh` bunu sihirbazdan **önce** yazar.
- **`/etc/sudoers.d/lyra-setup`** — geçici, tam yetkili. Kurulum fazı
  Caddy/cloudflared'i apt+dpkg ile kurar, apt kaynak listesi ve GPG
  anahtarı yazar, firewall ve systemd'yi değiştirir. Sihirbaz bitince
  Lyra bu dosyayı kendisi siler. Kurulum yarıda kalırsa elle silinmeli:

```bash
sudo rm -f /etc/sudoers.d/lyra-setup
```

İçeriği yeniden üretmek istersen:

```bash
node /opt/lyra/src/scripts/generate-sudoers.js --print   # icerigi gor
sudo node /opt/lyra/src/scripts/generate-sudoers.js --user <kullanici>
```

## 6. Ban yönetimi

Başarısız girişlerden sonra otomatik IP ban devreye girer. Banlı
IP'leri görmek, elle ban eklemek/kaldırmak ve ban ayarlarını (eşik,
süre) değiştirmek için **SSH ya da DB erişimi gerekmez** — Lyra
dashboard'da **Ayarlar > Güvenlik** sekmesinden panelden yönetilir.

## 7. systemd servisi

```bash
sudo systemctl status lyra
sudo systemctl restart lyra
sudo journalctl -u lyra -f
```

Unit'i elden geçirmek istersen:

```bash
sudo node /opt/lyra/src/scripts/generate-systemd.js --print   # icerigi gor
sudo node /opt/lyra/src/scripts/generate-systemd.js \
  --user <kullanici> --workdir /opt/lyra/src \
  --home /var/lib/lyra --port 3000 --projects-dir /home/<kullanici>/projects
sudo systemctl daemon-reload && sudo systemctl restart lyra
```

## 8. `lyra` komutu

`install.sh` kurulumun sonunda `/usr/local/bin/lyra` symlink'ini
`src/bin/lyra.js`'e kurar. Komut yeni bir işlev eklemez; var olan
script'leri ve modülleri çağırır:

| Komut | Ne yapar | Nereye bağlanır |
|-------|----------|-----------------|
| `lyra status` | Servis durumu, sürüm, erişim modu, panel adresi, bind, DB boyutu, caddy/cloudflared durumu, kayıtlı servisler | `lib/health.js` + `db/repos/settings` |
| `sudo lyra update [--skip-pull]` | `git pull --ff-only` + `npm ci --omit=dev` + `npm run migrate` + `systemctl restart` + doğrulama | git / npm / `db/migrate.js` |
| `sudo lyra uninstall [--keep-data] [--yes]` | Kaldırma | `uninstall.sh` |
| `lyra reset-admin [...]` | Şifre / 2FA / ban sıfırlama | `scripts/reset-admin.js` |
| `lyra logs [args]` | Servis logları (varsayılan `-f`) | `journalctl -u lyra` |
| `lyra connect [...]` | Laptop tarafı SSH tunnel yardımcısı | `lyra-connect` |

Root gerektiren alt komutlar (`update`, `uninstall`) root olmadan
çalıştırılırsa ne yapılması gerektiğini söyleyip çıkar; yarım iş yapmaz.

`reset-admin`, root olarak çağrılsa bile servis kullanıcısına düşerek
çalışır — aksi hâlde SQLite'ın `-wal`/`-shm` yan dosyaları root'a ait
oluşup servisin yazmasını engellerdi.

## Güncelleme

```bash
sudo lyra update
```

Git deposunu `--ff-only` çeker, bağımlılıkları kurar, migrasyonları
çalıştırır, servisi yeniden başlatır ve **ayağa kalktığını doğrular**.
`.env` ve veritabanına dokunmaz.

**Git deposu yoksa** (kod elle kopyalanmışsa) `lyra update` bunu fark eder
ve sessizce yarım iş yapmak yerine durur:

```
✗ /opt/lyra bir git deposu degil — kod otomatik guncellenemez.
    Bu kurulum elle kopyalanmis (tar/scp/rsync).
    Yeni surumu ayni dizine kopyala, sonra:
      sudo lyra update --skip-pull
```

`--skip-pull` yalnızca kod çekme adımını atlar; `npm ci`, migrasyon ve
restart yine çalışır.

`install.sh` ile güncelleme de mümkün (unit ve sudoers dosyalarını da
yeniler):

```bash
cd /opt/lyra
sudo ./install.sh -y
```

Elle:

```bash
cd /opt/lyra && sudo -u <kullanici> git pull --ff-only
cd src && sudo -u <kullanici> npm ci --omit=dev
sudo -u <kullanici> npm run migrate          # idempotent
sudo systemctl restart lyra
```

## Kaldırma

```bash
sudo lyra uninstall               # listeler + onay ister
sudo lyra uninstall --keep-data   # /var/lib/lyra kalsın
sudo lyra uninstall --yes         # onay sorma
# lyra komutu yoksa:
sudo bash /opt/lyra/uninstall.sh
```

`uninstall.sh` silmeden **önce** ne silineceğini listeler ve onay ister
(`--yes` ile atlanır). Kaldırdıkları:

- `lyra.service` (durdurulur, disable edilir) + `.service.d/` drop-in dizini
- `/etc/sudoers.d/lyra` ve `/etc/sudoers.d/lyra-setup`
- `/usr/local/bin/lyra`
- Lyra'nın yazdığı UFW kuralları — **yalnızca** `lyra` / `lyra-setup`
  yorumu taşıyanlar. Başkasının kuralına dokunulmaz.
- `/opt/lyra` (kod) ve `/var/lib/lyra` (veri; `--keep-data` ile korunur)

Bilerek **dokunmadıkları** (silmiş gibi yapmak yerine listeler):

- Cloudflare tunnel'ı ve DNS kayıtları — uzaktaki kaynaklar, dashboard'dan sil
- `cloudflared` servisi → `sudo cloudflared service uninstall`
- Caddy ve `/etc/caddy/Caddyfile` → `sudo apt-get remove caddy`
- Projelerin durduğu dizin — asla silinmez
- Node.js ve apt paketleri

Ayrıca `LYRA_DIR` / `LYRA_HOME` `/`, `/etc`, `/usr`, `/var`, `/home`, `/opt`
gibi bir yola işaret ediyorsa script hiçbir şey silmeden durur.

Tamamen elle:

```bash
sudo systemctl disable --now lyra
sudo rm -f /etc/systemd/system/lyra.service
sudo rm -rf /etc/systemd/system/lyra.service.d
sudo rm -f /etc/sudoers.d/lyra /etc/sudoers.d/lyra-setup
sudo rm -f /usr/local/bin/lyra
sudo systemctl daemon-reload
sudo rm -rf /opt/lyra /var/lib/lyra
```
