/**
 * The document → planned stages (the calendar's stage summary and the stage rows), the reverse of `docFromStages`:
 * `stagesFromDoc(docFromStages(s))` is `s` on every field the document carries (the round-trip test holds it; what it
 * does not carry is in the converter's `kept`).
 *
 * RULES
 * - A part with `rounds` is a repeat stage (repeatCount = rounds) holding its items' stages; any other part's items
 *   are top-level stages, in order.
 * - A run segment: in a warm-up part a warm-up, in a cool-down part a cool-down, with a recovery effort a recovery,
 *   else work. Its duration (time), else its distance, else open; a pace band → pace (low = the fast bound), else a
 *   heart-rate band → heart rate, else none; its zone → paceZone or hrZone; its cue → the note.
 * - A rest item is a timed recovery stage.
 * - A move: in a warm-up or cool-down part that kind, else work, named by the library (a legacy id by its current
 *   record; an id the library lacks by itself) or by its free text. Its hold → time; a carry → distance; reps →
 *   "none" with the reps (a range's low); nothing → open. Its load → loadKg, bodyweight → loadBodyweight; its rest
 *   → restSeconds; its cue → the note, with "<n>s down" and "each side" ahead of it when the cue does not already
 *   say so (the push path's own words). Its sets: outside a part with rounds, sets wrap it in a repeat of that many;
 *   inside one, only more than one set does.
 * - Ids are the stage's position ("0", "1", …); order is the same position.
 */
import type { PlannedStage, WorkoutDoc, WorkoutItem, WorkoutPart } from "@rg/domain";
import type { ExerciseRecord } from "@rg/exercise-library";
import { makeLibraryIndex } from "../derive.js";
import { ECCENTRIC_WORDS, PER_SIDE_WORDS } from "../convert/shared.js";

type Move = Extract<WorkoutItem, { kind: "exercise" | "free_exercise" }>;

export function stagesFromDoc(doc: WorkoutDoc, library: readonly ExerciseRecord[]): PlannedStage[] {
  const find = makeLibraryIndex(library);
  const out: PlannedStage[] = [];
  const add = (stage: Omit<PlannedStage, "id" | "order">): string => {
    const id = String(out.length);
    out.push({ id, order: out.length, ...stage });
    return id;
  };
  const repeat = (count: number, parent: string | null): string =>
    add({ parentStageId: parent, kind: "repeat", repeatCount: count, durationType: "none" });

  for (const part of doc.parts) {
    const inRounds = part.rounds !== undefined;
    const parent = inRounds ? repeat(part.rounds!, null) : null;
    for (const item of part.items) {
      if (item.kind === "rest") {
        add({ parentStageId: parent, kind: "recovery", durationType: "time", durationSeconds: item.seconds, targetType: "none" });
      } else if (item.kind === "run") {
        add({ parentStageId: parent, ...runStage(item, part) });
      } else {
        const sets = item.dose.sets;
        const wrap = sets !== undefined && (inRounds ? sets > 1 : true);
        const into = wrap ? repeat(sets!, parent) : parent;
        add({ parentStageId: into, ...moveStage(item, part, find) });
      }
    }
  }
  return out;
}

function runStage(item: Extract<WorkoutItem, { kind: "run" }>, part: WorkoutPart): Omit<PlannedStage, "id" | "order" | "parentStageId"> {
  const t = item.target;
  const kind: PlannedStage["kind"] =
    part.purpose === "warmup" ? "warmup" : part.purpose === "cooldown" ? "cooldown" : item.effort === "recovery" ? "recovery" : "work";
  return {
    kind,
    ...(t.durationSec !== undefined
      ? { durationType: "time" as const, durationSeconds: t.durationSec, ...(t.distanceM !== undefined ? { distanceMeters: t.distanceM } : {}) }
      : t.distanceM !== undefined
        ? { durationType: "distance" as const, distanceMeters: t.distanceM }
        : { durationType: "open" as const }),
    ...(t.pace
      ? { targetType: "pace" as const, targetLow: t.pace.fastSecPerKm, targetHigh: t.pace.slowSecPerKm }
      : t.hr
        ? { targetType: "heart_rate" as const, targetLow: t.hr.low, targetHigh: t.hr.high }
        : { targetType: "none" as const }),
    ...(t.zone ? (t.zone.kind === "pace" ? { paceZone: t.zone.index } : { hrZone: t.zone.index }) : {}),
    ...(item.cue ? { note: item.cue } : {}),
  };
}

function moveStage(item: Move, part: WorkoutPart, find: (id: string) => ExerciseRecord | undefined): Omit<PlannedStage, "id" | "order" | "parentStageId"> {
  const d = item.dose;
  const label = item.kind === "exercise" ? (find(item.libraryId)?.name ?? item.libraryId) : item.name;
  const reps = typeof d.reps === "number" ? d.reps : d.reps?.min;
  const note = [
    d.tempo?.eccentricSec !== undefined && !ECCENTRIC_WORDS.test(item.cue ?? "") ? `${d.tempo.eccentricSec}s down` : null,
    d.perSide && !PER_SIDE_WORDS.test(item.cue ?? "") ? "each side" : null,
    item.cue ?? null,
  ].filter((x): x is string => Boolean(x)).join(" · ");
  return {
    kind: part.purpose === "warmup" ? "warmup" : part.purpose === "cooldown" ? "cooldown" : "work",
    label,
    ...(d.holdSec !== undefined
      ? { durationType: "time" as const, durationSeconds: d.holdSec }
      : d.carryM !== undefined
        ? { durationType: "distance" as const, distanceMeters: d.carryM }
        : reps !== undefined
          ? { durationType: "none" as const }
          : { durationType: "open" as const }),
    ...(reps !== undefined ? { reps } : {}),
    targetType: "none",
    ...(d.load === "bodyweight" ? { loadBodyweight: true } : d.load ? { loadKg: d.load.kg } : {}),
    ...(d.restSec !== undefined ? { restSeconds: d.restSec } : {}),
    ...(note ? { note } : {}),
  };
}
