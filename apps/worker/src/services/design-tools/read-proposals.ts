/**
 * read_proposals(status?) — past proposals and how each ended (Stage 3 spec §4, §8): newest first, with the day it
 * was made, its status (pending, approved, partially_approved, declined, superseded, expired) and the day it was
 * resolved, and what it proposed — each change's kind, day and, for a designed workout, its title and how the athlete
 * decided it (design-approve.ts): `approved` as the coach proposed it, `edited` (the athlete changed the draft, then
 * approved theirs), `declined` (with the athlete's reason, when they gave one), or `not_applied` (the server refused
 * it at approval, with why). A rehearsal (the live scenario suite) is never one of them. The title, rationale, a
 * designed workout's title and a decline's reason are others' words: marked. A page that fits, paged by key. One
 * statement: the athlete with one page of proposals.
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

/** How the athlete decided a designed workout (design-approve.ts's outcome), in the tool's words; nothing while open. */
function decided(o: Record<string, unknown>): Record<string, unknown> {
  switch (o.outcome) {
    case "applied":
      return { outcome: o.edited === 1 || o.edited === true ? "edited" : "approved" };
    case "declined":
      return { outcome: "declined", ...(typeof o.reason === "string" ? { reason: untrusted(o.reason) } : {}) };
    case "refused":
      return { outcome: "not_applied", ...(typeof o.why === "string" ? { why: o.why } : {}) };
    default:
      return {};
  }
}

export const readProposals: DesignTool = {
  name: "read_proposals",
  description:
    "Past proposals, newest first: how each ended (approved, partly approved, declined, superseded, expired, pending), what each proposed, and whether each designed workout was approved as it was, edited first, or declined.",
  inputSchema: {
    type: "object",
    properties: { status: { type: "string", enum: [...STATUSES] }, limit: limitSchema(DEFAULT_LIMIT, MAX_LIMIT), cursor: CURSOR_SCHEMA },
    additionalProperties: false,
  },
  statementCost: 1,
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
            (select json_group_array(json_object('kind', ${op("$.kind")}, 'date', coalesce(${op("$.date")}, ${op("$.toDate")}),
              'title', ${op("$.doc.title")}, 'outcome', ${op("$.outcome.status")}, 'edited', ${op("$.outcome.edited")},
              'why', ${op("$.outcome.why")}, 'reason', ${op("$.outcome.reason")}))
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
          created: localDateOf(athlete.tz, r.createdAt),
          status: r.status,
          resolved: localDateOf(athlete.tz, r.resolvedAt),
          ops: ops.slice(0, OPS_SHOWN).map((o) => ({
            kind: typeof o.kind === "string" ? o.kind : "unknown",
            ...(typeof o.date === "string" && isLocalDate(o.date) ? { date: o.date } : {}),
            ...(typeof o.title === "string" ? { title: untrusted(o.title) } : {}),
            ...decided(o),
          })),
          ...(ops.length > OPS_SHOWN ? { moreOps: ops.length - OPS_SHOWN } : {}),
          title: untrusted(typeof r.title === "string" ? r.title : ""),
          ...(rationale ? { rationale } : {}),
        };
      },
      cursorOf: (r) => encodeCursor([String(r.createdAt), String(r.id)]),
      data: (proposals) => ({ proposals }),
      summary: (shown) => (rows.length ? `Read ${plural(shown, "past proposal")}` : "No past proposals"),
    });
  },
};
