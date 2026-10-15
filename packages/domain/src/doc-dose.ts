/**
 * A WORKOUT DOCUMENT'S DOSE IN WORDS — the one reading of it: the builder's rows and steppers, the session sheet's
 * moves for a document workout, and the build that carries them (`fromDoc.doses`) all say a dose this way.
 *
 *   "3 × 8 · 25 lb", "10 reps", "30 s each side", "6 breaths", "4 × 5–8", "3 × 45 s, to max".
 */
import { secondsText } from "./session-dose.js";
import type { WorkoutDose } from "./workout-doc.js";

export type AmountKind = "reps" | "hold" | "breaths" | "distance";

/** The dose's own amount; with none, the move's way of counting (its record's dose type). */
export function amountKind(dose: WorkoutDose, rec?: { dose: { type: string } }): AmountKind {
  if (dose.holdSec !== undefined) return "hold";
  if (dose.breaths !== undefined) return "breaths";
  if (dose.reps !== undefined) return "reps";
  if (dose.carryM !== undefined) return "distance";
  const t = rec?.dose.type;
  return t === "time" || t === "carry" ? "hold" : t === "breaths" ? "breaths" : "reps";
}

/** The amount as a stepper's field holds it: a bare number (a hold in seconds, a carry in metres), or a rep range. */
export function amountValue(dose: WorkoutDose, kind: AmountKind): string {
  switch (kind) {
    case "hold":
      return dose.holdSec !== undefined ? String(dose.holdSec) : "";
    case "breaths":
      return dose.breaths !== undefined ? String(dose.breaths) : "";
    case "distance":
      return dose.carryM !== undefined ? String(dose.carryM) : "";
    case "reps":
      return typeof dose.reps === "number" ? String(dose.reps) : dose.reps ? `${dose.reps.min}–${dose.reps.max}` : "";
  }
}

/** The amount in words: "8", "8–12", "45 s", "6", "40 m". */
export function amountText(dose: WorkoutDose, kind: AmountKind): string {
  const v = amountValue(dose, kind);
  if (!v) return "";
  return kind === "hold" ? secondsText(dose.holdSec!) : kind === "distance" ? `${v} m` : v;
}

/** "3 × 8 · 25 lb", "10 reps", "30 s each side", "30 s each side, to max", "6 breaths". */
export function doseSummary(dose: WorkoutDose): string {
  const kind = amountKind(dose);
  const amount = amountText(dose, kind);
  const sets = dose.sets ?? 1;
  const unit = kind === "breaths" ? " breaths" : kind === "reps" && sets <= 1 && amount ? " reps" : "";
  const body = `${sets > 1 && amount ? `${sets} × ` : ""}${amount}${unit}`;
  const sides = dose.perSide ? `${body ? " " : ""}each side` : "";
  const max = dose.max ? `${body || sides ? ", " : ""}to max` : "";
  const load = dose.load && dose.load !== "bodyweight" ? ` · ${dose.load.typed}` : "";
  return `${body}${sides}${max}${load}`;
}
