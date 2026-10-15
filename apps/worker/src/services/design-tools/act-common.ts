/**
 * WHAT THE COACH DESIGNER'S ACT TOOLS SHARE (Stage 3 spec §4 "Act"; principles §6.1, §6.2).
 *
 *  - Input is checked against the tool's own strict schema (`parseAct`): an unknown field is refused by name — a field
 *    an instruction might have smuggled in (`review`, `confirmed`) has nowhere to land — and named FIRST, so a cut to
 *    the first few problems never hides it.
 *  - A document is the model's, but it may carry what a read tool gave it: get_workout marks every text it returns
 *    `{ untrusted: true, text }`. `unwrapUntrusted` turns exactly that shape back into its text before anything judges
 *    the document; the document's `source` is always the coach (`coachDoc`).
 *  - THE DAY A DOCUMENT IS CHECKED FOR (`readDocAthlete` + `docValidateCtx`) is the Studio's create path's
 *    (doc-workouts.ts `docDayContext`) in a fixed number of statements: the switched-on profiles; the day's reading —
 *    the one rule the opening context's header reads (`readingsOfDay`, through `readAthlete`), on the day itself, and
 *    none for a day ahead; the moves done cleanly (`doneCleanlyOf` over `doneStats`, the library's unlock rule); the
 *    last session and the last seven days' (doc-workouts.ts `recentOf`, over the sessions it can pick, read by id);
 *    the moves set aside; and the gear of the place the document names, else the default place — both by the one rule
 *    default-place.ts holds for every worker reader (the athlete's place, a preset, or "No equipment"; the default: the
 *    profile's choice, the place marked default, the first made, the Home preset). At most 1 + 1 + 4 statements.
 *  - A free-text move is refused (`freeTextRefusal`): no rule can judge a move with no library record. A revision may
 *    keep one its workout already holds, unchanged.
 *  - Issues go back to the model as `{ path, code, message, fix? }`, capped and counted; a refusal's line names each
 *    error's code.
 */
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { exercisePrefs, performedSessions } from "@rg/database";
import {
  addDays,
  BASED_ON_KINDS,
  EFFORT_LEVELS,
  GOAL_IDS,
  itemSchema,
  PART_FORMATS,
  PART_PURPOSES,
  RUN_EFFORTS,
  workoutDocSchema,
  type WorkoutDoc,
} from "@rg/domain";
import { EQUIPMENT_IDS, EXERCISES } from "@rg/exercise-library";
import { deriveDoc, validateWorkoutDoc, type DocDerived, type DocIssue, type ValidateCtx } from "@rg/workout";
import { defaultFromRow, defaultPlaceSql, namedFromRow, ownPlaceSql, type PlaceGear } from "../default-place.js";
import { recentOf } from "../doc-workouts.js";
import { loadSessionsById } from "../engine-inputs.js";
import { doneCleanlyOf, doneStats } from "../library-view.js";
import { PENDING_HASH } from "../watch-sets.js";
import { parsedArray, readAthlete, refuse, type Athlete } from "./read-common.js";
import type { ToolContext, ToolErr } from "./types.js";

// ── Input ───────────────────────────────────────────────────────────────────────────────────────────────────────────

function issueText(i: z.ZodIssue): string {
  if (i.code === "unrecognized_keys") return `unknown field${i.keys.length === 1 ? "" : "s"} ${i.keys.map((k) => `"${k}"`).join(", ")}`;
  return `${i.path.length ? i.path.join(".") : "input"}: ${i.message}`;
}

/** The input as the tool's schema reads it, or a teachable refusal naming the problems — an unknown field first. */
export function parseAct<S extends z.ZodTypeAny>(schema: S, input: unknown, fields: string): z.output<S> | ToolErr {
  const parsed = schema.safeParse(input ?? {});
  if (parsed.success) return parsed.data as z.output<S>;
  const issues = [...parsed.error.issues].sort((a, b) => Number(b.code === "unrecognized_keys") - Number(a.code === "unrecognized_keys"));
  return refuse("invalid_input", issues.slice(0, 4).map(issueText).join("; "), `Call it again with ${fields}.`);
}

export const isErr = (x: unknown): x is ToolErr => typeof (x as ToolErr | null)?.error === "string" && typeof (x as ToolErr).fix === "string";

/** A JSON object (what a workout document must at least be). */
export const objectField = z.custom<Record<string, unknown>>((v) => !!v && typeof v === "object" && !Array.isArray(v), "must be a workout document (an object)");

// ── Documents ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Exactly the marker a read tool puts on outside text: `{ untrusted: true, text }`, nothing else. */
const isMarker = (v: Record<string, unknown>): boolean => {
  const keys = Object.keys(v);
  return keys.length === 2 && v.untrusted === true && typeof v.text === "string";
};

/** `value` with every `{ untrusted: true, text }` replaced by its text (a document copied back from get_workout). */
export function unwrapUntrusted(value: unknown, depth = 0): unknown {
  if (depth > 16 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => unwrapUntrusted(v, depth + 1));
  const o = value as Record<string, unknown>;
  if (isMarker(o)) return o.text;
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, unwrapUntrusted(v, depth + 1)]));
}

/** The document as the coach submits it: the read tools' markers unwrapped, version 1 by default, written by the coach
 * (`source.ref` names the run, so a stored document says which design it came from). */
export function coachDoc(raw: Record<string, unknown>, mainRunId: string): Record<string, unknown> {
  const doc = unwrapUntrusted(raw) as Record<string, unknown>;
  return { ...doc, version: doc.version ?? 1, source: { kind: "coach", ref: `run:${mainRunId}` } };
}

/** The place id the document names, if it names one. */
export function docPlaceId(doc: Record<string, unknown>): string | undefined {
  const setting = doc.setting as { placeId?: unknown } | undefined;
  return setting && typeof setting === "object" && typeof setting.placeId === "string" ? setting.placeId : undefined;
}

// The document's JSON schema, for the model (the tools' `inputSchema`): the domain's own vocabularies and bounds
// (packages/domain/src/workout-doc.ts — a test holds every enum to the domain's, and walks every bound stated here
// against the zod schema). No free-text move: the coach adds library moves only (`freeTextRefusal`).
const str = (max: number, description?: string) => ({ type: "string", minLength: 1, maxLength: max, ...(description ? { description } : {}) });
const num = (min: number, max: number, integer = false) => ({ type: integer ? "integer" : "number", minimum: min, maximum: max });
const DOSE = {
  type: "object",
  description: "At least one amount: reps, holdSec, breaths, carryM, or max.",
  properties: {
    sets: num(1, 20, true),
    reps: { anyOf: [num(1, 200, true), { type: "object", properties: { min: num(1, 200, true), max: num(1, 200, true) }, required: ["min", "max"], additionalProperties: false }] },
    holdSec: num(1, 3600),
    breaths: num(1, 200, true),
    carryM: num(1, 5000),
    perSide: { type: "boolean" },
    max: { const: true, description: "To max: reps or holdSec become a floor, not a cap." },
    tempo: { type: "object", properties: { eccentricSec: num(0, 20), pauseSec: num(0, 30), concentricSec: num(0, 20) }, additionalProperties: false },
    load: { anyOf: [{ type: "object", properties: { typed: str(20, 'As the athlete writes it: "35 lb".'), kg: num(0, 500) }, required: ["typed", "kg"], additionalProperties: false }, { const: "bodyweight" }] },
    restSec: num(0, 900),
  },
  additionalProperties: false,
} as const;
const RUN_TARGET = {
  type: "object",
  description: "A duration, a distance, or open.",
  properties: {
    durationSec: num(1, 86400),
    distanceM: num(1, 500000),
    typed: { type: "string", maxLength: 20 },
    open: { const: true },
    pace: { type: "object", properties: { fastSecPerKm: num(120, 1800), slowSecPerKm: num(120, 1800) }, required: ["fastSecPerKm", "slowSecPerKm"], additionalProperties: false },
    hr: { type: "object", properties: { low: num(30, 230, true), high: num(30, 230, true) }, required: ["low", "high"], additionalProperties: false },
    zone: { type: "object", properties: { kind: { enum: ["pace", "hr"] }, index: num(1, 6, true) }, required: ["kind", "index"], additionalProperties: false },
  },
  additionalProperties: false,
} as const;
const ITEM = {
  anyOf: [
    {
      type: "object",
      properties: {
        kind: { const: "exercise" },
        libraryId: str(80, "A library id from search_library."),
        dose: DOSE,
        side: { enum: ["left", "right"] },
        why: { type: "string", maxLength: 160 },
        progression: { type: "string", maxLength: 120 },
        cue: { type: "string", maxLength: 160 },
        alternates: {
          type: "array",
          maxItems: 3,
          items: { type: "object", properties: { libraryId: str(80), why: { type: "string", maxLength: 120 } }, required: ["libraryId"], additionalProperties: false },
        },
        test: { type: "object", properties: { keyResultId: str(80) }, additionalProperties: false },
      },
      required: ["kind", "libraryId", "dose"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { kind: { const: "run" }, target: RUN_TARGET, effort: { enum: [...RUN_EFFORTS] }, why: { type: "string", maxLength: 160 }, cue: { type: "string", maxLength: 160 } },
      required: ["kind", "target", "effort"],
      additionalProperties: false,
    },
    { type: "object", properties: { kind: { const: "rest" }, seconds: num(1, 3600) }, required: ["kind", "seconds"], additionalProperties: false },
  ],
} as const;

/** A workout document as the tools take it (`source` is the tool's to set). */
export const WORKOUT_DOC_JSON_SCHEMA = {
  type: "object",
  description: "A workout document, version 1. Its source is set to the coach by the tool.",
  properties: {
    version: { const: 1 },
    title: str(80),
    intent: {
      type: "object",
      properties: {
        summary: str(200, "One sentence: what this workout is for today."),
        goals: { type: "array", maxItems: 6, items: { enum: [...GOAL_IDS] } },
        focus: { type: "array", maxItems: 12, items: str(40, "A region or muscle id.") },
        effort: { enum: [...EFFORT_LEVELS] },
        objectiveIds: { type: "array", maxItems: 10, items: str(80) },
      },
      required: ["summary", "goals", "focus", "effort"],
      additionalProperties: false,
    },
    setting: {
      type: "object",
      properties: {
        placeId: str(80, 'A place id from read_profile (its gear is checked), or "none" for no equipment; left out: the default place.'),
        equipment: { type: "array", maxItems: 20, items: { enum: [...EQUIPMENT_IDS] } },
        targetMinutes: num(1, 600),
      },
      additionalProperties: false,
    },
    parts: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        properties: {
          purpose: { enum: [...PART_PURPOSES] },
          why: { type: "string", maxLength: 160 },
          format: { enum: [...PART_FORMATS] },
          rounds: num(1, 50, true),
          restBetweenRoundsSec: num(0, 900),
          items: { type: "array", minItems: 1, maxItems: 60, items: ITEM },
        },
        required: ["purpose", "format", "items"],
        additionalProperties: false,
      },
    },
    basedOn: { type: "object", properties: { kind: { enum: [...BASED_ON_KINDS] }, id: str(80), rev: { type: "integer", minimum: 0 } }, required: ["kind", "id"], additionalProperties: false },
    notes: { type: "string", maxLength: 500 },
  },
  required: ["title", "intent", "parts"],
  additionalProperties: false,
} as const;

// ── The day ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The gear a document is checked against (default-place.ts), and whether it was the default place. */
export interface DocPlace {
  id: string;
  equipment: string[];
  default: boolean;
  /** One of the athlete's places, a library preset, or "No equipment". */
  kind: PlaceGear["kind"];
}

export interface DocAthlete {
  athlete: Athlete;
  extra: Record<string, unknown>;
  place: DocPlace;
  setAside: string[];
  /** Sessions that hold the last one and the last seven days' (by id; at most RECENT_IDS_MAX). */
  recentIds: string[];
}

/** Enough for a week of sessions and the last before it, under one chunk of `loadSessionsById` (90). */
const RECENT_IDS_MAX = 60;

/**
 * The sessions `recentOf` can pick, by id, for any timezone's today (the UTC day either side holds it): those dated in
 * the last eight days through tomorrow, and every one on the latest date before yesterday — so the last session on or
 * before the athlete's today is among them, wherever it falls.
 */
function recentSql(userId: string, now: Date): SQL {
  const p = performedSessions;
  const utcDay = now.toISOString().slice(0, 10);
  const mine = sql`${p.userId} = ${userId} and ${p.payloadHash} != ${PENDING_HASH}`;
  return sql`(select json_group_array(id) from (
    select ${p.id} as id from ${p} where ${mine} and ${p.localDate} between ${addDays(utcDay, -8)} and ${addDays(utcDay, 1)}
    union
    select ${p.id} from ${p} where ${mine} and ${p.localDate} = (select max(${p.localDate}) from ${p} where ${mine} and ${p.localDate} <= ${addDays(utcDay, -1)})
    limit ${RECENT_IDS_MAX}))`;
}

/**
 * The athlete a document is judged for, in ONE statement: `readAthlete` (preferences, profiles, today's reading) with
 * the moves set aside, the place's gear (default-place.ts: the place the document names, else the default place), the
 * recent sessions' ids, and the caller's own `extras`. A place the document names that is no place is refused.
 */
export async function readDocAthlete(ctx: ToolContext, o: { placeId?: string; extras?: Record<string, SQL> }): Promise<DocAthlete | ToolErr> {
  const { athlete, extra } = await readAthlete(ctx.db, ctx.userId, ctx.now, {
    actSetAside: sql`(select json_group_array(${exercisePrefs.exerciseId}) from ${exercisePrefs} where ${exercisePrefs.userId} = ${ctx.userId} and ${exercisePrefs.excluded} = 1)`,
    actPlace: o.placeId ? ownPlaceSql(ctx.userId, o.placeId) : defaultPlaceSql(ctx.userId),
    actRecent: recentSql(ctx.userId, ctx.now),
    ...o.extras,
  });
  let place: DocPlace;
  if (o.placeId) {
    const named = namedFromRow(o.placeId, extra.actPlace);
    if (!named) {
      return refuse(
        "unknown_place",
        `setting.placeId ${JSON.stringify(o.placeId)} is not one of the athlete's places.`,
        'Use a place id from read_profile (or home, gym, mat, or "none" for no equipment), or leave placeId out to use the default place.',
      );
    }
    place = { id: named.id, equipment: named.equipment, default: false, kind: named.kind };
  } else {
    const d = defaultFromRow(extra.actPlace);
    place = { id: d.id, equipment: d.equipment, default: true, kind: d.kind };
  }
  return {
    athlete,
    extra,
    place,
    setAside: parsedArray(extra.actSetAside).filter((x): x is string => typeof x === "string"),
    recentIds: parsedArray(extra.actRecent).filter((x): x is string => typeof x === "string"),
  };
}

/**
 * The validator's context for `date` (see the module comment): what docDayContext gives the create path, the day's
 * reading excepted — this one is the opening context's. At most five statements: doneStats, then the recent sessions
 * (`loadSessionsById`: four, one chunk).
 */
export async function docValidateCtx(ctx: ToolContext, a: DocAthlete, date: string): Promise<ValidateCtx> {
  const today = a.athlete.today;
  const stats = await doneStats(ctx.db, ctx.userId, addDays(today, -29), today);
  const done = doneCleanlyOf(stats, a.athlete.profiles, stats.keys());
  const sessions = a.recentIds.length > 0 ? await loadSessionsById(ctx.db, ctx.userId, a.recentIds) : [];
  const readings =
    date === today
      ? Object.fromEntries(Object.entries(a.athlete.readings).map(([id, r]) => [id, { pre: r.pre, post: null, feelingOff: r.feelingOff }]))
      : {};
  return {
    library: EXERCISES,
    activeProfiles: a.athlete.profiles,
    day: { date, today, readings, done, recent: recentOf(sessions, today) },
    excluded: a.setAside,
    equipment: a.place.equipment,
  };
}

/** What could not be read of the day, in plain words. */
export function dayMissing(a: DocAthlete, date: string): string[] {
  const out: string[] = [];
  if (date === a.athlete.today) {
    for (const p of a.athlete.profiles) {
      if (!a.athlete.readings[p.id]?.at) out.push(`no ${p.label} check today: a rule that needs an answered check stays closed`);
    }
  } else if (a.athlete.profiles.length > 0) {
    out.push(`${date} is ahead: its check isn't known, so a move a check could close needs an alternate that passes in recovery`);
  }
  if (a.place.default && a.place.kind === "preset") out.push("no place set up: gear checked against the library's Home preset");
  return out;
}

// ── Free-text moves ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Keys sorted at every level: two items are the same item when this text is. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** Each free-text move of a document (its own name, no library record), as the schema reads it. */
function freeMoves(doc: unknown): Array<{ path: string; name: string; key: string }> {
  const parts = (doc as { parts?: unknown } | null)?.parts;
  if (!Array.isArray(parts)) return [];
  const out: Array<{ path: string; name: string; key: string }> = [];
  parts.forEach((part, p) => {
    const items = (part as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) return;
    items.forEach((item, i) => {
      if ((item as { kind?: unknown } | null)?.kind !== "free_exercise") return;
      const parsed = itemSchema.safeParse(item);
      const name = typeof (item as { name?: unknown }).name === "string" ? (item as { name: string }).name : "";
      out.push({ path: `parts[${p}].items[${i}]`, name, key: canonical(parsed.success ? parsed.data : item) });
    });
  });
  return out;
}

/**
 * A free-text move has no library record, so no condition rule, gate or gear check can judge it (`validateWorkoutDoc`
 * never reads one): the coach never adds one. The one exception is a revision that keeps a free-text move its base
 * document already holds, exactly as it is (`base`, the workout's current document). A refusal names every other one.
 */
export function freeTextRefusal(doc: unknown, base: WorkoutDoc | null): ToolErr | null {
  // Counted, not a set: a draft keeps each of the base's free-text moves as often as the base holds it, never more.
  const kept = new Map<string, number>();
  for (const m of freeMoves(base)) kept.set(m.key, (kept.get(m.key) ?? 0) + 1);
  const added = freeMoves(doc).filter((m) => {
    const left = kept.get(m.key) ?? 0;
    if (left === 0) return true;
    kept.set(m.key, left - 1);
    return false;
  });
  if (added.length === 0) return null;
  return refuse(
    "free_text_move",
    `${added.map((m) => `${m.path} (${JSON.stringify(m.name)})`).join(", ")} ${added.length === 1 ? "is a free-text move" : "are free-text moves"}: no condition rule or gear check can judge a move that isn't in the library.`,
    'Find the move with search_library and put it in as { kind: "exercise", libraryId }. A revision may keep a free-text move its workout already has, unchanged.',
  );
}

// ── Judging ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Judged {
  /** The document as the schema reads it; null when it doesn't. */
  doc: WorkoutDoc | null;
  errors: DocIssue[];
  warnings: DocIssue[];
  derived: DocDerived | null;
}

/** The validator's verdict, and what is derived from the document when it can be built. */
export function judge(raw: unknown, vctx: ValidateCtx): Judged {
  const issues = validateWorkoutDoc(raw, vctx);
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const parsed = workoutDocSchema.safeParse(raw);
  const buildable = parsed.success && !errors.some((e) => e.code === "bounds" || e.code === "too_large");
  return { doc: parsed.success ? parsed.data : null, errors, warnings, derived: buildable ? deriveDoc(parsed.data!, EXERCISES) : null };
}

export const ERRORS_SHOWN = 20;
export const WARNINGS_SHOWN = 15;

/** One issue as the model reads it. */
export const issueOut = (i: DocIssue) => ({ path: i.path, code: i.code, message: i.message, ...(i.fix !== undefined ? { fix: i.fix } : {}) });

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** What the proposal card and the reviewer read of a document: its length, discipline, category, mode, the balance it
 * adds, its top regions, its gear and its watch steps. */
export function derivedSummary(d: DocDerived): Record<string, unknown> {
  const balance = Object.fromEntries(Object.entries(d.balance).filter(([, v]) => v > 0).map(([k, v]) => [k, round1(v)]));
  const regions = Object.fromEntries(
    Object.entries(d.regionExposure)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 6)
      .map(([k, v]) => [k, round1(v)]),
  );
  return {
    minutes: d.estimatedMinutes,
    discipline: d.discipline,
    category: d.category,
    mode: d.mode,
    balance,
    regions,
    equipment: d.equipment,
    watchSteps: d.watchStepCount,
  };
}

/** The validator's errors, as one teachable line (the first few, then how many more). */
export function errorsLine(errors: readonly DocIssue[], shown = 6): string {
  const head = errors.slice(0, shown).map((e) => `${e.path} (${e.code}): ${e.message}${e.fix !== undefined ? ` (fix: ${e.fix})` : ""}`);
  return `${head.join("; ")}${errors.length > shown ? `; and ${errors.length - shown} more` : ""}`;
}

// ── Runs ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The main run a run belongs to: itself, or (a designer) the run that started it. */
export function mainRunIdOf(ctx: ToolContext): string | null {
  return ctx.run.role === "main" ? ctx.run.id : ctx.run.parentId;
}
