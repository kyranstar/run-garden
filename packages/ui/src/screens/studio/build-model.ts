/**
 * THE BUILDER'S DECISIONS, PURE (Stage 2 spec §8; principles §2.1–§2.8, §7). Everything the builder decides that needs
 * no React, so each rule is a test and the screen only draws:
 *
 *   sourceOfPath     where the builder is: a new workout (the draft on this device), a quick start (built on the
 *                    device for the day, kept nowhere until it is started, scheduled or saved), a template, a planned
 *                    workout.
 *   buildCtxOf       what it judges and suggests with: the switched-on profiles and today's readings (joined by any
 *                    this page recorded), the athlete's set-aside, pinned and recent moves, the place's gear, and what
 *                    was done cleanly — by the library's one rule (`isDoneCleanly`), and only where this device can
 *                    apply it: the library read carries when a move was last done, not the flags a profile sets on a
 *                    rung (TMJ's "clenched"), so while such a profile is on it claims no frontier at all and the
 *                    server, which has the flags, judges the jumps on Schedule and Start.
 *   judgeDraft       the notes: the validator on the draft as it would be saved (`toProposable`), each note put back on
 *                    the draft's own part and item (empty parts and all), with its Fix as an editor action, and — for an
 *                    error today's check could answer — the profile whose check to ask for. What blocks Start and
 *                    Schedule, in plain words: an empty workout, or the first error no check could answer. Warnings
 *                    are costs, never blocks.
 *   balanceRows …    the summary's numbers; a dose in words; the item sheet's steppers and load; the swap list; the
 *                    parts on offer; where activation belongs once the main part loads a lift; "Later today".
 */
import {
  formatWeight,
  parseWeight,
  secondsText,
  toKg,
  type SchedulingPreferences,
  type WeightUnit,
  type WorkoutDoc,
  type WorkoutDose,
  type WorkoutItem,
  type WorkoutPart,
} from "@rg/domain";
import {
  bestDay,
  EXERCISES,
  hasEquipment,
  isDoneCleanly,
  isPlyometric,
  label,
  type CheckReading,
  type ConditionProfile,
  type ExerciseRecord,
} from "@rg/exercise-library";
import {
  deriveDoc,
  makeLibraryIndex,
  PART_ORDER,
  QUICK_START_KINDS,
  toProposable,
  validateWorkoutDoc,
  type BalanceProfile,
  type DayContext,
  type DocDerived,
  type DocIssue,
  type DraftDoc,
  type EditAction,
  type QuickStartKind,
  type SuggestCtx,
} from "@rg/workout";
import type { ConditionViewDto } from "@rg/api-client";
import type { StudioCtx } from "./model.js";

type PartPurpose = WorkoutPart["purpose"];
type Library = readonly ExerciseRecord[];

// ── Where the builder is ───────────────────────────────────────────────────

export type BuildSource =
  | { kind: "new" }
  | { kind: "quick"; quick: QuickStartKind }
  | { kind: "template"; id: string }
  | { kind: "workout"; id: string };

/**
 * The builder's address (spec §2): `/studio/build/new`, `…/quick/:kind` (a quick start, spec §9), `…/template/:id`,
 * `…/workout/:workoutId`; anything else, null.
 */
export function sourceOfPath(pathname: string): BuildSource | null {
  if (/^\/studio\/build\/new\/?$/.test(pathname)) return { kind: "new" };
  const q = /^\/studio\/build\/quick\/([^/]+)\/?$/.exec(pathname);
  if (q) {
    const quick = QUICK_START_KINDS.find((k) => k === q[1]);
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
  /** Done cleanly (`isDoneCleanly`); undefined when this device cannot tell. */
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
  // A profile that flags a rung (a clenched set unlocks nothing) needs flag tallies the library read does not carry.
  const canTell = prefs.length > 0 && !ctx.profiles.some((p) => p.setFlag !== null);
  const done = canTell
    ? new Set(prefs.filter(([, p]) => isDoneCleanly({ lastDate: p.lastDoneOn, logged: 0, flags: {} }, ctx.profiles)).map(([id]) => id))
    : undefined;
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

export function judgeDraft(draft: DraftDoc, bc: BuildCtx, date: string, library: Library = EXERCISES): Judged {
  const doc = toProposable(draft);
  if (!doc) return { doc: null, derived: null, notes: [], blocked: EMPTY_BLOCK, checks: [] };
  const vctx = (readings: BuildCtx["readings"]) => ({
    library,
    activeProfiles: bc.profiles,
    day: { ...dayFor(bc, date), readings },
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

export type AmountKind = "reps" | "hold" | "breaths" | "distance";

/** The dose's own amount; with none, the move's way of counting. */
export function amountKind(dose: WorkoutDose, rec?: ExerciseRecord): AmountKind {
  if (dose.holdSec !== undefined) return "hold";
  if (dose.breaths !== undefined) return "breaths";
  if (dose.reps !== undefined) return "reps";
  if (dose.carryM !== undefined) return "distance";
  const t = rec?.dose.type;
  return t === "time" || t === "carry" ? "hold" : t === "breaths" ? "breaths" : "reps";
}

/** The amount as a stepper's field holds it: a bare number (a hold in seconds, a carry in metres), or a rep range. */
export function amountValue(dose: WorkoutDose, kind: AmountKind): string {
  switch (kind) {
    case "hold":
      return dose.holdSec !== undefined ? String(dose.holdSec) : "";
    case "breaths":
      return dose.breaths !== undefined ? String(dose.breaths) : "";
    case "distance":
      return dose.carryM !== undefined ? String(dose.carryM) : "";
    case "reps":
      return typeof dose.reps === "number" ? String(dose.reps) : dose.reps ? `${dose.reps.min}–${dose.reps.max}` : "";
  }
}

/** The amount in words: "8", "8–12", "45 s", "6", "40 m". */
export function amountText(dose: WorkoutDose, kind: AmountKind): string {
  const v = amountValue(dose, kind);
  if (!v) return "";
  return kind === "hold" ? secondsText(dose.holdSec!) : kind === "distance" ? `${v} m` : v;
}

/** "3 × 8 · 25 lb", "10 reps", "30 s each side", "6 breaths". */
export function doseSummary(dose: WorkoutDose): string {
  const kind = amountKind(dose);
  const amount = amountText(dose, kind);
  const sets = dose.sets ?? 1;
  const unit = kind === "breaths" ? " breaths" : kind === "reps" && sets <= 1 && amount ? " reps" : "";
  const body = `${sets > 1 && amount ? `${sets} × ` : ""}${amount}${unit}`;
  const max = dose.max ? `${body ? ", " : ""}to max` : "";
  const sides = dose.perSide ? " each side" : "";
  const load = dose.load && dose.load !== "bodyweight" ? ` · ${dose.load.typed}` : "";
  return `${body}${max}${sides}${load}`;
}

const clampInt = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(n)));
/** The schema's bounds. */
const MAX_SETS = 20;
const MAX_REPS = 200;
const MAX_HOLD = 3600;
const MIN_HOLD = 5;

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

/** A typed amount: a whole number ("12"), or for reps a range ("8-12"); null when it is neither. */
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
  const n = whole(t.replace(/\s*(s|sec|m)$/i, ""), kind === "hold" ? MAX_HOLD : kind === "distance" ? 5000 : MAX_REPS);
  if (n === null) return null;
  return kind === "hold" ? { ...dose, holdSec: n } : kind === "breaths" ? { ...dose, breaths: n } : { ...dose, carryM: n };
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
      if (!r || seen.has(r.id) || (skipDoc && inDoc.has(r.id))) return [];
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

/**
 * "Later today": the athlete's usual time to train (the window a planned session takes) while it is still ahead, else
 * the next whole hour and one more; null when that would run past the day.
 */
export function laterToday(now: Date, prefs: SchedulingPreferences | null, today: string): string | null {
  const mins = now.getHours() * 60 + now.getMinutes();
  if (prefs) {
    const usual = prefs.defaultWindow === "evening" ? prefs.weekdayEveningTime : isWeekend(today) ? prefs.weekendMorningTime : prefs.weekdayMorningTime;
    if (/^\d{2}:\d{2}$/.test(usual) && minutesOf(usual) > mins) return usual;
  }
  const next = (Math.floor(mins / 60) + 2) * 60;
  return next < 24 * 60 ? hhmm(next) : null;
}

/** The document as it is scheduled or started: a template's says it is based on the template. */
export function forSchedule(doc: WorkoutDoc, source: BuildSource): WorkoutDoc {
  return source.kind === "template" ? { ...doc, basedOn: { kind: "template", id: source.id } } : doc;
}

/** A profile as the check sheet shows it (its own words), unanswered. */
export function checkViewOf(p: ConditionProfile): ConditionViewDto & { today: null } {
  return { profileId: p.id, check: { label: p.check.label, min: p.check.min, max: p.check.max }, care: p.care?.block.label ?? null, today: null };
}
