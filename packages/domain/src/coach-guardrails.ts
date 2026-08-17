import { addDays } from "./time.js";
import { addOpDates, sessionSport } from "./coach.js";
import type { CoachOp, CoachSession } from "./coach.js";

/**
 * The floor outside the model (spec §4): pure, exhaustive, unit-tested.
 *
 * EVERY RULE IS EITHER FATAL OR ADVISORY, AND THE CHOICE IS DATA (2026-08-17).
 *
 * Until tonight every rule in this file was a hard rejection, and a single
 * objection binned the whole proposal — seven ops and $0.397 of thinking, gone,
 * with the athlete never told what was on the table. Verbatim, from prod: the
 * athlete asked for "3 real sessions as a compromise", the coach wrote three
 * and reasoned about what they cost, and `hard_adjacency` refused on the
 * athlete's behalf because two of the days it chose were next to each other.
 *
 * Nothing in this product is autonomous. Every proposal is a card with an
 * approve button on it. A rule that silently discards a plan the athlete never
 * sees is not protecting them from harm — it is protecting them from
 * information they asked for. So:
 *
 *   FATAL     the proposal is WRONG, not merely aggressive. It edits the past,
 *             names a session that does not exist, or asks for a mutation the
 *             apply cannot perform. Approving it would produce a broken plan
 *             rather than a risky one, so it is rejected — and then the wake
 *             gets a bounded convergence retry to fix it, because these are
 *             exactly the errors a model can correct when told what is legal.
 *
 *   ADVISORY  every judgement about load: adjacency, ramp, cold start, rest
 *             days, tapers, race weeks, plan horizons. These become trade-off
 *             lines on the proposal ("The trade-off — …", rendered directly
 *             above the approve/decline buttons) and the athlete decides.
 *
 * {@link RULE_CLASS} is the single place that choice is recorded, it is a
 * `Record` over a closed union, and `validateOps` routes through it — so a new
 * rule is a compile error until someone chooses a side for it, and
 * coach-guardrails.test.ts fails until someone writes the case that proves it.
 *
 * Advisory text is written to earn the athlete's judgement, not to nag: what
 * the cost is, in their terms, once. Fatal text is written for the receipt.
 */

export interface GuardrailWorkout {
  id: string;
  date: string;
  category: string;
  completionState: string;
  durationMinutes: number;
  discipline: "run" | "strength" | "yoga";
}

export interface SoftRule {
  id: string;
  /** anchor_day: category must stay on weekday; fixed_slot: same test. */
  kind: "anchor_day" | "fixed_slot";
  category: string;
  /** ISO weekday 1 (Mon) .. 7 (Sun). */
  weekday: number;
}

/**
 * Something dated the athlete told the coach about — a trip, a holiday, a
 * week away. Extracted from coach memory (`datedEventsFromMemory`), because
 * memory is the only place in this app that remembers them: they are not
 * races, they are not planned workouts, and nothing else in the schema has
 * a slot for "I am skiing on the 26th".
 */
export interface DatedEvent {
  /** The memory row's id — so a violation can point at what it read. */
  id: string;
  /** Short human label for the athlete-facing message ("ski trip"). */
  label: string;
  date: string;
}

export interface GuardrailCtx {
  today: string;
  workouts: GuardrailWorkout[];
  /** Trailing 4 completed weeks of training minutes, oldest first. */
  weeklyMinutesByDiscipline: Record<string, number[]>;
  raceDates: string[];
  /** Latest firm-detail date across active coached plans. */
  firmHorizonEnd: string;
  rules: SoftRule[];
  /**
   * Every plan id the coach authored (any status). Structural ops
   * (reshape/firmUp/extend/windDown/retire) may only touch these — imported
   * COROS plans are structurally read-only, though their individual sessions
   * remain fair game for ease/move/skip.
   */
  coachPlanIds: string[];
  /** Dated things the athlete cares about, from coach memory. */
  datedEvents: DatedEvent[];
}

export interface Violation {
  /** A {@link GuardrailRule}, or — for a standing-rule finding — the coach
   * memory row's id, because that row's own words are what the athlete reads. */
  rule: string;
  opIndex: number;
  detail: string;
}

/**
 * Every rule this file can find. Closed on purpose: {@link RULE_CLASS} is a
 * `Record` over it, so adding a member without classifying it does not compile.
 */
export type GuardrailRule =
  | "touch_resolved"
  | "unknown_workout"
  | "past_date"
  | "imported_plan_structure"
  | "runaway_size"
  | "hard_adjacency"
  | "ramp"
  | "cold_start"
  | "no_rest_day"
  | "race_week_intensity"
  | "event_taper"
  | "beyond_horizon"
  | "never_skip_race";

export type RuleClass = "fatal" | "advisory";

/**
 * THE SPLIT, with the defence of each placement.
 *
 * The test for FATAL is not "is this dangerous" — the athlete is looking at an
 * approve button and can judge danger themselves. It is "would approving this
 * produce a broken plan rather than a risky one": an op the apply cannot
 * perform, a row it would write into the past, an id that resolves to nothing.
 * Those four are the whole list, and each one is also the kind of mistake a
 * model fixes on the first retry once it is told what IS legal.
 *
 * Everything else is a training judgement. The coach is shown the number
 * before it plans (HARD_LIMITS_PROMPT + the dossier's LIMITS section), and if
 * it spends the budget anyway the athlete is shown what it cost and decides.
 * That is the whole product: the coach proposes, the athlete approves.
 */
export const RULE_CLASS: Record<GuardrailRule, RuleClass> = {
  /** The row is already resolved, or its day has gone. The apply would write
   * history — and a completed session's result is a fact, not a plan. */
  touch_resolved: "fatal",
  /** ease/move/skip naming an id that is not on the calendar. `applyOps`
   * UPDATEs zero rows and reports success: the athlete taps approve, the
   * receipt says approved, and nothing whatsoever happens. */
  unknown_workout: "fatal",
  /** A session dated before today. `insertSession` would happily create it,
   * and the athlete would find work on a day they have already lived. */
  past_date: "fatal",
  /** reshapeWeek/firmUp/extendPlan/windDown/retirePlan against a plan the
   * coach did not author. `archiveWeek` and `retirePlan` no-op on the
   * authorship guard while `firmUp`/`extendPlan` write rows into a plan that
   * has no coach_plans row at all — half the op silently lands. */
  imported_plan_structure: "fatal",
  /**
   * One proposal that would write more sessions than an approval can execute.
   *
   * This rule is the OTHER HALF of the schema's 2026-08-17 loosening. The
   * array caps in coach.ts were sized for a runaway model rather than for real
   * work — 14 dates on an add, 12 blocks in a run — and they refused a
   * three-week daily mobility piece and a 12×400m session while a determined
   * model could still write 20 ops of 14 dates. Now the caps fit real work and
   * the runaway is caught HERE, where it belongs: `applyOps` does several
   * writes per session inside one request, and a proposal of hundreds cannot
   * finish inside a Worker's subrequest budget — the athlete would tap approve
   * and get a half-written plan. Fatal, and refusing it costs one proposal
   * rather than the whole wake, which is exactly why it moved.
   */
  runaway_size: "fatal",

  /** Two hard days in a row. Real, and real is exactly why the athlete gets
   * to decide: front-loading before a trip is a legitimate thing to buy. */
  hard_adjacency: "advisory",
  /** More than a 10% weekly step in a discipline. A judgement, and one the
   * athlete may knowingly take for a specific week. */
  ramp: "advisory",
  /** A big first block in a discipline with no recent history. Same. */
  cold_start: "advisory",
  /** A week that ends up with work on all seven days. Same. */
  no_rest_day: "advisory",
  /** New intensity inside race week. The athlete owns their race. */
  race_week_intensity: "advisory",
  /** Hard work in the 48h before a dated event. Same. */
  event_taper: "advisory",
  /** A session dated past the end of the planned weeks. Applies perfectly
   * well — `add` mints a "Coach one-offs" plan for exactly this — so it was
   * never more than a note about tidiness, and as a rejection it was a
   * catastrophe: an athlete with an empty calendar has `firmHorizonEnd ===
   * today`, which made EVERY future session the coach proposed illegal. */
  beyond_horizon: "advisory",
  /** Skipping a race. Nothing breaks; the athlete may simply not be running
   * it. Taking their race off the plan without asking is the wrong side. */
  never_skip_race: "advisory",
};

const HARD_CATEGORIES = new Set(["quality", "long", "race"]);
/**
 * Strength counts as a hard day from 30 minutes — not 60 (2026-08-16).
 *
 * At 60 a 45-minute leg session was not "hard", so `hard_adjacency` could
 * never fire for one, and the rule perversely rewarded prescribing
 * 55-minute sessions the day after a long run. Nobody writes a 60-minute
 * strength session in a running plan; 30 is where a lift stops being a
 * filler and starts costing the next day.
 */
const HARD_LIFT_MINUTES = 30;
/**
 * …and below this, a strength/mobility session is the "costs nothing" daily
 * piece a coach is supposed to be able to give: a few holds, some ankle
 * work. It is never a hard day and never uses up a rest day, however
 * detrained the athlete is.
 */
const TRIVIAL_LIFT_MINUTES = 15;
/**
 * Trailing weekly minutes at or below this = no meaningful history in that
 * discipline. One strength session in seven months averages under three
 * minutes a week; the athlete this whole file was rewritten for was at zero.
 */
const DETRAINED_WEEK_MINUTES = 20;
/**
 * What a first week back in a discipline may hold, counting only LOADING
 * minutes (the trivial daily piece is free). Two 45s, or three 40s. The
 * percentage ramp cannot express this: 10% of nothing is nothing, so
 * without an absolute floor the ramp guard is silent exactly for the
 * athlete it exists to protect.
 */
const COLD_START_WEEK_MINUTES = 120;
/** Days before a dated event that stay easy. Two: the soreness peak from an
 * unaccustomed bout lands 24–48h later, i.e. on the trip. */
const EVENT_TAPER_DAYS = 2;

const RAMP_CAP = 1.1;
const RACE_WINDOW_DAYS = 7;
/**
 * The most sessions ONE proposal may write. Two months of daily work, or a
 * whole 20-week block firmed up at six a week, both fit under it; nothing a
 * coach writes on purpose comes close, and an approval past it cannot finish
 * inside one request (each session is an insert plus its stages plus, when
 * writes are on, a queued watch job).
 */
const MAX_PROPOSAL_SESSIONS = 120;

/**
 * Every number this file enforces, in one place, because the MODEL IS NOW
 * SHOWN THEM (2026-08-17).
 *
 * The coach was being judged against limits it could not read: the wake
 * prompt named the KINDS of hard limit ("a first block in a discipline you
 * have no recent history in") without a single figure, and the live ski-prep
 * wake proposed 313 minutes of strength against a 120-minute ceiling. It had
 * no way to know. So `HARD_LIMITS_PROMPT` (the generic rules) and
 * `athleteLimitLines` (this athlete's remaining budget, in the dossier) are
 * both GENERATED from the constants below rather than retyped into prose — a
 * stated ceiling that has drifted from the enforced one is worse than saying
 * nothing, because the coach would then plan carefully against a number that
 * still rejects it.
 */
export const GUARDRAIL_LIMITS = {
  /** Categories that are hard whatever the clock says. */
  hardCategories: [...HARD_CATEGORIES] as readonly string[],
  hardLiftMinutes: HARD_LIFT_MINUTES,
  trivialLiftMinutes: TRIVIAL_LIFT_MINUTES,
  detrainedWeekMinutes: DETRAINED_WEEK_MINUTES,
  coldStartWeekMinutes: COLD_START_WEEK_MINUTES,
  eventTaperDays: EVENT_TAPER_DAYS,
  rampCap: RAMP_CAP,
  raceWindowDays: RACE_WINDOW_DAYS,
  maxProposalSessions: MAX_PROPOSAL_SESSIONS,
} as const;

/**
 * The generic half of the budget, for the wake system prompt. Every number in
 * it is interpolated from {@link GUARDRAIL_LIMITS}; the athlete-specific half
 * (what is LEFT of each allowance this week) is `athleteLimitLines`, which
 * belongs in the dossier because only the dossier knows the calendar.
 *
 * Principles, not cases: these are the rules as `validateOps` applies them to
 * anyone, phrased so a model can count against them before it writes.
 *
 * IT NOW STATES THE SPLIT, because a prompt that lies about the consequence is
 * worse than one that says nothing (2026-08-17). This block used to open with
 * "Breaking ONE rejects the WHOLE proposal", and after tonight that is true of
 * three rules and false of eight. A model told that every number is a wall
 * plans to the wall and then apologises for the wall; a model told which ones
 * are walls and which ones are prices it may pay — out loud, with a reason —
 * writes the plan the athlete actually asked for.
 */
export const HARD_LIMITS_PROMPT = [
  `THE ENFORCED NUMBERS — checked outside you, against the calendar AS YOUR OPS LEAVE IT. Two kinds, and the difference decides how you write. The dossier's LIMITS section carries this athlete's actual figures and what is left of each.`,
  ``,
  `REJECTED OUTRIGHT — a proposal doing one of these is not a bold plan, it is a broken one, and the athlete never sees it:`,
  `- THE PAST IS FIXED: no op dated before today, and no op on a session already completed, skipped or missed.`,
  `- REAL SESSIONS ONLY: ease/move/skip must name a [wo:...] id that appears in this dossier. An id that isn't there changes nothing at all when approved.`,
  `- IMPORTED PLANS KEEP THEIR STRUCTURE: reshapeWeek/firmUp/extendPlan/windDown/retirePlan may only name a plan YOU authored (PLANS says which). An imported plan's individual sessions are still yours to ease, move, skip or add around — that is how you restructure one.`,
  `- ONE PROPOSAL WRITES AT MOST ${MAX_PROPOSAL_SESSIONS} SESSIONS, counting every date on an add and every session in a structural op. Long enough for two months of daily work or a whole firmed-up block; past it the approval cannot finish, so split the work across proposals.`,
  ``,
  `DISCLOSED TO THE ATHLETE — these do NOT reject anything. Each one the app finds is printed on the proposal as a trade-off, directly above the approve button, and they decide. So they are yours to spend deliberately: plan inside them, and when you go past one on purpose, give the reason in the rationale. Spending one you hadn't noticed is the failure; spending one you can defend is coaching.`,
  `- HARD IS DEFINED: a session in category ${[...HARD_CATEGORIES].join("/")}, or a strength session of ${HARD_LIFT_MINUTES}min or more — and in a discipline they have barely touched (${DETRAINED_WEEK_MINUTES}min/week or less over the last 4 weeks), any strength session of ${TRIVIAL_LIFT_MINUTES}min or more. Under ${TRIVIAL_LIFT_MINUTES}min is never hard, and neither is mobility work of any length.`,
  `- HARD DAYS NEVER TOUCH: two consecutive hard days cost the second one. Easing or skipping a side is how you make room — the check reads the calendar AFTER your ops, so a hard day you eased is no longer hard.`,
  `- RAMP: in any week you touch, a discipline's total minutes above ${Math.round(RAMP_CAP * 100)}% of its 4-week trailing average is a step up worth naming.`,
  `- COLD START: in a discipline at ${DETRAINED_WEEK_MINUTES}min/week or less, ${COLD_START_WEEK_MINUTES}min of HARD work in a week is already a big first block — counting what is ALREADY on the calendar, not just what you add.`,
  `- REST DAY: a week you leave with work on all seven days has no day off in it.`,
  `- EVENT TAPER: hard work on a dated event's day, or the ${EVENT_TAPER_DAYS} days before it, arrives as soreness on the day itself.`,
  `- RACE WEEK: a new quality session in the ${RACE_WINDOW_DAYS} days before a race spends freshness.`,
  `- PLAN HORIZON: a session past the last planned day lands as a one-off rather than part of a block; propose extendPlan or createPlan when you mean a block.`,
  ``,
  `DO NOT PUT ANY OF THE DISCLOSED FINDINGS IN "flags" — the app computes each one and prints it, the same rule as the manifest. "flags" is for the trade-offs only you can see ("eases Tuesday's 10K-pace intervals in a build week"). Your job is the reasoning: why the cost is worth it.`,
].join("\n");

interface CalEntry {
  /**
   * The planned-workout id this entry came from, or null for one the ops
   * invented. Identity, not (date, category): two run rows on one day is
   * ordinary — the fixture calendar has two on Tuesday 08-18 — and matching
   * on date+category resolved both of them to whichever came first, so an
   * ease of the second silently rewrote the first (2026-08-16).
   */
  id: string | null;
  date: string;
  category: string;
  durationMinutes: number;
  discipline: string;
  /** Introduced or rewritten by these ops (drives race-week "new intensity"). */
  fromOp: number | null;
  /** Already trained. Only `hard_adjacency` reads it, and only to word its
   * advisory honestly — see the note on that rule. */
  done: boolean;
}

function isoWeekday(date: string): number {
  const d = new Date(`${date}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "Tue 18 Aug". Every `detail` below is read by the ATHLETE — a rejected
 * proposal's reasons are printed verbatim into the receipt that explains
 * why their plan didn't change (coach-wake.ts `lostWorkBody`). "2026-08-18"
 * and "429min > 152min cap" are notes to a developer, not an answer to a
 * person who asked for a training week.
 */
function humanDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}`;
}

const DISCIPLINE_WORD: Record<string, string> = {
  run: "running",
  strength: "strength work",
  yoga: "mobility work",
};
const disciplineWord = (d: string): string => DISCIPLINE_WORD[d] ?? d;

function mondayOf(date: string): string {
  return addDays(date, -(isoWeekday(date) - 1));
}

/** The same total mapping the apply uses — a mobility session is yoga, not
 * a run (2026-08-16: the binary fallback lived here too, so a coached yoga
 * session was charged against the athlete's RUNNING ramp allowance). */
function disciplineOfSession(s: CoachSession): "run" | "strength" | "yoga" {
  return sessionSport(s);
}

/** Trailing weekly average in a discipline, or null when we have nothing. */
function trailingAvg(ctx: GuardrailCtx, discipline: string): number | null {
  const weeks = ctx.weeklyMinutesByDiscipline[discipline];
  if (!weeks || weeks.length === 0) return null;
  return weeks.reduce((a, b) => a + b, 0) / weeks.length;
}

/** No usable recent history in this discipline — a first session back is a
 * hard day whatever the clock says it is. */
function isDetrained(ctx: GuardrailCtx, discipline: string): boolean {
  const avg = trailingAvg(ctx, discipline);
  return avg === null || avg <= DETRAINED_WEEK_MINUTES;
}

type Loadish = { category: string; durationMinutes: number; discipline: string };

function isHard(e: Loadish, ctx: GuardrailCtx): boolean {
  if (HARD_CATEGORIES.has(e.category)) return true;
  if (e.discipline !== "strength") return false;
  if (e.durationMinutes < TRIVIAL_LIFT_MINUTES) return false;
  // Duration is the only intensity signal a lift has. Absent recent
  // strength history, duration understates it badly: 25 minutes of
  // unaccustomed eccentric work wrecks a next-day run in a way the same 25
  // minutes never would for someone who lifts twice a week.
  return e.durationMinutes >= HARD_LIFT_MINUTES || isDetrained(ctx, "strength");
}

/**
 * Whether this entry uses the day up. A rest row doesn't, and neither does
 * the few-minute mobility or holds piece the coach is encouraged to give
 * daily — otherwise the no-rest-day rule would forbid the very thing that
 * makes "daily" a safe answer.
 */
function isLoading(e: Loadish): boolean {
  if (e.category === "rest") return false;
  if ((e.discipline === "strength" || e.discipline === "yoga") && e.durationMinutes < TRIVIAL_LIFT_MINUTES) {
    return false;
  }
  return true;
}

/** Days in [week, week+6] carrying real work. */
function loadedDaysIn(entries: Array<{ date: string } & Loadish>, week: string): Set<string> {
  const weekEnd = addDays(week, 6);
  const days = new Set<string>();
  for (const e of entries) {
    if (e.date >= week && e.date <= weekEnd && isLoading(e)) days.add(e.date);
  }
  return days;
}

/**
 * Minutes of one discipline inside [week, week+6] — the two sums the two
 * volume rules compare against, in one function so the dossier can state the
 * SAME arithmetic the validator applies. `hardOnly` is the cold-start count
 * (loading work); otherwise it is the ramp count (everything but rest).
 */
function weekMinutes(
  entries: Array<{ date: string } & Loadish>,
  week: string,
  discipline: string,
  ctx: GuardrailCtx,
  hardOnly: boolean,
): number {
  const weekEnd = addDays(week, 6);
  let total = 0;
  for (const e of entries) {
    if (e.date < week || e.date > weekEnd) continue;
    if (e.discipline !== discipline) continue;
    if (hardOnly ? !isHard(e, ctx) : e.category === "rest") continue;
    total += e.durationMinutes;
  }
  return total;
}

/** The calendar as the guardrails see it before any op — skipped and missed
 * sessions are already gone, exactly as `resultingCalendar` starts. */
function liveWorkouts(ctx: GuardrailCtx): GuardrailWorkout[] {
  return ctx.workouts.filter((w) => !["skipped", "missed"].includes(w.completionState));
}

/** How many weeks of budget the dossier states. Two full weeks plus the
 * current one is the whole horizon a wake ever plans inside; beyond that the
 * numbers are noise the athlete pays for in input tokens. */
const LIMIT_WEEKS = 3;

/**
 * THIS athlete's remaining budget, for the dossier — the other half of
 * {@link HARD_LIMITS_PROMPT}.
 *
 * The generic rules belong in the prompt because they never change; the
 * numbers below cannot live there, because "120 minutes is your cold-start
 * ceiling" is useless next to a week that already holds 112 of them. Every
 * figure is computed by the same helpers `validateOps` uses, from the same
 * `GuardrailCtx` the validation will run against, so what the coach is told
 * it has left is precisely what it will be allowed to spend.
 */
export function athleteLimitLines(ctx: GuardrailCtx): string[] {
  const live = liveWorkouts(ctx);
  const weeks: string[] = [];
  for (let i = 0, w = mondayOf(ctx.today); i < LIMIT_WEEKS; i++, w = addDays(w, 7)) weeks.push(w);

  const lines = [
    "the numbers for this athlete, from the same code that checks your reply. These are the DISCLOSED kind: going past one does not reject anything, it prints a trade-off line on your proposal for the athlete to weigh. Plan inside them; when you spend one on purpose, say why in the rationale.",
    `the last planned day is ${ctx.firmHorizonEnd}; anything after it lands as a one-off unless it is firmUp/extendPlan/reshapeWeek/windDown/createPlan.`,
  ];

  // Volume, per discipline: the ramp ceiling, or the absolute cold-start one
  // when there is no history to take a percentage of.
  const disciplines = [...new Set(["run", "strength", ...live.map((w) => w.discipline)])];
  for (const disc of disciplines) {
    const avg = trailingAvg(ctx, disc);
    const word = disciplineWord(disc);
    if (isDetrained(ctx, disc)) {
      const spent = weeks.map((w) => {
        const held = weekMinutes(live, w, disc, ctx, true);
        return `${w} holds ${Math.round(held)}min (${Math.max(0, COLD_START_WEEK_MINUTES - Math.round(held))}min left)`;
      });
      lines.push(
        `${word}: ${avg === null ? "no history at all" : `${Math.round(avg)}min/week over 4 weeks`} — COLD START, so the ceiling is an absolute ${COLD_START_WEEK_MINUTES}min of HARD work per week, their own scheduled sessions included: ${spent.join(" · ")}.`,
      );
    } else {
      // FLOOR, not round: a stated ceiling must never be above the enforced
      // one, or the coach plans to the number it was given and is rejected by
      // the number that counts. Erring under costs at most a minute.
      const cap = Math.floor(avg! * RAMP_CAP);
      const spent = weeks.map((w) => {
        const held = Math.round(weekMinutes(live, w, disc, ctx, false));
        return `${w} holds ${held}min (${held >= cap ? "already at the cap — add none" : `${cap - held}min left`})`;
      });
      lines.push(
        `${word}: ${Math.round(avg!)}min/week over 4 weeks → weekly ceiling ${cap}min: ${spent.join(" · ")}.`,
      );
    }
  }

  // Adjacency and rest, as days — UPCOMING carries no durations, so this is
  // the only place the coach can see which existing sessions COUNT as hard.
  //
  // It starts YESTERDAY, not today (2026-08-17). `hard_adjacency` reads the
  // whole calendar, including a session already completed, so a hard day
  // yesterday makes today's hard session the second of a pair — and the coach
  // could not see that, because this list began at today. It met the finding
  // for the first time in a rejection, about a day it cannot change. Nothing
  // earlier than yesterday can be adjacent to anything the coach may write.
  const weekEnd = addDays(weeks[weeks.length - 1]!, 6);
  const inWindow = live.filter((w) => w.date >= addDays(ctx.today, -1) && w.date <= weekEnd);
  const hardDays = [...new Set(inWindow.filter((w) => isHard(w, ctx)).map((w) => w.date))].sort();
  lines.push(
    hardDays.length
      ? `already hard, so anything hard on the day before or after one of these is a back-to-back pair the athlete gets told about: ${hardDays.join(", ")}${hardDays[0]! < ctx.today ? " (the first is yesterday — already done, so only easing what comes AFTER it helps)" : ""}. Easing or skipping a future one opens its neighbours up.`
      : "no hard days between yesterday and the end of that window.",
  );
  for (const w of weeks) {
    const loaded = loadedDaysIn(live, w);
    const free = Array.from({ length: 7 }, (_, i) => addDays(w, i)).filter((d) => !loaded.has(d));
    // A rest day that has already happened still satisfies the rule, but it
    // is not a day the coach can plan into — so the count is all seven days
    // and the LIST is only what is still ahead.
    const ahead = free.filter((d) => d >= ctx.today);
    lines.push(
      free.length === 0
        ? `week of ${w}: all seven days already carry work — you did not do that, so it is not laid at your door, but adding to it is.`
        : `week of ${w}: ${free.length} free day${free.length === 1 ? "" : "s"}, ` +
          (ahead.length ? `${ahead.join(", ")} still ahead` : "all of them already past, so the week keeps its day off") +
          ` — fill the last one and the week has no rest day.`,
    );
  }

  // The two dated windows, spelled out as the days they cover.
  for (const ev of ctx.datedEvents) {
    if (ev.date < ctx.today) continue;
    lines.push(
      `hard work on ${addDays(ev.date, -EVENT_TAPER_DAYS)}–${ev.date} arrives as soreness on ${ev.label} (${ev.date}).`,
    );
  }
  for (const race of ctx.raceDates) {
    if (race < ctx.today) continue;
    lines.push(`a new quality session on ${addDays(race, -RACE_WINDOW_DAYS)}–${addDays(race, -1)} spends race-week freshness — race ${race}.`);
  }
  return lines;
}

/**
 * WHAT THE COACH MAY DO RIGHT NOW, for a convergence retry.
 *
 * The wake's guardrail repair used to hand back only the violation, and it was
 * useless for exactly the reason a compiler error without the type is useless:
 * the model was told what was wrong and not what was allowed, so it guessed,
 * and the guess broke the same rule a different way. This is the other half —
 * the structural facts the FATAL rules test against (today, the ids that
 * exist, the plans it authored), followed by {@link athleteLimitLines}, which
 * is the budget it was already shown in the dossier and must still respect.
 *
 * Derived from the SAME `GuardrailCtx` the retry will be judged against, so
 * what the coach is told it may do is precisely what it will be allowed to do.
 */
export function allowedNowLines(ctx: GuardrailCtx): string[] {
  const targetable = ctx.workouts
    .filter((w) => w.completionState === "scheduled" || w.completionState === "planned")
    .filter((w) => w.date >= ctx.today)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return [
    `today is ${ctx.today}. Nothing you write may be dated before it.`,
    targetable.length > 0
      ? `the ONLY ids ease/move/skip may name (everything else on your calendar is resolved or gone): ${targetable
          .slice(0, 40)
          .map((w) => `[wo:${w.id}] ${w.date} ${w.category}`)
          .join(" · ")}.`
      : `there is nothing on the calendar to ease, move or skip — only add/createPlan can put work there.`,
    ctx.coachPlanIds.length > 0
      ? `plans you authored, and the only ones reshapeWeek/firmUp/extendPlan/windDown/retirePlan may name: ${ctx.coachPlanIds.join(", ")}.`
      : `you have authored no plans, so reshapeWeek/firmUp/extendPlan/windDown/retirePlan have nothing legal to name — restructure by composition (ease/move/skip the sessions that exist, add your own around them) or createPlan a new block.`,
    ...athleteLimitLines(ctx),
  ];
}

/**
 * Dated events out of coach memory. The coach is told to write the date as
 * YYYY-MM-DD inside the note text, and this is the only reader of that
 * convention — deliberately strict, because guessing a date out of "the
 * 26th" against a rolling `expiresAt` produces phantom events and phantom
 * rejections. A memory row with no ISO date in it simply isn't an event.
 */
export function datedEventsFromMemory(
  rows: Array<{ id: string; body: string; active?: boolean }>,
): DatedEvent[] {
  const out: DatedEvent[] = [];
  for (const r of rows) {
    if (r.active === false) continue;
    const m = r.body.match(/\d{4}-\d{2}-\d{2}/);
    if (!m) continue;
    // The label is the prose before the date, trimmed of joining words —
    // "Ski trip 2026-08-26 to…" → "Ski trip". Falls back to the whole line.
    const head = r.body.slice(0, m.index).replace(/[\s,–—-]*(?:on|from|starting|is|are|the)?[\s,–—-]*$/i, "").trim();
    out.push({ id: r.id, label: (head || r.body).slice(0, 60), date: m[0] });
  }
  return out;
}

/** Apply ops to the known calendar, tracking which entries ops introduced. */
function resultingCalendar(ops: CoachOp[], ctx: GuardrailCtx): CalEntry[] {
  const cal: CalEntry[] = ctx.workouts
    .filter((w) => !["skipped", "missed"].includes(w.completionState))
    .map((w) => ({
      id: w.id,
      date: w.date,
      category: w.category,
      durationMinutes: w.durationMinutes,
      discipline: w.discipline,
      fromOp: null,
      done: w.completionState === "completed",
    }));
  const entryFor = (id: string): CalEntry | undefined => cal.find((e) => e.id === id);

  ops.forEach((op, i) => {
    switch (op.kind) {
      case "ease": {
        const e = entryFor(op.workoutId);
        if (e) {
          e.category = op.session.category;
          e.durationMinutes = op.session.durationMinutes;
          e.discipline = disciplineOfSession(op.session);
          e.fromOp = i;
        }
        break;
      }
      case "move": {
        const e = entryFor(op.workoutId);
        if (e) {
          e.date = op.toDate;
          e.fromOp = i;
        }
        break;
      }
      case "swap": {
        for (const e of cal) {
          if (e.date === op.dayA) {
            e.date = op.dayB;
            e.fromOp = i;
          } else if (e.date === op.dayB) {
            e.date = op.dayA;
            e.fromOp = i;
          }
        }
        break;
      }
      case "skip": {
        const idx = cal.findIndex((e) => e.id === op.workoutId);
        if (idx >= 0) cal.splice(idx, 1);
        break;
      }
      case "add":
        // One op, one session, N dates (2026-08-17). Every date is a real
        // day of load: a recurring piece written as ONE op must weigh exactly
        // what the same piece written as N ops weighed, or the cheaper
        // vocabulary would also be the way around the ramp check.
        for (const date of addOpDates(op)) {
          cal.push({
            id: null,
            date,
            category: op.session.category,
            durationMinutes: op.session.durationMinutes,
            discipline: disciplineOfSession(op.session),
            fromOp: i,
            done: false,
          });
        }
        break;
      case "reshapeWeek":
      case "firmUp":
      case "windDown":
        for (const s of op.sessions) {
          cal.push({
            id: null,
            date: s.date,
            category: s.session.category,
            durationMinutes: s.session.durationMinutes,
            discipline: disciplineOfSession(s.session),
            fromOp: i,
            done: false,
          });
        }
        break;
      case "createPlan":
        for (const s of op.firmSessions) {
          cal.push({
            id: null,
            date: s.date,
            category: s.session.category,
            durationMinutes: s.session.durationMinutes,
            discipline: disciplineOfSession(s.session),
            fromOp: i,
            done: false,
          });
        }
        break;
      case "extendPlan":
      case "retirePlan":
      // Demoting a mislabeled race row (or moving the race-day setting)
      // reshapes no training day, so the load calendar is untouched.
      case "resolveRaceConflict":
        break;
    }
  });
  return cal;
}

/** Dates an op edits directly (for horizon + touch checks). */
function opDates(op: CoachOp, ctx: GuardrailCtx): string[] {
  const byId = new Map(ctx.workouts.map((w) => [w.id, w]));
  switch (op.kind) {
    case "ease":
    case "skip":
      return byId.has(op.workoutId) ? [byId.get(op.workoutId)!.date] : [];
    case "move":
      return byId.has(op.workoutId) ? [byId.get(op.workoutId)!.date, op.toDate] : [op.toDate];
    case "swap":
      return [op.dayA, op.dayB];
    case "add":
      return addOpDates(op);
    case "reshapeWeek":
    case "firmUp":
    case "windDown":
      return op.sessions.map((s) => s.date);
    case "createPlan":
      return op.firmSessions.map((s) => s.date);
    case "extendPlan":
    case "retirePlan":
    case "resolveRaceConflict":
      return [];
  }
}

const HORIZON_EXEMPT = new Set([
  "firmUp",
  "extendPlan",
  "reshapeWeek",
  "createPlan",
  "windDown",
  "retirePlan",
  "resolveRaceConflict",
]);

/**
 * The dates an op would put NEW work on — as distinct from {@link opDates},
 * which also includes the day an id-addressed op's existing session sits on.
 *
 * `past_date` needs exactly this distinction: easing yesterday's session is
 * `touch_resolved` (the row is resolved, and the message should say so), while
 * ADDING a session to yesterday is a different and previously unguarded
 * mistake — nothing in this file looked at an `add`'s own dates against today,
 * so `insertSession` would have written work onto a day already lived.
 */
function newWorkDates(op: CoachOp): string[] {
  switch (op.kind) {
    case "ease":
    case "skip":
    case "extendPlan":
    case "retirePlan":
    case "resolveRaceConflict":
      return [];
    case "move":
      return [op.toDate];
    case "swap":
      return [op.dayA, op.dayB];
    case "add":
      return addOpDates(op);
    case "reshapeWeek":
    case "firmUp":
    case "windDown":
      return op.sessions.map((s) => s.date);
    case "createPlan":
      return op.firmSessions.map((s) => s.date);
  }
}

/**
 * How many NEW planned_workouts rows this op would write. Distinct from
 * {@link newWorkDates}, which answers "which days does this put work on": a
 * `move` or a `swap` lands work on a day without creating anything, and a
 * multi-date `add` creates one row per date.
 */
function newSessionCount(op: CoachOp): number {
  switch (op.kind) {
    case "add":
      return addOpDates(op).length;
    case "reshapeWeek":
    case "firmUp":
    case "windDown":
      return op.sessions.length;
    case "createPlan":
      return op.firmSessions.length;
    case "ease":
    case "move":
    case "swap":
    case "skip":
    case "extendPlan":
    case "retirePlan":
    case "resolveRaceConflict":
      return 0;
  }
}

export interface ValidationResult {
  /** The proposal cannot be applied — reject it, and let the wake converge. */
  fatal: Violation[];
  /** Costs the athlete decides on, rendered as the proposal's trade-off. */
  advisory: Violation[];
  /** Advisories against a standing rule the ATHLETE stated. Separate because
   * their flag text is the athlete's own words out of coach memory, not ours;
   * `rule` is the memory row id, not a {@link GuardrailRule}. */
  soft: Violation[];
}

export function validateOps(ops: CoachOp[], ctx: GuardrailCtx): ValidationResult {
  const fatal: Violation[] = [];
  const advisory: Violation[] = [];
  const soft: Violation[] = [];
  const byId = new Map(ctx.workouts.map((w) => [w.id, w]));

  /**
   * The ONE routing point. Every finding names a {@link GuardrailRule} and
   * {@link RULE_CLASS} decides which list it lands in — so classification
   * cannot drift away from the map, and a new rule cannot be pushed at all
   * until it has a class.
   */
  const found = (rule: GuardrailRule, opIndex: number, detail: string): void => {
    (RULE_CLASS[rule] === "fatal" ? fatal : advisory).push({ rule, opIndex, detail });
  };

  ops.forEach((op, i) => {
    const idAddressed = op.kind === "ease" || op.kind === "move" || op.kind === "skip";
    const targeted = idAddressed ? byId.get(op.workoutId) : undefined;
    // An id that resolves to nothing is the quietest failure this app has:
    // `applyOps` UPDATEs zero rows, pushes the id into `updated`, and the
    // receipt says approved. The athlete is told their plan changed.
    if (idAddressed && !targeted) {
      found(
        "unknown_workout",
        i,
        `it changes a session that isn't on your calendar any more — approving it wouldn't do anything`,
      );
    }
    if (targeted) {
      if (targeted.completionState !== "scheduled" && targeted.completionState !== "planned") {
        found(
          "touch_resolved",
          i,
          `${humanDate(targeted.date)} is already ${targeted.completionState} — only sessions still on the calendar can be changed`,
        );
      } else if (targeted.date < ctx.today) {
        found(
          "touch_resolved",
          i,
          `${humanDate(targeted.date)} has already been and gone — the past can't be rewritten`,
        );
      }
      if (op.kind === "skip" && targeted.category === "race") {
        found(
          "never_skip_race",
          i,
          `${humanDate(targeted.date)} is your race day — approving this takes it off the plan`,
        );
      }
    }
    for (const d of newWorkDates(op)) {
      if (d < ctx.today) {
        found("past_date", i, `it puts work on ${humanDate(d)}, which has already been and gone`);
        break;
      }
    }
    // Structural ops on plans the coach did not author. Imported COROS plans
    // can have sessions skipped/moved, never their structure rewritten — and
    // this one is fatal because the apply is HALF-guarded: archiveWeek and
    // retirePlan check authorship and no-op, while firmUp and extendPlan
    // happily write rows into a plan id that has no coach_plans row at all.
    if (
      (op.kind === "reshapeWeek" ||
        op.kind === "firmUp" ||
        op.kind === "extendPlan" ||
        op.kind === "windDown" ||
        op.kind === "retirePlan") &&
      !ctx.coachPlanIds.includes(op.planId)
    ) {
      found(
        "imported_plan_structure",
        i,
        `that plan came from your watch — its sessions can be moved or skipped, but its structure can't be rewritten here`,
      );
    }
    // The horizon says nothing at all to an athlete with an empty calendar:
    // `firmHorizonEnd` falls back to today, which made every future session
    // "past the end of your planned weeks". Silent when there are no planned
    // weeks to be past.
    if (!HORIZON_EXEMPT.has(op.kind) && ctx.firmHorizonEnd > ctx.today) {
      for (const d of opDates(op, ctx)) {
        if (d > ctx.firmHorizonEnd) {
          found(
            "beyond_horizon",
            i,
            `${humanDate(d)} is past the end of your planned weeks (${humanDate(ctx.firmHorizonEnd)}) — it lands as a one-off rather than part of the block`,
          );
          break;
        }
      }
    }
  });

  // How much this ONE proposal would write, across every op in it. The
  // schema's per-op caps are sized for real sessions now (60 dates on an add,
  // 60 blocks in a run), so the only thing standing between a runaway model
  // and a half-executed approval is this total.
  const written = ops.reduce((n, op) => n + newSessionCount(op), 0);
  if (written > MAX_PROPOSAL_SESSIONS) {
    found(
      "runaway_size",
      0,
      `it would put ${written} separate sessions on your calendar in one approval — more than can be written at once, so it needs splitting into blocks`,
    );
  }

  const cal = resultingCalendar(ops, ctx);

  // H2 — hard sessions on consecutive days (in the resulting calendar,
  // counting only pairs where at least one side was op-touched: pre-existing
  // adjacency is the plan's business, not this proposal's).
  //
  // A COMPLETED SESSION ON THE EARLIER DAY STILL COUNTS, deliberately
  // (2026-08-17 — the product owner asked). Tonight this fired on a Saturday
  // long run that had already happened, and as a REJECTION that was
  // indefensible: the only "fix" available to the coach is not to coach, since
  // it cannot ease a day the athlete has already run. As an ADVISORY it is
  // simply true — Sunday after a hard Saturday is Sunday on tired legs whether
  // or not the plan admits it — and the athlete can act on it in the one way
  // that matters, by deciding. So the finding stays and the wording changes:
  // a day already trained is named as already trained, never as something to
  // go and make easy. `athleteLimitLines` was widened to list yesterday's hard
  // day for the same reason, so the coach can see the stack before it plans
  // instead of meeting it in a rejection.
  const hardDays = new Map<string, CalEntry[]>();
  for (const e of cal) {
    if (isHard(e, ctx)) hardDays.set(e.date, [...(hardDays.get(e.date) ?? []), e]);
  }
  for (const [date, entries] of hardDays) {
    const next = hardDays.get(addDays(date, 1));
    if (!next) continue;
    const touched = [...entries, ...next].some((e) => e.fromOp !== null);
    if (touched) {
      const opIndex = [...entries, ...next].find((e) => e.fromOp !== null)!.fromOp!;
      const already = entries.some((e) => e.done);
      found(
        "hard_adjacency",
        opIndex,
        already
          ? `${humanDate(addDays(date, 1))} comes the day after ${humanDate(date)}, which you've already trained hard — they stack whether the plan says so or not`
          : `${humanDate(date)} and ${humanDate(addDays(date, 1))} are both hard days, back to back — the second one gets done on tired legs`,
      );
    }
  }

  // H1 — ramp: any op-touched week's projected minutes vs trailing average.
  //
  // Measured against the BASELINE the same week already had (2026-08-16). A
  // week can sit over its ramp cap for reasons the coach had nothing to do
  // with — an imported plan's own build, a race block — and the old check
  // charged the whole week's running volume to whatever op happened to
  // touch that week. Live consequence: a ski-prep STRENGTH block was
  // hard-rejected with "run week of 2026-08-17: 429min > 152min cap",
  // running minutes it did not add a single one of. The guard exists to
  // stop the COACH ramping you, so it fires only on a discipline whose
  // minutes these ops actually increased.
  const live = liveWorkouts(ctx);
  const baselineWeekMinutes = (week: string, disc: string): number =>
    weekMinutes(live, week, disc, ctx, false);
  const touchedWeeks = new Set(cal.filter((e) => e.fromOp !== null).map((e) => mondayOf(e.date)));
  for (const week of touchedWeeks) {
    const weekEnd = addDays(week, 6);
    const perDiscipline = new Map<string, number>();
    for (const e of cal) {
      if (e.date >= week && e.date <= weekEnd && e.category !== "rest") {
        perDiscipline.set(e.discipline, (perDiscipline.get(e.discipline) ?? 0) + e.durationMinutes);
      }
    }
    for (const [disc, minutes] of perDiscipline) {
      if (minutes <= baselineWeekMinutes(week, disc)) continue; // the ops did not add here
      const opIndex = cal.find((e) => e.fromOp !== null && mondayOf(e.date) === week)!.fromOp!;
      const avg = trailingAvg(ctx, disc);

      // H1b — COLD START. The percentage ramp is multiplicative, so with no
      // trailing history it caps nothing: `avg > 0` was false and the loop
      // `continue`d, meaning the ramp guardrail was silent for exactly the
      // athlete it exists to protect (2026-08-16 — one strength session in
      // seven months, and a proposed daily lift block sailed through). An
      // absolute first-week ceiling is the only thing that can speak here.
      //
      // It counts LOADING minutes only: the few-minute daily mobility piece
      // is free, or the rule would forbid the safest way to say yes to
      // "something every day".
      if (avg === null || avg <= DETRAINED_WEEK_MINUTES) {
        const loading = weekMinutes(cal, week, disc, ctx, true);
        if (loading > COLD_START_WEEK_MINUTES) {
          found(
            "cold_start",
            opIndex,
            `you've done essentially no ${disciplineWord(disc)} in the last four weeks, so ${Math.round(loading)} minutes of it ` +
              `in the week of ${humanDate(week)} is a big first block — the soreness turns up a day or two after each session`,
          );
        }
        continue; // a cold start has no percentage to measure against
      }

      if (avg > 0 && minutes > avg * RAMP_CAP) {
        found(
          "ramp",
          opIndex,
          `${Math.round(minutes)} minutes of ${disciplineWord(disc)} in the week of ${humanDate(week)}, ` +
            `against a recent average of ${Math.round(avg)} — a ${Math.round((minutes / avg - 1) * 100)}% step up in one week, ` +
            `and big steps are where niggles start`,
        );
      }
    }
  }

  // H8 — a week with no rest day left in it. "Rest day" means a day with no
  // LOADING on it (see isLoading): an explicit rest row, an empty day, or a
  // day carrying only the trivial daily mobility piece all count.
  //
  // Fires only when THESE ops removed the last one — a week that already had
  // no rest day is the plan's problem, and the coach adding a stretch to it
  // shouldn't be flagged for a fault it inherited. That mirrors the ramp
  // rule's baseline gate.
  for (const week of touchedWeeks) {
    const baselineLoaded = loadedDaysIn(live, week);
    const resultLoaded = loadedDaysIn(cal, week);
    if (resultLoaded.size >= 7 && baselineLoaded.size < 7) {
      const opIndex = cal.find((e) => e.fromOp !== null && mondayOf(e.date) === week)!.fromOp!;
      found(
        "no_rest_day",
        opIndex,
        `the week of ${humanDate(week)} ends up with work on all seven days — no rest day at all in it`,
      );
    }
  }

  // H5 — op-introduced intensity inside a race window.
  for (const race of ctx.raceDates) {
    const from = addDays(race, -RACE_WINDOW_DAYS);
    for (const e of cal) {
      if (e.fromOp === null) continue;
      if (e.date >= from && e.date < race && e.category === "quality") {
        found(
          "race_week_intensity",
          e.fromOp,
          `hard intensity on ${humanDate(e.date)} with your race on ${humanDate(race)} — that spends freshness you'd want on the day`,
        );
      }
    }
  }

  // H9 — loading inside the last 48h before something the athlete told the
  // coach about. Races have their own window above; everything else people
  // actually care about — a ski trip, a hike, a wedding — had none, so the
  // coach cheerfully scheduled its heaviest unaccustomed leg session two
  // days before the trip it was preparing them for (2026-08-16). Soreness
  // from a first eccentric bout peaks 24–48h later: on the mountain.
  for (const ev of ctx.datedEvents) {
    if (ev.date < ctx.today) continue;
    const from = addDays(ev.date, -EVENT_TAPER_DAYS);
    for (const e of cal) {
      if (e.fromOp === null) continue;
      if (e.date >= from && e.date <= ev.date && isHard(e, ctx)) {
        found(
          "event_taper",
          e.fromOp,
          `hard work on ${humanDate(e.date)} lands inside the last two days before ${ev.label} (${humanDate(ev.date)}) — ` +
            `soreness from a bout peaks about then, so you'd arrive stiff`,
        );
      }
    }
  }

  // Soft — structured standing rules on op-touched entries.
  for (const rule of ctx.rules) {
    for (const e of cal) {
      if (e.fromOp === null) continue;
      if (e.category === rule.category && isoWeekday(e.date) !== rule.weekday) {
        soft.push({
          rule: rule.id,
          opIndex: e.fromOp,
          detail: `puts your ${e.category} session on ${DAY_NAMES[isoWeekday(e.date) % 7]}, not ${DAY_NAMES[rule.weekday % 7]}`,
        });
      }
    }
  }

  return { fatal, advisory, soft };
}
