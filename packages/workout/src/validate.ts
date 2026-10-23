/**
 * Validation of a workout document (programme spec §3.2; principles §2.7–§2.8): the one deterministic checker every
 * workout from every source (the engine, the coach, the Studio, templates, imports) passes through. Pure.
 *
 * RULES
 * - Schema first: the input is anything (`unknown`); what does not parse as `workoutDocSchema` returns only `bounds`
 *   errors, one per schema issue at its path, in plain words; nothing else can be read safely from it.
 * - Size second (`docSize`): a document too large to build (past 600 derived minutes or 600 steps) returns only its
 *   `too_large` error — read from the document's numbers before anything is built or judged, so a hostile document
 *   costs a Worker one pass over its items. One within that bound but with more steps than a watch takes is judged
 *   like any other, with a `too_long_for_watch` warning: the app plays it all; it can't go to the watch whole.
 * - The day decides how the condition rules read (Amendment A): `day: null` (a template, a library context) judges every
 *   reading-dependent rule on each profile's calmest day — "does this fit the workout's mode at all"; a `day` whose
 *   `date` is after its `today` is a future day (that day's check is unknown); any other day uses `day.readings`.
 *   The day's own `feelingOff` joins every profile's reading. A reading with neither a "before" number nor "feeling
 *   off" (null, absent, or only an "after") is unanswered — and unanswered means not allowed: a move a reading can
 *   close must pass both unanswered and at the profile's worst reading. On the day itself the worst is the scale's top
 *   number, the day's "feeling off" as the day says it (not said is not feeling off, as the engine reads the day,
 *   2026-10-23); on a day ahead, nothing of the day is known, "feeling off" included.
 * - The workout's mode is `modeOfEffort(intent.effort)`. Every active profile is read through its contract only
 *   (`never`, `fitsMode`, `fitsFormat`, `allowPattern` per pattern, `allowRecord`, `flare`, the library's shared
 *   `recordFlareSafe`, `recoveryReason`, `buildChecks`) — this file never names a profile. A record with no rating for
 *   an active profile fails closed (as the engine's eligibility does). The mode's general limits (the engine's
 *   difficulty cap and load rule, `MODES`) apply with or without a profile.
 * - Alternates meet the same rules as the item they stand in for (same part, same mode, same day): the hard ones are
 *   errors at the alternate; the soft ones (mode, format, the mode's limits, set aside, gear) warnings. On a future day
 *   an alternate's pending gate adds nothing — the item's own `condition_gate_pending` covers the day.
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
 * - condition_never (error): a profile's `never`, or no rating for an active profile.
 * - condition_pattern (error): `allowPattern` refuses one of the record's patterns for this mode and the day.
 * - condition_gate (error): `allowRecord` refuses the record for this mode and the day.
 * - condition_gate_pending (warning, or error): a future day, and a pattern or record rule the day's reading could close;
 *   a warning only when the item carries an alternate that passes in recovery mode (the mode's limits and every
 *   profile's rules, at the calmest, unanswered and worst readings).
 * - condition_mode (warning): `fitsMode` is false for the workout's mode.
 * - condition_format (warning): `fitsFormat` is false for the part's format.
 * - condition_flare (warning): today's reading is a flare (`flare`) and the move is not flare-safe (`recordFlareSafe`).
 * - mode_limits (warning): the move is harder than the mode's difficulty cap or loaded where the mode takes no added
 *   weight (at the item or alternate); or a part holding exercises uses a format the mode does not (at the part's format),
 *   except straight sets whose every move is ONE set of an easy activation or mobility move (Task 13, A15: a library
 *   move with that purpose or role, at most difficulty ONE_SET_MAX_DIFFICULTY and no added weight, one set, one round —
 *   the mode's own easy work, set out one move at a time; a free-text move can't be vouched for).
 * - care_share (warning): a profile with care content (`care.block`) and a document with a `care` part — one that sets
 *   out a care block — where the care's derived minutes fall below CARE_SHARE_FLOOR of the block's share for the mode
 *   (in whole minutes, against the document's minutes without its runs). The care is the moves with a role of the block,
 *   wherever they are, and the rests between them — a rest whose nearest move before it in its part is one of them,
 *   and whose nearest move after it is one too or the part's end — as the session's minutes count every rest. The
 *   moves in a `care` part without such a role are named. At the first `care` part. A document with no care part is
 *   not judged, care moves or none (the athlete's own sessions, imports; round 2, Minor 4).
 * - mode_above_day (warning, at intent.effort): on the day, the day's "feeling off" (the engine's own sentence), else a
 *   profile's `recoveryReason` (for a workout above recovery) or its first failed `buildChecks` line (for a build
 *   workout) — the profile's own words; `fix` is the effort it allows.
 * - excluded_by_athlete (warning): the athlete set the move aside (`excluded`, legacy ids honoured).
 * - equipment_unavailable (warning): the move needs gear `equipment` (the place's) lacks.
 * - progression_jump (warning): with `day.done`, a jump past the athlete's frontier (the library's `onFrontier`: an
 *   easier variant must have been done cleanly); `fix` is the first move down its easier variants that is on the
 *   frontier and that the day does not refuse in that part (none, and no move named, when every one is refused).
 * - format_mismatch: a superset needs exactly two exercises (error); a circuit holds 3–6 moves (warning: the engine's
 *   own builds must validate clean); intervals need a run or a timed move (error).
 * - dose_mismatch (warning): an exercise with no amount (none of reps, holdSec, breaths, carryM, max); reps on a timed
 *   move or a carry (a library carry is timed) with no seconds, or on a breathing record with no breaths; seconds on a
 *   counted move outside a timed format (circuit, intervals, flow, holds). `fix` is the dose to use.
 * - jump_placement (warning): power while fresh (principles §2.1), where the engine puts jumps — at most one per jump:
 *   a jump in a second part holding jumps (the session's jumps live in one part), else a jump after a lift (a library
 *   move with a strength or power purpose that is no jump, in an earlier main, power, accessory or conditioning part, or
 *   earlier in its own part), both at the item; and a part holding a jump in a format other than straight sets or a
 *   superset, once at the part's format (`fix` straight). Free-text moves and alternates are not read.
 * - too_large (error, at "parts", alone): see Size.
 * - too_long_for_watch (warning, at "parts"): see Size.
 * - unknown_focus (warning): a focus id that is neither a region nor a muscle.
 * - unknown_equipment (warning): a `setting.equipment` id the library does not know.
 * RUNS (designed runs, §8 §3): a run is a document of run segments and rests only (`isRunDoc`); its pace is computed
 *   from the athlete's threshold (@rg/domain `paceBandFor`, the one function the card and the wire read). The athlete's
 *   running (`ctx.run`) is what the rules that count read; without it, only the document's own rules apply.
 * - run_mixed (error): run segments and moves in one document — at each segment when the moves are more, else at each
 *   move. Nothing else of a run is judged in such a document.
 * - run_open (error, at the segment's target): an open segment, which the watch can't hold.
 * - run_too_long (error, at "parts"): more than RUN_WATCH_MAX_STEPS steps as the wire in use writes them (`ctx.runWire`,
 *   §8 phase 2: v1 writes the repeats out, v2 writes a part of rounds as its children and a group); at a part's rounds:
 *   more than RUN_WATCH_MAX_ROUNDS rounds, on either wire.
 * - run_step_short (error, at a segment's target, a rest, or a part's restBetweenRoundsSec): a step under
 *   RUN_STEP_MIN_SEC on the watch (`runStepSeconds`: a distance at its pace's middle; one that can't be timed is not
 *   judged) — COROS's own minimum is unknown (review-2 (e)).
 * - run_pace_far (error, at the segment's target.pace): a pace the coach wrote whose middle lies more than PACE_FAR_SEC
 *   beyond either edge of its effort's band (race pace: the band for the segment's own distance). An effort with no
 *   band, or no threshold known, is not judged.
 * - run_pace_owed (warning, at "parts"): no threshold known (`ctx.run.thresholdSecPerKm` null) and a segment whose effort
 *   takes a band from one: the watch shows the time with no pace targets — or, a distance with no pace written, can't
 *   time it, and the run stays off the watch.
 * - run_hard_close (warning, at intent.effort): a quality or race run (derived) the day before, the day of or the day
 *   after another quality run or hard lower-body strength (`ctx.run.nearby`): under 48 hours apart. One per session.
 * - run_long_share (warning, at "parts"): a long run (derived) past LONG_SHARE of the week's running with it, when the
 *   week holds other running (`ctx.run.weekMinutes`).
 * - run_volume_jump (warning, at "parts"): the week's running with this run more than VOLUME_JUMP over the last four
 *   weeks' weekly average (`ctx.run.fourWeekAvgMinutes`, when above zero).
 *   A run's minutes are its steps' on the watch (`runWatchSteps`, a distance at its band's middle), else derived.
 * - run_time_and_distance (warning, at the segment's target): a time and a distance both set — the watch runs it by its
 *   time (`runWatchStepOf`). Without the athlete's running too (2026-10-18, decision guidance).
 * - run_race_by_time (warning, at the segment's target): a race effort set by time with no pace written — race pace is
 *   the band for a distance (`paceBandFor`), so the step carries none. Without the athlete's running too.
 * Not checked here: `test.keyResultId` and `intent.objectiveIds` (opaque without the database).
 *
 * FIXES for the condition, mode, athlete and place codes: the item's alternates first, then its easier variants (three
 * steps down), the first that raises none of those issues here. For condition_gate_pending: an alternate that passes
 * in recovery mode (the warning); otherwise (the error) such a move among the easier variants, else the library's
 * best move for the slot that passes in recovery, is no jump and fits here — sharing the item's patterns and regions,
 * then its patterns, then its regions, in library order.
 */
import type { ZodIssue } from "zod";
import {
  daysBetween,
  paceBandFor,
  RUN_EFFORT_LABELS,
  RUN_STEP_MIN_SEC,
  RUN_WATCH_MAX_ROUNDS,
  RUN_WATCH_MAX_STEPS,
  runDocStepCount,
  runStepSeconds,
  runWatchSessionOf,
  runWatchStepOf,
  runWatchSteps,
  workoutDocSchema,
  type WorkoutDoc,
  type WorkoutDose,
  type WorkoutItem,
  type WorkoutPart,
  type RunWire,
} from "@rg/domain";
import {
  EQUIPMENT,
  EQUIPMENT_IDS,
  MODES,
  MODE_IDS,
  MUSCLES,
  REGIONS,
  UNANSWERED,
  attrsOf,
  bestDay,
  hasEquipment,
  isPlyometric,
  label,
  onFrontier,
  recordFlareSafe,
  type CheckReading,
  type ConditionProfile,
  type ExerciseRecord,
  type FormatId,
  type HistorySession,
  type Mode,
  type ProposalCtx,
} from "@rg/exercise-library";
import { FORMAT_OF_PART, deriveDoc, docSize, makeLibraryIndex, modeOfEffort } from "./derive.js";

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
  "mode_limits",
  "mode_above_day",
  "excluded_by_athlete",
  "equipment_unavailable",
  "progression_jump",
  "format_mismatch",
  "dose_mismatch",
  "jump_placement",
  "too_large",
  "too_long_for_watch",
  "unknown_focus",
  "unknown_equipment",
  "care_share",
  "run_mixed",
  "run_open",
  "run_too_long",
  "run_step_short",
  "run_pace_far",
  "run_pace_owed",
  "run_hard_close",
  "run_long_share",
  "run_volume_jump",
  "run_race_by_time",
  "run_time_and_distance",
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
  /** "I'm feeling off" for the whole day, whatever profiles are active: it joins every profile's reading. */
  feelingOff?: boolean;
  /**
   * Library ids the athlete has done CLEANLY; given, a jump past their frontier is noted (`progression_jump`). Build it
   * with the library's `isDoneCleanly` over each move's tally (legacy ids merged into the move), the engine's own unlock
   * rule — never "done at all": a rung only ever done with a profile's flag on it unlocks nothing.
   */
  done?: ReadonlySet<string>;
  /** Recent sessions, for the profiles' mode rules. */
  recent?: { last: HistorySession | null; week: readonly HistorySession[] };
}

/** The athlete's running, as the rules that count read it for a run document (designed runs, §8 §3). */
export interface RunCtx {
  /** Their threshold pace, seconds per km; null when none is known. */
  thresholdSecPerKm: number | null;
  /** Hard sessions near the run's day, planned or done: a quality run, or hard lower-body strength. */
  nearby: ReadonlyArray<{ date: string; kind: "quality_run" | "hard_legs"; title: string }>;
  /** The running already planned in the run's week (Monday to Sunday), this run aside, in minutes. */
  weekMinutes: number;
  /** The last four weeks' running, a week on average, in minutes; null when none can be read. */
  fourWeekAvgMinutes: number | null;
}

export interface ValidateCtx {
  /** The run wire in use (§8 phase 2, `RUN_WIRE_V2`): how a run's steps are counted against the watch's. v1 when absent. */
  runWire?: RunWire;
  library: readonly ExerciseRecord[];
  activeProfiles: readonly ConditionProfile[];
  /** null only for templates and library contexts. */
  day: DayContext | null;
  /** Moves the athlete set aside ("not for me"). */
  excluded?: readonly string[];
  /** The place's equipment; absent: not checked. */
  equipment?: readonly string[];
  /** The athlete's running, for a run document; absent: only the document's own run rules. */
  run?: RunCtx;
}

type Part = WorkoutPart;
type DocFormat = Part["format"];
type Exercise = Extract<WorkoutItem, { kind: "exercise" }>;
type Phase = "any" | "today" | "future";

const FORMAT_RULE: Readonly<Record<DocFormat, FormatId>> = FORMAT_OF_PART;
const FORMAT_WORDS: Record<DocFormat, string> = {
  straight: "straight sets", superset: "a superset", circuit: "a circuit", flow: "a flow", intervals: "intervals", steady: "a steady effort", ladder: "a ladder", holds: "holds",
};
/** The format to offer when the mode leaves a part's out, in order of preference. */
const FORMAT_PREFERENCE: readonly DocFormat[] = ["straight", "holds", "flow", "superset"];
/** Formats whose work is a timed window: seconds of a counted move are their way, not a mismatch. */
const TIMED_FORMATS = new Set<DocFormat>(["circuit", "intervals", "flow", "holds"]);
/** The formats a part holding jumps takes: real rest between sets (the engine's jumps block). */
const JUMP_FORMATS = new Set<DocFormat>(["straight", "superset"]);
/** Parts whose lifts tire the legs before a jump: preparation (arrive, warm-up, activation), care and cool-down do not. */
const LIFTING_PARTS = new Set<Part["purpose"]>(["main", "power", "accessory", "conditioning"]);
const LIFT_PURPOSES = new Set<string>(["strength", "power"]);
/** A lift that tires before a jump: a strength or power move that is no jump itself. */
const isLift = (rec: ExerciseRecord): boolean => !isPlyometric(rec) && rec.purposes.some((p) => LIFT_PURPOSES.has(p));
const CIRCUIT_MIN = 3;
const CIRCUIT_MAX = 6;
/** How far down the easier variants a fix looks. */
const EASIER_DEPTH = 3;
/** How far down the easier variants the frontier is looked for. */
const FRONTIER_DEPTH = 8;
/** The day's "feeling off", in the engine's own words (its mode proposal). */
const FEELING_OFF = "You said you're feeling off.";
/**
 * The most difficult move a mode that leaves straight sets out still takes as one straight set (A15): the easy end of
 * the scale, where an activation or mobility move is a prompt, not strength work.
 */
const ONE_SET_MAX_DIFFICULTY = 2;
/** What makes a move a prompt rather than a lift, for A15: its purposes or its roles. */
const EASY_WORK = new Set<string>(["activation", "mobility"]);
/**
 * How much of a care block's share counts as met (A10). The block's share is what the engine's own sessions START the
 * block with (unused time rolls forward), so its builds land under it: down to about 80% in recovery, and a single
 * one-minute care move in a short Maintain or Develop session (1 of 21 minutes) — two thirds of the share, in whole
 * minutes, keeps every engine build clean and still flags a care part a third short or worse.
 */
const CARE_SHARE_FLOOR = 2 / 3;
/** A floating-point product that should be whole (0.1 × 30 × 2/3) is not let down by a hair. */
const EPSILON = 1e-9;
/** How far beyond its effort's band a written pace's middle may lie, seconds per km, before it is another effort. */
const PACE_FAR_SEC = 30;
/** A long run's share of the week's running past which it is out of proportion. */
const LONG_SHARE = 0.3;
/** How far over the last four weeks' average a week's running may go. */
const VOLUME_JUMP = 0.1;
/** Hard running wants 48 hours: a hard session this many days either side is too close. */
const HARD_CLOSE_DAYS = 1;
/** A derived run category that is hard running. */
const HARD_RUN = new Set<string>(["quality", "race"]);
const MIXED_RUN = "Runs and moves go in workouts of their own: this one mixes run segments with exercises.";
type RunItem = Extract<WorkoutItem, { kind: "run" }>;
/** "4:59": seconds per km as a pace reads. */
const paceText = (sec: number): string => {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

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

/**
 * The day as the document names it: its own effort, in the vocabulary's words ("a Maintain day") — never the engine's
 * mode name ("consistent"), which the athlete never chose. Develop and Peak share the build mode, and each says its own.
 */
const effortWord = (e: WorkoutDoc["intent"]["effort"]): string => label(e);
const worstDay = (p: ConditionProfile): CheckReading => ({ pre: p.check.max, post: p.check.max, feelingOff: true });

/**
 * The day's advice on a workout's effort (`mode_above_day`), for a workout above Recover on its own day: the day's
 * "feeling off" (the engine's own sentence), else each profile's own words for its reading and the recent sessions —
 * its `recoveryReason` (Recover), or for a Develop or Peak day the first failed `buildChecks` line (Maintain). The
 * validator's, and the session sheet's for a document built today (one voice, CUJ re-walk §2.6).
 */
export function effortAdvice(
  effort: WorkoutDoc["intent"]["effort"],
  profiles: readonly ConditionProfile[],
  day: Pick<DayContext, "date" | "readings" | "feelingOff" | "recent">,
): Array<{ message: string; fix: WorkoutDoc["intent"]["effort"] }> {
  const mode = modeOfEffort(effort);
  if (mode === "recovery") return [];
  if (day.feelingOff) return [{ message: FEELING_OFF, fix: "recover" }];
  const last = day.recent?.last ?? null;
  const week = day.recent?.week ?? [];
  const byId = new Map<string, HistorySession>();
  for (const s of [...week, ...(last ? [last] : [])]) if (s.date <= day.date) byId.set(s.id, s);
  const past = [...byId.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const out: Array<{ message: string; fix: WorkoutDoc["intent"]["effort"] }> = [];
  for (const p of profiles) {
    const pctx: ProposalCtx = { today: day.date, reading: day.readings[p.id] ?? UNANSWERED, past, last, week };
    const why = p.recoveryReason(pctx);
    if (why) {
      out.push({ message: why, fix: "recover" });
      continue;
    }
    if (mode !== "build") continue;
    const failed = p.buildChecks(pctx).find(([ok]) => !ok);
    if (failed) out.push({ message: failed[1], fix: "maintain" });
  }
  return out;
}
const patternOk = (p: ConditionProfile, rec: ExerciseRecord, mode: Mode, r: CheckReading): boolean => rec.patterns.every((pt) => p.allowPattern(pt, mode, r));
const recordOk = (p: ConditionProfile, rec: ExerciseRecord, mode: Mode, r: CheckReading): boolean => !p.allowRecord || p.allowRecord(rec, mode, r);
/** `gatesReadTheCheck`'s answers by profile and library (both fixed objects for a Worker's life). */
const GATES_READ_THE_CHECK = new WeakMap<ConditionProfile, WeakMap<readonly ExerciseRecord[], boolean>>();

/**
 * Whether a profile has a gate an answered check today could open: a move of the library its pattern or record rules
 * allow on the profile's calmest day but refuse on the day itself unanswered — as `validateWorkoutDoc` reads such a day
 * (unanswered, or the scale's top number; not feeling off). Without one, an unanswered check closes nothing today, and
 * asking the athlete for one opens nothing. Probed from the rules themselves, never from their words.
 */
export function gatesReadTheCheck(p: ConditionProfile, library: readonly ExerciseRecord[]): boolean {
  let byLibrary = GATES_READ_THE_CHECK.get(p);
  if (!byLibrary) GATES_READ_THE_CHECK.set(p, (byLibrary = new WeakMap()));
  let known = byLibrary.get(library);
  if (known === undefined) {
    const best = bestDay(p);
    const unknown: CheckReading[] = [UNANSWERED, { ...worstDay(p), feelingOff: false }];
    const open = (rec: ExerciseRecord, m: Mode, r: CheckReading): boolean => patternOk(p, rec, m, r) && recordOk(p, rec, m, r);
    known = library.some((rec) => attrsOf(rec, p) !== undefined && MODE_IDS.some((m) => open(rec, m, best) && unknown.some((r) => !open(rec, m, r))));
    byLibrary.set(library, known);
  }
  return known;
}
/** A reading that says something: a "before" number, or "feeling off". */
const answered = (r: CheckReading | null): r is CheckReading => r !== null && (r.pre != null || r.feelingOff);

/**
 * What the mode's general limits (the engine's difficulty cap and load rule) say against a move, or null; `w` names the
 * day in the document's words.
 */
function limitsAgainst(rec: ExerciseRecord, m: Mode, w: string): string | null {
  const spec = MODES[m];
  const loaded = !spec.allowExternalLoad && rec.load === "external";
  const hard = rec.difficulty > spec.maxDifficulty;
  if (loaded && hard) return `${rec.name} uses added weight and is harder than a ${w} day takes.`;
  if (loaded) return `${rec.name} uses added weight, which a ${w} day leaves out.`;
  if (hard) return `${rec.name} is harder than a ${w} day takes.`;
  return null;
}

function pathOf(segments: ReadonlyArray<string | number>): string {
  return segments.reduce<string>((acc, s) => (typeof s === "number" ? `${acc}[${s}]` : acc ? `${acc}.${s}` : s), "");
}

/** Why a pattern or record rule refuses a move. */
interface GateFail {
  rule: "pattern" | "record";
  /** mode: no reading opens it in this mode; today: today's check (or its absence); pending: a future day's check. */
  why: "mode" | "today" | "pending";
}

/** One rule's verdict against a move in a part (the item's or an alternate's). */
interface Finding {
  code: DocIssueCode;
  severity: "error" | "warning";
  message: string;
  /** For condition_gate_pending: the profile whose check the day waits on. */
  pending?: ConditionProfile;
}

export function validateWorkoutDoc(input: unknown, ctx: ValidateCtx): DocIssue[] {
  const parsed = workoutDocSchema.safeParse(input);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => ({ path: pathOf(i.path), code: "bounds", message: plainSchemaIssue(i), severity: "error" }));
  }
  const doc = parsed.data;
  const size = docSize(doc, ctx.library);
  if (size.tooLarge) return [{ path: "parts", code: "too_large", message: size.tooLarge, severity: "error" }];
  const find = makeLibraryIndex(ctx.library);
  const profiles = ctx.activeProfiles;
  const day = ctx.day;
  const phase: Phase = !day ? "any" : day.date > day.today ? "future" : "today";
  const mode = modeOfEffort(doc.intent.effort);
  const dayWord = effortWord(doc.intent.effort);
  const canonical = (id: string): string => find(id)?.id ?? id;
  const excluded = new Set((ctx.excluded ?? []).map(canonical));
  const equipment = ctx.equipment;
  const done = day?.done ? new Set([...day.done].map(canonical)) : null;
  const isDone = (id: string): boolean => done !== null && done.has(canonical(id));
  // Built only when a move is unknown and needs a fix (2026-10-18, the decision guidance's fix round): built on every
  // call, it was three quarters of a small document's check — propose_plan's condition check runs one a day and effort.
  let guessIndex: ((s: string) => string | undefined) | null = null;
  const guessExercise = (s: string): string | undefined => (guessIndex ??= guesser(ctx.library.flatMap((e) => [[e.id, e.id], [e.name, e.id]] as const)))(s);
  const issues: DocIssue[] = [];
  /** Records an issue; a fix that came out undefined is left off. */
  const add = (issue: DocIssue): void => {
    const { fix, ...rest } = issue;
    issues.push(fix === undefined ? rest : issue);
  };

  /** The day's reading for a profile, with the day's "feeling off" joined (null: none); never on a future day. */
  const readingOf = (p: ConditionProfile): CheckReading | null => {
    if (phase !== "today") return null;
    const r = day!.readings[p.id] ?? null;
    return day!.feelingOff ? { ...(r ?? UNANSWERED), feelingOff: true } : r;
  };

  /** A pattern or record rule that refuses the move here, for this profile. */
  function gate(p: ConditionProfile, rec: ExerciseRecord): GateFail | null {
    const best = bestDay(p);
    if (!patternOk(p, rec, mode, best)) return { rule: "pattern", why: "mode" };
    if (!recordOk(p, rec, mode, best)) return { rule: "record", why: "mode" };
    if (phase === "any") return null;
    const r = readingOf(p);
    const why: GateFail["why"] = phase === "future" ? "pending" : "today";
    // Today, an unanswered reading is not feeling off (the day would have said so, joined in `readingOf`): only its
    // number is unknown. A day ahead knows nothing yet.
    const worst = phase === "future" ? worstDay(p) : { ...worstDay(p), feelingOff: false };
    for (const t of answered(r) ? [r] : [UNANSWERED, worst]) {
      if (!patternOk(p, rec, mode, t)) return { rule: "pattern", why };
      if (!recordOk(p, rec, mode, t)) return { rule: "record", why };
    }
    return null;
  }

  function gateMessage(p: ConditionProfile, name: string, g: GateFail): string {
    const r = readingOf(p);
    if (g.why === "mode") return `${name} isn't allowed on a ${dayWord} day with ${p.label}.`;
    if (r?.feelingOff) return `${name} isn't allowed while you're feeling off.`;
    if (r && r.pre != null) return `${name} isn't allowed with today's ${p.check.label} check at ${r.pre}.`;
    return `${name} needs today's ${p.check.label} check answered first.`;
  }

  /** Every condition, mode, athlete and place rule against a move in a part of this format. */
  function judge(rec: ExerciseRecord, format: DocFormat): Finding[] {
    const out: Finding[] = [];
    const name = rec.name;
    for (const p of profiles) {
      const a = attrsOf(rec, p);
      if (!a) {
        out.push({ code: "condition_never", severity: "error", message: `${name} has no ${p.label} rating yet, so it can't be placed.` });
        continue;
      }
      if (p.never(a)) {
        out.push({ code: "condition_never", severity: "error", message: `${name} is never allowed with ${p.label}.` });
        continue;
      }
      if (!p.fitsMode(a, mode, rec)) out.push({ code: "condition_mode", severity: "warning", message: `${name} is more than ${p.label} allows on a ${dayWord} day.` });
      if (!p.fitsFormat(a, FORMAT_RULE[format])) out.push({ code: "condition_format", severity: "warning", message: `${name} doesn't suit ${FORMAT_WORDS[format]} with ${p.label}.` });
      const g = gate(p, rec);
      if (g?.why === "pending") out.push({ code: "condition_gate_pending", severity: "warning", message: "", pending: p });
      else if (g) out.push({ code: g.rule === "pattern" ? "condition_pattern" : "condition_gate", severity: "error", message: gateMessage(p, name, g) });
      const r = readingOf(p);
      if (r && p.flare(r) && !recordFlareSafe(p, rec)) {
        out.push({ code: "condition_flare", severity: "warning", message: `${name} isn't flare-safe, and today's ${p.check.label} check is a flare.` });
      }
    }
    const limits = limitsAgainst(rec, mode, dayWord);
    if (limits) out.push({ code: "mode_limits", severity: "warning", message: limits });
    if (excluded.has(rec.id)) out.push({ code: "excluded_by_athlete", severity: "warning", message: `You set ${name} aside as not for you.` });
    if (equipment && !hasEquipment(rec, equipment)) {
      out.push({ code: "equipment_unavailable", severity: "warning", message: `${name} needs ${missingGear(rec, equipment)}, which this place doesn't have.` });
    }
    return out;
  }

  /** Raises none of the condition, mode, athlete or place issues here: a fix to offer. */
  const fitsHere = (rec: ExerciseRecord, format: DocFormat): boolean => judge(rec, format).length === 0;

  /** Passes in recovery mode whatever the day's check reads: what a future day's gated move needs as its alternate. */
  const passesRecovery = (rec: ExerciseRecord): boolean =>
    limitsAgainst(rec, "recovery", "") === null &&
    profiles.every((p) => {
      const a = attrsOf(rec, p);
      if (!a || p.never(a) || !p.fitsMode(a, "recovery", rec)) return false;
      return [bestDay(p), UNANSWERED, worstDay(p)].every((r) => patternOk(p, rec, "recovery", r) && recordOk(p, rec, "recovery", r));
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

  /** The library's best stand-in for a gated move that must hold on any day (see FIXES in the header). */
  function recoverySubstitute(rec: ExerciseRecord, format: DocFormat): string | undefined {
    let best: { id: string; score: number } | undefined;
    for (const r of ctx.library) {
      if (r.id === rec.id || isPlyometric(r)) continue;
      const score = (r.patterns.some((pt) => rec.patterns.includes(pt)) ? 2 : 0) + (r.regions.some((g) => rec.regions.includes(g)) ? 1 : 0);
      if (score === 0 || (best && score <= best.score)) continue;
      if (!passesRecovery(r) || !fitsHere(r, format)) continue;
      best = { id: r.id, score };
      if (score === 3) break;
    }
    return best?.id;
  }

  /**
   * The first move down a jump's easier variants that is on the athlete's frontier and that the day does not refuse
   * here (no error of its own in this part: a jump a gated day keeps out is never the fix).
   */
  function frontierStep(rec: ExerciseRecord, format: DocFormat): ExerciseRecord | undefined {
    const seen = new Set([rec.id]);
    let level = [...rec.easier];
    for (let depth = 0; depth < FRONTIER_DEPTH && level.length; depth++) {
      const next: string[] = [];
      for (const id of level) {
        const r = find(id);
        if (!r || seen.has(r.id)) continue;
        seen.add(r.id);
        if (onFrontier(r, isDone) && !judge(r, format).some((f) => f.severity === "error")) return r;
        next.push(...r.easier);
      }
      level = next;
    }
    return undefined;
  }

  // ── Size: within the app's bound, but more than a watch takes ──
  if (size.tooLongForWatch) add({ path: "parts", code: "too_long_for_watch", message: size.tooLongForWatch, severity: "warning" });

  // ── Intent and setting ──
  doc.intent.focus.forEach((id, i) => {
    if (FOCUS_IDS.has(id)) return;
    add({ path: `intent.focus[${i}]`, code: "unknown_focus", message: `"${id}" isn't a body area or muscle the library knows.`, fix: guessFocus(id), severity: "warning" });
  });
  (doc.setting?.equipment ?? []).forEach((id, i) => {
    if (EQUIPMENT_SET.has(id)) return;
    add({ path: `setting.equipment[${i}]`, code: "unknown_equipment", message: `"${id}" isn't equipment the library knows.`, fix: guessEquipment(id), severity: "warning" });
  });

  // ── The day's mode: the day's "feeling off", else each profile's own words ──
  if (phase === "today") {
    for (const a of effortAdvice(doc.intent.effort, profiles, day!)) add({ path: "intent.effort", code: "mode_above_day", message: a.message, fix: a.fix, severity: "warning" });
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

  // ── Jumps: one part, straight sets or a superset, before the lifting ──
  checkJumps();

  // ── Care: a cared-for profile's care part, against its share of the minutes ──
  checkCare();

  // ── Runs: a document of their own, that the watch can hold, judged by what code can count ──
  checkRun();

  function checkRun(): void {
    const items = doc.parts.flatMap((p, pi) => p.items.map((item, ii) => ({ item, at: `parts[${pi}].items[${ii}]` })));
    const runs = items.filter((x) => x.item.kind === "run");
    if (runs.length === 0) return;
    const moves = items.filter((x) => x.item.kind === "exercise" || x.item.kind === "free_exercise");
    if (moves.length > 0) {
      for (const x of runs.length <= moves.length ? runs : moves) add({ path: x.at, code: "run_mixed", message: MIXED_RUN, severity: "error" });
      return;
    }
    for (const x of runs) {
      const it = x.item as RunItem;
      const t = it.target;
      if (t.durationSec === undefined && t.distanceM === undefined) {
        add({ path: `${x.at}.target`, code: "run_open", message: "An open segment can't go to the watch: give it a time or a distance.", severity: "error" });
      }
      // What the step's own target would silently lose (2026-10-18, decision guidance): with both, time wins
      // (`runWatchStepOf`); race pace is a distance's (`paceBandFor`), so a race step by time has none unless one is written.
      if (t.durationSec !== undefined && t.distanceM !== undefined) {
        add({ path: `${x.at}.target`, code: "run_time_and_distance", message: "This step has both a time and a distance; the watch runs it by its time.", severity: "warning" });
      }
      if (it.effort === "race" && t.durationSec !== undefined && !t.pace) {
        add({
          path: `${x.at}.target`, code: "run_race_by_time", severity: "warning",
          message: "Race pace is worked out for a distance, so this race step, set by time, has no pace on the watch: give it its distance, or a pace.",
        });
      }
    }
    // The watch's shortest step (review-2 (e)): each segment and rest as the watch takes it (`runWatchStepOf`), and the
    // rest between rounds.
    const shortStep = (seconds: number | null, path: string): void => {
      if (seconds === null || seconds >= RUN_STEP_MIN_SEC) return;
      add({
        path, code: "run_step_short", severity: "error",
        message: `This step is ${seconds} s on the watch, under the ${RUN_STEP_MIN_SEC} s a watch step needs: make it longer, or fold it into the step beside it.`,
      });
    };
    doc.parts.forEach((p, pi) => {
      p.items.forEach((item, ii) => {
        const step = runWatchStepOf(item, p.purpose);
        if (typeof step !== "string") shortStep(runStepSeconds(step, ctx.run?.thresholdSecPerKm ?? null), item.kind === "run" ? `parts[${pi}].items[${ii}].target` : `parts[${pi}].items[${ii}]`);
      });
      if (p.restBetweenRoundsSec !== undefined && (p.rounds ?? 1) > 1) shortStep(Math.max(1, Math.round(p.restBetweenRoundsSec)), `parts[${pi}].restBetweenRoundsSec`);
    });
    const wire = ctx.runWire ?? "v1";
    doc.parts.forEach((p, pi) => {
      const rounds = p.rounds ?? 1;
      if (rounds > RUN_WATCH_MAX_ROUNDS) {
        add({ path: `parts[${pi}].rounds`, code: "run_too_long", message: `This part has ${rounds} rounds, and the watch takes ${RUN_WATCH_MAX_ROUNDS}: fewer rounds, or longer ones.`, severity: "error" });
      }
    });
    const steps = runDocStepCount(doc, wire);
    if (steps > RUN_WATCH_MAX_STEPS) {
      add({
        path: "parts", code: "run_too_long", severity: "error",
        message:
          wire === "v1"
            ? `This run has ${steps} steps once its repeats are written out, and the watch takes ${RUN_WATCH_MAX_STEPS}: fewer repeats, or longer ones.`
            : `This run has ${steps} steps on the watch, and the watch takes ${RUN_WATCH_MAX_STEPS}: fewer steps, or longer ones.`,
      });
    }
    const run = ctx.run;
    const threshold = run?.thresholdSecPerKm ?? null;
    for (const x of runs) {
      const it = x.item as RunItem;
      const written = it.target.pace;
      const band = written ? paceBandFor(it.effort, threshold, it.target.distanceM !== undefined ? { distanceM: it.target.distanceM } : {}) : null;
      if (!written || !band) continue;
      const mid = (written.fastSecPerKm + written.slowSecPerKm) / 2;
      if (mid >= band.fastSecPerKm - PACE_FAR_SEC && mid <= band.slowSecPerKm + PACE_FAR_SEC) continue;
      const theirs = it.effort === "race" ? "race pace for its distance" : `a ${RUN_EFFORT_LABELS[it.effort].toLowerCase()} effort's`;
      add({
        path: `${x.at}.target.pace`, code: "run_pace_far", severity: "error",
        message: `This pace, ${paceText(written.fastSecPerKm)}–${paceText(written.slowSecPerKm)}/km, is far from ${theirs} ${paceText(band.fastSecPerKm)}–${paceText(band.slowSecPerKm)}/km: name the effort it is, or leave the pace to the app.`,
      });
    }
    if (!run) return;
    const made = runWatchSessionOf(doc, wire);
    const resolved = "session" in made ? runWatchSteps(made.session, threshold, wire) : null;
    if (resolved && threshold === null && (resolved.unresolved > 0 || resolved.paceOwed > 0)) {
      add({
        path: "parts", code: "run_pace_owed", severity: "warning",
        message: resolved.unresolved > 0
          ? "No threshold pace is known yet, so the watch can't time this run's distances: it stays off the watch until one is."
          : wire === "v2"
            ? "No threshold pace is known yet, so the watch shows this run's steps with no pace targets."
            : "No threshold pace is known yet, so the watch shows this run's time with no pace targets.",
      });
    }
    const derived = deriveDoc(doc, ctx.library);
    const seconds = resolved?.totalSeconds ?? derived.estimatedMinutes * 60;
    const minutes = Math.round(seconds / 60);
    if (day && HARD_RUN.has(derived.category)) {
      for (const n of run.nearby) {
        const gap = daysBetween(day.date, n.date);
        if (Math.abs(gap) > HARD_CLOSE_DAYS) continue;
        const when = gap < 0 ? "the day before" : gap > 0 ? "the day after" : "the same day";
        add({ path: "intent.effort", code: "run_hard_close", severity: "warning", message: `${n.title} is ${when}: hard running wants 48 hours from other hard running and hard leg strength.` });
      }
    }
    if (derived.category === "long" && run.weekMinutes > 0) {
      const total = run.weekMinutes + minutes;
      const share = minutes / total;
      if (share > LONG_SHARE + EPSILON) {
        add({
          path: "parts", code: "run_long_share", severity: "warning",
          message: `This long run is ${Math.round(share * 100)}% of the week's running (${minutes} of ${Math.round(total)} minutes); about ${Math.round(LONG_SHARE * 100)}% keeps it in proportion.`,
        });
      }
    }
    const avg = run.fourWeekAvgMinutes;
    if (avg !== null && avg > 0) {
      const total = run.weekMinutes + minutes;
      if (total > avg * (1 + VOLUME_JUMP) + EPSILON) {
        add({
          path: "parts", code: "run_volume_jump", severity: "warning",
          message: `With this run the week's running comes to ${Math.round(total)} minutes, ${Math.round((total / avg - 1) * 100)}% over your last four weeks' average of ${Math.round(avg)} a week.`,
        });
      }
    }
  }

  function checkJumps(): void {
    let jumpsPart: number | null = null;
    let lifted = false;
    doc.parts.forEach((part, pi) => {
      let jumpHere = false;
      part.items.forEach((item, ii) => {
        const rec = item.kind === "exercise" ? find(item.libraryId) : undefined;
        if (!rec) return;
        if (isPlyometric(rec)) {
          jumpHere = true;
          const path = `parts[${pi}].items[${ii}].libraryId`;
          if (jumpsPart !== null && jumpsPart !== pi) {
            add({ path, code: "jump_placement", message: `${rec.name} is in a second jumps part: keep the session's jumps together in one part.`, severity: "warning" });
          } else if (lifted) {
            add({ path, code: "jump_placement", message: `${rec.name} comes after lifting: jumps go first, while you're fresh.`, severity: "warning" });
          }
        } else if (LIFTING_PARTS.has(part.purpose) && isLift(rec)) {
          lifted = true;
        }
      });
      if (!jumpHere) return;
      jumpsPart ??= pi;
      if (!JUMP_FORMATS.has(part.format)) {
        add({ path: `parts[${pi}].format`, code: "jump_placement", message: `Jumps go in straight sets or a superset, with real rest between sets, not ${FORMAT_WORDS[part.format]}.`, fix: "straight", severity: "warning" });
      }
    });
  }

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
    // The mode's formats bind exercise work only (run intervals on a maintain day are a run's way), and one straight set
    // of an easy prompt is the mode's own easy work (A15).
    const allowed = MODES[mode].formats;
    if (moves > 0 && !allowed.includes(FORMAT_RULE[part.format]) && !(part.format === "straight" && easyOneSets(part))) {
      const fix = FORMAT_PREFERENCE.find((f) => allowed.includes(FORMAT_RULE[f]));
      add({ path, code: "mode_limits", message: `A ${dayWord} day doesn't use ${FORMAT_WORDS[part.format]}.`, fix, severity: "warning" });
    }
  }

  /** Every move of the part is one set, in one round, of an easy, unloaded library move for activation or mobility (A15). */
  function easyOneSets(part: Part): boolean {
    if ((part.rounds ?? 1) > 1) return false;
    return part.items.every((item) => {
      if (item.kind === "run" || item.kind === "rest") return true;
      const rec = item.kind === "exercise" ? find(item.libraryId) : undefined;
      if (!rec) return false;
      const sets = item.dose.sets ?? rec.dose.sets?.[0] ?? 1;
      return sets === 1 && rec.difficulty <= ONE_SET_MAX_DIFFICULTY && rec.load !== "external" && [...rec.purposes, ...rec.roles].some((x) => EASY_WORK.has(x));
    });
  }

  /** Each cared-for profile's care block against its share of the minutes (see care_share in the header). */
  function checkCare(): void {
    const careAt = doc.parts.findIndex((p) => p.purpose === "care");
    if (careAt < 0) return;
    /** The document's derived minutes, holding only the items `keep` keeps (a part left with no move is dropped). */
    const minutesOf = (keep: (item: WorkoutItem, at: number, items: readonly WorkoutItem[]) => boolean): number => {
      const parts = doc.parts
        .map((p) => ({ ...p, items: p.items.filter(keep) }))
        .filter((p) => p.items.some((i) => i.kind === "exercise" || i.kind === "free_exercise"));
      return parts.length > 0 ? deriveDoc({ ...doc, parts }, ctx.library).estimatedMinutes : 0;
    };
    /** The nearest item that is no rest from `at`, stepping by `step` through the part; undefined past its end. */
    const nearestMove = (items: readonly WorkoutItem[], at: number, step: 1 | -1): WorkoutItem | undefined => {
      for (let i = at + step; i >= 0 && i < items.length; i += step) if (items[i]!.kind !== "rest") return items[i];
      return undefined;
    };
    for (const p of profiles) {
      const block = p.care?.block;
      const share = block?.share[mode] ?? 0;
      if (!block || !(share > 0)) continue;
      const isCare = (item: WorkoutItem): boolean => item.kind === "exercise" && (find(item.libraryId)?.roles ?? []).some((r) => block.roles.includes(r));
      /** A care move, or a rest between care moves (or after the last one in its part). */
      const careTime = (item: WorkoutItem, at: number, items: readonly WorkoutItem[]): boolean => {
        if (item.kind !== "rest") return isCare(item);
        const before = nearestMove(items, at, -1);
        const after = nearestMove(items, at, 1);
        return before !== undefined && isCare(before) && (after === undefined || isCare(after));
      };
      const total = minutesOf((i) => i.kind !== "run");
      if (total === 0) continue;
      const care = minutesOf(careTime);
      const target = share * total;
      if (care >= Math.floor(target * CARE_SHARE_FLOOR + EPSILON)) continue;
      const pct = (x: number): number => Math.round(x * 100);
      const [lo, hi] = [block.min[mode], block.max[mode]];
      const moves = lo === hi ? `${lo} ${lo === 1 ? "move" : "moves"}` : `${lo}–${hi} moves`;
      const about = Math.round(target);
      let message = `${block.label} is ${care} of ${total} minutes (${pct(care / total)}%); a ${dayWord} day gives it about ${pct(share)}% — about ${about} ${about === 1 ? "minute" : "minutes"}, ${moves}.`;
      // The moves a care part holds that don't count: library moves without the block's role, and free-text moves.
      const uncounted = (i: WorkoutItem): string[] => {
        if (i.kind === "free_exercise") return [i.name];
        const rec = i.kind === "exercise" && !isCare(i) ? find(i.libraryId) : undefined;
        return rec ? [rec.name] : [];
      };
      const others = [...new Set(doc.parts.filter((part) => part.purpose === "care").flatMap((part) => part.items.flatMap(uncounted)))];
      if (others.length > 0) message += ` Only ${block.label.toLowerCase()} moves count: ${listWords(others)} ${others.length === 1 ? "isn't one" : "aren't"}.`;
      add({ path: `parts[${careAt}]`, code: "care_share", message, severity: "warning" });
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
    if (rec.id !== item.libraryId) add({ path: idAt, code: "legacy_id", message: `${rec.name} is listed under an old id.`, fix: rec.id, severity: "warning" });

    const name = rec.name;
    const options = candidates(rec, item);
    const alternates = (item.alternates ?? []).map((a) => find(a.libraryId)).filter((r): r is ExerciseRecord => r !== undefined && r.id !== rec.id);
    const better = (): string | undefined => fixAmong(options, (r) => fitsHere(r, part.format));
    for (const f of judge(rec, part.format)) {
      if (!f.pending) {
        add({ path: idAt, code: f.code, message: f.message, fix: better(), severity: f.severity });
        continue;
      }
      const check = f.pending.check.label;
      const alternate = alternates.find(passesRecovery);
      if (alternate) {
        add({ path: idAt, code: "condition_gate_pending", message: `${name} depends on that day's ${check} check; if it isn't allowed then, swap in ${alternate.name}.`, fix: alternate.id, severity: "warning" });
      } else {
        add({
          path: idAt, code: "condition_gate_pending", message: `${name} depends on that day's ${check} check: add an alternate that suits a recovery day.`,
          fix: fixAmong(options, passesRecovery) ?? recoverySubstitute(rec, part.format), severity: "error",
        });
      }
    }
    if (done && !onFrontier(rec, isDone)) {
      const step = frontierStep(rec, part.format);
      add({
        path: idAt, code: "progression_jump",
        message: step ? `${name} is a step past the jumps you've done; ${step.name} comes first.` : `${name} is a step past the jumps you've done.`,
        fix: step?.id, severity: "warning",
      });
    }

    checkDose(rec, item.dose, part.format, at);

    (item.alternates ?? []).forEach((alt, ai) => {
      const altAt = `${at}.alternates[${ai}].libraryId`;
      const r = find(alt.libraryId);
      if (!r) {
        add({ path: altAt, code: "unknown_exercise", message: `There's no move "${alt.libraryId}" in the library.`, fix: guessExercise(alt.libraryId), severity: "error" });
        return;
      }
      if (r.id !== alt.libraryId) add({ path: altAt, code: "legacy_id", message: `${r.name} is listed under an old id.`, fix: r.id, severity: "warning" });
      if (r.id === rec.id) return; // the item itself: already judged
      for (const f of judge(r, part.format)) {
        // A future day's gate waits on the item's own pending rule; a flare is the item's cost, judged when swapped in.
        if (f.pending || f.code === "condition_flare") continue;
        add({ path: altAt, code: f.code, message: f.message, severity: f.severity });
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
    } else if (rec.dose.type === "carry" && dose.reps !== undefined && dose.holdSec === undefined && dose.carryM === undefined) {
      // A library carry's range is seconds: a timed carry.
      const { reps: _r, ...rest } = dose;
      add({ path, code: "dose_mismatch", message: `${name} is carried for time, not counted in reps.`, fix: JSON.stringify({ ...rest, ...ownAmount(rec) }), severity: "warning" });
    } else if (rec.dose.type === "breaths" && dose.reps !== undefined && dose.breaths === undefined) {
      const { reps: _r, ...rest } = dose;
      add({ path, code: "dose_mismatch", message: `${name} is counted in breaths, not reps.`, fix: JSON.stringify({ ...rest, ...ownAmount(rec) }), severity: "warning" });
    } else if (rec.dose.type === "reps" && dose.holdSec !== undefined && dose.reps === undefined && !TIMED_FORMATS.has(format)) {
      const { holdSec: _h, ...rest } = dose;
      add({ path, code: "dose_mismatch", message: `${name} is counted in reps, not held for time.`, fix: JSON.stringify({ ...rest, ...ownAmount(rec) }), severity: "warning" });
    }
  }

  return issues;
}

/**
 * Whether a jump added at the end of part `partIndex` raises no `jump_placement`: the part is straight sets or a
 * superset, no other part holds a jump, and no lift plays before it (in an earlier lifting part, or in this one).
 */
export function jumpPlaceableIn(doc: Pick<WorkoutDoc, "parts">, partIndex: number, find: (id: string) => ExerciseRecord | undefined): boolean {
  const part = doc.parts[partIndex];
  if (!part || !JUMP_FORMATS.has(part.format)) return false;
  return doc.parts.every((p, pi) =>
    p.items.every((item) => {
      const rec = item.kind === "exercise" ? find(item.libraryId) : undefined;
      if (!rec) return true;
      if (isPlyometric(rec)) return pi === partIndex;
      return !(pi <= partIndex && LIFTING_PARTS.has(p.purpose) && isLift(rec));
    }),
  );
}

function hasAmount(dose: WorkoutDose): boolean {
  return dose.reps !== undefined || dose.holdSec !== undefined || dose.breaths !== undefined || dose.carryM !== undefined || dose.max === true;
}

/** The record's own amount: its dose range's midpoint (reps keep the range). */
function ownAmount(rec: ExerciseRecord): Partial<WorkoutDose> {
  const [lo, hi] = rec.dose.range;
  const mid = Math.round((lo + hi) / 2);
  switch (rec.dose.type) {
    // A library carry's range is seconds: a timed carry.
    case "time":
    case "carry":
      return { holdSec: mid };
    case "breaths":
      return { breaths: mid };
    default:
      return { reps: lo === hi ? lo : { min: lo, max: hi } };
  }
}

/** "a", "a and b", "a, b and c" — at most three named, then "and others". */
function listWords(xs: readonly string[]): string {
  const named = xs.length > 3 ? [...xs.slice(0, 3), "others"] : xs;
  return named.length <= 1 ? named.join("") : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
}

/** The gear a move needs that `have` lacks, in plain words. */
function missingGear(rec: ExerciseRecord, have: readonly string[]): string {
  const got = new Set(have);
  const word = (id: string): string => (EQUIPMENT as Readonly<Record<string, string>>)[id]?.toLowerCase() ?? id;
  const parts = rec.equipment.all.filter((id) => !got.has(id)).map(word);
  if (rec.equipment.oneOf.length && !rec.equipment.oneOf.some((id) => got.has(id))) parts.push(rec.equipment.oneOf.map(word).join(" or "));
  return parts.join(" and ");
}

// ── Schema issues in plain words ──

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** The document's field names as the athlete would say them. */
const FIELD_WORDS: Readonly<Record<string, string>> = {
  title: "The title", summary: "The summary", notes: "The notes", why: "The why", cue: "The cue", progression: "The progression note",
  name: "The name", typed: "The typed text", libraryId: "The move id", placeId: "The place", keyResultId: "The key result",
  objectiveIds: "Objectives", holdSec: "Hold time (seconds)", restSec: "Rest (seconds)", restBetweenRoundsSec: "Rest between rounds (seconds)",
  carryM: "Carry distance (metres)", durationSec: "Duration (seconds)", distanceM: "Distance (metres)", seconds: "Rest (seconds)",
  targetMinutes: "Target minutes", eccentricSec: "Lowering time (seconds)", pauseSec: "Pause (seconds)", concentricSec: "Lifting time (seconds)",
  fastSecPerKm: "The fast pace", slowSecPerKm: "The slow pace", kg: "The weight (kg)",
};

/** The schema's own refinements, said plainly. */
const REFINE_WORDS: Readonly<Record<string, string>> = {
  "reps min must not exceed max": "The fewest reps can't be more than the most.",
  "a run segment needs a duration, a distance or open": "A run needs a time, a distance, or to be left open for the lap button.",
  "fast pace must not be slower than slow pace": "The fast pace can't be slower than the slow pace.",
  "hr low must not exceed high": "The low heart rate can't be above the high one.",
};

function fieldWords(path: ReadonlyArray<string | number>): string {
  const last = path[path.length - 1];
  if (last === undefined) return "The workout";
  const words = (key: string): string => FIELD_WORDS[key] ?? capitalize(key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase());
  if (typeof last === "number") {
    const key = [...path].reverse().find((s): s is string => typeof s === "string");
    return key ? `An entry in ${words(key).replace(/^The /, "").toLowerCase()}` : "An entry";
  }
  return words(last);
}

function plainSchemaIssue(i: ZodIssue): string {
  const what = fieldWords(i.path);
  switch (i.code) {
    case "invalid_type":
      if (i.received === "undefined" || i.received === "null") return `${what} is missing.`;
      return i.path.length === 0 ? "This isn't a workout." : `${what} isn't the right kind of value.`;
    case "too_small":
      if (i.type === "string") return Number(i.minimum) <= 1 ? `${what} can't be empty.` : `${what} needs at least ${String(i.minimum)} characters.`;
      if (i.type === "array") return `${what} must have at least ${String(i.minimum)}.`;
      return `${what} must be at least ${String(i.minimum)}.`;
    case "too_big":
      if (i.type === "string") return `${what} is too long (at most ${String(i.maximum)} characters).`;
      if (i.type === "array") return `${what} can have at most ${String(i.maximum)}.`;
      return `${what} must be at most ${String(i.maximum)}.`;
    case "invalid_enum_value":
      return `${what} must be one of: ${i.options.join(", ")}.`;
    case "invalid_union_discriminator":
      return `${what} must be one of: ${i.options.map(String).join(", ")}.`;
    case "invalid_literal":
      return `${what} must be ${JSON.stringify(i.expected)}.`;
    case "custom":
      return REFINE_WORDS[i.message] ?? `${capitalize(i.message)}.`;
    default:
      return `${what} isn't valid.`;
  }
}
