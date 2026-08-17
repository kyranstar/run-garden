/**
 * COROS strength-exercise catalog sync (plan-studio-design §4). The bridge
 * fetches `GET /training/exercise/query?sportType=4` and includes
 * `exerciseCatalog: [{id, name}]` in its snapshot payload when the worker's
 * last sync response said the stored catalog was stale. This is a global,
 * shared reference table (not per-user) — the same ~382 COROS strength
 * exercises apply to every account.
 */

import { asc, sql } from "drizzle-orm";
import { corosExercises } from "@rg/database";
import { COROS_EXERCISE_NAMES } from "@rg/providers";
import { nowInstant, sessionExercises, type CoachOp, type CoachSession } from "@rg/domain";
import { chunkedInsert, type Db } from "./db.js";

const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface ExerciseCatalogItem {
  id: string;
  name: string;
}

/** Upserts each catalog entry by originId (id). */
export async function upsertExerciseCatalog(
  db: Db,
  items: ExerciseCatalogItem[],
): Promise<{ upserted: number }> {
  const now = nowInstant();
  // Batched multi-row upserts (~382 catalog entries): one statement per row
  // was ~382 D1 subrequests inside the bridge-sync request, enough to blow
  // the Worker's budget and fail the whole sync — which re-marked the
  // catalog stale and repeated the failure every 30 minutes.
  const rows = items.map((item) => ({
    id: item.id,
    name: item.name,
    raw: { id: item.id, name: item.name } as Record<string, unknown>,
    updatedAt: now,
  }));
  await chunkedInsert(rows, 4, (batch) =>
    db
      .insert(corosExercises)
      .values(batch)
      .onConflictDoUpdate({
        target: corosExercises.id,
        set: {
          name: sql`excluded.name`,
          raw: sql`excluded.raw`,
          updatedAt: sql`excluded.updated_at`,
        },
      }),
  );
  return { upserted: items.length };
}

/**
 * Stale when there are no rows yet, or the oldest row hasn't been refreshed
 * in 7+ days (worker-side rule, spec §4).
 */
export async function isExerciseCatalogStale(db: Db): Promise<boolean> {
  const rows = await db
    .select({ updatedAt: corosExercises.updatedAt })
    .from(corosExercises)
    .orderBy(asc(corosExercises.updatedAt))
    .limit(1);
  const oldest = rows[0]?.updatedAt;
  if (!oldest) return true;
  return Date.now() - Date.parse(oldest) > STALE_AFTER_MS;
}

/** id → human name, for resolving code-named exercises at display time. */
export async function exerciseNameMap(db: Db): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: corosExercises.id, name: corosExercises.name })
    .from(corosExercises);
  return new Map(rows.map((r) => [r.id, r.name]));
}

const isCodeName = (s: string): boolean =>
  /^[A-Za-z]{0,3}[\d\-_.]{2,}$/.test(s.replace(/\s/g, "")) || s.trim().length === 0;

/**
 * The actual exercise name, always (user requirement, rounds 3–5): COROS's
 * API returns i18n KEYS as names — live-verified, the entire synced catalog
 * is T-codes — so resolution walks name → catalog(originId) → catalog(name)
 * and translates whichever candidate first appears in COROS's own English
 * locale table (COROS_EXERCISE_NAMES). Only a key COROS itself doesn't
 * translate survives as-is.
 */
export function resolveExerciseName(
  name: string,
  originId: string | undefined,
  catalog: Map<string, string>,
): string {
  const candidates = [name, originId ? catalog.get(originId) : undefined, catalog.get(name.trim())];
  for (const c of candidates) if (c && !isCodeName(c)) return c;
  for (const c of candidates) {
    const translated = c && COROS_EXERCISE_NAMES[c.trim()];
    if (translated) return translated;
  }
  return name;
}

/* ------------------------------------------------------------------ *
 * The REVERSE direction: a model-supplied NAME → a catalog originId.
 *
 * `resolveExerciseName` above answers "what is T1231 called?". The coach
 * needs the opposite: it is never handed the catalog (the studio path is —
 * jobs.ts, `catalog is only the entries THIS session needs`), so it writes
 * "Wall sit" and something has to find T1231's row. Without this, the only
 * way to get an originId was to require it of the model, which is what
 * silently killed the 2026-08-16 ski-prep plan.
 *
 * Matching runs on the HUMAN names (COROS_EXERCISE_NAMES), because the
 * stored catalog names are themselves i18n keys — all 382 synced rows are
 * T-codes, live-verified.
 * ------------------------------------------------------------------ */

/**
 * Word-level aliases applied before matching. Kept deliberately short: each
 * entry is a form a coach writes and COROS does not, not a thesaurus.
 */
const WORD_ALIASES: Record<string, string> = {
  db: "dumbbell",
  bb: "barbell",
  kb: "kettlebell",
  sl: "single leg",
  bw: "bodyweight",
  ohp: "overhead press",
  rdl: "romanian deadlift",
  ghr: "glute ham raise",
  situp: "sit up",
  pushup: "push up",
  pullup: "pull up",
  stepup: "step up",
  pressup: "push up",
  unilateral: "single leg",
  // Prescription adjectives, not part of any catalog name — the tempo and
  // the hold live in their own fields now.
  eccentric: "",
  isometric: "",
  tempo: "",
  slow: "",
};

/** Whole-phrase synonyms — different words, same movement. Keys are in
 * FOLDED form (lowercase, singular, alias-expanded); see normalizeExerciseKey. */
const PHRASE_ALIASES: Record<string, string> = {
  "wall squat": "wall sit",
  "wall sit hold": "wall sit",
  // COROS calls it "Split Bench Squat"; nobody else does.
  "bulgarian split squat": "split bench squat",
  "rear foot elevated split squat": "split bench squat",
  rfess: "split bench squat",
  "side squat": "lateral squat",
  "front plank": "plank",
  "forearm plank": "plank",
  "hip bridge": "glute bridge",
  "hip thrust": "glute bridge",
  "skater bound": "lateral bound",
  "skater jump": "lateral bound",
  "calf raise": "standing calf raise",
  "heel raise": "standing calf raise",
  "nordic curl": "nordic hamstring curl",
  "air squat": "bodyweight squat",
  "body weight squat": "bodyweight squat",
};

/** Crude but predictable singularizer — catalog names are title-case English. */
function singular(w: string): string {
  if (w.length <= 2 || w.endsWith("ss")) return w;
  // "crunches"→crunch, "boxes"→box, "presses"→press. NOT "raises"→"rais":
  // a bare s before "es" is part of the stem unless it is a doubled ss.
  if (/(ch|sh|x|z|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.endsWith("s")) return w.slice(0, -1);
  return w;
}

/**
 * The matching key: case, punctuation, accents, plurals and the alias table
 * all folded away. "Single-Leg Calf Raises" and "single leg calf raise" and
 * "SL calf raises" all land on the same string.
 */
function fold(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .flatMap((w) => (WORD_ALIASES[w] ?? w).split(" "))
    .filter(Boolean)
    .map(singular)
    .join(" ");
}

export function normalizeExerciseKey(name: string): string {
  // Phrase aliases are matched on the FOLDED form, so "heel raises",
  // "Heel Raise" and "heel-raises" all reach the same entry. Their values
  // are folded again because an alias target is itself English.
  const folded = fold(name);
  const alias = PHRASE_ALIASES[folded];
  return alias ? fold(alias) : folded;
}

export interface ExerciseIndex {
  /** normalized human name → catalog originId. */
  byKey: Map<string, string>;
  /** normalized name → its token set, for the near-match pass. */
  tokens: Array<{ id: string; key: string; set: Set<string> }>;
  /** Every id in the athlete's synced catalog — for checking a
   * model-supplied originId is real rather than invented. */
  ids: Set<string>;
}

/**
 * Build the name→id index once per wake. Ambiguity is resolved by keeping
 * the FIRST id for a key — the catalog contains genuine duplicates
 * ("Plank Jacks" is both T1077 and T1259) and either is equally correct.
 */
export function buildExerciseIndex(catalog: Map<string, string>): ExerciseIndex {
  const byKey = new Map<string, string>();
  const tokens: ExerciseIndex["tokens"] = [];
  for (const [id, stored] of catalog) {
    const human = COROS_EXERCISE_NAMES[stored.trim()] ?? stored;
    if (!human || isCodeName(human)) continue;
    const key = normalizeExerciseKey(human);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, id);
    tokens.push({ id, key, set: new Set(key.split(" ")) });
  }
  return { byKey, tokens, ids: new Set(catalog.keys()) };
}

/** Ratio below which a near-match is a guess, not a match. */
const MIN_OVERLAP = 0.7;

/**
 * name → catalog originId, or null when the athlete's synced catalog simply
 * has no such exercise. Null is a NORMAL outcome, not an error: the session
 * still persists and still shows in the app, it just can never reach the
 * watch. Silently dropping it is the bug this whole path exists to fix.
 */
export function resolveExerciseOriginId(name: string, index: ExerciseIndex): string | null {
  const key = normalizeExerciseKey(name);
  if (!key) return null;
  const exact = index.byKey.get(key);
  if (exact) return exact;
  // Near match: token overlap (Jaccard) against every catalog entry, taken
  // only when one candidate clearly wins — "squat" must not silently become
  // "Bulgarian Split Squat".
  const want = new Set(key.split(" "));
  let best: { id: string; score: number } | null = null;
  let tie = false;
  for (const e of index.tokens) {
    let shared = 0;
    for (const t of want) if (e.set.has(t)) shared += 1;
    const score = shared / (want.size + e.set.size - shared);
    if (!best || score > best.score) {
      best = { id: e.id, score };
      tie = false;
    } else if (best && score === best.score && e.id !== best.id) {
      tie = true;
    }
  }
  if (!best || best.score < MIN_OVERLAP || tie) return null;
  return best.id;
}

/** Everything a wake needs to resolve names, loaded in one query. */
export async function loadExerciseIndex(db: Db): Promise<ExerciseIndex> {
  return buildExerciseIndex(await exerciseNameMap(db));
}

export interface ExerciseResolution {
  name: string;
  originId: string | null;
  /** "model" = the model supplied a real catalog id (it is given the
   * catalog in its dossier); "name" = this resolver matched the name;
   * null = the athlete's catalog has no such movement. */
  via: "model" | "name" | null;
}

/** Every session an op carries, whatever its shape. */
function opSessions(op: CoachOp): CoachSession[] {
  const out: CoachSession[] = [];
  const one = (op as { session?: CoachSession }).session;
  if (one) out.push(one);
  for (const s of (op as { sessions?: Array<{ session: CoachSession }> }).sessions ?? []) out.push(s.session);
  for (const s of (op as { firmSessions?: Array<{ session: CoachSession }> }).firmSessions ?? []) {
    out.push(s.session);
  }
  return out;
}

/**
 * Stamp every exercise in these ops with its catalog originId, IN PLACE,
 * and report what happened. Run once per wake, before the proposals are
 * persisted, so the stored ops — and therefore the apply, the session
 * sheet, and any future push — all see the same answer.
 *
 * Belt and braces on the model's own id. A model-supplied `originId` is
 * KEPT when it names a row in the athlete's synced catalog — the coach's
 * dossier can carry the catalog, and when it does the model's own choice is
 * better informed than a string match. An id the catalog does not contain
 * is a hallucination and is discarded in favour of matching the name.
 *
 * A null resolution is not an error and never removes an exercise. The
 * session persists whole; it simply carries an honest "the watch's library
 * has no such movement" mark that `offCatalogExercises` reads back.
 */
export function resolveOpsExercises(ops: CoachOp[], index: ExerciseIndex): ExerciseResolution[] {
  const report: ExerciseResolution[] = [];
  for (const op of ops) {
    for (const session of opSessions(op)) {
      for (const ex of sessionExercises(session)) {
        const claimed = ex.originId && index.ids.has(ex.originId) ? ex.originId : null;
        const originId = claimed ?? resolveExerciseOriginId(ex.name, index);
        if (originId) ex.originId = originId;
        else delete (ex as { originId?: string }).originId;
        report.push({ name: ex.name, originId, via: originId ? (claimed ? "model" : "name") : null });
      }
    }
  }
  return report;
}

/**
 * Resolve catalog codes EMBEDDED in composed display text ("15 min T1120 ·
 * 5× T3001") — stage summaries were stored with raw labels at import time,
 * so the read boundary swaps each token that exactly matches a catalog id.
 */
export function resolveCodesInText(text: string, catalog: Map<string, string>): string {
  return text.replace(/[A-Za-z]{0,3}\d[\w.-]*/g, (token) => {
    const viaCatalog = catalog.get(token);
    const candidate = viaCatalog ?? token;
    if (viaCatalog && !isCodeName(viaCatalog)) return viaCatalog;
    return COROS_EXERCISE_NAMES[candidate] ?? COROS_EXERCISE_NAMES[token] ?? token;
  });
}
