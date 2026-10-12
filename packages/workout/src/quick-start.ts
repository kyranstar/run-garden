/**
 * Quick starts (Stage 2 spec §9): workouts built instantly, with no AI, from the library and the day. Pure; varied by
 * `seed` and by what was done recently, never by the clock or `Math.random`.
 *
 * RULES
 * - Kinds and lengths: condition care ≈ 5 min, desk reset ≈ 8 min, hip opener ≈ 10 min (`QUICK_START_MINUTES`); the
 *   derived minutes (`deriveDoc`) land within two minutes of it whenever the library has the moves for the place.
 * - `quickStartDoc` answers `{ doc }`, or `{ reason }` in plain words when it cannot build one: condition care with no
 *   active profile that has care content (`quickStartKinds` leaves it out then), or nothing in the library fits.
 * - Condition care: recovery mode. Its moves have the condition-care purpose: the profiles' care moves
 *   (`careProfileOf`, through the profile contract — this file never names a profile) first, in the block's format,
 *   then the passive ones to let go. Titled by the profile's care block ("… care"; with several profiles,
 *   "Condition care").
 * - Desk reset: desk-relief and posture moves done standing or seated (at the desk); a move in another position only
 *   when those fall short of the length. Hip opener: hip-opening moves (weight 3) and moves for the athlete's focus
 *   areas that serve mobility (weight 1; `focusMet`), the moves only for a focus area at most a third of the items.
 *   Neither carries added weight. Each move goes to one part by what it is for: a passive move → cool-down; else
 *   activation → activation; else warm-up → warm-up; else stretch, mobility, recovery or cool-down → cool-down; a move
 *   that is only a lift is left out. Maintain mode — unless the day asks for recovery (the validator's
 *   `mode_above_day`), then recovery mode; formats the mode allows (warm-up flow; activation straight sets, flow in
 *   recovery; cool-down holds).
 * - Every move says why it is there, with the part's verb and the area it works first: desk reset "loosens" (warm-up),
 *   "wakes" (activation), "opens" (a stretch) or "eases" (cool-down); hip opener "warms up", "wakes", "eases"; a
 *   focus-area move "…your <area>, a focus area"; condition care "part of your … care", then "lets everything soften".
 * - Never a jump, a move set aside, gear the place lacks, two moves of one family, or a move that raises any issue in
 *   its part for the day (the same probe as the suggestions); so the document validates with no error.
 * - Order: fit, easier first (−0.5 per difficulty step above 1; −1 in recovery mode), on a flare day relaxation
 *   (passive, breathing or recovery moves, +1.5) and unresisted moves (+0.5) first, novelty (+2 when not in
 *   `ctx.recentIds`), pins (+1.5) and a seeded jitter in [0, 2.5) per move; ties by name. Filling: one move per part
 *   first, then round the parts in order, a move at a time, never past the length + 1 minute, until the length is
 *   reached; then the fallback moves the same way (desk reset); short of moves, a set is added to each move in turn
 *   (at most three sets).
 */
import type { WorkoutDoc, WorkoutItem, WorkoutPart } from "@rg/domain";
import { MODES, REGIONS, hasEquipment, isPlyometric, label, type ConditionProfile, type ExerciseRecord, type Mode, type Region } from "@rg/exercise-library";
import { Rng } from "@rg/session-engine";
import { deriveDoc, makeLibraryIndex, modeOfEffort } from "./derive.js";
import { EASIER, REGION_SET, areaWord, careProfileOf, cleanInPart, focusIds, focusMet, passiveOnly, rankScored, suggestedItem, type SuggestCtx } from "./suggest.js";
import { validateWorkoutDoc } from "./validate.js";

export type QuickStartKind = "condition_care" | "desk_reset" | "hip_opener";
export const QUICK_START_KINDS: readonly QuickStartKind[] = ["condition_care", "desk_reset", "hip_opener"];
export const QUICK_START_MINUTES: Readonly<Record<QuickStartKind, number>> = { condition_care: 5, desk_reset: 8, hip_opener: 10 };
/** A quick start, or why there is none today. */
export type QuickStart = { doc: WorkoutDoc } | { reason: string };

type Effort = WorkoutDoc["intent"]["effort"];
type PartPurpose = WorkoutPart["purpose"];
type PartFormat = WorkoutPart["format"];

/** The seeded jitter's width: enough to vary the picks, under a matching tag's weight. */
const JITTER = 2.5;
const MAX_SETS = 3;
/** A quick start may run this far past its length. */
const OVER = 1;
/** On a flare day: relaxation first, then moves against no resistance. */
const RELAXED = 1.5;
const UNRESISTED = 0.5;
const OPENS = 3;
const FOCUS = 1;
/** What a hip opener's focus-area moves must serve: mobility, not lifting. */
const MOBILITY_PURPOSES = new Set<string>(["warmup", "mobility", "stretch", "activation", "cooldown", "recovery"]);
/** Where a desk reset is done. */
const AT_THE_DESK = new Set<string>(["standing", "seated"]);

const careProfiles = (profiles: readonly ConditionProfile[]): ConditionProfile[] => profiles.filter((p) => p.care !== null);

/** The quick starts to offer: condition care only while a profile with care content is active. */
export function quickStartKinds(ctx: Pick<SuggestCtx, "activeProfiles">): QuickStartKind[] {
  return QUICK_START_KINDS.filter((k) => k !== "condition_care" || careProfiles(ctx.activeProfiles).length > 0);
}

/** What a part makes of a move: its fit and why; `fallback` only when the rest fall short; `focusOnly` is capped. */
interface Take {
  fit: number;
  why: string;
  fallback?: boolean;
  focusOnly?: boolean;
}

/** One part being filled. */
interface Slot {
  purpose: PartPurpose;
  format: PartFormat;
  why: string;
  /** How the summary says this part. */
  phrase: string;
  take: (rec: ExerciseRecord) => Take | null;
}

interface Plan {
  title: string;
  /** Before the parts' phrases, e.g. "Undo the sitting". */
  lead: string;
  goals: WorkoutDoc["intent"]["goals"];
  focus: (chosen: readonly ExerciseRecord[]) => string[];
  slots: readonly Slot[];
}

/** The format a part of this kind takes in this mode: the first of `prefer` the mode allows, else holds. */
function formatFor(mode: Mode, prefer: readonly PartFormat[]): PartFormat {
  return prefer.find((f) => (MODES[mode].formats as readonly string[]).includes(f)) ?? "holds";
}

type MobilityPart = "warmup" | "activation" | "cooldown";
/** The part a mobility move belongs in, by what it is for; null for a move that is only a lift. */
function partOf(rec: ExerciseRecord): MobilityPart | null {
  if (passiveOnly(rec)) return "cooldown";
  if (rec.purposes.includes("activation")) return "activation";
  if (rec.purposes.includes("warmup")) return "warmup";
  if (rec.purposes.some((p) => p === "stretch" || p === "mobility" || p === "recovery" || p === "cooldown")) return "cooldown";
  return null;
}

/** The regions most of the chosen moves work, most first (library order breaks ties), at most three. */
function topRegions(chosen: readonly ExerciseRecord[]): Region[] {
  const n = new Map<Region, number>();
  for (const r of chosen) for (const g of r.regions) n.set(g, (n.get(g) ?? 0) + 1);
  return REGIONS.filter((g) => g !== "full-body" && n.has(g)).sort((a, b) => n.get(b)! - n.get(a)! || REGIONS.indexOf(a) - REGIONS.indexOf(b)).slice(0, 3);
}

/** The area a move works first, in a reason's words. */
const firstArea = (rec: ExerciseRecord): string => areaWord(rec.regions[0] ?? rec.muscles.primary[0] ?? "full-body");

function mobilitySlots(mode: Mode, take: (rec: ExerciseRecord, part: MobilityPart) => Take | null, words: Record<MobilityPart, { why: string; phrase: string }>): Slot[] {
  const into = (part: MobilityPart) => (rec: ExerciseRecord) => (rec.load !== "external" && partOf(rec) === part ? take(rec, part) : null);
  return [
    { purpose: "warmup", format: formatFor(mode, ["flow"]), ...words.warmup, take: into("warmup") },
    { purpose: "activation", format: formatFor(mode, ["straight", "flow"]), ...words.activation, take: into("activation") },
    { purpose: "cooldown", format: formatFor(mode, ["holds"]), ...words.cooldown, take: into("cooldown") },
  ];
}

function planFor(kind: QuickStartKind, mode: Mode, ctx: SuggestCtx): Plan | null {
  if (kind === "condition_care") {
    const carers = careProfiles(ctx.activeProfiles);
    if (!carers.length) return null;
    const name = carers.length === 1 ? carers[0]!.care!.block.label : label("condition-care");
    const care = (rec: ExerciseRecord): boolean => rec.purposes.includes("condition-care");
    const careRegions = [...new Set(carers.flatMap((p) => Object.keys(p.care!.coverageTargets.regions ?? {})))].filter((g) => REGION_SET.has(g));
    return {
      title: name,
      lead: name,
      goals: ["condition-care"],
      focus: (chosen) => (careRegions.length ? careRegions : topRegions(chosen)),
      slots: [
        {
          purpose: "care",
          format: formatFor(mode, carers[0]!.care!.block.formats as readonly PartFormat[]),
          why: `Gentle ${name.toLowerCase()} first.`,
          phrase: "gentle moves first",
          take: (rec) => {
            const p = care(rec) && !passiveOnly(rec) ? careProfileOf(rec, carers) : undefined;
            return p ? { fit: 1, why: `part of your ${p.care!.block.label.toLowerCase()}` } : null;
          },
        },
        {
          purpose: "cooldown",
          format: formatFor(mode, ["holds"]),
          why: "Then let everything soften.",
          phrase: "then let everything soften",
          take: (rec) => (care(rec) && passiveOnly(rec) ? { fit: 1, why: "lets everything soften" } : null),
        },
      ],
    };
  }

  if (kind === "desk_reset") {
    const VERB: Record<MobilityPart, string> = { warmup: "loosens", activation: "wakes", cooldown: "eases" };
    const take = (rec: ExerciseRecord, part: MobilityPart): Take | null => {
      const desk = rec.tags.includes("desk-relief");
      const posture = rec.tags.includes("posture");
      if (!desk && !posture) return null;
      const verb = part === "cooldown" && rec.purposes.includes("stretch") ? "opens" : VERB[part];
      return { fit: (desk ? 1 : 0) + (posture ? 1 : 0), why: `${verb} the ${firstArea(rec)}`, fallback: !AT_THE_DESK.has(rec.position) };
    };
    return {
      title: "Desk reset",
      lead: "Undo the sitting",
      goals: ["posture"],
      focus: topRegions,
      slots: mobilitySlots(mode, take, {
        warmup: { why: "Get moving after sitting still.", phrase: "get moving" },
        activation: { why: "Wake the muscles that hold you tall.", phrase: "wake the muscles that hold you tall" },
        cooldown: { why: "Open up what sitting closes.", phrase: "open up what sitting closes" },
      }),
    };
  }

  const focus = focusIds(ctx.focusRefs);
  const VERB: Record<MobilityPart, string> = { warmup: "warms up", activation: "wakes", cooldown: "eases" };
  const take = (rec: ExerciseRecord, part: MobilityPart): Take | null => {
    const opens = rec.tags.includes("hip-opening");
    const f = rec.purposes.some((p) => MOBILITY_PURPOSES.has(p)) ? focusMet(rec, focus) : null;
    if (!opens && !f) return null;
    const why = opens ? `${VERB[part]} the ${firstArea(rec)}` : `${VERB[part]} your ${areaWord(f!)}, a focus area`;
    return { fit: (opens ? OPENS : 0) + (f ? FOCUS : 0), why, focusOnly: !opens };
  };
  return {
    title: "Hip opener",
    lead: focus.some((id) => id !== "hips") ? "Open the hips and your focus areas" : "Open the hips",
    goals: ["mobility"],
    focus: () => focusIds(["hips", ...focus]).slice(0, 12),
    slots: mobilitySlots(mode, take, {
      warmup: { why: "Warm up the joints you'll open.", phrase: "warm up the joints" },
      activation: { why: "Use the range as it opens.", phrase: "use the range as it opens" },
      cooldown: { why: "Settle into longer holds.", phrase: "settle into longer holds" },
    }),
  };
}

/** "a, b, then c" — the parts' phrases joined (a phrase that starts with "then" keeps it). */
function joinPhrases(xs: readonly string[]): string {
  const bare = xs.map((x) => x.replace(/^then /, ""));
  if (bare.length <= 1) return bare.join("");
  return `${bare.slice(0, -1).join(", ")}, then ${bare[bare.length - 1]}`;
}

/** Today's reading is a flare for an active profile (its own definition). */
function flareToday(ctx: SuggestCtx): boolean {
  const d = ctx.day;
  if (!d || d.date > d.today) return false;
  return ctx.activeProfiles.some((p) => {
    const r = d.readings[p.id];
    return r != null && p.flare(r);
  });
}

const NOTHING_FITS = "No move in the library fits this quick start here today.";
const NO_CARE = "Condition care needs a condition profile with care switched on.";

type Candidate = { rec: ExerciseRecord } & Take;

function build(kind: QuickStartKind, effort: Effort, library: readonly ExerciseRecord[], ctx: SuggestCtx & { seed: number }): QuickStart {
  const mode = modeOfEffort(effort);
  const plan = planFor(kind, mode, ctx);
  if (!plan) return { reason: NO_CARE };
  const find = makeLibraryIndex(library);
  const canonical = (id: string): string => find(id)?.id ?? id;
  const excluded = new Set(ctx.excluded.map(canonical));
  const recent = new Set(ctx.recentIds.map(canonical));
  const pinned = new Set(ctx.pinned.map(canonical));
  const rng = Rng.create(ctx.seed);
  const jitter = new Map(library.map((r) => [r.id, rng() * JITTER]));
  const target = QUICK_START_MINUTES[kind];
  const flare = flareToday(ctx);
  const easier = mode === "recovery" ? 2 * EASIER : EASIER;
  const lean = (r: ExerciseRecord): number =>
    (jitter.get(r.id) ?? 0) - easier * (r.difficulty - 1) +
    (flare ? (passiveOnly(r) || r.patterns.includes("breathe") || r.purposes.includes("recovery") ? RELAXED : 0) + (r.load === "none" ? UNRESISTED : 0) : 0);

  // Each slot's candidates, clean in that part for the day, best first: the main pool, then the fallback pool.
  const claimed = new Set<string>();
  const pools = plan.slots.map((slot) => {
    const cands: Candidate[] = [];
    for (const rec of library) {
      if (claimed.has(rec.id) || excluded.has(rec.id) || isPlyometric(rec) || !hasEquipment(rec, ctx.equipment)) continue;
      const t = slot.take(rec);
      if (!t) continue;
      claimed.add(rec.id);
      cands.push({ rec, ...t });
    }
    const clean = cleanInPart(cands.map((c) => c.rec), slot, effort, library, ctx);
    return rankScored(cands.filter((c) => clean.has(c.rec.id)), recent, pinned, { jitter: lean });
  });

  const items: WorkoutItem[][] = plan.slots.map(() => []);
  const docOf = (): WorkoutDoc => {
    const chosen = items.flat().flatMap((i) => (i.kind === "exercise" ? [find(i.libraryId)!] : []));
    const phrases = plan.slots.filter((_, k) => items[k]!.length > 0).map((s) => s.phrase);
    return {
      version: 1,
      title: plan.title,
      intent: { summary: `${plan.lead}: ${joinPhrases(phrases)}.`.slice(0, 200), goals: plan.goals, focus: plan.focus(chosen), effort },
      setting: { targetMinutes: target },
      parts: plan.slots.flatMap((s, k) => (items[k]!.length ? [{ purpose: s.purpose, format: s.format, why: s.why, items: items[k]! }] : [])),
      source: { kind: "studio", ref: `quick_start:${kind}` },
    };
  };
  const minutes = (): number => deriveDoc(docOf(), library).estimatedMinutes;
  const families = new Set<string>();
  const used = new Set<Candidate>();
  let count = 0;
  let focusOnly = 0;

  /** Adds the best move of slot `k` in this phase that keeps the workout within its length + OVER; false when none. */
  const addTo = (k: number, fallback: boolean): boolean => {
    for (const c of pools[k]!) {
      if (used.has(c) || Boolean(c.fallback) !== fallback) continue;
      if (families.has(c.rec.family)) {
        used.add(c);
        continue;
      }
      if (c.focusOnly && (focusOnly + 1) * 3 > count + 1) continue; // focus-only moves: at most a third
      items[k]!.push(suggestedItem(c.rec, plan.slots[k]!.purpose, c.why));
      used.add(c);
      if (minutes() <= target + OVER) {
        families.add(c.rec.family);
        count++;
        if (c.focusOnly) focusOnly++;
        return true;
      }
      items[k]!.pop();
    }
    return false;
  };

  for (const fallback of [false, true]) {
    if (fallback && minutes() >= target) break;
    if (!fallback) for (let k = 0; k < plan.slots.length; k++) addTo(k, false);
    const open = new Set(plan.slots.map((_, k) => k));
    while (open.size && minutes() < target) {
      for (const k of [...open]) {
        if (minutes() >= target) break;
        if (!addTo(k, fallback)) open.delete(k);
      }
    }
  }
  // Short of moves: a set more for each move in turn.
  let grew = true;
  while (grew && minutes() < target) {
    grew = false;
    for (const list of items) {
      for (const item of list) {
        if (minutes() >= target || item.kind !== "exercise") continue;
        const sets = item.dose.sets ?? 1;
        if (sets >= MAX_SETS) continue;
        item.dose = { ...item.dose, sets: sets + 1 };
        if (minutes() <= target + OVER) grew = true;
        else item.dose = { ...item.dose, sets };
      }
    }
  }
  if (!items.some((l) => l.length)) return { reason: NOTHING_FITS };
  return { doc: docOf() };
}

/**
 * A quick start for the day: built in maintain mode, rebuilt in recovery when the day asks for it (condition care is
 * always recovery). `{ reason }` when there is none to build.
 */
export function quickStartDoc(kind: QuickStartKind, library: readonly ExerciseRecord[], ctx: SuggestCtx & { seed: number }): QuickStart {
  if (kind === "condition_care") return build(kind, "recover", library, ctx);
  const first = build(kind, "maintain", library, ctx);
  if (!("doc" in first)) return first;
  const issues = validateWorkoutDoc(first.doc, { library, activeProfiles: ctx.activeProfiles, day: ctx.day, excluded: ctx.excluded, equipment: ctx.equipment });
  return issues.some((i) => i.code === "mode_above_day") ? build(kind, "recover", library, ctx) : first;
}
