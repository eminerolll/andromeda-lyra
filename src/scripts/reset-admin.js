// Admin sifre / kullanici sifirlama. Lockout durumunda kullanilir.
//
// Kullanim:
//   node scripts/reset-admin.js                    # interaktif
//   node scripts/reset-admin.js --reset-password   # sadece sifreyi sifirla
//   node scripts/reset-admin.js --disable-2fa      # 2FA'yi kapat
//   node scripts/reset-admin.js --recreate         # tum kullaniciyi sil + yenisini olustur
//   node scripts/reset-admin.js --unban-all        # ban listesini temizle

require("dotenv").config();
const prompts = require("prompts");
const { migrate } = require("../db/migrate");
const { users, bans, audit } = require("../db/repos");

const args = process.argv.slice(2);
const flags = {
  resetPassword: args.includes("--reset-password"),
  disable2fa: args.includes("--disable-2fa"),
  recreate: args.includes("--recreate"),
  unbanAll: args.includes("--unban-all")
};
const interactive = !Object.values(flags).some(Boolean);

async function main() {
  console.log("\n=== Lyra Admin Recovery ===\n");
  migrate();

  if (interactive) {
    return runInteractive();
  }

  if (flags.unbanAll) await unbanAll();
  if (flags.disable2fa) await disable2fa();
  if (flags.resetPassword) await resetPassword();
  if (flags.recreate) await recreate();
}

async function runInteractive() {
  const admin = users.getAdmin();
  if (!admin) {
    console.log("Hicbir admin kullanici yok. Setup wizard'i calistir: npm run setup");
    process.exit(0);
  }

  console.log(`Mevcut admin: ${admin.username}`);
  console.log(`  2FA: ${admin.totp_enabled ? "aktif" : "kapali"}`);
  console.log(`  Son giris: ${admin.last_login_at ? new Date(admin.last_login_at).toISOString() : "hic"}`);
  console.log("");

  const { action } = await prompts({
    type: "select",
    name: "action",
    message: "Ne yapmak istiyorsun?",
    choices: [
      { title: "Sifreyi sifirla", value: "reset-password" },
      { title: "2FA'yi kapat", value: "disable-2fa" },
      { title: "Ban listesini temizle", value: "unban-all" },
      { title: "Kullaniciyi sil ve yenisini olustur", value: "recreate" },
      { title: "Cik", value: "exit" }
    ]
  });

  if (action === "reset-password") return resetPassword();
  if (action === "disable-2fa") return disable2fa();
  if (action === "unban-all") return unbanAll();
  if (action === "recreate") return recreate();
}

async function resetPassword() {
  const admin = users.getAdmin();
  if (!admin) {
    console.error("Admin yok.");
    process.exit(1);
  }
  const ans = await prompts([
    { type: "password", name: "p1", message: "Yeni sifre (en az 12 karakter)", validate: v => v.length >= 12 || "En az 12 karakter" },
    { type: "password", name: "p2", message: "Sifre tekrari", validate: () => true }
  ]);
  if (ans.p1 !== ans.p2) {
    console.error("Sifreler eslesmedi.");
    process.exit(1);
  }
  users.setPassword(admin.id, ans.p1);
  audit.log({
    event_type: "admin_recovery",
    user_id: admin.id,
    details: { action: "password_reset", via: "cli" }
  });
  console.log(`✓ ${admin.username} icin sifre sifirlandi.`);
}

async function disable2fa() {
  const admin = users.getAdmin();
  if (!admin) {
    console.error("Admin yok.");
    process.exit(1);
  }
  if (!admin.totp_enabled) {
    console.log("2FA zaten kapali.");
    return;
  }
  const { confirm } = await prompts({
    type: "confirm",
    name: "confirm",
    message: `${admin.username} icin 2FA'yi kapat?`,
    initial: false
  });
  if (!confirm) return;
  users.disableTotp(admin.id);
  audit.log({
    event_type: "admin_recovery",
    user_id: admin.id,
    details: { action: "2fa_disabled", via: "cli" }
  });
  console.log("✓ 2FA kapatildi.");
}

async function unbanAll() {
  const list = bans.list();
  if (!list.length) {
    console.log("Ban listesi zaten bos.");
    return;
  }
  console.log(`${list.length} IP banli:`);
  for (const b of list) console.log(`  - ${b.ip} (${b.reason || "?"})`);
  const { confirm } = await prompts({
    type: "confirm",
    name: "confirm",
    message: "Hepsini kaldir?",
    initial: false
  });
  if (!confirm) return;
  for (const b of list) bans.unban(b.ip);
  audit.log({
    event_type: "admin_recovery",
    details: { action: "unban_all", count: list.length, via: "cli" }
  });
  console.log(`✓ ${list.length} ban kaldirildi.`);
}

async function recreate() {
  const admin = users.getAdmin();
  if (admin) {
    const { confirm } = await prompts({
      type: "confirm",
      name: "confirm",
      message: `${admin.username} silinecek. Emin misin?`,
      initial: false
    });
    if (!confirm) return;
    require("../db").db.prepare("DELETE FROM users WHERE id = ?").run(admin.id);
  }
  const ans = await prompts([
    { type: "text", name: "username", message: "Kullanici adi", initial: "admin" },
    { type: "password", name: "p1", message: "Sifre (en az 12)", validate: v => v.length >= 12 || "En az 12 karakter" },
    { type: "password", name: "p2", message: "Sifre tekrari" }
  ]);
  if (ans.p1 !== ans.p2) {
    console.error("Sifreler eslesmedi.");
    process.exit(1);
  }
  const created = users.create({ username: ans.username, password: ans.p1 });
  audit.log({
    event_type: "admin_recovery",
    user_id: created.id,
    details: { action: "recreated", via: "cli" }
  });
  console.log(`✓ Yeni admin olusturuldu: ${created.username}`);
  console.log("  2FA setup'i icin Lyra'da Ayarlar > Hesap > 2FA Aktif Et");
}

main().catch(err => {
  console.error("Hata:", err.message);
  process.exit(1);
});
