# Lyra Deployment Senaryoları

Hangi sunucuda, hangi ağ koşulunda Lyra'yı nasıl yayına alacaksın? Dört
ana senaryo + her birinin adımları. Kurulumun kendisi (`install.sh`)
her senaryoda aynı; farklı olan tek şey sihirbazda seçtiğin **erişim
modu**. Ayrıntılı kurulum akışı için [`install.md`](./install.md).

> Tüm senaryolarda kodu sunucuya kendin getirirsin (`git clone` veya
> `LYRA_REPO=` ile `install.sh`'a bırakırsın). Bu doc, `install.sh`
> bittikten sonra tarayıcıdaki sihirbazda hangi seçimleri yapman
> gerektiğini anlatır.

---

## Senaryo 1: VPS + kendi domain'in (en yaygın)

**Sen kimsin?** Hetzner / DigitalOcean / Linode'dan VPS aldın. Public
IP'n var. Senin ya da kuruluşunun bir domain'i var.

**Sonuç:** `https://lyra.sendomain.com` — TLS otomatik (Caddy +
Let's Encrypt).

### Adımlar

```bash
# 1. DNS panelinde A record ekle (sunucu kurulumundan ÖNCE):
#    lyra.sendomain.com  A  <vps-public-ip>

# 2. SSH ile sunucuya bağlan
ssh ubuntu@<vps-public-ip>

# 3. Kurulum — tek komut, sistem paketlerini de kendisi kurar
git clone https://github.com/eminerolll/andromeda-lyra.git lyra && cd lyra
sudo ./install.sh
```

Script bittiğinde terminalde **token** ve sunucu adresini gösterir:
```
http://<vps-public-ip>
Token: ABCD-EFGH-JKLM-NPQR
```

Laptop'unda tarayıcı aç, `http://<vps-public-ip>` git, token gir.
Wizard:
- Erişim modu: **🌍 Public**
- Domain: `lyra.sendomain.com`
- Email: `you@sendomain.com`
- Lyra DNS doğrulamasını yapar (eşleşmezse uyarır, "yine de devam et"
  seçeneği vardır)
- Admin user + 2FA
- Servisler

Wizard "Kurulumu Tamamla" sonrası:
1. Caddy kurulur (official Caddy apt repo'sundan)
2. Caddyfile yazılır — apex domain + tespit edilen servisler için
   `code.<domain>`, `files.<domain>`, `db.<domain>` blokları
   (**wildcard sertifika kullanılmaz**; her host HTTP-01 ile kendi
   sertifikasını alır, bu yüzden bilinen subdomain'ler tek tek
   listelenir):
   ```
   { email you@sendomain.com }
   lyra.sendomain.com { reverse_proxy localhost:3000 }
   code.sendomain.com { reverse_proxy localhost:3000 }
   ```
3. Caddy reload → Let's Encrypt cert'leri alınır
4. Lyra kurulum modundan çıkar, kendini yeniden başlatır, normal
   mode'a geçer (`127.0.0.1:3000`)

Tarayıcıda `https://lyra.sendomain.com` açıp login olursun.

**Not:** DNS'te henüz kaydı olmayan bir subdomain varsa (örn.
`db.sendomain.com` A kaydı eksik) o subdomain için sertifika alınamaz,
ama apex domain (panelin kendisi) etkilenmeyip çalışmaya devam eder —
eksik olan servise domain olmadan da `/db/` path'inden erişilebilir
(bkz. "Path-tabanlı erişim" altbaşlığı). Kaydı sonradan eklersen:
```bash
sudo systemctl reload caddy
```

### Bakım

- Cert otomatik yenilenir (Caddy yapar)
- Log: `sudo journalctl -u caddy -f` veya Lyra **Loglar** sekmesi
- DNS değişimi: `lyra → ayarlar → erişim` sekmesinden domain güncelle

---

## Senaryo 2: Ev/ofis sunucusu (NAT arkası, public IP yok)

**Sen kimsin?** Mini-PC / NUC / Pi'da Lyra çalıştırmak istiyorsun. Ev
ağında, public IP'n yok ya da port forward açmak istemiyorsun.

**İki çözüm var:**

### 2a. LAN-only (en basit)

Sadece ev ağındaki cihazlarından erişeceksen:

```bash
# 1. Kurulum
git clone https://github.com/eminerolll/andromeda-lyra.git lyra && cd lyra
sudo ./install.sh
# 2. Tarayıcıda: Erişim modu → 🏠 LAN
```

Lyra `0.0.0.0:3000`'e bind olur (UFW aktifse sadece sunucunun bağlı
olduğu yerel ağa açılır). Ev ağındaki herhangi bir cihaz tarayıcıdan
`http://<sunucu-lan-ip>:3000` ile erişir.

### 2b. Cloudflare Tunnel — otomatik (API token ile) ← önerilen

Evden çıktığında da erişmek istiyorsan. Cloudflare panelinde elle iş yok:
bir API token + domain verirsin, tunnel'ı, yönlendirmeyi ve DNS kayıtlarını
Lyra kendisi oluşturur.

**Önkoşul**: Cloudflare hesabın + Cloudflare'de DNS'i barındırılan bir domain.

#### API token oluştur

Cloudflare → **My Profile → API Tokens → Create Token → Create Custom Token**.

| Alan | Değer |
|------|-------|
| Permissions | `Account` · `Cloudflare Tunnel` · **Edit** |
| Permissions | `Zone` · `DNS` · **Edit** |
| Permissions | `Zone` · `Zone` · **Read** |
| Account Resources | Include → hesabın |
| Zone Resources | Include → ilgili domain |

Token'ı kopyala. Lyra token'ı `integrations` tablosunda saklar; log'lara veya
hata mesajlarına yazmaz.

#### Sunucu hazırlığı

```bash
git clone https://github.com/eminerolll/andromeda-lyra.git lyra && cd lyra
sudo ./install.sh
```

#### Setup wizard

- Erişim modu: ☁️ **Cloudflare Tunnel — otomatik (API token ile)**
- API token + domain (zone apex, örn. `sendomain.com`)
- **Cloudflare'i Kontrol Et** → token/hesap/zone doğrulanır ve **mevcut DNS
  kayıtları okunur**

Lyra sırayla:

1. Token'ı doğrular, hesabı ve zone'u bulur
2. `lyra-<domain>` adında **remotely-managed** bir tunnel oluşturur ve connector
   token'ı API'den alır
3. Ingress yazar — sıralı liste, **son eleman her zaman catch-all**:
   `*.sendomain.com` → `http://localhost:3000`, `sendomain.com` →
   `http://localhost:3000`, `http_status:404`
4. DNS kayıtlarını yazar: apex ve `*` için proxied `CNAME →
   <tunnel-id>.cfargotunnel.com`
5. `cloudflared`'i kurar ve connector token'ı **stdin'den** vererek servisi
   başlatır (token journald'a düşmez)

Wildcard kaydı `code.`, `files.`, `dev-3000.` gibi alt adreslerin çalışması
için gerekli.

#### Mevcut DNS kaydı varsa (sık karşılaşılan tuzak)

Domain'in apex'inde eski hosting sağlayıcısından kalmış bir `A` kaydı olabilir.
Bu durumda tunnel CNAME'i oluşturulamaz ve tarayıcı sebebi belirsiz bir
**`523 origin unreachable`** alır.

Lyra bunu **DNS yazmadan önce** tespit eder ve sihirbazda hangi kaydın, hangi
tipte, nereye işaret ettiğini gösterir. Onay olmadan hiçbir kayıt silinmez veya
değiştirilmez. İki seçenek sunulur:

- **Alt alan kullan** (varsayılan öneri): apex'e hiç dokunulmaz, panel
  `lyra.sendomain.com` adresinde açılır. `*` wildcard kaydı yine yazıldığı için
  servis alt adresleri çalışmaya devam eder.
- **Üzerine yaz**: onay kutusunu işaretlersen mevcut kayıt tunnel CNAME'i ile
  değiştirilir (aynı isimde fazladan kayıt varsa onlar silinir).

`base_domain` her iki durumda da domain'in kendisidir; `panel_host` panelin
gerçekte durduğu adrestir.

### 2c. Cloudflare Tunnel — connector token (ileri seçenek)

Tunnel'ı ve public hostname'leri Cloudflare dashboard'da kendin yönetmek
istiyorsan. Lyra sadece cloudflared'i kurup verdiğin token ile başlatır.

**Önkoşul**: Cloudflare hesabın + bir domain'in (Cloudflare'de DNS hosted).

#### Sunucu hazırlığı

```bash
git clone https://github.com/eminerolll/andromeda-lyra.git lyra && cd lyra
sudo ./install.sh
```

#### CF Dashboard'da tunnel oluştur

1. Cloudflare Dashboard → **Zero Trust** → **Networks** → **Tunnels**
2. **Create a tunnel** → **Cloudflared** → ad ver → **Save**
3. **Connector token**'ı kopyala (uzun base64 string)
4. **Public Hostname** ekle:
   - Subdomain: `lyra`
   - Domain: `sendomain.com`
   - Service: `HTTP` `localhost:3000`
   - Save

#### Setup wizard

Tarayıcıda:
- Erişim modu: ⚙️ **Cloudflare Tunnel**
- Connector token: yapıştır
- Admin user...

Lyra:
1. cloudflared'i kurar
2. `cloudflared service install <token>` çalıştırır
3. Tunnel aktif olur, public IP gerekmez, firewall'da port açılmaz

`https://lyra.sendomain.com` → Cloudflare → tunnel → sunucudaki Lyra.

---

## Senaryo 3: Sadece SSH'lı uzak sunucu (paranoid mod)

**Sen kimsin?** Public erişim istemiyorsun. Sadece sen kullanacaksın.

```bash
# Kurulumda: Erişim modu → 🔒 Localhost
```

Lyra `127.0.0.1:3000`'e bind olur, firewall'a dokunulmaz. İnternet'ten
erişilemez.

**Erişim için iki yöntem:**

### Saf SSH

```bash
# Laptop'undan
ssh -L 3000:127.0.0.1:3000 ubuntu@<sunucu-ip>
# Tarayıcı: http://localhost:3000
# (SSH oturumu açık olduğu sürece çalışır)
```

### `lyra-connect` helper script (önerilen)

Repo kökündeki `lyra-connect` script'ini laptop'una indirir, bir kez
kurarsın:

```bash
# Laptop'unda (tek seferlik kurulum)
curl -o ~/.local/bin/lyra-connect <raw-lyra-connect-url>
chmod +x ~/.local/bin/lyra-connect

# Sunucunu kaydet (bir kez)
lyra-connect add hetzner ubuntu@5.75.222.111

# Her gün kullan
lyra-connect hetzner
```

Tarayıcı otomatik açılır (`http://localhost:3000`). Ctrl+C ile tunnel
kapanır, sunucu yine kapalı.

---

## Senaryo 4: Var olan reverse proxy / orchestration

**Sen kimsin?** Zaten nginx/traefik/Caddy/HAProxy çalıştırıyorsun.
Lyra'yı kendi proxy'nde upstream olarak istiyorsun.

```bash
# Kurulumda: Erişim modu → 🔧 Manuel
```

Lyra `127.0.0.1:3000`'e bind olur, başka hiçbir şey yapmaz. Önüne
istediğin proxy'yi koy:

### nginx örneği

```nginx
server {
  listen 443 ssl http2;
  server_name lyra.sendomain.com;
  ssl_certificate     /etc/letsencrypt/live/lyra.sendomain.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/lyra.sendomain.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
```

### Traefik dynamic config örneği

```yaml
http:
  routers:
    lyra:
      rule: "Host(`lyra.sendomain.com`)"
      service: lyra
      entrypoints: [websecure]
      tls:
        certResolver: letsencrypt
  services:
    lyra:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:3000"
```

---

## Path-tabanlı erişim (her senaryoda çalışır)

Domain kurmadan ya da domain katmanındaki bir subdomain eksikken bile,
code-server / dosya yöneticisi / veritabanı arayüzü ve dev server
portları Lyra'nın kendi portu üzerinden path ile erişilebilir:

- `/code/` → code-server
- `/files/` → dosya yöneticisi
- `/db/` → veritabanı arayüzü
- `/dev/<port>/` → dinlenen bir dev server portu

Bu katman domain/subdomain katmanına **ek** olarak her zaman açıktır;
Senaryo 1'deki subdomain bloklarından biri sertifika alamasa da o
servise path üzerinden erişim kesilmez.

---

## Hangisini seçmeli?

| Senaryo | Sunucu | Domain | Kullanım |
|---------|--------|--------|----------|
| 1 — VPS + Caddy | VPS, public IP | var | en yaygın, en kolay |
| 2a — LAN | Ev sunucusu | yok | sadece ev ağında |
| 2b — CF Tunnel (API) | NAT arkası | var (CF'te) | uzaktan erişim + DDoS koruma, sıfır elle iş |
| 2c — CF Tunnel (token) | NAT arkası | var (CF'te) | tunnel'ı kendin yönetmek istiyorsan |
| 3 — Localhost + SSH | herhangi | yok | sadece sen, max güvenlik |
| 4 — Manuel | herhangi | var | zaten kurulu proxy var |

---

## Yaygın sorunlar

### "DNS doğrulanamadı"
A record yayılması 5-30 dk alır. Tekrar dene veya "Yine de devam et".
Caddy yine de cert almayı dener; başarısız olursa log'larda görürsün.

### "80 portu kullanımda"
Başka bir web server (nginx/Apache) çalışıyor. Ya onu durdur ya
`sudo LYRA_SETUP_PORT=8080 ./install.sh` ile kurulum sihirbazı portunu
değiştir ya da **Manuel mod** seç.

### Caddy cert alamıyor
- DNS gerçekten doğru mu? `dig +short lyra.sendomain.com`
- 80 portu açık mı? Let's Encrypt HTTP-01 challenge için gerekli.
- Rate limit'e takıldıysan (LE 50/hafta limit) staging cert'i dene.
- Sertifika alınamayan servise path üzerinden (`/code/`, `/files/`,
  `/db/`) erişim yine de çalışır.

### CF Tunnel "connector unhealthy"
- Token doğru mu yapıştırdın?
- `sudo systemctl status cloudflared`
- `sudo journalctl -u cloudflared -f`

### CF Tunnel: tarayıcı `523 origin unreachable` diyor
Neredeyse her zaman DNS: istediğin isim tunnel'a değil başka bir yere işaret
ediyor. Cloudflare Dashboard → DNS'te kaydı kontrol et; tunnel için beklenen
`CNAME <isim> → <tunnel-id>.cfargotunnel.com` (proxied).

Otomatik modda (2b) Lyra bu çakışmayı kurulum sırasında zaten gösterir ve onay
istemeden mevcut kaydı değiştirmez — o ekranda "üzerine yaz" seçilmediyse kayıt
eski haliyle durur.

### CF Tunnel: ingress yazıldı ama etkisi yok
Tunnel **remotely-managed** değilse (`config_src: local`) cloudflared kendi
`config.yml`'ini okur, API'ye yazılan ingress yok sayılır. Kontrol:
`GET /accounts/<acc>/cfd_tunnel/<tun>/configurations` cevabında
`result.source` alanı `cloudflare` olmalı. Lyra'nın oluşturduğu tunnel'lar
`config_src: cloudflare` ile açılır.

### SSH tunnel çalışmıyor
- Sunucuda Lyra gerçekten 127.0.0.1:3000'de mi? `ss -tlnp | grep 3000`
- Local 3000 portu boş mu? `lsof -i :3000`
- Farklı port: `ssh -L 3001:127.0.0.1:3000 ...`

### IP banlandı, giremiyorum
SSH'a gerek yok — bir yönetici hesabıyla girebiliyorsan **Ayarlar >
Güvenlik** sekmesinden banı kaldır. Hiç giremiyorsan (ör. kendi IP'n
banlı):
```bash
sudo -u <kullanici> sqlite3 $LYRA_HOME/lyra.db "DELETE FROM bans;"
sudo systemctl restart lyra
```

---

## Migrate / mod değiştirme

Setup sonrası modu değiştirmek için **Ayarlar → Erişim** sekmesini
kullan. Lyra restart ister, ama Caddy/cloudflared kurulumlarını
bozmaz — devre dışı bırakırsın.

```bash
# CLI ile mod değiştirme:
sqlite3 $LYRA_HOME/lyra.db
sqlite> UPDATE settings SET value='"0.0.0.0"' WHERE key='bind_address';
sqlite> .quit
sudo systemctl restart lyra
```
