/**
 * THE BUILDER'S DECISIONS, PURE (Stage 2 spec §8; principles §2.1–§2.8, §7). Everything the builder decides that needs
 * no React, so each rule is a test and the screen only draws:
 *
 *   sourceOfPath     where the builder is: a new workout (the draft on this device), a quick start (built on the
 *                    device for the day, kept nowhere until it is started, scheduled or saved), a template, a planned
 *                    workout.
 *   buildCtxOf       what it judges and suggests with: the switched-on profiles and today's readings (joined by any
 *                    this page recorded), the athlete's set-aside, pinned and recent moves, the place's gear, and what
 *                    was done cleanly — the server's `isDoneCleanly` over the same tally the engine reads, per library
 *                    row (`doneCleanly`); before the library read answers, or when it does not say (an older cached
 *                    read), nothing is claimed (no frontier).
 *   judgeDraft       the notes: the validator on the draft as it would be saved (`toProposable`), each note put back on
 *                    the draft's own part and item (empty parts and all), with its Fix as an editor action, and — for an
 *                    error today's check could answer — the profile whose check to ask for. What blocks Start and
 *                    Schedule, in plain words: an empty workout, or the first error no check could answer. Warnings
 *                    are costs, never blocks.
 *   balanceRows …    the summary's numbers; a dose in words; the item sheet's steppers and load; the swap list; the
 *                    parts on offer; where activation belongs once the main part loads a lift; "Later today"; why a
 *                    planned workout opens read-only; why an edit was refused, in the words of what was asked and
 *                    with the schema's own bounds; several edits as one (one Undo); the athlete's usual time.
 */
import {
  amountKind,
  amountText,
  amountValue,
  formatWeight,
  itemSchema,
  parseWeight,
  partSchema,
  secondsText,
  toKg,
  type AmountKind,
  type SchedulingPreferences,
  type WeightUnit,
  type WorkoutDoc,
  type WorkoutDose,
  type WorkoutItem,
  type WorkoutPart,
  workoutDocSchema,
} from "@rg/domain";
import {
  bestDay,
  EXERCISES,
  hasEquipment,
  isPlyometric,
  label,
  type CheckReading,
  type ConditionProfile,
  type ExerciseRecord,
} from "@rg/exercise-library";
import {
  deriveDoc,
  HISTORY_LIMIT,
  makeLibraryIndex,
  PART_ORDER,
  QUICK_START_KINDS,
  toProposable,
  tryEdit,
  validateWorkoutDoc,
  type BalanceProfile,
  type DayContext,
  type DocDerived,
  type DocIssue,
  type DraftDoc,
  type EditAction,
  type EditorState,
  type Rejection,
  type QuickStartKind,
  type SuggestCtx,
} from "@rg/workout";
import type { ConditionViewDto, WorkoutDto } from "@rg/api-client";
import type { StudioCtx } from "./model.js";

type PartPurpose = WorkoutPart["purpose"];
type Library = readonly ExerciseRecord[];

// ── Where the builder is ───────────────────────────────────────────────────

export type BuildSource =
  | { kind: "new" }
  | { kind: "quick"; quick: QuickStartKind }
  | { kind: "template"; id: string }
  | { kind: "workout"; id: string };

/** A quick start's kind from its address; null for anything else. */
export function quickKindOf(s: string): QuickStartKind | null {
  return QUICK_START_KINDS.find((k) => k === s) ?? null;
}

/**
 * The builder's address (spec §2): `/studio/build/new`, `…/quick/:kind` (a quick start, spec §9), `…/template/:id`,
 * `…/workout/:workoutId`; anything else, null.
 */
export function sourceOfPath(pathname: string): BuildSource | null {
  if (/^\/studio\/build\/new\/?$/.test(pathname)) return { kind: "new" };
  const q = /^\/studio\/build\/quick\/([^/]+)\/?$/.exec(pathname);
  if (q) {
    const quick = quickKindOf(q[1]!);
    return quick ? { kind: "quick", quick } : null;
  }
  const m = /^\/studio\/build\/(template|workout)\/([^/]+)\/?$/.exec(pathname);
  if (!m) return null;
  let id: string;
  try {
    id = decodeURIComponent(m[2]!);
  } catch {
    return null;
  }
  return m[1] === "template" ? { kind: "template", id } : { kind: "workout", id };
}

export const sourceKey = (s: BuildSource): string => (s.kind === "new" ? "new" : s.kind === "quick" ? `quick:${s.quick}` : `${s.kind}:${s.id}`);

/** A reason as a sentence ("wakes the glutes before Deadlift" → "Wakes the glutes before Deadlift."). */
export const sentence = (s: string): string => `${s.charAt(0).toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? "" : "."}`;

// ── Edits ──────────────────────────────────────────────────────────────────

/**
 * A bound the schema writes, read from it only when a refusal is said (an edit is refused by the schema's own rules,
 * so its reason quotes them) — never as the app loads, and never a throw: a schema, or a zod, that no longer says it
 * reads as null, and the message says the same without the number.
 */
function bound(read: () => number | null | undefined): number | null {
  try {
    const n = read();
    return typeof n === "number" && Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
/** A list's most, where zod keeps it. */
const listMax = (s: unknown): number | undefined => (s as { _def?: { maxLength?: { value?: number } | null } } | undefined)?._def?.maxLength?.value;
/** The schema's bounds an edit can meet, each read when asked. */
const BOUNDS = {
  roundsMin: () => bound(() => partSchema.shape.rounds.unwrap().minValue),
  roundsMax: () => bound(() => partSchema.shape.rounds.unwrap().maxValue),
  restSec: () => bound(() => partSchema.shape.restBetweenRoundsSec.unwrap().maxValue),
  partWhy: () => bound(() => partSchema.shape.why.unwrap().maxLength),
  moves: () => bound(() => listMax(partSchema.shape.items)),
  title: () => bound(() => workoutDocSchema.shape.title.maxLength),
  summary: () => bound(() => workoutDocSchema.shape.intent.shape.summary.maxLength),
  goals: () => bound(() => listMax(workoutDocSchema.shape.intent.shape.goals)),
  focus: () => bound(() => listMax(workoutDocSchema.shape.intent.shape.focus)),
  parts: () => bound(() => listMax(workoutDocSchema.shape.parts)),
  /** A cue's, for the kind of item it is on (an exercise's when the kind is unknown). */
  cue: (kind: string | undefined) =>
    bound(() => {
      const variant = itemSchema.options.find((o) => o.shape.kind.value === kind) ?? itemSchema.options[0];
      return "cue" in variant.shape ? variant.shape.cue.unwrap().maxLength : null;
    }),
};
/** The words with the bound in them, or — when the schema no longer says it — the same in words alone. */
const withBound = (n: number | null, line: (n: number) => string, otherwise: string): string => (n === null ? otherwise : line(n));

/**
 * Several actions as ONE edit — one Undo takes them all back: each applied to the last one's result; the first refusal
 * stops them all and nothing changes.
 */
export function editAll(state: EditorState, actions: readonly EditAction[], library: Library = EXERCISES): { state: EditorState; rejected?: Rejection } {
  let cur = state;
  let changed = false;
  for (const a of actions) {
    const r = tryEdit(cur, a, library);
    if (r.rejected === "unchanged") continue;
    if (r.rejected) return { state, rejected: r.rejected };
    cur = r.state;
    changed = true;
  }
  if (!changed) return { state, rejected: "unchanged" };
  return { state: { doc: cur.doc, past: [...state.past, state.doc].slice(-HISTORY_LIMIT), future: [] } };
}

/** Why an edit did nothing, in the words of what was asked (the editor's reason, said for this action). */
export function editRefusal(action: EditAction, r: Rejection, doc?: WorkoutDoc): string {
  if (r === "missing") return "That's gone already.";
  if (r === "unchanged") return "Nothing changed.";
  if (r === "full") {
    // A move with no part named goes to its purpose's part, made if need be: refused full, there was no room for one.
    const parts = BOUNDS.parts();
    const noPart = action.type === "addPart" || (action.type === "addItem" && action.part === undefined && parts !== null && (doc?.parts.length ?? 0) >= parts);
    return noPart
      ? withBound(parts, (n) => `A workout holds at most ${n} parts.`, "That's more parts than a workout holds.")
      : withBound(BOUNDS.moves(), (n) => `A part holds at most ${n} moves.`, "That part is full.");
  }
  switch (action.type) {
    case "setDose":
    case "setCue":
    case "swapItem": {
      // An item already outside the rules (a stored document's) changes only by being swapped or removed.
      const it = doc?.parts[action.part]?.items[action.item];
      if (it && !itemSchema.safeParse(it).success) return "Fix this item first.";
      if (action.type === "setDose") return "That dose is more than a workout takes.";
      if (action.type === "setCue") return withBound(BOUNDS.cue(it?.kind), (n) => `A cue takes at most ${n} characters.`, "That cue is too long.");
      return "That move can't stand in here.";
    }
    case "setPart": {
      const p = action.patch;
      if (p.rounds !== undefined) {
        const [lo, hi] = [BOUNDS.roundsMin(), BOUNDS.roundsMax()];
        return lo !== null && hi !== null ? `Rounds go from ${lo} to ${hi}.` : "That number of rounds doesn't fit.";
      }
      if (p.restBetweenRoundsSec !== undefined) {
        return withBound(BOUNDS.restSec(), (n) => `Rest between rounds goes up to ${secondsText(n)}.`, "That rest is longer than a part takes.");
      }
      if (p.why !== undefined) return withBound(BOUNDS.partWhy(), (n) => `A part's why takes at most ${n} characters.`, "That why is too long.");
      return "That doesn't fit this part.";
    }
    case "setIntent": {
      const i = action.intent;
      if (i.goals !== undefined) return withBound(BOUNDS.goals(), (n) => `A workout serves at most ${n} goals.`, "That's more goals than a workout serves.");
      if (i.focus !== undefined) return withBound(BOUNDS.focus(), (n) => `A workout has at most ${n} focus areas.`, "That's more focus areas than a workout has.");
      if (i.summary !== undefined) return withBound(BOUNDS.summary(), (n) => `The why takes at most ${n} characters.`, "That why is too long.");
      return "That can't be set for this workout.";
    }
    case "setTitle":
      return action.title.trim() ? withBound(BOUNDS.title(), (n) => `A title takes at most ${n} characters.`, "That title is too long.") : "The title can't be empty.";
    case "addItem":
      return "That move can't go in this part.";
    default:
      return "That can't be done here.";
  }
}

// ── What it judges and suggests with ───────────────────────────────────────

export interface BuildCtx {
  profiles: readonly ConditionProfile[];
  /** Per profile id: today's reading (a missing one is unanswered). */
  readings: Readonly<Record<string, CheckReading>>;
  /** "Not for me". */
  excluded: string[];
  pinned: string[];
  /** Done in the last week: they give way to the others. */
  recent: string[];
  /** The place's gear; null until it is known (then gear is not judged). */
  equipment: readonly string[] | null;
  /** Done cleanly (the library read's `doneCleanly`); undefined before that read answers, or when it does not say. */
  done: ReadonlySet<string> | undefined;
  today: string;
}

/** How far back "recent" reaches, in days. */
export const RECENT_DAYS = 7;
const DAY_MS = 86_400_000;

export function buildCtxOf(ctx: StudioCtx, today: string, recorded: Readonly<Record<string, CheckReading>> = {}): BuildCtx {
  const prefs = [...ctx.prefs];
  const recent = prefs
    .filter(([, p]) => p.lastDoneOn !== null && (Date.parse(today) - Date.parse(p.lastDoneOn)) / DAY_MS < RECENT_DAYS)
    .map(([id]) => id);
  // The server judged each move by the one rule (`isDoneCleanly`, flags and all). Before its read — or from an older
  // cached read that does not say — nothing is known: unknown, never "nothing done cleanly" (every jump a jump).
  const told = prefs.some(([, p]) => p.doneCleanly !== null);
  const done = told ? new Set(prefs.filter(([, p]) => p.doneCleanly === true).map(([id]) => id)) : undefined;
  return {
    profiles: ctx.profiles,
    readings: { ...ctx.readings, ...recorded },
    excluded: prefs.filter(([, p]) => p.excluded).map(([id]) => id),
    pinned: prefs.filter(([, p]) => p.pinned).map(([id]) => id),
    recent,
    equipment: ctx.place ? ctx.place.equipment : null,
    done,
    today,
  };
}

/** A reading that says something: a "before" number, or "feeling off". */
export const answered = (r: CheckReading | null | undefined): boolean => !!r && (r.pre !== null || r.feelingOff);

export function dayFor(bc: BuildCtx, date: string): DayContext {
  return { date, today: bc.today, readings: bc.readings, ...(bc.done ? { done: bc.done } : {}) };
}

/** A seed for the day, so equal suggestions take turns from one day to the next. */
const seedOf = (date: string): number => Number(date.replace(/-/g, "")) || 0;

export function suggestCtxOf(bc: BuildCtx, date: string): SuggestCtx {
  return {
    activeProfiles: bc.profiles,
    day: dayFor(bc, date),
    focusRefs: [],
    recentIds: bc.recent,
    pinned: bc.pinned,
    excluded: bc.excluded,
    equipment: bc.equipment ?? ALL_GEAR,
    seed: seedOf(date),
  };
}
/** Gear not known yet: suggest as if every piece were there (the place's read narrows it). */
const ALL_GEAR: readonly string[] = [...new Set(EXERCISES.flatMap((r) => [...r.equipment.all, ...r.equipment.oneOf]))];

// ── The notes ──────────────────────────────────────────────────────────────

export interface Note {
  code: DocIssue["code"];
  severity: DocIssue["severity"];
  message: string;
  /** The draft's part (and item) it is about; null for the whole workout. */
  part: number | null;
  item: number | null;
  /** What Fix does, and what its button says. */
  fix: { action: EditAction; label: string } | null;
  /** An error today's check could answer: the profile to ask. */
  check: string | null;
}

export interface Judged {
  /** The draft as it would be saved; null while it holds no move. */
  doc: WorkoutDoc | null;
  derived: DocDerived | null;
  /** Errors first. */
  notes: Note[];
  /** What stops Start and Schedule, in plain words; null when nothing does. */
  blocked: string | null;
  /** The profiles whose check would answer the errors left. */
  checks: string[];
}

export const EMPTY_BLOCK = "Add a move first.";
/** Errors a day's reading decides. */
const READING_CODES = new Set<string>(["condition_gate", "condition_pattern"]);

/** For each part of the saved document, the draft's own index (the saved one drops empty parts). */
function partIndexes(draft: WorkoutDoc): number[] {
  return draft.parts.flatMap((p, i) => (p.items.length > 0 ? [i] : []));
}

const PATH = /^parts\[(\d+)\](?:\.items\[(\d+)\])?/;

const FORMAT_PHRASE: Readonly<Record<WorkoutPart["format"], string>> = {
  straight: "straight sets", superset: "a superset", circuit: "a circuit", flow: "a flow", intervals: "intervals",
  steady: "a steady effort", ladder: "a ladder", holds: "holds",
};

function fixOf(issue: DocIssue, map: readonly number[], doc: WorkoutDoc, find: (id: string) => ExerciseRecord | undefined): Note["fix"] {
  const fix = issue.fix;
  if (fix === undefined) return null;
  const at = (k: string): number => map[Number(k)]!;
  let m = /^parts\[(\d+)\]\.items\[(\d+)\]\.libraryId$/.exec(issue.path);
  if (m) {
    const action: EditAction = { type: "swapItem", part: at(m[1]!), item: Number(m[2]), libraryId: fix };
    return { action, label: issue.code === "legacy_id" ? "Update" : `Swap in ${find(fix)?.name ?? fix}` };
  }
  m = /^parts\[(\d+)\]\.items\[(\d+)\]\.dose$/.exec(issue.path);
  if (m) {
    try {
      return { action: { type: "setDose", part: at(m[1]!), item: Number(m[2]), dose: JSON.parse(fix) as WorkoutDose }, label: "Fix the dose" };
    } catch {
      return null;
    }
  }
  m = /^parts\[(\d+)\]\.format$/.exec(issue.path);
  if (m && fix in FORMAT_PHRASE) {
    return { action: { type: "setPart", part: at(m[1]!), patch: { format: fix as WorkoutPart["format"] } }, label: `Use ${FORMAT_PHRASE[fix as WorkoutPart["format"]]}` };
  }
  if (issue.path === "intent.effort") {
    return { action: { type: "setIntent", intent: { effort: fix as WorkoutDoc["intent"]["effort"] } }, label: `Use ${label(fix)}` };
  }
  m = /^intent\.focus\[(\d+)\]$/.exec(issue.path);
  if (m) {
    const focus = doc.intent.focus.map((f, i) => (i === Number(m![1]) ? fix : f));
    return { action: { type: "setIntent", intent: { focus } }, label: `Use ${label(fix)}` };
  }
  return null;
}

const keyOf = (i: DocIssue): string => `${i.path}|${i.code}`;

/**
 * The draft judged for `date` — or, with no date (a planned workout done with: see `judgeDayOf`), by the static rules
 * alone: no day, so nothing a day's reading decides.
 */
export function judgeDraft(draft: DraftDoc, bc: BuildCtx, date: string | null, library: Library = EXERCISES): Judged {
  const doc = toProposable(draft);
  if (!doc) return { doc: null, derived: null, notes: [], blocked: EMPTY_BLOCK, checks: [] };
  const vctx = (readings: BuildCtx["readings"]) => ({
    library,
    activeProfiles: bc.profiles,
    day: date === null ? null : { ...dayFor(bc, date), readings },
    excluded: bc.excluded,
    ...(bc.equipment ? { equipment: bc.equipment } : {}),
  });
  const issues = validateWorkoutDoc(doc, vctx(bc.readings));
  // Today, an unanswered profile's check might open what it holds shut: judged again as if it read calm.
  const answeredBy = new Map<string, string>();
  if (date === bc.today) {
    for (const p of bc.profiles) {
      if (answered(bc.readings[p.id])) continue;
      const calm = new Set(validateWorkoutDoc(doc, vctx({ ...bc.readings, [p.id]: bestDay(p) })).map(keyOf));
      for (const i of issues) if (i.severity === "error" && READING_CODES.has(i.code) && !calm.has(keyOf(i)) && !answeredBy.has(keyOf(i))) answeredBy.set(keyOf(i), p.id);
    }
  }
  const map = partIndexes(draft);
  const find = makeLibraryIndex(library);
  const notes: Note[] = issues.map((i) => {
    const m = PATH.exec(i.path);
    return {
      code: i.code,
      severity: i.severity,
      message: i.message,
      part: m ? map[Number(m[1])]! : null,
      item: m && m[2] !== undefined ? Number(m[2]) : null,
      fix: fixOf(i, map, doc, find),
      check: answeredBy.get(keyOf(i)) ?? null,
    };
  });
  notes.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
  const blocking = notes.find((n) => n.severity === "error" && n.check === null);
  return {
    doc,
    derived: deriveDoc(doc, library),
    notes,
    blocked: blocking?.message ?? null,
    checks: [...new Set(notes.flatMap((n) => (n.check ? [n.check] : [])))],
  };
}

/** One part's minutes, as the summary counts them (0 for an empty part). */
export function partMinutes(draft: WorkoutDoc, i: number, library: Library = EXERCISES): number {
  const part = draft.parts[i];
  if (!part || part.items.length === 0) return 0;
  return deriveDoc({ ...draft, parts: [part] }, library).estimatedMinutes;
}

// ── The summary ────────────────────────────────────────────────────────────

/** About how long a rep takes, to set reps beside seconds on one scale. */
const REP_SEC = 3;
export const BALANCE_LEVELS = 5;

export interface BalanceRow {
  key: string;
  label: string;
  /** The glossary's word for it, when it has one (its tooltip). */
  term?: string;
  text: string;
  /** 0–5: its share against the biggest. */
  level: number;
}

export function balanceRows(b: BalanceProfile): BalanceRow[] {
  const time = (s: number) => (s > 0 ? secondsText(s) : "None");
  const count = (n: number, word: string) => (n > 0 ? `${n} ${word}` : "None");
  const rows = [
    { key: "holds", label: "Holds", term: "isometric", text: time(b.isometricSec), sec: b.isometricSec },
    { key: "range", label: "Through range", term: "isotonic", text: count(b.isotonicReps, "reps"), sec: b.isotonicReps * REP_SEC },
    { key: "eccentric", label: label("eccentric"), term: "eccentric", text: count(b.eccentricReps, "reps"), sec: b.eccentricReps * REP_SEC },
    { key: "jumps", label: "Jumps", term: "plyometric", text: count(b.plyoContacts, "landings"), sec: b.plyoContacts },
    { key: "aerobic", label: "Aerobic", text: time(b.aerobicSec), sec: b.aerobicSec },
    { key: "mobility", label: label("mobility"), term: "mobility", text: time(b.mobilitySec), sec: b.mobilitySec },
  ];
  const most = Math.max(...rows.map((r) => r.sec));
  return rows.map(({ sec, ...r }) => ({ ...r, level: sec > 0 ? Math.max(1, Math.round((BALANCE_LEVELS * sec) / most)) : 0 }));
}

/** The body areas the workout works most, in words, most first. */
export function areasWorked(d: DocDerived, n = 4): string[] {
  return Object.entries(d.regionExposure)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, n)
    .map(([id]) => label(id).toLowerCase());
}

// ── A dose ─────────────────────────────────────────────────────────────────

// The dose in words is the document's own (`@rg/domain`): the builder, the session sheet and the build say it alike.
export { amountKind, amountText, amountValue, doseSummary, type AmountKind } from "@rg/domain";

const clampInt = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(n)));
/** The schema's bounds. */
const MAX_SETS = 20;
const MAX_REPS = 200;
const MAX_HOLD = 3600;
/** The schema's own bound. */
const MIN_HOLD = 1;

/** Holds move by 5 s, and by 15 s from a minute up. */
export const holdStep = (sec: number, dir: 1 | -1): number => (dir > 0 ? (sec >= 60 ? 15 : 5) : sec > 60 ? 15 : 5);

export function stepAmount(dose: WorkoutDose, kind: AmountKind, dir: 1 | -1): WorkoutDose {
  switch (kind) {
    case "reps": {
      const r = dose.reps;
      if (r !== undefined && typeof r !== "number") {
        const shift = dir > 0 ? Math.min(1, MAX_REPS - r.max) : -Math.min(1, r.min - 1);
        return { ...dose, reps: { min: r.min + shift, max: r.max + shift } };
      }
      return { ...dose, reps: clampInt((r ?? 0) + dir, 1, MAX_REPS) };
    }
    case "hold": {
      const s = dose.holdSec ?? 0;
      return { ...dose, holdSec: clampInt(s + dir * holdStep(s, dir), MIN_HOLD, MAX_HOLD) };
    }
    case "breaths":
      return { ...dose, breaths: clampInt((dose.breaths ?? 0) + dir, 1, MAX_REPS) };
    case "distance":
      return { ...dose, carryM: clampInt((dose.carryM ?? 0) + dir * 5, 5, 5000) };
  }
}

export function stepSets(dose: WorkoutDose, dir: 1 | -1): WorkoutDose {
  return { ...dose, sets: clampInt((dose.sets ?? 1) + dir, 1, MAX_SETS) };
}

/** A typed hold in seconds: "45", "45 s", "2m", "2 min", "1:30"; null when it is none, or out of bounds. */
export function holdSeconds(text: string): number | null {
  const t = text.trim().toLowerCase();
  let sec: number | null = null;
  let m = /^(\d+):([0-5]\d)$/.exec(t);
  if (m) sec = Number(m[1]) * 60 + Number(m[2]);
  else if ((m = /^(\d+)\s*(m|min|mins|minutes?)$/.exec(t))) sec = Number(m[1]) * 60;
  else if ((m = /^(\d+)\s*(s|sec|secs|seconds?)?$/.exec(t))) sec = Number(m[1]);
  return sec !== null && sec >= MIN_HOLD && sec <= MAX_HOLD ? sec : null;
}

/** A typed amount: a whole number ("12"), for reps a range ("8-12"), for a hold minutes too ("2m", "1:30"); else null. */
export function typedAmount(dose: WorkoutDose, kind: AmountKind, text: string): WorkoutDose | null {
  const t = text.trim();
  const whole = (s: string, hi: number): number | null => (/^\d+$/.test(s) && Number(s) >= 1 && Number(s) <= hi ? Number(s) : null);
  if (kind === "reps") {
    const range = /^(\d+)\s*[-–]\s*(\d+)$/.exec(t);
    if (range) {
      const min = whole(range[1]!, MAX_REPS);
      const max = whole(range[2]!, MAX_REPS);
      return min !== null && max !== null && min <= max ? { ...dose, reps: min === max ? min : { min, max } } : null;
    }
    const n = whole(t, MAX_REPS);
    return n === null ? null : { ...dose, reps: n };
  }
  if (kind === "hold") {
    const sec = holdSeconds(t);
    return sec === null ? null : { ...dose, holdSec: sec };
  }
  const n = whole(kind === "distance" ? t.replace(/\s*m$/i, "") : t, kind === "distance" ? 5000 : MAX_REPS);
  if (n === null) return null;
  return kind === "breaths" ? { ...dose, breaths: n } : { ...dose, carryM: n };
}

/** A load as typed, in the athlete's unit unless it names one: null to clear it, "invalid" when it is no weight. */
export function loadFrom(text: string, unit: WeightUnit): WorkoutDose["load"] | null | "invalid" {
  if (text.trim() === "") return null;
  const w = parseWeight(text, unit);
  if (!w) return "invalid";
  const kg = Math.round(toKg(w) * 100) / 100;
  const typed = formatWeight(w);
  return kg > 500 || typed.length > 20 ? "invalid" : { typed, kg };
}

// ── Swap ───────────────────────────────────────────────────────────────────

export interface SwapOptions {
  alternates: ExerciseRecord[];
  easier: ExerciseRecord[];
  harder: ExerciseRecord[];
  /** Moves for the same purpose, sharing its patterns (else its areas). */
  same: ExerciseRecord[];
}

/** How many same-purpose moves the swap list offers. */
export const SAME_PURPOSE = 4;

const byName = new Intl.Collator("en");

/** Every library move the document names (items and alternates). */
function namedIn(doc: WorkoutDoc, find: (id: string) => ExerciseRecord | undefined): Set<string> {
  const ids = doc.parts.flatMap((p) => p.items.flatMap((i) => (i.kind === "exercise" ? [i.libraryId, ...(i.alternates ?? []).map((a) => a.libraryId)] : [])));
  return new Set(ids.map((id) => find(id)?.id ?? id));
}

export function swapOptions(item: WorkoutItem, rec: ExerciseRecord, doc: WorkoutDoc, library: Library, bc: BuildCtx): SwapOptions {
  const find = makeLibraryIndex(library);
  const inDoc = namedIn(doc, find);
  const seen = new Set<string>([rec.id]);
  const take = (ids: readonly string[], skipDoc: boolean): ExerciseRecord[] =>
    ids.flatMap((id) => {
      const r = find(id);
      // Never a move the athlete set aside ("not for me"), in any of the lists.
      if (!r || seen.has(r.id) || (skipDoc && inDoc.has(r.id)) || bc.excluded.includes(r.id)) return [];
      seen.add(r.id);
      return [r];
    });
  const alternates = take(item.kind === "exercise" ? (item.alternates ?? []).map((a) => a.libraryId) : [], false);
  const easier = take(rec.easier, true);
  const harder = take(rec.harder, true);
  const purpose = rec.purposes[0];
  const shared = (r: ExerciseRecord) => ({
    patterns: r.patterns.filter((p) => rec.patterns.includes(p)).length,
    regions: r.regions.filter((g) => rec.regions.includes(g)).length,
  });
  const same = library
    .filter(
      (r) =>
        !seen.has(r.id) &&
        !inDoc.has(r.id) &&
        purpose !== undefined &&
        r.purposes.includes(purpose) &&
        isPlyometric(r) === isPlyometric(rec) &&
        !bc.excluded.includes(r.id) &&
        (bc.equipment === null || hasEquipment(r, bc.equipment)) &&
        (shared(r).patterns > 0 || shared(r).regions > 0),
    )
    .sort((a, b) => {
      const sa = shared(a);
      const sb = shared(b);
      return (
        sb.patterns - sa.patterns ||
        sb.regions - sa.regions ||
        Math.abs(a.difficulty - rec.difficulty) - Math.abs(b.difficulty - rec.difficulty) ||
        byName.compare(a.name, b.name)
      );
    })
    .slice(0, SAME_PURPOSE);
  return { alternates, easier, harder, same };
}

// ── Parts ──────────────────────────────────────────────────────────────────

/** The parts the builder offers to add, in a workout's order (a run is not planned in the Studio yet). */
const OFFERED: readonly PartPurpose[] = ["warmup", "activation", "power", "main", "accessory", "conditioning", "care", "cooldown"];

export function addablePurposes(doc: WorkoutDoc, profiles: readonly ConditionProfile[]): PartPurpose[] {
  const have = new Set(doc.parts.map((p) => p.purpose));
  const care = profiles.some((p) => p.care !== null);
  return OFFERED.filter((p) => !have.has(p) && (p !== "care" || care));
}

/** Parts whose lifts load the prime movers. */
const LOADING_PARTS = new Set<PartPurpose>(["main", "power", "accessory"]);
const isLift = (r: ExerciseRecord): boolean => !isPlyometric(r) && r.purposes.some((p) => p === "strength" || p === "power");

/** Where a part of this purpose goes: before the first part that sits later in a workout's order. */
export function orderedAt(doc: WorkoutDoc, purpose: PartPurpose): number {
  const rank = PART_ORDER.indexOf(purpose);
  const at = doc.parts.findIndex((p) => PART_ORDER.indexOf(p.purpose) > rank);
  return at < 0 ? doc.parts.length : at;
}

/**
 * Activate before loading (principles §2.1, §2.5): once a part loads a lift and the workout has no activation part,
 * where one would go; else null.
 */
export function activationAt(doc: WorkoutDoc, library: Library = EXERCISES): number | null {
  if (doc.parts.some((p) => p.purpose === "activation")) return null;
  const find = makeLibraryIndex(library);
  const loads = doc.parts.some((p) => LOADING_PARTS.has(p.purpose) && p.items.some((i) => i.kind === "exercise" && isLift(find(i.libraryId) ?? NO_MOVE)));
  return loads ? orderedAt(doc, "activation") : null;
}
const NO_MOVE = { purposes: [], contraction: [], patterns: [] } as unknown as ExerciseRecord;

/** The document with an empty part of this purpose at `at`: what a part not yet made would suggest. */
export function withPart(doc: WorkoutDoc, at: number, purpose: PartPurpose): WorkoutDoc {
  return { ...doc, parts: [...doc.parts.slice(0, at), { purpose, format: "straight", items: [] }, ...doc.parts.slice(at)] };
}

/** Parts the Studio prompts for (spec §8: warm-ups and cool-downs, activation, care): they suggest until they hold three. */
const PROMPTED = new Set<PartPurpose>(["warmup", "activation", "cooldown", "care"]);
export const PROMPT_UNTIL = 3;

export function showsSuggestions(part: WorkoutPart): boolean {
  return part.items.length === 0 || (PROMPTED.has(part.purpose) && part.items.length < PROMPT_UNTIL);
}

/** Up or down one place — across into the neighbouring part at a part's edge; null where there is nowhere to go. */
export function moveTarget(doc: WorkoutDoc, part: number, item: number, dir: 1 | -1): { from: [number, number]; to: [number, number] } | null {
  const p = doc.parts[part];
  if (!p || !p.items[item]) return null;
  const to = item + dir;
  if (to >= 0 && to < p.items.length) return { from: [part, item], to: [part, to] };
  const next = part + dir;
  const q = doc.parts[next];
  if (!q) return null;
  return { from: [part, item], to: [next, dir < 0 ? q.items.length : 0] };
}

/** The library purpose a part's moves are browsed by, where one stands for it. */
export function browsePurposeOf(purpose: PartPurpose): ExerciseRecord["purposes"][number] | undefined {
  switch (purpose) {
    case "warmup":
      return "warmup";
    case "activation":
      return "activation";
    case "main":
      return "strength";
    case "power":
      return "power";
    case "conditioning":
      return "conditioning";
    case "care":
      return "condition-care";
    default:
      return undefined;
  }
}

// ── Scheduling ─────────────────────────────────────────────────────────────

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
const hhmm = (mins: number): string => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
const isWeekend = (date: string): boolean => {
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  return dow === 0 || dow === 6;
};

/** The device's time of day, "HH:MM". */
export const nowHHMM = (now: Date): string => hhmm(now.getHours() * 60 + now.getMinutes());

/** How far ahead "Later today" must be, in minutes: a slot that soon is now, not later. */
export const LATER_LEAD_MIN = 15;

/**
 * The athlete's usual time to train on a day, "HH:MM": the window the server places an untimed workout in (the evening
 * when that is their default, else the morning — a weekend's own); null when unknown.
 */
export function usualTime(prefs: SchedulingPreferences | null, date: string): string | null {
  if (!prefs) return null;
  const t = prefs.defaultWindow === "evening" ? prefs.weekdayEveningTime : isWeekend(date) ? prefs.weekendMorningTime : prefs.weekdayMorningTime;
  return /^\d{2}:\d{2}$/.test(t) ? t : null;
}

/**
 * "Later today": the athlete's usual time to train (the window a planned session takes) while it is at least
 * `LATER_LEAD_MIN` ahead, else the next whole hour and one more — so long as a workout of `minutes` started then
 * finishes by their latest evening finish (Settings); null when no such slot is left today.
 */
export function laterToday(now: Date, prefs: SchedulingPreferences | null, today: string, minutes = 0): string | null {
  const mins = now.getHours() * 60 + now.getMinutes();
  const finish = prefs && /^\d{2}:\d{2}$/.test(prefs.latestEveningFinish) ? minutesOf(prefs.latestEveningFinish) : 24 * 60;
  const fits = (start: number) => start < 24 * 60 && start + minutes <= finish;
  const usual = usualTime(prefs, today);
  if (usual !== null && minutesOf(usual) >= mins + LATER_LEAD_MIN && fits(minutesOf(usual))) return usual;
  const next = (Math.floor(mins / 60) + 2) * 60;
  return fits(next) ? hhmm(next) : null;
}

/** Whether "HH:MM" today is already past at `now` (a time chosen for today must be ahead). */
export const timeHasPassed = (time: string, now: Date): boolean => minutesOf(time) <= now.getHours() * 60 + now.getMinutes();

/**
 * Why a planned workout opens read-only — the rule `editableWorkout` keeps (done, skipped, missed, under way, gone, its
 * day passed) in plain words — or null when it can be changed.
 */
export function readOnlyWhy(w: WorkoutDto, today: string): string | null {
  const why = readOnlyOf(w, today);
  return why ? READ_ONLY_WORDS[why] : null;
}
type ReadOnly = "gone" | "done" | "skipped" | "missed" | "underWay" | "past";
const READ_ONLY_WORDS: Readonly<Record<ReadOnly, string>> = {
  gone: "This workout is no longer in the plan, so it can't be changed.",
  done: "This workout is done, so it can't be changed.",
  skipped: "This workout was skipped, so it can't be changed.",
  missed: "This workout was missed, so it can't be changed.",
  underWay: "This workout is under way, so it can't be changed.",
  past: "This workout's day has passed, so it can't be changed.",
};
function readOnlyOf(w: WorkoutDto, today: string): ReadOnly | null {
  if (w.archived) return "gone";
  if (w.completionState === "completed" || w.contentState === "done") return "done";
  if (w.completionState === "skipped") return "skipped";
  if (w.completionState === "missed") return "missed";
  if (w.contentState === "started") return "underWay";
  if (w.effectiveDate < today) return "past";
  return null;
}

/**
 * The day a planned workout is judged for: `date` (its own, with today's readings for today) while it can still be
 * done — editable, or under way today — and none once it is done with (done, skipped, missed, gone, or its day passed):
 * today's reading says nothing of another day, so only the static rules speak.
 */
export function judgeDayOf(w: WorkoutDto | undefined, today: string, date: string): string | null {
  if (!w) return date;
  const why = readOnlyOf(w, today);
  return why === null || (why === "underWay" && w.effectiveDate === today) ? date : null;
}

/** What the actions say while Start is off: the reason itself when no note shows it, else where to look. */
export function blockedLine(j: Judged): string | null {
  if (!j.blocked) return null;
  if (j.blocked === EMPTY_BLOCK) return EMPTY_BLOCK;
  const n = j.notes.filter((x) => x.severity === "error" && x.check === null).length;
  return n <= 1 ? "Fix the note above to start." : `Fix the ${n} notes above to start.`;
}

/** The document as it is scheduled or started: a template's says it is based on the template. */
export function forSchedule(doc: WorkoutDoc, source: BuildSource): WorkoutDoc {
  return source.kind === "template" ? { ...doc, basedOn: { kind: "template", id: source.id } } : doc;
}

/** A profile as the check sheet shows it (its own words), unanswered. */
export function checkViewOf(p: ConditionProfile): ConditionViewDto & { today: null } {
  return { profileId: p.id, check: { label: p.check.label, min: p.check.min, max: p.check.max }, care: p.care?.block.label ?? null, today: null };
}
