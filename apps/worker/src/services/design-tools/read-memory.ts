/**
 * recall_memory(query?, kind?) — memory beyond the pinned core (Stage 3 spec §4, §9; principles §6.7). The opening
 * context carries the core; this reads the rest of what is live (memory-core.ts: one definition for both — never a
 * superseded, switched-off or expired item, nor one a rehearsal run wrote), newest first, each with its kind,
 * confidence (stated, inferred — the coach's own inference, not yet confirmed — or confirmed), where it came from (its
 * provenance's source: "saved post" for what a post the athlete saved says about when, why or how often — Save kept it,
 * spec §17), when it was learned, when it expires, and its evidence. `query` matches every word. Bodies and evidence
 * are memory: marked. A page that fits, paged by key (a memory the run writes meanwhile never shifts the next page).
 * Two statements: the athlete (for today), then the page.
 */
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { coachMemory } from "@rg/database";
import { likeWordPatterns } from "../like-pattern.js";
import { liveMemoryWhere, memoryCoreIds } from "../memory-core.js";
import type { DesignTool } from "./types.js";
import {
  CURSOR_SCHEMA,
  cursorField,
  encodeCursor,
  isErr,
  keyCursor,
  limitField,
  limitSchema,
  localDateOf,
  pagedAnswer,
  parseInput,
  plural,
  READ_ROLES,
  athleteOf,
  untrusted,
  untrustedOrNull,
} from "./read-common.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;
const KINDS = ["fact", "rule", "note", "observation"] as const;
const m = coachMemory;
/** Newest first: the latest learning or update. */
const LEARNED = sql<string>`coalesce(${m.updatedAt}, ${m.learnedAt})`;

const input = z
  .object({ query: z.string().max(80).optional(), kind: z.enum(KINDS).optional(), limit: limitField(MAX_LIMIT).optional(), cursor: cursorField.optional() })
  .strict();

export const recallMemory: DesignTool = {
  name: "recall_memory",
  description: "Memory beyond the pinned core, newest first: kind, the body, confidence (stated, inferred or confirmed), source (saved post: a creator's tip Save kept, not the athlete's words), evidence. Filter by words or kind.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Words the memory says (every one)." },
      kind: { type: "string", enum: [...KINDS] },
      limit: limitSchema(DEFAULT_LIMIT, MAX_LIMIT),
      cursor: CURSOR_SCHEMA,
    },
    additionalProperties: false,
  },
  statementCost: 2,
  cpuWeight: 0.4,
  roles: READ_ROLES,
  async run(ctx, raw) {
    const p = parseInput(input, raw, "optionally query, kind, limit and cursor");
    if (isErr(p)) return p;
    const at = keyCursor(p.cursor, 2);
    if (isErr(at)) return at;
    const athlete = await athleteOf(ctx);
    const today = athlete.today;
    const words = likeWordPatterns(p.query);
    const limit = p.limit ?? DEFAULT_LIMIT;
    const rows = await ctx.db
      .select({
        id: m.id,
        kind: m.kind,
        body: m.body,
        confidence: m.confidence,
        pinned: m.pinned,
        learnedAt: m.learnedAt,
        latest: LEARNED,
        expiresAt: m.expiresAt,
        evidence: m.evidence,
        source: sql<string | null>`case when json_valid(${m.provenance}) then json_extract(${m.provenance}, '$.source') end`,
      })
      .from(m)
      .where(
        and(
          liveMemoryWhere(ctx.userId, today),
          // The opening context's core, exactly as it reads it (memory-core.ts).
          notInArray(m.id, memoryCoreIds(ctx.db, ctx.userId, today)),
          ...(p.kind ? [eq(m.kind, p.kind)] : []),
          ...words.map((like) => sql`${m.body} LIKE ${like} ESCAPE '\\'`),
          // Keyed on when an item was learned or last updated: one the run itself updates between two pages moves above
          // the cursor and is not read again. Accepted — the run wrote it, so it knows what it says.
          ...(at ? [sql`(${LEARNED}, ${m.id}) <= (${at[0]}, ${at[1]})`] : []),
        ),
      )
      .orderBy(desc(LEARNED), desc(m.id))
      .limit(limit + 1);
    return pagedAnswer({
      source: "the coach's memory of the athlete, beyond the pinned core",
      now: ctx.now,
      missing: [...athlete.missing, ...(rows.length === 0 && !at ? [p.query ? `no memory matches "${p.query}"` : "no memory beyond the pinned core"] : [])],
      rows,
      limit,
      render: (r) => {
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
      },
      cursorOf: (r) => encodeCursor([r.latest, r.id]),
      data: (memories) => ({ memories }),
      summary: (shown) => (shown ? `Recalled ${plural(shown, "memory", "memories")}${p.query ? " matching the search" : ""}` : "That's everything the coach remembers."),
    });
  },
};
