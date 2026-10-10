/**
 * An engine build → the workout document (programme spec §3.3).
 *
 * The build read is the one the worker stores: `session_builds.payload.build` (the stored payload is `{ build, view }`;
 * `build` is made by `composeBuild` from the engine's plan). Its steps are what the player plays, its items say which
 * slots there are and how each is run. The document is read back to exactly those steps by `playerStepsFromDoc` (the
 * round-trip test holds it for 50 seeded builds).
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
 * - Reasons: a slot's reasons → `why` (joined with "; "; cut to the document's 160 characters, the whole list kept),
 *   its progression note → `progression`, its offered swaps → `alternates` (the first 3 distinct moves, each with its
 *   reasons).
 * - Given the library (`meta.library`): a legacy id — the slot's move or an alternate — is the move's id now; a slot
 *   whose move the library no longer has is a free-text item by the move's name, its id, progression note and
 *   alternates kept; an alternate the library no longer has is left out and kept; one that is now the slot's own
 *   move, or a move already offered (two legacy ids of one move), is left out (the record's legacy ids keep it).
 * - Intent: the theme's name and blurb (else the mode's), the mode → effort (`effortOfMode`), the theme's emphasised
 *   regions → focus; the place → setting, and the build's stated length → `setting.targetMinutes`: its planned time
 *   (`plannedSeconds`, what its steps add up to, rounded), else the minutes it was asked for; the mode and theme
 *   reasons → notes.
 *
 * KNOWN GAPS: what the document cannot say of a build, and the build itself (stored beside it, dual-write) still
 * holds — slot keys, the new-move flag, a target's history (the last session's summary and date, the progression
 * action, and `graduate`, the move a topped-out target graduates to), the swap pools past three, and the hold a time
 * move's progression suggests when it stands in a circuit (the circuit plays its own work window, which is the
 * station's `holdSec`; a part has no work window of its own to hold it apart). A target's range and dose type are not
 * gaps: the player reads them from the move's record. `kept` holds only what the build's own text or ids lose in the
 * document (cut texts, gone moves); `docFromBuild` is the document alone.
 */
import type { WorkoutDoc, WorkoutDose, WorkoutItem, WorkoutPart } from "@rg/domain";
import { MODES, THEMES, type BlockId, type ExerciseRecord, type FormatId, type Mode } from "@rg/exercise-library";
import type { Step } from "@rg/session-engine";
import { effortOfMode } from "../derive.js";
import { bounded, currentId, loadOfWeight, openBlock, OPEN_BLOCK_NAME, type Converted, type KeptEntry, type LibraryIndex } from "./shared.js";

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
  /** What the build's steps add up to (the worker's stored build has it): the document's stated length. */
  plannedSeconds?: number;
  locationId?: string;
  /** The flat step list the player plays. */
  steps: readonly Step[];
  items: readonly BuildItemSource[];
  /** Every move in the plan: its laterality, roles and dose decide what the steps cannot show; its name names it. */
  exercises: Readonly<Record<string, Pick<ExerciseRecord, "name" | "laterality" | "roles" | "dose">>>;
  /** Per slot key: the swaps the slot offers. */
  alternatives?: Readonly<Record<string, ReadonlyArray<{ id: string; reasons: readonly string[] }>>>;
}

const PURPOSE_OF_BLOCK: Record<BlockId, WorkoutPart["purpose"]> = {
  arrive: "arrive", prep: "warmup", core: "main", accessory: "accessory", care: "care", cooldown: "cooldown",
};

/** A reason list as one line, and back (`whyOf` in the player adapter splits on the same separator). */
export const WHY_SEPARATOR = "; ";

type Move = Extract<WorkoutItem, { kind: "exercise" | "free_exercise" }>;

export interface BuildMeta {
  /** `makeLibraryIndex(library)`: canonicalises legacy ids and names gone ones in free text. */
  library?: LibraryIndex;
}

interface Slot {
  item: BuildItemSource;
  /** Its work steps, in play order. */
  work: Step[];
  /** The rest steps that carry its slot key, in play order. */
  rests: Step[];
}

/** The build's document (what `docFromBuildWithKept` makes, without its ledger). */
export function docFromBuild(build: BuildPayload, meta: BuildMeta = {}): WorkoutDoc {
  return docFromBuildWithKept(build, meta).doc;
}

export function docFromBuildWithKept(build: BuildPayload, meta: BuildMeta = {}): Converted<WorkoutDoc> {
  const kept: KeptEntry[] = [];
  const slots = slotsOf(build);
  const parts: WorkoutPart[] = [];
  for (const group of groupsOf(build, slots)) parts.push(...partsOf(build, group, kept, meta.library));

  const theme = build.theme ? THEMES.find((t) => t.id === build.theme) : undefined;
  const modeLabel = MODES[build.mode]?.label ?? build.mode;
  const regions = theme ? Object.entries(theme.emphasis.regions ?? {}).filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]).map(([r]) => r) : [];
  const notes = [...(build.modeReasons ?? []), ...(build.themeReasons ?? [])].join(" ").trim();
  const doc: WorkoutDoc = {
    version: 1,
    title: bounded(theme?.name ?? `${modeLabel} session`, 80, kept, "build", "title"),
    intent: {
      summary: bounded(theme?.blurb ?? `A ${build.minutes}-minute ${modeLabel.toLowerCase()} session.`, 200, kept, "build", "summary"),
      goals: [],
      focus: regions.slice(0, 12),
      effort: effortOfMode(build.mode),
    },
    setting: {
      ...(build.locationId ? { placeId: build.locationId } : {}),
      targetMinutes: Math.min(600, Math.max(1, build.plannedSeconds ? Math.round(build.plannedSeconds / 60) : build.minutes)),
    },
    parts: parts.length > 0 ? parts : [{ purpose: "main", format: "straight", items: [openBlock(OPEN_BLOCK_NAME, build.minutes * 60)] }],
    source: { kind: "engine" },
    ...(notes ? { notes: bounded(notes, 500, kept, "build", "notes") } : {}),
  };
  return { doc, kept };
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

function partsOf(build: BuildPayload, group: Slot[], kept: KeptEntry[], library: LibraryIndex | undefined): WorkoutPart[] {
  const first = group[0]!.item;
  const format = first.format;
  const purpose = PURPOSE_OF_BLOCK[first.block];
  const item = (slot: Slot, dose: WorkoutDose): Move => moveItem(build, slot, dose, kept, library);

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

function moveItem(build: BuildPayload, slot: Slot, dose: WorkoutDose, kept: KeptEntry[], library: LibraryIndex | undefined): Move {
  const at = `slot ${slot.item.slotKey}`;
  const first = slot.work[0];
  const reasons = first?.why ?? slot.item.why;
  const note = first?.target?.note;
  const why = reasons.length ? joined(reasons, 160, kept, at, "why") : "";
  const id = currentId(slot.item.exerciseId, library, kept, at, "exerciseId");
  const offered = alternativesOf(build, slot, id, kept, at, library);
  if (id === null) {
    // The library no longer has the move: free text by its name, and what only a library move can hold is kept.
    if (note) kept.push({ at, field: "progression", value: note, why: "a free-text move holds no progression" });
    if (offered.length) kept.push({ at, field: "alternatives", value: offered, why: "a free-text move holds no alternates" });
    const name = build.exercises[slot.item.exerciseId]?.name ?? slot.item.exerciseId;
    return { kind: "free_exercise", name: bounded(name, 80, kept, at, "name"), dose, ...(why ? { why } : {}) };
  }
  const alternates = offered.map((a) => {
    const line = joined(a.reasons, 120, kept, at, "alternative reasons");
    return { libraryId: a.id, ...(line ? { why: line } : {}) };
  });
  return {
    kind: "exercise",
    libraryId: id,
    dose,
    ...(why ? { why } : {}),
    ...(note ? { progression: bounded(note, 120, kept, at, "progression") } : {}),
    ...(alternates.length ? { alternates } : {}),
  };
}

/**
 * The slot's offered swaps the document can name: the first three distinct moves the library still has; a gone one is
 * kept. Distinct after canonicalising: an alternate that is now the slot's own move (`own`, its current id) or a move
 * already taken (two legacy ids of one move) is left out — nothing is lost, the record's legacy ids keep the old id.
 */
function alternativesOf(
  build: BuildPayload,
  slot: Slot,
  own: string | null,
  kept: KeptEntry[],
  at: string,
  library: LibraryIndex | undefined,
): Array<{ id: string; reasons: readonly string[] }> {
  const out: Array<{ id: string; reasons: readonly string[] }> = [];
  const taken = new Set(own === null ? [] : [own]);
  for (const a of build.alternatives?.[slot.item.slotKey] ?? []) {
    if (out.length >= 3) break;
    const id = currentId(a.id, library, kept, at, "alternative");
    if (id === null || taken.has(id)) continue;
    taken.add(id);
    out.push({ id, reasons: a.reasons });
  }
  return out;
}

/** Reasons as one line within `max` characters; when cut, the whole list is kept. */
function joined(reasons: readonly string[], max: number, kept: KeptEntry[], at: string, field: string): string {
  const line = reasons.join(WHY_SEPARATOR).trim();
  if (line.length <= max) return line;
  kept.push({ at, field, value: [...reasons], why: `longer than the document's ${max} characters` });
  return `${line.slice(0, max - 1).trimEnd()}…`;
}
