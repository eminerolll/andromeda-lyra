// cloudflared-installer — mevcut servisin tespiti.
//
// Bu dosya SISTEME dokunmaz: yalnizca unit metnini ve connector token'i
// ayristiran saf fonksiyonlar test edilir. Amac, "sunucuda zaten bir
// cloudflared servisi var" durumunu kurulum patlamadan ONCE gorebilmek.

import { describe, it, expect } from "vitest";
import { require } from "./setup.js";

const cfd = require("../lib/cloudflared-installer");

const TUNNEL_ID = "bde016f2-1111-2222-3333-444455556666";
// Connector token: base64({"a":hesap,"t":tunnel,"s":secret}).
const TOKEN = Buffer.from(
  JSON.stringify({ a: "hesap-id", t: TUNNEL_ID, s: "cok-gizli-secret" })
).toString("base64");

describe("cloudflared-installer — connector token", () => {
  it("token'dan tunnel id'sini cikarir", () => {
    expect(cfd.tunnelIdFromToken(TOKEN)).toBe(TUNNEL_ID);
  });

  it("bozuk token'da null doner (patlamaz)", () => {
    expect(cfd.tunnelIdFromToken("bu-base64-degil!!")).toBeNull();
    expect(cfd.tunnelIdFromToken("")).toBeNull();
    expect(cfd.tunnelIdFromToken(Buffer.from('{"a":"x"}').toString("base64"))).toBeNull();
  });
});

describe("cloudflared-installer — systemd unit ayristirma", () => {
  it("token yontemiyle kurulmus servisin tunnel'ini bulur", () => {
    const unit = [
      "# /etc/systemd/system/cloudflared.service",
      "[Service]",
      `ExecStart=/usr/bin/cloudflared --no-autoupdate tunnel run --token ${TOKEN}`
    ].join("\n");
    expect(cfd.tunnelIdFromUnit(unit)).toBe(TUNNEL_ID);
  });

  it("kimlik dosyasi yontemiyle kurulmus servisin tunnel'ini bulur", () => {
    const unit = "[Service]\nExecStart=/usr/bin/cloudflared tunnel run " + TUNNEL_ID;
    expect(cfd.tunnelIdFromUnit(unit)).toBe(TUNNEL_ID);
  });

  it("tanimadigi unit'te null doner", () => {
    expect(cfd.tunnelIdFromUnit("[Service]\nExecStart=/usr/bin/baska-sey")).toBeNull();
    expect(cfd.tunnelIdFromUnit(null)).toBeNull();
  });

  it("servis tarifinde token GECMEZ, yalnizca tunnel id'si", () => {
    const line = cfd.describeService({ present: true, active: true, tunnelId: TUNNEL_ID });
    expect(line).toMatch(/calisiyor/);
    expect(line).toContain(TUNNEL_ID);
    expect(line).not.toContain(TOKEN);
  });
});

describe("cloudflared-installer — installService on kontrolu", () => {
  it("gecersiz token'da hicbir sey calistirmaz", async () => {
    const r = await cfd.installService({ token: "kisa" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Gecersiz connector token/);
  });
});
