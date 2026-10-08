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

const TOKEN = /\d+(?:\.\d+)?\s*[a-z#]*/g;

/**
 * "8, 12, 20 lb" → every bare number takes the unit written after it — "10, 15, 20 lb, 12kg" is three weights in
 * pounds and one in kilos (Phase 2c Review Focus 3) — and a number with no unit after it takes the default unit.
 * Mixed units are fine. Sorted, no duplicates; junk is dropped (`weightListProblem` says what it was).
 */
export function parseWeightList(text: unknown, defaultUnit: WeightUnit): Weight[] {
  const tokens = String(text ?? "").toLowerCase().match(TOKEN) || [];
  // Right to left: the unit of the nearest token after a bare number that names one.
  const units: WeightUnit[] = new Array<WeightUnit>(tokens.length);
  let after = defaultUnit;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const own = /[a-z#]/.test(tokens[i]!) ? parseWeight(tokens[i], defaultUnit) : null;
    if (own) after = own.u;
    units[i] = after;
  }
  const out: Weight[] = [];
  tokens.forEach((token, i) => {
    const w = parseWeight(token, units[i]!);
    if (w && !out.some(o => sameWeight(o, w))) out.push(w);
  });
  return out.sort((a, b) => toKg(a) - toKg(b));
}

/**
 * A typed list as it is kept (Audit 2c-A MINOR-4): one that names a unit anywhere stays exactly as typed; one with
 * none ("10, 15, 20") gets the unit in force when it was typed appended ("10, 15, 20 kg"), so switching Weights later
 * never changes what it means. For text `weightListProblem` accepts (numbers and unit words only).
 */
export function withWeightUnit(text: string, unit: WeightUnit): string {
  const typed = text.trim();
  return /[a-z#]/i.test(typed) ? typed : `${typed} ${unit}`;
}

/**
 * Why a typed list is not a list of weights — the first part that is not one ("12 stone", "x", "0"), or "empty" when
 * it holds none — or null when every part is a weight. Separators are commas, semicolons, slashes and spaces.
 */
export function weightListProblem(text: unknown): string | null {
  const raw = String(text ?? "");
  const parts = raw.split(/[,;/]+|\s{2,}/).map(p => p.trim()).filter(Boolean);
  for (const part of parts) {
    const tokens = part.toLowerCase().match(TOKEN) || [];
    const rest = part.toLowerCase().replace(TOKEN, "").trim();
    if (tokens.length === 0 || rest !== "") return part;
    for (const token of tokens) if (!parseWeight(token, "kg")) return token.trim();
  }
  return parseWeightList(raw, "kg").length === 0 ? "empty" : null;
}
