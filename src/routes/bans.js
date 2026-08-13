// IP ban yonetimi. Ban'i geri almanin tek yolu SSH + reset-admin.js idi;
// uzaktan kurulum yapan kullanici kilitlenince paneli kurtaramiyordu.
// Tum endpoint'ler requireAuth gerektirir (server.js'te mount edilirken).

const express = require("express");
const ban = require("../lib/ban");
const { bans } = require("../db/repos");

const router = express.Router();

// Yeni bagimlilik eklemeden basit IPv4/IPv6 dogrulama
function isValidIp(ip) {
  if (typeof ip !== "string" || !ip || ip.length > 45) return false;
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) return v4.slice(1).every((o) => Number(o) <= 255);
  return ip.includes(":") && /^[0-9a-fA-F:]{2,45}$/.test(ip);
}

router.get("/api/bans", (req, res) => {
  res.json({ bans: bans.list() });
});

router.post("/api/bans", (req, res) => {
  const body = req.body || {};
  const ip = ban.normalizeIp(typeof body.ip === "string" ? body.ip.trim() : "");
  if (!isValidIp(ip)) return res.status(400).json({ error: "Gecersiz IP adresi" });
  if (ban.isWhitelisted(ip)) {
    return res.status(400).json({ error: "LAN/loopback adresleri banlanamaz" });
  }

  let durationMs = null;
  const raw = body.durationMinutes;
  if (raw !== undefined && raw !== null && raw !== "") {
    const minutes = parseInt(raw, 10);
    if (Number.isNaN(minutes) || minutes < 1) {
      return res.status(400).json({ error: "durationMinutes pozitif sayi olmali" });
    }
    durationMs = minutes * 60 * 1000;
  }

  // ban() kendi audit kaydini yazar (ip_banned)
  ban.ban(ip, {
    reason: body.reason || "manuel ban",
    durationMs,
    by: req.session.username || "admin",
    userId: req.session.userId
  });
  res.json({ success: true, ban: bans.getMeta(ip) });
});

router.delete("/api/bans/:ip", (req, res) => {
  const ip = ban.normalizeIp(req.params.ip);
  if (!isValidIp(ip)) return res.status(400).json({ error: "Gecersiz IP adresi" });
  if (!bans.getMeta(ip)) return res.status(404).json({ error: "Bu IP banli degil" });
  // unban() kendi audit kaydini yazar (ip_unbanned)
  ban.unban(ip, { userId: req.session.userId });
  res.json({ success: true });
});

module.exports = router;
