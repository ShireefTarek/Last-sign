#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$node_major" != "24" ]]; then
  echo "Node.js 24 is required; found $(node --version)." >&2
  exit 1
fi
npm_config_cache="${TMPDIR:-/tmp}/akher-tawqee-npm-cache"
export npm_config_cache
npm ci
