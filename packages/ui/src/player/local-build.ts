/**
 * A BUILD MADE ON THE DEVICE (R11): a quick start, or a template whose document is here, started with no network. The
 * player plays it exactly as it plays the server's build of a document (`materializeDocBuild`): the steps are the
 * document's own (`playerStepsFromDoc`), the moves the bundle's library, each slot's cue and "to max" what its item
 * says, each move's target its item's dose, and the parts and doses in the builder's words. What only the server can
 * work out is left out: no ⇄ offers (the library's usual moves are judged against the athlete's history), no history
 * on a target. Its day is the day it is played: what the save carries as its date, whenever it is sent.
 */
import type { DocSlotDto, SessionBuildDto, SessionExerciseDto, SessionItemDto, SessionViewDto } from "@rg/api-client";
import { doseSummary, type WorkoutDoc } from "@rg/domain";
import { EXERCISES, type ExerciseRecord } from "@rg/exercise-library";
import { Swapping, type Step, type Target } from "@rg/session-engine";
import { deriveDoc, docSlotKeys, makeLibraryIndex, modeOfEffort, playerStepsFromDoc } from "@rg/workout";

export interface LocalBuildInput {
  /** The provisional id it is played under (`local:<clientId>`): the build's id too. */
  localId: string;
  /** The day it is played. */
  date: string;
  /** The day's readings known on the device, answered before Start: the session's own `pre` checks. */
  checks: Readonly<Record<string, { pre: number | null; feelingOff: boolean }>>;
  /** Where it is done: the builder's place (its gear). */
  location: { id: string; name: string; equipment: readonly string[] };
  library?: readonly ExerciseRecord[];
  now?: number;
}

const sliceOf = (rec: ExerciseRecord): SessionExerciseDto => {
  const { providers: _providers, ...rest } = rec;
  return rest as SessionExerciseDto;
};

/** The build and view the player plays a document by, made on the device. */
export function localBuild(doc: WorkoutDoc, input: LocalBuildInput): { build: SessionBuildDto; view: SessionViewDto } {
  const library = input.library ?? EXERCISES;
  const find = makeLibraryIndex(library);
  const steps: Step[] = playerStepsFromDoc(doc, library);
  const keys = docSlotKeys(doc);

  const exercises: Record<string, SessionExerciseDto> = {};
  const items: SessionItemDto[] = [];
  const seen = new Set<string>();
  for (const s of steps) {
    if (s.kind === "rest" || !s.exerciseId) continue;
    const rec = find(s.exerciseId);
    if (rec && !exercises[rec.id]) exercises[rec.id] = sliceOf(rec);
    if (seen.has(s.slotKey)) continue;
    seen.add(s.slotKey);
    items.push({ slotKey: s.slotKey, block: s.block, exerciseId: s.exerciseId, format: s.format.id, sets: s.setCount ?? 1, group: s.format.group, coreFamily: null, isNew: false, why: [...s.why] });
  }

  // What each slot's item says beside its steps (its cue, a hold to max): as the server's `docSlots`, without ⇄'s lists.
  const slots: Record<string, DocSlotDto> = {};
  // Each item's dose in the builder's words: as the server's `docFacts`.
  const doses: Record<string, string> = {};
  // Each move's target from its item's dose, by move id (the first item that plays it): as the server's `docTargets`.
  const targets: Record<string, Target> = {};
  for (const at of keys) {
    const item = doc.parts[at.part]!.items[at.item]!;
    if (item.kind === "rest") continue;
    const max = item.kind !== "run" && item.dose.max === true;
    if (item.cue || max) slots[at.key] = { ...(item.cue ? { cue: item.cue } : {}), ...(max ? { max: true as const } : {}) };
    if (item.kind === "exercise" || item.kind === "free_exercise") {
      const words = doseSummary(item.dose);
      if (words) doses[at.key] = words;
    }
    if (item.kind !== "exercise") continue;
    const rec = find(item.libraryId);
    if (!rec || targets[rec.id]) continue;
    const said: Partial<Target> | null = steps.find((s) => s.slotKey === at.key && s.kind !== "rest" && s.target)?.target ?? null;
    const timed = rec.dose.type === "time" || rec.dose.type === "carry";
    targets[rec.id] = {
      lo: said?.lo ?? rec.dose.range[0],
      hi: said?.hi ?? rec.dose.range[1],
      type: said?.type ?? rec.dose.type,
      w: said?.w ?? null,
      reps: said?.reps ?? null,
      secs: said?.secs ?? (timed ? (item.dose.holdSec ?? null) : null),
      graduate: null,
      last: null,
      lastDate: null,
      action: "hold",
      note: said?.note ?? "",
    };
  }
  const parts = doc.parts
    .map((p, i) => ({ purpose: p.purpose, keys: keys.filter((k) => k.part === i).map((k) => k.key) }))
    .filter((p) => p.keys.length > 0);

  const mode = modeOfEffort(doc.intent.effort);
  const minutes = deriveDoc(doc, library).estimatedMinutes;
  const now = input.now ?? Date.now();
  const build: SessionBuildDto = {
    buildId: input.localId,
    version: 1,
    engineVersion: "local-doc-build",
    inputsHash: "",
    builtAt: new Date(now).toISOString(),
    date: input.date,
    mode,
    modeReasons: [],
    theme: null,
    themeReasons: [],
    minutes,
    locationId: input.location.id,
    blockRef: null,
    weekOfBlock: null,
    plannedSeconds: Swapping.costOf(steps),
    steps,
    items,
    exercises,
    alternatives: {},
    targets,
    newMove: null,
    params: { checks: { ...input.checks }, overrides: {}, swaps: {} },
    fromDoc: { rev: null, swaps: [], blocked: [], slots, effort: doc.intent.effort, parts, doses },
  };
  const view: SessionViewDto = {
    mode,
    proposedMode: mode,
    modeReasons: [],
    theme: null,
    proposedTheme: null,
    themeReasons: [],
    minutes,
    location: { id: input.location.id, name: input.location.name, equipment: [...input.location.equipment], implements: {} },
    block: null,
    newMove: null,
  };
  return { build, view };
}
