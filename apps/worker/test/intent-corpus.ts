/**
 * INTENT CONSERVATION — the corpus, the canonical shape, and the loss ledger.
 *
 * WHY THIS FILE EXISTS
 *
 * The coach's vocabulary grew a feature at a time — timed holds, per-side work,
 * eccentric tempo, circuit rounds, multi-date adds, a mobility discipline — and
 * each addition was verified against the one scenario that motivated it. Three
 * audits then found twenty-five places where the intent narrows on its way to
 * the athlete's watch, several of them inside features that had shipped
 * "verified" days earlier. One of them was DEAD CODE: an executor branch for
 * timed holds that could never run, because an upstream strict schema rejected
 * the key before it got there.
 *
 * All of those share one cause, and it is structural rather than careless:
 *
 *   NOTHING IN THE CHAIN EVER COMPARED WHAT CAME OUT AGAINST WHAT WENT IN.
 *
 * This file is the missing comparison. It declares one corpus of sessions, one
 * CANONICAL projection every stage of the pipeline reduces to, and one LEDGER
 * of named, declared losses. The suites around it push the corpus through the
 * real mutating ops (`intent-conservation.test.ts`), the real wire
 * (`intent-wire.test.ts`) and the five readers that describe a stored session
 * back to a human (`intent-cross-surface.test.ts`), and assert that
 * canonical(out) equals canonical(in) with only the declared losses applied.
 *
 * THE LEDGER IS THE PRODUCT. A green run does not mean "nothing is lost"; it
 * means "exactly the losses named in {@link LOSSES} happen, and no others".
 * Read the ledger, not the pass count.
 *
 * HOW IT FAILS WHEN SOMEONE ADDS A FIELD AND FORGETS THE WIRE
 *
 *  1. `keyof CoachExercise` grows, so `EXERCISE_FIELDS` below no longer covers
 *     it and this file DOES NOT COMPILE.
 *  2. Covering it there forces a fixture that carries it — the table generates
 *     one session per field from the spellings declared beside it, and a
 *     separate test asserts every field is exercised with a non-default value.
 *  3. If the canonical projection carries the field, the wire round trip now
 *     differs in it, `toEqual` fails, and the diff names the field.
 *  4. Declaring the difference costs a named entry in {@link LOSSES} — a
 *     sentence saying what is lost and why, which someone has to write and
 *     someone else can disagree with in review.
 *
 * That is the whole design: a new field cannot reach the athlete silently,
 * because silence is a compile error.
 */

import { asc, eq } from "drizzle-orm";
import { plannedWorkoutStages, plannedWorkouts } from "@rg/database";
import {
  coachExerciseSchema,
  coachSessionSchema,
  paceBandFor,
  sessionSport,
  type CoachExercise,
  type CoachRunBlock,
  type CoachSession,
} from "@rg/domain";
import { runBlockRoles } from "@rg/coros";
import type { SourcePlannedWorkout } from "@rg/providers";
import type { Db } from "../src/services/db.js";

/**
 * The athlete's real COROS lactate-threshold pace (prod: 289 s/km since
 * 2026-08-13). Every leg of the instrument is handed the SAME number, so a pace
 * band that differs between the app and the watch is a real divergence rather
 * than a difference of inputs.
 */
export const THRESHOLD_SEC_PER_KM = 289;

/** The two entries the mock COROS server's sportType=4 catalog returns. */
export const SQUAT_ORIGIN_ID = "425898928110747648";
export const BENCH_ORIGIN_ID = "426109589008859137";

// ── The canonical shape ─────────────────────────────────────────────────────

/**
 * What a step IS. Deliberately the stage vocabulary (`PlannedStage["kind"]`
 * minus `repeat`, which is structure rather than a step) so the app's stored
 * rows and the wire's read-back can be compared without a translation table
 * that could itself be wrong.
 */
export type StepRole = "warmup" | "work" | "recovery" | "cooldown" | "rest" | "open";

/**
 * HOW a step is measured. `unread` is not something anything writes: it is what
 * a rep count becomes after the round trip, because `normalize.ts` maps
 * `targetType: 3` to `durationType: "none"` and keeps no value. Naming it
 * rather than folding it into `open` is the point — the two are different
 * failures ("no target was prescribed" vs "a target was prescribed and the
 * reader threw it away").
 */
export type StepMeasure = "time" | "distance" | "reps" | "open" | "unread";

export interface CanonicalStep {
  role: StepRole;
  measure: StepMeasure;
  /** Seconds, metres, or reps — whichever `measure` says. */
  target: number | null;
  /** Repeats of THIS step (straight sets). Null for a run block. */
  sets: number | null;
  /** 2 when the prescription happens on each leg/arm. */
  sides: 1 | 2;
  tempoSeconds: number | null;
  loadKg: number | null;
  restSeconds: number | null;
  note: string | null;
  /** [fast, slow] seconds per km. */
  paceBand: readonly [number, number] | null;
}

export interface Canonical {
  discipline: "run" | "strength" | "yoga";
  title: string;
  minutes: number;
  /** Circuit rounds — the whole step list, repeated. Null for straight sets. */
  rounds: number | null;
  steps: CanonicalStep[];
}

const BARE_STEP: Omit<CanonicalStep, "role" | "measure" | "target"> = {
  sets: null,
  sides: 1,
  tempoSeconds: null,
  loadKg: null,
  restSeconds: null,
  note: null,
  paceBand: null,
};

function bandOf(
  intensity: CoachRunBlock["intensity"],
  threshold: number | undefined,
): readonly [number, number] | null {
  const band = paceBandFor(intensity, threshold);
  return band ? ([band.fastSecPerKm, band.slowSecPerKm] as const) : null;
}

/** One exercise as a canonical step — the projection BOTH the intent and the
 * stored `structured_json` go through, so a column that claims to round-trip
 * the exercise object verbatim proves it here rather than by inspection. */
function stepOfExercise(e: CoachExercise): CanonicalStep {
  return {
    ...BARE_STEP,
    role: "work",
    measure: e.holdSeconds != null ? "time" : e.reps != null ? "reps" : "open",
    target: e.holdSeconds ?? e.reps ?? null,
    sets: e.sets,
    sides: e.perSide ? 2 : 1,
    tempoSeconds: e.eccentricSeconds ?? null,
    loadKg: e.weight.type === "kg" ? e.weight.value : null,
    restSeconds: e.restSeconds,
    note: e.note ?? null,
  };
}

/**
 * THE INTENT, canonically — what the coach actually said, before anything
 * touched it. Every other projection in this file is measured against this one.
 *
 * Roles come from `runBlockRoles`, the ONE derivation that decides what a run
 * block is (the coach vocabulary has no `role` field, so the role is inferred
 * and there must be exactly one inference in the codebase). Using it here means
 * the app's stored `planned_workout_stages.kind` and the wire's `exerciseType`
 * are both measured against the same answer — which is how a second, older
 * inference elsewhere becomes visible instead of merely plausible.
 */
export function canonicalOfSession(s: CoachSession, threshold?: number): Canonical {
  const body = s.lift ?? s.mobility;
  const steps: CanonicalStep[] = [];
  if (s.run) {
    const roles = runBlockRoles(s.run.blocks);
    s.run.blocks.forEach((b, i) => {
      steps.push({
        ...BARE_STEP,
        role: roles[i]!,
        measure: b.kind === "duration" ? "time" : "distance",
        target: b.kind === "duration" ? Math.round(b.value * 60) : b.value,
        paceBand: bandOf(b.intensity, threshold),
      });
    });
  } else if (body) {
    for (const e of body.exercises) steps.push(stepOfExercise(e));
  }
  return {
    discipline: sessionSport(s),
    title: s.title,
    minutes: s.durationMinutes,
    rounds: body?.rounds ?? null,
    steps,
  };
}

export type StoredRow = typeof plannedWorkouts.$inferSelect;
export type StoredStage = typeof plannedWorkoutStages.$inferSelect;

/**
 * THE STORED ROW, canonically — `planned_workouts` plus its stage rows plus
 * `structured_json`: everything the app itself will ever say about this
 * session. A run's body lives in stage rows; a lift's or a mobility session's
 * lives in `structured_json`; a rest day has neither, which is a real
 * comparable shape rather than an absence.
 */
export function canonicalOfRow(row: StoredRow, stages: StoredStage[]): Canonical {
  const steps: CanonicalStep[] = [];
  let rounds: number | null = null;
  if (stages.length > 0) {
    for (const st of [...stages].sort((a, b) => a.ord - b.ord)) {
      steps.push({
        ...BARE_STEP,
        role: st.kind as StepRole,
        measure:
          st.durationType === "time" ? "time" : st.durationType === "distance" ? "distance" : "open",
        target: st.durationSeconds ?? st.distanceMeters ?? null,
        sets: st.repeatCount ?? null,
        paceBand:
          st.targetType === "pace" && st.targetLow != null && st.targetHigh != null
            ? ([st.targetLow, st.targetHigh] as const)
            : null,
      });
    }
  } else {
    const structured = row.structuredJson as { exercises?: unknown[]; rounds?: number } | null;
    rounds = structured?.rounds ?? null;
    for (const raw of structured?.exercises ?? []) {
      const parsed = coachExerciseSchema.safeParse(raw);
      // An exercise the schema cannot read back is itself a loss, so it is kept
      // as an unreadable step rather than skipped: a silently shortened step
      // list is exactly what this instrument exists to make impossible.
      steps.push(
        parsed.success
          ? stepOfExercise(parsed.data)
          : { ...BARE_STEP, role: "open", measure: "unread", target: null },
      );
    }
  }
  return {
    discipline: row.sport as Canonical["discipline"],
    title: row.title,
    minutes: (row.calendarBlockDurationSeconds ?? 0) / 60,
    rounds,
    steps,
  };
}

/** Every part of a stored session the canonical projection reads, fetched
 * together so no caller can compare one row against another row's stages. */
export async function readStored(
  db: Db,
  workoutId: string,
): Promise<{ row: StoredRow; stages: StoredStage[]; canonical: Canonical }> {
  const [row] = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, workoutId));
  if (!row) throw new Error(`no planned_workouts row ${workoutId}`);
  const stages = await db
    .select()
    .from(plannedWorkoutStages)
    .where(eq(plannedWorkoutStages.workoutId, workoutId))
    .orderBy(asc(plannedWorkoutStages.ord));
  return { row, stages, canonical: canonicalOfRow(row, stages) };
}

/**
 * THE READ-BACK, canonically — what `normalizeCorosSchedule` makes of the
 * program the executor actually put on the wire. This is the shape a later
 * COROS import would store, so it is the honest answer to "what does the watch
 * think this session is".
 *
 * A REPEAT CONTAINER IS ALWAYS READ AS STRAIGHT SETS, and the flatness is the
 * point. On the wire a circuit and straight sets are the SAME shape — one
 * `exerciseType: 0` container whose `sets` is the repeat count — so any attempt
 * to tell them apart here would be a guess dressed as a projection (a
 * one-exercise circuit and "3 sets of one movement" are byte-identical). The
 * projection therefore commits to the reading `summarizeStages` already uses,
 * and the circuit's disappearance is declared once, by name, in
 * `wire_circuit_reads_back_as_straight_sets`.
 */
export function canonicalOfReadback(w: SourcePlannedWorkout): Canonical {
  const stages = w.stages ?? [];
  const byParent = new Map<string | null, typeof stages>();
  for (const s of stages) {
    const key = s.parentStageId ?? null;
    const list = byParent.get(key) ?? [];
    list.push(s);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.order - b.order);

  const leaves: Array<{ stage: (typeof stages)[number]; sets: number | null }> = [];
  for (const s of byParent.get(null) ?? []) {
    if (s.kind === "repeat") {
      for (const child of byParent.get(s.id) ?? []) leaves.push({ stage: child, sets: s.repeatCount ?? 1 });
    } else {
      leaves.push({ stage: s, sets: null });
    }
  }

  return {
    discipline: w.sport as Canonical["discipline"],
    title: w.title,
    minutes: (w.estimatedDurationSeconds ?? 0) / 60,
    rounds: null,
    steps: leaves.map(({ stage, sets }) => ({
      ...BARE_STEP,
      role: stage.kind as StepRole,
      measure:
        stage.durationType === "time"
          ? "time"
          : stage.durationType === "distance"
            ? "distance"
            : stage.durationType === "open"
              ? "open"
              : "unread",
      target: stage.durationSeconds ?? stage.distanceMeters ?? null,
      sets,
      paceBand:
        stage.targetType === "pace" && stage.targetLow != null && stage.targetHigh != null
          ? ([stage.targetLow, stage.targetHigh] as const)
          : null,
    })),
  };
}

// ── The declared-loss ledger ────────────────────────────────────────────────

/**
 * EVERY WAY THE PIPELINE IS ALLOWED TO CHANGE THE COACH'S MEANING, named.
 *
 * A loss is written as a TRANSFORMATION on the expected canonical, given the
 * one that actually came back. That shape buys three properties at once:
 *
 *  - an UNDECLARED difference fails, because the expected value still holds the
 *    coach's own number and `toEqual` prints the field;
 *  - a DECLARED loss that no longer happens fails too, because applying its
 *    transformation changes nothing and a no-op declaration is ledger rot;
 *  - the declaration is executable prose. `wire_drops_strength_load` does not
 *    say "load is lost", it says "take whatever load came back" — a claim the
 *    round trip can contradict.
 *
 * `severity` separates the two kinds of entry. `structural` is a limit of the
 * medium: the COROS exercise object has no tempo field and never will.
 * `defect` is a bug that is live TODAY — the entry exists so the suite reports
 * it instead of hiding it, and so that the day someone fixes it the ledger rots
 * loudly and the entry is deleted.
 */
export type LossReason =
  // ── store leg: intent → applyOps → planned_workouts + stages ──────────────
  | "store_stage_role_is_positional"
  | "store_pace_band_needs_a_threshold_at_apply_time"
  // ── wire leg: intent → create executor → COROS → normalizeCorosSchedule ───
  | "wire_title_is_the_ownership_stamp"
  | "wire_minutes_are_the_servers_estimate"
  | "wire_mobility_files_as_strength"
  | "wire_drops_per_side_flag"
  | "wire_drops_eccentric_tempo"
  | "wire_drops_exercise_note"
  | "wire_drops_strength_load"
  | "wire_drops_rest_between_sets"
  | "wire_rep_count_is_not_read_back"
  | "wire_circuit_reads_back_as_straight_sets";

export interface Loss {
  severity: "structural" | "defect";
  /** One sentence: what is lost, and why it is or is not acceptable. */
  why: string;
  apply(expected: Canonical, actual: Canonical): Canonical;
}

const mapSteps = (c: Canonical, f: (s: CanonicalStep, i: number) => CanonicalStep): Canonical => ({
  ...c,
  steps: c.steps.map(f),
});

export const LOSSES: Record<LossReason, Loss> = {
  store_stage_role_is_positional: {
    severity: "defect",
    why:
      "`coach-apply.ts`'s writeStages still labels stage rows by POSITION" +
      " (`i === 0 && blocks.length >= 2 ? 'warmup' : 'work'`) — the rule" +
      " `runBlockRoles` replaced on the wire. The app's own stage list therefore" +
      " calls an opening interval a warm-up, a walk-back 'work' and a closing" +
      " easy block 'work': the same four mislabels the wire was fixed for," +
      " still live one layer up.",
    apply: (e, a) => mapSteps(e, (s, i) => ({ ...s, role: a.steps[i]?.role ?? s.role })),
  },
  store_pace_band_needs_a_threshold_at_apply_time: {
    severity: "structural",
    why:
      "Pace bands are derived from the athlete's COROS threshold, read ONCE at" +
      " apply time. With no threshold on file the stage rows store no target," +
      " permanently — nothing re-derives them when one later arrives. The WIRE" +
      " re-resolves at execution (coros-write-cloud's latestThresholdPace), so" +
      " the watch can end up better informed than the app that pushed it.",
    apply: (e) => mapSteps(e, (s) => ({ ...s, paceBand: null })),
  },

  wire_title_is_the_ownership_stamp: {
    severity: "structural",
    why:
      "The program NAME is the ownership stamp (`title — yyyy-mm-dd`) and is the" +
      " only thing authorising a later delete, so it cannot also be the" +
      " athlete's title. Import strips the stamp back off on the way in" +
      " (coros-stamp.ts), which is where the title is restored.",
    apply: (e, a) => ({ ...e, title: a.title }),
  },
  wire_minutes_are_the_servers_estimate: {
    severity: "structural",
    why:
      "The session's stated length is never written: the program's duration is" +
      " whatever COROS's own /training/program/calculate returns. The coach's" +
      " minutes survive in the app (calendar_block_duration_seconds); the watch" +
      " shows COROS's estimate of the work it was handed.",
    apply: (e, a) => ({ ...e, minutes: a.minutes }),
  },
  wire_mobility_files_as_strength: {
    severity: "structural",
    why:
      "COROS's program namespace is 1 Run / 2 Bike / 3 Swim / 4 Strength — there" +
      " is no mobility or yoga program sport, so a mobility session files under" +
      " Strength on the watch. The app keeps the honest discipline; only the" +
      " watch's own filing is coarse.",
    apply: (e) => ({ ...e, discipline: "strength" }),
  },
  wire_drops_per_side_flag: {
    severity: "structural",
    why:
      "The wire has no per-side flag. The WORK is preserved as two identical" +
      " steps (one step would prescribe half of what the coach wrote) and 'each" +
      " side' is disclosed in the step's overview — which normalize.ts does not" +
      " read, so the read-back cannot tell the pair from a duplicate.",
    apply: (e) => ({
      ...e,
      steps: e.steps.flatMap((s) =>
        s.sides === 2 ? [{ ...s, sides: 1 as const }, { ...s, sides: 1 as const }] : [s],
      ),
    }),
  },
  wire_drops_eccentric_tempo: {
    severity: "structural",
    why:
      "COROS's exercise object models sets, reps, time, distance and load, and" +
      " has NO tempo field of any kind. '4s down' is disclosed in `overview`" +
      " (and rendered by the app's own session sheet) but cannot be prescribed" +
      " mid-set, and normalize.ts drops `overview` entirely.",
    apply: (e) => mapSteps(e, (s) => ({ ...s, tempoSeconds: null })),
  },
  wire_drops_exercise_note: {
    severity: "structural",
    why:
      "A coach's cue rides in the step's `overview`, the one free-text slot a" +
      " step has. `PlannedStage` has no field for it, so it does not survive the" +
      " read-back — the note lives in the app only.",
    apply: (e) => mapSteps(e, (s) => ({ ...s, note: null })),
  },
  wire_drops_strength_load: {
    severity: "defect",
    why:
      "The load IS written (intensityType 1, kg × 1000, display unit '6') and" +
      " does reach the watch — but `normalize.ts`'s intensity switch handles" +
      " pace/HR/power and falls through to `targetType: 'none'` for weight," +
      " discarding intensityValue. Every COROS strength session the app imports" +
      " therefore arrives carrying no load at all.",
    apply: (e) => mapSteps(e, (s) => ({ ...s, loadKg: null })),
  },
  wire_drops_rest_between_sets: {
    severity: "defect",
    why:
      "Rest IS written (`restType: 1`, `restValue` in seconds) and is never read" +
      " back: `PlannedStage` has no rest field and normalize.ts ignores both" +
      " columns. The prescription reaches the watch and does not come home.",
    apply: (e) => mapSteps(e, (s) => ({ ...s, restSeconds: null })),
  },
  wire_rep_count_is_not_read_back: {
    severity: "defect",
    why:
      "A rep count IS written (`targetType: 3`, `targetValue: reps`) — but" +
      " normalize.ts maps targetType 3 to `durationType: 'none'` and keeps no" +
      " value, so '3 × 8' reads back as three targetless steps. The write is" +
      " right; the reader throws the number away.",
    apply: (e) =>
      mapSteps(e, (s) =>
        s.measure === "reps" ? { ...s, measure: "unread" as const, target: null } : s,
      ),
  },
  wire_circuit_reads_back_as_straight_sets: {
    severity: "structural",
    why:
      "A circuit and straight sets are the SAME wire shape — one repeat" +
      " container whose `sets` is the repeat count — so '3 rounds of A/B/C'" +
      " reads back as 'A 3 sets, B 3 sets, C 3 sets'. Identical total work," +
      " different session. Distinguishing them needs a wire field that does not" +
      " exist; guessing would be worse than declaring it." +
      " (Applied AFTER wire_drops_per_side_flag: the builder emits set-outer," +
      " side-inner, and every circuit in the corpus is one set per round.)",
    apply: (e) =>
      e.rounds == null
        ? e
        : {
            ...e,
            rounds: null,
            steps: e.steps.flatMap((s) =>
              Array.from({ length: s.sets ?? 1 }, () => ({ ...s, sets: e.rounds })),
            ),
          },
  },
};

/**
 * Why a session never reaches the watch at all. Distinct from a loss: nothing
 * arrives, so there is nothing to compare.
 *
 * `layer` is the finding, not the bookkeeping. TWO different things keep a
 * session off the watch and they are routinely confused:
 *
 *  - `executor` — the create executor refuses to build the program. A real
 *    protocol limit (or a real gap in the athlete's catalog).
 *  - `app_gate` — `watchPushable` in coach-apply.ts never queues the push, so
 *    the executor is never asked. A product decision, reversible at any time,
 *    and NOT a statement about what the wire can carry.
 *
 * A fixture whose wire ledger is a LOSS LIST rather than a refusal is one the
 * executor writes happily — including every lift and mobility session, which
 * the app gate nevertheless keeps app-only. See the app-gate test in
 * `intent-wire.test.ts`.
 */
export type RefusalReason =
  | "executor_refuses_a_bodyless_session"
  | "executor_refuses_an_empty_exercise_list"
  | "executor_refuses_a_distance_block"
  | "executor_refuses_an_uncatalogued_movement"
  | "app_gate_refuses_a_run_with_no_blocks";

export interface Refusal {
  layer: "executor" | "app_gate";
  why: string;
}

export const REFUSALS: Record<RefusalReason, Refusal> = {
  executor_refuses_a_bodyless_session: {
    layer: "executor",
    why:
      "A rest day and a 'gym, movements on the day' both reach the strength" +
      " builder (no run body), which refuses: there is no lift or mobility body" +
      " to write. Right answer, and it means a rest day is app-only by" +
      " construction rather than by anyone deciding.",
  },
  executor_refuses_an_empty_exercise_list: {
    layer: "executor",
    why:
      "`lift: {exercises: []}` parses exactly like an absent body (2026-08-17)" +
      " and must therefore also travel like one: the builder refuses a program" +
      " with no steps rather than writing an empty workout to the watch.",
  },
  executor_refuses_a_distance_block: {
    layer: "executor",
    why:
      "Distance targets are not spike-verified on this wire, so `buildRunProgram`" +
      " refuses them outright — and `watchPushable` independently requires EVERY" +
      " block be duration-based, so one distance block makes the whole session" +
      " app-only. Both layers agree here, which is why this one is safe.",
  },
  executor_refuses_an_uncatalogued_movement: {
    layer: "executor",
    why:
      "An exercise whose name found no match in the athlete's synced COROS" +
      " catalog has no `originId`, and the builder refuses to write a program the" +
      " server would reject. This is the honest reason a session lives in the app" +
      " and never travels.",
  },
  app_gate_refuses_a_run_with_no_blocks: {
    layer: "app_gate",
    why:
      "'Forty minutes, by feel' is a real prescription with no structure to" +
      " write. `watchPushable` refuses it — while the builder would happily emit" +
      " a program with zero steps, which is not a thing to put on a watch. The" +
      " app is right and the executor has no opinion.",
  },
};

// ── Cross-surface agreement ─────────────────────────────────────────────────

/**
 * The five readers that describe a stored session back to a human, compared in
 * pairs. Every pair below is two renderings of ONE row that a person can see
 * within a tap of each other.
 */
export type SurfacePair =
  /** `describeOps` (the approval card's manifest) vs the stored `stage_summary`
   * (Today's card, the week list). */
  | "manifest_vs_stored"
  /** The stored `stage_summary` vs `summarizeStageRows` of the row's own stage
   * rows — which is what the session sheet renders in preference. */
  | "stored_vs_stage_rows"
  /** `describeOps` vs `summarizeStageRows` — the card the athlete APPROVES
   * against the sheet they then open. Neither goes through the stored column,
   * so this pair can diverge while both agree with nothing in between. */
  | "manifest_vs_stage_rows"
  /** The stored `stage_summary` vs the `contains:` text the coach's dossier
   * quotes back to the model. */
  | "stored_vs_dossier"
  /** `describeOps`' detail lines vs the plan DTO's `exercises[].line`. */
  | "manifest_vs_dto_exercise_lines";

/**
 * Where those readers are allowed to disagree. Same contract as {@link LOSSES}:
 * an undeclared divergence fails, and a declared one that no longer happens
 * fails too. Nothing here is structural — every entry is two formatters that
 * should be one.
 */
export type SurfaceDivergence =
  | "manifest_vs_stored__distance_formatter"
  | "stored_vs_stage_rows__distance_formatter"
  | "manifest_vs_stage_rows__distance_precision"
  | "stored_vs_stage_rows__role_label"
  | "manifest_vs_stage_rows__role_label";

export const SURFACE_DIVERGENCES: Record<
  SurfaceDivergence,
  { pair: SurfacePair; severity: "defect"; why: string }
> = {
  manifest_vs_stored__distance_formatter: {
    pair: "manifest_vs_stored",
    severity: "defect",
    why:
      "Three formatters for one distance. `describeOps` and `summarizeStages`" +
      " agree ('644 m', '16 km'); `coach-apply.ts`'s stageSummary has its own" +
      " `(m/1000).toFixed(1) + 'km'`, so 644 m is stored — and shown on the card," +
      " and quoted to the coach — as '0.6km'.",
  },
  stored_vs_stage_rows__distance_formatter: {
    pair: "stored_vs_stage_rows",
    severity: "defect",
    why:
      "The same third formatter, seen from the other side: the session sheet" +
      " re-derives the summary from the stage rows and reads '800 m' where the" +
      " card above it reads '0.8km'.",
  },
  manifest_vs_stage_rows__distance_precision: {
    pair: "manifest_vs_stage_rows",
    severity: "defect",
    why:
      "A FOURTH rounding, between the two renderers that were supposed to be the" +
      " agreeing pair: `describeOps` writes `toFixed(2)` and `summarizeStages`" +
      " `toFixed(1)`, so a mile block reads '1.61 km' on the card the athlete" +
      " approves and '1.6 km' on the sheet they open next. Small, and exactly" +
      " the kind of small that makes an athlete check which one to run.",
  },
  stored_vs_stage_rows__role_label: {
    pair: "stored_vs_stage_rows",
    severity: "defect",
    why:
      "`summarizeStages` falls back to the stage row's KIND when a block stated" +
      " no intensity, so a block the positional rule called a warm-up renders as" +
      " '15 min warmup' on the sheet and '15 min' on the card. Downstream of" +
      " store_stage_role_is_positional: with the role derivation the wire uses," +
      " the block is `work` and the label is empty.",
  },
  manifest_vs_stage_rows__role_label: {
    pair: "manifest_vs_stage_rows",
    severity: "defect",
    why:
      "The same invented label, reaching the athlete one step earlier: the card" +
      " they APPROVE says '15 min', and the sheet they open afterwards says" +
      " '15 min warmup' — a role nobody wrote, on a session they already agreed to.",
  },
};

// ── Field coverage: adding a field to the vocabulary breaks this ────────────

/**
 * EVERY FIELD OF THE COACH'S EXERCISE VOCABULARY, and how this instrument
 * accounts for it. `Record<keyof CoachExercise, …>` is the enforcement: add a
 * field to `coachExerciseSchema` and this file stops compiling until the field
 * has a home here.
 *
 *  - `canonical` names the {@link CanonicalStep} field it projects onto, or
 *    `"gate"` for a field that decides whether the session can travel at all
 *    (`originId`), or `"identity"` for one the canonical shape deliberately
 *    does not carry.
 *  - `spellings` is every form the schema accepts, with what it must parse to.
 *    The corpus is BUILT from this table, so a spelling cannot be added here
 *    without also travelling the whole pipeline.
 */
export interface FieldAccount {
  canonical: keyof CanonicalStep | "gate" | "identity";
  spellings: Array<{ raw: unknown; parsed: unknown }>;
}

export const EXERCISE_FIELDS: Record<keyof CoachExercise, FieldAccount> = {
  name: { canonical: "identity", spellings: [{ raw: "Wall sit", parsed: "Wall sit" }] },
  sets: {
    canonical: "sets",
    spellings: [
      { raw: 3, parsed: 3 },
      { raw: "3", parsed: 3 },
      { raw: 4.0, parsed: 4 },
    ],
  },
  reps: {
    canonical: "target",
    spellings: [
      { raw: 8, parsed: 8 },
      { raw: "8", parsed: 8 },
      { raw: "8-12", parsed: 8 },
      { raw: 10.0, parsed: 10 },
    ],
  },
  holdSeconds: {
    canonical: "target",
    spellings: [
      { raw: 45, parsed: 45 },
      { raw: "45s", parsed: 45 },
      { raw: "1:30", parsed: 90 },
      { raw: "2 min", parsed: 120 },
    ],
  },
  perSide: { canonical: "sides", spellings: [{ raw: true, parsed: true }] },
  eccentricSeconds: {
    canonical: "tempoSeconds",
    spellings: [
      { raw: 4, parsed: 4 },
      { raw: "4s", parsed: 4 },
    ],
  },
  weight: {
    canonical: "loadKg",
    spellings: [
      { raw: 20, parsed: { type: "kg", value: 20 } },
      { raw: "20kg", parsed: { type: "kg", value: 20 } },
      { raw: "45lb", parsed: { type: "kg", value: 20.4 } },
      { raw: "2×20kg", parsed: { type: "kg", value: 20 } },
      { raw: { type: "kg", value: 35 }, parsed: { type: "kg", value: 35 } },
      { raw: { type: "bodyweight" }, parsed: { type: "bodyweight" } },
      { raw: "heavy", parsed: { type: "bodyweight" } },
      { raw: null, parsed: { type: "bodyweight" } },
    ],
  },
  restSeconds: {
    canonical: "restSeconds",
    spellings: [
      { raw: 0, parsed: 0 },
      { raw: 90, parsed: 90 },
      { raw: "2 min", parsed: 120 },
      { raw: "1:00", parsed: 60 },
      { raw: "45s", parsed: 45 },
    ],
  },
  note: {
    canonical: "note",
    spellings: [{ raw: "pause at the bottom", parsed: "pause at the bottom" }],
  },
  originId: { canonical: "gate", spellings: [{ raw: SQUAT_ORIGIN_ID, parsed: SQUAT_ORIGIN_ID }] },
};

/** The block-level field that makes a CIRCUIT expressible — same contract as
 * the exercise fields, one level up. */
export const ROUNDS_SPELLINGS: Array<{ raw: unknown; parsed: number }> = [
  { raw: 3, parsed: 3 },
  { raw: "3", parsed: 3 },
];

// ── The corpus ──────────────────────────────────────────────────────────────

export interface Fixture {
  name: string;
  /** One sentence: which feature of the vocabulary this session exercises. */
  exercises: string;
  /** The coach's own JSON, parsed by the REAL schema — so the corpus is written
   * in the dialect a model actually emits, defaults and synonyms included. */
  raw: unknown;
  session: CoachSession;
  ledger: {
    store: LossReason[];
    /** Losses IN APPLICATION ORDER, or the reason nothing arrives at all. */
    wire: LossReason[] | { refused: RefusalReason };
    surfaces: SurfaceDivergence[];
  };
}

/** An exercise the mock COROS catalog can resolve, so the wire leg tests the
 * wire rather than the catalog. */
const catalogued = (name: string, originId: string, rest: Record<string, unknown>) => ({
  name,
  originId,
  ...rest,
});

/** Every accepted spelling of ONE field, spread across a lift session — so each
 * spelling travels the whole chain rather than only the parser. */
function spellingFixture(
  field: keyof CoachExercise,
  base: Record<string, unknown>,
): Record<string, unknown> {
  return {
    category: "strength",
    title: `Spellings of ${field}`,
    durationMinutes: 45,
    lift: {
      exercises: EXERCISE_FIELDS[field].spellings.map((s, i) =>
        catalogued(`${field} ${i + 1}`, i % 2 === 0 ? SQUAT_ORIGIN_ID : BENCH_ORIGIN_ID, {
          ...base,
          [field]: s.raw,
        }),
      ),
    },
  };
}

/** The seven intensity states a run block can be in: the five the enum holds,
 * one synonym the coach actually writes, and absent. */
const INTENSITY_STATES = [
  "easy",
  "steady",
  "tempo", // → threshold, the one missing word that killed 7 plans in 800
  "interval",
  "walk", // → rest
  undefined, // by feel
  "easy", // closes the session, so the derivation must call it a cool-down
] as const;

/** Losses every lift or mobility session takes on the wire, in ledger order. */
const LIFT_WIRE_BASE: LossReason[] = [
  "wire_title_is_the_ownership_stamp",
  "wire_minutes_are_the_servers_estimate",
];

const RAW_FIXTURES: Array<Omit<Fixture, "session">> = [
  {
    name: "run/every-intensity-duration",
    exercises:
      "every intensity a duration block can carry plus intensity-absent, and all" +
      " four wire roles (warm-up, work, recovery, cool-down) in one session",
    raw: {
      category: "quality",
      title: "Threshold with walk-backs",
      durationMinutes: 60,
      run: {
        blocks: [
          { kind: "duration", value: 15, intensity: INTENSITY_STATES[0] },
          { kind: "duration", value: 8, intensity: INTENSITY_STATES[1] },
          { kind: "duration", value: 6, intensity: INTENSITY_STATES[2] },
          { kind: "duration", value: "90s", intensity: INTENSITY_STATES[3] },
          { kind: "duration", value: 2, intensity: INTENSITY_STATES[4] },
          { kind: "minutes", value: 5 },
          { kind: "duration", value: 10, intensity: INTENSITY_STATES[6] },
        ],
      },
    },
    ledger: {
      store: ["store_stage_role_is_positional"],
      wire: ["wire_title_is_the_ownership_stamp", "wire_minutes_are_the_servers_estimate"],
      surfaces: [],
    },
  },
  {
    name: "run/every-intensity-distance",
    exercises:
      "every intensity on a DISTANCE block, in every accepted spelling of the" +
      " block kind — including a unit written on the value instead of the kind",
    raw: {
      category: "long",
      title: "Progression by distance",
      durationMinutes: 90,
      run: {
        blocks: [
          { kind: "distance", value: 1600, intensity: INTENSITY_STATES[0] },
          { kind: "km", value: 2, intensity: INTENSITY_STATES[1] },
          { kind: "meters", value: 800, intensity: INTENSITY_STATES[2] },
          { kind: "m", value: 400, intensity: INTENSITY_STATES[3] },
          { kind: "duration", value: "1km", intensity: INTENSITY_STATES[4] },
          { kind: "miles", value: 1 },
          { kind: "yards", value: 500, intensity: INTENSITY_STATES[6] },
        ],
      },
    },
    ledger: {
      store: ["store_stage_role_is_positional"],
      wire: { refused: "executor_refuses_a_distance_block" },
      surfaces: [
        "manifest_vs_stored__distance_formatter",
        "stored_vs_stage_rows__distance_formatter",
        "manifest_vs_stage_rows__distance_precision",
      ],
    },
  },
  {
    name: "run/26-block-interval-session",
    exercises: "12×90s off 60s written as its 26 real blocks — the size a coach actually writes",
    raw: {
      category: "intervals",
      title: "12 × 90s",
      durationMinutes: 55,
      run: {
        blocks: [
          { kind: "duration", value: 15, intensity: "easy" },
          ...Array.from({ length: 12 }, () => [
            { kind: "duration", value: "90s", intensity: "interval" },
            { kind: "duration", value: "60s", intensity: "walk" },
          ]).flat(),
          { kind: "duration", value: 10, intensity: "easy" },
        ],
      },
    },
    ledger: {
      store: ["store_stage_role_is_positional"],
      wire: ["wire_title_is_the_ownership_stamp", "wire_minutes_are_the_servers_estimate"],
      surfaces: [],
    },
  },
  {
    name: "run/mixed-duration-and-distance",
    exercises: "one distance block among duration blocks — the whole session goes app-only",
    raw: {
      category: "quality",
      title: "Warm up, then a k",
      durationMinutes: 40,
      run: {
        blocks: [
          { kind: "duration", value: 15, intensity: "easy" },
          { kind: "distance", value: 1000, intensity: "threshold" },
          { kind: "duration", value: 10, intensity: "easy" },
        ],
      },
    },
    ledger: {
      store: ["store_stage_role_is_positional"],
      wire: { refused: "executor_refuses_a_distance_block" },
      surfaces: [
        "manifest_vs_stored__distance_formatter",
        "stored_vs_stage_rows__distance_formatter",
      ],
    },
  },
  {
    name: "run/single-block-no-intensity",
    exercises: "a run by feel: one block, no intensity, so there is no pace band to lose",
    raw: {
      category: "easy",
      title: "Forty easy",
      durationMinutes: 40,
      run: { blocks: [{ kind: "duration", value: 40 }] },
    },
    ledger: {
      store: [],
      wire: ["wire_title_is_the_ownership_stamp", "wire_minutes_are_the_servers_estimate"],
      surfaces: [],
    },
  },
  {
    name: "run/unstated-opening-block",
    exercises:
      "a session whose FIRST block states no intensity — where the positional" +
      " role rule and the intensity-derived one disagree about what it is",
    raw: {
      category: "quality",
      title: "Jog in, then work",
      durationMinutes: 35,
      run: {
        blocks: [
          { kind: "duration", value: 15 },
          { kind: "duration", value: 20, intensity: "threshold" },
        ],
      },
    },
    ledger: {
      store: ["store_stage_role_is_positional"],
      wire: ["wire_title_is_the_ownership_stamp", "wire_minutes_are_the_servers_estimate"],
      surfaces: [
      "stored_vs_stage_rows__role_label",
      "manifest_vs_stage_rows__role_label",
    ],
    },
  },
  {
    name: "run/empty-blocks",
    exercises: "`run: {blocks: []}` — an unstructured run, which must read like an absent body",
    raw: { category: "easy", title: "Forty by feel", durationMinutes: 40, run: { blocks: [] } },
    ledger: { store: [], wire: { refused: "app_gate_refuses_a_run_with_no_blocks" }, surfaces: [] },
  },
  {
    name: "session/rest-day",
    exercises: "a rest day at zero minutes — the shape a floor of 5 used to make unsayable",
    raw: { category: "rest day", title: "Off", durationMinutes: 0 },
    ledger: { store: [], wire: { refused: "executor_refuses_a_bodyless_session" }, surfaces: [] },
  },
  {
    name: "session/bodyless-strength",
    exercises: "a strength day with no body at all — the category is the only evidence there is",
    raw: { category: "S&C", title: "Gym, movements on the day", durationMinutes: 30 },
    ledger: { store: [], wire: { refused: "executor_refuses_a_bodyless_session" }, surfaces: [] },
  },
  {
    name: "session/empty-lift-body",
    exercises: "`lift: {exercises: []}` — must read exactly like omitting the key",
    raw: {
      category: "strength",
      title: "Strength Friday",
      durationMinutes: 45,
      lift: { exercises: [] },
    },
    ledger: { store: [], wire: { refused: "executor_refuses_an_empty_exercise_list" }, surfaces: [] },
  },
  {
    name: "session/empty-mobility-body",
    exercises: "the same for the third discipline, which must still file as yoga",
    raw: {
      category: "mobility",
      title: "Mobility, by feel",
      durationMinutes: 20,
      mobility: { exercises: [] },
    },
    ledger: { store: [], wire: { refused: "executor_refuses_an_empty_exercise_list" }, surfaces: [] },
  },
  {
    name: "lift/ski-prep",
    exercises:
      "the session that motivated half the vocabulary: a timed hold, per-side" +
      " work, an eccentric tempo, a real load, a cue, and resolved catalog ids",
    raw: {
      category: "strength",
      title: "Ski legs",
      durationMinutes: 40,
      lift: {
        exercises: [
          catalogued("Wall sit", SQUAT_ORIGIN_ID, {
            sets: 3,
            holdSeconds: "45s",
            restSeconds: "2 min",
          }),
          catalogued("Copenhagen plank", BENCH_ORIGIN_ID, {
            sets: "2",
            holdSeconds: "1:30",
            perSide: true,
            restSeconds: 20,
            note: "keep the hips stacked",
          }),
          catalogued("Tempo squat", SQUAT_ORIGIN_ID, {
            sets: 3,
            reps: "8-12",
            eccentricSeconds: 4,
            weight: "2×20kg",
            restSeconds: 90,
          }),
        ],
      },
    },
    ledger: {
      store: [],
      wire: [
        ...LIFT_WIRE_BASE,
        "wire_drops_per_side_flag",
        "wire_drops_eccentric_tempo",
        "wire_drops_exercise_note",
        "wire_drops_strength_load",
        "wire_drops_rest_between_sets",
        "wire_rep_count_is_not_read_back",
      ],
      surfaces: [],
    },
  },
  {
    name: "lift/circuit",
    exercises: "`rounds` — the field that makes a circuit expressible instead of unrelated blocks",
    raw: {
      category: "strength",
      title: "Isometric circuit",
      durationMinutes: 12,
      lift: {
        rounds: "3",
        exercises: [
          catalogued("Wall sit", SQUAT_ORIGIN_ID, { sets: 1, holdSeconds: 45, restSeconds: 15 }),
          catalogued("Plank", BENCH_ORIGIN_ID, { sets: 1, holdSeconds: 40, restSeconds: 15 }),
          catalogued("Side plank", BENCH_ORIGIN_ID, {
            sets: 1,
            holdSeconds: 30,
            perSide: true,
            restSeconds: 15,
          }),
        ],
      },
    },
    ledger: {
      store: [],
      wire: [
        ...LIFT_WIRE_BASE,
        "wire_drops_per_side_flag",
        "wire_drops_rest_between_sets",
        "wire_circuit_reads_back_as_straight_sets",
      ],
      surfaces: [],
    },
  },
  {
    name: "mobility/flow",
    exercises: "the third discipline carrying real content — it must not file as running",
    raw: {
      category: "mobility",
      title: "Hip and ankle flow",
      durationMinutes: 15,
      mobility: {
        exercises: [
          catalogued("Couch stretch", SQUAT_ORIGIN_ID, {
            sets: 2,
            holdSeconds: "1:30",
            perSide: true,
            restSeconds: 0,
          }),
          catalogued("Ankle rocks", BENCH_ORIGIN_ID, { sets: 2, reps: 12, restSeconds: 0 }),
        ],
      },
    },
    ledger: {
      store: [],
      wire: [
        ...LIFT_WIRE_BASE,
        "wire_mobility_files_as_strength",
        "wire_drops_per_side_flag",
        "wire_drops_rest_between_sets",
        "wire_rep_count_is_not_read_back",
      ],
      surfaces: [],
    },
  },
  {
    name: "lift/open-sets",
    exercises:
      "three ramping sets, stop when it gets heavy — neither reps nor a hold," +
      " which a `.refine()` used to refuse outright",
    raw: {
      category: "lift",
      title: "Ramping squats",
      durationMinutes: 35,
      lift: {
        exercises: [
          catalogued("Back squat", SQUAT_ORIGIN_ID, {
            sets: 3,
            weight: "heavy",
            restSeconds: "1:00",
          }),
        ],
      },
    },
    ledger: {
      store: [],
      wire: [...LIFT_WIRE_BASE, "wire_drops_rest_between_sets"],
      surfaces: [],
    },
  },
  {
    name: "lift/uncatalogued-movement",
    exercises: "`originId` absent — the honest reason a session lives in the app and never travels",
    raw: {
      category: "strength",
      title: "Nordics",
      durationMinutes: 20,
      lift: { exercises: [{ name: "Nordic curl", sets: 3, reps: 6, restSeconds: 60 }] },
    },
    ledger: { store: [], wire: { refused: "executor_refuses_an_uncatalogued_movement" }, surfaces: [] },
  },
];

/**
 * One fixture per exercise field, carrying every accepted spelling of it. The
 * wire losses are declared per field because they are exactly what the field
 * costs: `eccentricSeconds` pays `wire_drops_eccentric_tempo`, `reps` pays
 * `wire_rep_count_is_not_read_back`, and a field that pays nothing arrives
 * intact.
 */
const SPELLING_FIXTURES: Array<Omit<Fixture, "session">> = (
  [
    ["name", { sets: 3, reps: 8, restSeconds: 60 }, ["wire_rep_count_is_not_read_back"]],
    ["sets", { reps: 10, restSeconds: 60 }, ["wire_rep_count_is_not_read_back"]],
    ["reps", { sets: 3, restSeconds: 60 }, ["wire_rep_count_is_not_read_back"]],
    ["holdSeconds", { sets: 2, restSeconds: 30 }, []],
    [
      "perSide",
      { sets: 2, reps: 10, restSeconds: 60 },
      ["wire_drops_per_side_flag", "wire_rep_count_is_not_read_back"],
    ],
    [
      "eccentricSeconds",
      { sets: 3, reps: 8, restSeconds: 60 },
      ["wire_drops_eccentric_tempo", "wire_rep_count_is_not_read_back"],
    ],
    [
      "weight",
      { sets: 3, reps: 8, restSeconds: 60 },
      ["wire_drops_strength_load", "wire_rep_count_is_not_read_back"],
    ],
    ["restSeconds", { sets: 3, reps: 8 }, ["wire_rep_count_is_not_read_back"]],
    [
      "note",
      { sets: 3, reps: 8, restSeconds: 60 },
      ["wire_drops_exercise_note", "wire_rep_count_is_not_read_back"],
    ],
    ["originId", { sets: 3, reps: 8, restSeconds: 60 }, ["wire_rep_count_is_not_read_back"]],
  ] as Array<[keyof CoachExercise, Record<string, unknown>, LossReason[]]>
).map(([field, base, wireLosses]) => ({
  name: `spelling/${field}`,
  exercises: `every accepted spelling of \`${field}\`, each one travelling the whole chain`,
  raw: spellingFixture(field, base),
  ledger: {
    store: [],
    // Every exercise carries a rest (the schema defaults it to 60), and rest is
    // never read back — so the loss is on every lift fixture, by construction.
    wire: [...LIFT_WIRE_BASE, "wire_drops_rest_between_sets", ...wireLosses],
    surfaces: [],
  } as Fixture["ledger"],
}));

/** The corpus, parsed once by the real schema. A fixture that does not parse is
 * a corpus bug and fails loudly here rather than mysteriously downstream. */
export const FIXTURES: Fixture[] = [...RAW_FIXTURES, ...SPELLING_FIXTURES].map((f) => {
  const parsed = coachSessionSchema.safeParse(f.raw);
  if (!parsed.success) {
    throw new Error(
      `corpus fixture "${f.name}" does not parse: ` +
        parsed.error.issues.map((i) => `${i.path.join(".") || "session"}: ${i.message}`).join("; "),
    );
  }
  return { ...f, session: parsed.data };
});

export const FIXTURES_BY_NAME = new Map(FIXTURES.map((f) => [f.name, f]));

export function fixture(name: string): Fixture {
  const f = FIXTURES_BY_NAME.get(name);
  if (!f) throw new Error(`no corpus fixture named ${name}`);
  return f;
}

// ── Applying the ledger ─────────────────────────────────────────────────────

export interface LedgerVerdict {
  expected: Canonical;
  /** Declared losses that changed nothing — the ledger has rotted. */
  vacuous: LossReason[];
}

/**
 * The coach's intent with exactly the declared losses applied, plus the list of
 * declarations that turned out to be no-ops.
 *
 * Order is significant and is the fixture's to decide: `wire_drops_per_side_flag`
 * splits a step in two, so anything that maps over steps must be free to run
 * after it.
 */
export function applyLedger(
  intent: Canonical,
  actual: Canonical,
  reasons: LossReason[],
): LedgerVerdict {
  let expected = intent;
  const vacuous: LossReason[] = [];
  for (const reason of reasons) {
    const next = LOSSES[reason].apply(expected, actual);
    if (JSON.stringify(next) === JSON.stringify(expected)) vacuous.push(reason);
    expected = next;
  }
  return { expected, vacuous };
}
