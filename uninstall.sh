#!/usr/bin/env bash
# uninstall.sh — toglie web-vision da Claude Code.
#
#   bash uninstall.sh           deregistra il server MCP (i file restano)
#   bash uninstall.sh --purge   deregistra e cancella i file di web-vision e il login salvato
#
# --purge cancella SOLO i file di questo pacchetto, per nome, dopo aver
# verificato che la cartella sia davvero web-vision; la cartella viene tolta
# solo se poi è vuota. Qualsiasi altro file presente resta dov'è.
#
# Se l'avevi installato con WEB_VISION_SCOPE=local, lancia questo script dalla
# cartella del progetto, con la stessa variabile.
#
# Chromium in ~/Library/Caches/ms-playwright (Mac) o ~/.cache/ms-playwright
# (Linux) NON viene toccato: può servire ad altri strumenti.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="${WEB_VISION_NAME:-web-vision}"
SCOPE="${WEB_VISION_SCOPE:-user}"
STATE_DIR="${HOME%/}/.cache/web-vision"
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

die() { echo "uninstall.sh: $*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "lancialo come il tuo utente, non con sudo"

# I file che appartengono al pacchetto. Solo questi vengono cancellati.
OWN_FILES="server.mjs selftest.mjs install.sh uninstall.sh config.json package.json package-lock.json README.md"

if [ "$PURGE" -eq 1 ]; then
  # Prima di toccare qualsiasi cosa: questa cartella è davvero web-vision?
  grep -q '"name": *"web-vision-claude-code"' "$DIR/package.json" 2>/dev/null ||
    die "$DIR non sembra la cartella di web-vision (manca package.json di web-vision): non cancello niente"
fi

if command -v claude >/dev/null; then
  if claude mcp remove -s "$SCOPE" "$NAME" >/dev/null 2>&1; then
    echo "==> server MCP '$NAME' rimosso da Claude Code (scope: $SCOPE)"
  else
    echo "==> server MCP '$NAME' non era registrato (scope: $SCOPE)"
  fi
else
  echo "==> 'claude' non è nel PATH: niente da deregistrare"
fi

# Le sessioni di Claude Code già aperte tengono vivo il server fino alla loro
# chiusura; qui si chiudono subito i processi lanciati da questa cartella.
PIDS="$(pgrep -f "^node $DIR/server\.mjs$" || true)"
if [ -n "$PIDS" ]; then
  kill $PIDS 2>/dev/null || true
  echo "==> fermati i server ancora attivi (pid: $(echo $PIDS))"
fi

if [ "$PURGE" -eq 0 ]; then
  echo "    I file restano in $DIR (usa --purge per cancellarli)."
  [ -f "$STATE_DIR/storage-state.json" ] && echo "    Il login salvato resta in $STATE_DIR (contiene cookie: --purge lo cancella)."
  echo "Fatto."
  exit 0
fi

# login salvato: solo i file di web-vision, poi la cartella se vuota
if [ -f "$STATE_DIR/storage-state.json" ]; then
  rm -f "$STATE_DIR/storage-state.json"
  echo "==> cancellato il login salvato (cookie e localStorage dei siti visitati)"
fi
if [ -d "$STATE_DIR" ]; then
  rm -f "$STATE_DIR"/storage-state.json.*.tmp
  rmdir "$STATE_DIR" 2>/dev/null || true
fi

# file del pacchetto, per nome
for f in $OWN_FILES; do rm -f "$DIR/$f"; done
if [ -L "$DIR/node_modules" ]; then
  rm -f "$DIR/node_modules"
elif [ -d "$DIR/node_modules" ] && [ -d "$DIR/node_modules/playwright-core" ]; then
  rm -rf "$DIR/node_modules"
fi

if rmdir "$DIR" 2>/dev/null; then
  echo "==> cancellata la cartella $DIR"
else
  echo "==> cancellati i file di web-vision; la cartella $DIR contiene altri file e resta:"
  ls -A "$DIR" | sed 's/^/      /'
fi
echo "Fatto."
