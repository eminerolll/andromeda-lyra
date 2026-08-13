// Olay bildirimi: audit log + opsiyonel telegram.
// Telegram entegrasyonu opsiyonel (integrations.telegram).

const { audit, integrations } = require("../db/repos");
const telegram = require("./telegram");

function loginSuccess({ ip, userId, details = {} }) {
  audit.log({ event_type: "login_success", ip, user_id: userId, details });
  if (telegram.isEnabled()) {
    telegram.send(`✅ <b>Login</b>\nIP: <code>${escape(ip)}</code>`).catch(() => {});
  }
}

function loginFail({ ip, username, reason }) {
  audit.log({ event_type: "login_fail", ip, details: { username, reason } });
  if (telegram.isEnabled()) {
    telegram
      .send(
        `⚠️ <b>Basarisiz giris</b>\nIP: <code>${escape(ip)}</code>\nKullanici: <code>${escape(username)}</code>\nNeden: ${escape(reason)}`
      )
      .catch(() => {});
  }
}

function ipBanned({ ip, reason, by }) {
  audit.log({ event_type: "ip_banned", ip, details: { reason, by } });
  if (telegram.isEnabled()) {
    telegram
      .send(
        `🔨 <b>IP banlandi</b>\nIP: <code>${escape(ip)}</code>\nNeden: ${escape(reason || "")}\nBanlayan: ${escape(by || "auto")}`
      )
      .catch(() => {});
  }
}

function settingChanged({ key, oldValue, newValue, userId, ip }) {
  audit.log({
    event_type: "setting_change",
    ip,
    user_id: userId,
    details: { key, oldValue, newValue }
  });
}

function escape(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

module.exports = { loginSuccess, loginFail, ipBanned, settingChanged };
