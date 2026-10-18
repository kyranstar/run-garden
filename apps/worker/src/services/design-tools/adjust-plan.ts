/**
 * adjust_plan(workoutId, change, why) — the main coach changes a session already on the plan inside its own proposal
 * (Stage 3 Task 8b; the lead's ruling I6, Option A): skip it (a flare day), move it, or change a watch-plan run's length.
 * Not a new authority: the thread coach proposes exactly these (`CoachOp` skip, move, adjust), and the athlete approves
 * them; each change is applied at approval through coach-apply's own applier (design-approve.ts). The change and the
 * workout it makes way for go to the athlete together — one proposal, one approval.
 *
 * THE COACH'S REACH (the new shape §5): beside skip, move and a length, the thread coach's proven single-session changes,
 * each through its own applier: EASE (a watch-plan run made easy and shorter — the length asked for, else the body
 * check's own `easedRun`: EASE_SHARE of it — by TIME when the run is on the watch (`runOnWatch`: the wire carries no
 * distance), by distance only off it; the thread coach's `ease` carrying the eased session), SWAP (a run for an easier
 * kind: an easy or a recovery run, never longer than it, the same `ease`, its op marked `verb: "swap"`), REMOVE (off the plan entirely, the athlete's own
 * remove: not rest) and RESTORE (a skipped session still to come put back, the athlete's own un-skip). A session its
 * build decides is never eased, swapped or removed (a programme session is skipped or moved: `programme_session`; a Studio
 * or template workout revised: `revise_instead`), a race stays (`race_day`), an ease or a swap is a run's and easier
 * (`not_a_run`, `not_easier`), a restore a skip's (`not_skipped`).
 *
 * ONE op per session per proposal, of kind `plan_adjust` (proposal-kinds.ts `PlanAdjustOp`): the thread coach's op,
 * the coach's `why` (model-written: data, marked wherever it is shown back to a model), advisory `issues`, and the session
 * as the plan held it — what the manifest's line says it was. A second change of the same session replaces the first.
 * Never reviewed: it is a plan change, not a document (the finish's "every op reviewed" rule counts designed workouts
 * only). The call's tool-use id is on its op: a replay finds it and answers what it stored, writing nothing.
 *
 * REFUSED, each teachable, nothing written:
 *  - a session that isn't the athlete's or is off the plan (`not_found`), or can't change by coach-apply's own rule —
 *    done, skipped, missed, its day gone, under way (`not_changeable`; `whyNotActionable`, the applier's words);
 *  - a length for a session its build decides (ruling 3-R13): a programme or on-demand session is skipped or moved,
 *    never re-timed (`programme_session`: skip it and propose the shorter workout — for a set, brief it); a Studio or
 *    template workout is revised (`revise_instead`);
 *  - the athlete's race skipped or moved (`race_day`: the thread coach's `never_skip_race`, and the applier refuses to
 *    move a race);
 *  - a session, or a move's day, past the run's reach (`beyond_horizon`: a set's plan read, design-context.ts
 *    `horizonDays`; now and later today, today plus seven days — a request may name another day), a move into the past
 *    (`past_date`) or to today at a time not at least 15 minutes ahead — its toTime, or the time it keeps
 *    (`past_time`, `time_too_soon`, `no_time_today`; the polish round, 1) — and a move or length that changes nothing
 *    (`no_change`);
 *  - an eleventh change (`too_many_changes`: a proposal holds at most MAX_CHANGES);
 *  - a session a workout of this proposal revises (`target_taken`: propose_workout refuses the other way round);
 *  - a proposal already with the athlete (`proposal_pending`) or closed, a restore under way.
 *
 * CONDITION CARE (fix wave 3B, B-I6). A skip or a move of a session whose programme cares for an active profile (its
 * `careProfiles`) carries the advisory `care_session`, in the profile's own words: "This skips a jaw care session."
 *
 * SANCTIONED REST. A skip is the thread coach's agreed rest, held to its rule: the first sanctioned skip in a rolling
 * week counts as a rest day for the garden, further ones are merely neutral (coach-wake.ts's SKIP TREATMENT; the
 * dossier's "sanctioned rest used n of 1"; garden-sync.ts's mercy day). A skip that takes the week past it carries the
 * thread coach's advisory note, and every result counts it (`sanctionedRest`).
 *
 * The change's words reach the model marked: a session's name is an import's, a skip's reason the model's own.
 *
 * Two statements: the athlete with the session, the proposal, the restore marker and the week's sanctioned skips in one
 * read, and the proposal's guarded upsert (propose_workout's own: never a pending proposal, never one another write
 * changed meanwhile).
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { accountState, coachProposals, corosWriteJobs, plannedWorkouts, plannedWorkoutStages, programs } from "@rg/database";
import { addDays, appAuthoredRow, coachOpSchema, dayLabel, docOriginRow, hasWatchAddress, humanizeWorkoutTitle } from "@rg/domain";
import type { ConditionProfile } from "@rg/exercise-library";
import { easedRun, runOnWatch } from "../body-check.js";
import { NOT_ACTIONABLE, whyNotActionable } from "../coach-apply.js";
import { horizonDays } from "../design-context.js";
import { clockIn, todayLeadRefusal } from "../design-time.js";
import { OPEN_PROPOSAL_STATUSES } from "../design-review.js";
import { describeChange, isDocWorkoutOp, isPlanAdjustOp, planAdjustId, type PlanAdjustOp, type PlanChange, type PlanRowSnapshot } from "../proposal-kinds.js";
import { capInWords, isErr, mainRunIdOf, parseAct, prose } from "./act-common.js";
import { clipProse } from "../design-prose.js";
import { designProposalId, upsertProposal, type DocWorkoutOp } from "./propose.js";
import { dateField, DATE_SCHEMA, parsedArray, parsedJson, readAthlete, refuse, untrusted } from "./read-common.js";
import type { DesignTool, ToolContext, ToolErr, ToolOk } from "./types.js";

const WHY_MAX = 300;
const REASON_MAX = 200;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
/** A length the athlete can play: five minutes to five hours. */
const MINUTES = { min: 5, max: 300 } as const;
/** The most changes one proposal holds (the review's fix round, 4): its approve's plan read covers ten ops. */
export const MAX_CHANGES = 10;
/**
 * The sanctioned rest a rolling week holds: the thread coach's number (the dossier's "sanctioned rest used n of 1 this
 * rolling week"; garden-sync.ts: the FIRST sanctioned skip in any rolling 7 days is a rest day). A test holds the two
 * together.
 */
export const SANCTIONED_REST_PER_ROLLING_WEEK = 1;

/** An eased run's share of its length, by default (the new shape §5; the body check's own ease: about 70%). */
export const EASE_SHARE = 0.7;
/** The easier kinds a run may be swapped for (the new shape §5), each a run of that kind at an easy effort. */
const SWAP_TO = ["easy", "recovery"] as const;
/** How hard a run's kind is: a swap goes down it, never up or across. */
const RUN_RANK: Readonly<Record<string, number>> = { race: 5, quality: 4, long: 3, easy: 2, recovery: 1 };
/** An eased or swapped run's name, by its kind. */
const RUN_TITLE: Readonly<Record<string, string>> = { easy: "Easy run", long: "Long run", recovery: "Recovery run" };

const minutesField = z.number().int().min(MINUTES.min).max(MINUTES.max);
const change = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("skip"), reason: prose(REASON_MAX) }).strict(),
  z.object({ kind: z.literal("move"), toDate: dateField, toTime: z.string().regex(CLOCK, "must be a time like 17:30").optional() }).strict(),
  z.object({ kind: z.literal("adjust"), durationMinutes: minutesField }).strict(),
  // The new shape §5: the thread coach's single-session changes.
  z.object({ kind: z.literal("ease"), durationMinutes: minutesField.optional(), distanceKm: z.number().min(1).max(60).optional() }).strict(),
  z.object({ kind: z.literal("swap"), to: z.enum(SWAP_TO), durationMinutes: minutesField }).strict(),
  z.object({ kind: z.literal("remove") }).strict(),
  z.object({ kind: z.literal("restore") }).strict(),
]);
/** The words the athlete reads (a skip's reason, the change's why) are free text (Task 13's fix wave, §2.1; round 2, Minor
 * 8): kept up to four times their caps and clipped where they are stored, refused only past that, in words. */
const input = z.object({ workoutId: z.string().trim().min(1).max(120), change, why: prose(WHY_MAX) }).strict();

/** The session as the read gives it. */
interface Row {
  id: string;
  date: string;
  time: string | null;
  title: string;
  category: string;
  subtype: string | null;
  origin: string | null;
  completion: string;
  archived: string | null;
  sourceSec: number | null;
  fallbackSec: number | null;
  swid: string | null;
  sidp: string | null;
  spid: string | null;
  lvd: string | null;
  /** Its programme's care, when it has one (`config.careProfiles`): the profiles its sessions care for. */
  care: unknown;
  /** Its discipline and planned distance (an ease's), and whether the app put it on the watch (a remove's line). */
  sport?: string | null;
  meters?: number | null;
  pushed?: number | null;
  /** An ease's too (`easedRun`): its calendar block, whether COROS holds it as the import saw it, and its stages. */
  blockSec?: number | null;
  sync?: string | null;
  stages?: unknown;
}

const minutesOf = (r: Row): number | null => {
  const sec = r.sourceSec ?? r.fallbackSec;
  return typeof sec === "number" ? Math.round(sec / 60) : null;
};

/** The session as the manifest says it was. */
function snapshotOf(r: Row): PlanRowSnapshot {
  return {
    date: r.date,
    time: r.time ?? "",
    title: humanizeWorkoutTitle(r.title, r.category, r.subtype),
    minutes: minutesOf(r),
    category: r.category,
    origin: r.origin,
    onWatch: hasWatchAddress({ sourceWorkoutId: r.swid, sourceIdInPlan: r.sidp, sourceProgramId: r.spid, lastVerifiedCorosDate: r.lvd }),
    ...(r.pushed ? { appPushed: true } : {}),
  };
}

/** The first active profile a session's programme cares for (its `careProfiles`), or null: no care, or none on. */
function careOf(row: Row, active: readonly ConditionProfile[]): ConditionProfile | null {
  let ids: unknown = row.care;
  if (typeof ids === "string") {
    try {
      ids = JSON.parse(ids);
    } catch {
      ids = null;
    }
  }
  if (!Array.isArray(ids)) return null;
  const listed = ids as unknown[];
  return active.find((p) => listed.includes(p.id)) ?? null;
}

/** The profile's own words for its care, as a session's kind: "jaw care" (its care block's label), else "TMJ care". */
const careWords = (p: ConditionProfile): string =>
  p.care ? p.care.block.label.replace(/^([A-Z])(?=[a-z])/, (c) => c.toLowerCase()) : `${p.label} care`;

/** A set's main coach briefs; for now or later today it proposes (the review's fix round, 5). */
const isSet = (ctx: ToolContext): boolean => ctx.run.scope.kind === "week" || ctx.run.scope.kind === "next_n";

/** For a set the main coach briefs the shorter workout; for now or later today it proposes it. */
const shorterWorkout = (ctx: ToolContext): string =>
  isSet(ctx)
    ? "Skip it with adjust_plan and brief the shorter workout in plan_set; both go to the athlete together."
    : "Skip it with adjust_plan and propose the shorter workout with propose_workout; both go to the athlete together.";

/** For a set the main coach briefs a Studio workout's replacement; for now or later today it revises it. */
const reviseIt = (ctx: ToolContext): string =>
  isSet(ctx) ? "Brief its replacement in plan_set: a designer revises the workout itself." : "Revise it with propose_workout's revise target.";

/** The last day a change may touch (a session, or a move's day): a set's plan read; now and later today, today plus seven
 * days — a request may name another day (the review's fix round, 4). */
function lastDay(ctx: ToolContext, today: string): string {
  return isSet(ctx) ? addDays(today, horizonDays(ctx.run.scope.kind, ctx.run.scope.n ?? 3) - 1) : addDays(today, 7);
}

const ordinal = (n: number): string => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;

/** Why this change can't be made to this session, by the applier's and the thread coach's own rules; null when it can. */
function refusalOf(ctx: ToolContext, row: Row | null, c: z.output<typeof change>, today: string, workoutId: string, clock: { minutes: number }): ToolErr | null {
  if (!row || row.archived) {
    return refuse("not_found", `No planned session of the athlete's has id ${JSON.stringify(workoutId)}.`, "Use an id from read_plan.");
  }
  // A restore reaches a skipped session (the thread coach's one op whose purpose is a resolved row), still to come.
  if (c.kind === "restore") {
    if (row.completion !== "skipped") {
      return refuse("not_skipped", `That session is ${row.completion === "scheduled" || row.completion === "planned" ? "on the plan" : `already ${row.completion}`}: only a skipped one is put back.`, "Restore a skipped session — read_plan marks them.");
    }
    if (row.date < today) return refuse("not_changeable", `That session ${NOT_ACTIONABLE.past}: only a skip still to come is put back.`, "Restore a skipped session of today or later.");
  } else {
    const why = whyNotActionable({ archivedAt: row.archived, completionState: row.completion, effectiveDate: row.date }, today);
    if (why !== undefined) {
      return refuse("not_changeable", `That session ${why}.`, "Change a session still to come — read_plan lists them.");
    }
  }
  const last = lastDay(ctx, today);
  if (row.date > last) {
    return refuse("beyond_horizon", `That session is on ${row.date}, past the plan this run reads (to ${last}).`, `Change a session up to ${last} — read_plan lists them.`);
  }
  // The thread coach's single-session changes (the new shape §5): a session the app builds is its build's — a programme
  // session is skipped or moved, a Studio or template workout revised — and the race stays.
  if (c.kind === "ease" || c.kind === "swap" || c.kind === "remove") {
    if (appAuthoredRow({ origin: row.origin })) {
      return docOriginRow({ origin: row.origin })
        ? refuse("revise_instead", `A Studio or template workout is the athlete's document: it isn't ${c.kind === "remove" ? "removed" : "eased"} here.`, reviseIt(ctx))
        : refuse("programme_session", `A programme session is skipped or moved, never ${c.kind === "remove" ? "removed" : "eased or swapped"}.`, c.kind === "remove" ? "Skip it with adjust_plan instead." : shorterWorkout(ctx));
    }
    if (row.category === "race") return refuse("race_day", `${dayLabel(row.date)} holds the athlete's race: it stays as it is.`, "Leave the race on the plan and design around it.");
  }
  if (c.kind === "ease" || c.kind === "swap") {
    if (!(row.category in RUN_RANK) || (row.sport ?? "run") !== "run") {
      return refuse("not_a_run", `That session is ${row.category}, not a run: ease and swap change a watch-plan run.`, "Skip it, or propose an easier workout beside it.");
    }
    const now = minutesOf(row);
    if (c.kind === "ease") {
      const shorter = c.durationMinutes !== undefined ? now === null || c.durationMinutes < now : true;
      const nearer = c.distanceKm !== undefined ? !row.meters || c.distanceKm * 1000 < row.meters : true;
      if (!shorter || !nearer) {
        return refuse("not_easier", `That run is ${now ?? "?"} min${row.meters ? `, ${Math.round(row.meters / 100) / 10} km` : ""}: an ease makes it shorter.`, "Give a shorter durationMinutes or distanceKm, or leave both out for about 70% of it.");
      }
      if (now === null && c.durationMinutes === undefined) {
        return refuse("no_length", "That run states no length to ease from.", "Give durationMinutes.");
      }
    } else if ((RUN_RANK[c.to] ?? 0) >= (RUN_RANK[row.category] ?? 0)) {
      return refuse("not_easier", `That run is already ${row.category}: a swap is for an easier kind.`, `Swap it for a kind easier than ${row.category}, or ease it.`);
    }
  }
  if (c.kind === "skip" && row.category === "race") {
    return refuse("race_day", `${dayLabel(row.date)} holds the athlete's race: a skip would take it off the plan.`, "Leave the race on the plan and design around it; the athlete decides about their race.");
  }
  if (c.kind === "move" && row.category === "race") {
    return refuse("race_day", "A race can't be moved: its day is the race's.", "Leave the race where it is and design around it.");
  }
  if (c.kind === "adjust") {
    // Ruling 3-R13: a session the app builds has its build's length.
    if (appAuthoredRow({ origin: row.origin })) {
      return docOriginRow({ origin: row.origin })
        ? refuse("revise_instead", "A Studio or template workout's length is its document's.", reviseIt(ctx))
        : refuse("programme_session", "A programme session can't be re-timed.", shorterWorkout(ctx));
    }
    if (minutesOf(row) === c.durationMinutes) {
      return refuse("no_change", `That session is already ${c.durationMinutes} min.`, "Leave it as it is, or choose another length.");
    }
  }
  if (c.kind === "move") {
    if (c.toDate < today) return refuse("past_date", `${c.toDate} is before today (${today}) where the athlete is.`, "Move it to today or a later day.");
    if (c.toDate > last) return refuse("beyond_horizon", `${c.toDate} is past the plan this run reads (to ${last}).`, `Move it to a day up to ${last}.`);
    if (c.toDate === row.date && (c.toTime ?? row.time) === row.time) {
      return refuse("no_change", `That session is already on ${c.toDate}${row.time ? ` at ${row.time}` : ""}.`, "Leave it as it is, or choose another day or time.");
    }
    // Never at a past time (the polish round, 1): a move to today — at its toTime, or at the time it keeps, as the
    // applier keeps it — lands at least 15 minutes after now in the athlete's zone.
    if (c.toDate === today) {
      const kept = c.toTime ?? row.time ?? "07:00";
      const late = todayLeadRefusal(kept, clock);
      if (late) {
        const which = c.toTime ? "" : ` (with no toTime it keeps its own time, ${kept})`;
        return refuse(
          late.error,
          `${late.why}${which}`,
          late.earliest ? `Give change.toTime, HH:MM, ${late.earliest} or later — or move it to another day.` : "No time is left today: move it to another day, or leave it.",
        );
      }
    }
  }
  return null;
}

/**
 * The thread coach's own op for a change (its schema's parse): a skip, move or length as asked; an ease or a swap as the
 * thread coach's `ease` carrying the eased session — a run of an easy effort, its kind kept (an easy, long or recovery
 * run; a harder one eased is an easy run) or the easier kind swapped to, at the length or distance asked for, else about
 * EASE_SHARE of its own (by distance when it states one); a remove or a restore as they are.
 */
function coachOpOf(c: z.output<typeof change>, row: Row, workoutId: string): PlanChange {
  if (c.kind !== "ease" && c.kind !== "swap") return coachOpSchema.parse({ ...c, workoutId }) as PlanChange;
  const op = (session: Record<string, unknown>) => coachOpSchema.parse({ kind: "ease", workoutId, session }) as PlanChange;
  const timed = (category: string, title: string, minutes: number) => ({
    category,
    title,
    durationMinutes: minutes,
    run: { blocks: [{ kind: "duration", value: minutes, intensity: "easy" }] },
  });
  const now = minutesOf(row);
  // A swap never lengthens the session it replaces: its length is capped at the original's.
  if (c.kind === "swap") return op(timed(c.to, RUN_TITLE[c.to] ?? "Easy run", now !== null ? Math.min(c.durationMinutes, now) : c.durationMinutes));
  // The ease is the body check's own (`easedRun`, one rule): about 70% of the run, its kind kept or made easy — by TIME
  // when the run is on the watch (the wire carries no distance: a distance block would leave the watch holding the old
  // run, or take it off), by its distance when off the watch and the plan prescribes it so.
  const onWatch = runOnWatch({ sourceWorkoutId: row.swid ?? "", sourceIdInPlan: row.sidp, sourceProgramId: row.spid, lastVerifiedCorosDate: row.lvd ?? "", corosSyncState: row.sync ?? "" });
  const eased = easedRun(
    {
      title: row.title,
      category: row.category,
      qualitySubtype: row.subtype,
      sourceEstimatedDurationSeconds: row.sourceSec,
      fallbackEstimatedDurationSeconds: row.fallbackSec,
      calendarBlockDurationSeconds: row.blockSec ?? (now ?? MINUTES.min) * 60,
      expectedDistanceMeters: row.meters ?? null,
    },
    parsedStages(row.stages),
    onWatch,
  );
  const category = eased?.session.category ?? (row.category === "long" || row.category === "recovery" ? row.category : "easy");
  const title = eased?.session.title ?? RUN_TITLE[category] ?? "Easy run";
  if (c.durationMinutes !== undefined) return op(timed(category, title, c.durationMinutes));
  if (c.distanceKm !== undefined) {
    // The distance asked for, at the run's own pace: its time on the watch, its distance off it.
    const pace = now !== null && row.meters ? (now * 60) / row.meters : null;
    const minutes = pace !== null ? Math.max(MINUTES.min, Math.round((c.distanceKm * 1000 * pace) / 60)) : (eased?.session.durationMinutes ?? MINUTES.min);
    if (onWatch) return op(timed(category, title, minutes));
    return op({ category, title, durationMinutes: minutes, run: { blocks: [{ kind: "distance", value: Math.round(c.distanceKm * 1000), intensity: "easy" }] } });
  }
  return eased ? op(eased.session) : op(timed(category, title, Math.max(MINUTES.min, Math.round((now ?? MINUTES.min) * EASE_SHARE))));
}

/** A row's stages as the read gives them (JSON): what `easedRun` reads of them. */
function parsedStages(raw: unknown): Array<{ id: string; parentStageId: string | null; durationType: string }> {
  const list = typeof raw === "string" ? (parsedJson(raw) as unknown) : raw;
  return (Array.isArray(list) ? list : []).flatMap((s) => {
    const x = s as { id?: unknown; parentStageId?: unknown; durationType?: unknown } | null;
    return typeof x?.id === "string" && typeof x.durationType === "string"
      ? [{ id: x.id, parentStageId: typeof x.parentStageId === "string" ? x.parentStageId : null, durationType: x.durationType }]
      : [];
  });
}

/** The rolling week's sanctioned rest, as a result counts it. */
interface SanctionedRest {
  usedThisWeek: number;
  inProposal: number;
  allowance: number;
}

/** What a stored change answers: the change as the manifest says it — its words marked (a session's name is an
 * import's, a skip's reason the model's; the review's fix round, 6) — and the coach's why, marked. */
function storedAnswer(proposalId: string, op: PlanAdjustOp, o: { replaced?: boolean; sanctionedRest?: SanctionedRest } = {}): ToolOk {
  const words = describeChange(op);
  return {
    data: {
      stored: true,
      proposalId,
      opId: op.id,
      ...(o.replaced ? { replaced: true } : {}),
      change: {
        date: words.date,
        ...(words.time ? { time: words.time } : {}),
        summary: untrusted(words.summary),
        was: words.was,
        effect: words.effect === null ? null : untrusted(words.effect),
      },
      why: untrusted(op.why),
      issues: op.issues,
      ...(o.sanctionedRest ? { sanctionedRest: o.sanctionedRest } : {}),
      next: "It goes to the athlete with your proposal, never reviewed: the athlete approves or declines it with the rest.",
    },
    summary: `Plan change: ${words.title}${op.op.kind === "move" ? "" : ` (${dayLabel(op.date)})`}`,
    receipt: { proposalId, opId: op.id, workoutId: op.op.workoutId, change: op.op.kind },
  };
}

export const adjustPlan: DesignTool = {
  name: "adjust_plan",
  description:
    "The main coach: change a session on the plan, in your proposal — skip, move, re-time, ease or swap a watch-plan run for an easier one, remove it, or restore a skipped one (a programme session is only skipped or moved; a Studio workout is revised with propose_workout). One change per session; a second replaces it. Never reviewed: the athlete approves each.",
  inputSchema: {
    type: "object",
    properties: {
      workoutId: { type: "string", description: "The session's id (read_plan)." },
      change: {
        anyOf: [
          {
            type: "object",
            properties: { kind: { const: "skip" }, reason: { type: "string", description: `Why it comes off, for the athlete: ${capInWords(REASON_MAX)}.` } },
            required: ["kind", "reason"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { kind: { const: "move" }, toDate: DATE_SCHEMA, toTime: { type: "string", description: "HH:MM, the athlete's local time (optional)." } },
            required: ["kind", "toDate"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { kind: { const: "adjust" }, durationMinutes: { type: "integer", minimum: MINUTES.min, maximum: MINUTES.max } },
            required: ["kind", "durationMinutes"],
            additionalProperties: false,
          },
          {
            type: "object",
            description: "A watch-plan run made easy and shorter: the length given, else about 70% of it — by time on the watch (a distance given is its time at the run's pace).",
            properties: { kind: { const: "ease" }, durationMinutes: { type: "integer", minimum: MINUTES.min, maximum: MINUTES.max }, distanceKm: { type: "number" } },
            required: ["kind"],
            additionalProperties: false,
          },
          {
            type: "object",
            description: "A watch-plan run swapped for an easier kind of run, never longer than it.",
            properties: { kind: { const: "swap" }, to: { enum: [...SWAP_TO] }, durationMinutes: { type: "integer", minimum: MINUTES.min, maximum: MINUTES.max } },
            required: ["kind", "to", "durationMinutes"],
            additionalProperties: false,
          },
          { type: "object", description: "Off the plan entirely (not rest).", properties: { kind: { const: "remove" } }, required: ["kind"], additionalProperties: false },
          { type: "object", description: "A skipped session back on the plan.", properties: { kind: { const: "restore" } }, required: ["kind"], additionalProperties: false },
        ],
      },
      why: { type: "string", description: `Why, in one plain line the athlete reads beside the change: ${capInWords(WHY_MAX)}.` },
    },
    required: ["workoutId", "change", "why"],
    additionalProperties: false,
  },
  statementCost: 2,
  cpuWeight: 0.3,
  roles: ["main"],
  async run(ctx, raw) {
    const parsed = parseAct(
      input,
      raw,
      "workoutId, change ({ kind: skip, reason } or { kind: move, toDate, toTime? } or { kind: adjust, durationMinutes } or { kind: ease, durationMinutes?, distanceKm? } or { kind: swap, to, durationMinutes } or { kind: remove } or { kind: restore }) and why",
    );
    if (isErr(parsed)) return parsed;
    // Clipped where the athlete reads them (§2.1): the change's why, a skip's reason.
    const p = {
      ...parsed,
      why: clipProse(parsed.why, WHY_MAX),
      change: parsed.change.kind === "skip" ? { ...parsed.change, reason: clipProse(parsed.change.reason, REASON_MAX) } : parsed.change,
    };
    const mainRunId = mainRunIdOf(ctx);
    if (ctx.run.role !== "main" || !mainRunId) return refuse("not_for_role", "Only the main coach changes the plan.", "Say in your finish line what you would change.");
    const proposalId = designProposalId(mainRunId);
    const pw = plannedWorkouts;
    const { athlete, extra } = await readAthlete(ctx.db, ctx.userId, ctx.now, {
      row: sql`(select json_object('id', ${pw.id}, 'date', ${pw.effectiveDate}, 'time', ${pw.effectiveTime}, 'title', ${pw.title},
          'category', ${pw.category}, 'subtype', ${pw.qualitySubtype}, 'origin', ${pw.origin}, 'completion', ${pw.completionState},
          'archived', ${pw.archivedAt}, 'sourceSec', ${pw.sourceEstimatedDurationSeconds}, 'fallbackSec', ${pw.fallbackEstimatedDurationSeconds},
          'swid', ${pw.sourceWorkoutId}, 'sidp', ${pw.sourceIdInPlan}, 'spid', ${pw.sourceProgramId}, 'lvd', ${pw.lastVerifiedCorosDate},
          'sport', ${pw.sport}, 'meters', ${pw.expectedDistanceMeters}, 'blockSec', ${pw.calendarBlockDurationSeconds}, 'sync', ${pw.corosSyncState},
          'stages', (select json_group_array(json_object('id', st.id, 'parentStageId', st.parent_stage_id, 'durationType', st.duration_type))
            from ${plannedWorkoutStages} st where st.workout_id = ${pw.id}),
          'pushed', exists(select 1 from ${corosWriteJobs} j where j.id = ${pw.id} || '-push' and j.user_id = ${ctx.userId}),
          'care', (select case when json_valid(${programs.config}) then json_extract(${programs.config}, '$.careProfiles') end
            from ${programs} where ${programs.id} = ${pw.planId} and ${programs.userId} = ${ctx.userId}))
        from ${pw} where ${pw.id} = ${p.workoutId} and ${pw.userId} = ${ctx.userId})`,
      propOps: sql`(select ${coachProposals.ops} from ${coachProposals} where ${coachProposals.id} = ${proposalId} and ${coachProposals.userId} = ${ctx.userId})`,
      propStatus: sql`(select ${coachProposals.status} from ${coachProposals} where ${coachProposals.id} = ${proposalId} and ${coachProposals.userId} = ${ctx.userId})`,
      restoring: sql`(select ${accountState.restoreId} from ${accountState} where ${accountState.userId} = ${ctx.userId})`,
      // The thread coach's agreed rest resolved lately, its days (the athlete's today is known only after this read:
      // the UTC day's week and a day more either side hold it); counted below as the dossier counts it.
      sanctioned: sql`(select json_group_array(${pw.resolutionDate}) from ${pw} where ${pw.userId} = ${ctx.userId}
        and ${pw.sanctionedBy} = 'coach' and ${pw.completionState} in ('skipped', 'missed') and ${pw.resolutionDate} >= ${addDays(ctx.now.toISOString().slice(0, 10), -8)})`,
    });
    const opsText = typeof extra.propOps === "string" ? extra.propOps : null;
    const all = ((opsText ? parsedJson(opsText) : null) as unknown[] | null) ?? [];
    const changes = all.filter(isPlanAdjustOp);

    // A replay of this very call: what it stored — or, when a later change of the session replaced it, that.
    if (ctx.toolUseId) {
      const stored = changes.find((c) => c.toolUseId === ctx.toolUseId);
      if (stored) return storedAnswer(proposalId, stored);
      if (changes.some((c) => c.replaces?.includes(ctx.toolUseId!))) {
        return { data: { stored: true, proposalId, superseded: true, note: "a later change of this session replaced this one" }, summary: "An earlier change, already replaced" };
      }
    }

    const status = typeof extra.propStatus === "string" ? extra.propStatus : null;
    if (status === "pending") return refuse("proposal_pending", "Your proposal is already with the athlete.", "Call finish.");
    if (status !== null && !(OPEN_PROPOSAL_STATUSES as readonly string[]).includes(status)) {
      return refuse("proposal_closed", `This design's proposal is already ${status}.`, "Finish: say what you would change, and the athlete can ask again.");
    }
    if (typeof extra.restoring === "string" && extra.restoring.length > 0) {
      return refuse("restoring", "The athlete's account is being restored right now.", "Finish, and say the change can be asked for again once the restore is done.");
    }
    const row = parsedJson(extra.row) as Row | null;
    const refused = refusalOf(ctx, row, p.change, athlete.today, p.workoutId, clockIn(athlete.tz, ctx.now));
    if (refused) return refused;
    if (all.some((o) => isDocWorkoutOp(o) && (o as DocWorkoutOp).target.kind === "revise" && (o as DocWorkoutOp & { target: { workoutId: string } }).target.workoutId === p.workoutId)) {
      return refuse("target_taken", "A workout of this proposal already revises that session.", "Change the revision instead, or leave the session as it is.");
    }
    // A change of a session already changed replaces it; a new one must fit (the review's fix round, 4).
    if (!changes.some((c) => c.op.workoutId === p.workoutId) && changes.length >= MAX_CHANGES) {
      return refuse(
        "too_many_changes",
        `This proposal already holds ${MAX_CHANGES} changes to planned sessions, the most one proposal holds.`,
        "Leave this session as it is, or change one already in the proposal instead (a second change of a session replaces its first).",
      );
    }

    // The thread coach's own op, as its schema stores one (an ease's or a swap's eased session built from the row).
    const op = coachOpOf(p.change, row!, p.workoutId);
    const snapshot = snapshotOf(row!);
    const at = ctx.now.toISOString();
    const toolUseId = ctx.toolUseId ?? `call-${at}`;
    const id = planAdjustId(p.workoutId);
    const before = changes.find((c) => c.id === id);
    // The rolling week's sanctioned rest (the thread coach's rule): the skips resolved in the week to today, and this
    // proposal's own skips once this change is in it.
    const weekFrom = addDays(athlete.today, -6);
    const usedThisWeek = (parsedArray(extra.sanctioned) as unknown[]).filter((d): d is string => typeof d === "string" && d >= weekFrom).length;
    const inProposal = changes.filter((c) => c.id !== id && c.op.kind === "skip").length + (op.kind === "skip" ? 1 : 0);
    const sanctionedRest: SanctionedRest = { usedThisWeek, inProposal, allowance: SANCTIONED_REST_PER_ROLLING_WEEK };
    const restNote =
      op.kind === "skip" && usedThisWeek + inProposal > SANCTIONED_REST_PER_ROLLING_WEEK
        ? [{ code: "sanctioned_rest", message: `This would be the ${ordinal(usedThisWeek + inProposal)} sanctioned skip in a rolling week: only the first counts as a rest day for the garden; further ones are merely neutral.` }]
        : [];
    // A session of a programme that cares for an active profile (fix wave 3B, B-I6): skipped or moved, said plainly.
    const cared = careOf(row!, athlete.profiles);
    const careNote =
      cared && (op.kind === "skip" || op.kind === "move") ? [{ code: "care_session", message: `This ${op.kind === "skip" ? "skips" : "moves"} a ${careWords(cared)} session.` }] : [];
    const next: PlanAdjustOp = {
      kind: "plan_adjust",
      id,
      op,
      ...(p.change.kind === "swap" ? { verb: "swap" as const } : {}),
      why: p.why,
      issues: [
        ...(op.kind === "adjust" && snapshot.onWatch ? [{ code: "watch_unchanged", message: "The watch keeps its copy as it is: only the plan's length changes." }] : []),
        ...careNote,
        ...restNote,
      ],
      date: snapshot.date,
      row: snapshot,
      toolUseId,
      ...(before ? { replaces: [...(before.replaces ?? []), before.toolUseId] } : {}),
      at,
    };
    const ops = before ? all.map((o) => (o === before ? next : o)) : [...all, next];
    if (!(await upsertProposal(ctx, proposalId, ops, opsText, at))) {
      return refuse("proposal_changed", "The proposal changed while the change was being stored.", "Call adjust_plan again with the same change.");
    }
    return storedAnswer(proposalId, next, { replaced: !!before, sanctionedRest });
  },
};
