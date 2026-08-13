import { describe, it, expect } from "vitest";
import { require } from "./setup.js";

const firewall = require("../lib/firewall");

describe("firewall — subnet hesabi", () => {
  it("cidr'den ag adresini bulur", () => {
    expect(firewall.networkOf("192.168.0.17/24")).toBe("192.168.0.0/24");
    expect(firewall.networkOf("10.4.7.9/16")).toBe("10.4.0.0/16");
    expect(firewall.networkOf("172.16.31.200/20")).toBe("172.16.16.0/20");
    expect(firewall.networkOf("10.0.0.5/32")).toBe("10.0.0.5/32");
  });

  it("gecersiz girdide null doner", () => {
    expect(firewall.networkOf("192.168.0.17")).toBe(null);
    expect(firewall.networkOf("")).toBe(null);
    expect(firewall.networkOf("fe80::1/64")).toBe(null);
    expect(firewall.networkOf("999.1.1.1/24")).toBe(null);
  });
});

describe("firewall — ufw status ayristirma", () => {
  const sample = [
    "Status: active",
    "",
    "To                         Action      From",
    "--                         ------      ----",
    "22/tcp                     ALLOW       Anywhere",
    "80/tcp                     ALLOW       Anywhere                   # lyra-setup",
    "3000                       ALLOW       192.168.0.0/24             # lyra"
  ].join("\n");

  it("kural satirlarini okur", () => {
    const rules = firewall.parseRules(sample);
    expect(rules.length).toBe(3);
    expect(rules[0].target).toBe("22/tcp");
    expect(rules[1].comment).toBe("lyra-setup");
  });

  it("porta gore kural bulur", () => {
    expect(firewall.findPortRules(sample, 80).length).toBe(1);
    expect(firewall.findPortRules(sample, 3000).length).toBe(1);
    expect(firewall.findPortRules(sample, 8080).length).toBe(0);
  });
});

describe("firewall — erisim moduna gore kurallar", () => {
  it("public modda 80 ve 443 acar", () => {
    const rules = firewall.buildAccessModeRules("public", { port: 3000 });
    expect(rules.map(r => r[1])).toEqual(["80/tcp", "443/tcp"]);
  });

  it("lan modda Lyra portunu sadece yerel aglara acar", () => {
    const rules = firewall.buildAccessModeRules("lan", {
      port: 3000,
      subnets: ["192.168.0.0/24", "10.8.0.0/24"]
    });
    expect(rules.length).toBe(2);
    expect(rules[0]).toContain("192.168.0.0/24");
    expect(rules[0]).toContain("3000");
    expect(rules[1]).toContain("10.8.0.0/24");
  });

  it("lan modda yerel ag tespit edilemezse hicbir port acmaz", () => {
    expect(firewall.buildAccessModeRules("lan", { port: 3000, subnets: [] })).toEqual([]);
  });

  it("localhost / cf-tunnel / manual modlarda firewall'a dokunmaz", () => {
    for (const mode of ["localhost", "cf-tunnel", "manual"]) {
      expect(firewall.buildAccessModeRules(mode, { port: 3000 })).toEqual([]);
    }
  });
});
