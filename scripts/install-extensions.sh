#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
AGENT_DIR=${PI_AGENT_DIR:-"${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"}
EXTENSION_DIR="$AGENT_DIR/extensions"

mkdir -p "$EXTENSION_DIR"
for extension in clear effort markdown-backlinks; do
  mkdir -p "$EXTENSION_DIR/$extension"
  cp "$ROOT_DIR/extensions/$extension/index.ts" "$EXTENSION_DIR/$extension/index.ts"
  cp "$ROOT_DIR/extensions/$extension/helpers.ts" "$EXTENSION_DIR/$extension/helpers.ts"
done

printf 'Installed pi extensions from %s\n' "$ROOT_DIR/extensions"
printf 'Destination: %s\n' "$EXTENSION_DIR"
printf 'Run /reload in an active pi session to load changes.\n'
