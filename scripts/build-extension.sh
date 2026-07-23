#!/usr/bin/env bash
# Builds the Claude Desktop extension (.mcpb bundle) for this MCP server.
#
# Usage: npm run build:extension
#
# Produces anaplan-mcp.mcpb in the repo root, ready to double-click install
# in Claude Desktop (Settings -> Extensions -> Install from file).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT

echo "==> Compiling TypeScript"
npm run build

echo "==> Staging bundle contents in $STAGE_DIR"
mkdir -p "$STAGE_DIR/dist"
cp -R dist/. "$STAGE_DIR/dist/"
cp manifest.json "$STAGE_DIR/manifest.json"
cp package.json "$STAGE_DIR/package.json"
cp package-lock.json "$STAGE_DIR/package-lock.json"
if [ -f LICENSE ]; then cp LICENSE "$STAGE_DIR/LICENSE"; fi

echo "==> Installing production dependencies into the bundle"
# Playwright stays an optional dependency: it's a large download (browser
# binaries) that most users won't enable, and the server boots fine without
# it (see src/ui/anaplanUI.ts). Users who want the UI-automation fallback
# run 'npm install playwright && npx playwright install chromium' inside
# the installed extension folder afterwards -- see README.
(cd "$STAGE_DIR" && npm install --omit=dev --omit=optional --no-audit --no-fund --ignore-scripts)

echo "==> Packing .mcpb bundle"
OUT_FILE="$(pwd)/anaplan-mcp.mcpb"
rm -f "$OUT_FILE"
npx -y @anthropic-ai/mcpb pack "$STAGE_DIR" "$OUT_FILE"

echo "==> Done: $OUT_FILE"
