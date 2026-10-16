/**
 * A DESIGNED WORKOUT'S MANIFEST (Stage 3 spec §8): what each op of a proposal does, computed from its document, never
 * from prose — the coach manifest's own rule (@rg/domain coach-describe.ts: the model never states a fact the system
 * can compute). In the Studio's own voice, through the Studio's own helpers:
 *  - its minutes are `deriveDoc`'s, as the builder's summary says them;
 *  - its parts are a part header's words: the purpose, and beyond straight sets the format and its rounds ("Main ·
 *    Superset × 3"), each the vocabulary's `label`;
 *  - the effort is the vocabulary's word ("Maintain"), as the builder's picker and the validator say it;
 *  - the place is the place's name by default-place.ts's rule — the one the document names (the athlete's, a preset,
 *    or "No equipment"), else (none named, or one deleted since) the default place;
 *  - each move is its library name and its dose as the builder's row says it (`doseSummary`);
 *  - the review's mean is the set's own (design-orchestrate.ts `reviewMeanOf`: one number per review, wherever it is
 *    shown; null when the review couldn't be read).
 * Each line carries how its op ended, once the athlete decided — and, for an op applied, what was WRITTEN (`written`:
 * its day, time, title and minutes as the plan holds them), which after Edit before approve is the athlete's version,
 * never the coach's. The line's own fields stay the coach's proposal. Dates reach the UI as ISO dates for it to format;
 * the thread's receipt names a day as the coach manifest does (`dayLabel`).
 *
 * A change to a session already on the plan (Task 8b) has its own line (`planChangeLines`): the thread coach's manifest
 * line for its skip, move or length, word for word (@rg/domain `describeOps`), and the coach's why.
 */
import { sql } from "drizzle-orm";
import { locations } from "@rg/database";
import { dayLabel, doseSummary, NO_EQUIPMENT_PLACE, type WorkoutItem, type WorkoutPart } from "@rg/domain";
import { EXERCISES, label, LOCATION_PRESETS, noEquipmentPlace } from "@rg/exercise-library";
import { deriveDoc, makeLibraryIndex } from "@rg/workout";
import type { Db } from "./db.js";
import { defaultFromRow, defaultPlaceSql } from "./default-place.js";
import type { DesignedOp, DesignedPlanOp, OpOutcome, PlanOpOutcome, Written } from "./design-approve.js";
import { reviewMeanOf } from "./design-orchestrate.js";
import { describeChange, isPlanAdjustOp, opIdOf } from "./proposal-kinds.js";

/** One designed workout, as the athlete reads it before (and after) deciding. */
export interface DocWorkoutLine {
  opId: string;
  kind: "new" | "revise";
  /** A revision's workout. */
  workoutId?: string;
  date: string;
  /** "HH:MM", or null: placed at the athlete's window. */
  time: string | null;
  title: string;
  minutes: number;
  /** "Hips and back · 24 min". */
  summary: string;
  /** The effort's word: "Maintain". */
  effort: string;
  /** Where: the place's name. */
  place: string;
  /** Each part, as its header says it: "Warm-up", "Main · Superset × 3". */
  parts: string[];
  /** Each move with its dose: "Glute bridge 2 × 12". */
  detail: string[];
  /** The review's mean score (1–5; `reviewMeanOf`); null when there is none to average. */
  reviewMean: number | null;
  /** How it ended; null while it is the athlete's to decide. */
  outcome: OpOutcome | null;
  /** Applied: what the plan holds — the athlete's version and day after an edit or a move. Null otherwise. */
  written: (Written & { summary: string; edited: boolean; moved: boolean }) | null;
}

/** A place id (or none) → the name the athlete knows it by. */
export type PlaceNamer = (placeId: string | undefined) => string;

const find = makeLibraryIndex(EXERCISES);

/** "Hips and back · 24 min" — the coach manifest's summary shape. */
export const summaryLine = (title: string, minutes: number): string => `${title} · ${minutes} min`;

/** "Fri 15 May · Hips and back · 24 min", with "(edited)" after the title when the athlete changed the coach's draft. */
export const receiptLine = (date: string, title: string, minutes: number, edited = false): string =>
  `${dayLabel(date)} · ${summaryLine(edited ? `${title} (edited)` : title, minutes)}`;

/** A part's header words: its purpose, and its format beyond straight sets ("Main · Superset × 3"). */
export function partLine(part: WorkoutPart): string {
  const name = label(part.purpose);
  if (part.format === "straight") return name;
  const rounds = part.rounds && part.rounds > 1 ? ` × ${part.rounds}` : "";
  return `${name} · ${label(part.format)}${rounds}`;
}

/** A move and its dose, as the builder's row says them. */
function itemLine(it: WorkoutItem): string {
  switch (it.kind) {
    case "exercise":
      return `${find(it.libraryId)?.name ?? it.libraryId} ${doseSummary(it.dose)}`.trim();
    case "free_exercise":
      return `${it.name} ${doseSummary(it.dose)}`.trim();
    case "run":
      return "Run";
    case "rest":
      return `Rest ${it.seconds} s`;
  }
}

/** What an applied op wrote, as a line says it; null for any other outcome (or an applied one recorded without it). */
function writtenLine(o: OpOutcome | undefined): DocWorkoutLine["written"] {
  if (o?.status !== "applied" || !o.written) return null;
  const w = o.written;
  return { ...w, summary: summaryLine(w.title, w.minutes), edited: !!o.edited, moved: !!o.moved };
}

/** Each op's line, in the proposal's order. */
export function docWorkoutLines(ops: readonly DesignedOp[], placeName: PlaceNamer): DocWorkoutLine[] {
  return ops.map((op) => {
    const doc = op.doc;
    const minutes = deriveDoc(doc, EXERCISES).estimatedMinutes;
    return {
      opId: opIdOf(op),
      kind: op.target.kind,
      ...(op.target.kind === "revise" ? { workoutId: op.target.workoutId } : {}),
      date: op.date,
      time: op.time ?? null,
      title: doc.title,
      minutes,
      summary: summaryLine(doc.title, minutes),
      effort: label(doc.intent.effort),
      place: placeName(doc.setting?.placeId),
      parts: doc.parts.map(partLine),
      detail: doc.parts.flatMap((p) => p.items.map(itemLine)),
      reviewMean: reviewMeanOf(op),
      outcome: op.outcome ?? null,
      written: writtenLine(op.outcome),
    };
  });
}

/**
 * One change to a session already on the plan (Task 8b), as the athlete reads it before (and after) deciding: the
 * thread coach's own manifest line for its op (@rg/domain `describeOps`, proposal-kinds.ts `describeChange`) — with the
 * session as the plan held it when the coach proposed the change — and the coach's `why`.
 */
export interface PlanChangeLine {
  opId: string;
  kind: "skip" | "move" | "adjust";
  workoutId: string;
  /** The day the line is under: a move's destination, else the session's day. */
  date: string | null;
  /** A move's time asked for, else null. */
  time: string | null;
  /** "Strength — skipped", "Easy run — 30 min", a moved session's name. */
  summary: string;
  /** What it replaced: a move's old day, a length's old minutes — only a real difference. */
  was: string | null;
  /** What `was` can't say: a skip's reason. */
  effect: string | null;
  /** The coach's reason, in its words. */
  why: string;
  /** How it ended; null while it is the athlete's to decide. */
  outcome: PlanOpOutcome | null;
}

/** Each change's line, in the proposal's order. */
export function planChangeLines(ops: readonly unknown[]): PlanChangeLine[] {
  return (ops.filter(isPlanAdjustOp) as DesignedPlanOp[]).map((c) => {
    const w = describeChange(c);
    return {
      opId: c.id,
      kind: c.op.kind,
      workoutId: c.op.workoutId,
      date: w.date,
      time: w.time,
      summary: w.summary,
      was: w.was,
      effect: w.effect,
      why: c.why,
      outcome: c.outcome ?? null,
    };
  });
}

/**
 * The names of the athlete's places, by default-place.ts's rule (see the module comment), for the manifest. One
 * statement: the default place and the athlete's own places' names.
 */
export async function placeNamer(db: Db, userId: string): Promise<PlaceNamer> {
  const l = locations;
  const [row] = (await db.all(
    sql`select ${defaultPlaceSql(userId)} as fallback,
      (select json_group_array(json_object('id', ${l.id}, 'name', ${l.name})) from ${l} where ${l.userId} = ${userId}) as own`,
  )) as Array<{ fallback: unknown; own: unknown }>;
  const fallback = defaultFromRow(row?.fallback ?? null).name;
  const own = new Map<string, string>();
  try {
    const list = JSON.parse(typeof row?.own === "string" ? row.own : "[]") as Array<{ id?: unknown; name?: unknown }>;
    for (const p of list) if (typeof p.id === "string") own.set(p.id, typeof p.name === "string" ? p.name : p.id);
  } catch {
    // No places to name: every document is at the default.
  }
  return (id) => {
    if (!id) return fallback;
    const mine = own.get(id);
    if (mine !== undefined) return mine;
    if (id === NO_EQUIPMENT_PLACE) return noEquipmentPlace().name;
    return LOCATION_PRESETS.find((p) => p.id === id)?.name ?? fallback;
  };
}
