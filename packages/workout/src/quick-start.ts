/**
 * Quick starts (Stage 2 spec §9): workouts built instantly, with no AI, from the library and the day. Pure; varied by
 * `seed` and by what was done recently, never by the clock or `Math.random`.
 *
 * RULES
 * - Kinds and lengths: condition care ≈ 5 min, desk reset ≈ 8 min, hip opener ≈ 10 min (`QUICK_START_MINUTES`); the
 *   derived minutes (`deriveDoc`) land within two minutes of it whenever the library has the moves for the place.
 * - Condition care: only while an active profile has care content (`quickStartKinds`; `quickStartDoc` throws
 *   otherwise). Recovery mode. Its moves have the condition-care purpose: the profiles' care moves (their care block's
 *   roles, through the profile contract — this file never names a profile) first, in the block's format, then the
 *   passive ones to let go. Titled by the profile's care block ("… care"; with several profiles, "Condition care").
 * - Desk reset: desk-relief and posture moves. Hip opener: hip-opening moves and moves for the athlete's focus areas
 *   (`ctx.focusRefs`, as `suggestForPart` meets them) that serve mobility (warm-up, mobility, stretch, activation,
 *   cool-down or recovery). Neither carries added weight. Each move goes to one part by what it is for: activation →
 *   activation; else warm-up → warm-up; else stretch, mobility, recovery, cool-down or a passive move → cool-down; a
 *   move that is only a lift is left out. Maintain mode — unless the day asks for recovery (the validator's
 *   `mode_above_day`), then recovery mode; formats the mode allows (warm-up and activation flow in recovery, the
 *   activation straight sets otherwise; cool-down holds).
 * - Never a jump, a move set aside, gear the place lacks, two moves of one family, or a move that raises any issue in
 *   its part for the day (the same probe as the suggestions); so the document validates with no error.
 * - Order: fit (a matching tag or focus area), novelty (+2 when not in `ctx.recentIds`), pins (+1.5) and a seeded
 *   jitter in [0, 2.5) per move; ties by name. Filling: one move per part first, then round the parts in order, a move
 *   at a time, never past the length + 1 minute, until the length is reached; short of moves, a set is added to each
 *   move in turn (at most three sets). Every part and item says why it is there.
 */
import type { WorkoutDoc, WorkoutItem, WorkoutPart } from "@rg/domain";
import { MODES, REGIONS, hasEquipment, isPlyometric, label, type ConditionProfile, type ExerciseRecord, type Mode, type Region } from "@rg/exercise-library";
import { Rng } from "@rg/session-engine";
import { deriveDoc, makeLibraryIndex, modeOfEffort } from "./derive.js";
import { areaWord, cleanInPart, focusIds, focusMet, rankScored, suggestedItem, type SuggestCtx } from "./suggest.js";
import { validateWorkoutDoc } from "./validate.js";

export type QuickStartKind = "condition_care" | "desk_reset" | "hip_opener";
export const QUICK_START_KINDS: readonly QuickStartKind[] = ["condition_care", "desk_reset", "hip_opener"];
export const QUICK_START_MINUTES: Readonly<Record<QuickStartKind, number>> = { condition_care: 5, desk_reset: 8, hip_opener: 10 };

type Effort = WorkoutDoc["intent"]["effort"];
type PartPurpose = WorkoutPart["purpose"];
type PartFormat = WorkoutPart["format"];

/** The seeded jitter's width: enough to vary the picks, under a matching tag's weight. */
const JITTER = 2.5;
const MAX_SETS = 3;
/** A quick start may run this far past its length. */
const OVER = 1;
const REGION_SET = new Set<string>(REGIONS);
/** What a hip opener's focus-area moves must serve: mobility, not lifting. */
const MOBILITY_PURPOSES = new Set<string>(["warmup", "mobility", "stretch", "activation", "cooldown", "recovery"]);

const careProfiles = (profiles: readonly ConditionProfile[]): ConditionProfile[] => profiles.filter((p) => p.care !== null);
const passiveOnly = (r: ExerciseRecord): boolean => r.contraction.every((c) => c === "passive");

/** The quick starts to offer: condition care only while a profile with care content is active. */
export function quickStartKinds(ctx: Pick<SuggestCtx, "activeProfiles">): QuickStartKind[] {
  return QUICK_START_KINDS.filter((k) => k !== "condition_care" || careProfiles(ctx.activeProfiles).length > 0);
}

/** One part being filled. */
interface Slot {
  purpose: PartPurpose;
  format: PartFormat;
  why: string;
  /** How the summary says this part. */
  phrase: string;
  /** Whether a move belongs here, and the fit and why it carries. */
  take: (rec: ExerciseRecord) => { fit: number; why: string } | null;
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

/** The part a mobility move belongs in, by what it is for; null for a move that is only a lift. */
function partOf(rec: ExerciseRecord): "activation" | "warmup" | "cooldown" | null {
  if (rec.purposes.includes("activation")) return "activation";
  if (rec.purposes.includes("warmup")) return "warmup";
  if (rec.purposes.some((p) => p === "stretch" || p === "mobility" || p === "recovery" || p === "cooldown") || passiveOnly(rec)) return "cooldown";
  return null;
}

/** The regions most of the chosen moves work, most first (library order breaks ties), at most three. */
function topRegions(chosen: readonly ExerciseRecord[]): Region[] {
  const n = new Map<Region, number>();
  for (const r of chosen) for (const g of r.regions) n.set(g, (n.get(g) ?? 0) + 1);
  return REGIONS.filter((g) => g !== "full-body" && n.has(g)).sort((a, b) => n.get(b)! - n.get(a)! || REGIONS.indexOf(a) - REGIONS.indexOf(b)).slice(0, 3);
}

function mobilitySlots(mode: Mode, take: (rec: ExerciseRecord) => { fit: number; why: string } | null, words: Record<"warmup" | "activation" | "cooldown", { why: string; phrase: string }>): Slot[] {
  const into = (part: "warmup" | "activation" | "cooldown") => (rec: ExerciseRecord) => (rec.load !== "external" && partOf(rec) === part ? take(rec) : null);
  return [
    { purpose: "warmup", format: formatFor(mode, ["flow"]), ...words.warmup, take: into("warmup") },
    { purpose: "activation", format: formatFor(mode, ["straight", "flow"]), ...words.activation, take: into("activation") },
    { purpose: "cooldown", format: formatFor(mode, ["holds"]), ...words.cooldown, take: into("cooldown") },
  ];
}

function planFor(kind: QuickStartKind, mode: Mode, ctx: SuggestCtx): Plan {
  if (kind === "condition_care") {
    const carers = careProfiles(ctx.activeProfiles);
    if (!carers.length) throw new Error("Condition care needs a condition profile with care switched on.");
    const name = carers.length === 1 ? carers[0]!.care!.block.label : label("condition-care");
    const careOf = (rec: ExerciseRecord): ConditionProfile | undefined => carers.find((p) => p.blockAssignable(rec) && rec.roles.some((r) => p.care!.block.roles.includes(r)));
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
            const p = care(rec) && !passiveOnly(rec) ? careOf(rec) : undefined;
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
    const take = (rec: ExerciseRecord): { fit: number; why: string } | null => {
      const desk = rec.tags.includes("desk-relief");
      const posture = rec.tags.includes("posture");
      if (!desk && !posture) return null;
      return { fit: (desk ? 1 : 0) + (posture ? 1 : 0), why: desk ? "undoes the sitting" : "helps you stand tall" };
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
  const take = (rec: ExerciseRecord): { fit: number; why: string } | null => {
    const opens = rec.tags.includes("hip-opening");
    const f = rec.purposes.some((p) => MOBILITY_PURPOSES.has(p)) ? focusMet(rec, focus) : null;
    if (!opens && !f) return null;
    return { fit: (opens ? 2 : 0) + (f ? 2 : 0), why: opens ? "opens the hips" : `eases your ${areaWord(f!)}, a focus area` };
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

function build(kind: QuickStartKind, effort: Effort, library: readonly ExerciseRecord[], ctx: SuggestCtx & { seed: number }): WorkoutDoc {
  const mode = modeOfEffort(effort);
  const plan = planFor(kind, mode, ctx);
  const find = makeLibraryIndex(library);
  const canonical = (id: string): string => find(id)?.id ?? id;
  const excluded = new Set(ctx.excluded.map(canonical));
  const recent = new Set(ctx.recentIds.map(canonical));
  const pinned = new Set(ctx.pinned.map(canonical));
  const rng = Rng.create(ctx.seed);
  const jitter = new Map(library.map((r) => [r.id, rng() * JITTER]));
  const target = QUICK_START_MINUTES[kind];

  // Each slot's candidates, clean in that part for the day, best first. A move belongs to its first slot only.
  const claimed = new Set<string>();
  const queues = plan.slots.map((slot) => {
    const cands: Array<{ rec: ExerciseRecord; fit: number; why: string }> = [];
    for (const rec of library) {
      if (claimed.has(rec.id) || excluded.has(rec.id) || isPlyometric(rec) || !hasEquipment(rec, ctx.equipment)) continue;
      const t = slot.take(rec);
      if (!t) continue;
      claimed.add(rec.id);
      cands.push({ rec, ...t });
    }
    const clean = cleanInPart(cands.map((c) => c.rec), slot, effort, library, ctx);
    return rankScored(cands.filter((c) => clean.has(c.rec.id)), recent, pinned, (r) => jitter.get(r.id) ?? 0);
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
  const next = queues.map(() => 0);
  const families = new Set<string>();
  /** Adds the next move of a slot that keeps the workout within its length + OVER; false when the slot has none. */
  const addTo = (k: number): boolean => {
    const q = queues[k]!;
    while (next[k]! < q.length) {
      const c = q[next[k]!++]!;
      if (families.has(c.rec.family)) continue;
      items[k]!.push(suggestedItem(c.rec, plan.slots[k]!.purpose, c.why));
      if (minutes() <= target + OVER) {
        families.add(c.rec.family);
        return true;
      }
      items[k]!.pop();
    }
    return false;
  };

  for (let k = 0; k < plan.slots.length; k++) addTo(k);
  const open = new Set(plan.slots.map((_, k) => k).filter((k) => next[k]! < queues[k]!.length));
  while (open.size && minutes() < target) {
    for (const k of [...open]) {
      if (minutes() >= target) break;
      if (!addTo(k)) open.delete(k);
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
  if (!items.some((l) => l.length)) throw new Error("No move in the library fits this quick start here today.");
  return docOf();
}

/**
 * A quick start for the day: built in maintain mode, rebuilt in recovery when the day asks for it (condition care is
 * always recovery). Throws for condition care with no profile that has care content, and when nothing fits at all.
 */
export function quickStartDoc(kind: QuickStartKind, library: readonly ExerciseRecord[], ctx: SuggestCtx & { seed: number }): WorkoutDoc {
  if (kind === "condition_care") return build(kind, "recover", library, ctx);
  const doc = build(kind, "maintain", library, ctx);
  const issues = validateWorkoutDoc(doc, { library, activeProfiles: ctx.activeProfiles, day: ctx.day, excluded: ctx.excluded, equipment: ctx.equipment });
  return issues.some((i) => i.code === "mode_above_day") ? build(kind, "recover", library, ctx) : doc;
}
