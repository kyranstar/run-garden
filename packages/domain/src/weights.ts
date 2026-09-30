// Weights are { v: number, u: "lb" | "kg" }: kept in the unit they were typed or suggested in, and
// compared in kg. Pounds use the exact definition (1 lb = 0.45359237 kg).

export type WeightUnit = "lb" | "kg";

export interface Weight {
  v: number;
  u: WeightUnit;
}

export const LB_TO_KG = 0.45359237;
export const KG_TO_LB = 1 / LB_TO_KG;
/** Two weights within this many kg are the same weight. */
export const SAME_WEIGHT_KG = 0.05;

const UNIT_WORDS: Readonly<Record<string, WeightUnit>> = {
  kg: "kg", kgs: "kg", kilo: "kg", kilos: "kg", kilogram: "kg", kilograms: "kg",
  lb: "lb", lbs: "lb", pound: "lb", pounds: "lb", "#": "lb",
};

const roundTo = (n: number, step: number): number => Math.round(n / step) * step;
const trim = (n: number): string => String(Number(n.toFixed(2)));

/** "25", "25 lb", "12kg", "20 kilos" → a weight; junk, zero and negatives → null. */
export function parseWeight(text: unknown, defaultUnit: WeightUnit): Weight | null {
  const m = String(text ?? "").trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([a-z#]+)?$/);
  if (!m || m[1] == null) return null;
  const v = parseFloat(m[1]);
  if (!(v > 0)) return null;
  const u = m[2] ? UNIT_WORDS[m[2]] : defaultUnit;
  if (!u) return null;
  return { v: Number(v.toFixed(2)), u };
}

export const toKg = (w: Weight): number => (w.u === "kg" ? w.v : w.v * LB_TO_KG);

/** The number in another unit, rounded to the nearest 0.5 when converted. */
export function weightInUnit(w: Weight, unit: WeightUnit): number {
  if (w.u === unit) return w.v;
  const n = unit === "kg" ? toKg(w) : w.v * KG_TO_LB;
  return roundTo(n, 0.5);
}

export const formatWeight = (w: Weight): string => `${trim(w.v)} ${w.u}`;
export const formatWeightIn = (w: Weight, unit: WeightUnit): string => `${trim(weightInUnit(w, unit))} ${unit}`;

export const sameWeight = (a: Weight, b: Weight): boolean => Math.abs(toKg(a) - toKg(b)) < SAME_WEIGHT_KG;

/** "8, 12, 20 lb" → every bare number takes the trailing unit; mixed units are fine. Sorted, no duplicates. */
export function parseWeightList(text: unknown, defaultUnit: WeightUnit): Weight[] {
  const tokens = String(text ?? "").toLowerCase().match(/\d+(?:\.\d+)?\s*[a-z#]*/g) || [];
  const lastToken = tokens[tokens.length - 1];
  const trailing = lastToken != null ? parseWeight(lastToken, defaultUnit) : null;
  const listUnit = trailing ? trailing.u : defaultUnit;
  const out: Weight[] = [];
  for (const token of tokens) {
    const w = parseWeight(token, listUnit);
    if (w && !out.some(o => sameWeight(o, w))) out.push(w);
  }
  return out.sort((a, b) => toKg(a) - toKg(b));
}
