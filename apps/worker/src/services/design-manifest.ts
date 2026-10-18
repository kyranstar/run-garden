/**
 * A DESIGNED WORKOUT'S MANIFEST (Stage 3 spec §8): what each op of a proposal does, computed from its document, never
 * from prose — the coach manifest's own rule (@rg/domain coach-describe.ts: the model never states a fact the system
 * can compute). In the Studio's own voice, through the Studio's own helpers:
 *  - its minutes are `deriveDoc`'s, as the builder's summary says them;
 *  - its parts are a part header's words: the purpose, and beyond straight sets the format and its rounds ("Main ·
 *    Superset × 3"), each the vocabulary's `label`;
 *  - the effort is the vocabulary's word ("Maintain"), as the builder's picker and the validator say it;
 *  - the place is the place's name by default-place.ts's rule — the one the document names (the athlete's, a preset,
 *    or "No equipment"), else (none named, or one deleted since) the default place;
 *  - each move is its library name and its dose as the builder's row says it (`doseSummary`);
 *  - the review's mean is the set's own (design-orchestrate.ts `reviewMeanOf`: one number per review, wherever it is
 *    shown; null when the review couldn't be read).
 * Each line carries how its op ended, once the athlete decided — and, for an op applied, what was WRITTEN (`written`:
 * its day, time, title and minutes as the plan holds them), which after Edit before approve is the athlete's version,
 * never the coach's. The line's own fields stay the coach's proposal. Dates reach the UI as ISO dates for it to format;
 * the thread's receipt names a day as the coach manifest does (`dayLabel`).
 *
 * A change to a session already on the plan (Task 8b) has its own line (`planChangeLines`): the thread coach's manifest
 * line for its skip, move or length, word for word (@rg/domain `describeOps`), and the coach's why.
 */
import { sql, type SQL } from "drizzle-orm";
import { locations, userPreferences } from "@rg/database";
import {
  dayLabel,
  doseSummary,
  isRunDoc,
  NO_EQUIPMENT_PLACE,
  runWatchSessionOf,
  runWatchSteps,
  userPreferencesSchema,
  type RunEffort,
  type RunStepRole,
  type UserPreferences,
  type WorkoutDoc,
  type WorkoutItem,
  type WorkoutPart,
} from "@rg/domain";
import { EXERCISES, label, LOCATION_PRESETS, noEquipmentPlace } from "@rg/exercise-library";
import { deriveDoc, makeLibraryIndex } from "@rg/workout";
import type { Db } from "./db.js";
import { defaultFromRow, defaultPlaceSql } from "./default-place.js";
import type { DesignedOp, DesignedPlanOp, DesignedStructureOp, OpOutcome, PlanOpOutcome, PlanStructureOutcome, Written } from "./design-approve.js";
import { reviewMeanOf } from "./design-orchestrate.js";
import { runningFactsOf, thresholdSql } from "./designed-runs.js";
import { REVIEW_DIMENSIONS, RUN_REVIEW_DIMENSIONS } from "./design-prompt.js";
import { athleteText, clipProse } from "./design-prose.js";
import { acceptedLine, idInWords, REVIEW_ITEM_MAX, REVIEW_NOTE_MAX, type AcceptedCost } from "./design-review.js";
import { approveTimeOf } from "./design-time.js";
import { changeVerb, describeChange, isDocWorkoutOp, isPlanAdjustOp, isPlanStructureOp, opIdOf, type ChangeVerb } from "./proposal-kinds.js";

/** One designed workout, as the athlete reads it before (and after) deciding. */
export interface DocWorkoutLine {
  opId: string;
  kind: "new" | "revise";
  /** A revision's workout. */
  workoutId?: string;
  date: string;
  /** "HH:MM": the time the approve would use now (fix wave 3B, B-I1; design-time.ts `approveTimeOf`) — the coach's, the
   * moment of the approve for a "now" design, the next quarter hour once today's usual time has gone, else the
   * athlete's window. Null only when no time is left today for an untimed one. (What an approve wrote is `written`.) */
  time: string | null;
  /** The approve would refuse this time now — gone by, or no time left today (the polish round, 4): the card asks for
   * another rather than show it as if it stood. Only on an op still open. */
  timePassed?: true;
  title: string;
  minutes: number;
  /** "Hips and back · 24 min". */
  summary: string;
  /** The effort's word: "Maintain". */
  effort: string;
  /** Where: the place's name. */
  place: string;
  /** Each part, as its header says it: "Warm-up", "Main · Superset × 3". */
  parts: string[];
  /** Each move with its dose: "Glute bridge 2 × 12". */
  detail: string[];
  /** What the workout is for, in one sentence: the document's intent summary, in the athlete's words (`athleteText`;
   * Task 13's fix wave, §2.8 — the card's line under the title, 13d D1); null when it has none. */
  intent: string | null;
  /** Each move's why, parallel to `detail` (null where it has none: a rest, a move without one). */
  whys: Array<string | null>;
  /** The moves the coach weighed instead of each one, parallel to `detail` — each its name and why ([] where none; 13d
   * D3: what the coach weighed, one tap down). */
  alternates: Array<Array<{ name: string; why: string | null }>>;
  /** A "now" design (§2.6): placed at the moment of the approve, never a time gone by — the card reads it as now. */
  atNow?: true;
  /** The review's mean score (1–5; `reviewMeanOf`); null when there is none to average. */
  reviewMean: number | null;
  /** The review of the version held, as the card's expanded line shows it (Task 9); null when there is none. */
  review: LineReview | null;
  /** The validator's warnings for the day — the costs shown beside Approve — each its code and its message. A code the
   * shared validator doesn't list (the tool layer's `test_unmeasured`) comes the same way: the card shows the message. */
  issues: Array<{ code: string; message: string }>;
  /** How it ended; null while it is the athlete's to decide. */
  outcome: OpOutcome | null;
  /** Applied: what the plan holds — the athlete's version and day after an edit or a move. Null otherwise. */
  written: (Written & { summary: string; edited: boolean; moved: boolean }) | null;
  /** A designed run's steps, totals and what the watch does (§8 §3); absent for any other workout. */
  run?: RunLine;
}

/**
 * A review as the athlete reads it (Task 9): each dimension scored or noted, by the rubric's own label and in its order
 * (`REVIEW_DIMENSIONS`; one the rubric no longer has after them, by its plain label: `dimensionLabel`); what changed
 * between the drafts; the must-fix items and improvements; the costs the athlete chose (`acceptedLine`); how many drafts
 * were reviewed; and, for a review that couldn't be read, the note saying the validator's view stands. Plain text, all
 * of it, in the athlete's words (Task 13's fix wave, §2.8: `athleteText` — a move's id is its name, a tool or
 * "validator" plain words) and fitted to its cap at a sentence end (§2.1: the reviewer was never refused for length,
 * and the designer read it whole).
 */
export interface LineReview {
  dimensions: Array<{ id: string; label: string; score: number | null; note: string | null }>;
  mustFix: string[];
  improvements: string[];
  changes: string[];
  accepted: string[];
  rounds: number;
  note: string | null;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * The labels of rubric dimensions the rubric no longer has (Task 13's fix wave, §2.10: `time_fit` and `equipment_fit`
 * merged into `fit`): a review stored before keeps rendering, each by its plain label, never its raw id.
 */
export const LEGACY_LABELS: Readonly<Record<string, string>> = {
  time_fit: "Time fit",
  equipment_fit: "Equipment fit",
};

/** A dimension's label: the rubric's (a run's included), a retired one's (`LEGACY_LABELS`), else its id in plain words. */
export function dimensionLabel(id: string): string {
  return [...REVIEW_DIMENSIONS, ...RUN_REVIEW_DIMENSIONS].find((d) => d.id === id)?.label ?? LEGACY_LABELS[id] ?? idInWords(id);
}

/** The rubric a stored review was given on: a run's when it scores a dimension only a run's has (§8 §3). */
const rubricOfScores = (keys: readonly string[]): readonly { id: string }[] => {
  const runOnly = RUN_REVIEW_DIMENSIONS.filter((d) => !REVIEW_DIMENSIONS.some((x) => x.id === d.id)).map((d) => d.id as string);
  return keys.some((k) => runOnly.includes(k)) ? RUN_REVIEW_DIMENSIONS : REVIEW_DIMENSIONS;
};

/** What changed between drafts, as the card shows a line of it (a change note and why it wasn't kept), at most. */
export const CHANGE_SHOWN_MAX = 300;

/** A review's text as the athlete reads it: in their words, fitted to `max` at a sentence end. */
const shown = (text: string, max: number): string => clipProse(athleteText(text), max);

/** The op's review, as the athlete reads it (see `LineReview`). */
export function lineReview(review: DesignedOp["review"]): LineReview | null {
  if (!review) return null;
  const scores = (review.scores ?? {}) as Record<string, unknown>;
  const notes = (review.notes ?? {}) as Record<string, unknown>;
  const rubric = rubricOfScores([...Object.keys(scores), ...Object.keys(notes)]);
  const known = new Set<string>(rubric.map((d) => d.id));
  const ids = [...rubric.map((d) => d.id as string), ...[...Object.keys(scores), ...Object.keys(notes)].filter((k) => !known.has(k))];
  const dimensions = [...new Set(ids)].flatMap((id) => {
    const score = typeof scores[id] === "number" ? (scores[id] as number) : null;
    const note = typeof notes[id] === "string" ? shown(notes[id] as string, REVIEW_NOTE_MAX) : null;
    if (score === null && note === null) return [];
    return [{ id, label: dimensionLabel(id), score, note }];
  });
  const accepted = (review as { accepted?: unknown }).accepted;
  return {
    dimensions,
    mustFix: strings(review.mustFix).map((x) => shown(x, REVIEW_ITEM_MAX)),
    improvements: strings(review.improvements).map((x) => shown(x, REVIEW_ITEM_MAX)),
    changes: strings(review.changes).map((x) => shown(x, CHANGE_SHOWN_MAX)),
    accepted: Array.isArray(accepted)
      ? accepted
          .filter((a): a is AcceptedCost => !!a && typeof a === "object" && typeof (a as AcceptedCost).why === "string")
          .map((a) => acceptedLine({ ...a, why: clipProse(a.why, REVIEW_ITEM_MAX) }, dimensionLabel(a.dimension)))
      : [],
    rounds: typeof review.rounds === "number" ? review.rounds : 1,
    note: typeof review.note === "string" ? athleteText(review.note) : null,
  };
}

/** A place id (or none) → the name the athlete knows it by. */
export type PlaceNamer = (placeId: string | undefined) => string;

const find = makeLibraryIndex(EXERCISES);

/** "Hips and back · 24 min" — the coach manifest's summary shape. */
export const summaryLine = (title: string, minutes: number): string => `${title} · ${minutes} min`;

/** "Fri 15 May · Hips and back · 24 min", with "(your version)" after the title when the athlete changed the coach's
 * draft (the words the card uses too, fix wave 3B); `untitled`: the receipt has named the workout already (B-M8), so
 * the line is its day and minutes — "Fri 15 May · 24 min". */
export const receiptLine = (date: string, title: string, minutes: number, edited = false, untitled = false): string =>
  edited || !untitled ? `${dayLabel(date)} · ${summaryLine(edited ? `${title} (your version)` : title, minutes)}` : `${dayLabel(date)} · ${minutes} min`;

/** A part's header words: its purpose, and its format beyond straight sets ("Main · Superset × 3"). */
export function partLine(part: WorkoutPart): string {
  const name = label(part.purpose);
  if (part.format === "straight") return name;
  const rounds = part.rounds && part.rounds > 1 ? ` × ${part.rounds}` : "";
  return `${name} · ${label(part.format)}${rounds}`;
}

/** A move and its dose, as the builder's row says them. */
function itemLine(it: WorkoutItem): string {
  switch (it.kind) {
    case "exercise":
      return `${find(it.libraryId)?.name ?? it.libraryId} ${doseSummary(it.dose)}`.trim();
    case "free_exercise":
      return `${it.name} ${doseSummary(it.dose)}`.trim();
    case "run":
      return "Run";
    case "rest":
      return `Rest ${it.seconds} s`;
  }
}

/** A move's why as the athlete reads it, or null (a rest has none). */
function itemWhy(it: WorkoutItem): string | null {
  return it.kind !== "rest" && it.why ? athleteText(it.why) : null;
}

/** The moves weighed instead of a move: each by its library name, with its why in the athlete's words. */
function itemAlternates(it: WorkoutItem): Array<{ name: string; why: string | null }> {
  if (it.kind !== "exercise" || !it.alternates) return [];
  return it.alternates.map((a) => ({ name: find(a.libraryId)?.name ?? athleteText(a.libraryId), why: a.why ? athleteText(a.why) : null }));
}

/** What an applied op wrote, as a line says it; null for any other outcome (or an applied one recorded without it). */
function writtenLine(o: OpOutcome | undefined): DocWorkoutLine["written"] {
  if (o?.status !== "applied" || !o.written) return null;
  const w = o.written;
  return { ...w, summary: summaryLine(w.title, w.minutes), edited: !!o.edited, moved: !!o.moved };
}

/** The clock and the athlete's settings a line's time is read at (the approve's own rule). */
export interface LineClock {
  now: Date;
  prefs: Parameters<typeof approveTimeOf>[2]["prefs"];
  /** Where each open workout will sit once approved, the day's other sessions weighed (design-placement.ts
   * `placedTimes`, by op id): the card's read always gives it; without it, the op's own rule alone. */
  placed?: ReadonlyMap<string, string>;
}

/** The time the approve would use for `op` at `at` (see `DocWorkoutLine.time`): a revision's is its workout's. */
function lineTime(op: DesignedOp, category: string, at: LineClock): { time: string | null; passed: boolean } {
  const known = at.placed?.get(opIdOf(op));
  if (known) return { time: known, passed: false };
  if (op.target.kind !== "new") return { time: op.time ?? null, passed: false };
  const placed = approveTimeOf(op.target, category, at);
  // The approve would refuse it (gone by, or no time left today): the line says so, never the old time as if it stood.
  return "refused" in placed ? { time: op.target.time ?? null, passed: true } : { time: placed.time, passed: false };
}

/** Each op's line, in the proposal's order, its time read at `at`. */
/** What a designed run's line reads of the athlete (§8 §3): their threshold, and whether an approve puts it on the watch. */
export interface RunLineCtx {
  thresholdSecPerKm: number | null;
  corosWritesEnabled: boolean;
}

/** One step of a designed run, as the card shows it (and the watch gets it). */
export interface RunLineStep {
  role: RunStepRole;
  /** Its effort, the document's own word (`RUN_EFFORT_LABELS` names it); null for a standing rest. */
  effort: RunEffort | null;
  /** Its seconds on the watch — a distance's at its pace's middle; null when a distance can't be timed. */
  seconds: number | null;
  /** The distance asked, when it was one. */
  meters: number | null;
  /** The pace band it carries, or none. */
  pace: { fastSecPerKm: number; slowSecPerKm: number } | null;
  /** The band is one the athlete asked for (the coach wrote it), not the threshold's. */
  asked: boolean;
  why: string | null;
}

/**
 * A DESIGNED RUN as its card shows it (§8 §3): each part's steps once, with its rounds (and its rest between them) —
 * each step from `runWatchSteps`, the very function the wire builds from (the preview is the wire); its totals; and what
 * the watch does once it is approved: `goes` (paced), `time_only` (no threshold known: no pace targets), `needs_threshold`
 * (a distance no pace can time: it stays off the watch), or null when COROS writes are off (an approve sends nothing).
 */
export interface RunLine {
  segments: Array<{ rounds: number; restBetweenRoundsSec?: number; steps: RunLineStep[] }>;
  totalSeconds: number | null;
  totalMeters: number | null;
  watch: "goes" | "time_only" | "needs_threshold" | null;
}

/** A designed run's line (see `RunLine`), or null for any other workout. */
export function runLine(doc: WorkoutDoc, ctx: RunLineCtx): RunLine | null {
  if (!isRunDoc(doc)) return null;
  const made = runWatchSessionOf(doc);
  if (!("session" in made)) return null;
  const whole = runWatchSteps(made.session, ctx.thresholdSecPerKm);
  const segments = made.session.segments.map((seg, p) => {
    // Each part's steps once: its rounds are the card's "3 ×", its own steps resolved by the wire's function.
    const once = runWatchSteps({ segments: [{ rounds: 1, steps: seg.steps }] }, ctx.thresholdSecPerKm).steps;
    const items = doc.parts[p]?.items ?? [];
    return {
      rounds: seg.rounds,
      ...(seg.restBetweenRoundsSec ? { restBetweenRoundsSec: seg.restBetweenRoundsSec } : {}),
      steps: once.map((st, i): RunLineStep => ({
        role: st.role,
        effort: st.effort ?? null,
        seconds: st.seconds,
        meters: st.meters ?? null,
        pace: st.pace,
        asked: st.paceFrom === "asked",
        why: itemWhy(items[i] ?? { kind: "rest", seconds: 1 }),
      })),
    };
  });
  const watch = !ctx.corosWritesEnabled ? null : whole.unresolved > 0 ? "needs_threshold" : whole.paceOwed > 0 ? "time_only" : "goes";
  return { segments, totalSeconds: whole.totalSeconds, totalMeters: whole.totalMeters, watch };
}

export function docWorkoutLines(ops: readonly DesignedOp[], placeName: PlaceNamer, at: LineClock, running: RunLineCtx = { thresholdSecPerKm: null, corosWritesEnabled: false }): DocWorkoutLine[] {
  return ops.map((op) => {
    const doc = op.doc;
    const derived = deriveDoc(doc, EXERCISES);
    const run = runLine(doc, running);
    // A run's minutes are its steps' on the watch (a distance at its pace), else derived.
    const minutes = run?.totalSeconds != null ? Math.round(run.totalSeconds / 60) : derived.estimatedMinutes;
    const when = lineTime(op, derived.category, at);
    const items = doc.parts.flatMap((p) => p.items);
    return {
      opId: opIdOf(op),
      kind: op.target.kind,
      ...(op.target.kind === "revise" ? { workoutId: op.target.workoutId } : {}),
      date: op.date,
      time: when.time,
      ...(when.passed && (!op.outcome || op.outcome.status === "refused") ? { timePassed: true as const } : {}),
      ...(op.target.kind === "new" && (op.target as { atNow?: boolean }).atNow ? { atNow: true as const } : {}),
      title: doc.title,
      minutes,
      summary: summaryLine(doc.title, minutes),
      effort: label(doc.intent.effort),
      place: placeName(doc.setting?.placeId),
      parts: doc.parts.map(partLine),
      detail: items.map(itemLine),
      intent: doc.intent.summary ? athleteText(doc.intent.summary) : null,
      whys: items.map(itemWhy),
      alternates: items.map(itemAlternates),
      reviewMean: reviewMeanOf(op),
      review: lineReview(op.review),
      issues: (op.issues ?? []).map((i) => ({ code: String(i.code), message: i.message })),
      outcome: op.outcome ?? null,
      written: writtenLine(op.outcome),
      ...(run ? { run } : {}),
    };
  });
}

/**
 * One change to a session already on the plan (Task 8b), as the athlete reads it before (and after) deciding: the
 * thread coach's own manifest line for its op (@rg/domain `describeOps`, proposal-kinds.ts `describeChange`) — with the
 * session as the plan held it when the coach proposed the change — and the coach's `why`.
 */
export interface PlanChangeLine {
  opId: string;
  /** The change as the coach asked for it: a skip, a move, a length — and since the new shape §5 an ease, a swap (an ease
   * to an easier kind), a remove or a restore. */
  kind: ChangeVerb;
  workoutId: string;
  /** The day the line is under: a move's destination, else the session's day. */
  date: string | null;
  /** A move's time asked for, else null. */
  time: string | null;
  /** "Strength — skipped", "Easy run — 30 min", a moved session's name. */
  summary: string;
  /** What it replaced: a move's old day, a length's old minutes — only a real difference. */
  was: string | null;
  /** What `was` can't say: a skip's reason. */
  effect: string | null;
  /** The coach's reason, in its words. */
  why: string;
  /** Its advisory notes (Task 8b: a skip past the rolling week's sanctioned rest), each its code and plain message —
   * the card shows the message (Task 9). */
  issues: Array<{ code: string; message: string }>;
  /** How it ended; null while it is the athlete's to decide. */
  outcome: PlanOpOutcome | null;
}

/** A whole plan change as the manifest gives it (§8 §5): its change, its card's words, the thread coach's lines, the
 * coach's why, the guardrails' advisories, and how it stands — `applying` with how far its chunks got while approves
 * apply it, `applied` with the applier's line. */
export interface PlanStructureLine {
  opId: string;
  kind: string;
  title: string;
  summary: string;
  lines: string[];
  why: string;
  issues: Array<{ code: string; message: string }>;
  outcome: PlanStructureOutcome | null;
}

/** Each whole plan change's line, in the proposal's order (§8 §5). */
export function planStructureLines(ops: readonly unknown[]): PlanStructureLine[] {
  return (ops.filter(isPlanStructureOp) as DesignedStructureOp[]).map((s) => ({
    opId: s.id,
    kind: s.op.kind,
    title: s.title,
    summary: s.summary,
    lines: s.lines,
    why: s.why,
    issues: (s.issues ?? []).map((i) => ({ code: String(i.code), message: i.message })),
    outcome: s.outcome ?? null,
  }));
}

/** Each change's line, in the proposal's order. */
export function planChangeLines(ops: readonly unknown[]): PlanChangeLine[] {
  return (ops.filter(isPlanAdjustOp) as DesignedPlanOp[]).map((c) => {
    const w = describeChange(c);
    return {
      opId: c.id,
      kind: changeVerb(c),
      workoutId: c.op.workoutId,
      date: w.date,
      time: w.time,
      summary: w.summary,
      was: w.was,
      effect: w.effect,
      why: c.why,
      issues: (c.issues ?? []).map((i) => ({ code: String(i.code), message: i.message })),
      outcome: c.outcome ?? null,
    };
  });
}

/**
 * The names of the athlete's places, by default-place.ts's rule (see the module comment), for the manifest. One
 * statement: the default place and the athlete's own places' names.
 */
export async function placeNamer(db: Db, userId: string): Promise<PlaceNamer> {
  return (await manifestReads(db, userId)).placeName;
}

/**
 * What the manifest reads, in ONE statement: the places' names (`placeNamer`) and the athlete's settings, whose
 * timezone and usual times say the time each line's approve would use (B-I1).
 */
export async function manifestReads(
  db: Db,
  userId: string,
  /** The plan's rows the lines' times are placed among (design-placement.ts `dayRowsSql`), in the same statement. */
  dayRows: SQL = sql`null`,
  /** A set's other sessions in its days (`setContextSql`), in the same statement. */
  context: SQL = sql`null`,
): Promise<{ placeName: PlaceNamer; prefs: UserPreferences; dayRows: unknown; context: SetContextRow[] | null; thresholdSecPerKm: number | null }> {
  const l = locations;
  const [row] = (await db.all(
    sql`select ${defaultPlaceSql(userId)} as fallback,
      (select json_group_array(json_object('id', ${l.id}, 'name', ${l.name})) from ${l} where ${l.userId} = ${userId}) as own,
      (select ${userPreferences.prefs} from ${userPreferences} where ${userPreferences.userId} = ${userId}) as prefs,
      ${dayRows} as dayRows, ${context} as context, ${thresholdSql(userId)} as threshold`,
  )) as Array<{ fallback: unknown; own: unknown; prefs: unknown; dayRows: unknown; context: unknown; threshold: unknown }>;
  let stored: unknown = {};
  try {
    stored = typeof row?.prefs === "string" ? JSON.parse(row.prefs) : (row?.prefs ?? {});
  } catch {
    // Settings that don't read: the defaults, as a preferences read with nothing stored.
  }
  const parsed = userPreferencesSchema.safeParse(stored ?? {});
  const prefs = parsed.success ? parsed.data : userPreferencesSchema.parse({});
  const fallback = defaultFromRow(row?.fallback ?? null).name;
  const own = new Map<string, string>();
  try {
    const list = JSON.parse(typeof row?.own === "string" ? row.own : "[]") as Array<{ id?: unknown; name?: unknown }>;
    for (const p of list) if (typeof p.id === "string") own.set(p.id, typeof p.name === "string" ? p.name : p.id);
  } catch {
    // No places to name: every document is at the default.
  }
  const placeName: PlaceNamer = (id) => {
    if (!id) return fallback;
    const mine = own.get(id);
    if (mine !== undefined) return mine;
    if (id === NO_EQUIPMENT_PLACE) return noEquipmentPlace().name;
    return LOCATION_PRESETS.find((p) => p.id === id)?.name ?? fallback;
  };
  // A designed run's card reads the athlete's threshold (§8 §3): in this statement, no other.
  const thresholdSecPerKm = runningFactsOf(row?.threshold ?? null, null).threshold?.secPerKm ?? null;
  return { placeName, prefs, dayRows: row?.dayRows ?? null, context: contextRows(row?.context ?? null), thresholdSecPerKm };
}

// ── A set's other sessions (Task 13's fix wave, §2.9; 13d D7) ───────────────────────────────────────────────────────

/** One of the plan's other sessions in a set's days, as the card shows it among the set's workouts. */
export interface SetContextRow {
  date: string;
  /** "HH:MM". */
  time: string | null;
  /** What it is, as a word: "run", "programme", "workout" or "rest". */
  kind: string;
  title: string;
  minutes: number | null;
}

/** A set's other sessions shown, at most (a week holds about a dozen). */
export const SET_CONTEXT_MAX = 40;

const RUN_CATEGORIES = ["recovery", "easy", "long", "quality", "race"];

/**
 * A set's context, as a column of the manifest's one statement: for a proposal made by a `week` or `next_n` run, the
 * plan's other rows — runs, programme sessions, other workouts, rest days — in the set's date span (its first workout's
 * day to its last's), in day and time order: never the proposal's own (a revision's workout, a change's session, a
 * workout an approve of it wrote), nor one archived or skipped. `null` for any other proposal (no row is read). `runId`:
 * the main run whose design proposal it is (its scope says whether it is a set's).
 */
export function setContextSql(userId: string, runId: string | null, ops: readonly unknown[]): SQL {
  const workouts = ops.filter((o): o is DesignedOp => isDocWorkoutOp(o));
  if (!runId || workouts.length === 0) return sql`null`;
  const dates = workouts.map((w) => w.date).sort();
  const own = new Set<string>();
  for (const op of ops) {
    if (isPlanAdjustOp(op)) own.add((op as DesignedPlanOp).op.workoutId);
    if (!isDocWorkoutOp(op)) continue;
    const w = op as DesignedOp;
    if (w.target.kind === "revise") own.add(w.target.workoutId);
    if (w.outcome?.status === "applied") own.add(w.outcome.workoutId);
  }
  const pw = sql.raw("pw");
  const notOwn = own.size > 0 ? sql`AND ${pw}.id NOT IN (${sql.join([...own].slice(0, 60).map((id) => sql`${id}`), sql`, `)})` : sql``;
  const kind = sql`CASE WHEN ${pw}.category = 'rest' THEN 'rest'
      WHEN ${pw}.category IN (${sql.join(RUN_CATEGORIES.map((c) => sql`${c}`), sql`, `)}) THEN 'run'
      WHEN ${pw}.origin = 'program' THEN 'programme' ELSE 'workout' END`;
  return sql`CASE WHEN (SELECT CASE WHEN json_valid(r.scope) THEN json_extract(r.scope, '$.kind') END FROM coach_runs r
      WHERE r.id = ${runId} AND r.user_id = ${userId}) IN ('week', 'next_n')
    THEN (SELECT json_group_array(json_object('date', c.date, 'time', c.time, 'kind', c.kind, 'title', c.title, 'seconds', c.seconds)) FROM (
      SELECT ${pw}.effective_date AS date, ${pw}.effective_time AS time, ${kind} AS kind, ${pw}.title AS title,
        CASE WHEN ${pw}.category = 'rest' THEN NULL
          ELSE coalesce(${pw}.source_estimated_duration_seconds, ${pw}.fallback_estimated_duration_seconds) END AS seconds
      FROM planned_workouts ${pw}
      WHERE ${pw}.user_id = ${userId} AND ${pw}.archived_at IS NULL AND ${pw}.completion_state <> 'skipped'
        AND ${pw}.effective_date BETWEEN ${dates[0]!} AND ${dates.at(-1)!} ${notOwn}
      ORDER BY ${pw}.effective_date, ${pw}.effective_time, ${pw}.id
      LIMIT ${SET_CONTEXT_MAX}) c) END`;
}

/** `setContextSql`'s column, read; null when the proposal is no set's. */
function contextRows(column: unknown): SetContextRow[] | null {
  if (column === null || column === undefined) return null;
  let rows: unknown = column;
  try {
    if (typeof column === "string") rows = JSON.parse(column);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  return rows.flatMap((r) => {
    const x = r as { date?: unknown; time?: unknown; kind?: unknown; title?: unknown; seconds?: unknown } | null;
    if (typeof x?.date !== "string") return [];
    const seconds = typeof x.seconds === "number" && x.seconds > 0 ? x.seconds : null;
    return [{ date: x.date, time: typeof x.time === "string" ? x.time : null, kind: typeof x.kind === "string" ? x.kind : "workout", title: typeof x.title === "string" ? x.title : "", minutes: seconds === null ? null : Math.round(seconds / 60) }];
  });
}
