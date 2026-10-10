/**
 * Validation of a workout document (programme spec §3.2; principles §2.7–§2.8): the one deterministic checker every
 * workout from every source (the engine, the coach, the Studio, templates, imports) passes through. Pure.
 *
 * RULES
 * - Schema first: a document outside `workoutDocSchema` returns only `bounds` errors (one per schema issue, at its
 *   path); nothing else can be read safely from it.
 * - The day decides how the condition rules read (Amendment A): `day: null` (a template, a library context) judges every
 *   reading-dependent rule on each profile's calmest day — "does this fit the workout's mode at all"; a `day` whose
 *   `date` is after its `today` is a future day (that day's check is unknown); any other day uses `day.readings`, and
 *   a missing or null reading is unanswered — and unanswered means not allowed: a move a reading can close must pass
 *   both unanswered and at the profile's worst reading.
 * - The workout's mode is `modeOfEffort(intent.effort)`. Every active profile is read through its contract only
 *   (`never`, `fitsMode`, `fitsFormat`, `allowPattern` per pattern, `allowRecord`, `flareSafe`, `flare`,
 *   `recoveryReason`, `buildChecks`) — this file never names a profile. A record with no rating for an active profile
 *   fails closed (as the engine's eligibility does).
 * - Document format → the profile's format: straight, superset, circuit, ladder, flow and holds as themselves;
 *   intervals as circuit; steady as straight.
 * - Errors block a save, a proposal and a watch push; warnings are costs shown to the athlete.
 * - Paths are the document's own ("intent.focus[2]", "parts[1].items[0].libraryId"). `fix`, when present, is a
 *   replacement for the value at `path`: a library id to swap in, a region / muscle / equipment id, a format, an
 *   effort, or (for a dose) the whole dose as JSON. Messages are plain words for the athlete.
 *
 * CODES (severity)
 * - bounds (error): outside the schema.
 * - unknown_exercise (error): an item's or an alternate's library id resolves to nothing; `fix` is a library id whose
 *   spelling matches once case and separators are ignored.
 * - legacy_id (warning): an old id (resolved through `legacyIds`); `fix` is the current id.
 * - condition_never (error): a profile's `never`, or no rating for an active profile — items and alternates alike.
 * - condition_pattern (error): `allowPattern` refuses one of the record's patterns for this mode and the day.
 * - condition_gate (error): `allowRecord` refuses the record for this mode and the day.
 * - condition_gate_pending (warning, or error): a future day, and a pattern or record rule the day's reading could close;
 *   a warning only when the item carries an alternate that passes in recovery mode, unanswered and at the worst reading.
 * - condition_mode (warning): `fitsMode` is false for the workout's mode.
 * - condition_format (warning): `fitsFormat` is false for the part's format.
 * - condition_flare (warning): today's reading is a flare (`flare`) and the move is not `flareSafe`.
 * - mode_above_day (warning, at intent.effort): on the day, a profile's `recoveryReason` (for a workout above recovery)
 *   or its first failed `buildChecks` line (for a build workout) — the profile's own words; `fix` is the effort it allows.
 * - excluded_by_athlete (warning): the athlete set the move aside (`excluded`, legacy ids honoured).
 * - equipment_unavailable (warning): the move needs gear `equipment` (the place's) lacks.
 * - format_mismatch: a superset needs exactly two exercises (error); a circuit holds 3–6 moves (warning: the engine's
 *   own builds must validate clean); intervals need a run or a timed move (error).
 * - dose_mismatch (warning): an exercise with no amount (none of reps, holdSec, breaths, carryM, max); reps on a timed
 *   move; seconds on a counted move outside a timed format (circuit, intervals, flow, holds). `fix` is the dose to use.
 * - unknown_focus (warning): a focus id that is neither a region nor a muscle.
 * - unknown_equipment (warning): a `setting.equipment` id the library does not know.
 * Not checked here: `test.keyResultId` and `intent.objectiveIds` (opaque without the database).
 *
 * FIXES for the condition, athlete and place codes: the item's alternates first, then its easier variants (three steps
 * down), the first one that raises none of those issues here; for condition_gate_pending, the first that passes in
 * recovery mode.
 */
import { workoutDocSchema, type WorkoutDoc, type WorkoutDose, type WorkoutItem, type WorkoutPart } from "@rg/domain";
import {
  EQUIPMENT,
  EQUIPMENT_IDS,
  MODES,
  MUSCLES,
  REGIONS,
  UNANSWERED,
  attrsOf,
  bestDay,
  hasEquipment,
  label,
  type CheckReading,
  type ConditionProfile,
  type ExerciseRecord,
  type FormatId,
  type HistorySession,
  type Mode,
  type ProposalCtx,
} from "@rg/exercise-library";
import { makeLibraryIndex, modeOfEffort } from "./derive.js";

export const DOC_ISSUE_CODES = [
  "bounds",
  "unknown_exercise",
  "legacy_id",
  "condition_never",
  "condition_pattern",
  "condition_gate",
  "condition_gate_pending",
  "condition_mode",
  "condition_format",
  "condition_flare",
  "mode_above_day",
  "excluded_by_athlete",
  "equipment_unavailable",
  "format_mismatch",
  "dose_mismatch",
  "unknown_focus",
  "unknown_equipment",
] as const;
export type DocIssueCode = (typeof DOC_ISSUE_CODES)[number];

export interface DocIssue {
  /** Where in the document: "title", "intent.focus[2]", "parts[1].format", "parts[1].items[0].libraryId". */
  path: string;
  code: DocIssueCode;
  /** Plain words for the athlete. */
  message: string;
  /** A replacement for the value at `path` (a library id, a vocabulary id, a format, an effort, or a dose as JSON). */
  fix?: string;
  severity: "error" | "warning";
}

/** The day a workout is checked for (Amendment A). */
export interface DayContext {
  /** The workout's date, "YYYY-MM-DD". */
  date: string;
  /** The athlete's today, "YYYY-MM-DD". A `date` after it is a future day. */
  today: string;
  /** The day's check per profile id; null (or absent) is unanswered. */
  readings: Readonly<Record<string, CheckReading | null>>;
  /** Recent sessions, for the profiles' mode rules. */
  recent?: { last: HistorySession | null; week: readonly HistorySession[] };
}

export interface ValidateCtx {
  library: readonly ExerciseRecord[];
  activeProfiles: readonly ConditionProfile[];
  /** null only for templates and library contexts. */
  day: DayContext | null;
  /** Moves the athlete set aside ("not for me"). */
  excluded?: readonly string[];
  /** The place's equipment; absent: not checked. */
  equipment?: readonly string[];
}

type Part = WorkoutPart;
type DocFormat = Part["format"];
type Exercise = Extract<WorkoutItem, { kind: "exercise" }>;
type Phase = "any" | "today" | "future";

const FORMAT_RULE: Record<DocFormat, FormatId> = {
  straight: "straight", superset: "superset", circuit: "circuit", flow: "flow", intervals: "circuit", steady: "straight", ladder: "ladder", holds: "holds",
};
const FORMAT_WORDS: Record<DocFormat, string> = {
  straight: "straight sets", superset: "a superset", circuit: "a circuit", flow: "a flow", intervals: "intervals", steady: "a steady effort", ladder: "a ladder", holds: "holds",
};
/** Formats whose work is a timed window: seconds of a counted move are their way, not a mismatch. */
const TIMED_FORMATS = new Set<DocFormat>(["circuit", "intervals", "flow", "holds"]);
const CIRCUIT_MIN = 3;
const CIRCUIT_MAX = 6;
/** How far down the easier variants a fix looks. */
const EASIER_DEPTH = 3;

/** Case and separators ignored: "goblet-squat", "Goblet squat" and "gobletSquat" read alike. */
const keyOf = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A lookup by loose spelling (ids and labels), with a trailing plural "s" forgiven. */
function guesser(pairs: ReadonlyArray<readonly [string, string]>): (s: string) => string | undefined {
  const by = new Map<string, string>();
  for (const [text, id] of pairs) if (!by.has(keyOf(text))) by.set(keyOf(text), id);
  return (s) => {
    const k = keyOf(s);
    return by.get(k) ?? (k.endsWith("s") ? by.get(k.slice(0, -1)) : undefined);
  };
}

const FOCUS_IDS = new Set<string>([...REGIONS, ...MUSCLES]);
const guessFocus = guesser([...FOCUS_IDS].flatMap((id) => [[id, id], [label(id), id]] as const));
const EQUIPMENT_SET = new Set<string>(EQUIPMENT_IDS);
const guessEquipment = guesser(EQUIPMENT_IDS.flatMap((id) => [[id, id], [EQUIPMENT[id], id]] as const));

const modeWord = (m: Mode): string => (MODES[m]?.label ?? m).toLowerCase();
const worstDay = (p: ConditionProfile): CheckReading => ({ pre: p.check.max, post: p.check.max, feelingOff: true });
const patternOk = (p: ConditionProfile, rec: ExerciseRecord, mode: Mode, r: CheckReading): boolean => rec.patterns.every((pt) => p.allowPattern(pt, mode, r));
const recordOk = (p: ConditionProfile, rec: ExerciseRecord, mode: Mode, r: CheckReading): boolean => !p.allowRecord || p.allowRecord(rec, mode, r);

function pathOf(segments: ReadonlyArray<string | number>): string {
  return segments.reduce<string>((acc, s) => (typeof s === "number" ? `${acc}[${s}]` : acc ? `${acc}.${s}` : s), "");
}

/** Why a pattern or record rule refuses a move. */
interface GateFail {
  rule: "pattern" | "record";
  /** mode: no reading opens it in this mode; today: today's check (or its absence); pending: a future day's check. */
  why: "mode" | "today" | "pending";
}

export function validateWorkoutDoc(input: WorkoutDoc, ctx: ValidateCtx): DocIssue[] {
  const parsed = workoutDocSchema.safeParse(input);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => ({ path: pathOf(i.path), code: "bounds", message: `This doesn't fit a workout: ${i.message}.`, severity: "error" }));
  }
  const doc = parsed.data;
  const find = makeLibraryIndex(ctx.library);
  const profiles = ctx.activeProfiles;
  const day = ctx.day;
  const phase: Phase = !day ? "any" : day.date > day.today ? "future" : "today";
  const mode = modeOfEffort(doc.intent.effort);
  const excluded = new Set((ctx.excluded ?? []).map((id) => find(id)?.id ?? id));
  const equipment = ctx.equipment;
  const guessExercise = guesser(ctx.library.flatMap((e) => [[e.id, e.id], [e.name, e.id]] as const));
  const issues: DocIssue[] = [];
  /** Records an issue; a fix that came out undefined is left off. */
  const add = (issue: DocIssue): void => {
    const { fix, ...rest } = issue;
    issues.push(fix === undefined ? rest : issue);
  };

  /** Today's reading for a profile (null: unanswered); only on a day that is not in the future. */
  const readingOf = (p: ConditionProfile): CheckReading | null => (phase === "today" ? day!.readings[p.id] ?? null : null);
  const flareToday = (p: ConditionProfile): CheckReading | null => {
    const r = readingOf(p);
    return r && p.flare(r) ? r : null;
  };

  /** A pattern or record rule that refuses the move here, for this profile. */
  function gate(p: ConditionProfile, rec: ExerciseRecord, m: Mode): GateFail | null {
    const best = bestDay(p);
    if (!patternOk(p, rec, m, best)) return { rule: "pattern", why: "mode" };
    if (!recordOk(p, rec, m, best)) return { rule: "record", why: "mode" };
    if (phase === "any") return null;
    const r = readingOf(p);
    const why: GateFail["why"] = phase === "future" ? "pending" : "today";
    for (const t of r ? [r] : [UNANSWERED, worstDay(p)]) {
      if (!patternOk(p, rec, m, t)) return { rule: "pattern", why };
      if (!recordOk(p, rec, m, t)) return { rule: "record", why };
    }
    return null;
  }

  /** Passes in recovery mode whatever the day's check reads: what a future day's gated move needs as its alternate. */
  const passesRecovery = (rec: ExerciseRecord): boolean =>
    profiles.every((p) => {
      const a = attrsOf(rec, p);
      if (!a || p.never(a) || !p.fitsMode(a, "recovery")) return false;
      return [bestDay(p), UNANSWERED, worstDay(p)].every((r) => patternOk(p, rec, "recovery", r) && recordOk(p, rec, "recovery", r));
    });

  /** Raises none of the condition, athlete or place issues here: a fix to offer. */
  const fitsHere = (rec: ExerciseRecord, format: DocFormat): boolean =>
    !excluded.has(rec.id) &&
    (!equipment || hasEquipment(rec, equipment)) &&
    profiles.every((p) => {
      const a = attrsOf(rec, p);
      if (!a || p.never(a) || !p.fitsMode(a, mode) || !p.fitsFormat(a, FORMAT_RULE[format])) return false;
      if (gate(p, rec, mode)) return false;
      return !flareToday(p) || p.flareSafe(a);
    });

  /** The item's alternates, then its easier variants: what a fix may offer. */
  function candidates(rec: ExerciseRecord, item: Exercise): ExerciseRecord[] {
    const seen = new Set([rec.id]);
    const out: ExerciseRecord[] = [];
    const take = (id: string): ExerciseRecord | null => {
      const r = find(id);
      if (!r || seen.has(r.id)) return null;
      seen.add(r.id);
      out.push(r);
      return r;
    };
    for (const a of item.alternates ?? []) take(a.libraryId);
    let frontier = [...rec.easier];
    for (let depth = 0; depth < EASIER_DEPTH && frontier.length; depth++) {
      const next: string[] = [];
      for (const id of frontier) next.push(...(take(id)?.easier ?? []));
      frontier = next;
    }
    return out;
  }
  const fixAmong = (list: readonly ExerciseRecord[], ok: (r: ExerciseRecord) => boolean): string | undefined => list.find(ok)?.id;

  // ── Intent and setting ──
  doc.intent.focus.forEach((id, i) => {
    if (FOCUS_IDS.has(id)) return;
    add({ path: `intent.focus[${i}]`, code: "unknown_focus", message: `"${id}" isn't a body area or muscle the library knows.`, fix: guessFocus(id), severity: "warning" });
  });
  (doc.setting?.equipment ?? []).forEach((id, i) => {
    if (EQUIPMENT_SET.has(id)) return;
    add({ path: `setting.equipment[${i}]`, code: "unknown_equipment", message: `"${id}" isn't equipment the library knows.`, fix: guessEquipment(id), severity: "warning" });
  });

  // ── The day's mode, in each profile's own words ──
  if (phase === "today" && mode !== "recovery") {
    const last = day!.recent?.last ?? null;
    const week = day!.recent?.week ?? [];
    const byId = new Map<string, HistorySession>();
    for (const s of [...week, ...(last ? [last] : [])]) if (s.date <= day!.date) byId.set(s.id, s);
    const past = [...byId.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    for (const p of profiles) {
      const pctx: ProposalCtx = { today: day!.date, reading: readingOf(p) ?? UNANSWERED, past, last, week };
      const why = p.recoveryReason(pctx);
      if (why) {
        add({ path: "intent.effort", code: "mode_above_day", message: why, fix: "recover", severity: "warning" });
        continue;
      }
      if (mode !== "build") continue;
      const failed = p.buildChecks(pctx).find(([ok]) => !ok);
      if (failed) add({ path: "intent.effort", code: "mode_above_day", message: failed[1], fix: "maintain", severity: "warning" });
    }
  }

  // ── Parts ──
  doc.parts.forEach((part, pi) => {
    const at = `parts[${pi}]`;
    checkFormat(part, at);
    part.items.forEach((item, ii) => {
      const itemAt = `${at}.items[${ii}]`;
      if (item.kind === "exercise") checkExercise(item, part, itemAt);
      else if (item.kind === "free_exercise" && !hasAmount(item.dose)) {
        add({ path: `${itemAt}.dose`, code: "dose_mismatch", message: `${item.name} has no amount: give it reps, seconds, breaths or a distance.`, severity: "warning" });
      }
    });
  });

  function checkFormat(part: Part, at: string): void {
    const moves = part.items.filter((i) => i.kind === "exercise" || i.kind === "free_exercise").length;
    const runs = part.items.filter((i) => i.kind === "run").length;
    const path = `${at}.format`;
    if (part.format === "superset" && (moves !== 2 || runs > 0)) {
      const n = moves + runs;
      add({ path, code: "format_mismatch", message: `A superset pairs exactly two moves; this one has ${n}.`, fix: n === 1 ? "straight" : n >= CIRCUIT_MIN && n <= CIRCUIT_MAX ? "circuit" : undefined, severity: "error" });
    }
    if (part.format === "circuit" && (moves + runs < CIRCUIT_MIN || moves + runs > CIRCUIT_MAX)) {
      const n = moves + runs;
      add({ path, code: "format_mismatch", message: `A circuit works best with ${CIRCUIT_MIN} to ${CIRCUIT_MAX} moves; this one has ${n}.`, fix: n === 1 ? "straight" : n === 2 ? "superset" : undefined, severity: "warning" });
    }
    if (part.format === "intervals") {
      const timed = part.items.some((i) => i.kind === "run" || ((i.kind === "exercise" || i.kind === "free_exercise") && i.dose.holdSec !== undefined));
      if (!timed) {
        add({ path, code: "format_mismatch", message: "Intervals need a run or a timed move; this part has neither.", fix: moves >= CIRCUIT_MIN && moves <= CIRCUIT_MAX ? "circuit" : "straight", severity: "error" });
      }
    }
  }

  function checkExercise(item: Exercise, part: Part, at: string): void {
    const idAt = `${at}.libraryId`;
    const rec = find(item.libraryId);
    if (!rec) {
      add({ path: idAt, code: "unknown_exercise", message: `There's no move "${item.libraryId}" in the library.`, fix: guessExercise(item.libraryId), severity: "error" });
      if (!hasAmount(item.dose)) add({ path: `${at}.dose`, code: "dose_mismatch", message: `"${item.libraryId}" has no amount: give it reps, seconds, breaths or a distance.`, severity: "warning" });
      return;
    }
    if (rec.id !== item.libraryId) add({ path: idAt, code: "legacy_id", message: `"${item.libraryId}" is an old id for ${rec.name}.`, fix: rec.id, severity: "warning" });

    const name = rec.name;
    const options = candidates(rec, item);
    const alternates = (item.alternates ?? []).map((a) => find(a.libraryId)).filter((r): r is ExerciseRecord => r !== undefined && r.id !== rec.id);
    const better = (): string | undefined => fixAmong(options, (r) => fitsHere(r, part.format));
    for (const p of profiles) {
      const a = attrsOf(rec, p);
      if (!a) {
        add({ path: idAt, code: "condition_never", message: `${name} has no ${p.label} rating yet, so it can't be placed.`, fix: better(), severity: "error" });
        continue;
      }
      if (p.never(a)) {
        add({ path: idAt, code: "condition_never", message: `${name} is never allowed with ${p.label}.`, fix: better(), severity: "error" });
        continue;
      }
      if (!p.fitsMode(a, mode)) {
        add({ path: idAt, code: "condition_mode", message: `${name} is more than ${p.label} allows on a ${modeWord(mode)} day.`, fix: better(), severity: "warning" });
      }
      if (!p.fitsFormat(a, FORMAT_RULE[part.format])) {
        add({ path: idAt, code: "condition_format", message: `${name} doesn't suit ${FORMAT_WORDS[part.format]} with ${p.label}.`, fix: better(), severity: "warning" });
      }
      const g = gate(p, rec, mode);
      if (g && g.why === "pending") {
        const alternate = fixAmong(alternates, passesRecovery);
        if (alternate) {
          const altName = find(alternate)!.name;
          add({ path: idAt, code: "condition_gate_pending", message: `${name} depends on that day's ${p.check.label} check; if it isn't allowed then, swap in ${altName}.`, fix: alternate, severity: "warning" });
        } else {
          add({ path: idAt, code: "condition_gate_pending", message: `${name} depends on that day's ${p.check.label} check: add an alternate that suits a recovery day.`, fix: fixAmong(options, passesRecovery), severity: "error" });
        }
      } else if (g) {
        const code = g.rule === "pattern" ? "condition_pattern" : "condition_gate";
        const r = readingOf(p);
        const message =
          g.why === "mode" ? `${name} isn't allowed on a ${modeWord(mode)} day with ${p.label}.`
          : r?.feelingOff ? `${name} isn't allowed while you're feeling off.`
          : r && r.pre != null ? `${name} isn't allowed with today's ${p.check.label} check at ${r.pre}.`
          : `${name} needs today's ${p.check.label} check answered first.`;
        add({ path: idAt, code, message, fix: better(), severity: "error" });
      }
      const flare = flareToday(p);
      if (flare && !p.flareSafe(a)) {
        add({ path: idAt, code: "condition_flare", message: `${name} isn't flare-safe, and today's ${p.check.label} check is a flare.`, fix: better(), severity: "warning" });
      }
    }
    if (excluded.has(rec.id)) {
      add({ path: idAt, code: "excluded_by_athlete", message: `You set ${name} aside as not for you.`, fix: better(), severity: "warning" });
    }
    if (equipment && !hasEquipment(rec, equipment)) {
      add({ path: idAt, code: "equipment_unavailable", message: `${name} needs ${missingGear(rec, equipment)}, which this place doesn't have.`, fix: better(), severity: "warning" });
    }

    checkDose(rec, item.dose, part.format, at);

    (item.alternates ?? []).forEach((alt, ai) => {
      const altAt = `${at}.alternates[${ai}].libraryId`;
      const r = find(alt.libraryId);
      if (!r) {
        add({ path: altAt, code: "unknown_exercise", message: `There's no move "${alt.libraryId}" in the library.`, fix: guessExercise(alt.libraryId), severity: "error" });
        return;
      }
      if (r.id !== alt.libraryId) add({ path: altAt, code: "legacy_id", message: `"${alt.libraryId}" is an old id for ${r.name}.`, fix: r.id, severity: "warning" });
      for (const p of profiles) {
        const a = attrsOf(r, p);
        if (!a) add({ path: altAt, code: "condition_never", message: `${r.name} has no ${p.label} rating yet, so it can't be offered.`, severity: "error" });
        else if (p.never(a)) add({ path: altAt, code: "condition_never", message: `${r.name} is never allowed with ${p.label}.`, severity: "error" });
      }
    });
  }

  function checkDose(rec: ExerciseRecord, dose: WorkoutDose, format: DocFormat, at: string): void {
    const path = `${at}.dose`;
    const name = rec.name;
    if (!hasAmount(dose)) {
      add({ path, code: "dose_mismatch", message: `${name} has no amount: give it reps, seconds, breaths or a distance.`, fix: JSON.stringify({ ...dose, ...ownAmount(rec) }), severity: "warning" });
      return;
    }
    if (rec.dose.type === "time" && dose.reps !== undefined && dose.holdSec === undefined) {
      const { reps: _r, ...rest } = dose;
      add({ path, code: "dose_mismatch", message: `${name} is held for time, not counted in reps.`, fix: JSON.stringify({ ...rest, ...ownAmount(rec) }), severity: "warning" });
    } else if (rec.dose.type === "reps" && dose.holdSec !== undefined && dose.reps === undefined && !TIMED_FORMATS.has(format)) {
      const { holdSec: _h, ...rest } = dose;
      add({ path, code: "dose_mismatch", message: `${name} is counted in reps, not held for time.`, fix: JSON.stringify({ ...rest, ...ownAmount(rec) }), severity: "warning" });
    }
  }

  return issues;
}

function hasAmount(dose: WorkoutDose): boolean {
  return dose.reps !== undefined || dose.holdSec !== undefined || dose.breaths !== undefined || dose.carryM !== undefined || dose.max === true;
}

/** The record's own amount: its dose range's midpoint (reps keep the range). */
function ownAmount(rec: ExerciseRecord): Partial<WorkoutDose> {
  const [lo, hi] = rec.dose.range;
  const mid = Math.round((lo + hi) / 2);
  switch (rec.dose.type) {
    case "time":
      return { holdSec: mid };
    case "breaths":
      return { breaths: mid };
    case "carry":
      return { carryM: mid };
    default:
      return { reps: lo === hi ? lo : { min: lo, max: hi } };
  }
}

/** The gear a move needs that `have` lacks, in plain words. */
function missingGear(rec: ExerciseRecord, have: readonly string[]): string {
  const got = new Set(have);
  const word = (id: string): string => (EQUIPMENT as Readonly<Record<string, string>>)[id]?.toLowerCase() ?? id;
  const parts = rec.equipment.all.filter((id) => !got.has(id)).map(word);
  if (rec.equipment.oneOf.length && !rec.equipment.oneOf.some((id) => got.has(id))) parts.push(rec.equipment.oneOf.map(word).join(" or "));
  return parts.join(" and ");
}
