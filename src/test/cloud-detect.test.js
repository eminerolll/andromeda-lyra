// lib/cloud-detect.js — bulut saglayici tespiti.
//
// Bu testler GERCEK metadata adresine (169.254.169.254) hicbir istek atmaz:
// fetch her testte enjekte edilir. Amac iki sey: (1) her saglayicinin kendi
// imzasiyla ayirt edildigini, (2) bulut olmayan/agsiz makinede sessizce null
// donuldugunu garanti etmek — kurulum bu fonksiyon yuzunden gecikemez.

import { describe, it, expect } from "vitest";
import { require } from "./setup.js";

const cloud = require("../lib/cloud-detect");

// Minik fetch taklidi: URL + method eslesirse cevap, yoksa ag hatasi.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || "GET", headers: opts.headers || {} });
    for (const r of routes) {
      const methodOk = (r.method || "GET") === (opts.method || "GET");
      if (methodOk && String(url).includes(r.match)) {
        if (r.throws) throw new Error("connect EHOSTUNREACH");
        return {
          ok: r.ok !== false,
          status: r.status || 200,
          headers: { get: (k) => (r.headers || {})[String(k).toLowerCase()] || null },
          text: async () => r.body || ""
        };
      }
    }
    throw new Error("connect EHOSTUNREACH 169.254.169.254:80");
  };
  fn.calls = calls;
  return fn;
}

describe("cloud-detect", () => {
  it("Oracle Cloud'u /opc/v2/instance/ cevabindan tanir", async () => {
    const fetchImpl = fakeFetch([
      {
        match: "/opc/v2/instance/",
        body: '{"compartmentId":"ocid1.compartment.oc1..aaa","regionInfo":{}}'
      }
    ]);
    expect(await cloud.detect({ fetchImpl, timeout: 50 })).toEqual({
      id: "oracle",
      name: "Oracle Cloud"
    });
    // Oracle probu yetkilendirme basligini gondermeli, yoksa 401 alirdi.
    const call = fetchImpl.calls.find((c) => c.url.includes("/opc/v2/"));
    expect(call.headers.Authorization).toBe("Bearer Oracle");
  });

  it("AWS'i IMDSv2 token + meta-data listesinden tanir", async () => {
    const fetchImpl = fakeFetch([
      { match: "/latest/api/token", method: "PUT", body: "AQAEAExampleToken" },
      { match: "/latest/meta-data/", body: "ami-id\nhostname\ninstance-id\n" }
    ]);
    expect(await cloud.detect({ fetchImpl, timeout: 50 })).toEqual({
      id: "aws",
      name: "AWS EC2"
    });
    const listing = fetchImpl.calls.find((c) => c.url.includes("/latest/meta-data/"));
    expect(listing.headers["X-aws-ec2-metadata-token"]).toBe("AQAEAExampleToken");
  });

  it("IMDSv1 (token ucu kapali) makinede de AWS'i tanir", async () => {
    const fetchImpl = fakeFetch([
      { match: "/latest/api/token", method: "PUT", ok: false, status: 405 },
      { match: "/latest/meta-data/", body: "instance-id\nlocal-ipv4\n" }
    ]);
    expect(await cloud.detect({ fetchImpl, timeout: 50 })).toEqual({
      id: "aws",
      name: "AWS EC2"
    });
  });

  it("GCP'yi Metadata-Flavor cevap basligindan tanir", async () => {
    const fetchImpl = fakeFetch([
      {
        match: "/computeMetadata/v1/",
        body: "instance/\nproject/\n",
        headers: { "metadata-flavor": "Google" }
      }
    ]);
    expect(await cloud.detect({ fetchImpl, timeout: 50 })).toEqual({
      id: "gcp",
      name: "Google Cloud"
    });
  });

  it("Metadata-Flavor basligi yoksa GCP saymaz", async () => {
    const fetchImpl = fakeFetch([{ match: "/computeMetadata/v1/", body: "instance/\n" }]);
    expect(await cloud.detect({ fetchImpl, timeout: 50 })).toBeNull();
  });

  it("Azure'u instance metadata govdesinden tanir", async () => {
    const fetchImpl = fakeFetch([
      { match: "/metadata/instance", body: '{"compute":{"name":"vm1"},"network":{}}' }
    ]);
    expect(await cloud.detect({ fetchImpl, timeout: 50 })).toEqual({
      id: "azure",
      name: "Microsoft Azure"
    });
    const call = fetchImpl.calls.find((c) => c.url.includes("/metadata/instance"));
    expect(call.headers.Metadata).toBe("true");
  });

  it("hicbir prob cevap vermezse null doner (ev sunucusu / agsiz)", async () => {
    const fetchImpl = fakeFetch([]);
    expect(await cloud.detect({ fetchImpl, timeout: 50 })).toBeNull();
  });

  it("timeout/ag hatasi throw etmez", async () => {
    const fetchImpl = async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    };
    await expect(cloud.detect({ fetchImpl, timeout: 10 })).resolves.toBeNull();
  });

  it("beklenen govde gelmezse (yabanci 200) bulut saymaz", async () => {
    // Kurumsal bir proxy 169.254.169.254'e 200 dondurebilir; imza yoksa hayir.
    const fetchImpl = fakeFetch([
      { match: "169.254.169.254", body: "<html>proxy error</html>" },
      { match: "169.254.169.254", method: "PUT", body: "" }
    ]);
    expect(await cloud.detect({ fetchImpl, timeout: 50 })).toBeNull();
  });

  it("birden fazla prob tutarsa sonuc deterministiktir (PROVIDERS sirasi)", async () => {
    const fetchImpl = fakeFetch([
      { match: "/opc/v2/instance/", body: '{"compartmentId":"x"}' },
      { match: "/metadata/instance", body: '{"compute":{}}' }
    ]);
    const order = cloud.PROVIDERS.map((p) => p.id);
    expect(order.indexOf("oracle")).toBeLessThan(order.indexOf("azure"));
    expect((await cloud.detect({ fetchImpl, timeout: 50 })).id).toBe("oracle");
  });

  it("fetch yoksa (cok eski Node) null doner", async () => {
    expect(await cloud.detect({ fetchImpl: null })).toBeNull();
  });

  it("timeout TOPLAM butcedir: butce dolunca ikinci AWS istegi hic yapilmaz", async () => {
    // AWS probu iki adimli. Butce istek basina olsaydi cevapsiz bir makinede
    // sure iki katina cikardi — kurulumu bekletmemek icin bu onemli.
    const calls = [];
    const fetchImpl = (url) => {
      calls.push(String(url));
      return new Promise((resolve, reject) => {
        // Ilk istek butceyi asarak "cevapsiz ag"i taklit eder.
        setTimeout(() => reject(new Error("EHOSTUNREACH")), 60);
      });
    };
    expect(await cloud.detect({ fetchImpl, timeout: 20 })).toBeNull();
    expect(calls.some((u) => u.includes("/latest/api/token"))).toBe(true);
    expect(calls.some((u) => u.includes("/latest/meta-data/"))).toBe(false);
  });
});
