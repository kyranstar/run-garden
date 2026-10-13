/**
 * read_plan(from, to) — the plan over a range (Stage 3 spec §4): planned workouts by date and time with what each
 * is, its minutes, where it came from, whether it is done, whether it is still an outline the programme builds on its
 * day, and a document workout's intent and revision; plus each active programme's current block (its week and core
 * lifts). Archived rows are not workouts. Two statements: the athlete, then the rows and programmes in one read.
 */
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { plannedWorkouts, programBlocks, programs } from "@rg/database";
import { daysBetween } from "@rg/domain";
import type { DesignTool } from "./types.js";
import {
  answer,
  checkRange,
  CURSOR_SCHEMA,
  cursorField,
  DATE_SCHEMA,
  dateField,
  isErr,
  limitField,
  limitSchema,
  offsetOf,
  parsedJson,
  parseInput,
  READ_ROLES,
  readAthlete,
  readTagged,
  sqlPage,
  untrusted,
  untrustedOrNull,
} from "./read-common.js";

const pw = plannedWorkouts;

/** A document's intent summary read in SQL (a malformed document reads as none, never a failed statement). */
export const INTENT_SQL = sql`case when json_valid(${pw.workoutDoc}) and json_extract(${pw.workoutDoc}, '$.version') = 1
  and json_type(${pw.workoutDoc}, '$.intent.summary') = 'text' then json_extract(${pw.workoutDoc}, '$.intent.summary') end`;

/** Planned rows as `readTagged` reads them (tag `p`), by date, time and id, `limit` rows from `offset`. */
export function planTerm(userId: string, where: SQL, page?: { limit: number; offset: number }): SQL {
  const rows = sql`select 'p' as t, json_object('id', ${pw.id}, 'date', ${pw.effectiveDate}, 'time', ${pw.effectiveTime}, 'title', ${pw.title},
      'category', ${pw.category}, 'subtype', ${pw.qualitySubtype}, 'sport', ${pw.sport}, 'origin', ${pw.origin}, 'state', ${pw.completionState},
      'content', ${pw.contentState}, 'seconds', coalesce(${pw.sourceEstimatedDurationSeconds}, ${pw.fallbackEstimatedDurationSeconds}, ${pw.calendarBlockDurationSeconds}),
      'intent', ${INTENT_SQL}, 'rev', ${pw.workoutDocRev}) as j
    from ${pw} where ${pw.userId} = ${userId} and ${pw.archivedAt} is null and (${where})
    order by ${pw.effectiveDate}, ${pw.effectiveTime}, ${pw.id}`;
  return page ? sql`select t, j from (${rows} limit ${page.limit + 1} offset ${page.offset})` : sql`select t, j from (${rows})`;
}

const RUN_CATEGORIES = new Set(["recovery", "easy", "long", "quality", "race"]);
export const ORIGIN_WORDS: Record<string, string> = {
  program: "programme session",
  on_demand: "on-demand session",
  studio: "Studio workout",
  template: "Studio workout from a template",
  coach: "coach session",
  coros: "watch plan",
};
export const STATUS_WORDS: Record<string, string> = { scheduled: "scheduled", completed: "done", skipped: "skipped", missed: "missed" };

function whatOf(category: string, subtype: string | null, sport: string): string {
  if (category === "rest") return "rest day";
  if (RUN_CATEGORIES.has(category)) return `run, ${category}${subtype ? ` (${subtype})` : ""}`;
  if (category === "strength" || sport === "strength") return "strength";
  if (category === "yoga" || sport === "yoga") return "yoga or mobility";
  if (category === "cross_training") return "cross-training";
  return sport;
}

/** One planned row as the model reads it: the title and intent are the athlete's or an import's words, marked. */
export function planItem(r: Record<string, unknown>): Record<string, unknown> {
  const s = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : null);
  const seconds = typeof r.seconds === "number" ? r.seconds : 0;
  const item: Record<string, unknown> = {
    id: s("id"),
    date: s("date"),
    time: s("time"),
    what: whatOf(s("category") ?? "", s("subtype"), s("sport") ?? ""),
    minutes: seconds > 0 ? Math.round(seconds / 60) : null,
  };
  const origin = s("origin");
  if (origin) item.origin = ORIGIN_WORDS[origin] ?? origin;
  item.status = STATUS_WORDS[s("state") ?? ""] ?? s("state");
  if (s("content")) item.content = s("content");
  if (typeof r.rev === "number") item.rev = r.rev;
  item.title = untrusted(s("title") ?? "");
  const intent = untrustedOrNull(r.intent);
  if (intent) item.intent = intent;
  return item;
}

/** Each active programme's latest block, tagged `b`. */
export function programmesTerm(userId: string): SQL {
  return sql`select 'b' as t, json_object('name', ${programs.name}, 'config', ${programs.config}, 'number', ${programBlocks.number},
      'kind', ${programBlocks.kind}, 'start', ${programBlocks.startDate}, 'weeks', ${programBlocks.weeks}, 'intent', ${programBlocks.intent}) as j
    from ${programs} left join ${programBlocks} on ${programBlocks.programId} = ${programs.id}
      and ${programBlocks.number} = (select max(latest.number) from ${programBlocks} latest where latest.program_id = ${programs.id})
    where ${programs.userId} = ${userId} and ${programs.kind} = 'adaptive' and ${programs.status} = 'active'`;
}

export function programmeOf(r: Record<string, unknown>, today: string): Record<string, unknown> {
  const config = parsedJson(r.config) as { weeklyGoal?: unknown } | null;
  const out: Record<string, unknown> = { name: untrusted(typeof r.name === "string" ? r.name : "") };
  out.weeklyGoal = typeof config?.weeklyGoal === "number" ? config.weeklyGoal : null;
  if (r.kind === "core_block" && typeof r.start === "string" && typeof r.weeks === "number" && typeof r.number === "number") {
    const intent = parsedJson(r.intent) as { core?: Record<string, unknown> } | null;
    const core: Record<string, string | null> = {};
    for (const [family, id] of Object.entries(intent?.core ?? {})) core[family] = typeof id === "string" ? id : null;
    out.block = { number: r.number, week: Math.min(r.weeks, Math.max(1, Math.floor(daysBetween(r.start, today) / 7) + 1)), weeks: r.weeks, core };
  } else out.block = null;
  return out;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const input = z.object({ from: dateField, to: dateField, limit: limitField(MAX_LIMIT).optional(), cursor: cursorField.optional() }).strict();

export const readPlan: DesignTool = {
  name: "read_plan",
  description:
    "Planned workouts between two dates in date and time order — what each is, minutes, origin, whether done, a document workout's intent and revision — and each programme's current block.",
  inputSchema: {
    type: "object",
    properties: { from: DATE_SCHEMA, to: DATE_SCHEMA, limit: limitSchema(DEFAULT_LIMIT, MAX_LIMIT), cursor: CURSOR_SCHEMA },
    required: ["from", "to"],
    additionalProperties: false,
  },
  statementCost: 2,
  roles: READ_ROLES,
  async run(ctx, raw) {
    const p = parseInput(input, raw, "from and to (YYYY-MM-DD), and optionally limit and cursor");
    if (isErr(p)) return p;
    const bad = checkRange(p.from, p.to);
    if (bad) return bad;
    const { athlete } = await readAthlete(ctx.db, ctx.userId, ctx.now);
    const offset = offsetOf(p.cursor);
    const limit = p.limit ?? DEFAULT_LIMIT;
    const rows = await readTagged(ctx.db, [
      planTerm(ctx.userId, sql`${pw.effectiveDate} between ${p.from} and ${p.to}`, { limit, offset }),
      programmesTerm(ctx.userId),
    ]);
    const ordered = (rows.get("p") ?? []).sort((a, b) => `${a.date} ${a.time} ${a.id}`.localeCompare(`${b.date} ${b.time} ${b.id}`));
    const page = sqlPage(ordered, offset, limit);
    const programmes = (rows.get("b") ?? []).map((r) => programmeOf(r, athlete.today));
    return answer({
      source: "the plan (planned workouts) and the athlete's programmes",
      now: ctx.now,
      missing: [],
      data: { from: p.from, to: p.to, workouts: page.items.map(planItem), programmes, nextCursor: page.nextCursor },
      summary: page.items.length || offset ? `Read the plan from ${p.from} to ${p.to}` : `Nothing planned from ${p.from} to ${p.to}`,
    });
  },
};
