/**
 * COROS-imported stages (`PlannedStage[]`, run or strength) → the workout document (programme spec §3.3, Amendment A).
 *
 * RULES — runs (any sport but strength and yoga; a sport other than run is kept, the document's segments being runs)
 * - Top-level warm-up stages → a warm-up part, cool-down stages → a cool-down part, consecutive work / recovery /
 *   rest / open stages → a run part (steady), a repeat → a run part (intervals) with `rounds` = its count and its
 *   children as items. A repeat inside a repeat is kept whole.
 * - Every run stage is a run item: work → the session's effort (below); recovery → effort `recovery`, keeping its own
 *   duration or distance (a jog is not a rest); warm-up and cool-down → `easy`. Only a timed `rest` stage is a rest
 *   item. Duration → `durationSec`, distance → `distanceM`, open / lap button / none → `open` (the last two kept).
 * - Targets: a pace band (low = fast bound, both within 2:00–30:00/km) → `pace`; a heart-rate band → `hr`; a pace
 *   zone (else an hr zone) → `zone`; power, effort and anything out of bounds are kept.
 * - The effort of a work stage: in a repeat, a short one (≤ 30 s or ≤ 200 m) is `strides`; otherwise it follows the
 *   planned workout's category when the caller knows it — easy and recovery → easy, long → long, race → race,
 *   quality → its subtype (threshold, tempo, hills, intervals / vo2 → interval; else interval in a repeat, threshold
 *   out of one); with no category, `interval` in a repeat and `by_feel` out of one.
 * - The intent's effort: recovery → recover, quality → develop, race → peak, else maintain.
 *
 * RULES — strength and yoga
 * - A repeat holding one move is that move with `sets` = the repeat's count; a bare move has no `sets`; consecutive
 *   moves share a main part (straight; flow for yoga). A repeat holding several moves is its own main part (circuit;
 *   flow for yoga) with `rounds`. Warm-up and cool-down stages are their own parts; one inside a repeat is a move of
 *   the repeat's part, its kind kept (as on the run path).
 * - A move's identity: its label through `corosKeyToLibraryId` (the import resolves a step's T-code to COROS's English
 *   name; that name is the key a stored stage keeps) → a library item, its COROS name kept; else a free-text item by
 *   its label ("Exercise" when it has none, kept). Given the library (`meta.library`), a legacy id is the move's id now,
 *   and an id the library no longer has is a free-text item by its label, the id kept.
 * - No stage the document can hold: an open block (strength, yoga) or segment (runs) of the planned workout's length
 *   (`meta.durationSeconds`), else a half-hour block or an open segment.
 * - Its dose: reps → `reps`; time → `holdSec`; distance → `carryM`; open → nothing; loadKg → a load typed in kg (0 is
 *   a load of 0 kg); loadBodyweight → bodyweight; restSeconds → `restSec`. The note is the cue, and — the only carrier
 *   of either — "each side" makes it `perSide` and "<n>s down" its eccentric tempo.
 * - A recovery or timed rest stage among moves is a rest item. Run targets on a move are kept.
 * - Every stage's label the document has no place for (a run step's name, a container's "Group") is kept.
 */
import type { PlannedStage, WorkoutDoc, WorkoutDose, WorkoutItem, WorkoutPart } from "@rg/domain";
import { RUN_EFFORTS } from "@rg/domain";
import {
  bounded, currentId, ECCENTRIC_WORDS, loadOfKg, MAX_LOAD_KG, openBlock, OPEN_BLOCK_NAME, PER_SIDE_WORDS, within,
  type Converted, type KeptEntry, type LibraryIndex,
} from "./shared.js";

export interface StagesMeta {
  title: string;
  /** `planned_workouts.sport`. */
  sport: string;
  /** A stage's label (COROS's English name for the step) → a library id, or null. */
  corosKeyToLibraryId: (key: string) => string | null;
  /** `planned_workouts.category`, when known: it sets the effort of the work. */
  category?: string | null;
  /** `planned_workouts.quality_subtype`, when known. */
  qualitySubtype?: string | null;
  /** The planned workout's length, when known: the stand-in's length when no stage can be held. */
  durationSeconds?: number | null;
  /** `makeLibraryIndex(library)`: canonicalises legacy ids and names gone ones in free text. */
  library?: LibraryIndex;
}

/** The stand-in block's length when the planned workout's own is unknown. */
const DEFAULT_SECONDS = 1800;

type RunEffort = (typeof RUN_EFFORTS)[number];
type Effort = WorkoutDoc["intent"]["effort"];

const EXERCISE_SPORTS = new Set(["strength", "yoga"]);
const STRIDE_SECONDS = 30;
const STRIDE_METERS = 200;
const PACE_MIN = 120;
const PACE_MAX = 1800;

export function docFromStages(stages: PlannedStage[], meta: StagesMeta): Converted<WorkoutDoc> {
  const kept: KeptEntry[] = [];
  const ids = new Set(stages.map((s) => s.id));
  const childrenOf = (parent: string | null): PlannedStage[] =>
    stages
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => (s.parentStageId && ids.has(s.parentStageId) ? s.parentStageId : null) === parent)
      .sort((a, b) => a.s.order - b.s.order || a.i - b.i)
      .map(({ s }) => s);
  const subtree = (s: PlannedStage): PlannedStage[] => [s, ...childrenOf(s.id).flatMap(subtree)];

  const exercise = EXERCISE_SPORTS.has(meta.sport);
  if (!exercise && meta.sport !== "run") {
    kept.push({ at: "workout", field: "sport", value: meta.sport, why: "the document's segments are runs; this is the sport they were" });
  }
  const ctx: Ctx = { meta, kept, childrenOf, subtree };
  let parts = exercise ? exerciseParts(ctx) : runParts(ctx);

  if (parts.length === 0) {
    kept.push({ at: "workout", field: "stages", value: stages, why: "no stage the document can hold: an open block stands in" });
    const known = meta.durationSeconds && meta.durationSeconds >= 1 ? Math.round(meta.durationSeconds) : undefined;
    parts = exercise
      ? [{ purpose: "main", format: meta.sport === "yoga" ? "flow" : "straight", items: [openBlock(OPEN_BLOCK_NAME, known ?? DEFAULT_SECONDS)] }]
      : [{ purpose: "run", format: "steady", items: [{ kind: "run", target: known && known <= 86400 ? { durationSec: known } : { open: true }, effort: workEffort(meta, false) }] }];
  }
  parts = fit(parts, kept);

  return {
    doc: {
      version: 1,
      title: bounded(meta.title || "Workout", 80, kept, "workout", "title") || "Workout",
      intent: { summary: bounded(meta.title || "Workout", 200, kept, "workout", "summary") || "Workout", goals: [], focus: [], effort: effortOfCategory(meta.category) },
      parts,
      source: { kind: "coros_import" },
    },
    kept,
  };
}

interface Ctx {
  meta: StagesMeta;
  kept: KeptEntry[];
  childrenOf: (parent: string | null) => PlannedStage[];
  subtree: (s: PlannedStage) => PlannedStage[];
}

const at = (s: PlannedStage): string => `stage ${s.id}`;

function keep(ctx: Ctx, s: PlannedStage, field: keyof PlannedStage | "stage", why: string, value: unknown = s[field as keyof PlannedStage]): void {
  ctx.kept.push({ at: at(s), field, value, why });
}

// ── Runs ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function runParts(ctx: Ctx): WorkoutPart[] {
  const parts: WorkoutPart[] = [];
  const append = (purpose: WorkoutPart["purpose"], item: WorkoutItem) => {
    const last = parts.at(-1);
    if (last && last.purpose === purpose && last.rounds === undefined) last.items.push(item);
    else parts.push({ purpose, format: "steady", items: [item] });
  };
  for (const s of ctx.childrenOf(null)) {
    if (s.kind === "repeat") {
      const items = ctx.childrenOf(s.id).flatMap((c): WorkoutItem[] => {
        if (c.kind === "repeat") {
          keep(ctx, c, "stage", "a repeat inside a repeat has no place in the document", ctx.subtree(c));
          return [];
        }
        return [runItem(ctx, c, true)];
      });
      repeatFields(ctx, s);
      if (items.length === 0) {
        keep(ctx, s, "stage", "a repeat with nothing the document can hold", ctx.subtree(s));
        continue;
      }
      parts.push({ purpose: "run", format: "intervals", rounds: roundsOf(ctx, s), items });
      continue;
    }
    const purpose = s.kind === "warmup" ? "warmup" : s.kind === "cooldown" ? "cooldown" : "run";
    append(purpose, runItem(ctx, s, false));
  }
  return parts;
}

/** What a repeat container says beyond its count: its name and any prose, kept. */
function repeatFields(ctx: Ctx, s: PlannedStage): void {
  if (s.label !== undefined) keep(ctx, s, "label", "a repeat's name has no place in the document");
  if (s.note !== undefined) keep(ctx, s, "note", "a repeat's prose has no place in the document");
}

function roundsOf(ctx: Ctx, s: PlannedStage): number {
  const n = s.repeatCount ?? 1;
  if (n > 50) keep(ctx, s, "repeatCount", "more than the document's 50 rounds");
  return Math.min(50, Math.max(1, n));
}

function runItem(ctx: Ctx, s: PlannedStage, inRepeat: boolean): WorkoutItem {
  if (s.kind === "rest" && s.durationType === "time" && (s.durationSeconds ?? 0) >= 1 && (s.durationSeconds ?? 0) <= 3600) {
    keep(ctx, s, "kind", "a rest is a rest item, which reads back as a recovery");
    runExtras(ctx, s);
    if (s.targetType && s.targetType !== "none") keep(ctx, s, "targetType", "a rest item has no target");
    if (s.targetLow !== undefined) keep(ctx, s, "targetLow", "a rest item has no target");
    if (s.targetHigh !== undefined) keep(ctx, s, "targetHigh", "a rest item has no target");
    if (s.paceZone !== undefined) keep(ctx, s, "paceZone", "a rest item has no target");
    if (s.hrZone !== undefined) keep(ctx, s, "hrZone", "a rest item has no target");
    if (s.note !== undefined) keep(ctx, s, "note", "a rest item has no cue");
    return { kind: "rest", seconds: s.durationSeconds! };
  }
  if (s.kind === "rest" || s.kind === "open") keep(ctx, s, "kind", `a ${s.kind} stage is a run segment in the document`);
  if (inRepeat && (s.kind === "warmup" || s.kind === "cooldown")) keep(ctx, s, "kind", "a warm-up or cool-down inside a repeat");
  const effort: RunEffort =
    s.kind === "recovery" || s.kind === "rest" ? "recovery"
    : s.kind === "warmup" || s.kind === "cooldown" ? "easy"
    : isShort(s) && inRepeat ? "strides"
    : workEffort(ctx.meta, inRepeat);
  const target = runTarget(ctx, s);
  runExtras(ctx, s);
  const item: WorkoutItem = { kind: "run", target, effort };
  if (s.note !== undefined) item.cue = bounded(s.note, 160, ctx.kept, at(s), "note");
  return item;
}

const isShort = (s: PlannedStage): boolean =>
  (s.durationType === "time" && (s.durationSeconds ?? Infinity) <= STRIDE_SECONDS) ||
  (s.durationType === "distance" && (s.distanceMeters ?? Infinity) <= STRIDE_METERS);

function runTarget(ctx: Ctx, s: PlannedStage): Extract<WorkoutItem, { kind: "run" }>["target"] {
  const t: Extract<WorkoutItem, { kind: "run" }>["target"] = {};
  const seconds = s.durationSeconds;
  const meters = s.distanceMeters;
  if (s.durationType === "time" && seconds !== undefined && seconds >= 1 && seconds <= 86400) {
    t.durationSec = seconds;
    if (meters !== undefined) keep(ctx, s, "distanceMeters", "a timed segment's distance");
  } else if (s.durationType === "distance" && meters !== undefined && meters >= 1 && meters <= 500000) {
    t.distanceM = meters;
    if (seconds !== undefined) keep(ctx, s, "durationSeconds", "a distance segment's duration");
  } else {
    t.open = true;
    if (s.durationType !== "open") keep(ctx, s, "durationType", "the document's open segment reads back as open");
    if (seconds !== undefined) keep(ctx, s, "durationSeconds", "out of the document's bounds, or not this segment's measure");
    if (meters !== undefined) keep(ctx, s, "distanceMeters", "out of the document's bounds, or not this segment's measure");
  }
  const lo = s.targetLow;
  const hi = s.targetHigh;
  const band = (min: number, max: number, int: boolean) =>
    lo !== undefined && hi !== undefined && lo >= min && hi <= max && lo <= hi && (!int || (Number.isInteger(lo) && Number.isInteger(hi)));
  if (s.targetType === "pace" && band(PACE_MIN, PACE_MAX, false)) t.pace = { fastSecPerKm: lo!, slowSecPerKm: hi! };
  else if (s.targetType === "heart_rate" && band(30, 230, true)) t.hr = { low: lo!, high: hi! };
  else if (s.targetType !== undefined && s.targetType !== "none") {
    keep(ctx, s, "targetType", "a target the document cannot hold (power, effort, or a band out of bounds)");
    if (lo !== undefined) keep(ctx, s, "targetLow", "with its target");
    if (hi !== undefined) keep(ctx, s, "targetHigh", "with its target");
  } else {
    if (lo !== undefined) keep(ctx, s, "targetLow", "a bound with no target type");
    if (hi !== undefined) keep(ctx, s, "targetHigh", "a bound with no target type");
  }
  const zone = (z: number | undefined) => z !== undefined && Number.isInteger(z) && z >= 1 && z <= 6;
  if (zone(s.paceZone)) t.zone = { kind: "pace", index: s.paceZone! };
  else if (s.paceZone !== undefined) keep(ctx, s, "paceZone", "out of the document's zones 1–6");
  if (s.hrZone !== undefined) {
    if (!t.zone && zone(s.hrZone)) t.zone = { kind: "hr", index: s.hrZone };
    else keep(ctx, s, "hrZone", t.zone ? "the document holds one zone, and it holds the pace zone" : "out of the document's zones 1–6");
  }
  return t;
}

/** What a run stage carries that a run segment has no place for. */
function runExtras(ctx: Ctx, s: PlannedStage): void {
  if (s.label !== undefined) keep(ctx, s, "label", "a run step's name has no place in the document");
  for (const f of ["reps", "loadKg", "loadBodyweight", "restSeconds", "repeatCount"] as const) {
    if (s[f] !== undefined) keep(ctx, s, f, "a strength field on a run step");
  }
}

function workEffort(meta: StagesMeta, inRepeat: boolean): RunEffort {
  switch (meta.category) {
    case "easy":
    case "recovery":
      return "easy";
    case "long":
      return "long";
    case "race":
      return "race";
    case "quality": {
      const sub = meta.qualitySubtype;
      if (sub === "threshold" || sub === "tempo" || sub === "hills") return sub;
      if (sub === "intervals" || sub === "vo2") return "interval";
      return inRepeat ? "interval" : "threshold";
    }
    default:
      return inRepeat ? "interval" : "by_feel";
  }
}

function effortOfCategory(category: string | null | undefined): Effort {
  return category === "recovery" ? "recover" : category === "quality" ? "develop" : category === "race" ? "peak" : "maintain";
}

// ── Strength and yoga ─────────────────────────────────────────────────────────────────────────────────────────────

function exerciseParts(ctx: Ctx): WorkoutPart[] {
  const yoga = ctx.meta.sport === "yoga";
  const mainFormat: WorkoutPart["format"] = yoga ? "flow" : "straight";
  const parts: WorkoutPart[] = [];
  let main: WorkoutPart | null = null;
  const toMain = (item: WorkoutItem) => {
    if (!main) parts.push((main = { purpose: "main", format: mainFormat, items: [] }));
    main.items.push(item);
  };
  const own = (purpose: WorkoutPart["purpose"], item: WorkoutItem) => {
    main = null;
    const last = parts.at(-1);
    if (last && last.purpose === purpose && last.rounds === undefined) last.items.push(item);
    else parts.push({ purpose, format: mainFormat, items: [item] });
  };

  for (const s of ctx.childrenOf(null)) {
    if (s.kind === "repeat") {
      const kids = ctx.childrenOf(s.id);
      repeatFields(ctx, s);
      const moves = kids.filter((c) => c.kind !== "repeat");
      for (const c of kids.filter((k) => k.kind === "repeat")) keep(ctx, c, "stage", "a repeat inside a repeat has no place in the document", ctx.subtree(c));
      if (moves.length === 0) {
        keep(ctx, s, "stage", "a repeat with nothing the document can hold", ctx.subtree(s));
        continue;
      }
      if (moves.length === 1 && isMoveStage(moves[0]!) && moves[0]!.kind === "work") {
        const sets = s.repeatCount ?? 1;
        if (sets > 20) keep(ctx, s, "repeatCount", "more than the document's 20 sets");
        toMain(moveItem(ctx, moves[0]!, Math.min(20, Math.max(1, sets))));
        continue;
      }
      main = null;
      parts.push({ purpose: "main", format: yoga ? "flow" : "circuit", rounds: roundsOf(ctx, s), items: moves.map((c) => childItem(ctx, c)) });
      continue;
    }
    if (s.kind === "warmup" || s.kind === "cooldown") own(s.kind, moveItem(ctx, s, undefined));
    else toMain(childItem(ctx, s));
  }
  return parts;
}

/** A stage that names a move (not a pause). */
const isMoveStage = (s: PlannedStage): boolean => s.kind !== "recovery" && s.kind !== "rest";

function childItem(ctx: Ctx, s: PlannedStage): WorkoutItem {
  if (!isMoveStage(s) && s.durationType === "time" && (s.durationSeconds ?? 0) >= 1 && (s.durationSeconds ?? 0) <= 3600) {
    if (s.kind === "rest") keep(ctx, s, "kind", "a rest item reads back as a recovery");
    if (s.label !== undefined) keep(ctx, s, "label", "a rest's name has no place in the document");
    if (s.note !== undefined) keep(ctx, s, "note", "a rest item has no cue");
    for (const f of ["targetLow", "targetHigh", "paceZone", "hrZone", "reps", "loadKg", "loadBodyweight", "restSeconds"] as const) {
      if (s[f] !== undefined) keep(ctx, s, f, "a rest item holds only its seconds");
    }
    if (s.targetType && s.targetType !== "none") keep(ctx, s, "targetType", "a rest item has no target");
    return { kind: "rest", seconds: s.durationSeconds! };
  }
  if (!isMoveStage(s)) keep(ctx, s, "kind", "a pause the document can only hold as a move");
  if (s.kind === "open") keep(ctx, s, "kind", "an open stage reads back as work");
  // Only a repeat's children get here as warm-ups or cool-downs (top-level ones are their own parts).
  if (s.kind === "warmup" || s.kind === "cooldown") keep(ctx, s, "kind", "a warm-up or cool-down inside a repeat");
  return moveItem(ctx, s, undefined);
}

function moveItem(ctx: Ctx, s: PlannedStage, sets: number | undefined): WorkoutItem {
  const dose: WorkoutDose = {};
  if (sets !== undefined) dose.sets = sets;
  if (s.reps !== undefined) dose.reps = within(s.reps, 1, 200, ctx.kept, at(s), "reps", "reps");
  switch (s.durationType) {
    case "time":
      if (s.durationSeconds !== undefined && s.durationSeconds >= 1 && s.durationSeconds <= 3600) dose.holdSec = s.durationSeconds;
      else {
        keep(ctx, s, "durationType", "a hold out of the document's 1–3600 s");
        if (s.durationSeconds !== undefined) keep(ctx, s, "durationSeconds", "out of the document's 1–3600 s");
      }
      if (s.distanceMeters !== undefined) keep(ctx, s, "distanceMeters", "a timed move's distance");
      break;
    case "distance":
      if (s.distanceMeters !== undefined && s.distanceMeters >= 1 && s.distanceMeters <= 5000) dose.carryM = s.distanceMeters;
      else {
        keep(ctx, s, "durationType", "a carry out of the document's 1–5000 m");
        if (s.distanceMeters !== undefined) keep(ctx, s, "distanceMeters", "out of the document's 1–5000 m");
      }
      if (s.durationSeconds !== undefined) keep(ctx, s, "durationSeconds", "a carry's duration");
      break;
    case "none":
      if (dose.reps === undefined) keep(ctx, s, "durationType", "a rep step with no reps reads back as open");
      for (const f of ["durationSeconds", "distanceMeters"] as const) if (s[f] !== undefined) keep(ctx, s, f, "not this move's measure");
      break;
    default:
      if (s.durationType === "lap_button") keep(ctx, s, "durationType", "a lap-button step reads back as open");
      if (dose.reps !== undefined) keep(ctx, s, "durationType", "a step with reps reads back as a rep step");
      for (const f of ["durationSeconds", "distanceMeters"] as const) if (s[f] !== undefined) keep(ctx, s, f, "not this move's measure");
  }
  if (s.loadBodyweight) {
    dose.load = "bodyweight";
    if (s.loadKg !== undefined) keep(ctx, s, "loadKg", "a bodyweight step's kilos");
  } else if (s.loadKg !== undefined) {
    if (s.loadKg >= 0 && s.loadKg <= MAX_LOAD_KG) dose.load = loadOfKg(s.loadKg);
    else keep(ctx, s, "loadKg", `out of the document's 0–${MAX_LOAD_KG} kg`);
  } else if (s.loadBodyweight === false) keep(ctx, s, "loadBodyweight", "an explicit no to bodyweight");
  if (s.restSeconds !== undefined) dose.restSec = within(s.restSeconds, 0, 900, ctx.kept, at(s), "restSeconds", "seconds");
  // The note is the only carrier of per-side work and a slow lowering: both read, the words kept as the cue.
  if (s.note !== undefined) {
    if (PER_SIDE_WORDS.test(s.note)) dose.perSide = true;
    const ecc = ECCENTRIC_WORDS.exec(s.note);
    if (ecc && Number(ecc[1]) <= 20) dose.tempo = { eccentricSec: Number(ecc[1]) };
  }
  if (s.targetType !== undefined && s.targetType !== "none") keep(ctx, s, "targetType", "a run target on a move");
  for (const f of ["targetLow", "targetHigh", "paceZone", "hrZone", "repeatCount"] as const) {
    if (s[f] !== undefined) keep(ctx, s, f, "a run field on a move");
  }

  const mapped = s.label ? ctx.meta.corosKeyToLibraryId(s.label) : null;
  const libraryId = mapped ? currentId(mapped, ctx.meta.library, ctx.kept, at(s), "libraryId") : null;
  const cue = s.note !== undefined ? bounded(s.note, 160, ctx.kept, at(s), "note") : undefined;
  if (libraryId) {
    keep(ctx, s, "label", "a mapped move is named by the library; this is COROS's name for it");
    return { kind: "exercise", libraryId, dose, ...(cue !== undefined ? { cue } : {}) };
  }
  if (!s.label) keep(ctx, s, "label", "the step had no name", s.label ?? null);
  const name = s.label ? bounded(s.label, 80, ctx.kept, at(s), "label") : "Exercise";
  return { kind: "free_exercise", name, dose, ...(cue !== undefined ? { cue } : {}) };
}

/** The document's bounds: at most 20 parts of at most 60 items; what does not fit is kept. */
function fit(parts: WorkoutPart[], kept: KeptEntry[]): WorkoutPart[] {
  for (const p of parts) {
    if (p.items.length > 60) {
      kept.push({ at: "workout", field: "items", value: p.items.slice(60), why: "past the document's 60 items in a part" });
      p.items = p.items.slice(0, 60);
    }
  }
  if (parts.length <= 20) return parts;
  kept.push({ at: "workout", field: "parts", value: parts.slice(20), why: "past the document's 20 parts" });
  return parts.slice(0, 20);
}
