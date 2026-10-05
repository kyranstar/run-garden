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
 *    re-check); with none, a daily check recorded today is used.
 *  - 👎-rated and "not for me" moves are filtered out of the alternatives in every response (ruling 2a-R1); the
 *    stored build keeps what the engine offered.
 *
 * Every writer here is a no-op while a restore is replacing the account (ruling B2).
 */
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { conditionChecks, exercisePrefs, plannedWorkouts, programs, sessionBuilds, userConditions } from "@rg/database";
import { newId, todayInZone, type UserPreferences } from "@rg/domain";
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
import { loadBuildHistory, loadEngineContext, loadProgramState, saveProgramState, type EngineContext } from "./engine-inputs.js";

/** Bump when the engine's behaviour changes: a stored build from an older engine then no longer matches its inputs. */
export const ENGINE_VERSION = "session-engine-1";

/** A profile's answer before the session: 0–10 (null = no number), and "feeling off". */
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
  location: { id: string; name: string };
  block: { number: number; week: number; weeks: number; core: { family: string; name: string | null }[]; events: string[] } | null;
  /** The exercise id introduced today, if any. */
  newMove: string | null;
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
  /** The slot's day's checks: its own pre-checks, else that day's daily checks (today only). */
  checks: Record<string, CheckAnswer>;
  build: BuildPayload | null;
  view: SessionView | null;
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

/** A check for a condition profile the account has not switched on. */
export class UnknownProfileError extends Error {
  constructor() {
    super("unknown_profile");
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
function engineData(active: readonly string[], care: readonly string[]): EngineData {
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

export interface ComposeInput {
  date: string;
  programId: string;
  context: EngineContext;
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
  const data = engineData(c.activeProfiles, c.careProfiles);
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
  // the nearest allowed mode, and the reasons say so.
  const allowed = c.config.modes;
  let fallback: string | null = null;
  let planned = planWith(input.overrides.mode ? (allowed.includes(input.overrides.mode) ? input.overrides.mode : nearestMode(input.overrides.mode, allowed)) : undefined);
  if (input.overrides.mode && !allowed.includes(input.overrides.mode)) {
    fallback = fallbackReason(input.overrides.mode, nearestMode(input.overrides.mode, allowed));
  } else if (!input.overrides.mode && !allowed.includes(planned.view.proposedMode)) {
    const to = nearestMode(planned.view.proposedMode, allowed);
    planned = planWith(to);
    fallback = fallbackReason(planned.view.proposedMode, to);
    planned = { ...planned, view: { ...planned.view, proposedMode: to } };
  }
  const { view: v, blockUpdate } = planned;
  if (fallback) v.modeReasons = [fallback, ...v.modeReasons];
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
    location: { id: v.location.id, name: v.location.name ?? v.location.id },
    block: {
      number: v.block.number,
      week: v.week,
      weeks: v.block.weeks,
      core: data.coreFamilies.map((f) => ({ family: f.id, name: name(v.block.core[f.id]) })),
      events: v.blockEvents,
    },
    newMove: plan.newMove,
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

/** The slot's checks on `date`: its own pre-checks, else (when `date` is today) the day's daily checks. */
async function slotChecks(
  db: Db,
  userId: string,
  workoutId: string,
  date: string,
  today: string,
  active: readonly string[],
): Promise<Record<string, CheckAnswer>> {
  if (active.length === 0) return {};
  const rows = await db
    .select()
    .from(conditionChecks)
    .where(
      and(
        eq(conditionChecks.userId, userId),
        eq(conditionChecks.localDate, date),
        inArray(conditionChecks.kind, ["pre", "daily"]),
      ),
    );
  const latest = (xs: typeof rows) => [...xs].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))[0];
  const out: Record<string, CheckAnswer> = {};
  for (const profileId of active) {
    const own = latest(rows.filter((r) => r.kind === "pre" && r.workoutId === workoutId && r.profileId === profileId));
    const daily = date === today ? latest(rows.filter((r) => r.kind === "daily" && r.profileId === profileId)) : undefined;
    const pick = own ?? daily;
    if (pick) out[profileId] = { pre: pick.value, feelingOff: pick.feelingOff };
  }
  return out;
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

function respond(
  row: SlotRow,
  builds: readonly BuildRow[],
  today: string,
  checks: Record<string, CheckAnswer>,
  hidden: ReadonlySet<string>,
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
  };
}

async function readResponse(db: Db, userId: string, row: SlotRow, today: string, builds?: readonly BuildRow[]): Promise<SessionResponse> {
  const all = builds ?? (await loadBuilds(db, userId, row.id));
  const active = await activeProfilesOf(db, userId);
  const checks = await slotChecks(db, userId, row.id, row.effectiveDate, today, active);
  return respond(row, all, today, checks, await hiddenMoves(db, userId));
}

/** `GET /api/sessions/:workoutId`: the slot, its current build (or none), its day's checks, and the lock. */
export async function loadSession(db: Db, userId: string, workoutId: string, today: string): Promise<SessionResponse> {
  return readResponse(db, userId, await loadSlot(db, userId, workoutId), today);
}

// ── Writes ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Record the body's checks as this slot's pre-checks for `date`, replacing any answer that changed. */
async function recordPreChecks(
  db: Db,
  userId: string,
  workoutId: string,
  date: string,
  checks: Record<string, CheckAnswer>,
  now: string,
): Promise<void> {
  const profiles = Object.keys(checks);
  if (profiles.length === 0) return;
  const existing = await db
    .select()
    .from(conditionChecks)
    .where(
      and(
        eq(conditionChecks.userId, userId),
        eq(conditionChecks.workoutId, workoutId),
        eq(conditionChecks.localDate, date),
        eq(conditionChecks.kind, "pre"),
        inArray(conditionChecks.profileId, profiles),
      ),
    );
  for (const profileId of profiles.sort()) {
    const answer = checks[profileId]!;
    const mine = existing.filter((r) => r.profileId === profileId);
    if (mine.length === 1 && mine[0]!.value === answer.pre && mine[0]!.feelingOff === answer.feelingOff) continue;
    if (mine.length > 0) {
      await db.delete(conditionChecks).where(inArray(conditionChecks.id, mine.map((r) => r.id)));
    }
    await db.insert(conditionChecks).values({
      id: newId(),
      userId,
      profileId,
      kind: "pre",
      value: answer.pre,
      feelingOff: answer.feelingOff,
      localDate: date,
      at: now,
      performedSessionId: null,
      workoutId,
    });
  }
}

/** Keep one unlocked build per workout — `keep` — plus any locked one. */
async function pruneBuilds(db: Db, workoutId: string, keep: string): Promise<void> {
  await db
    .delete(sessionBuilds)
    .where(and(eq(sessionBuilds.workoutId, workoutId), ne(sessionBuilds.id, keep), isNull(sessionBuilds.lockedAt)));
}

/** Planned seconds as the calendar books them: rounded up to 5 minutes. */
const bookedSeconds = (planned: number): number => Math.max(300, Math.ceil(planned / 300) * 300);

/**
 * `POST /api/sessions/:workoutId/build`. Throws `SessionNotFoundError`, `SessionLockedError` (carrying the
 * locked session), `NotTodayError`, `UnknownProfileError`.
 */
export async function buildSession(
  db: Db,
  userId: string,
  workoutId: string,
  req: BuildRequest,
  ctx: { today: string; now: string; prefs: UserPreferences },
): Promise<SessionResponse> {
  const row = await loadSlot(db, userId, workoutId);
  const builds = await loadBuilds(db, userId, workoutId);
  if (lockedOf(row, builds)) throw new SessionLockedError(await readResponse(db, userId, row, ctx.today, builds));
  const date = row.effectiveDate;
  if (date < ctx.today) throw new NotTodayError(date, ctx.today);
  if (await restoreInProgress(db, userId)) return readResponse(db, userId, row, ctx.today, builds);
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

  let checks: Record<string, CheckAnswer>;
  if (preview) {
    // A day ahead has no checks of its own yet: only what the request asks about, never recorded.
    checks = canonical(asked) as Record<string, CheckAnswer>;
  } else {
    await recordPreChecks(db, userId, workoutId, date, asked, ctx.now);
    checks = await slotChecks(db, userId, workoutId, date, ctx.today, context.activeProfiles);
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
  const hashOf = (b: Block | null) =>
    sha256Hex(
      JSON.stringify(
        canonical({
          engine: version,
          date,
          programId: row.planId,
          settings: { unit: context.unit, weeklyGoal: context.config.weeklyGoal, blockWeeks: context.config.blockWeeks, defaultMinutes: context.config.defaultMinutes },
          location: context.location,
          locations: context.locations,
          activeProfiles: context.activeProfiles,
          careProfiles: context.careProfiles,
          block: blockKey(b),
          prefs: context.prefs,
          savedIds: context.savedIds,
          checks,
          overrides,
          swaps: Object.entries(swaps),
        }),
      ) + historyJson,
    );
  const inputsHash = await hashOf(block);
  const hidden = hiddenFrom(context.prefs);
  if (previous && previous.inputsHash === inputsHash && previous.engineVersion === version) {
    return respond(row, builds, ctx.today, preview ? {} : checks, hidden);
  }

  const composed = composeBuild({ date, programId: row.planId, context, block, history: history.sessions, summary: history.summary, checks, overrides, swaps });

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

  let keep: string;
  if (preview) {
    const existing = builds.find((b) => b.version === 0);
    keep = existing?.id ?? newId();
    if (existing) {
      await db
        .update(sessionBuilds)
        .set({ engineVersion: version, inputsHash: recordedHash, payload: stored as unknown as Record<string, unknown>, createdAt: ctx.now })
        .where(eq(sessionBuilds.id, existing.id));
    } else {
      await db.insert(sessionBuilds).values({
        id: keep,
        userId,
        workoutId,
        version: 0,
        engineVersion: version,
        inputsHash: recordedHash,
        payload: stored as unknown as Record<string, unknown>,
        lockedAt: null,
        createdAt: ctx.now,
      });
    }
  } else {
    keep = newId();
    const next = Math.max(0, ...builds.map((b) => b.version)) + 1;
    await db
      .insert(sessionBuilds)
      .values({
        id: keep,
        userId,
        workoutId,
        version: next,
        engineVersion: version,
        inputsHash: recordedHash,
        payload: stored as unknown as Record<string, unknown>,
        lockedAt: null,
        createdAt: ctx.now,
      })
      .onConflictDoNothing();
    const [mine] = await db.select({ id: sessionBuilds.id }).from(sessionBuilds).where(eq(sessionBuilds.id, keep)).limit(1);
    // A concurrent build took this version first: its build stands.
    if (!mine) return readResponse(db, userId, await loadSlot(db, userId, workoutId), ctx.today);

    const seconds = bookedSeconds(composed.build.plannedSeconds);
    const discipline = composed.hasCoreLift ? "strength" : "yoga";
    const name = program?.name ?? row.title;
    await db
      .update(plannedWorkouts)
      .set({
        title: composed.view.theme ? `${name} · ${composed.view.theme.name}` : name,
        category: discipline,
        sport: discipline,
        calendarBlockDurationSeconds: seconds,
        fallbackEstimatedDurationSeconds: seconds,
        contentState: "built",
        sessionParams: { checks, overrides, swaps } as unknown as Record<string, unknown>,
        updatedAt: ctx.now,
      })
      .where(and(eq(plannedWorkouts.id, workoutId), eq(plannedWorkouts.userId, userId)));
    // A longer session can now overlap the day's other plans: the same retime placement and coach edits use.
    if (seconds !== row.calendarBlockDurationSeconds || seconds !== row.fallbackEstimatedDurationSeconds) {
      await separateDayCollisions(db, userId, [date], ctx.prefs, { from: ctx.today, now: ctx.now });
    }
  }
  await pruneBuilds(db, workoutId, keep);

  const after = await loadSlot(db, userId, workoutId);
  return respond(after, await loadBuilds(db, userId, workoutId), ctx.today, preview ? {} : checks, hidden);
}

/**
 * `POST /api/sessions/:workoutId/start`: lock the day's latest build (`locked_at`, `content_state = 'started'`).
 * Idempotent: a started or done slot returns as it is. Throws `SessionNotFoundError`, `NotTodayError` (a day
 * ahead is a preview, never lockable; a day gone is not today), `NotBuiltError`.
 */
export async function startSession(db: Db, userId: string, workoutId: string, now: string): Promise<SessionResponse> {
  const row = await loadSlot(db, userId, workoutId);
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone, new Date(now));
  const builds = await loadBuilds(db, userId, workoutId);
  if (lockedOf(row, builds)) return readResponse(db, userId, row, today, builds);
  if (row.effectiveDate !== today) throw new NotTodayError(row.effectiveDate, today);
  const current = currentBuild(row, builds, today);
  if (!current) throw new NotBuiltError();
  if (await restoreInProgress(db, userId)) return readResponse(db, userId, row, today, builds);

  await db.update(sessionBuilds).set({ lockedAt: now }).where(eq(sessionBuilds.id, current.id));
  await db
    .update(plannedWorkouts)
    .set({ contentState: "started", updatedAt: now })
    .where(and(eq(plannedWorkouts.id, workoutId), eq(plannedWorkouts.userId, userId)));
  await pruneBuilds(db, workoutId, current.id);
  return readResponse(db, userId, await loadSlot(db, userId, workoutId), today);
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
