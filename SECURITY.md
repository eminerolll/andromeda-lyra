# Güvenlik Politikası

## Desteklenen Sürümler

Lyra erken geliştirme aşamasında. Sadece `main` üzerindeki son commit
güvenlik düzeltmesi alır.

| Sürüm   | Destekleniyor |
| ------- | ------------- |
| `main`  | Evet          |
| Eski    | Hayır         |

## Güvenlik Açığı Bildirme

**Güvenlik açıkları için public GitHub issue açma.**

Bunun yerine aşağıdakilerden biriyle özel olarak bildir:

1. **GitHub Security Advisory**: Repo'da draft advisory aç (Security
   sekmesi → Report a vulnerability).
2. **E-posta**: `security@<replace-domain>` (mümkünse PGP ile şifreli).

Şunları beklemelisin:

- **3 iş günü** içinde alındı bilgisi
- **7 gün** içinde ilk değerlendirme
- Yüksek öncelikli sorunlar için **30 gün** içinde düzeltme veya
  azaltma planı

## Kapsam

Kapsam içinde:

- Lyra Node.js uygulaması (`src/`)
- Setup wizard, install scriptleri ve oluşturulan sudoers/systemd
  dosyaları
- Kimlik doğrulama, oturum ve yetkilendirme mantığı
- Reverse proxy ve istek yönlendirmesi

Kapsam dışı:

- Lyra'nın entegre olduğu üçüncü taraf servisler (Cloudflare, GitHub,
  code-server, filebrowser, dbgate). Bunları upstream'lerine bildir.
- Kullanıcı kaynaklı yanlış yapılandırmalar: zayıf şifre seçimi,
  loopback bind'i `0.0.0.0`'a açma, 2FA'yı kapatma, vb.

## Tehdit modeli

Lyra, public internet'e ancak TLS terminate eden bir reverse proxy
(genelde Cloudflare Tunnel) arkasından açılmak üzere tasarlandı.
Express server'ın kendisi `127.0.0.1`'e bind olur, asla public arayüze
listen etmez.

Varsayılan saldırganlar:

- **Anonim internet kullanıcıları** — credential stuffing, scanning
  veya public hostname'e karşı abuse denemesi.
- **Local LAN kullanıcıları** — ağ erişimi olan ama host'ta shell
  erişimi olmayan kullanıcılar.

Tehdit modeli dışında:

- Host'ta shell erişimi olan kullanıcı. Lyra normal bir kullanıcı
  olarak çalışır; o kullanıcının shell'ine sahip bir saldırgan SQLite
  DB ve config'i doğrudan okur.
- Host kernel'a karşı side-channel saldırılar.
- `npm install` ile gelen tehlikeli bağımlılıklar. Upstream'i pinlamen
  ve denetlemen gerek.

## Sertleştirme varsayılanları

Lyra şu varsayılanlarla gelir; sonuçlarını anlamadan zayıflatma:

- Sadece `127.0.0.1` bind.
- Setup wizard'da 2FA önerilir.
- Yapılandırılabilir başarısız giriş eşiğinden sonra IP ban.
- Tüm API endpoint'leri `requireAuth` arkasında, küçük public
  allowlist hariç.
- Session cookie: `httpOnly`, `sameSite=lax`, public mode + base
  domain varsa `secure`.
- SQLite DB ve `.env` dosyaları `0600` izniyle yazılır.
- Sudoers entry'leri (oluşturulursa) küçük sabit komut listesini
  kısıtlar — asla blanket `NOPASSWD: ALL` değil.

## Entegrasyon token'ları rest'te plaintext

`integrations` tablosundaki `config` alanı **plaintext JSON**'dur. Burada
Telegram bot token'ı, GitHub PAT'i ve Cloudflare API token'ı durur.
Bu bilinçli bir karardır ve değişmesi planlanmıyor.

**Neden şifrelenmiyor?** Şifreleme ancak anahtar saldırgandan
saklanabiliyorsa işe yarar. Lyra tek kullanıcılı, unprivileged bir
servistir; anahtarın gidebileceği her yer o kullanıcı tarafından
okunabilir:

- Aynı veritabanında → DB'yi okuyan anahtarı da okur.
- `LYRA_HOME` altında `0600` bir dosyada → DB de `0600` ve aynı sahibin;
  birini okuyabilen diğerini de okur.
- systemd `EnvironmentFile` ile ortam değişkeninde → değişken Lyra
  process'inin ortamındadır, yani `/proc/<pid>/environ` üzerinden aynı
  kullanıcı tarafından okunabilir.

Üç durumda da DB'yi okuma yetkisi olan saldırgan anahtarı da okur. Kendi
kendini korumayan bir şifreleme katmanı denetimde iyi görünür ama
saldırgan modelini değiştirmez, o yüzden eklenmedi. Anlamlı olacağı tek
senaryo anahtarın **başka bir güven alanında** durmasıdır (HSM, harici
secret store, işletim zamanında operatörün girdiği passphrase) — Lyra'nın
tek kullanıcılı self-hosted tasarımı bunların hiçbirini varsaymaz.

**Gerçek koruma dosya izinleridir:** SQLite DB `0600`, `LYRA_HOME` `0700`,
Lyra unprivileged kullanıcı olarak çalışır. Bu, tehdit modelindeki
saldırganların (anonim internet kullanıcısı, LAN kullanıcısı) DB'ye
erişemediği anlamına gelir. DB'yi okuyabilen saldırgan zaten host'ta
shell erişimine sahiptir ve bu tehdit modelinin dışındadır.

**Operatörün sorumluluğu:**

- Token'lara mümkün olan en dar scope'u ver (GitHub PAT için `repo:read`,
  Cloudflare için `Zone.DNS:Edit`).
- `LYRA_HOME` yedeklerini DB kadar dikkatli sakla; yedek dosyası
  şifrelenmemiş token içerir. Yedeği şifrelemek **senin** işin.
- Host'un tehlikeye girdiğinden şüpheleniyorsan üç token'ı da rotate et.
- Lyra'yı paylaşımlı bir host'ta, başka kullanıcıların da shell'i olduğu
  bir makinede çalıştırma.

## Bilinen sınırlama: Cloudflare connector token'ı ve `ps`

Cloudflare Tunnel modunda kurulum sihirbazı `cloudflared service install`
çağırır. Bu alt komut connector token'ını **yalnızca argüman olarak**
kabul eder: `--token-file` bu alt komutta tanımlı değildir, `TUNNEL_TOKEN`
ve `TUNNEL_TOKEN_FILE` ortam değişkenleri ile `config.yml` içindeki
`token:` anahtarı yok sayılır (cloudflared 2026.7.3 ile doğrulandı).

Lyra token'ı `sudo`'nun argüman listesinden çıkarır ve stdin üzerinden
geçirir, böylece token **systemd journal'ına yazılmaz**. Buna rağmen
komut çalıştığı birkaç saniye boyunca token `cloudflared` process'inin
kendi argümanlarında, yani `ps` çıktısında görünür.

Sonuç: host üzerinde o an aktif shell erişimi olan bir kullanıcı token'ı
yakalayabilir. Bu, mevcut tehdit modelinin dışındaki "host'ta shell
erişimi olan kullanıcı" senaryosuna girer. Paylaşımlı bir host'ta kurulum
yapıyorsan, kurulumdan sonra Cloudflare dashboard'dan tunnel token'ını
rotate etmek operatörün sorumluluğundadır.

## İfşa

İfşayı raporlayanla koordine ederiz. Varsayılan zaman çizelgesi ilk
rapordan **90 gün**, ama düzeltme erken hazırsa veya karşılıklı
anlaşmayla daha geç de olabilir.
