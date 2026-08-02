/**
 * Reversible live CREATE spike (docs/research/plan-write-capability.md §(c)).
 *
 * Answers "can Run Garden create brand-new COROS workouts from scratch?" by
 * building hand-authored programs — never cloning an existing one — pushing
 * them via `status: 1`, verifying them with a read, and then deleting every
 * one of them again.
 *
 * Safety doctrine (docs/COROS_WRITE_PROTOCOL.md):
 *  - ADDITIVE ONLY. Nothing the user authored is ever read-modified-written.
 *    Every write is a create of the spike's own throwaway workout, or the
 *    delete of one it just created.
 *  - Far-future dates (today +21/+22/+23) so a leftover is unambiguous and
 *    never collides with real training.
 *  - Self-cleaning: every created entity is tracked and removed in reverse
 *    order, each removal verified by a read, then the whole window is compared
 *    against the baseline snapshot (PASS/FAIL restoration line).
 *  - Fail safe: any unexpected error, and SIGINT, both run the same cleanup
 *    and print the exact account state before exiting.
 *
 * Run with: pnpm coros:spike:create
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { addDays, daysBetween } from "@rg/domain";
import {
  corosDayToLocalDate,
  localDateToCorosDay,
  type RawCorosEntity,
  type RawCorosExercise,
  type RawCorosProgram,
  type RawCorosSchedule,
} from "@rg/providers";
import {
  CorosClient,
  type CorosProgramMetrics,
  type CorosRegion,
} from "./coros-client.js";
import { redactUserId, stripUserIds } from "./sanitize.js";

// ── Report shape ────────────────────────────────────────────────────────────

export type CreateTestName = "strength" | "run" | "bike" | "planAdd";

export interface CreateTestResult {
  name: CreateTestName;
  /** Human label + what the test proves, for the report reader. */
  description: string;
  attempted: boolean;
  /** Sanitized copy of exactly what was sent (userId keys stripped). */
  requestShape?: unknown;
  /** COROS envelope result code of the write ("0000" = accepted). */
  resultCode?: string;
  /** Structural read-after-write passed (duration/load are NOT checked). */
  verified: boolean;
  /** Per-field structural assertions from the read-back program. */
  structuralChecks?: Record<string, boolean>;
  /** What program/calculate returned and we spliced in before the create. */
  calculated?: { duration?: number; trainingLoad?: number };
  /** What the server stored after recomputation (advisory, never asserted). */
  serverRecomputed?: { duration?: number; trainingLoad?: number; distance?: unknown };
  serverIds?: { planId?: string; entityId?: string; programId?: string };
  idInPlan?: number;
  scheduledDate?: string;
  observedDate?: string;
  cleanedUp: boolean;
  cleanupResultCode?: string;
  error?: string;
  notes: string[];
}

export interface CreateSpikeReport {
  kind: "coros-create-spike";
  date: string;
  region: CorosRegion;
  userIdRedacted?: string;
  baseline?: {
    planName?: string;
    planIdPresent: boolean;
    maxIdInPlan: number;
    workoutCount: number;
    idInPlan: string[];
    windowStart: string;
    windowEnd: string;
  };
  tests: Record<CreateTestName, CreateTestResult>;
  overall: {
    /** The account is byte-for-byte back to the baseline entity set. */
    baselineRestored: boolean;
    finalWorkoutCount?: number;
    /** Anything the spike created and could NOT remove. MUST be empty. */
    leftovers: string[];
    /** Plan objects plan/add created that no known endpoint can delete. */
    orphanPlanIds: string[];
    capabilitiesConfirmed: {
      strengthCreateFromScratch: boolean;
      minimalRunCreateFromScratch: boolean;
      minimalBikeCreateFromScratch: boolean;
      planLevelCreate: boolean;
    };
  };
  /** True only if the spike ran to completion AND the account was restored. */
  succeeded: boolean;
  failure?: string;
}

export interface CreateSpikeHandle {
  /** Idempotent removal of everything created so far. Safe to call anytime. */
  cleanup: () => Promise<void>;
  /** The live report object, mutated in place as the spike progresses. */
  report: CreateSpikeReport;
}

export interface CreateSpikeOptions {
  /** yyyy-mm-dd anchor; the spike writes at +21/+22/+23 and probes +40/+41. */
  today?: string;
  log?: (line: string) => void;
  /** Called once, early, so a CLI can bind cleanup to SIGINT. */
  onStart?: (handle: CreateSpikeHandle) => void;
  /** Set false to skip the plan/add probe entirely. */
  includePlanAddProbe?: boolean;
}

// ── Payload construction (research §(b) and §(d)) ────────────────────────────

/** Loud enough that a leftover is unmistakable in the COROS UI. */
const SPIKE_NAME = "RG SPIKE — SAFE TO DELETE";

/** §5.3: top-level step n → 2^24 · n; sub-steps → groupSort + 2^16 · (j+1). */
const TOP_SORT = 16_777_216;
const SUB_SORT = 65_536;

/**
 * §5.5 per-exercise metadata block. Documented for running programs; applied
 * to all hand-built programs here by analogy (the survey gives no separate
 * strength list — noted as inferred in the research doc).
 */
const EXERCISE_METADATA = {
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

interface ExerciseChoice {
  originId: string;
  name: string;
}

/**
 * §(d) bodyweight weight-encoding. `intensityValue` is an empty STRING (not 0
 * — 0 renders "0.00 kg" and is a different case) and `intensityDisplayUnit` is
 * the STRING "6". Both are easy hand-built-payload bugs, hence the wire cast:
 * RawCorosExercise types intensityValue as a number for the read path.
 */
function applyBodyweightIntensity(exercise: RawCorosExercise): void {
  const wire = exercise as Record<string, unknown>;
  wire.intensityType = 1; // 1 = weight
  wire.intensityValue = "";
  wire.intensityPercent = 0;
  wire.intensityDisplayUnit = "6";
  wire.intensityCustom = 1;
}

/**
 * Strength (sportType 4), hand-built flat list: ONE repeat-group container
 * (3 sets) wrapping ONE child exercise at 10 reps bodyweight. "3 sets of 10"
 * is structure, not a field (§(d)). The container is not counted in
 * exerciseNum — real steps only (§5.4).
 */
export function buildStrengthProgram(
  idInPlan: number,
  planId: string,
  exercise: ExerciseChoice,
): RawCorosProgram {
  const container: RawCorosExercise = {
    ...EXERCISE_METADATA,
    id: 1,
    name: "Group",
    exerciseType: 0, // repeat-group container
    sportType: 4,
    intensityType: 0,
    intensityValue: 0,
    targetType: 2, // TIME per iteration
    targetValue: 60,
    sets: 3,
    sortNo: TOP_SORT,
    restType: 3, // skip rests
    restValue: 0,
    groupId: "0",
    isGroup: true,
    originId: "0",
  };
  const child: RawCorosExercise = {
    ...EXERCISE_METADATA,
    id: 2,
    name: exercise.name,
    exerciseType: 2, // main / training
    sportType: 4,
    targetType: 3, // REPS
    targetValue: 10,
    sets: 1,
    sortNo: TOP_SORT + SUB_SORT,
    restType: 3,
    restValue: 0,
    groupId: "1", // the container's id
    isGroup: false,
    originId: exercise.originId,
  };
  applyBodyweightIntensity(child);

  return {
    idInPlan,
    planId,
    name: `${SPIKE_NAME} strength`,
    overview: "",
    sportType: 4,
    subType: 65535, // structured
    duration: 0,
    estimatedTime: 0,
    trainingLoad: 0,
    estimatedValue: 0,
    estimatedType: 0,
    distance: 0,
    estimatedDistance: 0,
    exerciseNum: 1, // real steps only — the container must NOT be counted
    totalSets: 3,
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
    exercises: [container, child],
  };
}

/**
 * Minimal endurance topology: exactly two blocks, warmup (exerciseType 1) +
 * training (exerciseType 2), NO repeat group and NO cooldown — the shape
 * §4.4 point 9 confirms live for runs. intensityType 5 ("none") avoids the
 * HR-zone remapping that makes bpm targets non-round-tripping.
 */
export function buildEnduranceProgram(opts: {
  idInPlan: number;
  planId: string;
  sportType: number;
  label: string;
  warmupOriginId: string;
  workOriginId: string;
  warmupSeconds: number;
  workSeconds: number;
}): RawCorosProgram {
  const block = (
    id: number,
    exerciseType: number,
    seconds: number,
    originId: string,
    name: string,
  ): RawCorosExercise => ({
    ...EXERCISE_METADATA,
    id,
    name,
    exerciseType,
    sportType: opts.sportType,
    targetType: 2, // TIME, whole seconds
    targetValue: seconds,
    intensityType: 5, // none
    intensityValue: 0,
    sets: 1,
    sortNo: TOP_SORT * id,
    restType: 3,
    restValue: 0,
    groupId: "0",
    isGroup: false,
    originId,
  });

  return {
    idInPlan: opts.idInPlan,
    planId: opts.planId,
    name: `${SPIKE_NAME} ${opts.label}`,
    overview: "",
    sportType: opts.sportType,
    subType: 65535,
    duration: 0,
    estimatedTime: 0,
    trainingLoad: 0,
    estimatedValue: 0,
    estimatedType: 0,
    distance: 0,
    estimatedDistance: 0,
    exerciseNum: 2,
    totalSets: 0,
    hybridTotalSets: 0,
    gradeSystemVersion: 0,
    poolLength: 0,
    poolLengthId: 0,
    poolLengthUnit: 0,
    referExercise: { gradeSystem: 0, hrType: 0, intensityType: 5, valueType: 1 },
    sourceUrl: "",
    videoCoverUrl: "",
    videoUrl: "",
    targetType: 2,
    targetValue: opts.warmupSeconds + opts.workSeconds,
    type: 0,
    unit: 0,
    access: 1,
    authorId: "0",
    pbVersion: 2,
    version: 0,
    exercises: [
      block(1, 1, opts.warmupSeconds, opts.warmupOriginId, "T1120"),
      block(2, 2, opts.workSeconds, opts.workOriginId, "T3001"),
    ],
  };
}

/** Well-known run-role originIds from the captured template (§3.7). */
const RUN_WARMUP_ORIGIN_ID = "425895398452936705";
const RUN_WORK_ORIGIN_ID = "426109589008859136";

function buildEntity(opts: {
  idInPlan: number;
  planId: string;
  date: string;
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
 * §(b) plan-level create body (`shenmiguo/scripts/coros.js:279-286`). Plan
 * templates are day-offset relative — `happenDay` is "" and `dayNo` carries
 * the offset — so the caller's intended calendar dates are recorded in the
 * report rather than encoded here.
 */
export function buildPlanAddBody(program: RawCorosProgram, totalDay: number): unknown {
  return {
    name: `${SPIKE_NAME} plan probe`,
    overview: "",
    entities: [{ happenDay: "", idInPlan: 1, sortNoInSchedule: 0, dayNo: 1, exerciseBarChart: [] }],
    programs: [{ ...program, idInPlan: 1 }],
    weekStages: [],
    maxIdInPlan: 1,
    totalDay,
    unit: 0,
    sourceId: "425868142590476288",
    sourceUrl:
      "https://oss.coros.com/source/source_default/0/6097a29cf17a435f88b573c08679280b.jpg",
    minWeeks: 1,
    maxWeeks: Math.ceil(totalDay / 7),
    region: 2,
    pbVersion: 9,
    versionObjects: [{ id: 1, status: 1 }],
  };
}

// ── Spike engine ────────────────────────────────────────────────────────────

interface Located {
  entity: RawCorosEntity;
  program: RawCorosProgram | undefined;
  date: string;
}

function locate(raw: RawCorosSchedule, idInPlan: string | number): Located | undefined {
  const entity = (raw.entities ?? []).find((e) => String(e.idInPlan) === String(idInPlan));
  if (!entity) return undefined;
  const program = (raw.programs ?? []).find((p) => String(p.idInPlan) === String(idInPlan));
  return { entity, program, date: corosDayToLocalDate(entity.happenDay) };
}

function idInPlanSet(raw: RawCorosSchedule): string[] {
  return (raw.entities ?? []).map((e) => String(e.idInPlan)).sort();
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : "unknown failure";
}

function blankResult(name: CreateTestName, description: string): CreateTestResult {
  return { name, description, attempted: false, verified: false, cleanedUp: false, notes: [] };
}

interface CreatedEntity {
  test: CreateTestName;
  label: string;
  idInPlan: number;
  planProgramId: string;
  planId: string;
  date: string;
}

interface CreateSpec {
  test: CreateTestName;
  label: string;
  date: string;
  sportType: number;
  build: (idInPlan: number, planId: string) => RawCorosProgram;
  checks: (program: RawCorosProgram | undefined) => Record<string, boolean>;
}

/** Splice the server's calculate output into the program before creating it. */
function applyCalculated(program: RawCorosProgram, m: CorosProgramMetrics): RawCorosProgram {
  const out: RawCorosProgram = { ...program };
  if (m.duration != null) {
    out.duration = m.duration;
    out.estimatedTime = m.duration;
  }
  if (m.trainingLoad != null) {
    out.trainingLoad = m.trainingLoad;
    out.estimatedValue = m.trainingLoad;
  }
  if (m.distance != null) {
    out.distance = m.distance;
    out.estimatedDistance = m.distance;
  }
  if (m.totalSets != null && out.totalSets != null) out.totalSets = m.totalSets;
  return out;
}

/**
 * Core spike sequence, decoupled from the interactive CLI so it can be driven
 * against the mock server offline. Never throws: failures are recorded on the
 * returned report after cleanup has been attempted.
 */
export async function runCreateSpike(
  client: CorosClient,
  opts: CreateSpikeOptions = {},
): Promise<CreateSpikeReport> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const log = opts.log ?? ((line: string) => console.log(line));
  const windowStart = addDays(today, -30);
  const windowEnd = addDays(today, 30);
  const readWindow = (): Promise<RawCorosSchedule> =>
    client.getRawSchedule(windowStart, windowEnd);

  const report: CreateSpikeReport = {
    kind: "coros-create-spike",
    date: today,
    region: client.region,
    userIdRedacted: redactUserId(client.currentUserId),
    tests: {
      strength: blankResult(
        "strength",
        "hand-built sportType 4 program: repeat group (3 sets) × 10 bodyweight reps",
      ),
      run: blankResult("run", "hand-built sportType 1 program: 2 blocks, warmup + training"),
      bike: blankResult("bike", "probe: hand-built sportType 2 program, same 2-block topology"),
      planAdd: blankResult("planAdd", "probe: POST /training/plan/add (expected 1031 outside CN)"),
    },
    overall: {
      baselineRestored: false,
      leftovers: [],
      orphanPlanIds: [],
      capabilitiesConfirmed: {
        strengthCreateFromScratch: false,
        minimalRunCreateFromScratch: false,
        minimalBikeCreateFromScratch: false,
        planLevelCreate: false,
      },
    },
    succeeded: false,
  };

  const created: CreatedEntity[] = [];
  let cleanupStarted = false;

  const cleanup = async (): Promise<void> => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    if (created.length === 0) {
      log("Cleanup: nothing was created.");
      return;
    }
    log(`Cleanup: removing ${created.length} spike workout(s) in reverse order…`);
    for (const entry of [...created].reverse()) {
      const result = report.tests[entry.test];
      try {
        const del = await client.removeScheduleEntity(
          entry.idInPlan,
          entry.planProgramId,
          entry.planId,
        );
        result.cleanupResultCode = del.result;
        const after = await readWindow();
        const still = locate(after, entry.idInPlan);
        result.cleanedUp = !still;
        if (still) {
          const note = `${entry.label} idInPlan=${entry.idInPlan} still on ${entry.date}`;
          report.overall.leftovers.push(note);
          log(`  !! NOT REMOVED: ${note} — delete "${SPIKE_NAME}" in the COROS app`);
        } else {
          log(`  removed ${entry.label} (idInPlan ${entry.idInPlan}, ${entry.date})`);
        }
      } catch (e) {
        result.cleanedUp = false;
        const note = `${entry.label} idInPlan=${entry.idInPlan} on ${entry.date} (${errText(e)})`;
        report.overall.leftovers.push(note);
        log(`  !! CLEANUP FAILED: ${note} — delete "${SPIKE_NAME}" in the COROS app`);
      }
    }
  };

  opts.onStart?.({ cleanup, report });

  let baselineIds: string[] = [];
  let baselineCount = 0;

  try {
    // ── 1. Baseline snapshot ────────────────────────────────────────────────
    log("Step 1: fresh schedule read (baseline snapshot, ±30 days)…");
    const baseline = await readWindow();
    const planId = String(baseline.id ?? "");
    const planStartDay = baseline.startDay != null ? Number(baseline.startDay) : undefined;
    const maxIdInPlan = Number(baseline.maxIdInPlan ?? 0);
    baselineIds = idInPlanSet(baseline);
    baselineCount = baselineIds.length;
    report.baseline = {
      planName: typeof baseline.name === "string" ? baseline.name : undefined,
      planIdPresent: planId !== "",
      maxIdInPlan,
      workoutCount: baselineCount,
      idInPlan: baselineIds,
      windowStart,
      windowEnd,
    };
    log(
      `  plan="${report.baseline.planName ?? "(none)"}" workouts=${baselineCount} maxIdInPlan=${maxIdInPlan}`,
    );
    if (planId === "") {
      report.tests.strength.notes.push(
        'no active plan in the window; using planId "" (server auto-targets/auto-creates)',
      );
    }

    const ctx = { client, log, readWindow, created, report, planId, planStartDay };

    // ── 2. TEST A — strength from scratch ───────────────────────────────────
    log("\nStep 2: TEST A — strength create from scratch (sportType 4)…");
    const exercise = await pickStrengthExercise(client, log, report.tests.strength);
    await createAndVerify(ctx, report.tests.strength, {
      test: "strength",
      label: "strength",
      date: addDays(today, 21),
      sportType: 4,
      build: (idInPlan, pid) => buildStrengthProgram(idInPlan, pid, exercise),
      checks: (program) => {
        const exercises = program?.exercises ?? [];
        const container = exercises.find((e) => Number(e.exerciseType) === 0);
        const child = exercises.find((e) => Number(e.exerciseType) === 2);
        return {
          sportTypeIs4: Number(program?.sportType) === 4,
          repeatGroupPresent: container !== undefined,
          groupSetsIs3: Number(container?.sets) === 3,
          childTargetTypeIsReps: Number(child?.targetType) === 3,
          childTargetValueIs10: Number(child?.targetValue) === 10,
          childIntensityTypeIsWeight: Number(child?.intensityType) === 1,
        };
      },
    });

    // ── 3. TEST B — minimal run ─────────────────────────────────────────────
    log("\nStep 3: TEST B — minimal run create (2 blocks, no group, no cooldown)…");
    await createAndVerify(ctx, report.tests.run, {
      test: "run",
      label: "run",
      date: addDays(today, 22),
      sportType: 1,
      build: (idInPlan, pid) =>
        buildEnduranceProgram({
          idInPlan,
          planId: pid,
          sportType: 1,
          label: "run",
          warmupOriginId: RUN_WARMUP_ORIGIN_ID,
          workOriginId: RUN_WORK_ORIGIN_ID,
          warmupSeconds: 300,
          workSeconds: 1200,
        }),
      checks: enduranceChecks(1),
    });

    // ── 4. TEST C — bike probe ──────────────────────────────────────────────
    log("\nStep 4: TEST C — bike create probe (uncaptured in the survey; may fail)…");
    await createAndVerify(ctx, report.tests.bike, {
      test: "bike",
      label: "bike",
      date: addDays(today, 23),
      sportType: 2,
      build: (idInPlan, pid) =>
        buildEnduranceProgram({
          idInPlan,
          planId: pid,
          sportType: 2,
          label: "bike",
          warmupOriginId: "0",
          workOriginId: "0",
          warmupSeconds: 300,
          workSeconds: 1200,
        }),
      checks: enduranceChecks(2),
    });

    // ── 5. TEST D — plan/add probe ──────────────────────────────────────────
    if (opts.includePlanAddProbe === false) {
      report.tests.planAdd.notes.push("skipped by caller");
      report.tests.planAdd.cleanedUp = true;
    } else {
      log("\nStep 5: TEST D — plan-level create probe (POST /training/plan/add)…");
      await runPlanAddProbe(ctx, today);
    }

    // ── 6. Cleanup + restoration check ──────────────────────────────────────
    log("\nStep 6: cleanup…");
    await cleanup();
  } catch (e) {
    report.failure = errText(e);
    log(`\nSPIKE FAILED: ${report.failure}`);
    log("Attempting cleanup of everything created so far…");
    await cleanup();
  }

  // Restoration check runs on every path, including failure.
  try {
    const final = await readWindow();
    const finalIds = idInPlanSet(final);
    report.overall.finalWorkoutCount = finalIds.length;
    const restored =
      finalIds.length === baselineCount && finalIds.join(",") === baselineIds.join(",");
    // An orphaned plan object is also "not restored" — it is account state the
    // spike created and cannot remove.
    report.overall.baselineRestored =
      restored &&
      report.overall.leftovers.length === 0 &&
      report.overall.orphanPlanIds.length === 0;
    log(
      report.overall.baselineRestored
        ? `RESTORATION PASS: ${finalIds.length} workouts, idInPlan set identical to baseline.`
        : `RESTORATION FAIL: baseline had ${baselineCount} workouts, now ${finalIds.length}.`,
    );
    if (!report.overall.baselineRestored) {
      const extra = finalIds.filter((id) => !baselineIds.includes(id));
      const missing = baselineIds.filter((id) => !finalIds.includes(id));
      if (extra.length > 0) log(`  EXTRA idInPlan still present: ${extra.join(", ")}`);
      if (missing.length > 0) log(`  MISSING idInPlan (unexpected!): ${missing.join(", ")}`);
    }
  } catch (e) {
    report.overall.baselineRestored = false;
    report.failure ??= `restoration check failed: ${errText(e)}`;
    log(`RESTORATION FAIL: could not re-read the schedule (${errText(e)}).`);
  }

  if (report.overall.orphanPlanIds.length > 0) {
    log("");
    log("!! ACTION REQUIRED: plan/add created plan object(s) with no delete endpoint:");
    for (const id of report.overall.orphanPlanIds) log(`     planId=${id}`);
    log("   Remove them by hand in the COROS Training Hub UI.");
  }

  const caps = report.overall.capabilitiesConfirmed;
  caps.strengthCreateFromScratch = report.tests.strength.verified;
  caps.minimalRunCreateFromScratch = report.tests.run.verified;
  caps.minimalBikeCreateFromScratch = report.tests.bike.verified;
  caps.planLevelCreate = report.tests.planAdd.resultCode === "0000";

  report.succeeded = report.failure === undefined && report.overall.baselineRestored;
  return report;
}

function enduranceChecks(
  sportType: number,
): (program: RawCorosProgram | undefined) => Record<string, boolean> {
  return (program) => {
    const exercises = program?.exercises ?? [];
    const warmup = exercises.find((e) => Number(e.exerciseType) === 1);
    const work = exercises.find((e) => Number(e.exerciseType) === 2);
    return {
      sportTypeMatches: Number(program?.sportType) === sportType,
      exactlyTwoBlocks: exercises.length === 2,
      warmupPresent: warmup !== undefined,
      trainingPresent: work !== undefined,
      warmupTargetTypeIsTime: Number(warmup?.targetType) === 2,
      trainingTargetTypeIsTime: Number(work?.targetType) === 2,
      noRepeatGroup: exercises.every((e) => e.isGroup !== true),
    };
  };
}

interface SpikeContext {
  client: CorosClient;
  log: (line: string) => void;
  readWindow: () => Promise<RawCorosSchedule>;
  created: CreatedEntity[];
  report: CreateSpikeReport;
  planId: string;
  planStartDay?: number;
}

/**
 * Best-effort: a real catalog `id` is the valid `originId` for a hand-built
 * strength step. Failure is never fatal — the spike falls back to "0" and
 * records that in the report.
 */
async function pickStrengthExercise(
  client: CorosClient,
  log: (line: string) => void,
  result: CreateTestResult,
): Promise<ExerciseChoice> {
  try {
    const catalog = await client.getExerciseCatalog(4);
    const pick = catalog.find((e) => Number(e.targetType) === 3) ?? catalog[0];
    if (pick?.id != null) {
      log(`  exercise catalog: ${catalog.length} entries; originId=${String(pick.id)}`);
      result.notes.push(`originId from exercise catalog (${catalog.length} entries)`);
      return {
        originId: String(pick.id),
        name: typeof pick.name === "string" ? pick.name : "Exercise",
      };
    }
    result.notes.push("exercise catalog empty — falling back to originId 0");
  } catch (e) {
    log(`  exercise catalog unavailable (${errText(e)}) — falling back to originId 0`);
    result.notes.push(`exercise catalog unavailable: ${errText(e)}`);
  }
  return { originId: "0", name: "Exercise" };
}

/**
 * One create test: fresh maxIdInPlan read → calculate-then-add → status:1 →
 * read-after-write structural verify → server-id recovery. Anything that
 * materializes is registered for cleanup FIRST, before any verdict.
 */
async function createAndVerify(
  ctx: SpikeContext,
  result: CreateTestResult,
  spec: CreateSpec,
): Promise<void> {
  result.attempted = true;
  result.scheduledDate = spec.date;

  // Fresh read immediately before the write: maxIdInPlan is a monotonic
  // shared counter and read-then-write is racy (§4.4 point 3).
  const fresh = await ctx.readWindow();
  const idInPlan = Number(fresh.maxIdInPlan ?? 0) + 1;
  const planId = String(fresh.id ?? ctx.planId);
  result.idInPlan = idInPlan;

  let program = spec.build(idInPlan, planId);

  // Calculate-then-add: the web app's documented two-step (§(d)).
  try {
    const metrics = await ctx.client.calculateProgramMetrics(program);
    program = applyCalculated(program, metrics);
    result.calculated = { duration: metrics.duration, trainingLoad: metrics.trainingLoad };
    ctx.log(
      `  program/calculate → duration=${metrics.duration ?? "-"}s load=${metrics.trainingLoad ?? "-"}`,
    );
  } catch (e) {
    result.notes.push(`program/calculate failed (${errText(e)}); proceeding without estimates`);
    ctx.log(`  program/calculate failed (${errText(e)}) — proceeding`);
  }

  const entity = buildEntity({
    idInPlan,
    planId,
    date: spec.date,
    planStartDay: ctx.planStartDay,
    sportType: spec.sportType,
    name: String(program.name ?? SPIKE_NAME),
  });
  result.requestShape = stripUserIds({ entity, program });

  let add;
  try {
    add = await ctx.client.addScheduleEntity(entity, program, idInPlan, planId);
    result.resultCode = add.result;
    ctx.log(`  status:1 create at ${spec.date} → result=${add.result}`);
  } catch (e) {
    // Network failure mid-write: state unknown. The read below decides, and
    // anything visible is registered for cleanup.
    result.error = errText(e);
    result.notes.push("create threw mid-write; read-after-write decides");
    ctx.log(`  status:1 create threw (${errText(e)}) — reading back`);
  }

  const after = await ctx.readWindow();
  const found = locate(after, idInPlan);

  if (found) {
    // Register for cleanup BEFORE judging success — a rejected-but-materialized
    // create must still be removed.
    ctx.created.push({
      test: spec.test,
      label: spec.label,
      idInPlan,
      planProgramId: String(found.entity.planProgramId ?? idInPlan),
      planId: String(after.id ?? planId),
      date: found.date,
    });
    result.observedDate = found.date;
    result.serverIds = {
      planId: after.id != null ? String(after.id) : undefined,
      entityId: found.entity.id != null ? String(found.entity.id) : undefined,
      programId: found.program?.id != null ? String(found.program.id) : undefined,
    };
    result.serverRecomputed = {
      duration: typeof found.program?.duration === "number" ? found.program.duration : undefined,
      trainingLoad:
        typeof found.program?.trainingLoad === "number" ? found.program.trainingLoad : undefined,
      distance: found.program?.distance,
    };
  }

  if (add === undefined || !add.ok) {
    result.verified = false;
    result.notes.push(
      found
        ? "server rejected the create but an entity materialized — will be cleaned up"
        : "server rejected the create; nothing materialized",
    );
    if (!found) result.cleanedUp = true; // nothing to clean
    ctx.log(`  NOT CREATED (result=${result.resultCode ?? "threw"})`);
    return;
  }

  if (!found) {
    result.verified = false;
    result.cleanedUp = true;
    result.notes.push("create returned 0000 but nothing materialized on read-after-write");
    ctx.log("  ACCEPTED BUT NOT VISIBLE — read-after-write found nothing");
    return;
  }

  // Structural verify only: duration/load/distance are server-recomputed and
  // are never allowed to fail the spike (§(c) step 4).
  const checks = spec.checks(found.program);
  result.structuralChecks = checks;
  const structural = Object.values(checks).every(Boolean);
  result.verified = structural && found.date === spec.date;
  ctx.log(
    `  read-after-write: date=${found.date} structural=${structural ? "PASS" : "FAIL"} ` +
      `serverIds plan=${result.serverIds?.planId ?? "-"} entity=${result.serverIds?.entityId ?? "-"} ` +
      `program=${result.serverIds?.programId ?? "-"}`,
  );
  if (!structural) {
    const failed = Object.entries(checks)
      .filter(([, ok]) => !ok)
      .map(([k]) => k);
    ctx.log(`  failed structural checks: ${failed.join(", ")}`);
  }
}

/**
 * One-shot plan-level create probe. Expected to be rejected (1031 outside CN).
 * On unexpected success the probe diffs the schedule and removes whatever
 * appeared; a plan object it cannot delete is recorded loudly, never silently.
 */
async function runPlanAddProbe(ctx: SpikeContext, today: string): Promise<void> {
  const result = ctx.report.tests.planAdd;
  result.attempted = true;
  const probeStart = addDays(today, 40);
  const probeEnd = addDays(today, 41);
  result.scheduledDate = probeStart;
  result.notes.push(
    `plan templates are day-offset relative (happenDay ""); intended anchor ${probeStart}..${probeEnd}`,
  );

  const probeWindow = (): Promise<RawCorosSchedule> =>
    ctx.client.getRawSchedule(addDays(today, 30), addDays(today, 60));

  let before: RawCorosSchedule;
  try {
    before = await probeWindow();
  } catch (e) {
    result.error = `pre-probe read failed: ${errText(e)}`;
    result.cleanedUp = true;
    return;
  }
  const beforeIds = new Set(idInPlanSet(before));
  const beforePlanId = String(before.id ?? "");

  const program = buildEnduranceProgram({
    idInPlan: 1,
    planId: "",
    sportType: 1,
    label: "plan probe",
    warmupOriginId: RUN_WARMUP_ORIGIN_ID,
    workOriginId: RUN_WORK_ORIGIN_ID,
    warmupSeconds: 300,
    workSeconds: 1200,
  });
  const body = buildPlanAddBody(program, 2);
  result.requestShape = stripUserIds(body);

  let res;
  try {
    res = await ctx.client.planAdd(body);
  } catch (e) {
    result.error = errText(e);
    result.cleanedUp = true;
    ctx.log(`  plan/add threw (${errText(e)}) — nothing to clean up`);
    return;
  }
  result.resultCode = res.result;
  result.notes.push(`message=${res.message}`);
  ctx.log(`  plan/add → result=${res.result} (${res.message})`);

  if (!res.ok) {
    result.verified = false;
    result.cleanedUp = true;
    result.notes.push(
      res.result === "1031"
        ? "rejected with 1031 — matches the one community EU attempt on record"
        : "rejected; plan-level create is not available on this account/region",
    );
    return;
  }

  // Unexpected success — clean up aggressively and loudly.
  result.verified = true;
  result.notes.push("UNEXPECTED: plan-level create was accepted");
  ctx.log("  !! plan/add SUCCEEDED unexpectedly — removing whatever it created");

  const newPlanId = extractPlanId(res.data);
  if (newPlanId) result.serverIds = { planId: newPlanId };

  let removedAll = true;
  try {
    const after = await probeWindow();
    const activePlanId = String(after.id ?? beforePlanId);
    const fresh = (after.entities ?? []).filter((e) => !beforeIds.has(String(e.idInPlan)));
    ctx.log(`  plan/add produced ${fresh.length} new schedule entit(ies)`);
    for (const entity of fresh) {
      try {
        await ctx.client.removeScheduleEntity(
          entity.idInPlan,
          String(entity.planProgramId ?? entity.idInPlan),
          activePlanId,
        );
      } catch (e) {
        removedAll = false;
        ctx.report.overall.leftovers.push(
          `plan-probe entity idInPlan=${String(entity.idInPlan)} (${errText(e)})`,
        );
      }
    }
    const verify = await probeWindow();
    const stillThere = (verify.entities ?? []).filter((e) => !beforeIds.has(String(e.idInPlan)));
    for (const entity of stillThere) {
      removedAll = false;
      ctx.report.overall.leftovers.push(
        `plan-probe entity idInPlan=${String(entity.idInPlan)} still present`,
      );
    }
    if (String(verify.id ?? "") !== beforePlanId) {
      result.notes.push(
        `active planId changed ${beforePlanId || "(none)"} → ${String(verify.id ?? "")}`,
      );
    }
  } catch (e) {
    removedAll = false;
    result.error = `post-probe cleanup read failed: ${errText(e)}`;
  }

  // A plan OBJECT may exist that no endpoint in this client can delete
  // (/training/plan/delete is declared-only in the survey, never called).
  if (newPlanId && newPlanId !== beforePlanId) {
    ctx.report.overall.orphanPlanIds.push(newPlanId);
    result.notes.push(
      "a plan object was created; no delete endpoint is implemented — remove it in the COROS UI",
    );
    removedAll = false;
  }
  result.cleanedUp = removedAll;
}

function extractPlanId(data: unknown): string | undefined {
  if (typeof data === "string" && data !== "") return data;
  if (typeof data === "number") return String(data);
  if (data !== null && typeof data === "object") {
    const id = (data as { id?: unknown; planId?: unknown }).id ??
      (data as { planId?: unknown }).planId;
    if (typeof id === "string" && id !== "") return id;
    if (typeof id === "number") return String(id);
  }
  return undefined;
}

// ── Report file ─────────────────────────────────────────────────────────────

export function createSpikeReportPath(date: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, "..", "..", "..", "docs", "reports");
  mkdirSync(dir, { recursive: true });
  return join(dir, `coros-create-spike-${date}.json`);
}

function writeReport(report: CreateSpikeReport): string {
  const path = createSpikeReportPath(report.date);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

// ── Interactive CLI ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let client: CorosClient | null = null;
  // Held in an object so the SIGINT closure and the catch block both see the
  // handle the moment runCreateSpike publishes it.
  const state: { handle: CreateSpikeHandle | null } = { handle: null };
  let interrupted = false;

  const onInterrupt = (): void => {
    if (interrupted) return;
    interrupted = true;
    void (async () => {
      console.error("\nInterrupted — cleaning up anything the spike created…");
      const live = state.handle;
      if (live) {
        live.report.failure = "interrupted (SIGINT)";
        try {
          await live.cleanup();
        } catch {
          console.error("Cleanup after interrupt FAILED.");
        }
        if (live.report.overall.leftovers.length > 0) {
          console.error("CHECK YOUR COROS CALENDAR — leftovers:");
          for (const l of live.report.overall.leftovers) console.error(`  - ${l}`);
        }
        console.error(`Report written to ${writeReport(live.report)}`);
      }
      rl.close();
      if (client) await client.logout().catch(() => undefined);
      process.exit(130);
    })();
  };
  process.on("SIGINT", onInterrupt);
  rl.on("SIGINT", onInterrupt);

  console.log("──────────────────────────────────────────────────────────────");
  console.log(" COROS CREATE SPIKE — THIS WRITES TO YOUR REAL COROS ACCOUNT");
  console.log("");
  console.log(" It CREATES up to three brand-new throwaway workouts, named");
  console.log(` "${SPIKE_NAME}", on ${addDays(today, 21)}, ${addDays(today, 22)} and`);
  console.log(` ${addDays(today, 23)} — far outside any real training — verifies`);
  console.log(" each one, then DELETES every one of them again. It also probes");
  console.log(" plan-level create once (expected to be rejected).");
  console.log("");
  console.log(" It NEVER reads, edits or deletes a workout you authored.");
  console.log(" On any failure — or Ctrl-C — it cleans up what it made and");
  console.log(" prints the exact state your calendar is in.");
  console.log("──────────────────────────────────────────────────────────────");

  let report: CreateSpikeReport | null = null;
  try {
    const email = (await rl.question("COROS email: ")).trim();
    const password = await rl.question("COROS password: ");
    const regionInput = (await rl.question("Region [us/eu/cn] (default us): ")).trim() || "us";
    if (!["us", "eu", "cn"].includes(regionInput)) throw new Error("invalid region");
    const region = regionInput as CorosRegion;

    const confirm = await rl.question(
      "\nType CREATE to run the create spike against this account: ",
    );
    if (confirm.trim() !== "CREATE") throw new Error("aborted by user (no writes performed)");

    client = new CorosClient({ region });
    await client.login(email, password);
    console.log("Logged in.\n");

    report = await runCreateSpike(client, {
      today,
      log: (line) => console.log(line),
      onStart: (h) => {
        state.handle = h;
      },
    });

    console.log("");
    console.log(
      report.succeeded
        ? "SPIKE COMPLETE — account restored to its baseline state."
        : "SPIKE COMPLETE WITH PROBLEMS — see the leftovers above and the report.",
    );
    console.log(
      `  strength create: ${verdict(report.tests.strength)}   run create: ${verdict(report.tests.run)}`,
    );
    console.log(
      `  bike probe: ${verdict(report.tests.bike)}   plan/add probe: ${report.tests.planAdd.resultCode ?? "-"}`,
    );
    if (!report.succeeded) process.exitCode = 1;
  } catch (e) {
    const message = errText(e);
    console.error(`\nSPIKE FAILED: ${message}`);
    const live = state.handle;
    if (live) {
      live.report.failure ??= message;
      await live.cleanup().catch(() => undefined);
      report = live.report;
    }
    process.exitCode = 1;
  } finally {
    if (!interrupted) {
      rl.close();
      if (client) await client.logout().catch(() => undefined);
      if (report) console.log(`\nSanitized report written to ${writeReport(report)}`);
    }
  }
}

function verdict(result: CreateTestResult): string {
  if (!result.attempted) return "not attempted";
  return result.verified ? "VERIFIED" : `not verified (${result.resultCode ?? result.error ?? "-"})`;
}

// Only run the CLI when executed directly — the test imports runCreateSpike.
const entry = process.argv[1];
if (entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry)) {
  void main();
}
