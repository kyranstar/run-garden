/**
 * THE BODY CHECK (the new shape, 2026-10-17; design §4): "How's your body?" on the Today card — Fresh · A bit heavy ·
 * Sore somewhere, Sore with a small area picker. No AI anywhere in it.
 *
 * THE ANSWER is the athlete's, kept in their answers store (`athlete_answers`, principles §5.3) as a check-in
 * (`source 'checkin'`) on their local today, tied to the session it was given on (`workout_id`):
 *  - one `body_feel` row — `value_choice` fresh | heavy | sore, about the workout (`subject_kind 'workout'`), fresh for
 *    the day: `bc:<workout>:<date>`;
 *  - for Sore, one `soreness` row per area, by area (a library region, or a switched-on condition profile — the subject
 *    kinds the store already knows), fresh for soreness's days (record-answer.ts `CHECKIN_QUESTIONS`):
 *    `bc:<workout>:<date>:<area>`.
 * A changed answer replaces the day's rows (one batch); the same answer again writes nothing.
 *
 * THE DAY ADAPTS as the answer asks, visibly, never by a model. Fresh changes nothing. A bit heavy eases the session;
 * Sore eases it when the session works a sore area (a condition's area: the regions its care targets), and only notes it
 * otherwise (`kept: quiet`). How it eases depends on what the session is:
 *  - AN ENGINE SESSION (a programme's slot, an on-demand session) is rebuilt one mode down — build → consistent →
 *    recovery, the next the programme allows — through the build path itself, the day's choice of mode as the session
 *    sheet makes it (`buildSessionOutcome`; its other choices kept, a new mode dropping the day's swaps as it always
 *    does). Built first when it isn't yet. Already in the gentlest mode the programme has: kept (`gentlest`).
 *  - A WATCH-PLAN RUN (a run the plan holds, not one the app built) is eased by the thread coach's own `ease` op through
 *    its own applier (`applyOps`): its time × 0.7 — or, for a run not on the watch whose every stage is a distance, its
 *    distance × 0.7 (a run on the watch eases by time, which the wire carries) — one block held easy; a long, easy or
 *    recovery run keeps its kind and name, anything harder becomes an easy run. The applier writes
 *    the row, its stages, its document's next revision, the app's claim on the content, and the rewrite of the watch's
 *    copy, which the client drains (`coachDrain`, as after an approve). A run works the hips and the legs. Race day is
 *    never eased (`kept: race`).
 *  - A WORKOUT THE COACH OR THE STUDIO DESIGNED (a document workout), or any other session: never changed by itself —
 *    the card offers the coach instead (`ask`).
 * Nothing is ever deleted or moved.
 *
 * UNDO puts the session back as the day had it (`POST /api/today/body/undo`): an engine session is built again with the
 * choices it had before the ease — the same plan, the engine being a function of the day's inputs; a run is restored
 * exactly as the plan had it (every column the ease wrote, its document's text as the next revision, its stage rows
 * with their repeats and targets), and its watch settled — a rewrite not yet run is superseded, one that reached the
 * watch is followed by a rewrite back. The answer stays. An answer that no longer asks for the ease (A bit heavy →
 * Fresh) puts it back the same way. A session changed since the ease (another mode chosen in the sheet, the plan's own
 * new version of a run) is left as it is now.
 *
 * THE RECORD of what the check did is one `audit_events` row per session and day (`body-check:<workout>:<date>`, kind
 * `body_check`): what the card says (`change`) and the ease made, with what Undo needs to put it back. It is written
 * BEFORE an ease is applied (`easing`) and marked `eased` after, so a request cut off between the two finishes the ease
 * from the record on the next answer — never easing twice, never taking the eased session for the day's own.
 *
 * THE CHIPS CAN CHANGE until the session starts: the session must be the athlete's, live, today's, still scheduled, and —
 * an app session — neither started nor done nor locked to the watch. Otherwise the check is closed (`open: false`; a
 * write is refused).
 *
 * Statements: the view reads three; an answer and an Undo are pinned in body-check*.test.ts.
 */
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  athleteAnswers,
  auditEvents,
  corosWriteJobs,
  dailyHealth,
  plannedWorkoutStages,
  plannedWorkouts,
  programs,
  sessionBuilds,
  syncIntents,
  userConditions,
} from "@rg/database";
import {
  appAuthoredRow,
  coachSessionSchema,
  docOriginRow,
  humanizeWorkoutTitle,
  SESSION_MODES,
  watchAddressOf,
  type CoachSession,
  type SessionMode,
  type UserPreferences,
} from "@rg/domain";
import { EXERCISES, isProfileId, label as vocab, MUSCLE_REGION, profileById, type MuscleId } from "@rg/exercise-library";
import type { Swaps } from "@rg/session-engine";
import { applyOps, enqueueContentConvergence, sessionColumns } from "./coach-apply.js";
import { coachDrainQueued } from "./coros-write-cloud.js";
import { insertBatches, runAtomically, type Db } from "./db.js";
import { separateDayCollisions } from "./day-placement.js";
import { freshThrough } from "./design-tools/record-answer.js";
import { buildSessionOutcome, NotTodayError, SessionLockedError, type BuildOverrides } from "./session-build.js";
import { recordIntent } from "./sync-intents.js";
import { revisionInsert } from "./workout-doc-store.js";

/** The three answers, in the card's order. */
export const BODY_FEELS = ["fresh", "heavy", "sore"] as const;
export type BodyFeel = (typeof BODY_FEELS)[number];

/** The answers store's question for the check itself. */
export const BODY_QUESTION = "body_feel";

/**
 * The body's areas the picker offers, head to foot — library regions (record-answer's areas), less the ones another
 * name already covers or a picker has no use for (`jaw`: a condition's own; `thoracic`, `lats`: the upper back;
 * `full-body`).
 */
export const BODY_REGIONS = [
  "neck", "shoulders", "upper-back", "chest", "arms", "core", "low-back", "hips", "glutes", "quads", "hamstrings", "calves", "ankles", "feet",
] as const;

/** One area the picker offers: its id (a region, or a condition profile's) and its words. */
export interface BodyArea {
  id: string;
  label: string;
}

/** What the answer did to the day's session (the card says it in words; `bodyLine` in the UI). */
export type BodyChange =
  | { kind: "eased"; to: { mode: SessionMode } | { meters: number } | { minutes: number } }
  | { kind: "kept"; why: "undone" | "quiet" | "gentlest" | "race" }
  | { kind: "ask" };

/** What the Today card reads. */
export interface BodyCheckView {
  workoutId: string;
  /** Today's answer for this session, or null. `areas` in the picker's order (Sore only). */
  answer: { feel: BodyFeel; areas: string[] } | null;
  change: BodyChange | null;
  /** The chips can still change: the session hasn't started, and its day is today. */
  open: boolean;
  /** What the area picker offers: the body's regions, then each condition switched on. */
  areas: BodyArea[];
  /** An ease is recorded and not yet applied (it had to build the day's session first): the client asks again. */
  pending?: true;
}

export interface BodyCheckOutcome {
  view: BodyCheckView;
  /** A watch write is queued for the client to drain (`POST /api/coach/drain`, as after an approve). */
  coachDrain: boolean;
}

export interface BodyCheckCtx {
  today: string;
  now: string;
  prefs: UserPreferences;
}

export interface BodyAnswer {
  feel: BodyFeel;
  areas?: readonly string[];
}

/** Not this athlete's live session. */
export class BodyCheckNotFoundError extends Error {
  constructor() {
    super("not_found");
  }
}

/** The session isn't today's, or has started, or is done: its check can't change. */
export class BodyCheckClosedError extends Error {
  constructor() {
    super("closed");
  }
}

/** An answer the check doesn't take (an unknown area, areas without Sore, Sore without an area). */
export class BodyCheckInvalidError extends Error {
  constructor(readonly why: string) {
    super("invalid");
  }
}

/** Where an ease is: written before it is applied, marked after; put back by Undo or an answer that no longer asks. */
type EaseState = "easing" | "eased" | "undone";

/** An engine session's ease: the mode it was and went to, and the day's choices before it (what Undo builds with). */
interface EngineEase {
  kind: "engine";
  state: EaseState;
  from: SessionMode;
  to: SessionMode;
  overrides: BuildOverrides;
  swaps: Swaps;
}

/** What an ease of a watch-plan run replaces: every column a session decides (`sessionColumns`), and its document. */
const RUN_COLUMNS = [
  "title", "category", "qualitySubtype", "sport", "sourceEstimatedDurationSeconds", "fallbackEstimatedDurationSeconds", "calendarBlockDurationSeconds",
  "durationEstimate", "expectedDistanceMeters", "stageSummary", "structuredJson", "corosSyncState",
] as const satisfies ReadonlyArray<keyof typeof plannedWorkouts.$inferSelect>;
type RunColumns = Pick<typeof plannedWorkouts.$inferSelect, (typeof RUN_COLUMNS)[number]>;
type StageRow = typeof plannedWorkoutStages.$inferSelect;

/**
 * A watch-plan run's ease: the session the ease op wrote and how the card says it, when it was applied, and the run as
 * the plan had it — the columns, the document's text and the stage rows the ease replaced — with whether the app
 * already claimed its content then (a coach ease not yet on the watch).
 */
interface RunEase {
  kind: "run";
  state: EaseState;
  at: string;
  session: CoachSession;
  to: { meters: number } | { minutes: number };
  before: { columns: RunColumns; doc: string | null; stages: StageRow[]; claimed: boolean };
}

type Ease = EngineEase | RunEase;

/** The record of what the check did to a session on a day (`audit_events.detail`). */
interface BodyRecord {
  change: BodyChange | null;
  ease: Ease | null;
}

const RECORD_KIND = "body_check";

type Answer = { feel: BodyFeel; areas: string[] };

/**
 * The session as the check reads it: its row, whether a build of it is locked, the conditions switched on, its
 * programme's modes — and the day's answer and record.
 */
interface Subject {
  row: Pick<
    typeof plannedWorkouts.$inferSelect,
    "id" | "planId" | "origin" | "category" | "sport" | "title" | "effectiveDate" | "completionState" | "contentState"
  >;
  locked: boolean;
  conditions: string[];
  /** An engine session's programme's modes (all of them when it says none). */
  modes: SessionMode[];
  /** Today's answer for the session (null: none). */
  answer: Answer | null;
  /** The record of what the check did today (null: nothing yet). */
  record: BodyRecord | null;
}

const answerId = (workoutId: string, date: string): string => `bc:${workoutId}:${date}`;
const recordId = (workoutId: string, date: string): string => `body-check:${workoutId}:${date}`;

const MODE_ORDER: readonly SessionMode[] = SESSION_MODES;

const parsedJson = (v: unknown): unknown => {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};

/** The day's answer rows (`id`, question, choice, subject) as one JSON array, for `loadSubject`. */
function answerRowsSql(userId: string, workoutId: string, today: string) {
  const a = athleteAnswers;
  const id = answerId(workoutId, today);
  return sql<string | null>`(select json_group_array(json_array(${a.id}, ${a.questionId}, ${a.valueChoice}, ${a.subjectId})) from ${a} where ${and(
    eq(a.userId, userId),
    eq(a.workoutId, workoutId),
    eq(a.localDate, today),
    sql`(${a.id} = ${id} or substr(${a.id}, 1, ${id.length + 1}) = ${`${id}:`})`,
  )})`;
}

/** Today's answer from its rows (null when none): the check's own row and, for Sore, its areas in the picker's order. */
function answerOf(raw: unknown, workoutId: string, today: string, conditions: readonly string[]): Answer | null {
  const id = answerId(workoutId, today);
  const rows = (Array.isArray(raw) ? raw : []).filter((r): r is [string, string, string | null, string | null] => Array.isArray(r) && r.length === 4);
  const feel = rows.find((r) => r[0] === id && r[1] === BODY_QUESTION)?.[2];
  if (!feel || !(BODY_FEELS as readonly string[]).includes(feel)) return null;
  const areas = rows.filter((r) => r[0] !== id && r[1] === "soreness" && r[3]).map((r) => r[3]!);
  return { feel: feel as BodyFeel, areas: feel === "sore" ? bodyAreas(conditions).map((x) => x.id).filter((x) => areas.includes(x)) : [] };
}

/** The session, its lock, the athlete's conditions, its programme's modes, the day's answer and record — ONE read; null when it isn't theirs or is gone. */
async function loadSubject(db: Db, userId: string, workoutId: string, today: string): Promise<Subject | null> {
  const pw = plannedWorkouts;
  const [r] = await db
    .select({
      id: pw.id,
      planId: pw.planId,
      origin: pw.origin,
      category: pw.category,
      sport: pw.sport,
      title: pw.title,
      effectiveDate: pw.effectiveDate,
      completionState: pw.completionState,
      contentState: pw.contentState,
      locked: sql<number>`exists (select 1 from ${sessionBuilds} where ${and(eq(sessionBuilds.workoutId, pw.id), isNotNull(sessionBuilds.lockedAt))})`,
      conditions: sql<string | null>`(select group_concat(${userConditions.profileId}) from ${userConditions} where ${and(
        eq(userConditions.userId, userId),
        eq(userConditions.active, true),
      )})`,
      modes: sql<string | null>`(select json_extract(${programs.config}, '$.modes') from ${programs} where ${and(eq(programs.id, pw.planId), eq(programs.userId, userId))})`,
      answers: answerRowsSql(userId, workoutId, today),
      record: sql<string | null>`(select ${auditEvents.detail} from ${auditEvents} where ${and(
        eq(auditEvents.id, recordId(workoutId, today)),
        eq(auditEvents.userId, userId),
        eq(auditEvents.kind, RECORD_KIND),
      )})`,
    })
    .from(pw)
    .where(and(eq(pw.id, workoutId), eq(pw.userId, userId), sql`${pw.archivedAt} is null`))
    .limit(1);
  if (!r) return null;
  const { locked, conditions, modes, answers, record, ...row } = r;
  const listed = parsedJson(modes);
  const known = Array.isArray(listed) ? MODE_ORDER.filter((m) => listed.includes(m)) : [];
  const active = [...new Set((conditions ?? "").split(",").filter(isProfileId))].sort();
  const d = parsedJson(record) as Partial<BodyRecord> | null;
  return {
    row,
    locked: Boolean(locked),
    conditions: active,
    modes: known.length > 0 ? known : [...MODE_ORDER],
    answer: answerOf(parsedJson(answers), workoutId, today, active),
    record: d && typeof d === "object" ? { change: d.change ?? null, ease: d.ease ?? null } : null,
  };
}

/** Can the check still change? Today's, still scheduled, and an app session neither started nor done nor locked. */
function openOf(s: Subject, today: string): boolean {
  const { row } = s;
  if (row.effectiveDate !== today || row.completionState !== "scheduled") return false;
  if (appAuthoredRow(row) && (row.contentState === "started" || row.contentState === "done" || s.locked)) return false;
  return true;
}

/** What kind of session the check is adapting. */
type SessionKind = "engine" | "designed" | "run" | "race" | "rest" | "other";
function kindOf(row: Subject["row"]): SessionKind {
  if (row.category === "rest") return "rest";
  if (row.origin === "program" || row.origin === "on_demand") return "engine";
  if (docOriginRow(row)) return "designed";
  // A run the plan holds (imported, or one the thread coach put there): the ease op's own ground.
  if (!appAuthoredRow(row) && row.sport === "run") return row.category === "race" ? "race" : "run";
  return "other";
}

/** The picker's areas for an athlete with these conditions switched on. */
export function bodyAreas(conditions: readonly string[]): BodyArea[] {
  return [
    ...BODY_REGIONS.map((id) => ({ id, label: vocab(id) })),
    ...conditions.filter(isProfileId).map((id) => ({ id, label: profileById(id).check.label })),
  ];
}

/** The regions an area stands for: a region its own; a condition, the regions its care targets. */
function regionsOf(area: string): string[] {
  if (!isProfileId(area)) return [area];
  return Object.keys(profileById(area).care?.coverageTargets?.regions ?? {});
}

/** The answer as the check keeps it: its areas known, deduplicated and in the picker's order; else why not. */
function normalized(input: BodyAnswer, areas: readonly BodyArea[]): { feel: BodyFeel; areas: string[] } {
  if (!(BODY_FEELS as readonly string[]).includes(input.feel)) throw new BodyCheckInvalidError("feel: fresh, heavy or sore");
  const asked = [...new Set(input.areas ?? [])];
  if (input.feel !== "sore") {
    if (asked.length > 0) throw new BodyCheckInvalidError("areas only with sore");
    return { feel: input.feel, areas: [] };
  }
  const known = areas.map((a) => a.id);
  const unknown = asked.filter((a) => !known.includes(a));
  if (unknown.length > 0) throw new BodyCheckInvalidError(`unknown area: ${unknown.join(", ")}`);
  if (asked.length === 0) throw new BodyCheckInvalidError("sore needs an area");
  return { feel: "sore", areas: known.filter((a) => asked.includes(a)) };
}

/** The day's answer rows replaced by these (one batch: the delete, then the inserts). */
async function writeAnswer(db: Db, userId: string, workoutId: string, answer: Answer, ctx: BodyCheckCtx): Promise<void> {
  const a = athleteAnswers;
  const id = answerId(workoutId, ctx.today);
  const common = { userId, source: "checkin", localDate: ctx.today, at: ctx.now, workoutId };
  const rows: Array<typeof athleteAnswers.$inferInsert> = [
    { id, questionId: BODY_QUESTION, subjectKind: "workout", subjectId: workoutId, valueChoice: answer.feel, expiresAt: ctx.today, ...common },
    ...answer.areas.map((area) => ({
      id: `${id}:${area}`,
      questionId: "soreness",
      subjectKind: isProfileId(area) ? "condition" : "region",
      subjectId: area,
      valueChoice: null,
      expiresAt: freshThrough("soreness", ctx.today),
      ...common,
    })),
  ];
  await runAtomically(db, [
    db.delete(a).where(and(eq(a.userId, userId), sql`(${a.id} = ${id} or substr(${a.id}, 1, ${id.length + 1}) = ${`${id}:`})`)),
    ...insertBatches(rows).map((batch) => db.insert(a).values(batch)),
  ]);
}

const sameAnswer = (x: Answer | null, y: Answer): boolean =>
  x !== null && x.feel === y.feel && x.areas.length === y.areas.length && x.areas.every((a, i) => a === y.areas[i]);

async function writeRecord(db: Db, userId: string, workoutId: string, record: BodyRecord, ctx: BodyCheckCtx): Promise<void> {
  const detail = { workoutId, date: ctx.today, ...record } as unknown as Record<string, unknown>;
  await db
    .insert(auditEvents)
    .values({ id: recordId(workoutId, ctx.today), userId, kind: RECORD_KIND, detail, createdAt: ctx.now })
    .onConflictDoUpdate({ target: auditEvents.id, set: { detail, createdAt: ctx.now }, setWhere: and(eq(auditEvents.userId, userId), eq(auditEvents.kind, RECORD_KIND)) });
}

// ── An engine session ────────────────────────────────────────────────────────────────────────────────────────────

/** The day's build of an engine session as the check reads it: its mode, its choices, its moves. */
interface DayBuild {
  mode: SessionMode;
  overrides: BuildOverrides;
  swaps: Swaps;
  exerciseIds: string[];
}

/** The session's latest build for today (none: null) — its mode, choices and moves, read out of the payload in SQL. */
async function storedDayBuild(db: Db, workoutId: string, today: string): Promise<DayBuild | null> {
  const sb = sessionBuilds;
  const [b] = await db
    .select({
      date: sql<string | null>`json_extract(${sb.payload}, '$.build.date')`,
      mode: sql<string | null>`json_extract(${sb.payload}, '$.build.mode')`,
      params: sql<string | null>`json_extract(${sb.payload}, '$.build.params')`,
      items: sql<string | null>`json_extract(${sb.payload}, '$.build.items')`,
    })
    .from(sb)
    .where(and(eq(sb.workoutId, workoutId), gt(sb.version, 0)))
    .orderBy(desc(sb.version))
    .limit(1);
  if (!b || b.date !== today || !(MODE_ORDER as readonly (string | null)[]).includes(b.mode)) return null;
  const params = (parsedJson(b.params) ?? {}) as { overrides?: BuildOverrides; swaps?: Swaps };
  const items = parsedJson(b.items);
  return {
    mode: b.mode as SessionMode,
    overrides: params.overrides ?? {},
    swaps: params.swaps ?? {},
    exerciseIds: Array.isArray(items) ? items.flatMap((i) => (typeof (i as { exerciseId?: unknown }).exerciseId === "string" ? [(i as { exerciseId: string }).exerciseId] : [])) : [],
  };
}

/** A build of the session for today through the build path; a session locked or gone from today meanwhile is closed. */
async function build(db: Db, userId: string, workoutId: string, req: Parameters<typeof buildSessionOutcome>[3], ctx: BodyCheckCtx) {
  try {
    return await buildSessionOutcome(db, userId, workoutId, req, ctx);
  } catch (e) {
    if (e instanceof SessionLockedError || e instanceof NotTodayError) throw new BodyCheckClosedError();
    throw e;
  }
}

/** The day's build, made when there is none yet (as opening the sheet would; `made`). */
async function dayBuild(db: Db, userId: string, workoutId: string, ctx: BodyCheckCtx): Promise<{ build: DayBuild; made: boolean }> {
  const stored = await storedDayBuild(db, workoutId, ctx.today);
  if (stored) return { build: stored, made: false };
  const out = await build(db, userId, workoutId, {}, ctx);
  const b = out.session.build;
  if (!b) throw new BodyCheckClosedError();
  return {
    build: { mode: b.mode, overrides: b.params.overrides, swaps: b.params.swaps, exerciseIds: b.items.map((i) => i.exerciseId) },
    made: true,
  };
}

/** The regions a build works: each move's regions and its primary muscles' regions. */
function workedRegions(exerciseIds: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const id of exerciseIds) {
    const rec = EXERCISES.find((e) => e.id === id);
    if (!rec) continue;
    for (const r of rec.regions) out.add(r);
    for (const m of rec.muscles.primary) out.add(MUSCLE_REGION[m as MuscleId]);
  }
  return out;
}

/** The next mode down the programme allows, or null at its gentlest. */
function modeBelow(mode: SessionMode, allowed: readonly SessionMode[]): SessionMode | null {
  const at = MODE_ORDER.indexOf(mode);
  const lower = MODE_ORDER.filter((m, i) => i < at && allowed.includes(m));
  return lower.at(-1) ?? null;
}

/** What an adaptation did. */
interface Adapted {
  record: BodyRecord;
  coachDrain: boolean;
  /** The record is written already (an ease writes it around its apply). */
  persisted?: boolean;
}

/** Does the session work any of the sore areas? */
const worksSore = (answer: Answer, works: ReadonlySet<string>): boolean => answer.areas.some((a) => regionsOf(a).some((r) => works.has(r)));

/** Ease an engine session one mode down (or say it is at its gentlest, or that the sore area isn't worked). */
async function easeEngine(db: Db, userId: string, s: Subject, answer: Answer, record: BodyRecord | null, ctx: BodyCheckCtx): Promise<Adapted> {
  const id = s.row.id;
  const prior = record?.ease?.kind === "engine" ? record.ease : null;
  const day = await dayBuild(db, userId, id, ctx);
  if (answer.feel === "sore" && !worksSore(answer, workedRegions(day.build.exerciseIds))) {
    // Not an area today works: noted, and an ease of the day no longer asked for goes back (or, recorded and not yet
    // applied, is never applied).
    const back = await putBack(db, userId, s, record?.ease ?? null, ctx);
    return { record: { change: { kind: "kept", why: "quiet" }, ease: back.ease }, coachDrain: back.coachDrain };
  }
  // An ease recorded and not yet applied (the day's session had to be built first, or a request was cut off): finish it
  // from what was recorded.
  if (prior?.state === "easing") {
    await build(db, userId, id, { overrides: { ...prior.overrides, mode: prior.to } }, ctx);
    const rec: BodyRecord = { change: { kind: "eased", to: { mode: prior.to } }, ease: { ...prior, state: "eased" } };
    await writeRecord(db, userId, id, rec, ctx);
    return { record: rec, coachDrain: false, persisted: true };
  }
  // The day's ease still in place stands (A bit heavy → Sore in a worked area: the same ease, the card's reason changes).
  if (prior?.state === "eased" && day.build.overrides.mode === prior.to) {
    return { record: { change: { kind: "eased", to: { mode: prior.to } }, ease: prior }, coachDrain: false };
  }
  const to = modeBelow(day.build.mode, s.modes);
  if (!to) return { record: { change: { kind: "kept", why: "gentlest" }, ease: record?.ease ?? null }, coachDrain: false };
  const ease: EngineEase = { kind: "engine", state: "easing", from: day.build.mode, to, overrides: day.build.overrides, swaps: day.build.swaps };
  const eased: BodyChange = { kind: "eased", to: { mode: to } };
  // TWO BUILDS DON'T FIT ONE REQUEST (≈ 21 + 16 statements beside the check's own): a session built just now, to learn
  // the mode the engine proposes, is eased by the next request — the client asks again at once (`pending`), and the
  // recorded ease is finished above, from what was recorded here.
  if (day.made) {
    await writeRecord(db, userId, id, { change: eased, ease }, ctx);
    return { record: { change: eased, ease }, coachDrain: false, persisted: true };
  }
  await writeRecord(db, userId, id, { change: record?.change ?? null, ease }, ctx);
  await build(db, userId, id, { overrides: { ...day.build.overrides, mode: to } }, ctx);
  const rec: BodyRecord = { change: { kind: "eased", to: { mode: to } }, ease: { ...ease, state: "eased" } };
  await writeRecord(db, userId, id, rec, ctx);
  return { record: rec, coachDrain: false, persisted: true };
}

/**
 * Put an engine session back as the day had it before the ease — built again with the choices recorded then — unless
 * the athlete has chosen another mode since (theirs stands). The ease is marked undone either way.
 */
async function restoreEngine(db: Db, userId: string, s: Subject, ease: EngineEase, ctx: BodyCheckCtx): Promise<EngineEase> {
  const now = await storedDayBuild(db, s.row.id, ctx.today);
  if (now && now.overrides.mode === ease.to) await build(db, userId, s.row.id, { overrides: ease.overrides, swaps: ease.swaps }, ctx);
  return { ...ease, state: "undone" };
}

// ── A watch-plan run ─────────────────────────────────────────────────────────────────────────────────────────────

/** How much of a run an ease keeps: its distance, or its time, × 0.7 (design §4). */
export const RUN_EASE_FACTOR = 0.7;

/** The regions a run works (the growth body map's own reading: a run loads the hips and the legs). */
const RUN_REGIONS: ReadonlySet<string> = new Set(["hips", "glutes", "quads", "hamstrings", "calves", "ankles", "feet"]);

/** The run kinds an ease keeps (a long run eased is still the long run); any other run becomes an easy one. */
const KEPT_RUN_KINDS = ["easy", "long", "recovery"] as const;

/** The run as the check reads it: the whole row, its stages, and whether the app holds an open claim on its content. */
async function runOf(db: Db, userId: string, workoutId: string): Promise<{ row: typeof plannedWorkouts.$inferSelect; stages: StageRow[]; claimed: boolean } | null> {
  const si = syncIntents;
  const [row] = await db
    .select({
      row: plannedWorkouts,
      claimed: sql<number>`exists (select 1 from ${si} where ${and(eq(si.userId, userId), eq(si.targetId, workoutId), eq(si.kind, "content"), isNull(si.resolvedAt), isNull(si.supersededBy))})`,
    })
    .from(plannedWorkouts)
    .where(and(eq(plannedWorkouts.id, workoutId), eq(plannedWorkouts.userId, userId)))
    .limit(1);
  if (!row) return null;
  const stages = await db.select().from(plannedWorkoutStages).where(eq(plannedWorkoutStages.workoutId, workoutId)).orderBy(asc(plannedWorkoutStages.ord));
  return { row: row.row, stages, claimed: Boolean(row.claimed) };
}

/** A run on the watch — at an address the app can write to, or held by COROS as the import last saw it (`synced`) —
 * eases by time (the lead's ruling): `easedRun`'s `onWatch`, the body check's and the coach's adjust_plan's one rule. */
export function runOnWatch(
  row: Pick<typeof plannedWorkouts.$inferSelect, "sourceWorkoutId" | "sourceIdInPlan" | "sourceProgramId" | "lastVerifiedCorosDate" | "corosSyncState">,
): boolean {
  return watchAddressOf(row) !== null || row.corosSyncState === "synced";
}

/**
 * The run eased: its distance × 0.7 (to the 100 m) when the plan prescribes it by distance — every stage a distance —
 * and the run is not on the watch; else its time × 0.7 (to the minute), one block held easy. A run ON THE WATCH always
 * eases by time (the lead's ruling, 2026-10-17): the athlete runs with the watch, so the watch must hold what the app
 * says, and the wire carries no distance block. A long, easy or recovery run keeps its kind and its name; anything
 * harder becomes an easy run. Null for a run with nothing to ease (no length).
 */
export function easedRun(
  row: Pick<typeof plannedWorkouts.$inferSelect, RunKey>,
  stages: readonly Pick<StageRow, "id" | "parentStageId" | "durationType">[],
  onWatch: boolean,
): { session: CoachSession; to: RunEase["to"] } | null {
  const seconds = row.sourceEstimatedDurationSeconds ?? row.fallbackEstimatedDurationSeconds ?? row.calendarBlockDurationSeconds;
  const minutes = Math.round((seconds / 60) * RUN_EASE_FACTOR);
  if (!(minutes > 0)) return null;
  const leaves = stages.filter((s) => !stages.some((c) => c.parentStageId === s.id));
  const meters = row.expectedDistanceMeters ?? 0;
  const byDistance = !onWatch && meters >= 1000 && leaves.length > 0 && leaves.every((s) => s.durationType === "distance");
  const kept = (KEPT_RUN_KINDS as readonly string[]).includes(row.category);
  const parsed = coachSessionSchema.safeParse({
    category: kept ? row.category : "easy",
    title: kept ? humanizeWorkoutTitle(row.title, row.category, row.qualitySubtype) : "Easy run",
    durationMinutes: minutes,
    run: { blocks: [byDistance ? { kind: "distance", value: Math.round((meters * RUN_EASE_FACTOR) / 100) * 100, intensity: "easy" } : { kind: "duration", value: minutes, intensity: "easy" }] },
  });
  if (!parsed.success) return null;
  return { session: parsed.data, to: byDistance ? { meters: Math.round((meters * RUN_EASE_FACTOR) / 100) * 100 } : { minutes } };
}
type RunKey = "title" | "category" | "qualitySubtype" | "sourceEstimatedDurationSeconds" | "fallbackEstimatedDurationSeconds" | "calendarBlockDurationSeconds" | "expectedDistanceMeters";

/** Does the row still hold the session an ease wrote? (What `sessionColumns` makes a row say of it.) */
function holdsRun(row: typeof plannedWorkouts.$inferSelect, session: CoachSession): boolean {
  const c = sessionColumns(session);
  return row.title === c.title && row.stageSummary === c.stageSummary && row.calendarBlockDurationSeconds === c.calendarBlockDurationSeconds && row.expectedDistanceMeters === c.expectedDistanceMeters;
}

const pick = (row: typeof plannedWorkouts.$inferSelect): RunColumns => Object.fromEntries(RUN_COLUMNS.map((k) => [k, row[k]])) as RunColumns;

/** The applier's proposal id for the check's ease of a session on a day: its document revision's reference. */
const easeRef = (workoutId: string, date: string): string => `body-check-${workoutId}-${date}`;

/**
 * The run as the plan has it, as the wire can carry it: each stage a block, a repeat's stages as many times as it says
 * — every block by TIME, since the wire carries no distance: a distance stage takes its share, by distance, of the time
 * the plan gives what its timed stages leave (a 20 km run the plan says takes 110 minutes is 110 minutes). The app's own
 * copy keeps the plan's distance stages exactly; this is only what goes back to the watch.
 */
function planRunSession(columns: RunColumns, stages: readonly StageRow[]): CoachSession | null {
  const ordered = [...stages].sort((a, b) => a.ord - b.ord);
  const played: StageRow[] = [];
  for (const s of ordered.filter((x) => !x.parentStageId)) {
    const kids = ordered.filter((c) => c.parentStageId === s.id);
    const times = kids.length > 0 ? Math.max(1, s.repeatCount ?? 1) : 1;
    for (let i = 0; i < times; i++) played.push(...(kids.length > 0 ? kids : [s]));
  }
  const total = columns.sourceEstimatedDurationSeconds ?? columns.fallbackEstimatedDurationSeconds ?? columns.calendarBlockDurationSeconds;
  const timed = played.reduce((sum, s) => sum + (s.durationType === "time" ? (s.durationSeconds ?? 0) : 0), 0);
  const meters = played.reduce((sum, s) => sum + (s.durationType === "distance" ? (s.distanceMeters ?? 0) : 0), 0);
  const perMeter = meters > 0 ? (total - timed) / meters : 0;
  if (meters > 0 && !(perMeter > 0)) return null;
  const blocks: Array<{ kind: "duration"; value: number; intensity?: string }> = [];
  for (const s of played) {
    const seconds = s.durationType === "time" ? (s.durationSeconds ?? 0) : s.durationType === "distance" ? Math.round((s.distanceMeters ?? 0) * perMeter) : 0;
    if (!(seconds > 0)) return null;
    blocks.push({ kind: "duration", value: seconds / 60, ...(s.label ? { intensity: s.label } : {}) });
  }
  const parsed = coachSessionSchema.safeParse({
    category: ["easy", "long", "quality", "recovery", "race"].includes(columns.category) ? columns.category : "easy",
    title: columns.title,
    durationMinutes: Math.round(columns.calendarBlockDurationSeconds / 60),
    run: { blocks },
  });
  return parsed.success ? parsed.data : null;
}

/** The athlete's latest threshold pace (the applier's own read): what a run's pace bands are made from. */
async function thresholdPace(db: Db, userId: string): Promise<number | undefined> {
  const [r] = await db
    .select({ v: dailyHealth.thresholdPaceSecPerKm })
    .from(dailyHealth)
    .where(and(eq(dailyHealth.userId, userId), isNotNull(dailyHealth.thresholdPaceSecPerKm)))
    .orderBy(desc(dailyHealth.date))
    .limit(1);
  return r?.v ?? undefined;
}

const OPEN_JOB_STATUSES = ["queued", "claimed", "in_progress", "verifying"] as const;

/**
 * Apply a run's ease through the thread coach's own applier — the `ease` op: the row, its stages, its document's next
 * revision, the app's claim on its content and the rewrite of the watch's copy (`enqueueContentConvergence`). A rewrite
 * of this very content that an Undo superseded (the same session, from the same watch copy) is queued again: its id is
 * the content's, so the applier's insert finds it and adds nothing.
 */
async function applyRunEase(db: Db, userId: string, row: typeof plannedWorkouts.$inferSelect, session: CoachSession, ctx: BodyCheckCtx): Promise<void> {
  const applied = await applyOps(db, userId, ctx.prefs, easeRef(row.id, ctx.today), [{ kind: "ease", workoutId: row.id, session }]);
  // Done, skipped or gone between the read and the write: the check is closed.
  if (applied.missed.length > 0) throw new BodyCheckClosedError();
  if (!ctx.prefs.corosWritesEnabled) return;
  const jobs = await db
    .select({ id: corosWriteJobs.id, payload: corosWriteJobs.payload, expected: corosWriteJobs.expectedContentFingerprint })
    .from(corosWriteJobs)
    .where(and(eq(corosWriteJobs.userId, userId), eq(corosWriteJobs.workoutId, row.id), eq(corosWriteJobs.kind, "coach_update_workout"), eq(corosWriteJobs.status, "superseded")));
  const same = jobs.filter((j) => j.expected === row.sourceContentFingerprint && JSON.stringify((j.payload as { session?: unknown }).session) === JSON.stringify(session));
  if (same.length === 0) return;
  await db
    .update(corosWriteJobs)
    .set({ status: "queued", requestedAt: ctx.now, updatedAt: ctx.now, claimedAt: null, claimedByDeviceId: null })
    .where(and(eq(corosWriteJobs.userId, userId), inArray(corosWriteJobs.id, same.map((j) => j.id)), eq(corosWriteJobs.status, "superseded")));
}

/** Ease a watch-plan run (or say the sore area isn't one it works). */
async function easeRun(db: Db, userId: string, s: Subject, answer: Answer, record: BodyRecord | null, ctx: BodyCheckCtx): Promise<Adapted> {
  const id = s.row.id;
  const prior = record?.ease?.kind === "run" ? record.ease : null;
  if (answer.feel === "sore" && !worksSore(answer, RUN_REGIONS)) {
    const back = await putBack(db, userId, s, record?.ease ?? null, ctx);
    return { record: { change: { kind: "kept", why: "quiet" }, ease: back.ease }, coachDrain: back.coachDrain };
  }
  const run = await runOf(db, userId, id);
  if (!run) throw new BodyCheckNotFoundError();
  if (prior?.state === "eased" && holdsRun(run.row, prior.session)) {
    return { record: { change: { kind: "eased", to: prior.to }, ease: prior }, coachDrain: false };
  }
  // An ease written and cut off before it was applied is finished from what was recorded (the run as the plan had it
  // stays the one recorded then).
  let ease: RunEase;
  if (prior?.state === "easing") {
    ease = prior;
  } else {
    // On the watch: at an address the app can write to, or COROS holds it as the import last saw (`synced`).
    const onWatch = runOnWatch(run.row);
    const plan = easedRun(run.row, run.stages, onWatch);
    if (!plan) return { record: { change: { kind: "ask" }, ease: record?.ease ?? null }, coachDrain: false };
    ease = { kind: "run", state: "easing", at: ctx.now, session: plan.session, to: plan.to, before: { columns: pick(run.row), doc: run.row.workoutDoc, stages: run.stages, claimed: run.claimed } };
    await writeRecord(db, userId, id, { change: record?.change ?? null, ease }, ctx);
  }
  if (!holdsRun(run.row, ease.session)) await applyRunEase(db, userId, run.row, ease.session, ctx);
  const rec: BodyRecord = { change: { kind: "eased", to: ease.to }, ease: { ...ease, state: "eased" } };
  await writeRecord(db, userId, id, rec, ctx);
  return { record: rec, coachDrain: ctx.prefs.corosWritesEnabled === true && (await coachDrainQueued(db, userId)), persisted: true };
}

/**
 * Put a watch-plan run back exactly as the plan had it — every column the ease wrote, its document's text (the next
 * revision), its stage rows as they were — unless it has changed since the ease (an import, the coach: what it is now
 * stands). And the watch: a rewrite the ease queued that hasn't run is superseded, and the app's claim on the content
 * ends (the watch still holds the plan's run) unless the app held one before the ease; one that reached the watch is
 * followed by a rewrite back to the plan's run, under a new claim — when the wire can carry it, else the claim stays
 * open and the sync line says the watch holds another version.
 */
async function restoreRun(db: Db, userId: string, s: Subject, ease: RunEase, ctx: BodyCheckCtx): Promise<{ ease: RunEase; coachDrain: boolean }> {
  const undone = { ...ease, state: "undone" as const };
  const run = await runOf(db, userId, s.row.id);
  if (!run || !holdsRun(run.row, ease.session)) return { ease: undone, coachDrain: false };
  const { row } = run;
  const pw = plannedWorkouts;
  const jobs = await db
    .select({ id: corosWriteJobs.id, status: corosWriteJobs.status })
    .from(corosWriteJobs)
    .where(and(eq(corosWriteJobs.userId, userId), eq(corosWriteJobs.workoutId, row.id), eq(corosWriteJobs.kind, "coach_update_workout"), gte(corosWriteJobs.requestedAt, ease.at)));
  const reached = jobs.some((j) => j.status === "verified");
  const open = jobs.filter((j) => (OPEN_JOB_STATUSES as readonly string[]).includes(j.status)).map((j) => j.id);
  const b = ease.before;
  // The watch's copy is the eased run until the rewrite back lands: like any ease, the app's copy isn't the watch's yet.
  const columns: RunColumns = reached ? { ...b.columns, corosSyncState: "calendar_only" } : b.columns;
  await runAtomically(db, [
    db
      .update(pw)
      .set({
        ...columns,
        workoutDoc: b.doc,
        ...(b.doc !== null ? { workoutDocRev: sql`case when ${pw.workoutDoc} is ${b.doc} then ${pw.workoutDocRev} else coalesce(${pw.workoutDocRev}, 0) + 1 end` } : {}),
        updatedAt: ctx.now,
      })
      .where(and(eq(pw.id, row.id), eq(pw.userId, userId))),
    db.delete(plannedWorkoutStages).where(eq(plannedWorkoutStages.workoutId, row.id)),
    ...insertBatches(b.stages).map((batch) => db.insert(plannedWorkoutStages).values(batch)),
    ...(b.doc !== null ? [revisionInsert(db, { userId, workoutId: row.id, sourceKind: "athlete_edit", sourceRef: recordId(row.id, ctx.today), now: ctx.now })] : []),
    ...(open.length > 0
      ? [db.update(corosWriteJobs).set({ status: "superseded", updatedAt: ctx.now }).where(and(eq(corosWriteJobs.userId, userId), inArray(corosWriteJobs.id, open)))]
      : []),
  ]);
  // The run is its plan's length again: the day's other sessions make room as they did for the ease.
  await separateDayCollisions(db, userId, [row.effectiveDate], ctx.prefs, { from: ctx.today, now: ctx.now });
  let coachDrain = false;
  if (reached) {
    await recordIntent(db, { userId, targetKind: "workout", targetId: row.id, kind: "content", source: "undo" });
    const plan = planRunSession(b.columns, b.stages);
    if (plan) {
      const out = await enqueueContentConvergence(db, {
        userId,
        workout: row,
        session: plan,
        now: ctx.now,
        corosWritesEnabled: ctx.prefs.corosWritesEnabled ?? false,
        thresholdPaceSecPerKm: await thresholdPace(db, userId),
      });
      coachDrain = out.kind === "coach_update_workout";
    }
  } else if (!b.claimed) {
    // Nothing reached the watch: it holds the plan's run, as the app does again — the ease's claim ends.
    const si = syncIntents;
    await db
      .update(si)
      .set({ resolvedAt: ctx.now })
      .where(and(eq(si.userId, userId), eq(si.targetId, row.id), eq(si.kind, "content"), isNull(si.resolvedAt), isNull(si.supersededBy)));
  }
  return { ease: undone, coachDrain };
}

// ── The check ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Does this answer ask for the session to be eased? Heavy always; Sore when the session works a sore area (judged by the kind). */
const asksForEase = (answer: Answer): boolean => answer.feel === "heavy" || answer.feel === "sore";

/** Put back an ease of the day that is in place (or was being made), for Undo or an answer that no longer asks for it. */
async function putBack(db: Db, userId: string, s: Subject, ease: Ease | null, ctx: BodyCheckCtx): Promise<{ ease: Ease | null; coachDrain: boolean }> {
  if (!ease || ease.state === "undone") return { ease, coachDrain: false };
  if (ease.kind === "run") return restoreRun(db, userId, s, ease, ctx);
  return { ease: await restoreEngine(db, userId, s, ease, ctx), coachDrain: false };
}

/** Adapt the session to the answer: ease it, keep it (and say why), offer the coach, or put back an ease no longer asked for. */
async function adapt(db: Db, userId: string, s: Subject, answer: Answer, record: BodyRecord | null, ctx: BodyCheckCtx): Promise<Adapted> {
  const kind = kindOf(s.row);
  if (asksForEase(answer) && kind === "engine") return easeEngine(db, userId, s, answer, record, ctx);
  if (asksForEase(answer) && kind === "run") return easeRun(db, userId, s, answer, record, ctx);
  const back = await putBack(db, userId, s, record?.ease ?? null, ctx);
  // Race day is never eased; a designed workout, or any other, is the coach's to adapt; Fresh changes nothing.
  const change: BodyChange | null = !asksForEase(answer) || kind === "rest" ? null : kind === "race" ? { kind: "kept", why: "race" } : { kind: "ask" };
  return { record: { change, ease: back.ease }, coachDrain: back.coachDrain };
}

const viewOf = (s: Subject, answer: Answer | null, record: BodyRecord | null, today: string): BodyCheckView => ({
  workoutId: s.row.id,
  answer,
  change: answer ? (record?.change ?? null) : null,
  open: openOf(s, today),
  areas: bodyAreas(s.conditions),
  // An ease recorded and not yet applied: the client asks again to finish it.
  ...(answer && record?.ease?.state === "easing" && openOf(s, today) ? { pending: true as const } : {}),
});

/** `GET /api/today/body?workout=`: the check as the card shows it — one read. Throws `BodyCheckNotFoundError`. */
export async function readBodyCheck(db: Db, userId: string, workoutId: string, ctx: Pick<BodyCheckCtx, "today">): Promise<BodyCheckView> {
  const s = await loadSubject(db, userId, workoutId, ctx.today);
  if (!s) throw new BodyCheckNotFoundError();
  return viewOf(s, s.answer, s.record, ctx.today);
}

const sameRecord = (x: BodyRecord | null, y: BodyRecord): boolean => JSON.stringify(x) === JSON.stringify(y);

/**
 * `POST /api/today/body` `{workoutId, feel, areas?}`: keep the answer, and adapt the day as it asks. Idempotent: the
 * same answer again writes nothing — except to finish an ease recorded and not yet applied (`pending`). Throws
 * `BodyCheckNotFoundError`, `BodyCheckInvalidError`, `BodyCheckClosedError`.
 */
export async function answerBodyCheck(db: Db, userId: string, workoutId: string, input: BodyAnswer, ctx: BodyCheckCtx): Promise<BodyCheckOutcome> {
  const s = await loadSubject(db, userId, workoutId, ctx.today);
  if (!s) throw new BodyCheckNotFoundError();
  const answer = normalized(input, bodyAreas(s.conditions));
  if (!openOf(s, ctx.today)) throw new BodyCheckClosedError();
  const { record } = s;
  const same = sameAnswer(s.answer, answer);
  if (same && record?.ease?.state !== "easing") return { view: viewOf(s, answer, record, ctx.today), coachDrain: false };
  if (!same) await writeAnswer(db, userId, workoutId, answer, ctx);
  const done = await adapt(db, userId, s, answer, record, ctx);
  if (!done.persisted && !sameRecord(record, done.record)) await writeRecord(db, userId, workoutId, done.record, ctx);
  return { view: viewOf(s, answer, done.record, ctx.today), coachDrain: done.coachDrain };
}

/**
 * `POST /api/today/body/undo` `{workoutId}`: put the session back as the day had it before the check eased it; the
 * answer stays. Nothing eased: the check as it is, nothing written. Throws `BodyCheckNotFoundError`, `BodyCheckClosedError`.
 */
export async function undoBodyCheck(db: Db, userId: string, workoutId: string, ctx: BodyCheckCtx): Promise<BodyCheckOutcome> {
  const s = await loadSubject(db, userId, workoutId, ctx.today);
  if (!s) throw new BodyCheckNotFoundError();
  if (!openOf(s, ctx.today)) throw new BodyCheckClosedError();
  const { answer, record } = s;
  if (!record?.ease || record.ease.state === "undone") return { view: viewOf(s, answer, record, ctx.today), coachDrain: false };
  const back = await putBack(db, userId, s, record.ease, ctx);
  const next: BodyRecord = { change: { kind: "kept", why: "undone" }, ease: back.ease };
  await writeRecord(db, userId, workoutId, next, ctx);
  return { view: viewOf(s, answer, next, ctx.today), coachDrain: back.coachDrain };
}
