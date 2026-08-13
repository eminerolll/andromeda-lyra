# Lyra'ya Katkı

İlgine teşekkürler. Lyra küçük bir proje; katkılar memnuniyetle karşılanır.
Eşik **doğruluk**: küçük ve test edilmiş bir PR, geniş yüzey ekleyen
büyük bir PR'dan iyidir.

## Geliştirme ortamı

Yerel geliştirme için sunucu kurulumuna (`install.sh`) gerek yok —
o, systemd + sudoers + firewall ister ve makineni değiştirir.
Geliştirirken Lyra'yı doğrudan çalıştır:

```bash
git clone <repo-url> lyra          # repo henuz yayinlanmadi
cd lyra/src
cp .env.example .env               # LYRA_HOME=./data yeterli
npm install
npm run migrate
npm test                           # 75 test gecmeli

# Kurulum sihirbazini root olmadan ac (port 80 yerine 8080):
LYRA_SETUP_PORT=8080 npm run setup
# ...ya da sihirbazi atlayip mevcut bir DB ile calistir:
npm start
```

Lyra Node.js 20 LTS hedefler. `better-sqlite3` native derleme
gerektirir — Windows'ta Visual Studio Build Tools yoksa derlenmez;
WSL veya Linux kullan.

## Proje yapısı

```
src/
  server.js          # giriş: Express, WS, dynamic proxy
  db/                # SQLite migration'ları, repository'ler
  lib/               # config, auth, ban, proxy, vs.
  routes/            # HTTP route handler'ları
  scripts/           # setup wizard, sudoers/systemd generator'lar
  public/            # vanilla-JS dashboard, build step yok
```

`andromeda-lyra/audit/` — yayın öncesi audit notları; runtime'ın
parçası değil.

## Stil

- **Frontend için bundler/build step yok.** ES modülleri olduğu gibi
  servis edilir.
- **Vanilla JS.** React, JSX, TypeScript transpilation yok. (Sadece
  type için `.d.ts` TypeScript OK.)
- **Bağımlılık yığma yok.** Yeni npm paketi eklemek için PR
  açıklamasında gerekçe.
- **Yorumlar sadece *neden* aşikâr değilse.** Kodu prose ile tekrar
  etme.
- **2 boşluk indent**, semicolon, çift tırnak (mevcut dosyalarla
  uyumlu).
- ESLint + Prettier config'leri repo root'unda; `npm run lint` ve
  `npm run format`.

## Branching

- `main` tek uzun yaşayan branch.
- Fork → topic branch → PR.
- Default squash-merge; merge commit changelog girdisi olur.

## Test'ler

Smoke testler `src/test/`'te ve Vitest ile çalışır:

```bash
npm test
```

Test ekle:

- Yakalanmamış bir bug'ı düzeltirken (regression test).
- Önemsiz olmayan repository mantığı, validation veya auth flow
  eklerken.

Önemsiz route handler'lar veya sırf UI değişiklikleri için test
gerekmiyor.

## Commit'ler

- Commit başına bir mantıksal değişiklik. Refactor'u feature ile
  bundle etme.
- İlk satır ≤72 karakter, imperative ("add x", "fix y").
- Diff'ten anlaşılmıyorsa body *neden* anlatır.

## PR gönderme

- PR açmadan önce `main`'e rebase et.
- Ne değiştirdiğini ve **neden** açıkla. İlişkili issue'lara link.
- Lokalde `npm run lint` ve `npm test` çalıştır. Merge için CI yeşil
  olmak zorunda.
- Review'a sabırlı ol. Hız değil, düşük bakım yükü için optimize
  ediyoruz.

## Bug raporlama

Şunlarla issue aç:

1. Lyra sürümü (commit SHA).
2. Node sürümü, OS distro.
3. Repro adımları.
4. Beklenen vs gözlenen davranış.
5. İlgili `journalctl -u lyra` parçası.

Güvenlik açıkları için [SECURITY.md](./SECURITY.md) — public issue
açma.

## Lisanslama

Katkıda bulunarak, katkının AGPL-3.0 altında lisanslandığını kabul
edersin (bkz. [LICENSE](./LICENSE)). Telif hakkı sende kalır.
