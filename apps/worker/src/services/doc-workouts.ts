/**
 * DOCUMENT WORKOUTS, MADE AND REVISED (Stage 2 spec §10; programme spec §3.11) — the one path the Studio's Schedule and
 * Save and, in Stage 3, the coach's approved proposals write a workout document through.
 *
 * MAKING ONE (`createDocWorkout`). The document is judged for its day (`judgeDoc`, doc-build.ts: the validator with the
 * day's reading, the athlete's set-aside moves, the place's gear, what they have done cleanly and their recent
 * sessions — and on the day itself as its build will play it, a move the day keeps out answered by its alternate): an
 * error refuses it (`DocInvalidError`, every issue), a warning comes back with it and never blocks. A document whose
 * derived discipline is a run is refused (`RunUnsupportedError`) until a run has a way to be played. It becomes a planned row
 * exactly as the app's own sessions are written (a programme's slot, `program-slots.ts`): origin `studio` — or
 * `template` when the document is based on one — hung from the account's own Studio programme (`studioProgramId`,
 * the per-user programme the one-workout-system spec §9.3 hangs on-demand sessions from); its own id as its source;
 * `calendar_only` with no watch address, so the reconciler books its event and nothing but the athlete's Send puts it
 * on the watch (`appAuthoredRow`); an outline until its day's build. Its title is the document's; its discipline,
 * category and booked length are derived (`deriveDoc`, the length rounded up to five minutes as a built slot's is); its
 * time is the one asked for — pinned, as a time the athlete picks is (a `time_change` override: the collision pass never
 * moves it) — else the athlete's window, then the day's collision pass. The document is stored at revision 1 with its
 * revision row, in the same batch (`workout-doc-store.ts`), labelled by the row's origin unless a server caller says
 * otherwise (the client never labels its own revision).
 *
 * REVISING ONE (`reviseDocWorkout`). Any planned workout is revisable unless there is a clear reason (workout-editability
 * spec §3, `revisability` in @rg/domain): its day has passed, it is resolved or under way, it is race day or a rest day,
 * a programme's session (the engine builds it), or a run — each `NotEditableError` with its reason, why and what to do
 * instead; a base revision that is not the row's current one is `StaleRevisionError` — never a silent overwrite, and the
 * update itself re-checks them, so a write that lands in between still wins. A revisable row whose origin is not
 * app-authored — a coach session or a COROS-plan import, whose truth was its stage rows — is ADOPTED in the same atomic
 * write: it becomes a Studio document workout (`adoptionColumns`), its stage rows deleted, its plan and its watch address
 * kept. The same document again is no new revision. `watchHasOlder`: the watch holds (or is being sent) a copy built
 * from another revision, or a copy the app did not push from a build (an adopted row's) — the athlete is offered "Send
 * the new version". A new length runs the day's collision pass (a pinned time stays); the answer carries the row's date
 * and time as they then are.
 *
 * Every user-scoped; a write is refused while a restore is replacing the account (`RestoreInProgressError`).
 */
import type { RunWire } from "@rg/domain";
import { and, eq, exists, inArray, isNull, ne, notExists, notInArray, or, sql } from "drizzle-orm";
import {
  corosWriteJobs,
  exercisePrefs,
  performedSessions,
  plannedWorkoutStages,
  plannedWorkouts,
  programs,
  scheduleOverrides,
  sessionBuilds,
  userConditions,
  workoutTemplates,
} from "@rg/database";
import {
  addDays,
  DOC_ORIGINS,
  docOriginRow,
  newId,
  parseStoredWorkoutDoc,
  revisability,
  watchAddressOf,
  workoutDocSchema,
  type Revisability,
  type RevisabilityReason,
  type UserPreferences,
  type WorkoutDoc,
} from "@rg/domain";
import { EXERCISES, PROFILES, isDoneCleanly, isProfileId, type ConditionProfile, type ExerciseRecord } from "@rg/exercise-library";
import { Hist, type HistorySession, type HistorySummary } from "@rg/session-engine";
import { deriveDoc, makeLibraryIndex, QUICK_START_KINDS, validateWorkoutDoc, type DocDerived, type DocIssue, type ValidateCtx } from "@rg/workout";
import { sha256Hex } from "../auth/crypto.js";
import { libraryForDocs, loadAccountLibrary } from "./account-library.js";
import { restoreInProgress } from "./account-state.js";
import { recordedStampFor } from "./coros-stamp.js";
import { runAtomically, type Db } from "./db.js";
import { judgeDoc } from "./doc-build.js";
import { separateDayCollisions, windowTimeFor } from "./day-placement.js";
import { placeOrDefault } from "./default-place.js";
import { loadBuildHistory } from "./engine-inputs.js";
import { RestoreInProgressError } from "./programs.js";
import { bookedSeconds, pushJobId, sentBuildIdOf, slotChecks } from "./session-build.js";
import { removeFromPlan } from "./plan-mutations.js";
import { FROZEN_STATES, newRowDocColumns, revisionInsert, storedDocText, updateDocColumns, type DocSourceKind } from "./workout-doc-store.js";

/** The account's own Studio programme: what every document workout hangs from (its `plan_id`). */
export const studioProgramId = (userId: string): string => `studio-${userId}`;

/** The name the Studio programme carries (a document workout's watch stamp is its own title, watch-push.ts). */
const STUDIO_PROGRAM_NAME = "Studio";

/** A session already under way, or done: its content is locked. */
export const LOCKED_CONTENT = ["started", "done"] as const;

/** A document that fails validation: every issue, errors and warnings. */
export class DocInvalidError extends Error {
  constructor(public readonly issues: DocIssue[]) {
    super("invalid_doc");
  }
}

/** A run is not played by the app yet (Stage 3 adds its execution path): a document that derives to one is refused. */
export class RunUnsupportedError extends Error {
  constructor() {
    super("run_unsupported");
  }
}

/** A workout cannot be made for a day gone. */
/**
 * Start now of a quick start or a template that today already holds, not done or skipped: the athlete is offered that
 * one (Continue) rather than a second for the same day (`POST /api/workouts` with `startNow`, 409 `started_today`).
 */
export class StartedTodayError extends Error {
  constructor(readonly workout: DocWorkoutDto) {
    super("started_today");
  }
}

/** What a document is a start of, to know it again on the same day: a template's, or a quick start's kind; else null. */
function startOf(doc: WorkoutDoc): string | null {
  if (doc.basedOn?.kind === "template") return `template:${doc.basedOn.id}`;
  return doc.source.ref?.startsWith("quick_start:") ? doc.source.ref : null;
}

/**
 * Today's row from the same quick start or template, still to finish (not done, skipped or missed, not gone): one read
 * of today's document rows, only for a document that is such a start.
 */
async function startedToday(db: Db, userId: string, doc: WorkoutDoc, today: string): Promise<DocWorkoutDto | null> {
  const start = startOf(doc);
  if (!start) return null;
  const pw = plannedWorkouts;
  const rows = await db
    .select({
      id: pw.id, effectiveDate: pw.effectiveDate, effectiveTime: pw.effectiveTime, title: pw.title, category: pw.category, sport: pw.sport,
      origin: pw.origin, contentState: pw.contentState, completionState: pw.completionState, workoutDocRev: pw.workoutDocRev,
      workoutDoc: sql<string | null>`${pw.workoutDoc}`,
    })
    .from(pw)
    .where(
      and(
        eq(pw.userId, userId),
        eq(pw.effectiveDate, today),
        isNull(pw.archivedAt),
        inArray(pw.origin, [...DOC_ORIGINS]),
        notInArray(pw.completionState, ["completed", "skipped", "missed"]),
        ne(pw.contentState, "done"),
      ),
    );
  for (const row of rows) {
    const theirs = parseStoredWorkoutDoc(row.workoutDoc);
    // Its minutes in the account's library (the create read it: none more).
    if (theirs && startOf(theirs) === start) return dtoOf(row, theirs, deriveDoc(theirs, (await libraryForDocs(db, userId, [theirs])).all).estimatedMinutes);
  }
  return null;
}

export class PastDateError extends Error {
  constructor() {
    super("past_date");
  }
}

export class DocWorkoutNotFoundError extends Error {
  constructor() {
    super("not_found");
  }
}

/**
 * A workout that cannot be revised (workout-editability spec §3): `revisability`'s reason, what the athlete reads
 * (`why`), and what they — or the coach — can do about it (`instead`).
 */
export class NotEditableError extends Error {
  readonly reason: RevisabilityReason;
  readonly why: string;
  readonly instead: string;
  constructor(r: Extract<Revisability, { ok: false }>) {
    super("not_editable");
    this.reason = r.reason;
    this.why = r.why;
    this.instead = r.instead;
  }
}

/**
 * Why a workout can't be removed (`DELETE /api/workouts/:id`): not a Studio or template workout (a programme's session
 * goes through the programme), under way or done (`started`, `done`: a session was saved or begun), or on its way to
 * the watch this moment (`sending`: a push the lane has claimed).
 */
export class NotRemovableError extends Error {
  constructor(public readonly reason: "not_studio" | "started" | "done" | "sending") {
    super("not_removable");
  }
}

/**
 * The calendar state of a workout started at once (Start now): booked on no calendar — it was never planned — and the
 * player's Discard with nothing logged removes it (`removeAbandonedStartNow`). A move of it to a day of its own (the
 * plan's) makes it `pending`, as any move does: planned now, it is booked.
 */
export const START_NOW_CALENDAR_STATE = "app_only";

/**
 * The calendar state of a workout played offline and recorded on reconnect (`playedOffline`, R11): booked on no
 * calendar, as Start now's — and, left with no session, removed by the daily reconcile only once the outbox has had its
 * reach, a week, to deliver it (its day is already over when it is made).
 */
export const PLAYED_OFFLINE_CALENDAR_STATE = "app_only_offline";
/** The calendar states of a workout started at once: never planned, never booked, never asked about. */
export const STARTED_AT_ONCE_STATES: readonly string[] = [START_NOW_CALENDAR_STATE, PLAYED_OFFLINE_CALENDAR_STATE];
/** How far back a workout played offline may be recorded: the outbox's reach, a week. */
export const PLAYED_OFFLINE_DAYS_BACK = 7;

/**
 * A create of a workout played offline refused (R11): `key` — no device key, or not Start now; `date` — ahead of today,
 * or more than a week back; `source` — not a quick start's or a template's document (a coach's or a programme's never).
 */
export class PlayedOfflineRefusedError extends Error {
  constructor(readonly why: "key" | "date" | "source") {
    super(`played_offline_refused:${why}`);
  }
}

/**
 * A document the app itself made for the athlete to start (never a coach's or a programme's): a quick start's — its ref
 * names a quick start the app makes (`QUICK_START_KINDS`) — or a template's that is not another account's (fix round
 * 1). One the account deleted before the device reconnected is no one's now, and what was played is still recorded
 * (fix round 2); one another account holds is refused.
 */
async function appAuthored(db: Db, userId: string, doc: WorkoutDoc): Promise<boolean> {
  if (doc.source.kind === "coach" || doc.source.kind === "engine") return false;
  const ref = doc.source.ref ?? "";
  if (doc.source.kind === "studio" && ref.startsWith("quick_start:") && (QUICK_START_KINDS as readonly string[]).includes(ref.slice("quick_start:".length))) return true;
  if (doc.basedOn?.kind !== "template") return false;
  const [held] = await db.select({ userId: workoutTemplates.userId }).from(workoutTemplates).where(eq(workoutTemplates.id, doc.basedOn.id)).limit(1);
  return held === undefined || held.userId === userId;
}

/** The base revision is not the row's current one: the document changed elsewhere. */
export class StaleRevisionError extends Error {
  constructor(public readonly rev: number | null) {
    super("stale_revision");
  }
}

/** A document workout as the Studio shows it. */
export interface DocWorkoutDto {
  id: string;
  date: string;
  time: string;
  title: string;
  intentSummary: string;
  category: string;
  sport: string;
  /** `studio` or `template`. */
  origin: string;
  contentState: string;
  completionState: string;
  docRev: number | null;
  /** Derived from the document. */
  minutes: number;
}

export interface DocWorkoutCtx {
  today: string;
  now: string;
  prefs: UserPreferences;
  /** The run wire in force (§8 phase 2, `RUN_WIRE_V2`): a designed run's approve counts and queues by it. v1 when absent. */
  runWire?: RunWire;
}

/**
 * Who wrote the revision: by default the row's origin (made) or the athlete's edit (revised); a server caller (the
 * coach's approval, Stage 3) says otherwise. Never the document's own `source`, which the client writes.
 */
export interface DocWriteSource {
  sourceKind?: DocSourceKind;
  sourceRef?: string | null;
}

// ── The day a document is checked for ────────────────────────────────────────────────────────────────────────

/**
 * The moves the athlete has done CLEANLY by the summary's day — `DayContext.done`, by the library's one rule for what
 * unlocks the next rung (`isDoneCleanly`, the engine's own): a clenched exposure is not a clean one. Each move's tally
 * merges its entries under every legacy id into the move it now is, as the engine's history stats do — in `library` (the
 * account's `all`: a merged personal move's into its target).
 */
export function doneCleanly(summary: HistorySummary, profiles: readonly ConditionProfile[], library: readonly ExerciseRecord[] = EXERCISES): Set<string> {
  const find = makeLibraryIndex(library);
  const byMove = new Map<string, { lastDate: string | null; logged: number; flags: Record<string, number> }>();
  for (const [raw, m] of Object.entries(summary.moves)) {
    if (m.last === null && !m.logged) continue;
    const id = find(raw)?.id ?? raw;
    const tally = byMove.get(id) ?? { lastDate: null, logged: 0, flags: {} };
    if (m.last && (!tally.lastDate || m.last > tally.lastDate)) tally.lastDate = m.last;
    tally.logged += m.logged;
    for (const [flag, n] of Object.entries(m.flags)) tally.flags[flag] = (tally.flags[flag] ?? 0) + n;
    byMove.set(id, tally);
  }
  return new Set([...byMove].filter(([, tally]) => isDoneCleanly(tally, profiles)).map(([id]) => id));
}

/** The last session and the last seven days', as the engine's mode proposal reads them. */
export function recentOf(sessions: readonly HistorySession[], today: string): { last: HistorySession | null; week: HistorySession[] } {
  const past = Hist.sorted(sessions).filter((s) => s.date <= today);
  return { last: past[past.length - 1] ?? null, week: past.filter((s) => Hist.daysBetween(s.date, today) < 7) };
}

/**
 * What a document for `date` is validated with: the account's library (`all`: its personal moves too), the active
 * profiles, the day's reading (the row's own pre-check and the day's checks, as its session sheet reads them — none for
 * a day ahead), what was done cleanly and the recent sessions, the moves set aside, and the gear of the place the
 * document names, by default-place.ts's one rule (as its build reads it, `placeOrDefault`): one of the athlete's places,
 * a preset, or "No equipment" (a bare room's own props); none named, or one deleted since, the athlete's default place.
 */
export async function docDayContext(
  db: Db,
  userId: string,
  o: { date: string; today: string; workoutId: string; placeId?: string },
): Promise<ValidateCtx> {
  const [{ active, profiles, excluded }, place, history, library] = await Promise.all([
    profilesAndSetAside(db, userId),
    placeOrDefault(db, userId, o.placeId),
    loadBuildHistory(db, userId, o.today, null),
    loadAccountLibrary(db, userId),
  ]);
  const checks = o.date <= o.today && active.length > 0 ? await slotChecks(db, userId, o.workoutId, o.date, o.today, active) : {};
  return {
    library: library.all,
    offered: library.offered,
    activeProfiles: profiles,
    day: {
      date: o.date,
      today: o.today,
      readings: Object.fromEntries(Object.entries(checks).map(([p, a]) => [p, { pre: a.pre, post: null, feelingOff: a.feelingOff }])),
      done: doneCleanly(history.summary, profiles, library.all),
      recent: recentOf(history.sessions, o.today),
    },
    excluded,
    equipment: [...place.equipment],
  };
}

/**
 * The account's switched-on condition profiles (ids the library knows, sorted) and the moves it set aside ("not for
 * me"): what every judgement of a document reads of the athlete — a workout's (`docDayContext`), a template's.
 */
export async function profilesAndSetAside(db: Db, userId: string): Promise<{ active: string[]; profiles: ConditionProfile[]; excluded: string[] }> {
  const [conditionRows, setAside] = await Promise.all([
    db
      .select({ profileId: userConditions.profileId })
      .from(userConditions)
      .where(and(eq(userConditions.userId, userId), eq(userConditions.active, true))),
    db
      .select({ exerciseId: exercisePrefs.exerciseId })
      .from(exercisePrefs)
      .where(and(eq(exercisePrefs.userId, userId), eq(exercisePrefs.excluded, true))),
  ]);
  const active = [...new Set(conditionRows.map((r) => r.profileId).filter(isProfileId))].sort();
  return { active, profiles: active.map((id) => PROFILES[id]), excluded: setAside.map((r) => r.exerciseId) };
}

/**
 * A document as the schema reads it; else `DocInvalidError` with its schema issues (nothing else can be read of it),
 * its moves named against the account's library (read only then).
 */
export async function parsedDoc(db: Db, userId: string, raw: unknown): Promise<WorkoutDoc> {
  const parsed = workoutDocSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DocInvalidError(validateWorkoutDoc(raw, { library: (await loadAccountLibrary(db, userId)).all, activeProfiles: [], day: null }));
  }
  return parsed.data;
}

/** A judged document: refused on any error (`DocInvalidError`, every issue — errors first), else its warnings. */
export function accepted(judged: { errors: DocIssue[]; warnings: DocIssue[] }): DocIssue[] {
  if (judged.errors.length > 0) throw new DocInvalidError([...judged.errors, ...judged.warnings]);
  return judged.warnings;
}

/**
 * The document, schema-checked, refused when it is a run (`RunUnsupportedError`), then judged for its day: refused on
 * any error, its warnings answered — with what is derived from it.
 */
async function validated(
  db: Db,
  userId: string,
  raw: unknown,
  day: { date: string; today: string; workoutId: string },
  opts: { playedOffline?: boolean } = {},
): Promise<{ doc: WorkoutDoc; derived: DocDerived; warnings: DocIssue[] }> {
  const doc = await parsedDoc(db, userId, raw);
  if (opts.playedOffline && !(await appAuthored(db, userId, doc))) throw new PlayedOfflineRefusedError("source");
  // A run is told by its share of the document's seconds, and a move's seconds come from its record: derived in the
  // account's library (read once a request — the day's context below finds it with no statement), refused before the
  // day is read. In the public library alone, a personal move is 0 s of work: a jog beside a few of them would be a run.
  const library = (await loadAccountLibrary(db, userId)).all;
  const derived = deriveDoc(doc, library);
  if (derived.discipline === "run") throw new RunUnsupportedError();
  const ctx = await docDayContext(db, userId, { ...day, placeId: doc.setting?.placeId });
  // Played offline: what was done is recorded, not planned — the day was judged on the device, and its gate is skipped
  // here (judged as a template is: every reading-dependent rule on the calmest day). Everything else still holds.
  const warnings = accepted(judgeDoc(doc, opts.playedOffline ? { ...ctx, day: null } : ctx));
  // Its personal moves count in what is derived (its minutes, its kind).
  return { doc, derived, warnings };
}

// ── Writes ───────────────────────────────────────────────────────────────────────────────────────────────────

/** A document workout's origin: `template` when it is based on a saved template, else `studio`. */
export function originOfDoc(doc: WorkoutDoc): (typeof DOC_ORIGINS)[number] {
  return doc.basedOn?.kind === "template" ? "template" : "studio";
}

function dtoOf(
  row: Pick<
    typeof plannedWorkouts.$inferSelect,
    "id" | "effectiveDate" | "effectiveTime" | "title" | "category" | "sport" | "origin" | "contentState" | "completionState" | "workoutDocRev"
  >,
  doc: WorkoutDoc,
  minutes: number,
): DocWorkoutDto {
  return {
    id: row.id,
    date: row.effectiveDate,
    time: row.effectiveTime,
    title: row.title,
    intentSummary: doc.intent.summary,
    category: row.category,
    sport: row.sport,
    origin: row.origin ?? "studio",
    contentState: row.contentState ?? "outline",
    completionState: row.completionState,
    docRev: row.workoutDocRev ?? null,
    minutes,
  };
}

/**
 * The row a create with a client's key (`clientId`: made once per draft on the device, so a retry whose answer was lost
 * sends the same one) makes: an id from a hash of the account and the key — another account's key never meets this
 * one's, and the table's own primary key holds two racing creates to one row. No column holds the key: the id is it.
 */
export async function keyedRowId(userId: string, clientId: string): Promise<string> {
  const h = await sha256Hex(`created:${userId}:${clientId}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** The row a keyed create made, as the create answered it (no warnings: nothing is judged again), or null. */
async function keyedRow(db: Db, userId: string, id: string): Promise<{ workout: DocWorkoutDto; warnings: DocIssue[]; repeated: true } | null> {
  const pw = plannedWorkouts;
  const [row] = await db
    .select({
      id: pw.id, effectiveDate: pw.effectiveDate, effectiveTime: pw.effectiveTime, title: pw.title, category: pw.category, sport: pw.sport,
      origin: pw.origin, contentState: pw.contentState, completionState: pw.completionState, workoutDocRev: pw.workoutDocRev,
      calendarBlockDurationSeconds: pw.calendarBlockDurationSeconds, workoutDoc: sql<string | null>`${pw.workoutDoc}`,
    })
    .from(pw)
    .where(and(eq(pw.id, id), eq(pw.userId, userId)))
    .limit(1);
  if (!row) return null;
  const doc = parseStoredWorkoutDoc(row.workoutDoc);
  if (!doc) return null;
  // Its minutes in the account's library when it holds one of the athlete's own moves (one statement more, then).
  return { workout: dtoOf(row, doc, deriveDoc(doc, (await libraryForDocs(db, userId, [doc])).all).estimatedMinutes), warnings: [], repeated: true };
}

/**
 * `POST /api/workouts`: a document workout for `date` (see the header). With a client's key (`clientId`) it is made
 * once: a repeat answers the row the key made, as it now is, writing nothing (`repeated`). Throws `PastDateError`,
 * `DocInvalidError`, `RestoreInProgressError`.
 */
export async function createDocWorkout(
  db: Db,
  userId: string,
  input: { date: string; time?: string | null; doc: unknown; clientId?: string; startNow?: boolean; playedOffline?: boolean },
  ctx: DocWorkoutCtx,
  source: DocWriteSource = {},
): Promise<{ workout: DocWorkoutDto; warnings: DocIssue[]; repeated?: true }> {
  // Played offline (R11): a record of what was done, made with the device's key and at once — never planned.
  if (input.playedOffline && (!input.clientId || !input.startNow)) throw new PlayedOfflineRefusedError("key");
  const id = input.clientId ? await keyedRowId(userId, input.clientId) : newId();
  if (input.clientId) {
    const made = await keyedRow(db, userId, id);
    if (made) return made;
  }
  if (input.playedOffline) {
    // The day it was played: today, or up to a week back (the outbox's reach) — never ahead.
    if (input.date > ctx.today || input.date < addDays(ctx.today, -PLAYED_OFFLINE_DAYS_BACK)) throw new PlayedOfflineRefusedError("date");
  } else if (input.date < ctx.today) throw new PastDateError();
  const { doc, derived, warnings } = await validated(db, userId, input.doc, { date: input.date, today: ctx.today, workoutId: id }, { playedOffline: input.playedOffline });
  if (await restoreInProgress(db, userId)) throw new RestoreInProgressError();
  // Start now of what today already holds, still to finish: that one is offered instead of a second (I3).
  if (input.startNow && input.date === ctx.today) {
    const same = await startedToday(db, userId, doc, ctx.today);
    if (same) throw new StartedTodayError(same);
  }

  // Its length is the document's own (what the builder, Today and Plan say); the calendar books the rounded block.
  const seconds = derived.estimatedMinutes * 60;
  const booked = bookedSeconds(seconds);
  const date = input.date;
  // Every column, as placement writes a slot's (P1-R12).
  const row = {
    id,
    userId,
    planId: studioProgramId(userId),
    sourceWorkoutId: id,
    sourceProgramId: null,
    sourceIdInPlan: null,
    title: doc.title,
    category: derived.category,
    qualitySubtype: null,
    sport: derived.discipline,
    originalPlanDate: date,
    lastVerifiedCorosDate: "",
    effectiveDate: date,
    effectiveTime: input.time ?? windowTimeFor({ category: derived.category, date }, ctx.prefs),
    sourceContentFingerprint: originOfDoc(doc),
    sourceVersion: null,
    sourceEstimatedDurationSeconds: null,
    fallbackEstimatedDurationSeconds: seconds,
    calendarBlockDurationSeconds: booked,
    durationEstimate: null,
    expectedDistanceMeters: null,
    stageSummary: null,
    structuredJson: null,
    // Started at once (Start now): never planned, so never booked on the calendar; only a Schedule books one.
    calendarSyncState: input.playedOffline ? PLAYED_OFFLINE_CALENDAR_STATE : input.startNow ? START_NOW_CALENDAR_STATE : "not_created",
    corosSyncState: "calendar_only",
    completionState: "scheduled",
    missingReads: 0,
    snoozedUntil: null,
    resolutionDate: null,
    sanctionedBy: null,
    archivedAt: null,
    archiveReason: null,
    origin: originOfDoc(doc),
    contentState: "outline",
    sessionParams: null,
    ...newRowDocColumns(doc),
    createdAt: ctx.now,
    updatedAt: ctx.now,
  } satisfies typeof plannedWorkouts.$inferInsert;

  const writes = [
    db
      .insert(programs)
      .values({
        id: studioProgramId(userId),
        userId,
        kind: "studio",
        name: STUDIO_PROGRAM_NAME,
        status: "active",
        disciplines: [],
        startDate: null,
        endDate: null,
        raceDate: null,
        source: null,
        config: {},
        createdAt: ctx.now,
        updatedAt: ctx.now,
        archivedAt: null,
      })
      .onConflictDoNothing(),
    db.insert(plannedWorkouts).values(row),
    revisionInsert(db, { userId, workoutId: id, sourceKind: source.sourceKind ?? row.origin, sourceRef: source.sourceRef ?? null, now: ctx.now }),
    // A time the athlete picked is pinned, as a time change of theirs is (jobs.ts): no collision pass moves it.
    ...(input.time != null
      ? [
          db.insert(scheduleOverrides).values({
            id: newId(),
            workoutId: id,
            kind: "time_change",
            fromDate: date,
            toDate: date,
            toTime: input.time,
            source: "app",
            createdAt: ctx.now,
          }),
        ]
      : []),
  ];
  try {
    await runAtomically(db, writes);
  } catch (e) {
    // Two creates with one key raced: the one that landed is the answer (the batch that lost wrote nothing).
    const made = input.clientId ? await keyedRow(db, userId, id) : null;
    if (made) return made;
    throw e;
  }

  // A time asked for stands; the athlete's window gives way to what the day already holds, as a placed slot's does.
  let time = row.effectiveTime;
  if (input.time == null) {
    const moved = await separateDayCollisions(db, userId, [date], ctx.prefs, { from: ctx.today, now: ctx.now });
    time = moved.find((m) => m.workoutId === id)?.to ?? time;
  }
  return { workout: dtoOf({ ...row, effectiveTime: time }, doc, derived.estimatedMinutes), warnings };
}

/** A push the lane has claimed: on its way to the watch this moment (a queued one is only cancelled). */
const PUSH_UNDER_WAY = ["claimed", "in_progress", "verifying"] as const;

/**
 * What the watch holds of a row beside a copy pushed from a session build, as the read after a revise sees it: the name
 * of a copy an adopted row took over (`watchCopyName`), and whether a coach create the lane has already claimed is on
 * its way (a queued one is superseded at claim once the row is app-authored, coros-write-cloud.ts; a claimed one can
 * still land the old session — spec §3, M8).
 */
interface HeldCopy {
  watchCopyName: string | null;
  createInFlight: boolean;
}

/**
 * The watch holds — or is being sent — a copy of this row built from a revision other than `rev` (a document build
 * names its revision, `fromDoc.rev`), or a copy the app did not push from a build at all (`HeldCopy`): either is older
 * than the document now stored. The held copy is read with the row after the write, so it costs no statement here.
 */
async function watchHoldsOlder(db: Db, workoutId: string, rev: number | null, held: HeldCopy): Promise<boolean> {
  if (held.watchCopyName !== null || held.createInFlight) return true;
  const sent = await sentBuildIdOf(db, workoutId);
  if (!sent) return false;
  const [build] = await db
    .select({ rev: sql<number | null>`json_extract(${sessionBuilds.payload}, '$.build.fromDoc.rev')` })
    .from(sessionBuilds)
    .where(eq(sessionBuilds.id, sent))
    .limit(1);
  return (build?.rev ?? null) !== rev;
}

/** The fields `revisability` reads of a row, and its stored document's text. */
type RevisableRow = Pick<
  typeof plannedWorkouts.$inferSelect,
  "origin" | "category" | "sport" | "completionState" | "contentState" | "effectiveDate"
> & { workoutDoc: string | null };

/**
 * `revisability` of a row as read: its stored document, when there is one, says whether it is a run — derived in the
 * account's library, as `validated` derives one (one statement, once a request: the revise reads it anyway).
 */
async function revisabilityOf(db: Db, userId: string, row: RevisableRow, today: string): Promise<Revisability> {
  const stored = parseStoredWorkoutDoc(row.workoutDoc);
  const isRun = stored ? deriveDoc(stored, (await loadAccountLibrary(db, userId)).all).discipline === "run" : null;
  return revisability(
    {
      origin: row.origin,
      category: row.category,
      sport: row.sport,
      completionState: row.completionState,
      contentState: row.contentState,
      effectiveDate: row.effectiveDate,
      hasDoc: stored !== null,
      isRun,
    },
    today,
  );
}

/** What an adopted row becomes: a Studio document workout. */
const ADOPTED_ORIGIN = "studio" satisfies (typeof DOC_ORIGINS)[number];

/**
 * ADOPTION (workout-editability spec §3): the columns a revise writes, in the same UPDATE as the document, when it takes
 * over a revisable row whose origin is not app-authored — a coach session or a COROS-plan import, whose truth was its
 * stage rows, `structured_json` and the copy on the watch. It becomes a Studio document workout: origin `studio`; every
 * content column `createDocWorkout` writes as null cleared (its stage rows are deleted in the same batch); its fingerprint
 * set as `createDocWorkout` sets it, to its origin. Its plan and its watch address are not touched: an adopted row stays
 * in its plan, and the copy on the watch now belongs to it, held under `copyName` — never over a name already recorded.
 */
function adoptionColumns(copyName: string | null) {
  return {
    origin: ADOPTED_ORIGIN,
    structuredJson: null,
    stageSummary: null,
    expectedDistanceMeters: null,
    qualitySubtype: null,
    sourceEstimatedDurationSeconds: null,
    durationEstimate: null,
    sourceVersion: null,
    sourceContentFingerprint: ADOPTED_ORIGIN,
    watchCopyName: sql<string | null>`coalesce(${plannedWorkouts.watchCopyName}, ${copyName})`,
  };
}

/**
 * The program name the watch holds an adopted row's copy under (spec §4) — only for a row with a watch address, as the
 * unpush reads one (`unpushInsertIfOurs`): with none, nothing on the watch is this row's to name. The stamp the app last
 * wrote for a coach row (`recordedStampFor`), else the row's title: an imported row's title is the wire's own name.
 */
async function heldCopyName(
  db: Db,
  userId: string,
  row: Pick<typeof plannedWorkouts.$inferSelect, "id" | "title" | "sourceWorkoutId" | "sourceIdInPlan" | "sourceProgramId" | "lastVerifiedCorosDate">,
): Promise<string | null> {
  if (!watchAddressOf(row)) return null;
  return (await recordedStampFor(db, userId, row.id)) ?? row.title;
}

/**
 * `PUT /api/workouts/:id/doc`: a new revision of a workout's document, adopting a watch-shaped row (see the header).
 * `calendarChanged`: its title, category or booked length moved — what its event shows. Throws
 * `DocWorkoutNotFoundError`, `NotEditableError`, `StaleRevisionError`, `DocInvalidError`, `RunUnsupportedError`,
 * `RestoreInProgressError`.
 */
export async function reviseDocWorkout(
  db: Db,
  userId: string,
  workoutId: string,
  input: { doc: unknown; baseRev: number },
  ctx: DocWorkoutCtx,
  source: DocWriteSource = {},
): Promise<{ workout: DocWorkoutDto; rev: number | null; watchHasOlder: boolean; warnings: DocIssue[]; calendarChanged: boolean }> {
  const pw = plannedWorkouts;
  const [row] = await db
    .select({
      id: pw.id,
      effectiveDate: pw.effectiveDate,
      effectiveTime: pw.effectiveTime,
      title: pw.title,
      category: pw.category,
      sport: pw.sport,
      origin: pw.origin,
      contentState: pw.contentState,
      completionState: pw.completionState,
      workoutDocRev: pw.workoutDocRev,
      workoutDoc: sql<string | null>`${pw.workoutDoc}`,
      calendarBlockDurationSeconds: pw.calendarBlockDurationSeconds,
      archivedAt: pw.archivedAt,
      sourceWorkoutId: pw.sourceWorkoutId,
      sourceIdInPlan: pw.sourceIdInPlan,
      sourceProgramId: pw.sourceProgramId,
      lastVerifiedCorosDate: pw.lastVerifiedCorosDate,
      watchCopyName: pw.watchCopyName,
    })
    .from(pw)
    .where(and(eq(pw.id, workoutId), eq(pw.userId, userId)))
    .limit(1);
  if (!row || row.archivedAt) throw new DocWorkoutNotFoundError();
  // Refused before the document is judged: the row decides (its day, its state, its kind), never the draft.
  const verdict = await revisabilityOf(db, userId, row, ctx.today);
  if (!verdict.ok) throw new NotEditableError(verdict);
  if ((row.workoutDocRev ?? 0) !== input.baseRev) throw new StaleRevisionError(row.workoutDocRev ?? null);

  const { doc, derived, warnings } = await validated(db, userId, input.doc, { date: row.effectiveDate, today: ctx.today, workoutId });
  if (await restoreInProgress(db, userId)) throw new RestoreInProgressError();
  // Adopted (a coach session, a COROS-plan import): decided by this read — the update's guard still holds its revision,
  // and every write that could change its origin moves the revision on. The same document again adopts it too: the
  // revise is a taking-over, not only an edit. The name its copy is held under is read now, before the batch.
  const adopting = verdict.adopts;
  const copyName = adopting && row.watchCopyName === null ? await heldCopyName(db, userId, row) : null;

  // Its length is the document's own; the calendar books the rounded block (I4).
  const seconds = derived.estimatedMinutes * 60;
  const booked = bookedSeconds(seconds);
  const text = storedDocText(doc);
  await runAtomically(db, [
    db
      .update(pw)
      .set({
        ...updateDocColumns(doc),
        title: doc.title,
        category: derived.category,
        sport: derived.discipline,
        fallbackEstimatedDurationSeconds: seconds,
        calendarBlockDurationSeconds: booked,
        // The event shows the title and the length: a written one is asked to update.
        calendarSyncState: sql`case when ${pw.calendarSyncState} = 'synced' and (${pw.title} is not ${doc.title} or ${pw.calendarBlockDurationSeconds} is not ${booked} or ${pw.category} is not ${derived.category}) then 'pending' else ${pw.calendarSyncState} end`,
        ...(adopting ? adoptionColumns(copyName) : {}),
        updatedAt: ctx.now,
      })
      .where(
        and(
          eq(pw.id, workoutId),
          eq(pw.userId, userId),
          isNull(pw.archivedAt),
          // Never a programme's session (the engine builds it). Any other origin — NULL included, which `NOT IN` alone
          // would refuse (NULL NOT IN (…) is NULL in SQLite: spec M2) — takes the revise.
          or(isNull(pw.origin), notInArray(pw.origin, ["program", "on_demand"])),
          sql`coalesce(${pw.workoutDocRev}, 0) = ${input.baseRev}`,
          notInArray(pw.completionState, [...FROZEN_STATES]),
          or(isNull(pw.contentState), notInArray(pw.contentState, [...LOCKED_CONTENT])),
        ),
      ),
    // An adopted row's stage rows described the session it was: its document is its content now. Only once the update
    // above has landed (the row is a document workout as this statement reads it): an update its guard refused leaves
    // the row watch-shaped, and its stage rows are still its truth. Never a statement for a row not being adopted.
    ...(adopting
      ? [
          db
            .delete(plannedWorkoutStages)
            .where(
              and(
                eq(plannedWorkoutStages.workoutId, workoutId),
                exists(db.select({ id: pw.id }).from(pw).where(and(eq(pw.id, workoutId), eq(pw.userId, userId), inArray(pw.origin, [...DOC_ORIGINS])))),
              ),
            ),
        ]
      : []),
    revisionInsert(db, { userId, workoutId, sourceKind: source.sourceKind ?? "athlete_edit", sourceRef: source.sourceRef ?? null, now: ctx.now }),
  ]);
  const [after] = await db
    .select({
      workoutDoc: pw.workoutDoc,
      workoutDocRev: pw.workoutDocRev,
      origin: pw.origin,
      category: pw.category,
      sport: pw.sport,
      completionState: pw.completionState,
      contentState: pw.contentState,
      effectiveDate: pw.effectiveDate,
      archivedAt: pw.archivedAt,
      watchCopyName: pw.watchCopyName,
      createInFlight: sql<number>`exists (select 1 from ${corosWriteJobs} where ${and(
        eq(corosWriteJobs.userId, userId),
        eq(corosWriteJobs.workoutId, workoutId),
        eq(corosWriteJobs.kind, "coach_create_workout"),
        inArray(corosWriteJobs.status, [...PUSH_UNDER_WAY]),
      )})`,
    })
    .from(pw)
    .where(and(eq(pw.id, workoutId), eq(pw.userId, userId)))
    .limit(1);
  if (!after || after.workoutDoc !== text || (adopting && !docOriginRow(after))) {
    // Another write landed between the read and this one: say what stopped this one. The row gone is not found; a base
    // moved on is stale; else the row, read again as it now is, says why it can no longer be revised. One that still
    // reads revisable lost a pure race (its guard met a state that has since moved back, or an adoption that did not
    // land): stale, so the caller reads it again — never a reason that is not the row's.
    if (!after || after.archivedAt) throw new DocWorkoutNotFoundError();
    if ((after.workoutDocRev ?? 0) !== input.baseRev) throw new StaleRevisionError(after.workoutDocRev ?? null);
    const now = await revisabilityOf(db, userId, after, ctx.today);
    if (!now.ok) throw new NotEditableError(now);
    throw new StaleRevisionError(after.workoutDocRev ?? null);
  }
  // A new length can overlap the day's other plans: the collision pass (a pinned time stays), and the time it leaves.
  const moved = booked !== row.calendarBlockDurationSeconds
    ? await separateDayCollisions(db, userId, [row.effectiveDate], ctx.prefs, { from: ctx.today, now: ctx.now })
    : [];
  const rev = after.workoutDocRev ?? null;
  const workout = dtoOf(
    {
      ...row,
      origin: after.origin,
      effectiveTime: moved.find((m) => m.workoutId === workoutId)?.to ?? row.effectiveTime,
      title: doc.title,
      category: derived.category,
      sport: derived.discipline,
      workoutDocRev: rev,
    },
    doc,
    derived.estimatedMinutes,
  );
  const calendarChanged = row.title !== doc.title || row.calendarBlockDurationSeconds !== booked || row.category !== derived.category;
  const held = { watchCopyName: after.watchCopyName, createInFlight: Boolean(after.createInFlight) };
  return { workout, rev, watchHasOlder: await watchHoldsOlder(db, workoutId, rev, held), warnings, calendarChanged };
}

/**
 * `DELETE /api/workouts/:id`: a Studio or template workout never started — no session saved or begun, nothing on its
 * way to the watch this moment — removed as the Plan page's Remove removes one (`removeFromPlan`): archived, its
 * calendar event taken off (the next sync deletes it, and it is never booked again), its queued watch work cancelled,
 * a copy already on the watch taken off. Gone, so nothing reads it as missed. Throws `DocWorkoutNotFoundError` (not
 * this account's, or removed already), `NotRemovableError`, `RestoreInProgressError`.
 */
export async function removeDocWorkout(db: Db, userId: string, workoutId: string, ctx: DocWorkoutCtx): Promise<{ effectiveDate: string }> {
  const pw = plannedWorkouts;
  const [row] = await db
    .select({ id: pw.id, origin: pw.origin, contentState: pw.contentState, completionState: pw.completionState, archivedAt: pw.archivedAt })
    .from(pw)
    .where(and(eq(pw.id, workoutId), eq(pw.userId, userId)))
    .limit(1);
  if (!row || row.archivedAt) throw new DocWorkoutNotFoundError();
  if (!docOriginRow(row)) throw new NotRemovableError("not_studio");
  if (row.contentState === "done" || (FROZEN_STATES as readonly string[]).includes(row.completionState)) throw new NotRemovableError("done");
  if (row.contentState === "started") throw new NotRemovableError("started");
  const [saved] = await db
    .select({ id: performedSessions.id })
    .from(performedSessions)
    .where(and(eq(performedSessions.userId, userId), eq(performedSessions.workoutId, workoutId)))
    .limit(1);
  if (saved) throw new NotRemovableError("done");
  const sent = await sentBuildIdOf(db, workoutId);
  if (sent) {
    const [push] = await db.select({ status: corosWriteJobs.status }).from(corosWriteJobs).where(eq(corosWriteJobs.id, pushJobId(sent))).limit(1);
    if (push && (PUSH_UNDER_WAY as readonly string[]).includes(push.status)) throw new NotRemovableError("sending");
  }
  if (await restoreInProgress(db, userId)) throw new RestoreInProgressError();
  // Only while it is still as judged: a session begun or saved between the reads and this write keeps it.
  const removed = await removeFromPlan(db, userId, workoutId, {
    now: ctx.now,
    source: "remove_from_plan",
    prefs: ctx.prefs,
    onlyIf: and(
      or(isNull(pw.contentState), notInArray(pw.contentState, ["started", "done"])),
      notInArray(pw.completionState, [...FROZEN_STATES]),
      notExists(db.select({ id: performedSessions.id }).from(performedSessions).where(eq(performedSessions.workoutId, workoutId))),
    ),
  });
  if (!removed.removed) throw new NotRemovableError("started");
  return { effectiveDate: removed.effectiveDate! };
}

/**
 * The player's Discard of a workout started at once (Start now) with nothing logged: it was never planned, so it goes
 * (`removeFromPlan`), never left behind to read as missed. Any other row stays as the Discard left it. Answers whether
 * it was removed.
 */
export async function removeAbandonedStartNow(db: Db, userId: string, workoutId: string, ctx: Pick<DocWorkoutCtx, "now" | "prefs">): Promise<boolean> {
  const pw = plannedWorkouts;
  const [row] = await db
    .select({ origin: pw.origin, calendarSyncState: pw.calendarSyncState, archivedAt: pw.archivedAt })
    .from(pw)
    .where(and(eq(pw.id, workoutId), eq(pw.userId, userId)))
    .limit(1);
  if (!row || row.archivedAt || !docOriginRow(row) || row.calendarSyncState !== START_NOW_CALENDAR_STATE) return false;
  const removed = await removeFromPlan(db, userId, workoutId, {
    now: ctx.now,
    source: "remove_from_plan",
    prefs: ctx.prefs,
    onlyIf: and(
      eq(pw.calendarSyncState, START_NOW_CALENDAR_STATE),
      or(isNull(pw.contentState), ne(pw.contentState, "done")),
      notExists(db.select({ id: performedSessions.id }).from(performedSessions).where(eq(performedSessions.workoutId, workoutId))),
    ),
  });
  return removed.removed;
}
