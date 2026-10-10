/**
 * An engine build → the workout document (programme spec §3.3).
 *
 * The build read is the one the worker stores (`session_builds.payload`, made by `composeBuild` from the engine's
 * plan): its steps are what the player plays, its items say which slots there are and how each is run. The document
 * is read back to exactly those steps by `playerStepsFromDoc` (the round-trip test holds it for 50 seeded builds).
 *
 * RULES
 * - Groups: consecutive items of one block and format are one group, except that two straight items are one group
 *   only when a rest stands between them in the steps (the engine plays each core lift as its own group).
 * - Blocks → parts, one group to one part: arrive → arrive, prep → warmup (a run of activation moves — an activation
 *   role and no warm-up role — becomes an activation part), core → main, accessory → accessory, care → care,
 *   cooldown → cooldown. The group's format is the part's format.
 * - Dose, from the steps (what plays), not from the library: sets = the item's sets; a timed window's seconds →
 *   `holdSec` (and a set's reps, when it has a target, → `reps`); a self-paced set's reps → `reps`, or, with no target,
 *   the move's own rep range; the target's weight → load as typed plus kg, a target with no weight → bodyweight, no
 *   target → no load; a window per side, or a set of a one-sided move, → `perSide`; the rest that follows a straight
 *   set → `restSec`.
 * - Superset: equal sets → `rounds` = the sets, each move one set; unequal → each move its own sets. Either way the
 *   rest between rounds is `restBetweenRoundsSec`.
 * - Circuit: `rounds` and the round rest; each station one set of its window, the rest between stations a rest item.
 * - Ladder: `rounds` = the rungs, each move one set of the rungs' rep range (the rungs step evenly from its low to its
 *   high), the rest between rungs `restBetweenRoundsSec`.
 * - Reasons: a slot's reasons → `why` (joined with "; "), its progression note → `progression`, its offered swaps →
 *   `alternates` (the first 3, each with its reasons).
 * - Intent: the theme's name and blurb (else the mode's), the mode → effort (`effortOfMode`), the theme's emphasised
 *   regions → focus; the minutes and place → setting; the mode and theme reasons → notes.
 *
 * Nothing is kept beside the document: the build itself stays stored beside it (dual-write), and what the document
 * cannot say of it — slot keys, the new-move flag, a target's range and last-session summary, the swap pools past
 * three — the player derives or the build still holds.
 */
import type { WorkoutDoc, WorkoutDose, WorkoutItem, WorkoutPart } from "@rg/domain";
import { MODES, THEMES, type BlockId, type ExerciseRecord, type FormatId, type Mode } from "@rg/exercise-library";
import type { Step } from "@rg/session-engine";
import { effortOfMode } from "../derive.js";
import { bounded, loadOfWeight, openBlock, OPEN_BLOCK_NAME, type KeptEntry } from "./shared.js";

/** One slot of a stored build. */
export interface BuildItemSource {
  slotKey: string;
  block: BlockId;
  exerciseId: string;
  format: FormatId;
  sets: number;
  group: string | null;
  why: readonly string[];
}

/**
 * A build as the worker stores it (`session_builds.payload`): the fields the document reads. The worker's own
 * `BuildPayload` is one; so is the engine's plan with its items mapped the way `composeBuild` maps them.
 */
export interface BuildPayload {
  mode: Mode;
  /** Theme id. */
  theme: string | null;
  modeReasons?: readonly string[];
  themeReasons?: readonly string[];
  minutes: number;
  locationId?: string;
  /** The flat step list the player plays. */
  steps: readonly Step[];
  items: readonly BuildItemSource[];
  /** Every move in the plan: its laterality, roles and dose decide what the steps cannot show. */
  exercises: Readonly<Record<string, Pick<ExerciseRecord, "laterality" | "roles" | "dose">>>;
  /** Per slot key: the swaps the slot offers. */
  alternatives?: Readonly<Record<string, ReadonlyArray<{ id: string; reasons: readonly string[] }>>>;
}

const PURPOSE_OF_BLOCK: Record<BlockId, WorkoutPart["purpose"]> = {
  arrive: "arrive", prep: "warmup", core: "main", accessory: "accessory", care: "care", cooldown: "cooldown",
};

/** A reason list as one line, and back (`whyOf` in the player adapter splits on the same separator). */
export const WHY_SEPARATOR = "; ";

type Exercise = Extract<WorkoutItem, { kind: "exercise" }>;

interface Slot {
  item: BuildItemSource;
  /** Its work steps, in play order. */
  work: Step[];
  /** The rest steps that carry its slot key, in play order. */
  rests: Step[];
}

export function docFromBuild(build: BuildPayload): WorkoutDoc {
  // Nothing of a build is kept (see the header); the ledger is only for bounded texts, which the build still holds.
  const kept: KeptEntry[] = [];
  const slots = slotsOf(build);
  const parts: WorkoutPart[] = [];
  for (const group of groupsOf(build, slots)) parts.push(...partsOf(build, group, kept));

  const theme = build.theme ? THEMES.find((t) => t.id === build.theme) : undefined;
  const modeLabel = MODES[build.mode]?.label ?? build.mode;
  const regions = theme ? Object.entries(theme.emphasis.regions ?? {}).filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]).map(([r]) => r) : [];
  const notes = [...(build.modeReasons ?? []), ...(build.themeReasons ?? [])].join(" ").trim();
  return {
    version: 1,
    title: bounded(theme?.name ?? `${modeLabel} session`, 80, kept, "build", "title"),
    intent: {
      summary: bounded(theme?.blurb ?? `A ${build.minutes}-minute ${modeLabel.toLowerCase()} session.`, 200, kept, "build", "summary"),
      goals: [],
      focus: regions.slice(0, 12),
      effort: effortOfMode(build.mode),
    },
    setting: { ...(build.locationId ? { placeId: build.locationId } : {}), targetMinutes: Math.min(600, Math.max(1, build.minutes)) },
    parts: parts.length > 0 ? parts : [{ purpose: "main", format: "straight", items: [openBlock(OPEN_BLOCK_NAME, build.minutes * 60)] }],
    source: { kind: "engine" },
    ...(notes ? { notes: bounded(notes, 500, kept, "build", "notes") } : {}),
  };
}

function slotsOf(build: BuildPayload): Slot[] {
  const byKey = new Map<string, Slot>(build.items.map((item) => [item.slotKey, { item, work: [], rests: [] }]));
  for (const s of build.steps) {
    const slot = byKey.get(s.slotKey);
    if (!slot) continue;
    (s.kind === "rest" ? slot.rests : slot.work).push(s);
  }
  return [...byKey.values()];
}

/** The plan's groups, from its items in order and the rests between them. */
function groupsOf(build: BuildPayload, slots: Slot[]): Slot[][] {
  const restBefore = (slot: Slot): boolean => {
    const first = slot.work[0];
    const at = first ? build.steps.indexOf(first) : -1;
    return at > 0 && build.steps[at - 1]!.kind === "rest";
  };
  const groups: Slot[][] = [];
  for (const slot of slots) {
    const group = groups.at(-1);
    const last = group?.at(-1);
    const same = last && last.item.block === slot.item.block && last.item.format === slot.item.format;
    const joins =
      same &&
      (slot.item.format === "straight" ? restBefore(slot) : slot.item.format === "superset" ? group!.length < 2 : true);
    if (joins) group!.push(slot);
    else groups.push([slot]);
  }
  return groups;
}

/** A prep move that is there to switch muscles on rather than to warm up. */
function isActivation(build: BuildPayload, id: string): boolean {
  const roles = build.exercises[id]?.roles ?? [];
  return roles.includes("activation") && !roles.includes("warmup");
}

function partsOf(build: BuildPayload, group: Slot[], kept: KeptEntry[]): WorkoutPart[] {
  const first = group[0]!.item;
  const format = first.format;
  const purpose = PURPOSE_OF_BLOCK[first.block];
  const item = (slot: Slot, dose: WorkoutDose): Exercise => exerciseItem(build, slot, dose, kept);

  if (format === "holds" || format === "flow") {
    const items = group.map((slot) => ({ slot, it: item(slot, windowDose(slot)) }));
    if (first.block !== "prep") return [{ purpose, format, items: items.map((x) => x.it) }];
    // Prep: runs of activation moves are their own parts, in play order.
    const parts: WorkoutPart[] = [];
    for (const { slot, it } of items) {
      const p: WorkoutPart["purpose"] = isActivation(build, slot.item.exerciseId) ? "activation" : "warmup";
      const at = parts.at(-1);
      if (at && at.purpose === p) at.items.push(it);
      else parts.push({ purpose: p, format, items: [it] });
    }
    return parts;
  }

  if (format === "straight") {
    return [{ purpose, format, items: group.map((slot) => item(slot, { ...setDose(build, slot), ...restOf(slot) })) }];
  }

  if (format === "superset") {
    const sets = group.map((s) => s.item.sets);
    const rest = group[0]!.rests[0]?.seconds;
    const equal = sets.every((n) => n === sets[0]);
    return [{
      purpose, format,
      ...(equal ? { rounds: sets[0]! } : {}),
      ...(rest !== undefined ? { restBetweenRoundsSec: rest } : {}),
      items: group.map((slot) => item(slot, { ...setDose(build, slot), sets: equal ? 1 : slot.item.sets })),
    }];
  }

  if (format === "circuit") {
    const rounds = group[0]!.work[0]?.setCount ?? 1;
    const last = group.at(-1)!;
    const roundRest = last.rests[0]?.seconds;
    const items: WorkoutItem[] = [];
    group.forEach((slot, i) => {
      items.push(item(slot, { ...windowDose(slot), sets: 1 }));
      const between = slot.rests[0]?.seconds;
      if (i < group.length - 1 && between !== undefined && between >= 1) items.push({ kind: "rest", seconds: between });
    });
    return [{ purpose, format, rounds, ...(rounds > 1 && roundRest !== undefined ? { restBetweenRoundsSec: roundRest } : {}), items }];
  }

  // Ladder: the rungs are the rounds.
  const rungs = group[0]!.work.map((s) => s.target?.reps ?? 0).filter((r) => r > 0);
  const rest = group[0]!.rests[0]?.seconds;
  return [{
    purpose, format, rounds: rungs.length,
    ...(rest !== undefined ? { restBetweenRoundsSec: rest } : {}),
    items: group.map((slot) => {
      const dose = setDose(build, slot);
      const lo = Math.min(...rungs), hi = Math.max(...rungs);
      return item(slot, { ...dose, sets: 1, reps: lo === hi ? lo : { min: lo, max: hi } });
    }),
  }];
}

/** A timed window's dose: its seconds, sides, and what its target says. */
function windowDose(slot: Slot): WorkoutDose {
  const first = slot.work[0];
  const target = first?.target ?? null;
  return {
    sets: slot.item.sets,
    ...(first && first.seconds >= 1 ? { holdSec: first.seconds } : {}),
    ...(typeof target?.reps === "number" && target.reps >= 1 ? { reps: target.reps } : {}),
    ...(slot.work.some((s) => s.side !== null) ? { perSide: true } : {}),
    ...loadOf(target),
  };
}

/** A straight, superset or ladder slot's dose: windows for timed moves, reps for self-paced sets. */
function setDose(build: BuildPayload, slot: Slot): WorkoutDose {
  const first = slot.work[0];
  if (!first || first.kind === "timed") return windowDose(slot);
  const target = first.target;
  const record = build.exercises[slot.item.exerciseId];
  const range = record?.dose.range;
  const reps: WorkoutDose["reps"] =
    typeof target?.reps === "number" && target.reps >= 1 ? target.reps : range ? (range[0] === range[1] ? range[0] : { min: range[0], max: range[1] }) : undefined;
  return {
    sets: slot.item.sets,
    ...(reps !== undefined ? { reps } : {}),
    ...(record && record.laterality !== "bilateral" ? { perSide: true } : {}),
    ...loadOf(target),
  };
}

function loadOf(target: Step["target"]): Pick<WorkoutDose, "load"> {
  if (!target) return {};
  return { load: target.w ? loadOfWeight(target.w) : "bodyweight" };
}

/** The rest that follows the slot's sets, when one does. */
function restOf(slot: Slot): Pick<WorkoutDose, "restSec"> {
  const rest = slot.rests[0]?.seconds;
  return rest !== undefined ? { restSec: rest } : {};
}

function exerciseItem(build: BuildPayload, slot: Slot, dose: WorkoutDose, kept: KeptEntry[]): Exercise {
  const at = `slot ${slot.item.slotKey}`;
  const first = slot.work[0];
  const reasons = first?.why ?? slot.item.why;
  const note = first?.target?.note;
  const alternates = (build.alternatives?.[slot.item.slotKey] ?? []).slice(0, 3).map((a) => {
    const why = a.reasons.join(WHY_SEPARATOR);
    return { libraryId: a.id, ...(why ? { why: bounded(why, 120, kept, at, "alternative reasons") } : {}) };
  });
  return {
    kind: "exercise",
    libraryId: slot.item.exerciseId,
    dose,
    ...(reasons.length ? { why: bounded(reasons.join(WHY_SEPARATOR), 160, kept, at, "why") } : {}),
    ...(note ? { progression: bounded(note, 120, kept, at, "progression") } : {}),
    ...(alternates.length ? { alternates } : {}),
  };
}
