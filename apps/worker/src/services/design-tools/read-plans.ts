/**
 * read_plans() — the athlete's plans (§8 §5, stream W): the coach's own blocks (`coach_plans`, not a loose bucket of
 * one-offs), the athlete's adaptive programmes, the athlete's Studio plan and the watch's plans, each with its id, kind,
 * name, start and end, race day, firm and shape weeks (a block's), the next three sessions still to come (not the Studio
 * plan's: its sessions are the watch's, read_plan lists them), and whether the coach may change its STRUCTURE
 * (`coachMayChange`): only a block it wrote that is still running — propose_plan extends it, firms up a week, winds it
 * down or retires it; a watch plan's sessions are moved, skipped or eased with adjust_plan, a programme is the athlete's
 * own: its `settings` — days, weekly goal, minutes, block length, modes, care (each switched-on condition's with care, on
 * or off) — change with change_programme; the Studio plan is the Studio's (the newest, as the plan list shows it:
 * `studioPlanEntryOf`). A block whose last day is at most ENDED_DAYS days back is listed whatever its status, never
 * changeable once it has ended or once the athlete stopped it (retired).
 *
 * TRAINING LINES (training lines §3.1, §3.7): the blocks read are grouped as the plan list groups them (@rg/domain
 * `linesOf`): `lines`, each its sport's name and its phases in order (id, name, dates, ended or not), its end, its
 * `last` phase (the one its end is: what "Extend / Wind down my running plan" acts on) and its goal race. Said once
 * beside the lines: a new block starting after at most a week's rest (LINE_MAX_REST_DAYS, seven rest days) from a line's
 * end joins it (`continueLine`, CONTINUE_LINE —
 * the chip's "Plan what comes after my running plan" reads it while the line's last phase still runs), and a line is
 * extended or wound down through its last phase (`extendLine`, EXTEND_LINE).
 *
 * A block that may not change says what may, in `why` (as propose_plan's refusal does, `endedRefusal`): one the athlete
 * stopped stays stopped (STOPPED); one that ended while its line goes on names the phase it goes on in and, for an
 * extend or a wind-down, the line's last phase; one whose line has ended is continued by a next phase (CONTINUE_LINE).
 *
 * Names are the athlete's, the coach's or an import's words, and a shape week's volume and key sessions the coach's:
 * marked. One statement: the athlete with the plans, their weeks and next sessions, and the newest Studio plan with its
 * pushes' statuses and whether it was retired, read beside the preferences. The answer fits RESULT_BUDGET_BYTES: shape
 * weeks past what fits are counted (`moreShapeWeeks`), never cut mid-list.
 */
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { auditEvents, coachPlans, coachPlanWeeks, plannedWorkouts, programs, studioPlanPushes, studioPlans, trainingPlans } from "@rg/database";
import { adaptiveConfigSchema, addDays, linesOf, planEnded, type TrainingLine } from "@rg/domain";
import { lastPhaseOf, lineBlockOf, LOOSE_PLAN_ID_PREFIX, studioPlanEntryOf, studioPlanOnWatch } from "../coach-plans.js";
import { STUDIO_PLAN_RETIRED } from "../studio-push.js";
import { utf8Bytes } from "../utf8.js";
import type { DesignTool } from "./types.js";
import { answer, dayWords, isErr, parseInput, parsedArray, parsedJson, plural, READ_ROLES, readAthlete, RESULT_BUDGET_BYTES, untrusted } from "./read-common.js";
import { listRevisable, nullOriginWords, ORIGIN_WORDS } from "./read-plan.js";
import { DAY_SHORT } from "./change-programme.js";

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
    'time', n.t, 'title', n.title, 'category', n.category, 'sport', n.sport, 'origin', n.origin, 'seconds', n.seconds, 'state', n.state, 'content', n.content, 'source', n.source, 'hasDoc', n.hasDoc)) from (
      select ${pw.id} as id, ${pw.effectiveDate} as d, ${pw.effectiveTime} as t, ${pw.title} as title, ${pw.category} as category, ${pw.sport} as sport,
        ${pw.origin} as origin, ${pw.completionState} as state, ${pw.contentState} as content, ${pw.sourceWorkoutId} as source, ${pw.workoutDoc} is not null as hasDoc, coalesce(${pw.sourceEstimatedDurationSeconds}, ${pw.fallbackEstimatedDurationSeconds}) as seconds
      from ${pw} where ${pw.userId} = ${userId} and ${pw.planId} = ${planId} and ${pw.archivedAt} is null
        and ${pw.completionState} = 'scheduled' and ${pw.effectiveDate} >= ${from}
      order by ${pw.effectiveDate}, ${pw.effectiveTime}, ${pw.id} limit ${NEXT_SESSIONS + 5}) n)`;

interface Row {
  kind: "block" | "programme" | "watch" | "studio";
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

const KIND_WORDS = { block: "coach block", programme: "programme", watch: "watch plan", studio: "Studio plan" } as const;

/** What an ended block says comes next (training lines §3.7): a next phase, which joins its line. */
export const CONTINUE_LINE = "To continue a line, propose its next phase starting the day after the line's last phase ends; it joins the line.";
/** Which phase a line's Extend and Wind down act on (training lines §3.3): said once beside the lines, as `last` names it. */
export const EXTEND_LINE = "Extend or wind down a line through its last phase.";
/** A block the athlete stopped (retired): read_plans' `why` and propose_plan's refusal, in the same words. */
export const STOPPED = {
  why: "The athlete stopped this plan (retired).",
  fix: "Leave it stopped: propose a new plan (createPlan) only if the athlete asks for one.",
} as const;

/** Why the coach may not change a plan's structure, in its words. `lineOf`: each block's line, by its id. */
function whyNot(r: Row, today: string, lineOf: ReadonlyMap<string, TrainingLine>): string | null {
  if (r.kind === "watch") return "a watch plan: move, skip or ease its sessions with adjust_plan; its structure is the watch's";
  if (r.kind === "programme") return "the athlete's own programme: its settings change with change_programme; skip or move one session with adjust_plan";
  if (r.kind === "studio") return "the athlete's Studio plan: its structure is the Studio's; skip or move one of its sessions with adjust_plan, revise one with propose_workout";
  if (r.status === "retired") return `${STOPPED.why} ${STOPPED.fix}`;
  // Changeable while it runs: active, or a draft of the coach's (as propose_plan takes them) whose last day is ahead.
  const running = r.status === "active" || r.status === "draft";
  const ended = r.end !== null && planEnded(r.end, today);
  if (running && !ended) return null;
  const when = `it has ended (${running ? `on ${r.end}` : r.status})`;
  // Its line goes on: the phase running now (or next) is the one to change, and the line's end is its last phase.
  const line = lineOf.get(r.id);
  const goesOn = line && !line.ended ? line.phases.find((p) => p.id === line.currentPhaseId && p.id !== r.id) : undefined;
  if (line && goesOn) {
    const last = lastPhaseOf(line);
    return last.id === goesOn.id
      ? `${when}; its line goes on in ${goesOn.id}, its last phase: change, extend or wind down that phase instead.`
      : `${when}; its line goes on in ${goesOn.id}: change that phase instead. To extend or wind down the line, its last phase is ${last.id}.`;
  }
  return `${when}. ${CONTINUE_LINE}`;
}

/** The newest Studio plan as the read gives it (one JSON object, or null), as the plan list shows it — or null when the
 * list doesn't (nothing of it on the watch, or retired). */
function studioRowOf(raw: unknown, today: string): Row | null {
  const s = parsedJson(raw) as { id?: unknown; name?: unknown; brief?: unknown; createdAt?: unknown; pushes?: unknown; retired?: unknown } | null;
  if (!s || typeof s.id !== "string" || typeof s.createdAt !== "string" || s.retired) return null;
  const pushes = parsedArray(s.pushes).filter((p): p is string => typeof p === "string");
  if (!studioPlanOnWatch(pushes)) return null;
  const e = studioPlanEntryOf({ id: s.id, plan: { name: typeof s.name === "string" ? s.name : undefined }, brief: s.brief ?? null, createdAt: s.createdAt }, pushes, today, null);
  return { kind: "studio", id: e.id, name: e.name, status: e.status, discipline: e.discipline, start: e.startDate, end: e.endDate, race: null };
}

/** How much of each plan an answer shows: its shape weeks and its next sessions, at most. */
interface Room {
  shapes: number;
  next: number;
}

/** A switched-on condition with care, as a programme's care setting names it. */
interface Caring {
  profileId: string;
  care: string;
}

/** One plan as the model reads it, within `room`. */
function planOf(r: Row, today: string, room: Room, caring: readonly Caring[], lineOf: ReadonlyMap<string, TrainingLine>): Record<string, unknown> {
  const out: Record<string, unknown> = { id: r.id, kind: KIND_WORDS[r.kind], name: untrusted(r.name) };
  if (r.discipline) out.discipline = r.discipline;
  out.status = r.status;
  out.start = r.start;
  out.end = r.end;
  if (r.race) out.raceDate = r.race;
  if (r.kind === "programme") {
    const c = adaptiveConfigSchema.safeParse(parsedJson(r.config) ?? {});
    out.weeklyGoal = c.success ? c.data.weeklyGoal : null;
    // What change_programme changes, as the athlete's settings sheet shows it: [] days is any day.
    if (c.success) {
      out.settings = {
        days: c.data.preferredDays.map((d) => DAY_SHORT[d]),
        weeklyGoal: c.data.weeklyGoal,
        minutes: c.data.defaultMinutes,
        blockWeeks: c.data.blockWeeks,
        modes: c.data.modes,
        care: caring.map((p) => ({ ...p, on: c.data.careProfiles.includes(p.profileId) })),
      };
    }
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
  if (r.kind !== "studio") out.next = (parsedArray(r.next) as Array<Record<string, unknown>>)
    .filter((n) => typeof n.date === "string" && n.date >= today)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.time).localeCompare(String(b.time)))
    .slice(0, room.next)
    .map((n) => {
      const origin = typeof n.origin === "string" ? n.origin : null;
      const originWords = origin ? ORIGIN_WORDS[origin] : nullOriginWords(String(n.id), typeof n.source === "string" ? n.source : null);
      return {
        id: n.id,
        date: n.date,
        day: dayWords(String(n.date), today),
        time: n.time,
        what: whatOf(String(n.category ?? ""), String(n.sport ?? "")),
        minutes: typeof n.seconds === "number" && n.seconds > 0 ? Math.round(n.seconds / 60) : null,
        ...(originWords ? { origin: originWords } : {}),
        revisable: listRevisable(
          { origin, category: typeof n.category === "string" ? n.category : null, sport: typeof n.sport === "string" ? n.sport : null, state: typeof n.state === "string" ? n.state : null, content: typeof n.content === "string" ? n.content : null, date: String(n.date), hasDoc: n.hasDoc === 1 },
          today,
        ),
        title: untrusted(typeof n.title === "string" ? n.title : ""),
      };
    });
  const why = whyNot(r, today, lineOf);
  out.coachMayChange = why === null;
  if (why) out.why = why;
  return out;
}

const SOURCE = "the athlete's plans: the coach's blocks and their lines, their programmes, the Studio plan and the watch's plans";

export const readPlans: DesignTool = {
  name: "read_plans",
  description:
    "The athlete's plans — the coach's blocks, their programmes and Studio plan, the watch's plans — each with its id, dates, race day, firm and shape weeks, next sessions, and whether you may change its structure (propose_plan).",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  statementCost: 1,
  // An owner-shaped account — a four-phase line with its weeks and sessions, three buckets, a 24-week Studio plan with
  // its pushes — measured 0.55–0.66 ms (the final review) and 0.26 (the CPU bench's step 8, its first call 1.2): 0.8
  // covers both, with room for the answer's shortening rounds.
  cpuWeight: 0.8,
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
      // The newest Studio plan (the plan list's, loadNonCoachPlanEntries: newest first, the same tie-break), its pushes'
      // statuses and whether the athlete retired it.
      studio: sql`(select json_object('id', s.id, 'name', case when json_valid(s.plan) then json_extract(s.plan, '$.name') end,
          'brief', case when json_valid(s.brief) then json(s.brief) end, 'createdAt', s.created_at,
          'pushes', json((select json_group_array(p.status) from ${studioPlanPushes} p where p.plan_id = s.id)),
          'retired', exists (select 1 from ${auditEvents} a where a.user_id = ${ctx.userId} and a.kind = ${STUDIO_PLAN_RETIRED}
            and json_extract(a.detail, '$.studioPlanId') = s.id)) from (
          select ${studioPlans.id} as id, ${studioPlans.plan} as plan, ${studioPlans.brief} as brief, ${studioPlans.createdAt} as created_at
          from ${studioPlans} where ${studioPlans.userId} = ${ctx.userId}
          order by ${studioPlans.createdAt} desc, ${studioPlans.id} desc limit 1) s)`,
    });
    const today = athlete.today;
    const caring = athlete.profiles.flatMap((p) => (p.care ? [{ profileId: p.id, care: p.care.block.label }] : []));
    const blocks = parsedArray(extra.blocks) as Row[];
    const studio = studioRowOf(extra.studio, today);
    const rows = [...blocks, ...parsedArray(extra.programmes), ...(studio ? [studio] : []), ...parsedArray(extra.watch)] as Row[];
    // The blocks as the plan list groups them: lines, each with its phases (a retired block is none).
    const trainingLines = linesOf(
      blocks.flatMap((b) => (b.start && b.end && b.discipline ? [lineBlockOf({ ...b, discipline: b.discipline, startDate: b.start, endDate: b.end, raceDate: b.race })] : [])),
      today,
    );
    const lineOf = new Map(trainingLines.flatMap((l) => l.phases.map((p) => [p.id, l] as const)));
    const lines = trainingLines.map((l) => ({
      name: l.name,
      discipline: l.discipline,
      phases: l.phases.map((p) => ({ id: p.id, name: untrusted(p.name), start: p.startDate, end: p.endDate, ended: planEnded(p.endDate, today) })),
      end: l.endDate,
      last: lastPhaseOf(l).id,
      goalRace: l.goalRaceDate,
    }));
    // Said once beside the lines (and weighed with them): how to continue a line — the chip's flow ("Plan what comes
    // after my running plan") reads it while the line's last phase still runs, before anything has ended — and that a
    // line is extended or wound down through its last phase ("Extend my running plan", while the line is live).
    const linesData = lines.length > 0 ? { lines, continueLine: CONTINUE_LINE, extendLine: EXTEND_LINE } : { lines };
    // The coach's own running blocks first (the ones it may work on), then the others as read.
    const mayNot = (r: Row) => Number(whyNot(r, today, lineOf) !== null);
    const ordered = [...rows].sort((a, b) => mayNot(a) - mayNot(b));
    // Shortened until the answer fits: shape weeks halved down to one, then one next session each, then no shape weeks
    // listed (all counted) — and only then the last plans left out, counted (`morePlans`).
    const size = (ps: unknown[]) => utf8Bytes(JSON.stringify({ provenance: { source: SOURCE, asOf: ctx.now.toISOString() }, missing: athlete.missing, data: { plans: ps, ...linesData } }));
    const rooms: Room[] = [];
    for (let shapes = SHAPE_WEEKS_MAX; shapes >= 1; shapes = Math.floor(shapes / 2)) rooms.push({ shapes, next: NEXT_SESSIONS });
    rooms.push({ shapes: 1, next: 1 }, { shapes: 0, next: 1 });
    let plans: Array<Record<string, unknown>> = [];
    for (const room of rooms) {
      plans = ordered.map((r) => planOf(r, today, room, caring, lineOf));
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
      data: left > 0 ? { plans, morePlans: left, ...linesData } : { plans, ...linesData },
      summary: plans.length === 0 ? "No plans yet" : `Read ${plural(plans.length, "plan")}`,
    });
  },
};
