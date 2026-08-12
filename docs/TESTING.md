# Testing

Vitest across the monorepo (root `vitest.config.ts` uses projects:
`packages/*`, `apps/*`, `services/*`). CI runs typecheck + tests + web build
on every push/PR (`.github/workflows/ci.yml`).

## How to run

```bash
pnpm test                      # everything, one run
pnpm test:watch                # watch mode
pnpm vitest run --project @rg/garden-engine     # one project
pnpm --filter @rg/worker exec vitest run        # equivalently, from a package
pnpm -r typecheck              # type-level checks for every package
```

## What's covered

| Area | Tests | What they pin down |
|---|---|---|
| Unit, per package | `packages/*/test/*.test.ts` | domain time math; classification; the duration-estimate chain (`estimate.test.ts`); reminders + reschedule candidates; calendar reconciliation decisions incl. manual moves/deletes/notes (`calendar.test.ts`); COROS normalizers; legacy-row adoption scoring + completion matching bands (`merge-matching.test.ts`); every analytics module's rule and suppression threshold (12 test files) |
| Garden simulation | `packages/garden-engine/test/simulate.test.ts` | determinism (same inputs → identical garden), idempotency per day, the decay/death curve boundaries, comeback, unlock gates, replay convergence |
| Worker integration | `apps/worker/test/vertical-loop.test.ts` | the whole vertical loop against a real SQLite database (better-sqlite3 standing in for D1): fixture import → move → COROS write job claim/result → verification → activity arrival → adoption of any legacy row → completion → garden growth; plus reconciliation rules and grace periods via `reconcile-daily` |
| COROS client contract | `packages/coros/test/*.test.ts` | `client.test.ts` against a **mock COROS server** (login/MD5, result-code semantics incl. `1019` single re-login and `1030` bad credentials, workerd-strict fetch receivers); `write-executor.test.ts` for every branch of the safe-write protocol (direct update, verification failure, ambiguous network, remove-and-add incl. rollback and duplicate-left); snapshot/backfill builders |

The fixture provider (`packages/providers/src/fixture-provider.ts` +
`fixtures/`) makes all of this deterministic — no network anywhere in the
suite.

## What requires live credentials (not runnable in CI)

- **The COROS census** — `pnpm coros:census` logs which sportType codes the
  account actually holds (needs real credentials via env or TTY; never in CI).
- Real Google OAuth flows (covered indirectly by unit tests of the
  pure logic; live round-trips are manual).

## End-to-end (Playwright)

`@rg/web` has Playwright wired (`pnpm e2e` → `playwright test`,
`@playwright/test` dev dependency), intended to drive the web app against a
fixture-mode worker. **No e2e specs are committed yet** — the harness exists,
the suite is empty; add specs under `apps/web` before relying on `pnpm e2e`.

## Conventions

- Worker tests use an in-memory/better-sqlite3 database with the real Drizzle
  schema — the same SQL dialect as D1.
- Anything stochastic goes through the seeded PRNG, so garden and matching
  tests assert exact outcomes, not distributions.
- Tests never talk to real providers; new provider behavior gets a fixture or
  a mock-server route first.
