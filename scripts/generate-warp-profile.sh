#!/usr/bin/env bash
# Generates the Cloudflare WARP WireGuard profile used by
# docker-compose.warp.yml — runs entirely in a throwaway container and
# installs nothing on the host. Interactive (wgcf register asks you to
# accept Cloudflare's terms). Written for macOS: uses BSD `sed -i ''`.
#
# Usage: ./scripts/generate-warp-profile.sh

set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker not found — install it / open Docker Desktop before running this." >&2
  exit 1
fi

if [ -f warp/wgcf-profile.conf ]; then
  read -r -p "warp/wgcf-profile.conf already exists — regenerate it? (y/N) " confirm
  case "$confirm" in
    y|Y) ;;
    *) echo "Cancelled, keeping the existing profile."; exit 0 ;;
  esac
fi

mkdir -p warp

docker run --rm -it -v "$(pwd)/warp:/warp" -w /warp alpine sh -c '
  apk add --no-cache curl >/dev/null
  ARCH=$(uname -m)
  case "$ARCH" in
    aarch64) BIN=wgcf_2.2.32_linux_arm64 ;;
    x86_64)  BIN=wgcf_2.2.32_linux_amd64 ;;
    *) echo "unsupported architecture: $ARCH" >&2; exit 1 ;;
  esac
  curl -sSL -o wgcf "https://github.com/ViRb3/wgcf/releases/download/v2.2.32/$BIN"
  chmod +x wgcf
  ./wgcf register
  ./wgcf generate
  rm wgcf
'

# gluetun ("custom" WireGuard mode) requires Endpoint to be a literal IP,
# not a hostname — the wgcf profile ships "engage.cloudflareclient.com:PORT".
# See https://github.com/qdm12/gluetun/issues/788.
endpoint_line=$(grep '^Endpoint' warp/wgcf-profile.conf)
endpoint_host=$(echo "$endpoint_line" | sed -E 's/^Endpoint = ([^:]+):.*/\1/')
endpoint_port=$(echo "$endpoint_line" | sed -E 's/^Endpoint = [^:]+:(.*)/\1/')

if ! [[ "$endpoint_host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  endpoint_ip=$(dig +short "$endpoint_host" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1)
  if [ -z "$endpoint_ip" ]; then
    echo "Could not resolve $endpoint_host to an IP — replace Endpoint by hand in warp/wgcf-profile.conf." >&2
    exit 1
  fi
  sed -i '' "s/^Endpoint = .*/Endpoint = ${endpoint_ip}:${endpoint_port}/" warp/wgcf-profile.conf
  echo "Endpoint resolved: $endpoint_host -> $endpoint_ip"
fi

# gluetun also doesn't support the IPv6 address "Address" includes by default
# ("interface address is IPv6 but IPv6 is not supported") — keep only the
# IPv4 one, which is enough for this connectivity workaround.
sed -i '' -E "s/^Address = ([0-9.]+\/[0-9]+),.*/Address = \1/" warp/wgcf-profile.conf

echo "Done: generated warp/wgcf-account.toml and warp/wgcf-profile.conf."
