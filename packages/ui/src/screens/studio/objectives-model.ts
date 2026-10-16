/**
 * THE OBJECTIVES BOARD'S MODEL (Stage 3 Task 11; spec §11; principles §2.9 honesty, §2.10 gentle gamification): the
 * words and numbers the board shows, and the drafts its sheet edits — pure, so the board and its tests read one rule.
 *
 *  - A key result's values are in its own unit (`KeyResultDto.unit`, the athlete's when it was made): a hold in seconds,
 *    a race time or a pace as a clock, a load in the athlete's weight unit. The athlete types them the way they are shown.
 *  - Evidence is said in read_objectives' four words (measured, sparse, capped, none) — never a colour alone.
 *  - Progress toward a target runs from the start (`baseline`) to it, clamped to 0–100% — so a pace at or below its
 *    target is 100%, never more. A key result with no start can't say how far it has come ("from zero" means nothing
 *    for a time or a pace, and little for a hold), nor can one whose target lies the wrong way from its start: neither
 *    counts. The ring is the mean of the key results that can say; with none, there is no ring.
 *  - Never guilt: a streak shows from one week; a stalled objective is noticed only after four weeks, and only when it
 *    is active and has had four weeks to be worked on.
 */
import {
  addDays,
  canonicalUnitOf,
  defaultUnitFor,
  GOAL_IDS,
  GOAL_LABELS,
  KG_TO_LB,
  unitsFor,
  type KeyResultDirection,
  type KeyResultDto,
  type KeyResultEvidence,
  type KeyResultInput,
  type KeyResultMeasure,
  type KeyResultUnit,
  type ObjectiveBoardCard,
  type ObjectiveDto,
} from "@rg/domain";
import { EXERCISES, type ExerciseRecord } from "@rg/exercise-library";
import { ApiError } from "@rg/api-client";
import { formatDistance, type Units } from "../../components.js";

export type WeightUnit = "kg" | "lb";
export interface BoardUnits {
  units: Units;
  weightUnit: WeightUnit;
}

/** Days with nothing done toward an active objective before the board notices, kindly. */
export const STALL_DAYS = 28;

// ── Moves ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const moves = new Map<string, ExerciseRecord>();
for (const e of EXERCISES) for (const old of e.legacyIds) if (!moves.has(old)) moves.set(old, e);
for (const e of EXERCISES) moves.set(e.id, e);

/** A move's name, by its id or one it had; the id itself when the library has none. */
export const moveName = (id: string): string => moves.get(id)?.name ?? id;

function movesWords(ids: readonly string[]): string {
  const names = ids.map(moveName);
  return names.length <= 2 ? names.join(" + ") : `${names.slice(0, 2).join(", ")} + ${names.length - 2} more`;
}

// ── Values ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const round = (v: number, places: number): number => Math.round(v * 10 ** places) / 10 ** places;
const plain = (v: number, places = 1): string => String(round(v, places));

/** A clock: "25:30", "1:02:30". */
export function clock(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Whether a key result's seconds read as a clock (a race time) rather than a count of seconds (a hold). */
const isClock = (unit: KeyResultUnit, measure: KeyResultMeasure | null): boolean =>
  unit === "s/km" || unit === "s/mi" || (unit === "s" && (measure?.kind === "run_best" || measure?.kind === "predicted_time"));

/** A value in its key result's unit, as the board says it. */
export function formatKr(value: number, unit: KeyResultUnit, measure: KeyResultMeasure | null): string {
  if (unit === "s/km" || unit === "s/mi") return `${clock(value)} /${unit === "s/km" ? "km" : "mi"}`;
  if (isClock(unit, measure)) return clock(value);
  switch (unit) {
    case "s":
      return `${plain(value, 0)} s`;
    case "min":
      return `${plain(value, 2)} min`;
    case "kg":
    case "lb":
      return `${plain(value)} ${unit}`;
    case "reps":
      return `${plain(value, 0)} ${round(value, 0) === 1 ? "rep" : "reps"}`;
    default:
      return plain(value, 2);
  }
}

/** What a field's value is typed in, for its hint: "min:sec", "s", "kg"… */
export function unitHint(unit: KeyResultUnit, measure: KeyResultMeasure | null): string {
  if (unit === "s/km" || unit === "s/mi") return `min:sec /${unit === "s/km" ? "km" : "mi"}`;
  if (isClock(unit, measure)) return "min:sec";
  return unit === "score" ? "" : unit;
}

/**
 * What the athlete typed, in the key result's unit: a clock ("25:30", "1:02:30") for a race time or a pace, else a
 * number not below zero. Null when empty; "bad" when it can't be read.
 */
export function parseKr(text: string, unit: KeyResultUnit, measure: KeyResultMeasure | null): number | null | "bad" {
  const t = text.trim();
  if (t === "") return null;
  if (isClock(unit, measure)) {
    const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(t);
    if (!m) return "bad";
    const [h, mm, ss] = [Number(m[1] ?? 0), Number(m[2]), Number(m[3])];
    if (ss >= 60 || (m[1] !== undefined && mm >= 60)) return "bad";
    return h * 3600 + mm * 60 + ss;
  }
  if (!/^\d+(?:\.\d+)?$/.test(t)) return "bad";
  return Number(t);
}

// ── Words ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const loadWords = (kg: number, weightUnit: WeightUnit): string => (weightUnit === "lb" ? `${plain(kg * KG_TO_LB)} lb` : `${plain(kg)} kg`);

/** A measure in plain words, in the athlete's distance and weight units. */
export function measureWords(m: KeyResultMeasure, u: BoardUnits): string {
  switch (m.kind) {
    case "hold_max":
      return `Longest hold · ${movesWords(m.libraryIds)}`;
    case "best_set": {
      const what =
        m.metric === "e1rm" ? "Estimated max" : m.metric === "load_at_reps" ? `Heaviest for ${m.reps ?? 1} reps` : `Most reps at ${loadWords(m.loadKg ?? 0, u.weightUnit)}`;
      return `${what} · ${movesWords(m.libraryIds)}`;
    }
    case "run_best":
      return `Fastest ${formatDistance(m.distanceM, u.units)}`;
    case "pace_at_hr":
      return `Pace at heart rate ${m.hrLow}–${m.hrHigh}`;
    case "threshold_pace":
      return "Threshold pace from the watch";
    case "predicted_time":
      return `Predicted ${formatDistance(m.distanceM, u.units)} time`;
    case "checkin":
      return "A check-in answer";
    case "test":
      return "A test result";
  }
}

/** The window a measure reads, in words ("last 90 days"); null for one with none. */
export const windowWords = (m: KeyResultMeasure): string | null => ("windowDays" in m ? `last ${m.windowDays} days` : null);

/**
 * The evidence in plain words (fix wave 3B, B-I11), one map for the pill and every other place that says it — never the
 * model's own (sparse, capped, none). The domain holds the ids alone.
 */
const EVIDENCE_WORD: Record<KeyResultEvidence, string> = { measured: "Measured", sparse: "Few readings", capped: "At least", none: "Not measured yet" };

/** What "Ask the coach for a test" puts in the composer for a measure not measured yet (B-I11): the athlete's to send. */
export const testRequest = (label: string): string => `Plan a test so I can measure: ${label.trim()}`;
/** read_objectives' legend's own four words. */
export const evidenceWord = (e: KeyResultEvidence): string => EVIDENCE_WORD[e];

/** "1 point", "3 points". */
export const pointsWords = (n: number): string => `${n} ${n === 1 ? "point" : "points"}`;

/** A streak in words, from one week; nothing at zero. */
export function streakWords(weeks: number): string | null {
  if (weeks <= 0) return null;
  return weeks === 1 ? "1 week" : `${weeks} weeks in a row`;
}

/** The goals in plain words (`GOAL_LABELS`), in the order the goal list has them. */
export const goalWords = (ids: readonly string[]): string =>
  GOAL_IDS.filter((g) => ids.includes(g))
    .map((g) => GOAL_LABELS[g])
    .join(" · ");

// ── Progress ────────────────────────────────────────────────────────────────────────────────────────────────────────

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * How far a key result has come from its start toward its target, 0–1 (at or past the target is 1, never more). Null —
 * it can't say — without a start, a target or a current value, or when the target doesn't lie the key result's own way
 * from its start (higher for "up", lower for "down").
 */
export function krFraction(k: Pick<KeyResultDto, "baseline" | "target" | "direction">, current: number | null): number | null {
  if (k.target === null || k.baseline === null || current === null) return null;
  const span = k.target - k.baseline;
  if (span === 0 || (k.direction === "up" ? span < 0 : span > 0)) return null;
  return clamp01((current - k.baseline) / span);
}

/** The ring: the mean of the key results that can say; null when none can. */
export function objectiveFraction(card: ObjectiveBoardCard): number | null {
  const fs = card.keyResults.map((k) => krFraction(k.keyResult, k.progress.display.current)).filter((f): f is number => f !== null);
  return fs.length ? fs.reduce((a, b) => a + b, 0) / fs.length : null;
}

/**
 * An active objective, four weeks old or more, with nothing done toward it in the last four weeks: the board says so,
 * once, with a next step. Never a paused or completed one, never a new one.
 */
export function stalled(card: ObjectiveBoardCard, today: string): boolean {
  if (card.objective.status !== "active") return false;
  const since = addDays(today, -STALL_DAYS);
  if (card.objective.createdAt.slice(0, 10) > since) return false;
  return !card.served.some((s) => s.date > since);
}

/** The board's sections: active and paused in board order, then the completed. */
export function boardSections(cards: readonly ObjectiveBoardCard[]): { current: ObjectiveBoardCard[]; done: ObjectiveBoardCard[] } {
  return { current: cards.filter((c) => c.objective.status !== "done"), done: cards.filter((c) => c.objective.status === "done") };
}

// ── Drafts ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The measures the sheet offers to make; a check-in or a test (not measured yet) is kept as it is. */
export const MEASURE_KINDS = ["hold_max", "best_set", "run_best", "pace_at_hr", "threshold_pace", "predicted_time"] as const;
export type MeasureKind = (typeof MEASURE_KINDS)[number];
export const MEASURE_LABELS: Record<MeasureKind, string> = {
  hold_max: "Longest hold",
  best_set: "Best set",
  run_best: "Fastest run",
  pace_at_hr: "Pace at heart rate",
  threshold_pace: "Threshold pace (watch)",
  predicted_time: "Predicted race time",
};
export const METRIC_LABELS = { e1rm: "Estimated max", load_at_reps: "Heaviest for some reps", reps_at_load: "Most reps at a load" } as const;
export type Metric = keyof typeof METRIC_LABELS;
export const WINDOW_CHOICES = [30, 60, 90, 180, 365] as const;
const DEFAULT_WINDOW: Record<MeasureKind, number> = { hold_max: 90, best_set: 90, run_best: 180, pace_at_hr: 90, threshold_pace: 90, predicted_time: 90 };
export const defaultWindow = (kind: MeasureKind): number => DEFAULT_WINDOW[kind];

/** One key result as the sheet edits it: every field as typed. */
export interface KrDraft {
  /** The key result's id, when it exists. */
  id?: string;
  label: string;
  /** "" until one is chosen; "kept" for a check-in or test kept as it is. */
  kind: MeasureKind | "kept" | "";
  moves: string[];
  metric: Metric;
  reps: string;
  /** In the athlete's weight unit. */
  load: string;
  /** In the athlete's distance unit. */
  distance: string;
  hrLow: string;
  hrHigh: string;
  windowDays: number;
  target: string;
  baseline: string;
  dueDate: string;
  /** The unit it was kept in, when it exists (kept while the measure still fits it). */
  keptUnit?: KeyResultUnit;
  /** A check-in's or test's measure and way, kept as they are. */
  kept?: { measure: KeyResultMeasure; direction: KeyResultDirection };
}

export interface ObjectiveDraft {
  title: string;
  why: string;
  goalIds: string[];
  krs: KrDraft[];
}

export const emptyKr = (): KrDraft => ({
  label: "",
  kind: "",
  moves: [],
  metric: "e1rm",
  reps: "",
  load: "",
  distance: "",
  hrLow: "",
  hrHigh: "",
  windowDays: 90,
  target: "",
  baseline: "",
  dueDate: "",
});

export const emptyObjective = (): ObjectiveDraft => ({ title: "", why: "", goalIds: [], krs: [] });

const KM_PER_MI = 1.609344;
const distanceText = (m: number, units: Units): string => plain(units === "mi" ? m / 1000 / KM_PER_MI : m / 1000, 2);
const valueText = (v: number | null, unit: KeyResultUnit, m: KeyResultMeasure | null): string =>
  v === null ? "" : isClock(unit, m) ? clock(v) : String(v);

/** A key result as the sheet edits it. */
export function krDraftOf(k: KeyResultDto, u: BoardUnits): KrDraft {
  const m = k.measure;
  const base = { ...emptyKr(), id: k.id, label: k.label, keptUnit: k.unit, dueDate: k.dueDate ?? "" };
  const values = { target: valueText(k.target, k.unit, m), baseline: valueText(k.baseline, k.unit, m) };
  if (!m || m.kind === "checkin" || m.kind === "test") {
    return { ...base, ...values, kind: m ? "kept" : "", ...(m ? { kept: { measure: m, direction: k.direction } } : {}) };
  }
  const draft: KrDraft = { ...base, ...values, kind: m.kind, windowDays: m.windowDays };
  if (m.kind === "hold_max") return { ...draft, moves: [...m.libraryIds] };
  if (m.kind === "best_set") {
    return {
      ...draft,
      moves: [...m.libraryIds],
      metric: m.metric,
      reps: m.reps !== undefined ? String(m.reps) : "",
      load: m.loadKg !== undefined ? plain(u.weightUnit === "lb" ? m.loadKg * KG_TO_LB : m.loadKg) : "",
    };
  }
  if (m.kind === "run_best" || m.kind === "predicted_time") return { ...draft, distance: distanceText(m.distanceM, u.units) };
  if (m.kind === "pace_at_hr") return { ...draft, hrLow: String(m.hrLow), hrHigh: String(m.hrHigh) };
  return draft;
}

export function objectiveDraftOf(o: ObjectiveDto, u: BoardUnits): ObjectiveDraft {
  return { title: o.title, why: o.why ?? "", goalIds: [...o.goalIds], krs: o.keyResults.map((k) => krDraftOf(k, u)) };
}

const num = (t: string): number | null => (/^\d+(?:\.\d+)?$/.test(t.trim()) ? Number(t.trim()) : null);

/**
 * The measure a draft says, or what is missing in plain words. Its defaults filled (a window), so what is sent is what
 * the server keeps.
 */
export function measureOf(d: KrDraft, u: BoardUnits): { measure: KeyResultMeasure } | { errors: string[] } {
  if (d.kind === "kept" && d.kept) return { measure: d.kept.measure };
  if (d.kind === "" || d.kind === "kept") return { errors: ["Choose what it measures."] };
  const windowDays = d.windowDays;
  switch (d.kind) {
    case "hold_max":
      return d.moves.length ? { measure: { kind: "hold_max", libraryIds: d.moves, windowDays } } : { errors: ["Pick at least one move."] };
    case "best_set": {
      const errors: string[] = d.moves.length ? [] : ["Pick at least one move."];
      const reps = num(d.reps);
      const load = num(d.load);
      if (d.metric === "load_at_reps" && (reps === null || !Number.isInteger(reps) || reps < 1 || reps > 50)) errors.push("Say how many reps, from 1 to 50.");
      if (d.metric === "reps_at_load" && load === null) errors.push("Say the load.");
      if (errors.length) return { errors };
      const loadKg = load === null ? undefined : round(u.weightUnit === "lb" ? load / KG_TO_LB : load, 2);
      return {
        measure: {
          kind: "best_set",
          libraryIds: d.moves,
          metric: d.metric,
          ...(d.metric === "load_at_reps" ? { reps: reps! } : {}),
          ...(d.metric === "reps_at_load" ? { loadKg: loadKg! } : {}),
          windowDays,
        },
      };
    }
    case "run_best":
    case "predicted_time": {
      const dist = num(d.distance);
      const m = dist === null ? null : Math.round(dist * (u.units === "mi" ? KM_PER_MI : 1) * 1000);
      if (m === null || m < 1000 || m > 200_000) return { errors: [`Say the distance, from ${u.units === "mi" ? "0.7 to 124 mi" : "1 to 200 km"}.`] };
      return { measure: { kind: d.kind, distanceM: m, windowDays } };
    }
    case "pace_at_hr": {
      const lo = num(d.hrLow);
      const hi = num(d.hrHigh);
      const ok = (v: number | null) => v !== null && Number.isInteger(v) && v >= 40 && v <= 230;
      if (!ok(lo) || !ok(hi)) return { errors: ["Say the heart-rate range, from 40 to 230."] };
      if (lo! > hi!) return { errors: ["The heart-rate range is upside down."] };
      return { measure: { kind: "pace_at_hr", hrLow: lo!, hrHigh: hi!, minDurationSec: 1200, windowDays } };
    }
    case "threshold_pace":
      return { measure: { kind: "threshold_pace", windowDays } };
  }
}

/** The unit a draft's values are typed in: the one it was kept in while the measure fits it, else the athlete's. */
export function draftUnit(d: KrDraft, measure: KeyResultMeasure | null, u: BoardUnits): KeyResultUnit {
  if (!measure) return d.keptUnit ?? "s";
  if (d.keptUnit && unitsFor(measure).includes(d.keptUnit)) return d.keptUnit;
  return defaultUnitFor(measure, { weightUnit: u.weightUnit, units: u.units });
}

/** The measure a draft says so far, for its unit and hints (a partial one reads as its kind's canonical unit). */
export function draftMeasure(d: KrDraft, u: BoardUnits): KeyResultMeasure | null {
  const r = measureOf(d, u);
  if ("measure" in r) return r.measure;
  switch (d.kind) {
    case "hold_max":
      return { kind: "hold_max", libraryIds: ["?"], windowDays: d.windowDays };
    case "best_set":
      return { kind: "best_set", libraryIds: ["?"], metric: d.metric, windowDays: d.windowDays };
    case "run_best":
    case "predicted_time":
      return { kind: d.kind, distanceM: 5000, windowDays: d.windowDays };
    case "pace_at_hr":
      return { kind: "pace_at_hr", hrLow: 40, hrHigh: 230, minDurationSec: 1200, windowDays: d.windowDays };
    default:
      return null;
  }
}

/** The key result a draft says, as `POST`/`PUT /api/objectives` take it — or what to fix, in plain words. */
export function krInputOf(d: KrDraft, u: BoardUnits): { input: KeyResultInput } | { errors: string[] } {
  const errors: string[] = [];
  if (d.label.trim() === "") errors.push("Give it a name.");
  const m = measureOf(d, u);
  if ("errors" in m) errors.push(...m.errors);
  const measure = "measure" in m ? m.measure : draftMeasure(d, u);
  const unit = draftUnit(d, measure, u);
  const target = parseKr(d.target, unit, measure);
  const baseline = parseKr(d.baseline, unit, measure);
  const as = isClock(unit, measure) ? " Write it as minutes and seconds, like 25:30." : "";
  if (target === "bad") errors.push(`The target isn't ${isClock(unit, measure) ? "a time" : "a number"}.${as}`);
  if (baseline === "bad") errors.push(`The start isn't ${isClock(unit, measure) ? "a time" : "a number"}.${as}`);
  if (errors.length || !("measure" in m)) return { errors };
  return {
    input: {
      ...(d.id ? { id: d.id } : {}),
      label: d.label.trim(),
      measure: m.measure,
      ...(d.kind === "kept" && d.kept ? { direction: d.kept.direction } : {}),
      unit,
      target: target as number | null,
      baseline: baseline as number | null,
      dueDate: d.dueDate || null,
    },
  };
}

/** The objective a draft says — its key results the whole list — or what to fix, in plain words. */
export function objectiveInputOf(
  d: ObjectiveDraft,
  u: BoardUnits,
): { body: { title: string; why: string | null; goalIds: string[]; keyResults: KeyResultInput[] } } | { errors: string[] } {
  const errors: string[] = [];
  if (d.title.trim() === "") errors.push("Give it a title.");
  const keyResults: KeyResultInput[] = [];
  d.krs.forEach((k) => {
    const r = krInputOf(k, u);
    if ("errors" in r) errors.push(...r.errors.map((e) => `“${k.label.trim() || "A measure"}”: ${e}`));
    else keyResults.push(r.input);
  });
  if (errors.length) return { errors };
  return { body: { title: d.title.trim(), why: d.why.trim() || null, goalIds: GOAL_IDS.filter((g) => d.goalIds.includes(g)), keyResults } };
}

// ── Refusals ────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Issue {
  path?: Array<string | number>;
  message?: string;
  code?: string;
}

/** A server's 422 issues as plain lines: what each is about, then what it says. */
export function issueLines(issues: readonly Issue[], d: ObjectiveDraft): string[] {
  return issues.slice(0, 6).map((i) => {
    const [first, at] = i.path ?? [];
    const message = i.message ?? "can't be saved";
    if (first === "title") return i.code === "too_small" ? "Give it a title." : `Title: ${message}`;
    if (first === "why") return i.code === "too_big" ? "The why is too long (500 characters at most)." : `Why: ${message}`;
    // "Measure", never "key result", wherever the athlete reads it (fix wave 3B, M10); the domain's names stay.
    if (first === "keyResults" && typeof at === "number") return `“${d.krs[at]?.label.trim() || `Measure ${at + 1}`}”: ${message}`;
    if (first === "keyResults") return i.code === "too_big" ? "Ten measures at most." : `Measures: ${message}`;
    return message;
  });
}

/** Why a write didn't happen, in plain words. */
export function writeError(e: unknown, d: ObjectiveDraft | null): string[] {
  if (e instanceof ApiError) {
    const body = e.body as { issues?: Issue[] } | undefined;
    if (e.status === 422 && d && body?.issues?.length) return issueLines(body.issues, d);
    if (e.status === 404) return ["That objective is gone now."];
    if (e.status === 423) return ["Your account is being restored. Try again in a minute."];
    return ["Couldn't save it. Try again."];
  }
  return ["Saving needs a connection."];
}

/** The canonical unit a measure answers in (for a chart's tick format). */
export const canonicalOf = canonicalUnitOf;
