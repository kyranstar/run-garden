/**
 * "FROM YOUR SAVES" — what the review screen draws from (saves.tsx): a batch's facts, which rows show and what each
 * row's sheet offers, the edit form and the patch it sends (only what changed), and a refused write in plain words.
 * Pure: no React, no network.
 */
import { ApiError } from "@rg/api-client";
import { dayLabel } from "@rg/domain";
import { DOSE_TYPES, PROFILES, type Dose, type DoseType, type ExerciseRecord } from "@rg/exercise-library";
import type { PersonalMovePatch, SaveBatchDto, SaveBatchRowDto } from "@rg/saves";

/** The batches (`/studio/saves`), or one batch's rows. */
export const savesHref = (batchId?: string): string => (batchId ? `/studio/saves/${encodeURIComponent(batchId)}` : "/studio/saves");

/** An instant's day on this device, in the app's words for a day ("Fri 23 Oct"). */
export function dayOf(instant: string): string {
  const d = new Date(instant);
  if (Number.isNaN(d.getTime())) return "";
  const two = (n: number) => String(n).padStart(2, "0");
  return dayLabel(`${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`);
}

/** A batch by its day: when it was released (a held one: when it was made). */
export const batchDay = (b: SaveBatchDto): string => dayOf(b.releasedAt ?? b.createdAt);

/** "Hips · 2 new · 1 linked · Saved": the theme, the counts that aren't zero, and where it stands. */
export function batchFacts(b: SaveBatchDto): string[] {
  return [
    ...(b.theme ? [b.theme] : []),
    ...(b.counts.new ? [`${b.counts.new} new`] : []),
    ...(b.counts.linked ? [`${b.counts.linked} linked`] : []),
    ...(b.counts.removed ? [`${b.counts.removed} removed`] : []),
    ...(b.status === "saved" ? ["Saved"] : b.status === "held" ? ["Held"] : b.status === "dismissed" ? ["Dismissed"] : []),
  ];
}

/** The rows drawn: a removed one is gone from the list. */
export const shownRows = (rows: readonly SaveBatchRowDto[]): SaveBatchRowDto[] => rows.filter((r) => r.status !== "removed");

export interface RowActions {
  /** A new move, or one of the owner's own active moves: theirs to change. Never the library's. */
  edit: boolean;
  /** The post's move made a new move of its own, from the post's reading (every time; the move it leaves is never used). */
  notThis: boolean;
  sameAs: boolean;
  remove: boolean;
}

/** What a row's sheet offers: a pending row is the owner's to change; a saved one only to edit (its move) and ask about. */
export function rowActions(row: SaveBatchRowDto, ownStatus?: "active" | "archived"): RowActions {
  const pending = row.status === "pending";
  return {
    edit: !!row.record && (row.move.kind === "new" || ownStatus === "active"),
    notThis: pending,
    sameAs: pending,
    remove: pending,
  };
}

/** "Save these" is there while the batch is unsaved and a row is still kept. */
export const canSave = (b: SaveBatchDto, rows: readonly SaveBatchRowDto[]): boolean =>
  (b.status === "released" || b.status === "held") && rows.some((r) => r.status === "pending");

/** Whether the page offers "Fit these in" (final review I3): a saved batch nothing has fitted in yet. */
export const canFit = (b: SaveBatchDto): boolean => b.status === "saved" && !b.fittedAt;

/** How many batches wait for the owner (final review I2): released and not saved, or saved and not fitted in. */
export const waitingBatches = (batches: readonly SaveBatchDto[]): number =>
  batches.filter((b) => b.status === "released" || canFit(b)).length;

// ── The edit form ────────────────────────────────────────────────────────────────────────────────────────────────────

export const DOSE_WORD: Readonly<Record<DoseType, string>> = { reps: "Reps", time: "Seconds", breaths: "Breaths", carry: "Carry seconds" };
export { DOSE_TYPES };

/** An attribute's name in words: "neckLoad" → "Neck load". */
export const attrWord = (key: string): string => {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The form, as text fields: a list is one line per entry; the dose's numbers are text until they are sent. */
export interface MoveForm {
  name: string;
  summary: string;
  steps: string;
  focus: string;
  mistakes: string;
  doseType: DoseType;
  low: string;
  high: string;
  setsMin: string;
  setsMax: string;
  /** Each profile's note. */
  notes: Record<string, string>;
  /** Each profile's ratings. */
  ratings: Record<string, Record<string, number | boolean>>;
}

/** The form a record fills. */
export function formOf(rec: ExerciseRecord): MoveForm {
  const profiles = Object.values(PROFILES);
  return {
    name: rec.name,
    summary: rec.text.summary,
    steps: rec.text.steps.join("\n"),
    focus: rec.text.focus.join("\n"),
    mistakes: rec.text.mistakes.join("\n"),
    doseType: rec.dose.type,
    low: String(rec.dose.range[0]),
    high: String(rec.dose.range[1]),
    setsMin: rec.dose.sets ? String(rec.dose.sets[0]) : "",
    setsMax: rec.dose.sets ? String(rec.dose.sets[1]) : "",
    notes: Object.fromEntries(profiles.map((p) => [p.id, rec.text.conditions[p.id] ?? ""])),
    ratings: Object.fromEntries(profiles.map((p) => [p.id, { ...(rec.conditions[p.id] ?? {}) }])),
  };
}

/** A list field's entries: each line trimmed, blank lines dropped. */
export const linesOf = (text: string): string[] => text.split("\n").map((l) => l.trim()).filter(Boolean);

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const NUMBER = /^\d+(\.\d+)?$/;

/** The dose the form says, or null when a number doesn't read. Sets are both given or both left blank. */
function doseOf(f: MoveForm, was: Dose): Dose | null {
  const nums = [f.low, f.high].map((s) => s.trim());
  const sets = [f.setsMin, f.setsMax].map((s) => s.trim());
  if (!nums.every((s) => NUMBER.test(s))) return null;
  const noSets = sets.every((s) => s === "");
  if (!noSets && !sets.every((s) => NUMBER.test(s))) return null;
  const { sets: _sets, ...rest } = was;
  return {
    ...rest,
    type: f.doseType,
    range: [Number(nums[0]), Number(nums[1])],
    ...(noSets ? {} : { sets: [Number(sets[0]), Number(sets[1])] as const }),
  };
}

const sameDose = (a: Dose, b: Dose): boolean =>
  a.type === b.type && a.range[0] === b.range[0] && a.range[1] === b.range[1] && (a.sets?.[0] ?? null) === (b.sets?.[0] ?? null) && (a.sets?.[1] ?? null) === (b.sets?.[1] ?? null);

/**
 * What the edit sends: only what changed (a profile's note or ratings by that profile — its ratings whole); null when
 * nothing did; `{ error }` when the dose's numbers don't read. The library's own rules are the server's to say.
 */
export function patchOf(rec: ExerciseRecord, f: MoveForm): PersonalMovePatch | null | { error: string } {
  const dose = doseOf(f, rec.dose);
  if (!dose) return { error: "The dose needs numbers." };
  const patch: PersonalMovePatch = {};
  const text: NonNullable<PersonalMovePatch["text"]> = {};
  if (f.name.trim() !== rec.name) patch.name = f.name.trim();
  if (f.summary.trim() !== rec.text.summary) text.summary = f.summary.trim();
  for (const key of ["steps", "focus", "mistakes"] as const) {
    const lines = linesOf(f[key]);
    if (!sameList(lines, rec.text[key])) text[key] = lines;
  }
  const notes: Record<string, string> = {};
  const ratings: Record<string, Record<string, number | boolean>> = {};
  for (const p of Object.values(PROFILES)) {
    const note = (f.notes[p.id] ?? "").trim();
    if (note !== (rec.text.conditions[p.id] ?? "")) notes[p.id] = note;
    const was = rec.conditions[p.id] ?? {};
    const now = { ...was, ...(f.ratings[p.id] ?? {}) };
    if (Object.keys(now).some((k) => now[k] !== was[k])) ratings[p.id] = now;
  }
  if (Object.keys(notes).length) text.conditions = notes;
  if (Object.keys(text).length) patch.text = text;
  if (!sameDose(dose, rec.dose)) {
    // The dose is replaced whole, so what the form doesn't show (rest, seconds a rep, a starting weight) is sent as it was.
    const { type, range, sets, restSec, secsPerRep, startKg } = dose;
    patch.dose = {
      type,
      range: [range[0], range[1]],
      ...(sets ? { sets: [sets[0], sets[1]] } : {}),
      ...(restSec !== undefined ? { restSec } : {}),
      ...(secsPerRep !== undefined ? { secsPerRep } : {}),
      ...(startKg !== undefined ? { startKg } : {}),
    };
  }
  if (Object.keys(ratings).length) patch.conditions = ratings;
  return Object.keys(patch).length ? patch : null;
}

// ── A refused write ──────────────────────────────────────────────────────────────────────────────────────────────────

export type Write = "save" | "edit" | "match" | "remove";

/** Why a write did not happen, in plain words: the library's own words for an edit it refuses. */
export function writeError(e: unknown, what: Write): string {
  if (e instanceof ApiError) {
    const body = e.body as { error?: unknown; issues?: unknown } | null;
    if (e.status === 404) return "That isn't there any more.";
    if (e.status === 422 && body?.error === "invalid_record" && Array.isArray(body.issues)) {
      const issues = body.issues.filter((i): i is string => typeof i === "string");
      if (issues.length) return issues.join(" · ");
    }
    if (e.status === 422) return "That edit can't be saved.";
    if (e.status === 409) return what === "save" ? "This batch has changed. Look again." : "That row has changed. Look again.";
    return what === "save" ? "Couldn't save these. Try again." : "Couldn't save that. Try again.";
  }
  return what === "save" ? "Saving needs a connection." : "That needs a connection.";
}
