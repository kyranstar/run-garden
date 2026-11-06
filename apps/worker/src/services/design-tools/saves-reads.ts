/**
 * WHAT THE RUN READ OF A SAVES BATCH (import trail phase 3; design 2026-11-05 §8.1, §8.3). Each read_saves call leaves a
 * receipt in its trail event (`receipt.saves`: the batch, the moves its page showed with their first post, the posts it
 * read and each quote id with where it points). pin_moves and correct_import read them back as one scalar subquery inside
 * their own statement — so a line can cite only what the run read, and a line about a move of the batch needs a page
 * that covered it. The main run's trail holds every call of its tree (a designer's and a reviewer's too).
 */
import { sql, type SQL } from "drizzle-orm";
import type { QuoteCheck } from "@rg/saves";
import { parseCite, quoteLabel, quoteMoveNo, type CiteRef, type QuoteRef } from "../saves-evidence.js";
import { parsedArray, parsedJson } from "./read-common.js";

/** The run's read_saves receipts — for `batchId`, or every batch it read — as ONE JSON value: `[[at, receipt]]`, oldest
 * first. */
export function savesReadsSql(userId: string, mainRunId: string, batchId?: string): SQL {
  return sql`(select json_group_array(json_array(sr_e.at, json(json_extract(sr_e.payload, '$.receipt.saves')))) from (
      select * from coach_run_events sr_x where sr_x.run_id = ${mainRunId} and sr_x.user_id = ${userId} and sr_x.kind = 'tool_result'
        and json_valid(sr_x.payload) and json_extract(sr_x.payload, '$.tool') = 'read_saves'
        and ${batchId !== undefined ? sql`json_extract(sr_x.payload, '$.receipt.saves.batch') = ${batchId}` : sql`json_extract(sr_x.payload, '$.receipt.saves') is not null`}
      order by sr_x.seq) sr_e)`;
}

export interface SavesReads {
  /** Each move a page showed, with its first post, its place in the batch (a quote id's n) and the fields its posts
   * stated (what stated:<field> may cite). */
  moves: Map<string, { postId: string; position: number; n: number | null; stated: string[] }>;
  quotes: Map<string, QuoteRef>;
  /** When the run first read each post. */
  readAt: Map<string, string>;
}

const CHECKS = new Set<string>(["verified", "in_speech", "on_screen", "not_found"]);

/** `savesReadsSql`'s value, read. */
export function savesReadsOf(raw: unknown): SavesReads {
  const out: SavesReads = { moves: new Map(), quotes: new Map(), readAt: new Map() };
  for (const row of parsedArray(raw)) {
    const [at, receipt] = Array.isArray(row) ? (row as unknown[]) : [];
    const r = (parsedJson(receipt) ?? receipt) as { moves?: unknown; posts?: unknown; quotes?: unknown } | null;
    if (!r || typeof r !== "object") continue;
    for (const m of Array.isArray(r.moves) ? r.moves : []) {
      const [moveId, postId, position, n, stated] = Array.isArray(m) ? (m as unknown[]) : [];
      if (typeof moveId !== "string" || typeof postId !== "string" || typeof position !== "number") continue;
      const fields = Array.isArray(stated) ? stated.filter((f): f is string => typeof f === "string") : [];
      const had = out.moves.get(moveId);
      if (!had) out.moves.set(moveId, { postId, position, n: typeof n === "number" ? n : null, stated: fields });
      else had.stated = [...new Set([...had.stated, ...fields])];
    }
    for (const postId of Array.isArray(r.posts) ? r.posts : []) {
      if (typeof postId === "string" && typeof at === "string" && !out.readAt.has(postId)) out.readAt.set(postId, at);
    }
    const quotes = r.quotes && typeof r.quotes === "object" ? (r.quotes as Record<string, unknown>) : {};
    for (const [id, q] of Object.entries(quotes)) {
      const [postId, position, quote, check, from, qAt] = Array.isArray(q) ? (q as unknown[]) : [];
      if (typeof postId !== "string" || typeof position !== "number" || typeof quote !== "number") continue;
      out.quotes.set(id, {
        postId, position, quote,
        check: typeof check === "string" && CHECKS.has(check) ? (check as QuoteCheck) : null,
        from: typeof from === "string" ? from : "caption",
        at: typeof qAt === "number" ? qAt : null,
      });
    }
  }
  return out;
}

/** A cite as the card draws it (saves-evidence.ts `CiteRef`): a quote's chip and where it opens; the reader's guess opens
 * the move it is about at its first post. Null for a cite that isn't one, or a quote id the run never read. */
export function citeRefOf(id: string, reads: SavesReads, moveId: string | undefined): CiteRef | null {
  const p = parseCite(id);
  if (!p) return null;
  if (p.kind === "quote") {
    const r = reads.quotes.get(id);
    return r ? { id, kind: "quote", label: quoteLabel(r), postId: r.postId, position: r.position, quote: r.quote } : null;
  }
  if (p.kind === "history") return { id: "history", kind: "history", label: "your history" };
  if (p.kind === "goal") return { id, kind: "goal", label: "your goal", goalId: p.goalId };
  const first = moveId ? reads.moves.get(moveId) : undefined;
  const at = first ? { postId: first.postId, position: first.position } : {};
  // The reader's report: a field its posts stated, as the run read them (the controller's fix pass, C1).
  if (p.kind === "stated") return first?.stated.includes(p.field) ? { id, kind: "stated", label: "reader's report", field: p.field, ...at } : null;
  return { id, kind: "inferred", label: "reader's guess", field: p.field, ...at };
}

/** A quote cite on a line about `moveId` that is another move's (the controller's fix pass, D5): that move's place in
 * the batch — so a chip never vouches for the wrong move. Null when it is the move's own, or can't be told. */
export function otherMovesQuote(id: string, reads: SavesReads, moveId: string | undefined): number | null {
  const n = quoteMoveNo(id);
  const own = moveId ? reads.moves.get(moveId)?.n : null;
  return n !== null && own !== null && own !== undefined && n !== own ? n : null;
}
