/**
 * ADD, PURE (Stage 2 spec §7). What the one small Add sheet decides that needs no React:
 *
 *   addMove           a move into a document: it lands in the part its purpose belongs to (`placementFor` — warm-up →
 *                     warm-up, strength → main, balance → accessory, mobility and stretches → cool-down, condition care →
 *                     care, …), the part made when the document has none; through the editor's `tryEdit`, so a full
 *                     part or a document that would break says why and nothing changes.
 *   editableWorkouts  the planned workouts the Studio may add to: document workouts (the Studio's own, a template's)
 *                     still to be done — never a programme's session, which the engine builds (the sheet offers Pin
 *                     for those), and never one done, skipped, missed or under way.
 *   rejectionText     why an Add did nothing, in plain words.
 *   addTargetHref     where Open goes: the builder, on the thing the move went into (spec §2's routes).
 */
import { revisability, type WorkoutDoc } from "@rg/domain";
import { label, type ExerciseRecord } from "@rg/exercise-library";
import { itemFor, newDoc, placementFor, startEditing, tryEdit, type DraftDoc, type Rejection } from "@rg/workout";
import type { WorkoutDto } from "@rg/api-client";
import { formatDayShort, formatTime } from "../../components.js";

export type AddTargetKind = "draft" | "workout" | "new" | "template";

/** Where a move can go: the workout being built, a planned workout, a new workout, or a template. */
export type AddTarget =
  | { kind: "draft" }
  | { kind: "workout"; id: string }
  | { kind: "new" }
  | { kind: "template"; id: string };

type PartPurpose = WorkoutDoc["parts"][number]["purpose"];

/**
 * The move into the document, in the part its purpose belongs to — made if the document has none. A refusal
 * (`full`, `invalid`, …) changes nothing: the caller shows `rejectionText` and keeps the sheet open.
 */
export function addMove(
  doc: WorkoutDoc,
  rec: ExerciseRecord,
  library: readonly ExerciseRecord[],
): { doc: DraftDoc; part: PartPurpose } | { rejected: Rejection } {
  const r = tryEdit(startEditing(doc), { type: "addItem", item: itemFor(rec) }, library);
  if (r.rejected) return { rejected: r.rejected };
  return { doc: r.state.doc, part: placementFor(rec) };
}

/** A new workout to put the move into: warm-up, main and cool-down, as the builder starts one (spec §8). */
export const freshDoc = (): DraftDoc => newDoc("structured", { title: "New workout", source: { kind: "studio" } });

/**
 * A planned workout the Studio may change: any revisable one (`revisability`, workout-editability spec §3) — a Studio or
 * template workout, or a coach or watch session the revise adopts into a document — today or later, not resolved,
 * under way, a rest day, a race, a programme's session or a run.
 */
export function editableWorkout(w: WorkoutDto, today: string): boolean {
  return !w.archived && revisability(rowOf(w), today).ok;
}

/** The row as `revisability` reads it: the list carries no document, so sport and category decide a run. */
export const rowOf = (w: WorkoutDto) => ({
  origin: w.origin ?? null,
  category: w.category ?? null,
  sport: w.sport ?? null,
  completionState: w.completionState ?? null,
  contentState: w.contentState ?? null,
  effectiveDate: w.effectiveDate,
  archived: w.archived,
  hasDoc: w.hasDoc ?? false,
  isRun: null,
});

/** The planned workouts the sheet offers, soonest first. */
export function editableWorkouts(workouts: readonly WorkoutDto[], today: string): WorkoutDto[] {
  return workouts
    .filter((w) => editableWorkout(w, today))
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.effectiveTime.localeCompare(b.effectiveTime));
}

/**
 * A planned workout as the sheet's choice names it: "Thu Oct 15 · Strength day" — with its time too when another one
 * offered shares its day and title, so two choices never read alike.
 */
export function plannedLabel(w: WorkoutDto, offered: readonly WorkoutDto[]): string {
  const twin = offered.some((o) => o.id !== w.id && o.effectiveDate === w.effectiveDate && o.title === w.title);
  return `${formatDayShort(w.effectiveDate)} · ${w.title}${twin ? ` · ${formatTime(w.effectiveTime)}` : ""}`;
}

/** Why an Add did nothing, in plain words. */
export function rejectionText(r: Rejection): string {
  switch (r) {
    case "full":
      return "That part is full.";
    case "invalid":
      return "That move can't go in here.";
    case "missing":
      return "That part is gone.";
    case "unchanged":
      return "Nothing to add.";
  }
}

/** "Added to Main in “Hips & posture”." */
export const addedText = (part: PartPurpose, title: string): string => `Added to ${label(part)} in “${title}”.`;

/** Where Open goes: the builder on what the move went into (spec §2). */
export function addTargetHref(t: AddTarget): string {
  switch (t.kind) {
    case "draft":
    case "new":
      return "/studio/build/new";
    case "workout":
      return `/studio/build/workout/${encodeURIComponent(t.id)}`;
    case "template":
      return `/studio/build/template/${encodeURIComponent(t.id)}`;
  }
}
