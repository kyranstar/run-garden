/**
 * THE COACH'S DECISIONS ON EACH POST'S TRAIL (import trail phase 3; design 2026-11-05 §8.3, §4 "Coach"). A pins card's
 * line about a move is the coach's decision about that move — in or out, where, the dose, why, its cites — and each post
 * of the card's batch that names the move keeps it on its trail: "The coach suggested it" when the card is shown, then
 * "You approved it", "You said not now" or "Replaced by a newer suggestion". The posts the run read keep "The coach read
 * this post" at the read's own time; a correction shown is suggested on each post it touches (applied, it is the
 * correction stage's own event: import-corrections.ts).
 *
 * Each is ONE set-based statement. Approved and declined, it rides the write that decides the card (gated on it, so it
 * lands only with it); shown and replaced, it is read from the stored proposal right after the promotion's own writes
 * (design-orchestrate.ts `supersedeOlderPlans`), so its rows are the card as stored.
 */
import { sql, type SQL } from "drizzle-orm";
import { schema } from "@rg/database";
import type { AtomicStatement, Db } from "./db.js";
import type { ImportCorrectionOp, PinsCardLine } from "./proposal-kinds.js";

const { importEvents } = schema;

export type CoachVerdict = "suggested" | "approved" | "declined" | "superseded";

/** How a line's step begins, by what came of it. */
export const VERDICT_WORDS: Readonly<Record<CoachVerdict, string>> = {
  suggested: "The coach suggested it",
  approved: "You approved it",
  declined: "You said not now",
  superseded: "Replaced by a newer suggestion",
};
const CORRECTION_WORDS: Readonly<Record<CoachVerdict, string>> = {
  suggested: "The coach suggested a correction",
  approved: "You approved a correction",
  declined: "You said not now to a correction",
  superseded: "A correction replaced by a newer suggestion",
};
export const READ_WORDS = "The coach read this post";

/** A line in words: "in · joins your mobility rotation · 2×6 per side · <text>" (`lineSql`'s, in SQL). */
export function lineWords(l: PinsCardLine): string {
  const decision = l.decision === "in" ? "in" : l.decision === "out" ? "left out" : null;
  return [decision, l.where, l.dose, l.text].filter((x): x is string => !!x).join(" · ");
}

/** `lineWords` over a stored line's JSON (`v`). */
const lineSql = (v: SQL): SQL => sql`(coalesce(case json_extract(${v}, '$.decision') when 'in' then 'in · ' when 'out' then 'left out · ' end, '')
  || coalesce(json_extract(${v}, '$.where') || ' · ', '') || coalesce(json_extract(${v}, '$.dose') || ' · ', '') || json_extract(${v}, '$.text'))`;

const lineDetailSql = (verdict: CoachVerdict, v: SQL): SQL => sql`json_object('verdict', ${verdict}, 'decision', json_extract(${v}, '$.decision'),
  'where', json_extract(${v}, '$.where'), 'dose', json_extract(${v}, '$.dose'), 'text', json_extract(${v}, '$.text'),
  'cites', json(coalesce(json_extract(${v}, '$.cites'), '[]')))`;

/**
 * The decision on each card line and correction the caller holds (an approve's, a decline's), ONE statement — only while
 * `gate` holds: each pins line about a move on every post of its batch that names the move; each correction on every
 * post it touches. Null with nothing to write.
 */
export function decisionTrailStatement(
  db: Db,
  userId: string,
  o: {
    proposalId: string;
    runId: string | null;
    pins: ReadonlyArray<{ batchId: string; lines: readonly PinsCardLine[] }>;
    fixes: readonly ImportCorrectionOp[];
  },
  verdict: Exclude<CoachVerdict, "suggested" | "superseded">,
  at: string,
  gate: SQL,
): AtomicStatement | null {
  const source = "owner";
  const status = verdict === "approved" ? "ok" : "info";
  const pinRows = o.pins.flatMap((p) =>
    p.lines.flatMap((l) =>
      l.moveId
        ? [[p.batchId, l.moveId, `${VERDICT_WORDS[verdict]} — ${lineWords(l)}`.slice(0, 300), { verdict, decision: l.decision ?? null, where: l.where ?? null, dose: l.dose ?? null, text: l.text, cites: l.cites ?? [] }]]
        : [],
    ),
  );
  // An approved correction's own event is the correction stage's (import-corrections.ts): a decline's is the coach's.
  const fixRows = verdict === "declined" ? o.fixes.flatMap((f) => f.posts.map((post) => [post, f.moveId ?? null, `${CORRECTION_WORDS[verdict]} — ${f.line}`.slice(0, 300), { verdict, correction: f.id }])) : [];
  if (pinRows.length === 0 && fixRows.length === 0) return null;
  const pins = JSON.stringify(pinRows);
  const fixes = JSON.stringify(fixRows);
  const tail = sql`NULL, NULL, NULL, NULL, NULL, NULL, ${o.runId}, ${o.proposalId}, 0, ${at}`;
  return db.insert(importEvents).select(sql`
    SELECT lower(hex(randomblob(16))), ${userId}, x.post_id, x.batch_id, json_extract(r.value, '$[1]'), 'coach', ${source}, ${status},
      json_extract(r.value, '$[2]'), json_extract(r.value, '$[3]'), ${tail}
    FROM json_each(${pins}) r
      JOIN (select distinct ct_l.post_id as post_id, ct_l.batch_id as batch_id, coalesce(case when ct_m.status = 'merged' then ct_m.merged_into end, ct_l.move_id) as mv
        from saved_post_moves ct_l left join personal_moves ct_m on ct_m.user_id = ct_l.user_id and ct_m.id = ct_l.move_id
        where ct_l.user_id = ${userId} and ct_l.status = 'saved' and ct_l.batch_id in (select json_extract(value, '$[0]') from json_each(${pins}))) x
        ON x.batch_id = json_extract(r.value, '$[0]') AND x.mv = json_extract(r.value, '$[1]')
    WHERE ${gate}
    UNION ALL
    SELECT lower(hex(randomblob(16))), ${userId}, json_extract(c.value, '$[0]'), NULL, json_extract(c.value, '$[1]'), 'coach', ${source}, ${status},
      json_extract(c.value, '$[2]'), json_extract(c.value, '$[3]'), ${tail}
    FROM json_each(${fixes}) c WHERE ${gate}`);
}

/**
 * A suggestion just shown (`proposalId`, made pending) and the older cards it replaced, on the trail, ONE statement from
 * the proposals as stored: its pins lines suggested on each post naming their move, its read posts read (at the read's
 * own time), its corrections suggested on each post they touch — and each older card's lines and corrections this
 * promotion superseded (their outcome's `by` and `at`). A rehearsal's (never pending) writes nothing.
 */
export function promotionTrailStatement(db: Db, userId: string, proposalId: string, at: string): AtomicStatement {
  const tail = (cp: string) => sql`NULL, NULL, NULL, NULL, NULL, NULL, substr(${sql.raw(cp)}.id, 4), ${sql.raw(cp)}.id, 0`;
  const isNew = sql`cp.id = ${proposalId} AND cp.user_id = ${userId} AND cp.status = 'pending' AND json_valid(cp.ops)`;
  const isOlder = sql`cp.user_id = ${userId} AND cp.id <> ${proposalId} AND json_valid(cp.ops)
    AND json_extract(o.value, '$.outcome.status') = 'superseded' AND json_extract(o.value, '$.outcome.by') = ${proposalId}
    AND json_extract(o.value, '$.outcome.at') = ${at}`;
  // Each line about a move, once a post of its batch whose saved link names the move (a merged one as the move it went
  // into) — one row a post however many places the post shows it.
  const lines = (verdict: CoachVerdict, which: SQL) => sql`
    SELECT lower(hex(randomblob(16))), cp.user_id, ct_l.post_id, ct_l.batch_id, json_extract(ln.value, '$.moveId'), 'coach', 'coach', 'info',
      substr(${VERDICT_WORDS[verdict]} || ' — ' || ${lineSql(sql`ln.value`)}, 1, 300), ${lineDetailSql(verdict, sql`ln.value`)}, ${tail("cp")}, ${at}
    FROM coach_proposals cp, json_each(cp.ops) o, json_each(json_extract(o.value, '$.lines')) ln, saved_post_moves ct_l
      LEFT JOIN personal_moves ct_m ON ct_m.user_id = ct_l.user_id AND ct_m.id = ct_l.move_id
    WHERE ${which} AND json_extract(o.value, '$.kind') = 'move_pins' AND ln.type = 'object' AND json_extract(ln.value, '$.moveId') IS NOT NULL
      AND ct_l.user_id = cp.user_id AND ct_l.status = 'saved' AND ct_l.batch_id = json_extract(o.value, '$.batchId')
      AND coalesce(CASE WHEN ct_m.status = 'merged' THEN ct_m.merged_into END, ct_l.move_id) = json_extract(ln.value, '$.moveId')
    GROUP BY cp.id, o.key, ln.key, ct_l.post_id`;
  const fixes = (verdict: CoachVerdict, which: SQL) => sql`
    SELECT lower(hex(randomblob(16))), cp.user_id, p.value, NULL, json_extract(o.value, '$.moveId'), 'coach', 'coach', 'info',
      substr(${CORRECTION_WORDS[verdict]} || ' — ' || json_extract(o.value, '$.line'), 1, 300),
      json_object('verdict', ${verdict}, 'correction', json_extract(o.value, '$.id')), ${tail("cp")}, ${at}
    FROM coach_proposals cp, json_each(cp.ops) o, json_each(json_extract(o.value, '$.posts')) p
    WHERE ${which} AND json_extract(o.value, '$.kind') = 'import_correction'`;
  return db.insert(importEvents).select(sql`
    ${lines("suggested", isNew)}
    UNION ALL
    SELECT lower(hex(randomblob(16))), cp.user_id, json_extract(r.value, '$[0]'), json_extract(o.value, '$.batchId'), NULL, 'coach', 'coach', 'info',
      ${READ_WORDS}, json_object('runId', substr(cp.id, 4)), ${tail("cp")}, json_extract(r.value, '$[1]')
    FROM coach_proposals cp, json_each(cp.ops) o, json_each(json_extract(o.value, '$.read')) r
    WHERE ${isNew} AND json_extract(o.value, '$.kind') = 'move_pins' AND json_type(r.value) = 'array'
    UNION ALL
    ${fixes("suggested", isNew)}
    UNION ALL
    ${lines("superseded", isOlder)}
    UNION ALL
    ${fixes("superseded", isOlder)}`);
}
