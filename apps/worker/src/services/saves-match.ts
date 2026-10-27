/**
 * MATCHING AN EXTRACTED POST'S MOVES (saved-posts import, Task 8; spec §5.5). For each move, in order:
 *
 *  1. Its name or any alias, normalised (`normalizeMoveName`), equals a library move's normalised name, id or legacy id
 *     → that library move, high confidence.
 *  2. The same test against the owner's own moves (active, pending or archived; a merged one resolves to the move it was
 *     merged into) → that personal move, high. This is also how the same new move across posts becomes ONE move: the
 *     first post's pending move is there when the second post is matched. A hit whose load or dose type differs from the
 *     draft's (`sameMoveType`; the load its record would store) is never linked: two load types are never one move. It
 *     is a new move flagged "check this", like the move it is named as — the judge is not asked about it (spec §6).
 *  3. Otherwise a library move or one of the owner's own (not merged) whose name shares enough words (token overlap
 *     ≥ `FUZZY_MIN`) is a candidate, and
 *  4. one cheap judge call per post (`import_match` spend, reserved and settled) says which candidate, if any, is the
 *     same move: yes → that library or personal move, medium, flagged "check this"; no → a new move. No answer at all
 *     (fixture mode, no key, the budget, a failed call) → a new move flagged "check this", for the owner to merge in
 *     review.
 *  5. Two new moves with one normalised name in one post are one personal move with two links.
 *
 * Step 2b, after the judge (`flagNearDuplicates`): a new move one qualifying word from one of the owner's ACTIVE moves
 * (`nearDuplicateOf`) is created, flagged "check this", like that move; its links carry it (`like_move_id`). A pending
 * move of another batch is no target here — the cut holds a batch's new moves to each other (saves-batches.ts).
 *
 * A new move the extraction itself was unsure of (`confidence: "low"`) is flagged "check this" too (spec §4 call 11).
 *
 * `matchPost` writes what it decided as PENDING (personal moves and post-move links, no batch yet) and the post as
 * `matched`, in one transaction. Nothing it writes is usable until the batch is saved (saves-batches.ts). A new move's
 * record is built and validated first; a record that fails leaves the post `failed` (`model_failed`) with the issues,
 * and nothing is stored.
 */
import { and, eq, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId } from "@rg/domain";
import { EXERCISES, type ExerciseRecord } from "@rg/exercise-library";
import { extractionSchema, matchMessages, matchVerdictSchema, nearDuplicateOf, normalizeMoveName, sameMoveType } from "@rg/saves";
import type { ExtractedMove, Extraction, MatchJudgeItem, NearCandidate, NearMove } from "@rg/saves";
import type { Env } from "../env.js";
import { insertBatches, runAtomically, type Db } from "./db.js";
import { messagesCostMicros } from "./llm-messages.js";
import { wakeGateway } from "./gateway-route.js";
import { IMPORT_KINDS, reserveImport, settleImport } from "./saves-budget.js";
import { noteGatewayOutcome } from "./ai-credits.js";
import { extractJson, RETRY_BACKOFF_MS, RETRYABLE_STATUSES } from "./studio-llm.js";
import { FILTER_MODEL_DEFAULT } from "./saves-filter.js";
import { buildPersonalRecord, loadPersonalForMatch, newPersonalMoveId, type PersonalMatchRow } from "./personal-moves.js";
import { repairDraft } from "./personal-records.js";

const { savedPosts, personalMoves, savedPostMoves } = schema;

/** The least token overlap (shared words over all words) that makes a library or personal move a candidate for the judge. */
export const FUZZY_MIN = 0.6;
/** The most candidates one move takes to the judge. */
export const MAX_CANDIDATES = 3;
/** The judge is the filter's small model (`SAVES_FILTER_MODEL` overrides both). */
export const MATCH_MODEL_DEFAULT = FILTER_MODEL_DEFAULT;
/** A reply names at most 12 moves in a few words each. */
export const MATCH_MAX_TOKENS = 300;
const MATCH_TYPICAL_OUTPUT_TOKENS = 60;
const CALL_TIMEOUT_MS = 30_000;
/** `saved_post_moves.confidence` is a number; these are what each word stores. */
export const CONFIDENCE_VALUE = { high: 1, medium: 0.6, low: 0.3 } as const;
type Confidence = keyof typeof CONFIDENCE_VALUE;

export interface MatchCandidate {
  id: string;
  name: string;
  patterns: readonly string[];
  regions: readonly string[];
  /** A library move, or one of the owner's own (whose name a model wrote: the judge sees it inside the data block). */
  kind: "library" | "personal";
  score: number;
}

export interface MatchDecision {
  /** The move's index in the extraction. */
  position: number;
  kind: "library" | "personal" | "new";
  /** The move linked to (library or personal); absent for a new move until it is written. */
  id?: string;
  confidence: Confidence;
  /** "Check this" on the review screen: a match the names alone did not settle, or a new move like one the owner has. */
  check: boolean;
  /** A new move's draft: what its personal record is built from. */
  draft?: ExtractedMove;
  /** Library and personal moves near a new move's name, for the judge (step 3); a decision still holding them was never answered. */
  candidates?: MatchCandidate[];
  /** A new move repeating an earlier new move of the same post (step 5): that move's position. */
  sameAs?: number;
  /** A new move's near-duplicate among the owner's moves (steps 2 and 2b): that move's id, for "like <name>" in review. */
  like?: string;
}

export interface MatchOutcome {
  /** Personal moves this post created. */
  newMoves: number;
  /** Links this post wrote that created no move: to the library, to a move the owner had, or to a move repeated in the post. */
  linked: number;
  /** Set when the post failed (`model_failed`): why, in words that never repeat the model's. */
  issues?: string[];
}

// ── The library's names, indexed once per library array ─────────────────────────────────────────────────────────────

interface LibraryIndex {
  byKey: Map<string, string>;
  words: { rec: ExerciseRecord; words: Set<string> }[];
}

const indexes = new WeakMap<readonly ExerciseRecord[], LibraryIndex>();

/** "hip9090" → "hip 9090", "worldsGreatestStretch" → "worlds greatest stretch". */
const idWords = (id: string): string => id.replace(/([a-z])([A-Z0-9])/g, "$1 $2").replace(/([0-9])([A-Za-z])/g, "$1 $2");

/** A name's words for the overlap score: the normalised name, punctuation dropped. */
function wordsOf(name: string): Set<string> {
  return new Set(
    normalizeMoveName(name)
      .split(" ")
      .map((w) => w.replace(/[^a-z0-9]/g, ""))
      .filter(Boolean),
  );
}

function libraryIndex(library: readonly ExerciseRecord[]): LibraryIndex {
  const known = indexes.get(library);
  if (known) return known;
  const byKey = new Map<string, string>();
  const put = (key: string, id: string) => {
    if (key && !byKey.has(key)) byKey.set(key, id);
  };
  // Names first: a name always wins over another move's id that happens to read the same.
  for (const rec of library) put(normalizeMoveName(rec.name), rec.id);
  for (const rec of library) for (const id of [rec.id, ...rec.legacyIds]) put(normalizeMoveName(idWords(id)), rec.id);
  const built: LibraryIndex = { byKey, words: library.map((rec) => ({ rec, words: wordsOf(rec.name) })) };
  indexes.set(library, built);
  return built;
}

const STATUS_RANK: Readonly<Record<string, number>> = { active: 0, pending: 1, archived: 2, merged: 3 };

/** The owner's moves by normalised name → the id a link should name (a merged move's target). */
function personalIndex(rows: readonly PersonalMatchRow[]): Map<string, string> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const resolve = (row: PersonalMatchRow): string | null => {
    let at: PersonalMatchRow | undefined = row;
    for (let hop = 0; at && at.status === "merged"; hop++) {
      if (hop >= 5 || !at.mergedInto) return null;
      at = byId.get(at.mergedInto);
    }
    return at && at.status in STATUS_RANK && at.status !== "merged" ? at.id : null;
  };
  const out = new Map<string, string>();
  const ordered = rows.filter((r) => r.status in STATUS_RANK).sort((a, b) => STATUS_RANK[a.status]! - STATUS_RANK[b.status]!);
  for (const row of ordered) {
    const key = row.name ? normalizeMoveName(row.name) : "";
    if (!key || out.has(key)) continue;
    const id = resolve(row);
    if (id) out.set(key, id);
  }
  return out;
}

const firstHit = (keys: readonly string[], index: ReadonlyMap<string, string>): string | undefined => {
  for (const k of keys) {
    const id = index.get(k);
    if (id) return id;
  }
  return undefined;
};

/** A move that may be offered to the judge: its words, and the candidate it would be (its score filled in when offered). */
type Pooled = { words: Set<string>; candidate: () => Omit<MatchCandidate, "score"> };

const parseList = (raw: string | null | undefined): string[] => {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

/** The owner's moves that can be candidates: every one but a merged one (its target is in the pool under its own name). */
function personalPool(rows: readonly PersonalMatchRow[]): Pooled[] {
  return rows
    .filter((r) => r.name && r.status in STATUS_RANK && r.status !== "merged")
    .map((r) => ({
      words: wordsOf(r.name!),
      candidate: () => ({ id: r.id, name: r.name!, patterns: parseList(r.patterns), regions: parseList(r.regions), kind: "personal" as const }),
    }));
}

/** Shared words over all words (Jaccard), the best over the move's name and aliases; the closest `MAX_CANDIDATES` of both pools. */
function candidatesFor(move: ExtractedMove, index: LibraryIndex, mine: readonly Pooled[]): MatchCandidate[] {
  const own = [move.name, ...move.aliases].map(wordsOf).filter((w) => w.size > 0);
  const score = (words: Set<string>): number => {
    let best = 0;
    for (const w of own) {
      let shared = 0;
      for (const x of w) if (words.has(x)) shared += 1;
      if (shared === 0) continue;
      best = Math.max(best, shared / (w.size + words.size - shared));
    }
    return best;
  };
  const out: MatchCandidate[] = [];
  for (const { rec, words } of index.words) {
    const s = score(words);
    if (s >= FUZZY_MIN) out.push({ id: rec.id, name: rec.name, patterns: rec.patterns, regions: rec.regions, kind: "library", score: s });
  }
  for (const p of mine) {
    const s = score(p.words);
    if (s >= FUZZY_MIN) out.push({ ...p.candidate(), score: s });
  }
  return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, MAX_CANDIDATES);
}

/** A new move's flag: the extraction itself was unsure of it. */
const unsure = (draft: ExtractedMove): boolean => draft.confidence === "low";

/** A draft as the near-duplicate rule reads it: its name, the load its record would store (`repairDraft`), its dose type. */
const nearOfDraft = (draft: ExtractedMove): NearMove => ({
  name: draft.name,
  load: repairDraft(draft).draft.load,
  doseType: draft.dose.type ?? null,
});
const nearOfRow = (row: PersonalMatchRow): NearCandidate => ({
  id: row.id,
  name: row.name ?? "",
  load: row.load ?? null,
  doseType: row.doseType ?? null,
});

/** Step 5: a new move whose normalised name an earlier new move of the post already has becomes a link to that one. */
function dedupeNew(decisions: readonly MatchDecision[]): MatchDecision[] {
  const first = new Map<string, number>();
  return decisions.map((d) => {
    const { sameAs: _, ...rest } = d;
    if (d.kind !== "new" || !d.draft) return rest;
    const key = normalizeMoveName(d.draft.name);
    const at = first.get(key);
    if (at === undefined) {
      first.set(key, d.position);
      return rest;
    }
    return { ...rest, sameAs: at };
  });
}

/**
 * Steps 1–3 and 5, without the judge: a move with candidates comes back `new`, flagged, holding them — what it stays
 * if the judge never answers (`applyVerdicts`).
 */
export function matchMoves(
  extraction: Extraction,
  library: readonly ExerciseRecord[],
  personal: readonly PersonalMatchRow[],
): MatchDecision[] {
  const lib = libraryIndex(library);
  const mine = personalIndex(personal);
  const byId = new Map(personal.map((r) => [r.id, r]));
  const pool = personalPool(personal);
  return dedupeNew(
    extraction.moves.map((move, position): MatchDecision => {
      const keys = [move.name, ...move.aliases].map(normalizeMoveName).filter(Boolean);
      const libraryId = firstHit(keys, lib.byKey);
      if (libraryId) return { position, kind: "library", id: libraryId, confidence: "high", check: false };
      const personalId = firstHit(keys, mine);
      if (personalId) {
        const hit = byId.get(personalId);
        if (hit && !sameMoveType(nearOfDraft(move), nearOfRow(hit))) {
          return { position, kind: "new", confidence: move.confidence, check: true, draft: move, like: personalId };
        }
        return { position, kind: "personal", id: personalId, confidence: "high", check: false };
      }
      const candidates = candidatesFor(move, lib, pool);
      if (candidates.length) return { position, kind: "new", confidence: "low", check: true, draft: move, candidates };
      return { position, kind: "new", confidence: move.confidence, check: unsure(move), draft: move };
    }),
  );
}

/**
 * Step 4's outcome on the decisions: an answered move is the candidate the judge named — library or personal, medium,
 * flagged — or new (flagged only if the extraction was unsure of it) when it named none or one it was not offered. A
 * move repeating an earlier one of the post takes that one's answer (it is never asked about twice). Unanswered moves
 * (`verdicts` null, or a move the reply left out) stay new and flagged.
 */
export function applyVerdicts(
  decisions: readonly MatchDecision[],
  verdicts: ReadonlyMap<number, string | null> | null,
): MatchDecision[] {
  return dedupeNew(
    decisions.map((d): MatchDecision => {
      const asked = verdicts?.has(d.position) ? d.position : d.sameAs;
      if (!d.candidates?.length || !d.draft || asked === undefined || !verdicts?.has(asked)) return d;
      const id = verdicts.get(asked);
      const named = id ? d.candidates.find((c) => c.id === id) : undefined;
      if (named) return { position: d.position, kind: named.kind, id: named.id, confidence: "medium", check: true };
      return { position: d.position, kind: "new", confidence: d.draft.confidence, check: unsure(d.draft), draft: d.draft };
    }),
  );
}

/**
 * Step 2b, after the judge: each new move not already like another (step 2) and not repeating one of the post is held to
 * the owner's ACTIVE moves (`nearDuplicateOf`); a hit flags it "check this", like that move. A repeat's link takes its
 * first's like when it is written.
 */
export function flagNearDuplicates(decisions: readonly MatchDecision[], personal: readonly PersonalMatchRow[]): MatchDecision[] {
  const active = personal.filter((r) => r.status === "active" && r.name).map(nearOfRow);
  return decisions.map((d) => {
    if (d.kind !== "new" || !d.draft || d.like !== undefined || d.sameAs !== undefined) return d;
    const hit = nearDuplicateOf(nearOfDraft(d.draft), active);
    return hit ? { ...d, check: true, like: hit.id } : d;
  });
}

/** What the judge is asked: each undecided move once (a repeat in the same post takes its first's answer). */
export function judgeItems(decisions: readonly MatchDecision[]): MatchJudgeItem[] {
  return decisions.flatMap((d) =>
    d.candidates?.length && d.draft && d.sameAs === undefined
      ? [{ position: d.position, move: d.draft, candidates: d.candidates.map(({ score: _, ...c }) => c) }]
      : [],
  );
}

// ── The judge ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Tokens, over-estimated (3 characters each). */
const estimateTokens = (texts: string[]): number => Math.ceil(texts.reduce((n, t) => n + t.length, 0) / 3);

/**
 * One cheap model call for every undecided move of a post. Reserved at its worst case under `import_match` before the
 * call and settled in a `finally`; fixture mode never calls a gateway. `verdicts` is null when nothing answered (no
 * key, fixture mode, the budget, a failed call, a reply that isn't the format). D1 statements: reserve 2, credits note
 * up to 2, settle 1.
 */
export async function judgeMatches(
  env: Env,
  items: readonly MatchJudgeItem[],
  fetchImpl: typeof fetch,
  spend: { db: Db; userId: string; now: string },
): Promise<{ verdicts: Map<number, string | null> | null; costMicros: number }> {
  if (items.length === 0) return { verdicts: new Map(), costMicros: 0 };
  const gateway = wakeGateway(env);
  if (gateway.kind !== "model") return { verdicts: null, costMicros: 0 };
  const { db, userId, now } = spend;
  const model = env.SAVES_FILTER_MODEL || MATCH_MODEL_DEFAULT;
  const { system, userText } = matchMessages(items);
  const inputTokens = estimateTokens([system, userText]);
  const price = (outputTokens: number) =>
    Math.max(1, messagesCostMicros(model, { inputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens }));
  const reservation = await reserveImport(
    db, userId, IMPORT_KINDS.match, model, price(MATCH_MAX_TOKENS), price(MATCH_TYPICAL_OUTPUT_TOKENS), new Date(now),
  );
  if (!reservation.ok) return { verdicts: null, costMicros: 0 };

  let settled = false;
  try {
    const result = await askJudge(gateway.env, fetchImpl, model, system, userText);
    // A 402 records out-of-credits (the owner's banner); a call that worked clears it; any other failure says nothing.
    await noteGatewayOutcome(db, userId, result.ok ? { ok: true } : { ok: false, reason: result.reason });
    if (!result.ok) return { verdicts: null, costMicros: 0 };
    const cost = messagesCostMicros(model, {
      inputTokens: result.inputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: result.outputTokens,
    });
    await settleImport(db, reservation.usageId, { model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, costMicros: cost });
    settled = true;
    return { verdicts: parseVerdicts(result.content, items), costMicros: cost };
  } finally {
    // A throw (or a failed call) must not leave the reservation at its worst case: it settles to nothing spent.
    if (!settled) await settleImport(db, reservation.usageId, null);
  }
}

/** The judge's answers by move position; an id the move was not offered counts as "none". Null when the reply isn't the format. */
function parseVerdicts(content: string, items: readonly MatchJudgeItem[]): Map<number, string | null> | null {
  const parsed = matchVerdictSchema.safeParse(extractJson(content));
  if (!parsed.success) {
    console.warn(JSON.stringify({ level: "warn", msg: "saves match: the judge's reply is not the format" }));
    return null;
  }
  const offered = new Map(items.map((it) => [it.position, new Set(it.candidates.map((c) => c.id))]));
  const out = new Map<number, string | null>();
  for (const m of parsed.data.matches) {
    const ids = offered.get(m.move);
    if (!ids || out.has(m.move)) continue;
    out.set(m.move, m.id !== null && ids.has(m.id) ? m.id : null);
  }
  return out;
}

/**
 * One OpenAI-compatible chat completion, text only, not streamed (a short JSON reply). One resend on a retryable
 * status (a failed request is not billed, so one reservation covers both). Failures carry a reason
 * (`gateway_<status>` / `llm_error`) and are logged, as the filter's are.
 */
async function askJudge(
  env: Env,
  fetchImpl: typeof fetch,
  model: string,
  system: string,
  userText: string,
): Promise<{ ok: true; content: string; inputTokens: number; outputTokens: number } | { ok: false; reason: string }> {
  const body = JSON.stringify({
    model,
    max_tokens: MATCH_MAX_TOKENS,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userText },
    ],
  });
  let failure: { ok: false; reason: string } = { ok: false, reason: "llm_error" };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${env.AI_GATEWAY_BASE_URL || "https://ai-gateway.vercel.sh/v1"}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${env.AI_GATEWAY_API_KEY}`, "Content-Type": "application/json" },
        body,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        console.warn(
          JSON.stringify({ level: "warn", msg: "saves match: ai gateway error", status: response.status, model, attempt, detail: detail.slice(0, 300) }),
        );
        failure = { ok: false, reason: `gateway_${response.status}` };
        if (RETRYABLE_STATUSES.has(response.status)) continue;
        return failure;
      }
      const json = (await response.json().catch(() => null)) as {
        choices?: Array<{ message?: { content?: unknown } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      } | null;
      const content = json?.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        failure = { ok: false, reason: "gateway_bad_response" };
        continue;
      }
      return {
        ok: true,
        content,
        inputTokens: json?.usage?.prompt_tokens ?? estimateTokens([system, userText]),
        outputTokens: json?.usage?.completion_tokens ?? Math.ceil(content.length / 3),
      };
    } catch (e) {
      console.warn(
        JSON.stringify({ level: "warn", msg: "saves match: ai gateway request failed", model, attempt, detail: String(e).slice(0, 200) }),
      );
      failure = { ok: false, reason: "llm_error" };
      if (controller.signal.aborted) return failure;
    } finally {
      clearTimeout(timer);
    }
  }
  return failure;
}

// ── One post ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Match an `extracted` post's moves and write the outcome as pending; the post becomes `matched`. Any other status is
 * left alone (a re-run, a resubmit) and writes nothing. D1 statements: the post 1, personal moves 1 (read once: the
 * names, the candidates and the near-duplicates all come from it), the judge 0 or 5, then one transaction: new moves
 * (10 a statement) + links (7 a statement) + the post — at most 12 moves, so ≤ 5. A 12-move post with a judge call is
 * ≤ 12 in all.
 */
export async function matchPost(
  db: Db,
  env: Env,
  userId: string,
  postId: string,
  now: string,
  fetchImpl: typeof fetch,
): Promise<MatchOutcome> {
  const mine = and(eq(savedPosts.id, postId), eq(savedPosts.userId, userId), eq(savedPosts.status, "extracted"));
  const [post] = await db
    .select({ status: savedPosts.status, extraction: savedPosts.extraction })
    .from(savedPosts)
    .where(and(eq(savedPosts.id, postId), eq(savedPosts.userId, userId)))
    .limit(1);
  if (!post || post.status !== "extracted") return { newMoves: 0, linked: 0 };

  const fail = async (issues: string[], costMicros: number): Promise<MatchOutcome> => {
    await db
      .update(savedPosts)
      .set({
        status: "failed",
        lastErrorCode: "model_failed",
        lastError: issues.join("; ").slice(0, 500),
        costMicros: sql`${savedPosts.costMicros} + ${costMicros}`,
        updatedAt: now,
      })
      .where(mine);
    return { newMoves: 0, linked: 0, issues };
  };

  // Only a schema-parsed draft is ever built into a record.
  const parsed = extractionSchema.safeParse(post.extraction);
  if (!parsed.success) return fail(["extraction: the stored extraction does not match the format"], 0);

  const personal = await loadPersonalForMatch(db, userId);
  let decisions = matchMoves(parsed.data, EXERCISES, personal);
  const items = judgeItems(decisions);
  let judgeCost = 0;
  if (items.length) {
    const judged = await judgeMatches(env, items, fetchImpl, { db, userId, now });
    judgeCost = judged.costMicros;
    decisions = applyVerdicts(decisions, judged.verdicts);
  }
  decisions = flagNearDuplicates(decisions, personal);

  // New moves first: each record is built and checked before anything is written.
  const newIds = new Map<number, string>();
  const moveRows: (typeof personalMoves.$inferInsert)[] = [];
  const issues: string[] = [];
  /** Positions whose record was repaired to pass the library's rules: flagged to check, whatever the match said. */
  const repaired = new Set<number>();
  for (const d of decisions) {
    if (d.kind !== "new" || !d.draft || d.sameAs !== undefined) continue;
    const id = newPersonalMoveId(userId, postId, d.position, d.draft.name);
    const built = buildPersonalRecord(id, d.draft);
    if (!built.ok) {
      issues.push(...built.issues.map((i) => `moves.${d.position}: ${i}`));
      continue;
    }
    if (built.repairs.length) repaired.add(d.position);
    newIds.set(d.position, id);
    moveRows.push({ id, userId, status: "pending", mergedInto: null, batchId: null, record: built.record, editedByOwner: false, createdAt: now, updatedAt: now });
  }
  if (issues.length) return fail(issues.slice(0, 12), judgeCost);

  const byPosition = new Map(decisions.map((d) => [d.position, d]));
  const linkRows: (typeof savedPostMoves.$inferInsert)[] = decisions.map((d) => {
    // A repeat in the post is the same new move: its link is like what its first's is.
    const likeMoveId = d.like ?? (d.sameAs !== undefined ? byPosition.get(d.sameAs)?.like : undefined) ?? null;
    return {
      id: newId(),
      userId,
      postId,
      position: d.position,
      moveId: d.kind === "new" ? newIds.get(d.sameAs ?? d.position)! : d.id!,
      moveKind: d.kind === "library" ? "library" : "personal",
      batchId: null,
      confidence: CONFIDENCE_VALUE[d.confidence],
      checkFlag: d.check || repaired.has(d.position) || likeMoveId !== null,
      status: "pending",
      likeMoveId,
      createdAt: now,
    };
  });
  // A move or link already there (the same post matched before) is kept as it stands: an import never rewrites a
  // personal move, edited by the owner or not; later posts only add links.
  await runAtomically(db, [
    ...insertBatches(moveRows).map((rows) => db.insert(personalMoves).values(rows).onConflictDoNothing()),
    ...insertBatches(linkRows).map((rows) => db.insert(savedPostMoves).values(rows).onConflictDoNothing()),
    db
      .update(savedPosts)
      .set({ status: "matched", lastErrorCode: null, lastError: null, costMicros: sql`${savedPosts.costMicros} + ${judgeCost}`, updatedAt: now })
      .where(mine),
  ]);
  return { newMoves: moveRows.length, linked: linkRows.length - moveRows.length };
}
