#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker CLI is required to deploy Cloudflare Containers." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is not available. Start Docker Desktop or a compatible daemon." >&2
  exit 1
fi

export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$PWD/.npm-cache}"

npx --yes wrangler deploy --config wrangler.renderer.jsonc
