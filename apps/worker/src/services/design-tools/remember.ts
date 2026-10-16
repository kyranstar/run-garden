/**
 * remember(kind, body, confidence, evidence?, expires?, replaces?) — a durable item of memory v2 (Stage 3 spec §9;
 * principles §6.7; coach-memory.ts): a fact, a rule, a note (with its last day) or an observation (with the evidence
 * for it). Its confidence is `stated` — the athlete said it — or `inferred` — the coach concluded it; never
 * `confirmed`, which only the athlete gives. Where it came from goes with it (the athlete's words or the coach's
 * inference, the run, when), and a rehearsal run's item is marked as one (`provenance.rehearsal`) so no run ever reads
 * it as the athlete's. `replaces` updates an item by its id: the new one is written and the old one kept, superseded
 * by it — but an inference never replaces what the athlete confirmed, and what they state replaces it only with their
 * own words from the request (`quote`). Only a note expires: after today, within a year.
 *
 * A rehearsal run writes its marked row and NEVER supersedes the athlete's item (it answers that it would have).
 *
 * At most MEMORY_PER_RUN items per run, counted over the main run's whole tree. Keyed on the call's tool-use id: a
 * replay writes nothing new and answers the same. The body is the athlete's (or the coach's) words — data — and comes
 * back marked. Three statements: the athlete (with the run's count, a replay's row and the replaced item), then the
 * insert and the supersede, as one batch.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { addDays, newId } from "@rg/domain";
import { coachMemory, coachRuns } from "@rg/database";
import { runAtomically } from "../db.js";
import { COACH_CONFIDENCES, MEMORY_KINDS, memoryWrites } from "../coach-memory.js";
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
    const id = `mem:${ctx.run.id}:${ctx.toolUseId ?? newId()}`;
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
      summary: `Remembered (${confidence}): ${body}`,
      receipt: { memoryId: id, kind, confidence, ...(p.replaces ? { replaced: p.replaces } : {}) },
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
