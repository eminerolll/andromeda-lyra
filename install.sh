#!/usr/bin/env bash
# Lyra kurulum scripti — temiz bir Ubuntu/Debian sunucuya tek komutla kurar.
#
# Kullanim (root gerekir):
#   sudo LYRA_REPO=https://github.com/eminerolll/andromeda-lyra.git bash install.sh
#   # veya repo'yu kendin klonladiysan, klasorun icinden:
#   sudo ./install.sh
#
# Akis (sirasi onemli):
#   1. Root / distro / mimari kontrolu, hedef Linux kullanicisinin tespiti
#   2. Sistem paketleri + Node.js 20 (NodeSource) — eksikse KURAR
#   3. Kaynak kodu /opt/lyra'ya al (clone/update ya da yerel kopya)
#   4. npm ci --omit=dev
#   5. .env uret (LYRA_HOME=/var/lib/lyra) + veri dizinini yarat
#   6. DB migrate
#   7. systemd unit + kalici sudoers  <-- kurulum sihirbazindan ONCE
#  7b. /usr/local/bin/lyra symlink'i (status/update/logs/uninstall komutu)
#   8. ERISIM YONTEMI: bulut tespiti + kullaniciya secim (asagida)
#   9. Secilen yonteme gore sihirbazi baslat
#
# 8. adim neden var: bulut saglayicilarda (Oracle/AWS/GCP/Azure) gelen portlar
# Security List / Security Group / NSG katmaninda VARSAYILAN OLARAK KAPALIDIR.
# Instance icinde ufw pasif olsa bile port 80 disaridan erisilemez. Kullaniciya
# "tarayicidan http://<ip> adresine git" demek, erisemeyecegi bir adres
# vermektir. O yuzden sihirbaz baslamadan ONCE nasil erisilecegi soruluyor:
#
#   cf-api : Cloudflare API token + domain -> tunnel SIMDI kurulur, sihirbaz
#            https://<panel-host> uzerinde acilir. HICBIR PORT ACILMAZ.
#   direct : sihirbaz http://<ip>:80 uzerinde acilir (klasik davranis).
#   cli    : sihirbaz burada, terminalde calisir (port gerekmez).
#
# Sihirbaz ayri bir "npm run setup" process'i degil: Lyra systemd altinda
# kurulum modunda baslar (cli yontemi haric). Sihirbaz bitince Lyra drop-in'i
# silip kendini yeniden baslatir — restart edecek birinin var olmasi varsayim
# degil.
#
# Env override'lari: LYRA_REPO, LYRA_DIR, LYRA_BRANCH, LYRA_USER,
#                    LYRA_HOME, LYRA_PORT, LYRA_SETUP_PORT,
#                    LYRA_CF_API_TOKEN (cf-api yonteminde API token'i)
# Bayraklar: --yes / -y / --non-interactive, --access, --domain,
#            --cf-api-token, --cf-account-id, --cf-host-mode,
#            --cf-panel-subdomain, --cf-overwrite-dns, --help

set -euo pipefail

# ------- Renkler / yardimcilar -------
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
Kullanim: sudo bash install.sh [secenekler]

Secenekler:
  -y, --yes, --non-interactive   Hicbir sey sorma, varsayilanlarla devam et
  -h, --help                     Bu yardimi goster

Erisim yontemi (sorulmasin istiyorsan):
  --access <cf-api|direct|cli>
      cf-api : Cloudflare tunnel'i SIMDI kur, sihirbazi https://<panel> ac.
               Hicbir port acilmaz — NAT / bulut firewall'u arkasinda calisir.
      direct : sihirbazi http://<ip>:80 uzerinde ac (klasik davranis).
      cli    : sihirbazi bu terminalde calistir (TTY gerekir).

cf-api icin:
  --domain <alan.adi>            Cloudflare'da kayitli zone (zorunlu)
  --cf-api-token <token>         API token (LYRA_CF_API_TOKEN env'i daha
                                 guvenli — bayrak "ps" ciktisinda gorunur)
  --cf-account-id <id>           token birden fazla hesaba erisiyorsa
  --cf-host-mode <apex|subdomain>  panel apex'te mi alt alan adinda mi
  --cf-panel-subdomain <ad>      subdomain modunda panel adi (varsayilan: lyra)
  --cf-overwrite-dns             cakisan DNS kayitlarinin uzerine yaz

Ortam degiskenleri:
  LYRA_REPO        git repo URL'i (yerel kaynak yoksa zorunlu)
  LYRA_DIR         kurulum dizini            (varsayilan: /opt/lyra)
  LYRA_BRANCH      git branch'i              (varsayilan: main)
  LYRA_USER        Lyra'nin calisacagi kullanici (varsayilan: $SUDO_USER)
  LYRA_HOME        veri dizini               (varsayilan: /var/lib/lyra)
  LYRA_PORT        panel portu               (varsayilan: 3000)
  LYRA_SETUP_PORT  sihirbaz portu, sadece "direct" yonteminde (varsayilan: 80)
  LYRA_CF_API_TOKEN  cf-api yonteminde Cloudflare API token'i
USAGE
}

# Kok/kullanici hatalarinda kullaniciya komutu aynen tekrarlatabilmek icin.
ORIG_ARGS="$*"

ASSUME_YES=0
ACCESS_METHOD=""
CF_API_TOKEN="${LYRA_CF_API_TOKEN:-}"
CF_DOMAIN=""
CF_ACCOUNT_ID=""
CF_HOST_MODE=""
CF_PANEL_SUB=""
CF_OVERWRITE_DNS=0
SETUP_PORT_GIVEN=0
[[ -n "${LYRA_SETUP_PORT:-}" ]] && SETUP_PORT_GIVEN=1

need_value() {
  [[ -n "${2:-}" && "${2:-}" != -* ]] || fail "$1 bir deger bekliyor (yardim: --help)"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -y|--yes|--non-interactive) ASSUME_YES=1 ;;
    -h|--help) usage; exit 0 ;;
    --access) need_value "$1" "${2:-}"; ACCESS_METHOD="$2"; shift ;;
    --access=*) ACCESS_METHOD="${1#*=}" ;;
    --domain) need_value "$1" "${2:-}"; CF_DOMAIN="$2"; shift ;;
    --domain=*) CF_DOMAIN="${1#*=}" ;;
    --cf-api-token) need_value "$1" "${2:-}"; CF_API_TOKEN="$2"; shift ;;
    --cf-api-token=*) CF_API_TOKEN="${1#*=}" ;;
    --cf-account-id) need_value "$1" "${2:-}"; CF_ACCOUNT_ID="$2"; shift ;;
    --cf-account-id=*) CF_ACCOUNT_ID="${1#*=}" ;;
    --cf-host-mode) need_value "$1" "${2:-}"; CF_HOST_MODE="$2"; shift ;;
    --cf-host-mode=*) CF_HOST_MODE="${1#*=}" ;;
    --cf-panel-subdomain) need_value "$1" "${2:-}"; CF_PANEL_SUB="$2"; shift ;;
    --cf-panel-subdomain=*) CF_PANEL_SUB="${1#*=}" ;;
    --cf-overwrite-dns) CF_OVERWRITE_DNS=1 ;;
    *) fail "Bilinmeyen secenek: $1 (yardim: --help)" ;;
  esac
  shift
done

# Kisa adlari da kabul et; gecersiz degeri sessizce yutma.
case "$ACCESS_METHOD" in
  "") : ;;
  cf-api|cloudflare|tunnel) ACCESS_METHOD="cf-api" ;;
  direct|browser|ip) ACCESS_METHOD="direct" ;;
  cli|terminal) ACCESS_METHOD="cli" ;;
  *) fail "Bilinmeyen erisim yontemi: $ACCESS_METHOD
    Gecerli degerler: cf-api, direct, cli (yardim: --help)" ;;
esac
case "$CF_HOST_MODE" in
  ""|apex|subdomain) : ;;
  *) fail "--cf-host-mode yalnizca 'apex' ya da 'subdomain' olabilir (verilen: $CF_HOST_MODE)" ;;
esac

# curl | bash akisinda stdin script'in kendisi — soru soramayiz.
[[ -t 0 ]] || ASSUME_YES=1

# Soru sorulamayacak modda eksik bilgiyi tahmin etmiyoruz. Kontrol BURADA:
# yarim kurulum yapip 10 dakika sonra "domain lazimmis" demek kabul edilemez.
if [[ "$ASSUME_YES" -eq 1 ]]; then
  if [[ "$ACCESS_METHOD" == "cf-api" ]]; then
    [[ -n "$CF_DOMAIN" ]] || fail "--access cf-api icin --domain <alan.adi> gerekli.
    Ornek: sudo LYRA_CF_API_TOKEN=<token> bash $0 --yes --access cf-api --domain ornek.com"
    [[ -n "$CF_API_TOKEN" ]] || fail "--access cf-api icin Cloudflare API token'i gerekli:
    sudo LYRA_CF_API_TOKEN=<token> bash $0 --yes --access cf-api --domain $CF_DOMAIN
    (--cf-api-token <token> de kabul edilir ama 'ps' ciktisinda gorunur)"
  fi
  if [[ "$ACCESS_METHOD" == "cli" ]]; then
    fail "--access cli interaktif bir terminal ister; --yes / curl|bash ile kullanilamaz.
    Tam otomatik terminal kurulumu icin sihirbazi dogrudan cagir:
      node <kurulum-dizini>/src/scripts/setup-cli.js --yes ...  (bkz. --help)"
  fi
fi

confirm() {
  local prompt="$1"
  if [[ "$ASSUME_YES" -eq 1 ]]; then return 0; fi
  local reply=""
  read -rp "$prompt [E/h] " reply
  [[ ! "$reply" =~ ^([hH]|[nN]) ]]
}

# ------- Konfig -------
# Kanonik repo. Yerel bir checkout icinden calistirilirsa o oncelikli (bkz. LOCAL_SRC);
# bu varsayilan yalnizca "curl | bash" gibi kaynaksiz calistirmalarda devreye girer.
LYRA_REPO="${LYRA_REPO:-https://github.com/eminerolll/andromeda-lyra.git}"
LYRA_DIR="${LYRA_DIR:-/opt/lyra}"
LYRA_BRANCH="${LYRA_BRANCH:-main}"
LYRA_HOME="${LYRA_HOME:-/var/lib/lyra}"
LYRA_PORT="${LYRA_PORT:-3000}"
LYRA_SETUP_PORT="${LYRA_SETUP_PORT:-80}"
SRC_DIR="$LYRA_DIR/src"
UNIT_NAME="lyra"
DROPIN_DIR="/etc/systemd/system/${UNIT_NAME}.service.d"
DROPIN_FILE="$DROPIN_DIR/setup-mode.conf"
SETUP_SUDOERS="/etc/sudoers.d/lyra-setup"
LYRA_BIN_LINK="/usr/local/bin/lyra"

cat <<'BANNER'

  __
 / /  _   _ _ __ __ _
/ /  | | | | '__/ _` |
\ \  | |_| | | | (_| |
 \_\  \__, |_|  \__,_|
      |___/
  Self-hosted dev environment

BANNER

# ─────────────────────── 1. Ortam kontrolu ───────────────────────
step "Ortam kontrol ediliyor"

[[ "${EUID:-$(id -u)}" -eq 0 ]] || fail "Bu script root olarak calismali:
    sudo bash $0 $ORIG_ARGS"

[[ -r /etc/os-release ]] || fail "/etc/os-release okunamadi — desteklenmeyen sistem."
# shellcheck disable=SC1091
. /etc/os-release
command -v apt-get >/dev/null 2>&1 || fail "Bu script apt tabanli dagitimlar icindir (Ubuntu/Debian).
    Bulunan dagitim: ${PRETTY_NAME:-bilinmiyor}. Hicbir degisiklik yapilmadi.
    Elle kurulum: INSTALL.md"
[[ -d /run/systemd/system ]] || fail "systemd bulunamadi (PID 1 systemd degil).
    Lyra systemd servisi olarak calisir. Hicbir degisiklik yapilmadi."

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|aarch64) : ;;
  *) fail "Desteklenmeyen mimari: $ARCH (x86_64 veya aarch64 gerekli).
    better-sqlite3 ve NodeSource paketleri bu mimariler icin saglaniyor." ;;
esac
ok "${PRETTY_NAME:-Linux} · $ARCH · systemd"

# Hedef kullanici: Lyra bu kullanici olarak calisir, projeler onun home'unda durur.
TARGET_USER="${LYRA_USER:-${SUDO_USER:-root}}"
if ! id "$TARGET_USER" >/dev/null 2>&1; then
  fail "Kullanici bulunamadi: $TARGET_USER
    Dogru kullaniciyi ver: sudo LYRA_USER=<kullanici> bash $0"
fi
TARGET_GROUP="$(id -gn "$TARGET_USER")"
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
[[ -n "$TARGET_HOME" ]] || TARGET_HOME="/home/$TARGET_USER"
PROJECTS_DIR="$TARGET_HOME/projects"

if [[ "$TARGET_USER" == "root" ]]; then
  warn "Lyra root olarak calisacak. Onerilmez — normal bir kullanici tercih et:"
  warn "  sudo LYRA_USER=<kullanici> bash $0"
fi
ok "Hedef kullanici: $TARGET_USER ($TARGET_HOME)"

# Kaynak: yerel checkout mu, git repo mu?
LOCAL_SRC=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -f "$SCRIPT_DIR/src/package.json" ]]; then LOCAL_SRC="$SCRIPT_DIR"; fi
fi
if [[ -z "$LOCAL_SRC" && -z "${LYRA_REPO:-}" && ! -d "$LYRA_DIR/.git" ]]; then
  fail "Kaynak kodu bulunamadi.
    Ya repo URL'i ver:
      sudo LYRA_REPO=https://github.com/eminerolll/andromeda-lyra.git bash $0
    ya da repo'yu klonlayip klasorun icinden calistir:
      git clone <repo> lyra && cd lyra && sudo ./install.sh"
fi

echo
info "Kurulum plani:"
info "  kod       : $LYRA_DIR   ($([[ -n "$LOCAL_SRC" ]] && echo "yerel kopya: $LOCAL_SRC" || echo "${LYRA_REPO:-mevcut git remote}"))"
info "  veri      : $LYRA_HOME"
info "  kullanici : $TARGET_USER"
info "  servis    : ${UNIT_NAME}.service (port $LYRA_PORT)"
info "  sihirbaz  : erisim yontemi paketler kurulduktan sonra sorulacak"
echo
confirm "Devam edilsin mi?" || fail "Iptal edildi."

# Hedef kullanici olarak komut calistir (HOME dogru olsun diye -H).
as_target() { sudo -u "$TARGET_USER" -H "$@"; }

# ─────────────────────── 2. Bagimliliklar ───────────────────────
step "Sistem paketleri"

export DEBIAN_FRONTEND=noninteractive
info "apt-get update..."
apt-get update -qq
info "git curl ca-certificates iproute2 build-essential sudo kuruluyor..."
apt-get install -y -qq git curl ca-certificates iproute2 build-essential sudo
ok "Temel paketler hazir"

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

if command -v node >/dev/null 2>&1 && [[ "$(node_major)" -ge 20 ]]; then
  ok "Node.js $(node -v) (mevcut)"
else
  if command -v node >/dev/null 2>&1; then
    warn "Node.js $(node -v) cok eski, 20.x kurulacak"
  fi
  info "Node.js 20 kuruluyor (NodeSource)..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
  command -v node >/dev/null 2>&1 || fail "Node.js kurulamadi."
  [[ "$(node_major)" -ge 20 ]] || fail "Node.js 20+ kurulamadi (bulundu: $(node -v))."
  ok "Node.js $(node -v)"
fi

# ─────────────────────── 3. Kaynak kodu ───────────────────────
step "Kaynak kodu"

if [[ -d "$LYRA_DIR/.git" ]]; then
  info "$LYRA_DIR guncelleniyor..."
  # Repo hedef kullaniciya ait, git'i root calistiriyor: "dubious ownership".
  if ! git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$LYRA_DIR"; then
    git config --global --add safe.directory "$LYRA_DIR"
  fi
  git -C "$LYRA_DIR" fetch --quiet origin
  git -C "$LYRA_DIR" checkout --quiet "$LYRA_BRANCH"
  git -C "$LYRA_DIR" pull --quiet --ff-only origin "$LYRA_BRANCH"
  ok "Repo guncel ($LYRA_BRANCH)"
elif [[ -n "${LYRA_REPO:-}" ]]; then
  info "Repo klonlaniyor: $LYRA_REPO"
  # Once gecici dizine klonla, sonra icerigi tasi: mevcut $LYRA_DIR icindeki
  # .env / veri silinmesin (rm -rf ile klonlamak idempotent degildir).
  TMP_CLONE="$(mktemp -d)"
  git clone --quiet -b "$LYRA_BRANCH" "$LYRA_REPO" "$TMP_CLONE/lyra"
  mkdir -p "$LYRA_DIR"
  tar -C "$TMP_CLONE/lyra" --exclude=node_modules -cf - . | tar -C "$LYRA_DIR" -xf -
  rm -rf "$TMP_CLONE"
  ok "Clone tamam"
elif [[ -n "$LOCAL_SRC" ]]; then
  if [[ "$LOCAL_SRC" == "$LYRA_DIR" ]]; then
    info "Kod zaten $LYRA_DIR icinde"
  else
    info "Yerel kopya aliniyor: $LOCAL_SRC -> $LYRA_DIR"
    mkdir -p "$LYRA_DIR"
    tar -C "$LOCAL_SRC" --exclude=node_modules --exclude=.git -cf - . \
      | tar -C "$LYRA_DIR" -xf -
    ok "Kopyalandi"
  fi
else
  fail "Kaynak kodu alinamadi (beklenmedik durum)."
fi

[[ -f "$SRC_DIR/package.json" ]] || fail "$SRC_DIR/package.json bulunamadi — kaynak agaci beklenen yapida degil."
chown -R "$TARGET_USER:$TARGET_GROUP" "$LYRA_DIR"

# ─────────────────────── 4. npm ───────────────────────
step "Node bagimliliklari"

if [[ -f "$SRC_DIR/package-lock.json" ]]; then
  info "npm ci --omit=dev (lock dosyasindan)..."
  ( cd "$SRC_DIR" && as_target npm ci --omit=dev --no-audit --no-fund )
else
  warn "package-lock.json yok — npm install kullaniliyor"
  ( cd "$SRC_DIR" && as_target npm install --omit=dev --no-audit --no-fund )
fi
ok "Bagimliliklar kuruldu"

# ─────────────────────── 5. .env + veri dizini ───────────────────────
step "Yapilandirma"

if [[ -f "$SRC_DIR/.env" ]]; then
  info ".env mevcut, uzerine yazilmadi"
else
  cat > "$SRC_DIR/.env" <<EOF
# Lyra bootstrap ayarlari — install.sh tarafindan uretildi.
# Geri kalan her sey SQLite'ta (LYRA_HOME/lyra.db) tutulur.
LYRA_HOME=$LYRA_HOME
LYRA_PORT=$LYRA_PORT
NODE_ENV=production
EOF
  chown "$TARGET_USER:$TARGET_GROUP" "$SRC_DIR/.env"
  chmod 600 "$SRC_DIR/.env"
  ok ".env yazildi (LYRA_HOME=$LYRA_HOME)"
fi

mkdir -p "$LYRA_HOME"
chown "$TARGET_USER:$TARGET_GROUP" "$LYRA_HOME"
chmod 700 "$LYRA_HOME"
ok "Veri dizini: $LYRA_HOME"

# ─────────────────────── 6. Migrate ───────────────────────
step "Veritabani"
( cd "$SRC_DIR" && as_target env LYRA_HOME="$LYRA_HOME" npm run --silent migrate )
ok "Migrasyonlar uygulandi"

setup_complete() {
  ( cd "$SRC_DIR" && as_target env LYRA_HOME="$LYRA_HOME" node -e \
      'process.exit(require("./db/repos").users.exists() ? 0 : 1)' )
}

# ─────────────────────── 7. systemd + sudoers ───────────────────────
step "systemd servisi"

node "$SRC_DIR/scripts/generate-systemd.js" \
  --user "$TARGET_USER" \
  --workdir "$SRC_DIR" \
  --home "$LYRA_HOME" \
  --port "$LYRA_PORT" \
  --projects-dir "$PROJECTS_DIR" \
  --name "$UNIT_NAME" >/dev/null
ok "/etc/systemd/system/${UNIT_NAME}.service yazildi"

node "$SRC_DIR/scripts/generate-sudoers.js" \
  --user "$TARGET_USER" --name "$UNIT_NAME" >/dev/null
ok "/etc/sudoers.d/lyra yazildi (dar kapsamli)"

# ─────────────────────── 7b. lyra komutu ───────────────────────
step "lyra komutu"

# Kaynak elle kopyalanmis (tar/scp/rsync, hatta Windows uzerinden) olabilir;
# calistirma bitleri kaybolmus olabilir. Symlink'ten once geri veriyoruz.
LYRA_BIN="$SRC_DIR/bin/lyra.js"
if [[ -f "$LYRA_BIN" ]]; then
  chmod +x "$LYRA_BIN"
  if [[ -f "$LYRA_DIR/uninstall.sh" ]]; then chmod +x "$LYRA_DIR/uninstall.sh"; fi
  if [[ -f "$LYRA_DIR/lyra-connect" ]]; then chmod +x "$LYRA_DIR/lyra-connect"; fi
  ln -sfn "$LYRA_BIN" "$LYRA_BIN_LINK"
  ok "$LYRA_BIN_LINK -> $LYRA_BIN"
else
  warn "$LYRA_BIN bulunamadi — 'lyra' komutu kurulmadi"
fi

# ─────────────────────── 8. Kurulum modu ───────────────────────
if setup_complete; then
  step "Servis baslatiliyor"
  info "Kurulum daha once tamamlanmis (yonetici hesabi mevcut) — sihirbaz atlandi."
  rm -f "$DROPIN_FILE" "$SETUP_SUDOERS"
  systemctl daemon-reload
  systemctl enable --quiet "$UNIT_NAME"
  systemctl restart "$UNIT_NAME" || true
  sleep 2
  if systemctl is-active --quiet "$UNIT_NAME"; then
    ok "${UNIT_NAME}.service calisiyor (port $LYRA_PORT)"
  else
    echo
    journalctl -u "$UNIT_NAME" -n 30 --no-pager || true
    fail "${UNIT_NAME}.service baslatilamadi (yukaridaki loga bak)."
  fi
  echo
  ok "Lyra guncellendi."
  echo "  Durum     : lyra status"
  echo "  Log       : lyra logs"
  echo "  Guncelle  : sudo lyra update"
  echo "  Kaldir    : sudo lyra uninstall"
  exit 0
fi

# ─────────────────────── 8. Erisim yontemi ───────────────────────
#
# Bu bolum kurulumun geri kalanini belirler. Amaci tek bir gercek dunya
# hatasini kapatmak: kullaniciya erisemeyecegi bir adres vermek.

step "Erisim yontemi"

# Bulut tespiti — 169.254.169.254 metadata servisi, kisa timeout.
# Ag yoksa/adres yonlendirilmiyorsa sessizce bos doner, kurulum gecikmez.
CLOUD_ID=""
CLOUD_NAME=""
if [[ -f "$SRC_DIR/lib/cloud-detect.js" ]]; then
  CLOUD_RAW="$(node "$SRC_DIR/lib/cloud-detect.js" --timeout 1500 2>/dev/null || true)"
  CLOUD_RAW="${CLOUD_RAW//[$'\r\n']/}"
  if [[ -n "$CLOUD_RAW" ]]; then
    CLOUD_ID="${CLOUD_RAW%%|*}"
    CLOUD_NAME="${CLOUD_RAW#*|}"
  fi
fi

# Bulut tespit edildiyse "makine disaridan erisilebilir" VARSAYILAN OLMAZ.
DEFAULT_CHOICE=2
if [[ -n "$CLOUD_ID" ]]; then
  DEFAULT_CHOICE=1
  warn "Bulut sunucusu tespit edildi ($CLOUD_NAME)."
  warn "Bulut saglayicilarda gelen portlar (Security List / Security Group / NSG)"
  warn "varsayilan olarak kapali olabilir: makine icinde firewall kapali olsa bile"
  warn "http://<ip> adresi disaridan calismayabilir."
else
  info "Bulut metadata servisi cevap vermedi — fiziksel/ev sunucusu varsayiliyor."
fi

print_access_menu() {
  local rec1="" rec2=""
  if [[ "$DEFAULT_CHOICE" -eq 1 ]]; then
    rec1=" ${C_GREEN}(onerilen)${C_RESET}"
  else
    rec2=" ${C_GREEN}(onerilen)${C_RESET}"
  fi
  echo
  echo "  Bu panele nasil erisecegini sec:"
  echo
  echo -e "    ${C_CYAN}1)${C_RESET} Cloudflare domain'im var${rec1}"
  echo -e "       ${C_DIM}API token + domain -> tunnel SIMDI kurulur, sihirbaz${C_RESET}"
  echo -e "       ${C_DIM}https://lyra.alanadin.com gibi bir adreste acilir.${C_RESET}"
  echo -e "       ${C_DIM}Hicbir port acilmaz; NAT/bulut firewall'u arkasinda da calisir.${C_RESET}"
  echo
  echo -e "    ${C_CYAN}2)${C_RESET} Bu makine disaridan erisilebilir${rec2}"
  echo -e "       ${C_DIM}Sihirbaz http://<ip>:${LYRA_SETUP_PORT} adresinde acilir.${C_RESET}"
  echo -e "       ${C_DIM}Port ${LYRA_SETUP_PORT} gercekten disariya acik olmali.${C_RESET}"
  echo
  echo -e "    ${C_CYAN}3)${C_RESET} Ne domain'im var ne de port acabiliyorum"
  echo -e "       ${C_DIM}Sihirbaz burada, terminalde calisir (CLI).${C_RESET}"
  echo
}

choose_access() {
  local reply=""
  while true; do
    print_access_menu
    read -rp "  Secim [1-3] (varsayilan: $DEFAULT_CHOICE): " reply || reply=""
    reply="${reply// /}"
    reply="${reply:-$DEFAULT_CHOICE}"
    case "$reply" in
      1) ACCESS_METHOD="cf-api"; return 0 ;;
      2) ACCESS_METHOD="direct"; return 0 ;;
      3) ACCESS_METHOD="cli"; return 0 ;;
      *) warn "Gecersiz secim: $reply (1, 2 ya da 3)" ;;
    esac
  done
}

if [[ -z "$ACCESS_METHOD" ]]; then
  if [[ "$ASSUME_YES" -eq 1 ]]; then
    # Non-interactive: bugunku davranisi koru, ama bulutta sessiz kalma.
    ACCESS_METHOD="direct"
    if [[ -n "$CLOUD_ID" ]]; then
      warn "Non-interactive mod: 'direct' yontemi secildi (sihirbaz port $LYRA_SETUP_PORT)."
      warn "Bulut firewall'unda bu port kapaliysa sihirbaza ERISEMEZSIN. Tunnel icin:"
      warn "  sudo LYRA_CF_API_TOKEN=<token> bash $0 --yes --access cf-api --domain <alan.adi>"
    fi
  else
    choose_access
  fi
fi

# (Bayrak dogrulamasi arguman ayristirmasinda yapildi — buraya gelen
#  ACCESS_METHOD calistirilabilir durumda.)

if [[ "$ACCESS_METHOD" == "cf-api" && "$SETUP_PORT_GIVEN" -eq 1 ]]; then
  warn "LYRA_SETUP_PORT verilmis ama tunnel yonteminde kullanilmiyor:"
  warn "sihirbaz Lyra'nin kendi portunda ($LYRA_PORT) calisir, disari port acilmaz."
fi

# ─────────────────────── 9. Kurulum sihirbazi ───────────────────────
step "Kurulum sihirbazi"

# Kurulum fazinin gecici tam-yetki sudoers dosyasi (cloudflared/Caddy kurulumu,
# firewall, systemd gecisi). Uc yontemin de ihtiyaci var; sihirbaz bitince
# Lyra siler (bkz. lib/setup-core.js -> runPostSetup).
node "$SRC_DIR/scripts/generate-sudoers.js" \
  --user "$TARGET_USER" --name "$UNIT_NAME" --setup >/dev/null
ok "$SETUP_SUDOERS yazildi (gecici — sihirbaz bitince silinir)"

# Token'i ne argv'ye ne de cocuk process'in env'ine koyuyoruz: ikisi de "ps"
# ciktisinda gorunebilir. 0600 gecici dosya, yol olarak gecirilir ve her
# durumda (hata/iptal dahil) silinir.
CF_TOKEN_FILE=""
cleanup_token_file() {
  if [[ -n "$CF_TOKEN_FILE" ]]; then
    rm -f "$CF_TOKEN_FILE"
    CF_TOKEN_FILE=""
  fi
}
trap cleanup_token_file EXIT

write_token_file() {
  CF_TOKEN_FILE="$(mktemp)"
  chmod 600 "$CF_TOKEN_FILE"
  chown "$TARGET_USER:$TARGET_GROUP" "$CF_TOKEN_FILE"
  printf '%s' "$1" > "$CF_TOKEN_FILE"
}

# Tunnel kurulumu. Dogrulama, DNS cakismasi ve kurulum adimlari sihirbazla
# AYNI cekirdekten gelir (lib/setup-core.js); burada kopya mantik yok.
provision_cloudflare() {
  local rc=0
  local -a cmd=(node scripts/setup-cli.js --provision-tunnel)
  [[ -n "$CF_TOKEN_FILE" ]] && cmd+=(--cf-api-token-file "$CF_TOKEN_FILE")
  [[ -n "$CF_DOMAIN" ]] && cmd+=(--domain "$CF_DOMAIN")
  [[ -n "$CF_ACCOUNT_ID" ]] && cmd+=(--cf-account-id "$CF_ACCOUNT_ID")
  [[ -n "$CF_HOST_MODE" ]] && cmd+=(--cf-host-mode "$CF_HOST_MODE")
  [[ -n "$CF_PANEL_SUB" ]] && cmd+=(--cf-panel-subdomain "$CF_PANEL_SUB")
  [[ "$CF_OVERWRITE_DNS" -eq 1 ]] && cmd+=(--cf-overwrite-dns)
  [[ "$ASSUME_YES" -eq 1 ]] && cmd+=(--yes)
  ( cd "$SRC_DIR" && as_target env LYRA_HOME="$LYRA_HOME" "${cmd[@]}" ) || rc=$?
  return "$rc"
}

# Kurulum modu drop-in'i. Sihirbaz bitince Lyra bu dosyayi kendisi siler
# (lib/setup-core.js -> setup-mode-off adimi).
write_setup_dropin() {
  mkdir -p "$DROPIN_DIR"
  if [[ "$1" == "tunnel" ]]; then
    # Tunnel modunda ayri bir kurulum portu YOK: cloudflared zaten
    # localhost:$LYRA_PORT'a bakiyor, sihirbaz dogrudan orada calisir.
    # Bu yuzden LYRA_SETUP_PORT, CAP_NET_BIND_SERVICE ve ProtectSystem=off
    # gerekmiyor — kurulum bitince degisen tek sey uygulama modu.
    cat > "$DROPIN_FILE" <<EOF
# Lyra kurulum modu (tunnel) — install.sh tarafindan yazildi, GECICI.
# Sihirbaz Lyra'nin kendi portunda ($LYRA_PORT) calisir; disari port acilmaz.
# Sihirbaz bitince Lyra bu dosyayi silip kendini yeniden baslatir.
# Elle cikmak icin:
#   sudo rm -f $DROPIN_FILE
#   sudo systemctl daemon-reload && sudo systemctl restart $UNIT_NAME
[Service]
Environment=LYRA_SETUP_MODE=1
EOF
  else
    cat > "$DROPIN_FILE" <<EOF
# Lyra kurulum modu — install.sh tarafindan yazildi, GECICI.
# Sihirbaz bitince Lyra bu dosyayi silip kendini yeniden baslatir.
# Elle cikmak icin:
#   sudo rm -f $DROPIN_FILE
#   sudo systemctl daemon-reload && sudo systemctl restart $UNIT_NAME
[Service]
Environment=LYRA_SETUP_MODE=1
Environment=LYRA_SETUP_PORT=$LYRA_SETUP_PORT
# Ayricalikli olmayan kullanicinin 80'e bind edebilmesi icin
AmbientCapabilities=CAP_NET_BIND_SERVICE
# Kurulum fazinda Caddy/cloudflared apt+dpkg ile kurulur; /etc ve /usr'a yazilir.
ProtectSystem=off
EOF
  fi
  chmod 644 "$DROPIN_FILE"
  ok "Kurulum modu drop-in'i yazildi"
}

start_setup_service() {
  systemctl daemon-reload
  systemctl enable --quiet "$UNIT_NAME"
  systemctl restart "$UNIT_NAME" || true
  sleep 2
  if ! systemctl is-active --quiet "$UNIT_NAME"; then
    echo
    journalctl -u "$UNIT_NAME" -n 30 --no-pager || true
    fail "${UNIT_NAME}.service baslatilamadi (yukaridaki loga bak)."
  fi
  ok "${UNIT_NAME}.service kurulum modunda calisiyor"
}

make_setup_token() {
  local tok=""
  tok="$( cd "$SRC_DIR" && as_target env LYRA_HOME="$LYRA_HOME" node -e \
    'const t=require("./lib/setup-token");const tok=t.generate();t.save(tok);console.log(tok);' )"
  [[ -n "$tok" ]] || fail "Kurulum token'i uretilemedi."
  printf '%s' "$tok"
}

print_token_block() {
  echo
  echo "  Kurulum token'i (tarayiciya yapistir):"
  echo
  echo -e "    ${C_CYAN}${1}${C_RESET}"
  echo
  echo -e "${C_DIM}  Token 1 saat gecerlidir. Yenisi icin:${C_RESET}"
  echo -e "${C_DIM}    cd $SRC_DIR && sudo -u $TARGET_USER node -e 'const t=require(\"./lib/setup-token\");const k=t.generate();t.save(k);console.log(k)'${C_RESET}"
  echo -e "${C_DIM}────────────────────────────────────────────────────────────${C_RESET}"
}

print_footer() {
  echo
  warn "Kurulumu yarida birakirsan gecici tam-yetki sudoers dosyasi geride kalir:"
  warn "  sudo rm -f $SETUP_SUDOERS"
  echo
  echo "  Log    : lyra logs"
  echo "  Durum  : lyra status"
  echo "  Kaldir : sudo lyra uninstall"
  echo
}

# ---- Yontem 1: Cloudflare tunnel'i simdi kur ----
if [[ "$ACCESS_METHOD" == "cf-api" ]]; then
  [[ -n "$CF_API_TOKEN" ]] && write_token_file "$CF_API_TOKEN"
  while true; do
    PROVISION_RC=0
    provision_cloudflare || PROVISION_RC=$?
    cleanup_token_file
    [[ "$PROVISION_RC" -eq 0 ]] && break
    [[ "$PROVISION_RC" -eq 130 ]] && fail "Iptal edildi. Tunnel kurulmadi."
    if [[ "$ASSUME_YES" -eq 1 ]]; then
      rm -f "$SETUP_SUDOERS"
      fail "Cloudflare kurulumu basarisiz — hicbir sey kurulmadi."
    fi
    echo
    warn "Cloudflare kurulumu tamamlanmadi. Baska bir yontem de secebilirsin."
    choose_access
    [[ "$ACCESS_METHOD" != "cf-api" ]] && break
    # Yeniden denemede token/domain bastan sorulsun.
    CF_DOMAIN=""
    CF_ACCOUNT_ID=""
  done
fi

case "$ACCESS_METHOD" in
  # ---- Yontem 1 (devami): sihirbaz tunnel uzerinden ----
  cf-api)
    write_setup_dropin tunnel
    SETUP_TOKEN="$(make_setup_token)"
    start_setup_service

    PANEL_HOST="$( cd "$SRC_DIR" && as_target env LYRA_HOME="$LYRA_HOME" node -e \
      'process.stdout.write(String(require("./db/repos").settings.get("panel_host")||""))' )"
    [[ -n "$PANEL_HOST" ]] || fail "Panel adresi ayarlardan okunamadi (beklenmedik durum)."

    echo
    echo -e "${C_DIM}────────────────────────────────────────────────────────────${C_RESET}"
    echo "  Tarayicidan kuruluma devam et:"
    echo
    echo -e "    ${C_CYAN}https://${PANEL_HOST}${C_RESET}"
    print_token_block "$SETUP_TOKEN"
    echo
    info "Tunnel uzerinden yayindasin — sunucuda hicbir port acilmadi."
    info "Adres hemen acilmazsa DNS/tunnel yayilmasi icin 1-2 dakika bekle."
    info "Sihirbaz bitince Lyra ayni portta ($LYRA_PORT) normal moda gecer."
    print_footer
    ;;

  # ---- Yontem 2: klasik davranis, sihirbaz port 80'de ----
  direct)
    write_setup_dropin port

    # UFW acikken sihirbazin portu disaridan erisilemez olurdu.
    if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi '^Status: active'; then
      if ufw status | grep -qE "^${LYRA_SETUP_PORT}(/tcp)?[[:space:]]"; then
        info "UFW: ${LYRA_SETUP_PORT}/tcp zaten acik, dokunulmadi"
      else
        ufw allow "${LYRA_SETUP_PORT}/tcp" comment "lyra-setup" >/dev/null
        ok "UFW: ${LYRA_SETUP_PORT}/tcp acildi (sihirbaz bitince kapatilir)"
      fi
    else
      info "UFW aktif degil — firewall'a dokunulmadi"
    fi

    SETUP_TOKEN="$(make_setup_token)"
    start_setup_service

    PUBLIC_IP="$(curl -fsS --max-time 4 https://api.ipify.org 2>/dev/null || true)"
    LOCAL_IPS="$(hostname -I 2>/dev/null || true)"
    PORT_SUFFIX=""
    if [[ "$LYRA_SETUP_PORT" != "80" ]]; then PORT_SUFFIX=":$LYRA_SETUP_PORT"; fi

    echo
    echo -e "${C_DIM}────────────────────────────────────────────────────────────${C_RESET}"
    echo "  Tarayicidan kuruluma devam et:"
    echo
    if [[ -n "$PUBLIC_IP" ]]; then
      echo -e "    ${C_CYAN}http://${PUBLIC_IP}${PORT_SUFFIX}${C_RESET}"
    fi
    # Kelime bolunmesi kasitli: hostname -I bosluklu liste doner.
    # shellcheck disable=SC2086
    for ip in $LOCAL_IPS; do
      echo -e "    ${C_CYAN}http://${ip}${PORT_SUFFIX}${C_RESET}"
    done
    print_token_block "$SETUP_TOKEN"
    echo
    info "Sihirbaz bitince Lyra kurulum modundan cikip port $LYRA_PORT'a gecer."
    echo
    info "Bu adres acilmiyorsa port ${LYRA_SETUP_PORT} disariya kapali demektir."
    info "Sihirbazi terminalde de calistirabilirsin:"
    info "  sudo systemctl stop $UNIT_NAME"
    info "  cd $SRC_DIR && sudo -u $TARGET_USER LYRA_HOME=$LYRA_HOME node scripts/setup-cli.js"
    print_footer
    ;;

  # ---- Yontem 3: sihirbaz burada, terminalde ----
  cli)
    # Kurulum modu drop-in'i YOK: sihirbaz ayri bir process olarak calisir,
    # servisi kurulum bitince kendisi baslatir (transition "direct").
    rm -f "$DROPIN_FILE"
    systemctl daemon-reload
    systemctl enable --quiet "$UNIT_NAME"
    systemctl stop "$UNIT_NAME" 2>/dev/null || true

    echo
    info "Terminal sihirbazi baslatiliyor (iptal: Ctrl-C)."
    CLI_RC=0
    ( cd "$SRC_DIR" && as_target env LYRA_HOME="$LYRA_HOME" node scripts/setup-cli.js ) || CLI_RC=$?

    if [[ "$CLI_RC" -eq 0 ]]; then
      echo
      ok "Kurulum tamamlandi."
      echo "  Durum     : lyra status"
      echo "  Log       : lyra logs"
      echo "  Guncelle  : sudo lyra update"
      echo "  Kaldir    : sudo lyra uninstall"
      echo
      exit 0
    fi

    echo
    if [[ "$CLI_RC" -eq 130 ]]; then
      warn "Sihirbaz iptal edildi. Hicbir ayar yazilmadi."
    else
      warn "Sihirbaz hatayla bitti (cikis kodu $CLI_RC)."
    fi
    info "Tekrar calistirmak icin:"
    info "  cd $SRC_DIR && sudo -u $TARGET_USER LYRA_HOME=$LYRA_HOME node scripts/setup-cli.js"
    print_footer
    exit "$CLI_RC"
    ;;
esac
