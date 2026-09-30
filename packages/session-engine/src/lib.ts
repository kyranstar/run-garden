import { sameWeight, toKg, type Weight } from "@rg/domain";
import {
  LOAD_IMPLEMENTS, coreFamilyOf, eligible, fitsMode, flareSafe, hasEquipment, type EngineData, type ExerciseRecord,
} from "@rg/exercise-library";
import type { EngineLocation } from "./types.js";

// The exercise library: lookup (including renamed ids), equipment and mode eligibility, core families.
// Every function that reads library data takes the EngineData first; lookups are indexed per exercise list,
// so different data never shares a stale index.

interface Index {
  n: number;
  map: Map<string, ExerciseRecord>;
}
const indexes = new WeakMap<readonly ExerciseRecord[], Index>();

function index(data: EngineData): Map<string, ExerciseRecord> {
  const list = data.exercises;
  let idx = indexes.get(list);
  if (!idx || idx.n !== list.length) {
    const map = new Map<string, ExerciseRecord>();
    for (const ex of list) {
      map.set(ex.id, ex);
      for (const old of ex.legacyIds || []) if (!map.has(old)) map.set(old, ex);
    }
    idx = { n: list.length, map };
    indexes.set(list, idx);
  }
  return idx.map;
}

const get = (data: EngineData, id: string | null | undefined): ExerciseRecord | null => (id == null ? null : index(data).get(id) ?? null);
const all = (data: EngineData): readonly ExerciseRecord[] => data.exercises;

/** The implement whose weight gets logged: the first loadable one this place has, in the exercise's order. */
function implementFor(ex: ExerciseRecord, equipment: readonly string[] | null | undefined): string | null {
  if (ex.load !== "external") return null;
  const have = new Set(equipment ?? []);
  const loadable: readonly string[] = LOAD_IMPLEMENTS;
  const candidates = [...ex.equipment.oneOf, ...ex.equipment.all].filter(i => loadable.includes(i));
  return candidates.find(i => have.has(i)) ?? null;
}

/** The kettlebells at a place, light to heavy, without duplicates. */
function kettlebellsAt(location: EngineLocation): Weight[] {
  const out: Weight[] = [];
  for (const w of [...(location.implements?.kettlebell ?? [])].sort((a, b) => toKg(a) - toKg(b))) {
    if (w && w.v > 0 && !out.some(o => sameWeight(o, w))) out.push(w);
  }
  return out;
}

export const Lib = { get, all, flareSafe, hasEquipment, implementFor, fitsMode, eligible, coreFamilyOf, kettlebellsAt };
