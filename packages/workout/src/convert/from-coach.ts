/**
 * A coach session (`CoachSession`: run / lift / mobility) → the workout document (programme spec §3.3, Amendment A).
 *
 * RULES
 * - A rest day carries no document (null): the document holds a workout, and a rest day is the absence of one.
 * - Run blocks → run items with their efforts as given (easy, steady, threshold, interval; none → by feel). A timed
 *   "rest" block (the coach's walk / stand) is a rest item; a distance one a recovery segment (kept). The block roles
 *   are the wire's own (`runBlockRoles`, imported from @rg/coros): a block's declared role, else an easy block
 *   opening a session with harder work (steady, threshold or interval) is the warm-up part, an easy block closing one
 *   the cool-down part; work and recovery are the run part (intervals when it holds a rest or more than one hard
 *   block, else steady). No blocks → one run segment of the session's length at the category's effort.
 * - Lift → a main part, straight (circuit with `rounds`); mobility → a main part, flow (with `rounds` when given).
 *   No exercises → an open block of the session's length.
 * - An exercise: its name through `resolveName` → a library item; else a free-text item. sets, reps, holdSeconds →
 *   holdSec, perSide, eccentricSeconds → tempo, restSeconds → restSec, note → cue. The catalog id (`originId`) is
 *   kept: the document names moves by the library. Given the library (`meta.library`), a legacy id is the move's id
 *   now, and an id the library no longer has is a free-text item by the coach's name, the id kept.
 * - Load (Review Focus 3): with the coach's own words (`meta.raw`, the session as the model wrote it) a typed load
 *   stays as typed — "25 lb" → { typed: "25 lb", kg: 11.34 }, "2×20kg" → { typed: "2×20kg", kg: 20 }, a bare number
 *   is kilos — and a word that is no load ("heavy") is kept with no load; absent or null is bodyweight. Without them,
 *   the stored kilos (the schema keeps a tenth) stay the load's kilos, typed in the athlete's unit (`meta.weightUnit`,
 *   ruling: pounds to the nearest half — 11.3 kg is "25 lb" — kilos exact; kilos when the unit is unknown), and
 *   bodyweight is bodyweight.
 * - The coach's category is kept (the document derives its own); its minutes → `setting.targetMinutes`; its title →
 *   the title and the intent's summary; effort: recovery → recover, quality → develop, race → peak, else maintain.
 */
import type { CoachExercise, CoachRunBlock, CoachSession, WeightUnit, WorkoutDoc, WorkoutDose, WorkoutItem, WorkoutPart } from "@rg/domain";
import { formatWeightIn, parseWeight, toKg } from "@rg/domain";
import { runBlockRoles } from "@rg/coros";
import {
  bounded, currentId, kg2, loadOfKg, MAX_LOAD_KG, MAX_TYPED, openBlock, OPEN_BLOCK_NAME, within,
  type Converted, type KeptEntry, type LibraryIndex,
} from "./shared.js";

export interface CoachMeta {
  /** What the coach called a move → a library id, or null. */
  resolveName: (name: string) => string | null;
  /** The session as the model wrote it, before the schema read it: the loads as typed. */
  raw?: unknown;
  /** The athlete's weight unit: how a stored load is typed when the coach's own words are not known. */
  weightUnit?: WeightUnit;
  /** `makeLibraryIndex(library)`: canonicalises legacy ids and names gone ones in free text. */
  library?: LibraryIndex;
}

type RunEffort = Extract<WorkoutItem, { kind: "run" }>["effort"];
/** Hard work, for a run part's format: more than one of these (or a rest) makes it intervals. */
const HARD = new Set(["threshold", "interval"]);

export function docFromCoachSession(session: CoachSession, meta: CoachMeta): Converted<WorkoutDoc> | null {
  if (session.category === "rest") return null;
  const kept: KeptEntry[] = [];
  kept.push({ at: "session", field: "category", value: session.category, why: "the document derives its category from what it holds" });
  const seconds = Math.max(60, session.durationMinutes * 60);

  let parts: WorkoutPart[];
  const body = session.lift ?? session.mobility;
  if (session.run) {
    parts = runParts(session.run.blocks, session, kept, seconds);
  } else if (body) {
    const mobility = !session.lift;
    const rawExercises = rawBody(meta.raw, mobility ? "mobility" : "lift");
    const items = body.exercises.map((e, i) => exerciseItem(e, i, meta, rawExercises?.[i], kept));
    if (items.length === 0) {
      kept.push({ at: "session", field: mobility ? "mobility" : "lift", value: body, why: "no exercises named: an open block of the session's length stands in" });
      items.push(openBlock(OPEN_BLOCK_NAME, seconds));
    }
    const format: WorkoutPart["format"] = mobility ? "flow" : body.rounds ? "circuit" : "straight";
    // The coach names at most 30 exercises (MAX_EXERCISES), inside the document's 60 items: every one fits.
    parts = [{ purpose: "main", format, ...(body.rounds ? { rounds: body.rounds } : {}), items }];
  } else {
    // No body: the category is the only evidence there is.
    kept.push({ at: "session", field: "body", value: null, why: "no body: an open block of the session's length stands in" });
    parts = session.category === "yoga"
      ? [{ purpose: "main", format: "flow", items: [openBlock(OPEN_BLOCK_NAME, seconds)] }]
      : session.category === "strength"
        ? [{ purpose: "main", format: "straight", items: [openBlock(OPEN_BLOCK_NAME, seconds)] }]
        : [{ purpose: "run", format: "steady", items: [{ kind: "run", target: { durationSec: seconds }, effort: effortOfCategory(session.category) }] }];
  }

  const doc: WorkoutDoc = {
    version: 1,
    title: bounded(session.title, 80, kept, "session", "title") || "Session",
    intent: {
      summary: bounded(session.title, 200, kept, "session", "title") || "Session",
      goals: [],
      focus: [],
      effort: session.category === "recovery" ? "recover" : session.category === "quality" ? "develop" : session.category === "race" ? "peak" : "maintain",
    },
    ...(session.durationMinutes > 0 ? { setting: { targetMinutes: Math.min(600, session.durationMinutes) } } : {}),
    parts,
    source: { kind: "coach" },
  };
  if (session.durationMinutes > 600) kept.push({ at: "session", field: "durationMinutes", value: session.durationMinutes, why: "past the document's 600-minute setting" });
  return { doc, kept };
}

function effortOfCategory(category: CoachSession["category"]): RunEffort {
  return category === "long" ? "long" : category === "recovery" ? "recovery" : category === "race" ? "race" : category === "easy" ? "easy" : "by_feel";
}

function runParts(blocks: readonly CoachRunBlock[], session: CoachSession, kept: KeptEntry[], seconds: number): WorkoutPart[] {
  if (blocks.length === 0) {
    kept.push({ at: "session", field: "run", value: { blocks: [] }, why: "no blocks: one segment of the session's length stands in" });
    return [{ purpose: "run", format: "steady", items: [{ kind: "run", target: { durationSec: seconds }, effort: effortOfCategory(session.category) }] }];
  }
  const roles = runBlockRoles(blocks);
  const parts: WorkoutPart[] = [];
  blocks.forEach((b, i) => {
    const purpose: WorkoutPart["purpose"] = roles[i] === "warmup" ? "warmup" : roles[i] === "cooldown" ? "cooldown" : "run";
    const item = blockItem(b, i, kept);
    const last = parts.at(-1);
    if (last && last.purpose === purpose) last.items.push(item);
    else parts.push({ purpose, format: "steady", items: [item] });
  });
  for (const p of parts) {
    if (p.purpose !== "run") continue;
    const hard = p.items.filter((it) => it.kind === "run" && HARD.has(it.effort)).length;
    if (hard > 1 || p.items.some((it) => it.kind === "rest")) p.format = "intervals";
  }
  return parts;
}

function blockItem(b: CoachRunBlock, i: number, kept: KeptEntry[]): WorkoutItem {
  const at = `block ${i + 1}`;
  const seconds = b.kind === "duration" ? Math.round(b.value * 60) : undefined;
  if (b.intensity === "rest") {
    if (seconds !== undefined && seconds <= 3600) return { kind: "rest", seconds };
    kept.push({ at, field: "intensity", value: "rest", why: seconds === undefined ? "a rest by distance is a recovery segment" : "a rest longer than the document's hour is a recovery segment" });
    return { kind: "run", target: seconds !== undefined ? { durationSec: seconds } : { distanceM: b.value }, effort: "recovery" };
  }
  return { kind: "run", target: seconds !== undefined ? { durationSec: seconds } : { distanceM: b.value }, effort: b.intensity ?? "by_feel" };
}

/** The coach's own exercise list for this body, when its words are known. */
function rawBody(raw: unknown, key: "lift" | "mobility"): unknown[] | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const body = (raw as Record<string, unknown>)[key];
  if (typeof body !== "object" || body === null) return undefined;
  const list = (body as Record<string, unknown>).exercises;
  return Array.isArray(list) ? list : undefined;
}

function exerciseItem(e: CoachExercise, i: number, meta: CoachMeta, raw: unknown, kept: KeptEntry[]): WorkoutItem {
  const at = `exercise ${i + 1}`;
  // The coach's bounds are wider than the document's in places (30 sets, 500 reps, 30 s down, 1800 s rest): a number
  // past the document's is clamped to it, the coach's own kept.
  const dose: WorkoutDose = { sets: within(e.sets, 1, 20, kept, at, "sets", "sets") };
  if (e.reps !== undefined && e.reps !== null) dose.reps = within(e.reps, 1, 200, kept, at, "reps", "reps");
  if (e.holdSeconds !== undefined && e.holdSeconds !== null) dose.holdSec = within(e.holdSeconds, 1, 3600, kept, at, "holdSeconds", "seconds");
  if (e.perSide) dose.perSide = true;
  if (e.eccentricSeconds !== undefined && e.eccentricSeconds !== null) {
    dose.tempo = { eccentricSec: within(e.eccentricSeconds, 0, 20, kept, at, "eccentricSeconds", "seconds") };
  }
  const load = loadOf(e, raw, meta.weightUnit, at, kept);
  if (load !== undefined) dose.load = load;
  dose.restSec = within(e.restSeconds, 0, 900, kept, at, "restSeconds", "seconds");
  if (e.originId) kept.push({ at, field: "originId", value: e.originId, why: "the document names moves by the library, not the athlete's COROS catalog" });

  const cue = e.note ? bounded(e.note, 160, kept, at, "note") : undefined;
  const resolved = meta.resolveName(e.name);
  const libraryId = resolved ? currentId(resolved, meta.library, kept, at, "libraryId") : null;
  if (libraryId) return { kind: "exercise", libraryId, dose, ...(cue ? { cue } : {}) };
  return { kind: "free_exercise", name: bounded(e.name, 80, kept, at, "name"), dose, ...(cue ? { cue } : {}) };
}

/** The load: as typed when the coach's words are known, else the stored kilos typed in the athlete's unit. */
function loadOf(e: CoachExercise, raw: unknown, unit: WeightUnit | undefined, at: string, kept: KeptEntry[]): WorkoutDose["load"] {
  const typed = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).weight : undefined;
  if (typeof typed === "string" && typed.trim() !== "") {
    const text = typed.trim();
    if (e.weight.type === "bodyweight") {
      // A word with no number ("heavy", "moderate") is not bodyweight: it is the coach's judgement, kept.
      if (!/bodyweight|body weight|^bw$/i.test(text)) {
        kept.push({ at, field: "weight", value: typed, why: "a word, not a load" });
        return undefined;
      }
      return "bodyweight";
    }
    const w = parseWeight(text, "kg");
    const kg = w ? kg2(toKg(w)) : e.weight.value;
    if (kg > MAX_LOAD_KG) {
      kept.push({ at, field: "weight", value: typed, why: `past the document's ${MAX_LOAD_KG} kg` });
      return undefined;
    }
    if (text.length > MAX_TYPED) {
      kept.push({ at, field: "weight", value: typed, why: `longer than the document's ${MAX_TYPED} characters` });
      return loadOfKg(kg);
    }
    return { typed: text, kg };
  }
  if (typeof typed === "number" && e.weight.type === "kg") return loadOfKg(e.weight.value);
  if (e.weight.type === "bodyweight") return "bodyweight";
  if (!unit) return loadOfKg(e.weight.value);
  return { typed: formatWeightIn({ v: e.weight.value, u: "kg" }, unit), kg: kg2(e.weight.value) };
}
