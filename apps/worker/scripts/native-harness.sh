#!/usr/bin/env bash
# THE NATIVE SIDE'S LOCAL HARNESS (native device sign-in, SLICE-CONTRACT revision 2 §7, §11): the Worker on wrangler's
# LOCAL runtime and LOCAL D1 (migrations applied), a synthetic owner account, a cookie session for it without Google
# (fixture mode's /api/dev/fixture-login), and pairing codes minted with that cookie — for the LifeOS app's end-to-end
# test in the lab, and for this repo's own check of the flow on real local D1.
#
#   bash apps/worker/scripts/native-harness.sh up        # start, migrate, sign the owner in; prints where
#   bash apps/worker/scripts/native-harness.sh code      # mint a pairing code (the laptop's Pair), print it
#   bash apps/worker/scripts/native-harness.sh pending   # the pending phones, with their check numbers
#   bash apps/worker/scripts/native-harness.sh confirm   # confirm the newest pending phone (the laptop's Confirm)
#   bash apps/worker/scripts/native-harness.sh check     # the whole flow, scripted (native-harness-check.mjs)
#   bash apps/worker/scripts/native-harness.sh sql "select …"   # a read of the LOCAL D1
#   bash apps/worker/scripts/native-harness.sh down      # stop it and delete its state
#
# LOCAL ONLY: `wrangler d1 … --local` and `wrangler dev --local` on wrangler.dev.toml (a local database id, no real
# binding), persisted in the state dir; nothing is deployed, no remote database is touched. Run it under the
# loopback-only network block when one is at hand:
#   sandbox-exec -f <net-block.sb> bash apps/worker/scripts/native-harness.sh up
#
# SECRETS ARE SYNTHETIC: the env file is written here, into the state dir (mode 600), with random SESSION_SECRET and
# TOKEN_ENCRYPTION_KEY and an example.test owner. This script never reads apps/worker/.dev.vars — and refuses to run when
# one exists, because wrangler would load it.
#
# wrangler needs Node >= 22; the caller puts it on PATH. NATIVE_HARNESS_PORT (default 8975) and NATIVE_HARNESS_STATE
# (default under $TMPDIR, one per checkout) move it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WORKER="$ROOT/apps/worker"
PORT="${NATIVE_HARNESS_PORT:-8975}"
STATE="${NATIVE_HARNESS_STATE:-${TMPDIR:-/tmp}/rg-native-harness-$(printf %s "$ROOT" | cksum | cut -d' ' -f1)}"
BASE="http://127.0.0.1:$PORT"
JAR="$STATE/owner.cookies"
ENV_FILE="$STATE/synthetic.env"
OWNER="native-owner@example.test"
export WRANGLER_SEND_METRICS=false

stop() {
  if [ -f "$STATE/pid" ]; then kill "$(cat "$STATE/pid")" 2>/dev/null || true; fi
  lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
}

json_field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=process.argv[1].split(".").reduce((o,k)=>o==null?o:o[k],JSON.parse(s));process.stdout.write(typeof v==="string"?v:JSON.stringify(v))})' "$1"; }

case "${1:-}" in
  up)
    [ -f "$WORKER/.dev.vars" ] && { echo "apps/worker/.dev.vars exists: wrangler would load it instead of the synthetic env. Not starting." >&2; exit 1; }
    stop
    rm -rf "$STATE"
    mkdir -p "$STATE"
    umask 077
    node -e '
      const { randomBytes } = require("node:crypto");
      const lines = [
        `SESSION_SECRET=${randomBytes(32).toString("base64url")}`,
        `TOKEN_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`,
        `ALLOWED_GOOGLE_EMAIL=${process.argv[1]}`,
        "GOOGLE_CLIENT_ID=synthetic-client-id",
        "GOOGLE_CLIENT_SECRET=synthetic-client-secret",
        "NATIVE_DEVICES=1",
        "FIXTURE_MODE=1",
        "AI_DEFAULT_ENABLED=0",
        "AI_GATEWAY_BASE_URL=http://127.0.0.1:9",
        `APP_URL=http://127.0.0.1:${process.argv[2]}`,
      ];
      require("node:fs").writeFileSync(process.argv[3], lines.join("\n") + "\n", { mode: 0o600 });
    ' "$OWNER" "$PORT" "$ENV_FILE"
    cd "$WORKER"
    npx wrangler d1 migrations apply run-garden-db --local -c wrangler.dev.toml --persist-to "$STATE" >"$STATE/migrate.log" 2>&1 \
      || { cat "$STATE/migrate.log"; exit 1; }
    npx wrangler dev --local -c wrangler.dev.toml --port "$PORT" --ip 127.0.0.1 --persist-to "$STATE" --env-file "$ENV_FILE" \
      --var "APP_URL:http://127.0.0.1:$PORT" --var FIXTURE_MODE:1 --var AI_DEFAULT_ENABLED:0 >"$STATE/worker.log" 2>&1 &
    echo $! >"$STATE/pid"
    for _ in $(seq 1 90); do
      curl -fsS "$BASE/api/health" >/dev/null 2>&1 && break
      sleep 1
    done
    curl -fsS "$BASE/api/health" >/dev/null || { tail -n 40 "$STATE/worker.log" >&2; exit 1; }
    # The synthetic owner, signed in by cookie without Google (fixture mode only). curl sends no Origin.
    curl -fsS -c "$JAR" -X POST "$BASE/api/dev/fixture-login" >"$STATE/login.json"
    echo "native harness up: $BASE (local D1 in $STATE; owner $OWNER, userId $(json_field userId <"$STATE/login.json"); cookie jar $JAR)"
    ;;
  code)
    answer="$(curl -fsS -b "$JAR" -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/api/native/pairings")"
    echo "pairing code $(json_field code <<<"$answer") (expires $(json_field expiresAt <<<"$answer"))"
    ;;
  pending)
    curl -fsS -b "$JAR" "$BASE/api/native/devices" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const d of JSON.parse(s).devices)console.log(`${d.state}\t${d.label}\tcheck ${d.check??"-"}\t${d.id}`)})'
    ;;
  confirm)
    list="$(curl -fsS -b "$JAR" "$BASE/api/native/devices")"
    pick="$(node -e 'const p=JSON.parse(process.argv[1]).devices.filter(d=>d.state==="pending").at(-1);if(!p)process.exit(3);process.stdout.write(`${p.id} ${p.check} ${p.label}`)' "$list")" || { echo "no pending phone" >&2; exit 1; }
    read -r id check label <<<"$pick"
    echo "confirming \"$label\", check number $check — the phone must show the same number"
    curl -fsS -b "$JAR" -X POST -H 'Content-Type: application/json' -d "{\"check\":\"$check\"}" "$BASE/api/native/devices/$id/confirm"
    echo
    ;;
  check)
    node "$WORKER/scripts/native-harness-check.mjs" "$BASE" "$JAR" "$STATE"
    ;;
  sql)
    cd "$WORKER"
    npx wrangler d1 execute run-garden-db --local -c wrangler.dev.toml --persist-to "$STATE" --json --command "$2"
    ;;
  down)
    stop
    rm -rf "$STATE"
    echo "native harness down"
    ;;
  *)
    sed -n '2,25p' "$0"
    exit 2
    ;;
esac
