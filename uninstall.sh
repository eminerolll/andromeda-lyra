#!/usr/bin/env bash
# Lyra kaldirma scripti — install.sh'in birakti izleri geri alir.
#
# Kullanim (root gerekir):
#   sudo bash uninstall.sh
#   sudo bash uninstall.sh --keep-data     # veritabani ve oturumlar kalsin
#   sudo bash uninstall.sh --yes           # onay sorma
#   sudo lyra uninstall                    # ayni sey
#
# Kaldirilanlar:
#   - systemd unit'i + drop-in dizini (lyra.service, .service.d/)
#   - /etc/sudoers.d/lyra ve /etc/sudoers.d/lyra-setup
#   - /usr/local/bin/lyra symlink'i
#   - Lyra'nin yazdigi UFW kurallari (yalnizca "lyra" / "lyra-setup" etiketliler)
#   - kurulum dizini (varsayilan /opt/lyra)
#   - veri dizini (varsayilan /var/lib/lyra) — --keep-data ile korunur
#
# DOKUNULMAYANLAR (bilerek): Cloudflare tunnel'i ve DNS kayitlari, Caddy paketi
# ve Caddyfile, cloudflared servisi, Node.js, projelerin durdugu dizin.
# Bunlar uzaktaki/paylasilan kaynaklar; sessizce silmek yerine listeleyip
# kullaniciya birakiyoruz.
#
# Env override'lari: LYRA_DIR, LYRA_HOME

set -euo pipefail

if [[ -t 1 ]]; then
  C_RESET='\033[0m'; C_GREEN='\033[0;32m'; C_RED='\033[0;31m'
  C_YELLOW='\033[0;33m'; C_DIM='\033[2m'; C_CYAN='\033[1;36m'
else
  C_RESET=''; C_GREEN=''; C_RED=''; C_YELLOW=''; C_DIM=''; C_CYAN=''
fi

ok()    { echo -e "${C_GREEN}✓${C_RESET} $*"; }
warn()  { echo -e "${C_YELLOW}!${C_RESET} $*"; }
fail()  { echo -e "${C_RED}✗${C_RESET} $*" >&2; exit 1; }
info()  { echo -e "${C_DIM}-${C_RESET} $*"; }
step()  { echo; echo -e "${C_CYAN}▸ $*${C_RESET}"; }

usage() {
  cat <<'USAGE'
Kullanim: sudo bash uninstall.sh [secenekler]

Secenekler:
  --keep-data                    /var/lib/lyra (DB, oturumlar) silinmesin
  -y, --yes, --non-interactive   Onay sorma
  -h, --help                     Bu yardimi goster

Ortam degiskenleri:
  LYRA_DIR    kurulum dizini  (varsayilan: script'in bulundugu dizin, yoksa /opt/lyra)
  LYRA_HOME   veri dizini     (varsayilan: .env'den, yoksa /var/lib/lyra)
USAGE
}

ASSUME_YES=0
KEEP_DATA=0
for a in "$@"; do
  case "$a" in
    -y|--yes|--non-interactive) ASSUME_YES=1 ;;
    --keep-data) KEEP_DATA=1 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Bilinmeyen secenek: $a (yardim: --help)" ;;
  esac
done
[[ -t 0 ]] || ASSUME_YES=1

UNIT_NAME="lyra"
UNIT_FILE="/etc/systemd/system/${UNIT_NAME}.service"
DROPIN_DIR="/etc/systemd/system/${UNIT_NAME}.service.d"
SUDOERS="/etc/sudoers.d/lyra"
SETUP_SUDOERS="/etc/sudoers.d/lyra-setup"
BIN_LINK="/usr/local/bin/lyra"

# Kurulum dizini: script nerede duruyorsa orasi (elle kopyalanmis kurulumlar
# /opt/lyra disinda da olabilir).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -n "${LYRA_DIR:-}" ]]; then
  :
elif [[ -f "$SCRIPT_DIR/src/package.json" ]]; then
  LYRA_DIR="$SCRIPT_DIR"
else
  LYRA_DIR="/opt/lyra"
fi

# Veri dizini: once .env, sonra varsayilan.
if [[ -z "${LYRA_HOME:-}" ]]; then
  LYRA_HOME="/var/lib/lyra"
  if [[ -r "$LYRA_DIR/src/.env" ]]; then
    from_env="$(grep -E '^LYRA_HOME=' "$LYRA_DIR/src/.env" | tail -1 | cut -d= -f2- || true)"
    [[ -n "$from_env" ]] && LYRA_HOME="$from_env"
  fi
fi

[[ "${EUID:-$(id -u)}" -eq 0 ]] || fail "Bu script root olarak calismali:
    sudo bash $0 $*"

# Guvenlik freni: "/" ya da bos bir yolu silmeye kalkma.
for p in "$LYRA_DIR" "$LYRA_HOME"; do
  case "$p" in
    ""|"/"|"/usr"|"/etc"|"/var"|"/home"|"/opt") fail "Guvenli olmayan dizin: '$p' — iptal edildi." ;;
  esac
done

# ─────────────────────── Ne silinecek? ───────────────────────
echo
echo -e "${C_CYAN}Lyra kaldirilacak${C_RESET}"
echo
echo "  Silinecekler:"
FOUND=0
list_if() {
  # $1: test sonucu (0/1), $2: gosterilecek satir
  if [[ "$1" -eq 0 ]]; then echo "    $2"; FOUND=1; fi
}
list_if "$([[ -f "$UNIT_FILE" ]] && echo 0 || echo 1)" "$UNIT_FILE"
list_if "$([[ -d "$DROPIN_DIR" ]] && echo 0 || echo 1)" "$DROPIN_DIR/"
list_if "$([[ -f "$SUDOERS" ]] && echo 0 || echo 1)" "$SUDOERS"
list_if "$([[ -f "$SETUP_SUDOERS" ]] && echo 0 || echo 1)" "$SETUP_SUDOERS"
list_if "$([[ -L "$BIN_LINK" || -f "$BIN_LINK" ]] && echo 0 || echo 1)" "$BIN_LINK"
list_if "$([[ -d "$LYRA_DIR" ]] && echo 0 || echo 1)" "$LYRA_DIR/  (kod)"
if [[ "$KEEP_DATA" -eq 0 ]]; then
  list_if "$([[ -d "$LYRA_HOME" ]] && echo 0 || echo 1)" "$LYRA_HOME/  (VERITABANI, oturumlar)"
fi
if [[ "$FOUND" -eq 0 ]]; then
  echo "    (Lyra'ya ait bir sey bulunamadi — zaten kaldirilmis olabilir)"
fi
if [[ "$KEEP_DATA" -eq 1 ]]; then
  echo
  echo -e "  ${C_GREEN}Korunacak:${C_RESET}"
  echo "    $LYRA_HOME/  (veritabani, oturumlar) — --keep-data"
fi

echo
echo -e "  ${C_YELLOW}Dokunulmayacaklar${C_RESET} (gerekiyorsa kendin temizle):"
if systemctl list-unit-files cloudflared.service >/dev/null 2>&1; then
  echo "    cloudflared servisi   → sudo cloudflared service uninstall"
fi
echo "    Cloudflare tunnel'i ve DNS kayitlari → Cloudflare dashboard"
if [[ -f /etc/caddy/Caddyfile ]]; then
  echo "    Caddy + /etc/caddy/Caddyfile → sudo apt-get remove caddy"
fi
echo "    Projelerin durdugu dizin (asla silinmez)"
echo "    Node.js ve apt paketleri"
echo

if [[ "$ASSUME_YES" -ne 1 ]]; then
  read -rp "Devam edilsin mi? [e/H] " reply
  [[ "$reply" =~ ^[eEyY] ]] || fail "Iptal edildi. Hicbir sey silinmedi."
fi

# ─────────────────────── 1. Servis ───────────────────────
step "systemd servisi"
# systemd'ye ulasamamak kaldirmayi yarida birakmamali: unit dosyalari her
# durumda diskten silinir, systemctl cagrilari sadece uyari uretir.
if command -v systemctl >/dev/null 2>&1; then
  if systemctl list-unit-files "${UNIT_NAME}.service" >/dev/null 2>&1; then
    systemctl stop "$UNIT_NAME" >/dev/null 2>&1 || true
    systemctl disable "$UNIT_NAME" >/dev/null 2>&1 || true
    ok "${UNIT_NAME}.service durduruldu ve devre disi birakildi"
  else
    info "${UNIT_NAME}.service kurulu degil"
  fi
  # Kurulumdan kalmis olabilecek gecis timer'i.
  systemctl stop lyra-setup-finish.timer >/dev/null 2>&1 || true
  systemctl reset-failed "$UNIT_NAME" >/dev/null 2>&1 || true
else
  info "systemctl yok — sadece dosyalar siliniyor"
fi
rm -f "$UNIT_FILE"
rm -rf "$DROPIN_DIR"
if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || warn "systemctl daemon-reload basarisiz — elle calistir: sudo systemctl daemon-reload"
fi
ok "Unit dosyalari silindi"

# ─────────────────────── 2. sudoers ───────────────────────
step "sudoers"
removed=0
for f in "$SUDOERS" "$SETUP_SUDOERS"; do
  if [[ -f "$f" ]]; then rm -f "$f"; ok "$f silindi"; removed=1; fi
done
[[ "$removed" -eq 1 ]] || info "Lyra'ya ait sudoers dosyasi yoktu"

# ─────────────────────── 3. lyra komutu ───────────────────────
step "lyra komutu"
if [[ -L "$BIN_LINK" || -f "$BIN_LINK" ]]; then
  rm -f "$BIN_LINK"
  ok "$BIN_LINK silindi"
else
  info "$BIN_LINK yoktu"
fi

# ─────────────────────── 4. UFW ───────────────────────
step "Firewall"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi '^Status: active'; then
  # Yalnizca bizim etiketledigimiz kurallar. Numaralar silindikce kaydigi icin
  # buyukten kucuge gidiyoruz.
  nums="$(ufw status numbered 2>/dev/null \
    | grep -E '#[[:space:]]*lyra(-setup)?[[:space:]]*$' \
    | sed -E 's/^\[[[:space:]]*([0-9]+)\].*/\1/' \
    | sort -rn || true)"
  if [[ -n "$nums" ]]; then
    for n in $nums; do
      ufw --force delete "$n" >/dev/null 2>&1 || warn "UFW kural $n silinemedi"
    done
    ok "Lyra'ya ait UFW kurallari silindi"
  else
    info "Lyra etiketli UFW kurali yok"
  fi
else
  info "UFW aktif degil — dokunulmadi"
fi

# ─────────────────────── 5. Veri dizini ───────────────────────
step "Veri dizini"
if [[ "$KEEP_DATA" -eq 1 ]]; then
  warn "$LYRA_HOME korundu (--keep-data). Icinde admin hesabi ve oturumlar var."
  warn "Sonra silmek icin: sudo rm -rf $LYRA_HOME"
elif [[ -d "$LYRA_HOME" ]]; then
  rm -rf "$LYRA_HOME"
  ok "$LYRA_HOME silindi"
else
  info "$LYRA_HOME yoktu"
fi

# ─────────────────────── 6. Kurulum dizini ───────────────────────
# En sona birakildi: bu script o dizinin icinde olabilir. Linux'ta acik
# dosyanin unlink edilmesi sorun degil, bash okumaya devam eder.
step "Kurulum dizini"
if [[ -d "$LYRA_DIR" ]]; then
  rm -rf "$LYRA_DIR"
  ok "$LYRA_DIR silindi"
else
  info "$LYRA_DIR yoktu"
fi

echo
ok "Lyra kaldirildi."
echo
echo "  Kalanlar (varsa) icin yukaridaki 'Dokunulmayacaklar' listesine bak."
echo
