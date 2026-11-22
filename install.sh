#!/usr/bin/env bash
# install.sh — installa web-vision e lo registra in Claude Code.
#
#   bash install.sh           installa (o aggiorna) per l'utente corrente
#
# Da lanciare come il TUO utente, non con sudo: la registrazione dei server MCP
# di Claude Code è per utente (~/.claude.json). La cartella può stare dove vuoi;
# Claude Code la usa dal percorso in cui si trova al momento dell'installazione.
#
# Variabili opzionali:
#   WEB_VISION_NAME=web-vision   nome del server MCP in Claude Code
#   WEB_VISION_SCOPE=user        user  = tutti i tuoi progetti (default)
#                                local = solo il progetto da cui lanci lo script:
#                                        cd ~/mio-progetto && WEB_VISION_SCOPE=local bash ~/web_vision_claude_code/install.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CALLER_DIR="$PWD"   # per lo scope "local": il progetto è la cartella da cui si lancia
NAME="${WEB_VISION_NAME:-web-vision}"
SCOPE="${WEB_VISION_SCOPE:-user}"

die() { echo "install.sh: $*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "non lanciarlo come root: registrerebbe il server per root, non per te"

# --------------------------------------------------------------------------
# requisiti
# --------------------------------------------------------------------------
if [ "$(uname -s)" = "Darwin" ]; then
  MACOS="$(sw_vers -productVersion 2>/dev/null || echo 0)"
  # Il Chromium di questa versione di Playwright non esiste per macOS 13 e precedenti.
  [ "${MACOS%%.*}" -ge 14 ] || die "serve macOS 14 o più recente (questo è macOS $MACOS)"
  BROWSERS="$HOME/Library/Caches/ms-playwright"
else
  BROWSERS="$HOME/.cache/ms-playwright"
fi
command -v node >/dev/null || die "serve Node.js 20 o più recente (non trovato). Su Mac: brew install node"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "serve Node.js 20 o più recente (trovato $(node --version)). Su Mac: brew upgrade node"
command -v npm >/dev/null || die "serve npm (non trovato)"
command -v claude >/dev/null || die "serve Claude Code: il comando 'claude' non è nel PATH"
[ -w "$DIR" ] || die "non posso scrivere in $DIR — dai la cartella al tuo utente: sudo chown -R $(id -un) \"$DIR\""
echo "==> node $(node --version), $(claude --version 2>/dev/null | head -1)"

# --------------------------------------------------------------------------
# dipendenze
# --------------------------------------------------------------------------
echo "==> dipendenze npm in $DIR"
cd "$DIR"
if [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund >/dev/null
else
  npm install --omit=dev --no-audit --no-fund >/dev/null
fi

# --------------------------------------------------------------------------
# Chromium: quello della versione esatta di playwright-core
# --------------------------------------------------------------------------
if node --input-type=module -e '
  import { chromium } from "playwright-core"; import { existsSync } from "node:fs"
  process.exit(existsSync(chromium.executablePath()) ? 0 : 1)' 2>/dev/null; then
  echo "==> Chromium già presente"
else
  # --no-shell: il server usa il Chromium completo; la variante "headless
  # shell" sarebbe un secondo download inutile (~260 MB su disco).
  echo "==> scarico Chromium (~180 MB, una volta sola, in $BROWSERS)"
  node node_modules/playwright-core/cli.js install --no-shell chromium
fi

# --------------------------------------------------------------------------
# prova prima di registrare: se non funziona qui, non funzionerà in Claude Code
# --------------------------------------------------------------------------
echo "==> selftest"
if ! node selftest.mjs; then
  echo >&2
  echo "Se l'errore parla di librerie mancanti (libnss3, libatk, libgbm…), su Linux installale con:" >&2
  echo "  sudo node $DIR/node_modules/playwright-core/cli.js install-deps chromium" >&2
  exit 1
fi

# --------------------------------------------------------------------------
# registrazione in Claude Code
# --------------------------------------------------------------------------
echo "==> registro il server MCP '$NAME' (scope: $SCOPE)"
(
  # Lo scope "local" vale per la cartella da cui si lancia claude: quella del
  # chiamante, non questa.
  cd "$CALLER_DIR"
  claude mcp remove -s "$SCOPE" "$NAME" >/dev/null 2>&1 || true
  claude mcp add -s "$SCOPE" "$NAME" -- node "$DIR/server.mjs" >/dev/null
  claude mcp get "$NAME" 2>&1 | sed 's/^/    /'
)

echo
echo "Fatto. Apri una NUOVA sessione di Claude Code (quelle già aperte non lo vedono):"
echo "i tool compaiono come mcp__${NAME}__browser_look, _open, _act, _console, _eval."
[ "$SCOPE" = "local" ] && echo "Registrato solo per il progetto in $CALLER_DIR."
echo "Configurazione: $DIR/config.json"
