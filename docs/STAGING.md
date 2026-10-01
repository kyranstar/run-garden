# Staging

A second Worker (`run-garden-staging`) with its own D1 database. It is inert
by construction: no cron triggers, and every outbound `fetch` except Google's
sign-in token exchange throws `StagingOutboundBlocked`
(`apps/worker/src/services/staging.ts`). It can hold a copy of real data and
still never reach COROS, Calendar, the COROS MCP or the LLM gateway.

Shell setup for every wrangler command below (that shell only; tests run on
the default Node 21):

```sh
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"   # wrangler needs Node 22
export WRANGLER_WRITE_LOGS=false                            # see below
```

Why `WRANGLER_WRITE_LOGS=false`: by default wrangler appends everything it
prints to a debug log in `~/Library/Preferences/.wrangler/logs/`, including
`d1 execute` query results (only API request bodies are sanitised). A command
run against production or staging data would leave that data on disk. The
`@rg/worker` package scripts that reach Cloudflare set it themselves; set it
in the shell for every `npx wrangler` command here.

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

Sign-in needs only a POST to `https://oauth2.googleapis.com/token`, the one
request the guard allows — that exact URL and method, not the whole origin:
staging shares production's OAuth client, so a `/revoke` from staging would
disconnect production's Calendar. Calendar sync, COROS and the LLM are
blocked in staging, so Calendar scopes granted on staging do nothing.

## Copy and rehearse

A rehearsal copies production into staging, runs the change there, and
compares parity hashes before and after. **Each rehearsal needs the owner's
OK** — the copy reads production. The copy happens inside Cloudflare: a
temporary copier Worker (`rg-staging-copier`, `apps/worker/wrangler.copier.toml`,
code in `apps/worker/src/copier/`) is bound to production's D1 as `SRC` (only
read) and staging's as `DST`. Nothing is exported, downloaded or written to
disk. If any step fails, stop and ask; never fall back to a local export.

What the copier does:

- Copies every table except `sessions` and `oauth_states`, whole, in
  primary-key order, in pages (`maxRows`, default 200, at most 500 per call).
  Provider token columns are written as null.
- Keeps its progress in staging, so a dropped call or a crash just resumes.
- Answers with progress, counts and hashes only — never a row.
- Writes only into a database it has proved is staging: it creates a
  `staging_sentinel` table in `DST` on the first run, and only if `DST` is
  completely empty; it refuses if `SRC` has that table (`src_is_staging`), if
  an unprepared `DST` holds any row (`dst_not_empty`), if the two bindings
  are one database (`same_database`), or if `SRC` holds no rows at all
  (`src_empty`: production is never empty). Every call also repeats
  `?dst=run-garden-db-staging`.

### 1. Before

1. Owner OK for this rehearsal; note the date.
2. Check out the commit production runs. The copier and staging must have
   production's schema: the copier selects the columns its code knows.
3. Staging is empty (first copy, or wiped — see Wipe) and migrated to that
   schema: `pnpm --filter @rg/worker migrate:staging`. Do not sign in to an
   empty staging before the first copy (that writes rows; the copier then
   refuses with `dst_not_empty`).
4. Copy between production's cron ticks (`:00`, `:15`, `:30`), e.g. starting
   a few minutes after `:15` or `:30`: a row production writes mid-copy shows
   up as a `/verify` mismatch.

### 2. Copy

All in one shell, from `apps/worker`, with Node 22 on PATH:

```sh
pnpm copier:deploy
COPIER_KEY="$(openssl rand -base64 32)"     # this shell only; never echoed or saved
printf %s "$COPIER_KEY" | npx wrangler secret put COPIER_KEY -c wrangler.copier.toml
URL=https://rg-staging-copier.kyranadams.workers.dev
Q="dst=run-garden-db-staging"
copier() { curl -s -X POST -H "x-copier-key: $COPIER_KEY" "$URL/$1?$Q${2:+&$2}"; echo; }

# Step until finished; stop on any error.
while :; do
  out="$(copier step)"; echo "$out"
  case "$out" in *'"finished":true'*) break ;; '' | *'"error"'*) break ;; esac
done

copier verify          # {"ok":true,...} — every table's src/dst hash and row count
copier scrub           # {"ok":true,"remaining":{"secrets":0,"sessions":0,"oauthStates":0}}
pnpm copier:delete
unset COPIER_KEY URL Q
```

- `/verify` not ok: production wrote to those tables during the copy. Copy
  again in a quiet window with `copier step restart=1` (empties staging's
  copied tables, then starts over) and the loop above; `copier verify
  tables=a,b` checks just those tables.
- `/scrub` leaves staging with no usable provider connection (tokens null;
  staging also has its own `TOKEN_ENCRYPTION_KEY`) and no sessions.
- Delete the copier the same session, even after a failure. Check:
  `curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL/step"` no longer
  answers 401.

### 3. Rehearse

1. `pnpm build:web && pnpm --filter @rg/worker deploy:staging` (same commit),
   sign in to staging.
2. Record "before" parity from the browser console on staging (same origin,
   signed in):

   ```js
   const j = (p, b) => fetch(p, b && { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
   const dto = (...ps) => j("/api/admin/parity/dto?" + ps.map((p) => "paths=" + encodeURIComponent(p)).join("&"));
   await j("/api/admin/parity/garden", { resim: false });
   await j("/api/admin/parity/garden", { resim: true });
   await dto("/api/plan/today", "/api/plan/week?week=<monday>", "/api/garden", "/api/coach/state", "/api/insights?discipline=run");
   await j("/api/admin/parity/tables");
   await j("/api/admin/parity/calendar");
   await j("/api/admin/parity/jobs?since=2026-01-01");
   ```

   Answers are hashes, counts and dates only — safe to keep in rehearsal
   notes. `resim: false` hashes the garden as found; `resim: true` replays it
   from genesis through the ordinary path (on a long garden it can run out of
   D1 queries in one request — then pass `{ resim: true, from: "<date>" }`,
   which replays from the checkpoint before that day).

   The order is load-bearing. The replay and the DTO reads write, as the app
   does when it opens (the replay rewrites the derived garden tables; GET
   `/api/garden` advances the garden and fills missing collection rows; GET
   `/api/coach/state` sweeps proposals). Both run before the table hashes, so
   "before" and "after" each hash a garden replayed by the code under test.
   Write stamps those writes leave (`PARITY_VOLATILE_COLUMNS` in
   `services/parity.ts`, `VOLATILE_DTO_KEYS` in `routes/admin.ts`) are not
   hashed, so two recordings with no code change between them are identical
   (tested). Record "before" and "after" on the same local day, and do not
   use the app in between: a new day advances the garden, and that is a real
   difference.
3. Check out the change, `pnpm --filter @rg/worker migrate:staging`, build and
   deploy staging, record "after" the same way, and compare. Differences
   should be exactly the ones the change intends.

The parity endpoints answer 404 everywhere except staging, or a deployment
with the var `PARITY_ENABLED = "1"` (production, for a rehearsal only — then
remove it). Production can hash but never resimulate (`resim: true` → 409).

### 4. After

- Owner OK, then wipe staging (below) the same day.
- Staging holds a copy of real data until then: the production-data rules
  apply to it in full.
- Sweep `~/Library/Preferences/.wrangler/logs` (see the production-data
  rules): no log written during the rehearsal stays.

## Wipe

Delete the rows, keep the schema (and `d1_migrations`), then re-apply
migrations if the schema changed. List the tables first — the query returns
table names only — and paste its output into the second command:

```sh
npx wrangler d1 execute run-garden-db-staging --remote --env staging --command "SELECT 'DELETE FROM ' || name || ';' FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'"
npx wrangler d1 execute run-garden-db-staging --remote --env staging --command "<the DELETE statements printed above>"
pnpm migrate:staging
```

`staging_sentinel` is emptied but kept: staging stays recognisable as staging
for the next copy.

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
- Drive prod reads from the browser. A `wrangler d1 execute` is saved to disk
  twice over unless you prevent it: wrangler writes its output to
  `~/Library/Preferences/.wrangler/logs/` unless `WRANGLER_WRITE_LOGS=false`
  is set, and a command an agent runs is kept in the agent's session
  transcript. If you must use one, set the variable and read only counts.
- Verify cleanup yourself: no files, no scratch tables, no leftover rows.
  After any production or staging work, sweep wrangler's log folder: list it
  with `ls -lt ~/Library/Preferences/.wrangler/logs` and delete any log
  written since the work began (it holds whatever wrangler printed).
- Keep personal data out of code, fixtures, tests and docs.
