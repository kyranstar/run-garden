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
 *    move's set with no side) becomes such a Left/Right pair (audit W-1). A
 *    step with a side carries it in its NAME too, " (L)" / " (R)" (owner,
 *    2026-10-10: the watch's step screen shows no overview).
 *  - A two-sided move whose T-code (`corosKeyOf`, ruling 3-R1) the athlete's
 *    catalog holds goes as that catalog step; every other move goes as free
 *    text on `originId "0"` (spike outcome A), its name cut at a word to 30
 *    characters (ruling 3-R6) so the preview stays exact if COROS has a limit.
 *    A one-sided move the catalog holds is free text under the catalog's
 *    English name, so its steps can carry the side (owner, 2026-10-10).
 *  - Weights in grams (kg × 1000, the wire's only unit); none is bodyweight.
 *  - A rest adds onto the step before it (at most 900 s); a leading rest has no
 *    step to hang on and is dropped.
 */
import { and, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { corosWriteJobs, plannedWorkouts, programs, providerConnections, sessionBuilds } from "@rg/database";
import {
  canonicalJson,
  docOriginRow,
  parseStoredWorkoutDoc,
  programSessionPushJobSchema,
  STAMPING_JOB_KINDS,
  todayInZone,
  toKg,
  watchAddressOf,
  weightInUnit,
  WATCH_MAX_STEPS,
  WATCH_NAME_MAX,
  WATCH_OVERVIEW_MAX,
  WATCH_SIDE_LABEL,
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
import { libraryFor, loadAccountLibrary, PUBLIC_LIBRARY } from "./account-library.js";
import { corosKeyOf } from "./coros-exercise-map.js";
import { freeStamp, STAMP_SEPARATOR, stampName, takenStampsOn } from "./coros-stamp.js";
import { adoptedCopyUnpush, enqueueUnpushIfOurs } from "./plan-mutations.js";
import { markMirrorOwed, resolveMirrorOwed } from "./mirror-owed.js";
import { dayRowRefusal, rowRefusal } from "./mirror-rules.js";
import { WATCH_JOB_UNDERWAY, watchJobCondition } from "./watch-jobs.js";
import { exerciseNameMap } from "./exercise-catalog.js";
import { dayValidateCtx, snapshotErrors } from "./doc-build.js";
import {
  activeProfilesOf,
  checksAnswered,
  loadSession,
  loadSlot,
  lockCurrentBuild,
  provisionalRecord,
  PROVISIONAL_KIND_PATH,
  pushJobId,
  RestoringError,
  sentBuildIdOf,
  slotChecks,
  StaleBuildError,
  type BuildCtx,
  type BuildPayload,
  type CheckAnswer,
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

/**
 * What the watch steps are read from: a build's steps and its moves' records. A stored build is one; so are the
 * steps a workout document plays (`watchStepsFromDoc`, watch-doc.ts).
 */
export type WatchBuild = Pick<BuildPayload, "steps" | "exercises">;

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
  // THE FIRST CHARACTER ALONE IS WIDER THAN THE ROOM (re-review C-1a: a ZWJ family emoji is one 25-byte character):
  // the cut would be empty. It is dropped and the rest cut instead — empty only when nothing at all fits.
  if (hard === "") return chars.length > 1 ? cutAtWord(chars.slice(1).join(""), max, maxBytes) : "";
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
 * A free-text move's name as the watch shows it, at most `max` characters — WATCH_NAME_MAX, or less to leave a one-sided
 * move's step room for its side label (ruling 3-R6, audit W-6). A longer "<move> · <qualifier>" goes as the move, its
 * qualifier leading the overview; any other long name is cut at a word, never ending on a word like "on" or "with".
 */
export function watchNameOf(libraryName: string, max: number = WATCH_NAME_MAX): { name: string; qualifier: string | null } {
  const t = libraryName.trim();
  if (t.length <= max) return { name: t, qualifier: null };
  const at = t.indexOf(QUALIFIER);
  const head = at > 0 ? t.slice(0, at).trim() : "";
  if (head && head.length <= max) return { name: head, qualifier: t.slice(at + QUALIFIER.length).trim() || null };
  let name = cutAtWord(t, max);
  while (DANGLING_WORD.test(name)) name = name.replace(DANGLING_WORD, "").replace(TRAILING_SEPARATOR, "");
  return { name, qualifier: null };
}

/** The room a one-sided move's name leaves for its side label (" (L)" / " (R)"). */
const SIDE_LABEL_ROOM = Math.max(WATCH_SIDE_LABEL.left.length, WATCH_SIDE_LABEL.right.length);

/** A watch step's side label: " (L)", " (R)", or none for a step of no side. */
const sideLabel = (side: Step["side"]): string => (side === "Left" ? WATCH_SIDE_LABEL.left : side === "Right" ? WATCH_SIDE_LABEL.right : "");

/**
 * Each free-text move's watch name — before its side label — and qualifier. Two different moves never share a watch
 * name within one program (audit W-6): a name a catalog step of the session already shows (its English name), or an
 * earlier free-text move holds (by first appearance in the build), gets " (2)", " (3)", cut to fit. The names are made
 * unique BEFORE the labels go on, so "X (L)" of one move and "X (L)" of another never meet. A one-sided move's name
 * (`sided`) is cut to leave its label room, so name and label stay within WATCH_NAME_MAX. The same build gives the
 * same names.
 */
function freeTextNames(build: WatchBuild, deps: WatchPlanDeps, sided: ReadonlySet<string>): Map<string, { name: string; qualifier: string | null }> {
  const moves = [...new Set(build.steps.flatMap((s) => (s.kind !== "rest" && s.exerciseId && build.exercises[s.exerciseId] ? [s.exerciseId] : [])))];
  const taken = new Set(
    moves.flatMap((id) => {
      const catalog = catalogStepOf(id, deps, sided);
      return catalog ? [(COROS_EXERCISE_NAMES[catalog.key] ?? catalog.key).toLowerCase()] : [];
    }),
  );
  const out = new Map<string, { name: string; qualifier: string | null }>();
  for (const id of moves) {
    if (catalogStepOf(id, deps, sided)) continue;
    const room = sided.has(id) ? WATCH_NAME_MAX - SIDE_LABEL_ROOM : WATCH_NAME_MAX;
    const { name, qualifier } = watchNameOf(freeTextNameOf(id, build.exercises[id]!, deps), room);
    let unique = name;
    for (let n = 2; taken.has(unique.toLowerCase()); n++) unique = `${cutAtWord(name, room - ` (${n})`.length)} (${n})`;
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

type BuildRecord = BuildPayload["exercises"][string];

/** One stop of the build's walk to the watch: a rest, or one watch step — its build step, move and side. */
type WalkStop = { rest: number } | { rest?: undefined; step: Step; exerciseId: string; record: BuildRecord; side: Step["side"] };

/**
 * THE ONE WALK from a build's steps to the watch's: a rest as it comes, each work step of a move the build carries as
 * one watch step per side (`sidesOf`), in order. The steps (`watchStepsFromBuild`), the one-sided moves and each
 * step's move (`watchStepMoves`) are all read off it, so a payload's step i is always `watchStepMoves`' move i.
 */
function* walkToWatch(build: WatchBuild): Generator<WalkStop> {
  for (const s of build.steps) {
    if (s.kind === "rest") {
      yield { rest: s.seconds };
      continue;
    }
    if (!s.exerciseId) continue;
    const record = build.exercises[s.exerciseId];
    if (!record) continue;
    for (const side of sidesOf(s, record)) yield { step: s, exerciseId: s.exerciseId, record, side };
  }
}

/**
 * The move each of the build's watch steps is of, in the order `watchStepsFromBuild` lays them out: a payload sent
 * for this build has step i of move i — whatever the builder of the day it was sent made of it (the review reads what
 * each move went as off the push's own payload, owner 2026-10-10).
 */
export function watchStepMoves(build: WatchBuild): string[] {
  return [...walkToWatch(build)].flatMap((w) => (w.rest === undefined ? [w.exerciseId] : []));
}

/** The build's moves any of whose watch steps has a side: their steps' names carry the side label. */
function sidedMoves(build: WatchBuild): Set<string> {
  const out = new Set<string>();
  for (const w of walkToWatch(build)) if (w.rest === undefined && w.side !== null) out.add(w.exerciseId);
  return out;
}

/**
 * The catalog step a move goes to the watch as, or null for free text. A move whose T-code (`corosKeyOf`, ruling 3-R1)
 * the athlete's catalog holds goes as that catalog step — unless it is one-sided (`sided`; owner, 2026-10-10): a
 * catalog step's name is COROS's own and cannot carry the side, so a one-sided move goes as free text.
 */
function catalogStepOf(exerciseId: string, deps: WatchPlanDeps, sided: ReadonlySet<string>): { key: string; originId: string } | null {
  if (sided.has(exerciseId)) return null;
  const key = deps.keyOf(exerciseId);
  const originId = key ? deps.catalogIdByKey.get(key) : undefined;
  return key && originId ? { key, originId } : null;
}

/**
 * A free-text move's name before any cut: for a move the athlete's catalog holds (a one-sided one, see
 * `catalogStepOf`) the catalog's English name — what the watch would have shown it as — else the library's.
 */
function freeTextNameOf(exerciseId: string, record: { name: string }, deps: WatchPlanDeps): string {
  const key = deps.keyOf(exerciseId);
  return (key && deps.catalogIdByKey.has(key) && COROS_EXERCISE_NAMES[key]) || record.name;
}

/** The build's steps as the watch will hold them. Pure: the same build gives the same steps. */
export function watchStepsFromBuild(build: WatchBuild, deps: WatchPlanDeps): WatchPlan {
  const steps: ProgramWatchStep[] = [];
  const sided = sidedMoves(build);
  const names = freeTextNames(build, deps, sided);
  for (const w of walkToWatch(build)) {
    if (w.rest !== undefined) {
      const prev = steps.at(-1);
      if (prev) prev.restSeconds = Math.min(MAX_REST_SECONDS, prev.restSeconds + Math.max(0, Math.round(w.rest)));
      continue;
    }
    const { step: s, record, side } = w;
    const catalog = catalogStepOf(w.exerciseId, deps, sided);
    const free = catalog ? null : names.get(w.exerciseId)!;
    steps.push({
      originId: catalog?.originId ?? FREE_TEXT_ORIGIN_ID,
      name: catalog ? catalog.key : `${free!.name}${sideLabel(side)}`,
      target: targetOf(s),
      grams: s.target?.w ? Math.round(toKg(s.target.w) * 1000) : null,
      restSeconds: 0,
      overview: overviewOf(side, free?.qualifier ?? null, record.text.focus[0]),
      side: side === "Left" ? "left" : side === "Right" ? "right" : null,
    });
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
    // Never a nameless " — <date>" (re-review C-1a): COROS may trim the leading space, and then the stamp it hands
    // back matches nothing the lane or the import looks for.
    return `${stampName(cutAtWord(programName, room, roomBytes) || NAMELESS_PROGRAM, date)}${suffix}`;
  }, taken);
}

/** The stamp's name when not one character of the program's fits (a name of emoji wider than the room). */
const NAMELESS_PROGRAM = "Program";

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
  | "taking_off"
  /**
   * Send's 409 only (audit 3-A L-7 / L-9): this build's copy is on the watch already — taken off, but its removal
   * failed or a restore neutralised it — so there is nothing Send could queue. The sheet shows it on the watch, with
   * Take off.
   */
  | "already_sent"
  /**
   * A document workout (Stage 2 spec §10) whose build holds a move the day's reading keeps out: a locked build cannot
   * swap it, so it is never sent — on a first Send, a Retry, or a Send after Start. Rebuilt (taken off, or discarded),
   * the day's build swaps in an alternate where one passes.
   */
  | "gated";

/**
 * THE SHEET'S WATCH LINE (the watch mirrors the plan §3.9): a status, never a Send.
 *  - `kept_off`: the athlete keeps it off (`watch_off`, §3.6) — "Kept off your watch", with Put on.
 *  - `updating`: the watch is being brought in step with it — a delete of its copy on its way, a push replacing a copy
 *    the row holds, or nothing on the watch yet while the mirror owes it one (the drain or the sweep makes it).
 *  - `sending`: its copy going on where there was none (a first push, a Retry).
 *  - `failed`: the push failed; the sweep re-queues it on its backoff, and Retry re-queues it now.
 *  - `closed_by_check`: today's reading keeps a move out that no alternate stands in for — the day's build cannot go.
 *  - `on_watch`: its copy is on the watch; `off_watch`: removed in the COROS app (a session the mirror does not hold now).
 *  - `unavailable`: not on the watch, and why (`reason`); `ready`: nothing on it and nothing owed (no reason to give).
 */
export interface WatchState {
  state: "unavailable" | "ready" | "sending" | "on_watch" | "failed" | "off_watch" | "updating" | "kept_off" | "closed_by_check";
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

/**
 * Push statuses Send queues afresh: a failed one (Retry), one whose copy was taken off or that never ran, and one a
 * restore neutralised (audit 3-A L-7 / L-9) — the athlete's Send is the new act a restored job waits for. (Every
 * `SETTLED_PUSH` status, spelled out: this module sits on an import cycle with session-build.ts, whose constants
 * may not be initialised yet when this one is.)
 */
const REQUEUEABLE_PUSH = ["failed", "needs_attention", "superseded", "cancelled", "restored"] as const;

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

/**
 * The athlete's catalog, and the deps `watchStepsFromBuild` resolves moves with — `corosKeyOf` in the account's library
 * when the build holds one of the athlete's own moves (`libraryFor`: one statement then). A move is looked up by its own
 * id: one of the athlete's own moves has no T-code, so it goes as free text by its own name — and so does any id the
 * library doesn't hold by its own id (an old or merged one; a build's moves are their current ids).
 */
async function planDeps(db: Db, userId: string, build: WatchBuild): Promise<{ catalog: Map<string, string>; deps: WatchPlanDeps }> {
  const [catalog, library] = await Promise.all([exerciseNameMap(db), libraryFor(db, userId, Object.keys(build.exercises))]);
  const all = library === PUBLIC_LIBRARY ? undefined : library.all;
  return { catalog, deps: { catalogIdByKey: catalogIdsByKey(catalog), keyOf: (id) => corosKeyOf(id, all) } };
}

/** The step count does not depend on the catalog, so a refusal needs no catalog read. */
export const NO_CATALOG: WatchPlanDeps = { catalogIdByKey: new Map(), keyOf: () => null };

/**
 * THE STEPS `build` WOULD GO TO THE WATCH AS, resolved as `sent` was (the watch mirrors the plan §3.3): against the
 * catalog the sent payload itself carries (`ownCatalog`: each catalog step's id → its T-code), the moves keyed in the
 * account's library — so they compare with `sent.session.steps` step for step, and with no catalog read (`libraryFor`:
 * one statement only for a build holding one of the athlete's own moves, and none when this request has read it).
 */
export async function watchStepsAsSent(db: Db, userId: string, build: WatchBuild, sent: ProgramSessionPushJob): Promise<WatchPlan> {
  const library = await libraryFor(db, userId, Object.keys(build.exercises));
  const all = library === PUBLIC_LIBRARY ? undefined : library.all;
  return watchStepsFromBuild(build, { catalogIdByKey: catalogIdsByKey(ownCatalog(sent)), keyOf: (id) => corosKeyOf(id, all) });
}

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

/**
 * The refusals the build answers: current and built for the day, the pre-check answered, nothing coming off, fits —
 * and a document workout's build re-gated with the day's reading (`gatedSnapshot`), whichever Send this is. Never a
 * preview (version 0) nor a provisional copy's record (a negative version): the athlete's Send is the day's build's, on
 * its day; a provisional copy goes to the watch by the mirror's own path.
 */
async function buildRefusal(
  db: Db,
  row: WorkoutRow,
  build: BuildPayload | null,
  profiles: readonly string[],
  checks: Readonly<Record<string, CheckAnswer>>,
): Promise<WatchUnavailable | null> {
  if (!build || build.version <= 0 || build.date !== row.effectiveDate || (row.contentState !== "built" && row.contentState !== "started")) {
    return "not_built";
  }
  if (!checksAnswered(profiles, checks)) return "precheck";
  if (docOriginRow(row) && (await gatedSnapshot(db, row, build.buildId, profiles, checks))) return "gated";
  const unpush = await jobById(db, unpushJobId(build.buildId));
  if (unpush && isInFlight(unpush.status)) return "taking_off";
  return watchStepsFromBuild(build, NO_CATALOG).refusal;
}

/**
 * A document build the day keeps a move of: its snapshot (`session_builds.workout_doc`, what the watch would hold —
 * a blocked build's blocked move included) judged with the day's reading, as Start judges a build already on the
 * watch — so a build sent at a calm reading is refused a Retry, or a Send after Start, once the reading has risen.
 */
async function gatedSnapshot(
  db: Db,
  row: WorkoutRow,
  buildId: string,
  profiles: readonly string[],
  checks: Readonly<Record<string, CheckAnswer>>,
): Promise<boolean> {
  const [[stored], library] = await Promise.all([
    db.select({ doc: sessionBuilds.workoutDoc }).from(sessionBuilds).where(eq(sessionBuilds.id, buildId)).limit(1),
    loadAccountLibrary(db, row.userId),
  ]);
  const snapshot = parseStoredWorkoutDoc(stored?.doc ?? null);
  if (!snapshot) return false;
  return snapshotErrors(snapshot, dayValidateCtx({ library: library.all, offered: library.offered, profiles, checks, date: row.effectiveDate, today: row.effectiveDate })).length > 0;
}

/**
 * A document workout's queued push, judged as the lane claims it: its build's snapshot with the day's reading now
 * (`gatedSnapshot`, as Send, Retry and Start judge it) — the reading can rise between the tap and the lane's run. Never
 * an engine build's: a locked engine build plays as built wherever it is judged (Send, Retry, Start), so there is no
 * gate of its own to re-check.
 */
export async function gatedAtClaim(db: Db, userId: string, row: WorkoutRow, buildId: string, today: string): Promise<boolean> {
  if (!docOriginRow(row)) return false;
  const profiles = await activeProfilesOf(db, userId);
  const checks = await slotChecks(db, userId, row.id, row.effectiveDate, today, profiles);
  return gatedSnapshot(db, row, buildId, profiles, checks);
}

/** The sheet's state for a push just read: the row decides between on and off the watch for a verified one. */
function stateOfPush(status: string, row: WorkoutRow): WatchState {
  if (isInFlight(status)) return { state: "sending" };
  if (status === "verified") return { state: watchAddressOf(row) ? "on_watch" : "off_watch" };
  return { state: "failed" };
}

/**
 * A COPY LEFT ON THE WATCH (audit 3-A L-7 / L-9): the build was sent and taken off — so it is unlocked, and no longer
 * "sent" — but its removal did not go through: the unpush failed for good, or a restore neutralised it. Its push is
 * still verified and no unpush of it is on its way. Returns that push, or null.
 */
async function copyLeftOnWatch(db: Db, buildId: string) {
  const push = await jobById(db, pushJobId(buildId));
  if (push?.status !== "verified") return null;
  const unpush = await jobById(db, unpushJobId(buildId));
  return unpush && isInFlight(unpush.status) ? null : push;
}

/**
 * The row's watch jobs on their way (`watchJobCondition`, `WATCH_JOB_UNDERWAY`): a program push (a provisional copy's
 * too) or a copy's delete (`unpush:<buildId>`, an adopted row's `<id>-unpush-copy`). ONE read.
 */
async function watchJobsUnderway(db: Db, userId: string, workoutId: string): Promise<Array<{ id: string; kind: string }>> {
  return db
    .select({ id: corosWriteJobs.id, kind: corosWriteJobs.kind })
    .from(corosWriteJobs)
    .where(
      and(
        eq(corosWriteJobs.userId, userId),
        eq(corosWriteJobs.workoutId, workoutId),
        inArray(corosWriteJobs.status, [...WATCH_JOB_UNDERWAY]),
        watchJobCondition(),
      ),
    );
}

/** Today's day build shown, blocked by the day's reading (`fromDoc.blocked`): it cannot go to the watch (§3.3). */
const blockedToday = (row: WorkoutRow, session: SessionResponse, today: string): boolean => {
  const b = session.build;
  return !!b && b.version > 0 && b.date === today && row.effectiveDate === today && (b.fromDoc?.blocked.length ?? 0) > 0;
};

/** Send's refusal as the sheet says it: a move the day's reading keeps out is the day's check closing it. */
const unavailable = (reason: WatchUnavailable): WatchState => (reason === "gated" ? { state: "closed_by_check" } : { state: "unavailable", reason });

/**
 * WHAT THE SHEET SAYS ABOUT THE WATCH (the watch mirrors the plan §3.9), in order:
 *  1. kept off (`watch_off`) → `kept_off` (a done session's copy stays, and is said as it is);
 *  2. a watch job of the row on its way (one read) → a delete, or a push replacing the copy the row holds: `updating`;
 *     a push where the row holds none: `sending`;
 *  3. the sent build (`sentBuildIdOf`): its push failed → `failed` (Retry) — unless the day's reading has closed what it
 *     holds, which Retry would refuse: `closed_by_check`, or Retry's own reason in Retry's order; verified → today's day
 *     build blocked by the reading: `closed_by_check`; else the row holding the copy's address: `on_watch`; without one
 *     (removed in COROS): `updating` for a document workout the mirror holds (it puts the copy back, §3.8), else
 *     `off_watch`.
 *     Nothing sent, but the shown build's copy left on the watch (`copyLeftOnWatch`): as its verified push;
 *  4. nothing on the watch, nothing on its way: Send's own refusal where one stands (`unavailable` with the reason; a move
 *     the reading keeps out: `closed_by_check`) — except what a provisional copy does not wait on (its day, the day's
 *     build, the day's check: `OWED_ANYWAY`, M1), which is owed (`updating`) unless the copy would not fit the watch —
 *     else `updating` while the mirror holds the session (it owes the copy: the drain, the sweep, or the day's next build
 *     makes it), else `ready`.
 * Asked only while the switch is on (the routes answer null otherwise).
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
  const today = todayOf(prefs);
  const done = row.contentState === "done" || row.completionState === "completed";
  if (row.watchOff && !done) return { state: "kept_off" };
  const underway = await watchJobsUnderway(db, userId, row.id);
  if (underway.some((j) => j.kind !== "program_session_push")) return { state: "updating" };
  if (underway.length > 0) return { state: watchAddressOf(row) ? "updating" : "sending" };
  const rules = { today, prefs };
  // The mirror puts this session on ahead of its day (a document workout in the window: its provisional copy), or holds
  // its day's build on it today.
  const provisional = rowRefusal(row, env, rules) === null;
  const holds = provisional || dayRowRefusal(row, env, rules) === null;
  const sent = await sentBuildIdOf(db, row.id);
  if (sent) {
    const push = await jobById(db, pushJobId(sent));
    // A document workout's failed push is offered Retry only while the day still allows what it holds: a reading
    // that has since closed one of its moves makes it unavailable, for the reason Retry itself would give — Retry's own
    // checks in Retry's order (the slot's, then the build's, the gate among them), so the two never disagree.
    const retry = push !== null && !isInFlight(push.status) && push.status !== "verified";
    if (retry && docOriginRow(row) && (await gatedSnapshot(db, row, sent, session.profiles.map((p) => p.profileId), session.checks))) {
      return unavailable((await unavailableReason(db, userId, row, session, prefs, today)) ?? "gated");
    }
    if (push?.status === "verified") return onTheWatch(row, session, today, provisional);
    if (push) return stateOfPush(push.status, row);
  } else if (session.build && (await copyLeftOnWatch(db, session.build.buildId))) {
    return onTheWatch(row, session, today, provisional);
  }
  const reason = await unavailableReason(db, userId, row, session, prefs, today);
  // A document workout the mirror puts on as a provisional copy waits for no day, no day's build and no check (M1: with
  // no answer yet, the provisional copy goes): it is owed — unless the copy itself would not fit, as the shown build
  // (the preview a day ahead, materialised as the copy is) says.
  if (reason && provisional && OWED_ANYWAY.includes(reason)) {
    const fits = session.build ? watchStepsFromBuild(session.build, NO_CATALOG).refusal : null;
    return fits ? unavailable(fits) : { state: "updating" };
  }
  if (reason) return unavailable(reason);
  return holds ? { state: "updating" } : { state: "ready" };
}

/** Send's refusals a provisional copy does not wait on: its day, the day's build, the day's check (§3.2, M1). */
const OWED_ANYWAY: readonly WatchUnavailable[] = ["not_today", "not_built", "precheck"];

/**
 * A copy on the watch (a verified push): the day's check closing today's build, the copy there, or gone from it — put
 * back by the mirror for a document workout it holds (`putsBack`: the sweep's re-push, §3.8; today's day build by the
 * build commit or the hourly), so `updating`; an engine slot's copy is not put back (as the import leaves it): `off_watch`.
 */
function onTheWatch(row: WorkoutRow, session: SessionResponse, today: string, putsBack: boolean): WatchState {
  if (blockedToday(row, session, today)) return { state: "closed_by_check" };
  if (watchAddressOf(row)) return { state: "on_watch" };
  return putsBack ? { state: "updating" } : { state: "off_watch" };
}

const todayOf = (prefs: UserPreferences): string => todayInZone(prefs.timezone);

/**
 * What the stamp is made of: the program's name (the slot's title carries the theme too) — for a document workout its
 * own title, the one the athlete gave it (its programme is only the account's Studio bucket).
 */
async function programNameOf(db: Db, row: WorkoutRow): Promise<string> {
  if (docOriginRow(row)) return row.title.trim();
  const [program] = await db.select({ name: programs.name }).from(programs).where(eq(programs.id, row.planId)).limit(1);
  return program?.name?.trim() || row.title;
}

/** What a push is made from: a build's id, its steps and moves — a day's build, or a provisional copy's record. */
export type PushableBuild = WatchBuild & Pick<BuildPayload, "buildId">;

/**
 * The push's payload for a build on its slot's day: the steps resolved against today's catalog, and the stamp.
 *
 * THE STAMP IS FIXED AT THE BUILD'S FIRST SEND (audit W-8, U-3). A failed or restored push may have landed a copy
 * unrecorded, under its stamp; Retry must carry that very stamp, so the lane's `already_present` finds the copy
 * instead of writing a second one under a new name (a program renamed since would otherwise change it). So a build
 * whose push was queued before keeps that push's stamp for its day — unless another session holds it now (only a
 * push that was taken off or never ran gives its stamp up); then, as at a first Send, the day's free stamp.
 *
 * `opts.taken` is the day's taken stamps when the caller has read them (the mirror reads them with its own jobs read);
 * `opts.provisional` and `opts.fromDocRev` mark a mirror push (watch mirrors the plan §3.2): a provisional copy, and the
 * document revision the build was made from, which the mirror's current-copy test reads off the job.
 */
export async function pushPayloadFor(
  db: Db,
  userId: string,
  row: WorkoutRow,
  build: PushableBuild,
  /** The build's push as the caller read it (null: none); read here when not given. */
  known?: Awaited<ReturnType<typeof jobById>>,
  opts: { taken?: ReadonlySet<string>; provisional?: boolean; fromDocRev?: number | null } = {},
): Promise<{ payload: ProgramSessionPushJob; plan: WatchPlan; catalog: Map<string, string> }> {
  const { catalog, deps } = await planDeps(db, userId, build);
  const plan = watchStepsFromBuild(build, deps);
  const taken = opts.taken ?? (await takenStampsOn(db, userId, row.effectiveDate, { jobId: pushJobId(build.buildId) }));
  const earlier = known !== undefined ? known : await jobById(db, pushJobId(build.buildId));
  const prior = earlier ? programSessionPushJobSchema.safeParse(earlier.payload) : null;
  const fixed = prior?.success && prior.data.happenDay === row.effectiveDate && !taken.has(prior.data.name) ? prior.data.name : null;
  const stamp = fixed ?? programStamp(await programNameOf(db, row), row.effectiveDate, taken);
  const payload: ProgramSessionPushJob = {
    workoutId: row.id,
    buildId: build.buildId,
    happenDay: row.effectiveDate,
    name: stamp,
    session: { kind: "program_watch" as const, title: row.title, steps: plan.steps },
    ...(opts.provisional ? { provisional: true } : {}),
    ...(typeof opts.fromDocRev === "number" ? { fromDocRev: opts.fromDocRev } : {}),
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
  if (refusal === "too_long") {
    // NO WIRE PROGRAM CAN HOLD IT (more than WATCH_MAX_STEPS), so nothing is built and nothing can be sent — but the
    // preview still lists every step as the watch would have had it (owner call 8, 2026-10-08: "Too long for the
    // watch" takes Send's place at the preview's foot, under the steps). Each step reads as `previewOfProgram` reads
    // it off a wire program: a catalog step by its English name, a free-text one by its own.
    const steps = payload.session.steps.map((s) => {
      const free = s.originId === FREE_TEXT_ORIGIN_ID;
      return {
        name: free ? s.name : (COROS_EXERCISE_NAMES[s.name] ?? s.name),
        freeText: free,
        target: s.target,
        grams: s.grams,
        overview: s.overview,
        restSeconds: s.restSeconds,
        load: loadOf(s.grams, unit),
      };
    });
    return { ...head, steps, refusal };
  }
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
 * watch cannot take says why in `refusal`: too long, with its steps still listed; empty, with none. Throws `SessionNotFoundError`, `WatchUnavailableError`
 * (Send would be refused for that reason).
 *
 * WHICH PAYLOAD (audit W-2 / W-8). A push queued, running or verified previews its own payload, against a catalog
 * made from that payload (`ownCatalog`): it is what was sent, whatever the catalog says now — the sent build's, or
 * the shown build's when it was taken off while its push ran (Send keeps that push) or its copy was left on the
 * watch. Any other build — not sent, or its push failed (Retry) or settled (sent again) — previews exactly the
 * payload Send would queue now, so Retry with this preview's digest is never refused.
 */
export async function watchPreview(db: Db, env: Env, userId: string, workoutId: string, ctx: BuildCtx): Promise<WatchPreviewDto> {
  const row = await loadSlot(db, userId, workoutId);
  const session = await loadSession(db, userId, workoutId, ctx.today);
  const sent = (await sentBuildIdOf(db, row.id)) ?? session.build?.buildId;
  const pushed = sent ? await jobById(db, pushJobId(sent)) : null;
  const own = pushed && (isInFlight(pushed.status) || pushed.status === "verified") ? programSessionPushJobSchema.safeParse(pushed.payload) : null;
  if (own?.success) return previewOf(own.data, ownCatalog(own.data), null, ctx.prefs.weightUnit);
  const reason = await unavailableReason(db, userId, row, session, ctx.prefs, ctx.today);
  if (reason && reason !== "too_long" && reason !== "empty") throw new WatchUnavailableError(reason);
  const made = await pushPayloadFor(db, userId, row, session.build!, sent === session.build!.buildId ? pushed : undefined);
  return previewOf(made.payload, made.catalog, made.plan.refusal, ctx.prefs.weightUnit);
}

/**
 * `POST /api/sessions/:workoutId/send-to-watch` `{buildId}`: lock the build as Start does (it must still be the day's
 * current build; `content_state` stays `built`) and queue `push:<buildId>` (spec §4.3). A second send while the push
 * is queued, running or verified is a no-op; a failed, superseded or restored one is queued afresh; a build whose
 * copy was left on the watch (`copyLeftOnWatch`) is refused `already_sent` — Send never answers 200 for nothing. Throws
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
 *
 * A SESSION KEPT OFF (`watch_off`, §3.6) is put back on by Send, as by Put on: the mark is cleared before the push is
 * queued (one statement more, only for such a row).
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

  /** The payload to queue; null when the build's push is still running and is what reaches the watch. */
  let payload: ProgramSessionPushJob | null = null;
  /** Send's preconditions on the build it would send, then the payload — all before anything is written. */
  const prepare = async (slot: WorkoutRow, build: BuildPayload | null, profiles: readonly string[], checks: Readonly<Record<string, CheckAnswer>>) => {
    const refusal = await buildRefusal(db, slot, build, profiles, checks);
    if (refusal) throw new WatchUnavailableError(refusal);
    const earlier = await jobById(db, pushJobId(build!.buildId));
    // NOTHING TO QUEUE IS A 409, NEVER A SILENT 200 (audit 3-A L-7 / L-9): this build's copy is on the watch already
    // (taken off, but its removal failed or a restore neutralised it). Take off is what the sheet offers for it.
    if (earlier?.status === "verified") throw new WatchUnavailableError("already_sent");
    const running = earlier && isInFlight(earlier.status) ? programSessionPushJobSchema.safeParse(earlier.payload) : null;
    if (running?.success) {
      // Taken off while its push ran, and sent again: that push is what reaches the watch (the lane keeps its copy
      // once the build is locked again), so it is what the preview showed, and nothing new is queued.
      if (opts.digest !== undefined && (await pushDigest(running.data)) !== opts.digest) {
        throw new StalePreviewError(await previewOf(running.data, ownCatalog(running.data), null, ctx.prefs.weightUnit));
      }
      payload = null;
      return;
    }
    // The revision the build was made from (a document's; none for an engine build): the mirror's current-copy test
    // reads it off the job, a day's push as a provisional one (mirror.ts `currentCopy`). The digest does not cover it.
    const made = await pushPayloadFor(db, userId, slot, build!, earlier, { fromDocRev: build!.fromDoc?.rev ?? null });
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
  const id = pushJobId(build.buildId);
  // AN EXPLICIT SEND PUTS IT ON THE WATCH (the watch mirrors the plan §3.6): a session kept off (`watch_off`) is the
  // athlete's to have on the watch again — cleared before the push is queued (or the push still running is kept), so
  // the lane's claim does not drop it and its verify does not take the copy off (coros-write-cloud.ts). After every
  // refusal above, so a refused Send writes nothing here. One statement, only for a row kept off; Retry likewise.
  if (row.watchOff) {
    await db
      .update(plannedWorkouts)
      .set({ watchOff: false, updatedAt: ctx.now })
      .where(and(eq(plannedWorkouts.id, row.id), eq(plannedWorkouts.userId, userId)));
  }
  if (payload === null) return { ...session, watch: { state: "sending" } };
  const valid = programSessionPushJobSchema.parse(payload);
  // SEND REPLACES AN ADOPTED WORKOUT'S OLD COPY (workout-editability spec §4): a coach session or a COROS-plan session a
  // revise took over keeps the copy the watch held of it (`watch_copy_name`). Its stamp-checked delete is queued first,
  // in this request — one statement, only for such a row — so the lane, which runs a user's jobs in request order
  // under one lock, takes it off as the new build goes on. The app's targeted drain takes the push first
  // (`claimNextJob`'s `watchOnly`): the new build then goes on at once, and the old copy comes off in the drain's next
  // request (or the lane's next pass), addressed by its own payload (the row by then holds the new copy's address); the
  // row reads older on watch until it has. Writes are on here (`slotRefusal`), so the delete is always queued.
  const copy = adoptedCopyUnpush(db, userId, row, ctx.now, ctx.prefs);
  if (copy) await copy.insert;
  if (!(await queuePushJob(db, userId, row, build.buildId, build.inputsHash, valid, ctx.now))) {
    // Neither inserted nor queued afresh — another request changed the push since `prepare` read it. "Sending" is
    // the answer only while that push is on its way; anything else is a 409, never a silent 200.
    const push = await jobById(db, id);
    if (!push || !isInFlight(push.status)) throw new WatchUnavailableError("already_sent");
  }
  // The session `lockCurrentBuild` answered with is the slot as it now stands; the push just queued is `sending`.
  return { ...session, watch: { state: "sending" } };
}

/** A failed push the athlete's Retry queues again: failed for good, or left needing attention. */
const RETRYABLE_PUSH = ["failed", "needs_attention"] as const;

/**
 * RETRY (the watch mirrors the plan §3.9, M6): the session's failed push queued again now, with no digest — the sweep's
 * backoff (MIRROR_RETRY_BACKOFF_MS) not waited out. `POST /api/sessions/:workoutId/retry-watch`.
 *  - A PROVISIONAL COPY's push (the sent build is its record — ahead of the day, or today's before the day's build): the
 *    same job re-queued, its payload and stamp kept (a failed push may have landed a copy under that stamp, which the
 *    lane's `already_present` then finds), the executor's tries and the mirror's re-queues reset: this is the athlete's
 *    new act. Never a Send of the day's build (that was `StaleBuildError` every time: the sent build is not the one the
 *    sheet shows). Refused as the mirror refuses the row (`rowRefusal`): writes off or the switch off → `writes_off`,
 *    resolved → `done`, a day gone → `not_today`; COROS not connected → `not_connected`.
 *  - A DAY BUILD's push: Send's Retry (`sendToWatch` on the sent build): the payload made again, re-gated by the day's
 *    reading, the stamp kept.
 *  - Nothing failed (nothing sent, or its push on its way or verified): the session as it stands; nothing written.
 * No lane runs here (ruling 3-R11): the client follows up with the drain. Throws as Send does.
 *
 * Statements, the provisional path: the slot, the sent build (two), its push, the connection, the re-queue (one UPDATE),
 * then the session — and the route's watch state.
 */
export async function retryWatch(db: Db, env: Env, userId: string, workoutId: string, ctx: BuildCtx): Promise<SessionResponse> {
  if (!watchPushEnabled(env)) throw new WatchUnavailableError("writes_off");
  const row = await loadSlot(db, userId, workoutId);
  const sent = await sentBuildIdOf(db, row.id);
  const push = sent ? await jobById(db, pushJobId(sent)) : null;
  if (!sent || !push || !(RETRYABLE_PUSH as readonly string[]).includes(push.status)) return loadSession(db, userId, workoutId, ctx.today);
  const parsed = programSessionPushJobSchema.safeParse(push.payload);
  if (!parsed.success || parsed.data.provisional !== true) return sendToWatch(db, env, userId, workoutId, sent, ctx);
  const refused = rowRefusal(row, env, ctx);
  if (refused === "switch_off" || refused === "writes_off") throw new WatchUnavailableError("writes_off");
  if (refused === "resolved") throw new WatchUnavailableError("done");
  if (refused === "past" || refused === "beyond_window") throw new WatchUnavailableError("not_today");
  // Kept off (Put on is the way back) or no longer a document workout: nothing to retry.
  if (refused) return loadSession(db, userId, workoutId, ctx.today);
  if (!(await corosConnected(db, userId))) throw new WatchUnavailableError("not_connected");
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
      payload: sql`json_remove(${corosWriteJobs.payload}, '$.attempts', '$.mirrorRetries')`,
      requestedAt: ctx.now,
      updatedAt: ctx.now,
    })
    .where(and(eq(corosWriteJobs.id, push.id), inArray(corosWriteJobs.status, [...RETRYABLE_PUSH])));
  return loadSession(db, userId, workoutId, ctx.today);
}

/**
 * Queue `push:<buildId>` with `payload` (already parsed by `programSessionPushJobSchema`): inserted — or, when the build
 * was sent before (a failed push, one whose copy was taken off, one a restore neutralised), queued afresh: the steps
 * from today's catalog, the stamp the payload carries, the retry count reset, the old observation gone. True when the
 * push is now queued by this call; false when it was neither (another request holds it: in flight or verified). One
 * statement, two when the build was sent before. Send's and the mirror's one writer of a program push.
 */
export async function queuePushJob(
  db: Db,
  userId: string,
  row: Pick<WorkoutRow, "id" | "effectiveDate">,
  buildId: string,
  inputsHash: string,
  payload: ProgramSessionPushJob,
  now: string,
): Promise<boolean> {
  const id = pushJobId(buildId);
  const inserted = await db
    .insert(corosWriteJobs)
    .values({
      id,
      userId,
      workoutId: row.id,
      kind: "program_session_push",
      expectedContentFingerprint: inputsHash,
      originalDate: row.effectiveDate,
      destinationDate: row.effectiveDate,
      payload: payload as unknown as Record<string, unknown>,
      requestedAt: now,
      status: "queued",
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: corosWriteJobs.id });
  if (inserted.length > 0) return true;
  const requeued = await db
    .update(corosWriteJobs)
    .set({
      status: "queued",
      claimedByDeviceId: null,
      claimedAt: null,
      verifiedAt: null,
      completedAt: null,
      lastErrorCategory: null,
      lastErrorDetail: null,
      payload: payload as unknown as Record<string, unknown>,
      requestedAt: now,
      updatedAt: now,
    })
    .where(and(eq(corosWriteJobs.id, id), inArray(corosWriteJobs.status, [...REQUEUEABLE_PUSH])))
    .returning({ id: corosWriteJobs.id });
  return requeued.length > 0;
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
  // A DONE SESSION'S COPY STAYS (audit 3-A life U-1): it is the session the athlete did — the record a watch review
  // pairs with — so nothing takes it off, now or owed.
  const resolved = row.contentState === "done" || row.completionState === "completed";
  if (!resolved && push?.status === "verified" && address && parsed?.success) {
    if (!prefs.corosWritesEnabled) {
      // Owed on the sent build — locked, or a provisional copy's record (the watch mirrors the plan, A1), which keeps
      // its marker as a sent build keeps its lock.
      await db
        .update(sessionBuilds)
        .set({ payload: sql`json_set(${sessionBuilds.payload}, ${UNPUSH_OWED_AT_PATH}, ${now})` })
        .where(and(eq(sessionBuilds.id, buildId), or(isNotNull(sessionBuilds.lockedAt), provisionalRecord())));
      return;
    }
    await queueUnpush(db, userId, buildId, {
      workoutId: row.id,
      happenDay: address.happenDay,
      // A copy the athlete renamed in the COROS app is held under its new name (audit 3-A life L-5): the delete's
      // proof is the name COROS holds at the recorded address.
      name: parsed.data.renamed ?? parsed.data.name,
      idInPlan: address.idInPlan,
      programId: address.programId,
      corosPlanId: address.corosPlanId,
    }, now);
  }
  await unlockSentBuild(db, row, buildId, now);
}

/**
 * The sent build unlocked (`$.unsentAt`), so the slot builds again — unless it is started or done (Start owns it). A
 * provisional copy's record (the watch mirrors the plan, A1) was never locked: it loses its marker instead (`$.kind`),
 * so it is no longer the copy on the watch. One statement either way.
 */
export async function unlockSentBuild(db: Db, row: Pick<WorkoutRow, "contentState">, buildId: string, now: string): Promise<void> {
  if (row.contentState === "started" || row.contentState === "done") return;
  await db
    .update(sessionBuilds)
    .set({
      lockedAt: null,
      payload: sql`case when ${provisionalRecord()} then json_remove(${sessionBuilds.payload}, ${PROVISIONAL_KIND_PATH}) else json_set(${sessionBuilds.payload}, ${UNSENT_AT_PATH}, ${now}) end`,
    })
    .where(and(eq(sessionBuilds.id, buildId), or(isNotNull(sessionBuilds.lockedAt), provisionalRecord())));
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
        // A sent build: locked, or a provisional copy's record (A1).
        or(isNotNull(sessionBuilds.lockedAt), provisionalRecord()),
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
    .where(
      and(
        eq(corosWriteJobs.id, id),
        // `restored` too (audit 3-A L-7): an unpush a restore neutralised removed nothing, and the athlete's Take off
        // is the new act it waits for.
        inArray(corosWriteJobs.status, ["verified", "failed", "superseded", "cancelled", "needs_attention", "restored"]),
      ),
    );
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

/**
 * TAKE OFF, the copy alone: `enqueueProgramUnpush` for the slot — or, with nothing sent, for the shown build's copy
 * left on the watch (`copyLeftOnWatch`: taken off before, but its unpush failed for good or a restore neutralised it),
 * whose removal is queued again (audit 3-A L-7). A no-op when neither holds. No route runs it any more: under the
 * mirror a copy taken off and not kept off is put straight back, so `take-off-watch` answers as Keep off
 * (`keepOffWatch`, which takes the copy off the same way and sets `watch_off`).
 */
export async function takeOffWatch(db: Db, userId: string, workoutId: string, ctx: BuildCtx): Promise<SessionResponse> {
  const row = await loadSlot(db, userId, workoutId);
  const sent = await sentBuildIdOf(db, row.id);
  if (sent) {
    await unpushBuild(db, userId, row, sent, ctx.now, ctx.prefs);
    return loadSession(db, userId, workoutId, ctx.today);
  }
  const session = await loadSession(db, userId, workoutId, ctx.today);
  const shown = session.build?.buildId;
  if (!shown || !(await copyLeftOnWatch(db, shown))) return session;
  // Its build is unlocked already (a locked one with a verified push would be the sent build): the session stands.
  await unpushBuild(db, userId, row, shown, ctx.now, ctx.prefs);
  return session;
}

/** A session whose copy stays as it is — done, or resolved otherwise (skipped, missed): never kept off (§3.6). */
const KEEP_OFF_REFUSED = ["completed", "skipped", "missed"] as const;
const resolvedSlot = (row: Pick<WorkoutRow, "contentState" | "completionState">): boolean =>
  row.contentState === "done" || (KEEP_OFF_REFUSED as readonly string[]).includes(row.completionState);

/**
 * KEEP OFF MY WATCH (the watch mirrors the plan §3.6; builder check A8, M4) — `POST /api/sessions/:workoutId/keep-off-watch`,
 * and for one release `take-off-watch` (an older client's Take off). An app-built session only (`loadSlot`: the coach's
 * sessions keep their own lane, M4). Refused for a session done, or resolved otherwise (`WatchUnavailableError("done")`):
 * a done session's copy is the session the athlete did, and it stays. In order:
 *  1. `watch_off = 1`, which the mirror honours (the sweep, the drain, the lane's claim) — written first, so a push the
 *     lane verifies from here on finds the row kept off and queues the copy's delete itself (coros-write-cloud.ts) — still
 *     not resolved in its own WHERE, the row as written read back;
 *  2. the copy off, as Take off takes it off, from that row: an adopted row's held copy and the sent build's unpush — a
 *     push still queued superseded instead — the build let go (a provisional record's marker cleared, a day build
 *     unlocked), never the address path (`enqueueUnpushIfOurs`, `addressPath: false`); with nothing sent, the shown
 *     build's copy left on the watch has its removal queued again (`copyLeftOnWatch`, as `takeOffWatch`);
 *  3. any other program push of the row still queued superseded and its build let go (the claim would supersede it). A
 *     CLAIMED push is the lane's: its claim finds the row kept off (and its build no longer the sent one) and supersedes
 *     it — or, landed, its verify queues the delete. Never refused `sending`;
 *  4. the row's owed mark resolved (`resolveMirrorOwed`).
 * Put on (`putOnWatch`) clears the mark, and so does an explicit Send (`sendToWatch`, its Retry too) before it queues.
 * With the athlete's COROS writes off the delete is owed on the sent build, as Take off owes it (`unpushBuild`).
 * Idempotent. Statements: the slot, the write, the sent build (two), the delete at its most (held copy, supersede, push
 * read, unpush, unlock: five), the straggler supersede, the mark, then the session.
 */
export async function keepOffWatch(db: Db, userId: string, workoutId: string, ctx: BuildCtx): Promise<SessionResponse> {
  const slot = await loadSlot(db, userId, workoutId);
  if (resolvedSlot(slot)) throw new WatchUnavailableError("done");
  const pw = plannedWorkouts;
  const [row] = await db
    .update(pw)
    .set({ watchOff: true, updatedAt: ctx.now })
    .where(
      and(
        eq(pw.id, slot.id),
        eq(pw.userId, userId),
        or(isNull(pw.contentState), ne(pw.contentState, "done")),
        notInArray(pw.completionState, [...KEEP_OFF_REFUSED]),
      ),
    )
    .returning();
  if (!row) throw new WatchUnavailableError("done");
  const sent = await sentBuildIdOf(db, row.id);
  await enqueueUnpushIfOurs(db, userId, row, ctx.now, ctx.prefs, { sent, addressPath: false });
  const stragglers = await db
    .update(corosWriteJobs)
    .set({ status: "superseded", updatedAt: ctx.now })
    .where(
      and(
        eq(corosWriteJobs.userId, userId),
        eq(corosWriteJobs.workoutId, row.id),
        eq(corosWriteJobs.kind, "program_session_push"),
        eq(corosWriteJobs.status, "queued"),
      ),
    )
    .returning({ id: corosWriteJobs.id });
  for (const j of stragglers) await unlockSentBuild(db, row, j.id.slice(pushJobId("").length), ctx.now);
  await resolveMirrorOwed(db, userId, row.id, ctx.now);
  const session = await loadSession(db, userId, workoutId, ctx.today);
  const shown = session.build?.buildId;
  // Its build is unlocked already (a locked one with a verified push would be the sent build): the session stands.
  if (!sent && shown && (await copyLeftOnWatch(db, shown))) await unpushBuild(db, userId, row, shown, ctx.now, ctx.prefs);
  return session;
}

/**
 * PUT ON MY WATCH (§3.6) — `POST /api/sessions/:workoutId/put-on-watch`: `watch_off` cleared and the session owed to the
 * mirror again (`markMirrorOwed`), so the drain or the sweep makes its copy — on its day, the day's next build
 * (`mirrorOnDayBuild`). Nothing is queued here (M2). An app-built session (`loadSlot`); idempotent. Statements: the slot,
 * the write, the mark, then the session.
 */
export async function putOnWatch(db: Db, userId: string, workoutId: string, ctx: BuildCtx): Promise<SessionResponse> {
  const row = await loadSlot(db, userId, workoutId);
  await db
    .update(plannedWorkouts)
    .set({ watchOff: false, updatedAt: ctx.now })
    .where(and(eq(plannedWorkouts.id, row.id), eq(plannedWorkouts.userId, userId)));
  await markMirrorOwed(db, userId, row.id, ctx.now);
  return loadSession(db, userId, workoutId, ctx.today);
}
