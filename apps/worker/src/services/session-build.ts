/**
 * A SLOT'S SESSION, BUILT ON ITS DAY (Phase 2 spec §2a "Build API"; programme spec §7.2–7.3, §9.2, §10.1–10.2).
 *
 * The one place the worker calls the session engine. A program slot (or an on-demand session) is an outline until
 * its day; opening it builds the session from what the database holds (`engine-inputs.ts`) and the day's own
 * choices — checks, overrides (mode, theme, minutes, place) and swaps.
 *
 * THE RULES
 *  - Only live `program` / `on_demand` rows of this user. Anything else is not found.
 *  - A started or done slot is LOCKED: its build never changes, and any build request is refused with the locked
 *    build (409 `locked`). Start locks the latest build of the day.
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
import { and, eq, inArray, isNotNull, isNull, ne, notExists, notInArray, or, sql } from "drizzle-orm";
import { conditionChecks, exercisePrefs, performedSessions, plannedWorkouts, programs, sessionBuilds, userConditions } from "@rg/database";
import { newId, sessionLead, todayInZone, type AdaptiveConfig, type SessionLead, type UserPreferences, type Weight } from "@rg/domain";
import {
  CORE_FAMILIES,
  COVERAGE_TARGETS,
  EXERCISES,
  FORMATS,
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
/** The engine version plus a fingerprint of the library data it plans from, computed once per isolate. */
function engineVersion(): Promise<string> {
  libraryHash ??= sha256Hex(
    JSON.stringify({ EXERCISES, THEMES, FORMATS, MODES, CORE_FAMILIES, COVERAGE_TARGETS, SKELETON, PROFILES }),
  );
  return libraryHash.then((h) => `${ENGINE_VERSION}+${h.slice(0, 12)}`);
}

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

async function loadSlot(db: Db, userId: string, workoutId: string): Promise<SlotRow> {
  const [row] = await db
    .select()
    .from(plannedWorkouts)
    .where(and(eq(plannedWorkouts.id, workoutId), eq(plannedWorkouts.userId, userId)))
    .limit(1);
  if (!row || row.archivedAt !== null || (row.origin !== "program" && row.origin !== "on_demand")) {
    throw new SessionNotFoundError();
  }
  return row;
}

async function loadBuilds(db: Db, userId: string, workoutId: string): Promise<BuildRow[]> {
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

async function activeProfilesOf(db: Db, userId: string): Promise<string[]> {
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

/** The slot's checks on `date` (see `resolveChecks`), as stored. */
async function slotChecks(
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
  return { build: { buildId: b.id, version: b.version, ...stored.build, alternatives }, view: stored.view };
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
  const state = row.contentState;
  return {
    workoutId: row.id,
    date: row.effectiveDate,
    contentState: state === "built" || state === "started" || state === "done" ? state : "outline",
    locked: lockedOf(row, builds),
    checks,
    build: shown?.build ?? null,
    view: shown?.view ?? null,
    profiles: extras.profiles,
    choices: extras.choices,
  };
}

async function readResponse(db: Db, userId: string, row: SlotRow, today: string, builds?: readonly BuildRow[]): Promise<SessionResponse> {
  const all = builds ?? (await loadBuilds(db, userId, row.id));
  const active = await activeProfilesOf(db, userId);
  const checks = await slotChecks(db, userId, row.id, row.effectiveDate, today, active);
  return respond(row, all, today, checks, await hiddenMoves(db, userId), await loadExtras(db, userId, row));
}

/** `GET /api/sessions/:workoutId`: the slot, its current build (or none), its day's checks, and the lock. */
export async function loadSession(db: Db, userId: string, workoutId: string, today: string): Promise<SessionResponse> {
  return readResponse(db, userId, await loadSlot(db, userId, workoutId), today);
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
const bookedSeconds = (planned: number): number => Math.max(300, Math.ceil(planned / 300) * 300);

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

type BuildCtx = { today: string; now: string; prefs: UserPreferences };

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
  const workoutId = row.id;
  const hidden = hiddenFrom(context.prefs);
  // A restore can begin while a build reads and plans; it is checked again just before the first write (audit M10).
  const restoring = async (): Promise<BuildOutcome | null> =>
    (await restoreInProgress(db, userId)) ? { session: await readResponse(db, userId, row, ctx.today, builds), calendarChanged: false } : null;
  if (previous && previous.inputsHash === inputsHash && previous.engineVersion === version) {
    // A slot moved away and back is an outline again (ruling 2a-R7), yet the build it holds is for this date and these
    // inputs: it is built again (audit M1).
    const rebuilt = !preview && row.contentState !== "built";
    if (inputs.preChecks.length === 0 && !rebuilt) {
      return { session: respond(row, builds, ctx.today, preview ? {} : checks, hidden, sheetExtras(context)), calendarChanged: false };
    }
    const refused = await restoring();
    if (refused) return refused;
    // An answer that leaves the day's checks as they were (the day's check, given again) is still the slot's own.
    await recordPreChecks(db, userId, workoutId, date, inputs.preChecks, ctx.now);
    if (rebuilt) {
      // While it was an outline a placement pass may have given it the program's outline content (its name, default
      // length and discipline): the row takes the stored build's again, exactly as that build first wrote it
      // (re-review R2).
      const stored = storedOf(previous);
      const content = builtRowContent(
        inputs.programName ?? row.title,
        stored.view.theme,
        stored.build.plannedSeconds,
        stored.build.items.some((i) => i.block === "core"),
      );
      const changes = {
        ...content,
        contentState: "built",
        sessionParams: stored.build.params as unknown as Record<string, unknown>,
        updatedAt: ctx.now,
      } satisfies Partial<SlotRow>;
      const updated = await db
        .update(plannedWorkouts)
        .set(changes)
        .where(
          and(
            eq(plannedWorkouts.id, workoutId),
            eq(plannedWorkouts.userId, userId),
            or(isNull(plannedWorkouts.contentState), eq(plannedWorkouts.contentState, "outline")),
          ),
        )
        .returning({ id: plannedWorkouts.id });
      // Started (or built) meanwhile: what it is now is the answer.
      if (updated.length === 0) {
        return { session: await readResponse(db, userId, await loadSlot(db, userId, workoutId), ctx.today), calendarChanged: false };
      }
      const { resized, calendarChanged } = rowChange(row, content);
      if (resized) await separateDayCollisions(db, userId, [date], ctx.prefs, { from: ctx.today, now: ctx.now });
      return { session: respond({ ...row, ...changes }, builds, ctx.today, checks, hidden, sheetExtras(context)), calendarChanged };
    }
    return { session: respond(row, builds, ctx.today, preview ? {} : checks, hidden, sheetExtras(context)), calendarChanged: false };
  }

  const composed = composeBuild({ date, programId: row.planId, context, block, history: history.sessions, summary: history.summary, checks, overrides, swaps });

  const refused = await restoring();
  if (refused) return refused;
  await recordPreChecks(db, userId, workoutId, date, inputs.preChecks, ctx.now);

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

  // The response is made from what this writes (ruling 2a-R8), never read back: the row as updated, and the build as
  // stored — after the prune, the only unlocked build left.
  const payload = stored as unknown as Record<string, unknown>;
  const locked = builds.filter((b) => b.lockedAt !== null);
  if (preview) {
    const existing = builds.find((b) => b.version === 0);
    const written: BuildRow = existing
      ? { ...existing, engineVersion: version, inputsHash: recordedHash, payload, createdAt: ctx.now }
      : { id: newId(), userId, workoutId, version: 0, engineVersion: version, inputsHash: recordedHash, payload, lockedAt: null, createdAt: ctx.now };
    if (existing) {
      await db
        .update(sessionBuilds)
        .set({ engineVersion: version, inputsHash: recordedHash, payload, createdAt: ctx.now })
        .where(eq(sessionBuilds.id, existing.id));
    } else {
      await db.insert(sessionBuilds).values(written);
    }
    await pruneBuilds(db, workoutId, written.id);
    // A preview leaves the row alone: nothing the calendar shows changed.
    return { session: respond(row, [written, ...locked], ctx.today, {}, hidden, sheetExtras(context)), calendarChanged: false };
  }

  const next = Math.max(0, ...builds.map((b) => b.version)) + 1;
  const written: BuildRow = { id: newId(), userId, workoutId, version: next, engineVersion: version, inputsHash: recordedHash, payload, lockedAt: null, createdAt: ctx.now };
  // A Start that landed while this build ran wins (audit M2): this build's version goes, and the request is refused
  // with the locked session, as any build after Start is.
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

  const content = builtRowContent(inputs.programName ?? row.title, composed.view.theme, composed.build.plannedSeconds, composed.hasCoreLift);
  const changes = {
    ...content,
    contentState: "built",
    sessionParams: { checks, overrides, swaps } as unknown as Record<string, unknown>,
    updatedAt: ctx.now,
  } satisfies Partial<SlotRow>;
  // Never over a started or done slot, nor while any build of it is locked: a Start between the check above and here
  // still wins, even one that has locked but not yet marked the slot started (re-review R3).
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
  const { resized, calendarChanged } = rowChange(row, content);
  if (resized) await separateDayCollisions(db, userId, [date], ctx.prefs, { from: ctx.today, now: ctx.now });
  await pruneBuilds(db, workoutId, written.id);
  return {
    session: respond({ ...row, ...changes }, [written, ...locked], ctx.today, checks, hidden, sheetExtras(context)),
    // The calendar shows the row's title, discipline and booked length; a build that keeps all three (a swap, a
    // check that keeps the theme) leaves the event to the half-hourly reconcile (ruling 2a-R8).
    calendarChanged,
  };
}

/**
 * `POST /api/sessions/:workoutId/build`, with what it means for the calendar. Throws `SessionNotFoundError`,
 * `SessionLockedError` (carrying the locked session), `NotTodayError`, `UnknownProfileError`.
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
  const row = await loadSlot(db, userId, workoutId);
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone, new Date(now));
  const builds = await loadBuilds(db, userId, workoutId);
  const unchanged = async (session: Promise<SessionResponse>) => ({ session: await session, calendarChanged: false });
  if (lockedOf(row, builds)) return unchanged(readResponse(db, userId, row, today, builds));
  if (row.effectiveDate !== today) throw new NotTodayError(row.effectiveDate, today);
  const current = currentBuild(row, builds, today);
  if (!current) throw new NotBuiltError();
  if (await restoreInProgress(db, userId)) return unchanged(readResponse(db, userId, row, today, builds));

  const ctx: BuildCtx = { today, now, prefs };
  const inputs = await dayInputs(db, userId, row, builds, {}, ctx);
  if (current.id !== buildId || current.inputsHash !== inputs.inputsHash || current.engineVersion !== inputs.version) {
    const fresh = await commitBuild(db, userId, row, builds, inputs, ctx);
    throw new StaleBuildError(fresh.session, fresh.calendarChanged);
  }
  // A restore can begin while the inputs are read again: checked once more just before the lock (audit M10).
  if (await restoreInProgress(db, userId)) return unchanged(readResponse(db, userId, row, today, builds));

  // An outline again (moved away and back): the row takes the build's content as Start locks it (U4).
  const adopted = row.contentState === null || row.contentState === "outline";
  const stored = storedOf(current);
  const content = adopted
    ? builtRowContent(
        inputs.programName ?? row.title,
        stored.view.theme,
        stored.build.plannedSeconds,
        stored.build.items.some((i) => i.block === "core"),
      )
    : null;
  await db.update(sessionBuilds).set({ lockedAt: now }).where(eq(sessionBuilds.id, current.id));
  await db
    .update(plannedWorkouts)
    .set({
      ...(content ? { ...content, sessionParams: stored.build.params as unknown as Record<string, unknown> } : {}),
      contentState: "started",
      updatedAt: now,
    })
    .where(and(eq(plannedWorkouts.id, workoutId), eq(plannedWorkouts.userId, userId)));
  await pruneBuilds(db, workoutId, current.id);
  let calendarChanged = false;
  if (content) {
    const change = rowChange(row, content);
    calendarChanged = change.calendarChanged;
    if (change.resized) await separateDayCollisions(db, userId, [row.effectiveDate], prefs, { from: today, now });
  }
  return { session: await readResponse(db, userId, await loadSlot(db, userId, workoutId), today), calendarChanged };
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
  // Unlocked, but kept on record with its day (ruling 2b-R19): another device's save made from it may still arrive.
  await db
    .update(sessionBuilds)
    .set({ lockedAt: null, payload: sql`json_set(${sessionBuilds.payload}, ${UNSTARTED_AT_PATH}, ${ctx.now})` })
    .where(and(eq(sessionBuilds.workoutId, workoutId), eq(sessionBuilds.userId, userId), isNotNull(sessionBuilds.lockedAt)));
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
  const inputs = await dayInputs(db, userId, row, builds, {}, ctx);
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
