# COROS write protocol

The exact protocol for mutating the COROS schedule safely over an unofficial,
non-idempotent API. Sources: [COROS_INTEGRATION_FINDINGS.md](COROS_INTEGRATION_FINDINGS.md)
(decisions D4–D6, verified endpoint semantics) and the implementation in
`services/coros-bridge/src/write-executor.ts` +
`apps/worker/src/services/jobs.ts`. The only mutation kind today is
`move_scheduled_workout` (a date move — structure is never rewritten).

## Ground rules

- **All writes serialize** through one queue: the worker hands out at most one
  claimed job per user, and the bridge processes requests strictly
  sequentially. Reason: `maxIdInPlan` is a monotonic shared counter and
  read-then-write is racy.
- **Never hand-build payloads**: updates resend the *raw entity and program
  objects exactly as read*, with only `happenDay` (+ recomputed `dayNo`)
  changed; re-inserts clone the raw program byte-for-byte. This preserves
  `planId`, `programId` (`planProgramId`), `idInPlan`, structure, targets, and
  version fields.
- **Verification is a read, never trust**: the update response does not echo
  server state, so every write ends with a fresh `schedule/query` and a match
  on `idInPlan`. `lastVerifiedCorosDate` only moves on read-verified evidence.
- **One workout per call** (multi-entity payloads are rejected upstream).

## Preferred path: direct update (`status: 2`)

`executeMoveJob` steps:

1. **Fresh read** of a window covering both dates (±3 days).
2. Workout absent upstream → `upstream_changed` (`workout_not_found`); no write.
3. Already at the destination → `already_in_desired_state` (idempotent exit; no write).
4. Found at neither the expected original date nor the destination → it moved
   upstream → `upstream_changed`; no write. Refuse to overwrite a user's
   COROS-side change.
5. **Content guard**: the program's fingerprint must equal the job's
   `expectedContentFingerprint` (what the user approved) → else
   `upstream_changed` (`content_changed`); no write.
6. **Write**: `POST /training/schedule/update` with the full raw
   entity+program, `happenDay` → destination, `versionObjects[].status: 2`.
7. **Read-after-write verify**: destination date **and** unchanged program
   fingerprint → `verified` (`pathUsed: direct_update`, with observed
   date/fingerprint/version). A date-only match with changed content is
   `verification_failed`.

Network failure mid-write (state unknown): re-read once — destination seen →
`verified`; original seen → `write_failed` (clean, retryable); can't tell →
`ambiguous`.

## Fallback: remove-and-add (insert-before-delete)

Used only when the server cleanly rejects the direct update. Ordering is
deliberate: a mid-operation failure leaves a **visible, recoverable duplicate**
rather than a lost workout (decision D5).

1. **Re-read**: fresh `maxIdInPlan` and raw objects; re-verify the original's
   date and existence (failure here is a clean `write_failed`).
2. **Insert** a clone at the destination with `idInPlan = maxIdInPlan + 1`
   (`status: 1`), `happenDay`/`dayNo` recomputed, program cloned raw.
3. **Verify the clone** by reading. Clone at the wrong date → try to remove it:
   removed → `rolled_back`; removal fails → `verification_failed`
   (`duplicate_left`). No clone visible after an exception → `ambiguous`;
   after a clean rejection → `write_failed`.
4. **Delete the original** (`status: 3`). Any failure → `verification_failed`
   (`duplicate_left`) — surfaced, never silently ignored.
5. **Final verify**: original gone and clone present at the destination →
   `verified` with `pathUsed: remove_and_add` and the job marked
   **`degraded: true`** (the workout's COROS identity changed:
   new `idInPlan`; Run Garden re-links via the read-back ids).

## Idempotency & retries

- **Operation id**: the job id is the idempotency key; results for jobs already
  terminal (`verified`/`failed`/`superseded`/`cancelled`) are ignored.
- **Expected version/fingerprint**: jobs carry `expectedSourceVersion` and
  `expectedContentFingerprint`; the executor re-reads immediately before any
  write and refuses on mismatch (`upstream_changed`).
- **Re-read before write, always** — including before each retry: step 3's
  idempotent exit makes a retry of an ambiguous-but-actually-successful write
  a no-op instead of a duplicate.
- **Ambiguous → read-before-retry**: `ambiguous`/`write_failed` outcomes
  requeue (max **5 attempts**, claims time out after 10 min); the next attempt
  starts from a fresh read. After max attempts the job fails and the workout
  degrades to `calendar_only`.
- Newer moves for the same workout **supersede** pending jobs.

## Job state machine (worker side)

```
queued → claimed → (executor runs) →
  verified            (outcome verified | already_in_desired_state)
  needs_attention     (outcome upstream_changed | verification_failed)
  queued again        (outcome ambiguous | write_failed, attempts < 5)
  failed              (outcome rolled_back | unsupported | attempts exhausted)
superseded / cancelled from the outside at any pre-terminal point
```

Effect on the workout (`applyJobResult`):

| Outcome | Job → | `corosSyncState` → | `lastVerifiedCorosDate` |
|---|---|---|---|
| `verified` / `already_in_desired_state` | verified | `synced` | observed date (+ observed version/fingerprint adopted) |
| `upstream_changed` / `verification_failed` | needs_attention | `needs_attention` | observed date if reported |
| `ambiguous` / `write_failed` (attempts left) | queued | `syncing` | unchanged |
| same, attempts exhausted | failed | `calendar_only` | unchanged |
| `rolled_back` / `unsupported` | failed | `calendar_only` | unchanged |

Rule 4 of [SYNC_AND_RECONCILIATION.md](SYNC_AND_RECONCILIATION.md) provides a
second verification channel: if a routine schedule read observes the
destination date while a job is pending, the job is marked verified from the
read alone.

## The initial reversible write test

Before trusting writes on a real account (product spec §"Initial live write
test"): `pnpm coros:spike` or desktop Settings → COROS → "Run schedule write
test" (`services/coros-bridge/src/spike.ts`). It:

1. snapshots the raw entity/program of one user-chosen, low-risk workout;
2. moves it **one day later** via the direct-update path and verifies;
3. moves it **back** and verifies again (attempting rollback on failure);
4. writes a sanitized report to `docs/reports/coros-write-spike-<date>.json`
   (user ids stripped/redacted; no tokens or emails).

Status: implemented but **not yet executed against a live account** (no real
credentials in the build environment).

## The reversible CREATE spike

`pnpm coros:spike:create` (`services/coros-bridge/src/spike-create.ts`) answers
a different question: can the bridge create **brand-new, hand-authored**
workouts, not just move or clone existing ones
([research §(c)](research/plan-write-capability.md))? It is **additive only** —
it never reads-modifies-writes anything the user authored:

1. **Baseline** — fresh ±30-day read: `planId`, `maxIdInPlan`, workout count and
   the full `idInPlan` set are snapshotted.
2. **TEST A, strength** (`today + 21`) — a hand-built `sportType: 4` program:
   one repeat-group container (`sets: 3`) wrapping one 10-rep bodyweight step
   (`intensityValue: ""`, `intensityDisplayUnit: "6"` — both strings).
3. **TEST B, run** (`today + 22`) — the minimal confirmed topology: two blocks,
   warmup + training, no group, no cooldown.
4. **TEST C, bike probe** (`today + 23`) — uncaptured in the survey; the result
   is recorded either way.
5. **TEST D, plan/add probe** — one `POST /training/plan/add`, expected to be
   rejected with `1031` outside CN. On unexpected success it deletes what it
   created; a plan object with no known delete endpoint is reported as an
   **orphan planId**, in the console and the report, for manual removal.

Every write is preceded by `program/calculate` (calculate-then-add) and followed
by a read-after-write that asserts **structural fields only**
(`exerciseType`/`targetType`/`sets`/`intensityType`) — `duration`, `distance`
and `trainingLoad` are server-recomputed and never allowed to fail the spike.
Server ids (`plan`/`entity`/`program`) are recovered from that read, not the
write response.

**Cleanup is the point**: every created entity is registered for removal the
moment a read proves it exists — including after a *rejected* write that
materialized anyway — then removed in reverse order, each removal verified by a
read, and finally the whole window is compared against the baseline. The spike
prints a `RESTORATION PASS/FAIL` line and names anything it could not remove.
An unexpected error and Ctrl-C (SIGINT) both run the same cleanup and write the
same sanitized report (`docs/reports/coros-create-spike-<date>.json`,
`baselineRestored` at the top level).

Status: implemented, offline-tested against the mock server
(`services/coros-bridge/test/spike-create.test.ts`), **not yet executed against
a live account**.

Note: the findings doc specifies
shipping with writes defaulting to calendar-only until the spike passes;
the current preferences schema defaults `corosWritesEnabled` to `true`
(`packages/domain/src/preferences.ts`) — a known code/spec discrepancy. Until
your spike passes, turn COROS writes off in Settings yourself.

## Watch-sync truthfulness

There is **no server-side push to the watch** and no way to verify watch
delivery (`verifyWatchSync` is permanently `false`; the domain even models it:
`WatchSyncState = "calendar_verified_watch_unverified" | "unknown"`). Schedule
changes reach the watch when the COROS **phone app** next syncs. Therefore,
after a verified write, the product says exactly:

> **"COROS calendar updated · Open COROS to sync your watch"**

— and never "Updated on watch".
