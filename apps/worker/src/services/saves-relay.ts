import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { PROFILE_IDS } from "@rg/exercise-library";
import { schema } from "@rg/database";
import { extractionSchema } from "@rg/saves";
import type { Extraction, SaveErrorCode } from "@rg/saves";
import type { Env } from "../env.js";
import type { Db } from "./db.js";
import { messagesCostMicros } from "./llm-messages.js";
import { wakeGateway } from "./gateway-route.js";
import { IMPORT_KINDS, reserveImport, settleImport } from "./saves-budget.js";
import { noteGatewayOutcome } from "./ai-credits.js";
import { extractJson } from "./studio-llm.js";

const { savedPosts } = schema;

/** The models the extension may ask for (`x-saves-model`). R3's probe sets the real list. */
export const EXTRACT_MODELS: readonly string[] = ["google/gemini-3.6-flash"];
export const EXTRACT_MODEL_DEFAULT = "google/gemini-3.6-flash";
/** The most output tokens a request may ask for (`x-saves-max-tokens`). */
export const EXTRACT_MAX_TOKENS_CAP = 4000;
/** The largest request body the relay takes. R2 sets the real value; `SAVES_RELAY_MAX_BYTES` overrides. */
export const RELAY_MAX_BYTES = 20_000_000;
/** A post another relay claimed this long ago is a request that died; it may be claimed again. */
export const RELAY_CLAIM_STALE_MS = 10 * 60_000;
const CALL_TIMEOUT_MS = 120_000;
const ISSUES_MAX = 12;

/**
 * What a typical reel costs, for the reservation's estimate (what a crash-orphaned reservation counts at once stale):
 * about 3k tokens of prompt and a ~1.6 Mbps video (200 KB a second, base64 inflating it by a third) read at ~300 tokens
 * a second, and a ~1.5k-token reply. The WORST case instead takes every base64 character as a quarter token.
 */
const TEXT_PROMPT_TOKENS = 3_000;
const VIDEO_BYTES_PER_SECOND = 200_000;
const VIDEO_TOKENS_PER_SECOND = 300;
const TYPICAL_OUTPUT_TOKENS = 1_500;

/** What fixture mode stores: one synthetic move, valid for `extractionSchema`. No model is asked. */
export const CANNED_EXTRACTION: Extraction = {
  kind: "single_move",
  summary: "A synthetic post showing one mobility move.",
  themes: ["mobility"],
  moves: [
    {
      name: "Synthetic hip switch",
      aliases: [],
      summary: "Rotate both knees side to side from a seated position.",
      steps: ["Sit with both knees bent.", "Drop both knees to one side, then the other."],
      cues: ["Stay tall."],
      mistakes: [],
      purpose: "hip mobility",
      dose: { text: "10 each side", type: "reps", range: [8, 12] },
      patterns: ["mobility"],
      regions: ["hips"],
      equipment: ["mat"],
      position: "seated",
      laterality: "alternating",
      load: "bodyweight",
      contraction: ["isotonic"],
      difficulty: 2,
      conditions: Object.fromEntries(PROFILE_IDS.map((p) => [p, { attrs: { load: 2, safe: true }, note: "synthetic" }])) as never,
      evidence: { name: "stated", dose: "inferred", steps: "stated" },
      confidence: "high",
    },
  ],
};

export type RelayResult =
  | { ok: true; extraction: Extraction }
  /** `status` is set when the request itself was wrong (404 no such post, 409 not in a state to extract). */
  | { ok: false; code: SaveErrorCode; issues?: string[]; status?: 404 | 409 };

/** A response model is accepted when the allowlist names it (the gateway may drop the provider prefix). */
const modelAllowed = (m: string): boolean => EXTRACT_MODELS.some((x) => x === m || x.endsWith(`/${m}`));

const relayMaxBytes = (env: Env): number => {
  const n = Number(env.SAVES_RELAY_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? n : RELAY_MAX_BYTES;
};

/** What the headers and length ask for, or why the request is refused before anything is reserved or called. */
export function readRelayRequest(
  req: Request,
  env: Env,
): { ok: true; model: string; maxTokens: number; length: number } | { ok: false; status: 400 | 411 | 413; error: string } {
  const model = req.headers.get("x-saves-model") ?? EXTRACT_MODEL_DEFAULT;
  if (!EXTRACT_MODELS.includes(model)) return { ok: false, status: 400, error: "model_not_allowed" };
  const rawTokens = req.headers.get("x-saves-max-tokens");
  const maxTokens = rawTokens === null ? EXTRACT_MAX_TOKENS_CAP : Number(rawTokens);
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > EXTRACT_MAX_TOKENS_CAP) {
    return { ok: false, status: 400, error: "bad_max_tokens" };
  }
  if (!req.body) return { ok: false, status: 400, error: "body_missing" };
  // The body is never read here, so its length must be declared.
  const length = Number(req.headers.get("content-length"));
  if (!Number.isInteger(length) || length <= 0) return { ok: false, status: 411, error: "length_required" };
  if (length > relayMaxBytes(env)) return { ok: false, status: 413, error: "too_large" };
  return { ok: true, model, maxTokens, length };
}

/**
 * Relay one extraction request. The body is the gateway JSON the extension built: it is NEVER read, parsed or buffered
 * here — the request's stream goes straight into `fetch` (`duplex: "half"`), so a 20 MB video costs the Worker no
 * memory and almost no CPU. One consequence: the stream can be consumed once, so this does NOT retry; the extension
 * retries (with `retryIssues` for a schema failure).
 *
 * Order: reserve the worst case, claim the post (`extracting`), call, settle (in a `finally`: a throw settles to
 * nothing spent), then one write that counts the attempt and stores the outcome. D1 statements, happy path: reserve 2,
 * claim 1, out-of-credits note 2, settle 1, outcome 1 = 7 (matchPost, Task 8, adds its own).
 */
export async function relayExtract(
  db: Db,
  env: Env,
  userId: string,
  post: { id: string },
  req: Request,
  now: Date,
  fetchImpl: typeof fetch,
): Promise<RelayResult> {
  const asked = readRelayRequest(req, env);
  if (!asked.ok) return { ok: false, code: asked.status === 413 ? "too_large" : "unknown", issues: [asked.error] };
  const { model, maxTokens, length } = asked;
  const nowIso = now.toISOString();

  const gateway = wakeGateway(env);
  if (gateway.kind === "no_key") return { ok: false, code: "model_failed" };

  const claim = async (): Promise<boolean> => {
    const stale = new Date(now.getTime() - RELAY_CLAIM_STALE_MS).toISOString();
    const claimed = await db
      .update(savedPosts)
      .set({ status: "extracting", updatedAt: nowIso })
      .where(
        and(
          eq(savedPosts.id, post.id),
          eq(savedPosts.userId, userId),
          or(
            inArray(savedPosts.status, ["queued", "failed"]),
            and(eq(savedPosts.status, "extracting"), lt(savedPosts.updatedAt, stale)),
          ),
        ),
      )
      .returning({ id: savedPosts.id });
    return claimed.length > 0;
  };
  const refusal = async (): Promise<RelayResult> => {
    const [row] = await db
      .select({ id: savedPosts.id })
      .from(savedPosts)
      .where(and(eq(savedPosts.id, post.id), eq(savedPosts.userId, userId)));
    return { ok: false, code: "unknown", status: row ? 409 : 404 };
  };
  /** The one write that ends a relay: counts the attempt and stores the outcome. */
  const finish = (
    out: { extraction: Extraction } | { code: SaveErrorCode },
    costMicros: number,
  ): Promise<unknown> =>
    db
      .update(savedPosts)
      .set({
        status: "extraction" in out ? "extracted" : "failed",
        ...("extraction" in out ? { extraction: out.extraction, lastErrorCode: null } : { lastErrorCode: out.code }),
        lastError: null,
        extractAttempts: sql`${savedPosts.extractAttempts} + 1`,
        costMicros: sql`${savedPosts.costMicros} + ${costMicros}`,
        updatedAt: nowIso,
      })
      .where(and(eq(savedPosts.id, post.id), eq(savedPosts.userId, userId), eq(savedPosts.status, "extracting")));

  if (gateway.kind === "canned") {
    if (!(await claim())) return refusal();
    await finish({ extraction: CANNED_EXTRACTION }, 0);
    // SEAM (Task 8): `matchPost(db, env, userId, post, CANNED_EXTRACTION, ...)` is called here and below, after the extraction is stored.
    return { ok: true, extraction: CANNED_EXTRACTION };
  }

  // The worst case takes every body character as a quarter token; a typical reel is far smaller (see the constants).
  const worst = Math.max(
    1,
    messagesCostMicros(model, { inputTokens: Math.ceil(length / 4), cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: maxTokens }),
  );
  const videoSeconds = ((length * 3) / 4 / VIDEO_BYTES_PER_SECOND);
  const typical = Math.max(
    1,
    messagesCostMicros(model, {
      inputTokens: TEXT_PROMPT_TOKENS + Math.ceil(videoSeconds * VIDEO_TOKENS_PER_SECOND),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: Math.min(maxTokens, TYPICAL_OUTPUT_TOKENS),
    }),
  );
  const reservation = await reserveImport(db, userId, IMPORT_KINDS.extract, model, worst, typical, now);
  if (!reservation.ok) return { ok: false, code: reservation.reason };

  let settled = false;
  try {
    if (!(await claim())) return await refusal();
    const call = await callGateway(gateway.env, fetchImpl, req, model, length);
    // A 402 records out-of-credits (the owner's banner); a call that worked clears it; any other failure says nothing.
    await noteGatewayOutcome(db, userId, call.ok ? { ok: true } : { ok: false, reason: call.reason });
    if (!call.ok) {
      await settleImport(db, reservation.usageId, null);
      settled = true;
      const code: SaveErrorCode = call.reason === "gateway_413" ? "too_large" : "model_failed";
      await finish({ code }, 0);
      return { ok: false, code };
    }
    // A reply from an unlisted model is priced as that model (the table's ceiling when unknown), never as the one asked for.
    const cost = messagesCostMicros(call.model && !modelAllowed(call.model) ? call.model : model, {
      inputTokens: call.inputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: call.outputTokens,
    });
    await settleImport(db, reservation.usageId, {
      model: call.model ?? model, inputTokens: call.inputTokens, outputTokens: call.outputTokens, costMicros: cost,
    });
    settled = true;
    if (call.model && !modelAllowed(call.model)) {
      console.warn(JSON.stringify({ level: "warn", msg: "saves relay: reply from a model outside the allowlist", requested: model, got: call.model }));
      await finish({ code: "model_failed" }, cost);
      return { ok: false, code: "model_failed", issues: ["the reply came from a model that is not allowed"] };
    }
    const parsed = parseExtraction(call.content);
    if (!parsed.ok) {
      await finish({ code: "model_failed" }, cost);
      return { ok: false, code: "model_failed", issues: parsed.issues };
    }
    await finish({ extraction: parsed.extraction }, cost);
    // SEAM (Task 8): `matchPost(db, env, userId, post, parsed.extraction, ...)` is called here, after the extraction is stored.
    return { ok: true, extraction: parsed.extraction };
  } catch (e) {
    console.warn(JSON.stringify({ level: "warn", msg: "saves relay: failed", detail: String(e).slice(0, 200) }));
    if (!settled) await settleImport(db, reservation.usageId, null).catch(() => undefined);
    settled = true;
    await finish({ code: "model_failed" }, 0).catch(() => undefined);
    return { ok: false, code: "model_failed" };
  } finally {
    // A throw must not leave the reservation at its worst case: it settles to nothing spent.
    if (!settled) await settleImport(db, reservation.usageId, null);
  }
}

function parseExtraction(content: string): { ok: true; extraction: Extraction } | { ok: false; issues: string[] } {
  const raw = extractJson(content);
  if (raw === null || typeof raw !== "object") return { ok: false, issues: ["the reply was not valid JSON"] };
  const parsed = extractionSchema.safeParse(raw);
  if (parsed.success) return { ok: true, extraction: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.slice(0, ISSUES_MAX).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`.slice(0, 200)),
  };
}

/**
 * One chat completion whose body is the request's own stream. Not retried: the stream is spent by the first attempt.
 * Failures carry a reason (`gateway_<status>` / `llm_error`) and are logged, as the filter's are.
 */
async function callGateway(
  env: Env,
  fetchImpl: typeof fetch,
  req: Request,
  model: string,
  length: number,
): Promise<
  | { ok: true; content: string; model: string | null; inputTokens: number; outputTokens: number }
  | { ok: false; reason: string }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${env.AI_GATEWAY_BASE_URL || "https://ai-gateway.vercel.sh/v1"}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${env.AI_GATEWAY_API_KEY}`,
        "Content-Type": "application/json",
        "Content-Length": String(length),
      },
      body: req.body,
      duplex: "half",
    } as RequestInit);
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.warn(JSON.stringify({ level: "warn", msg: "saves relay: ai gateway error", status: response.status, model, detail: detail.slice(0, 300) }));
      return { ok: false, reason: `gateway_${response.status}` };
    }
    // The reply is small JSON: parsed whole.
    const json = (await response.json().catch(() => null)) as {
      model?: unknown;
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    } | null;
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return { ok: false, reason: "gateway_bad_response" };
    return {
      ok: true,
      content,
      model: typeof json?.model === "string" ? json.model : null,
      inputTokens: json?.usage?.prompt_tokens ?? Math.ceil(length / 4),
      outputTokens: json?.usage?.completion_tokens ?? Math.ceil(content.length / 3),
    };
  } catch (e) {
    console.warn(JSON.stringify({ level: "warn", msg: "saves relay: ai gateway request failed", model, detail: String(e).slice(0, 200) }));
    return { ok: false, reason: "llm_error" };
  } finally {
    clearTimeout(timer);
  }
}
