# Staging

A second Worker (`run-garden-staging`) with its own D1 database. It is inert
by construction: no cron triggers, and every outbound `fetch` except Google's
sign-in token exchange throws `StagingOutboundBlocked`
(`apps/worker/src/services/staging.ts`). It can hold a copy of real data and
still never reach COROS, Calendar, the COROS MCP or the LLM gateway.

Node: wrangler commands use Node 22 (`export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"`
in that shell only). Tests run on the default Node 21.

## Why it is inert (evidence)

- `[env.staging.triggers] crons = []`. Wrangler's `triggers` is inheritable,
  but the merge is `rawEnv.triggers ?? topLevel.triggers`, and `{ crons: [] }`
  is not nullish, so the empty list overrides production's three crons.
  Independently, `scheduled()` returns immediately when `STAGING = "1"`.
- `vars` and `d1_databases` are NOT inherited. A
  `wrangler deploy --env staging --dry-run` lists exactly these bindings:
  `DB (run-garden-db-staging)`, `ASSETS`, `APP_URL` (staging URL),
  `FIXTURE_MODE "0"`, `AI_DEFAULT_ENABLED "0"`, `STAGING "1"`. Production's D1
  does not appear. Wrangler also warns that `AI_GATEWAY_MODEL` is not carried
  over, which is intended.
- Secrets are per Worker; staging has none until they are set below.

## Create (once)

Done on 2026-09-30: `run-garden-db-staging` exists (region WNAM, empty) and its id is
in `[[env.staging.d1_databases]]`. To recreate it after a teardown, run the commands
below and paste the printed id there.

```sh
cd apps/worker
npx wrangler d1 create run-garden-db-staging          # copy database_id into [[env.staging.d1_databases]]
pnpm migrate:staging                                  # migrations apply, remote, --env staging
```

Secrets (all `--env staging`, values through stdin, never echoed or written
to disk):

```sh
openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET --env staging
openssl rand -base64 32 | npx wrangler secret put TOKEN_ENCRYPTION_KEY --env staging
npx wrangler secret put ALLOWED_GOOGLE_EMAIL --env staging   # same as production
npx wrangler secret put GOOGLE_CLIENT_ID --env staging       # same as production
npx wrangler secret put GOOGLE_CLIENT_SECRET --env staging   # same as production
```

`SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY` are FRESH values, never
production's. A copy of production tokens is unreadable on staging by design;
the copier (below) does not copy provider tokens.

## Deploy

```sh
pnpm build:web && pnpm --filter @rg/worker deploy:staging
curl -s https://run-garden-staging.kyranadams.workers.dev/api/health
# {"ok":true,"fixtureMode":false,"staging":true}
```

`npx wrangler deployments list --env staging` should show no triggers. The app
shows a one-line "Staging" strip at the top of every screen.

## Google sign-in (owner, one time)

Add this to the OAuth client's authorized redirect URIs in Google Cloud
Console before signing in to staging:

```
https://run-garden-staging.kyranadams.workers.dev/api/auth/google/callback
```

Sign-in needs only `https://oauth2.googleapis.com/token`, the one origin the
guard allows. Calendar sync, COROS and the LLM are blocked in staging, so
Calendar scopes granted on staging do nothing.

## Copy and rehearse

Placeholder: Task 13 fills this section (the copier, the rehearsal flow and
its checks).

## Wipe

Delete the rows, keep the schema, then re-apply migrations if the schema
changed:

```sh
npx wrangler d1 execute run-garden-db-staging --remote --env staging --command "<DELETE statements per table>"
pnpm migrate:staging
```

To start from nothing, `npx wrangler d1 delete run-garden-db-staging`, then
create again (above).

## Time Travel and rollback (production)

Take a bookmark before any production migration or data change:

```sh
npx wrangler d1 time-travel info run-garden-db          # prints the current bookmark; record it
npx wrangler d1 time-travel restore run-garden-db --bookmark=<id>
```

Rollback runbook:

1. Restore the bookmark: `wrangler d1 time-travel restore run-garden-db --bookmark=<id>`.
2. Redeploy the previous commit: `git revert` the change (or check out the
   previous commit) and `pnpm --filter @rg/worker deploy`.
3. Check `/api/health`, then the Garden and Plan screens.

Restoring replaces the database in place; writes made after the bookmark are
lost, so restore only when that trade is intended.

## Production-data rules

- Read-only unless the owner approves a write.
- Take only the columns and rows the task needs. Never `SELECT *`.
- Never write query results to disk (no redirects, no temp files, no dumps).
- Drive prod reads from the browser or a single `wrangler d1 execute` whose
  output is consumed in the terminal, not saved.
- Verify cleanup yourself: no files, no scratch tables, no leftover rows.
- Keep personal data out of code, fixtures, tests and docs.
