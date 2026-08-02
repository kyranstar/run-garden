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
 *  - OWNERSHIP IS PROVEN, NEVER ASSUMED. `idInPlan` alone does not identify a
 *    workout as ours: the counter can collide with pre-existing entities. A
 *    workout is only ever registered for deletion when its entity or program
 *    name starts with SPIKE_NAME, and that is re-checked immediately before
 *    every delete. A collision aborts the run instead of deleting.
 *  - Far-future dates (today +21/+22/+23) so a leftover is unambiguous and
 *    never collides with real training.
 *  - Self-cleaning: created entities are drained until every one is verified
 *    gone, then the whole window is compared against the baseline snapshot
 *    (PASS/FAIL restoration line).
 *  - Fail safe: any unexpected error, and SIGINT, stop further writes, drain
 *    what exists, run the restoration read, and print the exact account state
 *    before exiting.
 *
 * Run with: pnpm coros:spike:create
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
import { CorosClient, type CorosProgramMetrics, type CorosRegion } from "./coros-client.js";
import { createPrompter } from "./prompt.js";
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
  /** The idInPlan the spike CLAIMED. The server may ignore it entirely. */
  idInPlan?: number;
  /** The idInPlan the server actually stored it under, recovered by stamp. */
  serverIdInPlan?: string;
  /** How the candidate idInPlan was derived, for post-mortem reading. */
  idInPlanDerivedFrom?: { counter: number; observedMax: number };
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
    /** The `maxIdInPlan` counter as the server reports it. May be 0/stale. */
    maxIdInPlan: number;
    /** Highest idInPlan actually observed on entities across the wide read. */
    observedMaxIdInPlan: number;
    /** False when the counter trails reality — seen live on template plans. */
    counterMaintained: boolean;
    /** idInPlan values carried by more than one entity (legal — see locate()). */
    duplicateIdInPlan: string[];
    observationWindowStart: string;
    observationWindowEnd: string;
    observedEntityCount: number;
    workoutCount: number;
    idInPlan: string[];
    windowStart: string;
    windowEnd: string;
  };
  /** "full" runs the create tests; the others never write. */
  mode: "full" | "cleanup-only" | "dry-run" | "inspect";
  /**
   * Raw wire dump for diagnosis. UNLIKE every other section of this report it
   * contains the user's real workout titles verbatim (that is its purpose), so
   * it is written to its own file and must not be committed.
   */
  inspect?: {
    warning: string;
    dates: string[];
    spanStart: string;
    spanEnd: string;
    planId?: string;
    planName?: string;
    maxIdInPlan: number;
    entityCountInSpan: number;
    /** Every plan whose rows the schedule read merged in, largest first. */
    plans: Array<{
      planId: string;
      entityCount: number;
      programCount: number;
      idInPlan: string[];
    }>;
    idInPlanOnDates: string[];
    /** Every entity whose happenDay is one of `dates`, with its programs. */
    onDates: Array<{ entity: unknown; programs: unknown[] }>;
    /** Every entity elsewhere in the plan sharing one of those idInPlan values. */
    sameIdElsewhere: Array<{ entity: unknown; programs: unknown[] }>;
  };
  /** Read-only inspection of every stamped workout across the whole plan. */
  dryRun?: {
    windowStart: string;
    windowEnd: string;
    /** The target plan — the one the spike would write to. */
    planId?: string;
    /** Every plan whose rows the schedule read merged in, largest first. */
    plans: Array<{
      planId: string;
      entityCount: number;
      programCount: number;
      idInPlan: string[];
    }>;
    /** One entry per stamped workout found. */
    stamped: Array<{
      stampName: string;
      date: string;
      planId: string;
      idInPlan: string;
      planProgramId: string;
      /** planProgramId is normally a copy of idInPlan; false means rewritten. */
      planProgramIdEqualsIdInPlan: boolean;
      entityId?: string;
      programId?: string;
      /** The stored program, so structural round-trip is checkable offline. */
      program?: {
        name?: string;
        sportType?: number;
        subType?: number;
        duration?: number;
        trainingLoad?: number;
        exerciseNum?: number;
        totalSets?: number;
        exercises: Array<Record<string, unknown>>;
      };
      /** Present means the program could not be found for this entity. */
      programMissing?: true;
    }>;
    /** Link keys resolving to both a spike program and someone else's. */
    ambiguousStamps: Array<{ idInPlan: string; planProgramId: string; date: string }>;
    /**
     * Unstamped workouts anywhere in the plan sharing planId+idInPlan with one
     * of the above — i.e. whether the delete triple uniquely addresses ours.
     */
    collisions: Array<{
      withStampName: string;
      planId: string;
      idInPlan: string;
      /** The colliding workout's own planProgramId. */
      planProgramId: string;
      date: string;
      /** True when the FULL delete triple matches: a delete cannot be sent. */
      fullTripleMatches: boolean;
    }>;
  };
  /** Pre-run sweep for stamped workouts left by an earlier run. */
  strays?: {
    windowStart: string;
    windowEnd: string;
    found: string[];
    removed: string[];
    failed: string[];
  };
  tests: Record<CreateTestName, CreateTestResult>;
  overall: {
    /** The account is back to the baseline entity set, with nothing orphaned. */
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
  /** Why the spike stopped issuing writes early (collision, SIGINT, error). */
  abortReason?: string;
  /** True only if the spike ran to completion AND the account was restored. */
  succeeded: boolean;
  failure?: string;
}

export interface CreateSpikeHandle {
  /** The live report object, mutated in place as the spike progresses. */
  report: CreateSpikeReport;
  /** Stop issuing NEW writes. Already-created entities are still cleaned up. */
  abort: (reason: string) => void;
  /** Drain: remove every registered entity until each is verified gone. */
  cleanup: () => Promise<void>;
  /** Restoration read + leftover/orphan summary. Runs at most once. */
  finalize: () => Promise<void>;
}

export interface CreateSpikeOptions {
  /** yyyy-mm-dd anchor; the spike writes at +21/+22/+23 and probes +40/+41. */
  today?: string;
  log?: (line: string) => void;
  /** Called once, early, so a CLI can bind abort/cleanup to SIGINT. */
  onStart?: (handle: CreateSpikeHandle) => void;
  /**
   * Plan-level create probe. OFF by default: on unexpected success it creates
   * a plan object that no known endpoint can delete. Opt in explicitly.
   */
  includePlanAddProbe?: boolean;
  /** Login → stray sweep → restoration count → report. No creates at all. */
  cleanupOnly?: boolean;
  /** Login → read-only plan-wide inspection of every stamped workout. */
  dryRun?: boolean;
  /** Login → read-only raw dump of the entities on these yyyy-mm-dd dates. */
  inspectDates?: string[];
}

export const INSPECT_WARNING =
  "CONTAINS REAL WORKOUT TITLES — diagnostic dump, do not commit this file";

/** Window the pre-run stray sweep scans for leftovers of earlier runs. */
const STRAY_SWEEP_FORWARD_DAYS = 60;

// ── Payload construction (research §(b) and §(d)) ────────────────────────────

/**
 * Ownership marker. Every program (and entity) the spike creates is named with
 * this prefix, and it is the ONLY thing that authorizes a delete. Loud enough
 * that a leftover is unmistakable in the COROS UI.
 */
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
 * `region` on plan/add. The only capture is from a CN-region script, which
 * sends `2`; the survey has no mapping for us/eu. Rather than guess a number,
 * send the client's own region value there and record the ambiguity.
 */
export const PLAN_ADD_REGION: Record<CorosRegion, number | string> = {
  cn: 2, // the one captured value (shenmiguo/scripts/coros.js:279-286)
  us: "us",
  eu: "eu",
};

/**
 * §(b) plan-level create body (`shenmiguo/scripts/coros.js:279-286`). Plan
 * templates are day-offset relative — `happenDay` is "" and `dayNo` carries
 * the offset — so the caller's intended calendar dates are recorded in the
 * report rather than encoded here.
 */
export function buildPlanAddBody(
  program: RawCorosProgram,
  totalDay: number,
  region: CorosRegion,
): unknown {
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
    region: PLAN_ADD_REGION[region],
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

/**
 * A single plan's rows, carved out of a schedule read.
 *
 * THE CENTRAL FACT: `/training/schedule/query` MERGES every plan on the
 * account into one response. A live account carried two — a COROS-authored
 * template the athlete follows, and the account's own (initially empty) plan
 * container that the spike's creates land in — and their `idInPlan` values
 * overlap freely, because the counter is per plan. Only the top-level `id`,
 * `name` and `maxIdInPlan` of the response describe the target plan.
 *
 * Every read-derived decision (derivation, occupancy, recovery, ownership,
 * cleanup, ambiguity) must therefore be made inside ONE plan. Reasoning over
 * the merged view is what produced every anomaly of the first two live runs:
 * a bogus "slot occupied" (another plan's id), an "accepted but not visible"
 * create (searching the merged view), and a stray sweep that found nothing.
 */
interface PlanView {
  planId: string;
  entities: RawCorosEntity[];
  programs: RawCorosProgram[];
}

/**
 * Rows belonging to `planId` only. Membership is an exact `planId` match —
 * a row of unknown provenance is never assumed to be ours.
 */
function planView(raw: RawCorosSchedule, planId: string): PlanView {
  return {
    planId,
    entities: (raw.entities ?? []).filter((e) => String(e.planId ?? "") === planId),
    programs: (raw.programs ?? []).filter((p) => String(p.planId ?? "") === planId),
  };
}

/** planId → what that plan contributed to a read. For diagnostics. */
export function planBreakdown(
  raw: RawCorosSchedule,
  /** Always listed, even contributing nothing — an empty target plan is the
   * live shape and must not vanish from the diagnosis. */
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
  for (const program of raw.programs ?? []) bucket(String(program.planId ?? "")).programs.push(program);
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
 * `idInPlan` identifies the PROGRAM-IN-PLAN within ONE plan, not the entity:
 * several entities of the same plan may reference one program and so share an
 * `idInPlan`. Returns the first placement, which is sound here only because
 * the spike always claims an id unused *in its target plan*.
 */
function locate(view: PlanView, idInPlan: string | number): Located | undefined {
  const entity = view.entities.find((e) => String(e.idInPlan) === String(idInPlan));
  if (!entity) return undefined;
  return { entity, program: programsFor(view, entity)[0], date: corosDayToLocalDate(entity.happenDay) };
}

// ── idInPlan derivation ─────────────────────────────────────────────────────

/**
 * How far either side of today the derivation read sweeps. A live plan was
 * observed reporting `maxIdInPlan: 0` while its entities carried ids up to 45,
 * so the counter cannot be trusted and the real maximum has to be observed
 * directly — across the plan's whole likely span, not just the ±30d window
 * used for the restoration comparison.
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

/**
 * Sweep the target plan's likely span and report both the server's counter
 * and the true maximum in use IN THAT PLAN. The next safe id is
 * `max(counter, observedMax) + 1`.
 */
export async function observeIdInPlan(
  client: CorosClient,
  today: string,
  planId: string,
): Promise<IdInPlanObservation> {
  const windows = observationWindows(today);
  let counter = 0;
  const seen: string[] = [];
  for (const [start, end] of windows) {
    const raw = await client.getRawSchedule(start, end);
    counter = Math.max(counter, Number(raw.maxIdInPlan ?? 0) || 0);
    // TARGET PLAN ONLY: another plan's ids say nothing about which id is free
    // in ours, and treating them as occupied is what blocked the first run.
    for (const entity of planView(raw, planId).entities) seen.push(String(entity.idInPlan));
  }
  const counts = new Map<string, number>();
  for (const id of seen) counts.set(id, (counts.get(id) ?? 0) + 1);
  const observedMax = seen.reduce((max, id) => Math.max(max, Number(id) || 0), 0);
  return {
    counter,
    observedMax,
    observedIds: [...counts.keys()].sort((a, b) => Number(a) - Number(b)),
    duplicates: [...counts.entries()]
      .filter(([, n]) => n > 1)
      .map(([id]) => id)
      .sort((a, b) => Number(a) - Number(b)),
    entityCount: seen.length,
    windowStart: windows[0]?.[0] ?? today,
    windowEnd: windows[windows.length - 1]?.[1] ?? today,
  };
}

/** The next id it is safe to claim: past the counter AND past reality. */
export function nextIdInPlan(observation: IdInPlanObservation): number {
  return Math.max(observation.counter, observation.observedMax) + 1;
}

/**
 * One merged view of the plan across the whole observation span. Required for
 * anything that reasons about deletion: a `status: 3` delete is **plan-wide**,
 * not window-scoped, so a colliding workout 200 days away is just as
 * destroyable as one next week — and invisible to a ±30 day read.
 */
export async function readFullSpan(
  client: CorosClient,
  today: string,
): Promise<RawCorosSchedule> {
  const merged: RawCorosSchedule = { entities: [], programs: [] };
  const seenPrograms = new Set<string>();
  for (const [start, end] of observationWindows(today)) {
    const raw = await client.getRawSchedule(start, end);
    merged.id ??= raw.id;
    merged.name ??= raw.name;
    merged.startDay ??= raw.startDay;
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
 * The ONLY authorization to delete: an entity **of the target plan** whose
 * plan-scoped program carries the stamp.
 *
 * The inspect dump settled which half of the stamp survives the round trip:
 * PROGRAM names come back verbatim, entity names do not. So ownership rests on
 * the program alone — and the old entity-name and unnamed-entity fallbacks are
 * gone, which also removes the residual misclassification risk they carried.
 */
function isSpikeOwned(found: Located): boolean {
  return isStampedName(found.program?.name);
}

/**
 * Every placement in this plan whose program carries the spike's stamp.
 *
 * A link key must resolve UNANIMOUSLY. If a stamped and an unstamped program
 * share it, the entity's real workout is genuinely ambiguous — claiming it
 * would let a delete take a workout we did not create — so nothing is claimed
 * and `stampAmbiguities` reports the situation instead of hiding it.
 */
function spikeStamped(view: PlanView): Located[] {
  const found: Located[] = [];
  for (const entity of view.entities) {
    const programs = programsFor(view, entity);
    if (programs.length === 0 || !programs.every((p) => isStampedName(p.name))) continue;
    found.push({ entity, program: programs[0], date: corosDayToLocalDate(entity.happenDay) });
  }
  return found;
}

/**
 * Entities whose link key resolves to BOTH stamped and unstamped programs.
 * Never actioned; always reported, because such an entity may be residue of
 * ours that cannot be safely removed.
 */
function stampAmbiguities(view: PlanView): Located[] {
  const out: Located[] = [];
  for (const entity of view.entities) {
    const programs = programsFor(view, entity);
    if (programs.length < 2) continue;
    if (!programs.some((p) => isStampedName(p.name))) continue;
    if (!programs.some((p) => !isStampedName(p.name))) continue;
    out.push({ entity, program: programs[0], date: corosDayToLocalDate(entity.happenDay) });
  }
  return out;
}

/** The stamped name carried by this placement's program. */
function stampOf(found: Located): string {
  return String(found.program?.name ?? "");
}

function isStampedName(name: unknown): boolean {
  return typeof name === "string" && name.startsWith(SPIKE_NAME);
}

/**
 * Programs linked to an entity by the entity's OWN link key, WITHIN ITS PLAN.
 * `planProgramId` is the field that points at the program-in-plan (usually a
 * copy of `idInPlan`, but not always); matching on `idInPlan` alone made an
 * entity whose `planProgramId` differed look program-less.
 */
function programsFor(view: PlanView, entity: RawCorosEntity): RawCorosProgram[] {
  const linkKey = String(entity.planProgramId ?? entity.idInPlan);
  return view.programs.filter((p) => String(p.idInPlan) === linkKey);
}

/** Everything in this plan the spike did NOT stamp — never touchable. */
function notSpikeStamped(view: PlanView): Located[] {
  const stamped = new Set(spikeStamped(view).map((f) => f.entity));
  return view.entities
    .filter((e) => !stamped.has(e))
    .map((entity) => ({
      entity,
      program: programsFor(view, entity).find((p) => !isStampedName(p.name)),
      date: corosDayToLocalDate(entity.happenDay),
    }));
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
function deleteWouldBeAmbiguous(view: PlanView, target: Located): Located | undefined {
  const key = (entity: RawCorosEntity): string =>
    [String(entity.idInPlan), String(entity.planProgramId ?? entity.idInPlan)].join("|");
  const targetKey = key(target.entity);
  const other = view.entities.find((e) => e !== target.entity && key(e) === targetKey);
  if (!other) return undefined;
  return {
    entity: other,
    program: programsFor(view, other).find((p) => !isStampedName(p.name)),
    date: corosDayToLocalDate(other.happenDay),
  };
}

function describeForeignForReport(found: Located): string {
  return `idInPlan ${String(found.entity.idInPlan)} date=${found.date} (foreign workout — title printed to console)`;
}

/** Console only: on the user's own terminal the title is what identifies it. */
function describeForeignForConsole(found: Located): string {
  const name = String(found.entity.name ?? found.program?.name ?? "(unnamed)");
  return `name="${name}" date=${found.date}`;
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
  test: CreateTestName | "stray";
  label: string;
  /** The exact stamped name — the recovery key, immune to renumbering. */
  stampName: string;
  date: string;
  /** What we asked for. The server may ignore it entirely. */
  claimedIdInPlan?: number;
  /** What the server actually stored it under, from the read-back. */
  serverIdInPlan?: string;
  planId: string;
  cleaned: boolean;
  attempts: number;
  /** Stop retrying: deleting would be ambiguous, or the stamp is gone. */
  abandoned: boolean;
  resultCode?: string;
  error?: string;
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

/** Bounded retries per entity so a hard failure cannot loop the drain. */
const MAX_CLEANUP_ATTEMPTS = 2;

/**
 * Core spike sequence, decoupled from the interactive CLI so it can be driven
 * against the mock server offline. Never throws: failures are recorded on the
 * returned report after cleanup and the restoration read have been attempted.
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
    mode:
      opts.inspectDates !== undefined
        ? "inspect"
        : opts.dryRun === true
          ? "dry-run"
          : opts.cleanupOnly === true
            ? "cleanup-only"
            : "full",
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
  const control = { aborted: false };
  /**
   * The plan the spike operates in — the account's own container, which is
   * what the top-level `id` of a schedule read names. Reads merge OTHER plans'
   * rows into the same response; scoping to this id is what keeps every
   * decision about them out of the picture.
   */
  let targetPlanId = "";
  const scope = (raw: RawCorosSchedule): PlanView => planView(raw, targetPlanId);
  let baselineIds: string[] = [];
  let baselineCount = 0;

  /** Stop issuing new writes. Cleanup deliberately ignores this flag. */
  const abort = (reason: string): void => {
    if (control.aborted) return;
    control.aborted = true;
    report.abortReason = reason;
    report.failure ??= reason;
    log(`\n!! ABORTING further writes: ${reason}`);
  };

  /**
   * The ONLY deletion path — used by both cleanup and the pre-run stray sweep.
   * Everything is driven by the stamp, never by a remembered id:
   *   1. read the window and find stamped placements matching this entry;
   *   2. none → already gone;
   *   3. refuse if the delete address is shared with unstamped content;
   *   4. delete each match by ITS OWN server-assigned ids;
   *   5. re-read: our stamp must be gone AND the unstamped count unchanged.
   */
  const matchesEntry = (view: PlanView, entry: CreatedEntity): Located[] =>
    spikeStamped(view).filter((f) => f.date === entry.date && stampOf(f) === entry.stampName);

  /**
   * Issue the deletes for one entry, given a PLAN-WIDE snapshot. Verification
   * happens after the whole pass, against a second plan-wide snapshot.
   *
   * The snapshot must span the whole plan, not the entry's own window: a
   * `status: 3` delete is addressed by (planId, idInPlan, planProgramId) and
   * is plan-wide, so a colliding workout 200 days out is just as destroyable
   * as one next week — and invisible to a ±30 day read.
   */
  const removeOne = async (entry: CreatedEntity, span: PlanView): Promise<void> => {
    entry.attempts += 1;
    const targets = matchesEntry(span, entry);
    if (targets.length === 0) {
      entry.cleaned = true;
      log(`  already gone: ${entry.label} (${entry.stampName}, ${entry.date})`);
      return;
    }
    for (const target of targets) {
      const clash = deleteWouldBeAmbiguous(span, target);
      if (clash) {
        // Sending this delete could take the user's workout with it.
        entry.abandoned = true;
        entry.error =
          `NOT deleted — its delete address (planId/idInPlan/planProgramId) is shared with` +
          ` ${describeForeignForReport(clash)}; remove it by hand in the COROS app`;
        log(
          `  !! ${entry.label} on ${entry.date}: delete address idInPlan=` +
            `${String(target.entity.idInPlan)} is shared with ${describeForeignForConsole(clash)}` +
            " — NOT deleted, remove it by hand",
        );
        return;
      }
      entry.serverIdInPlan = String(target.entity.idInPlan);
      const del = await client.removeScheduleEntity(
        target.entity.idInPlan,
        String(target.entity.planProgramId ?? target.entity.idInPlan),
        String(target.entity.planId ?? entry.planId),
      );
      entry.resultCode = del.result;
    }
  };

  /**
   * Drain loop: entries can be appended while a cleanup is already running
   * (an abort landing mid-create), so keep sweeping until nothing is pending.
   * Each pass takes one plan-wide snapshot before and one after, so both the
   * ambiguity guard and the "did we destroy anything" assertion see the whole
   * plan rather than a window.
   */
  const drain = async (): Promise<void> => {
    const pending = (): CreatedEntity[] =>
      created.filter((c) => !c.cleaned && !c.abandoned && c.attempts < MAX_CLEANUP_ATTEMPTS);
    if (created.length === 0) {
      log("Cleanup: nothing was created.");
      return;
    }
    while (pending().length > 0) {
      const batch = [...pending()].reverse(); // reverse creation order
      log(`Cleanup: removing ${batch.length} spike workout(s)…`);
      const span = scope(await readFullSpan(client, today));
      const foreignBefore = notSpikeStamped(span).length;
      for (const entry of batch) {
        try {
          await removeOne(entry, span);
        } catch (e) {
          entry.error = errText(e);
          log(`  !! CLEANUP ERROR: "${entry.stampName}" on ${entry.date} (${entry.error})`);
        }
      }
      const after = scope(await readFullSpan(client, today));
      const foreignAfter = notSpikeStamped(after).length;
      if (foreignAfter < foreignBefore) {
        // Must never happen — the ambiguity guard exists to prevent exactly this.
        const note = `DELETE REMOVED ${foreignBefore - foreignAfter} WORKOUT(S) THE SPIKE DID NOT CREATE`;
        log(`  !!!! ${note} — check your COROS calendar`);
        if (!report.overall.leftovers.includes(note)) report.overall.leftovers.push(note);
      }
      for (const entry of batch) {
        if (entry.abandoned) continue;
        const still = matchesEntry(after, entry);
        entry.cleaned = still.length === 0;
        if (still.length > 0) {
          entry.error ??= `delete returned ${entry.resultCode ?? "-"} but the workout is still on ${entry.date}`;
          log(`  !! NOT REMOVED: ${entry.label} ("${entry.stampName}", ${entry.date})`);
        } else {
          log(
            `  removed ${entry.label} ("${entry.stampName}", ${entry.date}` +
              `${entry.serverIdInPlan ? `, server idInPlan ${entry.serverIdInPlan}` : ""})`,
          );
        }
      }
    }
    for (const name of Object.keys(report.tests) as CreateTestName[]) {
      const mine = created.filter((c) => c.test === name);
      if (mine.length === 0) continue;
      report.tests[name].cleanedUp = mine.every((c) => c.cleaned);
      report.tests[name].cleanupResultCode ??= mine.find((c) => c.resultCode)?.resultCode;
    }
    for (const entry of created.filter((c) => !c.cleaned)) {
      log(
        `  !! LEFT BEHIND: "${entry.stampName}" on ${entry.date}` +
          (entry.serverIdInPlan ? ` (server idInPlan ${entry.serverIdInPlan})` : "") +
          ` — delete it by name in the COROS app`,
      );
    }
  };

  let cleanupInFlight: Promise<void> | null = null;
  const cleanup = async (): Promise<void> => {
    // Serialize concurrent callers (SIGINT arriving during the normal
    // cleanup), then run again so late registrations are drained too.
    if (cleanupInFlight) await cleanupInFlight.catch(() => undefined);
    const run = drain();
    cleanupInFlight = run;
    try {
      await run;
    } finally {
      if (cleanupInFlight === run) cleanupInFlight = null;
    }
  };

  let finalized = false;
  const finalize = async (): Promise<void> => {
    if (finalized) return;
    finalized = true;

    // An orphan plan object means the probe did not clean up after itself,
    // whatever the entity-level drain concluded.
    if (report.overall.orphanPlanIds.length > 0) report.tests.planAdd.cleanedUp = false;

    // A link key that resolves to both a stamped and an unstamped program is
    // potential residue of ours that cannot be safely acted on — say so.
    try {
      const ambiguous = stampAmbiguities(scope(await readFullSpan(client, today)));
      for (const item of ambiguous) {
        const note =
          `AMBIGUOUS STAMP: idInPlan ${String(item.entity.idInPlan)} on ${item.date} resolves to` +
          " both a spike program and one the spike did not create — not actioned; check by hand";
        if (!report.overall.leftovers.includes(note)) report.overall.leftovers.push(note);
        log(`  !! ${note}`);
      }
    } catch {
      // Best effort: the restoration read below is the authoritative check.
    }

    const catastrophes = report.overall.leftovers.filter(
      (l) => l.startsWith("DELETE REMOVED") || l.startsWith("AMBIGUOUS STAMP"),
    );
    report.overall.leftovers = [
      ...catastrophes,
      ...created
        .filter((c) => !c.cleaned)
        .map(
          (c) =>
            `"${c.stampName}" on ${c.date}` +
            (c.serverIdInPlan ? ` (server idInPlan ${c.serverIdInPlan})` : "") +
            (c.claimedIdInPlan !== undefined ? ` [claimed ${c.claimedIdInPlan}]` : "") +
            (c.error ? ` — ${c.error}` : ""),
        ),
    ];

    try {
      const final = await readWindow();
      const finalIds = idInPlanSet(final);
      report.overall.finalWorkoutCount = finalIds.length;
      const sameSet =
        finalIds.length === baselineCount && finalIds.join(",") === baselineIds.join(",");
      // An orphaned plan object is also "not restored" — it is account state
      // the spike created and cannot remove.
      report.overall.baselineRestored =
        sameSet &&
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

    if (report.overall.leftovers.length > 0) {
      log("");
      log("!! ACTION REQUIRED — the spike could not remove:");
      for (const l of report.overall.leftovers) log(`     ${l}`);
      log(`   They are all named "${SPIKE_NAME}" in the COROS app.`);
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
  };

  opts.onStart?.({ report, abort, cleanup, finalize });

  try {
    if (opts.inspectDates !== undefined) {
      await runInspect(client, today, opts.inspectDates, report, log);
      for (const test of Object.values(report.tests)) test.cleanedUp = true;
      baselineIds = idInPlanSet(await readWindow());
      baselineCount = baselineIds.length;
      await finalize();
      return report;
    }

    if (opts.dryRun === true) {
      await runDryRun(client, today, report, log);
      for (const test of Object.values(report.tests)) test.cleanedUp = true;
      baselineIds = idInPlanSet(await readWindow());
      baselineCount = baselineIds.length;
      await finalize();
      return report;
    }

    // ── 1. Stray sweep — BEFORE the baseline, so the baseline is the clean
    //      state the account must be returned to. ─────────────────────────────
    log("Step 1: sweeping for workouts left behind by an earlier run…");
    const strayStart = today;
    const strayEnd = addDays(today, STRAY_SWEEP_FORWARD_DAYS);
    if (opts.cleanupOnly === true) {
      // Snapshot BEFORE the sweep, so the restoration line means something:
      // "the account changed by exactly the strays we removed".
      const preSweep = await readWindow();
      baselineIds = idInPlanSet(preSweep);
      baselineCount = baselineIds.length;
    }
    report.strays = {
      windowStart: strayStart,
      windowEnd: strayEnd,
      found: [],
      removed: [],
      failed: [],
    };
    const strayScan = await client.getRawSchedule(strayStart, strayEnd);
    // The response's top-level id names the TARGET plan; other plans' rows are
    // merged into the same payload and must be scoped out of every decision.
    targetPlanId = String(strayScan.id ?? "");
    if (targetPlanId === "") {
      throw new Error(
        "no active plan id in the schedule read — cannot scope safely, refusing to write",
      );
    }
    const plans = planBreakdown(strayScan, targetPlanId);
    log(`  target plan ${targetPlanId}; the read merges ${plans.length} plan(s):`);
    for (const plan of plans) {
      log(
        `    planId=${plan.planId || "(none)"} entities=${plan.entityCount}` +
          `${plan.planId === targetPlanId ? "  ← target" : ""}`,
      );
    }
    const strays = spikeStamped(scope(strayScan));
    if (strays.length === 0) {
      log("  none found.");
    } else {
      log(`  found ${strays.length} stamped workout(s) from an earlier run:`);
      for (const stray of strays) {
        const describe = `"${stampOf(stray)}" on ${stray.date} (server idInPlan ${String(stray.entity.idInPlan)})`;
        report.strays.found.push(describe);
        log(`    ${describe}`);
        created.push({
          test: "stray",
          label: "stray from an earlier run",
          stampName: stampOf(stray),
          date: stray.date,
          serverIdInPlan: String(stray.entity.idInPlan),
          planId: String(stray.entity.planId ?? strayScan.id ?? ""),
          cleaned: false,
          attempts: 0,
          abandoned: false,
        });
      }
      await cleanup();
      for (const entry of created.filter((c) => c.test === "stray")) {
        const describe = `"${entry.stampName}" on ${entry.date}`;
        if (entry.cleaned) report.strays.removed.push(describe);
        else report.strays.failed.push(`${describe}${entry.error ? ` — ${entry.error}` : ""}`);
      }
      log(
        `  swept: ${report.strays.removed.length} removed, ${report.strays.failed.length} could not be removed.`,
      );
    }

    if (opts.cleanupOnly === true) {
      log("\nCleanup-only mode: no workouts were created.");
      report.tests.strength.notes.push("cleanup-only mode: no create attempted");
      report.tests.run.notes.push("cleanup-only mode: no create attempted");
      report.tests.bike.notes.push("cleanup-only mode: no create attempted");
      report.tests.planAdd.notes.push("cleanup-only mode: no probe attempted");
      for (const test of Object.values(report.tests)) test.cleanedUp = true;
      const remaining = scope(await readFullSpan(client, today));
      const stillStamped = spikeStamped(remaining);
      const nowIds = idInPlanSet(await readWindow());
      report.overall.finalWorkoutCount = nowIds.length;
      log(
        `Account held ${baselineCount} workouts in ±30 days before the sweep,` +
          ` ${nowIds.length} after; ${stillStamped.length} spike-stamped workout(s) remain` +
          ` across ${observationWindows(today)[0]?.[0]}…${addDays(today, OBSERVE_FORWARD_DAYS)}.`,
      );
      // "Restored" here means: nothing stamped is left behind. The workout
      // count is EXPECTED to drop by exactly the number of strays removed.
      baselineIds = nowIds;
      baselineCount = nowIds.length;
      await finalize();
      return report;
    }

    // ── 2. Baseline snapshot (post-sweep) ───────────────────────────────────
    log("\nStep 2: fresh schedule read (baseline snapshot, ±30 days)…");
    const baseline = await readWindow();
    const planId = String(baseline.id ?? targetPlanId);
    const planStartDay = baseline.startDay != null ? Number(baseline.startDay) : undefined;
    const maxIdInPlan = Number(baseline.maxIdInPlan ?? 0);
    baselineIds = idInPlanSet(baseline);
    baselineCount = baselineIds.length;

    // The counter alone is not trustworthy: a live template plan reported
    // maxIdInPlan 0 while its entities carried ids up to 45. Observe the real
    // maximum across the plan's whole likely span before deriving anything.
    log("  observing idInPlan usage across the plan's full span…");
    const observation = await observeIdInPlan(client, today, targetPlanId);
    report.baseline = {
      planName: typeof baseline.name === "string" ? baseline.name : undefined,
      planIdPresent: planId !== "",
      maxIdInPlan,
      observedMaxIdInPlan: observation.observedMax,
      counterMaintained: observation.counter >= observation.observedMax,
      duplicateIdInPlan: observation.duplicates,
      observationWindowStart: observation.windowStart,
      observationWindowEnd: observation.windowEnd,
      observedEntityCount: observation.entityCount,
      workoutCount: baselineCount,
      idInPlan: baselineIds,
      windowStart,
      windowEnd,
    };
    log(
      `  plan="${report.baseline.planName ?? "(none)"}" workouts=${baselineCount}` +
        ` maxIdInPlan(counter)=${observation.counter} maxIdInPlan(observed)=${observation.observedMax}` +
        ` → next candidate ${nextIdInPlan(observation)}`,
    );
    if (!report.baseline.counterMaintained) {
      log(
        `  NOTE: this plan does not maintain maxIdInPlan (counter=${observation.counter} <` +
          ` observed=${observation.observedMax}); deriving ids from observation.`,
      );
      report.tests.strength.notes.push(
        `plan does not maintain maxIdInPlan (counter=${observation.counter}, observed=${observation.observedMax})`,
      );
    }
    if (observation.duplicates.length > 0) {
      log(
        `  NOTE: idInPlan values reused by multiple entities: ${observation.duplicates.join(", ")}` +
          " (idInPlan identifies the program-in-plan, not the entity)",
      );
    }
    if (planId === "") {
      report.tests.strength.notes.push(
        'no active plan in the window; using planId "" (server auto-targets/auto-creates)',
      );
    }

    const ctx: SpikeContext = {
      client,
      log,
      today,
      targetPlanId,
      scope,
      readWindow,
      windowStart,
      windowEnd,
      created,
      report,
      planId,
      planStartDay,
      control,
      abort,
    };

    // ── 2. TEST A — strength from scratch ───────────────────────────────────
    log("\nStep 3: TEST A — strength create from scratch (sportType 4)…");
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
    log("\nStep 4: TEST B — minimal run create (2 blocks, no group, no cooldown)…");
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
    log("\nStep 5: TEST C — bike create probe (uncaptured in the survey; may fail)…");
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

    // ── 5. Cleanup of A/B/C — BEFORE the plan probe, so the schedule is back
    //      to baseline before anything plan-level is attempted. ─────────────
    log("\nStep 6: cleanup of the created workouts…");
    await cleanup();

    // ── 6. TEST D — plan/add probe (opt-in only) ────────────────────────────
    const probeRequested = opts.includePlanAddProbe === true;
    if (!probeRequested) {
      report.tests.planAdd.cleanedUp = true;
      report.tests.planAdd.notes.push("not requested (opt-in only; off by default)");
    } else if (control.aborted) {
      report.tests.planAdd.cleanedUp = true;
      report.tests.planAdd.notes.push("skipped: the spike aborted before the probe");
    } else {
      log("\nStep 7: TEST D — plan-level create probe (POST /training/plan/add)…");
      await runPlanAddProbe(ctx, today);
      await cleanup();
    }
  } catch (e) {
    report.failure ??= errText(e);
    log(`\nSPIKE FAILED: ${errText(e)}`);
    log("Attempting cleanup of everything created so far…");
    await cleanup().catch(() => undefined);
  }

  await finalize();
  return report;
}

/**
 * READ-ONLY raw dump for diagnosis. The stamp-ownership model rests on the
 * server round-tripping the names we write; a live dry run found zero stamped
 * workouts on a plan that demonstrably held our creates. This mode shows the
 * wire truth: every field of every entity and program on the given dates, and
 * every entity elsewhere in the plan sharing those `idInPlan` values, so the
 * strays can be compared field-by-field against the real workouts beside them.
 *
 * Issues zero writes. `stripUserIds` is the ONLY redaction — real titles are
 * present on purpose, which is why the report goes to its own file.
 */
async function runInspect(
  client: CorosClient,
  today: string,
  dates: string[],
  report: CreateSpikeReport,
  log: (line: string) => void,
): Promise<void> {
  const windows = observationWindows(today);
  const spanStart = windows[0]?.[0] ?? today;
  const spanEnd = windows[windows.length - 1]?.[1] ?? today;
  log(`Inspect: reading ${spanStart} … ${spanEnd} (read-only, no writes)…`);
  log(`  dates: ${dates.join(", ")}`);

  const span = await readFullSpan(client, today);
  const entities = span.entities ?? [];
  const onDates = entities.filter((e) => dates.includes(corosDayToLocalDate(e.happenDay)));
  const idsOnDates = new Set(onDates.map((e) => String(e.idInPlan)));
  const sameIdElsewhere = entities.filter(
    (e) => !onDates.includes(e) && idsOnDates.has(String(e.idInPlan)),
  );

  /** Programs reachable from this entity by EITHER key — show both truths. */
  const programsOf = (entity: RawCorosEntity): unknown[] => {
    const keys = new Set([String(entity.idInPlan), String(entity.planProgramId ?? entity.idInPlan)]);
    return (span.programs ?? [])
      .filter((p) => keys.has(String(p.idInPlan)))
      .map((p) => stripUserIds(p));
  };
  const dump = (entity: RawCorosEntity): { entity: unknown; programs: unknown[] } => ({
    entity: stripUserIds(entity),
    programs: programsOf(entity),
  });

  report.inspect = {
    warning: INSPECT_WARNING,
    dates,
    spanStart,
    spanEnd,
    planId: span.id != null ? String(span.id) : undefined,
    planName: typeof span.name === "string" ? span.name : undefined,
    maxIdInPlan: Number(span.maxIdInPlan ?? 0),
    entityCountInSpan: entities.length,
    plans: planBreakdown(span, String(span.id ?? "")),
    idInPlanOnDates: [...idsOnDates].sort((a, b) => Number(a) - Number(b)),
    onDates: onDates.map(dump),
    sameIdElsewhere: sameIdElsewhere.map(dump),
  };

  log(
    `  plan="${report.inspect.planName ?? "(none)"}" planId=${report.inspect.planId ?? "-"}` +
      ` maxIdInPlan=${report.inspect.maxIdInPlan} entitiesInSpan=${entities.length}`,
  );
  log(`  the read merges ${report.inspect.plans.length} plan(s):`);
  for (const plan of report.inspect.plans) {
    log(
      `    planId=${plan.planId || "(none)"} entities=${plan.entityCount}` +
        ` programs=${plan.programCount}` +
        `${plan.planId === report.inspect.planId ? "  ← target" : ""}` +
        ` ids=[${plan.idInPlan.join(",")}]`,
    );
  }
  log(`\n  ── ${onDates.length} entit(ies) on the requested dates ──`);
  for (const item of report.inspect.onDates) {
    log(`  ENTITY: ${JSON.stringify(item.entity, null, 2)}`);
    log(`  PROGRAMS (${item.programs.length}): ${JSON.stringify(item.programs, null, 2)}`);
    log("");
  }
  log(
    `  ── ${sameIdElsewhere.length} entit(ies) elsewhere sharing idInPlan` +
      ` ${report.inspect.idInPlanOnDates.join(", ") || "(none)"} ──`,
  );
  for (const item of report.inspect.sameIdElsewhere) {
    log(`  ENTITY: ${JSON.stringify(item.entity, null, 2)}`);
    log(`  PROGRAMS (${item.programs.length}): ${JSON.stringify(item.programs, null, 2)}`);
    log("");
  }
  log(`  !! ${INSPECT_WARNING}`);
}

/** The exercise fields that decide structural round-trip (research §(d)). */
const DRY_RUN_EXERCISE_FIELDS = [
  "id",
  "name",
  "exerciseType",
  "targetType",
  "targetValue",
  "sets",
  "intensityType",
  "intensityValue",
  "intensityPercent",
  "intensityDisplayUnit",
  "intensityCustom",
  "originId",
  "groupId",
  "isGroup",
  "sortNo",
  "restType",
  "restValue",
] as const;

/**
 * READ-ONLY inspection: what does the account actually hold under the spike's
 * stamp, and does the delete triple address it uniquely? Issues zero writes.
 */
async function runDryRun(
  client: CorosClient,
  today: string,
  report: CreateSpikeReport,
  log: (line: string) => void,
): Promise<void> {
  const windows = observationWindows(today);
  const windowStart = windows[0]?.[0] ?? today;
  const windowEnd = windows[windows.length - 1]?.[1] ?? today;
  log(`Dry run: reading ${windowStart} … ${windowEnd} (read-only, no writes)…`);

  const raw = await readFullSpan(client, today);
  const targetPlanId = String(raw.id ?? "");
  const span = planView(raw, targetPlanId);
  const stamped = spikeStamped(span);
  const unstamped = notSpikeStamped(span);
  const plans = planBreakdown(raw, targetPlanId);
  const dry: NonNullable<CreateSpikeReport["dryRun"]> = {
    windowStart,
    windowEnd,
    planId: targetPlanId !== "" ? targetPlanId : undefined,
    plans,
    stamped: [],
    collisions: [],
    ambiguousStamps: stampAmbiguities(span).map((a) => ({
      idInPlan: String(a.entity.idInPlan),
      planProgramId: String(a.entity.planProgramId ?? a.entity.idInPlan),
      date: a.date,
    })),
  };
  report.dryRun = dry;

  // A schedule read merges every plan on the account; say so plainly, because
  // a multi-plan account is what made the earlier runs unreadable.
  log(`  the read merges ${plans.length} plan(s); target is ${targetPlanId || "(none)"}:`);
  for (const plan of plans) {
    log(
      `    planId=${plan.planId || "(none)"} entities=${plan.entityCount}` +
        ` programs=${plan.programCount}${plan.planId === targetPlanId ? "  ← target" : ""}`,
    );
  }
  log(`  ${stamped.length} spike-stamped workout(s) in the target plan.`);
  for (const found of stamped) {
    const idInPlan = String(found.entity.idInPlan);
    const planProgramId = String(found.entity.planProgramId ?? idInPlan);
    const planId = String(found.entity.planId ?? targetPlanId);
    const entry: NonNullable<CreateSpikeReport["dryRun"]>["stamped"][number] = {
      stampName: stampOf(found),
      date: found.date,
      planId,
      idInPlan,
      planProgramId,
      planProgramIdEqualsIdInPlan: planProgramId === idInPlan,
      entityId: found.entity.id != null ? String(found.entity.id) : undefined,
      programId: found.program?.id != null ? String(found.program.id) : undefined,
    };
    if (found.program) {
      entry.program = {
        name: typeof found.program.name === "string" ? found.program.name : undefined,
        sportType: found.program.sportType,
        subType: found.program.subType,
        duration: found.program.duration,
        trainingLoad: found.program.trainingLoad,
        exerciseNum:
          typeof found.program.exerciseNum === "number" ? found.program.exerciseNum : undefined,
        totalSets: typeof found.program.totalSets === "number" ? found.program.totalSets : undefined,
        exercises: (found.program.exercises ?? []).map((exercise) => {
          const out: Record<string, unknown> = {};
          for (const field of DRY_RUN_EXERCISE_FIELDS) {
            const value = (exercise as Record<string, unknown>)[field];
            if (value !== undefined) out[field] = value;
          }
          return out;
        }),
      };
    } else {
      entry.programMissing = true;
    }
    dry.stamped.push(entry);
    log(
      `    "${entry.stampName}" ${entry.date}  planId=${entry.planId}` +
        ` idInPlan=${entry.idInPlan} planProgramId=${entry.planProgramId}` +
        `${entry.planProgramIdEqualsIdInPlan ? "" : " (REWRITTEN — differs from idInPlan)"}`,
    );
    if (entry.program) {
      log(
        `      program sportType=${entry.program.sportType ?? "-"} subType=${entry.program.subType ?? "-"}` +
          ` duration=${entry.program.duration ?? "-"} load=${entry.program.trainingLoad ?? "-"}` +
          ` exercises=${entry.program.exercises.length}`,
      );
      for (const exercise of entry.program.exercises) {
        log(
          `        exerciseType=${String(exercise.exerciseType ?? "-")}` +
            ` targetType=${String(exercise.targetType ?? "-")}` +
            ` targetValue=${String(exercise.targetValue ?? "-")}` +
            ` sets=${String(exercise.sets ?? "-")}` +
            ` intensityType=${String(exercise.intensityType ?? "-")}` +
            ` intensityValue=${JSON.stringify(exercise.intensityValue ?? null)}` +
            ` originId=${String(exercise.originId ?? "-")}`,
        );
      }
    } else {
      log("      program MISSING from the response");
    }

    // Does the delete triple address ours uniquely?
    for (const other of unstamped) {
      const otherPlanId = String(other.entity.planId ?? targetPlanId);
      const otherIdInPlan = String(other.entity.idInPlan);
      if (otherPlanId !== planId || otherIdInPlan !== idInPlan) continue;
      const otherPlanProgramId = String(other.entity.planProgramId ?? otherIdInPlan);
      const fullTripleMatches = otherPlanProgramId === planProgramId;
      dry.collisions.push({
        withStampName: entry.stampName,
        planId: otherPlanId,
        idInPlan: otherIdInPlan,
        planProgramId: otherPlanProgramId,
        date: other.date,
        fullTripleMatches,
      });
      log(
        `      COLLISION: an unstamped workout on ${other.date} shares planId+idInPlan` +
          ` (its planProgramId=${otherPlanProgramId})` +
          `${fullTripleMatches ? " — FULL TRIPLE MATCHES: a delete cannot be sent safely" : " — triple differs, delete is addressable"}`,
      );
    }
  }

  if (dry.ambiguousStamps.length > 0) {
    log(
      `  !! ${dry.ambiguousStamps.length} ambiguous stamp(s): a link key resolves to both a` +
        " spike program and one the spike did not create — those are never actioned.",
    );
  }
  if (dry.collisions.length === 0) {
    log("  no id collisions: every stamped workout is uniquely addressable for delete.");
  } else {
    const blocking = dry.collisions.filter((c) => c.fullTripleMatches).length;
    log(
      `  ${dry.collisions.length} collision(s), ${blocking} of which block a safe delete.`,
    );
  }
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
  today: string;
  /** The plan the spike writes to; every read is scoped to it. */
  targetPlanId: string;
  scope: (raw: RawCorosSchedule) => PlanView;
  readWindow: () => Promise<RawCorosSchedule>;
  windowStart: string;
  windowEnd: string;
  created: CreatedEntity[];
  report: CreateSpikeReport;
  planId: string;
  planStartDay?: number;
  control: { aborted: boolean };
  abort: (reason: string) => void;
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
 * One create test: abort check → fresh maxIdInPlan read → calculate-then-add →
 * abort check → status:1 → read-after-write → OWNERSHIP GUARD → registration →
 * structural verify. Nothing is ever registered (and therefore nothing is ever
 * deleted) unless the read-back workout carries the spike's own name.
 */
async function createAndVerify(
  ctx: SpikeContext,
  result: CreateTestResult,
  spec: CreateSpec,
): Promise<void> {
  if (ctx.control.aborted) {
    result.notes.push("skipped: the spike aborted before this test");
    result.cleanedUp = true;
    ctx.log(`  skipped (${ctx.report.abortReason ?? "aborted"})`);
    return;
  }
  result.attempted = true;
  result.scheduledDate = spec.date;

  // Fresh derivation immediately before every write: read-then-write is racy
  // (§4.4 point 3), AND the server's counter may simply not be maintained —
  // observed live at 0 on a plan whose entities ran up to 45. So sweep the
  // full span and take max(counter, observed) + 1 each time.
  const observation = await observeIdInPlan(ctx.client, ctx.today, ctx.targetPlanId);
  const idInPlan = nextIdInPlan(observation);
  const freshRaw = await ctx.readWindow();
  const fresh = ctx.scope(freshRaw);
  const planId = String(freshRaw.id ?? ctx.planId);
  result.idInPlan = idInPlan;
  result.idInPlanDerivedFrom = {
    counter: observation.counter,
    observedMax: observation.observedMax,
  };
  ctx.log(
    `  idInPlan: counter=${observation.counter} observed=${observation.observedMax}` +
      ` → claiming ${idInPlan}`,
  );

  // Final gate: the slot we are about to claim must be empty. The derivation
  // above already excludes every id it saw, so an occupant here means
  // something landed between the observation and now — a genuine race.
  const occupant = locate(fresh, idInPlan);
  if (occupant) {
    result.verified = false;
    result.cleanedUp = true; // nothing created
    const detail = `idInPlan ${idInPlan} (derived from counter=${observation.counter}, observed=${observation.observedMax}) is already occupied: ${describeForeignForReport(occupant)}`;
    result.notes.push(`${detail} — no write attempted`);
    ctx.log(`  slot already occupied by ${describeForeignForConsole(occupant)}`);
    ctx.abort(`${detail}; refusing to write or delete`);
    return;
  }

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

  // Second abort check: the run may have been aborted while calculate was
  // in flight (SIGINT). No new writes once aborted.
  if (ctx.control.aborted) {
    result.notes.push("aborted before the write; nothing was created");
    result.cleanedUp = true;
    ctx.log("  aborted before the write — nothing created");
    return;
  }

  let add;
  try {
    add = await ctx.client.addScheduleEntity(entity, program, idInPlan, planId);
    result.resultCode = add.result;
    ctx.log(`  status:1 create at ${spec.date} → result=${add.result}`);
  } catch (e) {
    // Network failure mid-write: state unknown. The read below decides, and
    // anything of OURS that is visible gets registered for cleanup.
    result.error = errText(e);
    result.notes.push("create threw mid-write; read-after-write decides");
    ctx.log(`  status:1 create threw (${errText(e)}) — reading back`);
  }

  // ── RECOVERY BY STAMP ─────────────────────────────────────────────────────
  // NOT by the claimed idInPlan: a live account was observed reassigning it on
  // create (claimed 49, stored elsewhere), which left the created workouts
  // unrecoverable and therefore uncleaned. The stamp we wrote is the only
  // ownership proof that survives server renumbering.
  const afterRaw = await ctx.readWindow();
  const after = ctx.scope(afterRaw);
  const stampName = String(program.name ?? SPIKE_NAME);
  const matches = spikeStamped(after).filter(
    (f) => f.date === spec.date && stampOf(f) === stampName,
  );
  const found = matches[0];

  if (found) {
    // Register for cleanup BEFORE judging success — a rejected-but-materialized
    // create must still be removed. Every match is registered under one entry;
    // removeOne re-finds them all by stamp and removes each by its own ids.
    ctx.created.push({
      test: spec.test,
      label: spec.label,
      stampName,
      date: found.date,
      claimedIdInPlan: idInPlan,
      serverIdInPlan: String(found.entity.idInPlan),
      planId: String(found.entity.planId ?? afterRaw.id ?? planId),
      cleaned: false,
      attempts: 0,
      abandoned: false,
    });
    result.observedDate = found.date;
    result.serverIdInPlan = String(found.entity.idInPlan);
    result.serverIds = {
      planId: afterRaw.id != null ? String(afterRaw.id) : undefined,
      entityId: found.entity.id != null ? String(found.entity.id) : undefined,
      programId: found.program?.id != null ? String(found.program.id) : undefined,
    };
    result.serverRecomputed = {
      duration: typeof found.program?.duration === "number" ? found.program.duration : undefined,
      trainingLoad:
        typeof found.program?.trainingLoad === "number" ? found.program.trainingLoad : undefined,
      distance: found.program?.distance,
    };
    if (String(found.entity.idInPlan) !== String(idInPlan)) {
      result.notes.push(
        `server REASSIGNED idInPlan: claimed ${idInPlan}, stored as ${String(found.entity.idInPlan)}` +
          " — recovered by stamp, not by id",
      );
      ctx.log(
        `  server reassigned idInPlan: claimed ${idInPlan} → stored ${String(found.entity.idInPlan)}`,
      );
    }
    if (matches.length > 1) {
      result.notes.push(
        `${matches.length} workouts carry this stamp on ${spec.date}; all will be removed`,
      );
    }
  }

  if (add === undefined || !add.ok) {
    result.verified = false;
    result.notes.push(
      found
        ? "server rejected the create but the spike's workout materialized — will be cleaned up"
        : "server rejected the create; nothing materialized",
    );
    if (add !== undefined) {
      // A rejection of a correctly-derived id is itself the answer: the server
      // may enforce its own id allocation. Record it; never retry other ids —
      // guessing at a shared counter is exactly how a spike overwrites a real
      // workout.
      result.notes.push(
        `rejected result=${add.result} for idInPlan ${idInPlan}` +
          ` (counter=${observation.counter}, observed=${observation.observedMax});` +
          " not retrying with other ids — the server may allocate ids itself",
      );
    }
    if (!found) result.cleanedUp = true; // nothing to clean
    ctx.log(`  NOT CREATED (result=${result.resultCode ?? "threw"}) — not retrying other ids`);
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
  if (found.date !== spec.date) {
    // Ours, so it is still registered for cleanup — but the server put it
    // somewhere we did not ask for. Stop before writing anything else.
    result.notes.push(`landed on ${found.date}, expected ${spec.date}`);
    ctx.abort(`spike workout landed on ${found.date} instead of ${spec.date}`);
  }
}

/**
 * One-shot plan-level create probe, run only after A/B/C have been cleaned up.
 * Expected to be rejected (1031 outside CN). On unexpected success it sweeps
 * the probe window for NEW entities — and, exactly like the create path, only
 * registers the ones carrying the spike's own name. A plan object it cannot
 * delete is recorded loudly, never silently.
 */
async function runPlanAddProbe(ctx: SpikeContext, today: string): Promise<void> {
  const result = ctx.report.tests.planAdd;
  result.attempted = true;
  const probeStart = addDays(today, 40);
  const probeEnd = addDays(today, 41);
  const sweepStart = addDays(today, 30);
  const sweepEnd = addDays(today, 60);
  result.scheduledDate = probeStart;
  result.notes.push(
    `plan templates are day-offset relative (happenDay ""); intended anchor ${probeStart}..${probeEnd}`,
  );
  result.notes.push(
    `region sent as ${JSON.stringify(PLAN_ADD_REGION[ctx.client.region])} — only the CN wire value (2) is documented; us/eu are unknown`,
  );

  const probeWindow = (): Promise<RawCorosSchedule> =>
    ctx.client.getRawSchedule(sweepStart, sweepEnd);

  let before: RawCorosSchedule;
  try {
    before = await probeWindow();
  } catch (e) {
    result.error = `pre-probe read failed: ${errText(e)}`;
    result.cleanedUp = true;
    return;
  }
  const beforeIds = new Set(ctx.scope(before).entities.map((e) => String(e.idInPlan)));
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
  const body = buildPlanAddBody(program, 2, ctx.client.region);
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
  ctx.log("  !! plan/add SUCCEEDED unexpectedly — sweeping for what it created");

  const newPlanId = extractPlanId(res.data);
  if (newPlanId) result.serverIds = { planId: newPlanId };

  try {
    const afterRaw = await probeWindow();
    const after = ctx.scope(afterRaw);
    const appeared = after.entities.filter((e) => !beforeIds.has(String(e.idInPlan)));
    ctx.log(`  ${appeared.length} new schedule entit(ies) appeared in the probe window`);
    // Same rule as the create path, in the target plan only: a placement is
    // ours when its plan-scoped program carries the stamp.
    const stamped = spikeStamped(after);
    for (const entity of appeared) {
      const mine = stamped.find((f) => f.entity === entity);
      if (!mine) {
        const located: Located = {
          entity,
          program: after.programs.find(
            (p) => String(p.idInPlan) === String(entity.planProgramId ?? entity.idInPlan),
          ),
          date: corosDayToLocalDate(entity.happenDay),
        };
        result.notes.push(
          `left untouched (not created by the spike): ${describeForeignForReport(located)}`,
        );
        ctx.log(`  leaving untouched (not ours): ${describeForeignForConsole(located)}`);
        continue;
      }
      ctx.created.push({
        test: "planAdd",
        label: "plan-probe workout",
        stampName: stampOf(mine),
        date: mine.date,
        serverIdInPlan: String(entity.idInPlan),
        planId: String(entity.planId ?? afterRaw.id ?? beforePlanId),
        cleaned: false,
        attempts: 0,
        abandoned: false,
      });
    }
    if (String(afterRaw.id ?? "") !== beforePlanId) {
      result.notes.push(
        `active planId changed ${beforePlanId || "(none)"} → ${String(afterRaw.id ?? "")}`,
      );
    }
  } catch (e) {
    result.error = `post-probe sweep failed: ${errText(e)}`;
    ctx.log(`  !! post-probe sweep failed (${errText(e)})`);
  }

  // A plan OBJECT may exist that no endpoint in this client can delete
  // (/training/plan/delete is declared-only in the survey, never called).
  if (newPlanId && newPlanId !== beforePlanId) {
    ctx.report.overall.orphanPlanIds.push(newPlanId);
    result.notes.push(
      "a plan object was created; no delete endpoint is implemented — remove it in the COROS UI",
    );
  }
  // Entity-level cleanup status is set by the drain that follows; an orphan
  // plan is re-applied in finalize() so the drain cannot mask it.
}

function extractPlanId(data: unknown): string | undefined {
  if (typeof data === "string" && data !== "") return data;
  if (typeof data === "number") return String(data);
  if (data !== null && typeof data === "object") {
    const id =
      (data as { id?: unknown; planId?: unknown }).id ?? (data as { planId?: unknown }).planId;
    if (typeof id === "string" && id !== "") return id;
    if (typeof id === "number") return String(id);
  }
  return undefined;
}

// ── Report file ─────────────────────────────────────────────────────────────

export function createSpikeReportPath(date: string, mode = "full"): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, "..", "..", "..", "docs", "reports");
  mkdirSync(dir, { recursive: true });
  // The inspect dump carries real workout titles — keep it out of the file
  // people are used to committing.
  const stem = mode === "inspect" ? "coros-inspect" : "coros-create-spike";
  return join(dir, `${stem}-${date}.json`);
}

function writeReport(report: CreateSpikeReport): string {
  const path = createSpikeReportPath(report.date, report.mode);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

// ── Interactive CLI ─────────────────────────────────────────────────────────

/** How long the SIGINT path waits for an in-flight step before draining. */
const INTERRUPT_SETTLE_MS = 15_000;

function delay(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

async function main(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const cleanupOnly = process.argv.includes("--cleanup-only");
  const dryRun = process.argv.includes("--dry-run");
  // Parsed before anything is opened, so a bad flag is a clean usage error
  // rather than an unhandled rejection.
  let inspectDates: string[] | undefined;
  try {
    inspectDates = parseInspectDates(process.argv);
  } catch (e) {
    console.error(errText(e));
    process.exitCode = 1;
    return;
  }
  const prompter = createPrompter();
  const rl = prompter.rl;
  let client: CorosClient | null = null;
  // Held in an object so the SIGINT closure and the catch block both see what
  // runCreateSpike published the moment it published it.
  const state: {
    handle: CreateSpikeHandle | null;
    run: Promise<CreateSpikeReport> | null;
  } = { handle: null, run: null };
  let interrupted = false;

  const onInterrupt = (): void => {
    if (interrupted) return;
    interrupted = true;
    void (async () => {
      console.error("\nInterrupted — no further writes; draining what the spike created…");
      const live = state.handle;
      if (live) {
        live.abort("interrupted (SIGINT)");
        // Let the in-flight step finish so anything it created is registered.
        if (state.run) await Promise.race([state.run, delay(INTERRUPT_SETTLE_MS)]);
        try {
          await live.cleanup();
        } catch {
          console.error("Cleanup after interrupt FAILED.");
        }
        // Restoration read + leftover summary BEFORE we exit.
        await live.finalize().catch(() => undefined);
        if (live.report.overall.leftovers.length > 0) {
          console.error("CHECK YOUR COROS CALENDAR — leftovers:");
          for (const l of live.report.overall.leftovers) console.error(`  - ${l}`);
        }
        console.error(`Report written to ${writeReport(live.report)}`);
      } else {
        console.error("Nothing had been created yet.");
      }
      rl.close();
      if (client) await client.logout().catch(() => undefined);
      process.exit(130);
    })();
  };
  process.on("SIGINT", onInterrupt);
  rl.on("SIGINT", onInterrupt);

  console.log("──────────────────────────────────────────────────────────────");
  if (inspectDates) {
    console.log(" COROS SPIKE INSPECT — READ ONLY, WRITES NOTHING");
    console.log("");
    console.log(` It dumps every field of every workout on ${inspectDates.join(", ")}`);
    console.log(" plus every workout elsewhere in the plan sharing their");
    console.log(" idInPlan, so the wire truth can be compared side by side.");
    console.log("");
    console.log(` !! The report ${INSPECT_WARNING.toLowerCase()}.`);
  } else if (dryRun) {
    console.log(" COROS SPIKE DRY RUN — READ ONLY, WRITES NOTHING");
    console.log("");
    console.log(" It reads the whole plan and reports every workout named");
    console.log(` "${SPIKE_NAME}" — its ids, its stored structure, and`);
    console.log(" whether anything else in the plan shares its delete address.");
    console.log("");
    console.log(" It issues no create and no delete. Nothing changes.");
  } else if (cleanupOnly) {
    console.log(" COROS SPIKE CLEANUP — REMOVES LEFTOVER SPIKE WORKOUTS");
    console.log("");
    console.log(` It scans ${today} … ${addDays(today, STRAY_SWEEP_FORWARD_DAYS)} for workouts named`);
    console.log(` "${SPIKE_NAME}" — the ones a previous spike run created —`);
    console.log(" deletes them, and verifies each is gone. It CREATES nothing.");
    console.log("");
    console.log(" It only ever deletes a workout carrying that exact name, so a");
    console.log(" workout you authored can never be touched.");
  } else {
    console.log(" COROS CREATE SPIKE — THIS WRITES TO YOUR REAL COROS ACCOUNT");
    console.log("");
    console.log(" It first removes any leftovers from a previous run, then");
    console.log(" CREATES up to three brand-new throwaway workouts, named");
    console.log(` "${SPIKE_NAME}", on ${addDays(today, 21)}, ${addDays(today, 22)} and`);
    console.log(` ${addDays(today, 23)} — far outside any real training — verifies`);
    console.log(" each one, then DELETES every one of them again.");
    console.log("");
    console.log(" It NEVER reads, edits or deletes a workout you authored: it");
    console.log(" only ever deletes a workout whose name it stamped itself, it");
    console.log(" finds its own work by that name rather than by any id, and it");
    console.log(" re-checks the name immediately before every delete.");
    console.log(" On any failure — or Ctrl-C — it stops writing, removes what it");
    console.log(" made and prints the exact state your calendar is in.");
  }
  console.log("──────────────────────────────────────────────────────────────");

  let report: CreateSpikeReport | null = null;
  try {
    const email = (await prompter.ask("COROS email: ")).trim();
    const password = await prompter.askHidden("COROS password: ");
    const regionInput =
      (await prompter.ask("Region [us/eu/cn] (default us): ")).trim() || "us";
    if (!["us", "eu", "cn"].includes(regionInput)) throw new Error("invalid region");
    const region = regionInput as CorosRegion;

    // Log in BEFORE asking for confirmation: a read-only auth check costs
    // nothing and there is no point confirming a run with a bad password.
    client = new CorosClient({ region });
    await client.login(email, password);
    console.log("Logged in.");

    let includePlanAddProbe = false;
    if (inspectDates) {
      console.log("\nInspect: reading only, nothing will be written.\n");
    } else if (dryRun) {
      console.log("\nDry run: reading only, nothing will be written.\n");
    } else if (cleanupOnly) {
      const confirm = await prompter.ask(
        "\nType CLEAN to remove leftover spike workouts from this account: ",
      );
      if (confirm.trim() !== "CLEAN") throw new Error("aborted by user (no writes performed)");
    } else {
      const confirm = await prompter.ask(
        "\nType CREATE to run the create spike against this account: ",
      );
      if (confirm.trim() !== "CREATE") throw new Error("aborted by user (no writes performed)");

      console.log("");
      console.log("OPTIONAL EXTRA — plan-level create probe (POST /training/plan/add):");
      console.log("  On unexpected success this creates a plan object that has no");
      console.log("  delete endpoint — you would remove it manually in the COROS UI.");
      console.log("  It is expected to be rejected (1031), but that is not guaranteed.");
      const probeAnswer = await prompter.ask(
        "Include the plan/add probe? Type PROBE to include it (anything else skips): ",
      );
      includePlanAddProbe = probeAnswer.trim() === "PROBE";
      console.log(includePlanAddProbe ? "Plan/add probe: INCLUDED." : "Plan/add probe: skipped.");
    }

    console.log("");
    const run = runCreateSpike(client, {
      today,
      includePlanAddProbe,
      cleanupOnly,
      dryRun,
      ...(inspectDates ? { inspectDates } : {}),
      log: (line) => console.log(line),
      onStart: (h) => {
        state.handle = h;
      },
    });
    state.run = run;
    report = await run;

    console.log("");
    const strays = report.strays;
    if (strays && (strays.removed.length > 0 || strays.failed.length > 0)) {
      console.log(
        `Leftovers from earlier runs: ${strays.removed.length} removed, ${strays.failed.length} could not be removed.`,
      );
    }
    if (inspectDates) {
      console.log(
        `INSPECT COMPLETE — ${report.inspect?.onDates.length ?? 0} entit(ies) on the requested` +
          ` dates, ${report.inspect?.sameIdElsewhere.length ?? 0} elsewhere sharing their idInPlan.`,
      );
      console.log(`!! ${INSPECT_WARNING}`);
    } else if (dryRun) {
      const dry = report.dryRun;
      console.log(
        `DRY RUN COMPLETE — ${dry?.stamped.length ?? 0} stamped workout(s),` +
          ` ${dry?.collisions.filter((c) => c.fullTripleMatches).length ?? 0} of them not safely deletable.`,
      );
    } else if (cleanupOnly) {
      console.log(
        strays && strays.failed.length === 0
          ? "CLEANUP COMPLETE — no spike workouts remain."
          : "CLEANUP INCOMPLETE — see the ACTION REQUIRED list above.",
      );
      if (strays && strays.failed.length > 0) process.exitCode = 1;
    } else {
      console.log(
        report.succeeded
          ? "SPIKE COMPLETE — account restored to its baseline state."
          : "SPIKE COMPLETE WITH PROBLEMS — see the report and any ACTION REQUIRED above.",
      );
      console.log(
        `  strength create: ${verdict(report.tests.strength)}   run create: ${verdict(report.tests.run)}`,
      );
      console.log(
        `  bike probe: ${verdict(report.tests.bike)}   plan/add probe: ${report.tests.planAdd.resultCode ?? "not run"}`,
      );
      if (!report.succeeded) process.exitCode = 1;
    }
  } catch (e) {
    const message = errText(e);
    console.error(`\nSPIKE FAILED: ${message}`);
    const live = state.handle;
    if (live) {
      live.abort(message);
      live.report.failure ??= message;
      await live.cleanup().catch(() => undefined);
      await live.finalize().catch(() => undefined);
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

/** `--inspect 2026-08-23,2026-08-24` or `--inspect=2026-08-23,…`. */
export function parseInspectDates(argv: string[]): string[] | undefined {
  const index = argv.findIndex((a) => a === "--inspect" || a.startsWith("--inspect="));
  if (index < 0) return undefined;
  const arg = argv[index] ?? "";
  const raw = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : (argv[index + 1] ?? "");
  const dates = raw
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d !== "");
  const invalid = dates.filter((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d));
  if (dates.length === 0 || invalid.length > 0) {
    throw new Error(
      `--inspect needs comma-separated yyyy-mm-dd dates (got ${JSON.stringify(raw)})`,
    );
  }
  return dates;
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
