/**
 * read_history(from, to, kind?) — what was actually done (Stage 3 spec §4): logged sessions with their moves, sets,
 * flags and checks before and after; runs with distance, pace, heart rate and feel; other sports. One compact line
 * each, newest first, each with its id; a page that fits, paged by key (a session logged meanwhile never shifts the
 * next page). The prompt's guide lines (step down, hold, rotate) turn on a session's check rising and its flagged
 * sets, so both are on every session line. Two statements: the athlete, then everything in one read.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { performedSessions } from "@rg/database";
import { dayRangeLabel } from "@rg/domain";
import type { DesignTool } from "./types.js";
import {
  checkRange,
  CURSOR_SCHEMA,
  cursorField,
  DATE_SCHEMA,
  dateField,
  encodeCursor,
  isErr,
  keyCursor,
  limitField,
  limitSchema,
  pagedAnswer,
  parseInput,
  plural,
  READ_ROLES,
  readAthlete,
  readTagged,
} from "./read-common.js";
import { activitiesAround, DONE_KINDS, doneEntries, doneTerms, sessionsWhere, type DoneKind } from "./read-sessions.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;
const KIND_WORDS: Record<DoneKind, [string, string]> = { session: ["logged session", "logged sessions"], run: ["run", "runs"], other: ["other sport", "other sports"] };

const input = z
  .object({
    from: dateField,
    to: dateField,
    kind: z.enum(DONE_KINDS).optional(),
    limit: limitField(MAX_LIMIT).optional(),
    cursor: cursorField.optional(),
  })
  .strict();

export const readHistory: DesignTool = {
  name: "read_history",
  description:
    "What was actually done between two dates, newest first: logged sessions (moves, sets, flags, checks before and after), runs (distance, pace, heart rate, feel) and other sports, each with its id.",
  inputSchema: {
    type: "object",
    properties: {
      from: DATE_SCHEMA,
      to: DATE_SCHEMA,
      kind: { type: "string", enum: [...DONE_KINDS], description: "Only one kind of line, as each line's kind says. Default: all." },
      limit: limitSchema(DEFAULT_LIMIT, MAX_LIMIT),
      cursor: CURSOR_SCHEMA,
    },
    required: ["from", "to"],
    additionalProperties: false,
  },
  statementCost: 2,
  cpuWeight: 1.6,
  roles: READ_ROLES,
  async run(ctx, raw) {
    const p = parseInput(input, raw, "from and to (YYYY-MM-DD), and optionally kind, limit and cursor");
    if (isErr(p)) return p;
    const bad = checkRange(p.from, p.to);
    if (bad) return bad;
    const after = keyCursor(p.cursor, 1);
    if (isErr(after)) return after;
    const { athlete } = await readAthlete(ctx.db, ctx.userId, ctx.now);
    const scope = sessionsWhere(ctx.userId, sql`${performedSessions.localDate} between ${p.from} and ${p.to}`);
    const rows = await readTagged(ctx.db, doneTerms(ctx.userId, scope, { activitiesWhere: activitiesAround(p.from, p.to) }));
    const all = doneEntries(
      { sessions: rows.get("s"), sets: rows.get("x"), checks: rows.get("c"), activities: rows.get("a") },
      { tz: athlete.tz, units: athlete.prefs.units, weightUnit: athlete.prefs.weightUnit },
      { from: p.from, to: p.to },
    ).filter((e) => !p.kind || e.kind === p.kind);
    // Newest first: a page starts at its cursor's line, or at the newest.
    const start = after ? all.findIndex((e) => e.key <= after[0]!) : 0;
    const from = start < 0 ? all.length : start;
    const [one, many] = p.kind ? KIND_WORDS[p.kind] : ["entry", "entries"];
    return pagedAnswer({
      source: "logged sessions (app and watch) and the watch's activities",
      now: ctx.now,
      missing: [...athlete.missing, ...(all.length === 0 ? [`${p.kind ? `no ${many}` : "nothing logged"} from ${p.from} to ${p.to}`] : [])],
      rows: all.slice(from, from + (p.limit ?? DEFAULT_LIMIT) + 1),
      limit: p.limit ?? DEFAULT_LIMIT,
      render: (e) => e.entry,
      cursorOf: (e) => encodeCursor([e.key]),
      data: (entries) => ({ from: p.from, to: p.to, entries }),
      summary: (shown) =>
        all.length ? `Read ${plural(shown, one, many)} of ${all.length}, ${dayRangeLabel(p.from, p.to)}` : `Found no ${many}, ${dayRangeLabel(p.from, p.to)}`,
    });
  },
};
