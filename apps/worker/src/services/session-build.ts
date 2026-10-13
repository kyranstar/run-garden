/**
 * A SLOT'S SESSION, BUILT ON ITS DAY (Phase 2 spec §2a "Build API"; programme spec §7.2–7.3, §9.2, §10.1–10.2).
 *
 * The one place the worker calls the session engine. A program slot (or an on-demand session) is an outline until
 * its day; opening it builds the session from what the database holds (`engine-inputs.ts`) and the day's own
 * choices — checks, overrides (mode, theme, minutes, place) and swaps.
 *
 * THE RULES
 *  - Only live rows of this user that the app authored (`appAuthoredRow`: `program`, `on_demand`, and the document
 *    workouts `studio` / `template`). Anything else is not found. A document workout is built from its document, not
 *    by the engine, through the same versions, lock and Start contract (see "A document workout's build" below).
 *  - A started or done slot is LOCKED: what its build plays never changes, and any build request is refused with the
 *    locked build (409 `locked`). Start locks the latest build of the day. (One thing of a locked build does change: a
 *    document build sent to the watch loses, as it starts, the ⇄ options the day's reading now keeps out —
 *    `$.build.fromDoc.slots` alone, written in place.)
 *  - Today → a build, versioned per workout (1, 2, …). The day's choices persist: a request that leaves out
 *    `overrides` or `swaps` keeps the stored ones; new overrides drop the swaps (their slots may mean something
 *    else now). A build writes its block changes to `program_blocks` and the row's title, discipline (§9.2: a core
 *    lift → strength, else yoga), length (planned seconds rounded up to 5 min), `content_state = 'built'` and
 *    `session_params`. Only the latest unlocked version is kept, plus the locked one (ruling P1-R7).
 *  - A day ahead → a PREVIEW: version 0, overwritten by the next preview, never lockable; the row, the block and
 *    the checks are left alone (the session is built for real on its day).
 *  - A day gone → 409 `not_today` (the sheet offers "Move to today", the existing move verb).
 *  - DETERMINISM (§7.2): the engine is a pure function of its inputs and the seed is the date + program id, so a
 *    request whose inputs hash matches the stored build returns that build and writes nothing. The hash is taken
 *    over the block as stored AFTER the build, so the block a first build starts does not make the next identical
 *    request look new.
 *  - Checks in the body are recorded as `pre` checks for this slot and day (one per profile, replaced on a
 *    re-check). A slot's reading is the latest answer of its own pre-check and today's daily check (the Today chip):
 *    one reading, whichever was given last (ruling 2a-R13). A check with no number and no "feeling off" is no answer:
 *    it records nothing and clears the slot's own (audit I2).
 *  - 👎-rated and "not for me" moves are filtered out of the alternatives in every response (ruling 2a-R1); the
 *    stored build keeps what the engine offered.
 *
 * Every writer here is a no-op while a restore is replacing the account (ruling B2).
 */
import { and, eq, inArray, isNotNull, isNull, ne, notExists, notInArray, or, sql, type SQL } from "drizzle-orm";
import { conditionChecks, corosWriteJobs, exercisePrefs, performedSessions, plannedWorkouts, programs, sessionBuilds, userConditions } from "@rg/database";
import {
  appAuthoredRow,
  docOriginRow,
  doseSummary,
  newId,
  parseStoredWorkoutDoc,
  sessionLead,
  todayInZone,
  type AdaptiveConfig,
  type SessionLead,
  type UserPreferences,
  type Weight,
  type WorkoutDoc,
  type WorkoutPart,
} from "@rg/domain";
import {
  CORE_FAMILIES,
  COVERAGE_TARGETS,
  EXERCISES,
  FORMATS,
  isPlyometric,
  isProfileId,
  makeEngineData,
  MODES,
  PROFILES,
  SKELETON,
  THEMES,
  type BlockId,
  type EngineData,
  type ExerciseRecord,
  type FormatId,
} from "@rg/exercise-library";
import {
  Planner,
  type Alternative,
  type Block,
  type BlockUpdate,
  type CheckReading,
  type HistorySession,
  type HistorySummary,
  type Mode,
  type Step,
  type Swaps,
  type Target,
} from "@rg/session-engine";
import { sha256Hex } from "../auth/crypto.js";
import { restoreInProgress } from "./account-state.js";
import { loadPreferences } from "./calendar-sync.js";
import type { Db } from "./db.js";
import { separateDayCollisions } from "./day-placement.js";
import {
  loadBuildHistory,
  loadEngineContext,
  loadProgramState,
  saveProgramState,
  type BuildHistory,
  type EngineContext,
} from "./engine-inputs.js";
import { conditionView, isAnswer, latestReading, type ConditionView } from "./condition-views.js";
import type { WatchState } from "./watch-push.js";
import { docForBuild, storedDocText } from "./workout-doc-store.js";
import { dayValidateCtx, DOC_BUILD_VERSION, gateDoc, materializeDocBuild, slotsForDay, snapshotErrors, type DocBuildInfo, type DocSlot } from "./doc-build.js";
import { docSlotKeys, DocTooLargeError, makeLibraryIndex, type DocIssue, type ValidateCtx } from "@rg/workout";
import { doneCleanlyOf, doneStats } from "./library-view.js";

/**
 * Bump when the engine's behaviour or the stored build's shape changes: a stored build from an older version then no
 * longer matches its inputs and is built again on its next open. 2: the view's place carries its gear (ruling 2b-R2).
 */
export const ENGINE_VERSION = "session-engine-2";

/**
 * A profile's answer before the session: 0–10 (null = no number), and "feeling off". Neither a number nor "feeling
 * off" is no answer (the question not answered yet).
 */
export interface CheckAnswer {
  pre: number | null;
  feelingOff: boolean;
}

export interface BuildOverrides {
  mode?: Mode;
  /** A theme id. */
  theme?: string;
  minutes?: number;
  locationId?: string;
}

export interface BuildRequest {
  checks?: Record<string, CheckAnswer>;
  overrides?: BuildOverrides;
  swaps?: Swaps;
}

/** The day's choices a build was made with (also the row's `session_params`). */
export interface BuildParams {
  checks: Record<string, CheckAnswer>;
  overrides: BuildOverrides;
  swaps: Swaps;
}

export interface SessionView {
  mode: Mode;
  proposedMode: Mode;
  modeReasons: string[];
  theme: { id: string; name: string } | null;
  proposedTheme: { id: string; name: string } | null;
  themeReasons: string[];
  minutes: number;
  /**
   * The place, with what the player needs of it offline (ruling 2b-R2): its equipment ids, and its implement weights
   * as parsed from the typed list (the log card's ± steppers move through them).
   */
  location: { id: string; name: string; equipment: string[]; implements: Record<string, Weight[]> };
  block: { number: number; week: number; weeks: number; core: { family: string; name: string | null }[]; events: string[] } | null;
  /** The exercise id introduced today, if any. */
  newMove: string | null;
  /** The Today card's line of moves (`sessionLead`), made with the build so Today reads it without the payload. */
  lead: SessionLead;
}

/** One slot of the plan: what it holds and how it is played. */
export interface BuildItem {
  slotKey: string;
  block: BlockId;
  exerciseId: string;
  format: FormatId;
  sets: number;
  /** Superset / circuit group label, if any. */
  group: string | null;
  coreFamily: string | null;
  isNew: boolean;
  why: string[];
  /** The session's one new or retried jump (the engine's swap state): the player's ⇄ offers no second one elsewhere. */
  fresh?: true;
}

/** A library record as the player and how-to sheet need it, offline (never the provider mappings). */
export type ExerciseSlice = Omit<ExerciseRecord, "providers">;

/** The build as stored and sent (programme spec §7.3). */
export interface BuildPayload {
  /** `session_builds.id`: what a performed session names as its build. */
  buildId: string;
  /** 0 = a preview of a day ahead; 1, 2, … = the day's builds. */
  version: number;
  engineVersion: string;
  inputsHash: string;
  builtAt: string;
  /** The day the session was built for. */
  date: string;
  mode: Mode;
  modeReasons: string[];
  /** Theme id. */
  theme: string | null;
  themeReasons: string[];
  minutes: number;
  locationId: string;
  /** `program_blocks.id` of the block the session belongs to; null in a preview that would start a block. */
  blockRef: string | null;
  weekOfBlock: number | null;
  plannedSeconds: number;
  /** The flat step list the player plays (timed | set | rest). */
  steps: Step[];
  items: BuildItem[];
  /** Every move in the plan and in its alternatives. */
  exercises: Record<string, ExerciseSlice>;
  /** Per slot key: up to 3 moves the slot can take now, each with its steps (ruling 2a-R1 filtered). */
  alternatives: Record<string, Alternative[]>;
  /** Progression targets from logged history, per exercise id in the plan. */
  targets: Record<string, Target>;
  newMove: string | null;
  params: BuildParams;
  /**
   * A document workout's build (Stage 2, `doc-build.ts`): the revision it was made from, the moves the day swapped for
   * their alternates, and the errors left (a blocked build is never locked). Absent from an engine build. With the
   * document's own words for what it is (`DocFacts`) — absent from a build stored before them.
   */
  fromDoc?: DocBuildInfo & Partial<DocFacts>;
}

/**
 * What a document build says of its document in the document's own words, so the sheet, Today and the player name it
 * as the Studio does: its effort (never a mode's word), its parts by purpose with the slot keys each holds (in play
 * order), and each item's dose as the builder says it ("4 × 5–8", never "4 sets").
 */
export interface DocFacts {
  effort: WorkoutDoc["intent"]["effort"];
  parts: Array<{ purpose: WorkoutPart["purpose"]; keys: string[] }>;
  doses: Record<string, string>;
}

/** `DocFacts` of the document as played. */
export function docFacts(doc: WorkoutDoc): DocFacts {
  const keys = docSlotKeys(doc);
  const doses: Record<string, string> = {};
  for (const k of keys) {
    const item = doc.parts[k.part]!.items[k.item]!;
    if (item.kind === "exercise" || item.kind === "free_exercise") {
      const words = doseSummary(item.dose);
      if (words) doses[k.key] = words;
    }
  }
  const parts = doc.parts
    .map((p, i) => ({ purpose: p.purpose, keys: keys.filter((k) => k.part === i).map((k) => k.key) }))
    .filter((p) => p.keys.length > 0);
  return { effort: doc.intent.effort, parts, doses };
}

export interface SessionResponse {
  workoutId: string;
  date: string;
  contentState: "outline" | "built" | "started" | "done";
  locked: boolean;
  /** The slot's day's checks: the latest answer of its own pre-check and that day's daily check (today only), per
   * ruling 2a-R13. */
  checks: Record<string, CheckAnswer>;
  build: BuildPayload | null;
  view: SessionView | null;
  /** The switched-on condition profiles, as the sheet labels them (the pre-check, the reading, the care block). */
  profiles: ConditionView[];
  /** What the sheet's chips can pick. */
  choices: SessionChoices;
  /**
   * The session on the watch (Phase 3): null while the switch is off, and nothing about the watch renders. The
   * routes attach it (`withWatch`); a service answer carries null until they do.
   */
  watch: WatchState | null;
}

/** The program's modes; the themes a build can take, each with the modes it suits; the account's places. */
export interface SessionChoices {
  modes: Mode[];
  themes: Array<{ id: string; name: string; modes: Mode[] }>;
  locations: Array<{ id: string; name: string }>;
}

/** What a response says beside the slot and its build: labels and choices, from the build's context. */
interface SheetExtras {
  profiles: ConditionView[];
  choices: SessionChoices;
}

/** What `session_builds.payload` holds. */
interface StoredBuild {
  build: Omit<BuildPayload, "buildId" | "version">;
  view: SessionView;
}

export interface RecordedCheck {
  profileId: string;
  date: string;
  value: number | null;
  feelingOff: boolean;
}

export class SessionNotFoundError extends Error {
  constructor() {
    super("not_found");
  }
}

export class NotTodayError extends Error {
  constructor(
    public readonly date: string,
    public readonly today: string,
  ) {
    super("not_today");
  }
}

export class SessionLockedError extends Error {
  constructor(public readonly session: SessionResponse) {
    super("locked");
  }
}

export class NotBuiltError extends Error {
  constructor() {
    super("not_built");
  }
}

/**
 * Start named a build that is no longer the one the day's inputs make (audit I3): `session` is the fresh build, made
 * as `POST /build {}` makes it; `calendarChanged` when making it changed what the slot's calendar event shows.
 */
export class StaleBuildError extends Error {
  constructor(
    public readonly session: SessionResponse,
    public readonly calendarChanged: boolean,
  ) {
    super("stale");
  }
}

/** A check for a condition profile the account has not switched on. */
export class UnknownProfileError extends Error {
  constructor() {
    super("unknown_profile");
  }
}

/** Un-start refused: a performed session exists for the slot (it was saved — here or elsewhere). */
export class PerformedExistsError extends Error {
  constructor() {
    super("performed");
  }
}

/**
 * Start or Send refused for a document workout (Stage 2 spec §10): with the day's reading, the document holds a move
 * the day keeps out that no alternate can stand in for (or another fatal issue). `issues` are the validator's.
 */
export class GatedError extends Error {
  constructor(public readonly issues: DocIssue[]) {
    super("gated");
  }
}

/** A document workout whose stored document cannot be read: nothing can be built from it. */
export class NoDocumentError extends Error {
  constructor() {
    super("no_document");
  }
}

/**
 * A document workout too large to build (`docTooLarge`: past 600 derived minutes or 600 steps): nothing is
 * materialised, and the build, a preview or Start's fresh build answers with the issue. The validator refuses such a
 * document when it is made or revised, so only one stored before that bound (or grown by the day's swap) reaches here.
 */
export class DocTooLargeRefusal extends Error {
  constructor(public readonly issues: DocIssue[]) {
    super("too_large");
  }
}

/** The one issue a too-large document answers with: the validator's own (`too_large`, at "parts"). */
const tooLargeIssue = (message: string): DocIssue => ({ path: "parts", code: "too_large", message, severity: "error" });

/** A write refused because a restore began while the request ran (the route's 423). */
export class RestoringError extends Error {
  constructor() {
    super("restore_in_progress");
  }
}

type SlotRow = typeof plannedWorkouts.$inferSelect;
type BuildRow = typeof sessionBuilds.$inferSelect;

// ── Pure helpers ──────────────────────────────────────────────────────────────────────────────────────────────

/** Objects with their keys sorted (and undefined dropped), so equal inputs always serialise the same. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .filter((k) => o[k] !== undefined)
        .map((k) => [k, canonical(o[k])]),
    );
  }
  return v;
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

let libraryHash: Promise<string> | null = null;
/** A fingerprint of the library data a build reads, computed once per isolate. */
function libraryFingerprint(): Promise<string> {
  libraryHash ??= sha256Hex(
    JSON.stringify({ EXERCISES, THEMES, FORMATS, MODES, CORE_FAMILIES, COVERAGE_TARGETS, SKELETON, PROFILES }),
  );
  return libraryHash.then((h) => h.slice(0, 12));
}
/** The engine version plus the library's fingerprint. */
const engineVersion = (): Promise<string> => libraryFingerprint().then((h) => `${ENGINE_VERSION}+${h}`);
/** A document build's version plus the library's fingerprint: what a document's moves resolve to moves with it. */
const docBuildVersion = (): Promise<string> => libraryFingerprint().then((h) => `${DOC_BUILD_VERSION}+${h}`);

let exercisesById: Map<string, ExerciseRecord> | null = null;
function exerciseRecord(id: string): ExerciseRecord | undefined {
  exercisesById ??= new Map(EXERCISES.map((e) => [e.id, e]));
  return exercisesById.get(id);
}
function slice(id: string): ExerciseSlice | undefined {
  const record = exerciseRecord(id);
  if (!record) return undefined;
  const { providers: _providers, ...rest } = record;
  return rest;
}

const engineDataCache = new Map<string, EngineData>();
/** The engine's data for these active and cared-for profiles, made once per isolate. */
export function engineDataFor(active: readonly string[], care: readonly string[]): EngineData {
  const key = `${active.join(",")}|${care.join(",")}`;
  let data = engineDataCache.get(key);
  if (!data) {
    data = makeEngineData({ activeProfiles: active, careProfiles: care, exercises: EXERCISES });
    engineDataCache.set(key, data);
  }
  return data;
}

/** The block as the hash sees it: its id is the row's (or the engine's), never an input. */
const blockKey = (b: Block | null) => (b ? { number: b.number, startedAt: b.startedAt, weeks: b.weeks, core: b.core, rotations: b.rotations } : null);

const MODE_ORDER: readonly Mode[] = ["recovery", "consistent", "build"];

/** The allowed mode closest to `mode` (recovery < consistent < build); the lower one on a tie. */
export function nearestMode(mode: Mode, allowed: readonly Mode[]): Mode {
  const at = (m: Mode) => MODE_ORDER.indexOf(m);
  const pool = allowed.length > 0 ? allowed : MODE_ORDER;
  return [...pool].sort((a, b) => Math.abs(at(a) - at(mode)) - Math.abs(at(b) - at(mode)) || at(a) - at(b))[0]!;
}

function fallbackReason(from: Mode, to: Mode): string {
  return `Your program doesn't include ${from} sessions, so this is a ${to} one.`;
}

/**
 * The program settings a build reads — the one list both `composeBuild` and the inputs hash take them from (audit
 * I1): `composeBuild` is typed to see only these, and the hash covers exactly these, so a setting the build starts
 * reading is one it is rebuilt for. (The program's place and care profiles reach the build as `context.location`
 * and `context.careProfiles`, hashed with the rest of the context.)
 */
export const BUILD_CONFIG_KEYS = ["weeklyGoal", "blockWeeks", "defaultMinutes", "modes"] as const satisfies readonly (keyof AdaptiveConfig)[];
export type BuildConfig = Pick<AdaptiveConfig, (typeof BUILD_CONFIG_KEYS)[number]>;
/** What a build reads of the engine context: all of it, but of the program's config only `BUILD_CONFIG_KEYS`. */
export type BuildContext = Omit<EngineContext, "config"> & { config: BuildConfig };

const buildConfigOf = (config: BuildConfig): BuildConfig =>
  Object.fromEntries(BUILD_CONFIG_KEYS.map((k) => [k, config[k]])) as unknown as BuildConfig;

export interface ComposeInput {
  date: string;
  programId: string;
  context: BuildContext;
  block: Block | null;
  /** The history (`loadHistory`), or what a build reads of it: the trimmed sessions plus `summary` (`loadBuildHistory`). */
  history: readonly HistorySession[];
  summary?: HistorySummary;
  checks: Record<string, CheckAnswer>;
  overrides: BuildOverrides;
  swaps: Swaps;
}

export interface Composed {
  /** The build without what only storing it decides (version, id, hash, block row, time). */
  build: Omit<BuildPayload, "buildId" | "version" | "engineVersion" | "inputsHash" | "builtAt" | "blockRef">;
  view: SessionView;
  /** A block the engine started or changed today; null when the stored block stands. */
  blockUpdate: BlockUpdate | null;
  /** §9.2: the session holds a core lift. */
  hasCoreLift: boolean;
}

/**
 * The build itself, from loaded inputs: proposal, block upkeep, the plan with its alternatives (one pass), and
 * the payload and view. Pure and synchronous: the CPU a build costs is this function (the benchmark times it).
 */
export function composeBuild(input: ComposeInput): Composed {
  const { context: c } = input;
  const data = engineDataFor(c.activeProfiles, c.careProfiles);
  const checks: Record<string, CheckReading> = Object.fromEntries(
    Object.entries(input.checks).map(([p, a]) => [p, { pre: a.pre, post: null, feelingOff: a.feelingOff }]),
  );
  const planWith = (mode: Mode | undefined) => Planner.planToday(
    data,
    {
      today: input.date,
      day: {
        date: input.date,
        checks,
        feelingOff: false,
        override: {
          ...(mode ? { mode } : {}),
          ...(input.overrides.theme ? { theme: input.overrides.theme } : {}),
          ...(input.overrides.minutes ? { minutes: input.overrides.minutes } : {}),
        },
        swaps: input.swaps,
      },
    },
    {
      programId: input.programId,
      settings: {
        unit: c.unit,
        weeklyGoal: c.config.weeklyGoal,
        blockWeeks: c.config.blockWeeks,
        defaultMinutes: c.config.defaultMinutes,
        location: c.location.id,
      },
      locations: c.locations,
      prefs: c.prefs,
      savedIds: c.savedIds,
      block: input.block,
      sessions: input.history,
      ...(input.summary ? { summary: input.summary } : {}),
    },
  );
  // The program's own modes bind the build (ruling 2a-R7): an override or a proposal outside them falls back to
  // the nearest allowed mode, and the reasons say so. A recovery the engine proposes comes only from a safety
  // signal — a condition profile's own recovery rule, or "feeling off" — and stands whatever the modes, as does
  // recovery asked for on such a day (ruling 2a-R10). The proposal shown is always a mode the build could take
  // (audit M7).
  const want = input.overrides.mode;
  const clamp = (m: Mode, modes: readonly Mode[]): Mode => (modes.includes(m) ? m : nearestMode(m, modes));
  let planned = planWith(want ? clamp(want, c.config.modes) : undefined);
  const proposed = planned.view.proposedMode;
  const allowed: readonly Mode[] =
    proposed === "recovery" && !c.config.modes.includes("recovery") ? [...c.config.modes, "recovery"] : c.config.modes;
  const proposal = clamp(proposed, allowed);
  const mode = want ? clamp(want, allowed) : proposal;
  if (planned.view.mode !== mode) planned = planWith(mode);
  const from = want ?? proposed;
  const fallback = from !== mode ? fallbackReason(from, mode) : null;
  const { blockUpdate } = planned;
  const v = {
    ...planned.view,
    proposedMode: proposal,
    modeReasons: fallback ? [fallback, ...planned.view.modeReasons] : planned.view.modeReasons,
  };
  const plan = v.plan;

  const exercises: Record<string, ExerciseSlice> = {};
  const add = (id: string) => {
    if (exercises[id]) return;
    const s = slice(id);
    if (s) exercises[id] = s;
  };
  for (const it of plan.items) add(it.exercise.id);
  for (const list of Object.values(plan.alternatives)) for (const a of list) add(a.id);
  const targets: Record<string, Target> = {};
  for (const it of plan.items) if (it.target) targets[it.exercise.id] = it.target;

  const name = (id: string | null | undefined): string | null => (id ? (exerciseRecord(id)?.name ?? null) : null);
  const themeRef = (t: { id: string; name: string } | null) => (t ? { id: t.id, name: t.name } : null);
  const view: SessionView = {
    mode: v.mode,
    proposedMode: v.proposedMode,
    modeReasons: v.modeReasons,
    theme: themeRef(v.theme),
    proposedTheme: themeRef(v.proposedTheme),
    themeReasons: v.themeReasons,
    minutes: v.minutes,
    location: {
      id: v.location.id,
      name: v.location.name ?? v.location.id,
      equipment: [...v.location.equipment],
      implements: Object.fromEntries(Object.entries(v.location.implements ?? {}).map(([k, ws]) => [k, ws.map((w) => ({ v: w.v, u: w.u }))])),
    },
    block: {
      number: v.block.number,
      week: v.week,
      weeks: v.block.weeks,
      core: data.coreFamilies.map((f) => ({ family: f.id, name: name(v.block.core[f.id]) })),
      events: v.blockEvents,
    },
    newMove: plan.newMove,
    lead: sessionLead({
      items: plan.items.map((it) => ({ slotKey: it.slotKey, block: it.block, exerciseId: it.exercise.id, sets: it.sets })),
      steps: plan.steps,
      targets,
      exercises,
    }),
  };

  return {
    build: {
      date: input.date,
      mode: v.mode,
      modeReasons: v.modeReasons,
      theme: v.theme?.id ?? null,
      themeReasons: v.themeReasons,
      minutes: v.minutes,
      locationId: v.location.id,
      weekOfBlock: v.week,
      plannedSeconds: plan.plannedSeconds,
      steps: plan.steps,
      items: plan.items.map((it) => ({
        slotKey: it.slotKey,
        block: it.block,
        exerciseId: it.exercise.id,
        format: it.format,
        sets: it.sets,
        group: it.group,
        coreFamily: it.coreFamily,
        isNew: it.isNew,
        why: it.why,
        ...(plan.swapState.current[it.slotKey]?.fresh ? { fresh: true as const } : {}),
      })),
      exercises,
      alternatives: plan.alternatives,
      targets,
      newMove: plan.newMove,
      params: { checks: input.checks, overrides: input.overrides, swaps: input.swaps },
    },
    view,
    blockUpdate,
    hasCoreLift: plan.items.some((it) => it.block === "core"),
  };
}

// ── Reads ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The user's live program / on-demand row, or `SessionNotFoundError`. */
export async function loadSlot(db: Db, userId: string, workoutId: string): Promise<SlotRow> {
  const [row] = await db
    .select()
    .from(plannedWorkouts)
    .where(and(eq(plannedWorkouts.id, workoutId), eq(plannedWorkouts.userId, userId)))
    .limit(1);
  if (!row || row.archivedAt !== null || !appAuthoredRow(row)) {
    throw new SessionNotFoundError();
  }
  return row;
}

/** The slot's builds, newest version first. */
export async function loadBuilds(db: Db, userId: string, workoutId: string): Promise<BuildRow[]> {
  const rows = await db
    .select()
    .from(sessionBuilds)
    .where(and(eq(sessionBuilds.workoutId, workoutId), eq(sessionBuilds.userId, userId)));
  return rows.sort((a, b) => b.version - a.version);
}

const storedOf = (b: BuildRow): StoredBuild => b.payload as unknown as StoredBuild;
const lockedOf = (row: SlotRow, builds: readonly BuildRow[]): boolean =>
  row.contentState === "started" || row.contentState === "done" || builds.some((b) => b.lockedAt !== null);

/**
 * The build a slot shows: the locked one; else the latest made for the slot's current day — a day's build
 * (version ≥ 1) for today or a day gone, the preview (version 0) for a day ahead.
 */
function currentBuild(row: SlotRow, builds: readonly BuildRow[], today: string): BuildRow | null {
  const locked = builds.find((b) => b.lockedAt !== null);
  if (locked) return locked;
  const ahead = row.effectiveDate > today;
  return builds.find((b) => (ahead ? b.version === 0 : b.version > 0) && storedOf(b).build.date === row.effectiveDate) ?? null;
}

/** The account's switched-on condition profiles: ids the library knows, sorted. */
export async function activeProfilesOf(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .select({ profileId: userConditions.profileId })
    .from(userConditions)
    .where(and(eq(userConditions.userId, userId), eq(userConditions.active, true)));
  return [...new Set(rows.map((r) => r.profileId).filter(isProfileId))].sort();
}

const answeredOnly = (checks: Record<string, CheckAnswer>): Record<string, CheckAnswer> =>
  Object.fromEntries(Object.entries(checks).filter(([, a]) => isAnswer(a.pre, a.feelingOff)));

type CheckRow = typeof conditionChecks.$inferSelect;

/** The user's pre-checks and daily checks on `date`: what a slot's checks for that day are made from. */
function dayCheckRows(db: Db, userId: string, date: string): Promise<CheckRow[]> {
  return db
    .select()
    .from(conditionChecks)
    .where(and(eq(conditionChecks.userId, userId), eq(conditionChecks.localDate, date), inArray(conditionChecks.kind, ["pre", "daily"])));
}

/** The slot's own pre-check rows for a profile, among the day's rows. */
const ownPre = (rows: readonly CheckRow[], workoutId: string, profileId: string): CheckRow[] =>
  rows.filter((r) => r.kind === "pre" && r.workoutId === workoutId && r.profileId === profileId);
/** The day's check rows (the Today chip's) for a profile, among the day's rows. */
const dailyOf = (rows: readonly CheckRow[], profileId: string): CheckRow[] =>
  rows.filter((r) => r.kind === "daily" && r.profileId === profileId);
/** Every slot's pre-check rows for a profile among the day's rows, but `except`'s. */
const dayPre = (rows: readonly CheckRow[], profileId: string, except: string | null = null): CheckRow[] =>
  rows.filter((r) => r.kind === "pre" && r.profileId === profileId && r.workoutId !== except);

/**
 * The slot's checks on `date`, per active profile: the day's reading (ruling 2a-R13, `latestReading` — the Today
 * chip's own rule) — on today, over the day's check and every slot's pre-check that day (one reading a day, whichever
 * asked it: two app sessions on a day read the same, as the chip does; 2a UI re-review U2); on another day, over the
 * slot's own pre-check — whichever answer was given last. The request's answer, when the request asks about the
 * profile, is the newest reading there is; asked with no answer, it takes the slot's own away and the day's other
 * answers stand. A profile with no answer is left out (unanswered). What the slot's checks are once the request's are
 * recorded, worked out before anything is written.
 */
function resolveChecks(
  rows: readonly CheckRow[],
  workoutId: string,
  date: string,
  today: string,
  active: readonly string[],
  asked: Record<string, CheckAnswer> = {},
): Record<string, CheckAnswer> {
  const out: Record<string, CheckAnswer> = {};
  for (const profileId of active) {
    const ask = asked[profileId];
    const isToday = date === today;
    const daily = isToday ? dailyOf(rows, profileId) : [];
    const others = isToday ? dayPre(rows, profileId, workoutId) : [];
    const pick = ask
      ? isAnswer(ask.pre, ask.feelingOff)
        ? { value: ask.pre, feelingOff: ask.feelingOff }
        : latestReading([...others, ...daily])
      : latestReading([...ownPre(rows, workoutId, profileId), ...others, ...daily]);
    if (pick) out[profileId] = { pre: pick.value, feelingOff: pick.feelingOff };
  }
  return out;
}

/**
 * The slot's checks on `date` (see `resolveChecks`), as stored — also the day's reading a document workout is checked
 * with when it is made or revised (`doc-workouts.ts`).
 */
export async function slotChecks(
  db: Db,
  userId: string,
  workoutId: string,
  date: string,
  today: string,
  active: readonly string[],
): Promise<Record<string, CheckAnswer>> {
  if (active.length === 0) return {};
  return resolveChecks(await dayCheckRows(db, userId, date), workoutId, date, today, active);
}

/** Moves never offered as alternatives: 👎-rated (ruling 2a-R1) and "not for me". */
function hiddenFrom(prefs: { ratings: Readonly<Record<string, number>>; excluded: readonly string[] }): Set<string> {
  return new Set([...Object.entries(prefs.ratings).filter(([, r]) => r < 0).map(([id]) => id), ...prefs.excluded]);
}

async function hiddenMoves(db: Db, userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ exerciseId: exercisePrefs.exerciseId, rating: exercisePrefs.rating, excluded: exercisePrefs.excluded })
    .from(exercisePrefs)
    .where(eq(exercisePrefs.userId, userId));
  return new Set(rows.filter((r) => (r.rating ?? 0) < 0 || r.excluded).map((r) => r.exerciseId));
}

function toPayload(b: BuildRow, hidden: ReadonlySet<string>): { build: BuildPayload; view: SessionView } {
  const stored = storedOf(b);
  const alternatives = Object.fromEntries(
    Object.entries(stored.build.alternatives).map(([slotKey, list]) => [slotKey, list.filter((a) => !hidden.has(a.id))]),
  );
  // A document's planned alternates are offered by the player's ⇄: never a hidden move either.
  const doc = stored.build.fromDoc;
  const slots = doc?.slots ? { fromDoc: { ...doc, slots: withoutHidden(doc.slots, hidden) } } : {};
  return { build: { buildId: b.id, version: b.version, ...stored.build, alternatives, ...slots }, view: stored.view };
}

/** A document build's slots with the hidden moves out of their alternates and offers (a slot left saying nothing goes). */
function withoutHidden(slots: Readonly<Record<string, DocSlot>>, hidden: ReadonlySet<string>): Record<string, DocSlot> {
  const out: Record<string, DocSlot> = {};
  for (const [key, slot] of Object.entries(slots)) {
    const { alternates, offers, ...said } = slot;
    const a = (alternates ?? []).filter((c) => !hidden.has(c.id));
    const o = (offers ?? []).filter((c) => !hidden.has(c.id));
    const next: DocSlot = { ...said, ...(a.length > 0 ? { alternates: a } : {}), ...(o.length > 0 ? { offers: o } : {}) };
    if (Object.keys(next).length > 0) out[key] = next;
  }
  return out;
}

/** The sheet's labels and choices from a build's context: the same context the engine plans with. */
function sheetExtras(context: EngineContext): SheetExtras {
  return {
    profiles: context.activeProfiles.map(conditionView),
    choices: {
      modes: [...context.config.modes],
      themes: engineDataFor(context.activeProfiles, context.careProfiles).themes.map((t) => ({ id: t.id, name: t.name, modes: [...t.modes] })),
      locations: context.locations.map((l) => ({ id: l.id, name: l.name ?? l.id })),
    },
  };
}

/** The sheet's labels and choices for a slot, read fresh (its program gone: no profiles, every mode, nothing to pick). */
async function loadExtras(db: Db, userId: string, row: SlotRow): Promise<SheetExtras> {
  try {
    return sheetExtras(await loadEngineContext(db, userId, row.planId, {}));
  } catch (e) {
    if (e instanceof Error && e.message === "program_not_found") {
      return { profiles: [], choices: { modes: ["recovery", "consistent", "build"], themes: [], locations: [] } };
    }
    throw e;
  }
}

const contentStateOf = (row: SlotRow): SessionResponse["contentState"] => {
  const state = row.contentState;
  return state === "built" || state === "started" || state === "done" ? state : "outline";
};

function respond(
  row: SlotRow,
  builds: readonly BuildRow[],
  today: string,
  checks: Record<string, CheckAnswer>,
  hidden: ReadonlySet<string>,
  extras: SheetExtras,
): SessionResponse {
  const current = currentBuild(row, builds, today);
  const shown = current ? toPayload(current, hidden) : null;
  return {
    workoutId: row.id,
    date: row.effectiveDate,
    contentState: contentStateOf(row),
    locked: lockedOf(row, builds),
    checks,
    build: shown?.build ?? null,
    view: shown?.view ?? null,
    profiles: extras.profiles,
    choices: extras.choices,
    watch: null,
  };
}

async function readResponse(db: Db, userId: string, row: SlotRow, today: string, builds?: readonly BuildRow[]): Promise<SessionResponse> {
  const all = builds ?? (await loadBuilds(db, userId, row.id));
  const active = await activeProfilesOf(db, userId);
  const checks = await slotChecks(db, userId, row.id, row.effectiveDate, today, active);
  // A document workout reads no programme, and its sheet is offered no choices (`docExtras`).
  const extras = docOriginRow(row) ? docExtras(active) : await loadExtras(db, userId, row);
  return respond(row, all, today, checks, await hiddenMoves(db, userId), extras);
}

/** `GET /api/sessions/:workoutId`: the slot, its current build (or none), its day's checks, and the lock. */
export async function loadSession(db: Db, userId: string, workoutId: string, today: string): Promise<SessionResponse> {
  return readResponse(db, userId, await loadSlot(db, userId, workoutId), today);
}

/**
 * `GET /api/sessions/:workoutId/state`: the slot's content state alone — Today's check before it offers Continue on a
 * session left in progress (ruling 2b-R18). One read of the slot row: never its builds, each a whole session kept
 * (re-review 2b-B2 M-3).
 */
export async function loadSessionState(db: Db, userId: string, workoutId: string): Promise<Pick<SessionResponse, "workoutId" | "contentState">> {
  const row = await loadSlot(db, userId, workoutId);
  return { workoutId: row.id, contentState: contentStateOf(row) };
}

// ── Writes ────────────────────────────────────────────────────────────────────────────────────────────────────

/** One profile's pre-check change for a slot: the slot's own rows it replaces, and the answer to record (none: cleared). */
interface PreCheckWrite {
  profileId: string;
  remove: string[];
  answer: CheckAnswer | null;
}

/**
 * The writes that record the request's checks as this slot's pre-checks for the day (`rows`: the day's check rows),
 * replacing any answer that changed. A check with no answer records nothing and removes the slot's own pre-check for
 * that profile (un-answering), so the day's check stands again (audit I2).
 */
function preCheckWrites(asked: Record<string, CheckAnswer>, rows: readonly CheckRow[], workoutId: string): PreCheckWrite[] {
  const out: PreCheckWrite[] = [];
  for (const profileId of Object.keys(asked).sort()) {
    const answer = asked[profileId]!;
    const mine = ownPre(rows, workoutId, profileId);
    if (!isAnswer(answer.pre, answer.feelingOff)) {
      if (mine.length > 0) out.push({ profileId, remove: mine.map((r) => r.id), answer: null });
      continue;
    }
    // The same answer is written again unless it is already the day's reading: given after a later chip check, it
    // is the latest once more (ruling 2a-R13).
    const current = latestReading([...mine, ...dailyOf(rows, profileId)]);
    if (mine.length === 1 && current === mine[0] && mine[0]!.value === answer.pre && mine[0]!.feelingOff === answer.feelingOff) continue;
    out.push({ profileId, remove: mine.map((r) => r.id), answer: { pre: answer.pre, feelingOff: answer.feelingOff } });
  }
  return out;
}

async function recordPreChecks(
  db: Db,
  userId: string,
  workoutId: string,
  date: string,
  writes: readonly PreCheckWrite[],
  now: string,
): Promise<void> {
  for (const w of writes) {
    if (w.remove.length > 0) await db.delete(conditionChecks).where(inArray(conditionChecks.id, w.remove));
    if (!w.answer) continue;
    await db.insert(conditionChecks).values({
      id: newId(),
      userId,
      profileId: w.profileId,
      kind: "pre",
      value: w.answer.pre,
      feelingOff: w.answer.feelingOff,
      localDate: date,
      at: now,
      performedSessionId: null,
      workoutId,
    });
  }
}

/**
 * A build started and then un-started (ruling 2b-R19) says when in its payload, `$.unstartedAt`. It stays on record,
 * unlocked: a save made from it may still be waiting on another device, and the day it was built for is still that
 * session's day (session-save's date check reads it, `startedBuildDays`).
 */
export const UNSTARTED_AT_PATH = "$.unstartedAt";
const neverStarted = () => sql`json_extract(${sessionBuilds.payload}, ${UNSTARTED_AT_PATH}) is null`;

/** Keep one unlocked build per workout — `keep` — plus any locked one, and any started once (ruling 2b-R19). */
async function pruneBuilds(db: Db, workoutId: string, keep: string): Promise<void> {
  await db
    .delete(sessionBuilds)
    .where(and(eq(sessionBuilds.workoutId, workoutId), ne(sessionBuilds.id, keep), isNull(sessionBuilds.lockedAt), neverStarted()));
}

/** Planned seconds as the calendar books them: rounded up to 5 minutes. */
export const bookedSeconds = (planned: number): number => Math.max(300, Math.ceil(planned / 300) * 300);

/**
 * What a build puts on its slot's row (§2a "Output persisted"): `<program> · <theme>`, the discipline (§9.2: a core
 * lift makes it strength, else yoga) and the planned length as the calendar books it. A fresh build and the stored
 * build adopted again (a cache hit on a slot that became an outline) write the same thing (re-review R2).
 */
function builtRowContent(name: string, theme: { name: string } | null, plannedSeconds: number, hasCoreLift: boolean) {
  const seconds = bookedSeconds(plannedSeconds);
  const discipline = hasCoreLift ? "strength" : "yoga";
  return {
    title: theme ? `${name} · ${theme.name}` : name,
    category: discipline,
    sport: discipline,
    calendarBlockDurationSeconds: seconds,
    fallbackEstimatedDurationSeconds: seconds,
  } satisfies Partial<SlotRow>;
}

/**
 * What writing `next` on `row` changes for the calendar: the booked length (then the day's collision pass runs), and
 * whether the event has anything new to show — its title, discipline or length (ruling 2a-R8).
 */
function rowChange(row: SlotRow, next: ReturnType<typeof builtRowContent>): { resized: boolean; calendarChanged: boolean } {
  const resized =
    next.calendarBlockDurationSeconds !== row.calendarBlockDurationSeconds ||
    next.fallbackEstimatedDurationSeconds !== row.fallbackEstimatedDurationSeconds;
  return { resized, calendarChanged: resized || next.title !== row.title || next.category !== row.category };
}

export type BuildCtx = { today: string; now: string; prefs: UserPreferences };

/** Everything a build of a slot on its day reads, and the hash over it. */
interface DayInputs {
  date: string;
  /** A day ahead: the build is a preview. */
  preview: boolean;
  /** The day's latest build (the preview, for a day ahead): its choices stand for any the request leaves out. */
  previous: BuildRow | null;
  overrides: BuildOverrides;
  swaps: Swaps;
  context: EngineContext;
  /** The checks the build is made with: the request's, recorded (see `preChecks`), over the day's. */
  checks: Record<string, CheckAnswer>;
  /** What recording the request's checks writes — once the build is made, after the restore check (audit M10). */
  preChecks: PreCheckWrite[];
  block: Block | null;
  programName: string | null;
  history: BuildHistory;
  version: string;
  /** The inputs hash with a given block (the hash a build records is over the block as stored after it). */
  hashOf: (b: Block | null) => Promise<string>;
  inputsHash: string;
}

/**
 * The inputs of a build of `row` on its day — the request's choices over the day's stored ones, the context, the
 * checks, the block, what the build reads of the history — and their hash. Reads only: the request's checks are
 * resolved as they will be once recorded, and recorded by `commitBuild`. A build and Start share it: Start derives
 * the hash again to know the build it locks is still the one the day's inputs make (audit I3). Throws
 * `SessionNotFoundError`, `UnknownProfileError`.
 */
async function dayInputs(db: Db, userId: string, row: SlotRow, builds: readonly BuildRow[], req: BuildRequest, ctx: BuildCtx): Promise<DayInputs> {
  const date = row.effectiveDate;
  const preview = date > ctx.today;

  // The day's choices: what the request sends, else what the day's latest build was made with.
  const previous = builds.find((b) => (preview ? b.version === 0 : b.version > 0) && storedOf(b).build.date === date) ?? null;
  const base = previous ? storedOf(previous).build.params : { checks: {}, overrides: {}, swaps: {} };
  const overrides = (canonical(req.overrides ?? base.overrides) ?? {}) as BuildOverrides;
  // Swaps keep the order they were made in: the engine applies hand-made combinations in that order.
  const swaps: Swaps = req.swaps ?? (same(overrides, base.overrides) ? base.swaps : {});

  let context: EngineContext;
  try {
    context = await loadEngineContext(db, userId, row.planId, {
      ...(overrides.locationId ? { locationId: overrides.locationId } : {}),
      prefs: ctx.prefs,
    });
  } catch (e) {
    if (e instanceof Error && e.message === "program_not_found") throw new SessionNotFoundError();
    throw e;
  }
  const asked = req.checks ?? {};
  if (Object.keys(asked).some((p) => !context.activeProfiles.includes(p))) throw new UnknownProfileError();

  let checks: Record<string, CheckAnswer> = {};
  let preChecks: PreCheckWrite[] = [];
  if (preview) {
    // A day ahead has no checks of its own yet: only what the request answers, never recorded.
    checks = canonical(answeredOnly(asked)) as Record<string, CheckAnswer>;
  } else if (context.activeProfiles.length > 0) {
    const rows = await dayCheckRows(db, userId, date);
    checks = resolveChecks(rows, row.id, date, ctx.today, context.activeProfiles, asked);
    preChecks = preCheckWrites(asked, rows, row.id);
  }

  // What the build reads of the history depends on the block (a running block's lifts are judged since it started).
  const [block, [program]] = await Promise.all([
    loadProgramState(db, row.planId),
    db.select({ name: programs.name }).from(programs).where(eq(programs.id, row.planId)).limit(1),
  ]);
  const history = await loadBuildHistory(db, userId, date, block);
  const version = await engineVersion();
  // The engine plans from exactly these (the trimmed sessions and the summary), so they are what the hash covers:
  // a change to the history that this build cannot read is no reason to build again.
  const historyJson = JSON.stringify(history);
  // The whole context the build reads (unit, places, profiles, prefs, saved ids, and the program settings it reads).
  const hashedContext: BuildContext = { ...context, config: buildConfigOf(context.config) };
  const hashOf = (b: Block | null) =>
    sha256Hex(
      JSON.stringify(
        canonical({
          engine: version,
          date,
          programId: row.planId,
          context: hashedContext,
          block: blockKey(b),
          checks,
          overrides,
          swaps: Object.entries(swaps),
        }),
      ) + historyJson,
    );
  return {
    date,
    preview,
    previous,
    overrides,
    swaps,
    context,
    checks,
    preChecks,
    block,
    programName: program?.name ?? null,
    history,
    version,
    hashOf,
    inputsHash: await hashOf(block),
  };
}

/** What a build request did: the session, and whether the slot's calendar event has something new to show. */
export interface BuildOutcome {
  session: SessionResponse;
  calendarChanged: boolean;
}

/** What the row shows of a build it holds: its title, discipline and booked length (`builtRowContent`). */
type RowContent = ReturnType<typeof builtRowContent>;

/**
 * How a build of a slot's day is stored — shared by the engine's builds (`commitBuild`) and a document workout's
 * (`commitDocBuild`), which differ only in how the build is made and in what the row shows of it.
 */
interface BuildStore {
  row: SlotRow;
  builds: readonly BuildRow[];
  /** A day ahead: the build is a preview (version 0), and the row is left alone. */
  preview: boolean;
  /** The checks the build is made with (a preview's response shows none). */
  checks: Record<string, CheckAnswer>;
  /** What recording the request's checks writes, just before the first write (audit M10). */
  preChecks: PreCheckWrite[];
  hidden: ReadonlySet<string>;
  extras: SheetExtras;
  /**
   * What the row takes from a build it holds: an engine build's title, discipline and booked length; null for a
   * document workout, whose row shows its document's already.
   */
  contentOf: (stored: StoredBuild) => RowContent | null;
}

/**
 * The row's changes for holding `stored` as the day's build, and what they mean for the calendar: its content (if
 * any), `built`, and the day's choices as `session_params`.
 */
function builtChanges(s: BuildStore, stored: StoredBuild, now: string) {
  const content = s.contentOf(stored);
  const changes = {
    ...(content ?? {}),
    contentState: "built",
    sessionParams: stored.build.params as unknown as Record<string, unknown>,
    updatedAt: now,
  } satisfies Partial<SlotRow>;
  return { changes, ...(content ? rowChange(s.row, content) : { resized: false, calendarChanged: false }) };
}

/**
 * The stored build is the one the day's inputs make (`previous`, its hash and version matching): nothing new is built.
 * The request's checks are recorded; a slot moved away and back is an outline again (ruling 2a-R7), yet the build it
 * holds is for this date and these inputs — it is built again (audit M1): the row takes the stored build's content
 * again, exactly as that build first wrote it (re-review R2).
 */
async function reuseStored(db: Db, userId: string, s: BuildStore, previous: BuildRow, ctx: BuildCtx): Promise<BuildOutcome> {
  const { row, builds, preview, checks, hidden, extras } = s;
  const rebuilt = !preview && row.contentState !== "built";
  if (s.preChecks.length === 0 && !rebuilt) {
    return { session: respond(row, builds, ctx.today, preview ? {} : checks, hidden, extras), calendarChanged: false };
  }
  const refused = await beginWrite(db, userId, s, ctx);
  if (refused) return refused;
  if (!rebuilt) return { session: respond(row, builds, ctx.today, preview ? {} : checks, hidden, extras), calendarChanged: false };
  const { changes, resized, calendarChanged } = builtChanges(s, storedOf(previous), ctx.now);
  const updated = await db
    .update(plannedWorkouts)
    .set(changes)
    .where(
      and(
        eq(plannedWorkouts.id, row.id),
        eq(plannedWorkouts.userId, userId),
        or(isNull(plannedWorkouts.contentState), eq(plannedWorkouts.contentState, "outline")),
      ),
    )
    .returning({ id: plannedWorkouts.id });
  // Started (or built) meanwhile: what it is now is the answer.
  if (updated.length === 0) {
    return { session: await readResponse(db, userId, await loadSlot(db, userId, row.id), ctx.today), calendarChanged: false };
  }
  if (resized) await separateDayCollisions(db, userId, [row.effectiveDate], ctx.prefs, { from: ctx.today, now: ctx.now });
  return { session: respond({ ...row, ...changes }, builds, ctx.today, checks, hidden, extras), calendarChanged };
}

/**
 * Just before a build's first write: a restore that began while it read and planned refuses it (audit M10) — the slot
 * is answered as it is — else the request's checks are recorded. (An answer that leaves the day's checks as they were,
 * the day's check given again, is still the slot's own.)
 */
async function beginWrite(db: Db, userId: string, s: BuildStore, ctx: BuildCtx): Promise<BuildOutcome | null> {
  if (await restoreInProgress(db, userId)) return { session: await readResponse(db, userId, s.row, ctx.today, s.builds), calendarChanged: false };
  await recordPreChecks(db, userId, s.row.id, s.row.effectiveDate, s.preChecks, ctx.now);
  return null;
}

/**
 * Store a new build: a day ahead's preview (version 0, overwritten, the row left alone), or the day's next version —
 * a Start that landed while it was made wins (audit M2: this version goes, and the request is refused with the locked
 * session), as does a concurrent build that took the version first (its build stands); the row takes the build
 * (`builtChanges`) never over a started or done slot nor while any build of it is locked (re-review R3); a longer
 * session runs the day's collision pass; only the latest unlocked build is kept (ruling P1-R7). The response is made
 * from what this writes (ruling 2a-R8), never read back. Call `beginWrite` first.
 */
async function storeBuild(
  db: Db,
  userId: string,
  s: BuildStore,
  w: { engineVersion: string; inputsHash: string; stored: StoredBuild; workoutDoc: string | null },
  ctx: BuildCtx,
): Promise<BuildOutcome> {
  const { row, builds, hidden, extras } = s;
  const workoutId = row.id;
  const payload = w.stored as unknown as Record<string, unknown>;
  const fields = { engineVersion: w.engineVersion, inputsHash: w.inputsHash, payload, workoutDoc: w.workoutDoc };
  const locked = builds.filter((b) => b.lockedAt !== null);
  if (s.preview) {
    const existing = builds.find((b) => b.version === 0);
    const written: BuildRow = existing
      ? { ...existing, ...fields, createdAt: ctx.now }
      : { id: newId(), userId, workoutId, version: 0, ...fields, lockedAt: null, createdAt: ctx.now };
    if (existing) {
      await db.update(sessionBuilds).set({ ...fields, createdAt: ctx.now }).where(eq(sessionBuilds.id, existing.id));
    } else {
      await db.insert(sessionBuilds).values(written);
    }
    await pruneBuilds(db, workoutId, written.id);
    // A preview leaves the row alone: nothing the calendar shows changed.
    return { session: respond(row, [written, ...locked], ctx.today, {}, hidden, extras), calendarChanged: false };
  }

  const next = Math.max(0, ...builds.map((b) => b.version)) + 1;
  const written: BuildRow = { id: newId(), userId, workoutId, version: next, ...fields, lockedAt: null, createdAt: ctx.now };
  const refuse = async (): Promise<never> => {
    await db.delete(sessionBuilds).where(and(eq(sessionBuilds.id, written.id), isNull(sessionBuilds.lockedAt)));
    throw new SessionLockedError(await readResponse(db, userId, await loadSlot(db, userId, workoutId), ctx.today));
  };
  await db.insert(sessionBuilds).values(written).onConflictDoNothing();
  const race = await db
    .select({ id: sessionBuilds.id, lockedAt: sessionBuilds.lockedAt })
    .from(sessionBuilds)
    .where(and(eq(sessionBuilds.workoutId, workoutId), or(eq(sessionBuilds.id, written.id), isNotNull(sessionBuilds.lockedAt))));
  // A concurrent build took this version first: its build stands.
  if (!race.some((b) => b.id === written.id)) {
    return { session: await readResponse(db, userId, await loadSlot(db, userId, workoutId), ctx.today), calendarChanged: false };
  }
  if (race.some((b) => b.lockedAt !== null)) return refuse();

  const { changes, resized, calendarChanged } = builtChanges(s, w.stored, ctx.now);
  const updated = await db
    .update(plannedWorkouts)
    .set(changes)
    .where(
      and(
        eq(plannedWorkouts.id, workoutId),
        eq(plannedWorkouts.userId, userId),
        or(isNull(plannedWorkouts.contentState), notInArray(plannedWorkouts.contentState, ["started", "done"])),
        notExists(
          db
            .select({ id: sessionBuilds.id })
            .from(sessionBuilds)
            .where(and(eq(sessionBuilds.workoutId, workoutId), isNotNull(sessionBuilds.lockedAt))),
        ),
      ),
    )
    .returning({ id: plannedWorkouts.id });
  if (updated.length === 0) return refuse();
  // A longer session can now overlap the day's other plans: the same retime placement and coach edits use.
  if (resized) await separateDayCollisions(db, userId, [row.effectiveDate], ctx.prefs, { from: ctx.today, now: ctx.now });
  await pruneBuilds(db, workoutId, written.id);
  return {
    session: respond({ ...row, ...changes }, [written, ...locked], ctx.today, s.checks, hidden, extras),
    // The calendar shows the row's title, discipline and booked length; a build that keeps all three (a swap, a
    // check that keeps the theme) leaves the event to the half-hourly reconcile (ruling 2a-R8).
    calendarChanged,
  };
}

/** An engine build's row content: `<program> · <theme>`, its discipline (§9.2) and its booked length. */
const engineContentOf = (row: SlotRow, programName: string | null) => (stored: StoredBuild): RowContent =>
  builtRowContent(programName ?? row.title, stored.view.theme, stored.build.plannedSeconds, stored.build.items.some((i) => i.block === "core"));

/**
 * Build from `inputs`, or return the stored build when its hash matches them (nothing written); store the build and
 * the day's row as the rules say.
 */
async function commitBuild(
  db: Db,
  userId: string,
  row: SlotRow,
  builds: readonly BuildRow[],
  inputs: DayInputs,
  ctx: BuildCtx,
): Promise<BuildOutcome> {
  const { date, preview, previous, overrides, swaps, context, checks, block, history, version, hashOf, inputsHash } = inputs;
  const s: BuildStore = {
    row,
    builds,
    preview,
    checks,
    preChecks: inputs.preChecks,
    hidden: hiddenFrom(context.prefs),
    extras: sheetExtras(context),
    contentOf: engineContentOf(row, inputs.programName),
  };
  if (previous && previous.inputsHash === inputsHash && previous.engineVersion === version) return reuseStored(db, userId, s, previous, ctx);

  const composed = composeBuild({ date, programId: row.planId, context, block, history: history.sessions, summary: history.summary, checks, overrides, swaps });
  const refused = await beginWrite(db, userId, s, ctx);
  if (refused) return refused;

  // A preview never starts or rotates a block: that happens on the session's day.
  let blockRef = block?.id ?? null;
  let recordedHash = inputsHash;
  if (!preview && composed.blockUpdate) {
    blockRef = await saveProgramState(db, row.planId, composed.blockUpdate.block, ctx.now);
    recordedHash = await hashOf({ ...composed.blockUpdate.block, id: blockRef });
  }
  const stored: StoredBuild = {
    build: { engineVersion: version, inputsHash: recordedHash, builtAt: ctx.now, blockRef, ...composed.build },
    view: composed.view,
  };
  // The build's workout document, in the same statement as the build (Stage 1 dual-write): a snapshot of this build,
  // no revisions. A conversion that fails is logged by its code and stored as NULL — never a failed build.
  const workoutDoc = storedDocText(docForBuild(stored.build));
  return storeBuild(db, userId, s, { engineVersion: version, inputsHash: recordedHash, stored, workoutDoc }, ctx);
}

// ── A document workout's build (Stage 2 spec §10; programme spec §3.11) ──────────────────────────────────────────
//
// A Studio or template row (`docOriginRow`) is played through this same path — the same versions, preview, lock,
// prune, pre-checks and Start contract (`reuseStored`, `beginWrite`, `storeBuild`, `lockProven`) — but its build is
// MATERIALISED from the row's document (`doc-build.ts`) instead of composed by the engine: no programme, no block, no
// history. The day's choices are its checks only (a document's moves, mode and length are its own: overrides and swaps
// in a request are not read, and the sheet is offered none). The row's title, discipline and booked length are the
// document's, written when it was made or revised, so a build changes nothing the calendar shows. The inputs hash
// covers the row's document text and revision, the day's checks, the active profiles and the place: a revision or a
// new reading makes the shown build stale, and Start then answers with the fresh one (audit I3's contract), which
// carries any swap the reading made — or refuses (`GatedError`).

/** Everything a document build of a row on its day reads, and the hash over it. */
interface DocDayInputs {
  date: string;
  preview: boolean;
  /** The day's latest build (the preview, for a day ahead). */
  previous: BuildRow | null;
  doc: WorkoutDoc;
  rev: number | null;
  context: EngineContext;
  checks: Record<string, CheckAnswer>;
  preChecks: PreCheckWrite[];
  /**
   * The jumps the athlete has done cleanly (`doneCleanlyOf` over library-view's one-statement `doneStats`): the frontier
   * the build's ⇄ honours, and which jump is new. Read only when the document holds a jump (an item or an alternate:
   * only then can an option be one); empty otherwise.
   */
  jumpsDone: ReadonlySet<string>;
  version: string;
  inputsHash: string;
}

/** The library's jumps: what a document build's frontier is read for. */
const JUMP_IDS: readonly string[] = EXERCISES.filter(isPlyometric).map((e) => e.id);

/** Whether a document holds a jump — an item or one of its alternates — so that an option of its ⇄ could be one. */
function docHoldsJump(doc: WorkoutDoc): boolean {
  const find = makeLibraryIndex(EXERCISES);
  const jump = (id: string): boolean => {
    const rec = find(id);
    return rec !== undefined && isPlyometric(rec);
  };
  return doc.parts.some((p) => p.items.some((i) => i.kind === "exercise" && (jump(i.libraryId) || (i.alternates ?? []).some((a) => jump(a.libraryId)))));
}

/** The place as a session's view carries it: its gear and its implement weights, for the player offline. */
const viewLocationOf = (l: EngineContext["location"]): SessionView["location"] => ({
  id: l.id,
  name: l.name ?? l.id,
  equipment: [...l.equipment],
  implements: Object.fromEntries(Object.entries(l.implements ?? {}).map(([k, ws]) => [k, ws.map((w) => ({ v: w.v, u: w.u }))])),
});

/**
 * A document workout's sheet: its profiles (the pre-check), and no choices — its mode, moves and place are its
 * document's, and a build request's overrides are not read.
 */
const docExtras = (activeProfiles: readonly string[]): SheetExtras => ({
  profiles: activeProfiles.map(conditionView),
  choices: { modes: [], themes: [], locations: [] },
});

/**
 * What the validator reads of the day for a document build: only its errors decide the build; the jumps done cleanly
 * (`jumpsDone`) keep its ⇄ on the athlete's frontier.
 */
const docValidateCtx = (
  context: EngineContext,
  checks: Record<string, CheckAnswer>,
  date: string,
  today: string,
  jumpsDone: ReadonlySet<string>,
): ValidateCtx =>
  dayValidateCtx({ profiles: context.activeProfiles, checks, date, today, excluded: context.prefs.excluded, equipment: context.location.equipment, done: jumpsDone });

/** The day's checks for a document row (the request's, recorded, over the day's) and its context; reads only. */
async function docDay(
  db: Db,
  userId: string,
  row: SlotRow,
  req: BuildRequest,
  ctx: BuildCtx,
  placeId: string | undefined,
): Promise<Pick<DocDayInputs, "context" | "checks" | "preChecks">> {
  const date = row.effectiveDate;
  const context = await loadEngineContext(db, userId, null, { ...(placeId ? { locationId: placeId } : {}), prefs: ctx.prefs });
  const asked = req.checks ?? {};
  if (Object.keys(asked).some((p) => !context.activeProfiles.includes(p))) throw new UnknownProfileError();
  if (date > ctx.today) return { context, checks: canonical(answeredOnly(asked)) as Record<string, CheckAnswer>, preChecks: [] };
  if (context.activeProfiles.length === 0) return { context, checks: {}, preChecks: [] };
  const rows = await dayCheckRows(db, userId, date);
  return {
    context,
    checks: resolveChecks(rows, row.id, date, ctx.today, context.activeProfiles, asked),
    preChecks: preCheckWrites(asked, rows, row.id),
  };
}

/** The inputs of a document build of `row` on its day, and their hash. Throws `NoDocumentError`, `UnknownProfileError`. */
async function docDayInputs(db: Db, userId: string, row: SlotRow, builds: readonly BuildRow[], req: BuildRequest, ctx: BuildCtx): Promise<DocDayInputs> {
  const date = row.effectiveDate;
  const preview = date > ctx.today;
  const previous = builds.find((b) => (preview ? b.version === 0 : b.version > 0) && storedOf(b).build.date === date) ?? null;
  const doc = parseStoredWorkoutDoc(row.workoutDoc);
  if (!doc) throw new NoDocumentError();
  const { context, checks, preChecks } = await docDay(db, userId, row, req, ctx, doc.setting?.placeId);
  // One statement, only when an option could be a jump: what the frontier and the one-new-jump rule read.
  const jumpsDone = docHoldsJump(doc)
    ? doneCleanlyOf(await doneStats(db, userId, ctx.today, ctx.today), context.activeProfiles.filter(isProfileId).map((id) => PROFILES[id]), JUMP_IDS)
    : new Set<string>();
  const version = await docBuildVersion();
  const rev = row.workoutDocRev ?? null;
  const inputsHash = await sha256Hex(
    JSON.stringify(
      canonical({
        engine: version, date, doc: row.workoutDoc, rev, checks, profiles: context.activeProfiles, location: context.location, unit: context.unit,
        jumpsDone: [...jumpsDone].sort(),
      }),
    ),
  );
  return { date, preview, previous, doc, rev, context, checks, preChecks, jumpsDone, version, inputsHash };
}

/**
 * Build a document row from `inputs`, or return the stored build when its hash matches them; stored as `commitBuild`
 * stores one (`storeBuild`). A day ahead has no reading yet: its preview plays the document as it stands, and the
 * day's own build gates it.
 */
async function commitDocBuild(
  db: Db,
  userId: string,
  row: SlotRow,
  builds: readonly BuildRow[],
  inputs: DocDayInputs,
  ctx: BuildCtx,
): Promise<BuildOutcome> {
  const { date, preview, previous, doc, rev, context, checks, version, inputsHash } = inputs;
  const s: BuildStore = {
    row,
    builds,
    preview,
    checks,
    preChecks: inputs.preChecks,
    hidden: hiddenFrom(context.prefs),
    extras: docExtras(context.activeProfiles),
    contentOf: () => null,
  };
  if (previous && previous.inputsHash === inputsHash && previous.engineVersion === version) return reuseStored(db, userId, s, previous, ctx);

  const judge = docValidateCtx(context, checks, date, ctx.today, inputs.jumpsDone);
  const gated = preview ? { doc, swaps: [], blocked: [] } : gateDoc(doc, judge);
  let made: ReturnType<typeof materializeDocBuild>;
  try {
    made = materializeDocBuild(gated.doc, { date, location: viewLocationOf(context.location), checks: preview ? {} : checks, library: EXERCISES, judge });
  } catch (e) {
    // Too large to build (`playerStepsFromDoc` checks the bound before making a step) — today, ahead, or grown past it
    // by the day's swap: refused with the issue, nothing materialised, never a 500.
    if (e instanceof DocTooLargeError) throw new DocTooLargeRefusal([tooLargeIssue(e.message)]);
    throw e;
  }
  const refused = await beginWrite(db, userId, s, ctx);
  if (refused) return refused;
  const facts = docFacts(gated.doc);
  const stored: StoredBuild = {
    build: {
      engineVersion: version,
      inputsHash,
      builtAt: ctx.now,
      blockRef: null,
      ...made.build,
      fromDoc: { rev, swaps: gated.swaps, blocked: gated.blocked, slots: made.slots, ...facts },
    },
    // Today's line of moves says each dose as the builder does.
    view: { ...made.view, lead: sessionLead(made.build, 2, facts.doses) },
  };
  // The snapshot is the document as played: the day's swaps made, the row's own document untouched.
  return storeBuild(db, userId, s, { engineVersion: version, inputsHash, stored, workoutDoc: storedDocText(gated.doc) }, ctx);
}

/**
 * Lock `current` — proven the day's build for its inputs — for Start or Send: Send's preconditions asked of it first
 * (before anything is written, so a refusal locks nothing), a restore checked once more just before the lock (audit
 * M10), then the lock; Start marks the slot `started`, and a slot that is an outline again (moved away and back) takes
 * the build's content as it locks (U4) — Send never reaches an outline (it refuses `not_built` first) and changes
 * nothing on the row; the other unlocked builds are pruned. Shared by the engine's builds and a document's.
 */
async function lockProven(
  db: Db,
  userId: string,
  row: SlotRow,
  builds: readonly BuildRow[],
  current: BuildRow,
  ctx: BuildCtx,
  opts: LockOptions,
  day: { profiles: readonly string[]; checks: Record<string, CheckAnswer>; contentOf: (stored: StoredBuild) => RowContent | null },
): Promise<LockOutcome> {
  const workoutId = row.id;
  await opts.beforeLock?.({ row, build: toPayload(current, new Set()).build, profiles: day.profiles, checks: day.checks });
  if (await restoreInProgress(db, userId)) return { session: await readResponse(db, userId, row, ctx.today, builds), calendarChanged: false, lockedNow: false };

  const adopted = opts.as === "start" && (row.contentState === null || row.contentState === "outline");
  const stored = storedOf(current);
  const content = adopted ? day.contentOf(stored) : null;
  await db.update(sessionBuilds).set({ lockedAt: ctx.now }).where(eq(sessionBuilds.id, current.id));
  if (opts.as === "start") {
    await db
      .update(plannedWorkouts)
      .set({
        ...(adopted ? { ...(content ?? {}), sessionParams: stored.build.params as unknown as Record<string, unknown> } : {}),
        contentState: "started",
        updatedAt: ctx.now,
      })
      .where(and(eq(plannedWorkouts.id, workoutId), eq(plannedWorkouts.userId, userId)));
  }
  await pruneBuilds(db, workoutId, current.id);
  let calendarChanged = false;
  if (content) {
    const change = rowChange(row, content);
    calendarChanged = change.calendarChanged;
    if (change.resized) await separateDayCollisions(db, userId, [row.effectiveDate], ctx.prefs, { from: ctx.today, now: ctx.now });
  }
  return { session: await readResponse(db, userId, await loadSlot(db, userId, workoutId), ctx.today), calendarChanged, lockedNow: true };
}

/**
 * Start's and Send's lock of a document row's current build, once it is proven to be the build the day's inputs make
 * (else the fresh build: `StaleBuildError`, or `GatedError` when it is blocked). A blocked build never locks.
 */
async function lockDocBuild(
  db: Db,
  userId: string,
  row: SlotRow,
  builds: readonly BuildRow[],
  current: BuildRow,
  buildId: string,
  ctx: BuildCtx,
  opts: LockOptions,
): Promise<LockOutcome> {
  const inputs = await docDayInputs(db, userId, row, builds, {}, ctx);
  if (current.id !== buildId || current.inputsHash !== inputs.inputsHash || current.engineVersion !== inputs.version) {
    const fresh = await commitDocBuild(db, userId, row, builds, inputs, ctx);
    const blocked = fresh.session.build?.fromDoc?.blocked ?? [];
    if (blocked.length > 0) throw new GatedError(blocked);
    throw new StaleBuildError(fresh.session, fresh.calendarChanged);
  }
  const blocked = storedOf(current).build.fromDoc?.blocked ?? [];
  if (blocked.length > 0) throw new GatedError(blocked);
  return lockProven(db, userId, row, builds, current, ctx, opts, { profiles: inputs.context.activeProfiles, checks: inputs.checks, contentOf: () => null });
}

/**
 * A sent document build, about to Start (it is locked: what it plays cannot change): its snapshot judged with the day's
 * reading (`snapshotErrors`). A move the day now keeps out refuses Start with the issues (`GatedError`); take it off
 * the watch to rebuild. What ⇄ may offer is judged too (`slotsForDay`): the build's slots with an alternate or offer
 * the day now keeps out taken off — only its options, never what it plays (nor the watch's copy) — when one is; else
 * null. Reads only: the caller writes them (`$.build.fromDoc.slots` alone) as the build starts.
 */
async function refuseGatedSnapshot(db: Db, userId: string, row: SlotRow, sent: BuildRow, today: string): Promise<Record<string, DocSlot> | null> {
  const snapshot = parseStoredWorkoutDoc(sent.workoutDoc);
  if (!snapshot) return null;
  const profiles = await activeProfilesOf(db, userId);
  const checks = await slotChecks(db, userId, row.id, row.effectiveDate, today, profiles);
  const day = dayValidateCtx({ profiles, checks, date: row.effectiveDate, today });
  const errors = snapshotErrors(snapshot, day);
  if (errors.length > 0) throw new GatedError(errors);
  const stored = storedOf(sent);
  const slots = stored.build.fromDoc?.slots;
  if (!slots) return null;
  const open = slotsForDay(slots, snapshot, day);
  return JSON.stringify(open) === JSON.stringify(slots) ? null : open;
}

/**
 * `POST /api/sessions/:workoutId/build`, with what it means for the calendar. Throws `SessionNotFoundError`,
 * `SessionLockedError` (carrying the locked session), `NotTodayError`, `UnknownProfileError`, and for a document
 * workout `NoDocumentError` and `DocTooLargeRefusal`.
 */
export async function buildSessionOutcome(
  db: Db,
  userId: string,
  workoutId: string,
  req: BuildRequest,
  ctx: BuildCtx,
): Promise<BuildOutcome> {
  const row = await loadSlot(db, userId, workoutId);
  const builds = await loadBuilds(db, userId, workoutId);
  if (lockedOf(row, builds)) throw new SessionLockedError(await readResponse(db, userId, row, ctx.today, builds));
  if (row.effectiveDate < ctx.today) throw new NotTodayError(row.effectiveDate, ctx.today);
  if (await restoreInProgress(db, userId)) return { session: await readResponse(db, userId, row, ctx.today, builds), calendarChanged: false };
  if (docOriginRow(row)) return commitDocBuild(db, userId, row, builds, await docDayInputs(db, userId, row, builds, req, ctx), ctx);
  return commitBuild(db, userId, row, builds, await dayInputs(db, userId, row, builds, req, ctx), ctx);
}

/** `POST /api/sessions/:workoutId/build` (see `buildSessionOutcome`): the session. */
export async function buildSession(db: Db, userId: string, workoutId: string, req: BuildRequest, ctx: BuildCtx): Promise<SessionResponse> {
  return (await buildSessionOutcome(db, userId, workoutId, req, ctx)).session;
}

/**
 * `POST /api/sessions/:workoutId/start` `{buildId}`: lock the build the athlete was shown (`locked_at`,
 * `content_state = 'started'`) — only while it is still the day's current build and the day's inputs still make it.
 * The inputs hash is derived again, so a check, a saved session, a rating or a place changed since the build makes
 * it stale: `StaleBuildError` then carries the fresh build, made as `POST /build {}` makes it, and nothing is locked
 * (audit I3). Idempotent: a started or done slot returns as it is, whatever build id is named. Throws
 * `SessionNotFoundError`, `NotTodayError` (a day ahead is a preview, never lockable; a day gone is not today),
 * `NotBuiltError`, `StaleBuildError`.
 */
export async function startSession(db: Db, userId: string, workoutId: string, buildId: string, now: string): Promise<SessionResponse> {
  return (await startSessionOutcome(db, userId, workoutId, buildId, now)).session;
}

/**
 * `POST /api/sessions/:workoutId/start` (see `startSession`), with what it means for the calendar: a row that is an
 * outline again (moved away and back, and refreshed meanwhile) takes the build's title, discipline and length as Start
 * locks it, as a build request would have written them (2a UI re-review U4) — the player may Start what the device
 * holds with no build request first.
 */
export async function startSessionOutcome(
  db: Db,
  userId: string,
  workoutId: string,
  buildId: string,
  now: string,
): Promise<{ session: SessionResponse; calendarChanged: boolean }> {
  return lockCurrentBuild(db, userId, workoutId, buildId, now, { as: "start" });
}

/** Start's or Send's lock (`lockCurrentBuild`). */
export interface LockOptions {
  as: "start" | "send";
  /** The caller's preferences, already loaded (Send's budget, ruling 3-R11); read here otherwise. */
  prefs?: UserPreferences;
  /**
   * Send's own preconditions, asked of the build about to be locked once it is proven current — before anything is
   * written, so a refusal thrown here locks nothing. Not asked of a build that was locked already.
   */
  beforeLock?: (v: { row: SlotRow; build: BuildPayload; profiles: readonly string[]; checks: Record<string, CheckAnswer> }) => Promise<void>;
}

export interface LockOutcome {
  session: SessionResponse;
  calendarChanged: boolean;
  lockedNow: boolean;
}

/**
 * Lock the build the athlete was shown — Start's lock, and Send to watch's (Phase 3, ruling 3-R2): only while it is
 * still the day's current build and the day's inputs still make it, else `StaleBuildError` with the fresh build (made
 * as `POST /build {}` makes it) and nothing locked. `as: "start"` marks the slot `started` (an outline again takes the
 * build's content, U4); `as: "send"` sets `locked_at` and leaves `content_state` as it is — the slot stays `built`
 * until it is started or done. A slot already locked returns as it is. Throws `SessionNotFoundError`,
 * `NotTodayError`, `NotBuiltError`, `StaleBuildError`, and for a document workout `GatedError` (the day's reading keeps
 * a move out that no alternate stands in for — also on Start of the build already on the watch) and `NoDocumentError`.
 */
export async function lockCurrentBuild(
  db: Db,
  userId: string,
  workoutId: string,
  buildId: string,
  now: string,
  opts: LockOptions,
): Promise<LockOutcome> {
  const row = await loadSlot(db, userId, workoutId);
  const prefs = opts.prefs ?? (await loadPreferences(db, userId));
  const today = todayInZone(prefs.timezone, new Date(now));
  const builds = await loadBuilds(db, userId, workoutId);
  const unchanged = async (session: Promise<SessionResponse>) => ({ session: await session, calendarChanged: false, lockedNow: false });
  if (lockedOf(row, builds)) {
    // START ON A SENT BUILD (Phase 3, spec §4.4): the athlete takes the phone along. The slot is `built` with the
    // build on the watch locked; Start plays that very build — `started`, no rebuild, no new hash check (what a locked
    // build plays never changes). It must be the build the athlete was shown, on the slot's day.
    if (opts.as === "start" && row.contentState === "built") {
      const sent = await sentBuildIdOf(db, workoutId);
      const locked = builds.find((b) => b.lockedAt !== null);
      if (sent && locked && sent === locked.id) {
        if (row.effectiveDate !== today) throw new NotTodayError(row.effectiveDate, today);
        if (buildId !== sent) throw new StaleBuildError(await readResponse(db, userId, row, today, builds), false);
        // A document workout re-gates at Start (Stage 2 spec §10), even the very build on the watch.
        const trimmed = docOriginRow(row) ? await refuseGatedSnapshot(db, userId, row, locked, today) : null;
        if (await restoreInProgress(db, userId)) return unchanged(readResponse(db, userId, row, today, builds));
        // Only the options, in place: whatever else the payload holds now (a stamp written since it was read) stays.
        if (trimmed) {
          await db
            .update(sessionBuilds)
            .set({ payload: sql`json_set(${sessionBuilds.payload}, '$.build.fromDoc.slots', json(${JSON.stringify(trimmed)}))` })
            .where(eq(sessionBuilds.id, locked.id));
        }
        await db
          .update(plannedWorkouts)
          .set({ contentState: "started", updatedAt: now })
          .where(and(eq(plannedWorkouts.id, workoutId), eq(plannedWorkouts.userId, userId), eq(plannedWorkouts.contentState, "built")));
        return unchanged(readResponse(db, userId, await loadSlot(db, userId, workoutId), today));
      }
    }
    return unchanged(readResponse(db, userId, row, today, builds));
  }
  if (row.effectiveDate !== today) throw new NotTodayError(row.effectiveDate, today);
  const current = currentBuild(row, builds, today);
  if (!current) throw new NotBuiltError();
  if (await restoreInProgress(db, userId)) return unchanged(readResponse(db, userId, row, today, builds));

  const ctx: BuildCtx = { today, now, prefs };
  if (docOriginRow(row)) return lockDocBuild(db, userId, row, builds, current, buildId, ctx, opts);
  const inputs = await dayInputs(db, userId, row, builds, {}, ctx);
  if (current.id !== buildId || current.inputsHash !== inputs.inputsHash || current.engineVersion !== inputs.version) {
    const fresh = await commitBuild(db, userId, row, builds, inputs, ctx);
    throw new StaleBuildError(fresh.session, fresh.calendarChanged);
  }
  return lockProven(db, userId, row, builds, current, ctx, opts, {
    profiles: inputs.context.activeProfiles,
    checks: inputs.checks,
    contentOf: engineContentOf(row, inputs.programName),
  });
}

/** A push job's id for a build (`push:<buildId>`): one per build, so sending the same build twice is one job. */
export const pushJobId = (buildId: string): string => `push:${buildId}`;

/** Push statuses that no longer hold a copy on the watch, nor will put one there. */
export const SETTLED_PUSH = ["superseded", "cancelled", "restored"] as const;

/**
 * The slot's locked build that a non-superseded `program_session_push` names — the build that was sent; null when
 * none was sent (Phase 3). A failed push still names its build: Retry sends that build again.
 */
export async function sentBuildIdOf(db: Db, workoutId: string): Promise<string | null> {
  const locked = await db
    .select({ id: sessionBuilds.id })
    .from(sessionBuilds)
    .where(and(eq(sessionBuilds.workoutId, workoutId), isNotNull(sessionBuilds.lockedAt)));
  if (locked.length === 0) return null;
  const pushes = await db
    .select({ id: corosWriteJobs.id })
    .from(corosWriteJobs)
    .where(
      and(
        inArray(
          corosWriteJobs.id,
          locked.map((b) => pushJobId(b.id)),
        ),
        eq(corosWriteJobs.kind, "program_session_push"),
        notInArray(corosWriteJobs.status, [...SETTLED_PUSH]),
      ),
    );
  const sent = locked.find((b) => pushes.some((j) => j.id === pushJobId(b.id)));
  return sent?.id ?? null;
}

/**
 * `POST /api/sessions/:workoutId/unstart`: the player's Discard (ruling 2b-R9). A started slot goes back to `built`
 * and its build is unlocked, so Today offers Start again rather than a Continue that would replay the discarded
 * session; the sheet then shows the same build (or a fresh one, when the day's inputs moved on), and Start locks it.
 * The build stays on record, marked un-started (ruling 2b-R19): a save made from it on another device may still arrive,
 * and its day is still that session's, even after the slot moves.
 *
 * Refused (`PerformedExistsError`) once a performed session exists for the slot — the session was saved, from this
 * device or another, and a save is never taken back. The refusal is also written into the update itself, so a save
 * landing between the check and the write still wins. Idempotent: a slot already built is answered as it is, with no
 * write. Throws `SessionNotFoundError` for a slot that is not this user's, `RestoringError` while a restore runs.
 */
export async function unstartSession(db: Db, userId: string, workoutId: string, ctx: { today: string; now: string }): Promise<SessionResponse> {
  const row = await loadSlot(db, userId, workoutId);
  const builds = await loadBuilds(db, userId, workoutId);
  const saved = () =>
    db
      .select({ id: performedSessions.id })
      .from(performedSessions)
      .where(and(eq(performedSessions.userId, userId), eq(performedSessions.workoutId, workoutId)))
      .limit(1);
  if (row.contentState === "done" || (await saved()).length > 0) throw new PerformedExistsError();
  if (row.contentState !== "started" && !builds.some((b) => b.lockedAt !== null)) return readResponse(db, userId, row, ctx.today, builds);
  if (await restoreInProgress(db, userId)) throw new RestoringError();
  await db
    .update(plannedWorkouts)
    .set({ contentState: "built", updatedAt: ctx.now })
    .where(
      and(
        eq(plannedWorkouts.id, workoutId),
        eq(plannedWorkouts.userId, userId),
        eq(plannedWorkouts.contentState, "started"),
        notExists(
          db
            .select({ id: performedSessions.id })
            .from(performedSessions)
            .where(and(eq(performedSessions.userId, userId), eq(performedSessions.workoutId, workoutId))),
        ),
      ),
    );
  const after = await loadSlot(db, userId, workoutId);
  if (after.contentState !== "built") throw new PerformedExistsError();
  // A build on its way to the watch, or on it (Phase 3, spec §4.4), stays locked: the watch holds that build, and
  // Start plays it again. A failed push holds nothing; its build unlocks as any other.
  const sent = await sentBuildIdOf(db, workoutId);
  const [push] = sent ? await db.select({ status: corosWriteJobs.status }).from(corosWriteJobs).where(eq(corosWriteJobs.id, pushJobId(sent))) : [];
  const keep = sent && push && push.status !== "failed" && push.status !== "needs_attention" ? sent : null;
  // Unlocked, but kept on record with its day (ruling 2b-R19): another device's save made from it may still arrive.
  await db
    .update(sessionBuilds)
    .set({ lockedAt: null, payload: sql`json_set(${sessionBuilds.payload}, ${UNSTARTED_AT_PATH}, ${ctx.now})` })
    .where(
      and(
        eq(sessionBuilds.workoutId, workoutId),
        eq(sessionBuilds.userId, userId),
        isNotNull(sessionBuilds.lockedAt),
        ...(keep ? [ne(sessionBuilds.id, keep)] : []),
      ),
    );
  return readResponse(db, userId, after, ctx.today);
}

/** `GET /api/sessions/:workoutId/current`: whether the build the slot shows is still the one its day's inputs make. */
export interface SessionCurrency {
  workoutId: string;
  /** The build the slot shows (`GET /api/sessions/:workoutId`'s); null when it has none. */
  buildId: string | null;
  /**
   * Start would lock this build as it is: it is locked already, or it is today's (or the preview ahead's) and the
   * day's inputs still hash to it with this engine. False means the sheet builds again (`POST …/build`).
   */
  current: boolean;
  locked: boolean;
}

/**
 * Is the slot's build still current? Reads the day's inputs and hashes them, exactly as Start does — never composes
 * a build and never writes, so opening the sheet need not POST a build every time. Throws `SessionNotFoundError`.
 */
export async function sessionCurrency(db: Db, userId: string, workoutId: string, ctx: BuildCtx): Promise<SessionCurrency> {
  const row = await loadSlot(db, userId, workoutId);
  const builds = await loadBuilds(db, userId, workoutId);
  const shown = currentBuild(row, builds, ctx.today);
  const out = { workoutId, buildId: shown?.id ?? null, locked: lockedOf(row, builds) };
  if (out.locked) return { ...out, current: shown !== null };
  if (!shown || row.effectiveDate < ctx.today) return { ...out, current: false };
  // A slot moved away and back is an outline again: its stored build needs a build request to be the row's again.
  if (shown.version > 0 && row.contentState !== "built") return { ...out, current: false };
  const inputs = docOriginRow(row) ? await docDayInputs(db, userId, row, builds, {}, ctx) : await dayInputs(db, userId, row, builds, {}, ctx);
  return { ...out, current: shown.inputsHash === inputs.inputsHash && shown.engineVersion === inputs.version };
}

/**
 * `POST /api/conditions/checks`: the day's check for one active profile (the Today chip), one per profile per
 * day, replaced on a re-check. Null (nothing written) while a restore is replacing the account. Throws
 * `UnknownProfileError` for a profile the account has not switched on.
 */
export async function recordCheck(
  db: Db,
  userId: string,
  input: { profileId: string; value: number | null; feelingOff: boolean },
  ctx: { today: string; now: string },
): Promise<RecordedCheck | null> {
  if (await restoreInProgress(db, userId)) return null;
  if (!(await activeProfilesOf(db, userId)).includes(input.profileId)) throw new UnknownProfileError();
  await db
    .delete(conditionChecks)
    .where(
      and(
        eq(conditionChecks.userId, userId),
        eq(conditionChecks.profileId, input.profileId),
        eq(conditionChecks.kind, "daily"),
        eq(conditionChecks.localDate, ctx.today),
      ),
    );
  await db.insert(conditionChecks).values({
    id: newId(),
    userId,
    profileId: input.profileId,
    kind: "daily",
    value: input.value,
    feelingOff: input.feelingOff,
    localDate: ctx.today,
    at: ctx.now,
    performedSessionId: null,
    workoutId: null,
  });
  return { profileId: input.profileId, date: ctx.today, value: input.value, feelingOff: input.feelingOff };
}
