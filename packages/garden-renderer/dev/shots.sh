#!/bin/sh
# Screenshot every exported scene HTML in $1. Pair with:
#   EXPORT_DIR=<dir> pnpm vitest run test/export-scenes.test.tsx --root packages/garden-renderer
set -e
DIR="${1:?usage: shots.sh <dir with exported html>}"
PW="$(cd "$(dirname "$0")/../../../apps/web/node_modules/.bin" && pwd)/playwright"
for f in "$DIR"/*.html; do
  "$PW" screenshot --viewport-size=1000,560 "file://$f" "${f%.html}.png"
done
