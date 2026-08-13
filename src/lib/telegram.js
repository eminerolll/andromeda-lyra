// Opsiyonel Telegram bildirim. integrations.telegram'da config tutar.
// config: { botToken, ownerChatId }
// Devre disi (enabled=false) iken hicbir cagrida hata atmaz.

const { integrations } = require("../db/repos");

function isEnabled() {
  return integrations.isEnabled("telegram");
}

function getConfig() {
  const i = integrations.get("telegram");
  return i && i.enabled ? i.config || {} : null;
}

async function send(text, replyMarkup = null) {
  const cfg = getConfig();
  if (!cfg || !cfg.botToken || !cfg.ownerChatId) return;
  const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
  const body = {
    chat_id: cfg.ownerChatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      console.error("[telegram] send failed:", res.status);
    }
  } catch (err) {
    console.error("[telegram] send error:", err.message);
  }
}

module.exports = { isEnabled, send, getConfig };
