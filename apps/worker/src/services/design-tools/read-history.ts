/**
 * read_history(from, to, kind?) — what was actually done (Stage 3 spec §4): logged sessions with their moves, sets,
 * flags and checks before and after; runs with distance, pace, heart rate and feel; other sports. One compact line
 * each, newest first, paged. The prompt's guide lines (step down, hold, rotate) turn on a session's check rising and
 * its flagged sets, so both are on every session line. Two statements: the athlete, then everything in one read.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { performedSessions } from "@rg/database";
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
  pageOf,
  parseInput,
  READ_ROLES,
  readAthlete,
  readTagged,
} from "./read-common.js";
import { ACTIVITY_DAY, doneEntries, doneTerms, sessionsWhere, type DoneKind } from "./read-sessions.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;
const KINDS = ["sessions", "runs", "other"] as const satisfies readonly DoneKind[];
const KIND_WORDS: Record<DoneKind, string> = { sessions: "logged sessions", runs: "runs", other: "other sports" };

const input = z
  .object({
    from: dateField,
    to: dateField,
    kind: z.enum(KINDS).optional(),
    limit: limitField(MAX_LIMIT).optional(),
    cursor: cursorField.optional(),
  })
  .strict();

export const readHistory: DesignTool = {
  name: "read_history",
  description:
    "What was actually done between two dates, newest first: logged sessions (moves, sets, flags, checks before and after), runs (distance, pace, heart rate, feel) and other sports.",
  inputSchema: {
    type: "object",
    properties: {
      from: DATE_SCHEMA,
      to: DATE_SCHEMA,
      kind: { type: "string", enum: [...KINDS], description: "Only logged sessions, only runs, or only other sports. Default: all." },
      limit: limitSchema(DEFAULT_LIMIT, MAX_LIMIT),
      cursor: CURSOR_SCHEMA,
    },
    required: ["from", "to"],
    additionalProperties: false,
  },
  statementCost: 2,
  roles: READ_ROLES,
  async run(ctx, raw) {
    const p = parseInput(input, raw, "from and to (YYYY-MM-DD), and optionally kind, limit and cursor");
    if (isErr(p)) return p;
    const bad = checkRange(p.from, p.to);
    if (bad) return bad;
    const { athlete } = await readAthlete(ctx.db, ctx.userId, ctx.now);
    const scope = sessionsWhere(ctx.userId, sql`${performedSessions.localDate} between ${p.from} and ${p.to}`);
    const rows = await readTagged(ctx.db, doneTerms(ctx.userId, scope, { activitiesWhere: sql`${ACTIVITY_DAY} between ${p.from} and ${p.to}` }));
    const all = doneEntries(
      { sessions: rows.get("s"), sets: rows.get("x"), checks: rows.get("c"), activities: rows.get("a") },
      { tz: athlete.tz, units: athlete.prefs.units, weightUnit: athlete.prefs.weightUnit },
    ).filter((e) => !p.kind || e.kind === p.kind);
    const page = pageOf(all, offsetOf(p.cursor), p.limit ?? DEFAULT_LIMIT);
    const what = p.kind ? KIND_WORDS[p.kind] : "sessions and activities";
    return answer({
      source: "logged sessions (app and watch) and the watch's activities",
      now: ctx.now,
      missing: all.length === 0 ? [`${p.kind ? `no ${KIND_WORDS[p.kind]}` : "nothing logged"} from ${p.from} to ${p.to}`] : [],
      data: { from: p.from, to: p.to, entries: page.items.map((e) => e.entry), nextCursor: page.nextCursor },
      summary: all.length ? `Read ${all.length} ${what} from ${p.from} to ${p.to}` : `Found no ${what} from ${p.from} to ${p.to}`,
    });
  },
};
