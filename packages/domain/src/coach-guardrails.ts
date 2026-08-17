import { addDays } from "./time.js";
import { addOpDates, sessionSport } from "./coach.js";
import type { CoachOp, CoachSession } from "./coach.js";

/**
 * The hard floor outside the model (spec §4): pure, exhaustive, unit-tested.
 * Hard violations reject a proposal (after one repair round-trip); soft
 * violations are FLAGS the proposal must carry — the wake pipeline unions
 * these with whatever the model volunteered, so the "breaks your rule" chip
 * can never be forgotten.
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
  rule: string;
  opIndex: number;
  detail: string;
}

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

export function validateOps(
  ops: CoachOp[],
  ctx: GuardrailCtx,
): { hard: Violation[]; soft: Violation[] } {
  const hard: Violation[] = [];
  const soft: Violation[] = [];
  const byId = new Map(ctx.workouts.map((w) => [w.id, w]));

  // H3 / H6 / H4 — per-op checks.
  ops.forEach((op, i) => {
    const targeted =
      op.kind === "ease" || op.kind === "move" || op.kind === "skip" ? byId.get(op.workoutId) : undefined;
    if (targeted) {
      if (targeted.completionState !== "scheduled" && targeted.completionState !== "planned") {
        hard.push({
          rule: "touch_resolved",
          opIndex: i,
          detail: `${humanDate(targeted.date)} is already ${targeted.completionState} — only sessions still on the calendar can be changed`,
        });
      } else if (targeted.date <= ctx.today && targeted.date < ctx.today) {
        hard.push({
          rule: "touch_resolved",
          opIndex: i,
          detail: `${humanDate(targeted.date)} has already been and gone — the past can't be rewritten`,
        });
      }
      if (op.kind === "skip" && targeted.category === "race") {
        hard.push({ rule: "never_skip_race", opIndex: i, detail: "race days are never skipped" });
      }
    }
    // H7 — structural ops on plans the coach did not author. Imported COROS
    // plans can have sessions skipped/moved, never their structure rewritten.
    if (
      (op.kind === "reshapeWeek" ||
        op.kind === "firmUp" ||
        op.kind === "extendPlan" ||
        op.kind === "windDown" ||
        op.kind === "retirePlan") &&
      !ctx.coachPlanIds.includes(op.planId)
    ) {
      hard.push({
        rule: "imported_plan_structure",
        opIndex: i,
        detail: `that plan came from your watch — its sessions can be moved or skipped, but its structure can't be rewritten here`,
      });
    }
    if (!HORIZON_EXEMPT.has(op.kind)) {
      for (const d of opDates(op, ctx)) {
        if (d > ctx.firmHorizonEnd) {
          hard.push({
            rule: "beyond_horizon",
            opIndex: i,
            detail: `${humanDate(d)} is past the end of your planned weeks (${humanDate(ctx.firmHorizonEnd)}) — the plan has to be extended first`,
          });
          break;
        }
      }
    }
  });

  const cal = resultingCalendar(ops, ctx);

  // H2 — hard sessions on consecutive days (in the resulting calendar,
  // counting only pairs where at least one side was op-touched: pre-existing
  // adjacency is the plan's business, not this proposal's).
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
      hard.push({
        rule: "hard_adjacency",
        opIndex,
        detail: `hard days back to back on ${humanDate(date)} and ${humanDate(addDays(date, 1))} — one of the two needs to be easy`,
      });
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
  const baselineWeekMinutes = (week: string, disc: string): number => {
    const weekEnd = addDays(week, 6);
    let total = 0;
    for (const w of ctx.workouts) {
      if (["skipped", "missed"].includes(w.completionState)) continue;
      if (w.date >= week && w.date <= weekEnd && w.category !== "rest" && w.discipline === disc) {
        total += w.durationMinutes;
      }
    }
    return total;
  };
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
        let loading = 0;
        for (const e of cal) {
          if (e.date >= week && e.date <= weekEnd && e.discipline === disc && isHard(e, ctx)) {
            loading += e.durationMinutes;
          }
        }
        if (loading > COLD_START_WEEK_MINUTES) {
          hard.push({
            rule: "cold_start",
            opIndex,
            detail:
              `you've done essentially no ${disciplineWord(disc)} in the last four weeks, so ${Math.round(loading)} minutes of it ` +
              `in the week of ${humanDate(week)} is too much to start with — about ${COLD_START_WEEK_MINUTES} minutes is a sane first week`,
          });
        }
        continue; // a cold start has no percentage to measure against
      }

      if (avg > 0 && minutes > avg * RAMP_CAP) {
        hard.push({
          rule: "ramp",
          opIndex,
          detail:
            `${Math.round(minutes)} minutes of ${disciplineWord(disc)} in the week of ${humanDate(week)}, ` +
            `against a recent average of ${Math.round(avg)} — more than the 10% step up that keeps this safe (${Math.round(avg * RAMP_CAP)} minutes)`,
        });
      }
    }
  }

  // H8 — a week with no rest day left in it. "Rest day" means a day with no
  // LOADING on it (see isLoading): an explicit rest row, an empty day, or a
  // day carrying only the trivial daily mobility piece all count.
  //
  // Fires only when THESE ops removed the last one — a week that already had
  // no rest day is the plan's problem, and the coach adding a stretch to it
  // shouldn't be rejected for a fault it inherited. That mirrors the ramp
  // rule's baseline gate.
  for (const week of touchedWeeks) {
    const baselineLoaded = loadedDaysIn(
      ctx.workouts.filter((w) => !["skipped", "missed"].includes(w.completionState)),
      week,
    );
    const resultLoaded = loadedDaysIn(cal, week);
    if (resultLoaded.size >= 7 && baselineLoaded.size < 7) {
      const opIndex = cal.find((e) => e.fromOp !== null && mondayOf(e.date) === week)!.fromOp!;
      hard.push({
        rule: "no_rest_day",
        opIndex,
        detail: `the week of ${humanDate(week)} ends up with work on all seven days and no rest day at all — a day off is part of the training`,
      });
    }
  }

  // H5 — op-introduced intensity inside a race window.
  for (const race of ctx.raceDates) {
    const from = addDays(race, -RACE_WINDOW_DAYS);
    for (const e of cal) {
      if (e.fromOp === null) continue;
      if (e.date >= from && e.date < race && e.category === "quality") {
        hard.push({
          rule: "race_week_intensity",
          opIndex: e.fromOp,
          detail: `hard intensity on ${humanDate(e.date)} with your race on ${humanDate(race)} — race week stays easy`,
        });
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
        hard.push({
          rule: "event_taper",
          opIndex: e.fromOp,
          detail:
            `hard work on ${humanDate(e.date)} lands inside the last two days before ${ev.label} (${humanDate(ev.date)}) — ` +
            `you'd arrive sore, which is the opposite of the point`,
        });
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

  return { hard, soft };
}
