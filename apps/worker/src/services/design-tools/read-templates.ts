/**
 * list_templates — the athlete's saved workouts (Stage 3 spec §4; Stage 2 §9): pinned first, then the most used,
 * the most recently used, by name — each with its derived minutes and discipline and its intent, the name and
 * intent marked (the athlete wrote them). A template whose document no longer reads is listed without them. One
 * statement: the athlete with one page of templates.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { workoutTemplates } from "@rg/database";
import { parseStoredWorkoutDoc } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { deriveDoc } from "@rg/workout";
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
  parsedArray,
  parseInput,
  READ_ROLES,
  readAthlete,
  sqlPage,
  untrusted,
} from "./read-common.js";

const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 50;

const input = z.object({ limit: limitField(MAX_LIMIT).optional(), cursor: cursorField.optional() }).strict();

export const listTemplates: DesignTool = {
  name: "list_templates",
  description: "The athlete's saved workouts, pinned and most used first: name, minutes, discipline and intent.",
  inputSchema: {
    type: "object",
    properties: { limit: limitSchema(DEFAULT_LIMIT, MAX_LIMIT), cursor: CURSOR_SCHEMA },
    additionalProperties: false,
  },
  statementCost: 1,
  roles: READ_ROLES,
  async run(ctx, raw) {
    const p = parseInput(input, raw, "optionally limit and cursor");
    if (isErr(p)) return p;
    const offset = offsetOf(p.cursor);
    const limit = p.limit ?? DEFAULT_LIMIT;
    const t = workoutTemplates;
    const { athlete, extra } = await readAthlete(ctx.db, ctx.userId, ctx.now, {
      templates: sql`(select json_group_array(json_object('id', id, 'name', name, 'doc', doc, 'pinned', pinned, 'uses', uses, 'lastUsedAt', last_used_at)) from (
          select ${t.id} as id, ${t.name} as name, ${t.doc} as doc, ${t.pinned} as pinned, ${t.uses} as uses, ${t.lastUsedAt} as last_used_at
          from ${t} where ${t.userId} = ${ctx.userId}
          order by ${t.pinned} desc, ${t.uses} desc, ${t.lastUsedAt} is null, ${t.lastUsedAt} desc, ${t.name}, ${t.id}
          limit ${limit + 1} offset ${offset}))`,
    });
    // The page's own order (an aggregate's input order is SQLite's to choose).
    const rows = (parsedArray(extra.templates) as Array<Record<string, unknown>>).sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        Number(b.uses) - Number(a.uses) ||
        (a.lastUsedAt === null ? 1 : 0) - (b.lastUsedAt === null ? 1 : 0) ||
        String(b.lastUsedAt ?? "").localeCompare(String(a.lastUsedAt ?? "")) ||
        String(a.name).localeCompare(String(b.name)) ||
        String(a.id).localeCompare(String(b.id)),
    );
    const page = sqlPage(rows, offset, limit);
    const templates = page.items.map((r) => {
      const doc = parseStoredWorkoutDoc(r.doc);
      const derived = doc ? deriveDoc(doc, EXERCISES) : null;
      return {
        id: r.id,
        minutes: derived?.estimatedMinutes ?? null,
        discipline: derived?.discipline ?? null,
        pinned: r.pinned === 1,
        uses: typeof r.uses === "number" ? r.uses : 0,
        lastUsed: localDateOf(athlete.tz, r.lastUsedAt),
        name: untrusted(typeof r.name === "string" ? r.name : ""),
        ...(doc ? { intent: untrusted(doc.intent.summary) } : {}),
      };
    });
    return answer({
      source: "the athlete's saved templates",
      now: ctx.now,
      missing: templates.length === 0 && offset === 0 ? ["no saved templates"] : [],
      data: { templates, nextCursor: page.nextCursor },
      summary: templates.length ? `Listed ${templates.length} saved templates` : "No saved templates",
    });
  },
};
