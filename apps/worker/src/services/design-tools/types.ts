import type { WorkoutDoc } from "@rg/domain";
import type { SetEstimate } from "../design-orchestrate.js";
import type { DocIssue } from "@rg/workout";
import type { Env } from "../../env.js";
import type { Db } from "../db.js";
import type { Athlete } from "./read-common.js";

/**
 * THE COACH DESIGNER'S TOOL CONTRACT (Stage 3 spec §4; principles §6.2). The step loop (coach-runs.ts) takes the tool
 * list as a dependency and is the only caller: it sends each tool's name, description and input schema to the model,
 * runs the calls the model makes in order while the request's statement budget allows, and turns what a tool answers
 * into the model's tool result and one line of the run's transparency trail.
 *
 * - A tool never throws at the model. It answers `ToolOk` or a teachable `ToolErr` (what was wrong, why, how to fix
 *   it); a throw is caught by the loop and answered as a generic `ToolErr`, never a stack.
 * - `statementCost` is the most D1 statements one call runs. The loop trusts it to keep a step within the Workers
 *   Free budget (≤ 45 statements + fetches per request), so a counting test pins every tool's declaration.
 * - `cpuWeight` is the CPU one call takes (ms, measured by the go-live CPU gate): the loop trusts it to keep a step
 *   within the free plan's 10 ms of CPU a request.
 * - A tool sees only the signed-in athlete's data: `ctx.userId` scopes every read and write.
 * - Text that came from outside the app's own code (the athlete's free text, notes, imported names) goes back to the
 *   model marked as data, `{ text, untrusted: true }`, never as an instruction.
 */

/** Who a run is: the main agent, a workout's designer, or that designer's independent reviewer (spec §5, §6). */
export type ToolRole = "main" | "designer" | "reviewer";

/** What a run is asked to design (`coach_runs.scope`). `auto` (the new shape §5): no time frame up front — the main
 * coach decides from the athlete's words whether to answer, design one workout, change the plan or plan a set. */
export type RunScopeKind = "now" | "later_today" | "week" | "next_n" | "auto";
export interface RunScope {
  kind: RunScopeKind;
  /** `next_n` only: how many workouts. */
  n?: number;
}

export interface ToolContext {
  db: Db;
  env: Env;
  userId: string;
  run: {
    id: string;
    role: ToolRole;
    scope: RunScope;
    parentId: string | null;
    /** A rehearsal run (the live scenario suite): whatever it proposes is stored with status `rehearsal`, never
     * shown in the app's lists. */
    rehearsal: boolean;
    /** A main run's conversation (the new shape §5): propose_workout's `replaces` names a suggestion of this one. */
    conversationId?: string;
  };
  now: Date;
  /**
   * The model's id for this call (`tool_use.id`), set by the loop. A step that died after a tool wrote and before
   * the state was stored replays the call with the same id, so a tool that writes keys its write on it and answers
   * a replay with what the first call stored (propose_workout, record_answer, remember). Absent outside the loop.
   */
  toolUseId?: string;
  /**
   * The independent review of a stored draft (spec §5; ruling 4), set by the loop when its deps review drafts:
   * propose_workout starts a reviewer sub-run through it and pauses. Absent outside the loop (and in deps without
   * review): a draft is stored unreviewed and never becomes pending.
   */
  review?: ReviewHooks;
  /** A reviewer's run: the draft it reviews (the loop sets it from the sub-run's state). */
  reviewOf?: ReviewOf;
  /**
   * A main run's set (Task 7; design-orchestrate.ts), set by the loop for the main run: the rounds planned so far, and
   * the start of a round's designer sub-runs. Absent outside the loop.
   */
  set?: SetHooks;
  /**
   * A set's redo designer (Task 7): the run whose workout this run's replaces once reviewed — its op stands until then,
   * so it never makes this run's revision of the same workout "taken" (propose_workout). Set by the loop from the
   * run's state.
   */
  replaces?: string;
  /**
   * The athlete as `readAthlete` reads them with no extras, read once for the step's calls (the loop sets it:
   * read-common.ts `sharedAthlete`): a read tool that needs nothing beside the athlete takes them from here
   * (`athleteOf`). Absent outside the loop: the tool reads its own.
   */
  athlete?: () => Promise<Athlete>;
}

export interface ToolOk {
  data: unknown;
  /** Where the data came from and how fresh it is. */
  provenance?: { source: string; asOf: string };
  /** What could not be read, said plainly ("no check-in today"). */
  missing?: string[];
  /** One plain line for the run view ("Checked recent work — legs last trained 5 days ago"). The loop writes a
   * generic line when a tool gives none. Never shown to the model. */
  summary?: string;
  /**
   * What the run view needs of this call beyond its line — an undo handle, the proposal a draft went into, a
   * memory's id. The loop puts it in the call's event payload. Never shown to the model. Small, bounded JSON.
   */
  receipt?: Record<string, unknown>;
  /**
   * `review`: the run pauses (`waiting_review`) while the reviewer sub-run this call started reviews its draft; the
   * call's result for the model is that review, given when the run resumes (design-review.ts).
   * `set`: the main run pauses (`waiting_set`) while the designer sub-runs plan_set started design the set; the call's
   * result for the model is the set's outcome, given when every designer is over (design-orchestrate.ts). `data` is
   * then the loop's: `{ round: SetRound, estimate? }`.
   */
  control?: "review" | "set";
}

// ── A set (Task 7; spec §6; principles §6.9; design-orchestrate.ts) ─────────────────────────────────────────────────

/** One workout of a set, as the main coach briefs it (plan_set). Model-written: the designer reads it as data. */
export interface SetBrief {
  /** The main coach's name for this workout of the set (its slot): unique in the set, and what a redo names. */
  key: string;
  date: string;
  time?: string;
  purpose: string;
  emphasis: string;
  constraints: string;
  why: string;
  /** Why a second session that day: needed when another brief, a programme session or a session already over holds
   * the date. */
  sameDayWhy?: string;
  /** A redo's: what to change from the first version, and why. */
  note?: string;
}

/** One call of plan_set: its briefs and the designer started for each (its id is the workout's op id). */
export interface SetRound {
  toolUseId: string;
  /** A second call, for specific keys of the first. */
  redo: boolean;
  briefs: SetBrief[];
  designers: Array<{ key: string; runId: string }>;
  /** A redo's: the designer whose workout each key's new one replaces once reviewed. */
  replaces?: Record<string, string>;
}

/** A designer sub-run to start: its id (keyed on the call and the brief), and its brief as its context will carry it. */
export interface SetDesignerStart {
  runId: string;
  key: string;
  brief: string;
  /** The brief's day: what a stop names when the designer never started. */
  date: string;
  /** A redo's: the designer whose workout this one replaces once reviewed. */
  replaces?: string;
}

/** What a set may still spend, from the step's tree (no statement). */
export interface SetBudget {
  /** The main run's ceiling: the whole set's. */
  ceilingMicros: number;
  /** What the main run's tree has spent, this step's model call included. */
  spentMicros: number;
  /** What the main run itself has spent (its own calls, this step's included). */
  mainSpentMicros: number;
  /** This set's own measured average per designer (its reviewers included), over the designers that ran and are over;
   * null before any has. */
  perDesignerMicros: number | null;
  /** The set's estimate from its first plan, when there is one. */
  estimate: SetEstimate | null;
}

/** The loop's side of a set (coach-runs.ts). */
export interface SetHooks {
  /** The rounds this main run has planned, as its state holds them (no statement). */
  rounds(): readonly SetRound[];
  /**
   * An auto run (the new shape §5) that plans a set: its ceiling raised to the set's, once — recorded in the run with a
   * set's window — before plan_set weighs the set against it. No statement (the step writes the run's state); nothing
   * for a run of a set's own scope, or one raised already.
   */
  raise?(): void;
  /**
   * Start the designers, in brief order: one insert, each keyed on its id — answers the ids inserted (none for a
   * designer that already exists: a replay starts nothing twice).
   */
  start(designers: SetDesignerStart[]): Promise<string[]>;
  /** What the set may still spend (no statement). */
  budget(): SetBudget;
  /**
   * The week's spend now and one model call's worst case (Task 13's fix wave, §2.11): what the step's own weekly read
   * gave, with its call's cost — or, in a step that called no model, one read. Absent: the week isn't weighed.
   */
  week?(): Promise<{ spentMicros: number; callWorstMicros: number }>;
  /** Whether any of these designers is already in the tree: a replay of the call that started them (no statement). */
  started(runIds: readonly string[]): boolean;
  /** A line a tool put in the proposal for one workout of the set (drop_workout's): kept with its key in the main
   * run's state, so a redo of the key that is designed takes it back. */
  keyLine(key: string, line: string): void;
}

// ── Review (spec §5; ruling 4; design-review.ts) ────────────────────────────────────────────────────────────────────

/** An independent review of a draft: a 1–5 score and a one-line note per dimension (design-prompt.ts
 * `REVIEW_DIMENSIONS`), the must-fix items and the improvements. The reviewer's own words: model-written text. */
export interface DesignReview {
  scores: Record<string, number>;
  notes: Record<string, string>;
  mustFix: string[];
  improvements: string[];
}

/**
 * The review a proposal's workout carries, for the athlete (Task 9 shows it): the kept version's review — or, when
 * it couldn't be read, empty scores and a `note` saying the validator's view stands — with how many drafts were
 * reviewed and what changed between them. Plain text only.
 */
export interface OpReview extends DesignReview {
  rounds: number;
  changes: string[];
  note?: string;
}

/** What propose_workout hands the reviewer: the draft as it would be stored, before it is. */
export interface DraftForReview {
  proposalId: string;
  target: { kind: "new"; date: string; time?: string } | { kind: "revise"; workoutId: string; baseRev: number };
  date: string;
  /** The validated document. */
  doc: WorkoutDoc;
  /** The validator's advisory issues, as the op keeps them (errors never reach review: they refuse the draft) — and the
   * tool layer's own (act-common.ts `CoachIssue`: a test whose move its measure doesn't read). */
  issues: Array<Pick<DocIssue, "path" | "message" | "fix"> & { code: DocIssue["code"] | "test_unmeasured" }>;
  derived: Record<string, unknown>;
  changeNote?: string;
}

/** What starts a draft's review: the reviewer sub-run's id, the round, the call that proposed it, and the draft. */
export interface ReviewStart {
  reviewRunId: string;
  proposalId: string;
  round: number;
  toolUseId: string;
  draft: DraftForReview;
}

/** The loop's side of a review (coach-runs.ts). */
export interface ReviewHooks {
  /**
   * Start the independent review of a stored draft: a reviewer sub-run under this run, with a fresh history and the
   * packet built from this run's tool results (never its reasoning). One statement: the sub-run's insert, keyed on
   * `reviewRunId` — answers false, inserting nothing, when that run already exists.
   */
  start(req: ReviewStart): Promise<boolean>;
  /** How a reviewer of this run's ended, from the step's tree (no statement); null when it isn't there or is live. */
  ended(reviewRunId: string): { status: string; error: string | null } | null;
}

/** The draft a reviewer run reviews: the proposal, the designer's run, and the call that proposed the draft. */
export interface ReviewOf {
  proposalId: string;
  designerRunId: string;
  toolUseId: string;
  round: number;
}

/** A teachable error: the model sees all three and can correct itself. */
export interface ToolErr {
  error: string;
  why: string;
  fix: string;
}

/**
 * A tool with a loop-level effect, once it answers `ToolOk`:
 * - `ask`: the run pauses (`waiting_athlete`) with the question as an event; the tool's result for the model is the
 *   athlete's answer, given when they answer (`POST /api/coach/runs/:id/answer`).
 * - `finish`: the run ends. `data.proposalId` (a string), when present, becomes the run's proposal. The reviewer's
 *   `submit_review` is its finish.
 * A call that started a review, or a set's designers (plan_set), pauses its run through its result instead
 * (`ToolOk.control`).
 */
export type ToolControl = "ask" | "finish";

export interface DesignTool<I = any> {
  name: string;
  /** What it is for, when to use it and when not to: the model reads this. */
  description: string;
  /** The JSON schema of `input`, sent to the model. */
  inputSchema: Record<string, unknown>;
  /** The most D1 statements one call runs (see above). */
  statementCost: number;
  /**
   * The Worker CPU one call takes, in milliseconds on the go-live CPU gate's reference machine (design-cpu-bench.test.ts
   * measures every tool and holds each declaration at or above its measured p50): a step starts a call only while its
   * weight still fits the step's CPU room (coach-runs.ts PENDING_STEP_CPU_ROOM / MODEL_STEP_CPU_ROOM), the rest stay
   * queued — as with statements.
   */
  cpuWeight: number;
  /**
   * The roles that may call it; a call from any other role is answered with a `ToolErr` (`not_for_role`). Every role
   * is offered every tool — one shared cache prefix (coach-runs.ts) — so a role-limited tool's description names its
   * roles.
   */
  roles: ToolRole[];
  control?: ToolControl;
  run(ctx: ToolContext, input: I): Promise<ToolOk | ToolErr>;
}

export function isToolErr(result: ToolOk | ToolErr): result is ToolErr {
  return typeof (result as ToolErr).error === "string";
}
