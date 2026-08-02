# Can Run Garden CREATE new COROS workouts/plans (not just move existing ones)?

Research date: **2026-08-02**. Question gating the "plan studio" feature: can the
unofficial Training Hub API the bridge already speaks create *new* workouts from
scratch (strength, yoga, custom run structures) and push them into a user's COROS
schedule/plan, not merely move/re-insert workouts that already exist there?

Scope: read-only code archaeology across this repo's docs, the bridge
implementation, and the community-client survey already in this repo
(`docs/research/coros-community-clients.md`). No network calls made.

---

## (a) Verdict

**Plausible-but-unverified for individual scheduled workouts (strength and
structured run), on the same unofficial endpoint the bridge already calls.
Not implemented in this codebase today. Plan-level (multi-week program)
creation is more speculative. Yoga has no known write path at all.**

Breaking that down by layer:

1. **Endpoint exists and is reachable**: `POST /training/schedule/update` with
   `versionObjects[].status: 1` is a **create**, not just an update/insert-of-existing.
   This is the *same* endpoint and status value the bridge's own remove-and-add
   fallback already calls in production code today
   (`services/coros-bridge/src/coros-client.ts:241-265` `addScheduleEntity`,
   used from `services/coros-bridge/src/write-executor.ts:228`). The bridge already
   proves this call succeeds end-to-end (clone insert + read-after-write verify) —
   just always with a byte-for-byte clone of an *existing* raw program, never a
   hand-built one. `[verified — bridge code + live-tested community pattern]`

2. **Community-client evidence that hand-built (not cloned) creates work**:
   `docs/research/coros-community-clients.md:502-606` (§4.1/§4.4) — this repo's
   own prior research states plainly: *"For gym/strength (sportType 4), hand-built
   flat lists are accepted; the 'Plan data is illegal' constraint does not apply"*
   (community-clients.md:605-606, sourced to `open-coros-training/docs/API.md:74-78`,
   itself marked `[verified-live]` against a real account). For **runs**, a hand-built
   topology was *initially rejected* but a **2-block run (warmup + training, no
   group, no cooldown) is confirmed accepted** without cloning a template
   (community-clients.md:601-604, `docs/API.md:56-58`). So: strength creation from
   scratch is the strongest-evidence case; minimal-topology run creation is also
   evidenced; nothing in the survey exercises a genuinely from-scratch bike or swim
   structured workout.

3. **What's NOT verified**: none of this has been exercised by *this codebase*
   against a live account — `docs/COROS_INTEGRATION_FINDINGS.md:172-175` and
   `docs/COROS_WRITE_PROTOCOL.md:125-130` both state the write spike
   (`pnpm coros:spike`) "has not yet been executed against a live account (no real
   credentials in the build environment)" and that spike only exercises **moves**
   of an **existing** workout, never a create-from-scratch. So even the verified
   move/remove-and-add path is unproven live; a from-scratch create is unproven at
   every level (no code path, no live test) in this repo.

4. **Plan-level (multi-week program) creation** (`POST /training/plan/add`) is
   materially weaker evidence: body shape is known from exactly one source
   (CN-region capture, `shenmiguo/scripts/coros.js:279-286`,
   community-clients.md:668-683) and the *other* community repo that tried it
   against a live EU account got rejected — `1031 Parameter input error`
   (community-clients.md:662, :1237). Treat plan-level create as **speculative**,
   not plausible-but-unverified.

5. **Yoga**: there is no program-namespace `sportType` value for yoga anywhere in
   the surveyed source (`sportType` workout namespace is `1=Run 2=Bike 3=Swim
   4=Strength`, community-clients.md:701-707, mirrored in
   `packages/providers/src/coros/raw-types.ts:58`). "Yoga" only exists as an
   *activity* namespace code for completed activities (403 or 904 depending on
   source, community-clients.md:1027-1028) — i.e. COROS can log a completed yoga
   session, but no community client demonstrates (or even attempts) scheduling a
   yoga *plan* workout. This is a **hard unknown**, not just unverified — see §(e).

---

## (b) The exact endpoint + payload a create would use

### Endpoint

```
POST {regionalHost}/training/schedule/update
Headers: accessToken: <token>, yfheader: {"userId":"<userId>"}, Content-Type: application/json
```

Regional hosts and auth exactly as already implemented in
`services/coros-bridge/src/coros-client.ts:27-31,140-164`. No new endpoint, no new
auth — this is 100% the machinery already in the bridge.

### Payload shape (status:1 = create)

Minimal form, confirmed live by `open-coros-training`
(community-clients.md:513-529, `cygnusb/coros_api.py:1594-1603`):

```jsonc
{
  "entities": [
    { "happenDay": "20260312", "idInPlan": 7, "sortNoInSchedule": 1 }
  ],
  "programs": [ { /* full program object, see §(d) */ "idInPlan": 7 } ],
  "versionObjects": [ { "id": 7, "status": 1 } ],
  "pbVersion": 2
}
```

Full web-app-fidelity form (highest-confidence capture, a scrubbed real request/
response pair): `community-clients.md:531-569`, sourced from
`laurenceomfoisy/open-coros-training/payloads/schedule_update_create_minimal.json:12-119`.
Confirmed live semantics for create (`community-clients.md:583-606`):

- **One workout per call** — multi-entity payloads rejected ("Plan data is illegal").
- `planId: ""` **auto-targets the active plan** — "server auto-creates a plan on
  first call and assigns planId / entity id / program id"
  (community-clients.md:573, the recorded `_notes` in the capture file).
- `idInPlan` must be `maxIdInPlan + 1`, re-read fresh immediately before the push
  (monotonic counter; racy under concurrency — community-clients.md:589-590). The
  bridge already handles this: `write-executor.ts:218` (`newIdInPlan = Number(fresh.maxIdInPlan ?? 0) + 1`).
- The create response **does not echo server-assigned ids**
  (community-clients.md:651-656) — a fresh `schedule/query` read-after-write and
  match-on-`idInPlan` is required to recover them, exactly the pattern
  `write-executor.ts` already implements for the remove-and-add fallback.
- Server recomputes `distance`/`trainingLoad` from targets; submitted estimates
  are advisory (community-clients.md:597-598). HR bpm targets get remapped onto
  the account's zones and will not round-trip exactly (community-clients.md:595-596).
- Pace targets round-trip exactly in ms/km (community-clients.md:593-594).

### What the bridge is missing today to expose this as a product feature

The bridge's `addScheduleEntity` (`coros-client.ts:241-265`) already sends exactly
this payload shape — but every caller of it today (`write-executor.ts:228`) passes
a **clone of an existing raw program** (`original.program`), never a freshly
constructed one. To support real creation the app would need to:

1. A **program builder** that assembles a `RawCorosProgram` (per
   `packages/providers/src/coros/raw-types.ts:52-70`) from scratch, satisfying the
   required-field lists in §(d) below — this does not exist anywhere in the repo
   (`raw-types.ts` only *types* the shape for pass-through, it has no constructor).
2. A **new job kind** — the domain layer's job schema hardcodes a single literal:
   `kind: z.literal("move_scheduled_workout")`
   (`packages/domain/src/jobs.ts:20`). There is no `create_scheduled_workout` (or
   similar) job kind, no corresponding executor function alongside
   `executeMoveJob`, and no route in `apps/worker/src/routes/plan.ts` that would
   enqueue one. This is a schema+executor+route addition, not a config flip.
3. A **capability flag rename/clarification**: `addScheduledWorkout: true` already
   exists in `TrainingProviderCapabilities`
   (`packages/domain/src/capabilities.ts:10,24`) and is set `true` by the bridge
   (`coros-client.ts:67`), but today it means only "can insert a clone as part of
   remove-and-add," gated behind `move_scheduled_workout` jobs
   (`apps/worker/src/services/jobs.ts:58`). Nothing currently interprets this flag
   as "can create arbitrary new content."

---

## (c) What a live spike would need to verify

Mirroring the existing reversible move-spike pattern
(`services/coros-bridge/src/spike.ts`, described in
`docs/COROS_WRITE_PROTOCOL.md:113-130`), a create-capability spike should be
**additive and self-cleaning** — never touch a real user-authored workout:

1. **Fresh read** of the active plan window to get `maxIdInPlan` and `planId`
   (same call the move-spike already makes, `spike.ts:102`).
2. **Build one minimal hand-authored program from scratch** (no cloning) — the
   strongest test of "can we create", since remove-and-add already proves
   clone-based create works. Two variants worth running, matching the two
   confirmed-accepted minimal topologies in the survey:
   - Strength: a single flat exercise list, no groups (per §4.4 point 10,
     community-clients.md:605-606).
   - Run: exactly a 2-block warmup+training topology, no group, no cooldown
     (per §4.4 point 9, community-clients.md:601-604).
3. **Insert** via `status: 1` with `idInPlan = maxIdInPlan + 1` at a date far
   enough out to be unambiguously the spike's own workout (the existing move-spike
   convention is `>= today + 3 days`, `spike.ts:109`).
4. **Read-after-write verify**: `schedule/query` match on `idInPlan`, confirm the
   program round-trips the intended structure (expect HR/distance/trainingLoad to
   be server-recomputed — do not fail the spike on those, only on structural
   fields: `exerciseType`, `targetType`, `sets`, `intensityType`).
5. **Recover server-assigned ids** the same way the remove-and-add path already
   does (`write-executor.ts` §"Post-write identifier discovery" pattern /
   community-clients.md:650-656) — `plan_id` = `data.id`, `entity_id` = matched
   entity's `id`, `program_id` = matched program's `id`.
6. **Clean up**: delete the spike workout via the already-implemented
   `removeScheduleEntity` (`coros-client.ts:268-279`, `status: 3`) and verify its
   absence — this is the "reversible" half of the pattern; a create-spike leaves
   nothing behind on success (contrast with the move-spike, which restores state
   by moving back).
7. **Negative-case probes worth running once, cheaply**, since they resolve open
   questions the survey flags as unresolved for this account/region:
   - Try `planId: ""` (auto-target) vs. an explicit `planId` — confirm
     auto-create-on-first-call behavior applies to this account
     (community-clients.md:573).
   - Try a **bike or swim** hand-built minimal program — the survey explicitly
     flags these as **uncaptured** for the schedule path
     (community-clients.md:1239-1240, "Bike/swim structured-workout templates for
     the schedule path are uncaptured").
   - Try `POST /training/plan/add` (multi-day plan create) once, expecting it may
     return `1031` outside CN region as the one EU attempt on record did
     (community-clients.md:662) — this determines whether plan-level creation is
     worth pursuing at all vs. only per-workout creation via repeated
     `schedule/update` calls into an existing (or auto-created) plan.
8. Write a sanitized report to `docs/reports/coros-write-spike-<date>.json` (same
   redaction rules as the existing spike: no tokens, no email, userId truncated) —
   extend the existing `SpikeReport` shape (`spike.ts:23-43`) with a `create`
   section rather than inventing a new report format.

None of this can run in the current build environment for the same reason the
existing move-spike hasn't run: **no real COROS credentials available**
(`docs/COROS_INTEGRATION_FINDINGS.md:172-175`).

---

## (d) Strength program structure (sets/reps/weight encoding), as known

All from `docs/research/coros-community-clients.md` §5 (`community-clients.md:694-822`),
cross-referenced against this repo's own type definitions in
`packages/providers/src/coros/raw-types.ts:31-70`.

**Program-level** (`sportType: 4` = Strength):
- `subType: 65535` marks it structured (community-clients.md:744-745).
- `exercises[]` is the flat/nested step list (§ below).
- `exerciseNum` / `totalSets` count **real steps only** — a repeat-group
  container must not be counted (community-clients.md:807-808).
- Program-level required metadata for a *running* program is documented in
  detail (community-clients.md:810-821: `referExercise{gradeSystem,hrType,
  intensityType,valueType:1}`, etc.) — the survey does **not** give an equivalent
  exhaustive required-field list for strength programs specifically; §4.4 point 10
  just says hand-built flat lists for `sportType:4` are accepted without the "Plan
  data is illegal" template constraint. Treat the exact strength-required-field
  set as **inferred by analogy**, not separately confirmed.

**Per-exercise fields** (`RawCorosExercise`, `raw-types.ts:31-49`):
- `exerciseType`: `0`=repeat-group container, `1`=warmup, `2`=main/training,
  `3`=cooldown, `4`=rest/recovery (community-clients.md:709-719).
- `targetType`: `2`=TIME (seconds), `3`=REPS (rep count),
  `5`=DISTANCE (COROS units = m×100) (community-clients.md:727-735).
- `intensityType`: `1`=weight, `2`=HR, `3`=pace, `4`=speed, `5`=none, `6`=power,
  `7`=cadence (community-clients.md:721-725).

**Weight encoding** (`intensityType: 1`) — reverse-engineered from iOS payloads,
pinned by a unit test in the source repo
(`cygnusb/coros_api.py:1372-1420`, `tests/test_workout_payloads.py:52-97`,
community-clients.md:775-785):

| case | `intensityValue` | `intensityPercent` | `intensityDisplayUnit` | `intensityCustom` |
|---|---|---|---|---|
| bodyweight (omit both) | `""` (empty string) | `0` | `"6"` | `1` |
| kg | `round(kg × 1000)` | `0` | `"6"` | `0` |
| lbs | `round(lbs × 0.45359237 × 1000)` | `round(lbs × 1_000_000)` | `"7"` | `0` |
| explicit `kg=0` | `0` | `0` | `"6"` | `0` (renders "0.00 kg", ≠ bodyweight) |

Note `intensityDisplayUnit` is a **string** ("6"/"7"), not a number, in this
encoding — an easy hand-built-payload bug.

**Sets/reps as structure, not a field**: there is no single "sets × reps" pair on
one exercise object. A "3 sets of 10 reps" strength move is modeled as a
**repeat-group container** wrapping one child exercise:

```jsonc
// container (community-clients.md:798-805, cygnusb/coros_api.py:877-893)
{ "id": <int>, "exerciseType": 0, "intensityType": 0, "intensityValue": 0,
  "targetType": 2, "targetValue": <seconds per iteration>,
  "sets": 3, "sortNo": <16777216*n>,
  "restType": 3, "restValue": 0,
  "groupId": "0", "isGroup": true, "originId": "0" }
// child (reps target)
{ "id": <int>, "exerciseType": 2, "targetType": 3, "targetValue": 10,
  "intensityType": 1, "intensityValue": <weight per §above>,
  "groupId": "<container id>", "isGroup": false }
```

`sortNo` scheme: top-level step *n* → `16777216 × n` (2²⁴); sub-steps inside a
group → `groupSort + 65536 × (j+1)` (community-clients.md:787-792) — though the
same section notes the captured real payload also used small raw ints (1,2,4)
successfully, so this may be cosmetic rather than enforced. `restType: 3` = "skip
rests" (`restValue: 0`); `restType: 1` = explicit rest with `restValue` in seconds
(community-clients.md:737-738).

**Duration/load are server-computed, not submitted**: `POST
/training/program/calculate` (already implemented,
`coros-client.ts:282-290` `calculateProgram`) takes a full program object and
returns `planDuration`/`duration`, `planTrainingLoad`/`trainingLoad`
(community-clients.md:827-877) — the documented web-app pattern is
calculate-then-add: call `calculate` first, splice the results into `duration`/
`totalSets`/`sets` before the `schedule/update` create call
(community-clients.md:879-883).

**Exercise catalog** (`GET /training/exercise/query?sportType=4`, ~383–400
strength exercises, each with a stable `id` usable as `originId`) is documented
and already partially relied on by the bridge's name-resolution path — see
community-clients.md:468-477 — but there is **no call to this endpoint anywhere
in `services/coros-bridge/src/coros-client.ts`** today; a from-scratch strength
program builder would need to add it (or hardcode a small known-good exercise
subset) to pick valid `originId`s.

---

## (e) Yoga — plan/schedule representation

**None found. This is the weakest area of the whole survey.**

- The program-namespace `sportType` enum used by `/training/schedule/update` and
  `/training/schedule/query` is exhaustively documented as `1=Run 2=Bike 3=Swim
  4=Strength` (plus pass-through `200`/`201` for bike variants) — no yoga value
  anywhere (community-clients.md:698-707; mirrored in this repo's own
  `packages/providers/src/coros/raw-types.ts:58` comment, which lists the same
  four).
- "Yoga" appears **only** in the unrelated *activity*-namespace enum used for
  **completed** activities (`/activity/query`'s `sportType`): `403 Yoga`
  (cygnusb) or `904 Yoga` (gandroz) — two different sources disagree on the
  numeric code even for that (community-clients.md:1027-1028). Namespace
  confusion risk: this repo's own findings doc explicitly warns activity-namespace
  and program-namespace `sportType` are **different enums that share a name**
  (`docs/COROS_INTEGRATION_FINDINGS.md` §2 "Schedule read", community-clients.md
  §5.1 heading "workout namespace (≠ activity namespace!)" at community-clients.md:698).
- No community client in the 10-repo survey (community-clients.md:16-46) creates,
  reads, or even attempts a yoga *plan* workout. Grep of the full survey document
  and this repo's bridge/domain code for "yoga" turns up **zero** hits outside the
  two activity-code lines above.
- **Practical implication for a plan-studio feature**: a yoga entry could almost
  certainly be logged as a *completed activity* (COROS clearly has an activity
  type for it), but there is currently no evidence COROS Training Hub's schedule
  even supports **planning** a yoga session at all — it may simply not be a
  schedulable workout type in the product, independent of API access. This would
  need to be checked by hand in the actual COROS web app / Training Hub UI before
  any spike work, since if the UI itself has no "add yoga to plan" option, no
  amount of reverse-engineering will find a payload for it.

---

## (f) Existing LLM infrastructure + cost ceiling (for the plan-studio side)

**Where**: the only LLM call site in the entire worker/packages tree is
`apps/worker/src/services/llm.ts` (confirmed by grep across `apps/worker/src` and
`packages` for `anthropic|claude-|@anthropic-ai` — only `env.ts` and `llm.ts` hit).

**What it does today** (`generateWeeklyReview`, `llm.ts:64-213`): turns
deterministic weekly-training facts JSON into a short narrative. It is **not**
reused for planning — no code path constructs or edits a training plan via LLM
anywhere today.

**Transport**: routed through the **Vercel AI Gateway**, OpenAI-compatible
`/chat/completions`, not the Anthropic SDK directly
(`llm.ts:8-9,19-20,136-155`). Model: `anthropic/claude-haiku-4.5` by default,
overridable via `env.AI_GATEWAY_MODEL` (`llm.ts:19,73`). Config:
`MAX_OUTPUT_TOKENS = 400` (`llm.ts:25`), `TIMEOUT_MS = 20_000` with `AbortController`
(`llm.ts:26,132-133`), exactly **one attempt, no retry loop** in this function
(the "1 retry" mentioned in `docs/COSTS.md:26-27` is not visible as a retry loop
in `llm.ts` itself — worth flagging as a doc/code gap, not verified in this file).

**Caching**: by input-facts fingerprint (`fingerprint(input.facts)`,
`llm.ts:72,82`) — identical facts reuse the stored narrative without a new call.

**Cost accounting**: every call inserts a row into `llmUsage`
(`llm.ts:174-185`) with `costMicros = ceil(inputTokens×1 + outputTokens×5)`
(`llm.ts:23-24,171-173`) — i.e. **$1/M input tokens, $5/M output tokens**,
computed from the gateway's reported `usage.prompt_tokens`/`completion_tokens`.

**Budget enforcement** (`llmBudgetStatus`, `llm.ts:40-52`, constants
`llm.ts:28-32`): sums `costMicros` from `llm_usage` over the **trailing 7 days**
per user:

| Threshold | Value | Effect | Source |
|---|---|---|---|
| Warn | $2 (`2_000_000` micros) | Settings shows a warning | `llm.ts:29`, `docs/COSTS.md:36` |
| Cutoff | $8 (`8_000_000` micros) | AI calls auto-disabled; facts stored, narrative withheld | `llm.ts:30,114-118`, `docs/COSTS.md:37` |
| Absolute max | $10 (`10_000_000` micros) | Never reached — cutoff fires first | `llm.ts:31`, `docs/COSTS.md:38` |

Budget check happens **before** the network call (`llm.ts:114-118`) — a cutoff
never even reaches the gateway. Additional off switches: `aiEnabled` is a
per-user preference (`packages/domain/src/preferences.ts:28`, default `true`)
checked at `llm.ts:106-109`; `env.AI_GATEWAY_API_KEY` missing also disables
cleanly (`llm.ts:110-113`); `docs/COSTS.md:40-41` additionally documents a global
`AI_DEFAULT_ENABLED=0` env override — confirmed in `apps/worker/src/env.ts:7`
(declared) and applied upstream of `llm.ts` at `apps/worker/src/index.ts:177`
(`prefs.aiEnabled && env.AI_DEFAULT_ENABLED !== "0"`), not inside `llm.ts` itself.

**Failure mode**: every error branch (`gateway_<status>`, `llm_error`, invalid
JSON output) falls back to `persist(null, null)` and returns `narrative: null` —
`llm.ts` never throws into its caller (`llm.ts:15` doc comment, confirmed by the
`try {…} catch { await persist(null, null); … }` at `llm.ts:131-212`). This
"never break the app, degrade gracefully" pattern is exactly the shape a
plan-studio LLM feature would need to reuse.

**What plan-studio would need beyond this**: `llm.ts` is single-purpose
(`generateWeeklyReview` only) and free-text-narrative-shaped — it parses a JSON
object with one `narrative` string field (`llm.ts:120-129,193-204`), not
structured plan data. Building a plan-writing LLM feature would need a **new**
function (or generalize this one) with a different response schema (a workout/
plan object, not a narrative string), but would plug into the same gateway
client, budget table (`llmUsage`), and threshold constants (`LLM_BUDGET`) already
in place — the metering and ceiling infrastructure is reusable as-is; the
prompt/response shape is not.

---

## Summary of confidence levels

| Claim | Confidence | Key citation |
|---|---|---|
| `schedule/update` with `status:1` can create new (non-cloned) content | Plausible-but-unverified; strongest for strength, then minimal run | `community-clients.md:605-606`, `:601-604` |
| Bridge already has the wire-level machinery (`addScheduleEntity`) | Verified (in this codebase) | `coros-client.ts:241-265` |
| Product-level "create workout" job kind exists | Does not exist | `packages/domain/src/jobs.ts:20` (single literal) |
| Multi-day plan create (`plan/add`) works outside CN | Speculative — one live rejection on record | `community-clients.md:662` |
| Yoga has any plan/schedule representation | Not found; likely does not exist at the product level | `community-clients.md:698-707`, no hits for "yoga" in schedule context |
| LLM infra + $2/$8/$10 budget ceiling exists and is reusable | Verified | `apps/worker/src/services/llm.ts:28-32,40-52` |
| Live spike has ever run (move or create) | Verified — has not | `docs/COROS_INTEGRATION_FINDINGS.md:172-175` |

**Bottom line for the plan-studio decision**: the unofficial API very likely
*can* create individual strength (and simple structured-run) workouts — the
evidence is a live-tested capture from a real account, not speculation — but
(1) this repo has never exercised create-from-scratch even in a spike, only
move/clone, (2) there is no job-kind/executor/route plumbing for it yet, (3)
multi-week plan-level creation is much shakier evidence, and (4) yoga appears to
have no plan representation at all, independent of API access. A create-capable
spike (per §c) mirroring the existing reversible move-spike is the right next
step before committing product design to "the app owns all planning."

---

## LIVE VERIFICATION RESULTS (2026-08-02/03, four spike runs against the real account)

Everything below is **live-verified**, superseding the confidence table above:

1. **Create works — strength, structured run, AND bike** — `POST /training/schedule/update`
   with `status:1` and hand-built programs: all accepted (`0000`) and materialized with
   **perfect structural fidelity** (strength: repeat-group container `sets:3` wrapping a
   `targetType:3/targetValue:10` child with catalog `originId`; run/bike: 2-block
   warmup+training). Program **names round-trip** and are a reliable ownership stamp.
2. **Delete works** — `status:3` with `(planId, idInPlan, planProgramId)`: six live deletes
   (3 strays + 3 end-to-end), every one plan-scoped and precise; account restored to
   baseline both times (verified across the full span, all foreign plans untouched).
3. **THE key wire fact: `schedule/query` merges MULTIPLE plans** (this account: a COROS
   template plan + two small COROS plans + the account's own container plan). ALL identity
   logic must be planId-scoped. The container plan's `maxIdInPlan` counter works correctly
   within its own scope; creates land in the target plan with sequential ids; `planId` is
   a real routing key on both create and delete (verified: deletes never crossed plans).
4. **Full end-to-end cycle green**: create → read-after-write verify (plan-scoped stamp
   recovery) → delete → baseline restoration, exit 0, on the real account.
5. **Unprobed (deliberately)**: `plan/add` (plan-object creation) — unnecessary for the
   product: per-workout creates into the account's own container plan are sufficient.
6. **Product write-path implications**: scope every read by planId; recover created
   workouts by (target plan, happenDay, program-name stamp); store server-assigned ids;
   never rely on entity names (they don't round-trip — program names do).

Spike tooling: `pnpm coros:spike:dryrun` / `coros:spike:cleanup` / `coros:spike:create`
(services/coros-bridge/src/spike-create.ts, 43 offline tests incl. multi-plan regressions).
Reports: docs/reports/ (run history preserved in /tmp backups this session).
