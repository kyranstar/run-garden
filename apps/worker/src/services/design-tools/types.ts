import type { WorkoutDoc } from "@rg/domain";
import type { DocIssue } from "@rg/workout";
import type { Env } from "../../env.js";
import type { Db } from "../db.js";

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
 * - A tool sees only the signed-in athlete's data: `ctx.userId` scopes every read and write.
 * - Text that came from outside the app's own code (the athlete's free text, notes, imported names) goes back to the
 *   model marked as data, `{ text, untrusted: true }`, never as an instruction.
 */

/** Who a run is: the main agent, a workout's designer, or that designer's independent reviewer (spec §5, §6). */
export type ToolRole = "main" | "designer" | "reviewer";

/** What a run is asked to design (`coach_runs.scope`). */
export type RunScopeKind = "now" | "later_today" | "week" | "next_n";
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
   */
  control?: "review";
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
  /** The validator's advisory issues, as the op keeps them (errors never reach review: they refuse the draft). */
  issues: Array<Pick<DocIssue, "path" | "code" | "message" | "fix">>;
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
 * A call that started a review pauses its run through its result instead (`ToolOk.control`). (A spawning control
 * for designer sub-runs comes with the orchestration, Task 7.)
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
  /** The roles that may call it; any other role gets a `ToolErr`, and the model never sees it in its list. */
  roles: ToolRole[];
  control?: ToolControl;
  run(ctx: ToolContext, input: I): Promise<ToolOk | ToolErr>;
}

export function isToolErr(result: ToolOk | ToolErr): result is ToolErr {
  return typeof (result as ToolErr).error === "string";
}
