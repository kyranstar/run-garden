/**
 * remember(kind, body, confidence, evidence?, expires?, replaces?) — a durable item of memory v2 (Stage 3 spec §9;
 * principles §6.7; coach-memory.ts): a fact, a rule, a note (with its last day) or an observation (with the evidence
 * for it). Its confidence is `stated` — the athlete said it — or `inferred` — the coach concluded it; never
 * `confirmed`, which only the athlete gives. Where it came from goes with it (the athlete's words or the coach's
 * inference, the run, when), and a rehearsal run's item is marked as one (`provenance.rehearsal`) so no run ever reads
 * it as the athlete's. `replaces` updates an item by its id: the new one is written — keeping the old one's pin (fix
 * wave 3B, A-M1) — and the old one kept, superseded by it; but an inference never replaces what the athlete confirmed,
 * and what they state replaces it only with their own words from the request (`quote`). Only a note expires: after
 * today, within a year.
 *
 * A rehearsal run writes its marked row and NEVER supersedes the athlete's item (it answers that it would have).
 *
 * At most MEMORY_PER_RUN items per run, counted over the main run's whole tree. Keyed on the call's tool-use id: a
 * replay writes nothing new and answers the same. Its line carries an undo handle (record_answer's design, Task 10):
 * the run view's Undo takes the item back and puts back what it replaced, its pin within the cap (`undoRemembered`).
 * The body is the athlete's (or the coach's) words — data — and comes
 * back marked. Three statements: the athlete (with the run's count, a replay's row and the replaced item), then the
 * insert and the supersede, as one batch.
 */
import { and, eq, isNull, sql, type AnyColumn } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { addDays, newId, todayInZone } from "@rg/domain";
import { coachMemory, coachRuns } from "@rg/database";
import { runAtomically, type Db } from "../db.js";
import { COACH_CONFIDENCES, MEMORY_KINDS, memoryWrites } from "../coach-memory.js";
import { EARLIEST_ZONE, liveMemoryWhere, MEMORY_PIN_CAP } from "../memory-core.js";
import type { DesignTool } from "./types.js";
import { isErr, mainRunIdOf, parseAct } from "./act-common.js";
import { quoteIn } from "./record-answer.js";
import { dateField, parsedJson, readAthlete, refuse, untrusted } from "./read-common.js";

/** Items one run (with its sub-runs) may write. */
export const MEMORY_PER_RUN = 5;
const BODY_MAX = 300;
const EVIDENCE_ITEMS = 5;
const EVIDENCE_MAX = 200;
/** A note's expiry, at most this far ahead. */
const NOTE_DAYS_MAX = 365;

const input = z
  .object({
    kind: z.enum(MEMORY_KINDS),
    body: z.string().trim().min(1).max(BODY_MAX),
    confidence: z.enum(COACH_CONFIDENCES),
    evidence: z.array(z.string().trim().min(1).max(EVIDENCE_MAX)).min(1).max(EVIDENCE_ITEMS).optional(),
    expires: dateField.optional(),
    replaces: z.string().min(1).max(120).optional(),
    quote: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const m = coachMemory;

/** A confidence as the run view and the Settings list both say it. */
const CONFIDENCE_WORDS: Record<string, string> = { stated: "you said", inferred: "the coach inferred", confirmed: "confirmed" };

/**
 * The handle an undo names (record_answer's design, `rm:<main run>:<tool-use id>`): the run view's Undo posts it to
 * `POST /api/coach/runs/:id/undo-answer`, which only takes back a handle naming that run.
 */
export const memoryHandle = (mainRunId: string, callId: string): string => `rm:${mainRunId}:${callId}`;

/**
 * Take back what one `remember` call kept (its handle), for `userId` only: the item is deleted as the Settings list
 * deletes one (`active` off), and what it replaced is live again — unless the item had itself been replaced since,
 * when the history stays as it is. Null when there is nothing to take back (already taken back, or never this
 * athlete's).
 *
 * A PIN COMES BACK WITHIN THE CAP (fix wave 3B, A-M1). What comes back keeps its pin while the athlete's other live pins
 * — the item taken back not among them: it goes in the same undo — leave room under MEMORY_PIN_CAP; past it, it comes
 * back unpinned, and the line says so. The write decides (the count in its own statement); the read before it says.
 *
 * Three statements: the read of the item, what it replaced and the other pins; then the replaced item put back first —
 * should the last fail, both are live: a repeat, never a loss, and the undo can be tried again.
 */
export async function undoRemembered(db: Db, userId: string, handle: string): Promise<{ line: string; count: number } | null> {
  const parsed = /^rm:([^:]{1,120}):([A-Za-z0-9_-]{1,120})$/.exec(handle);
  if (!parsed) return null;
  const [, rootId, callId] = parsed as unknown as [string, string, string];
  const suffix = `:${callId}`;
  // The item: this athlete's, written in that main run's tree (`provenance.runId`), by that call (`mem:<run>:<call>`).
  const theItemOf = (t: { id: AnyColumn; userId: AnyColumn; provenance: AnyColumn }) =>
    and(
      eq(t.userId, userId),
      sql`substr(${t.id}, 1, 4) = 'mem:'`,
      sql`substr(${t.id}, length(${t.id}) - ${suffix.length} + 1) = ${suffix}`,
      sql`case when json_valid(${t.provenance}) then json_extract(${t.provenance}, '$.runId') end = ${rootId}`,
    )!;
  const theItem = theItemOf(m);
  /** The athlete's live pins (the PATCH's own count: memory-core.ts's live) but the item's, named by the outer row. */
  const pins = and(liveMemoryWhere(userId, todayInZone(EARLIEST_ZONE)), eq(m.pinned, true));
  // Raw, with each table named: a column in a select's fields is written without its table, which a subquery over the
  // same table would read as its own.
  const item = alias(coachMemory, "item");
  const [found] = (await db.all(sql`
    SELECT item.id AS id,
      CASE WHEN item.superseded_by IS NULL THEN (SELECT json_object('body', r.body, 'pinned', r.pinned) FROM coach_memory r
        WHERE r.user_id = ${userId} AND r.superseded_by = item.id AND r.active = 1 LIMIT 1) END AS back,
      (SELECT count(*) FROM ${m} WHERE ${pins} AND ${m.id} <> item.id) AS otherPins
    FROM coach_memory item
    WHERE ${theItemOf(item)} AND item.active = 1
    LIMIT 1
  `)) as Array<{ id: string; back: string | null; otherPins: number }>;
  if (!found) return null;
  const now = new Date().toISOString();
  await db
    .update(m)
    .set({
      supersededBy: null,
      updatedAt: now,
      pinned: sql`case when ${m.pinned} = 1 and (select count(*) from ${m} where ${pins} and ${m.id} <> ${found.id}) >= ${MEMORY_PIN_CAP} then 0 else ${m.pinned} end`,
    })
    .where(
      and(
        eq(m.userId, userId),
        sql`${m.supersededBy} = (select ${m.id} from ${m} where ${and(theItem, eq(m.active, true), isNull(m.supersededBy))} limit 1)`,
      ),
    );
  const [gone] = await db.update(m).set({ active: false, updatedAt: now }).where(and(theItem, eq(m.active, true))).returning({ body: m.body });
  if (!gone) return null;
  const back = parsedJson(found.back) as { body?: unknown; pinned?: unknown } | null;
  const unpinned = !!back && (back.pinned === 1 || back.pinned === true) && Number(found.otherPins) >= MEMORY_PIN_CAP;
  return {
    line: `the memory "${gone.body}"${unpinned ? `. "${String(back.body)}" is back, unpinned: you have ${MEMORY_PIN_CAP} pinned already.` : ""}`,
    count: 1,
  };
}

export const remember: DesignTool = {
  name: "remember",
  description:
    "The main coach and designers: keep a durable fact, rule, note (with expires) or observation (with evidence) about the athlete. Confidence: stated (they said it) or inferred (you concluded it) — only the athlete confirms. replaces: an item's id, to update it.",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: [...MEMORY_KINDS] },
      body: { type: "string", minLength: 1, maxLength: BODY_MAX },
      confidence: { type: "string", enum: [...COACH_CONFIDENCES] },
      evidence: { type: "array", minItems: 1, maxItems: EVIDENCE_ITEMS, items: { type: "string", minLength: 1, maxLength: EVIDENCE_MAX }, description: "What supports it: required for an observation." },
      expires: { type: "string", description: "A note's last day, YYYY-MM-DD: required for a note." },
      replaces: { type: "string", description: "The id of the item this one updates (the old one is kept as history)." },
      quote: {
        type: "string",
        maxLength: 200,
        description: "Only when replacing an item the athlete confirmed (and then required): the request's own words that change it. Refused anywhere else.",
      },
    },
    required: ["kind", "body", "confidence"],
    additionalProperties: false,
  },
  statementCost: 3,
  roles: ["main", "designer"],
  async run(ctx, raw) {
    if ((raw as { confidence?: unknown } | null)?.confidence === "confirmed") {
      return refuse(
        "not_yours_to_confirm",
        "Only the athlete confirms a memory.",
        "Write it as stated (the athlete said it) or inferred (you concluded it); the athlete can confirm it in Settings.",
      );
    }
    const p = parseAct(input, raw, "kind, body, confidence (stated or inferred), and optionally evidence, expires, replaces and quote");
    if (isErr(p)) return p;
    const quoteUnused = refuse(
      "quote_unused",
      "quote is only for replacing an item the athlete confirmed: their own words from the request that change it.",
      "Leave quote out (an item's body keeps what was said); give it only with replaces of an item the athlete confirmed.",
    );
    if (p.quote && !p.replaces) return quoteUnused;
    const rootId = mainRunIdOf(ctx);
    if (!rootId) return refuse("no_main_run", "This run has no main run to remember for.", "Finish with what you have.");
    const callId = ctx.toolUseId ?? newId();
    const id = `mem:${ctx.run.id}:${callId}`;
    const { athlete, extra } = await readAthlete(ctx.db, ctx.userId, ctx.now, {
      memUsed: sql`(select count(*) from ${m} where ${m.userId} = ${ctx.userId}
        and case when json_valid(${m.provenance}) then json_extract(${m.provenance}, '$.runId') end = ${rootId})`,
      memReplay: sql`(select json_object('kind', ${m.kind}, 'confidence', ${m.confidence}, 'body', ${m.body}, 'expires', ${m.expiresAt})
        from ${m} where ${m.id} = ${id} and ${m.userId} = ${ctx.userId})`,
      memReplaced: p.replaces
        ? sql`(select json_object('confidence', ${m.confidence}, 'active', ${m.active}, 'superseded', ${m.supersededBy})
            from ${m} where ${m.id} = ${p.replaces} and ${m.userId} = ${ctx.userId})`
        : sql`null`,
      memRequest: sql`(select ${coachRuns.request} from ${coachRuns} where ${coachRuns.id} = ${rootId} and ${coachRuns.userId} = ${ctx.userId})`,
    });
    const answerFor = (body: string, kind: string, confidence: string, expires: string | null) => ({
      data: {
        remembered: { id, kind, confidence, body: untrusted(body), ...(expires ? { expires } : {}) },
        ...(p.replaces ? { replaced: p.replaces } : {}),
        ...(ctx.run.rehearsal ? { rehearsal: true } : {}),
      },
      summary: `Remembered (${CONFIDENCE_WORDS[confidence] ?? confidence}): ${body}`,
      receipt: { memoryId: id, kind, confidence, ...(p.replaces ? { replaced: p.replaces } : {}), undo: { handle: memoryHandle(rootId, callId) } },
    });
    const replay = parsedJson(extra.memReplay) as { kind: string; confidence: string; body: string; expires: string | null } | null;
    if (replay) return answerFor(replay.body, replay.kind, replay.confidence, replay.expires);

    const today = athlete.today;
    if (p.kind !== "note" && p.expires) {
      return refuse("only_notes_expire", `Only a note expires; a ${p.kind} lasts until it is replaced.`, "Leave expires out, or keep it as a note.");
    }
    if (p.kind === "note" && (!p.expires || p.expires <= today || p.expires > addDays(today, NOTE_DAYS_MAX))) {
      return refuse("needs_expiry", `A note is time-boxed: give expires, a day after today (${today}) and within a year.`, "Add expires (YYYY-MM-DD), or keep it as a fact or rule.");
    }
    if (p.kind === "observation" && !p.evidence) {
      return refuse("needs_evidence", "An observation is learned from outcomes: say what supports it.", 'Add evidence, e.g. ["no clenched sets in 3 of 3 sessions"].');
    }
    if (Number(extra.memUsed ?? 0) >= MEMORY_PER_RUN) {
      return refuse("memory_cap", `This design has already kept ${MEMORY_PER_RUN} memories.`, "Keep only what will matter beyond this design; replace an item instead of adding one.");
    }
    if (p.replaces) {
      const old = parsedJson(extra.memReplaced) as { confidence?: string; active?: number; superseded?: string | null } | null;
      if (!old || !old.active || old.superseded) {
        return refuse("not_found", `No live memory item has id ${JSON.stringify(p.replaces)}.`, "Use an id from the pinned memory or recall_memory, or leave replaces out.");
      }
      if (p.quote && old.confidence !== "confirmed") return quoteUnused;
      if (old.confidence === "confirmed") {
        if (p.confidence === "inferred" || !p.quote) {
          return refuse(
            "confirmed_by_athlete",
            "The athlete confirmed that item: only their own words replace it.",
            "Give quote — the request's words that change it — with confidence stated, or ask the athlete (ask_athlete).",
          );
        }
        const request = typeof extra.memRequest === "string" ? extra.memRequest : "";
        if (quoteIn(request, p.quote) !== "ok") {
          return refuse("not_in_request", `quote "${p.quote}" is not words of the athlete's request.`, "Quote the request's own words exactly, or ask the athlete.");
        }
      }
    }
    const at = ctx.now.toISOString();
    await runAtomically(
      ctx.db,
      memoryWrites(ctx.db, {
        id,
        userId: ctx.userId,
        kind: p.kind,
        body: p.body,
        confidence: p.confidence,
        evidence: p.evidence ?? null,
        expiresAt: p.kind === "note" ? p.expires! : null,
        provenance: {
          source: p.confidence === "stated" ? "athlete_words" : "coach_inference",
          runId: rootId,
          role: ctx.run.role === "designer" ? "designer" : "main",
          at,
          ...(ctx.run.rehearsal ? { rehearsal: true as const } : {}),
        },
        // A rehearsal never supersedes the athlete's item.
        ...(p.replaces && !ctx.run.rehearsal ? { replaces: p.replaces } : {}),
      }),
    );
    return answerFor(p.body, p.kind, p.confidence, p.kind === "note" ? p.expires! : null);
  },
};
