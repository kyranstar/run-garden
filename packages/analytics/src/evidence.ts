import type { DateRange, PlannedWorkout } from "@rg/domain";
import { inRange } from "@rg/domain";
import type { PersonalRecord } from "./records.js";
import { stableHash } from "./stats.js";
import type { TimeOfDayPair } from "./timeOfDay.js";
import { computeTimeOfDay } from "./timeOfDay.js";

/**
 * Evidence cards for the Today screen: at most ONE factual, non-causal card,
 * chosen by information value (comeback pattern > morning completion rate >
 * easy-run consistency). Returns null when nothing meets its sample threshold
 * — no platitudes, no filler.
 */

const MIN_MORNING_PLANNED = 10;
const MIN_MORNING_RATE = 0.7;
const MIN_EASY_PLANNED = 10;
const MIN_EASY_RATE = 0.7;
/** Comparative morning-vs-evening phrasing requires at least this many
 * planned samples in BOTH windows; below that, the card is not produced. */
const MIN_WINDOW_PLANNED_FOR_COMPARISON = 3;

export interface EvidenceCard {
  /** Stable hash of the card kind + headline value, so dismissals persist. */
  id: string;
  text: string;
  sampleNote: string;
  dismissible: true;
}

export interface EvidenceInput {
  /** Same inputs computeConsistency takes. */
  workouts: PlannedWorkout[];
  range: DateRange;
  /** Same input computeTimeOfDay takes. */
  timeOfDayPairs: TimeOfDayPair[];
  /** Output of computeRecords. */
  records: PersonalRecord[];
}

function card(kind: string, keyValue: string, text: string, sampleNote: string): EvidenceCard {
  return { id: `ev-${stableHash(`${kind}:${keyValue}`)}`, text, sampleNote, dismissible: true };
}

/**
 * Find a record by its bare id, tolerating the `<discipline>:` namespace.
 *
 * Record ids gained that prefix when insights became per-discipline; records
 * persisted before then still carry bare ids, and both must resolve here or a
 * card silently stops appearing.
 */
function findRecord(records: PersonalRecord[], bareId: string): PersonalRecord | undefined {
  return records.find((r) => r.id === bareId || r.id.endsWith(`:${bareId}`));
}

function comebackCard(records: PersonalRecord[]): EvidenceCard | null {
  const record = findRecord(records, "fastest_comeback_days");
  if (!record) return null;
  return card(
    "comeback",
    record.value,
    `After a break of 7 or more days, your fastest return to three runs took ${record.value}.`,
    record.rule,
  );
}

function morningCard(pairs: TimeOfDayPair[]): EvidenceCard | null {
  const result = computeTimeOfDay(pairs);
  if (result.status !== "ok") return null;
  const { morning, evening, medianStartDeltaMinutes } = result.value;
  // Comparative phrasing needs a real comparison: without at least a few
  // planned samples in EACH window, the other window's rate is too thin to
  // stand behind, so no card is produced at all.
  if (
    morning.planned < MIN_WINDOW_PLANNED_FOR_COMPARISON ||
    evening.planned < MIN_WINDOW_PLANNED_FOR_COMPARISON
  ) {
    return null;
  }
  if (morning.planned < MIN_MORNING_PLANNED || morning.rate < MIN_MORNING_RATE) return null;
  const pct = Math.round(morning.rate * 100);
  let text = `You complete ${pct}% of morning runs (${morning.completed} of ${morning.planned} scheduled before noon).`;
  if (medianStartDeltaMinutes != null) {
    text += ` You typically start within ${medianStartDeltaMinutes} minutes of plan.`;
  }
  return card(
    "morning_completion",
    String(pct),
    text,
    `Sample: ${morning.planned} scheduled morning runs.`,
  );
}

function easyConsistencyCard(workouts: PlannedWorkout[], range: DateRange): EvidenceCard | null {
  const easy = workouts.filter(
    (w) =>
      w.category === "easy" &&
      inRange(w.effectiveDate, range) &&
      w.completionState !== "scheduled",
  );
  const completed = easy.filter(
    (w) => w.completionState === "completed",
  ).length;
  if (easy.length < MIN_EASY_PLANNED) return null;
  const rate = completed / easy.length;
  if (rate < MIN_EASY_RATE) return null;
  const pct = Math.round(rate * 100);
  return card(
    "easy_consistency",
    String(pct),
    `You completed ${completed} of ${easy.length} planned easy runs (${pct}%).`,
    `Sample: ${easy.length} planned easy runs between ${range.start} and ${range.end}.`,
  );
}

/**
 * The highest-value card the user has not dismissed. `dismissedIds` is applied
 * INSIDE the fallback chain, not to its result: filtering afterwards would
 * make dismissing the top card collapse the whole rotation to null, when the
 * point of dismissing it is to see the next one. Required (not defaulted) so a
 * caller cannot silently re-serve a card the user has already waved away.
 */
export function pickEvidenceCard(
  input: EvidenceInput,
  dismissedIds: ReadonlySet<string>,
): EvidenceCard | null {
  const live = (c: EvidenceCard | null): EvidenceCard | null =>
    c != null && !dismissedIds.has(c.id) ? c : null;
  return (
    live(comebackCard(input.records)) ??
    live(morningCard(input.timeOfDayPairs)) ??
    live(easyConsistencyCard(input.workouts, input.range)) ??
    null
  );
}
