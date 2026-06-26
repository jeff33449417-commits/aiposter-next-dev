#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$PWD/.npm-cache}"

npx --yes wrangler deploy
