/**
 * WHICH OPEN SUGGESTION A NEWER ONE COVERS (Task 7's rule; Task 13's fix wave §2.5): one predicate, two readers —
 *  - design-orchestrate.ts `supersedeOlderPlans`, which writes it once a proposal is made pending;
 *  - `willReplaceSql`, which reads it before — what a reviewed draft WOULD replace, given to its designer with the
 *    review (design-review.ts `designerResult`), so the coach's last line says "replaces" only when it will (13c R2: the
 *    line said so twice, true only because two times fell within the window).
 *
 * A session is covered BY SESSION, NOT BY DAY (two sessions a day are legitimate): an older revision of a workout, or an
 * older change to it (adjust_plan's skip, move or length), is covered by a newer revision of the same workout or a
 * newer change to it — the newer wins, whichever kind each is; an older new workout by a newer NEW workout on its date
 * whose time overlaps — either has no time, or the two start within SAME_SESSION_MINUTES of each other. (A newer
 * revision of a different workout, already planned, is its own session: it never supersedes a new one near it; nor
 * does a change ever supersede a new workout, or a new workout a change.) Only an op still OPEN is covered: a designed
 * workout or a change with no outcome yet, or refused (a refused op stays open: design-approve.ts).
 */
import { sql, type SQL } from "drizzle-orm";

/** How far apart two sessions on one day start before they are two sessions, not one (minutes). */
export const SAME_SESSION_MINUTES = 180;

/** Most open suggestions a designer is told its draft would replace. */
export const WILL_REPLACE_SHOWN = 5;

const minutes = (time: SQL) => sql`(cast(substr(${time}, 1, 2) AS integer) * 60 + cast(substr(${time}, 4, 2) AS integer))`;

/** The planned workout a designed op is about: a revision's, or a change's (Task 8b); none for a new workout. */
const workoutOf = (value: SQL) => sql`(CASE json_extract(${value}, '$.kind')
    WHEN 'plan_adjust' THEN json_extract(${value}, '$.op.workoutId')
    WHEN 'doc_workout' THEN CASE WHEN json_extract(${value}, '$.target.kind') = 'revise' THEN json_extract(${value}, '$.target.workoutId') END END)`;

/** `value` (an op's JSON) is a designed workout or a change still open: no outcome yet, or refused. */
export const openOp = (value: SQL): SQL => sql`(json_extract(${value}, '$.kind') IN ('doc_workout', 'plan_adjust')
    AND coalesce(json_extract(${value}, '$.outcome.status'), 'open') IN ('open', 'refused'))`;

/** The op `newer` covers the op `older` (both an op's JSON; see the module comment). */
export const covers = (newer: SQL, older: SQL): SQL => sql`((${workoutOf(older)} IS NOT NULL AND ${workoutOf(older)} = ${workoutOf(newer)})
    OR (json_extract(${older}, '$.kind') = 'doc_workout' AND json_extract(${newer}, '$.kind') = 'doc_workout'
        AND json_extract(${older}, '$.target.kind') = 'new' AND json_extract(${newer}, '$.target.kind') = 'new'
        AND json_extract(${newer}, '$.date') = json_extract(${older}, '$.date')
        AND (json_extract(${older}, '$.time') IS NULL OR json_extract(${newer}, '$.time') IS NULL
          OR abs(${minutes(sql`json_extract(${older}, '$.time')`)} - ${minutes(sql`json_extract(${newer}, '$.time')`)}) <= ${SAME_SESSION_MINUTES})))`;

/**
 * What the run `runId`'s ops in proposal `proposalId` would replace once it is made pending, as a JSON array column:
 * each open op, newest proposal first (at most WILL_REPLACE_SHOWN), of the athlete's OLDER proposals still theirs to
 * decide (`pending`, `partially_approved`) that one of those ops covers — `{ title, date, time }`. `ops` is the
 * proposal's ops column as the enclosing statement reads it (valid JSON: the caller guards), so it costs no statement of
 * its own.
 */
export function willReplaceSql(userId: string, proposalId: string, ops: SQL, runId: string): SQL {
  return sql`(SELECT json_group_array(json_object('title', w.title, 'date', w.date, 'time', w.time)) FROM (
      SELECT coalesce(json_extract(o.value, '$.doc.title'), json_extract(o.value, '$.row.title')) AS title,
        json_extract(o.value, '$.date') AS date,
        coalesce(json_extract(o.value, '$.time'), json_extract(o.value, '$.row.time')) AS time
      FROM coach_proposals op, json_each(op.ops) o
      WHERE op.user_id = ${userId} AND op.id <> ${proposalId} AND op.status IN ('pending', 'partially_approved') AND json_valid(op.ops)
        AND op.created_at < (SELECT created_at FROM coach_proposals WHERE id = ${proposalId} AND user_id = ${userId})
        AND ${openOp(sql`o.value`)}
        AND EXISTS (SELECT 1 FROM json_each(${ops}) n
          WHERE json_extract(n.value, '$.kind') = 'doc_workout' AND json_extract(n.value, '$.by.runId') = ${runId}
            AND ${covers(sql`n.value`, sql`o.value`)})
      ORDER BY op.created_at DESC, op.id, o.key
      LIMIT ${WILL_REPLACE_SHOWN}) w)`;
}

/** `willReplaceSql`'s column, read: each replaced op's title, day and time ("HH:MM", or null). */
export function willReplaceOf(column: unknown): Array<{ title: string; date: string; time: string | null }> {
  let rows: unknown = column;
  try {
    if (typeof column === "string") rows = JSON.parse(column);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r) => {
    const x = r as { title?: unknown; date?: unknown; time?: unknown } | null;
    return typeof x?.date === "string" ? [{ title: typeof x.title === "string" ? x.title : "", date: x.date, time: typeof x.time === "string" ? x.time : null }] : [];
  });
}
