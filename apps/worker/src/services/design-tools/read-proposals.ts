/**
 * read_proposals(status?) — past proposals and how each ended (Stage 3 spec §4, §8): newest first, with the day it
 * was made, its status (pending, approved, partially_approved, declined, superseded, expired) and the day it was
 * resolved, and what it proposed — each change's kind, day and, for a designed workout, its title, what the coach based
 * it on (`basedOn`, as it set it), its `opId` (get_workout reads the suggestion back by it, fix wave 13, R8), and how
 * the athlete decided it (design-approve.ts): `approved` as the coach proposed it, `edited` (the athlete changed the draft, then
 * approved theirs), with `moved` and the day it went to (`plannedFor`) when the athlete chose another day or time,
 * `declined` (with the athlete's reason, when they gave one), `not_applied` (the server refused it at approval, with
 * why), or `superseded` (a newer plan covered its day) — and each change to a session already on the plan (Task 8b):
 * the change, the session as it was named, where it moved or its new length, a skip's reason and the coach's why, and
 * how it ended (`approved`, `declined`, `not_applied`, `superseded`). A rehearsal (the live scenario suite) is never one of them. The
 * title, rationale, a designed workout's title, a decline's reason and a refusal's why (it can quote the validator, which
 * quotes what a workout holds) — and a change's session name, reason and why — are marked as others' words. A page that fits, paged by key. One statement: the athlete
 * with one page of proposals.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { coachProposals } from "@rg/database";
import { isLocalDate } from "@rg/domain";
import type { DesignTool } from "./types.js";
import {
  byBytes,
  CURSOR_SCHEMA,
  cursorField,
  dayWords,
  encodeCursor,
  isErr,
  keyCursor,
  limitField,
  limitSchema,
  localDateOf,
  pagedAnswer,
  parsedArray,
  parseInput,
  plural,
  READ_ROLES,
  readAthlete,
  untrusted,
  untrustedOrNull,
} from "./read-common.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;
/** Changes listed per proposal; the rest are counted. */
const OPS_SHOWN = 6;
const STATUSES = ["pending", "approved", "partially_approved", "declined", "superseded", "expired"] as const;

const input = z.object({ status: z.enum(STATUSES).optional(), limit: limitField(MAX_LIMIT).optional(), cursor: cursorField.optional() }).strict();

/** An id as the app writes them: shown as it is; anything else is marked as someone else's words. */
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;

/**
 * A designed workout's lineage as the coach set it (`doc.basedOn`: "like last week's" — a workout at a revision, a
 * template, a logged session; fix wave 3A round 2, B-M2): what it was made from, so the coach learns from what the
 * athlete approved. The workout approval makes is based on the proposal instead (design-approve.ts, Task 8).
 */
function lineageOf(raw: unknown): Record<string, unknown> {
  const b = raw as { kind?: unknown; id?: unknown; rev?: unknown } | null;
  if (!b || typeof b.kind !== "string" || typeof b.id !== "string") return {};
  return { basedOn: { kind: b.kind, id: ID.test(b.id) ? b.id : untrusted(b.id), ...(typeof b.rev === "number" ? { rev: b.rev } : {}) } };
}

/** A day by name and how far from today ("Tue 12 May · yesterday"); null for none. */
const dayOf = (date: string | null, today: string): string | null => (date ? dayWords(date, today) : null);

/** How the athlete decided a designed workout (design-approve.ts's outcome), in the tool's words; nothing while open.
 * get_workout says a suggestion's the same way. */
export function decided(o: Record<string, unknown>): Record<string, unknown> {
  switch (o.outcome) {
    case "applied": {
      const moved = (o.moved === 1 || o.moved === true) && typeof o.wDate === "string";
      return {
        outcome: o.edited === 1 || o.edited === true ? "edited" : "approved",
        ...(moved ? { moved: true, plannedFor: `${o.wDate}${typeof o.wTime === "string" && o.wTime ? ` ${o.wTime}` : ""}` } : {}),
      };
    }
    case "declined":
      return { outcome: "declined", ...(typeof o.reason === "string" ? { reason: untrusted(o.reason) } : {}) };
    case "refused":
      return { outcome: "not_applied", ...(typeof o.why === "string" ? { why: untrusted(o.why) } : {}) };
    case "superseded":
      return { outcome: "superseded" };
    default:
      return {};
  }
}

/** A change to a session already on the plan (adjust_plan's, Task 8b), as the tool reports it: the change, the session
 * as it was named, where it moved or its new length, a skip's reason and the coach's why — model-written, marked — and
 * how it ended. */
function changeOf(o: Record<string, unknown>, today: string): Record<string, unknown> {
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const to = str(o.toDate);
  return {
    kind: "plan_adjust",
    change: str(o.change) ?? "unknown",
    ...(typeof o.date === "string" && isLocalDate(o.date) ? { date: o.date, day: dayWords(o.date, today) } : {}),
    ...(str(o.rowTitle) ? { title: untrusted(str(o.rowTitle)!) } : {}),
    ...(to && isLocalDate(to) ? { to: `${to}${str(o.toTime) ? ` ${str(o.toTime)}` : ""}` } : {}),
    ...(typeof o.minutes === "number" ? { minutes: o.minutes } : {}),
    ...(str(o.skipReason) ? { skipReason: untrusted(str(o.skipReason)!) } : {}),
    ...(str(o.changeWhy) ? { why: untrusted(str(o.changeWhy)!) } : {}),
    ...decided(o),
  };
}

/** A whole plan change (§8 §5; propose_plan's), as the tool reports it: the change, its card's words and the coach's
 * why — model-written, marked — and how it ended: approved with what was added, being applied, or as a change ends. */
function planOf(o: Record<string, unknown>, today: string): Record<string, unknown> {
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  return {
    kind: "plan_structure",
    change: str(o.change) ?? "unknown",
    ...(typeof o.date === "string" && isLocalDate(o.date) ? { date: o.date, day: dayWords(o.date, today) } : {}),
    ...(str(o.planTitle) ? { title: untrusted(str(o.planTitle)!) } : {}),
    ...(str(o.planSummary) ? { summary: untrusted(str(o.planSummary)!) } : {}),
    ...(str(o.changeWhy) ? { why: untrusted(str(o.changeWhy)!) } : {}),
    ...(o.outcome === "applying" ? { outcome: "being_applied" } : decided(o)),
    ...(o.outcome === "applied" && str(o.planDone) ? { added: untrusted(str(o.planDone)!) } : {}),
  };
}

export const readProposals: DesignTool = {
  name: "read_proposals",
  description:
    "Past proposals, newest first: how each ended (approved, partly approved, declined, superseded, expired, pending), what each proposed, and whether each designed workout or plan change was approved as it was, edited first, or declined.",
  inputSchema: {
    type: "object",
    properties: { status: { type: "string", enum: [...STATUSES] }, limit: limitSchema(DEFAULT_LIMIT, MAX_LIMIT), cursor: CURSOR_SCHEMA },
    additionalProperties: false,
  },
  statementCost: 1,
  cpuWeight: 0.4,
  roles: READ_ROLES,
  async run(ctx, raw) {
    const p = parseInput(input, raw, "optionally status, limit and cursor");
    if (isErr(p)) return p;
    // A page starts at its cursor's proposal (made, id; newest first), so one the run proposes meanwhile never shifts it.
    const at = keyCursor(p.cursor, 2);
    if (isErr(at)) return at;
    const limit = p.limit ?? DEFAULT_LIMIT;
    const c = coachProposals;
    const op = (path: string) => sql.raw(`json_extract(o.value, '${path}')`);
    const { athlete, extra } = await readAthlete(ctx.db, ctx.userId, ctx.now, {
      proposals: sql`(select json_group_array(json_object('id', id, 'title', title, 'rationale', rationale, 'status', status, 'createdAt', created_at,
          'resolvedAt', resolved_at, 'ops', ops)) from (
          select ${c.id} as id, ${c.title} as title, ${c.rationale} as rationale, ${c.status} as status, ${c.createdAt} as created_at,
            ${c.resolvedAt} as resolved_at,
            (select json_group_array(json_object('kind', ${op("$.kind")}, 'opId', coalesce(${op("$.by.runId")}, ${op("$.id")}), 'date', coalesce(${op("$.date")}, ${op("$.toDate")}),
              'title', ${op("$.doc.title")}, 'outcome', ${op("$.outcome.status")}, 'edited', ${op("$.outcome.edited")},
              'moved', ${op("$.outcome.moved")}, 'wDate', ${op("$.outcome.written.date")}, 'wTime', ${op("$.outcome.written.time")},
              'why', ${op("$.outcome.why")}, 'reason', ${op("$.outcome.reason")}, 'basedOn', json(${op("$.doc.basedOn")}),
              'change', ${op("$.op.kind")}, 'rowTitle', ${op("$.row.title")}, 'toDate', ${op("$.op.toDate")}, 'toTime', ${op("$.op.toTime")},
              'minutes', ${op("$.op.durationMinutes")}, 'skipReason', ${op("$.op.reason")}, 'changeWhy', ${op("$.why")},
              'planTitle', ${op("$.title")}, 'planSummary', ${op("$.summary")}, 'planDone', ${op("$.outcome.summary")}))
              from json_each(case when json_valid(${c.ops}) then ${c.ops} else '[]' end) o) as ops
          from ${c} where ${c.userId} = ${ctx.userId} and ${c.status} != 'rehearsal' ${p.status ? sql`and ${c.status} = ${p.status}` : sql``}
            ${at ? sql`and (${c.createdAt}, ${c.id}) <= (${at[0]}, ${at[1]})` : sql``}
          order by ${c.createdAt} desc, ${c.id} desc limit ${limit + 1}))`,
    });
    // The page's own order (an aggregate's input order is SQLite's to choose), compared as SQL compares, byte by byte.
    const rows = (parsedArray(extra.proposals) as Array<Record<string, unknown>>).sort(
      (a, b) => byBytes(String(b.createdAt), String(a.createdAt)) || byBytes(String(b.id), String(a.id)),
    );
    return pagedAnswer({
      source: "the coach's proposals and how the athlete resolved them",
      now: ctx.now,
      missing: [...athlete.missing, ...(rows.length === 0 && !at ? [p.status ? `no ${p.status} proposals` : "no proposals yet"] : [])],
      rows,
      limit,
      render: (r) => {
        const ops = parsedArray(r.ops).map((o) => o as Record<string, unknown>);
        const rationale = untrustedOrNull(r.rationale);
        return {
          id: r.id,
          created: dayOf(localDateOf(athlete.tz, r.createdAt), athlete.today),
          status: r.status,
          resolved: dayOf(localDateOf(athlete.tz, r.resolvedAt), athlete.today),
          ops: ops.slice(0, OPS_SHOWN).map((o) => (o.kind === "plan_adjust" ? changeOf(o, athlete.today) : o.kind === "plan_structure" ? planOf(o, athlete.today) : {
            kind: typeof o.kind === "string" ? o.kind : "unknown",
            ...(typeof o.opId === "string" && ID.test(o.opId) ? { opId: o.opId } : {}),
            ...(typeof o.date === "string" && isLocalDate(o.date) ? { date: o.date, day: dayWords(o.date, athlete.today) } : {}),
            ...(typeof o.title === "string" ? { title: untrusted(o.title) } : {}),
            ...lineageOf(o.basedOn),
            ...decided(o),
          })),
          ...(ops.length > OPS_SHOWN ? { moreOps: ops.length - OPS_SHOWN } : {}),
          title: untrusted(typeof r.title === "string" ? r.title : ""),
          ...(rationale ? { rationale } : {}),
        };
      },
      cursorOf: (r) => encodeCursor([String(r.createdAt), String(r.id)]),
      data: (proposals) => ({ proposals }),
      summary: (shown) => (rows.length ? `Read ${plural(shown, "past suggestion")}` : "No past suggestions"),
    });
  },
};
