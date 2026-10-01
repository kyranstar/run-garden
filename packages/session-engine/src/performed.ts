import {
  performedSessionSaveSchema, type ConditionCheck, type PerformedSessionWire, type PerformedSessionWireInput, type PerformedSource,
} from "@rg/domain";
import type { CheckReading, HistoryEntry, HistorySession } from "@rg/exercise-library";
import type { PendingChanges, PerformedSessionSave } from "./recorder.js";

// The one place the recorder's save meets the wire contract (ruling P1-R3). The domain's
// `performedSessionSaveSchema` is what the outbox holds and the server accepts; `PerformedSessionSave` is what the
// recorder returns (and what the review screen's records run on). `toPerformedSave` maps one to the other;
// `historyFromPerformed` maps a saved session back to the history the engine reads.

/** Where the save came from and what it performed — the parts the recorder does not know. */
export interface PerformedSaveContext {
  source: PerformedSource;
  /** The source's own session id (imports); null for the app's own saves. */
  sourceRef?: string | null;
  workoutId: string | null;
  buildId: string | null;
}

/** A logged count is whole: a typed 7.6 reps saves as 8. */
const whole = (n: number | null): number | null => (n == null ? null : Math.round(n));

/** A rating is 👍 (+1) or 👎 (-1); the review only ever sets those, or null to clear one. */
const sign = (v: number | null): 1 | -1 | null => (v == null || v === 0 ? null : v > 0 ? 1 : -1);

/** A check row is written only for an answer: a reading with no number and no "feeling off" is not saved. */
function checkRows(save: PerformedSessionSave): ConditionCheck[] {
  const rows: ConditionCheck[] = [];
  const preAt = save.startedAt ?? save.endedAt;
  for (const [profileId, r] of Object.entries(save.checks)) {
    if (r.pre != null || r.feelingOff) rows.push({ profileId, kind: "pre", value: whole(r.pre), feelingOff: Boolean(r.feelingOff), at: preAt });
    if (r.post != null) rows.push({ profileId, kind: "post", value: whole(r.post), feelingOff: false, at: save.endedAt });
  }
  return rows;
}

/**
 * The recorder's save and the review's pending decisions → the wire payload, validated (throws if the save cannot
 * be represented — better at Save than as an outbox entry the server will never take).
 *
 * Set flags are per exercise in the recorder and per set on the wire (and in `performed_sets`): every set of an
 * entry carries the entry's flags. Sets are numbered among the done sets the recorder kept.
 */
export function toPerformedSave(save: PerformedSessionSave, review: PendingChanges, ctx: PerformedSaveContext): PerformedSessionWire {
  const wire: PerformedSessionWireInput = {
    id: save.id,
    source: ctx.source,
    sourceRef: ctx.sourceRef ?? null,
    workoutId: ctx.workoutId,
    buildId: ctx.buildId,
    localDate: save.date,
    startedAt: save.startedAt,
    endedAt: save.endedAt,
    seconds: Math.round(save.seconds),
    plannedSeconds: whole(save.plannedSeconds),
    minutes: whole(save.minutes),
    mode: save.mode,
    theme: save.theme,
    locationId: save.locationId || null,
    blockRef: save.blockId,
    blockNumber: save.blockNumber,
    completed: save.completed,
    stepsTotal: save.stepsTotal,
    stepsDone: save.stepsDone,
    movesDone: save.done.map(d => ({ exerciseId: d.id, seconds: Math.round(d.secs) })),
    note: save.note === "" ? null : save.note,
    newMove: save.newMove,
    entries: save.entries.filter(e => e.sets.length > 0).map(e => ({
      exerciseId: e.id,
      implement: e.implement,
      format: e.format,
      perSide: e.perSide,
      sets: e.sets.map((s, i) => ({
        setIndex: i, side: null, reps: whole(s.reps), seconds: whole(s.secs),
        load: s.w ? { v: s.w.v, u: s.w.u } : null, done: true, flags: [...e.flags],
      })),
    })),
    checks: checkRows(save),
    review: {
      ratings: Object.fromEntries(Object.entries(review.ratings).map(([exId, v]) => [exId, sign(v)])),
      excluded: { ...review.excluded },
      graduations: review.graduations.map(g => ({ family: g.family, to: g.to })),
    },
  };
  return performedSessionSaveSchema.parse(wire);
}

const UNANSWERED: CheckReading = { pre: null, post: null, feelingOff: false };

/**
 * A saved session → the history the engine reads (Phase 1 spec §4.3). Only done sets are history (as the recorder
 * keeps them); an entry with none is dropped. An entry's flags are its sets' flags.
 */
export function historyFromPerformed(p: PerformedSessionWire): HistorySession {
  const checks: Record<string, CheckReading> = {};
  for (const c of p.checks) {
    if (c.kind === "daily") continue;
    const r = { ...(checks[c.profileId] ?? UNANSWERED) };
    if (c.kind === "pre") r.pre = c.value;
    else r.post = c.value;
    r.feelingOff = r.feelingOff || c.feelingOff;
    checks[c.profileId] = r;
  }
  const entries: HistoryEntry[] = [];
  for (const e of p.entries) {
    const sets = e.sets.filter(s => s.done).map(s => ({ w: s.load ? { v: s.load.v, u: s.load.u } : null, reps: s.reps, secs: s.seconds }));
    if (sets.length === 0) continue;
    entries.push({
      id: e.exerciseId, implement: e.implement, perSide: e.perSide, format: e.format,
      flags: [...new Set(e.sets.flatMap(s => s.flags))], sets,
    });
  }
  return {
    id: p.id, date: p.localDate, startedAt: p.startedAt, mode: p.mode, theme: p.theme, blockNumber: p.blockNumber,
    checks, done: p.movesDone.map(m => ({ id: m.exerciseId, secs: m.seconds })), entries,
  };
}
