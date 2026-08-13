---
name: Bug raporu
about: Bir şey bozuk
labels: bug
---

## Açıklama

<!-- Bir paragraf: ne yanlış? -->

## Tekrar üretme adımları

1.
2.
3.

## Beklenen vs gerçekleşen

**Beklenen:**

**Gerçekleşen:**

## Ortam

- Lyra commit'i: <!-- git -C /opt/lyra rev-parse HEAD -->
- Node sürümü: <!-- node -v -->
- OS: <!-- lsb_release -d -->
- Public mode: evet / hayır
- Cloudflared: evet / hayır

## Loglar

```
# şuradan ilgili satırları yapıştır: sudo journalctl -u lyra -n 100
```
