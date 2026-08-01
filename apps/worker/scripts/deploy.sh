#!/usr/bin/env bash
# Run Garden production deploy — mechanical steps.
# Prereqs (see docs/DEPLOYMENT.md): `wrangler login` done, and a
# apps/worker/.prod.secrets file with all secret KEY=VALUE lines (SESSION_SECRET
# and TOKEN_ENCRYPTION_KEY are pre-generated; add GOOGLE_CLIENT_ID,
# GOOGLE_CLIENT_SECRET, ALLOWED_GOOGLE_EMAIL, and any optional ones).
#
# Usage:  bash scripts/deploy.sh
set -euo pipefail

# Wrangler needs Node >= 22; prefer an nvm-installed 22 if the default is older.
if ! node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' 2>/dev/null; then
  for d in "$HOME"/.nvm/versions/node/v22*/bin; do [ -d "$d" ] && export PATH="$d:$PATH" && break; done
fi
echo "Node: $(node --version)"

cd "$(dirname "$0")/.."
ROOT="$(cd ../.. && pwd)"
SECRETS="./.prod.secrets"

command -v jq >/dev/null || { echo "Please install jq (brew install jq)"; exit 1; }
[ -f "$SECRETS" ] || { echo "Missing $SECRETS — see the header of this script."; exit 1; }

echo "==> Verifying Cloudflare auth"
npx wrangler whoami >/dev/null || { echo "Run 'npx wrangler login' first."; exit 1; }

# 1. Create the D1 database if wrangler.toml still has the placeholder id.
if grep -q "REPLACE_WITH_D1_DATABASE_ID" wrangler.toml; then
  echo "==> Creating D1 database run-garden-db"
  DB_ID="$(npx wrangler d1 create run-garden-db 2>&1 | grep -oE '"?database_id"?[ =:]+"?[0-9a-f-]{36}' | grep -oE '[0-9a-f-]{36}' | head -1)"
  [ -n "$DB_ID" ] || { echo "Could not parse the new database_id — create it manually and paste into wrangler.toml."; exit 1; }
  sed -i.bak "s/REPLACE_WITH_D1_DATABASE_ID/$DB_ID/" wrangler.toml && rm -f wrangler.toml.bak
  echo "    database_id set to $DB_ID"
fi

# 2. Apply migrations to the remote D1.
echo "==> Applying D1 migrations (remote)"
npx wrangler d1 migrations apply run-garden-db --remote

# 3. Push every secret from .prod.secrets.
echo "==> Setting secrets"
while IFS= read -r line; do
  case "$line" in ''|\#*) continue;; esac
  key="${line%%=*}"; val="${line#*=}"
  [ -n "$key" ] && [ -n "$val" ] || continue
  printf '%s' "$val" | npx wrangler secret put "$key" >/dev/null
  echo "    set $key"
done < "$SECRETS"

# 4. Build the web app (served by the worker's ASSETS binding).
echo "==> Building web PWA"
( cd "$ROOT" && pnpm --filter @rg/web build )

# 5. Deploy.
echo "==> Deploying worker"
npx wrangler deploy

echo
echo "Done. Your worker URL is printed above (…workers.dev)."
echo "Set that URL as APP_URL in wrangler.toml [vars] and add"
echo "  <URL>/api/auth/google/callback   as an authorized redirect URI in Google Cloud,"
echo "then re-run 'npx wrangler deploy' so APP_URL takes effect."
