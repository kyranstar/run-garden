import { APP_AUTHORED_ORIGINS } from "./watch-address.js";

/**
 * WHICH PLANNED WORKOUTS CAN BE REVISED — one predicate for the coach's revise and the Studio's document PUT
 * (workout-editability spec §3, §5). A workout is revisable unless there is a clear reason, and every reason carries a
 * path forward: `why` is what the athlete reads, `instead` is what they (or the coach) can do about it.
 *
 * A revisable row whose origin is not app-authored is ADOPTED by the revise (`adopts: true`): it becomes a Studio
 * document workout. Archived rows are `not_found` at the call sites, so `archived` is accepted but is not a reason here.
 */
export type RevisabilityReason = "programme" | "resolved" | "under_way" | "run" | "rest" | "race" | "past";

export interface RevisabilityInput {
  origin: string | null;
  category: string | null;
  sport: string | null;
  completionState: string | null;
  contentState: string | null;
  /** YYYY-MM-DD, compared with `today` as a string. */
  effectiveDate: string;
  archived?: boolean;
  hasDoc: boolean;
  /** From the workout document when there is one; null when there is none (sport/category then decide). */
  isRun: boolean | null;
}

export type Revisability =
  | { ok: true; adopts: boolean }
  | { ok: false; reason: RevisabilityReason; why: string; instead: string };

/** The words for each reason (spec §3's table, verbatim). `resolved`'s `why` follows the completion state. */
export const REVISABILITY_WORDS: Record<
  RevisabilityReason,
  { why: string | ((state: string) => string); instead: string }
> = {
  programme: {
    why: "It's a programme's session: the programme builds it on the day.",
    instead:
      "Put moves in its pool with pin_moves, change the programme with change_programme, or propose a new workout for that day and skip the slot with adjust_plan.",
  },
  resolved: {
    why: (state) => (state === "completed" ? "It's already done." : state === "skipped" ? "It was skipped." : "It was missed."),
    instead: "Propose a new workout.",
  },
  under_way: { why: "It's under way.", instead: "Propose one for later." },
  run: {
    why: "It's a run: runs are re-planned, not revised.",
    instead: "adjust_plan changes its length or eases it; propose a new run to replace it.",
  },
  rest: { why: "It's a rest day.", instead: "Propose a new workout for that day." },
  race: { why: "It's race day.", instead: "Leave it; design around it." },
  past: { why: "Its day has passed.", instead: "Propose for today or later." },
};

const RUN_CATEGORIES: readonly string[] = ["recovery", "easy", "long", "quality"];
const RESOLVED_STATES: readonly string[] = ["completed", "skipped", "missed"];

function refuse(reason: RevisabilityReason, state = ""): Revisability {
  const w = REVISABILITY_WORDS[reason];
  return { ok: false, reason, why: typeof w.why === "function" ? w.why(state) : w.why, instead: w.instead };
}

/** First match wins: past, resolved, under_way, race, rest, programme, run — else revisable. */
export function revisability(row: RevisabilityInput, today: string): Revisability {
  if (row.effectiveDate < today) return refuse("past");
  if (row.completionState && RESOLVED_STATES.includes(row.completionState)) return refuse("resolved", row.completionState);
  if (row.contentState === "started" || row.contentState === "done") return refuse("under_way");
  if (row.category === "race") return refuse("race");
  if (row.category === "rest") return refuse("rest");
  if (row.origin === "program" || row.origin === "on_demand") return refuse("programme");
  const run =
    row.isRun !== null ? row.isRun : row.sport === "run" || (row.category !== null && RUN_CATEGORIES.includes(row.category));
  if (run) return refuse("run");
  return { ok: true, adopts: !(APP_AUTHORED_ORIGINS as readonly (string | null)[]).includes(row.origin) };
}
