/**
 * recall_memory(query?, kind?) — memory beyond the pinned core (Stage 3 spec §4, §9; principles §6.7). The opening
 * context carries the core: pinned items, then the most recent facts and rules, twenty at most (design-context.ts,
 * `MEMORY_CORE`) — this reads the rest, newest first, each with its kind, confidence (stated, inferred — the coach's
 * own inference, not yet confirmed — or confirmed), where it came from, when it was learned, when it expires, and its
 * evidence. Never a superseded, switched-off or expired item, nor one a rehearsal run wrote (`provenance.rehearsal`).
 * Bodies and evidence are memory: marked. Two statements: the athlete (for today), then the page.
 */
import { and, asc, desc, eq, gte, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { coachMemory } from "@rg/database";
import { likePatternOf } from "../../routes/workouts.js";
import type { DesignTool } from "./types.js";
import {
  answer,
  CURSOR_SCHEMA,
  cursorField,
  isErr,
  limitField,
  limitSchema,
  localDateOf,
  offsetOf,
  parseInput,
  READ_ROLES,
  readAthlete,
  sqlPage,
  untrusted,
  untrustedOrNull,
} from "./read-common.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;
/** The pinned core's size: the opening context's `MEMORY_CORE` (design-context.ts), read the same way here. */
const MEMORY_CORE = 20;
const KINDS = ["fact", "rule", "note", "observation"] as const;
const m = coachMemory;

/** A row a rehearsal run wrote: never memory the athlete has. */
export const REHEARSAL_MEMORY = sql`coalesce(case when json_valid(${m.provenance}) then json_extract(${m.provenance}, '$.rehearsal') end, 0) = 1`;

const input = z
  .object({ query: z.string().max(80).optional(), kind: z.enum(KINDS).optional(), limit: limitField(MAX_LIMIT).optional(), cursor: cursorField.optional() })
  .strict();

export const recallMemory: DesignTool = {
  name: "recall_memory",
  description: "Memory beyond the pinned core, newest first: kind, the body, confidence (stated, inferred or confirmed), source, evidence. Filter by words or kind.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Words the memory says." },
      kind: { type: "string", enum: [...KINDS] },
      limit: limitSchema(DEFAULT_LIMIT, MAX_LIMIT),
      cursor: CURSOR_SCHEMA,
    },
    additionalProperties: false,
  },
  statementCost: 2,
  roles: READ_ROLES,
  async run(ctx, raw) {
    const p = parseInput(input, raw, "optionally query, kind, limit and cursor");
    if (isErr(p)) return p;
    const { athlete } = await readAthlete(ctx.db, ctx.userId, ctx.now);
    const today = athlete.today;
    const live: SQL = and(eq(m.userId, ctx.userId), eq(m.active, true), isNull(m.supersededBy), or(isNull(m.expiresAt), gte(m.expiresAt, today)))!;
    // The opening context's core, exactly as it reads it.
    const core = ctx.db
      .select({ id: m.id })
      .from(m)
      .where(and(live, or(eq(m.pinned, true), sql`${m.kind} in ('fact', 'rule')`)))
      .orderBy(desc(m.pinned), desc(sql`coalesce(${m.updatedAt}, ${m.learnedAt})`), asc(m.id))
      .limit(MEMORY_CORE);
    const like = likePatternOf(p.query);
    const offset = offsetOf(p.cursor);
    const limit = p.limit ?? DEFAULT_LIMIT;
    const rows = await ctx.db
      .select({
        id: m.id,
        kind: m.kind,
        body: m.body,
        confidence: m.confidence,
        pinned: m.pinned,
        learnedAt: m.learnedAt,
        expiresAt: m.expiresAt,
        evidence: m.evidence,
        source: sql<string | null>`case when json_valid(${m.provenance}) then json_extract(${m.provenance}, '$.source') end`,
      })
      .from(m)
      .where(
        and(
          live,
          sql`not ${REHEARSAL_MEMORY}`,
          notInArray(m.id, core),
          ...(p.kind ? [eq(m.kind, p.kind)] : []),
          ...(like ? [sql`${m.body} LIKE ${like} ESCAPE '\\'`] : []),
        ),
      )
      .orderBy(desc(sql`coalesce(${m.updatedAt}, ${m.learnedAt})`), asc(m.id))
      .limit(limit + 1)
      .offset(offset);
    const page = sqlPage(rows, offset, limit);
    const memories = page.items.map((r) => {
      const evidence = untrustedOrNull(r.evidence);
      return {
        id: r.id,
        kind: r.kind,
        confidence: r.confidence,
        ...(r.pinned ? { pinned: true } : {}),
        ...(r.source ? { source: r.source } : {}),
        learned: localDateOf(athlete.tz, r.learnedAt),
        ...(r.expiresAt ? { expires: localDateOf(athlete.tz, r.expiresAt) } : {}),
        ...(evidence ? { evidence } : {}),
        body: untrusted(r.body),
      };
    });
    const missing: string[] = [];
    if (memories.length === 0 && offset === 0) missing.push(p.query ? `no memory matches "${p.query}"` : "no memory beyond the pinned core");
    return answer({
      source: "the coach's memory of the athlete, beyond the pinned core",
      now: ctx.now,
      missing,
      data: { memories, nextCursor: page.nextCursor },
      summary: memories.length ? `Recalled ${memories.length} memories${p.query ? " matching the search" : ""}` : "Nothing more remembered",
    });
  },
};
