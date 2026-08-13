# Lyra Kurulum

## Önkoşullar

- **Ubuntu 22.04+ / Debian 12+** (apt + systemd zorunlu)
- **x86_64 veya aarch64** (`better-sqlite3` ve NodeSource paketleri bu
  mimariler için)
- **root erişimi** (`sudo` ya da doğrudan root shell)
- Node.js, git, build-essential gibi paketleri **kendin kurmana gerek yok** —
  `install.sh` eksikse kurar.

---

## 1. Tek komut

```bash
git clone https://github.com/eminerolll/andromeda-lyra.git lyra
cd lyra
sudo ./install.sh
```

veya kodu klonlamadan:

```bash
curl -fsSL https://raw.githubusercontent.com/eminerolll/andromeda-lyra/main/install.sh | sudo LYRA_REPO=https://github.com/eminerolll/andromeda-lyra.git bash
```

> **Neden root?** Script sistem paketlerini kurar, `/opt/lyra`'ya yazar,
> systemd unit'i ve sudoers dosyasını oluşturur, servisi yönetir. Root
> olmadan çalıştırırsan hiçbir şey yapmadan doğru komutu söyleyip çıkar.

### Erişim yöntemi — kurulum bunu sana sorar

Paketler kurulduktan sonra, sihirbaz başlamadan önce tek bir soru gelir:

```
  Bu panele nasil erisecegini sec:

    1) Cloudflare domain'im var          (onerilen)
       API token + domain -> tunnel SIMDI kurulur, sihirbaz
       https://lyra.alanadin.com gibi bir adreste acilir.
       Hicbir port acilmaz; NAT/bulut firewall'u arkasinda da calisir.

    2) Bu makine disaridan erisilebilir
       Sihirbaz http://<ip>:80 adresinde acilir.

    3) Ne domain'im var ne de port acabiliyorum
       Sihirbaz burada, terminalde calisir (CLI).
```

Bu soru **gerçek bir kurulum hatasından** doğdu: Oracle Cloud / AWS / GCP /
Azure gibi sağlayıcılarda gelen portlar Security List / Security Group / NSG
katmanında varsayılan olarak kapalıdır. Makine içinde firewall kapalı olsa
bile `http://<ip>` dışarıdan açılmaz — kurulum sana erişemeyeceğin bir adres
vermiş olur.

`install.sh` bunu önceden anlamak için `169.254.169.254` metadata servisine
kısa (~1.5 sn) bir sorgu atar. Bulut tespit edilirse uyarır ve **2. seçeneği
varsayılan yapmaz**; ağ yoksa ya da cevap gelmezse sessizce eski davranışa
döner (fiziksel/ev sunucusunda 80 genelde açıktır).

**1. seçenekte** tunnel sihirbazdan **önce** kurulur: token ve domain doğrulanır,
tunnel + ingress + DNS oluşturulur, `cloudflared` servis olur. Token geçersizse
**hiçbir şey kurulmadan** hata verilir ve menüye dönülür — yarım kurulmuş sistem
kalmaz. Sonra sihirbaz `https://<panel-host>` üzerinde açılır ve Cloudflare
adımını atlar. Bu modda **port 80 hiç kullanılmaz**: sihirbaz Lyra'nın kendi
portunda (`3000`, `127.0.0.1`) çalışır, çünkü `cloudflared` zaten oraya bağlıdır.

Script bittiğinde ekrana şuna benzer bir kutu basar:

```
────────────────────────────────────────────────────────────
  Tarayicidan kuruluma devam et:

    https://lyra.alanadin.com          <- 1. secenek
    http://5.75.222.111                <- 2. secenek

  Kurulum token'i (tarayiciya yapistir):

    ABCD-EFGH-JKLM-NPQR
────────────────────────────────────────────────────────────
```

Bu adresi laptop'unun tarayıcısında aç, token'ı yapıştır, sihirbazı bitir.
(3. seçenekte tarayıcı yok — sihirbaz aynı terminalde başlar.)

### Ortam değişkenleri

| Değişken | Varsayılan | Açıklama |
|----------|------------|----------|
| `LYRA_REPO` | — | git repo URL'i. Yerel checkout içinden çalıştırıyorsan gerekmez. |
| `LYRA_DIR` | `/opt/lyra` | Kod dizini |
| `LYRA_BRANCH` | `main` | git branch |
| `LYRA_USER` | `$SUDO_USER` | Lyra'nın çalışacağı Linux kullanıcısı |
| `LYRA_HOME` | `/var/lib/lyra` | Veri dizini (SQLite DB, oturumlar) |
| `LYRA_PORT` | `3000` | Panel portu |
| `LYRA_SETUP_PORT` | `80` | Sihirbaz portu — **yalnızca 2. seçenekte** (80 doluysa değiştir) |
| `LYRA_CF_API_TOKEN` | — | 1. seçenekte Cloudflare API token'ı |

### Bayraklar

| Bayrak | Açıklama |
|--------|----------|
| `-y`, `--yes`, `--non-interactive` | Hiçbir şey sorma |
| `--access <cf-api\|direct\|cli>` | Erişim yöntemini sorma, doğrudan seç |
| `--domain <alan.adi>` | `cf-api` için Cloudflare'da kayıtlı zone |
| `--cf-api-token <token>` | API token (`LYRA_CF_API_TOKEN` env'i tercih edilir — bayrak `ps` çıktısında görünür) |
| `--cf-account-id <id>` | Token birden fazla hesaba erişiyorsa |
| `--cf-host-mode <apex\|subdomain>` | Panel apex'te mi alt alan adında mı |
| `--cf-panel-subdomain <ad>` | `subdomain` modunda panel adı (varsayılan: `lyra`) |
| `--cf-overwrite-dns` | Çakışan DNS kayıtlarının üzerine yaz |
| `--cf-tunnel-name <ad>` | Tunnel adı (varsayılan: `lyra-<domain>`) |
| `--cf-tunnel-existing <fail\|reuse\|recreate>` | Aynı **adda** tunnel varsa: dur (varsayılan) / devral / sil ve yeniden yarat |
| `--replace-cloudflared` | Sunucuda zaten bir `cloudflared` servisi varsa kaldırıp yenisini kur |
| `--help` | Yardım |

> **Yeniden kurulumda çıkan iki tuzak.** `lyra uninstall` sunucudaki
> `cloudflared` servisine ve Cloudflare hesabındaki tunnel'a **bilerek
> dokunmaz** (uzaktaki kaynağı sessizce silmiyoruz). Bu yüzden ikinci kurulumda:
>
> - Sunucuda duran `cloudflared` servisi `cloudflared service install`'ı
>   patlatır → `--replace-cloudflared` ver ya da önce
>   `sudo cloudflared service uninstall` çalıştır.
> - Aynı adda tunnel zaten vardır → `--cf-tunnel-existing reuse` ile devral,
>   `recreate` ile sil-yeniden yarat, ya da `--cf-tunnel-name` ile başka bir ad
>   kullan. Kopya tunnel **üretmiyoruz**.
>
> Tunnel'ın **aktif bağlantısı** varsa hiçbir bayrakla devralınmaz: o tunnel
> başka bir makinede canlı olabilir ve devralmak o sistemin erişimini keser.
> Önce oradaki `cloudflared`'i durdur.

Non-interactive kurulum örneği (bulut sunucu, tunnel ile):

```bash
sudo LYRA_CF_API_TOKEN="$CF_TOKEN" bash install.sh --yes \
  --access cf-api --domain ornek.com
```

Eksik bir alan varsa kurulum **hiç başlamadan** hangi bayrağın gerektiğini
söyleyip çıkar; varsayılana kaçmaz. `--access cli` interaktif terminal ister,
`--yes` ile birlikte kullanılamaz.

`curl | sudo bash` akışında stdin script'in kendisi olduğu için soru
sorulmaz — otomatik olarak non-interactive çalışır ve erişim yöntemi
`direct` olur (bugünkü davranış). Bulut tespit edilirse bu durumda da
uyarı basılır.

API token'ı `--cf-api-token` ile verirsen `install.sh` onu çocuk process'in
argümanına **koymaz**: `0600` geçici bir dosyaya yazıp yolunu geçirir ve
her durumda (hata/iptal dâhil) siler.

---

## 2. Kurulum ne yapar, nereye yazar

| Yol | İçerik |
|-----|--------|
| `/opt/lyra` | Kaynak kod (`src/` altında uygulama) |
| `/opt/lyra/src/.env` | Bootstrap ayarları (`LYRA_HOME`, `LYRA_PORT`, `NODE_ENV`), `0600`. Varsa **üzerine yazılmaz.** |
| `/var/lib/lyra` | SQLite DB + oturumlar, `0700`, Lyra kullanıcısına ait |
| `/etc/systemd/system/lyra.service` | Servis tanımı |
| `/etc/systemd/system/lyra.service.d/setup-mode.conf` | **Geçici** — kurulum modu drop-in'i (tunnel modunda sadece `LYRA_SETUP_MODE=1`; port geçişi ve `CAP_NET_BIND_SERVICE` yok) |
| `/etc/sudoers.d/lyra` | Kalıcı, dar kapsamlı sudo izinleri |
| `/etc/sudoers.d/lyra-setup` | **Geçici** — kurulum fazının tam yetkisi |
| `/usr/local/bin/lyra` | `src/bin/lyra.js`'e symlink (`lyra status/update/logs/uninstall`) |
| `<home>/projects` | Projeler dizini (sihirbazda değiştirilebilir) |

Sıralama bilinçli: **systemd unit ve sudoers, sihirbazdan önce** kurulur.
Sihirbaz bitince Lyra kurulum modu drop-in'ini ve geçici sudoers dosyasını
kendisi siler, `daemon-reload` yapar ve **kendini yeniden başlatır**. Yani
"kurulum bitti, birileri restart etsin" varsayımı yok.

`install.sh` idempotenttir: ikinci kez çalıştırdığında repo'yu günceller,
`.env` ve veritabanına dokunmaz, kurulum zaten tamamlanmışsa sihirbazı
atlayıp sadece servisi yeniden başlatır.

---

## 3. Tarayıcıdaki sihirbaz

| # | Adım | Açıklama |
|---|------|----------|
| 1 | **Token** | Terminalde gösterilen 16 karakterli token |
| 2 | **Erişim modu** | Public / LAN / Localhost / CF Tunnel / Manuel — *tunnel kurulumda hazırlandıysa bu adım atlanır ve "Cloudflare: yapılandırıldı ✓" gösterilir* |
| 3 | **Bağlantı + panel** | Mode'a göre domain+email veya CF token; ayrıca **uygulama adı** ve **projeler dizini** |
| 4 | **Yönetici hesabı** | kullanıcı adı + şifre (≥12) + TOTP QR |
| 5 | **Servisler** | Seç → Lyra **kurar** → panele bağlar (code-server varsayılan açık) |
| 6 | **Entegrasyonlar** | Telegram / GitHub token (opsiyonel) |
| 7 | **İlerleme** | Caddy/cloudflared, seçilen servislerin kurulumu, firewall, restart — **canlı adım listesi** |

### Servisler adımı

Lyra yönettiği servisleri kendisi kurar; SSH'a dönüp elle kurman gerekmez.

| Servis | Ne | RAM | Kurulum kaynağı |
|--------|-----|-----|-----------------|
| `code-server` | Tarayıcıda VS Code (`/code/`) | ~200 MB | [code-server.dev/install.sh](https://code-server.dev/install.sh) (resmi `.deb`) |
| `filebrowser` | Dosya yönetimi | ~30 MB | GitHub release tarball + Lyra'nın yazdığı systemd unit'i |
| `dbgate` | Veritabanı arayüzü | ~150 MB | `docker.io/dbgate/dbgate` + systemd unit'i (**Docker gerekir**) |
| `mongod` | MongoDB | ~500 MB | `repo.mongodb.org/apt` (mongodb-org 8.0) |

- **`code-server` varsayılan açık**, diğerleri kapalı.
- Zaten kurulu olan servis "kurulu" görünür ve **tekrar kurulmaz**.
- Sunucunun gerçek RAM/disk/mimari değerleri adımın başında yazar; seçim boş
  RAM'i aşarsa **uyarılırsın, engellenmezsin**.
- **arm64 (Oracle A1 gibi)**: dört servisin de arm64 paketi var. Desteklenmeyen
  bir mimaride seçenek **sebebiyle birlikte** devre dışı kalır, gizlenmez.
- **Docker otomatik kurulmaz**: yoksa `dbgate` devre dışı kalır ve sebebi yazar.
- Bir servisin kurulumu patlarsa **diğerleri ve kurulumun geri kalanı devam
  eder**; hata kendi adımında görünür.

> **Güvenlik:** kurulan her servis yalnızca `127.0.0.1`'e bind edilir ve kendi
> auth'u kapalıdır — dışarıya tek kapı Lyra'nın login + 2FA + ban katmanıdır.
> `mongod` yapılandırması değiştirilmez, yalnızca `bindIp` doğrulanır; loopback
> dışındaysa servis **başlatılmaz** ve durum bildirilir.

Son adım `/api/setup/progress`'i yoklar: her arka plan adımının durumunu
(bekliyor / çalışıyor / tamam / hata) gerçek hata mesajıyla gösterir.
Bir adım başarısız olursa **kurulum modu açık bırakılır** ve ekranda ne
yapılacağı yazar — "hazır ✓" deyip seni boşluğa yollamaz.

Yeniden başlatma sırasında tarayıcının bağlantısı kopar; bu hata değil,
"servis yeniden başlıyor" olarak gösterilir. Sihirbaz Lyra'nın yeni
adresinde `/healthz` yanıt verene kadar bekler, sonra yönlendirir.

### Projeler dizini

Sihirbaz projeler dizinini **sorar** ve Lyra'nın çalıştığı Linux
kullanıcısının home'unu önerir (panel kullanıcı adıyla ilgisi yok). Dizin
yoksa oluşturulur; yazılamıyorsa kurulum net bir hatayla durur.

---

## 4. Erişim modları

### 🌍 Public (VPS + domain)
- Önce DNS A kaydını sunucuya yönlendir: `lyra.example.com → <vps-ip>`
- Wizard'da domain + email gir; DNS otomatik doğrulanır
- **Caddy otomatik kurulur**, Let's Encrypt sertifikası alır
- UFW aktifse 80/443 açılır
- Final: `https://lyra.example.com`

**Servis subdomain'leri:** code-server / dosya yöneticisi / DB arayüzü için
Caddy `code.<domain>`, `files.<domain>`, `db.<domain>` blokları da üretir ve
her biri için ayrı sertifika ister. Sihirbaz bu kayıtları da kontrol eder ve
eksik olanları listeler. **Bu kayıtları Lyra oluşturmaz** — DNS
sağlayıcında kendin açmalısın. Eksik olanlar için sertifika alınamaz; apex
domain (panelin kendisi) etkilenmez, o çalışmaya devam eder. Kayıtları
sonradan eklersen:

```bash
sudo systemctl reload caddy
```

Servisler ayrıca domain gerektirmeyen path yollarından da erişilebilir
(`/code/`, `/files/`, `/dev/<port>/`).

### 🏠 LAN
- Lyra `0.0.0.0:3000`'e bind olur
- UFW aktifse Lyra portu **sadece sunucunun bağlı olduğu yerel ağlara**
  açılır (`ufw allow from <subnet> to any port 3000`)
- Erişim: `http://<sunucu-ip>:3000`

### 🔒 Localhost
- Lyra `127.0.0.1:3000`'e bind olur, firewall'a dokunulmaz
- Uzak sunucuysa SSH tünel:
  ```bash
  ssh -L 3000:127.0.0.1:3000 user@sunucu
  # tarayicida http://localhost:3000
  ```
- Laptop tarafı için `lyra-connect` script'i var

### ⚙️ Cloudflare Tunnel (NAT arkası / DDoS koruma)
- CF Dashboard: Zero Trust → Tunnels → Create
- Public hostname: `lyra.example.com → http://localhost:3000`
- Connector token'ı wizard'a yapıştır
- **cloudflared otomatik kurulur**, tunnel başlatılır
- Public IP gerekmez, firewall'da port açılmaz

### 🔧 Manuel
- Lyra `127.0.0.1:3000`'e bind olur, başka hiçbir şey yapmaz
- Önüne kendi nginx/traefik/HAProxy'ni koyarsın, TLS senin sorumluluğun

---

## 5. Sudo ve güvenlik

Lyra iki sudoers dosyası kullanır:

**`/etc/sudoers.d/lyra` (kalıcı, dar):** port tarayıcı (`ss -tlnp`),
Caddyfile/cloudflared config yazma, ilgili servisleri reload etme, kendi
unit'ini restart etme. Her satır sabit yollara bağlı; blanket `NOPASSWD: ALL`
**yok**.

**`/etc/sudoers.d/lyra-setup` (geçici, tam yetki):** kurulum fazı Caddy ve
cloudflared'i apt/dpkg ile kurar, apt kaynak listesi ve GPG anahtarı yazar,
firewall ve systemd'yi değiştirir. Bunları komut listesiyle daraltmak
anlamsız (`apt-get install *` zaten tam root'tur), o yüzden kurulum fazı
**açıkça ayrıcalıklı** ve kısa ömürlüdür: sihirbaz bitince Lyra dosyayı
siler. Normal mode ilk açılışında da bir temizlik denemesi yapılır.

Kurulumu yarıda bırakırsan dosya geride kalır — elle sil:

```bash
sudo rm -f /etc/sudoers.d/lyra-setup
sudo rm -f /etc/systemd/system/lyra.service.d/setup-mode.conf
sudo systemctl daemon-reload && sudo systemctl restart lyra
```

systemd unit'inde `ProtectHome` **bilinçli olarak yok**: Lyra projeler
dizinine repo klonlar, commit atar, `.env` ve not dosyası yazar.
`NoNewPrivileges` de yok — setuid `sudo` onun altında çalışmaz, o zaman port
tarayıcı ve reverse proxy yönetimi ölürdü. `ProtectSystem=full` duruyor;
`/var/lib/lyra`, `/etc/caddy`, `/etc/cloudflared` ve projeler dizini
`ReadWritePaths` ile yazılabilir tutulur.

---

## 6. Servis komutları

`install.sh` kurulum sırasında `/usr/local/bin/lyra` symlink'ini oluşturur.
Günlük işler bu komutla yapılır:

```bash
lyra status                  # servis durumu, erişim modu, panel adresi, DB boyutu
lyra logs                    # journalctl -u lyra -f
lyra logs -n 100 --no-pager  # ekstra argümanlar journalctl'e geçer
sudo lyra update             # kod + bağımlılık + migration + restart
sudo lyra update --skip-pull # kodu sen kopyaladın, git'e dokunma
lyra reset-admin             # şifre / 2FA / ban sıfırlama
lyra connect <user@host>     # laptop tarafı SSH tunnel yardımcısı
sudo lyra uninstall          # kaldırma (aşağıya bak)
lyra --help
```

`lyra` komutu yeni bir işlev eklemez; mevcut script'leri ve modülleri çağırır
(`lib/health.js`, `scripts/reset-admin.js`, `uninstall.sh`, `lyra-connect`).
Root gerektiren alt komutları (`update`, `uninstall`) root olmadan
çalıştırırsan ne yapman gerektiğini söyleyip çıkar.

Doğrudan systemd ile:

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

Sudoers dosyasını yeniden üretmek için:

```bash
sudo node /opt/lyra/src/scripts/generate-sudoers.js --print   # icerigi gor
sudo node /opt/lyra/src/scripts/generate-sudoers.js --user <kullanici>
```

---

## Headless kurulum (terminal sihirbazı)

Tarayıcıya hiç erişemiyorsan (kapalı ağ, SSH-only, otomasyon) sihirbazın
terminal sürümü aynı işi yapar. Tarayıcı sihirbazıyla **aynı soruları** sorar
ve **aynı kodu** çalıştırır: doğrulama, Cloudflare ön-kontrolü, veritabanı
seed'i ve kurulum sonrası adımlar `src/lib/setup-core.js` içinde ortaktır.
İki ayrı kurulum gerçekliği yok.

En kolay yolu kurulum sırasında **3. seçeneği** işaretlemektir: `install.sh`
sihirbazı orada, o terminalde başlatır — kopyalayacağın komut yok.

Sonradan çalıştırmak istersen: `install.sh` 1. ya da 2. seçenekle çalıştıysa
Lyra kurulum modunda bir portu tutuyordur; önce onu durdur:

```bash
sudo systemctl stop lyra
cd /opt/lyra/src
sudo -u <kullanici> LYRA_HOME=/var/lib/lyra node scripts/setup-cli.js
```

Tunnel kurulumda hazırlandıysa terminal sihirbazı da erişim modu adımını
atlar ve "Cloudflare: yapilandirildi" der.

Yerel bir checkout'tan:

```bash
npm run setup -- --cli
```

Sihirbaz sırayla: erişim modu → moda özel alanlar (domain/e-posta, CF token)
→ uygulama adı + projeler dizini → yönetici hesabı (şifre ≥ 12) → 2FA →
servisler → entegrasyonlar → özet + onay. QR kod yerine TOTP secret'ı ve
`otpauth://` URI'si terminale basılır; kodu doğrulamadan 2FA açılmaz.

### Tam non-interactive (Ansible, cloud-init, CI)

```bash
sudo -u <kullanici> LYRA_HOME=/var/lib/lyra \
  LYRA_ADMIN_PASSWORD='cok-uzun-bir-sifre' \
  node /opt/lyra/src/scripts/setup-cli.js --yes \
    --mode cf-api --domain ornek.com --cf-api-token "$CF_TOKEN" \
    --app-name "Lyra" --projects-dir /home/<kullanici>/projects \
    --user admin --no-2fa
```

| Bayrak | Açıklama |
|--------|----------|
| `--yes`, `-y`, `--non-interactive` | Hiçbir şey sorma |
| `--mode` | `public` \| `lan` \| `localhost` \| `cf-tunnel` \| `cf-api` \| `manual` |
| `--domain`, `--email` | `public` için zorunlu (`--domain` `cf-api` için de) |
| `--cf-token` | `cf-tunnel` connector token'ı |
| `--cf-api-token`, `--cf-api-token-file`, `--cf-account-id` | `cf-api` API token'ı (`LYRA_CF_API_TOKEN` env'i ya da `0600` dosya tercih edilir) / hesap seçimi |
| `--cf-host-mode`, `--cf-panel-subdomain`, `--cf-overwrite-dns` | Panel apex'te mi alt alan adında mı, DNS çakışması yönetimi |
| `--cf-tunnel-name`, `--cf-tunnel-existing <fail\|reuse\|recreate>` | Tunnel adı; aynı adda tunnel varsa davranış (varsayılan `fail` — dur). Aktif bağlantılı tunnel hiçbir değerde devralınmaz |
| `--replace-cloudflared` | Sunucuda duran `cloudflared` servisini kaldırıp yenisini kur (verilmezse kurulum durur) |
| `--app-name`, `--projects-dir` | Zorunlu |
| `--user`, `--password` | Zorunlu (`LYRA_ADMIN_PASSWORD` env'i tercih edilir — komut satırı `ps` çıktısında görünür) |
| `--2fa` / `--no-2fa` | **Biri zorunlu.** `--2fa` verilirse secret ekrana basılır ve 2FA açılır; kaybedersen `lyra reset-admin --disable-2fa` |
| `--services a,b` / `--no-services` | Panelde yönetilecek servisler (`code-server,filebrowser,dbgate,mongod`). Kurulu olmayanları Lyra **kurar**; kurulu olanı tekrar kurmaz. Bu makinede kurulamayan bir servis verilirse kurulum **başlamaz** ve sebep yazılır |
| `--telegram-token`, `--telegram-chat-id`, `--github-token` | Opsiyonel entegrasyonlar |

Eksik zorunlu alan varsa kurulum **başlamaz**; hangi bayrağın eksik olduğu tek
tek yazılır. Sessizce varsayılana kaçılmaz. Tam liste:
`node scripts/setup-cli.js --help`.

> CLI sihirbazı kurulum sonrası geçişi (drop-in silme, `daemon-reload`,
> `systemctl restart lyra`) **kendisi** yapar ve sonucu doğrular — tarayıcı
> modundaki `systemd-run` gecikmesi burada gerekmez, çünkü sihirbaz servisin
> kendisi değil ayrı bir process'tir.

`npm run setup` (tarayıcı modu) hâlâ çalışır ama sihirbazı ön planda
başlatır; port 80 için `sudo` ister ve sonundaki restart adımı ancak systemd
unit'i kuruluysa iş görür. Önerilen yol `install.sh`. (Tunnel önceden
kurulduysa `npm run setup` de port 80 istemez: Lyra'nın kendi portunu kullanır.)

### Sadece tunnel kurulumu

`install.sh`'in 1. seçenekte çalıştırdığı adım tek başına da çağrılabilir —
sihirbazın Cloudflare adımıyla **aynı kodu** kullanır:

```bash
sudo -u <kullanici> LYRA_HOME=/var/lib/lyra \
  node /opt/lyra/src/scripts/setup-cli.js --provision-tunnel
```

Token/zone doğrulanır, tunnel + ingress + DNS kurulur, `cloudflared` servis
olur ve `access_mode`, `base_domain`, `panel_host`, `public_access` ayarları
yazılır. Doğrulama başarısız olursa **hiçbir kalıcı ayar yazılmaz**. Sonrasında
her iki sihirbaz da bu adımı atlar.

---

## Ayarları sonradan değiştirme

Setup sonrası Lyra dashboard'da **sağ üstteki dişli ikonuyla** Settings
modal'ını aç. 6 sekme:

- **Genel**: app adı, projeler dizini, ikincil disk
- **Erişim**: bind address, public mode, base domain, subdomain'ler
- **Servisler**: kayıtlı systemd unit'leri ekle/sil/aktif et
- **Güvenlik**: rate limit, ban ayarları, session TTL
- **Entegrasyonlar**: Telegram, GitHub, Cloudflare token'ları
- **Hesap**: şifre değiştir, 2FA aç/kapat

`bind_address` veya `public_access` değişirse Lyra restart ister.

---

## Güncelleme

```bash
sudo lyra update
```

Git deposunu `--ff-only` çeker, `npm ci --omit=dev` çalıştırır,
migration'ları uygular ve servisi yeniden başlatıp ayağa kalktığını doğrular.
`.env` ve veritabanına dokunmaz.

**Kodu elle kopyaladıysan (tar/scp/rsync — git deposu yok):** `lyra update`
bunu fark eder ve yarım iş yapmaz; çekilecek remote olmadığını söyleyip çıkar.
Yeni sürümü aynı dizine kopyaladıktan sonra:

```bash
sudo lyra update --skip-pull
```

Bu, kod çekme adımını atlar; bağımlılıklar, migration ve restart yine çalışır.

`install.sh` ile de güncellenebilir (unit ve sudoers dosyalarını da yeniler):

```bash
cd /opt/lyra
sudo ./install.sh -y
```

Elle yapmak istersen:

```bash
cd /opt/lyra && sudo -u <kullanici> git pull --ff-only
cd src && sudo -u <kullanici> npm ci --omit=dev
sudo -u <kullanici> npm run migrate          # idempotent
sudo systemctl restart lyra
```

---

## Kaldırma

```bash
sudo lyra uninstall              # ne silineceğini listeler, onay ister
sudo lyra uninstall --keep-data  # /var/lib/lyra (DB, oturumlar) kalsın
sudo lyra uninstall --yes        # onay sorma
```

`lyra` komutu yoksa doğrudan: `sudo bash /opt/lyra/uninstall.sh`

Kaldırılanlar: systemd unit'i + drop-in dizini, `/etc/sudoers.d/lyra` ve
`lyra-setup`, `/usr/local/bin/lyra`, Lyra'nın yazdığı UFW kuralları (yalnızca
`lyra` / `lyra-setup` etiketli olanlar), `/opt/lyra`, `/var/lib/lyra`.

**Bilerek dokunulmayanlar** — script bunları siler gibi yapmaz, sadece
listeler:

- Cloudflare tunnel'ı ve DNS kayıtları (uzaktaki kaynaklar; dashboard'dan sil)
- `cloudflared` servisi → `sudo cloudflared service uninstall`
- Caddy paketi ve `/etc/caddy/Caddyfile` → `sudo apt-get remove caddy`
- Projelerin durduğu dizin — **asla silinmez**
- Node.js ve apt paketleri

Tamamen elle yapmak istersen:

```bash
sudo systemctl disable --now lyra
sudo rm -f /etc/systemd/system/lyra.service
sudo rm -rf /etc/systemd/system/lyra.service.d
sudo rm -f /etc/sudoers.d/lyra /etc/sudoers.d/lyra-setup
sudo rm -f /usr/local/bin/lyra
sudo systemctl daemon-reload
sudo rm -rf /opt/lyra /var/lib/lyra
```

---

## Sorun Giderme

| Sorun | Çözüm |
|-------|-------|
| `install.sh` "root olarak calismali" | `sudo ./install.sh` |
| Tarayıcıya hiç erişemiyorum | Kurulumu tekrar çalıştırıp **3. seçeneği** (terminal sihirbazı) ya da **1. seçeneği** (Cloudflare tunnel) seç. Kurulum yarıdaysa: `sudo systemctl stop lyra` sonra `cd /opt/lyra/src && sudo -u <kullanici> LYRA_HOME=/var/lib/lyra node scripts/setup-cli.js` |
| Bulut sunucuda `http://<ip>` açılmıyor | Beklenen: Oracle/AWS/GCP/Azure gelen portları **sağlayıcı tarafında** kapalı tutar. Ya Security List / Security Group / NSG'de 80'i aç, ya da kurulumu 1. (tunnel) ya da 3. (CLI) seçenekle tekrarla. `ufw` burada yeterli değildir. |
| `lyra: command not found` | Symlink kurulmamış: `sudo ln -sfn /opt/lyra/src/bin/lyra.js /usr/local/bin/lyra && sudo chmod +x /opt/lyra/src/bin/lyra.js` |
| `lyra update` "git deposu degil" dedi | Kurulum elle kopyalanmış. Yeni sürümü aynı dizine kopyala, sonra `sudo lyra update --skip-pull` |
| "apt tabanli dagitimlar icindir" | Desteklenmeyen distro. Hiçbir değişiklik yapılmadı, elle kurulum gerekir. |
| Port 80 bind hatası | Başka web server çalışıyor (nginx/Apache). Durdur ya da `sudo LYRA_SETUP_PORT=8080 ./install.sh` |
| Tarayıcıda sayfa açılmıyor | Firewall. `sudo ufw status` → `sudo ufw allow 80/tcp`. Bulut sağlayıcının security group'unu da kontrol et. |
| Token'ı kaybettim | `cd /opt/lyra/src && sudo -u <kullanici> node -e 'const t=require("./lib/setup-token");const k=t.generate();t.save(k);console.log(k)'` |
| Servis ayağa kalkmıyor | `sudo journalctl -u lyra -n 100 --no-pager` |
| Sihirbaz "Kurulum yarım kaldı" dedi | Ekrandaki komutları uygula; ayarların ve yönetici hesabın kaydedilmiştir. |
| Kurulum modundan çıkmadı | `sudo rm -f /etc/systemd/system/lyra.service.d/setup-mode.conf && sudo systemctl daemon-reload && sudo systemctl restart lyra` |
| Port tablosu boş | `sudo node /opt/lyra/src/scripts/generate-sudoers.js --user <kullanici>` |
| Projeler dizinine yazılamıyor | Sihirbaz zaten uyarır. Sahiplik: `sudo chown -R <kullanici>: <dizin>` |
| "IP banlandi" + giriş yok | `sudo -u <kullanici> sqlite3 /var/lib/lyra/lyra.db "DELETE FROM bans;" && sudo systemctl restart lyra` |
| DB içeriğini görmek | `sudo -u <kullanici> sqlite3 /var/lib/lyra/lyra.db ".tables"` |
| Public mode'da Caddy cert alamıyor | DNS hâlâ yayılmıyor olabilir; bekle (max 30dk). `sudo journalctl -u caddy -f` |
| `code.<domain>` çalışmıyor | O subdomain için A kaydı yok. Kaydı ekle, `sudo systemctl reload caddy`. Bu arada `/code/` yolu çalışır. |
| CF Tunnel "connector unhealthy" | Connector token doğru mu? `sudo systemctl status cloudflared` |
