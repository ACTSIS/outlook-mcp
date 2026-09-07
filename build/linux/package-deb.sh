#!/usr/bin/env bash
set -euo pipefail

# Build the amd64 .deb from the Linux SEA binary produced by build/package.js.
# Requires GITHUB_REF_NAME=v<semver> and GITHUB_SHA. Uses dpkg-shlibdeps to
# derive runtime Depends and renders nfpm.yaml.tmpl before invoking nfpm.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [[ ! "${GITHUB_REF_NAME:-}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "[package-deb] GITHUB_REF_NAME must be v<semver>; got: ${GITHUB_REF_NAME:-<empty>}" >&2
  exit 1
fi

if [ -z "${GITHUB_SHA:-}" ]; then
  echo "[package-deb] GITHUB_SHA is required" >&2
  exit 1
fi

if ! command -v dpkg-shlibdeps >/dev/null 2>&1; then
  echo "[package-deb] dpkg-shlibdeps not found; install dpkg-dev" >&2
  exit 1
fi

if ! command -v nfpm >/dev/null 2>&1; then
  echo "[package-deb] nfpm not on PATH; run build/linux/fetch-tools.sh first" >&2
  exit 1
fi

VERSION="${GITHUB_REF_NAME#v}"
MAINTAINER="${MAINTAINER:-ACTSIS}"
BINARY_SRC="${BINARY_SRC:-$REPO_ROOT/dist/linux-x64/outlook-mcp-linux-x64}"

if [ ! -f "$BINARY_SRC" ]; then
  echo "[package-deb] missing SEA binary: $BINARY_SRC" >&2
  exit 1
fi

STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT

STAGE_BIN="$STAGE_DIR/outlook-mcp"
cp "$BINARY_SRC" "$STAGE_BIN"
chmod 0755 "$STAGE_BIN"

echo "[package-deb] deriving Depends with dpkg-shlibdeps" >&2
DEPENDS=$(dpkg-shlibdeps -O "$STAGE_BIN" 2>/dev/null | sed -n 's/^shlibs:Depends=//p' || true)
if [ -z "$DEPENDS" ]; then
  echo "[package-deb] dpkg-shlibdeps produced no Depends; failing closed" >&2
  exit 1
fi

sed \
  -e "s|@VERSION@|$VERSION|g" \
  -e "s|@MAINTAINER@|$MAINTAINER|g" \
  -e "s|@BINARY@|$STAGE_BIN|g" \
  -e "s|@DEPENDS@|$DEPENDS|g" \
  -e "s|@SCRIPTS@|$SCRIPT_DIR/scripts|g" \
  "$SCRIPT_DIR/nfpm.yaml.tmpl" > "$STAGE_DIR/nfpm.yaml"

OUT_DIR="$REPO_ROOT/dist/linux-x64"
mkdir -p "$OUT_DIR"

echo "[package-deb] building .deb with nfpm" >&2
nfpm package -f "$STAGE_DIR/nfpm.yaml" -p deb -t "$OUT_DIR/"

DEB_PATH="$OUT_DIR/outlook-mcp_${VERSION}_amd64.deb"
if [ ! -f "$DEB_PATH" ]; then
  echo "[package-deb] nfpm did not produce expected .deb" >&2
  exit 1
fi

echo "[package-deb] $DEB_PATH"
