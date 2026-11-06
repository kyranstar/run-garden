/**
 * THE COACH'S CHANGES TO THE ATHLETE'S OBJECTIVES (audit fixes 2026-11-06, E6; principles §2.8, §5.2; the owner: "the
 * coach always needs to be aware of my overall goals … It should be able to manage all of these"). What an
 * `objective_change` op reads, says and writes — the objectives and key results the board keeps (`objectives`,
 * `key_results`; objectives.ts) — with no table of its own:
 *  - READ (`objectiveStateSql`): the objective the change is about, with its key results, as ONE scalar subquery — so the
 *    tool reads it beside the athlete (its one read), and Approve reads every change's in one statement
 *    (`objectivesReadSql`).
 *  - SAID (`objectiveChangeLine`): one line, before → after, in the key result's own unit and the app's day words.
 *  - WRITTEN (`judgeObjectiveChange`): ONLY at Approve, each change in one atomic write gated on the value the coach read
 *    (and on its claim, `asRead`), the state change last with `returning`: refused `stale` when the athlete changed it
 *    since (nothing written), recorded applied with nothing written when it is already so (a double tap, a crash after
 *    the write). An objective added and a key result added carry the ids made when proposed, so a second approve never
 *    adds twice.
 *  - LOGGED: today nothing logs an objective's change but its row's `updated_at` (the board's own edits); the coach's are
 *    kept whole in the op — before, after, why, basis and its outcome's time — which read_proposals, the conversation
 *    and the thread's approve receipt read back. No migration.
 *
 * COSTS: OBJECTIVE_CHANGES_FIXED (the claim's write and the one read) and objectiveChangeCostOf a change (one statement;
 * an objective added with key results, two).
 */
import { sql, type SQL } from "drizzle-orm";
import { keyResults, objectives } from "@rg/database";
import { dayLabel, MAX_KEY_RESULTS, type KeyResultUnit } from "@rg/domain";
import type { AtomicStatement, Db } from "./db.js";
import type { ObjectiveChangeKind, ObjectiveChangeOp, ObjectiveKeyResultDraft } from "./proposal-kinds.js";
import { figure } from "./where-you-stand.js";

/** An objective as a change reads it: its title and status, and each key result's words, target, due day and unit. */
export interface ObjectiveState {
  id: string;
  title: string;
  status: string;
  krs: Array<{ id: string; label: string; target: number | null; dueDate: string | null; unit: string }>;
}

/** The objective `ref` names — or the one its key result belongs to — with its key results, the athlete's alone: ONE
 * scalar subquery (null when there is none). Its tables go by their own aliases. */
export function objectiveStateSql(userId: string, ref: { objectiveId?: string; keyResultId?: string }): SQL {
  const which =
    ref.objectiveId !== undefined
      ? sql`${ref.objectiveId}`
      : sql`(select os_k.objective_id from key_results os_k where os_k.user_id = ${userId} and os_k.id = ${ref.keyResultId ?? ""})`;
  return sql`(select json_object('id', os_o.id, 'title', os_o.title, 'status', os_o.status,
      'krs', json((select json_group_array(json_object('id', os_r.id, 'label', os_r.label, 'target', os_r.target, 'dueDate', os_r.due_date, 'unit', os_r.unit))
        from key_results os_r where os_r.user_id = ${userId} and os_r.objective_id = os_o.id)))
    from objectives os_o where os_o.user_id = ${userId} and os_o.id = ${which})`;
}

/** The athlete's own words a run answers (its request), as ONE scalar subquery — null for none, and for a "needs you"
 * chip's run (its `diagnose`), whose request is the app's text (the E6 review): basis owner and a challenge rest on
 * their words alone. */
export function askedWordsSql(userId: string, runId: string): SQL {
  return sql`(select case when json_valid(aw_r.state) and json_extract(aw_r.state, '$.settings.diagnose') is not null then null
      else nullif(trim(coalesce(aw_r.request, '')), '') end
    from coach_runs aw_r where aw_r.id = ${runId} and aw_r.user_id = ${userId})`;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** `objectiveStateSql`'s value, read; null for none (or one that doesn't read). */
export function objectiveStateOf(raw: unknown): ObjectiveState | null {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  if (!o || typeof o.id !== "string" || typeof o.title !== "string" || typeof o.status !== "string") return null;
  const krs = (Array.isArray(o.krs) ? o.krs : []).flatMap((x) => {
    const k = x && typeof x === "object" ? (x as Record<string, unknown>) : null;
    return k && typeof k.id === "string" && typeof k.label === "string"
      ? [{ id: k.id, label: k.label, target: num(k.target), dueDate: str(k.dueDate), unit: str(k.unit) ?? "score" }]
      : [];
  });
  return { id: o.id, title: o.title, status: o.status, krs };
}

/** The statuses an objective may still change from: a done or dropped one is the athlete's to bring back. */
export const LIVE_OBJECTIVE = ["active", "paused"] as const;

/** A retired key result's words, as the coach read them: its row's own, the gate of its delete. */
export interface RetiredKeyResult {
  label: string;
  target: number | null;
  dueDate: string | null;
}

/**
 * What a change finds now (`before` when proposed; the gate's value when applied): a target, a due day, an objective's
 * status, a key result's words, or null (an add) — or why there is nothing to change.
 */
export function currentOf(
  o: { change: ObjectiveChangeKind; keyResultId?: string; objectiveId?: string },
  state: ObjectiveState | null,
): { value: unknown } | { code: "not_found" | "not_a_target" | "full"; why: string } {
  if (o.change === "add_objective") return state ? { code: "not_a_target", why: "is there already" } : { value: null };
  if (!state) return { code: "not_found", why: "isn't one of the athlete's objectives or key results" };
  if (o.change === "add_key_result") {
    if (!(LIVE_OBJECTIVE as readonly string[]).includes(state.status)) return { code: "not_a_target", why: `is ${state.status}: the athlete brings it back first` };
    if (state.krs.length >= MAX_KEY_RESULTS) return { code: "full", why: `holds ${MAX_KEY_RESULTS} key results already` };
    return { value: null };
  }
  if (o.change === "retire" && o.keyResultId === undefined) {
    return (LIVE_OBJECTIVE as readonly string[]).includes(state.status) ? { value: state.status } : { code: "not_a_target", why: `is ${state.status} already` };
  }
  const kr = state.krs.find((k) => k.id === o.keyResultId);
  if (!kr) return { code: "not_found", why: "isn't one of the athlete's key results" };
  // A done or dropped objective's key results are the athlete's to bring back first (E6 review).
  if (!(LIVE_OBJECTIVE as readonly string[]).includes(state.status)) return { code: "not_a_target", why: `belongs to an objective that is ${state.status}: the athlete brings it back first` };
  if (o.change === "retarget") return { value: kr.target };
  if (o.change === "redate") return { value: kr.dueDate };
  return { value: { label: kr.label, target: kr.target, dueDate: kr.dueDate } satisfies RetiredKeyResult };
}

const fig = (v: unknown, unit: string): string => (typeof v === "number" ? figure(v, unit as KeyResultUnit) : "none");
const day = (v: unknown): string => (typeof v === "string" && v ? dayLabel(v) : "no date");

/** A change in one line, before → after: "Zorbex wall sit: target 120 s → 90 s", "Strong legs: active → done",
 * "New objective: Zorbex balance — 1 key result". */
export function objectiveChangeLine(o: {
  change: ObjectiveChangeKind;
  title: string;
  before: unknown;
  after: unknown;
  kr?: { label: string; unit: string };
}): string {
  switch (o.change) {
    case "retarget":
      return `${o.kr!.label}: target ${fig(o.before, o.kr!.unit)} → ${fig(o.after, o.kr!.unit)}`;
    case "redate":
      return `${o.kr!.label}: due ${day(o.before)} → ${day(o.after)}`;
    case "add_key_result": {
      const k = o.after as ObjectiveKeyResultDraft;
      return `${o.title}: new key result — ${k.label}${k.target !== null ? `, target ${fig(k.target, k.unit)}` : ""}${k.dueDate ? ` by ${day(k.dueDate)}` : ""}`;
    }
    case "retire": {
      if (!o.kr) return `${o.title}: ${String(o.before)} → ${String(o.after)}`;
      const b = o.before as RetiredKeyResult;
      const aim = b.target !== null ? `target ${fig(b.target, o.kr.unit)}${b.dueDate ? ` by ${day(b.dueDate)}` : ""}` : b.dueDate ? `by ${day(b.dueDate)}` : "";
      return `${o.title}: retire ${b.label}${aim ? ` (${aim})` : ""}`;
    }
    case "add_objective": {
      const n = ((o.after as { keyResults?: unknown[] } | null)?.keyResults ?? []).length;
      return `New objective: ${o.title}${n ? ` — ${n} key result${n === 1 ? "" : "s"}` : ""}`;
    }
  }
}

// ── Applied at Approve (design-approve.ts) ──────────────────────────────────────────────────────────────────────────

/** The changes' own part of an approve: their claim's write and their one read (every change's objective). */
export const OBJECTIVE_CHANGES_FIXED = 1 + 1;

/** What one change costs: its write — an objective added with key results, those first, then the objective. */
export function objectiveChangeCostOf(op: Pick<ObjectiveChangeOp, "change" | "after">): number {
  if (op.change !== "add_objective") return 1;
  return ((op.after as { keyResults?: unknown[] } | null)?.keyResults ?? []).length > 0 ? 2 : 1;
}

/** Every change's objective, ONE statement: a column each (`s0`, `s1`, …). */
export function objectivesReadSql(userId: string, ops: readonly Pick<ObjectiveChangeOp, "objectiveId">[]): SQL {
  if (ops.length === 0) return sql`select 1`;
  return sql`select ${sql.join(ops.map((o, i) => sql`${objectiveStateSql(userId, { objectiveId: o.objectiveId })} as ${sql.raw(`s${i}`)}`), sql`, `)}`;
}

export const STALE_OBJECTIVE_WHY = "It changed since the coach suggested this — ask again.";

export type ObjectiveVerdict =
  | { status: "made" }
  | { status: "refused"; error: "stale" | "not_a_target" | "full"; why: string }
  | { status: "apply"; statements: AtomicStatement[] };

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Key results inserted from `drafts` (one JSON parameter), after the objective's own, while `gate` holds. */
function keyResultsInsert(db: Db, userId: string, objectiveId: string, drafts: readonly ObjectiveKeyResultDraft[], now: string, gate: SQL) {
  const j = (k: string) => sql.raw(`json_extract(oc_j.value, '$.${k}')`);
  return db.insert(keyResults).select(
    sql`SELECT ${j("id")}, ${userId}, ${objectiveId}, ${j("label")}, json(${j("measure")}), ${j("direction")}, ${j("baseline")}, ${j("target")}, ${j("unit")}, ${j("dueDate")},
      (SELECT coalesce(max(oc_p.position) + 1, 0) FROM key_results oc_p WHERE oc_p.user_id = ${userId} AND oc_p.objective_id = ${objectiveId}) + oc_j.key, ${now}, ${now}
      FROM json_each(${JSON.stringify(drafts)}) oc_j WHERE ${gate}`,
  );
}

/**
 * One change judged against its objective as Approve read it (`state`): made already, refused (not there any more, or
 * changed since: `stale`), or its statements — each gated on the value the coach read and on its claim (`asRead`), the
 * state change last with `returning` (runAtomicallyClaim).
 */
export function judgeObjectiveChange(db: Db, userId: string, op: ObjectiveChangeOp, state: ObjectiveState | null, o: { now: string; asRead: SQL }): ObjectiveVerdict {
  const gone: ObjectiveVerdict = { status: "refused", error: "not_a_target", why: "What it changes isn't there any more." };
  if (op.change === "add_objective") {
    // Its id was made when proposed: there already is a second approve's (or a crash's) — made.
    if (state) return { status: "made" };
    const a = op.after as { title: string; why: string | null; goalIds: string[]; keyResults: ObjectiveKeyResultDraft[] };
    const absent = sql`NOT EXISTS (SELECT 1 FROM objectives oc_x WHERE oc_x.id = ${op.objectiveId}) AND ${o.asRead}`;
    return {
      status: "apply",
      statements: [
        // Its key results first, while the objective isn't there; the objective last, the claim.
        ...(a.keyResults.length ? [keyResultsInsert(db, userId, op.objectiveId, a.keyResults, o.now, absent)] : []),
        db
          .insert(objectives)
          .select(
            sql`SELECT ${op.objectiveId}, ${userId}, ${a.title}, ${a.why}, 'active', ${JSON.stringify(a.goalIds)},
              (SELECT coalesce(max(oc_s.sort) + 1, 0) FROM objectives oc_s WHERE oc_s.user_id = ${userId}), ${o.now}, ${o.now} WHERE ${absent}`,
          )
          .returning({ id: objectives.id }),
      ],
    };
  }
  if (!state) return gone;
  if (op.change === "add_key_result") {
    const draft = op.after as ObjectiveKeyResultDraft;
    if (state.krs.some((k) => k.id === draft.id)) return { status: "made" };
    const current = currentOf(op, state);
    if ("why" in current) return { status: "refused", error: current.code === "full" ? "full" : "stale", why: `The objective ${current.why}.` };
    const gate = sql`EXISTS (SELECT 1 FROM objectives oc_g WHERE oc_g.user_id = ${userId} AND oc_g.id = ${op.objectiveId} AND oc_g.status IN ('active', 'paused'))
      AND (SELECT count(*) FROM key_results oc_c WHERE oc_c.user_id = ${userId} AND oc_c.objective_id = ${op.objectiveId}) < ${MAX_KEY_RESULTS} AND ${o.asRead}`;
    return { status: "apply", statements: [keyResultsInsert(db, userId, op.objectiveId, [draft], o.now, gate).onConflictDoNothing().returning({ id: keyResults.id })] };
  }
  if (op.change === "retire" && op.keyResultId === undefined) {
    if (state.status === op.after) return { status: "made" };
    if (state.status !== op.before) return { status: "refused", error: "stale", why: STALE_OBJECTIVE_WHY };
    return {
      status: "apply",
      statements: [
        db
          .update(objectives)
          .set({ status: String(op.after), updatedAt: o.now })
          .where(sql`${objectives.userId} = ${userId} AND ${objectives.id} = ${op.objectiveId} AND ${objectives.status} = ${String(op.before)} AND ${o.asRead}`)
          .returning({ id: objectives.id }),
      ],
    };
  }
  const kr = state.krs.find((k) => k.id === op.keyResultId);
  // Its objective done or dropped since (the athlete's): changed since.
  if (!(LIVE_OBJECTIVE as readonly string[]).includes(state.status)) return { status: "refused", error: "stale", why: STALE_OBJECTIVE_WHY };
  const live = sql`EXISTS (SELECT 1 FROM objectives oc_l WHERE oc_l.user_id = ${userId} AND oc_l.id = ${op.objectiveId} AND oc_l.status IN ('active', 'paused'))`;
  if (op.change === "retire") {
    // Gone already (the athlete took it off the board too): so.
    if (!kr) return { status: "made" };
    const b = op.before as RetiredKeyResult;
    if (kr.label !== b.label || kr.target !== b.target || kr.dueDate !== b.dueDate) return { status: "refused", error: "stale", why: STALE_OBJECTIVE_WHY };
    return {
      status: "apply",
      statements: [
        db
          .delete(keyResults)
          .where(
            sql`${keyResults.userId} = ${userId} AND ${keyResults.id} = ${op.keyResultId!} AND ${keyResults.objectiveId} = ${op.objectiveId} AND ${keyResults.label} = ${b.label}
              AND ${keyResults.target} IS ${b.target} AND ${keyResults.dueDate} IS ${b.dueDate} AND ${live} AND ${o.asRead}`,
          )
          .returning({ id: keyResults.id }),
      ],
    };
  }
  if (!kr) return gone;
  const now = op.change === "retarget" ? kr.target : kr.dueDate;
  if (same(now, op.after)) return { status: "made" };
  if (!same(now, op.before)) return { status: "refused", error: "stale", why: STALE_OBJECTIVE_WHY };
  const column = op.change === "retarget" ? keyResults.target : keyResults.dueDate;
  const set = op.change === "retarget" ? { target: op.after as number, updatedAt: o.now } : { dueDate: (op.after as string | null) ?? null, updatedAt: o.now };
  return {
    status: "apply",
    statements: [
      db
        .update(keyResults)
        .set(set)
        .where(sql`${keyResults.userId} = ${userId} AND ${keyResults.id} = ${op.keyResultId!} AND ${keyResults.objectiveId} = ${op.objectiveId} AND ${column} IS ${op.before ?? null} AND ${live} AND ${o.asRead}`)
        .returning({ id: keyResults.id }),
    ],
  };
}
