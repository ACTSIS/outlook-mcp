#!/usr/bin/env bash
set -euo pipefail

# Container-only .deb smoke test (ADR 3). Runs inside ubuntu:24.04 with the
# .deb path mounted as $1. Exercises install, mcp/auth boot, upgrade,
# remove, purge, and asserts user-scoped data is never touched.

DEB_PATH="${1:-}"
if [ -z "$DEB_PATH" ]; then
  echo "Usage: $0 <path-to.deb>" >&2
  exit 2
fi

if [ ! -f "$DEB_PATH" ]; then
  echo "[smoke] missing .deb: $DEB_PATH" >&2
  exit 1
fi

apt-get update -qq
apt-get install -y -qq curl

TOKEN_FIXTURE="$HOME/.outlook-mcp-tokens.json"
printf '{"fixture":"preserve-me"}\n' > "$TOKEN_FIXTURE"

echo "[smoke] installing $DEB_PATH"
dpkg -i "$DEB_PATH" || apt-get -f install -y -qq

if [ ! -f /usr/bin/outlook-mcp ]; then
  echo "[smoke] /usr/bin/outlook-mcp not installed" >&2
  exit 1
fi

MODE="$(stat -c '%a' /usr/bin/outlook-mcp)"
if [ "$MODE" != "755" ]; then
  echo "[smoke] expected mode 0755, got $MODE" >&2
  exit 1
fi

wait_for_log() {
  local log="$1" pid="$2" pattern="$3"
  for _ in $(seq 1 30); do
    if grep -q "$pattern" "$log"; then return 0; fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "[smoke] process exited before pattern matched"; cat "$log"; return 1
    fi
    sleep 1
  done
  grep -q "$pattern" "$log"
}

MCP_LOG="$(mktemp)"
outlook-mcp mcp >"$MCP_LOG" 2>&1 &
MCP_PID=$!
wait_for_log "$MCP_LOG" "$MCP_PID" "connected and listening"
kill "$MCP_PID" 2>/dev/null || true
wait "$MCP_PID" 2>/dev/null || true

AUTH_LOG="$(mktemp)"
outlook-mcp auth >"$AUTH_LOG" 2>&1 &
AUTH_PID=$!
for _ in $(seq 1 30); do
  if curl -s -o /dev/null -w '%{http_code}' http://localhost:3333/ | grep -q 200; then break; fi
  if ! kill -0 "$AUTH_PID" 2>/dev/null; then
    echo "[smoke] auth mode exited early"; cat "$AUTH_LOG"; exit 1
  fi
  sleep 1
done
curl -sf http://localhost:3333/ >/dev/null
kill "$AUTH_PID" 2>/dev/null || true
wait "$AUTH_PID" 2>/dev/null || true

echo "[smoke] upgrade path"
dpkg -i "$DEB_PATH"

echo "[smoke] remove and purge"
dpkg -r outlook-mcp
if [ -f /usr/bin/outlook-mcp ]; then
  echo "[smoke] /usr/bin/outlook-mcp still present after remove" >&2
  exit 1
fi
dpkg -P outlook-mcp

if [ ! -f "$TOKEN_FIXTURE" ]; then
  echo "[smoke] user-scoped fixture was removed by package operations" >&2
  exit 1
fi
if [ "$(cat "$TOKEN_FIXTURE")" != '{"fixture":"preserve-me"}' ]; then
  echo "[smoke] user-scoped fixture was modified by package operations" >&2
  exit 1
fi

echo "[smoke] container smoke passed"
