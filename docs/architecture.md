# Lyra Mimarisi

Bu doküman Lyra'nın nasıl yapılandırıldığını anlatır: hangi dosya
nelerden sorumlu, veri nasıl akıyor ve her katman ne garanti veriyor.

## Yüksek seviye

```
┌──────────────┐
│   Tarayıcı   │  ES modülleri, build step yok. src/public/'te vanilla JS
└──────┬───────┘
       │ HTTP / WS
       ▼
┌─────────────────────────────────────────────────┐
│  Express app (src/server.js)                    │
│  ─ trust proxy=loopback                         │
│  ─ ban middleware                               │
│  ─ güvenlik header'ları (CSP, HSTS, ...)        │
│  ─ session (connect-sqlite3)                    │
│  ─ requireSetupComplete                         │
│  ─ requireAuth                                  │
│  ─ route modülleri (src/routes/*)               │
└──────┬──────────────────────────┬───────────────┘
       │                          │
       ▼                          ▼
┌──────────────┐           ┌─────────────────┐
│ http-proxy   │           │ ws (WebSocket)  │
│ → 8080 code  │           │ /ws/ports       │
│ → diğer svc  │           │ /ws/logs        │
└──────────────┘           └─────────────────┘
       │                          │
       ▼                          ▼
   SQLite (WAL)              child_process
   sessions, settings        (git, journalctl,
   services, users           ss, systemctl,
   bans, audit, vs.          docker, cloudflared)
```

## İki konfigürasyon katmanı

**`.env`** — sadece bootstrap için. Process başında bir kez okunur. Üç
anahtar: `LYRA_HOME`, `LYRA_PORT`, `NODE_ENV`. Veritabanı açılmadan
*önce* bilinmesi gereken her şey burada.

**SQLite (`$LYRA_HOME/lyra.db`)** — runtime config ve state. Domain,
port eşlemeleri, servis tanımları, kullanıcı bilgileri, oturumlar,
banlar, audit log, üçüncü taraf bilgileri. Setup wizard veya (sonra)
dashboard üzerinden runtime'da düzenlenebilir. Eşzamanlı okuyucular
için WAL mode, dosya izni `0600`.

Bu ayrım bootstrap "tavuk-yumurta" sorununu (DB nerede, nasıl bilirim?)
ortadan kaldırırken runtime'da tek doğru kaynak (single source of
truth) bırakır.

## Kaynak kodu yapısı

```
src/
├── server.js                 # giriş noktası
├── package.json
├── .env.example
│
├── db/
│   ├── index.js              # better-sqlite3 connection (WAL, FK on)
│   ├── migrate.js            # migration runner
│   ├── migrations/
│   │   └── 001_initial.sql   # ilk şema
│   └── repos/
│       ├── settings.js       # key-value config
│       ├── services.js       # systemd unit kayıtları
│       ├── users.js          # bcrypt + TOTP
│       ├── bans.js           # IP banlar + memory cache
│       ├── audit.js          # event log
│       └── integrations.js   # telegram, github, cloudflare creds
│
├── lib/
│   ├── config.js             # .env + DB merge, hostname builder/parser
│   ├── auth.js               # session, password verify, TOTP, rate limiter
│   ├── ban.js                # RFC1918 whitelist + middleware
│   ├── notifier.js           # event → audit + opsiyonel telegram
│   ├── telegram.js           # bot wrapper
│   ├── service-detect.js     # host'ta kurulu servis tespiti
│   ├── security-headers.js   # CSP, HSTS, vs.
│   ├── proxy.js              # DB-driven hostname → port routing
│   ├── port-scanner.js       # ss tabanlı port enumeration
│   ├── docker.js             # docker / compose yardımcıları
│   └── cloudflare.js         # tunnel ingress / DNS / health
│
├── routes/
│   ├── auth-routes.js        # login, logout, password, 2FA
│   ├── projects.js           # CRUD, clone (SSE stream), pin
│   ├── github.js             # token, repo/branch list, clone
│   ├── git.js                # status, log, diff, exec
│   ├── system.js             # CPU/RAM/disk/uptime/GPU
│   ├── ports.js              # REST + WS port monitor
│   ├── env.js                # global env + proje .env
│   ├── logs.js               # WS journalctl stream
│   ├── notes.js              # proje .notes.md CRUD
│   ├── docker.js             # container'lar + compose
│   └── cloudflare.js         # ingress + DNS
│
├── scripts/
│   ├── setup.js              # 7-adımlı interaktif sihirbaz
│   ├── generate-sudoers.js   # kısıtlı sudoers entry'si
│   └── generate-systemd.js   # lyra.service unit
│
└── public/
    ├── login.html            # 2-adımlı login (şifre → opsiyonel TOTP)
    ├── index.html            # 7-sekmeli dashboard
    ├── favicon.ico
    ├── css/  (base, components, tabs)
    └── js/   (app, projects, ports, git, git-ops, env,
               logs, notes, docker, cloudflare)
```

## İstek yaşam döngüsü

1. **Cloudflare → cloudflared (loopback) → Lyra**. `trust proxy=loopback`
   gerçek istemci IP'sini Cloudflare'in koyduğu `cf-connecting-ip`
   header'ından okur.
2. **Ban kontrolü**. IP, başlangıçta SQLite'tan yüklenen memory ban
   set'ine karşı kontrol edilir. Banlanan IP'ler `403` alır.
3. **Güvenlik header'ları**. CSP, HSTS, X-Frame-Options,
   Permissions-Policy.
4. **Body parse + session**. SQLite store ile `express-session`.
5. **Setup gate**. Setup wizard admin user oluşturana kadar küçük
   allowlist hariç her route ipucuyla `503` döner.
6. **Auth**. `requireAuth` `req.session.userId`'i kontrol eder. Anonim
   API çağrıları `401` alır; HTML route'ları `/login`'e redirect olur.
7. **Route handler**. İlgili `routes/*.js` modülü isteği işler,
   repo'lar ve lib modülleriyle konuşur.

## Reverse proxy yönlendirmesi (public mode)

`public_access=true` ve `base_domain` set olduğunda Lyra hostname
tabanlı reverse proxy'dir:

| Hostname pattern | Çözüldüğü yer |
|------------------|---------------|
| `code.<base>` | `services` tablosu → ilk enabled `code-server` satırı |
| `files.<base>` | ilk enabled `filebrowser` satırı |
| `db.<base>` | ilk enabled `dbgate` satırı |
| `dev-<port>.<base>` | doğrudan port (DB lookup yok) |

Eşleme `lib/proxy.js`'te. Subdomain prefix'leri (`code`, `files`,
`db`, `dev-{port}`) `settings`'te tutuluyor; kod düzenlemeden
değiştirilebilir.

LAN-only mode'da proxy code path'i atlanır; istekler hep ana Express
app'e gider.

## WebSocket yönlendirmesi

İki WS endpoint:

- `/ws/ports` — canlı port tablosu güncellemeleri.
  `lib/port-scanner` her 5 saniyede poll eder ve bağlı tüm
  client'lara diff gönderir.
- `/ws/logs` — `journalctl -u <unit> -f` akışı; `services` tablosunda
  kayıtlı unit'lerle (artı Lyra'nın kendi unit'i) sınırlı.

İkisi de aynı session middleware'inden geçer, anonim upgrade'ler
socket seviyesinde düşer.

## Veri akışı örnekleri

**Login**:
```
tarayıcı → POST /api/login {username, password, totp?}
server   → users.findByUsername → bcrypt.compare
         → totp_enabled && !totp ise → {needs2FA} dön
         → users.touchLogin
         → session.userId = user.id
         → audit.log "login_success"
         → {success} dön
```

**Cloudflare ingress ekle** (public mode + cloudflared kayıtlı):
```
tarayıcı → POST /api/cf/ingress {hostname, port, autoDns}
server   → cf.addDnsAndIngress
           → getTunnelId (sudo ile /etc/cloudflared/config.yml okur)
           → cloudflaredRouteDns (sudo cloudflared tunnel route dns ...)
           → applyConfigAsyncRestart
             → writeConfigAtomic (backup → validate → install)
             → {success, backup} dön
             → setImmediate(restartTunnel)
               → active değilse: backup'a rollback
```

**Auto-ban**:
```
tarayıcı → POST /api/login {yanlış şifre}     (10 dk içinde 3 kez)
server   → audit.log "login_fail"
         → ban.maybeAutoBan
           → audit.countSince eventType=login_fail >= 3
           → bans.ban(ip, durationMs=60dk, by="auto")
           → notifier.ipBanned (telegram aktifse)
4. deneme → ban.middleware → 403 IP banlandi
```

## Operasyonel değişmezler

- **Loopback bind**. `server.listen(PORT, "127.0.0.1")`. Asla
  `0.0.0.0`'a bind etmez. Aynı host'ta bir reverse proxy tek public
  yoldur.
- **0600 secret'lar**. SQLite DB ve `.env` `0600` ile yazılır.
  `LYRA_HOME` dizini `0700`.
- **Setup-complete gate**. `users` tablosunda admin yoksa allowlist
  dışındaki tüm route'lar `503` döner. Default şifre yok.
- **Otomatik veri yıkımı yok**. Wizard mevcut user'ı asla yazmaz.
  Sıfırdan başlamak istiyorsan DB'yi sil.
- **Fail-closed proxy**. Public mode'da bilinmeyen hostname'ler
  default backend'e değil ana app'e düşer. Eski `services` satırları
  üzerinden subdomain takeover mümkün değil çünkü her satır kendi
  açık portunu taşır.
