#!/usr/bin/env bash
set -euo pipefail

# Acquire the pinned nfpm release, verify its SHA-256, and place it on PATH.
# Mirrors the org toolchain-lock pattern: the lockfile is the single source of
# truth for version, download URL, and hash.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK_FILE="${SCRIPT_DIR}/toolchain.lock.yaml"
TOOLS_DIR="${TOOLS_DIR:-${SCRIPT_DIR}/.tools}"

if [ ! -f "$LOCK_FILE" ]; then
  echo "[fetch-tools] missing toolchain lock: $LOCK_FILE" >&2
  exit 1
fi

# Minimal YAML field extraction (lockfile shape is controlled by this repo).
lock_value() {
  local key="$1"
  awk -F': ' -v "k=$key" '{gsub(/^[ \t]+|[ \t]+$/,"",$1); gsub(/^[" ]+|[" ]+$/,"",$2)} $1 == k {print $2}' "$LOCK_FILE"
}

NFPM_VERSION="$(lock_value version)"
NFPM_URL="$(lock_value url)"
NFPM_SHA256="$(lock_value sha256)"

if [ -z "$NFPM_VERSION" ] || [ -z "$NFPM_URL" ] || [ -z "$NFPM_SHA256" ]; then
  echo "[fetch-tools] toolchain.lock.yaml must contain nfpm.version, url, and sha256" >&2
  exit 1
fi

mkdir -p "$TOOLS_DIR"
TARBALL="$TOOLS_DIR/nfpm-${NFPM_VERSION}-linux-x86_64.tar.gz"

if [ -f "$TARBALL" ]; then
  echo "[fetch-tools] reusing cached tarball" >&2
else
  echo "[fetch-tools] downloading nfpm ${NFPM_VERSION}" >&2
  EFFECTIVE_URL=$(curl -fsSL --location --write-out '%{url_effective}' --output "$TARBALL" "$NFPM_URL")
  EFFECTIVE_HOST="${EFFECTIVE_URL#*://}"
  EFFECTIVE_HOST="${EFFECTIVE_HOST%%/*}"
  case "$EFFECTIVE_HOST" in
    github.com|*.github.com|objects.githubusercontent.com) ;;
    *)
      echo "[fetch-tools] refusing redirect to untrusted host: $EFFECTIVE_HOST" >&2
      rm -f "$TARBALL"
      exit 1
      ;;
  esac
fi

echo "[fetch-tools] verifying nfpm sha256" >&2
printf '%s  %s\n' "$NFPM_SHA256" "$TARBALL" | sha256sum -c - >/dev/null

tar -xzf "$TARBALL" -C "$TOOLS_DIR" nfpm
chmod +x "$TOOLS_DIR/nfpm"

export PATH="$TOOLS_DIR:$PATH"
if [ -n "${GITHUB_PATH:-}" ]; then
  echo "$TOOLS_DIR" >> "$GITHUB_PATH"
fi

echo "[fetch-tools] nfpm ${NFPM_VERSION} ready at $TOOLS_DIR/nfpm" >&2
