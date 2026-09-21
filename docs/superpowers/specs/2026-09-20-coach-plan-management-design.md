# Coach plan management: selectors, parity verbs, and premises

Date: 2026-09-20
Status: approved design, not yet implemented
Supersedes nothing. Extends `2026-08-06-coach-intelligence-design.md` §3 (the
op vocabulary) and `2026-08-11-coach-plan-rework-design.md`.

## 1. Why

The coach can reason about a whole plan but can only *act* on it one workout
at a time, through a handle it must copy by hand, inside a 14-day window. Three
consequences, all observed in the live thread:

- **"Move all my lifting a week later, leave the running"** has no expressible
  form. Every affected session needs its own `move` op carrying an id, and ids
  only exist for sessions inside `UPCOMING 14 DAYS`. A lifting block running
  past a fortnight is not refused — it is invisible.
- **"Can we get rid of that [Saturday run]"** (2026-08-06) was answered with
  `skip`, because `skip` is the only removal-shaped verb the coach has. It is
  the wrong one: `skip` means *you did not do it* and feeds the garden as
  sanctioned rest; the athlete meant *this should not be on the plan*.
- **Shortening a set of sessions** — the ordinary shape of a taper — requires
  `ease`, which carries a full replacement session body per workout. Unusable
  in bulk, so it is not attempted.

A fourth, different failure (2026-09-19): the athlete answered "Real race I'm
doing", the coach read that as confirming the 3 Oct date, and committed a
structural write — a whole bridge block to 23 Oct — to that inference. The
athlete approved, then immediately asked why 3 Oct was a race day at all. The
premise was never on screen, so it could not be rejected.

The standard this design is measured against: **the coach should be able to
propose anything the athlete can already do by hand.** Measured against the
mutation routes in `apps/worker/src/routes/plan.ts`, today it cannot:

| Athlete can do | Coach op today |
| --- | --- |
| `workouts/:id/move` (with `toTime`) | `move` — date only |
| `workouts/:id/skip` | `skip` |
| `workouts/:id/remove` | — |
| `workouts/:id/unskip` | — |
| `workouts/:id/restore-calendar` | — |
| shorten / lengthen a session | `ease`, body required |

## 2. The selector

A selector names workouts by property or by id. It is a discriminated union,
not one object with optional `ids` — a payload where `ids` and `sport` can both
appear invites an and/or ambiguity, and this codebase has already paid for that
class of mistake once (`coach.ts`, on `add` carrying both `date` and `dates`:
"two ways to say one thing… fooled an inspection script into misreporting to
the user").

```ts
export const workoutSelectorSchema = z.discriminatedUnion("by", [
  z.object({ by: z.literal("ids"), ids: z.array(echoedId).min(1).max(60) }).strict(),
  z.object({
    by: z.literal("match"),
    from: isoDate,                       // required — never unbounded
    to: isoDate,                         // required
    sport: z.enum(["run", "strength", "yoga"]).optional(),
    // The same seven categories `coachSessionSchema` already uses.
    category: z.enum(["easy", "long", "quality", "recovery", "race", "rest", "strength"]).optional(),
    titleContains: prose(60).optional(),
  }).strict(),
]);
```

`from`/`to` are required on `by: "match"` so no selector can ever mean "every
workout I have". `by: "ids"` covers the single-workout case natively, which is
why this design does not add parallel singular and bulk forms of each new verb.

### Resolution

`expandSelectors(db, userId, ops, ctx)` runs in `coach-wake.ts` at the existing
seam — the line `let proposals = out.proposals;` immediately before the fatal
guardrail loop — and rewrites every selector op into ordinary `move` / `skip` /
`remove` / `ease`-shaped ops against live rows.

This placement is the whole reason the change is small. Downstream,
`describeOps`, `validateOps` and `applyOps` are untouched, because by the time
they see a proposal it contains only ops they already handle. The manifest
still renders the resolved list before approval; `applyOps` still reports
per-op `skipped`; the guardrails still judge the real resulting calendar.

Three rules govern resolution:

1. **One snapshot.** Every selector in a proposal resolves against the same
   pre-op view of the calendar, never sequentially. Otherwise a `moveEach` in
   op 1 silently changes what op 2's date range matches, and the outcome
   depends on op order.
2. **Live rows only.** `isNull(archivedAt)`, this user's, and targetable by the
   same predicate `validateOps` uses — so a selector can never resolve onto
   something an ordinary op would be refused for.
3. **Empty is an error, not a no-op.** A selector matching nothing raises a new
   fatal `empty_selection`, so the coach is told and can re-ask. Silently
   proposing zero ops would present the athlete an empty card.

The model's `ops: z.array().max(20)` cap is a limit on *its output*, not on the
result: expansion happens after parsing, so one selector op may resolve to
forty. Oversized resolutions are caught by the existing fatal `runaway_size`.

### Provenance

The proposal stores the original selector alongside the expanded ops. The card
renders a heading computed from it — "all strength sessions, 22 Sep – 1 Nov" —
so twelve resolved lines read as one intent. Computed, never narrated: the rule
`coach-describe.ts` exists to enforce (the model states no fact the system can
compute) applies to this heading too.

## 3. The vocabulary

Existing verbs are unchanged — they are deployed, tested, and the model's
prompt already teaches them. One extension and five additions.

**Extended:** `move { workoutId, toDate, toTime? }` — `toTime` fills the parity
gap with `applyMove`, which has always accepted one.

**New, selector-addressed:**

| Op | Meaning |
| --- | --- |
| `moveEach { select, shiftDays, toTime? }` | Relative shift. `shiftDays` bounded ±28. |
| `skipEach { select, reason? }` | Did not happen; garden sees sanctioned rest. |
| `removeEach { select }` | Should not be on the plan; archives, as `workouts/:id/remove` does. |
| `adjustEach { select, durationDeltaMinutes? \| durationScale? }` | Relative duration change. Exactly one of the two. No session body, which is what makes a bulk taper expressible. |
| `restoreEach { select }` | Reverses a skip; clears `sanctionedBy`. |

`removeEach` and `restoreEach` are the two that need genuinely new branches in
`applyOps` — archive-with-reason and un-resolve respectively, mirroring what
`workouts/:id/remove` and `workouts/:id/unskip` already do. `moveEach`,
`skipEach` and `adjustEach` resolve into ops the apply path already handles
(`move`, `skip`, `ease`), so they add no apply surface at all.

`-Each` reads unambiguously against the singular verbs. `skipEach` and
`removeEach` are distinct on purpose and the prompt must teach the difference:
skip is about *what happened*, remove is about *what the plan should contain*.

`adjustEach` rewrites `calendarBlockDurationSeconds` and scales the session's
blocks proportionally; it never changes category or structure. Sessions whose
resulting duration would fall outside the schema's 5–360 minute bounds are
clamped and reported in the manifest.

**Deliberately excluded:** `match`/`unmatch` (completion matching, its own UI
surface and concern); setting a race date (a settings write — letting proposals
reach into settings is a larger door than this design should open, and
`resolveRaceConflict` already handles choosing between existing sources);
`defer` and `repair-fidelity` (sync plumbing, not coaching).

## 4. Seeing beyond 14 days

Selectors address by property, so a handle is no longer required to act — which
is what actually removes the horizon. The coach still needs to know the block
exists. A new compact dossier section, no handles, ~5 lines:

```
## PLAN SHAPE (beyond the next 14 days)
strength · 12 sessions · 22 Sep → 01 Nov · usually Mon, Thu
run · 24 sessions · 22 Sep → 23 Oct · usually Tue, Thu, Sat, Sun
```

Per discipline: count, span, and modal weekdays. Negligible tokens, and it
cannot be mistaken for a target list because it carries no `[wo:...]`.

## 5. Seeing the sets

`RECENT STRENGTH DETAIL`, built from `activityLaps` grouped by
`exerciseNameKey` and resolved through the COROS catalog already loaded in the
dossier:

```
2026-09-15 "Lower Body" (48min) — Back Squat ×3 · Romanian Deadlift ×3 · Wall Sit ×3
```

**Known ceiling, stated plainly:** `activity_laps` has no reps or weight
column, and `RawCorosLapItem` documents none. This section therefore gives
exercises and set counts, not loads. Today the conversational coach sees only
the ≤180-word prose read from `coach_reads`, so exercise-level structure is
still a large gain — but it will not support "add 5kg to your squat".

A one-off probe (phase 0) inspects a real COROS lap payload's undocumented keys
(`RawCorosLapItem` has an index signature) to determine whether reps/load are
recoverable at all. If they are, normalizing them is a migration and this
section carries them. If not, the ceiling above is the answer and we stop
asking.

## 6. Premises

Proposals whose ops create or rewrite plan structure (`createPlan`,
`reshapeWeek`, `firmUp`, `extendPlan`, `windDown`, `retirePlan`) carry a
`premise`: one declarative sentence naming what the coach is acting on — "the
3 Oct race is a real entry" — rendered on the card directly above the approve
button.

No blocking confirmation step. A required round-trip would tax every plan
change to prevent one class of error that a visible premise already lets the
athlete catch in one tap, and the coach's restraint rules already discourage
gratuitous questions.

## 7. Watch writes for `removeEach` (phased)

**Decision (product owner, 2026-09-20): removals should reach the watch.**

This cannot be a flag. `deleteScheduledWorkoutJobSchema` requires a `pushId` —
a `studio_plan_pushes` row — plus the exact program-name stamp recorded when
*we* created the workout. Imported COROS sessions have neither. The safety that
makes deletes safe today (`stamp_mismatch`: refuse when the workout changed
since we wrote it) has no recorded fingerprint to compare an imported workout
against, and the delete lifecycle is owned by the studio push state machine.

Sequenced as its own phase, so the vocabulary is not blocked behind it:

- **Phase A (this spec's main body).** `removeEach` archives in the app only.
  The manifest states the watch is untouched — the same honest contract today's
  `skip` carries.
- **Phase B.** Generalize the delete lane to workouts the app did not author:
  identity from `plannedWorkouts.sourceIdInPlan` / `sourceProgramId` and the
  owning plan's source id; fingerprint from the most recent
  `corosScheduleSnapshots` entry in place of the create-time stamp; a refusal
  code for "COROS no longer matches what we last saw". Bulk removals enqueue
  one job per session through a lane capped at 3 per invocation with
  read-after-write verification, so partial completion is the normal case and
  the UI must show per-session state, not a single boolean.

Phase B carries its own verification requirements (§8) and must not be measured
against the COROS mock, which echoes bytes back and therefore cannot fail a
read-after-write test.

## 8. Testing

- **Resolver**: DB-backed unit tests on `makeTestDb` — each selector mode, the
  single-snapshot rule (two selector ops whose ranges overlap after a shift),
  archived exclusion, empty selection, oversized resolution.
- **Schema and manifest**: pure domain tests, including the `never` exhaustive
  check in `coach-describe.ts` that makes a new op kind a compile error.
- **Parity**: a test asserting every plan-mutation route has a corresponding op
  or an explicit documented exclusion, so this table cannot silently rot.
- **Survival-rate harness.** Generate several hundred realistic op sets and
  measure what fraction survives parse → expand → guardrails → apply, reporting
  ranked failure causes. Parsing, resolution, guardrails and apply are all
  deterministic and need no model key. This is the instrument that predicts the
  *next* request rather than re-testing the one that prompted a fix; its absence
  is why five consecutive live failures in August were each diagnosed
  separately.
- **Phase B only**: verified against a real COROS account, never the mock.

## 9. Out of scope

Tool-calling agent loop (considered and deferred: the selector abstraction
reaches the same outcomes for the known request shapes at ~1× rather than ~3×
the per-wake cost; revisit if requests appear that selectors cannot express).
Settings writes. Completion matching. Any change to the existing op verbs
beyond `move.toTime`.
