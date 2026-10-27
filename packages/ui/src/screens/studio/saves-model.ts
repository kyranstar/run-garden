/**
 * "FROM YOUR SAVES" — what the review screen draws from (saves.tsx): a batch's facts, the page's rows (one per new move,
 * its line of purpose, the tally of the owner's choices) and what each row's sheet offers, the edit form and the patch
 * it sends (only what changed), and a refused write in plain words; and the open batch's words on Today and in the
 * coach (saves-today-card.tsx, coach-saves.tsx).
 * Pure: no React, no network.
 */
import { ApiError } from "@rg/api-client";
import { dayLabel } from "@rg/domain";
import { DOSE_TYPES, PROFILES, type Dose, type DoseType, type ExerciseRecord } from "@rg/exercise-library";
import { numberWord, type FitChoice, type OpenSavesBatchDto, type OpenSavesDto, type PersonalMovePatch, type SaveBatchDto, type SaveBatchRowDto } from "@rg/saves";

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

/** "Hips · 2 new · 1 linked · Saved": the theme, the counts that aren't zero, and where it stands — put aside included. */
export function batchFacts(b: SaveBatchDto): string[] {
  return [
    ...(b.theme ? [b.theme] : []),
    ...(b.counts.new ? [`${b.counts.new} new`] : []),
    ...(b.counts.linked ? [`${b.counts.linked} linked`] : []),
    ...(b.counts.removed ? [`${b.counts.removed} removed`] : []),
    ...(b.status === "saved" ? ["Saved"] : b.status === "held" ? ["Held"] : b.status === "dismissed" ? ["Dismissed"] : []),
    ...(b.dismissedAt && !b.fittedAt ? ["Put aside"] : []),
  ];
}

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

/** Whether a batch can be fitted in ("Fit these in", "Fit them in"): released or saved, not fitted in, no fit at work. */
export const canFit = (b: SaveBatchDto): boolean => !b.fittedAt && !b.fitting && (b.status === "released" || b.status === "saved");

/** How many batches wait for the owner: released or saved, and not fitted in yet (put aside too). */
export const waitingBatches = (batches: readonly SaveBatchDto[]): number =>
  batches.filter((b) => !b.fittedAt && (b.status === "released" || b.status === "saved")).length;

// ── The batch page: one row per new move (the saves flow redesigned §3.3) ──────────────────────────────────────────

/** A new move's row: its name, one line of what it is for, and its first kept link (the sheet's). */
export interface PageRow {
  moveId: string;
  row: SaveBatchRowDto;
  name: string;
  purpose: string;
  /** "Check this" on any of its kept links. */
  check: boolean;
  /** The move it looks like (a near-duplicate), from the first of its kept links that names one. */
  like?: { id: string; name: string };
}

/** A move the owner already has: by the name it has among their moves. */
export interface OwnedRow {
  moveId: string;
  name: string;
  row: SaveBatchRowDto;
}

/** The longest line of purpose a row shows. */
const PURPOSE_MAX = 80;

/** Cut between words to at most `max` characters, "…" at the end when anything was cut. */
function cutByWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const room = s.slice(0, max);
  const space = room.lastIndexOf(" ");
  return `${(space > 0 ? room.slice(0, space) : room.slice(0, max - 1)).trimEnd()}…`;
}

/** What the move is for, in one line: the post's purpose, else its summary's first sentence — at most 80 characters. */
export function purposeLine(row: SaveBatchRowDto): string {
  const purpose = row.move.purpose?.trim();
  const line = purpose || (row.move.summary.trim().match(/^.*?[.!?](?=\s|$)/)?.[0] ?? row.move.summary.trim());
  return cutByWord(line, PURPOSE_MAX);
}

/**
 * The page's rows: one per distinct move of the kept rows (a removed row is gone), in the posts' order, each holding
 * its first kept link — the new moves, and apart from them the moves already the owner's.
 */
export function pageRowsOf(rows: readonly SaveBatchRowDto[]): { fresh: PageRow[]; owned: OwnedRow[] } {
  const fresh = new Map<string, PageRow>();
  const owned = new Map<string, OwnedRow>();
  for (const row of rows) {
    if (row.status === "removed") continue;
    const id = row.move.id;
    const seen = fresh.get(id);
    if (seen) {
      seen.check ||= row.move.check;
      if (!seen.like && row.move.like) seen.like = row.move.like;
      continue;
    }
    if (owned.has(id)) continue;
    if (row.move.kind === "new") {
      fresh.set(id, { moveId: id, row, name: row.move.name, purpose: purposeLine(row), check: row.move.check, ...(row.move.like ? { like: row.move.like } : {}) });
    } else owned.set(id, { moveId: id, name: row.move.linkedName ?? row.move.name, row });
  }
  return { fresh: [...fresh.values()], owned: [...owned.values()] };
}

/** A move's pending links: every post of the batch that shows it, still the owner's to change. */
export const pendingLinksOf = (rows: readonly SaveBatchRowDto[], moveId: string): string[] =>
  rows.filter((r) => r.status === "pending" && r.move.id === moveId).map((r) => r.postMoveId);

/**
 * The foot's tally of the owner's choices over these moves (a move with no choice is on the coach's call): "2 in · 1 out
 * · 6 on the coach's call", zero parts left out; every move on the coach's call: "On the coach's call", "Both on the
 * coach's call", "All nine on the coach's call". No moves: nothing.
 */
export function tallyLine(choices: Readonly<Record<string, FitChoice | undefined>>, moveIds: readonly string[]): string {
  const n = moveIds.length;
  if (n === 0) return "";
  const of = (c: FitChoice) => moveIds.filter((id) => choices[id] === c).length;
  const inc = of("include");
  const out = of("skip");
  const coach = n - inc - out;
  if (coach === n) return n === 1 ? "On the coach's call" : n === 2 ? "Both on the coach's call" : `All ${numberWord(n)} on the coach's call`;
  return [inc ? `${inc} in` : null, out ? `${out} out` : null, coach ? `${coach} on the coach's call` : null].filter(Boolean).join(" · ");
}

// ── The open batch: the Today card, the coach's chip and its saves card (the saves flow redesigned §3.1–§3.2) ──────────

/** Every surface, while a fit is at work, in place of its button (spec §12.1). */
export const FITTING_LINE = "Fitting in… open the coach";
/** A fit refused while another batch is open (409 `batch_open`). */
export const OPEN_FIRST_LINE = "finish the batch that is open first";
/** "not now"'s sheet, said before anything is put aside. */
export const PUT_ASIDE_LINE = "Put aside. Find it again under Settings → Saves (or the Studio tab), where Fit them in brings it back.";
/** A fit that did not go through for any other reason. */
export const FIT_FAILED_LINE = "Couldn't fit them in. Try again.";
/** "not now"'s OK that did not go through. */
export const DISMISS_FAILED_LINE = "Couldn't put it aside. Try again.";

type OpenCounts = { new: number; linked: number };
const moveWord = (n: number): string => (n === 1 ? "move" : "moves");

/** Today's headline: "9 new moves from your saves"; with no new move, "3 saved moves you already have". */
export const todayHeadline = (c: OpenCounts): string =>
  c.new > 0 ? `${c.new} new ${moveWord(c.new)} from your saves` : `${c.linked} saved ${moveWord(c.linked)} you already have`;

/** Under it, only beside new moves: "4 more were already yours" ("1 more was already yours"). */
export const todaySubline = (c: OpenCounts): string | null =>
  c.new === 0 || c.linked === 0 ? null : c.linked === 1 ? "1 more was already yours" : `${c.linked} more were already yours`;

/** The coach sheet's chip: "9 new saved moves"; with no new move, "3 saved moves". */
export const savesChipLabel = (c: OpenCounts): string =>
  c.new > 0 ? `${c.new} new saved ${moveWord(c.new)}` : `${c.linked} saved ${moveWord(c.linked)}`;

/** The open batch a surface draws: none open, or one with nothing left in it (every row removed: 0 and 0), is none. */
export function openShown(d: OpenSavesDto | undefined): OpenSavesBatchDto | null {
  const open = d?.open ?? null;
  return open && (open.counts.new > 0 || open.counts.linked > 0) ? open : null;
}

/**
 * A fit refused, in words: another batch open says so. A fit already at work, a batch fitted, gone, never released or
 * with nothing left in it (`empty`) says nothing — the open batch read again shows what is true (Fitting in…, or no
 * card). Anything else: try again.
 */
export function fitRefusal(e: unknown): string | null {
  if (e instanceof ApiError && (e.status === 409 || e.status === 404)) {
    return e.status === 409 && (e.body as { error?: unknown } | null)?.error === "batch_open" ? OPEN_FIRST_LINE : null;
  }
  return FIT_FAILED_LINE;
}

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

/** Why a row's write (an edit, a re-match, a removal) did not happen, in plain words: the library's own words for an
 * edit it refuses. */
export function writeError(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body as { error?: unknown; issues?: unknown } | null;
    if (e.status === 404) return "That isn't there any more.";
    if (e.status === 422 && body?.error === "invalid_record" && Array.isArray(body.issues)) {
      const issues = body.issues.filter((i): i is string => typeof i === "string");
      if (issues.length) return issues.join(" · ");
    }
    if (e.status === 422) return "That edit can't be saved.";
    if (e.status === 409) return "That row has changed. Look again.";
    return "Couldn't save that. Try again.";
  }
  return "That needs a connection.";
}
