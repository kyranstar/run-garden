# Run Garden

A private, single-user running companion that closes one loop:

**COROS training plan → realistic calendar → correctly scheduled watch workout → completed run → visible progress → a living garden.**

Your COROS plan is the source of truth for *what* you train. Run Garden makes it fit your real week: it mirrors workouts into Google Calendar with honest duration estimates and buffers, lets you move a workout with one decision (and writes the move back to COROS when that is safe and verified), matches completed runs from COROS and Strava back to the plan, computes deterministic training insights a watch never surfaces, and grows a small ecosystem — plants, trees, wildlife — from your actual consistency.

## The honest COROS write status

There is no official self-service COROS write API today. Run Garden's write paths, in priority order (see [docs/COROS_INTEGRATION_FINDINGS.md](docs/COROS_INTEGRATION_FINDINGS.md)):

1. **Official COROS MCP write tools** — announced "coming soon" upstream; the worker probes `tools/list` so official writes take over automatically when they ship. The official MCP is **read-only today**.
2. **Unofficial Training Hub web API** via the **desktop bridge** on your Mac — the implemented write path (direct schedule update preserving all identity fields, verified by a read-after-write; see [docs/COROS_WRITE_PROTOCOL.md](docs/COROS_WRITE_PROTOCOL.md)).
3. **Remove-and-add fallback** (insert-before-delete, flagged as degraded).
4. **Calendar-only** — the automatic fallback state when no write path is available.

A reversible **live write spike** (`pnpm coros:spike`, or the desktop app's "Run schedule write test") must pass against your real COROS account before you should trust schedule writes; until then treat writes as unproven. After a verified write the UI says *"COROS calendar updated · Open COROS to sync your watch"* — never "Updated on watch", because no server-side watch push exists.

Cost: runs on Cloudflare's free/near-free tiers with a **hard $10/week LLM ceiling** (AI is optional and off-switchable) — see [docs/COSTS.md](docs/COSTS.md). Privacy: single Google account allowlist, COROS password only in your Mac's Keychain (never in the cloud), encrypted provider tokens, Strava strictly read-only — see [docs/SECURITY.md](docs/SECURITY.md).

## Monorepo layout

| Path | Package | What it is |
|---|---|---|
| `apps/worker` | `@rg/worker` | Cloudflare Worker: Hono API, cron sync, D1, serves the built web app |
| `apps/web` | `@rg/web` | React PWA (Vite) — the phone/desktop browser UI |
| `apps/desktop` | `@rg/desktop` | Tauri 2 macOS app hosting the COROS bridge sidecar + keychain |
| `services/coros-bridge` | `@rg/coros-bridge` | TypeScript sidecar speaking the (unofficial) COROS Training Hub API, NDJSON over stdio |
| `packages/domain` | `@rg/domain` | Shared types, state machines, time math, preferences |
| `packages/database` | `@rg/database` | Drizzle schema + D1 migrations |
| `packages/providers` | `@rg/providers` | COROS/Strava normalizers, dedup merge, completion matching, fixtures |
| `packages/scheduling` | `@rg/scheduling` | Classification, duration estimation, calendar blocks, reschedule candidates |
| `packages/calendar` | `@rg/calendar` | Pure Google Calendar reconciliation (event bodies, manual-edit detection) |
| `packages/analytics` | `@rg/analytics` | Deterministic metrics with honest sample-size suppression |
| `packages/garden-engine` | `@rg/garden-engine` | Event-sourced, seeded-PRNG garden simulation |
| `packages/garden-renderer` | `@rg/garden-renderer` | SVG garden scene renderer |
| `packages/ui` | `@rg/ui` | Shared React components |
| `packages/api-client` | `@rg/api-client` | Typed client for the worker API |

Three deployables: the **worker** (API + web assets, one `wrangler deploy`), the **web PWA** (built into the worker's assets, installable on iPhone), and the **desktop app** (Tauri, personal build, no App Store).

## Local development (no real accounts needed)

```bash
pnpm install
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # FIXTURE_MODE=1 is preset
pnpm db:migrate:local                                    # create local D1 schema
pnpm dev                                                 # worker :8787 + web :5173
```

Open http://localhost:5173, then seed a deterministic world:

```bash
curl -X POST http://localhost:8787/api/dev/fixture-login -c cookies.txt
curl -X POST http://localhost:8787/api/dev/seed -b cookies.txt
```

Fixture mode is explicit, never silent: both endpoints 403 unless `FIXTURE_MODE=1`. The web dev server proxies `/api` to the worker on :8787.

Other root scripts: `pnpm typecheck`, `pnpm test`, `pnpm build:web`, `pnpm dev:desktop`, `pnpm coros:spike`, `pnpm db:generate`.

## Documentation

| Doc | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Package graph, data-authority rules, the three date concepts, bridge↔cloud flow |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Every table, grouped, with provenance fields |
| [docs/SYNC_AND_RECONCILIATION.md](docs/SYNC_AND_RECONCILIATION.md) | COROS reconciliation rules 1–11, sync states, calendar reconciliation, matching |
| [docs/DURATION_ESTIMATION.md](docs/DURATION_ESTIMATION.md) | Estimate priority chain + calendar block formula |
| [docs/GARDEN_ENGINE.md](docs/GARDEN_ENGINE.md) | Decay curve, species catalog, determinism, replay |
| [docs/ANALYTICS.md](docs/ANALYTICS.md) | Each metric's rule and suppression threshold |
| [docs/SECURITY.md](docs/SECURITY.md) | Credential handling, signing, encryption, deletion |
| [docs/DESKTOP_APP.md](docs/DESKTOP_APP.md) | Tauri app, sidecar, pairing, build commands |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | End-to-end deploy: Cloudflare, Google, Strava, PWA install |
| [docs/TESTING.md](docs/TESTING.md) | What's covered, how to run, what needs live credentials |
| [docs/COSTS.md](docs/COSTS.md) | Monthly cost model and scenarios |
| [docs/COROS_WRITE_PROTOCOL.md](docs/COROS_WRITE_PROTOCOL.md) | The exact safe-write protocol and state machine |
| [docs/COROS_INTEGRATION_FINDINGS.md](docs/COROS_INTEGRATION_FINDINGS.md) | Verified research the integration is built on |
