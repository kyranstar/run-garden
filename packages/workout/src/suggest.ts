/**
 * Suggestions for one part of a workout (Stage 2 spec §8; principles §2.1, §2.5): the prompting around warm-ups and
 * cool-downs, so a part is filled with intention. Pure; the Studio's builder and the Worker share it.
 *
 * RULES
 * - The work: the library moves in the document's main parts (with none, its power, accessory and conditioning parts).
 *   Its patterns, regions, prime movers (the primary muscles of its lifts — moves with a strength or power purpose —
 *   else of all its moves, plus the stabilisers its patterns lean on: the rotator cuff, serratus and lower traps for a
 *   press, the glute med for a squat or a lunge) and the muscles it works (primary and secondary) are what the other
 *   parts answer to. Its warm-up areas are its regions plus what its patterns ask of the joints (a squat or a lunge:
 *   ankles and hips; a hinge: hips; a push or a pull: the upper spine and shoulders).
 * - Focus: `ctx.focusRefs`, then the document's `intent.focus` (region or muscle ids; others are ignored). A move meets
 *   a focus region through its regions or a primary muscle under it (`MUSCLE_REGION`), a focus muscle through its
 *   primary muscles.
 * - By the part's purpose:
 *   warm-up: moves that raise the temperature and rehearse — warm-up moves, or mobility moves whose other purposes are
 *     not only stretching, cooling down or recovering; never a passive move. Rehearsing a pattern of the work (+4),
 *     warming its warm-up areas (+1 each, at most 2), a focus area (+1; +2 with no work), a warm-up purpose (+1). With
 *     no work and no focus: warm-up moves, plainly.
 *   activation: activation moves whose primary muscles are the work's prime movers (+3); a tag that names waking a prime
 *     mover (glute activation before a hinge or a squat, +3); sharing a region with the work (+1). With no work, a
 *     focus area; with neither, nothing to wake: none.
 *   cool-down: stretch, cool-down, recovery or passive moves (+2), or mobility moves that are not warm-ups; never a
 *     lift. Easing a muscle the work used (+3), its regions (+1 each, at most 2), a focus area (+2). With no work and no
 *     focus: cool-down moves, to wind down.
 *   care: the care moves of each active profile that has care content (`careProfileOf`: its care block's roles,
 *     through the profile's contract; this file never names a profile).
 *   main (lifts), accessory (accessory-role strength or balance moves): a focus area (+3), a pattern the work lacks
 *     (+2), sharing the work's regions (+1), a region it leaves out (+2); with neither work nor focus, every such move,
 *     by the areas it builds. A core lift is +1 in the main part, a move that is only an accessory +1 in the accessory
 *     part (so each goes where it fits best). power: power moves, sharing the work's regions (+1), while fresh. arrive: breathing and
 *     passive moves. conditioning: conditioning moves. run: none.
 *   Easier first in every part: −0.5 per difficulty step above 1 (a jump's gentlest rungs first; no hard eccentric
 *   leading an accessory part).
 * - One part per move: a move another part of the document wants more (a higher fit there; on a tie, the earlier part)
 *   is offered there, not here.
 * - Never: a move already in the document (items or alternates), or of a family already in the part; set aside
 *   (`ctx.excluded`); needing gear the place lacks (`ctx.equipment`); raising any issue — error or warning — at the
 *   item in that part, for the day (`validateWorkoutDoc` with the day, the active profiles, the set-aside list and the
 *   gear): a suggestion is never a cost. A schema issue anywhere else in the probe is a programming error: it throws.
 *   A jump (plyometric) only in a power part, on a day that is the day itself (not a template or a future day), above
 *   recovery mode, not feeling off — the profiles' gates then decide through the validator — and on the athlete's
 *   frontier (`onFrontier` over `day.done`; with no record of what was done, the bottom rungs only).
 * - Rank: fit, + 2 when not in `ctx.recentIds` (novelty), + 1.5 when pinned; ties by a seeded order when `ctx.seed` is
 *   given (variety from day to day), else by name (Intl.Collator("en")), then id. Up to three, one per family, each
 *   with a different reason before any reason repeats (variety).
 * - A reason is one short line in plain words ("wakes the glutes before Romanian deadlift"), at most 120 characters,
 *   fit for an item's `why`.
 */
import type { WorkoutDoc, WorkoutDose, WorkoutItem, WorkoutPart } from "@rg/domain";
import {
  MUSCLES,
  MUSCLE_REGION,
  REGIONS,
  hasEquipment,
  isPlyometric,
  label,
  onFrontier,
  type ConditionProfile,
  type ExerciseRecord,
  type MuscleId,
  type Pattern,
  type Region,
} from "@rg/exercise-library";
import { Rng } from "@rg/session-engine";
import { makeLibraryIndex, modeOfEffort } from "./derive.js";
import { validateWorkoutDoc, type DayContext } from "./validate.js";

export interface SuggestCtx {
  /** Condition profiles switched on: their rules apply, and their care moves are offered. */
  activeProfiles: readonly ConditionProfile[];
  /** The day the workout is for (null: a template). */
  day: DayContext | null;
  /** The athlete's focus areas: region or muscle ids. */
  focusRefs: readonly string[];
  /** Library ids done recently: they give way to the others. */
  recentIds: readonly string[];
  /** Library ids the athlete pinned. */
  pinned: readonly string[];
  /** Library ids the athlete set aside ("not for me"). */
  excluded: readonly string[];
  /** The place's gear: a suggestion needs nothing else. */
  equipment: readonly string[];
  /** Breaks ties in a seeded order (e.g. the day), so equal fits take turns; without it, by name. */
  seed?: number;
}

export interface Suggestion {
  libraryId: string;
  /** Why it belongs here, in plain words. */
  reason: string;
}

type PartPurpose = WorkoutPart["purpose"];

// ── Library facts the suggestions and the quick starts share ──

export const REGION_SET: ReadonlySet<string> = new Set<string>(REGIONS);
const MUSCLE_SET: ReadonlySet<string> = new Set<string>(MUSCLES);
/** A move with no deliberate effort against resistance: release, rest, relaxed breathing or a relaxed hold. */
export const passiveOnly = (r: ExerciseRecord): boolean => r.contraction.every((c) => c === "passive");
/** The active profile whose care this move belongs to (its care block's roles, and the block takes it), if any. */
export function careProfileOf(rec: ExerciseRecord, profiles: readonly ConditionProfile[]): ConditionProfile | undefined {
  return profiles.find((p) => p.care !== null && p.blockAssignable(rec) && rec.roles.some((r) => p.care!.block.roles.includes(r)));
}
/** Area words a reason reads better with than the chip's label. */
const AREA_WORDS: Readonly<Record<string, string>> = { thoracic: "upper spine", "full-body": "whole body" };
/** An area (region or muscle) in the words of a reason. */
export const areaWord = (id: string): string => AREA_WORDS[id] ?? label(id).toLowerCase();
/** Region and muscle ids among `ids`, each once, in order. */
export function focusIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].filter((id) => REGION_SET.has(id) || MUSCLE_SET.has(id));
}
/** The first focus area the move meets, or null: a region through its regions or a primary muscle under it, a muscle through its primary muscles. */
export function focusMet(rec: ExerciseRecord, ids: readonly string[]): string | null {
  for (const id of ids) {
    if (REGION_SET.has(id) && (rec.regions.includes(id as Region) || rec.muscles.primary.some((m) => MUSCLE_REGION[m] === id))) return id;
    if (MUSCLE_SET.has(id) && rec.muscles.primary.includes(id as MuscleId)) return id;
  }
  return null;
}

const MAX_SUGGESTIONS = 3;
const NOVELTY = 2;
const PIN = 1.5;
/** Fit lost per difficulty step above 1. */
export const EASIER = 0.5;
const REASON_MAX = 120;
/** How many items one probe document holds (a part holds at most 60). */
const PROBE_CHUNK = 60;
const LIFT_PURPOSES = new Set(["strength", "power"]);
/** Parts whose moves are light: one set each. */
const LIGHT_PARTS = new Set<PartPurpose>(["arrive", "warmup", "activation", "cooldown", "care"]);
/** Patterns a warm-up can rehearse, in the words of a reason. Mobility, breathing and release are not rehearsed. */
const PATTERN_WORDS: Partial<Record<Pattern, string>> = {
  squat: "squat", hinge: "hinge", lunge: "lunge", "push-h": "push", "push-v": "press", "pull-h": "row", "pull-v": "pull",
  carry: "carry", rotate: "turn", "anti-rotate": "brace", "anti-extend": "brace", "anti-lateral": "brace",
};
/** What a pattern asks of the joints beyond the areas its moves list: what its warm-up warms too. */
const WARMUP_AREAS: Partial<Record<Pattern, readonly Region[]>> = {
  squat: ["ankles", "hips"], lunge: ["ankles", "hips"], hinge: ["hips"],
  "push-h": ["thoracic", "shoulders"], "push-v": ["thoracic", "shoulders"], "pull-h": ["thoracic", "shoulders"], "pull-v": ["thoracic", "shoulders"],
};
/** The stabilisers a pattern leans on: what its activation wakes beside the prime movers. */
const STABILISERS: Partial<Record<Pattern, readonly MuscleId[]>> = {
  "push-h": ["rotator-cuff", "serratus-anterior", "lower-traps"], "push-v": ["rotator-cuff", "serratus-anterior", "lower-traps"],
  squat: ["glute-med"], lunge: ["glute-med"],
};
/** A tag that says the move wakes these muscles. */
const ACTIVATION_TAGS: Readonly<Record<string, readonly MuscleId[]>> = { "glute-activation": ["glute-max", "glute-med"] };
const byName = new Intl.Collator("en");

const word = areaWord;
const regionWord = (m: MuscleId): string => word(MUSCLE_REGION[m]);
const both = (xs: readonly string[]): string => (xs.length > 1 ? `${xs[0]} and ${xs[1]}` : xs[0] ?? "");
const isLift = (r: ExerciseRecord): boolean => r.purposes.some((p) => LIFT_PURPOSES.has(p));
const allMuscles = (r: ExerciseRecord): MuscleId[] => [...r.muscles.primary, ...r.muscles.secondary];
const COOLING = new Set<string>(["stretch", "cooldown", "recovery"]);
/**
 * A move that raises the temperature and rehearses: never passive; a warm-up move, or a mobility move whose other
 * purposes are not only stretching, cooling down or recovering (a held stretch or a recovery flow stays for later).
 */
const warms = (r: ExerciseRecord): boolean => {
  if (passiveOnly(r)) return false;
  if (r.purposes.includes("warmup")) return true;
  if (!r.purposes.includes("mobility")) return false;
  const rest = r.purposes.filter((p) => p !== "mobility");
  return !(rest.length > 0 && rest.every((p) => COOLING.has(p)));
};
const easierBy = (rec: ExerciseRecord, per = EASIER): number => per * (rec.difficulty - 1);

/** The dose a suggested move starts with: its own range's low end (reps keep the range); one set in a light part. */
export function suggestedDose(rec: ExerciseRecord, purpose: PartPurpose): WorkoutDose {
  const [lo, hi] = rec.dose.range;
  const sets = LIGHT_PARTS.has(purpose) ? 1 : (rec.dose.sets?.[0] ?? 1);
  const amount: WorkoutDose =
    rec.dose.type === "time" ? { holdSec: lo } : rec.dose.type === "breaths" ? { breaths: lo } : rec.dose.type === "carry" ? { carryM: lo } : { reps: lo === hi ? lo : { min: lo, max: hi } };
  return { sets, ...amount, ...(rec.laterality !== "bilateral" ? { perSide: true } : {}) };
}

/** A suggested move as an item for a part of this purpose, with its reason as the item's why. */
export function suggestedItem(rec: ExerciseRecord, purpose: PartPurpose, why?: string): WorkoutItem {
  return { kind: "exercise", libraryId: rec.id, dose: suggestedDose(rec, purpose), ...(why ? { why: why.slice(0, 160) } : {}) };
}

/** What the rest of the workout answers to. */
interface Work {
  recs: readonly ExerciseRecord[];
  patterns: ReadonlySet<Pattern>;
  regions: ReadonlySet<Region>;
  /** Its regions, and what its patterns ask of the joints. */
  warmAreas: ReadonlySet<Region>;
  movers: ReadonlySet<MuscleId>;
  /** The movers that are stabilisers, not the lifts' own primary muscles. */
  stabilisers: ReadonlySet<MuscleId>;
  worked: ReadonlySet<MuscleId>;
}

const WORK_PARTS: readonly (readonly PartPurpose[])[] = [["main"], ["power", "accessory", "conditioning"]];

function workOf(doc: WorkoutDoc, find: (id: string) => ExerciseRecord | undefined): Work {
  let recs: ExerciseRecord[] = [];
  for (const purposes of WORK_PARTS) {
    recs = doc.parts
      .filter((p) => purposes.includes(p.purpose))
      .flatMap((p) => p.items.flatMap((i) => (i.kind === "exercise" ? [find(i.libraryId)] : [])))
      .filter((r): r is ExerciseRecord => r !== undefined);
    if (recs.length) break;
  }
  const lifts = recs.filter(isLift);
  const patterns = new Set(recs.flatMap((r) => r.patterns));
  const prime = new Set((lifts.length ? lifts : recs).flatMap((r) => r.muscles.primary));
  const stabilisers = new Set([...patterns].flatMap((pt) => STABILISERS[pt] ?? []).filter((m) => !prime.has(m)));
  const regions = new Set(recs.flatMap((r) => r.regions));
  return {
    recs,
    patterns,
    regions,
    warmAreas: new Set([...regions, ...[...patterns].flatMap((pt) => WARMUP_AREAS[pt] ?? [])]),
    movers: new Set([...prime, ...stabilisers]),
    stabilisers,
    worked: new Set(recs.flatMap(allMuscles)),
  };
}

interface Scored {
  rec: ExerciseRecord;
  fit: number;
  reason: string;
}
type Scorer = (rec: ExerciseRecord) => { fit: number; reason: string } | null;

/** The name of the first move of the work that passes `has`. */
const nameOf = (work: Work, has: (r: ExerciseRecord) => boolean): string => work.recs.find(has)?.name ?? "the main work";

function scorerFor(purpose: PartPurpose, work: Work, focus: readonly string[], ctx: SuggestCtx): Scorer | null {
  const hasWork = work.recs.length > 0;
  const focusReason = (verb: string, id: string): string => `${verb} your ${word(id)}, a focus area`;

  switch (purpose) {
    case "warmup":
      return (rec) => {
        if (!warms(rec)) return null;
        const warmup = rec.purposes.includes("warmup") ? 1 : 0;
        const pattern = rec.patterns.find((pt) => PATTERN_WORDS[pt] && work.patterns.has(pt));
        const areas = rec.regions.filter((g) => work.warmAreas.has(g));
        const f = focusMet(rec, focus);
        let fit = warmup + Math.min(areas.length, 2) + (f ? (hasWork ? 1 : 2) : 0);
        if (pattern) {
          fit += 4;
          return { fit, reason: `rehearses the ${PATTERN_WORDS[pattern]} for ${nameOf(work, (r) => r.patterns.includes(pattern))}` };
        }
        if (areas.length) {
          const g = areas[0]!;
          return { fit, reason: `warms the ${both(areas.map(word))} for ${nameOf(work, (r) => r.regions.includes(g) || r.patterns.some((pt) => WARMUP_AREAS[pt]?.includes(g)))}` };
        }
        if (f) return { fit, reason: focusReason("warms up", f) };
        if (hasWork || focus.length || !warmup) return null;
        return { fit, reason: "gets you warm and moving" };
      };

    case "activation":
      return (rec) => {
        if (!rec.purposes.includes("activation")) return null;
        const mover = rec.muscles.primary.find((m) => work.movers.has(m));
        const tagged = rec.tags.some((t) => (ACTIVATION_TAGS[t] ?? []).some((m) => work.movers.has(m)));
        if (mover) {
          const fit = 3 + (tagged ? 3 : 0) + (rec.regions.some((g) => work.regions.has(g)) ? 1 : 0);
          if (work.stabilisers.has(mover)) {
            return { fit, reason: `wakes the ${word(mover)} before ${nameOf(work, (r) => r.patterns.some((pt) => STABILISERS[pt]?.includes(mover)))}` };
          }
          return { fit, reason: `wakes the ${regionWord(mover)} before ${nameOf(work, (r) => r.muscles.primary.includes(mover))}` };
        }
        const f = hasWork ? null : focusMet(rec, focus);
        return f ? { fit: 2, reason: focusReason("wakes", f) } : null;
      };

    case "cooldown":
      return (rec) => {
        const easing = rec.purposes.some((p) => p === "stretch" || p === "cooldown" || p === "recovery") || passiveOnly(rec);
        const fits = easing || (rec.purposes.includes("mobility") && !rec.purposes.includes("warmup"));
        if (!fits || isLift(rec)) return null;
        const muscle = rec.muscles.primary.find((m) => work.worked.has(m));
        const regions = rec.regions.filter((g) => work.regions.has(g));
        const f = focusMet(rec, focus);
        const fit = (easing ? 2 : 0) + (muscle ? 3 : 0) + Math.min(regions.length, 2) + (f ? 2 : 0);
        if (muscle) return { fit, reason: `eases the ${regionWord(muscle)} after ${nameOf(work, (r) => allMuscles(r).includes(muscle))}` };
        if (regions.length) return { fit, reason: `eases the ${both(regions.map(word))} after ${nameOf(work, (r) => r.regions.includes(regions[0]!))}` };
        if (f) return { fit, reason: focusReason("eases", f) };
        if (hasWork || focus.length || !rec.purposes.includes("cooldown")) return null;
        return { fit, reason: "helps you wind down" };
      };

    case "care": {
      if (!ctx.activeProfiles.some((p) => p.care !== null)) return null;
      return (rec) => {
        const p = careProfileOf(rec, ctx.activeProfiles);
        return p ? { fit: 2, reason: `part of your ${p.care!.block.label.toLowerCase()}` } : null;
      };
    }

    case "power":
      return (rec) => (rec.purposes.includes("power") ? { fit: 1 + (rec.regions.some((g) => work.regions.has(g)) ? 1 : 0), reason: "adds spring while you're fresh" } : null);

    case "main":
    case "accessory":
      return (rec) => {
        const fits = purpose === "main" ? rec.purposes.includes("strength") : rec.roles.includes("accessory") && rec.purposes.some((p) => p === "strength" || p === "balance");
        if (!fits) return null;
        // Where it fits best: a core lift in the main part, a move that is only an accessory in the accessory part.
        const edge = (purpose === "main") === rec.roles.includes("core") ? 1 : 0;
        const f = focusMet(rec, focus);
        if (f) return { fit: 3 + edge, reason: focusReason("works", f) };
        const newPattern = rec.patterns.find((pt) => PATTERN_WORDS[pt] && !work.patterns.has(pt));
        const newRegions = rec.regions.filter((g) => !work.regions.has(g));
        const shared = rec.regions.filter((g) => work.regions.has(g));
        if (hasWork && newPattern) return { fit: 2 + edge, reason: `adds a ${PATTERN_WORDS[newPattern]} the workout lacks` };
        if (hasWork && shared.length) return { fit: 1 + edge, reason: `backs up ${nameOf(work, (r) => r.regions.includes(shared[0]!))}` };
        if (hasWork && newRegions.length) return { fit: 2 + edge, reason: `works the ${both(newRegions.map(word))}, which the workout leaves out` };
        if (hasWork || focus.length) return null;
        return { fit: edge, reason: `builds your ${both(rec.regions.map(word))}` };
      };

    case "arrive":
      return (rec) => (rec.patterns.includes("breathe") || (passiveOnly(rec) && rec.purposes.includes("recovery")) ? { fit: rec.patterns.includes("breathe") ? 2 : 1, reason: "settles your breathing before you start" } : null);

    case "conditioning":
      return (rec) => (rec.purposes.includes("conditioning") ? { fit: 1, reason: "keeps your heart rate up" } : null);

    default:
      return null;
  }
}

/** Whether a jump may be offered at all for this part on this day (the profiles' gates then decide, in the validator). */
function jumpsOpen(purpose: PartPurpose, doc: WorkoutDoc, day: DayContext | null): boolean {
  return purpose === "power" && day !== null && day.date <= day.today && !day.feelingOff && modeOfEffort(doc.intent.effort) !== "recovery";
}

/**
 * The ids among `recs` that raise no issue at all as items of a part like `part`, on the day: one probe document per
 * chunk, holding only that part, so the rest of a draft (empty parts, a missing title) cannot get in the way. A schema
 * issue outside the probe's items means the part or the effort is malformed: a programming error, thrown.
 */
export function cleanInPart(recs: readonly ExerciseRecord[], part: Pick<WorkoutPart, "purpose" | "format">, effort: WorkoutDoc["intent"]["effort"], library: readonly ExerciseRecord[], ctx: SuggestCtx): Set<string> {
  const clean = new Set<string>();
  for (let i = 0; i < recs.length; i += PROBE_CHUNK) {
    const chunk = recs.slice(i, i + PROBE_CHUNK);
    const probe: WorkoutDoc = {
      version: 1, title: "Probe", intent: { summary: "Probe.", goals: [], focus: [], effort },
      parts: [{ purpose: part.purpose, format: part.format, items: chunk.map((r) => suggestedItem(r, part.purpose)) }],
      source: { kind: "studio" },
    };
    const issues = validateWorkoutDoc(probe, { library, activeProfiles: ctx.activeProfiles, day: ctx.day, excluded: ctx.excluded, equipment: ctx.equipment });
    const malformed = issues.find((x) => x.code === "bounds" && !/^parts\[0\]\.items\[\d+\]/.test(x.path));
    if (malformed) throw new Error(`A suggestion probe is malformed at ${malformed.path}: ${malformed.message}`);
    const bad = new Set<number>();
    for (const x of issues) {
      const m = /^parts\[0\]\.items\[(\d+)\]/.exec(x.path);
      if (m) bad.add(Number(m[1]));
    }
    chunk.forEach((r, k) => {
      if (!bad.has(k)) clean.add(r.id);
    });
  }
  return clean;
}

/** Fit, novelty and pins; ties in a seeded order when `seed` is given, else by name; then id. */
export function rankScored<T extends { rec: ExerciseRecord; fit: number }>(
  xs: readonly T[], recent: ReadonlySet<string>, pinned: ReadonlySet<string>, opts: { jitter?: (rec: ExerciseRecord) => number; seed?: number } = {},
): T[] {
  const score = (x: T): number => x.fit + (recent.has(x.rec.id) ? 0 : NOVELTY) + (pinned.has(x.rec.id) ? PIN : 0) + (opts.jitter ? opts.jitter(x.rec) : 0);
  const scores = new Map(xs.map((x) => [x, score(x)]));
  const seeded = opts.seed === undefined ? null : new Map(xs.map((x) => [x, Rng.hash(`${opts.seed}:${x.rec.id}`)]));
  return [...xs].sort(
    (a, b) =>
      scores.get(b)! - scores.get(a)! ||
      (seeded ? seeded.get(a)! - seeded.get(b)! : byName.compare(a.rec.name, b.rec.name)) ||
      (a.rec.id < b.rec.id ? -1 : a.rec.id > b.rec.id ? 1 : 0),
  );
}

export function suggestForPart(doc: WorkoutDoc, partIndex: number, library: readonly ExerciseRecord[], ctx: SuggestCtx): Suggestion[] {
  const part = doc.parts[partIndex];
  if (!part) return [];
  const find = makeLibraryIndex(library);
  const canonical = (id: string): string => find(id)?.id ?? id;
  const work = workOf(doc, find);
  const focus = focusIds([...ctx.focusRefs, ...doc.intent.focus]);
  const scorers = new Map<PartPurpose, Scorer | null>();
  const scorerOf = (purpose: PartPurpose): Scorer | null => {
    if (!scorers.has(purpose)) scorers.set(purpose, scorerFor(purpose, work, focus, ctx));
    return scorers.get(purpose)!;
  };
  if (!scorerOf(part.purpose)) return [];

  const inDoc = new Set(
    doc.parts.flatMap((p) => p.items.flatMap((i) => (i.kind === "exercise" ? [i.libraryId, ...(i.alternates ?? []).map((a) => a.libraryId)] : []))).map(canonical),
  );
  const excluded = new Set(ctx.excluded.map(canonical));
  const familiesOf = doc.parts.map((p) => new Set(p.items.flatMap((i) => (i.kind === "exercise" ? [find(i.libraryId)?.family] : [])).filter((f): f is string => f !== undefined)));
  const done = ctx.day?.done ? new Set([...ctx.day.done].map(canonical)) : new Set<string>();

  /** The move's fit in part `pi` of this document, or null when that part would not take it. */
  const fitIn = (rec: ExerciseRecord, pi: number): { fit: number; reason: string } | null => {
    const p = doc.parts[pi]!;
    const scorer = scorerOf(p.purpose);
    if (!scorer || familiesOf[pi]!.has(rec.family)) return null;
    if (isPlyometric(rec) && !(jumpsOpen(p.purpose, doc, ctx.day) && onFrontier(rec, (id) => done.has(canonical(id))))) return null;
    const s = scorer(rec);
    return s ? { fit: s.fit - easierBy(rec), reason: s.reason } : null;
  };
  /** Another part of a different kind wants the move more (or as much, and comes first). */
  const belongsElsewhere = (rec: ExerciseRecord, fit: number): boolean =>
    doc.parts.some((p, qi) => {
      if (qi === partIndex || p.purpose === part.purpose) return false;
      const there = fitIn(rec, qi);
      return there !== null && (there.fit > fit || (there.fit === fit && qi < partIndex));
    });

  const scored: Scored[] = [];
  for (const rec of library) {
    if (inDoc.has(rec.id) || excluded.has(rec.id) || !hasEquipment(rec, ctx.equipment)) continue;
    const here = fitIn(rec, partIndex);
    if (!here || belongsElsewhere(rec, here.fit)) continue;
    scored.push({ rec, fit: here.fit, reason: here.reason.slice(0, REASON_MAX) });
  }

  const clean = cleanInPart(scored.map((s) => s.rec), part, doc.intent.effort, library, ctx);
  const ranked = rankScored(scored.filter((s) => clean.has(s.rec.id)), new Set(ctx.recentIds.map(canonical)), new Set(ctx.pinned.map(canonical)), { seed: ctx.seed });
  return pickVaried(ranked, MAX_SUGGESTIONS).map((s) => ({ libraryId: s.rec.id, reason: s.reason }));
}

/** Up to `n`, best first, one per family, each with a different reason before any reason repeats. */
function pickVaried(ranked: readonly Scored[], n: number): Scored[] {
  const out: Scored[] = [];
  const families = new Set<string>();
  const reasons = new Set<string>();
  for (const firstPass of [true, false]) {
    for (const s of ranked) {
      if (out.length >= n) break;
      if (out.includes(s) || families.has(s.rec.family) || (firstPass && reasons.has(s.reason))) continue;
      families.add(s.rec.family);
      reasons.add(s.reason);
      out.push(s);
    }
  }
  return out;
}
