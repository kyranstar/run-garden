import type { ExerciseRecord } from "../record.js";
import type { CoverageTargets } from "../targets.js";
import type { FormatId, Mode, Pattern, Role } from "../vocab.js";

// The condition-profile contract (Phase 1 spec §4.1). A profile is data plus rules; the engine reads
// every condition-specific rule, threshold and word through it and never names a profile itself.

export type AttrValue = number | boolean;
/** One exercise's ratings for one profile, e.g. `{ clench: 1, neckLoad: 0, faceDown: false }`. */
export type Attrs = Readonly<Record<string, AttrValue>>;
export type AttributeSpec = { kind: "scale"; min: number; max: number } | { kind: "flag" };

/** One profile's check for a day or a session: before, after, and "I'm feeling off". */
export interface CheckReading {
  pre: number | null;
  post: number | null;
  feelingOff: boolean;
}

/** A weight as typed or suggested: `{ v: 25, u: "lb" }`. */
export interface WeightValue {
  v: number;
  u: "lb" | "kg";
}

export interface HistorySet {
  w: WeightValue | null;
  reps: number | null;
  secs: number | null;
}

/** One exercise logged in a saved session (spec §4.3). */
export interface HistoryEntry {
  id: string;
  implement: string | null;
  perSide: boolean;
  format: FormatId | null;
  /** Profile flags set on this exercise, e.g. `["clenched"]`. */
  flags: readonly string[];
  sets: readonly HistorySet[];
}

/** A saved session in the one shape the engine reads (spec §4.3). */
export interface HistorySession {
  id: string;
  /** Local "YYYY-MM-DD". */
  date: string;
  startedAt: string | null;
  mode: Mode | null;
  theme: string | null;
  blockNumber: number | null;
  /** Check readings by profile id. */
  checks: Readonly<Record<string, CheckReading>>;
  done: ReadonlyArray<{ id: string; secs: number }>;
  entries: readonly HistoryEntry[];
}

/** What a profile needs from a logged exercise: its flags. */
export type EntryFlags = Pick<HistoryEntry, "flags">;
/** What a profile needs from a session: its check readings. */
export type SessionChecks = Pick<HistorySession, "checks">;

/** Everything a profile's proposal rules see, with this profile's own reading for today. */
export interface ProposalCtx {
  today: string;
  /** This profile's check today. */
  reading: CheckReading;
  /**
   * Sessions on or before today, oldest first. A build may plan from a trimmed history (ruling 2a-R6): only the last
   * 14 days and the last three sessions are certain to be here, so a rule that reads further back must first be
   * added to what the session engine's `Hist.trim` keeps.
   */
  past: readonly HistorySession[];
  last: HistorySession | null;
  /** Past sessions in the trailing 7 days. */
  week: readonly HistorySession[];
}

export interface CareBlock {
  label: string;
  roles: readonly Role[];
  formats: readonly FormatId[];
  share: Readonly<Record<Mode, number>>;
  min: Readonly<Record<Mode, number>>;
  max: Readonly<Record<Mode, number>>;
}

export interface ConditionProfile {
  id: string;
  label: string;
  attributes: Readonly<Record<string, AttributeSpec>>;
  check: { label: string; min: 0; max: 10 };
  setFlag: { id: string; label: string; pastTense: string } | null;

  // Exercise rules (everywhere the profile is active)
  never(a: Attrs): boolean;
  fitsMode(a: Attrs, mode: Mode): boolean;
  fitsFormat(a: Attrs, formatId: FormatId): boolean;
  allowPattern(pattern: Pattern, mode: Mode, today: CheckReading): boolean;
  coreCandidate(a: Attrs): boolean;
  blockAssignable(ex: ExerciseRecord): boolean;
  flareSafe(a: Attrs): boolean;

  // Proposal (mode): reasons are the profile's own words
  recoveryReason(ctx: ProposalCtx): string | null;
  buildChecks(ctx: ProposalCtx): Array<[ok: boolean, reason: string]>;
  buildLabel(ctx: ProposalCtx): string;

  // Progression
  entryClean(e: EntryFlags, s: SessionChecks): boolean;
  stepDownCause(e: EntryFlags, s: SessionChecks): "flag" | "symptom" | null;
  holdReason(today: CheckReading, last: SessionChecks | null): string | null;
  quietPhrase: string;

  // Selection, rotation, milestones
  flagPenaltyWeight: number;
  rotateReason(log: readonly EntryFlags[]): string | null;
  calmStreakLabel: string | null;

  // Care content: only when a program cares for this profile
  care: {
    block: CareBlock;
    coverageTargets: Partial<CoverageTargets>;
  } | null;
}

/** A check nobody answered. */
export const UNANSWERED: CheckReading = Object.freeze({ pre: null, post: null, feelingOff: false });
