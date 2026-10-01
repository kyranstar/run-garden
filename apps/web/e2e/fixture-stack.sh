#!/usr/bin/env bash
# Boots the fixture stack the smoke suite runs against:
#   worker (FIXTURE_MODE, private D1 state) on :8971, web dev server on :5271.
#
#   bash apps/web/e2e/fixture-stack.sh          # start, wait until healthy
#   bash apps/web/e2e/fixture-stack.sh stop     # stop both and remove the state
#
# wrangler needs Node >= 22; the caller puts it on PATH. The migrations and
# `wrangler dev` share one --persist-to directory, otherwise they resolve to
# different sqlite files. apps/worker/.dev.vars must exist (dummy values are
# fine in fixture mode); this script never creates or copies secrets.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${RG_API_PORT:-8971}"
WEB_PORT="${RG_WEB_PORT:-5271}"
# One state dir per checkout: two worktrees' stacks never stop or delete
# each other's (Audit 2 E2E M5).
STATE="${RG_E2E_STATE:-${TMPDIR:-/tmp}/rg-e2e-state-$(printf %s "$ROOT" | cksum | cut -d' ' -f1)}"
PIDS="$STATE/pids"

stop() {
  if [ -f "$PIDS" ]; then
    while read -r pid; do kill "$pid" 2>/dev/null || true; done <"$PIDS"
  fi
  # wrangler/vite spawn children; clear whatever still LISTENS on our ports —
  # never a client connected to them, such as a browser tab on the dev server.
  for p in "$API_PORT" "$WEB_PORT"; do
    lsof -ti "tcp:$p" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
  done
  rm -rf "$STATE"
}

if [ "${1:-}" = "stop" ]; then stop; exit 0; fi

[ -f "$ROOT/apps/worker/.dev.vars" ] || { echo "apps/worker/.dev.vars is missing" >&2; exit 1; }
stop
mkdir -p "$STATE" "$ROOT/apps/web/dist"
: >"$PIDS"

cd "$ROOT/apps/worker"
npx wrangler d1 migrations apply run-garden-db --local --persist-to "$STATE" >"$STATE/migrate.log" 2>&1 \
  || { cat "$STATE/migrate.log"; exit 1; }

# No LLM, whatever .dev.vars holds (Ruling C2): fixture mode's coach wake
# answers with a canned reply, and any other gateway call goes to a dead
# local port instead of the real gateway.
npx wrangler dev --port "$API_PORT" --persist-to "$STATE" \
  --var FIXTURE_MODE:1 --var AI_DEFAULT_ENABLED:0 --var AI_GATEWAY_BASE_URL:http://127.0.0.1:9 \
  --var "APP_URL:http://localhost:$WEB_PORT" >"$STATE/worker.log" 2>&1 &
echo $! >>"$PIDS"

cd "$ROOT"
RG_API_PORT="$API_PORT" RG_WEB_PORT="$WEB_PORT" pnpm --filter @rg/web dev >"$STATE/web.log" 2>&1 &
echo $! >>"$PIDS"

wait_for() {
  for _ in $(seq 1 90); do
    curl -fsS "$1" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "timed out waiting for $1" >&2
  tail -n 40 "$STATE"/*.log >&2
  exit 1
}
wait_for "http://localhost:$API_PORT/api/health"
wait_for "http://localhost:$WEB_PORT/api/health"

# Seed once, here: a seed takes several seconds, and two Playwright workers
# seeding at once is what used to knock `wrangler dev` over. curl sends no
# Origin header, which the /api/dev/* origin guard allows.
JAR="$STATE/cookies"
curl -fsS -c "$JAR" -X POST "http://localhost:$API_PORT/api/dev/fixture-login" >/dev/null
curl -fsS -b "$JAR" -m 120 -X POST "http://localhost:$API_PORT/api/dev/seed" >/dev/null
echo "fixture stack up: worker :$API_PORT, web :$WEB_PORT (state $STATE)"
