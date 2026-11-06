/**
 * A move's correction in one line, as the Studio's move shows its history (audit 2026-11-06, I10): "Dose of Zorbex hip
 * lift: 30 s, 2 sets (was 8–12 reps)". The words match import-corrections.ts `correctionLine` for a move; kept apart so
 * the library's read (library-view.ts) doesn't import the corrections' module, whose imports lead back to it (a cycle
 * that changes type inference elsewhere).
 */
import { label, PROFILES } from "@rg/exercise-library";
import { valueWords } from "./saves-evidence.js";

/** A move's field in words: the card's, the trail's and the Studio's one source (import-corrections.ts reads it too). */
export const MOVE_FIELD_WORDS: Readonly<Record<string, string>> = {
  name: "Name",
  summary: "Summary",
  purpose: "Purpose",
  dose: "Dose",
  laterality: "Sides",
  load: "Load",
  equipment: "Equipment",
  steps: "Steps",
  cues: "Cues",
  contraction: "Contraction",
  conditions: "Condition ratings",
  regions: "Areas",
  patterns: "Patterns",
};

const attrWords = (key: string): string => key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();

/** A move's condition ratings in words: "TMJ clench 2, neck load 0, face down no". */
function ratingsWords(v: unknown): string {
  if (!v || typeof v !== "object") return valueWords(v);
  return Object.entries(v as Record<string, unknown>)
    .map(([p, attrs]) => {
      const name = (PROFILES as Record<string, { label: string } | undefined>)[p]?.label ?? p;
      const parts = attrs && typeof attrs === "object" ? Object.entries(attrs as Record<string, unknown>).map(([k, x]) => `${attrWords(k)} ${typeof x === "boolean" ? (x ? "yes" : "no") : String(x)}`) : [];
      return `${name} ${parts.join(", ")}`.trim();
    })
    .join("; ");
}

/** A list of the library's own words (contraction types, regions, patterns), as the athlete reads them. */
const vocabWords = (v: unknown): string => (Array.isArray(v) ? (v.length ? v.map((x) => label(String(x)).toLowerCase()).join(", ") : "nothing") : valueWords(v));

/** How a move field's value reads on the card. */
export function moveValueWords(field: string, v: unknown): string {
  if (field === "conditions") return ratingsWords(v);
  if (field === "contraction" || field === "regions" || field === "patterns") return vocabWords(v);
  return valueWords(v);
}

/** A move's correction in one line; a retire is the move's status, said as such (the safety audit, S2). */
export function moveCorrectionLine(field: string, before: unknown, after: unknown, name: string): string {
  if (field === "retire") return `Retire ${name} from your moves`;
  return `${MOVE_FIELD_WORDS[field] ?? field} of ${name}: ${moveValueWords(field, after)} (was ${moveValueWords(field, before)})`;
}
