/**
 * THE DOCUMENT EDITOR (Stage 2 spec §7, §8): every edit the Studio's builder makes is a pure action on a WorkoutDoc, so
 * each is testable without a browser. History is the reducer's own: the last 20 documents, undo and redo.
 *
 * DRAFTS. The editor never produces a document that fails `workoutDocSchema` EXCEPT for empty parts: a structured new
 * document starts with empty warm-up, main and cool-down parts, and removing a part's last item leaves it empty (the
 * athlete is mid-edit). `DraftDoc` names that: it is a WorkoutDoc whose parts may have no items. Anything that saves,
 * validates or starts a workout goes through `toProposable`, which drops the empty parts and checks the schema.
 * An action that would break the schema (an out-of-range dose, an empty title, a 21st part) is a no-op and adds no history;
 * `tryEdit` says why (full, invalid, missing, unchanged).
 *
 * The draft is a BRANDED type: a caller cannot hand a draft where a WorkoutDoc is required, and `toProposable` is the only
 * way out.
 *
 * TEXT. Dispatch text edits (title, summary, cue) on commit or blur, not per keystroke: each dispatch is one history
 * entry (20 deep), and an empty title or summary is rejected, so a field cleared mid-typing would be refused.
 */
import { PART_PURPOSES, doseSchema, itemSchema, partSchema, workoutDocSchema, type WorkoutDoc, type WorkoutDose, type WorkoutItem, type WorkoutPart } from "@rg/domain";
import { isPlyometric, type ExerciseRecord, type Purpose } from "@rg/exercise-library";
import { makeLibraryIndex } from "./derive.js";

type PartPurpose = WorkoutPart["purpose"];
type Find = (id: string) => ExerciseRecord | undefined;

declare const draftBrand: unique symbol;
/** A WorkoutDoc whose parts may be empty (see the header). Branded: only `newDoc`, `startEditing` and the reducer make one. */
export type DraftDoc = WorkoutDoc & { readonly [draftBrand]: true };
const asDraft = (doc: WorkoutDoc): DraftDoc => doc as DraftDoc;

/** Why an action did nothing. */
export type Rejection = "full" | "invalid" | "missing" | "unchanged";

export type EditAction =
  | { type: "setTitle"; title: string }
  | { type: "setIntent"; intent: Partial<WorkoutDoc["intent"]> }
  | { type: "addPart"; purpose: PartPurpose; at?: number }
  | { type: "removePart"; part: number }
  | { type: "movePart"; part: number; to: number }
  | { type: "setPart"; part: number; patch: Partial<Omit<WorkoutPart, "items">> }
  /** No part: the part the move's library purpose belongs to (spec §7), created if missing. */
  | { type: "addItem"; item: WorkoutItem; part?: number }
  | { type: "removeItem"; part: number; item: number }
  | { type: "moveItem"; from: [number, number]; to: [number, number] }
  | { type: "setDose"; part: number; item: number; dose: WorkoutDose }
  | { type: "swapItem"; part: number; item: number; libraryId: string }
  | { type: "setCue"; part: number; item: number; cue: string | undefined }
  /** Where it is done (`setting.placeId`): one of the athlete's places, "none" (no equipment), or none named (the default). */
  | { type: "setPlace"; placeId: string | undefined };

export interface EditorState {
  doc: DraftDoc;
  past: DraftDoc[];
  future: DraftDoc[];
}

export const HISTORY_LIMIT = 20;
const MAX_PARTS = 20;
const MAX_ITEMS = 60;

/** The order parts sit in when one is created. */
export const PART_ORDER: readonly PartPurpose[] = ["arrive", "warmup", "activation", "power", "main", "accessory", "conditioning", "run", "care", "cooldown"];

/** Which of a record's purposes decides its part, first match wins. "cooldown" (a purpose of its own) comes last. */
const PURPOSE_PRIORITY: readonly Purpose[] = ["activation", "strength", "power", "conditioning", "balance", "warmup", "condition-care", "mobility", "stretch", "recovery", "cooldown"];
const PART_OF_PURPOSE: Record<Purpose, PartPurpose> = {
  warmup: "warmup",
  activation: "activation",
  strength: "main",
  power: "power",
  balance: "accessory",
  mobility: "cooldown",
  stretch: "cooldown",
  cooldown: "cooldown",
  recovery: "cooldown",
  "condition-care": "care",
  conditioning: "conditioning",
};

/**
 * The part a library move belongs to (spec §7). A jump (plyometric) is always a power move: the session's jumps live in
 * one part, early, while fresh, whatever else the move is for. A passive-contraction move (release, massage) is a
 * cool-down move unless it is condition care.
 */
export function placementFor(record: ExerciseRecord): PartPurpose {
  if (isPlyometric(record)) return "power";
  if (record.contraction.includes("passive") && !record.purposes.includes("condition-care")) return "cooldown";
  for (const p of PURPOSE_PRIORITY) if (record.purposes.includes(p)) return PART_OF_PURPOSE[p];
  return "main";
}

export function newDoc(kind: "blank" | "structured", meta: { title: string; source: WorkoutDoc["source"] }): DraftDoc {
  const empty = (purpose: PartPurpose): WorkoutPart => ({ purpose, format: "straight", items: [] });
  const title = meta.title.trim().slice(0, 80) || "New workout";
  return asDraft({
    version: 1,
    title,
    intent: { summary: title, goals: [], focus: [], effort: "maintain" },
    parts: kind === "structured" ? [empty("warmup"), empty("main"), empty("cooldown")] : [],
    source: meta.source,
  });
}

/** Open a document (a stored one, or a new draft) for editing. */
export const startEditing = (doc: WorkoutDoc): EditorState => ({ doc: asDraft(doc), past: [], future: [] });

/** Parts whose moves are light: one set each. */
export const LIGHT_PARTS: ReadonlySet<PartPurpose> = new Set<PartPurpose>(["arrive", "warmup", "activation", "cooldown", "care"]);

/**
 * THE ONE DOSE a library move starts with in a part of `purpose` — the dose the list row and the detail say, that Add
 * puts in, that the builder's picker and its suggestions put in, and that a swap's new move takes when the old dose
 * doesn't fit it: its range's low end (reps keep the range: "3 × 8–12"), its own sets — one in a light part — each side
 * for a one-sided move, and its rest between sets when it has more than one (a one-set move has none: only the
 * transition, CUJ R16). A library carry's range is seconds: a timed carry (`holdSec`); `carryM` is only ever a distance
 * a source stated.
 */
export function doseFor(rec: ExerciseRecord, purpose: PartPurpose): WorkoutDose {
  const [lo, hi] = rec.dose.range;
  const sets = LIGHT_PARTS.has(purpose) ? 1 : (rec.dose.sets?.[0] ?? 1);
  const amount: WorkoutDose =
    rec.dose.type === "time" || rec.dose.type === "carry" ? { holdSec: lo } : rec.dose.type === "breaths" ? { breaths: lo } : { reps: lo === hi ? lo : { min: lo, max: hi } };
  return {
    sets,
    ...amount,
    ...(rec.laterality !== "bilateral" ? { perSide: true } : {}),
    ...(sets > 1 && rec.dose.restSec !== undefined ? { restSec: rec.dose.restSec } : {}),
  };
}

/** The item for a library move, as the Add sheet puts it in: in the part it belongs to, with that part's dose. */
export function itemFor(rec: ExerciseRecord): WorkoutItem {
  return { kind: "exercise", libraryId: rec.id, dose: doseFor(rec, placementFor(rec)) };
}

/** Whether a dose already speaks the record's dose type. */
function fitsType(dose: WorkoutDose, type: ExerciseRecord["dose"]["type"]): boolean {
  if (type === "time") return dose.holdSec !== undefined && dose.reps === undefined;
  if (type === "breaths") return dose.breaths !== undefined;
  // Timed (the library's way), or a distance a source stated.
  if (type === "carry") return (dose.holdSec !== undefined || dose.carryM !== undefined) && dose.reps === undefined;
  return dose.reps !== undefined && dose.holdSec === undefined;
}

const insertAt = <T>(list: readonly T[], at: number, value: T): T[] => [...list.slice(0, at), value, ...list.slice(at)];
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const inRange = (i: number, len: number): boolean => Number.isInteger(i) && i >= 0 && i < len;

/** Where a part of this purpose goes: before the first part that sits later in the canonical order. */
function orderedAt(parts: readonly WorkoutPart[], purpose: PartPurpose): number {
  const rank = PART_ORDER.indexOf(purpose);
  const at = parts.findIndex((p) => PART_ORDER.indexOf(p.purpose) > rank);
  return at < 0 ? parts.length : at;
}

function ensurePart(parts: readonly WorkoutPart[], purpose: PartPurpose): { parts: WorkoutPart[]; index: number } | null {
  const found = parts.findIndex((p) => p.purpose === purpose);
  if (found >= 0) return { parts: [...parts], index: found };
  if (parts.length >= MAX_PARTS) return null;
  const at = orderedAt(parts, purpose);
  return { parts: insertAt(parts, at, { purpose, format: "straight", items: [] }), index: at };
}

/** The part a new item lands in when none is named; null = could not make one. */
function targetFor(item: WorkoutItem, doc: WorkoutDoc, find: Find): { parts: WorkoutPart[]; index: number } | null {
  if (item.kind === "rest" && doc.parts.length) return { parts: [...doc.parts], index: doc.parts.length - 1 };
  const rec = item.kind === "exercise" ? find(item.libraryId) : undefined;
  const purpose: PartPurpose = rec ? placementFor(rec) : item.kind === "run" ? "run" : "main";
  return ensurePart(doc.parts, purpose);
}

type Applied = WorkoutDoc | Exclude<Rejection, "unchanged">;

const mapItem = (doc: WorkoutDoc, part: number, item: number, f: (it: WorkoutItem) => WorkoutItem | null): Applied => {
  const p = doc.parts[part];
  if (!p || !inRange(item, p.items.length)) return "missing";
  const next = f(p.items[item]!);
  // The edited item must still pass the schema (a cue, a dose, a swap), like every other action.
  if (!next || !itemSchema.safeParse(next).success) return "invalid";
  return { ...doc, parts: doc.parts.map((q, i) => (i === part ? { ...q, items: q.items.map((it, j) => (j === item ? next : it)) } : q)) };
};

function apply(doc: WorkoutDoc, action: EditAction, find: Find): Applied {
  switch (action.type) {
    case "setTitle": {
      const title = action.title.trim().slice(0, 80);
      return title ? { ...doc, title } : "invalid";
    }
    case "setIntent": {
      const parsed = workoutDocSchema.shape.intent.safeParse({ ...doc.intent, ...action.intent });
      return parsed.success ? { ...doc, intent: parsed.data } : "invalid";
    }
    case "addPart": {
      if (!PART_PURPOSES.includes(action.purpose)) return "invalid";
      if (doc.parts.length >= MAX_PARTS) return "full";
      const part: WorkoutPart = { purpose: action.purpose, format: "straight", items: [] };
      const at = action.at !== undefined ? clamp(action.at, 0, doc.parts.length) : orderedAt(doc.parts, action.purpose);
      return { ...doc, parts: insertAt(doc.parts, at, part) };
    }
    case "removePart":
      return inRange(action.part, doc.parts.length) ? { ...doc, parts: doc.parts.filter((_, i) => i !== action.part) } : "missing";
    case "movePart": {
      if (!inRange(action.part, doc.parts.length)) return "missing";
      const rest = doc.parts.filter((_, i) => i !== action.part);
      return { ...doc, parts: insertAt(rest, clamp(action.to, 0, rest.length), doc.parts[action.part]!) };
    }
    case "setPart": {
      const p = doc.parts[action.part];
      if (!p) return "missing";
      const merged: WorkoutPart = { ...p, ...action.patch, items: p.items };
      // An empty part is a legal draft; check the rest of the part's shape on a stand-in item.
      const probe = partSchema.safeParse({ ...merged, items: [{ kind: "rest", seconds: 1 }] });
      return probe.success ? { ...doc, parts: doc.parts.map((q, i) => (i === action.part ? merged : q)) } : "invalid";
    }
    case "addItem": {
      if (!itemSchema.safeParse(action.item).success) return "invalid";
      let parts: WorkoutPart[];
      let index: number;
      if (action.part !== undefined) {
        if (!inRange(action.part, doc.parts.length)) return "missing";
        parts = [...doc.parts];
        index = action.part;
      } else {
        const t = targetFor(action.item, doc, find);
        if (!t) return "full";
        ({ parts, index } = t);
      }
      const target = parts[index]!;
      if (target.items.length >= MAX_ITEMS) return "full";
      parts[index] = { ...target, items: [...target.items, action.item] };
      return { ...doc, parts };
    }
    case "removeItem": {
      const p = doc.parts[action.part];
      if (!p || !inRange(action.item, p.items.length)) return "missing";
      return { ...doc, parts: doc.parts.map((q, i) => (i === action.part ? { ...q, items: q.items.filter((_, j) => j !== action.item) } : q)) };
    }
    case "moveItem": {
      const [fp, fi] = action.from;
      const [tp, ti] = action.to;
      const src = doc.parts[fp];
      if (!src || !inRange(fi, src.items.length) || !doc.parts[tp]) return "missing";
      if (tp !== fp && doc.parts[tp]!.items.length >= MAX_ITEMS) return "full";
      const moved = src.items[fi]!;
      const parts = doc.parts.map((q, i) => (i === fp ? { ...q, items: q.items.filter((_, j) => j !== fi) } : q));
      const dest = parts[tp]!;
      parts[tp] = { ...dest, items: insertAt(dest.items, clamp(ti, 0, dest.items.length), moved) };
      return { ...doc, parts };
    }
    case "setDose": {
      const dose = doseSchema.safeParse(action.dose);
      if (!dose.success) return "invalid";
      return mapItem(doc, action.part, action.item, (it) => (it.kind === "exercise" || it.kind === "free_exercise" ? { ...it, dose: dose.data } : null));
    }
    case "swapItem": {
      const next = find(action.libraryId);
      if (!next) return "missing";
      return mapItem(doc, action.part, action.item, (it) => {
        if (it.kind !== "exercise") return null;
        // Same dose shape stays; otherwise the new move's own dose for this part (reps <-> hold), never a reps dose on a
        // time-only move.
        const dose = fitsType(it.dose, next.dose.type) ? it.dose : doseFor(next, doc.parts[action.part]!.purpose);
        return { kind: "exercise", libraryId: next.id, dose, ...(it.cue ? { cue: it.cue } : {}) };
      });
    }
    case "setPlace": {
      const { placeId: _drop, ...rest }: NonNullable<WorkoutDoc["setting"]> = doc.setting ?? {};
      const setting = action.placeId === undefined ? rest : { ...rest, placeId: action.placeId };
      if (!workoutDocSchema.shape.setting.safeParse(setting).success) return "invalid";
      if (Object.keys(setting).length) return { ...doc, setting };
      const { setting: _gone, ...bare } = doc;
      return bare;
    }
    case "setCue": {
      const cue = action.cue?.trim().slice(0, 160);
      return mapItem(doc, action.part, action.item, (it) => {
        if (it.kind === "rest") return null;
        const { cue: _drop, ...rest } = it;
        return (cue ? { ...rest, cue } : rest) as WorkoutItem;
      });
    }
  }
}

/** Apply an action and say why if nothing happened. Rejected and unchanged actions return the same state: no history entry. */
export function tryEdit(state: EditorState, action: EditAction, library: readonly ExerciseRecord[]): { state: EditorState; rejected?: Rejection } {
  const next = apply(state.doc, action, makeLibraryIndex(library));
  if (typeof next === "string") return { state, rejected: next };
  if (JSON.stringify(next) === JSON.stringify(state.doc)) return { state, rejected: "unchanged" };
  return { state: { doc: asDraft(next), past: [...state.past, state.doc].slice(-HISTORY_LIMIT), future: [] } };
}

/** `tryEdit`, without the reason. */
export function edit(state: EditorState, action: EditAction, library: readonly ExerciseRecord[]): EditorState {
  return tryEdit(state, action, library).state;
}

export function undo(state: EditorState): EditorState {
  const prev = state.past[state.past.length - 1];
  if (!prev) return state;
  return { doc: prev, past: state.past.slice(0, -1), future: [state.doc, ...state.future].slice(0, HISTORY_LIMIT) };
}

export function redo(state: EditorState): EditorState {
  const [next, ...rest] = state.future;
  if (!next) return state;
  return { doc: next, past: [...state.past, state.doc].slice(-HISTORY_LIMIT), future: rest };
}

/** The draft as a document that passes the schema: empty parts dropped; null when nothing is left (or it still fails). */
export function toProposable(doc: DraftDoc): WorkoutDoc | null {
  const parts = doc.parts.filter((p) => p.items.length > 0);
  if (!parts.length) return null;
  const r = workoutDocSchema.safeParse({ ...doc, parts });
  return r.success ? r.data : null;
}
