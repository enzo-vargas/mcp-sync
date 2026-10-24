#!/usr/bin/env sh
# mcp-sync setup + health checkup (READ-ONLY).
# Delegates to `mcp-sync doctor`, which prints a full report ending in a HEALTH: line.
# Never writes to any config. Always exits 0 (the HEALTH: line is the signal).

set -u

BIN="mcp-sync"
if ! command -v "$BIN" >/dev/null 2>&1; then
  echo "mcp-sync: NOT INSTALLED (not on PATH)"
  echo "  install: git clone https://github.com/enzo-vargas/mcp-sync && cd mcp-sync && npm install && npm link"
  echo "HEALTH: not-installed"
  exit 0
fi

"$BIN" doctor || true
exit 0
