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
 *  - A run (designed runs, §8 §3) is judged as a run, with the athlete's running read in the athlete's statement
 *    (`runCtxExtra` → the validator's `ctx.run`). Refused only as a revision of a Studio or template workout
 *    (`runUnsupported`), by validate_workout and propose_workout alike: a new run is proposed as any workout is.
 *  - The ids a document names beyond the library — `intent.objectiveIds`, an item's `test.keyResultId` — must be the
 *    athlete's own (`idsRefusal`, fatal: an invented id would attach the workout to nothing), read in the statement
 *    the tools already run. A focus-area id in `intent.focus` stands for its library refs (`withFocusRefs`), so the
 *    document keeps the library's ids and the validator's focus check reads them.
 *  - Issues go back to the model as `{ path, code, message, fix? }`, capped and counted; a refusal's line names each
 *    error's code. Some fixes are the tool layer's (`judge`): an unknown move's points at search_library, and a gated
 *    move's stand-in — today's or a day ahead's — is offered only from its own family, none when nothing of it passes;
 *    today, with no check answered, the main coach may ask for one. So is one advisory note: a test whose move its key
 *    result's measure doesn't read (`test_unmeasured`, the measures read in the athlete's statement).
 */
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { athleteProfiles, exercisePrefs, keyResults, objectives, performedSessions } from "@rg/database";
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
  keyResultMeasureSchema,
  type KeyResultMeasure,
  type WorkoutDoc,
} from "@rg/domain";
import { EQUIPMENT_IDS, EXERCISES, LOCATION_PRESETS, MUSCLES, NO_EQUIPMENT_GEAR, REGIONS, type ExerciseRecord } from "@rg/exercise-library";
import { deriveDoc, validateWorkoutDoc, type DocDerived, type DocIssue, type ValidateCtx } from "@rg/workout";
import { defaultFromRow, defaultPlaceSql, namedFromRow, ownPlaceSql, type PlaceGear } from "../default-place.js";
import { recentOf } from "../doc-workouts.js";
import { runCtxOf, runCtxSql } from "../designed-runs.js";
import { loadSessionsById } from "../engine-inputs.js";
import { doneCleanlyOf, doneStats } from "../library-view.js";
import { PENDING_HASH } from "../watch-sets.js";
import { parsedArray, readAthlete, refuse, type Athlete } from "./read-common.js";
import { measureWords } from "./read-objectives.js";
import type { ToolContext, ToolErr } from "./types.js";

// ── Input ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * SOFT CAPS FOR FREE TEXT (Task 13's fix wave, §2.1; audit 13b, I1). A model can't count characters: the live suite's 39
 * refused calls were nearly all a line a little over its cap. A free-text field is accepted whole up to PROSE_CEILING
 * times its cap — what the athlete reads is clipped to the cap where it is stored (design-prose.ts `clipProse`), what
 * only a model reads is kept whole — and refused only past that, saying its length and the cap in words. Each schema
 * description states its cap in words (`capInWords`).
 */
export const PROSE_CEILING = 4;

/** About how many words a cap of `chars` characters holds (a word and its space: about 6.5 characters). */
export const capWords = (chars: number): number => Math.max(5, Math.round(chars / 6.5 / 5) * 5);

/** "at most about 45 words (300 characters)": a cap as a schema's description says it. */
export const capInWords = (chars: number): string => `at most about ${capWords(chars)} words (${chars} characters)`;

const thousands = (n: number): string => n.toLocaleString("en-US");

/** "summary is 1,410 characters; at most 300 — about 45 words": a text past its ceiling, in a refusal's words. */
export const proseTooLong = (field: string, length: number, cap: number): string =>
  `${field} is ${thousands(length)} characters; at most ${thousands(cap)} — about ${capWords(cap)} words`;

/** A free-text field: trimmed and not empty, accepted whole up to `ceiling` × `cap` (PROSE_CEILING; 1 for a text that is
 * never cut, a question's own words), refused past it in words. */
export const prose = (cap: number, ceiling = PROSE_CEILING) =>
  z
    .string()
    .trim()
    .min(1)
    .superRefine((text, c) => {
      if (text.length > cap * ceiling) c.addIssue({ code: z.ZodIssueCode.custom, message: "too long", params: { prose: { length: text.length, cap } } });
    });

function issueText(i: z.ZodIssue): string {
  if (i.code === "unrecognized_keys") return `unknown field${i.keys.length === 1 ? "" : "s"} ${i.keys.map((k) => `"${k}"`).join(", ")}`;
  const path = i.path.length ? i.path.join(".") : "input";
  const long = i.code === "custom" ? (i.params as { prose?: { length: number; cap: number } } | undefined)?.prose : undefined;
  if (long) return proseTooLong(path, long.length, long.cap);
  return `${path}: ${i.message}`;
}

/** The input as the tool's schema reads it, or a teachable refusal naming the problems — an unknown field first; a text
 * past its ceiling says its length and its cap in words, and the fix says to shorten it. */
export function parseAct<S extends z.ZodTypeAny>(schema: S, input: unknown, fields: string): z.output<S> | ToolErr {
  const parsed = schema.safeParse(input ?? {});
  if (parsed.success) return parsed.data as z.output<S>;
  const issues = [...parsed.error.issues].sort((a, b) => Number(b.code === "unrecognized_keys") - Number(a.code === "unrecognized_keys"));
  const long = issues.some((i) => i.code === "custom" && (i.params as { prose?: unknown } | undefined)?.prose);
  return refuse("invalid_input", issues.slice(0, 4).map(issueText).join("; "), `Call it again with ${fields}${long ? " — each text within its cap: say it in fewer words" : ""}.`);
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
    max: { const: true, description: "To max: reps or holdSec become a floor, not a cap — what a test needs." },
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
        test: {
          type: "object",
          description: "A test of a key result: this move to max (dose.max). It counts as evidence once done and logged.",
          properties: { keyResultId: str(80, "The key result it measures (read_objectives).") },
          additionalProperties: false,
        },
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

/** The library's place presets and a bare room, in words (the place filter of search_library says the same). */
const PRESET_WORDS = `${LOCATION_PRESETS.map((p) => p.id).slice(0, -1).join(", ")} or ${LOCATION_PRESETS.at(-1)!.id}`;
export const PLACE_WORDS = `a preset — ${PRESET_WORDS} — or "none": a bare room — ${NO_EQUIPMENT_GEAR.join(", ")}, nothing brought`;

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
        focus: { type: "array", maxItems: 12, items: str(40, "A region or muscle id, or one of the athlete's focus-area ids (it stands for its refs).") },
        effort: { enum: [...EFFORT_LEVELS] },
        objectiveIds: { type: "array", maxItems: 10, items: str(80, "An id of the athlete's objectives.") },
      },
      required: ["summary", "goals", "focus", "effort"],
      additionalProperties: false,
    },
    setting: {
      type: "object",
      properties: {
        placeId: str(80, `Where it is done, whose gear is checked: a place id from read_profile, ${PLACE_WORDS}. Left out: the default place.`),
        equipment: {
          type: "array",
          maxItems: 20,
          description: "The gear this workout uses. placeId decides what is available: listing gear here adds none.",
          items: { enum: [...EQUIPMENT_IDS] },
        },
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
    basedOn: {
      type: "object",
      properties: {
        kind: { enum: [...BASED_ON_KINDS] },
        id: str(80),
        rev: { type: "integer", minimum: 0 },
        // A suggestion's op (kind proposal), as get_workout reads one back by { proposalId, opId } (Task 13's fix wave).
        opId: str(120, "A suggestion's op, with kind proposal: the opId get_workout or read_proposals gives."),
      },
      required: ["kind", "id"],
      additionalProperties: false,
    },
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
  /** The athlete's focus areas: id → the library regions and muscles it means. */
  focusAreas: Map<string, string[]>;
  /** The ids a document may serve or test: the athlete's objectives (not dropped) and their key results. */
  objectiveIds: Set<string>;
  keyResultIds: Set<string>;
  /** Each of those key results' measure by id (null when the stored one no longer reads): what a test must move. */
  keyResultMeasures: Map<string, KeyResultMeasure | null>;
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
 * recent sessions' ids, the focus areas, the objectives' and key results' ids, and the caller's own `extras`. A place
 * the document names that is no place is refused.
 */
export async function readDocAthlete(ctx: ToolContext, o: { placeId?: string; extras?: Record<string, SQL> }): Promise<DocAthlete | ToolErr> {
  const live = sql`(select ${objectives.id} from ${objectives} where ${objectives.userId} = ${ctx.userId} and ${objectives.status} != 'dropped')`;
  const { athlete, extra } = await readAthlete(ctx.db, ctx.userId, ctx.now, {
    actSetAside: sql`(select json_group_array(${exercisePrefs.exerciseId}) from ${exercisePrefs} where ${exercisePrefs.userId} = ${ctx.userId} and ${exercisePrefs.excluded} = 1)`,
    actPlace: o.placeId ? ownPlaceSql(ctx.userId, o.placeId) : defaultPlaceSql(ctx.userId),
    actRecent: recentSql(ctx.userId, ctx.now),
    actFocus: sql`(select ${athleteProfiles.focusAreas} from ${athleteProfiles} where ${athleteProfiles.userId} = ${ctx.userId})`,
    actObjectives: sql`(select json_group_array(id) from ${live})`,
    actKeyResults: sql`(select json_group_array(json_object('id', ${keyResults.id}, 'measure', case when json_valid(${keyResults.measure}) then json(${keyResults.measure}) end))
      from ${keyResults} where ${keyResults.userId} = ${ctx.userId} and ${keyResults.objectiveId} in ${live})`,
    ...o.extras,
  });
  let place: DocPlace;
  if (o.placeId) {
    const named = namedFromRow(o.placeId, extra.actPlace);
    if (!named) {
      return refuse(
        "unknown_place",
        `setting.placeId ${JSON.stringify(o.placeId)} is not one of the athlete's places.`,
        `Use a place id from read_profile, or ${PLACE_WORDS}; or leave placeId out to use the default place.`,
      );
    }
    place = { id: named.id, equipment: named.equipment, default: false, kind: named.kind };
  } else {
    const d = defaultFromRow(extra.actPlace);
    place = { id: d.id, equipment: d.equipment, default: true, kind: d.kind };
  }
  const ids = (raw: unknown): Set<string> => new Set(parsedArray(raw).filter((x): x is string => typeof x === "string"));
  const krs = parsedArray(extra.actKeyResults).flatMap((x) => {
    const k = x as { id?: unknown; measure?: unknown } | null;
    return typeof k?.id === "string" ? [{ id: k.id, measure: k.measure }] : [];
  });
  const focusAreas = new Map(
    parsedArray(extra.actFocus).flatMap((f) => {
      const x = f as { id?: unknown; refs?: unknown } | null;
      return typeof x?.id === "string" && Array.isArray(x.refs) ? [[x.id, x.refs.filter((r): r is string => typeof r === "string")] as const] : [];
    }),
  );
  return {
    athlete,
    extra,
    place,
    setAside: parsedArray(extra.actSetAside).filter((x): x is string => typeof x === "string"),
    recentIds: parsedArray(extra.actRecent).filter((x): x is string => typeof x === "string"),
    focusAreas,
    objectiveIds: ids(extra.actObjectives),
    keyResultIds: new Set(krs.map((k) => k.id)),
    keyResultMeasures: new Map(
      krs.map((k) => {
        const m = keyResultMeasureSchema.safeParse(k.measure);
        return [k.id, m.success ? m.data : null] as const;
      }),
    ),
  };
}

// ── What a document names beyond the library ────────────────────────────────────────────────────────────────────────

const LIBRARY_AREAS = new Set<string>([...REGIONS, ...MUSCLES]);
/** The most focus ids a document holds (the schema's bound). */
const FOCUS_MAX = 12;

/**
 * The document with each focus-area id in `intent.focus` replaced by its refs (the library's regions and muscles), in
 * order, each once — a library id stays as it is, and anything else is left for the validator to name. The document
 * keeps the library's ids, which the Studio and the suggestions read.
 */
export function withFocusRefs(doc: Record<string, unknown>, focusAreas: ReadonlyMap<string, readonly string[]>): Record<string, unknown> {
  const intent = doc.intent as { focus?: unknown } | null | undefined;
  if (!intent || typeof intent !== "object" || !Array.isArray(intent.focus)) return doc;
  const focus = intent.focus as unknown[];
  if (!focus.some((f) => typeof f === "string" && !LIBRARY_AREAS.has(f) && focusAreas.has(f))) return doc;
  const out: unknown[] = [];
  for (const f of focus) {
    const refs = typeof f === "string" && !LIBRARY_AREAS.has(f) ? focusAreas.get(f) : undefined;
    for (const x of refs ?? [f]) if (!out.includes(x)) out.push(x);
  }
  return { ...doc, intent: { ...intent, focus: out.slice(0, FOCUS_MAX) } };
}

/**
 * An objective or key result id the athlete doesn't have — refused (fatal only when wrong: an invented id attaches the
 * workout to nothing, and the card would name it). Every one is named at once; null when all are theirs.
 */
export function idsRefusal(doc: Record<string, unknown>, a: Pick<DocAthlete, "objectiveIds" | "keyResultIds">): ToolErr | null {
  const bad: string[] = [];
  const intent = doc.intent as { objectiveIds?: unknown } | null | undefined;
  if (intent && Array.isArray(intent.objectiveIds)) {
    intent.objectiveIds.forEach((id, i) => {
      if (typeof id === "string" && !a.objectiveIds.has(id)) bad.push(`intent.objectiveIds[${i}] ${JSON.stringify(id)} is none of the athlete's objectives`);
    });
  }
  const parts = Array.isArray(doc.parts) ? (doc.parts as unknown[]) : [];
  parts.forEach((part, p) => {
    const items = (part as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) return;
    items.forEach((item, i) => {
      const id = (item as { test?: { keyResultId?: unknown } } | null)?.test?.keyResultId;
      if (typeof id === "string" && !a.keyResultIds.has(id)) bad.push(`parts[${p}].items[${i}].test.keyResultId ${JSON.stringify(id)} is none of the athlete's key results`);
    });
  });
  if (bad.length === 0) return null;
  return refuse(
    "unknown_objective",
    `${bad.slice(0, 6).join("; ")}${bad.length > 6 ? `; and ${bad.length - 6} more` : ""}.`,
    "Use an objective id from the profile, or a key result id from read_objectives — or leave it out.",
  );
}

/**
 * A run as a revision (designed runs, §8 §3): a Studio or template workout is played in the app, a run goes to the watch,
 * so one never becomes the other (validate_workout and propose_workout). A new run is proposed as any workout is.
 */
export function runUnsupported(): ToolErr {
  return refuse(
    "run_unsupported",
    "A run can't replace a Studio or template workout: the one is played in the app, the run goes to the watch.",
    "Propose the run as a new workout (target new); if the old one goes, take it off with adjust_plan in the same suggestion.",
  );
}

/** Whether a submitted document holds a run segment (read before it is parsed: the run's context is read with it). */
export function holdsRun(doc: Record<string, unknown>): boolean {
  const parts = Array.isArray(doc.parts) ? (doc.parts as unknown[]) : [];
  return parts.some((part) => {
    const items = (part as { items?: unknown } | null)?.items;
    return Array.isArray(items) && items.some((i) => (i as { kind?: unknown } | null)?.kind === "run");
  });
}

/** The athlete's running for a run on `date`, read in the athlete's statement (`readDocAthlete`'s extras): `actRun`. */
export const runCtxExtra = (ctx: ToolContext, date: string): Record<string, SQL> => ({ actRun: runCtxSql(ctx.userId, date) });

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
    // A run's: the athlete's running, read with the athlete (`runCtxExtra`) — designed runs, §8 §3.
    ...(a.extra.actRun !== undefined ? { run: runCtxOf(a.extra.actRun) } : {}),
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

/** An issue as the coach's tools raise it: the validator's (`DocIssue`), or the tool layer's own advisory — a test whose
 * move its key result's measure doesn't read (`test_unmeasured`: fix wave 3A round 2, B-M10). */
export type CoachIssue = Omit<DocIssue, "code"> & { code: DocIssue["code"] | "test_unmeasured" };

export interface Judged {
  /** The document as the schema reads it; null when it doesn't. */
  doc: WorkoutDoc | null;
  errors: CoachIssue[];
  warnings: CoachIssue[];
  derived: DocDerived | null;
}

/** What the coach's refusal of a move today's check closes adds when no check is logged today (fix wave 3A round 2,
 * B-M8): a logged check may open it, and the main coach is the one who asks. */
export const ASK_FOR_CHECK = 'if no check is logged today, the main coach may ask_athlete({ check: "condition", why })';

/** Today, with an active profile whose check isn't answered yet (the validator's own rule: a value, or feeling off): a
 * gate that reads it may open once it is. */
export function noCheckToday(vctx: ValidateCtx): boolean {
  const d = vctx.day;
  if (!d || d.date !== d.today) return false;
  return vctx.activeProfiles.some((p) => {
    const r = d.readings[p.id];
    return !r || (r.pre == null && !r.feelingOff && !d.feelingOff);
  });
}

/**
 * The validator's verdict, and what is derived from the document when it can be built — with the tool layer's own fixes
 * (`coachFix`) and, given the athlete's key results (`keyResults`: each one's measure by id, read with the athlete), its
 * own advisory notes (`testNotes`).
 */
export function judge(raw: unknown, vctx: ValidateCtx, o: { keyResults?: ReadonlyMap<string, KeyResultMeasure | null> } = {}): Judged {
  const noCheck = noCheckToday(vctx);
  const issues: CoachIssue[] = [...validateWorkoutDoc(raw, vctx).map((i) => coachFix(i, raw, noCheck)), ...testNotes(raw, o.keyResults)];
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const parsed = workoutDocSchema.safeParse(raw);
  const buildable = parsed.success && !errors.some((e) => e.code === "bounds" || e.code === "too_large");
  return { doc: parsed.success ? parsed.data : null, errors, warnings, derived: buildable ? deriveDoc(parsed.data!, EXERCISES) : null };
}

/**
 * A scheduled test (`test.keyResultId`) whose move isn't one its key result's measure reads — done to max and logged, it
 * would never count toward that key result (fix wave 3A round 2, B-M10): an advisory note on the move, with the move
 * the measure reads as its fix when it reads one. A key result the athlete doesn't have is `idsRefusal`'s; one whose
 * stored measure no longer reads has nothing to compare with.
 */
function testNotes(raw: unknown, keyResults: ReadonlyMap<string, KeyResultMeasure | null> | undefined): CoachIssue[] {
  if (!keyResults || keyResults.size === 0) return [];
  const out: CoachIssue[] = [];
  const parts = Array.isArray((raw as { parts?: unknown } | null)?.parts) ? ((raw as { parts: unknown[] }).parts) : [];
  parts.forEach((part, p) => {
    const items = (part as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) return;
    items.forEach((item, i) => {
      const x = item as { libraryId?: unknown; test?: { keyResultId?: unknown } } | null;
      const id = x?.test?.keyResultId;
      const measure = typeof id === "string" ? keyResults.get(id) : undefined;
      if (!measure) return;
      const own = typeof x?.libraryId === "string" ? RECORD_BY_ID.get(x.libraryId) : undefined;
      const reads = "libraryIds" in measure ? measure.libraryIds.map((l) => RECORD_BY_ID.get(l)?.id ?? l) : [];
      if (own && reads.includes(own.id)) return;
      out.push({
        path: own ? `parts[${p}].items[${i}].libraryId` : `parts[${p}].items[${i}].test.keyResultId`,
        code: "test_unmeasured",
        message: `${own?.name ?? "This move"} isn't a move its key result's measure reads (${measureWords(measure)}): done to max and logged, it won't count toward it.`,
        ...(reads.length > 0 ? { fix: reads[0] } : {}),
        severity: "warning",
      });
    });
  });
  return out;
}

/** A library record by its id or one of its old ids. */
const RECORD_BY_ID = new Map<string, ExerciseRecord>(EXERCISES.flatMap((e) => [[e.id, e] as const, ...e.legacyIds.map((l) => [l, e] as const)]));
const ITEM_ID_PATH = /^parts\[(\d+)\]\.items\[(\d+)\]\.libraryId$/;

/** The library id of the item at a `parts[p].items[i].libraryId` path, if there is one. */
function itemIdAt(raw: unknown, path: string): string | undefined {
  const m = ITEM_ID_PATH.exec(path);
  if (!m) return undefined;
  const item = ((raw as { parts?: Array<{ items?: unknown[] }> } | null)?.parts?.[Number(m[1])]?.items ?? [])[Number(m[2])] as { libraryId?: unknown } | undefined;
  return typeof item?.libraryId === "string" ? item.libraryId : undefined;
}

/**
 * The fixes the coach reads differently from the Studio (spec §4; audit M6; fix wave 3A round 2, B-M7 and B-M8):
 *  - an unknown move's fix points at search_library — after the validator's near guess, when it has one;
 *  - a gated move's stand-in — today's check closing it (`condition_gate`, `condition_pattern`), or a day ahead's (the
 *    error `condition_gate_pending`: no alternate of the designer's passes on a recovery day) — is offered only from the
 *    move's own family (`family`, the library's pattern family; a move with none has no family to keep). One from
 *    another family (a box squat for pogo hops) is another quality, so none is offered, and the message says how to
 *    choose; today, with no check logged, it adds that the main coach may ask for one (`ASK_FOR_CHECK`).
 */
function coachFix(i: DocIssue, raw: unknown, noCheck: boolean): DocIssue {
  if (i.code === "unknown_exercise") {
    const search = "find the move with search_library and use an id it shows";
    return { ...i, fix: i.fix !== undefined ? `"${i.fix}", or ${search}` : `${search[0]!.toUpperCase()}${search.slice(1)}` };
  }
  const today = i.code === "condition_gate" || i.code === "condition_pattern";
  if (today || (i.code === "condition_gate_pending" && i.severity === "error")) {
    const own = RECORD_BY_ID.get(itemIdAt(raw, i.path) ?? "");
    const offered = i.fix !== undefined ? RECORD_BY_ID.get(i.fix) : undefined;
    const ask = today && noCheck ? ASK_FOR_CHECK : null;
    if (offered && own && own.family && offered.family === own.family) return ask ? { ...i, message: `${i.message} Or, ${ask}.` } : i;
    const { fix: _f, ...rest } = i;
    const choose = today ? "choose one yourself with search_library" : "choose an alternate yourself with search_library, or keep the move for a day whose check is known";
    return { ...rest, message: `${i.message} No stand-in of its own family is offered: ${choose}${ask ? `, or, ${ask}` : ""}.` };
  }
  return i;
}

export const ERRORS_SHOWN = 20;
export const WARNINGS_SHOWN = 15;

/** One issue as the model reads it. */
export const issueOut = (i: CoachIssue) => ({ path: i.path, code: i.code, message: i.message, ...(i.fix !== undefined ? { fix: i.fix } : {}) });

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
export function errorsLine(errors: readonly CoachIssue[], shown = 6): string {
  const head = errors.slice(0, shown).map((e) => `${e.path} (${e.code}): ${e.message}${e.fix !== undefined ? ` (fix: ${e.fix})` : ""}`);
  return `${head.join("; ")}${errors.length > shown ? `; and ${errors.length - shown} more` : ""}`;
}

// ── Runs ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The main run a run belongs to: itself, or (a designer) the run that started it. */
export function mainRunIdOf(ctx: ToolContext): string | null {
  return ctx.run.role === "main" ? ctx.run.id : ctx.run.parentId;
}
