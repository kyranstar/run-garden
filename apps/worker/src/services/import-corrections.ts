/**
 * CORRECTIONS TO IMPORTED DATA (import trail phase 3; design 2026-11-05 §8.4, §14.3). What a correction may correct,
 * how its target's current value is read, how a proposed value is checked, and the words the card and the trail show.
 * The tool that proposes one is design-tools/correct-import.ts; Approve applies it (design-approve.ts, below).
 *
 * TARGETS. A personal move's field (`move`, its id): name, summary, purpose (the record's why), dose, laterality, load,
 * equipment, steps, cues (the record's focus) — the corrected record held to the library's own validation. A post's
 * reading of one of its moves (`reading`, `<postId>:<position>`): when to use it, when to skip it, why. An insight
 * (`insight`, `<postId>:<index>`): drop it, reword it, change its scope, attach it to one of the post's moves. A link's
 * match (`link`, `<postId>:<position>`): the same as another move the athlete is offered, or — a library link — not the
 * same (a move of its own, from the post's reading).
 */
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@rg/database";
import { newId } from "@rg/domain";
import { DOSE_TYPES, EQUIPMENT_IDS, LATERALITY, LOADS, type ExerciseRecord } from "@rg/exercise-library";
import { extractedMoveSchema, INSIGHT_SCOPES, isPersonalId, type InsightScope } from "@rg/saves";
import type { AtomicStatement, Db } from "./db.js";
import { summaryLine } from "./import-trail.js";
import { buildPersonalRecord, newPersonalMoveId } from "./personal-moves.js";
import { validatePersonalRecord } from "./personal-records.js";
import type { CorrectionTarget, ImportCorrectionOp } from "./proposal-kinds.js";
import { valueWords } from "./saves-evidence.js";

const { importCorrections, importEvents, personalMoves, savedPosts, savedPostMoves, coachMemory } = schema;

export const CORRECTION_TARGETS = ["move", "reading", "insight", "link"] as const satisfies readonly CorrectionTarget[];
export const MOVE_FIELDS = ["name", "summary", "purpose", "dose", "laterality", "load", "equipment", "steps", "cues"] as const;
export const READING_FIELDS = ["useWhen", "skipWhen", "why"] as const;
export const INSIGHT_FIELDS = ["drop", "text", "scope", "move"] as const;
export const LINK_FIELDS = ["same_as", "not_same"] as const;
export const CORRECTION_FIELDS: Readonly<Record<CorrectionTarget, readonly string[]>> = {
  move: MOVE_FIELDS,
  reading: READING_FIELDS,
  insight: INSIGHT_FIELDS,
  link: LINK_FIELDS,
};

/** A post's target id: the post and a number (a move's position, an insight's index); null for anything else. */
export function postRef(targetId: string): { postId: string; n: number } | null {
  const m = /^(.{1,160}):(\d{1,3})$/.exec(targetId);
  return m ? { postId: m[1]!, n: Number(m[2]) } : null;
}

/** A post's link, as the state read gives it. */
export interface StateLink {
  position: number;
  moveId: string;
  moveKind: "library" | "personal";
  status: string;
  id: string;
  batchId: string | null;
}

/** What else holds a link's personal move (a "same as" correction archives it only when nothing does, §14.3). */
export interface MoveUsage {
  sets: boolean;
  plans: boolean;
  pinned: boolean;
  others: number;
}

export type CorrectionState =
  | { kind: "move"; status: string; record: ExerciseRecord; posts: string[] }
  | { kind: "post"; postId: string; status: string; extraction: Record<string, unknown> | null; links: StateLink[]; usage: MoveUsage | null };

/**
 * The target's current state as ONE JSON value (a scalar subquery), null when it isn't the athlete's: a move's status,
 * record and the posts its saved links name; a post's status, reading and links.
 */
export function correctionStateSql(userId: string, target: CorrectionTarget, targetId: string, today: string = new Date().toISOString().slice(0, 10)): SQL {
  if (target === "move") {
    return sql`(select json_object('kind', 'move', 'status', cs_m.status, 'record', json(cs_m.record),
        'posts', (select json_group_array(distinct cs_l.post_id) from saved_post_moves cs_l where cs_l.user_id = ${userId} and cs_l.move_id = cs_m.id and cs_l.status = 'saved'))
      from personal_moves cs_m where cs_m.user_id = ${userId} and cs_m.id = ${targetId} and json_valid(cs_m.record))`;
  }
  const ref = postRef(targetId);
  if (!ref) return sql`null`;
  // A link's personal move: what else holds it — logged sets, a planned workout from today on, a pin, another saved link.
  const usage =
    target === "link"
      ? sql`(select json_object(
            'sets', exists (select 1 from performed_sets cs_s join performed_sessions cs_ss on cs_ss.id = cs_s.performed_session_id
              where cs_ss.user_id = ${userId} and cs_s.exercise_id = cs_u.move_id),
            'plans', exists (select 1 from planned_workouts cs_w where cs_w.user_id = ${userId} and cs_w.effective_date >= ${today}
              and instr(coalesce(cs_w.workout_doc, ''), '"' || cs_u.move_id || '"') > 0),
            'pinned', exists (select 1 from exercise_prefs cs_e where cs_e.user_id = ${userId} and cs_e.exercise_id = cs_u.move_id and cs_e.pinned = 1),
            'others', (select count(*) from saved_post_moves cs_o where cs_o.user_id = ${userId} and cs_o.move_id = cs_u.move_id
              and cs_o.status = 'saved' and cs_o.id <> cs_u.id))
          from saved_post_moves cs_u where cs_u.user_id = ${userId} and cs_u.post_id = ${ref.postId} and cs_u.position = ${ref.n})`
      : sql`null`;
  return sql`(select json_object('kind', 'post', 'postId', cs_p.id, 'status', cs_p.status,
      'extraction', json(case when json_valid(cs_p.extraction) then cs_p.extraction end),
      'links', (select json_group_array(json_array(cs_l.position, cs_l.move_id, cs_l.move_kind, cs_l.status, cs_l.id, cs_l.batch_id)) from saved_post_moves cs_l
        where cs_l.user_id = ${userId} and cs_l.post_id = cs_p.id),
      'usage', ${usage})
    from saved_posts cs_p where cs_p.user_id = ${userId} and cs_p.id = ${ref.postId})`;
}

/** `correctionStateSql`'s value, read; null when there is none or it doesn't read. */
export function correctionStateOf(raw: unknown): CorrectionState | null {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  if (!o) return null;
  if (o.kind === "move") {
    if (typeof o.status !== "string" || !o.record || typeof o.record !== "object") return null;
    const posts = Array.isArray(o.posts) ? o.posts.filter((p): p is string => typeof p === "string") : [];
    return { kind: "move", status: o.status, record: o.record as ExerciseRecord, posts };
  }
  if (o.kind === "post" && typeof o.postId === "string") {
    const links = (Array.isArray(o.links) ? o.links : []).flatMap((l): StateLink[] => {
      const [position, moveId, moveKind, status, id, batchId] = Array.isArray(l) ? (l as unknown[]) : [];
      return typeof position === "number" && typeof moveId === "string" && typeof id === "string"
        ? [{ position, moveId, moveKind: moveKind === "library" ? "library" : "personal", status: typeof status === "string" ? status : "", id, batchId: typeof batchId === "string" ? batchId : null }]
        : [];
    });
    const extraction = o.extraction && typeof o.extraction === "object" ? (o.extraction as Record<string, unknown>) : null;
    const u = o.usage && typeof o.usage === "object" ? (o.usage as Record<string, unknown>) : null;
    const usage = u ? { sets: u.sets === 1 || u.sets === true, plans: u.plans === 1 || u.plans === true, pinned: u.pinned === 1 || u.pinned === true, others: Number(u.others) || 0 } : null;
    return { kind: "post", postId: o.postId, status: typeof o.status === "string" ? o.status : "", extraction, links, usage };
  }
  return null;
}

const MOVE_PATH: Readonly<Record<(typeof MOVE_FIELDS)[number], readonly string[]>> = {
  name: ["name"],
  summary: ["text", "summary"],
  purpose: ["text", "why"],
  dose: ["dose"],
  laterality: ["laterality"],
  load: ["load"],
  equipment: ["equipment"],
  steps: ["text", "steps"],
  cues: ["text", "focus"],
};

const at = (o: unknown, path: readonly string[]): unknown => path.reduce<unknown>((x, k) => (x && typeof x === "object" ? (x as Record<string, unknown>)[k] : undefined), o);

/** A move's record with one field set to `value`. */
export function withMoveField(record: ExerciseRecord, field: (typeof MOVE_FIELDS)[number], value: unknown): ExerciseRecord {
  const path = MOVE_PATH[field];
  if (path.length === 1) return { ...record, [path[0]!]: value } as ExerciseRecord;
  return { ...record, text: { ...record.text, [path[1]!]: value } } as ExerciseRecord;
}

const movesOf = (state: Extract<CorrectionState, { kind: "post" }>): unknown[] => (Array.isArray(state.extraction?.moves) ? (state.extraction!.moves as unknown[]) : []);
const insightsOf = (state: Extract<CorrectionState, { kind: "post" }>): unknown[] => (Array.isArray(state.extraction?.insights) ? (state.extraction!.insights as unknown[]) : []);

/** An insight's words and scope, whatever its age (before extract-6 it is words, general). */
export function insightParts(i: unknown): { text: string; scope: InsightScope; move: number | null; dropped: boolean } | null {
  if (typeof i === "string") return { text: i, scope: "general", move: null, dropped: false };
  const o = i && typeof i === "object" ? (i as Record<string, unknown>) : null;
  if (!o || typeof o.text !== "string") return null;
  return {
    text: o.text,
    scope: (INSIGHT_SCOPES as readonly unknown[]).includes(o.scope) ? (o.scope as InsightScope) : "general",
    move: typeof o.move === "number" ? o.move : null,
    dropped: o.dropped === true,
  };
}

/**
 * The target's current value of `field` — what a correction's `before` is, read by the Worker — or why there is none:
 * not the athlete's, archived or merged, a library move, a position or index the post doesn't hold, a link that is no
 * library link (not the same).
 */
export function currentValue(target: CorrectionTarget, targetId: string, field: string, state: CorrectionState | null): { value: unknown } | { why: string } {
  if (!state) return { why: "isn't one of the athlete's" };
  if (target === "move") {
    if (!isPersonalId(targetId) || state.kind !== "move") return { why: "is a library move: only the athlete's own moves are corrected here" };
    if (state.status !== "active") return { why: `is ${state.status === "merged" ? "merged into another move" : state.status}, not one the athlete is offered` };
    return { value: at(state.record, MOVE_PATH[field as (typeof MOVE_FIELDS)[number]]) ?? null };
  }
  if (state.kind !== "post") return { why: "isn't one of the athlete's posts" };
  const n = postRef(targetId)!.n;
  if (target === "reading") {
    const move = movesOf(state)[n];
    if (!move || typeof move !== "object") return { why: `holds no move at position ${n}` };
    return { value: (move as Record<string, unknown>)[field] ?? null };
  }
  if (target === "insight") {
    const parts = insightParts(insightsOf(state)[n]);
    if (!parts) return { why: `holds no insight at ${n}` };
    // A dropped one reads as dropped (`true`): an approve asked again finds it so.
    if (field === "drop") return { value: parts.dropped ? true : parts.text };
    if (field === "text") return { value: parts.text };
    if (field === "scope") return { value: parts.scope };
    return { value: parts.move };
  }
  const link = state.links.find((l) => l.position === n && l.status === "saved");
  if (!link) return { why: `holds no saved move at position ${n}` };
  if (field === "not_same" && link.moveKind !== "library") return { why: "isn't linked to a library move: nothing to say it isn't" };
  return { value: link.moveId };
}

const line = (max: number) => z.string().trim().min(1).max(max);
const caseSchema = z.object({ text: line(160), evidence: z.enum(["stated", "inferred"]) }).strict();
const doseSchema = z
  .object({
    type: z.enum(DOSE_TYPES),
    range: z.tuple([z.number().positive(), z.number().positive()]).refine(([lo, hi]) => lo <= hi, { message: "the range's low end is above its high" }),
    sets: z.tuple([z.number().int().min(1), z.number().int().min(1)]).refine(([lo, hi]) => lo <= hi, { message: "the sets' low end is above its high" }).optional(),
    restSec: z.number().int().min(0).max(900).optional(),
    secsPerRep: z.number().min(0).max(60).optional(),
  })
  .strict();

const AFTER: Readonly<Record<string, z.ZodTypeAny>> = {
  "move.name": line(80),
  "move.summary": line(160),
  "move.purpose": line(160),
  "move.dose": doseSchema,
  "move.laterality": z.enum(LATERALITY),
  "move.load": z.enum(LOADS),
  "move.equipment": z.array(z.enum(EQUIPMENT_IDS)).max(8),
  "move.steps": z.array(line(200)).min(1).max(12),
  "move.cues": z.array(line(160)).max(8),
  "reading.useWhen": z.array(caseSchema).max(4),
  "reading.skipWhen": z.array(caseSchema).max(4),
  "reading.why": line(200),
  "insight.drop": z.literal(true),
  "insight.text": line(200),
  "insight.scope": z.enum(INSIGHT_SCOPES),
  "insight.move": z.number().int().min(0).max(99),
  "link.same_as": z.string().min(1).max(80),
  "link.not_same": z.null(),
};

/**
 * A proposed value, checked: its shape, and for a move the corrected record against the library's own validation; for an
 * insight's move, a position the post holds. Answers the value as it will be written, or what is wrong in words.
 */
export function checkedAfter(target: CorrectionTarget, field: string, after: unknown, state: CorrectionState): { value: unknown } | { why: string } {
  const schema = AFTER[`${target}.${field}`];
  if (!schema) return { why: `${target} has no field ${JSON.stringify(field)}` };
  const parsed = schema.safeParse(after);
  if (!parsed.success) return { why: parsed.error.issues.map((i) => `${i.path.length ? `after.${i.path.join(".")}` : "after"}: ${i.message}`).join("; ") };
  if (target === "move" && state.kind === "move") {
    const value = field === "dose" ? mergedDose(state.record.dose as unknown as Record<string, unknown>, parsed.data as Record<string, unknown>) : parsed.data;
    const next = withMoveField(state.record, field as (typeof MOVE_FIELDS)[number], value);
    const problems = validatePersonalRecord(next).map((p) => p.replace(/^\S+: /, ""));
    if (problems.length) return { why: problems.slice(0, 3).join("; ") };
    return { value };
  }
  if (target === "insight" && field === "move" && state.kind === "post" && !movesOf(state)[parsed.data as number]) return { why: `the post holds no move at position ${parsed.data}` };
  return { value: parsed.data };
}

/**
 * A dose fix over the dose it corrects (the controller's fix pass, D11): what the fix doesn't say is kept — its sets, its
 * rest, its starting load, and its seconds a rep while it stays reps (a time or a carry has none).
 */
export function mergedDose(before: Record<string, unknown> | undefined, after: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = { ...(before && typeof before === "object" ? before : {}) };
  if (after.type !== "reps") delete kept.secsPerRep;
  return { ...kept, ...after };
}

const FIELD_WORDS: Readonly<Record<string, string>> = {
  "move.name": "Name",
  "move.summary": "Summary",
  "move.purpose": "Purpose",
  "move.dose": "Dose",
  "move.laterality": "Sides",
  "move.load": "Load",
  "move.equipment": "Equipment",
  "move.steps": "Steps",
  "move.cues": "Cues",
  "reading.useWhen": "When to use it",
  "reading.skipWhen": "When to skip it",
  "reading.why": "Why",
};

const SCOPE_WORDS: Readonly<Record<InsightScope, string>> = {
  general: "general",
  this_routine: "this routine only",
  creator_programme: "the creator's own programme",
};

/**
 * A correction in one line, as the card and the trail show it: "Dose of Zorbex hip lift: 30 s, 2 sets (was 6–10 reps)",
 * "Insight dropped — “…”", "Zorbex neck nod is the same as Dead bug". `name` is the move's (or the post's) as the
 * account names it; `named` names another move by its id.
 */
export function correctionLine(o: { target: CorrectionTarget; field: string; before: unknown; after: unknown; name: string; insight?: string | null }, named: (id: string) => string): string {
  const quoted = o.insight ? ` — “${o.insight}”` : "";
  switch (o.target) {
    case "move":
      return `${FIELD_WORDS[`move.${o.field}`] ?? o.field} of ${o.name}: ${valueWords(o.after)} (was ${valueWords(o.before)})`;
    case "reading":
      return `${FIELD_WORDS[`reading.${o.field}`] ?? o.field} for ${o.name}: ${valueWords(o.after)} (was ${valueWords(o.before)})`;
    case "insight":
      if (o.field === "drop") return `Insight dropped${quoted}`;
      if (o.field === "text") return `Insight reworded: ${valueWords(o.after)} (was ${valueWords(o.before)})`;
      if (o.field === "scope") return `Insight's scope: ${SCOPE_WORDS[o.after as InsightScope] ?? valueWords(o.after)} (was ${SCOPE_WORDS[o.before as InsightScope] ?? valueWords(o.before)})${quoted}`;
      return `Insight about ${o.name}${quoted}`;
    case "link":
      return o.field === "same_as" ? `${o.name} is the same as ${named(String(o.after))}` : `The post's move isn't the library's ${named(String(o.before))} — a move of its own`;
  }
}

// ── Applied at Approve (design-approve.ts) ──────────────────────────────────────────────────────────────────────────

/** The corrections' own part of an approve: their claim's write, their one read (every target's state), and — a
 * correction of a move or a match changes the account's library, which the request then forgets — the library read
 * again by a later op of the request (a workout's day, the receipt), once (final review I4). */
export const CORRECTIONS_FIXED = 1 + 1 + 1;
/**
 * The corrections one approve request applies, at most (the controller's fix pass, B, 2026-11-06): beside the
 * statements, each costs the Worker its target judged, its record checked and its statements built and bound — measured
 * (design-cpu-bench 5c: ten at the caps beside a 30-line pins card, a 60 KB ops JSON) at about 0.4 ms each, so ten in
 * one request ran 5.9 ms scaled p50 against the approve's 4 ms. The rest wait in `remaining`, as a request's room does.
 */
export const CORRECTIONS_PER_REQUEST = 4;
/** One correction: its `import_corrections` row, its trail event (one statement for every post it touches), and the
 * state change — one atomic batch. */
export const CORRECTION_COST = 3;

/** What one correction costs: CORRECTION_COST, and its extra writes — a "same as" link's archive and its like marks (2),
 * a "not the same" link's new move (1), an insight's memory row (1). */
export function correctionCostOf(op: Pick<ImportCorrectionOp, "target" | "field">): number {
  if (op.target === "link") return CORRECTION_COST + (op.field === "same_as" ? 2 : 1);
  if (op.target === "insight" && op.field !== "move") return CORRECTION_COST + 1;
  return CORRECTION_COST;
}

/** Every correction's target state, ONE statement: a column each (`s0`, `s1`, …). */
export function correctionsReadSql(userId: string, ops: readonly Pick<ImportCorrectionOp, "target" | "targetId">[], today: string): SQL {
  if (ops.length === 0) return sql`select 1`;
  return sql`select ${sql.join(ops.map((o, i) => sql`${correctionStateSql(userId, o.target, o.targetId, today)} as ${sql.raw(`s${i}`)}`), sql`, `)}`;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** `expr` (a json_extract) holds `value` — a scalar as itself, a list or an object as JSON. */
function valueIs(expr: SQL, value: unknown): SQL {
  if (value === null || value === undefined) return sql`(${expr} IS NULL)`;
  if (typeof value === "string" || typeof value === "number") return sql`(${expr} = ${value})`;
  if (typeof value === "boolean") return sql`(${expr} = ${value ? 1 : 0})`;
  return sql`(${expr} IS NOT NULL AND json(${expr}) = json(${JSON.stringify(value)}))`;
}

/** `value` as json_set takes it. */
const jsonArg = (value: unknown): SQL =>
  typeof value === "string" || typeof value === "number" ? sql`${value}` : sql`json(${JSON.stringify(value ?? null)})`;

const MOVE_JSON_PATH: Readonly<Record<(typeof MOVE_FIELDS)[number], string>> = {
  name: "$.name", summary: "$.text.summary", purpose: "$.text.why", dose: "$.dose", laterality: "$.laterality", load: "$.load",
  equipment: "$.equipment", steps: "$.text.steps", cues: "$.text.focus",
};

/** How it stands at Approve: already so (recorded applied, nothing written), changed since (refused), gone, or to write. */
export type CorrectionVerdict =
  | { status: "made" }
  | { status: "refused"; error: "stale" | "not_a_target" | "invalid"; why: string }
  | { status: "apply"; statements: AtomicStatement[]; lines: string[]; touches: "library" | "post" };

export const STALE_WHY = "It changed since the coach suggested this — ask again.";

/** The new personal move a "not the same" correction makes: its id is the post's position's, so a retry finds it. */
export const ownMoveIdOf = (userId: string, postId: string, position: number, name: string): string => newPersonalMoveId(userId, `${postId}:own`, position, name);

/**
 * One correction at Approve, judged on its target as it stands now (`state`, the approve's read) — and, to write, its
 * statements: the `import_corrections` row and the trail event on each post it touches, each gated on the value still
 * being `before` and the proposal as this request last wrote it (`asRead`), the extra writes, then the state change,
 * LAST, `… returning` (runAtomicallyClaim: nothing of it lands when the gate fails).
 */
export function judgeCorrection(
  db: Db,
  userId: string,
  op: ImportCorrectionOp,
  state: CorrectionState | null,
  o: { proposalId: string; runId: string | null; now: string; asRead: SQL },
): CorrectionVerdict {
  const current = currentValue(op.target, op.targetId, op.field, state);
  if ("why" in current) return { status: "refused", error: "not_a_target", why: `What it corrects ${current.why}.` };
  // A "not the same" applied: the link now names the move it made.
  const ref = postRef(op.targetId);
  const link = state?.kind === "post" && ref ? state.links.find((l) => l.position === ref.n && l.status === "saved") : undefined;
  if (op.target === "link" && op.field === "not_same" && link && link.moveKind === "personal" && state?.kind === "post") {
    const draft = (state.extraction?.moves as Array<{ name?: unknown }> | undefined)?.[ref!.n];
    if (typeof draft?.name === "string" && link.moveId === ownMoveIdOf(userId, ref!.postId, ref!.n, draft.name)) return { status: "made" };
  }
  if (same(current.value, op.after)) return { status: "made" };
  if (!same(current.value, op.before)) return { status: "refused", error: "stale", why: STALE_WHY };

  const evidence = JSON.stringify(op.cites ?? []);
  const summary = summaryLine(`${op.line} — ${op.why}`);
  const detail = JSON.stringify({ target: op.target, targetId: op.targetId, field: op.field, before: op.before, after: op.after, basis: op.basis, cites: op.cites ?? [], by: "coach" });
  /** The log: the correction row and the trail event on each post, both only while `gate` holds. */
  const log = (gate: SQL): AtomicStatement[] => [
    db.insert(importCorrections).select(
      sql`SELECT ${newId()}, ${userId}, ${op.target}, ${op.targetId}, ${op.field}, ${JSON.stringify(op.before ?? null)}, ${JSON.stringify(op.after ?? null)},
        ${op.why}, ${op.basis}, ${evidence}, 'coach', ${o.proposalId}, ${o.now} WHERE ${gate} AND ${o.asRead}`,
    ),
    db.insert(importEvents).select(
      sql`SELECT lower(hex(randomblob(16))), ${userId}, j.value, NULL, ${op.moveId ?? null}, 'correction', 'coach', 'ok', ${summary}, ${detail},
        NULL, NULL, NULL, NULL, NULL, NULL, ${o.runId}, ${o.proposalId}, 0, ${o.now}
        FROM json_each(${JSON.stringify(op.posts)}) j WHERE ${gate} AND ${o.asRead}`,
    ),
  ];

  if (op.target === "move" && state?.kind === "move") {
    const field = op.field as (typeof MOVE_FIELDS)[number];
    const problems = validatePersonalRecord(withMoveField(state.record, field, op.after));
    if (problems.length) return { status: "refused", error: "invalid", why: `The corrected move doesn't pass the library's rules: ${problems[0]!.replace(/^\S+: /, "")}` };
    const path = MOVE_JSON_PATH[field];
    const gate = sql`EXISTS (SELECT 1 FROM personal_moves g WHERE g.user_id = ${userId} AND g.id = ${op.targetId} AND g.status = 'active'
      AND ${valueIs(sql`json_extract(g.record, ${path})`, op.before)})`;
    return {
      status: "apply",
      touches: "library",
      lines: [],
      statements: [
        ...log(gate),
        db
          .update(personalMoves)
          // Never `edited_by_owner` (the controller's fix pass, D10): a coach's correction is no athlete's edit, so the
          // move's condition ratings stay the post's reading — "not checked by the athlete" (account-library `unchecked`).
          // Nothing an import does rewrites a record (matching only adds links), so it needs no guard of its own.
          .set({ record: sql`json_set(${personalMoves.record}, ${path}, ${jsonArg(op.after)})`, updatedAt: o.now })
          .where(sql`${personalMoves.userId} = ${userId} AND ${personalMoves.id} = ${op.targetId} AND ${gate} AND ${o.asRead}`)
          .returning({ id: personalMoves.id }),
      ],
    };
  }
  if (state?.kind !== "post" || !ref) return { status: "refused", error: "not_a_target", why: "What it corrects isn't there any more." };

  if (op.target === "reading") {
    const path = `$.moves[${ref.n}].${op.field}`;
    const gate = sql`EXISTS (SELECT 1 FROM saved_posts g WHERE g.user_id = ${userId} AND g.id = ${ref.postId} AND json_valid(g.extraction)
      AND ${valueIs(sql`json_extract(g.extraction, ${path})`, op.before)})`;
    return {
      status: "apply",
      touches: "post",
      lines: [],
      statements: [
        ...log(gate),
        db
          .update(savedPosts)
          .set({ extraction: sql`json_set(${savedPosts.extraction}, ${path}, ${jsonArg(op.after)})`, updatedAt: o.now })
          .where(sql`${savedPosts.userId} = ${userId} AND ${savedPosts.id} = ${ref.postId} AND ${gate} AND ${o.asRead}`)
          .returning({ id: savedPosts.id }),
      ],
    };
  }

  if (op.target === "insight") {
    const asRead = (state.extraction?.insights as unknown[] | undefined)?.[ref.n];
    const base: Record<string, unknown> = typeof asRead === "string" ? { text: asRead, scope: "general" } : { ...(asRead as Record<string, unknown>) };
    const next =
      op.field === "drop" ? { ...base, dropped: true } : op.field === "text" ? { ...base, text: op.after } : op.field === "scope" ? { ...base, scope: op.after } : { ...base, move: op.after };
    const path = `$.insights[${ref.n}]`;
    const gate = sql`EXISTS (SELECT 1 FROM saved_posts g WHERE g.user_id = ${userId} AND g.id = ${ref.postId} AND json_valid(g.extraction)
      AND ${valueIs(sql`json_extract(g.extraction, ${path})`, asRead)})`;
    // The coach's memory of it (Save kept a general one: `saved:<post>:<index>`): let go when dropped or no longer
    // general, reworded with it.
    const memoryId = `saved:${ref.postId}:${ref.n}`;
    const memory: AtomicStatement[] =
      op.field === "text"
        ? [db.update(coachMemory).set({ body: String(op.after), updatedAt: o.now }).where(sql`${coachMemory.userId} = ${userId} AND ${coachMemory.id} = ${memoryId} AND ${gate} AND ${o.asRead}`)]
        : op.field === "drop" || (op.field === "scope" && op.after !== "general")
          ? [db.update(coachMemory).set({ active: false, updatedAt: o.now }).where(sql`${coachMemory.userId} = ${userId} AND ${coachMemory.id} = ${memoryId} AND ${gate} AND ${o.asRead}`)]
          : [];
    return {
      status: "apply",
      touches: "post",
      lines: [],
      statements: [
        ...log(gate),
        ...memory,
        db
          .update(savedPosts)
          .set({ extraction: sql`json_set(${savedPosts.extraction}, ${path}, json(${JSON.stringify(next)}))`, updatedAt: o.now })
          .where(sql`${savedPosts.userId} = ${userId} AND ${savedPosts.id} = ${ref.postId} AND ${gate} AND ${o.asRead}`)
          .returning({ id: savedPosts.id }),
      ],
    };
  }

  // A link's match.
  if (!link) return { status: "refused", error: "not_a_target", why: "What it corrects isn't there any more." };
  const gate = sql`EXISTS (SELECT 1 FROM saved_post_moves g WHERE g.user_id = ${userId} AND g.id = ${link.id} AND g.status = 'saved' AND g.move_id = ${String(op.before)})`;
  if (op.field === "same_as") {
    const to = String(op.after);
    const toKind = isPersonalId(to) ? "personal" : "library";
    const dup = String(op.before);
    const extra: AtomicStatement[] = [];
    const lines: string[] = [];
    if (isPersonalId(dup)) {
      const u = state.usage ?? { sets: false, plans: false, pinned: false, others: 0 };
      const held = [u.sets ? "it has logged sets" : null, u.plans ? "a planned workout holds it" : null, u.pinned ? "it is in your rotation" : null, u.others > 0 ? "another post names it" : null].filter(Boolean);
      // §14.3: archived into the move it is when nothing holds it; else kept, its other links marked like it.
      extra.push(
        db
          .update(personalMoves)
          .set({ status: "merged", mergedInto: to, fitChoice: null, updatedAt: o.now })
          .where(sql`${personalMoves.userId} = ${userId} AND ${personalMoves.id} = ${dup} AND ${personalMoves.status} = 'active'
            AND NOT EXISTS (SELECT 1 FROM saved_post_moves x WHERE x.user_id = ${userId} AND x.move_id = ${dup} AND x.status = 'saved' AND x.id <> ${link.id})
            AND NOT EXISTS (SELECT 1 FROM exercise_prefs x WHERE x.user_id = ${userId} AND x.exercise_id = ${dup} AND x.pinned = 1)
            AND NOT EXISTS (SELECT 1 FROM performed_sets x JOIN performed_sessions xs ON xs.id = x.performed_session_id WHERE xs.user_id = ${userId} AND x.exercise_id = ${dup})
            AND NOT EXISTS (SELECT 1 FROM planned_workouts x WHERE x.user_id = ${userId} AND x.effective_date >= ${o.now.slice(0, 10)} AND instr(coalesce(x.workout_doc, ''), '"' || ${dup} || '"') > 0)
            AND ${gate} AND ${o.asRead}`),
        db
          .update(savedPostMoves)
          .set({ likeMoveId: to, checkFlag: true })
          .where(sql`${savedPostMoves.userId} = ${userId} AND ${savedPostMoves.moveId} = ${dup} AND ${savedPostMoves.status} = 'saved' AND ${savedPostMoves.id} <> ${link.id}
            AND EXISTS (SELECT 1 FROM personal_moves x WHERE x.user_id = ${userId} AND x.id = ${dup} AND x.status = 'active') AND ${gate} AND ${o.asRead}`),
      );
      if (held.length) lines.push(`${op.name} stays: ${held.join(", ")} — marked like ${op.toName ?? to}`);
    }
    return {
      status: "apply",
      touches: "library",
      lines,
      statements: [
        ...log(gate),
        ...extra,
        db
          .update(savedPostMoves)
          .set({ moveId: to, moveKind: toKind, likeMoveId: null, checkFlag: false })
          .where(sql`${savedPostMoves.userId} = ${userId} AND ${savedPostMoves.id} = ${link.id} AND ${gate} AND ${o.asRead}`)
          .returning({ id: savedPostMoves.id }),
      ],
    };
  }
  // Not the same: a move of its own, from the post's reading at that position, active on approval (§14.3).
  const draft = extractedMoveSchema.safeParse((state.extraction?.moves as unknown[] | undefined)?.[ref.n]);
  if (!draft.success) return { status: "refused", error: "invalid", why: "The post's reading of that move can't make a move of its own." };
  const id = ownMoveIdOf(userId, ref.postId, ref.n, draft.data.name);
  const built = buildPersonalRecord(id, draft.data);
  if (!built.ok) return { status: "refused", error: "invalid", why: `The post's reading doesn't pass the library's rules: ${built.issues[0] ?? ""}` };
  return {
    status: "apply",
    touches: "library",
    lines: [],
    statements: [
      ...log(gate),
      db
        .insert(personalMoves)
        .select(
          sql`SELECT ${id}, ${userId}, 'active', NULL, ${link.batchId}, ${JSON.stringify(built.record)}, 0, NULL, ${o.now}, ${o.now} WHERE ${gate} AND ${o.asRead}`,
        )
        .onConflictDoNothing(),
      db
        .update(savedPostMoves)
        .set({ moveId: id, moveKind: "personal", likeMoveId: null, checkFlag: false })
        .where(sql`${savedPostMoves.userId} = ${userId} AND ${savedPostMoves.id} = ${link.id} AND ${gate} AND ${o.asRead}`)
        .returning({ id: savedPostMoves.id }),
    ],
  };
}
