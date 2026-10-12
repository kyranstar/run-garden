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
 * REVISING ONE (`reviseDocWorkout`). Only a document workout's own document, and only while it is still to be done:
 * a programme's session (the engine builds it), a completed, skipped or missed row, and a session already started are
 * `NotEditableError`; a base revision that is not the row's current one is `StaleRevisionError` — never a silent
 * overwrite, and the update itself re-checks both, so a write that lands in between still wins. The same document
 * again is no new revision. `watchHasOlder`: the watch holds (or is being sent) a copy built from another revision —
 * the athlete is offered "Send the new version". A new length runs the day's collision pass (a pinned time stays); the
 * answer carries the row's date and time as they then are.
 *
 * Every user-scoped; a write is refused while a restore is replacing the account (`RestoreInProgressError`).
 */
import { and, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { exercisePrefs, locations, plannedWorkouts, programs, scheduleOverrides, sessionBuilds, userConditions } from "@rg/database";
import {
  DOC_ORIGINS,
  docOriginRow,
  newId,
  workoutDocSchema,
  type UserPreferences,
  type WorkoutDoc,
} from "@rg/domain";
import { EXERCISES, PROFILES, isDoneCleanly, isProfileId, type ConditionProfile } from "@rg/exercise-library";
import { Hist, type HistorySession, type HistorySummary } from "@rg/session-engine";
import { deriveDoc, makeLibraryIndex, validateWorkoutDoc, type DocDerived, type DocIssue, type ValidateCtx } from "@rg/workout";
import { restoreInProgress } from "./account-state.js";
import { runAtomically, type Db } from "./db.js";
import { judgeDoc } from "./doc-build.js";
import { separateDayCollisions, windowTimeFor } from "./day-placement.js";
import { loadBuildHistory } from "./engine-inputs.js";
import { RestoreInProgressError } from "./programs.js";
import { bookedSeconds, sentBuildIdOf, slotChecks } from "./session-build.js";
import { FROZEN_STATES, newRowDocColumns, revisionInsert, storedDocText, updateDocColumns, type DocSourceKind } from "./workout-doc-store.js";

/** The account's own Studio programme: what every document workout hangs from (its `plan_id`). */
export const studioProgramId = (userId: string): string => `studio-${userId}`;

/** The name the Studio programme carries (a document workout's watch stamp is its own title, watch-push.ts). */
const STUDIO_PROGRAM_NAME = "Studio";

/** A session already under way, or done: its content is locked. */
const LOCKED_CONTENT = ["started", "done"] as const;

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

/** Not a document workout, or no longer to be done (resolved, or under way). */
export class NotEditableError extends Error {
  constructor() {
    super("not_editable");
  }
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
 * merges its entries under every legacy id into the move it now is, as the engine's history stats do.
 */
export function doneCleanly(summary: HistorySummary, profiles: readonly ConditionProfile[]): Set<string> {
  const find = makeLibraryIndex(EXERCISES);
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
function recentOf(sessions: readonly HistorySession[], today: string): { last: HistorySession | null; week: HistorySession[] } {
  const past = Hist.sorted(sessions).filter((s) => s.date <= today);
  return { last: past[past.length - 1] ?? null, week: past.filter((s) => Hist.daysBetween(s.date, today) < 7) };
}

/**
 * What a document for `date` is validated with: the active profiles, the day's reading (the row's own pre-check and
 * the day's checks, as its session sheet reads them — none for a day ahead), what was done cleanly and the recent
 * sessions, the moves set aside, and the gear of the place the document names (none named: not checked).
 */
export async function docDayContext(
  db: Db,
  userId: string,
  o: { date: string; today: string; workoutId: string; placeId?: string },
): Promise<ValidateCtx> {
  const [{ active, profiles, excluded }, places, history] = await Promise.all([
    profilesAndSetAside(db, userId),
    o.placeId
      ? db.select({ equipment: locations.equipment }).from(locations).where(and(eq(locations.id, o.placeId), eq(locations.userId, userId))).limit(1)
      : Promise.resolve([]),
    loadBuildHistory(db, userId, o.today, null),
  ]);
  const checks = o.date <= o.today && active.length > 0 ? await slotChecks(db, userId, o.workoutId, o.date, o.today, active) : {};
  const place = places[0];
  return {
    library: EXERCISES,
    activeProfiles: profiles,
    day: {
      date: o.date,
      today: o.today,
      readings: Object.fromEntries(Object.entries(checks).map(([p, a]) => [p, { pre: a.pre, post: null, feelingOff: a.feelingOff }])),
      done: doneCleanly(history.summary, profiles),
      recent: recentOf(history.sessions, o.today),
    },
    excluded,
    ...(place ? { equipment: [...place.equipment] } : {}),
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

/** A document as the schema reads it; else `DocInvalidError` with its schema issues (nothing else can be read of it). */
export function parsedDoc(raw: unknown): WorkoutDoc {
  const parsed = workoutDocSchema.safeParse(raw);
  if (!parsed.success) throw new DocInvalidError(validateWorkoutDoc(raw, { library: EXERCISES, activeProfiles: [], day: null }));
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
): Promise<{ doc: WorkoutDoc; derived: DocDerived; warnings: DocIssue[] }> {
  const doc = parsedDoc(raw);
  const derived = deriveDoc(doc, EXERCISES);
  if (derived.discipline === "run") throw new RunUnsupportedError();
  const warnings = accepted(judgeDoc(doc, await docDayContext(db, userId, { ...day, placeId: doc.setting?.placeId })));
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
 * `POST /api/workouts`: a document workout for `date` (see the header). Throws `PastDateError`, `DocInvalidError`,
 * `RestoreInProgressError`.
 */
export async function createDocWorkout(
  db: Db,
  userId: string,
  input: { date: string; time?: string | null; doc: unknown },
  ctx: DocWorkoutCtx,
  source: DocWriteSource = {},
): Promise<{ workout: DocWorkoutDto; warnings: DocIssue[] }> {
  if (input.date < ctx.today) throw new PastDateError();
  const id = newId();
  const { doc, derived, warnings } = await validated(db, userId, input.doc, { date: input.date, today: ctx.today, workoutId: id });
  if (await restoreInProgress(db, userId)) throw new RestoreInProgressError();

  const seconds = bookedSeconds(derived.estimatedMinutes * 60);
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
    calendarBlockDurationSeconds: seconds,
    durationEstimate: null,
    expectedDistanceMeters: null,
    stageSummary: null,
    structuredJson: null,
    calendarSyncState: "not_created",
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

  await runAtomically(db, [
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
  ]);

  // A time asked for stands; the athlete's window gives way to what the day already holds, as a placed slot's does.
  let time = row.effectiveTime;
  if (input.time == null) {
    const moved = await separateDayCollisions(db, userId, [date], ctx.prefs, { from: ctx.today, now: ctx.now });
    time = moved.find((m) => m.workoutId === id)?.to ?? time;
  }
  return { workout: dtoOf({ ...row, effectiveTime: time }, doc, derived.estimatedMinutes), warnings };
}

/**
 * The watch holds — or is being sent — a copy of this row built from a revision other than `rev` (a document build
 * names its revision, `fromDoc.rev`).
 */
async function watchHoldsOlder(db: Db, workoutId: string, rev: number | null): Promise<boolean> {
  const sent = await sentBuildIdOf(db, workoutId);
  if (!sent) return false;
  const [build] = await db
    .select({ rev: sql<number | null>`json_extract(${sessionBuilds.payload}, '$.build.fromDoc.rev')` })
    .from(sessionBuilds)
    .where(eq(sessionBuilds.id, sent))
    .limit(1);
  return (build?.rev ?? null) !== rev;
}

/**
 * `PUT /api/workouts/:id/doc`: a new revision of a document workout (see the header). `calendarChanged`: its title,
 * category or booked length moved — what its event shows. Throws `DocWorkoutNotFoundError`, `NotEditableError`,
 * `StaleRevisionError`, `DocInvalidError`, `RestoreInProgressError`.
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
      calendarBlockDurationSeconds: pw.calendarBlockDurationSeconds,
      archivedAt: pw.archivedAt,
    })
    .from(pw)
    .where(and(eq(pw.id, workoutId), eq(pw.userId, userId)))
    .limit(1);
  if (!row || row.archivedAt) throw new DocWorkoutNotFoundError();
  const frozen = (FROZEN_STATES as readonly string[]).includes(row.completionState);
  const underWay = (LOCKED_CONTENT as readonly (string | null)[]).includes(row.contentState);
  if (!docOriginRow(row) || frozen || underWay) throw new NotEditableError();
  if ((row.workoutDocRev ?? 0) !== input.baseRev) throw new StaleRevisionError(row.workoutDocRev ?? null);

  const { doc, derived, warnings } = await validated(db, userId, input.doc, { date: row.effectiveDate, today: ctx.today, workoutId });
  if (await restoreInProgress(db, userId)) throw new RestoreInProgressError();

  const seconds = bookedSeconds(derived.estimatedMinutes * 60);
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
        calendarBlockDurationSeconds: seconds,
        // The event shows the title and the length: a written one is asked to update.
        calendarSyncState: sql`case when ${pw.calendarSyncState} = 'synced' and (${pw.title} is not ${doc.title} or ${pw.calendarBlockDurationSeconds} is not ${seconds} or ${pw.category} is not ${derived.category}) then 'pending' else ${pw.calendarSyncState} end`,
        updatedAt: ctx.now,
      })
      .where(
        and(
          eq(pw.id, workoutId),
          eq(pw.userId, userId),
          isNull(pw.archivedAt),
          inArray(pw.origin, [...DOC_ORIGINS]),
          sql`coalesce(${pw.workoutDocRev}, 0) = ${input.baseRev}`,
          notInArray(pw.completionState, [...FROZEN_STATES]),
          or(isNull(pw.contentState), notInArray(pw.contentState, [...LOCKED_CONTENT])),
        ),
      ),
    revisionInsert(db, { userId, workoutId, sourceKind: source.sourceKind ?? "athlete_edit", sourceRef: source.sourceRef ?? null, now: ctx.now }),
  ]);
  const [after] = await db
    .select({ workoutDoc: pw.workoutDoc, workoutDocRev: pw.workoutDocRev })
    .from(pw)
    .where(and(eq(pw.id, workoutId), eq(pw.userId, userId)))
    .limit(1);
  if (!after || after.workoutDoc !== text) {
    // Another write landed between the read and this one: say what stopped this one.
    if (after && (after.workoutDocRev ?? 0) !== input.baseRev) throw new StaleRevisionError(after.workoutDocRev ?? null);
    throw new NotEditableError();
  }
  // A new length can overlap the day's other plans: the collision pass (a pinned time stays), and the time it leaves.
  const moved = seconds !== row.calendarBlockDurationSeconds
    ? await separateDayCollisions(db, userId, [row.effectiveDate], ctx.prefs, { from: ctx.today, now: ctx.now })
    : [];
  const rev = after.workoutDocRev ?? null;
  const workout = dtoOf(
    {
      ...row,
      effectiveTime: moved.find((m) => m.workoutId === workoutId)?.to ?? row.effectiveTime,
      title: doc.title,
      category: derived.category,
      sport: derived.discipline,
      workoutDocRev: rev,
    },
    doc,
    derived.estimatedMinutes,
  );
  const calendarChanged = row.title !== doc.title || row.calendarBlockDurationSeconds !== seconds || row.category !== derived.category;
  return { workout, rev, watchHasOlder: await watchHoldsOlder(db, workoutId, rev), warnings, calendarChanged };
}
