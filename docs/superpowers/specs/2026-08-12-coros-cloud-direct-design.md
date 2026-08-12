# COROS cloud-direct: the worker owns the integration, the desktop app retires

**Date:** 2026-08-12
**Status:** Draft for review (direction user-approved; datacenter viability spike PASSED)
**Supersedes, eventually:** the desktop bridge architecture (`services/coros-bridge`, `apps/desktop`, the devices/claim job protocol)

## Why

The only component that can talk to COROS today is the bridge on the user's Mac.
Mac asleep → nothing syncs, backfills queue forever, and the UI says none of it
(live incident 2026-08-12: activity done in the evening, backfill pressed at
8:24pm against a Mac asleep since 6:41pm, two jobs still queued the next
morning). The bridge exists for exactly two reasons — keep the COROS password
off the cloud, and originate requests from a residential IP. The user has
waived the first for their single-user deployment, and the spike disproved the
second's necessity:

> **Spike (2026-08-12): dummy-credential `POST /account/login` from a deployed
> Cloudflare Worker returns COROS's normal `1030` bad-credentials envelope on
> both `teamapi` (US) and `teameuapi` (EU) hosts — HTTP 200, no bot wall, no
> captcha, ~3.3s.** Datacenter egress is treated like any browser.

## Goal

Do an activity → open the app → it's there, or a visible "checking COROS…"
state and then it's there — with the Mac off. All COROS reads AND writes happen
from the worker; the desktop app becomes unnecessary and is retired.

## Non-goals

- Multi-user credential onboarding flows (single-user posture stays).
- COROS sleep data (mobile-API only; calling it kills the phone-app session —
  same exclusion the bridge honors).
- Keeping any bridge fallback long-term. Transition is short; the end state is
  one integration path.

## Architecture

### 1. Credentials & session (`provider_connections`, provider `"coros"`)

Reuses the existing row shape and AES-GCM helpers (`encryptSecret`/
`decryptSecret`, `TOKEN_ENCRYPTION_KEY`) exactly as `google_calendar` does:

- `encryptedRefreshToken` ← the **MD5 of the password** (the durable COROS
  web-API credential; COROS's login takes `pwd: md5(password)`).
- `encryptedAccessToken` ← the current session token; `accessTokenExpiresAt`
  set to +20h (observed TTL ~24h; renew early).
- `externalAccountId` ← COROS userId; `meta` ← `{ email, region: "us" | "eu" | "cn" }`.
- `status`/`lastErrorCategory` drive the settings card and sync-status line
  (`bad_credentials` → "COROS rejected the password — update it here").

**The plaintext password never exists server-side:** the Settings page hashes
it in the browser (small pure-JS MD5 util in `@rg/ui`; Workers' WebCrypto has
no MD5, so hashing client-side is also the practical choice) and submits
`{ email, pwdMd5, region }` to `POST /api/coros/connect`, which verifies with a
live login before storing. Disconnect wipes the row. The pwdMd5 is still a
credential and is treated like one: encrypted at rest, never logged, never in
DTOs.

### 2. The worker-side client (`apps/worker/src/services/coros-cloud.ts`)

A Workers-native port of the bridge's vendored client (same endpoints, same
envelope semantics, same security invariants — nothing secret ever logged).
The bridge client is already `fetchImpl`-based; the port drops `node:crypto`
(md5 arrives pre-hashed) and keeps:

- `login(email, pwdMd5)` → token; auto re-login ONCE on envelope `1019`
  (expired token), mirroring the bridge's retry rule.
- Reads: `getRawSchedule` (≤90-day windows), `getActivities` (paged),
  `getActivityDetail` (+laps), `getDayDetails`, `getExerciseCatalog`.
- Writes: `createScheduledWorkout`, `updateScheduledWorkout`,
  `removeScheduledWorkout`, `calculateProgram`, `addPlan` — the executor
  semantics port from `create-executor.ts` (stamp verify, read-after-write,
  delete triple addressing) unchanged; they are already pure API logic.
- Per-request 60s timeout; envelope `result` branching (HTTP is always 200).

### 3. Read scheduling — the UX contract

- **On app open (the point of this project):** Plan/Activity screens fire
  `POST /api/coros/read-now`. Server-side single-flight via the existing
  claim-token pattern (`coach_locks` table, kind `"coros_read"`) + a 90-second
  freshness window: concurrent tabs and rapid reopens share one COROS pull.
  The pull: activities list (last 14 days) → detail+laps for unseen ids →
  `ingestActivities` → `resimulateFrom` → coach-read enqueue (existing) →
  schedule delta (7-day window) → daily health. Returns `{ status, ingested }`;
  the client shows "Checking COROS…" until it resolves, then invalidates
  queries. Target: **activity visible ≤10s after opening the app.**
- **Cron:** the halfHourly job runs the same pull per connected user (replaces
  bridge snapshots); hourly keeps reconcile/garden as today.
- **Backfill:** the existing 90-day chunk walker runs in the worker directly —
  chunk per cron tick (bounded), no device claim, progress visible immediately.
  The Backfill button acts on it in seconds, awake Mac or no Mac.
- **Full-window schedule sync** (90 days, plan import): daily + on plan-page
  read-now when >6h stale, same `importPlanSnapshot` path as bridge payloads.

### 4. Writes

`corosWriteJobs` stays as the queue (idempotency, attempt budgets, supersede
semantics all keep working) but the CONSUMER moves into the worker: jobs are
executed inline via `waitUntil` on enqueue and swept hourly — the
devices/claim/handshake protocol is bypassed entirely when a cloud connection
exists. Write results flow through the existing `applyJobResult` machinery, so
studio pushes, coach approvals, moves, sync-intents, and drift detection are
untouched above the transport.

### 5. Sync status & honesty

`sync-status.ts` gains a cloud mode: presence = "COROS connection healthy /
erroring since X" instead of Mac liveness; the sync line reads
"Synced with COROS · 2 min ago" / "COROS unreachable since 9:14 — retrying" /
"COROS rejected the password — fix in Settings". The Backfill button reports
chunk progress live (it's now worker-local).

### 6. Bridge retirement (phased)

- **Phase A (reads + credentials + UX):** ship cloud reads behind the presence
  of a `coros` connection. When connected, bridge snapshot payloads are still
  ACCEPTED (idempotent ingest makes them harmless) but no longer needed.
- **Phase B (writes):** worker executes write jobs; job emission to devices
  stops for connected users. After A+B, the desktop app is functionally dead —
  the user can quit and uninstall it. Its sidecar-leak saga ends by deletion.
- **Phase C (decommission):** remove `services/coros-bridge`, `apps/desktop`,
  device routes/handshakes, `desktop_devices`/`device_handshakes` tables, the
  release workflow for the desktop app, and the settings surface for pairing.
  Dev fixtures/census scripts that used the bridge client move to a small
  local CLI using the same vendored client. Phase C lands only after A+B have
  run clean for a stretch — separate plan, no rush.

### 7. Transition caveats (told to the user, not hidden)

- Web-API sessions: the worker's login may invalidate the bridge's token and
  vice versa (each re-logins on `1019`, so both keep working, noisily). Run
  both only briefly; quit the desktop app once read-now works.
- The COROS phone app uses a different session class (accountType) — bridge
  experience says web logins don't disturb it; cloud logins are the same class
  as the bridge's.
- Rate courtesy: cron + read-now with the 90s freshness window keeps request
  volume at or below the bridge's current cadence (45s poll + 30min snapshot).

## Error handling

- Login `1030` → connection `status: "error"`, `lastErrorCategory:
  "bad_credentials"`, sync line + settings card say so; no retries until the
  password is updated (never hammer a failing login).
- Other envelope errors / network: bounded retry with backoff in cron; read-now
  returns `{ status: "coros_unreachable" }` and the UI says it plainly.
- All secrets: never in logs, never in error payloads, never in DTOs.

## Testing

- Client port: scripted-envelope unit tests (login, 1019 re-login-once, range
  guard, paging) mirroring the bridge's own suites.
- read-now: single-flight race test (two concurrent calls → one COROS pull),
  freshness-window test, ingest+resim invocation assertions with a fake client.
- Writes: executor tests against a fake COROS (create/verify/delete stamps) —
  port the bridge executor suites.
- Settings: connect flow with a fake login (success, 1030), disconnect wipe.
- Live: user connects real credentials in Settings, then the acceptance test
  IS the original complaint — record an activity, open the app, watch it
  appear behind the loading state without the Mac.

## Success criteria

1. Activity recorded → app opened (Mac off/asleep) → visible within ~10s.
2. Backfill progresses with the Mac off, with visible chunk progress.
3. Studio push / coach approve writes to the watch with the Mac off.
4. Desktop app uninstalled; nothing in the product references it (Phase C).
