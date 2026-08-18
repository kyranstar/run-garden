/**
 * SHARED COROS CREATE/DELETE EXECUTOR — the safety core.
 *
 * This module is the live-verified machinery from the reversible create spike
 * (docs/research/plan-write-capability.md, "LIVE VERIFICATION RESULTS"),
 * lifted out so the spike and the Plan Studio push pipeline run the SAME code.
 * The spike suite (test/spike-create.test.ts) is unchanged and is the proof
 * that lifting it changed no behaviour.
 *
 * THE FIVE INVARIANTS, all learned the hard way across four live runs:
 *
 *  1. PLAN-SCOPED EVERYTHING. `/training/schedule/query` MERGES every plan on
 *     the account into one response, and `idInPlan` counters are per-plan, so
 *     they overlap freely. Every derivation, occupancy check, recovery,
 *     ownership decision and ambiguity check happens inside ONE plan
 *     (`planView`). Reasoning over the merged view produced every anomaly of
 *     the first two live runs.
 *  2. IDS COME FROM OBSERVATION, NOT FROM THE COUNTER. A live plan reported
 *     `maxIdInPlan: 0` while carrying ids up to 45. The next safe id is
 *     `max(counter, observedMax) + 1`, observed across the plan's whole span.
 *  3. OWNERSHIP IS PROVEN, NEVER ASSUMED. Entity names do not round-trip;
 *     PROGRAM names do. A workout is ours only when its plan-scoped program
 *     carries the exact name we wrote, and the link key resolves UNANIMOUSLY
 *     to programs we wrote. Recovery after a create is by that stamp, never by
 *     the claimed id — the server was observed renumbering on create.
 *  4. DELETES ARE TRIPLE-ADDRESSED AND RE-PROVEN. A `status: 3` delete is
 *     addressed by (planId, idInPlan, planProgramId) and is PLAN-WIDE, not
 *     window-scoped. Ownership is re-read and re-proven immediately before
 *     every delete, and if any other entity of the plan shares that address
 *     the delete is not sent at all.
 *  5. AMBIGUITY IS REFUSED, NEVER GUESSED. Every "can't tell" path returns a
 *     refusal the caller must handle; nothing is deleted on a maybe.
 */

import { paceBandFor } from "@rg/domain";
import {
  addDays,
  coachSessionSchema,
  daysBetween,
  studioSessionSchema,
  type CoachSession,
  type StudioSession,
  type StudioWeight,
} from "@rg/domain";
import type { PaceIntensity } from "@rg/domain";
import {
  corosDayToLocalDate,
  corosProgramFingerprint,
  localDateToCorosDay,
  type RawCorosEntity,
  type RawCorosExercise,
  type RawCorosProgram,
  type RawCorosSchedule,
} from "@rg/providers";
import type { CorosClient, CorosProgramMetrics } from "./client.js";

// ── Product-facing interfaces ───────────────────────────────────────────────

export interface CreateWorkoutSpec {
  /** COROS calendar day, YYYYMMDD (the wire format, not yyyy-mm-dd). */
  happenDay: string;
  /**
   * The workout name — AND the ownership stamp. It is written to the program
   * (program names round-trip; entity names do not) and is the only thing that
   * ever authorizes a later delete, so it must be unique per (plan, day).
   */
  name: string;
  /** A studio LIFT session, or a coach session (run sessions push as
   * structured run programs; coach lift sessions share the studio shape). */
  session: StudioSession | CoachSession;
  /** The athlete's COROS-measured lactate-threshold pace (sec/km). When
   * present, run blocks carry pace targets derived from it; when absent the
   * workout pushes with no intensity target, exactly as before. */
  thresholdPaceSecPerKm?: number;
}

/**
 * How many blocks of this session asked for a pace band and did not get one.
 *
 * A "bare timer" push is a real outcome, not an error — but it used to be a
 * SILENT one (`buildRunProgram` just wrote `intensityType: 5` and moved on),
 * and all three of the sessions the coach has pushed live went to the watch
 * as bare timers while the athlete's threshold of 289 s/km already existed.
 * The caller is the only layer that can do anything about that (re-resolve the
 * threshold, re-push later, tell the athlete), so the count is reported rather
 * than swallowed. Blocks the coach marked `rest` are NOT counted: a walk has
 * no honest pace band and never will.
 */
export function missingPaceTargets(
  session: CoachSession,
  thresholdPaceSecPerKm?: number,
): number {
  const blocks = session.run?.blocks ?? [];
  return blocks.filter(
    (b) => b.intensity != null && b.intensity !== "rest" && !paceBandFor(b.intensity, thresholdPaceSecPerKm),
  ).length;
}

/** Why a create did not end in a verified workout. */
export type CreateFailureReason =
  /** The schedule read named no plan — nothing can be scoped safely. */
  | "no_target_plan"
  /** happenDay lies outside the span the id derivation sweeps: it would be blind. */
  | "out_of_span"
  /** The derived id was taken between derivation and write — a genuine race. */
  | "slot_occupied"
  /** The server rejected the create (`code` carries its result). */
  | "rejected"
  /** Accepted, but the read-after-write found nothing carrying our stamp. */
  | "not_visible"
  /** Materialized on a different day than requested. */
  | "wrong_date"
  /** A local failure (bad catalog, network) — `error` carries the detail. */
  | "error"
  /** Already on the calendar under this stamp: idempotent no-op, `ok` is true. */
  | "already_present";

export interface CreateResult {
  ok: boolean;
  /** COROS envelope result code of the write ("0000" = accepted). */
  code?: string;
  /** Set whenever the outcome is not a plain new verified create. */
  reason?: CreateFailureReason;
  /** The idInPlan the server actually stored it under, recovered by stamp. */
  serverIdInPlan?: string;
  /**
   * The entity's `planProgramId` — the THIRD element of the delete triple, and
   * exactly what `deleteWorkout`'s target wants. (Not the program object's own
   * server id, which nothing addresses.)
   */
  serverProgramId?: string;
  /** Server-assigned entity object id. Diagnostic only; nothing addresses it. */
  serverEntityId?: string;
  /** The container plan the workout landed in — the delete triple's first element. */
  serverPlanId?: string;
  /**
   * The day the workout is ACTUALLY on (yyyy-mm-dd), whenever a stamped
   * placement was located — which is not always the day that was requested.
   * `wrong_date` and a cross-day `already_present` both mean "it exists, just
   * not where you asked", and a caller that only recorded the requested day
   * would address a later delete at an empty date and be told `stamp_mismatch`
   * — mislabelling its own stray as a user edit.
   */
  serverHappenDay?: string;
  /**
   * Run creates only: how many blocks went to the watch as a BARE TIMER
   * because no pace band could be derived (see `missingPaceTargets`). Absent
   * or `0` means every block that wanted a target got one. Reported on
   * SUCCESS as well as failure — a verified create can still owe the athlete
   * its targets, and nothing else in the pipeline can notice.
   */
  paceTargetsOwed?: number;
  /**
   * `corosProgramFingerprint` of the program this call actually PUT ON THE
   * WIRE — after `/training/program/calculate` spliced its duration and load
   * in, which is the version the server stores and the next read returns.
   *
   * Callers stamp this so a later move's content guard compares like with
   * like. Rebuilding it caller-side cannot work: the builders emit
   * `duration: 0` and the fingerprint covers duration, so a caller-built
   * stamp describes a program that was never written.
   */
  wireFingerprint?: string;
  error?: string;
}

export interface CreateWorkoutOptions {
  /** Exercise catalog, originId → display name. Every step must resolve here. */
  catalog: Map<string, string>;
  /** yyyy-mm-dd anchor for the plan-span sweep. Defaults to the system date. */
  today?: string;
  /**
   * The caller's ASSERTION about which container plan to write to. It is
   * cross-checked against the schedule read, and a disagreement is refused —
   * it never overrides what the server says the active plan is. Omit to use
   * the plan the read names.
   */
  planId?: string;
  /**
   * Diagnostic sink. SENSITIVITY: lines written here never contain a workout
   * title the caller did not author unless `verbose` is set — foreign workouts
   * are described by identifier only, exactly as in a committed report.
   */
  log?: (line: string) => void;
  /**
   * Allow foreign workout TITLES into `log`. Only for an interactive tool
   * printing to the user's own terminal, where the title is what identifies
   * the workout. Defaults to false; never enable for a persisted log.
   */
  verbose?: boolean;
}

/**
 * What a caller recorded when the workout was pushed. Every field is a
 * *claim*: the executor re-reads and re-proves all of it before deleting.
 */
export interface DeleteWorkoutTarget {
  /** COROS calendar day, YYYYMMDD. */
  happenDay: string;
  /** The exact program-name stamp recorded at push time. */
  name: string;
  /** The idInPlan the server stored it under. */
  idInPlan: string;
  /** The recorded `planProgramId` — third element of the delete triple. */
  programId: string;
  /** The container plan. Nothing outside it is ever read or written. */
  planId: string;
}

/** Why a delete was not sent. `ok` is false in every case. */
export type DeleteRefusal =
  /**
   * Nothing in the target plan carries this stamp on this day, and the
   * recorded address is free: the workout is already gone (or never existed).
   * No delete was sent. A caller removing a workout may treat this as terminal.
   */
  | "not_found"
  /**
   * The recorded address is occupied, but not by a workout provably ours on
   * the recorded day — the user edited, renamed or moved it in COROS. Drift:
   * never deleted.
   */
  | "stamp_mismatch"
  /**
   * The delete could take something we did not create: either the delete
   * address is shared with another entity of the plan, or the link key
   * resolves to both our program and one we did not write.
   */
  | "ambiguous";

export interface DeleteResult {
  ok: boolean;
  refused?: DeleteRefusal;
  /** COROS envelope result code, when a delete was actually sent. */
  code?: string;
  error?: string;
}

export interface DeleteWorkoutOptions {
  /** yyyy-mm-dd anchor for the plan-wide sweep. Defaults to the system date. */
  today?: string;
  /**
   * Diagnostic sink. SENSITIVITY: lines written here never contain a workout
   * title the caller did not author unless `verbose` is set — foreign workouts
   * are described by identifier only, exactly as in a committed report.
   */
  log?: (line: string) => void;
  /**
   * Allow foreign workout TITLES into `log`. Only for an interactive tool
   * printing to the user's own terminal. Defaults to false.
   */
  verbose?: boolean;
}

// ── Program construction (research §(d)) ────────────────────────────────────

/** §5.3: top-level step n → 2^24 · n; sub-steps → groupSort + 2^16 · (j+1). */
export const TOP_SORT = 16_777_216;
export const SUB_SORT = 65_536;

/**
 * §5.5 per-exercise metadata block. Documented for running programs; applied
 * to all hand-built programs here by analogy (the survey gives no separate
 * strength list — noted as inferred in the research doc). Live-verified to
 * round-trip on strength creates.
 */
export const EXERCISE_METADATA = {
  exerciseKind: 0,
  gradeSystem: 0,
  hrType: 0,
  intensityMultiplier: 0,
  intensityPercent: 0,
  intensityPercentExtend: 0,
  onsightGradeOffset: 0,
  overview: "",
  packageTime: 0,
  sourceId: "0",
  subType: 0,
  targetDisplayUnit: 0,
} as const;

/**
 * §(d): the metric display unit is the STRING "6", not the number 6 — an easy
 * hand-built-payload bug, hence the constant.
 *
 * This is the ONLY display unit this module emits. `StudioWeight` is kilograms
 * or bodyweight, so the research table's imperial row (display unit "7", with
 * its own `intensityValue` and `intensityPercent` formulas) has no code path
 * here and is deliberately not half-implemented: adding lbs means adding the
 * whole row, not just a constant.
 */
export const DISPLAY_UNIT_KG = "6";

/** §5.4 `restType`: 3 = "skip rests" (restValue 0); 1 = explicit rest in seconds. */
const REST_TYPE_SKIP = 3;
const REST_TYPE_EXPLICIT = 1;

/**
 * The repeat-group container's TIME-per-iteration target (§5.4 wants one). The
 * domain models sets/reps/weight, not seconds per set, so this is a fixed
 * placeholder — the value the spike proved live — and duration is anyway
 * recomputed by `/training/program/calculate` before the create.
 */
const CONTAINER_SECONDS_PER_SET = 60;

/**
 * §(d) weight-encoding table, applied to a real (non-container) step:
 *
 *   | case        | intensityValue      | Percent | DisplayUnit | Custom |
 *   |-------------|---------------------|---------|-------------|--------|
 *   | bodyweight  | `""` (empty STRING) | 0       | `"6"`       | 1      |
 *   | kg          | round(kg × 1000)    | 0       | `"6"`       | 0      |
 *   | explicit 0  | `0` (NUMBER)        | 0       | `"6"`       | 0      |
 *
 * Bodyweight's empty string and 0 kg's numeric zero are DIFFERENT cases: 0
 * renders "0.00 kg" in the app. The wire cast is deliberate — RawCorosExercise
 * types `intensityValue` as a number for the read path, but the write path
 * needs a string here.
 */
export function applyWeightIntensity(exercise: RawCorosExercise, weight: StudioWeight): void {
  const wire = exercise as Record<string, unknown>;
  wire.intensityType = 1; // 1 = weight, for every row of the table
  wire.intensityPercent = 0;
  wire.intensityDisplayUnit = DISPLAY_UNIT_KG;
  if (weight.type === "bodyweight") {
    wire.intensityValue = "";
    wire.intensityCustom = 1;
    return;
  }
  // Covers explicit 0 kg too: round(0 × 1000) = 0 with intensityCustom 0.
  wire.intensityValue = Math.round(weight.value * 1000);
  wire.intensityCustom = 0;
}

/** COROS catalog origin ids for generic run blocks — the exact values the
 * live spike created and verified (COROS_WRITE_PROTOCOL.md TEST B). */
export const RUN_WARMUP_ORIGIN_ID = "425895398452936705";
export const RUN_WORK_ORIGIN_ID = "426109589008859136";

/**
 * What a run block IS, as the watch announces it. The wire has carried all
 * four since forever (`raw-types.ts`: `1=warmup 2=work 3=cooldown
 * 4=rest/recovery`) and `normalize.ts` has always read all four back — the
 * coach lane just never wrote more than two of them, so a "walk back down"
 * arrived on the watch as *run for 3 minutes*.
 */
export type RunBlockRole = "warmup" | "work" | "cooldown" | "recovery";

/**
 * role → the two wire fields that carry it, and the label COROS's own
 * programs use for it (the athlete's imported plan spells them T1120 "Warm
 * Up", T3001 "Run", T1122 "Cool Down", T1123 "Recover"; the hand-built spike
 * proved plain English round-trips, so the words go on the wire directly).
 *
 * `originId`: the catalog ids are spike-verified for warmup and work ONLY
 * (COROS_WRITE_PROTOCOL.md TEST B). No cooldown/recovery run-catalog id has
 * ever been observed on this account — the synced catalog is sportType 4
 * only, and COROS's own run programs carry no `originId` at all — so the
 * generic work id rides along and the ROLE is carried by `exerciseType`,
 * which is the field the read path actually reads.
 */
const RUN_ROLE_WIRE: Record<RunBlockRole, { exerciseType: number; name: string; originId: string }> = {
  warmup: { exerciseType: 1, name: "Warm up", originId: RUN_WARMUP_ORIGIN_ID },
  work: { exerciseType: 2, name: "Run", originId: RUN_WORK_ORIGIN_ID },
  cooldown: { exerciseType: 3, name: "Cool down", originId: RUN_WORK_ORIGIN_ID },
  recovery: { exerciseType: 4, name: "Recover", originId: RUN_WORK_ORIGIN_ID },
};

/** Intensities that make the blocks around them warm-ups and cool-downs. */
const HARD_INTENSITIES = new Set<PaceIntensity>(["steady", "threshold", "interval"]);

/** Words an upstream `role` field may use, folded onto the four wire roles. */
const ROLE_WORDS: Record<string, RunBlockRole> = {
  warmup: "warmup",
  warm: "warmup",
  work: "work",
  main: "work",
  interval: "work",
  cooldown: "cooldown",
  cool: "cooldown",
  recovery: "recovery",
  recover: "recovery",
  rest: "recovery",
  float: "recovery",
  walk: "recovery",
};

/** A block's declared role, when it has one. Tolerant of spelling. */
function declaredRole(block: unknown): RunBlockRole | undefined {
  const raw = (block as { role?: unknown } | null)?.role;
  if (typeof raw !== "string") return undefined;
  return ROLE_WORDS[raw.toLowerCase().replace(/[^a-z]/g, "")];
}

/**
 * The role of every block of a session — derived from what the block IS, not
 * from where it sits.
 *
 * The rule this replaces was `index === 0 && blocks.length >= 2`, which
 * labelled the opening rep of a VO2 session "Warm up" on the watch (verified
 * live: a 3:58–4:13/km interval called `Warm up`) and, because a single-block
 * session got `work`, disagreed with itself about what position even meant.
 *
 * Precedence:
 *  1. AN EXPLICIT `role` ON THE BLOCK WINS. Nothing upstream writes one today
 *     — `coachRunBlockSchema` has `kind`, `value` and `intensity` and zod
 *     strips what it does not declare — so this is dormant until the coach
 *     vocabulary grows the field. THAT is the field that would make warm-up
 *     vs. cool-down explicit rather than inferred; everything below is
 *     inference and says so.
 *  2. `intensity: "rest"` is a RECOVERY block. This is the coach's own word
 *     for "walk back down"/"stand"/"off" (RUN_INTENSITY_SYNONYMS folds all
 *     three onto `rest`), and it is the one role the session data states
 *     outright.
 *  3. An EASY block that opens a session containing harder work is a warm-up;
 *     an easy block that closes one is a cool-down. Both are inferences, but
 *     they are the inferences the words carry: `warmup`/`warm up`/`cooldown`/
 *     `cool down` all normalize to `easy` upstream, so intensity alone cannot
 *     separate them and position is the only remaining signal — used ONLY
 *     where the block is easy and the session really does contain hard work.
 *  4. Everything else is work, including the first block of a session that is
 *     hard from the gun.
 */
export function runBlockRoles(
  blocks: ReadonlyArray<{ intensity?: PaceIntensity | undefined }>,
): RunBlockRole[] {
  const hard = blocks.map((b) => b.intensity != null && HARD_INTENSITIES.has(b.intensity));
  return blocks.map((b, i) => {
    const declared = declaredRole(b);
    if (declared) return declared;
    if (b.intensity === "rest") return "recovery";
    if (b.intensity !== "easy" || blocks.length < 2) return "work";
    if (i === 0 && hard.slice(1).some(Boolean)) return "warmup";
    if (i === blocks.length - 1 && hard.slice(0, i).some(Boolean)) return "cooldown";
    return "work";
  });
}

/**
 * Build a structured RUN program (sportType 1) from one coach session —
 * Bundle A Task A10, the coach-era generalization of the safety core.
 *
 * The wire shape is the live-verified minimal topology (protocol §4.4 point
 * 9 / TEST B): N sequential blocks, no repeat groups, targetType 2 (TIME,
 * whole seconds), and pace as the only intensity that round-trips (HR is
 * remapped onto the account's own zones by the server).
 *
 * EACH BLOCK'S ROLE IS ITS OWN (2026-08-17, `runBlockRoles`). The topology
 * used to emit `exerciseType` 1 and 2 and nothing else — first block warmup,
 * everything else training — which meant the coach could not write the two
 * roles the athlete's own library is full of (67 cooldown, 48 recovery
 * stages), and a `rest` block reached the watch as *run for 3 minutes*.
 *
 * DISTANCE blocks are refused here: distance targets have not been spike-
 * verified on the wire, and this is the last code before the user's real
 * calendar. Callers keep distance-block sessions app-only until a spike
 * extends the protocol doc.
 *
 * Same self-validating stance as the strength builder: the session is
 * re-parsed with `coachSessionSchema`, and `idInPlan`/`planId` are
 * placeholders the caller splices in immediately before the write.
 */
export function buildRunProgram(spec: {
  happenDay: string;
  name: string;
  session: CoachSession;
  /** Threshold pace (sec/km) anchoring per-block pace targets. */
  thresholdPaceSecPerKm?: number;
}): RawCorosProgram {
  const parsed = coachSessionSchema.safeParse(spec.session);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "session"}: ${issue.message}`)
      .join("; ");
    throw new Error(`cannot build "${spec.name}": invalid session — ${detail}`);
  }
  const run = parsed.data.run;
  if (!run) throw new Error(`cannot build "${spec.name}": not a run session`);
  if (run.blocks.some((b) => b.kind === "distance")) {
    throw new Error(
      `cannot build "${spec.name}": distance targets are not spike-verified on the wire — keep this session app-only`,
    );
  }

  // Pace targets round-trip EXACTLY on this wire (spike-verified: HR does
  // not — the server remaps it onto the account's own zones). Bounds are
  // milliseconds per km: intensityValue is the fast edge, extend the slow.
  let anyPaceTarget = false;
  const roles = runBlockRoles(run.blocks);
  const exercises: RawCorosExercise[] = run.blocks.map((b, index) => {
    const id = index + 1;
    const wire = RUN_ROLE_WIRE[roles[index]!];
    const band = paceBandFor(b.intensity, spec.thresholdPaceSecPerKm);
    if (band) anyPaceTarget = true;
    return {
      ...EXERCISE_METADATA,
      id,
      name: wire.name,
      exerciseType: wire.exerciseType,
      sportType: 1,
      targetType: 2, // TIME, whole seconds
      // WHOLE seconds, explicitly rounded. `value` is minutes and is no
      // longer guaranteed integral — a 15-second stride is 0.25 minutes, and
      // the domain's own quantiser lands on `round(seconds)/60`, which is
      // exact "to within 2.3e-13". Every app-side consumer rounds that away;
      // the wire is the one consumer that cannot, and `targetValue:
      // 899.9999999999999` is not a number to hand a watch.
      targetValue: Math.round(b.value * 60),
      ...(band
        ? {
            intensityType: 3, // PACE
            intensityValue: band.fastSecPerKm * 1000,
            intensityValueExtend: band.slowSecPerKm * 1000,
          }
        : { intensityType: 5, intensityValue: 0 }), // none
      sets: 1,
      sortNo: TOP_SORT * id,
      restType: 3,
      restValue: 0,
      groupId: "0",
      isGroup: false,
      originId: wire.originId,
    };
  });

  return {
    idInPlan: 0,
    planId: "",
    name: spec.name,
    overview: "",
    sportType: 1,
    subType: 65535, // structured
    duration: 0, // server-computed via /training/program/calculate
    estimatedTime: 0,
    trainingLoad: 0,
    estimatedValue: 0,
    estimatedType: 0,
    distance: 0,
    estimatedDistance: 0,
    exerciseNum: exercises.length,
    totalSets: 0,
    hybridTotalSets: 0,
    gradeSystemVersion: 0,
    poolLength: 0,
    poolLengthId: 0,
    poolLengthUnit: 0,
    referExercise: { gradeSystem: 0, hrType: 0, intensityType: anyPaceTarget ? 3 : 1, valueType: 1 },
    fastIntensityTypeName: anyPaceTarget ? "pace" : "weight",
    sourceUrl: "",
    videoCoverUrl: "",
    videoUrl: "",
    targetType: 0,
    targetValue: 0,
    type: 0,
    unit: 0,
    access: 1,
    authorId: "0",
    pbVersion: 2,
    version: 0,
    exercises,
  };
}

/** The load encoding is identical in both vocabularies; the types are not. */
type WireWeight = StudioWeight;

/**
 * One strength step, normalized out of whichever vocabulary wrote it. The
 * studio's `sets`/`reps` and the coach's `holdSeconds`/`perSide`/
 * `eccentricSeconds` all land here, so the wire builder below has exactly one
 * shape to reason about.
 */
interface StrengthStep {
  originId: string;
  /** The author's label. Only ever used in an error message: the CATALOG's
   * name is what goes on the wire. */
  label: string;
  sets: number;
  reps?: number;
  holdSeconds?: number;
  perSide: boolean;
  eccentricSeconds?: number;
  weight: WireWeight;
  restSeconds: number;
  note?: string;
}

/** A whole strength body: its steps, and whether they are a CIRCUIT. */
interface StrengthPlan {
  steps: StrengthStep[];
  /** Set = the steps are one circuit cycled this many times (coach `rounds`). */
  rounds?: number;
}

/**
 * A hard ceiling on emitted wire steps. The coach vocabulary allows 30
 * exercises × 30 sets, and per-side work doubles the children, so an
 * unbounded expansion could put 1800 steps on the athlete's watch. Refusing
 * is the safe direction: nothing legitimate comes near this.
 */
const MAX_WIRE_STEPS = 200;

/** Reps, hold, per-side and tempo are all the STUDIO's shape or the COACH's;
 * a StudioSession is `{title, weekday, exercises}` and carries none of the
 * discipline bodies, so the discriminator is unambiguous. */
function isCoachShaped(session: unknown): boolean {
  const o = session as Record<string, unknown> | null;
  if (!o) return false;
  return (
    typeof o["category"] === "string" ||
    o["lift"] !== undefined ||
    o["mobility"] !== undefined ||
    o["run"] !== undefined
  );
}

/**
 * Re-validate the session with the schema that actually describes it, and
 * normalize it to `StrengthStep`s.
 *
 * THE BUG THIS CLOSES (audit 2026-08-17 #3): the builder re-parsed every
 * session with `studioSessionSchema.safeParse`, which is `.strict()` and was
 * written for the plan-generation path. A coach lift session does not merely
 * lose its extra keys there — it is REJECTED outright (`Unrecognized key(s)
 * in object: 'holdSeconds'`), which is why the `targetType: 2` hold branch
 * added the day before was dead code: the value could never reach it. The
 * fix is not to loosen the studio schema (its strictness is load-bearing for
 * LLM drift) but to parse each vocabulary with its own.
 */
function readStrengthSession(
  session: StudioSession | CoachSession,
  name: string,
): StrengthPlan {
  const invalid = (issues: Array<{ path: PropertyKey[]; message: string }>): Error =>
    new Error(
      `cannot build "${name}": invalid session — ` +
        issues.map((i) => `${i.path.join(".") || "session"}: ${i.message}`).join("; "),
    );

  if (isCoachShaped(session)) {
    const parsed = coachSessionSchema.safeParse(session);
    if (!parsed.success) throw invalid(parsed.error.issues);
    const block = parsed.data.lift ?? parsed.data.mobility;
    if (!block) {
      throw new Error(`cannot build "${name}": the session has no lift or mobility body`);
    }
    const steps = block.exercises.map((e): StrengthStep => {
      if (!e.originId) {
        // originId is SERVER-filled from the exercise name
        // (exercise-catalog.ts). Absent means the athlete's synced catalog
        // has no match, and the wire has nowhere to put the movement.
        throw new Error(
          `exercise "${e.name}" has no COROS catalog id — refusing to build a program` +
            " the server would reject",
        );
      }
      return {
        originId: e.originId,
        label: e.name,
        sets: e.sets,
        reps: e.reps,
        holdSeconds: e.holdSeconds,
        perSide: e.perSide === true,
        eccentricSeconds: e.eccentricSeconds,
        weight: e.weight,
        restSeconds: e.restSeconds,
        note: e.note,
      };
    });
    return { steps, ...(block.rounds != null ? { rounds: block.rounds } : {}) };
  }

  const parsed = studioSessionSchema.safeParse(session);
  if (!parsed.success) throw invalid(parsed.error.issues);
  return {
    steps: parsed.data.exercises.map((e) => ({
      originId: e.originId,
      label: e.name,
      sets: e.sets,
      reps: e.reps,
      perSide: false,
      weight: e.weight,
      restSeconds: e.restSeconds,
      note: e.note,
    })),
  };
}

/**
 * Prose the wire has no field for, parked in `overview` — the one free-text
 * slot a step has.
 *
 * `eccentricSeconds` is the honest case: COROS's exercise object models sets,
 * reps, time, distance and load, and has NO tempo field of any kind. "4s
 * down" therefore cannot reach the watch as a prescription; it can only be
 * disclosed. The app's own session sheet renders it (`formatExercise`), so
 * the athlete does see it — just not mid-set.
 */
function stepOverview(step: StrengthStep): string {
  const bits: string[] = [];
  if (step.eccentricSeconds != null) bits.push(`${step.eccentricSeconds}s down`);
  if (step.perSide) bits.push("each side");
  if (step.note) bits.push(step.note);
  return bits.join(" · ");
}

/**
 * Build a structured strength program (sportType 4) from one STUDIO session
 * or one COACH lift/mobility session — both vocabularies, each parsed with
 * its own schema (`readStrengthSession`).
 *
 * "3 sets of 10" is STRUCTURE, not a field (§(d)): straight sets become one
 * repeat-group container per exercise (`sets` = the set count) wrapping the
 * real step; a CIRCUIT (`rounds`) becomes one container repeated `rounds`
 * times with every exercise as a child of it. Containers are never counted in
 * `exerciseNum` (§5.4).
 *
 * `catalog` maps originId → display name and is the server-side validation
 * gate: an exercise the account's own COROS catalog does not know THROWS here,
 * before any wire call, rather than being rejected (or silently mangled) by
 * the server. The catalog's name wins over the caller's label, because the
 * catalog is the authority at push time.
 *
 * The session is RE-VALIDATED here rather than trusted. This is the last code
 * between an LLM-authored plan and the user's real calendar, and it is reached
 * from several callers (jobs, the spike, a future retry path); a
 * self-validating safety core is cheaper than proving every caller validated
 * first. Out-of-range sets/reps/weights and unknown fields throw here.
 *
 * MOBILITY PUSHES AS sportType 4. The program namespace COROS documents is
 * 1 Run / 2 Bike / 3 Swim / 4 Strength — there is no mobility or yoga
 * program sport, so a mobility session files under strength on the watch.
 * The app keeps the honest discipline (`sessionSport` → "yoga"); only the
 * watch's own filing is coarse.
 *
 * `idInPlan`/`planId` are placeholders — the caller splices in the derived
 * values (as `addScheduleEntity` does anyway) immediately before the write.
 */
export function buildStrengthProgram(
  spec: CreateWorkoutSpec,
  catalog: Map<string, string>,
): RawCorosProgram {
  const { steps, rounds } = readStrengthSession(spec.session, spec.name);
  if (steps.length === 0) {
    throw new Error(`cannot build "${spec.name}": the session has no exercises`);
  }
  for (const step of steps) {
    if (!catalog.has(step.originId)) {
      throw new Error(
        `exercise originId ${step.originId} ("${step.label}") is not in the COROS exercise catalog` +
          " — refusing to build a program the server would reject",
      );
    }
  }

  /**
   * One real (non-container) step. `sortNo` is the caller's business: §5.3
   * numbers sub-steps `groupSort + 2^16·(j+1)`.
   *
   * PER-SIDE WORK IS TWO STEPS, not one (2026-08-17). The wire has no
   * `perSide` flag, and emitting a single step would prescribe HALF the work
   * the coach wrote — a silent under-prescription. Two identical children is
   * what the athlete actually does, and `overview` says "each side" so the
   * pairing is legible rather than looking like a duplicate.
   */
  const childOf = (
    step: StrengthStep,
    id: number,
    groupId: number,
    sortNo: number,
  ): RawCorosExercise => {
    const overview = stepOverview(step);
    const child: RawCorosExercise = {
      ...EXERCISE_METADATA,
      id,
      // The catalog is the authority at push time — and its names are the
      // T-codes the app resolves for display, so nothing is appended to them.
      name: catalog.get(step.originId)!,
      exerciseType: 2, // main / training
      sportType: 4,
      // A TIMED HOLD is a time target, not a rep count. Hardcoding REPS meant
      // a wall sit could only go to the watch as "3 × 1 rep" with the real
      // prescription stranded in prose. `targetType: 2 = time(s)` has been on
      // the wire all along and `normalize.ts` already reads it back.
      // A step with NEITHER ("three ramping sets, stop when it gets heavy")
      // is an OPEN step: no target value can be honest, and `normalize.ts`
      // maps an unknown targetType to `durationType: "open"`.
      ...(step.holdSeconds != null
        ? { targetType: 2, targetValue: step.holdSeconds }
        : step.reps != null
          ? { targetType: 3, targetValue: step.reps }
          : { targetType: 0, targetValue: 0 }),
      sets: 1,
      sortNo,
      restType: step.restSeconds > 0 ? REST_TYPE_EXPLICIT : REST_TYPE_SKIP,
      restValue: step.restSeconds > 0 ? step.restSeconds : 0,
      groupId: String(groupId),
      isGroup: false,
      originId: step.originId,
      ...(overview ? { overview } : {}),
    };
    applyWeightIntensity(child, step.weight);
    return child;
  };

  /** The repeat-group container: `sets` is the repeat count (§(d)). */
  const containerOf = (id: number, sets: number, sortNo: number): RawCorosExercise => ({
    ...EXERCISE_METADATA,
    id,
    name: "Group",
    exerciseType: 0, // repeat-group container
    sportType: 4,
    intensityType: 0,
    intensityValue: 0,
    targetType: 2, // TIME per iteration
    targetValue: CONTAINER_SECONDS_PER_SET,
    sets,
    sortNo,
    restType: REST_TYPE_SKIP, // §5.4 pins the container itself to "skip rests"
    restValue: 0,
    groupId: "0",
    isGroup: true,
    originId: "0",
  });

  const exercises: RawCorosExercise[] = [];
  let realSteps = 0;
  let totalSets = 0;
  let nextId = 1;

  if (rounds != null) {
    // A CIRCUIT: one container repeated `rounds` times, every exercise a child
    // of it. This shape is not new — `buildStrengthProgram` has emitted it per
    // exercise since the spike, and `normalize.ts` reads `exerciseType: 0` +
    // `sets` back as `repeatCount` (the athlete's own library holds 370 such
    // stages). It was simply never reachable from the coach's `rounds`, so
    // "3 rounds of wall sit / plank / side plank" had to go to the watch as
    // three unrelated straight-set blocks — a different session.
    const containerId = nextId++;
    const groupSort = TOP_SORT;
    exercises.push(containerOf(containerId, rounds, groupSort));
    let sub = 0;
    for (const step of steps) {
      // `sets` inside a circuit is the work done PER ROUND (coach.ts), so a
      // rare sets>1 is that many passes of the movement within one round.
      for (let set = 0; set < step.sets; set++) {
        for (let side = 0; side < (step.perSide ? 2 : 1); side++) {
          sub += 1;
          if (realSteps + 1 > MAX_WIRE_STEPS) {
            throw new Error(
              `cannot build "${spec.name}": the session expands to more than ${MAX_WIRE_STEPS}` +
                " wire steps — refusing to write a program that size",
            );
          }
          realSteps += 1;
          exercises.push(childOf(step, nextId++, containerId, groupSort + SUB_SORT * sub));
        }
      }
    }
    totalSets = rounds * realSteps;
  } else {
    // STRAIGHT SETS: one container per exercise, `sets` the repeat count.
    steps.forEach((step, index) => {
      const containerId = nextId++;
      const groupSort = TOP_SORT * (index + 1);
      exercises.push(containerOf(containerId, step.sets, groupSort));
      const sides = step.perSide ? 2 : 1;
      for (let side = 0; side < sides; side++) {
        if (realSteps + 1 > MAX_WIRE_STEPS) {
          throw new Error(
            `cannot build "${spec.name}": the session expands to more than ${MAX_WIRE_STEPS}` +
              " wire steps — refusing to write a program that size",
          );
        }
        realSteps += 1;
        exercises.push(childOf(step, nextId++, containerId, groupSort + SUB_SORT * (side + 1)));
      }
      totalSets += step.sets * sides;
    });
  }

  return {
    idInPlan: 0,
    planId: "",
    name: spec.name,
    overview: "",
    sportType: 4,
    subType: 65535, // structured
    duration: 0, // server-computed via /training/program/calculate
    estimatedTime: 0,
    trainingLoad: 0,
    estimatedValue: 0,
    estimatedType: 0,
    distance: 0,
    estimatedDistance: 0,
    exerciseNum: realSteps, // real steps only — containers must NOT count
    totalSets,
    hybridTotalSets: 0,
    gradeSystemVersion: 0,
    poolLength: 0,
    poolLengthId: 0,
    poolLengthUnit: 0,
    referExercise: { gradeSystem: 0, hrType: 0, intensityType: 1, valueType: 1 },
    fastIntensityTypeName: "weight",
    sourceUrl: "",
    videoCoverUrl: "",
    videoUrl: "",
    targetType: 0,
    targetValue: 0,
    type: 0,
    unit: 0,
    access: 1,
    authorId: "0",
    pbVersion: 2,
    version: 0,
    exercises,
  };
}

/**
 * Is this session a RUN? The discipline bodies are mutually exclusive
 * (`coachSessionSchema`'s one-body refinement), and a `StudioSession` carries
 * none of them, so the presence of `run` is the whole test.
 */
export function isRunSession(session: StudioSession | CoachSession): boolean {
  return Boolean((session as { run?: unknown }).run);
}

/**
 * THE dispatch from a session to the program that goes on the wire — run
 * sessions to `buildRunProgram`, lift AND mobility sessions to
 * `buildStrengthProgram`.
 *
 * It is a named function rather than an `if` inside `createWorkout` because
 * the content-update path has to write EXACTLY what the create path would
 * write: a second dispatch (or a second builder) would let the two drift, and
 * the whole point of an update is that the wire ends up carrying the same
 * program a fresh create of the same session would have carried.
 *
 * NOTE FOR ANYONE READING A COMMENT THAT SAYS OTHERWISE: this executor does
 * not build "a structured RUN program and nothing else". Both builders are
 * live, and lift/mobility sessions are pushed and read back by
 * `test/wire-simulation.test.ts` and `test/content-update.test.ts`.
 */
export function buildProgramFor(
  spec: CreateWorkoutSpec,
  catalog: Map<string, string>,
): RawCorosProgram {
  if (isRunSession(spec.session)) {
    return buildRunProgram({
      happenDay: spec.happenDay,
      name: spec.name,
      session: spec.session as CoachSession,
      thresholdPaceSecPerKm: spec.thresholdPaceSecPerKm,
    });
  }
  return buildStrengthProgram(spec, catalog);
}

/**
 * The schedule entity that places a program on a calendar day. `dayNo` is only
 * meaningful when the plan declares a start day.
 */
export function buildEntity(opts: {
  idInPlan: number;
  planId: string;
  date: string; // yyyy-mm-dd
  planStartDay?: number;
  sportType: number;
  name: string;
}): RawCorosEntity {
  const entity: RawCorosEntity = {
    idInPlan: opts.idInPlan,
    planId: opts.planId,
    planProgramId: String(opts.idInPlan),
    happenDay: localDateToCorosDay(opts.date),
    sortNo: 1,
    sortNoInSchedule: 1,
    completeRate: "-1.00",
    standardRate: "0",
    score: "0",
    thirdParty: false,
    name: opts.name,
    sportType: opts.sportType,
  };
  if (opts.planStartDay != null && opts.planStartDay > 0) {
    entity.dayNo = daysBetween(corosDayToLocalDate(opts.planStartDay), opts.date) + 1;
  }
  return entity;
}

/**
 * Splice the server's `/training/program/calculate` output into a program
 * before creating it — the web app's documented two-step (§(d)). Zeroes and
 * absent values never overwrite what the client computed.
 */
export function applyCalculated(
  program: RawCorosProgram,
  m: CorosProgramMetrics,
): RawCorosProgram {
  const out: RawCorosProgram = { ...program };
  if (m.duration != null && m.duration > 0) {
    out.duration = m.duration;
    out.estimatedTime = m.duration;
  }
  if (m.trainingLoad != null && m.trainingLoad > 0) {
    out.trainingLoad = m.trainingLoad;
    out.estimatedValue = m.trainingLoad;
  }
  if (m.distance != null && m.distance > 0) {
    out.distance = m.distance;
    out.estimatedDistance = m.distance;
  }
  // Never clobber a client-computed set count with 0/undefined from calculate.
  if (m.totalSets != null && m.totalSets > 0 && out.totalSets != null) out.totalSets = m.totalSets;
  return out;
}

// ── Plan-scoped views (INVARIANT 1) ─────────────────────────────────────────

export interface Located {
  entity: RawCorosEntity;
  program: RawCorosProgram | undefined;
  date: string;
}

/**
 * A single plan's rows, carved out of a schedule read.
 *
 * THE CENTRAL FACT: `/training/schedule/query` MERGES every plan on the
 * account into one response. A live account carried several — COROS-authored
 * templates the athlete follows, and the account's own plan container that
 * creates land in — and their `idInPlan` values overlap freely, because the
 * counter is per plan. Only the top-level `id`, `name` and `maxIdInPlan` of
 * the response describe the target plan.
 */
export interface PlanView {
  planId: string;
  entities: RawCorosEntity[];
  programs: RawCorosProgram[];
}

/**
 * Rows belonging to `planId` only. Membership is an exact `planId` match — a
 * row of unknown provenance is never assumed to be ours.
 */
export function planView(raw: RawCorosSchedule, planId: string): PlanView {
  return {
    planId,
    entities: (raw.entities ?? []).filter((e) => String(e.planId ?? "") === planId),
    programs: (raw.programs ?? []).filter((p) => String(p.planId ?? "") === planId),
  };
}

/** planId → what that plan contributed to a read. For diagnostics. */
export function planBreakdown(
  raw: RawCorosSchedule,
  /**
   * Always listed, even contributing nothing — an empty target plan is the
   * live shape and must not vanish from the diagnosis.
   */
  ensurePlanId?: string,
): Array<{ planId: string; entityCount: number; programCount: number; idInPlan: string[] }> {
  const byPlan = new Map<string, { entities: RawCorosEntity[]; programs: RawCorosProgram[] }>();
  const bucket = (planId: string): { entities: RawCorosEntity[]; programs: RawCorosProgram[] } => {
    let found = byPlan.get(planId);
    if (!found) {
      found = { entities: [], programs: [] };
      byPlan.set(planId, found);
    }
    return found;
  };
  if (ensurePlanId !== undefined && ensurePlanId !== "") bucket(ensurePlanId);
  for (const entity of raw.entities ?? []) bucket(String(entity.planId ?? "")).entities.push(entity);
  for (const program of raw.programs ?? [])
    bucket(String(program.planId ?? "")).programs.push(program);
  return [...byPlan.entries()]
    .map(([planId, rows]) => ({
      planId,
      entityCount: rows.entities.length,
      programCount: rows.programs.length,
      idInPlan: rows.entities.map((e) => String(e.idInPlan)).sort((a, b) => Number(a) - Number(b)),
    }))
    .sort((a, b) => b.entityCount - a.entityCount);
}

/**
 * Programs linked to an entity by the entity's OWN link key, WITHIN ITS PLAN.
 * `planProgramId` is the field that points at the program-in-plan (usually a
 * copy of `idInPlan`, but not always); matching on `idInPlan` alone made an
 * entity whose `planProgramId` differed look program-less.
 */
export function programsFor(view: PlanView, entity: RawCorosEntity): RawCorosProgram[] {
  /**
   * THE LINK IS `entity.idInPlan` → `program.idInPlan`, and it took a live
   * refusal to establish that (2026-08-17).
   *
   * This used to key on `planProgramId ?? idInPlan`, which is right for every
   * workout THIS APP creates — we emit both numbers equal, so the `??` fallback
   * hid the difference and no test could see it (the schedule fixture sets
   * `planProgramId: String(t.idInPlan)`). It is wrong for a placement COROS
   * authored. In the recorded wire capture `docs/reports/coros-inspect-2026-08-02.json`
   * the programs carry `idInPlan` ∈ {1,2,3,15,21,23,24,45}; every ENTITY's
   * `idInPlan` appears in that set, while `planProgramId` values 43 and 16 match
   * no program at all:
   *
   *     entity idInPlan=45 planProgramId=43 → by idInPlan: P10679, by planProgramId: nothing
   *     entity idInPlan=23 planProgramId=16 → by idInPlan: P10667, by planProgramId: nothing
   *
   * `providers/coros/normalize.ts` had it right all along, keying imports on
   * `idInPlan`. The disagreement was invisible until an import-proven rewrite
   * asked both sides about one placement and got two different programs — the
   * athlete's 2026-08-22 session resolved to program …148 for the importer and
   * …159 here, so the content proof could never match and the write refused as
   * `stamp_mismatch` while blaming the athlete for editing in COROS.
   *
   * `planProgramId` remains the third element of the DELETE TRIPLE — that is
   * addressing, not linking, and is untouched. It stays here only as a fallback
   * for a placement no program claims by `idInPlan`, so nothing that resolves
   * today stops resolving.
   */
  const byIdInPlan = view.programs.filter((p) => String(p.idInPlan) === String(entity.idInPlan));
  if (byIdInPlan.length > 0) return byIdInPlan;
  const fallback = String(entity.planProgramId ?? entity.idInPlan);
  return view.programs.filter((p) => String(p.idInPlan) === fallback);
}

/**
 * `idInPlan` identifies the PROGRAM-IN-PLAN within ONE plan, not the entity:
 * several entities of the same plan may reference one program and so share an
 * `idInPlan`. Returns the first placement, which is sound only for callers
 * that claim an id unused *in their target plan*.
 */
export function locate(view: PlanView, idInPlan: string | number): Located | undefined {
  const entity = view.entities.find((e) => String(e.idInPlan) === String(idInPlan));
  if (!entity) return undefined;
  return {
    entity,
    program: programsFor(view, entity)[0],
    date: corosDayToLocalDate(entity.happenDay),
  };
}

// ── Ownership by stamp (INVARIANT 3) ────────────────────────────────────────

/** Does this program name identify a program the caller wrote? */
export type StampPredicate = (name: unknown) => boolean;

/**
 * "IS THIS PLACEMENT THE ONE I MEAN?" — the general form of the question the
 * stamp answers.
 *
 * The stamp answers it by AUTHORSHIP: only this app emits that exact program
 * name, so a program carrying it is one we wrote. That is the only proof
 * available for a workout we created, and it stays the proof for those.
 *
 * It is not the only honest answer to the question, though, and assuming it was
 * is what made `enqueueContentConvergence` refuse `no_recorded_stamp` for the
 * majority of the athlete's plan — the sessions COROS authored and the coach
 * eased (see `content-executor.ts`, THE SECOND PROOF). A caller that recorded
 * what it SAW at an address can answer the same question by re-reading it. So
 * the two ownership functions below take a predicate over the placement rather
 * than over its name, and `stampedPlacements`/`stampAmbiguities` become the
 * name-shaped case of it. Every existing caller is unchanged, deliberately:
 * nothing about the stamp discipline is relaxed by giving it a sibling.
 */
export type PlacementPredicate = (program: RawCorosProgram, entity: RawCorosEntity) => boolean;

/**
 * Every placement in this plan the caller can prove is theirs.
 *
 * A link key must resolve UNANIMOUSLY. If a matching and a non-matching program
 * share it, the entity's real workout is genuinely ambiguous — claiming it
 * would let a delete take a workout we did not create — so nothing is claimed
 * and `ownershipAmbiguities` reports the situation instead of hiding it.
 */
export function ownedPlacements(view: PlanView, isOurs: PlacementPredicate): Located[] {
  const found: Located[] = [];
  for (const entity of view.entities) {
    const programs = programsFor(view, entity);
    if (programs.length === 0 || !programs.every((p) => isOurs(p, entity))) continue;
    found.push({ entity, program: programs[0], date: corosDayToLocalDate(entity.happenDay) });
  }
  return found;
}

/**
 * Entities whose link key resolves to BOTH ours and not-ours. Never actioned;
 * always reported, because such an entity may be residue of ours that cannot be
 * safely removed.
 */
export function ownershipAmbiguities(view: PlanView, isOurs: PlacementPredicate): Located[] {
  const out: Located[] = [];
  for (const entity of view.entities) {
    const programs = programsFor(view, entity);
    if (programs.length < 2) continue;
    if (!programs.some((p) => isOurs(p, entity))) continue;
    if (!programs.some((p) => !isOurs(p, entity))) continue;
    out.push({ entity, program: programs[0], date: corosDayToLocalDate(entity.happenDay) });
  }
  return out;
}

/** Every placement in this plan whose program carries the caller's stamp. */
export function stampedPlacements(view: PlanView, isStamped: StampPredicate): Located[] {
  return ownedPlacements(view, (p) => isStamped(p.name));
}

/** Entities whose link key resolves to BOTH stamped and unstamped programs. */
export function stampAmbiguities(view: PlanView, isStamped: StampPredicate): Located[] {
  return ownershipAmbiguities(view, (p) => isStamped(p.name));
}

/** Everything in this plan the caller did NOT stamp — never touchable. */
export function unstampedPlacements(view: PlanView, isStamped: StampPredicate): Located[] {
  const stamped = new Set(stampedPlacements(view, isStamped).map((f) => f.entity));
  return view.entities
    .filter((e) => !stamped.has(e))
    .map((entity) => ({
      entity,
      program: programsFor(view, entity).find((p) => !isStamped(p.name)),
      date: corosDayToLocalDate(entity.happenDay),
    }));
}

/** The name carried by this placement's program — the stamp, when it is ours. */
export function stampOf(found: Located): string {
  return String(found.program?.name ?? "");
}

/**
 * A delete is addressed by (planId, idInPlan, planProgramId) — NOT by date and
 * NOT by stamp. So if ANY other entity of the same plan shares that address,
 * the server cannot tell it from ours and the delete must not be sent.
 *
 * Deliberately stamp-independent: checking only *unstamped* neighbours would
 * miss an entity that classification got wrong, and the whole point of this
 * guard is to be the last line when classification is wrong.
 */
export function writeAddressClash(
  view: PlanView,
  target: Located,
  isOurs: PlacementPredicate,
): Located | undefined {
  const key = (entity: RawCorosEntity): string =>
    [String(entity.idInPlan), String(entity.planProgramId ?? entity.idInPlan)].join("|");
  const targetKey = key(target.entity);
  const other = view.entities.find((e) => e !== target.entity && key(e) === targetKey);
  if (!other) return undefined;
  return {
    entity: other,
    program: programsFor(view, other).find((p) => !isOurs(p, other)),
    date: corosDayToLocalDate(other.happenDay),
  };
}

/** `writeAddressClash` for a caller that proves ownership by stamp. */
export function deleteWouldBeAmbiguous(
  view: PlanView,
  target: Located,
  isStamped: StampPredicate,
): Located | undefined {
  return writeAddressClash(view, target, (p) => isStamped(p.name));
}

/**
 * Identifier-only description of a workout that is NOT ours. Reports are
 * committed to the repo, so a foreign title must never reach one.
 */
export function describeForeignForReport(found: Located): string {
  return `idInPlan ${String(found.entity.idInPlan)} date=${found.date} (foreign workout — title printed to console)`;
}

/** Console only: on the user's own terminal the title is what identifies it. */
export function describeForeignForConsole(found: Located): string {
  const name = String(found.entity.name ?? found.program?.name ?? "(unnamed)");
  return `name="${name}" date=${found.date}`;
}

/**
 * Describe a workout that is NOT ours for a log line. The console form carries
 * the user's real workout title, so it is emitted only when the caller has
 * explicitly asked for it (`verbose`); otherwise the identifier-only form goes
 * out, exactly as it would into a committed report.
 */
function describeForLog(found: Located, verbose: boolean): string {
  return verbose ? describeForeignForConsole(found) : describeForeignForReport(found);
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : "unknown failure";
}

// ── idInPlan derivation (INVARIANT 2) ───────────────────────────────────────

/**
 * How far either side of today the derivation read sweeps. A live plan was
 * observed reporting `maxIdInPlan: 0` while its entities carried ids up to 45,
 * so the counter cannot be trusted and the real maximum has to be observed
 * directly — across the plan's whole likely span.
 */
const OBSERVE_BACK_DAYS = 180;
const OBSERVE_FORWARD_DAYS = 240;
/** /training/schedule/query rejects spans over 90 days (5011). */
const OBSERVE_CHUNK_DAYS = 90;

/** Disjoint ≤90-day windows covering today-180 … today+240. */
export function observationWindows(today: string): Array<[string, string]> {
  const windows: Array<[string, string]> = [];
  for (
    let offset = -OBSERVE_BACK_DAYS;
    offset <= OBSERVE_FORWARD_DAYS;
    offset += OBSERVE_CHUNK_DAYS + 1
  ) {
    const endOffset = Math.min(offset + OBSERVE_CHUNK_DAYS, OBSERVE_FORWARD_DAYS);
    windows.push([addDays(today, offset), addDays(today, endOffset)]);
  }
  return windows;
}

/** First and last day the observation sweep can see. */
export function observationSpan(today: string): { start: string; end: string } {
  const windows = observationWindows(today);
  return {
    start: windows[0]?.[0] ?? today,
    end: windows[windows.length - 1]?.[1] ?? today,
  };
}

export interface IdInPlanObservation {
  /** `maxIdInPlan` as reported by the server (highest seen across windows). */
  counter: number;
  /** Highest idInPlan actually carried by an entity. The reliable number. */
  observedMax: number;
  /** Distinct observed ids, sorted numerically. */
  observedIds: string[];
  /** Ids carried by more than one entity — legal, see locate(). */
  duplicates: string[];
  entityCount: number;
  windowStart: string;
  windowEnd: string;
}

/** How far a window sits from `today`; 0 when it contains it. */
function windowDistance(today: string, start: string, end: string): number {
  if (start <= today && today <= end) return 0;
  return Math.min(Math.abs(daysBetween(today, start)), Math.abs(daysBetween(today, end)));
}

/**
 * One merged view of the plan across the whole observation span. Required for
 * anything that reasons about deletion: a `status: 3` delete is **plan-wide**,
 * not window-scoped, so a colliding workout 200 days away is just as
 * destroyable as one next week — and invisible to a ±30 day read.
 *
 * PLAN IDENTITY IS TAKEN FROM THE WINDOW NEAREST TODAY, not from the first
 * (oldest) one. The sweep starts 180 days back, and a window that far out can
 * still name a plan the account has since replaced — while `id` is what every
 * guard in this module scopes to. Taking the stale one would scope the guards
 * to one plan while the write lands in another, which is exactly the divergence
 * `createWorkout` now refuses on. `name`/`startDay` come from the same window,
 * so the three describe one consistent plan.
 */
export async function readFullSpan(
  client: CorosClient,
  today: string,
): Promise<RawCorosSchedule> {
  const merged: RawCorosSchedule = { entities: [], programs: [] };
  const seenPrograms = new Set<string>();
  let nearestIdDistance = Number.POSITIVE_INFINITY;
  for (const [start, end] of observationWindows(today)) {
    const raw = await client.getRawSchedule(start, end);
    const distance = windowDistance(today, start, end);
    if (raw.id != null && String(raw.id) !== "" && distance < nearestIdDistance) {
      nearestIdDistance = distance;
      merged.id = raw.id;
      merged.name = raw.name;
      merged.startDay = raw.startDay;
    }
    merged.maxIdInPlan = Math.max(
      Number(merged.maxIdInPlan ?? 0),
      Number(raw.maxIdInPlan ?? 0) || 0,
    );
    // Windows are disjoint, so entities never repeat. Programs can, when two
    // entities in different windows share an idInPlan.
    merged.entities?.push(...(raw.entities ?? []));
    for (const program of raw.programs ?? []) {
      const key = `${String(program.id ?? "")}|${String(program.idInPlan)}|${String(program.name ?? "")}`;
      if (seenPrograms.has(key)) continue;
      seenPrograms.add(key);
      merged.programs?.push(program);
    }
  }
  return merged;
}

/**
 * Both the server's counter and the true maximum in use IN THIS PLAN, read off
 * a span already fetched by `readFullSpan` (no further requests).
 */
export function observationFromSpan(
  span: RawCorosSchedule,
  planId: string,
  today: string,
): IdInPlanObservation {
  // TARGET PLAN ONLY: another plan's ids say nothing about which id is free in
  // ours, and treating them as occupied is what blocked the first live run.
  const seen = planView(span, planId).entities.map((e) => String(e.idInPlan));
  const counts = new Map<string, number>();
  for (const id of seen) counts.set(id, (counts.get(id) ?? 0) + 1);
  const { start, end } = observationSpan(today);
  return {
    counter: Number(span.maxIdInPlan ?? 0) || 0,
    observedMax: seen.reduce((max, id) => Math.max(max, Number(id) || 0), 0),
    observedIds: [...counts.keys()].sort((a, b) => Number(a) - Number(b)),
    duplicates: [...counts.entries()]
      .filter(([, n]) => n > 1)
      .map(([id]) => id)
      .sort((a, b) => Number(a) - Number(b)),
    entityCount: seen.length,
    windowStart: start,
    windowEnd: end,
  };
}

/**
 * Sweep the target plan's likely span and report both the server's counter and
 * the true maximum in use IN THAT PLAN. The next safe id is
 * `max(counter, observedMax) + 1`.
 */
export async function observeIdInPlan(
  client: CorosClient,
  today: string,
  planId: string,
): Promise<IdInPlanObservation> {
  return observationFromSpan(await readFullSpan(client, today), planId, today);
}

/** The next id it is safe to claim: past the counter AND past reality. */
export function nextIdInPlan(observation: IdInPlanObservation): number {
  return Math.max(observation.counter, observation.observedMax) + 1;
}

/** A derived id plus the fresh read that judged whether it is really free. */
export interface SlotClaim {
  idInPlan: number;
  observation: IdInPlanObservation;
  /** The plan the fresh read names (falls back to the caller's planId). */
  planId: string;
  /** The fresh read, plan-scoped — reusable by the caller. */
  view: PlanView;
  raw: RawCorosSchedule;
  /**
   * Set means the claim is TAKEN. The derivation already excluded every id it
   * saw, so an occupant here is a genuine race: do not write, do not delete.
   */
  occupant?: Located;
}

/**
 * Derive the next free id and gate it on a FRESH read: read-then-write is racy
 * (§4.4 point 3), and the server's counter may simply not be maintained, so
 * both the sweep and the final occupancy check happen immediately before the
 * write rather than once at start-up.
 */
export async function claimNextIdInPlan(
  client: CorosClient,
  today: string,
  targetPlanId: string,
  readWindow: () => Promise<RawCorosSchedule>,
  fallbackPlanId: string,
): Promise<SlotClaim> {
  const observation = await observeIdInPlan(client, today, targetPlanId);
  const idInPlan = nextIdInPlan(observation);
  const raw = await readWindow();
  const view = planView(raw, targetPlanId);
  return {
    idInPlan,
    observation,
    planId: String(raw.id ?? fallbackPlanId),
    view,
    raw,
    occupant: locate(view, idInPlan),
  };
}

// ── Guarded delete (INVARIANTS 4 + 5) ───────────────────────────────────────

export interface GuardedDeleteOutcome {
  /** True when a `status: 3` delete was actually issued. */
  sent: boolean;
  /** Set when the delete was refused: the entity sharing the delete address. */
  clash?: Located;
  /** COROS envelope result code, when one was sent. */
  code?: string;
}

/**
 * The ONE place a delete is ever issued. Given a PLAN-WIDE snapshot and a
 * placement already proven ours, it re-checks that the delete address
 * (planId, idInPlan, planProgramId) is not shared, then removes the placement
 * by ITS OWN server-assigned ids — never by a remembered id.
 *
 * The snapshot must span the whole plan, not a window: a `status: 3` delete is
 * plan-wide, so a colliding workout 200 days out is just as destroyable as one
 * next week — and invisible to a ±30 day read.
 */
export async function issueGuardedDelete(
  client: CorosClient,
  span: PlanView,
  target: Located,
  isStamped: StampPredicate,
  fallbackPlanId: string,
): Promise<GuardedDeleteOutcome> {
  const clash = deleteWouldBeAmbiguous(span, target, isStamped);
  if (clash) return { sent: false, clash };
  const del = await client.removeScheduleEntity(
    target.entity.idInPlan,
    String(target.entity.planProgramId ?? target.entity.idInPlan),
    String(target.entity.planId ?? fallbackPlanId),
  );
  return { sent: true, code: del.result };
}

// ── Product entry points ────────────────────────────────────────────────────

/** Days either side of the target date the pre/post-write reads cover. */
const WRITE_WINDOW_PAD_DAYS = 3;

function isoOf(happenDay: string): string {
  return corosDayToLocalDate(Number(happenDay));
}

/**
 * Create one workout in the account's own container plan and prove it landed.
 *
 * Sequence — every step is one of the five invariants:
 *   1. plan-wide sweep → target plan id + `max(counter, observed) + 1`;
 *   2. fresh read around the target day → final occupancy gate (a race here
 *      means someone else took the slot: refuse, write nothing);
 *   3. build the program (catalog-validated) and calculate-then-add;
 *   4. `status: 1` create;
 *   5. read-after-write, recovering BY STAMP — never by the claimed id, which
 *      a live account was observed reassigning;
 *   6. return the server's own ids, which are what a later delete addresses.
 *
 * Never throws: every failure is a `CreateResult` the caller can record.
 */
export async function createWorkout(
  client: CorosClient,
  spec: CreateWorkoutSpec,
  opts: CreateWorkoutOptions,
): Promise<CreateResult> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const log = opts.log ?? ((): void => undefined);
  const verbose = opts.verbose === true;
  const date = isoOf(spec.happenDay);
  const isOurs: StampPredicate = (name) => name === spec.name;

  // The id derivation can only exclude ids it can SEE. A day outside the sweep
  // would be written with a blindly-derived id: refuse instead.
  const span = observationSpan(today);
  if (date < span.start || date > span.end) {
    return {
      ok: false,
      reason: "out_of_span",
      error: `happenDay ${date} is outside the observed span ${span.start}…${span.end}; refusing to derive an id blindly`,
    };
  }

  // Catalog validation and program construction happen BEFORE any wire call,
  // so a bad originId can never reach the account. `buildProgramFor` is the
  // shared dispatch: a run session builds the spike-verified minimal run
  // topology, a lift OR MOBILITY session builds the structured strength
  // topology; everything downstream (id derivation, write, verify) is
  // program-agnostic, and the content-update path builds through the very
  // same function so the two can never write different programs.
  let program: RawCorosProgram;
  // Run creates only: how much of the prescription is going to the watch as a
  // bare timer. Computed BEFORE the write so it is reported whatever happens.
  let paceTargetsOwed = 0;
  try {
    program = buildProgramFor(spec, opts.catalog);
    if (isRunSession(spec.session)) {
      const session = spec.session as CoachSession;
      paceTargetsOwed = missingPaceTargets(session, spec.thresholdPaceSecPerKm);
      if (paceTargetsOwed > 0) {
        // NOT silent any more (audit 2026-08-17 #6). All three sessions the
        // coach has pushed live carry `intensityType: 5` on every block
        // because the job payload's threshold was null — while the athlete's
        // 289 s/km had existed since that same day. The executor cannot fix
        // that (it has no database); it can refuse to hide it.
        log(
          `  no pace band for ${paceTargetsOwed}/${session.run?.blocks.length ?? 0} block(s)` +
            ` — they push as bare timers (threshold=${spec.thresholdPaceSecPerKm ?? "none"})`,
        );
      }
    }
  } catch (e) {
    return { ok: false, reason: "error", error: errText(e) };
  }
  /** Every return past this point carries the pace debt, success or not. */
  const owed = paceTargetsOwed > 0 ? { paceTargetsOwed } : {};

  const windowStart = addDays(date, -WRITE_WINDOW_PAD_DAYS);
  const windowEnd = addDays(date, WRITE_WINDOW_PAD_DAYS);
  const readWindow = (): Promise<RawCorosSchedule> => client.getRawSchedule(windowStart, windowEnd);

  try {
    // 1. Which plan are we allowed to touch at all?
    const fullSpan = await readFullSpan(client, today);
    const targetPlanId = opts.planId ?? String(fullSpan.id ?? "");
    if (targetPlanId === "") {
      return {
        ok: false,
        reason: "no_target_plan",
        error: "no active plan id in the schedule read — cannot scope safely, refusing to write",
      };
    }

    // STAMP UNIQUENESS. The stamp is what makes ownership decidable, so a plan
    // must never hold two workouts carrying the same one — that is checked
    // plan-wide, not just on the requested day.
    //   - already on the requested day → idempotent success (a retried push,
    //     or a create whose response was lost, must not duplicate anything);
    //   - the same stamp on ANOTHER day → the user moved it in COROS. Creating
    //     a second one would make both undeletable. Refuse and report.
    const sameStamp = stampedPlacements(planView(fullSpan, targetPlanId), isOurs);
    const existing = sameStamp.find((f) => f.date === date) ?? sameStamp[0];
    if (existing) {
      const ids = {
        serverIdInPlan: String(existing.entity.idInPlan),
        serverProgramId: String(existing.entity.planProgramId ?? existing.entity.idInPlan),
        serverEntityId: existing.entity.id != null ? String(existing.entity.id) : undefined,
        serverPlanId: String(existing.entity.planId ?? targetPlanId),
        serverHappenDay: existing.date,
      };
      if (existing.date === date) {
        log(`  "${spec.name}" is already on ${date} (idInPlan ${ids.serverIdInPlan})`);
        return { ok: true, reason: "already_present", ...ids, ...owed };
      }
      // NO ids on the cross-day refusal. `serverIdInPlan`/`serverProgramId`
      // mean "the workout THIS call put on THIS day" — the contract that makes
      // them safe to hand straight to `deleteWorkout`. Returning the ids of a
      // workout sitting on a different day would invite a delete addressed at
      // the wrong date. The reason is enough for Task 3 to surface the drift;
      // resolving it needs a fresh read, not a stale id.
      //
      // `serverHappenDay` IS returned, because it is the one thing that makes
      // the refusal actionable: without it the caller knows only that the
      // stamp is somewhere else, and cannot address the somewhere.
      return {
        ok: false,
        reason: "already_present",
        serverHappenDay: existing.date,
        error:
          `a workout named "${spec.name}" already exists in plan ${targetPlanId} on` +
          ` ${existing.date}, not ${date} — it was moved in COROS; refusing to create a` +
          " second workout under the same stamp",
      };
    }

    // 2. Derive + final occupancy gate, both against fresh reads.
    const observation = observationFromSpan(fullSpan, targetPlanId, today);
    const idInPlan = nextIdInPlan(observation);
    const freshRaw = await readWindow();

    // THE WRITE PLAN *IS* THE GUARDED PLAN. Everything above — derivation,
    // stamp uniqueness, and the occupancy gate below — is scoped to
    // targetPlanId, so writing anywhere else would put the workout outside
    // every guard that just cleared it: the read-after-write could not see it,
    // no ids would come back, and a retry would duplicate without bound.
    // A fresh read naming a different plan means the account's active plan
    // moved under us (or the caller asserted a plan the server disagrees
    // with): that is unresolvable here, so nothing is written.
    const freshPlanId = String(freshRaw.id ?? targetPlanId);
    if (freshPlanId !== targetPlanId) {
      return {
        ok: false,
        reason: "no_target_plan",
        error: `plan identity changed mid-create (${targetPlanId} → ${freshPlanId}); refusing`,
      };
    }
    const planId = targetPlanId;
    const fresh = planView(freshRaw, targetPlanId);
    log(
      `  idInPlan: counter=${observation.counter} observed=${observation.observedMax}` +
        ` → claiming ${idInPlan}`,
    );
    const occupant = locate(fresh, idInPlan);
    if (occupant) {
      log(`  slot already occupied by ${describeForLog(occupant, verbose)}`);
      return {
        ok: false,
        reason: "slot_occupied",
        error:
          `idInPlan ${idInPlan} (derived from counter=${observation.counter},` +
          ` observed=${observation.observedMax}) is already occupied:` +
          ` ${describeForeignForReport(occupant)} — no write attempted`,
      };
    }

    // 3. Calculate-then-add: the web app's documented two-step (§(d)).
    program = { ...program, idInPlan, planId };
    try {
      program = applyCalculated(program, await client.calculateProgramMetrics(program));
    } catch (e) {
      log(`  program/calculate failed (${errText(e)}) — proceeding without estimates`);
    }
    // Taken HERE, off the exact object about to be written: after calculate,
    // before the write. See `CreateResult.wireFingerprint`.
    const wireFingerprint = corosProgramFingerprint(program);
    const planStartDay = freshRaw.startDay != null ? Number(freshRaw.startDay) : undefined;
    const entity = buildEntity({
      idInPlan,
      planId,
      date,
      planStartDay,
      // The entity's sport must match its program — a run program wrapped in
      // a strength-typed entity lands mistyped on the real calendar (audit#2
      // finding 5; the deleted spike's TEST B passed sportType 1 here).
      sportType: program.sportType ?? 4,
      name: spec.name,
    });

    // 4. The write.
    let code: string | undefined;
    let threw: string | undefined;
    try {
      const add = await client.addScheduleEntity(entity, program, idInPlan, planId);
      code = add.result;
      log(`  status:1 create at ${date} → result=${add.result}`);
    } catch (e) {
      // Network failure mid-write: state unknown. The read below decides.
      threw = errText(e);
      log(`  status:1 create threw (${threw}) — reading back`);
    }

    // 5. RECOVERY BY STAMP, never by the claimed id — a live account was
    //    observed storing a create under an id it picked itself.
    const afterRaw = await readWindow();
    let found = stampedPlacements(planView(afterRaw, targetPlanId), isOurs).find(
      (f) => f.date === date,
    );
    let elsewhere: Located | undefined;
    if (!found) {
      // Widen the search before concluding "nothing materialized": a workout
      // the server filed on another day would otherwise be a LEAK — stamped,
      // ours, and unknown to the caller that has to remove it.
      const wideSpan = planView(await readFullSpan(client, today), targetPlanId);
      const wide = stampedPlacements(wideSpan, isOurs);
      found = wide.find((f) => f.date === date);
      elsewhere = wide[0];
    }
    const recovered = found ?? elsewhere;
    const ids = recovered
      ? {
          serverIdInPlan: String(recovered.entity.idInPlan),
          serverProgramId: String(recovered.entity.planProgramId ?? recovered.entity.idInPlan),
          serverEntityId: recovered.entity.id != null ? String(recovered.entity.id) : undefined,
          serverPlanId: String(recovered.entity.planId ?? afterRaw.id ?? planId),
          // Where it ACTUALLY is. Equal to the requested day on the happy
          // path; on `wrong_date` it is the only address a later delete can
          // use. Recorded structurally so no caller has to parse `error`.
          serverHappenDay: recovered.date,
        }
      : {};

    if (code !== "0000") {
      // Rejected (or threw). Ids, when present, matter: something materialized
      // and the caller must be able to remove it.
      return {
        ok: false,
        code,
        reason: threw !== undefined ? "error" : "rejected",
        error:
          threw ??
          `server rejected the create (result ${code ?? "-"}) for idInPlan ${idInPlan};` +
            " not retrying with other ids — the server may allocate ids itself",
        ...ids,
        ...owed,
      };
    }
    if (found) return { ok: true, code, ...ids, ...owed, wireFingerprint };
    if (elsewhere) {
      return {
        ok: false,
        code,
        reason: "wrong_date",
        error: `the create landed on ${elsewhere.date}, not the requested ${date}`,
        ...ids,
        ...owed,
        wireFingerprint,
      };
    }
    return {
      ok: false,
      code,
      reason: "not_visible",
      error: "create returned 0000 but nothing carrying the stamp materialized",
    };
  } catch (e) {
    return { ok: false, reason: "error", error: errText(e) };
  }
}

/**
 * Remove a workout the caller previously created — and nothing else.
 *
 * Ownership is RE-PROVEN from a fresh plan-wide read immediately before the
 * delete: the recorded ids are treated as claims, the program-name stamp is
 * the only authorization, and every "can't tell" outcome is a refusal.
 * After the delete a second plan-wide read asserts both that our workout is
 * gone AND that the count of workouts we did not create is unchanged.
 *
 * Never throws.
 */
export async function deleteWorkout(
  client: CorosClient,
  target: DeleteWorkoutTarget,
  opts: DeleteWorkoutOptions = {},
): Promise<DeleteResult> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const log = opts.log ?? ((): void => undefined);
  const verbose = opts.verbose === true;
  const date = isoOf(target.happenDay);
  const isOurs: StampPredicate = (name) => name === target.name;

  if (target.planId === "") {
    return { ok: false, error: "no target plan id — refusing to delete without a plan scope" };
  }
  const span = observationSpan(today);
  if (date < span.start || date > span.end) {
    return {
      ok: false,
      error: `happenDay ${date} is outside the observed span ${span.start}…${span.end}; refusing to delete on a partial view`,
    };
  }

  try {
    const before = planView(await readFullSpan(client, today), target.planId);

    // A link key resolving to both our program and one we did not write means
    // the entity's real workout is unknowable. Never actioned.
    if (stampAmbiguities(before, isOurs).some((a) => a.date === date)) {
      return {
        ok: false,
        refused: "ambiguous",
        error:
          `idInPlan ${target.idInPlan} on ${date} resolves to both this workout's program and one` +
          " it did not create — not actioned; remove it by hand in the COROS app",
      };
    }

    const matches = stampedPlacements(before, isOurs).filter((f) => f.date === date);
    if (matches.length === 0) {
      // Drift vs. already-gone: is the recorded address occupied by something?
      const atAddress = before.entities.find(
        (e) =>
          String(e.idInPlan) === target.idInPlan &&
          String(e.planProgramId ?? e.idInPlan) === target.programId,
      );
      if (atAddress) {
        return {
          ok: false,
          refused: "stamp_mismatch",
          error:
            `idInPlan ${target.idInPlan} in plan ${target.planId} no longer carries the recorded` +
            ` stamp on ${date} — it was edited, renamed or moved in COROS; refusing to delete it`,
        };
      }
      return { ok: false, refused: "not_found" };
    }

    const foreignBefore = unstampedPlacements(before, isOurs).length;
    let code: string | undefined;
    for (const found of matches) {
      const outcome = await issueGuardedDelete(client, before, found, isOurs, target.planId);
      if (!outcome.sent) {
        log(
          `  !! delete address idInPlan=${String(found.entity.idInPlan)} is shared with` +
            ` ${outcome.clash ? describeForLog(outcome.clash, verbose) : "another workout"}` +
            " — NOT deleted",
        );
        return {
          ok: false,
          refused: "ambiguous",
          error:
            "NOT deleted — its delete address (planId/idInPlan/planProgramId) is shared with" +
            ` ${outcome.clash ? describeForeignForReport(outcome.clash) : "another workout"};` +
            " remove it by hand in the COROS app",
        };
      }
      code = outcome.code;
    }

    // Verify plan-wide: ours gone, and nothing else taken with it.
    const after = planView(await readFullSpan(client, today), target.planId);
    const foreignAfter = unstampedPlacements(after, isOurs).length;
    if (foreignAfter < foreignBefore) {
      return {
        ok: false,
        code,
        error:
          `DELETE REMOVED ${foreignBefore - foreignAfter} WORKOUT(S) THIS EXECUTOR DID NOT CREATE` +
          " — check the COROS calendar",
      };
    }
    const still = stampedPlacements(after, isOurs).filter((f) => f.date === date);
    if (still.length > 0) {
      return {
        ok: false,
        code,
        error: `delete returned ${code ?? "-"} but the workout is still on ${date}`,
      };
    }
    return { ok: true, code };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}
