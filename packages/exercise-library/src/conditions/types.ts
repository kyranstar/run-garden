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
  /**
   * The mode's caps on the ratings. With the record — every reader that has one passes it — a profile may also judge the
   * move by what it is (TMJ never holds neck and posture care work to its neck-load caps); without it, by its ratings
   * alone.
   */
  fitsMode(a: Attrs, mode: Mode, ex?: ExerciseRecord): boolean;
  fitsFormat(a: Attrs, formatId: FormatId): boolean;
  allowPattern(pattern: Pattern, mode: Mode, today: CheckReading): boolean;
  /**
   * A rule on the whole record for today, beside `allowPattern` (optional; absent allows): for what one pattern can't
   * say, e.g. "plyometric moves never in recovery, nor while the athlete feels off".
   */
  allowRecord?(ex: ExerciseRecord, mode: Mode, today: CheckReading): boolean;
  /**
   * Why `allowRecord` holds this record back today, in the profile's own words (null when it allows it). The engine
   * shows it when a day's theme lost its moves to the rule (e.g. a jumping day while the athlete feels off).
   */
  recordReason?(ex: ExerciseRecord, mode: Mode, today: CheckReading): string | null;
  coreCandidate(a: Attrs): boolean;
  blockAssignable(ex: ExerciseRecord): boolean;
  flareSafe(a: Attrs): boolean;
  /**
   * The profile's flare definition (one-workout-system spec §6: "a flare (profile-defined)"): a day whose reading
   * meets it is a flare day — counted on the Progress condition tile, and the day the flare-safe rules exist for: a
   * recovery day on a flare reading takes flare-safe moves only (eligibility's `fitsMode` with the day's checks).
   */
  flare(reading: CheckReading): boolean;

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

  /**
   * The rules above in plain sentences, one per line, for the coach designer's opening context (Stage 3 spec §3).
   * Generated from the same constants the rules read — never written beside them — so the prompt and the code cannot
   * disagree. Each line names the member it describes (`rule`); how that member is enforced (refused, a cost, or only a
   * guide the engine's own sessions follow) is the reader's to say from where the member is read, never the line's.
   * It speaks of the profile and its readings, never of a person.
   */
  describeRules(): RuleLine[];
}

/** The members of a profile a `describeRules` line can describe. */
export type DescribedRule = Extract<
  keyof ConditionProfile,
  | "attributes"
  | "never"
  | "allowPattern"
  | "allowRecord"
  | "fitsMode"
  | "fitsFormat"
  | "flare"
  | "recoveryReason"
  | "buildChecks"
  | "stepDownCause"
  | "holdReason"
  | "rotateReason"
  | "care"
>;

/** One rule in words: the member it is generated from, and a plain sentence (no enforcement word of its own). */
export interface RuleLine {
  rule: DescribedRule;
  text: string;
}

/** A check nobody answered. */
export const UNANSWERED: CheckReading = Object.freeze({ pre: null, post: null, feelingOff: false });
