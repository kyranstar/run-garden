/**
 * read_plans() — the athlete's plans (§8 §5, stream W): the coach's own blocks (`coach_plans`, not a loose bucket of
 * one-offs), the athlete's adaptive programmes and the watch's plans, each with its id, kind, name, start and end, race
 * day, firm and shape weeks (a block's), the next three sessions still to come, and whether the coach may change its
 * STRUCTURE (`coachMayChange`): only a block it wrote that is still running — propose_plan extends it, firms up a week,
 * winds it down or retires it; a watch plan's sessions are moved, skipped or eased with adjust_plan, a programme is the
 * athlete's own, changed in its settings. A block that ended in the last ENDED_DAYS days is listed too (what comes after
 * it is a plan worth making), never changeable.
 *
 * Names are the athlete's, the coach's or an import's words, and a shape week's volume and key sessions the coach's:
 * marked. One statement: the athlete with the plans, their weeks and next sessions, read beside the preferences. The
 * answer fits RESULT_BUDGET_BYTES: shape weeks past what fits are counted (`moreShapeWeeks`), never cut mid-list.
 */
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { coachPlans, coachPlanWeeks, plannedWorkouts, programs, trainingPlans } from "@rg/database";
import { addDays } from "@rg/domain";
import { LOOSE_PLAN_ID_PREFIX } from "../coach-plans.js";
import { utf8Bytes } from "../utf8.js";
import type { DesignTool } from "./types.js";
import { answer, dayWords, isErr, parseInput, parsedArray, parsedJson, plural, READ_ROLES, readAthlete, RESULT_BUDGET_BYTES, untrusted } from "./read-common.js";
import { ORIGIN_WORDS } from "./read-plan.js";

/** A block that ended this many days ago or less is still listed. */
export const ENDED_DAYS = 30;
/** Plans of each kind listed, at most. */
const PLANS_MAX = 10;
/** Sessions still to come shown per plan. */
export const NEXT_SESSIONS = 3;
/** Shape weeks listed per block before the answer's size is weighed. */
const SHAPE_WEEKS_MAX = 12;
/** A shape week's key sessions shown, at most. */
const KEY_SESSIONS_MAX = 4;

const input = z.object({}).strict();

const pw = plannedWorkouts;

const RUN_CATEGORIES = new Set(["recovery", "easy", "long", "quality", "race"]);
function whatOf(category: string, sport: string): string {
  if (category === "rest") return "rest day";
  if (RUN_CATEGORIES.has(category)) return `run, ${category}`;
  if (category === "strength" || sport === "strength") return "strength";
  if (category === "yoga" || sport === "yoga") return "yoga or mobility";
  return sport || category;
}

/** The next sessions of a plan (its id an SQL expression), still scheduled and not archived, from a day before the UTC
 * day on (the athlete's today is filtered after the read): a JSON array. */
const nextSql = (userId: string, planId: SQL, from: string) => sql`(select json_group_array(json_object('id', n.id, 'date', n.d,
    'time', n.t, 'title', n.title, 'category', n.category, 'sport', n.sport, 'origin', n.origin, 'seconds', n.seconds)) from (
      select ${pw.id} as id, ${pw.effectiveDate} as d, ${pw.effectiveTime} as t, ${pw.title} as title, ${pw.category} as category, ${pw.sport} as sport,
        ${pw.origin} as origin, coalesce(${pw.sourceEstimatedDurationSeconds}, ${pw.fallbackEstimatedDurationSeconds}) as seconds
      from ${pw} where ${pw.userId} = ${userId} and ${pw.planId} = ${planId} and ${pw.archivedAt} is null
        and ${pw.completionState} = 'scheduled' and ${pw.effectiveDate} >= ${from}
      order by ${pw.effectiveDate}, ${pw.effectiveTime}, ${pw.id} limit ${NEXT_SESSIONS + 5}) n)`;

interface Row {
  kind: "block" | "programme" | "watch";
  id: string;
  name: string;
  status: string;
  discipline: string | null;
  start: string | null;
  end: string | null;
  race: string | null;
  config?: unknown;
  weeks?: unknown;
  next?: unknown;
}

const KIND_WORDS = { block: "coach block", programme: "programme", watch: "watch plan" } as const;

/** Why the coach may not change a plan's structure, in its words. */
function whyNot(r: Row, today: string): string | null {
  if (r.kind === "watch") return "a watch plan: move, skip or ease its sessions with adjust_plan; its structure is the watch's";
  if (r.kind === "programme") return "the athlete's own programme: its days and goal are changed in its settings; skip or move a session with adjust_plan";
  if (r.status !== "active" || (r.end !== null && r.end < today)) return `it has ended (${r.status}): plan what comes after it as a new plan`;
  return null;
}

/** How much of each plan an answer shows: its shape weeks and its next sessions, at most. */
interface Room {
  shapes: number;
  next: number;
}

/** One plan as the model reads it, within `room`. */
function planOf(r: Row, today: string, room: Room): Record<string, unknown> {
  const out: Record<string, unknown> = { id: r.id, kind: KIND_WORDS[r.kind], name: untrusted(r.name) };
  if (r.discipline) out.discipline = r.discipline;
  out.status = r.status;
  out.start = r.start;
  out.end = r.end;
  if (r.race) out.raceDate = r.race;
  if (r.kind === "programme") {
    const c = parsedJson(r.config) as { weeklyGoal?: unknown } | null;
    out.weeklyGoal = typeof c?.weeklyGoal === "number" ? c.weeklyGoal : null;
  }
  if (r.kind === "block") {
    const weeks = (parsedArray(r.weeks) as Array<{ weekStart?: unknown; state?: unknown; shape?: unknown }>)
      .filter((w) => typeof w.weekStart === "string")
      .sort((a, b) => String(a.weekStart).localeCompare(String(b.weekStart)));
    out.firmWeeks = weeks.filter((w) => w.state === "firm").map((w) => w.weekStart);
    // The shape weeks still to come (one whose Monday is past is still this week's).
    const shapes = weeks.filter((w) => w.state === "shape" && String(w.weekStart) >= addDays(today, -6));
    out.shapeWeeks = shapes.slice(0, room.shapes).map((w) => {
      const s = (parsedJson(w.shape) ?? w.shape) as { volumeTarget?: unknown; keySessions?: unknown } | null;
      const keys = Array.isArray(s?.keySessions) ? s.keySessions.filter((k): k is string => typeof k === "string") : [];
      return {
        weekStart: w.weekStart,
        volumeTarget: untrusted(typeof s?.volumeTarget === "string" ? s.volumeTarget : ""),
        keySessions: keys.slice(0, KEY_SESSIONS_MAX).map(untrusted),
      };
    });
    if (shapes.length > room.shapes) out.moreShapeWeeks = shapes.length - room.shapes;
  }
  out.next = (parsedArray(r.next) as Array<Record<string, unknown>>)
    .filter((n) => typeof n.date === "string" && n.date >= today)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.time).localeCompare(String(b.time)))
    .slice(0, room.next)
    .map((n) => {
      const origin = typeof n.origin === "string" ? n.origin : null;
      return {
        id: n.id,
        date: n.date,
        day: dayWords(String(n.date), today),
        time: n.time,
        what: whatOf(String(n.category ?? ""), String(n.sport ?? "")),
        minutes: typeof n.seconds === "number" && n.seconds > 0 ? Math.round(n.seconds / 60) : null,
        ...(origin && ORIGIN_WORDS[origin] ? { origin: ORIGIN_WORDS[origin] } : {}),
        title: untrusted(typeof n.title === "string" ? n.title : ""),
      };
    });
  const why = whyNot(r, today);
  out.coachMayChange = why === null;
  if (why) out.why = why;
  return out;
}

const SOURCE = "the athlete's plans: the coach's blocks, their programmes and the watch's plans";

export const readPlans: DesignTool = {
  name: "read_plans",
  description:
    "The athlete's plans — the coach's blocks, their programmes, the watch's plans — each with its id, dates, race day, firm and shape weeks, next sessions, and whether you may change its structure (propose_plan).",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  statementCost: 1,
  cpuWeight: 0.3,
  roles: READ_ROLES,
  async run(ctx, raw) {
    const p = parseInput(input, raw, "no fields");
    if (isErr(p)) return p;
    // The athlete's today is known only after the read: the UTC day's neighbours hold it.
    const utcDay = ctx.now.toISOString().slice(0, 10);
    const from = addDays(utcDay, -1);
    const endedSince = addDays(utcDay, -ENDED_DAYS - 1);
    const cp = coachPlans;
    const { athlete, extra } = await readAthlete(ctx.db, ctx.userId, ctx.now, {
      blocks: sql`(select json_group_array(json_object('kind', 'block', 'id', b.id, 'name', b.name, 'status', b.status, 'discipline', b.discipline,
          'start', b.start_date, 'end', b.end_date, 'race', b.race_date,
          'weeks', (select json_group_array(json_object('weekStart', w.week_start, 'state', w.state, 'shape', json(w.shape)))
            from ${coachPlanWeeks} w where w.plan_id = b.id),
          'next', json(${nextSql(ctx.userId, sql`b.id`, from)}))) from (
          select * from ${cp} where ${cp.userId} = ${ctx.userId} and substr(${cp.id}, 1, ${LOOSE_PLAN_ID_PREFIX.length}) <> ${LOOSE_PLAN_ID_PREFIX}
            and (${cp.status} in ('active', 'draft') or ${cp.endDate} >= ${endedSince})
          order by case when ${cp.status} = 'active' then 0 else 1 end, ${cp.startDate} desc, ${cp.id} limit ${PLANS_MAX}) b)`,
      programmes: sql`(select json_group_array(json_object('kind', 'programme', 'id', g.id, 'name', g.name, 'status', g.status,
          'discipline', (select group_concat(value, ', ') from json_each(case when json_valid(g.disciplines) then g.disciplines else '[]' end)),
          'start', g.start_date, 'end', g.end_date, 'race', g.race_date, 'config', g.config,
          'next', json(${nextSql(ctx.userId, sql`g.id`, from)}))) from (
          select * from ${programs} where ${programs.userId} = ${ctx.userId} and ${programs.kind} = 'adaptive' and ${programs.status} = 'active'
          order by ${programs.createdAt} desc, ${programs.id} limit ${PLANS_MAX}) g)`,
      watch: sql`(select json_group_array(json_object('kind', 'watch', 'id', t.id, 'name', t.name, 'status', t.status, 'discipline', 'run',
          'start', t.start_date, 'end', t.end_date, 'next', json(${nextSql(ctx.userId, sql`t.id`, from)}))) from (
          select * from ${trainingPlans} where ${trainingPlans.userId} = ${ctx.userId} and ${trainingPlans.status} = 'active' and ${trainingPlans.archivedAt} is null
          order by ${trainingPlans.startDate} desc, ${trainingPlans.id} limit ${PLANS_MAX}) t)`,
    });
    const today = athlete.today;
    const rows = [...parsedArray(extra.blocks), ...parsedArray(extra.programmes), ...parsedArray(extra.watch)] as Row[];
    // The coach's own running blocks first (the ones it may work on), then the others as read.
    const ordered = [...rows].sort((a, b) => Number(whyNot(a, today) !== null) - Number(whyNot(b, today) !== null));
    // Shortened until the answer fits: shape weeks halved down to one, then one next session each, then no shape weeks
    // listed (all counted) — and only then the last plans left out, counted (`morePlans`).
    const size = (ps: unknown[]) => utf8Bytes(JSON.stringify({ provenance: { source: SOURCE, asOf: ctx.now.toISOString() }, missing: athlete.missing, data: { plans: ps } }));
    const rooms: Room[] = [];
    for (let shapes = SHAPE_WEEKS_MAX; shapes >= 1; shapes = Math.floor(shapes / 2)) rooms.push({ shapes, next: NEXT_SESSIONS });
    rooms.push({ shapes: 1, next: 1 }, { shapes: 0, next: 1 });
    let plans: Array<Record<string, unknown>> = [];
    for (const room of rooms) {
      plans = ordered.map((r) => planOf(r, today, room));
      if (size(plans) <= RESULT_BUDGET_BYTES) break;
    }
    let left = 0;
    while (plans.length > 1 && size([...plans, { morePlans: left }]) > RESULT_BUDGET_BYTES) {
      plans = plans.slice(0, -1);
      left += 1;
    }
    const missing = [...athlete.missing, ...(plans.length === 0 ? ["no plans yet"] : [])];
    return answer({
      source: SOURCE,
      now: ctx.now,
      missing,
      data: left > 0 ? { plans, morePlans: left } : { plans },
      summary: plans.length === 0 ? "No plans yet" : `Read ${plural(plans.length, "plan")}`,
    });
  },
};
