/**
 * A move's correction in one line, as the Studio's move shows its history (audit 2026-11-06, I10): "Dose of Zorbex hip
 * lift: 30 s, 2 sets (was 8–12 reps)". The words match import-corrections.ts `correctionLine` for a move; kept apart so
 * the library's read (library-view.ts) doesn't import the corrections' module, whose imports lead back to it (a cycle
 * that changes type inference elsewhere).
 */
import { valueWords } from "./saves-evidence.js";

const MOVE_FIELD_WORDS: Readonly<Record<string, string>> = {
  name: "Name",
  summary: "Summary",
  purpose: "Purpose",
  dose: "Dose",
  laterality: "Sides",
  load: "Load",
  equipment: "Equipment",
  steps: "Steps",
  cues: "Cues",
};

export function moveCorrectionLine(field: string, before: unknown, after: unknown, name: string): string {
  return `${MOVE_FIELD_WORDS[field] ?? field} of ${name}: ${valueWords(after)} (was ${valueWords(before)})`;
}
