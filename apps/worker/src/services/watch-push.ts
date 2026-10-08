/**
 * SEND TODAY'S SESSION TO THE WATCH (Phase 3; spec 2026-09-30-phase-3-watch-design.md §3–§4).
 *
 * The pure part: a locked build's steps as the watch will hold them
 * (`watchStepsFromBuild`), and the stamp the push carries (`programStamp`).
 * The service part: the preview, Send, Take off, and the state the sheet shows
 * (below the pure part).
 *
 *  - Every work step of the build is one watch step. A timed window is a hold;
 *    a set is its reps, else its seconds, else open. Per-side windows stay two
 *    steps, each overview naming its side, and a one-sided set (a unilateral
 *    move's set with no side) becomes such a Left/Right pair (audit W-1).
 *  - A move whose T-code (`corosKeyOf`, ruling 3-R1) the athlete's catalog holds
 *    goes as that catalog step; every other move goes as free text on
 *    `originId "0"` (spike outcome A), its name cut at a word to 30 characters
 *    (ruling 3-R6) so the preview stays exact if COROS has a limit.
 *  - Weights in grams (kg × 1000, the wire's only unit); none is bodyweight.
 *  - A rest adds onto the step before it (at most 900 s); a leading rest has no
 *    step to hang on and is dropped.
 */
import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { corosWriteJobs, plannedWorkouts, programs, providerConnections, sessionBuilds } from "@rg/database";
import {
  programSessionPushJobSchema,
  STAMPING_JOB_KINDS,
  todayInZone,
  toKg,
  watchAddressOf,
  weightInUnit,
  WATCH_MAX_STEPS,
  WATCH_NAME_MAX,
  WATCH_OVERVIEW_MAX,
  WATCH_STAMP_MAX,
  WATCH_STAMP_MAX_BYTES,
  type ProgramSessionPushJob,
  type ProgramWatchStep,
  type UserPreferences,
  type Weight,
} from "@rg/domain";
import { buildProgramWatchProgram, FREE_TEXT_ORIGIN_ID, previewOfProgram, type ProgramPreviewStep } from "@rg/coros";
import { COROS_EXERCISE_NAMES, localDateToCorosDay } from "@rg/providers";
import type { Step } from "@rg/session-engine";
import { watchPushEnabled, type Env } from "../env.js";
import type { Db } from "./db.js";
import { corosKeyOf } from "./coros-exercise-map.js";
import { STAMP_SEPARATOR, stampName } from "./coros-stamp.js";
import { exerciseNameMap } from "./exercise-catalog.js";
import {
  loadSession,
  loadSlot,
  lockCurrentBuild,
  pushJobId,
  sentBuildIdOf,
  StaleBuildError,
  type BuildCtx,
  type BuildPayload,
  type SessionResponse,
} from "./session-build.js";

/** The longest rest a step's rest fields carry. */
const MAX_REST_SECONDS = 900;

export interface WatchPlanDeps {
  /** T-code → the athlete's catalog id; keys the catalog holds twice are absent. */
  catalogIdByKey: ReadonlyMap<string, string>;
  /** Library id → T-code (`corosKeyOf`). */
  keyOf: (exerciseId: string) => string | null;
}

export type WatchRefusal = "empty" | "too_long";

export interface WatchPlan {
  steps: ProgramWatchStep[];
  /** How many steps go as free text. */
  freeText: number;
  refusal: WatchRefusal | null;
}

const utf8 = new TextEncoder();

/**
 * `text` as the characters a reader sees — grapheme clusters (workerd and Node segment them), else code points — so a
 * cut between two of them never leaves half an emoji, a lone surrogate or a dangling joiner (audit W-3, lane L-6).
 */
function charactersOf(text: string): string[] {
  if (typeof Intl.Segmenter === "function") {
    return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (s) => s.segment);
  }
  return Array.from(text);
}

/**
 * `text` cut at a word boundary to at most `max` characters (UTF-16 units, what the schemas count) and `maxBytes`
 * UTF-8 bytes, whole characters only, with no dangling separator; a single word longer than that is cut hard, still
 * between characters (ruling 3-R6).
 */
export function cutAtWord(text: string, max: number, maxBytes = Number.POSITIVE_INFINITY): string {
  const t = text.trim();
  if (t.length <= max && (maxBytes === Number.POSITIVE_INFINITY || utf8.encode(t).length <= maxBytes)) return t;
  const chars = charactersOf(t);
  let hard = "";
  let bytes = 0;
  let n = 0;
  for (; n < chars.length; n++) {
    const ch = chars[n]!;
    const b = utf8.encode(ch).length;
    if (hard.length + ch.length > max || bytes + b > maxBytes) break;
    hard += ch;
    bytes += b;
  }
  // A space right after the hard cut means every word in it is whole; else cut back to the last space inside it.
  const space = /^\s/u.test(chars[n] ?? "") ? hard.length : hard.lastIndexOf(" ");
  const cut = (space > 0 ? hard.slice(0, space) : hard).replace(/[\s·,;:—–-]+$/u, "");
  return cut || hard;
}

function targetOf(s: Step): ProgramWatchStep["target"] {
  if (s.kind === "timed") {
    const seconds = Math.round(s.seconds);
    return seconds >= 1 ? { kind: "hold", seconds: Math.min(3600, seconds) } : { kind: "open" };
  }
  const reps = Math.round(s.target?.reps ?? 0);
  if (reps >= 1) return { kind: "reps", reps: Math.min(500, reps) };
  const secs = Math.round(s.target?.secs ?? 0);
  if (secs >= 1) return { kind: "hold", seconds: Math.min(3600, secs) };
  return { kind: "open" };
}

/** The side, then the qualifier a long name gave up, then the first cue — at most WATCH_OVERVIEW_MAX characters. */
function overviewOf(side: Step["side"], qualifier: string | null, cue: string | undefined): string {
  const sideText = side === "Left" ? "left side" : side === "Right" ? "right side" : null;
  return cutAtWord([sideText, qualifier, cue?.trim()].filter((p): p is string => Boolean(p)).join(QUALIFIER), WATCH_OVERVIEW_MAX);
}

/** How a library name sets a variant apart: "Child's pose · forehead on block". */
const QUALIFIER = " · ";
/** A word a cut name must not end on: "Child's pose · forehead on" reads as a sentence cut off. */
const DANGLING_WORD = /\s+(?:a|an|and|at|by|for|from|in|of|on|or|the|to|under|with)$/iu;
const TRAILING_SEPARATOR = /[\s·,;:—–-]+$/u;

/**
 * A free-text move's name as the watch shows it, at most WATCH_NAME_MAX characters (ruling 3-R6, audit W-6). A longer
 * "<move> · <qualifier>" goes as the move, its qualifier leading the overview; any other long name is cut at a word,
 * never ending on a word like "on" or "with".
 */
export function watchNameOf(libraryName: string): { name: string; qualifier: string | null } {
  const t = libraryName.trim();
  if (t.length <= WATCH_NAME_MAX) return { name: t, qualifier: null };
  const at = t.indexOf(QUALIFIER);
  const head = at > 0 ? t.slice(0, at).trim() : "";
  if (head && head.length <= WATCH_NAME_MAX) return { name: head, qualifier: t.slice(at + QUALIFIER.length).trim() || null };
  let name = cutAtWord(t, WATCH_NAME_MAX);
  while (DANGLING_WORD.test(name)) name = name.replace(DANGLING_WORD, "").replace(TRAILING_SEPARATOR, "");
  return { name, qualifier: null };
}

/**
 * Each free-text move's watch name and qualifier. Two different moves never share a watch name within one program
 * (audit W-6): a name a catalog step of the session already shows (its English name), or an earlier free-text move
 * holds (by first appearance in the build), gets " (2)", " (3)", cut to fit. The same build gives the same names.
 */
function freeTextNames(build: BuildPayload, deps: WatchPlanDeps): Map<string, { name: string; qualifier: string | null }> {
  const catalogKey = (id: string): string | null => {
    const key = deps.keyOf(id);
    return key && deps.catalogIdByKey.has(key) ? key : null;
  };
  const moves = [...new Set(build.steps.flatMap((s) => (s.kind !== "rest" && s.exerciseId && build.exercises[s.exerciseId] ? [s.exerciseId] : [])))];
  const taken = new Set(
    moves.flatMap((id) => {
      const key = catalogKey(id);
      return key ? [(COROS_EXERCISE_NAMES[key] ?? key).toLowerCase()] : [];
    }),
  );
  const out = new Map<string, { name: string; qualifier: string | null }>();
  for (const id of moves) {
    if (catalogKey(id)) continue;
    const { name, qualifier } = watchNameOf(build.exercises[id]!.name);
    let unique = name;
    for (let n = 2; taken.has(unique.toLowerCase()); n++) unique = `${cutAtWord(name, WATCH_NAME_MAX - ` (${n})`.length)} (${n})`;
    taken.add(unique.toLowerCase());
    out.set(id, { name: unique, qualifier });
  }
  return out;
}

/**
 * The sides one build step goes to the watch as. A set of a unilateral move with no side is work on BOTH sides — the
 * engine prices it so (`setSeconds` × 2) and the player says "each side" — so it is a Left then a Right step, one lap
 * each, as the coach lane does since 2026-08-17 (audit W-1): one step would prescribe half the work. A timed window
 * already carries its side; an alternating move is one step, as the app shows it.
 */
function sidesOf(s: Step, record: { laterality: string }): Array<Step["side"]> {
  return s.kind === "set" && s.side === null && record.laterality === "unilateral" ? ["Left", "Right"] : [s.side];
}

/** The build's steps as the watch will hold them. Pure: the same build gives the same steps. */
export function watchStepsFromBuild(build: BuildPayload, deps: WatchPlanDeps): WatchPlan {
  const steps: ProgramWatchStep[] = [];
  const names = freeTextNames(build, deps);
  for (const s of build.steps) {
    if (s.kind === "rest") {
      const prev = steps.at(-1);
      if (prev) prev.restSeconds = Math.min(MAX_REST_SECONDS, prev.restSeconds + Math.max(0, Math.round(s.seconds)));
      continue;
    }
    if (!s.exerciseId) continue;
    const record = build.exercises[s.exerciseId];
    if (!record) continue;
    const key = deps.keyOf(s.exerciseId);
    const originId = key ? deps.catalogIdByKey.get(key) : undefined;
    const free = originId ? null : names.get(s.exerciseId)!;
    for (const side of sidesOf(s, record)) {
      steps.push({
        originId: originId ?? FREE_TEXT_ORIGIN_ID,
        name: originId ? key! : free!.name,
        target: targetOf(s),
        grams: s.target?.w ? Math.round(toKg(s.target.w) * 1000) : null,
        restSeconds: 0,
        overview: overviewOf(side, free?.qualifier ?? null, record.text.focus[0]),
        side: side === "Left" ? "left" : side === "Right" ? "right" : null,
      });
    }
  }
  const refusal: WatchRefusal | null =
    steps.length === 0 ? "empty" : steps.length > WATCH_MAX_STEPS ? "too_long" : null;
  return { steps, freeText: steps.filter((s) => s.originId === FREE_TEXT_ORIGIN_ID).length, refusal };
}

/**
 * `<program name> — <date>`, at most WATCH_STAMP_MAX characters and WATCH_STAMP_MAX_BYTES bytes (ruling 3-R5):
 * the name cut to fit, then " (2)", " (3)" while `taken` holds the stamp — two
 * sessions of one day, or a coach session of the same title, each get their own.
 */
export function programStamp(programName: string, date: string, taken: ReadonlySet<string>): string {
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : ` (${n})`;
    const room = WATCH_STAMP_MAX - STAMP_SEPARATOR.length - date.length - suffix.length;
    const roomBytes = WATCH_STAMP_MAX_BYTES - utf8.encode(`${STAMP_SEPARATOR}${date}${suffix}`).length;
    const stamp = `${stampName(cutAtWord(programName, room, roomBytes), date)}${suffix}`;
    if (!taken.has(stamp)) return stamp;
  }
}

// ── The service part ─────────────────────────────────────────────────────────────────────────────────────────

type WorkoutRow = typeof plannedWorkouts.$inferSelect;

/** An unpush job's id for a build (`unpush:<buildId>`): taking the same copy off twice is one job. */
export const unpushJobId = (buildId: string): string => `unpush:${buildId}`;

/** A sent build that was taken off says when in its payload, as an un-started one does (`$.unstartedAt`). */
export const UNSENT_AT_PATH = "$.unsentAt";

export type WatchUnavailable =
  | "not_today"
  | "not_built"
  | "done"
  | "precheck"
  | "writes_off"
  | "not_connected"
  | "too_long"
  | "empty"
  /** An unpush of this build is queued or running: Send waits for it (a re-send would be a silent no-op). */
  | "taking_off";

export interface WatchState {
  state: "unavailable" | "ready" | "sending" | "on_watch" | "failed" | "off_watch";
  reason?: WatchUnavailable;
}

export interface WatchPreviewDto {
  buildId: string;
  stamp: string;
  /** Each step as the watch shows it, read off the wire program; `load` is the weight in the athlete's unit. */
  steps: Array<ProgramPreviewStep & { load: Weight | null }>;
  freeText: number;
  refusal: WatchRefusal | null;
}

/** Send (or its preview) is not offered now; `reason` is the sheet's word for why. */
export class WatchUnavailableError extends Error {
  constructor(public readonly reason: WatchUnavailable) {
    super(reason);
  }
}

const IN_FLIGHT = ["queued", "claimed", "in_progress", "verifying"] as const;
const isInFlight = (status: string): boolean => (IN_FLIGHT as readonly string[]).includes(status);

async function jobById(db: Db, id: string) {
  const [job] = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, id)).limit(1);
  return job ?? null;
}

/** A COROS connection the lane could write through (`corosClient`'s own refusals, without the login). */
async function corosConnected(db: Db, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: providerConnections.status, lastErrorCategory: providerConnections.lastErrorCategory })
    .from(providerConnections)
    .where(and(eq(providerConnections.userId, userId), eq(providerConnections.provider, "coros")))
    .limit(1);
  if (!row || row.status === "disconnected") return false;
  return !(row.status === "error" && row.lastErrorCategory === "bad_credentials");
}

/** The catalog's T-code → the athlete's catalog id; a T-code the catalog holds twice maps to neither. */
export function catalogIdsByKey(catalog: ReadonlyMap<string, string>): Map<string, string> {
  const seen = new Map<string, string | null>();
  for (const [id, name] of catalog) {
    const key = name.trim();
    seen.set(key, seen.has(key) ? null : id);
  }
  return new Map([...seen].filter((e): e is [string, string] => e[1] !== null));
}

/** The athlete's catalog, and the deps `watchStepsFromBuild` resolves moves with. */
async function planDeps(db: Db): Promise<{ catalog: Map<string, string>; deps: WatchPlanDeps }> {
  const catalog = await exerciseNameMap(db);
  return { catalog, deps: { catalogIdByKey: catalogIdsByKey(catalog), keyOf: (id) => corosKeyOf(id) } };
}

/** The step count does not depend on the catalog, so a refusal needs no catalog read. */
const NO_CATALOG: WatchPlanDeps = { catalogIdByKey: new Map(), keyOf: () => null };

/**
 * Why Send is not offered for this slot now, or null when it is (ruling 3-R2: Start's preconditions — today, the
 * current build, the pre-check answered, not done — plus COROS writes on and connected; then nothing of this build
 * may be on its way off the watch, and the build must fit the watch).
 */
async function unavailableReason(
  db: Db,
  userId: string,
  row: WorkoutRow,
  session: SessionResponse,
  prefs: Pick<UserPreferences, "corosWritesEnabled">,
  today: string,
): Promise<WatchUnavailable | null> {
  if (!prefs.corosWritesEnabled) return "writes_off";
  if (!(await corosConnected(db, userId))) return "not_connected";
  if (row.effectiveDate !== today) return "not_today";
  if (row.contentState === "done" || row.completionState === "completed") return "done";
  const build = session.build;
  if (!build || build.version === 0 || build.date !== row.effectiveDate || (row.contentState !== "built" && row.contentState !== "started")) {
    return "not_built";
  }
  if (session.profiles.some((p) => !session.checks[p.profileId])) return "precheck";
  const unpush = await jobById(db, unpushJobId(build.buildId));
  if (unpush && isInFlight(unpush.status)) return "taking_off";
  return watchStepsFromBuild(build, NO_CATALOG).refusal;
}

/**
 * What the sheet shows about the watch. A sent build: its push queued or running → `sending`; failed → `failed`;
 * verified with the copy's address on the row → `on_watch`, without one (removed in COROS) → `off_watch`. Not sent:
 * `ready`, or `unavailable` with the reason. Asked only while the switch is on (the routes answer null otherwise).
 */
export async function watchStateOf(
  db: Db,
  env: Env,
  userId: string,
  row: WorkoutRow,
  session: SessionResponse,
  prefs: UserPreferences,
): Promise<WatchState> {
  if (!watchPushEnabled(env)) return { state: "unavailable", reason: "writes_off" };
  const sent = await sentBuildIdOf(db, row.id);
  if (sent) {
    const push = await jobById(db, pushJobId(sent));
    if (push && isInFlight(push.status)) return { state: "sending" };
    if (push?.status === "verified") return { state: watchAddressOf(row) ? "on_watch" : "off_watch" };
    if (push) return { state: "failed" };
  }
  const reason = await unavailableReason(db, userId, row, session, prefs, todayOf(prefs));
  return reason ? { state: "unavailable", reason } : { state: "ready" };
}

const todayOf = (prefs: UserPreferences): string => todayInZone(prefs.timezone);

/** The program's name: what the stamp is made of (the slot's title carries the theme too). */
async function programNameOf(db: Db, row: WorkoutRow): Promise<string> {
  const [program] = await db.select({ name: programs.name }).from(programs).where(eq(programs.id, row.planId)).limit(1);
  return program?.name?.trim() || row.title;
}

/** Every stamp this account has put (or is putting) on COROS for `date`, but `exceptJobId`'s own. */
async function takenStamps(db: Db, userId: string, date: string, exceptJobId: string): Promise<Set<string>> {
  const rows = await db
    .select({ payload: corosWriteJobs.payload })
    .from(corosWriteJobs)
    .where(
      and(
        eq(corosWriteJobs.userId, userId),
        inArray(corosWriteJobs.kind, [...STAMPING_JOB_KINDS]),
        ne(corosWriteJobs.id, exceptJobId),
        sql`json_extract(${corosWriteJobs.payload}, '$.happenDay') = ${date}`,
      ),
    );
  return new Set(rows.map((r) => (r.payload as { name?: unknown } | null)?.name).filter((n): n is string => typeof n === "string"));
}

/** The push's payload for a build on its slot's day: the resolved steps and the day's free stamp. */
async function pushPayloadFor(db: Db, userId: string, row: WorkoutRow, build: BuildPayload): Promise<{ payload: ProgramSessionPushJob; plan: WatchPlan; catalog: Map<string, string> }> {
  const { catalog, deps } = await planDeps(db);
  const plan = watchStepsFromBuild(build, deps);
  const stamp = programStamp(await programNameOf(db, row), row.effectiveDate, await takenStamps(db, userId, row.effectiveDate, pushJobId(build.buildId)));
  const payload = {
    workoutId: row.id,
    buildId: build.buildId,
    happenDay: row.effectiveDate,
    name: stamp,
    session: { kind: "program_watch" as const, title: row.title, steps: plan.steps },
  };
  return { payload, plan, catalog };
}

/** A grams figure in the athlete's unit, the preview's second figure (the watch shows the kg). */
function loadOf(grams: number | null, unit: UserPreferences["weightUnit"]): Weight | null {
  if (grams === null) return null;
  return { v: weightInUnit({ v: grams / 1000, u: "kg" }, unit), u: unit };
}

/**
 * `GET /api/sessions/:workoutId/watch-preview`: the steps as the watch will hold them, read off the very program the
 * push would write (the preview IS the wire), and the stamp it would carry. A sent build previews what was sent. A
 * build the watch cannot take says why in `refusal`, with no steps. Throws `SessionNotFoundError`,
 * `WatchUnavailableError` (Send would be refused for that reason).
 */
export async function watchPreview(db: Db, env: Env, userId: string, workoutId: string, ctx: BuildCtx): Promise<WatchPreviewDto> {
  const row = await loadSlot(db, userId, workoutId);
  const session = await loadSession(db, userId, workoutId, ctx.today);
  const sent = await sentBuildIdOf(db, row.id);
  let payload: ProgramSessionPushJob;
  let catalog: Map<string, string>;
  let refusal: WatchRefusal | null;
  let freeText: number;
  const pushed = sent ? await jobById(db, pushJobId(sent)) : null;
  const parsed = pushed ? programSessionPushJobSchema.safeParse(pushed.payload) : null;
  if (parsed?.success) {
    payload = parsed.data;
    catalog = await exerciseNameMap(db);
    refusal = null;
    freeText = payload.session.steps.filter((s) => s.originId === FREE_TEXT_ORIGIN_ID).length;
  } else {
    const reason = await unavailableReason(db, userId, row, session, ctx.prefs, ctx.today);
    if (reason && reason !== "too_long" && reason !== "empty") throw new WatchUnavailableError(reason);
    const made = await pushPayloadFor(db, userId, row, session.build!);
    ({ payload, catalog } = made);
    refusal = made.plan.refusal;
    freeText = made.plan.freeText;
  }
  if (refusal) return { buildId: payload.buildId, stamp: payload.name, steps: [], freeText, refusal };
  const program = buildProgramWatchProgram(
    { happenDay: String(localDateToCorosDay(payload.happenDay)), name: payload.name, session: payload.session },
    catalog,
  );
  const steps = previewOfProgram(program, (key) => COROS_EXERCISE_NAMES[key]).map((s) => ({ ...s, load: loadOf(s.grams, ctx.prefs.weightUnit) }));
  return { buildId: payload.buildId, stamp: payload.name, steps, freeText, refusal: null };
}

/**
 * `POST /api/sessions/:workoutId/send-to-watch` `{buildId}`: lock the build as Start does (it must still be the day's
 * current build; `content_state` stays `built`) and queue `push:<buildId>` (spec §4.3). A second send while the push
 * is queued, running or verified is a no-op; a failed or superseded one is queued afresh. Throws
 * `SessionNotFoundError`, `WatchUnavailableError`, `StaleBuildError` (with the fresh session), `NotTodayError`,
 * `NotBuiltError`. The caller runs the lane.
 */
export async function sendToWatch(
  db: Db,
  env: Env,
  userId: string,
  workoutId: string,
  buildId: string,
  ctx: BuildCtx,
): Promise<SessionResponse> {
  if (!watchPushEnabled(env)) throw new WatchUnavailableError("writes_off");
  const row = await loadSlot(db, userId, workoutId);
  let session = await loadSession(db, userId, workoutId, ctx.today);
  const sent = await sentBuildIdOf(db, row.id);
  if (sent) {
    if (sent !== buildId) throw new StaleBuildError(session, false);
    const push = await jobById(db, pushJobId(sent));
    // Queued, running, or done: nothing to send. Only a failed push is sent again (Retry).
    if (push && push.status !== "failed" && push.status !== "needs_attention") return session;
  }
  const reason = await unavailableReason(db, userId, row, session, ctx.prefs, ctx.today);
  if (reason) throw new WatchUnavailableError(reason);
  if (!sent) {
    if (session.locked) {
      // Started in the app (or locked otherwise): the locked build is the one the watch gets.
      if (session.build?.buildId !== buildId) throw new StaleBuildError(session, false);
    } else {
      session = (await lockCurrentBuild(db, userId, workoutId, buildId, ctx.now, { as: "send" })).session;
    }
  }
  const build = session.build!;
  const { payload } = await pushPayloadFor(db, userId, row, build);
  const valid = programSessionPushJobSchema.parse(payload);
  const id = pushJobId(build.buildId);
  const inserted = await db
    .insert(corosWriteJobs)
    .values({
      id,
      userId,
      workoutId: row.id,
      kind: "program_session_push",
      expectedContentFingerprint: build.inputsHash,
      originalDate: row.effectiveDate,
      destinationDate: row.effectiveDate,
      payload: valid as unknown as Record<string, unknown>,
      requestedAt: ctx.now,
      status: "queued",
      updatedAt: ctx.now,
    })
    .onConflictDoNothing()
    .returning({ id: corosWriteJobs.id });
  if (inserted.length === 0) {
    // The build was sent before: a failed push, or one whose copy was taken off (superseded). Queued afresh — new
    // steps and stamp from today's catalog, the retry count reset, the old observation gone.
    await db
      .update(corosWriteJobs)
      .set({
        status: "queued",
        claimedByDeviceId: null,
        claimedAt: null,
        verifiedAt: null,
        completedAt: null,
        lastErrorCategory: null,
        lastErrorDetail: null,
        payload: valid as unknown as Record<string, unknown>,
        requestedAt: ctx.now,
        updatedAt: ctx.now,
      })
      .where(and(eq(corosWriteJobs.id, id), inArray(corosWriteJobs.status, ["failed", "needs_attention", "superseded", "cancelled"])));
  }
  return loadSession(db, userId, workoutId, ctx.today);
}

/**
 * Take a sent build's copy off the watch, or stop it reaching it (spec §4.4): a queued push is superseded; a pushed
 * copy (a verified push, the row holding its address) gets `unpush:<buildId>`, the stamp-proven delete, with the
 * stamp from the push's own payload; a push still running is left to the lane, which queues the unpush as soon as it
 * verifies. The build is unlocked at once (`$.unsentAt`): a moved slot must build on its new day. A started or done
 * slot keeps its lock (Start owns it). Unpushes run whatever the switch says (ruling 3-R10); none is queued while the
 * athlete's COROS writes are off.
 */
export async function unpushBuild(
  db: Db,
  userId: string,
  row: WorkoutRow,
  buildId: string,
  now: string,
  prefs: Pick<UserPreferences, "corosWritesEnabled">,
): Promise<void> {
  const id = pushJobId(buildId);
  await db
    .update(corosWriteJobs)
    .set({ status: "superseded", updatedAt: now })
    .where(and(eq(corosWriteJobs.id, id), eq(corosWriteJobs.status, "queued")));
  const push = await jobById(db, id);
  const address = watchAddressOf(row);
  const parsed = push ? programSessionPushJobSchema.safeParse(push.payload) : null;
  if (prefs.corosWritesEnabled && push?.status === "verified" && address && parsed?.success) {
    await queueUnpush(db, userId, buildId, {
      workoutId: row.id,
      happenDay: address.happenDay,
      name: parsed.data.name,
      idInPlan: address.idInPlan,
      programId: address.programId,
      corosPlanId: address.corosPlanId,
    }, now);
  }
  if (row.contentState === "started" || row.contentState === "done") return;
  await db
    .update(sessionBuilds)
    .set({ lockedAt: null, payload: sql`json_set(${sessionBuilds.payload}, ${UNSENT_AT_PATH}, ${now})` })
    .where(and(eq(sessionBuilds.id, buildId), isNotNull(sessionBuilds.lockedAt)));
}

/** What an unpush of a sent copy carries: the stamp-proven delete triple (`coachDeleteWorkoutJobSchema`). */
export interface ProgramUnpushPayload {
  workoutId: string;
  happenDay: string;
  name: string;
  idInPlan: string;
  programId: string;
  corosPlanId: string;
}

/**
 * Queue `unpush:<buildId>` — a `coach_delete_workout`, so it runs whatever the switch says (ruling 3-R10) — or, when
 * that copy was taken off before and the build sent again since, queue the settled one afresh for this copy. A live
 * one is left as it is. The caller has checked the athlete's COROS writes are on.
 */
export async function queueUnpush(db: Db, userId: string, buildId: string, payload: ProgramUnpushPayload, now: string): Promise<void> {
  const id = unpushJobId(buildId);
  const inserted = await db
    .insert(corosWriteJobs)
    .values({
      id,
      userId,
      workoutId: payload.workoutId,
      kind: "coach_delete_workout",
      expectedContentFingerprint: "",
      originalDate: payload.happenDay,
      destinationDate: payload.happenDay,
      payload: { ...payload },
      requestedAt: now,
      status: "queued",
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: corosWriteJobs.id });
  if (inserted.length > 0) return;
  await db
    .update(corosWriteJobs)
    .set({
      status: "queued",
      claimedByDeviceId: null,
      claimedAt: null,
      verifiedAt: null,
      completedAt: null,
      lastErrorCategory: null,
      lastErrorDetail: null,
      payload: { ...payload },
      originalDate: payload.happenDay,
      destinationDate: payload.happenDay,
      requestedAt: now,
      updatedAt: now,
    })
    .where(and(eq(corosWriteJobs.id, id), inArray(corosWriteJobs.status, ["verified", "failed", "superseded", "cancelled", "needs_attention"])));
}

/** Supersede a queued push, queue `unpush:<buildId>` for a pushed one, unlock the sent build (json_set `$.unsentAt`). */
export async function enqueueProgramUnpush(
  db: Db,
  userId: string,
  row: WorkoutRow,
  now: string,
  prefs: Pick<UserPreferences, "corosWritesEnabled">,
): Promise<void> {
  const sent = await sentBuildIdOf(db, row.id);
  if (sent) await unpushBuild(db, userId, row, sent, now, prefs);
}

/** `POST /api/sessions/:workoutId/take-off-watch`: `enqueueProgramUnpush` for the slot; a no-op when nothing was sent. */
export async function takeOffWatch(db: Db, userId: string, workoutId: string, ctx: BuildCtx): Promise<SessionResponse> {
  const row = await loadSlot(db, userId, workoutId);
  await enqueueProgramUnpush(db, userId, row, ctx.now, ctx.prefs);
  return loadSession(db, userId, workoutId, ctx.today);
}
