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
import { DOSE_TYPES, EQUIPMENT_IDS, LATERALITY, LOADS, type ExerciseRecord } from "@rg/exercise-library";
import { INSIGHT_SCOPES, isPersonalId, type InsightScope } from "@rg/saves";
import { validatePersonalRecord } from "./personal-records.js";
import type { CorrectionTarget } from "./proposal-kinds.js";
import { valueWords } from "./saves-evidence.js";

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
}

export type CorrectionState =
  | { kind: "move"; status: string; record: ExerciseRecord; posts: string[] }
  | { kind: "post"; postId: string; status: string; extraction: Record<string, unknown> | null; links: StateLink[] };

/**
 * The target's current state as ONE JSON value (a scalar subquery), null when it isn't the athlete's: a move's status,
 * record and the posts its saved links name; a post's status, reading and links.
 */
export function correctionStateSql(userId: string, target: CorrectionTarget, targetId: string): SQL {
  if (target === "move") {
    return sql`(select json_object('kind', 'move', 'status', cs_m.status, 'record', json(cs_m.record),
        'posts', (select json_group_array(distinct cs_l.post_id) from saved_post_moves cs_l where cs_l.user_id = ${userId} and cs_l.move_id = cs_m.id and cs_l.status = 'saved'))
      from personal_moves cs_m where cs_m.user_id = ${userId} and cs_m.id = ${targetId} and json_valid(cs_m.record))`;
  }
  const ref = postRef(targetId);
  if (!ref) return sql`null`;
  return sql`(select json_object('kind', 'post', 'postId', cs_p.id, 'status', cs_p.status,
      'extraction', json(case when json_valid(cs_p.extraction) then cs_p.extraction end),
      'links', (select json_group_array(json_array(cs_l.position, cs_l.move_id, cs_l.move_kind, cs_l.status, cs_l.id)) from saved_post_moves cs_l
        where cs_l.user_id = ${userId} and cs_l.post_id = cs_p.id))
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
      const [position, moveId, moveKind, status, id] = Array.isArray(l) ? (l as unknown[]) : [];
      return typeof position === "number" && typeof moveId === "string" && typeof id === "string"
        ? [{ position, moveId, moveKind: moveKind === "library" ? "library" : "personal", status: typeof status === "string" ? status : "", id }]
        : [];
    });
    const extraction = o.extraction && typeof o.extraction === "object" ? (o.extraction as Record<string, unknown>) : null;
    return { kind: "post", postId: o.postId, status: typeof o.status === "string" ? o.status : "", extraction, links };
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
export function insightParts(i: unknown): { text: string; scope: InsightScope; move: number | null } | null {
  if (typeof i === "string") return { text: i, scope: "general", move: null };
  const o = i && typeof i === "object" ? (i as Record<string, unknown>) : null;
  if (!o || typeof o.text !== "string") return null;
  return {
    text: o.text,
    scope: (INSIGHT_SCOPES as readonly unknown[]).includes(o.scope) ? (o.scope as InsightScope) : "general",
    move: typeof o.move === "number" ? o.move : null,
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
    if (field === "drop") return { value: parts.text };
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
    const next = withMoveField(state.record, field as (typeof MOVE_FIELDS)[number], parsed.data);
    const problems = validatePersonalRecord(next).map((p) => p.replace(/^\S+: /, ""));
    if (problems.length) return { why: problems.slice(0, 3).join("; ") };
  }
  if (target === "insight" && field === "move" && state.kind === "post" && !movesOf(state)[parsed.data as number]) return { why: `the post holds no move at position ${parsed.data}` };
  return { value: parsed.data };
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
