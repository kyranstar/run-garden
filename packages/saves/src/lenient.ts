import { CONTRACTIONS, EQUIPMENT_IDS, PATTERNS, REGIONS } from "@rg/exercise-library";

// A reading's list fields are the library's vocabularies. One word the library doesn't have (a region, a pattern)
// threw a whole paid reply away (live finding, 2026-11-05): the word goes instead, and the move says so. Single-valued
// fields (position, laterality, load) are not touched: a reply whose required word is unusable is still refused.

export const LIST_FIELDS = ["regions", "patterns", "equipment", "equipmentOneOf", "contraction"] as const;
export type ListField = (typeof LIST_FIELDS)[number];
export interface DroppedValues {
  move: number;
  field: ListField;
  values: string[];
}

const VOCAB: Readonly<Record<ListField, ReadonlySet<string>>> = {
  regions: new Set(REGIONS),
  patterns: new Set(PATTERNS),
  equipment: new Set(EQUIPMENT_IDS),
  equipmentOneOf: new Set(EQUIPMENT_IDS),
  contraction: new Set(CONTRACTIONS),
};
/** How much of a dropped word the note keeps: it is the model's, shown as text. */
const NOTE_CHARS = 40;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The reply with each move's unknown list values left out, and what went. A list every value of which is unknown is
 * left as it is: the schema refuses it, and its retry names the options (an empty list would say nothing).
 */
export function dropUnknownEnums(raw: unknown): { value: unknown; dropped: DroppedValues[] } {
  if (!isObj(raw) || !Array.isArray(raw.moves)) return { value: raw, dropped: [] };
  const dropped: DroppedValues[] = [];
  const moves = raw.moves.map((m, move) => {
    if (!isObj(m)) return m;
    let out = m;
    for (const field of LIST_FIELDS) {
      const list = m[field];
      if (!Array.isArray(list)) continue;
      const known = list.filter((v): v is string => typeof v === "string" && VOCAB[field].has(v));
      if (known.length === list.length || known.length === 0) continue;
      dropped.push({ move, field, values: list.filter((v) => !known.includes(v as string)).map((v) => String(v).slice(0, NOTE_CHARS)) });
      out = { ...out, [field]: known };
    }
    return out;
  });
  return { value: dropped.length ? { ...raw, moves } : raw, dropped };
}
