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
  canonicalJson,
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
import { sha256Hex } from "../auth/crypto.js";
import type { Db } from "./db.js";
import { corosKeyOf } from "./coros-exercise-map.js";
import { freeStamp, STAMP_SEPARATOR, stampName, takenStampsOn } from "./coros-stamp.js";
import { exerciseNameMap } from "./exercise-catalog.js";
import {
  loadSession,
  loadSlot,
  lockCurrentBuild,
  pushJobId,
  RestoringError,
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
const graphemes = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/** How a library name sets a variant apart ("Child's pose · forehead on block"), and how an overview joins its parts. */
const QUALIFIER = " · ";
/** A word a cut name must not end on: "Child's pose · forehead on" reads as a sentence cut off. */
const DANGLING_WORD = /\s+(?:a|an|and|at|by|for|from|in|of|on|or|the|to|under|with)$/iu;
const TRAILING_SEPARATOR = /[\s·,;:—–-]+$/u;

/**
 * `text` as the characters a reader sees — grapheme clusters (workerd and Node segment them), else code points — so a
 * cut between two of them never leaves half an emoji, a lone surrogate or a dangling joiner (audit W-3, lane L-6).
 */
function charactersOf(text: string): string[] {
  return graphemes ? Array.from(graphemes.segment(text), (s) => s.segment) : Array.from(text);
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
  const cut = (space > 0 ? hard.slice(0, space) : hard).replace(TRAILING_SEPARATOR, "");
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
  // The one chooser both lanes use (ruling 3-R12): only the name's cut is the program lane's own.
  return freeStamp((suffix) => {
    const room = WATCH_STAMP_MAX - STAMP_SEPARATOR.length - date.length - suffix.length;
    const roomBytes = WATCH_STAMP_MAX_BYTES - utf8.encode(`${STAMP_SEPARATOR}${date}${suffix}`).length;
    return `${stampName(cutAtWord(programName, room, roomBytes), date)}${suffix}`;
  }, taken);
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
  /**
   * The digest of the payload this preview rendered (`pushDigest`). Send carries it back: a payload that would differ
   * is refused 409 `stale_preview` with the fresh preview (audit W-2 / W-8), so what is sent is what was shown.
   */
  digest: string;
}

/** Send (or its preview) is not offered now; `reason` is the sheet's word for why. */
export class WatchUnavailableError extends Error {
  constructor(public readonly reason: WatchUnavailable) {
    super(reason);
  }
}

/**
 * Send named a preview whose payload is not the one it would queue now (another session took the stamp, the catalog
 * synced, the build's steps resolve differently): nothing is written, and `preview` is the fresh one to show.
 */
export class StalePreviewError extends Error {
  constructor(public readonly preview: WatchPreviewDto) {
    super("stale_preview");
  }
}

/**
 * THE DIGEST OF WHAT A PUSH WRITES: its payload without the lane's own bookkeeping (`attempts`, `observed`), as
 * canonical JSON, SHA-256. The preview answers it and Send compares it, so the two are one payload or Send refuses.
 */
export async function pushDigest(payload: ProgramSessionPushJob): Promise<string> {
  const { workoutId, buildId, happenDay, name, session } = payload;
  return sha256Hex(canonicalJson({ workoutId, buildId, happenDay, name, session }));
}

/**
 * The catalog a sent payload was resolved against, made from the payload itself: each catalog step's id → the T-code
 * it carries. A sent push previews against this, never the live catalog — a row COROS re-keyed since must not break
 * (or change) the preview of what was sent (audit W-2).
 */
function ownCatalog(payload: ProgramSessionPushJob): Map<string, string> {
  return new Map(payload.session.steps.filter((s) => s.originId !== FREE_TEXT_ORIGIN_ID).map((s) => [s.originId, s.name]));
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
  return (
    (await slotRefusal(db, userId, row, prefs, today)) ??
    (await buildRefusal(db, row, session.build, session.profiles.map((p) => p.profileId), session.checks))
  );
}

/** The refusals the slot itself answers — writes, the connection, the day, done — before any build is read. */
async function slotRefusal(
  db: Db,
  userId: string,
  row: WorkoutRow,
  prefs: Pick<UserPreferences, "corosWritesEnabled">,
  today: string,
): Promise<WatchUnavailable | null> {
  if (!prefs.corosWritesEnabled) return "writes_off";
  if (!(await corosConnected(db, userId))) return "not_connected";
  if (row.effectiveDate !== today) return "not_today";
  if (row.contentState === "done" || row.completionState === "completed") return "done";
  return null;
}

/** The refusals the build answers: current and built for the day, the pre-check answered, nothing coming off, fits. */
async function buildRefusal(
  db: Db,
  row: WorkoutRow,
  build: BuildPayload | null,
  profiles: readonly string[],
  checks: Readonly<Record<string, unknown>>,
): Promise<WatchUnavailable | null> {
  if (!build || build.version === 0 || build.date !== row.effectiveDate || (row.contentState !== "built" && row.contentState !== "started")) {
    return "not_built";
  }
  if (profiles.some((p) => !checks[p])) return "precheck";
  const unpush = await jobById(db, unpushJobId(build.buildId));
  if (unpush && isInFlight(unpush.status)) return "taking_off";
  return watchStepsFromBuild(build, NO_CATALOG).refusal;
}

/** The sheet's state for a push just read: the row decides between on and off the watch for a verified one. */
function stateOfPush(status: string, row: WorkoutRow): WatchState {
  if (isInFlight(status)) return { state: "sending" };
  if (status === "verified") return { state: watchAddressOf(row) ? "on_watch" : "off_watch" };
  return { state: "failed" };
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
    if (push) return stateOfPush(push.status, row);
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

/**
 * The push's payload for a build on its slot's day: the steps resolved against today's catalog, and the stamp.
 *
 * THE STAMP IS FIXED AT THE BUILD'S FIRST SEND (audit W-8, U-3). A failed or restored push may have landed a copy
 * unrecorded, under its stamp; Retry must carry that very stamp, so the lane's `already_present` finds the copy
 * instead of writing a second one under a new name (a program renamed since would otherwise change it). So a build
 * whose push was queued before keeps that push's stamp for its day — unless another session holds it now (only a
 * push that was taken off or never ran gives its stamp up); then, as at a first Send, the day's free stamp.
 */
async function pushPayloadFor(db: Db, userId: string, row: WorkoutRow, build: BuildPayload): Promise<{ payload: ProgramSessionPushJob; plan: WatchPlan; catalog: Map<string, string> }> {
  const { catalog, deps } = await planDeps(db);
  const plan = watchStepsFromBuild(build, deps);
  const taken = await takenStampsOn(db, userId, row.effectiveDate, { jobId: pushJobId(build.buildId) });
  const earlier = await jobById(db, pushJobId(build.buildId));
  const prior = earlier ? programSessionPushJobSchema.safeParse(earlier.payload) : null;
  const fixed = prior?.success && prior.data.happenDay === row.effectiveDate && !taken.has(prior.data.name) ? prior.data.name : null;
  const stamp = fixed ?? programStamp(await programNameOf(db, row), row.effectiveDate, taken);
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

/** A payload's preview: read off the very program the push would write (the preview IS the wire), with its digest. */
async function previewOf(
  payload: ProgramSessionPushJob,
  catalog: Map<string, string>,
  refusal: WatchRefusal | null,
  unit: UserPreferences["weightUnit"],
): Promise<WatchPreviewDto> {
  const freeText = payload.session.steps.filter((s) => s.originId === FREE_TEXT_ORIGIN_ID).length;
  const head = { buildId: payload.buildId, stamp: payload.name, freeText, digest: await pushDigest(payload) };
  if (refusal) return { ...head, steps: [], refusal };
  const program = buildProgramWatchProgram(
    { happenDay: String(localDateToCorosDay(payload.happenDay)), name: payload.name, session: payload.session },
    catalog,
  );
  const steps = previewOfProgram(program, (key) => COROS_EXERCISE_NAMES[key]).map((s) => ({ ...s, load: loadOf(s.grams, unit) }));
  return { ...head, steps, refusal: null };
}

/**
 * `GET /api/sessions/:workoutId/watch-preview`: the steps as the watch will hold them, read off the very program the
 * push would write (the preview IS the wire), the stamp it would carry, and the digest Send carries back. A build the
 * watch cannot take says why in `refusal`, with no steps. Throws `SessionNotFoundError`, `WatchUnavailableError`
 * (Send would be refused for that reason).
 *
 * WHICH PAYLOAD (audit W-2 / W-8). A push queued, running or verified previews its own payload, against a catalog
 * made from that payload (`ownCatalog`): it is what was sent, whatever the catalog says now. Any other build — not
 * sent, or its push failed (Retry) or settled (sent again) — previews exactly the payload Send would queue now, so
 * Retry with this preview's digest is never refused.
 */
export async function watchPreview(db: Db, env: Env, userId: string, workoutId: string, ctx: BuildCtx): Promise<WatchPreviewDto> {
  const row = await loadSlot(db, userId, workoutId);
  const session = await loadSession(db, userId, workoutId, ctx.today);
  const sent = await sentBuildIdOf(db, row.id);
  const pushed = sent ? await jobById(db, pushJobId(sent)) : null;
  const own = pushed && (isInFlight(pushed.status) || pushed.status === "verified") ? programSessionPushJobSchema.safeParse(pushed.payload) : null;
  if (own?.success) return previewOf(own.data, ownCatalog(own.data), null, ctx.prefs.weightUnit);
  const reason = await unavailableReason(db, userId, row, session, ctx.prefs, ctx.today);
  if (reason && reason !== "too_long" && reason !== "empty") throw new WatchUnavailableError(reason);
  const made = await pushPayloadFor(db, userId, row, session.build!);
  return previewOf(made.payload, made.catalog, made.plan.refusal, ctx.prefs.weightUnit);
}

/**
 * `POST /api/sessions/:workoutId/send-to-watch` `{buildId}`: lock the build as Start does (it must still be the day's
 * current build; `content_state` stays `built`) and queue `push:<buildId>` (spec §4.3). A second send while the push
 * is queued, running or verified is a no-op; a failed or superseded one is queued afresh. Throws
 * `SessionNotFoundError`, `WatchUnavailableError`, `StaleBuildError` (with the fresh session), `NotTodayError`,
 * `NotBuiltError`, `RestoringError`, `StalePreviewError`. The answer carries its `watch` state.
 *
 * NO LANE RUNS HERE, and the shape is Start's (ruling 3-R11, the Workers Free budget): the slot is read once, the
 * build is checked and locked by `lockCurrentBuild` (its session is the answer), and the payload is made before the
 * lock so that every refusal writes nothing. The client then asks for the push in a request of its own
 * (`POST /api/sessions/watch/drain`); the hourly lane is the fallback.
 *
 * THE PREVIEW IS WHAT IS SENT (audit W-2 / W-8): `opts.digest` is the digest of the preview the athlete saw (the
 * route requires it). The payload made here must have that digest, else `StalePreviewError` with the fresh preview,
 * before anything is written. A no-op Send (the push already queued, running or verified) checks nothing.
 */
export async function sendToWatch(
  db: Db,
  env: Env,
  userId: string,
  workoutId: string,
  buildId: string,
  ctx: BuildCtx,
  opts: { digest?: string } = {},
): Promise<SessionResponse> {
  if (!watchPushEnabled(env)) throw new WatchUnavailableError("writes_off");
  const row = await loadSlot(db, userId, workoutId);
  const sent = await sentBuildIdOf(db, row.id);
  if (sent) {
    const push = await jobById(db, pushJobId(sent));
    // Queued, running, or done: nothing to send. Only a failed push is sent again (Retry).
    if (push && push.status !== "failed" && push.status !== "needs_attention") {
      const session = await loadSession(db, userId, workoutId, ctx.today);
      if (sent !== buildId) throw new StaleBuildError(session, false);
      return { ...session, watch: stateOfPush(push.status, row) };
    }
  }
  const reason = await slotRefusal(db, userId, row, ctx.prefs, ctx.today);
  if (reason) throw new WatchUnavailableError(reason);

  let payload: ProgramSessionPushJob | null = null;
  /** Send's preconditions on the build it would send, then the payload — all before anything is written. */
  const prepare = async (slot: WorkoutRow, build: BuildPayload | null, profiles: readonly string[], checks: Readonly<Record<string, unknown>>) => {
    const refusal = await buildRefusal(db, slot, build, profiles, checks);
    if (refusal) throw new WatchUnavailableError(refusal);
    const made = await pushPayloadFor(db, userId, slot, build!);
    if (opts.digest !== undefined && (await pushDigest(made.payload)) !== opts.digest) {
      throw new StalePreviewError(await previewOf(made.payload, made.catalog, made.plan.refusal, ctx.prefs.weightUnit));
    }
    payload = made.payload;
  };
  let session: SessionResponse;
  if (sent) {
    // Retry: the sent build is locked, and it is the one the watch gets.
    session = await loadSession(db, userId, workoutId, ctx.today);
    if (sent !== buildId) throw new StaleBuildError(session, false);
    await prepare(row, session.build, session.profiles.map((p) => p.profileId), session.checks);
  } else {
    const locked = await lockCurrentBuild(db, userId, workoutId, buildId, ctx.now, {
      as: "send",
      prefs: ctx.prefs,
      beforeLock: (v) => prepare(v.row, v.build, v.profiles, v.checks),
    });
    session = locked.session;
    if (!locked.lockedNow) {
      // Locked before (started in the app): that build is the one the watch gets — or a restore began meanwhile.
      if (!session.locked) throw new RestoringError();
      if (session.build?.buildId !== buildId) throw new StaleBuildError(session, false);
      await prepare(row, session.build, session.profiles.map((p) => p.profileId), session.checks);
    }
  }
  const build = session.build!;
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
  // The session `lockCurrentBuild` answered with is the slot as it now stands; the push just queued is `sending`.
  return { ...session, watch: { state: "sending" } };
}

/**
 * Take a sent build's copy off the watch, or stop it reaching it (spec §4.4): a queued push is superseded; a pushed
 * copy (a verified push, the row holding its address) gets `unpush:<buildId>`, the stamp-proven delete, with the
 * stamp from the push's own payload; a push still running is left to the lane, which queues the unpush as soon as it
 * verifies. The build is unlocked at once (`$.unsentAt`): a moved slot must build on its new day. A started or done
 * slot keeps its lock (Start owns it). Unpushes run whatever the switch says (ruling 3-R10).
 *
 * AN UNPUSH OWED WHILE THE ATHLETE'S COROS WRITES ARE OFF (audit 3-A life L-10) is not queued — nothing writes to
 * their COROS then — and not forgotten either: it is recorded on the sent build (`$.unpushOwedAt`), which stays
 * locked so the copy stays accounted for (the push stays the slot's, its stamp recognised), and `runOwedUnpushes`
 * queues it when writes come back on. Before, the copy was stranded on the old day for good.
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
  if (push?.status === "verified" && address && parsed?.success) {
    if (!prefs.corosWritesEnabled) {
      await db
        .update(sessionBuilds)
        .set({ payload: sql`json_set(${sessionBuilds.payload}, ${UNPUSH_OWED_AT_PATH}, ${now})` })
        .where(and(eq(sessionBuilds.id, buildId), isNotNull(sessionBuilds.lockedAt)));
      return;
    }
    await queueUnpush(db, userId, buildId, {
      workoutId: row.id,
      happenDay: address.happenDay,
      name: parsed.data.name,
      idInPlan: address.idInPlan,
      programId: address.programId,
      corosPlanId: address.corosPlanId,
    }, now);
  }
  await unlockSentBuild(db, row, buildId, now);
}

/** The sent build unlocked (`$.unsentAt`), so the slot builds again — unless it is started or done (Start owns it). */
export async function unlockSentBuild(db: Db, row: Pick<WorkoutRow, "contentState">, buildId: string, now: string): Promise<void> {
  if (row.contentState === "started" || row.contentState === "done") return;
  await db
    .update(sessionBuilds)
    .set({ lockedAt: null, payload: sql`json_set(${sessionBuilds.payload}, ${UNSENT_AT_PATH}, ${now})` })
    .where(and(eq(sessionBuilds.id, buildId), isNotNull(sessionBuilds.lockedAt)));
}

/** A sent build whose copy's unpush is owed — recorded while the athlete's COROS writes were off (`unpushBuild`). */
export const UNPUSH_OWED_AT_PATH = "$.unpushOwedAt";

/**
 * STRANDED-COPY CLEANUP (audit 3-A life L-10): the unpushes owed while the athlete's COROS writes were off, queued
 * now that they are on — each through `unpushBuild` again (its copy re-read: a copy gone since queues nothing), and
 * each owed once. Run by the catch-up pass when writes are turned on (`emitPendingWork`). One read when nothing is owed.
 */
export async function runOwedUnpushes(db: Db, userId: string, now: string): Promise<number> {
  const owed = await db
    .select({ id: sessionBuilds.id, workoutId: sessionBuilds.workoutId })
    .from(sessionBuilds)
    .where(
      and(
        eq(sessionBuilds.userId, userId),
        isNotNull(sessionBuilds.lockedAt),
        sql`json_extract(${sessionBuilds.payload}, ${UNPUSH_OWED_AT_PATH}) is not null`,
      ),
    );
  for (const build of owed) {
    await db
      .update(sessionBuilds)
      .set({ payload: sql`json_remove(${sessionBuilds.payload}, ${UNPUSH_OWED_AT_PATH})` })
      .where(eq(sessionBuilds.id, build.id));
    const [row] = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, build.workoutId)).limit(1);
    if (row) await unpushBuild(db, userId, row, build.id, now, { corosWritesEnabled: true });
  }
  return owed.length;
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
