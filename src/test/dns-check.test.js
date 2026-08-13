import { describe, it, expect } from "vitest";
import { require } from "./setup.js";

describe("dns-check", () => {
  it("rejects invalid FQDN format", async () => {
    const dnsCheck = require("../lib/dns-check");
    const r = await dnsCheck.check("not-a-domain");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/format/i);
  });

  it("requires FQDN argument", async () => {
    const dnsCheck = require("../lib/dns-check");
    const r = await dnsCheck.check("");
    expect(r.ok).toBe(false);
  });

  it("checkAll gecersiz domain'de subdomain sorgusu yapmaz", async () => {
    const dnsCheck = require("../lib/dns-check");
    const r = await dnsCheck.checkAll("not-a-domain", ["code", "files", "db"]);
    expect(r.apex.ok).toBe(false);
    expect(r.subdomains).toEqual([]);
  });

  // NOT: Resolve testleri DNS gerektirir, agdan baska gecek olabilir.
  // CI'da skip edilebilir.
});
