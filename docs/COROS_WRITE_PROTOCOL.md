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
5. **Cleanup of A/B/C**, so the schedule is verified back at baseline *before*
   anything plan-level is attempted.
6. **TEST D, plan/add probe — opt-in only, OFF by default.** One
   `POST /training/plan/add`, expected to be rejected with `1031` outside CN.
   The CLI names the risk before asking: on unexpected success it creates a
   plan object with **no known delete endpoint**, which you would remove by
   hand in the COROS UI. It is reported as an **orphan planId** in the console
   and the report, and forces `baselineRestored: false`.

### Choosing `idInPlan`: observe, do not trust the counter

The first live run found a COROS-authored template plan reporting
**`maxIdInPlan: 0`** on the wire while its entities carried ids up to **45** —
so `maxIdInPlan + 1` pointed at a real workout and the spike correctly refused
to write. The counter is not maintained on every plan.

The spike therefore derives its id as
**`max(counter, highest observed idInPlan) + 1`**, where "observed" comes from a
sweep of `today-180 … today+240` in disjoint ≤90-day windows (the endpoint
`5011`s past 90). The sweep is repeated fresh **before every insert**, so the
second and third workouts see the first one and step past it even when the
counter never moves. The occupancy check stays as the final gate: an entity in
the derived slot can now only mean a genuine race, and it aborts.

If the server rejects a correctly-derived id, that is recorded as an
**informative result** (code + derivation in the report) and the spike does
**not** retry with other ids — guessing at a shared counter is exactly how a
write clobbers someone's workout.

Also observed live: `idInPlan` identifies the **program-in-plan, not the
entity** — several entities may share one (ids 2, 8 and 38 each appeared twice).

### Recovery: by stamp, never by id

The second live run created all three workouts successfully (`0000`, all three
materialized) — and then **could not find them**, because the server **stored
them under a different `idInPlan` than the one claimed**. Nothing got registered
for cleanup, so three workouts were left on the account.

So the spike never uses an id as a recovery key. It stamps every program and
entity it creates with `RG SPIKE — SAFE TO DELETE …` and finds its own work by
**(stamp, date)**, then deletes using the ids the *server* reported. Claimed and
server-assigned ids are both recorded (`idInPlan`, `serverIdInPlan`).

Because `idInPlan` is shared legitimately, the stamp rules are asymmetric on
purpose: the **entity's** name proves ownership on its own, but the
**program's** name only counts when exactly one program carries that
`idInPlan` — otherwise a stamped program sitting beside a real workout's entity
could make a real workout look like ours.

A delete is addressed by `(planId, idInPlan, planProgramId)`. If an unstamped
workout shares that whole triple, the server cannot tell them apart either, so
the spike **does not send the delete** — it reports the leftover for manual
removal instead. Every delete is followed by a read that checks both that our
stamp is gone *and* that the unstamped count is unchanged.

### Cleaning up after a bad run

`pnpm coros:spike:cleanup` (`--cleanup-only`) logs in, scans
`today … today+60` for stamped workouts, deletes them under the same guards,
verifies each is gone, writes the report and exits. It creates nothing. The
full spike runs the same sweep as its **first** step, before taking the
baseline snapshot — so a previous run's leftovers are cleared and the baseline
is the clean state the account is returned to.

### Ownership: the rule that makes deletion safe

`idInPlan` is a plan-scoped counter, **not** an identity — it can collide with
a pre-existing workout (e.g. a stale entity numbered above the active plan's
`maxIdInPlan`). So the spike never treats "the entity at my `idInPlan`" as its
own:

- every program and entity it creates is **named** `RG SPIKE — SAFE TO DELETE …`;
- a workout is registered for deletion **only** when that name is present on
  the entity or its program;
- the name is **re-checked by a read immediately before every delete**, in case
  the slot was reassigned in between;
- a foreign workout in the target slot — found either before the write or on
  the read-after-write — means **no write, no delete, and the run aborts** with
  the reason in the report and on the console.

Every write is preceded by `program/calculate` (calculate-then-add) and followed
by a read-after-write that asserts **structural fields only**
(`exerciseType`/`targetType`/`sets`/`intensityType`) — `duration`, `distance`
and `trainingLoad` are server-recomputed and never allowed to fail the spike.
Server ids (`plan`/`entity`/`program`) are recovered from that read, not the
write response.

**Cleanup is the point**: every created entity is registered for removal the
moment a read proves it is ours — including after a *rejected* write that
materialized anyway — then **drained** (a loop that keeps sweeping until every
registered entity is verified gone, so an entity registered *while* cleanup is
running is still removed), each removal verified by a read, and finally the
whole window is compared against the baseline. The spike prints a
`RESTORATION PASS/FAIL` line and names anything it could not remove.

An unexpected error and Ctrl-C both take the same path: **abort** (stop issuing
new writes — checked before every write, so an interrupt can never start one),
let the in-flight step settle so whatever it created gets registered, drain,
then run the restoration read and print the leftovers **before** exiting. The
sanitized report (`docs/reports/coros-create-spike-<date>.json`) is written on
every path, with `baselineRestored`, `leftovers[]`, `orphanPlanIds[]` and
`abortReason` at the top level.

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
