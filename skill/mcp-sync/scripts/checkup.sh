#!/usr/bin/env sh
# mcp-sync setup + health checkup (READ-ONLY).
# Prints a short report and a final HEALTH: line.
# Never writes to any config.

set -u

BIN="mcp-sync"
if ! command -v "$BIN" >/dev/null 2>&1; then
  echo "mcp-sync: NOT INSTALLED (not on PATH)"
  echo "  install: git clone https://github.com/enzo-vargas/mcp-sync && cd mcp-sync && npm install && npm link"
  echo "HEALTH: not-installed"
  exit 0
fi

echo "mcp-sync: $(command -v "$BIN")"

echo
echo "## Setup"
if "$BIN" config 2>/dev/null | grep -q "setupComplete = true"; then
  echo "  preferences: configured ($("$BIN" config path 2>/dev/null))"
  SETUP=1
else
  echo "  preferences: NOT configured"
  echo "  run 'mcp-sync setup' (first-run onboarding: accept defaults or walk through)"
  SETUP=0
fi

echo
echo "## Agents"
"$BIN" targets 2>/dev/null || echo "  (targets unavailable)"

echo
echo "## Project scope"
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
echo "  current root: $ROOT"
if "$BIN" projects ls 2>/dev/null | grep -qx "$ROOT"; then
  echo "  registered: yes"
  REGISTERED=1
else
  echo "  registered: no  (only global-scope MCPs sync here)"
  echo "  to enable project scope: mcp-sync projects add \"$ROOT\""
  REGISTERED=0
fi

echo
echo "## Drift"
if OUT="$("$BIN" check 2>&1)"; then
  echo "  in sync"
  DRIFT=0
else
  echo "  $OUT"
  echo "  run 'mcp-sync plan' for details"
  DRIFT=1
fi

echo
if [ "$SETUP" -eq 0 ]; then
  echo "HEALTH: needs-setup"
elif [ "$DRIFT" -eq 1 ]; then
  echo "HEALTH: drift"
elif [ "$REGISTERED" -eq 0 ]; then
  echo "HEALTH: not-registered"
else
  echo "HEALTH: ok"
fi
