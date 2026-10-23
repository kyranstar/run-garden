import { and, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import type { SavedPostRow } from "@rg/database";
import { filterMessages, filterVerdictSchema } from "@rg/saves";
import type { FilterVerdict, PostSubmit, SaveErrorCode, SavePostStatus } from "@rg/saves";
import type { Env } from "../env.js";
import type { Db } from "./db.js";
import { messagesCostMicros } from "./llm-messages.js";
import { wakeGateway } from "./gateway-route.js";
import { IMPORT_KINDS, reserveImport, settleImport } from "./saves-budget.js";
import { noteGatewayOutcome } from "./ai-credits.js";
import { extractJson, RETRY_BACKOFF_MS, RETRYABLE_STATUSES } from "./studio-llm.js";

const { savedPosts } = schema;

/** The small model that reads a caption (and cover) and says whether a post is worth extracting. `SAVES_FILTER_MODEL` overrides. */
export const FILTER_MODEL_DEFAULT = "google/gemini-3.1-flash-lite";
/** Words that promote a post when the model cannot be asked. They never reject one. */
export const TRAINING_WORDS: readonly string[] = [
  "workout", "sets", "reps", "mobility", "stretch", "drill", "exercise", "routine", "warm up", "hold", "rounds",
];
export const FILTER_MAX_TOKENS = 120;
/** A creator's earlier decided posts that must agree before the creator alone decides. */
export const CREATOR_MIN_POSTS = 3;
/** A claim older than this is a worker that died mid-filter; the post may be claimed again. */
export const CLAIM_STALE_MS = 5 * 60_000;
/** Marks a post as being filtered right now. It lives in `last_error_code` (no status of its own) and is overwritten by the outcome. */
const CLAIM = "filtering";
const CALL_TIMEOUT_MS = 30_000;

export type FilterStage = "creator" | "keyword" | "model" | "seed";
export interface FilterOutcome {
  status: SavePostStatus;
  verdict?: FilterVerdict["verdict"];
  stage?: FilterStage;
  reason?: string;
  /** Set when the post stays `seen`: why (`budget_paused`, `model_failed`), or `busy` when another request holds it. */
  errorCode?: SaveErrorCode | "busy";
}

type FilterInput = SavedPostRow & { cover?: PostSubmit["cover"] };

const hasTrainingWord = (post: SavedPostRow): boolean => {
  const text = `${post.caption ?? ""} ${(post.hashtags ?? []).join(" ")}`.toLowerCase();
  return TRAINING_WORDS.some((w) => text.includes(w));
};

/** Tokens, over-estimated (3 characters each; a cover counts a token per 4 base64 characters). */
function estimateInputTokens(texts: string[], cover: PostSubmit["cover"]): number {
  return Math.ceil(texts.reduce((n, t) => n + t.length, 0) / 3) + (cover ? Math.ceil(cover.base64.length / 4) : 0);
}

async function finish(db: Db, row: SavedPostRow, out: FilterOutcome, now: string, costMicros = 0): Promise<FilterOutcome> {
  const stays = out.status === "seen";
  await db
    .update(savedPosts)
    .set({
      status: out.status,
      filterVerdict: out.verdict ?? null,
      filterReason: out.reason ?? null,
      filterStage: out.stage ?? null,
      lastErrorCode: stays ? (out.errorCode ?? null) : null,
      lastError: null,
      costMicros: row.costMicros + costMicros,
      updatedAt: now,
    })
    .where(and(eq(savedPosts.id, row.id), eq(savedPosts.status, "seen")));
  return out;
}

/**
 * Decide a fresh (`seen`) post: the creator's history, then a small model on the caption and cover. The post is CLAIMED
 * first by one conditional UPDATE (status still `seen` and nobody else's live claim), so of two simultaneous submits
 * only one filters and pays; the other answers `seen`/`busy`. The write that ends the filter moves the post on, or
 * leaves it `seen` with an error code (`budget_paused`, `model_failed`). A `seen` post is never in `/known`'s fresh
 * list, so the extension finds it again through `workList` (saves-ledger.ts), which hands it back as `filter` work, and
 * resubmits it to `/posts`, which runs this again.
 * D1 statements: claim 1, creator history 1, reserve 2, settle 1, outcome 1.
 */
export async function filterPost(
  db: Db,
  env: Env,
  userId: string,
  post: FilterInput,
  now: string,
  fetchImpl: typeof fetch,
): Promise<FilterOutcome> {
  if (post.seeded && post.status !== "seen") {
    return { status: post.status as SavePostStatus, stage: "seed", ...(post.filterReason ? { reason: post.filterReason } : {}) };
  }
  const stale = new Date(new Date(now).getTime() - CLAIM_STALE_MS).toISOString();
  const claimed = await db
    .update(savedPosts)
    .set({ lastErrorCode: CLAIM, updatedAt: now })
    .where(
      and(
        eq(savedPosts.id, post.id),
        eq(savedPosts.userId, userId),
        eq(savedPosts.status, "seen"),
        or(isNull(savedPosts.lastErrorCode), ne(savedPosts.lastErrorCode, CLAIM), lt(savedPosts.updatedAt, stale)),
      ),
    )
    .returning({ id: savedPosts.id });
  if (claimed.length === 0) return { status: "seen", errorCode: "busy" };

  // The creator: three or more earlier decided posts, all one verdict, decide this one.
  // Only decisions that teach the creator count: the model's, the seed's and the owner's (a `process` override reads as
  // training). Never the creator stage's own, so a creator verdict cannot feed itself.
  const effective = sql<string | null>`CASE WHEN ${savedPosts.filterStage} = 'owner' THEN 'training' ELSE ${savedPosts.filterVerdict} END`;
  const history = await db
    .select({ verdict: effective, n: sql<number>`count(*)` })
    .from(savedPosts)
    .where(
      and(
        eq(savedPosts.userId, userId),
        eq(savedPosts.source, post.source),
        eq(savedPosts.creatorHandle, post.creatorHandle ?? ""),
        ne(savedPosts.id, post.id),
        sql`${savedPosts.filterStage} IN ('model', 'seed', 'owner')`,
        sql`(${savedPosts.filterStage} = 'owner' OR ${savedPosts.filterVerdict} IS NOT NULL)`,
      ),
    )
    .groupBy(effective);
  const only = history.length === 1 ? history[0]! : null;
  if (only && Number(only.n) >= CREATOR_MIN_POSTS && (only.verdict === "training" || only.verdict === "not")) {
    const verdict = only.verdict;
    return finish(
      db,
      post,
      {
        status: verdict === "training" ? "queued" : "filtered_out",
        verdict,
        stage: "creator",
        reason: `${Number(only.n)} earlier posts from this creator were all ${verdict === "training" ? "training" : "not training"}`,
      },
      now,
    );
  }

  const gateway = wakeGateway(env);
  if (gateway.kind === "canned") {
    return finish(db, post, { status: "queued", verdict: "maybe", stage: "model", reason: "fixture mode: not asked" }, now);
  }
  const failed = (code: SaveErrorCode): Promise<FilterOutcome> =>
    finish(
      db,
      post,
      hasTrainingWord(post)
        ? { status: "queued", verdict: "maybe", stage: "keyword", reason: "model unavailable; a training word in the caption" }
        : { status: "seen", errorCode: code },
      now,
    );
  if (gateway.kind === "no_key") return failed("model_failed");

  // The model. `post` is a stored row; the prompt takes the submit's shape.
  const model = env.SAVES_FILTER_MODEL || FILTER_MODEL_DEFAULT;
  const { system, userText } = filterMessages({
    source: post.source,
    key: post.sourceKey,
    url: post.url ?? "",
    creator: { handle: post.creatorHandle ?? "", ...(post.creatorName ? { name: post.creatorName } : {}) },
    caption: post.caption ?? "",
    hashtags: post.hashtags ?? [],
    mediaType: (post.mediaType as PostSubmit["mediaType"]) ?? "video",
  });
  const worst = Math.max(
    1,
    messagesCostMicros(model, {
      inputTokens: estimateInputTokens([system, userText], post.cover),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: FILTER_MAX_TOKENS,
    }),
  );
  // A typical filter reply is a short verdict (about 40 tokens), against the 120-token ceiling the worst case holds.
  const typical = Math.max(
    1,
    messagesCostMicros(model, {
      inputTokens: estimateInputTokens([system, userText], post.cover),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 40,
    }),
  );
  const reservation = await reserveImport(db, userId, IMPORT_KINDS.filter, model, worst, typical, new Date(now));
  if (!reservation.ok) return finish(db, post, { status: "seen", errorCode: reservation.reason }, now);

  let settled = false;
  try {
    const result = await askModel(gateway.env, fetchImpl, model, system, userText, post.cover);
    // A 402 records out-of-credits (the owner's banner); a call that worked clears it; any other failure says nothing.
    await noteGatewayOutcome(db, userId, result.ok ? { ok: true } : { ok: false, reason: result.reason });
    if (!result.ok) return await failed("model_failed");
    const cost = messagesCostMicros(model, {
      inputTokens: result.inputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: result.outputTokens,
    });
    await settleImport(db, reservation.usageId, {
      model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, costMicros: cost,
    });
    settled = true;
    const verdict = parseVerdict(result.content);
    return await finish(
      db,
      post,
      {
        status: verdict.verdict === "not" ? "filtered_out" : "queued",
        verdict: verdict.verdict,
        stage: "model",
        reason: verdict.reason,
      },
      now,
      cost,
    );
  } finally {
    // A throw (or a failed call) must not leave the reservation at its worst case: it settles to nothing spent.
    if (!settled) await settleImport(db, reservation.usageId, null);
  }
}

function parseVerdict(content: string): FilterVerdict {
  const raw = extractJson(content);
  const lenient =
    raw && typeof raw === "object" && typeof (raw as { reason?: unknown }).reason === "string"
      ? { ...(raw as object), reason: (raw as { reason: string }).reason.slice(0, 160) }
      : raw;
  const parsed = filterVerdictSchema.safeParse(lenient);
  return parsed.success ? parsed.data : { verdict: "maybe", reason: "unclear" };
}

/**
 * One OpenAI-compatible chat completion with an image part. `chatCompletion` (studio-llm.ts) takes string content only
 * and streams, so this is a small request of its own: not streamed (120 tokens). Like it, one resend on a retryable
 * status (a failed request is not billed, so one reservation covers both attempts). Failures carry a reason
 * (`gateway_<status>` / `llm_error`) and are logged.
 */
async function askModel(
  env: Env,
  fetchImpl: typeof fetch,
  model: string,
  system: string,
  userText: string,
  cover: PostSubmit["cover"],
): Promise<{ ok: true; content: string; inputTokens: number; outputTokens: number } | { ok: false; reason: string }> {
  const body = JSON.stringify({
    model,
    max_tokens: FILTER_MAX_TOKENS,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          ...(cover ? [{ type: "image_url", image_url: { url: `data:${cover.mime};base64,${cover.base64}` } }] : []),
        ],
      },
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
          JSON.stringify({ level: "warn", msg: "saves filter: ai gateway error", status: response.status, model, attempt, detail: detail.slice(0, 300) }),
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
        inputTokens: json?.usage?.prompt_tokens ?? estimateInputTokens([system, userText], cover),
        outputTokens: json?.usage?.completion_tokens ?? Math.ceil(content.length / 3),
      };
    } catch (e) {
      console.warn(
        JSON.stringify({ level: "warn", msg: "saves filter: ai gateway request failed", model, attempt, detail: String(e).slice(0, 200) }),
      );
      failure = { ok: false, reason: "llm_error" };
      if (controller.signal.aborted) return failure;
    } finally {
      clearTimeout(timer);
    }
  }
  return failure;
}

