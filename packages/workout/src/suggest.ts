/**
 * Suggestions for one part of a workout (Stage 2 spec §8; principles §2.1, §2.5): the prompting around warm-ups and
 * cool-downs, so a part is filled with intention. Pure; the Studio's builder and the Worker share it.
 *
 * RULES
 * - The work: the library moves in the document's main parts (with none, its power, accessory and conditioning parts).
 *   Its patterns, regions, prime movers (the primary muscles of its lifts — moves with a strength or power purpose —
 *   else of all its moves) and the muscles it works (primary and secondary) are what the other parts answer to.
 * - Focus: `ctx.focusRefs`, then the document's `intent.focus` (region or muscle ids; others are ignored). A move meets
 *   a focus region through its regions or a primary muscle under it (`MUSCLE_REGION`), a focus muscle through its
 *   primary muscles.
 * - By the part's purpose:
 *   warm-up: warm-up or mobility moves. Rehearsing a pattern of the work (+4), warming its regions (+1 each, at most 2),
 *     a focus area (+1; +2 with no work), a warm-up purpose (+1). With no work and no focus: warm-up moves, plainly.
 *   activation: activation moves whose primary muscles are the work's prime movers (+3); a tag that names waking a prime
 *     mover (glute activation before a hinge or a squat, +3); sharing a region with the work (+1). With no work, a
 *     focus area; with neither, nothing to wake: none.
 *   cool-down: stretch, cool-down, recovery or passive moves (+2), or mobility moves that are not warm-ups; never a
 *     lift. Easing a muscle the work used (+3), its regions (+1 each, at most 2), a focus area (+2). With no work and no
 *     focus: cool-down moves, to wind down.
 *   care: the care moves of each active profile that has care content (its care block's roles, through the profile's
 *     contract; this file never names a profile).
 *   main (lifts), accessory (accessory-role strength or balance moves): a focus area (+3), a pattern the work lacks
 *     (+2), sharing the work's regions (+1), a region it leaves out (+2); with neither work nor focus, every such move,
 *     by the areas it builds. power: power moves, sharing the work's regions (+1), while fresh. arrive: breathing and
 *     passive moves. conditioning: conditioning moves. run: none.
 *   Easier first where a part is light (warm-up, activation, cool-down, care, arrive) and in power (the gentlest rungs
 *   first): −0.5 per difficulty step above 1.
 * - Never: a move already in the document (items or alternates), or of a family already in the part; set aside (`ctx.excluded`); needing gear the place
 *   lacks (`ctx.equipment`); raising any issue — error or warning — at the item in that part, for the day
 *   (`validateWorkoutDoc` with the day, the active profiles, the set-aside list and the gear): a suggestion is never a
 *   cost. A jump (plyometric) only in a power part, on a day that is the day itself (not a template or a future day),
 *   above recovery mode, not feeling off — the profiles' gates then decide through the validator — and on the
 *   athlete's frontier (`onFrontier` over `day.done`; with no record of what was done, the bottom rungs only).
 * - Rank: fit, + 2 when not in `ctx.recentIds` (novelty), + 1.5 when pinned; ties by name (Intl.Collator("en")), then id.
 *   Up to three, one per family, each with a different reason before any reason repeats (variety).
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
}

export interface Suggestion {
  libraryId: string;
  /** Why it belongs here, in plain words. */
  reason: string;
}

type PartPurpose = WorkoutPart["purpose"];

const MAX_SUGGESTIONS = 3;
const NOVELTY = 2;
const PIN = 1.5;
const REASON_MAX = 120;
/** How many items one probe document holds (a part holds at most 60). */
const PROBE_CHUNK = 60;
const LIFT_PURPOSES = new Set(["strength", "power"]);
/** Parts whose moves are light: one set each. */
const LIGHT_PARTS = new Set<PartPurpose>(["arrive", "warmup", "activation", "cooldown", "care"]);
/** Parts that offer the easier moves first (a jump's gentlest rungs first). */
const EASIER_FIRST = new Set<PartPurpose>([...LIGHT_PARTS, "power"]);
/** Patterns a warm-up can rehearse, in the words of a reason. Mobility, breathing and release are not rehearsed. */
const PATTERN_WORDS: Partial<Record<Pattern, string>> = {
  squat: "squat", hinge: "hinge", lunge: "lunge", "push-h": "push", "push-v": "press", "pull-h": "row", "pull-v": "pull",
  carry: "carry", rotate: "turn", "anti-rotate": "brace", "anti-extend": "brace", "anti-lateral": "brace",
};
/** A tag that says the move wakes these muscles. */
const ACTIVATION_TAGS: Readonly<Record<string, readonly MuscleId[]>> = { "glute-activation": ["glute-max", "glute-med"] };
const REGION_SET = new Set<string>(REGIONS);
const MUSCLE_SET = new Set<string>(MUSCLES);
const byName = new Intl.Collator("en");

/** Area words a reason reads better with than the chip's label. */
const AREA_WORDS: Readonly<Record<string, string>> = { thoracic: "upper spine", "full-body": "whole body" };
/** An area (region or muscle) in the words of a reason. */
export const areaWord = (id: string): string => AREA_WORDS[id] ?? label(id).toLowerCase();
const word = areaWord;
const regionWord = (m: MuscleId): string => word(MUSCLE_REGION[m]);
const both = (xs: readonly string[]): string => (xs.length > 1 ? `${xs[0]} and ${xs[1]}` : xs[0] ?? "");
const passiveOnly = (r: ExerciseRecord): boolean => r.contraction.every((c) => c === "passive");
const isLift = (r: ExerciseRecord): boolean => r.purposes.some((p) => LIFT_PURPOSES.has(p));
const allMuscles = (r: ExerciseRecord): MuscleId[] => [...r.muscles.primary, ...r.muscles.secondary];

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
  movers: ReadonlySet<MuscleId>;
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
  return {
    recs,
    patterns: new Set(recs.flatMap((r) => r.patterns)),
    regions: new Set(recs.flatMap((r) => r.regions)),
    movers: new Set((lifts.length ? lifts : recs).flatMap((r) => r.muscles.primary)),
    worked: new Set(recs.flatMap(allMuscles)),
  };
}

/** The focus areas, in order: the athlete's, then the document's; region and muscle ids only. */
interface Focus {
  ids: readonly string[];
}
/** Region and muscle ids among `ids`, each once, in order. */
export function focusIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].filter((id) => REGION_SET.has(id) || MUSCLE_SET.has(id));
}
function focusOf(doc: WorkoutDoc, ctx: SuggestCtx): Focus {
  return { ids: focusIds([...ctx.focusRefs, ...doc.intent.focus]) };
}
/** The first focus area the move meets, or null: a region through its regions or a primary muscle under it, a muscle through its primary muscles. */
export function focusMet(rec: ExerciseRecord, ids: readonly string[]): string | null {
  for (const id of ids) {
    if (REGION_SET.has(id) && (rec.regions.includes(id as Region) || rec.muscles.primary.some((m) => MUSCLE_REGION[m] === id))) return id;
    if (MUSCLE_SET.has(id) && rec.muscles.primary.includes(id as MuscleId)) return id;
  }
  return null;
}
const meets = (rec: ExerciseRecord, focus: Focus): string | null => focusMet(rec, focus.ids);

interface Scored {
  rec: ExerciseRecord;
  fit: number;
  reason: string;
}
type Scorer = (rec: ExerciseRecord) => { fit: number; reason: string } | null;

/** The name of the first move of the work that passes `has`. */
const nameOf = (work: Work, has: (r: ExerciseRecord) => boolean): string => work.recs.find(has)?.name ?? "the main work";

function scorerFor(purpose: PartPurpose, work: Work, focus: Focus, ctx: SuggestCtx): Scorer | null {
  const hasWork = work.recs.length > 0;
  const focusReason = (verb: string, id: string): string => `${verb} your ${word(id)}, a focus area`;

  switch (purpose) {
    case "warmup":
      return (rec) => {
        if (!rec.purposes.some((p) => p === "warmup" || p === "mobility")) return null;
        const warmup = rec.purposes.includes("warmup") ? 1 : 0;
        const pattern = rec.patterns.find((pt) => PATTERN_WORDS[pt] && work.patterns.has(pt));
        const regions = rec.regions.filter((g) => work.regions.has(g));
        const f = meets(rec, focus);
        let fit = warmup + Math.min(regions.length, 2) + (f ? (hasWork ? 1 : 2) : 0);
        if (pattern) {
          fit += 4;
          return { fit, reason: `rehearses the ${PATTERN_WORDS[pattern]} for ${nameOf(work, (r) => r.patterns.includes(pattern))}` };
        }
        if (regions.length) return { fit, reason: `warms the ${both(regions.map(word))} for ${nameOf(work, (r) => r.regions.includes(regions[0]!))}` };
        if (f) return { fit, reason: focusReason("warms up", f) };
        if (hasWork || focus.ids.length || !warmup) return null;
        return { fit, reason: "gets you warm and moving" };
      };

    case "activation":
      return (rec) => {
        if (!rec.purposes.includes("activation")) return null;
        const mover = rec.muscles.primary.find((m) => work.movers.has(m));
        const tagged = rec.tags.some((t) => (ACTIVATION_TAGS[t] ?? []).some((m) => work.movers.has(m)));
        if (mover) {
          const fit = 3 + (tagged ? 3 : 0) + (rec.regions.some((g) => work.regions.has(g)) ? 1 : 0);
          return { fit, reason: `wakes the ${regionWord(mover)} before ${nameOf(work, (r) => r.muscles.primary.includes(mover))}` };
        }
        const f = hasWork ? null : meets(rec, focus);
        return f ? { fit: 2, reason: focusReason("wakes", f) } : null;
      };

    case "cooldown":
      return (rec) => {
        const easing = rec.purposes.some((p) => p === "stretch" || p === "cooldown" || p === "recovery") || passiveOnly(rec);
        const fits = easing || (rec.purposes.includes("mobility") && !rec.purposes.includes("warmup"));
        if (!fits || isLift(rec)) return null;
        const muscle = rec.muscles.primary.find((m) => work.worked.has(m));
        const regions = rec.regions.filter((g) => work.regions.has(g));
        const f = meets(rec, focus);
        const fit = (easing ? 2 : 0) + (muscle ? 3 : 0) + Math.min(regions.length, 2) + (f ? 2 : 0);
        if (muscle) return { fit, reason: `eases the ${regionWord(muscle)} after ${nameOf(work, (r) => allMuscles(r).includes(muscle))}` };
        if (regions.length) return { fit, reason: `eases the ${both(regions.map(word))} after ${nameOf(work, (r) => r.regions.includes(regions[0]!))}` };
        if (f) return { fit, reason: focusReason("eases", f) };
        if (hasWork || focus.ids.length || !rec.purposes.includes("cooldown")) return null;
        return { fit, reason: "helps you wind down" };
      };

    case "care": {
      const carers = ctx.activeProfiles.filter((p) => p.care !== null);
      if (!carers.length) return null;
      return (rec) => {
        const p = carers.find((c) => c.blockAssignable(rec) && rec.roles.some((r) => c.care!.block.roles.includes(r)));
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
        const f = meets(rec, focus);
        if (f) return { fit: 3, reason: focusReason("works", f) };
        const newPattern = rec.patterns.find((pt) => PATTERN_WORDS[pt] && !work.patterns.has(pt));
        const newRegions = rec.regions.filter((g) => !work.regions.has(g));
        const shared = rec.regions.filter((g) => work.regions.has(g));
        if (hasWork && newPattern) return { fit: 2, reason: `adds a ${PATTERN_WORDS[newPattern]} the workout lacks` };
        if (hasWork && shared.length) return { fit: 1, reason: `backs up ${nameOf(work, (r) => r.regions.includes(shared[0]!))}` };
        if (hasWork && newRegions.length) return { fit: 2, reason: `works the ${both(newRegions.map(word))}, which the workout leaves out` };
        if (hasWork || focus.ids.length) return null;
        return { fit: rec.roles.includes("core") ? 1 : 0, reason: `builds your ${both(rec.regions.map(word))}` };
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
 * chunk, holding only that part, so the rest of a draft (empty parts, a missing title) cannot get in the way.
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
    if (issues.some((x) => x.code === "bounds" && !/^parts\[0\]\.items\[\d+\]/.test(x.path))) continue;
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

/** Fit, novelty and pins; ties by name, then id. */
export function rankScored<T extends { rec: ExerciseRecord; fit: number }>(xs: readonly T[], recent: ReadonlySet<string>, pinned: ReadonlySet<string>, jitter?: (rec: ExerciseRecord) => number): T[] {
  const score = (x: T): number => x.fit + (recent.has(x.rec.id) ? 0 : NOVELTY) + (pinned.has(x.rec.id) ? PIN : 0) + (jitter ? jitter(x.rec) : 0);
  const scores = new Map(xs.map((x) => [x, score(x)]));
  return [...xs].sort((a, b) => scores.get(b)! - scores.get(a)! || byName.compare(a.rec.name, b.rec.name) || (a.rec.id < b.rec.id ? -1 : a.rec.id > b.rec.id ? 1 : 0));
}

export function suggestForPart(doc: WorkoutDoc, partIndex: number, library: readonly ExerciseRecord[], ctx: SuggestCtx): Suggestion[] {
  const part = doc.parts[partIndex];
  if (!part) return [];
  const find = makeLibraryIndex(library);
  const canonical = (id: string): string => find(id)?.id ?? id;
  const work = workOf(doc, find);
  const scorer = scorerFor(part.purpose, work, focusOf(doc, ctx), ctx);
  if (!scorer) return [];

  const inDoc = new Set(
    doc.parts.flatMap((p) => p.items.flatMap((i) => (i.kind === "exercise" ? [i.libraryId, ...(i.alternates ?? []).map((a) => a.libraryId)] : []))).map(canonical),
  );
  const excluded = new Set(ctx.excluded.map(canonical));
  const partFamilies = new Set(part.items.flatMap((i) => (i.kind === "exercise" ? [find(i.libraryId)?.family] : [])).filter((f): f is string => f !== undefined));
  const done = ctx.day?.done ? new Set([...ctx.day.done].map(canonical)) : new Set<string>();
  const jumps = jumpsOpen(part.purpose, doc, ctx.day);

  const scored: Scored[] = [];
  for (const rec of library) {
    if (inDoc.has(rec.id) || excluded.has(rec.id) || partFamilies.has(rec.family) || !hasEquipment(rec, ctx.equipment)) continue;
    if (isPlyometric(rec) && !(jumps && onFrontier(rec, (id) => done.has(canonical(id))))) continue;
    const s = scorer(rec);
    if (!s) continue;
    const easier = EASIER_FIRST.has(part.purpose) ? 0.5 * (rec.difficulty - 1) : 0;
    scored.push({ rec, fit: s.fit - easier, reason: s.reason.slice(0, REASON_MAX) });
  }

  const clean = cleanInPart(scored.map((s) => s.rec), part, doc.intent.effort, library, ctx);
  const ranked = rankScored(scored.filter((s) => clean.has(s.rec.id)), new Set(ctx.recentIds.map(canonical)), new Set(ctx.pinned.map(canonical)));
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
