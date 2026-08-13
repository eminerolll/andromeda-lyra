// Bulut sunucu tespiti — link-local metadata servisi (169.254.169.254).
//
// Neden var: Oracle/AWS/GCP/Azure gibi saglayicilarda gelen portlar
// (Security List / Security Group / NSG) VARSAYILAN OLARAK KAPALIDIR. install.sh
// "tarayicidan http://<ip> adresine git" dedigi anda kullanici erisemeyecegi bir
// adres alir — instance icinde ufw pasif olsa bile paket saglayicinin kenar
// firewall'unda duser. Bu modul o durumu kurulum BASLAMADAN once anlamak icin.
//
// Tasarim kurallari:
//   - Hicbir zaman throw etmez. Ag yoksa, adres yonlendirilmiyorsa ya da
//     zaman asimi olursa null doner; kurulum gecikmez.
//   - timeout TOPLAM butcedir, istek basina degil: problar paralel calisir ama
//     AWS probu iki adimlidir (IMDSv2 token + listeleme). Istek basina timeout
//     verilseydi cevapsiz bir makinede sure iki katina cikardi (olculdu: 1.5 sn
//     yerine 3.1 sn). Butce dolduysa kalan istekler hic yapilmaz.
//   - Sonuc deterministik: birden fazla prob cevap verirse PROVIDERS
//     sirasindaki ilk saglayici kazanir.
//   - fetch disaridan verilebilir (fetchImpl) — testler gercek metadata
//     adresine cikmaz.

const METADATA_HOST = "169.254.169.254";
const DEFAULT_TIMEOUT_MS = 1500;

const url = (p) => `http://${METADATA_HOST}${p}`;

// Her prob "bu cevap gercekten bu saglayiciya mi ait" sorusunu ayrica
// dogrular: metadata IP'si tekildir, yanlis saglayiciya ait bir cevabi
// "bulut degil" saymak, yanlis saglayici adi basmaktan iyidir.
const PROVIDERS = [
  {
    id: "oracle",
    name: "Oracle Cloud",
    async probe(get) {
      const r = await get(url("/opc/v2/instance/"), {
        headers: { Authorization: "Bearer Oracle" }
      });
      if (!r || !r.ok) return false;
      const body = await r.text();
      return /"(compartmentId|canonicalRegionName|regionInfo)"/.test(body);
    }
  },
  {
    id: "aws",
    name: "AWS EC2",
    async probe(get) {
      // IMDSv2: once token, sonra listeleme. IMDSv1 acik birakilmis
      // instance'larda token adimi 404/405 doner, dogrudan listelemeye duseriz.
      let token = null;
      const t = await get(url("/latest/api/token"), {
        method: "PUT",
        headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" }
      });
      if (t && t.ok) {
        const value = (await t.text()).trim();
        if (value) token = value;
      }
      const r = await get(
        url("/latest/meta-data/"),
        token ? { headers: { "X-aws-ec2-metadata-token": token } } : {}
      );
      if (!r || !r.ok) return false;
      const body = await r.text();
      return /^(instance-id|ami-id|instance-type)$/m.test(body);
    }
  },
  {
    id: "gcp",
    name: "Google Cloud",
    async probe(get) {
      const r = await get(url("/computeMetadata/v1/"), {
        headers: { "Metadata-Flavor": "Google" }
      });
      if (!r || !r.ok) return false;
      // GCP metadata sunucusu cevabi bu basligi ZORUNLU tasir; govdeye
      // bakmadan ayirt etmenin en guvenilir yolu.
      const flavor = r.headers && r.headers.get ? r.headers.get("metadata-flavor") : null;
      return String(flavor || "").toLowerCase() === "google";
    }
  },
  {
    id: "azure",
    name: "Microsoft Azure",
    async probe(get) {
      const r = await get(url("/metadata/instance?api-version=2021-02-01"), {
        headers: { Metadata: "true" }
      });
      if (!r || !r.ok) return false;
      const body = await r.text();
      return /"compute"\s*:/.test(body);
    }
  }
];

function providerById(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

// Tek bir istek: hata da timeout da "cevap yok" demektir (null).
// deadline: tum tespitin bitmesi gereken an (epoch ms).
function makeGetter(fetchImpl, deadline) {
  return async (target, opts = {}) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    try {
      return await fetchImpl(target, {
        method: opts.method || "GET",
        headers: opts.headers || {},
        redirect: "manual",
        signal: AbortSignal.timeout(remaining)
      });
    } catch (_) {
      return null;
    }
  };
}

// Bulutta miyiz? -> { id, name } ya da null.
async function detect({ timeout = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") return null;
  const get = makeGetter(fetchImpl, Date.now() + timeout);

  const results = await Promise.all(
    PROVIDERS.map(async (p) => {
      try {
        return (await p.probe(get)) ? p.id : null;
      } catch (_) {
        return null;
      }
    })
  );

  const hit = results.find(Boolean);
  if (!hit) return null;
  const p = providerById(hit);
  return { id: p.id, name: p.name };
}

module.exports = { METADATA_HOST, DEFAULT_TIMEOUT_MS, PROVIDERS, providerById, detect };

// install.sh bu dosyayi dogrudan calistirir:
//   node lib/cloud-detect.js   -> "oracle|AWS EC2" gibi tek satir, ya da bos.
// Cikis kodu HER ZAMAN 0: tespit edememek hata degildir.
if (require.main === module) {
  const arg = process.argv.indexOf("--timeout");
  const timeout = arg >= 0 ? parseInt(process.argv[arg + 1], 10) : DEFAULT_TIMEOUT_MS;
  detect({ timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS })
    .then((r) => {
      if (r) process.stdout.write(`${r.id}|${r.name}\n`);
      process.exit(0);
    })
    .catch(() => process.exit(0));
}
