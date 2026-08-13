# Konfigürasyon Referansı

Lyra'nın iki katmanı var: bootstrap için minik `.env` ve geri kalan her
şey için SQLite veritabanı.

## `.env`

Process başında bir kez okunur. Setup wizard tarafından otomatik
oluşturulur.

| Anahtar      | Default     | Zorunlu | Notlar                                  |
|--------------|-------------|---------|------------------------------------------|
| `LYRA_HOME`  | `./data`    | evet    | mutlak yol önerilir (`/var/lib/lyra`)    |
| `LYRA_PORT`  | `3000`      | evet    | bind portu (sadece loopback)             |
| `NODE_ENV`   | `production`| hayır   | `development` ayrıntılı log açar         |

`.env`'in tamamı bu. İçindeki başka her şey görmezden gelinir.

## SQLite tabloları

### `settings`

Key-value store. Anahtarlar (`lib/config.js`'te tanımlı):

| Anahtar                     | Tip     | Default                          | Amaç                                  |
|-----------------------------|---------|----------------------------------|----------------------------------------|
| `app_name`                  | string  | `"Andromeda"`                    | UI brand etiketi                       |
| `base_domain`               | string  | `null`                           | örn. `"example.com"`; public için zorunlu |
| `public_access`             | bool    | `false`                          | reverse proxy ve subdomain ingress'i aktif eder |
| `subdomain_code`            | string  | `"code"`                         | code-server subdomain                  |
| `subdomain_files`           | string  | `"files"`                        | filebrowser subdomain                  |
| `subdomain_db`              | string  | `"db"`                           | dbgate subdomain                       |
| `subdomain_dev_pattern`     | string  | `"dev-{port}"`                   | dev preview pattern (`{port}` placeholder) |
| `projects_dir`              | string  | `~/projeler`                     | git repo'ların klonlandığı yer         |
| `secondary_disk`            | string  | `null`                           | system tab için opsiyonel `/mnt/data` benzeri yol |
| `prod_apps_dir`             | string  | `null`                           | set edilince Docker tab aktif olur     |
| `session_ttl_days`          | int     | `30`                             | session cookie max age                 |
| `rate_limit_attempts`       | int     | `5`                              | pencere başına max login denemesi      |
| `rate_limit_window_minutes` | int     | `15`                             | rate limit penceresi                   |
| `auto_ban_after`            | int     | `3`                              | ban'dan önceki başarısız giriş sayısı  |
| `auto_ban_window_minutes`   | int     | `10`                             | başarısız girişlerin sayım penceresi   |
| `auto_ban_duration_minutes` | int     | `60`                             | otomatik ban süresi                    |
| `pinned_projects`           | array   | `[]`                             | en üste sabitlenen proje isimleri      |
| `global_env`                | object  | `{}`                             | `{key: {value, sensitive}}`            |
| `system_ports`              | array   | `[22, 53, 80, 443, 631]`         | "sistem" sayılan ekstra portlar        |
| `hidden_processes`          | array   | `["sshd", "systemd", ...]`       | user-port listesinden gizlenen process'ler |
| `cf_protected_hosts`        | array   | otomatik `code.<base>`           | UI'dan silinemeyen CF ingress kayıtları |
| `cloudflared_config_path`   | string  | `/etc/cloudflared/config.yml`    | tunnel config konumu                   |
| `cloudflared_backup_dir`    | string  | `/etc/cloudflared`               | yazım öncesi backup yeri               |
| `cloudflared_cert_path`     | string  | `/root/.cloudflared/cert.pem`    | `cloudflared route dns` için           |
| `cloudflared_enabled`       | bool    | `false`                          | `cf` tab'ını gösterir; setup ayarlayabilir |
| `lyra_service_name`         | string  | `null`                           | log akışı için systemd unit adı        |
| `session_secret`            | string  | random 32B hex                   | satırı silerek rotate edilir           |

### `services`

Her satır Lyra'nın bildiği bir kayıtlı systemd unit'i.

```sql
id INTEGER PRIMARY KEY,
unit_name TEXT UNIQUE,         -- "code-server"
display_name TEXT,             -- "Code Server"
type TEXT,                     -- "code-server" | "filebrowser" | ...
port INTEGER,                  -- 8080
subdomain TEXT,                -- "code"  (sadece public mode'da anlamlı)
enabled INTEGER,               -- 0 / 1
config TEXT,                   -- JSON, servise özel
created_at INTEGER
```

Reverse proxy `code.<base_domain>` → `type="code-server"`'in ilk
enabled satırı olarak çözer.

### `users`

Tek kullanıcı bekleniyor, ama şema birden fazlasına izin veriyor.

```sql
id, username, password_hash, totp_secret, totp_enabled,
created_at, last_login_at
```

### `bans`

```sql
ip TEXT PRIMARY KEY,
reason, banned_at, expires_at, banned_by
```

`expires_at NULL` = kalıcı. Hızlı request-yolu kontrolleri için
başlangıçta memory `Set`'ine yüklenir.

### `audit_log`

```sql
id, ts, event_type, ip, user_id, details
```

`event_type` değerleri: `login_success`, `login_fail`, `ip_banned`,
`ip_unbanned`, `setting_change`, ...

### `integrations`

Her entegrasyon adı için JSON config'le düz key-value:

```sql
name TEXT PRIMARY KEY,         -- "telegram" | "github" | "cloudflare"
enabled INTEGER,
config TEXT,                   -- JSON, plaintext (DB 0600)
updated_at
```

v1'de config plaintext saklanır; DB dosyası `0600`. v2 yol haritasında
`LYRA_SECRET_KEY`'den türetilen anahtarla simetrik şifreleme var.

## Ayarları düzenleme

Üç seçenek:

1. **Dashboard > Ayarlar** (önerilen) — sağ üstteki dişli ikonu. Altı
   sekme: Genel, Erişim, Servisler, Güvenlik, Entegrasyonlar, Hesap.
   Path, port, domain, servisler, ban listesi ve token'lar buradan
   yönetilir. `bind_address` veya `public_access` değişirse Lyra
   restart ister.

   > Kurulum sihirbazı **tekrar çalıştırılamaz** — admin kullanıcı
   > oluşturulduktan sonra kapanır. Sıfırdan kurmak için
   > `/var/lib/lyra/lyra.db` silinip `install.sh` yeniden çalıştırılmalı.
2. **Doğrudan SQL** (ileri kullanıcılar için):
   ```bash
   sqlite3 $LYRA_HOME/lyra.db
   sqlite> UPDATE settings SET value='"newvalue"' WHERE key='app_name';
   sqlite> .quit
   sudo systemctl restart lyra
   ```
   Değerler JSON-encoded; string'leri tırnak içine al.
3. **Dashboard UI** — yakında. Settings modal şu an sadece GitHub
   token, şifre değiştirme ve 2FA gösteriyor.

## Hostname yönlendirmesi

Public mode'da yönlendirme mantığı:

```
host = req.headers.host (lowercase, port çıkar)
suffix = "." + base_domain
host suffix ile bitmiyorsa: ana Lyra app'e geç
sub = host[:-len(suffix)]

sub == subdomain_code:        → type=code-server'in ilk enabled servisi
sub == subdomain_files:       → ilk enabled filebrowser servisi
sub == subdomain_db:          → ilk enabled dbgate servisi
sub subdomain_dev_pattern'a uyuyorsa: → URL'deki port
aksi: ana app'e geç
```

Bu `lib/proxy.js:findTargetPort()`'da implement edilmiş.

## Proxy `Host` başlığı politikası

Lyra iki proxy katmanı çalıştırır (host tabanlı `lib/proxy.js`, path tabanlı
`lib/path-proxy.js`). İkisi de yukarı akıma giden `Host` başlığını **hedefin
türüne göre** farklı ele alır:

| Hedef | Giden `Host` | Neden |
|-------|--------------|-------|
| Yönetilen servisler (code-server, filebrowser, dbgate) | Tarayıcının gönderdiği orijinal `Host` (`code.alanadi.com`, `alanadi.com:3000` …) | code-server WebSocket upgrade'ini CSRF'e karşı `Origin` ≟ `Host` karşılaştırmasıyla korur |
| Dev server önizlemeleri (`dev-{port}.alanadi.com`, `/dev/{port}/`) | `127.0.0.1:{port}` olarak yeniden yazılır | Vite/webpack-dev-server gelen `Host`'u `allowedHosts` listesine karşı doğrular |

### Neden yönetilen servislerde `Host` korunur

code-server'ın WebSocket route'u `ensureOrigin` middleware'i ile korunuyor
(`coder/code-server`, `src/node/http.ts`). `authenticateOrigin()` şunu yapar:

```
origin = new URL(req.headers.origin).host
host   = Forwarded: host=…  ||  X-Forwarded-Host  ||  Host
host !== origin  →  403 Forbidden
```

`Host`'u `127.0.0.1:8080`'e yeniden yazan bir proxy'de tarayıcı
`Origin: https://code.alanadi.com` gönderirken code-server `127.0.0.1:8080`
görür; upgrade reddedilir. Düz HTTP istekleri `Origin` taşımadığı için arayüz
sorunsuz yüklenir — belirti yalnızca terminal/LSP açılırken ortaya çıkar:

```
The workbench failed to connect to the server
(Error: WebSocket close with status code 1006)
```

Caddy önde çalışırken `X-Forwarded-Host` eklendiği için bu hata maskelenebilir;
Cloudflare Tunnel `X-Forwarded-Host` eklemez, bu yüzden orada mutlaka görülür.

### Dev server ödünleşimi

Dev önizlemelerinde `Host` yeniden yazılır, çünkü çoğu dev server bilinmeyen bir
`Host` gördüğünde isteği reddeder ve `127.0.0.1` her zaman izinlidir. Bunun
karşılığında, kendi `Origin`/`Host` doğrulamasını yapan bir dev server bu yolda
çalışmayabilir. Böyle bir durumda dev server'ı kendi adresine izin verecek
şekilde yapılandır:

```js
// vite.config.js
export default {
  server: {
    allowedHosts: ["dev-5173.alanadi.com", "alanadi.com"]
  }
};
```

`/dev/{port}/` path yolunda tarayıcının `Host`'u zaten Lyra'nın kendi adresidir;
oraya da aynı liste yazılır.
