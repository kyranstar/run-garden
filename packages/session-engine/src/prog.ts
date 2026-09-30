import { KG_TO_LB, SAME_WEIGHT_KG, formatWeight, sameWeight, toKg, type Weight, type WeightUnit } from "@rg/domain";
import {
  UNANSWERED, type CheckReading, type ConditionProfile, type EngineData, type ExerciseRecord, type HistorySession, type HistorySet, type Mode,
} from "@rg/exercise-library";
import { Lib } from "./lib.js";
import type { Target } from "./types.js";

// Next weight / reps / hold time for one exercise, from its history and today's checks. Every condition
// rule (when a session was rough, when to hold) comes from the active profiles.

/** How progression sees today: the mode, today's checks, the implement and its available weights. */
export interface ProgCtx {
  mode: Mode;
  checks: Readonly<Record<string, CheckReading>>;
  implement: string | null;
  /** Available kettlebells, sorted light to heavy. */
  kbWeights: readonly Weight[];
  unit: WeightUnit;
  equipment?: readonly string[] | null;
}

/** One logged session of one exercise (newest first in a history). */
export interface ProgEntry {
  date: string;
  startedAt: string;
  sets: readonly HistorySet[];
  flags: readonly string[];
  checks: Readonly<Record<string, CheckReading>>;
  mode: Mode | null;
}

const TIME_STEP = 5;
const TOLERANCE_KG = 0.3;
const DEFAULT_START_KG = 12;

const kgOf = (w: Weight): number => toKg(w);
const usesBellList = (ctx: Pick<ProgCtx, "implement" | "kbWeights">): boolean =>
  ctx.implement === "kettlebell" && Array.isArray(ctx.kbWeights) && ctx.kbWeights.length > 0;
const gridStep = (unit: WeightUnit): number => (unit === "kg" ? 2.5 : 5);

function stepOrNull(w: Weight, dir: number, ctx: Pick<ProgCtx, "implement" | "kbWeights">): Weight | null {
  if (usesBellList(ctx)) {
    const list = ctx.kbWeights;
    if (dir > 0) return list.find(b => kgOf(b) > kgOf(w) + SAME_WEIGHT_KG) ?? null;
    return [...list].reverse().find(b => kgOf(b) < kgOf(w) - SAME_WEIGHT_KG) ?? null;
  }
  const step = gridStep(w.u);
  const v = dir > 0 ? (Math.floor(w.v / step + 1e-9) + 1) * step : (Math.ceil(w.v / step - 1e-9) - 1) * step;
  return v >= step ? { v, u: w.u } : null;
}

/** For ± buttons: one step, or stay put at the ends. */
const stepWeight = (w: Weight, dir: number, ctx: Pick<ProgCtx, "implement" | "kbWeights">): Weight => stepOrNull(w, dir, ctx) ?? w;

/** Heaviest available bell at or under w (the lightest if all are heavier). */
function snap(w: Weight, ctx: Pick<ProgCtx, "implement" | "kbWeights">): Weight {
  if (!usesBellList(ctx)) return w;
  const list = ctx.kbWeights;
  const exact = list.find(b => sameWeight(b, w));
  if (exact) return exact;
  const under = list.filter(b => kgOf(b) <= kgOf(w) + TOLERANCE_KG);
  return under.length ? under[under.length - 1]! : list[0]!;
}

function startWeight(ex: ExerciseRecord, ctx: Pick<ProgCtx, "implement" | "kbWeights" | "unit">): Weight {
  const kg = (ex.dose && ex.dose.startKg) || DEFAULT_START_KG;
  if (usesBellList(ctx)) return snap({ v: kg, u: "kg" }, ctx);
  const unit = ctx.unit || "lb";
  const step = gridStep(unit);
  const n = unit === "kg" ? kg : kg * KG_TO_LB;
  return { v: Math.max(step, Math.round(n / step) * step), u: unit };
}

function topSet(sets: readonly (HistorySet | null)[] | null | undefined): { w: Weight; reps: number } | null {
  const loaded = (sets || []).filter((s): s is HistorySet & { w: Weight } => Boolean(s && s.w));
  if (!loaded.length) return null;
  const topKg = Math.max(...loaded.map(s => kgOf(s.w)));
  const atTop = loaded.filter(s => Math.abs(kgOf(s.w) - topKg) < SAME_WEIGHT_KG);
  return { w: atTop[0]!.w, reps: Math.min(...atTop.map(s => s.reps ?? 0)) };
}

const best = (sets: readonly (HistorySet | null)[] | null | undefined, key: "reps" | "secs"): number =>
  Math.max(0, ...(sets || []).map(s => (s && s[key]) || 0));

const active = (data: EngineData): readonly ConditionProfile[] => data.profiles.active;
/** Clean for every active profile: no flag, no symptom rise. */
const clean = (data: EngineData, e: ProgEntry): boolean => active(data).every(p => p.entryClean(e, e));

/** Why the last session was rough: a flag first (any profile), then a symptom rise. */
function stepDown(data: EngineData, e: ProgEntry): { profile: ConditionProfile; cause: "flag" | "symptom" } | null {
  for (const cause of ["flag", "symptom"] as const) {
    for (const profile of active(data)) if (profile.stepDownCause(e, e) === cause) return { profile, cause };
  }
  return null;
}

const flagPastTense = (profile: ConditionProfile): string => profile.setFlag?.pastTense ?? "You flagged it";

/** Is entry a better than entry b? Weight first, then reps at that weight, then time. */
function improved(a: { sets: readonly (HistorySet | null)[] }, b: { sets: readonly (HistorySet | null)[] }): boolean {
  const ta = topSet(a.sets), tb = topSet(b.sets);
  if (ta && tb) {
    if (kgOf(ta.w) > kgOf(tb.w) + SAME_WEIGHT_KG) return true;
    if (Math.abs(kgOf(ta.w) - kgOf(tb.w)) < SAME_WEIGHT_KG && ta.reps > tb.reps) return true;
  }
  if (!ta && !tb && best(a.sets, "reps") > best(b.sets, "reps")) return true;
  return best(a.sets, "secs") > best(b.sets, "secs");
}

/** The first active profile's reason to hold today (a high check, or a rise since last session). */
function holdReason(data: EngineData, last: ProgEntry | null, ctx: ProgCtx): string | null {
  for (const p of active(data)) {
    const why = p.holdReason(ctx.checks[p.id] ?? UNANSWERED, last);
    if (why) return why;
  }
  return null;
}

/** "with a quiet …" for every active profile, or nothing. */
const quietPhrase = (data: EngineData): string => active(data).map(p => p.quietPhrase).filter(Boolean).join(" and ");

function harderFor(data: EngineData, ex: ExerciseRecord, ctx: ProgCtx): ExerciseRecord | null {
  for (const id of ex.harder || []) {
    const h = Lib.get(data, id);
    if (h && (!ctx.equipment || Lib.hasEquipment(h, ctx.equipment))) return h;
  }
  return null;
}

function summary(entry: ProgEntry | null): string | null {
  if (!entry) return null;
  const sets = entry.sets.map(s => {
    if (s.w && s.reps != null) return `${formatWeight(s.w)} × ${s.reps}`;
    if (s.w && s.secs) return `${formatWeight(s.w)} · ${s.secs} s`;
    if (s.w) return formatWeight(s.w);
    if (s.secs) return `${s.secs} s`;
    return s.reps != null ? `${s.reps} reps` : "done";
  });
  return `${sets.join(", ")}${(entry.flags || []).map(f => ` · ${f}`).join("")}`;
}

type Fields = Partial<Target>;

function topOut(data: EngineData, ex: ExerciseRecord, ctx: ProgCtx, fields: Fields, fallbackNote: string): Fields {
  const h = harderFor(data, ex, ctx);
  if (h) return { ...fields, action: "graduate", graduate: h.id, note: `Top of the range — ready for ${h.name}?` };
  return { ...fields, action: "tempo", note: fallbackNote };
}

function suggest(data: EngineData, ex: ExerciseRecord, history: readonly ProgEntry[], ctx: ProgCtx): Target {
  const [lo, hi] = ex.dose.range;
  const last = history[0] ?? null;
  const result = (f: Fields): Target => ({
    lo, hi, type: ex.dose.type, w: null, reps: null, secs: null, graduate: null, last: summary(last), lastDate: last ? last.date : null,
    action: "start", note: "",
    ...f,
  });
  const recovery = ctx.mode === "recovery";

  if (ex.dose.type === "time") {
    if (!last) return result({ secs: lo, action: "start", note: `Start with ${lo} s.` });
    const s = best(last.sets, "secs") || lo;
    if (!clean(data, last)) {
      const why = stepDown(data, last);
      const note = why && why.cause === "flag" ? `${flagPastTense(why.profile)} last time — shorter hold today.` : "Symptoms rose last time — shorter hold today.";
      return result({ secs: Math.max(lo, s - TIME_STEP), action: "down", note });
    }
    const hold = recovery ? "Recovery day — same hold, easy breathing." : holdReason(data, last, ctx);
    if (hold) return result({ secs: Math.min(s, hi), action: "hold", note: hold });
    if (s >= hi) return result(topOut(data, ex, ctx, { secs: hi }, "Top of the range — slow your breathing through the hold."));
    return result({ secs: Math.min(hi, s + TIME_STEP), action: "more", note: `${TIME_STEP} s longer than last time.` });
  }

  if (ex.load !== "external") {
    if (!last) return result({ reps: lo, action: "start", note: `Start at ${lo} reps and see how it feels.` });
    const r = Math.min(...last.sets.map(s => s.reps ?? lo));
    if (!clean(data, last)) return result({ reps: Math.max(lo, r - 2), action: "down", note: "Last time was rough — fewer reps today." });
    const hold = recovery ? "Recovery day — keep reps easy." : holdReason(data, last, ctx);
    if (hold) return result({ reps: lo, action: "hold", note: hold });
    if (r >= hi) return result(topOut(data, ex, ctx, { reps: hi }, "Top of the range — slow the lowering to 3–4 s."));
    return result({ reps: r + 1, action: "reps", note: "One more rep than last time." });
  }

  const base: Fields = { reps: ex.dose.type === "reps" ? lo : null, secs: ex.dose.type === "carry" ? hi : null };
  const top = last ? topSet(last.sets) : null;
  if (!last || !top) return result({ ...base, w: startWeight(ex, ctx), action: "start", note: "Starting weight — adjust freely if it's too easy or hard." });
  const lastW = snap(top.w, ctx);
  const lighter = () => stepOrNull(lastW, -1, ctx) ?? lastW;

  if (recovery) {
    if (last.mode === "recovery") return result({ ...base, w: lastW, action: "hold", note: "Recovery day — same easy weight as last time." });
    return result({ ...base, w: lighter(), action: "down", note: "Recovery day — one step lighter." });
  }
  const rough = stepDown(data, last);
  if (rough && rough.cause === "flag") return result({ ...base, w: lighter(), action: "down", note: `${flagPastTense(rough.profile)} last time — one step lighter.` });
  if (rough) return result({ ...base, w: lighter(), action: "down", note: "Symptoms rose during last session — one step lighter." });
  const hold = holdReason(data, last, ctx);
  if (hold) return result({ ...base, w: lastW, action: "hold", note: hold });

  if (ex.dose.type === "carry") {
    const prev = history[1];
    const prevTop = prev ? topSet(prev.sets) : null;
    const cleanTwice = Boolean(prev && clean(data, prev) && prevTop && sameWeight(prevTop.w, top.w));
    const up = cleanTwice ? stepOrNull(lastW, 1, ctx) : null;
    if (up) return result({ ...base, w: up, action: "up", note: "Two clean carries at this weight — go up." });
    if (cleanTwice) return result(topOut(data, ex, ctx, { ...base, w: lastW }, "Heaviest weight — walk slower and stay taller."));
    return result({ ...base, w: lastW, action: "hold", note: "Same weight — own it once more before going up." });
  }

  const atTop = (entry: ProgEntry): boolean => {
    const t = topSet(entry.sets);
    return Boolean(t) && entry.sets.filter(s => s.w && t && sameWeight(s.w, t.w)).every(s => (s.reps ?? 0) >= hi);
  };
  if (atTop(last)) {
    const prev = history[1];
    const prevTop = prev ? topSet(prev.sets) : null;
    const confirmed = Boolean(prev && clean(data, prev) && atTop(prev) && prevTop && sameWeight(prevTop.w, top.w));
    if (ctx.mode === "consistent" && !confirmed) {
      return result({ w: lastW, reps: hi, action: "hold", note: `Hit ${hi} — one more clean session at this weight before going up.` });
    }
    const up = stepOrNull(lastW, 1, ctx);
    const quiet = quietPhrase(data);
    if (up) return result({ w: up, reps: lo, action: "up", note: `Hit ${hi}${quiet ? " " + quiet : ""} — go up.` });
    return result(topOut(data, ex, ctx, { w: lastW, reps: hi }, "Top of the range at your heaviest — slow the lowering to 3–4 s."));
  }
  return result({ w: lastW, reps: Math.min(hi, Math.max(lo, top.reps + 1)), action: "reps", note: "Same weight — aim for one more rep." });
}

/** This exercise's logged sessions, newest first (renamed ids resolve; ladders and circuits don't count). */
function historyFor(data: EngineData, sessions: readonly HistorySession[], exerciseId: string): ProgEntry[] {
  const target = Lib.get(data, exerciseId);
  const id = target ? target.id : exerciseId;
  const out: ProgEntry[] = [];
  for (const s of sessions || []) {
    for (const e of s.entries || []) {
      // Ladders and circuits use deliberately light or timed sets; they don't say anything about progress.
      if (!e || !e.id || e.format === "ladder" || e.format === "circuit") continue;
      const ex = Lib.get(data, e.id);
      const sets = (e.sets || []).filter(Boolean);
      if ((ex ? ex.id : e.id) !== id || !sets.length) continue;
      out.push({
        date: s.date, startedAt: s.startedAt || s.date, sets, flags: e.flags || [],
        checks: s.checks || {}, mode: s.mode || null,
      });
    }
  }
  return out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

export const Prog = { suggest, historyFor, improved, stepWeight, startWeight, snap, topSet };
