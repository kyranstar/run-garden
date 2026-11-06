import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { ZodIssue } from "zod";
import { EXERCISES, PROFILES } from "@rg/exercise-library";
import { schema } from "@rg/database";
import {
  buildExtractBody, dropUnknownEnums, EXTRACT_PROMPT_VERSION, extractionSchema, extractSystemText, extractUserText, promptSha,
  transcriptSegments, verifyQuotes,
} from "@rg/saves";
import type { Extraction, PostSubmit, PostWords, SaveErrorCode } from "@rg/saves";
import type { Env } from "../env.js";
import { runAtomically, type Db } from "./db.js";
import { promptVersionStatement, trailStatements, type TrailEventInput } from "./import-trail.js";
import { messagesCostMicros } from "./llm-messages.js";
import { wakeGateway } from "./gateway-route.js";
import { IMPORT_KINDS, reserveImport, settleImport } from "./saves-budget.js";
import { noteGatewayOutcome } from "./ai-credits.js";
import { extractJson } from "./studio-llm.js";
import { MAX_EXTRACT_ATTEMPTS, RELAY_CLAIM_STALE_MS, RETRYABLE_ERROR_CODES, siteSource } from "./saves-ledger.js";
import { matchPost } from "./saves-match.js";

const { savedPosts, importBlobs } = schema;

/** The models the extension may ask for (`x-saves-model`). R3's probe sets the real list. */
export const EXTRACT_MODELS: readonly string[] = ["google/gemini-3.6-flash"];
export const EXTRACT_MODEL_DEFAULT = "google/gemini-3.6-flash";
/** The most output tokens a request may ask for (`x-saves-max-tokens`). */
/**
 * The most output tokens an extraction may ask for. 4,000 cut off 18 of the first 43 live replies (2026-10-26: a routine's
 * moves, each with twelve condition notes, run long) — every one then failed as "not valid JSON" and paid twice. 32,000
 * since extract-6 (design 2026-11-05 §5.4): a 30-move follow-along with its quotes and reasons, with headroom.
 */
export const EXTRACT_MAX_TOKENS_CAP = 32_000;
/** The largest request body the relay takes. R2 sets the real value; `SAVES_RELAY_MAX_BYTES` overrides. */
export const RELAY_MAX_BYTES = 20_000_000;
/** The model's context window in tokens: a body cannot cost more input than this, whatever its length. */
export const EXTRACT_CONTEXT_TOKENS = 1_048_576;
const CALL_TIMEOUT_MS = 120_000;
const ISSUES_MAX = 12;
/** The most of a failure's reasons `last_error` keeps. */
const LAST_ERROR_CHARS = 600;

/**
 * What a typical reel costs, for the reservation's estimate (what a crash-orphaned reservation counts at once stale):
 * about 3k tokens of prompt and a ~1.6 Mbps video (200 KB a second, base64 inflating it by a third) read at ~300 tokens
 * a second, and a ~1.5k-token reply. The WORST case instead takes every base64 character as a quarter token, up to the model's context window.
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
      // Every profile rated on its own scale (each at its floor, each flag off), so the move's record validates when matched.
      conditions: Object.fromEntries(
        Object.values(PROFILES).map((p) => [
          p.id,
          {
            attrs: Object.fromEntries(Object.entries(p.attributes).map(([k, s]) => [k, s.kind === "scale" ? s.min : false])),
            note: "synthetic",
          },
        ]),
      ) as never,
      evidence: { name: "stated", dose: "inferred", steps: "stated" },
      confidence: "high",
    },
  ],
};

export type RelayResult =
  | { ok: true; extraction: Extraction }
  /** `status` is set when the request itself was wrong (404 no such post, 409 not in a state to extract). */
  | { ok: false; code: SaveErrorCode; issues?: string[]; status?: 404 | 409 };

/** The library's names, as the extension sends them with each reading (rebuilding the prompt as sent). */
const LIBRARY_NAMES = EXERCISES.map((e) => e.name);
/** The most retry issues a request may name, and the most of each kept (the relay's own issue lines are shorter). */
const RETRY_ISSUES_MAX = 12;
const RETRY_ISSUE_CHARS = 300;

/** What the extension says about the prompt it sent: its version, its text's hash, and the issues it retried with. */
export function readPromptHeaders(req: Request): { version: string | null; sha: string | null; retryIssues: string[] | undefined } {
  const version = req.headers.get("x-saves-prompt-version");
  const sha = req.headers.get("x-saves-prompt-sha");
  let retryIssues: string[] | undefined;
  const raw = req.headers.get("x-saves-retry-issues");
  if (raw) {
    try {
      const list: unknown = JSON.parse(decodeURIComponent(raw));
      if (Array.isArray(list)) {
        const kept = list.filter((x): x is string => typeof x === "string").slice(0, RETRY_ISSUES_MAX).map((x) => x.slice(0, RETRY_ISSUE_CHARS));
        if (kept.length) retryIssues = kept;
      }
    } catch {
      retryIssues = undefined;
    }
  }
  return {
    version: version && /^[a-z0-9._-]{1,40}$/i.test(version) ? version : null,
    sha: sha && /^[0-9a-f]{64}$/.test(sha) ? sha : null,
    retryIssues,
  };
}

/** What the extension fetched for this call (`x-saves-read-facts`, URI-encoded JSON ≤ 1 KB): kept on the attempt's event. */
export function readFactsHeader(req: Request): Record<string, unknown> | null {
  const raw = req.headers.get("x-saves-read-facts");
  if (!raw || raw.length > 1_024) return null;
  try {
    const v: unknown = JSON.parse(decodeURIComponent(raw));
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
    return { variantWidth: n(o.variantWidth), bytes: n(o.bytes), byLink: o.byLink === true, images: n(o.images) };
  } catch {
    return null;
  }
}

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
):
  | { ok: true; model: string; maxTokens: number; length: number }
  | { ok: false; status: 400 | 411; error: string }
  | { ok: false; status: 413; error: string; maxBytes: number } {
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
  const maxBytes = relayMaxBytes(env);
  if (length > maxBytes) return { ok: false, status: 413, error: "too_large", maxBytes };
  return { ok: true, model, maxTokens, length };
}

/** How a reading's body reaches the gateway: the extension's own, streamed unread; or built here from the stored words. */
type Send = { kind: "stream"; req: Request; length: number } | { kind: "video" };
interface ExtractPlan {
  model: string;
  maxTokens: number;
  prompt: { version: string | null; sha: string | null; retryIssues: string[] | undefined };
  readFacts: Record<string, unknown> | null;
  send: Send;
}

/**
 * Relay one extraction request. The body is the gateway JSON the extension built: it is NEVER read, parsed or buffered
 * here — the request's stream goes straight into `fetch` (`duplex: "half"`), so a 20 MB video costs the Worker no
 * memory and almost no CPU. One consequence: the stream can be consumed once, so this does NOT retry; the extension
 * retries (with `retryIssues` for a schema failure).
 *
 * Order: reserve the worst case, claim the post (`extracting`), call, settle (in a `finally`: a throw settles to
 * nothing spent), then one write that counts the attempt and stores the outcome, then `matchPost`. D1 statements, happy
 * path: reserve 2, claim 1, out-of-credits note 2, settle 1, outcome 1 = 7, plus matchPost's (≤ 12 for a 12-move post
 * with a judge call): ≤ 19, and the route's bearer guard 2.
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
  return runExtraction(db, env, userId, post, {
    model: asked.model, maxTokens: asked.maxTokens, prompt: readPromptHeaders(req), readFacts: readFactsHeader(req),
    send: { kind: "stream", req, length: asked.length },
  }, now, fetchImpl);
}

/** A video is watched (attached by its link) when it is this long or shorter, or when the owner asked (§5.4). */
export const WATCH_MAX_SEC = 20 * 60;
/**
 * The longest video Watch it too may ask for: at the worst rate (300 tokens a second) and with its text, a longer one
 * would pass the model's context window and fail every attempt (final review F1).
 */
export const WATCH_ASK_MAX_SEC = 50 * 60;
/** What a watched second costs in prompt tokens: typically (the video-seen check's yardstick) and at worst (the reservation's). */
export const VIDEO_TOKENS_PER_SEC = 100;
export const VIDEO_TOKENS_PER_SEC_WORST = 300;

/** The gateway call's time limit: 120 s, plus 2 s a minute watched, at most 10 minutes (design 2026-11-05 §5.4). */
export function callTimeoutMs(watchedSec: number | null): number {
  return Math.min(600_000, CALL_TIMEOUT_MS + 2_000 * Math.ceil((watchedSec ?? 0) / 60));
}

/** The reading's model and output cap, from the headers alone: a video's body is the Worker's own. */
export function readVideoRequest(req: Request): { ok: true; model: string; maxTokens: number } | { ok: false; status: 400; error: string } {
  const model = req.headers.get("x-saves-model") ?? EXTRACT_MODEL_DEFAULT;
  if (!EXTRACT_MODELS.includes(model)) return { ok: false, status: 400, error: "model_not_allowed" };
  const rawTokens = req.headers.get("x-saves-max-tokens");
  const maxTokens = rawTokens === null ? EXTRACT_MAX_TOKENS_CAP : Number(rawTokens);
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > EXTRACT_MAX_TOKENS_CAP) return { ok: false, status: 400, error: "bad_max_tokens" };
  return { ok: true, model, maxTokens };
}

/**
 * A video's reading (`POST /api/saves/posts/:key/extract-video`; design 2026-11-05 §5.4). There are no media bytes to
 * relay, so the Worker builds the body itself from the stored words (`extractUserText`, the same builder; "as sent" by
 * construction) and attaches the video by its link when it is WATCH_MAX_SEC or shorter, or the owner asked (Watch it
 * too). The reservation and the timeout come from the length. The rest is the relay's: claim, call, settle, finish,
 * match. D1 statements: the relay's, plus the post read before reserving 1 and its transcript 1.
 */
export async function relayVideoExtract(
  db: Db,
  env: Env,
  userId: string,
  post: { id: string },
  req: Request,
  now: Date,
  fetchImpl: typeof fetch,
): Promise<RelayResult> {
  const asked = readVideoRequest(req);
  if (!asked.ok) return { ok: false, code: "unknown", issues: [asked.error] };
  const prompt = readPromptHeaders(req);
  return runExtraction(db, env, userId, post, {
    model: asked.model, maxTokens: asked.maxTokens, prompt: { version: EXTRACT_PROMPT_VERSION, sha: null, retryIssues: prompt.retryIssues },
    readFacts: null, send: { kind: "video" },
  }, now, fetchImpl);
}

/** A claimed post's words and facts, as the reading is built from them and checked against them. */
interface ClaimedPost {
  attempt: number;
  userText: string;
  sha: string;
  words: PostWords;
  url: string | null;
  /**
   * The link the gateway is sent to watch: rebuilt from the video's id, never the stored URL (final audit G16: a
   * submit's URL is any https link, and the gateway would fetch it). Null for anything but a YouTube video id.
   */
  videoUrl: string | null;
}

/** What a watched video must add to the bill, beyond the text's own tokens, to count as seen: half the typical rate. */
function videoSeenOf(inputTokens: number, textChars: number, durationSec: number): boolean {
  return inputTokens - Math.ceil(textChars / 4) >= 0.5 * VIDEO_TOKENS_PER_SEC * durationSec;
}

async function runExtraction(
  db: Db,
  env: Env,
  userId: string,
  post: { id: string },
  plan: ExtractPlan,
  now: Date,
  fetchImpl: typeof fetch,
): Promise<RelayResult> {
  const { model, maxTokens, prompt, readFacts, send } = plan;
  const nowIso = now.toISOString();
  /** The claimed attempt and the post's words: the prompt as sent is rebuilt from them (design 2026-11-05 §6.1). */
  let claimed: ClaimedPost | null = null;
  /** A video's plan: its length, whether it is watched, whether it has a transcript (read before reserving). */
  let video: { durationSec: number | null; watched: boolean; hasTranscript: boolean; textBytes: number } | null = null;

  const gateway = wakeGateway(env);
  if (gateway.kind === "no_key") return { ok: false, code: "model_failed" };

  const claim = async (): Promise<boolean> => {
    const stale = new Date(now.getTime() - RELAY_CLAIM_STALE_MS).toISOString();
    const rows = await db
      .update(savedPosts)
      // The attempt is counted here, so a post that crashes every time (before any outcome is written) still runs out.
      .set({ status: "extracting", updatedAt: nowIso, extractAttempts: sql`${savedPosts.extractAttempts} + 1` })
      .where(
        and(
          eq(savedPosts.id, post.id),
          eq(savedPosts.userId, userId),
          lt(savedPosts.extractAttempts, MAX_EXTRACT_ATTEMPTS),
          or(
            eq(savedPosts.status, "queued"),
            // `too_large` too: the extension retries a too-large post at a smaller size straight away (`/work` never
            // hands it out again, so only that retry reaches it); the attempt limit above still holds.
            and(eq(savedPosts.status, "failed"), inArray(savedPosts.lastErrorCode, [...RETRYABLE_ERROR_CODES, "too_large"])),
            and(eq(savedPosts.status, "extracting"), lt(savedPosts.updatedAt, stale)),
          ),
        ),
      )
      .returning({
        attempt: savedPosts.extractAttempts,
        caption: savedPosts.caption,
        hashtags: savedPosts.hashtags,
        creatorHandle: savedPosts.creatorHandle,
        creatorName: savedPosts.creatorName,
        mediaType: savedPosts.mediaType,
        source: savedPosts.source,
        sourceKey: savedPosts.sourceKey,
        url: savedPosts.url,
        title: savedPosts.title,
        durationSec: savedPosts.durationSec,
        videoInfo: savedPosts.videoInfo,
      });
    const row = rows[0];
    if (!row) return false;
    const words: PostWords = {
      caption: row.caption ?? "",
      hashtags: row.hashtags ?? [],
      creator: { handle: row.creatorHandle ?? "", ...(row.creatorName ? { name: row.creatorName } : {}) },
      mediaType: (row.mediaType as PostSubmit["mediaType"]) ?? "video",
    };
    if (send.kind === "video") {
      // The video's words: its title, length and chapters from the post, its transcript from its blob (§5.3).
      const [blob] = video?.hasTranscript
        ? await db
            .select({ text: importBlobs.text })
            .from(importBlobs)
            .where(and(eq(importBlobs.userId, userId), eq(importBlobs.postId, post.id), eq(importBlobs.kind, "transcript")))
            .orderBy(desc(importBlobs.at))
            .limit(1)
        : [];
      const info = row.videoInfo;
      Object.assign(words, {
        source: row.source, title: row.title, durationSec: row.durationSec, chapters: info?.chapters ?? [],
        transcript: blob && info?.captions ? { lang: info.captions.lang, kind: info.captions.kind, text: blob.text, cut: info.transcriptCut } : null,
      });
    }
    const userText = extractUserText({ post: words, libraryNames: LIBRARY_NAMES, retryIssues: prompt.retryIssues });
    const videoUrl = row.source === "youtube" && /^[A-Za-z0-9_-]{11}$/.test(row.sourceKey) ? `https://www.youtube.com/watch?v=${row.sourceKey}` : null;
    claimed = { attempt: row.attempt, userText, sha: await promptSha(userText), words, url: row.url, videoUrl };
    return true;
  };
  const refusal = async (): Promise<RelayResult> => {
    const [row] = await db
      .select({ id: savedPosts.id })
      .from(savedPosts)
      .where(and(eq(savedPosts.id, post.id), eq(savedPosts.userId, userId)));
    return { ok: false, code: "unknown", status: row ? 409 : 404 };
  };
  /**
   * The one write that ends a relay: stores the outcome (the attempt was counted by the claim). A failure keeps why, as
   * `last_error` (the schema's issues, the gateway's reason): the lead reads it to tune the prompt (first live run, 2026-10-25).
   */
  const finish = (
    out: { extraction: Extraction } | { code: SaveErrorCode; why?: string[] },
    costMicros: number,
    call?: RelayCall,
  ): Promise<unknown> => {
    const update = db
      .update(savedPosts)
      .set({
        status: "extraction" in out ? "extracted" : "failed",
        ...("extraction" in out ? { extraction: out.extraction, lastErrorCode: null } : { lastErrorCode: out.code }),
        lastError: "extraction" in out || !out.why?.length ? null : out.why.join(" | ").slice(0, LAST_ERROR_CHARS),
        costMicros: sql`${savedPosts.costMicros} + ${costMicros}`,
        ...(call?.videoSeen !== undefined && call.videoSeen !== null ? { videoSeen: call.videoSeen } : {}),
        updatedAt: nowIso,
      })
      .where(and(eq(savedPosts.id, post.id), eq(savedPosts.userId, userId), eq(savedPosts.status, "extracting")));
    // The attempt's trail with its outcome (design 2026-11-05 §4): the call's facts, the raw reply, the prompt as sent.
    const sent = send.kind === "video" && claimed ? { ...prompt, sha: claimed.sha } : prompt;
    const event = extractEvent(out, costMicros, call, claimed, sent, model, send.kind === "stream" ? send.length : (call?.bytes ?? 0));
    if (readFacts) event.detail = { ...(event.detail as object), readFacts };
    return runAtomically(db, [
      update,
      ...trailStatements(db, userId, post.id, [event], nowIso),
      ...(call && sent.version === EXTRACT_PROMPT_VERSION ? [promptVersionStatement(db, EXTRACT_PROMPT_VERSION, "extract", extractSystemText(), nowIso)] : []),
    ]);
  };

  /**
   * After the extraction is stored, its moves are matched (saves-match.ts): the post becomes `matched`, or `failed`
   * (`model_failed`, with the issues the extension retries with) when a new move's record does not validate. A throw
   * while matching leaves the post `failed`/`unknown`, which `/work` hands out again, never `extracted` with nothing to
   * move it on.
   */
  const matched = async (extraction: Extraction): Promise<RelayResult> => {
    try {
      // The quotes are checked only now, after the paid reading is stored: a request cut off here leaves it `extracted`,
      // which nothing hands out to be read (and paid for) again; `matchStale` finishes it (final audit G1b).
      const checked = checkQuotes(extraction, (claimed as ClaimedPost | null)?.words);
      const out = await matchPost(db, env, userId, post.id, nowIso, fetchImpl, { checked });
      if (out.issues) return { ok: false, code: "model_failed", issues: out.issues };
      return { ok: true, extraction: checked };
    } catch (e) {
      console.warn(JSON.stringify({ level: "warn", msg: "saves relay: matching failed", detail: String(e).slice(0, 200) }));
      await runAtomically(db, trailStatements(db, userId, post.id, [
        { stage: "match", source: "worker", status: "warn", summary: MATCH_AGAIN, detail: { code: "unknown" } },
      ], nowIso)).catch(() => undefined);
      return { ok: false, code: "unknown" };
    }
  };

  if (send.kind === "video") {
    // The length, the owner's ask and whether there are words to read decide the reading before anything is spent.
    const [p] = await db
      .select({ durationSec: savedPosts.durationSec, watchVideo: savedPosts.watchVideo, videoInfo: savedPosts.videoInfo, caption: savedPosts.caption })
      .from(savedPosts)
      .where(and(eq(savedPosts.id, post.id), eq(savedPosts.userId, userId)))
      .limit(1);
    if (!p) return { ok: false, code: "unknown", status: 404 };
    const durationSec = p.durationSec ?? null;
    const transcriptChars = p.videoInfo?.captions ? (p.videoInfo.transcriptChars ?? 0) : 0;
    // Bytes, not characters (final audit G5): a CJK character is about a token, three UTF-8 bytes. An older row has
    // no byte count: three bytes a character bounds it.
    const transcriptBytes = p.videoInfo?.captions ? (p.videoInfo.transcriptBytes ?? transcriptChars * 3) : 0;
    video = {
      durationSec,
      // An unknown length is never watched (nothing would be reserved for it); an ask only up to WATCH_ASK_MAX_SEC.
      watched: durationSec !== null && durationSec > 0 && (durationSec <= WATCH_MAX_SEC || (p.watchVideo === true && durationSec <= WATCH_ASK_MAX_SEC)),
      hasTranscript: transcriptChars > 0,
      textBytes: SYSTEM_CHARS + LIBRARY_CHARS + new TextEncoder().encode(p.caption ?? "").length + transcriptBytes + TEXT_SLACK_CHARS,
    };
  }

  if (gateway.kind === "canned") {
    if (!(await claim())) return refusal();
    await finish({ extraction: CANNED_EXTRACTION }, 0);
    return matched(CANNED_EXTRACTION);
  }

  if (video && !video.watched && !video.hasTranscript) {
    // Nothing to read from words and too long to watch unasked: no call (and no spend) until Watch it too.
    if (!(await claim())) return refusal();
    await finish({ code: "no_captions", why: [NO_CAPTIONS_LONG] }, 0);
    return { ok: false, code: "no_captions" };
  }

  let worst: number;
  let typical: number;
  if (video) {
    // A URL body's cost is its length's (≈100 tokens a second watched, 300 at worst) and its text's, not its bytes'.
    const watchedSec = video.watched ? (video.durationSec ?? WATCH_MAX_SEC) : 0;
    worst = Math.max(1, messagesCostMicros(model, {
      // Never past the model's context window: a body can't cost more input than that (final review F1).
      inputTokens: Math.min(EXTRACT_CONTEXT_TOKENS, Math.ceil(video.textBytes / 3) + VIDEO_TOKENS_PER_SEC_WORST * watchedSec),
      cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: maxTokens,
    }));
    typical = Math.max(1, messagesCostMicros(model, {
      inputTokens: Math.ceil(video.textBytes / 4) + VIDEO_TOKENS_PER_SEC * watchedSec, cacheReadTokens: 0, cacheWriteTokens: 0,
      outputTokens: Math.min(maxTokens, TYPICAL_OUTPUT_TOKENS),
    }));
  } else {
    const { length } = send as Extract<Send, { kind: "stream" }>;
    // The worst case takes every body character as a quarter token; a typical reel is far smaller (see the constants).
    worst = Math.max(
      1,
      messagesCostMicros(model, { inputTokens: Math.min(Math.ceil(length / 4), EXTRACT_CONTEXT_TOKENS), cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: maxTokens }),
    );
    const videoSeconds = ((length * 3) / 4 / VIDEO_BYTES_PER_SECOND);
    typical = Math.max(
      1,
      messagesCostMicros(model, {
        inputTokens: TEXT_PROMPT_TOKENS + Math.ceil(videoSeconds * VIDEO_TOKENS_PER_SECOND),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: Math.min(maxTokens, TYPICAL_OUTPUT_TOKENS),
      }),
    );
  }
  const reservation = await reserveImport(db, userId, IMPORT_KINDS.extract, model, worst, typical, now);
  if (!reservation.ok) {
    // The post waits `queued` with the reason, and its `updatedAt` moves it behind other work in `/work`.
    await runAtomically(db, [
      db
        .update(savedPosts)
        .set({ lastErrorCode: reservation.reason, updatedAt: nowIso })
        .where(and(eq(savedPosts.id, post.id), eq(savedPosts.userId, userId), eq(savedPosts.status, "queued"))),
      ...trailStatements(db, userId, post.id, [
        { stage: "extract", source: "worker", status: "warn", summary: "Waiting for the import budget", detail: { code: reservation.reason } },
      ], nowIso),
    ]);
    return { ok: false, code: reservation.reason };
  }

  let settled = false;
  try {
    if (!(await claim())) return await refusal();
    const c = claimed as ClaimedPost | null;
    let body: { stream: ReadableStream | null; length: number } | { text: string };
    let timeoutMs = CALL_TIMEOUT_MS;
    if (send.kind === "video" && c && video) {
      const text = buildExtractBody({
        model, post: c.words, images: [], libraryNames: LIBRARY_NAMES, retryIssues: prompt.retryIssues, maxTokens, userText: c.userText,
        ...(video.watched && c.videoUrl ? { videoUrl: c.videoUrl, videoName: "video.mp4" } : {}),
      });
      body = { text };
      timeoutMs = callTimeoutMs(video.watched ? video.durationSec : null);
    } else {
      const stream = send as Extract<Send, { kind: "stream" }>;
      body = { stream: stream.req.body, length: stream.length };
    }
    const started = Date.now();
    let call = await callGateway(gateway.env, fetchImpl, body, model, timeoutMs);
    /** The gateway refused the video part (final audit G6): read once more from the words alone, marked unseen. */
    let refused = false;
    if (!call.ok && send.kind === "video" && video?.watched && c && /^gateway_4(00|04|15|22)$/.test(call.reason)) {
      refused = true;
      if (video.hasTranscript) {
        body = { text: buildExtractBody({ model, post: c.words, images: [], libraryNames: LIBRARY_NAMES, retryIssues: prompt.retryIssues, maxTokens, userText: c.userText }) };
        call = await callGateway(gateway.env, fetchImpl, body, model, CALL_TIMEOUT_MS);
      }
    }
    const latencyMs = Date.now() - started;
    const bytes = "text" in body ? new TextEncoder().encode(body.text).length : undefined;
    // A 402 records out-of-credits (the owner's banner); a call that worked clears it; any other failure says nothing.
    await noteGatewayOutcome(db, userId, call.ok ? { ok: true } : { ok: false, reason: call.reason });
    if (!call.ok && refused && video && !video.hasTranscript) {
      // No captions and the video refused: nothing to read, and no use trying again (it isn't retried by `/work`).
      await settleImport(db, reservation.usageId, null);
      settled = true;
      await finish({ code: "no_captions", why: [NOTHING_TO_READ] }, 0, { usageId: reservation.usageId, latencyMs, failure: call.reason, bytes, videoSeen: false });
      return { ok: false, code: "no_captions" };
    }
    if (!call.ok) {
      await settleImport(db, reservation.usageId, null);
      settled = true;
      const code: SaveErrorCode = call.reason === "gateway_413" ? "too_large" : "model_failed";
      await finish({ code, why: [call.reason] }, 0, { usageId: reservation.usageId, latencyMs, failure: call.reason, bytes });
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
    // Was the video seen? The gateway's passing of a link is undocumented: the billed tokens say (§5.4).
    const videoSeen = video && c
      ? refused ? false : video.watched && video.durationSec ? videoSeenOf(call.inputTokens, extractSystemText().length + c.userText.length, video.durationSec) : null
      : undefined;
    const facts: RelayCall = {
      usageId: reservation.usageId, latencyMs, model: call.model ?? model, raw: call.content,
      inputTokens: call.inputTokens, outputTokens: call.outputTokens, finishReason: call.finishReason, bytes,
      ...(video ? { watched: video.watched, videoSeen: videoSeen ?? null, ...(refused ? { videoRefused: true } : {}) } : {}),
    };
    if (call.model && !modelAllowed(call.model)) {
      console.warn(JSON.stringify({ level: "warn", msg: "saves relay: reply from a model outside the allowlist", requested: model, got: call.model }));
      await finish({ code: "model_failed", why: ["the reply came from a model that is not allowed"] }, cost, facts);
      return { ok: false, code: "model_failed", issues: ["the reply came from a model that is not allowed"] };
    }
    if (call.finishReason === "length") {
      // Cut off at the output limit: not a JSON problem, and a retry at the same length would be cut the same way.
      const issues = [`the reply was cut off at the output limit (${call.outputTokens} tokens): write less — shorter steps, cues and condition notes, no aliases`];
      await finish({ code: "model_failed", why: issues }, cost, facts);
      return { ok: false, code: "model_failed", issues };
    }
    if (video && videoSeen === false && !video.hasTranscript) {
      // No captions and the video unseen: whatever came back was read from a title and a description alone.
      await finish({ code: "no_captions", why: [NOTHING_TO_READ] }, cost, facts);
      return { ok: false, code: "no_captions" };
    }
    const parsed = parseExtraction(call.content);
    if (!parsed.ok) {
      await finish({ code: "model_failed", why: parsed.issues }, cost, facts);
      return { ok: false, code: "model_failed", issues: parsed.issues };
    }
    // Paid and stored first (final audit G1b): its quotes are checked and its moves matched after.
    await finish({ extraction: parsed.extraction }, cost, facts);
    return await matched(parsed.extraction);
  } catch (e) {
    console.warn(JSON.stringify({ level: "warn", msg: "saves relay: failed", detail: String(e).slice(0, 200) }));
    if (!settled) await settleImport(db, reservation.usageId, null).catch(() => undefined);
    settled = true;
    await finish({ code: "model_failed", why: [String(e).slice(0, 200)] }, 0).catch(() => undefined);
    return { ok: false, code: "model_failed" };
  } finally {
    // A throw must not leave the reservation at its worst case: it settles to nothing spent.
    if (!settled) await settleImport(db, reservation.usageId, null);
  }
}

/** The trail's word for a match the request didn't finish: the stale re-match does it, no reading paid again. */
const MATCH_AGAIN = "Matching didn't finish; it will be matched again shortly";

/** Every quote checked against the words it claims (§5.6); the check replaces any the model wrote. */
function checkQuotes(extraction: Extraction, words: PostWords | undefined): Extraction {
  return verifyQuotes(extraction, {
    caption: words?.caption ?? "",
    title: words?.title ?? null,
    chapters: (words?.chapters ?? []).map((ch) => ch.title),
    // Read only if a quote isn't found in the other words: a long transcript is the costly part (F2).
    transcript: words?.transcript ? () => transcriptSegments(words.transcript!.text) : null,
    speech: extraction.speech ?? null,
  }).extraction;
}

/**
 * A reading whose request was cut off after its paid call (final audit G1b): `extracted` longer than the relay's stale
 * claim, never handed out to be read again. One such post a call is checked and matched here, alone in its request
 * (`GET /work` runs it), with no model asked for the reading. True when one was matched. D1 statements: the post 1, its
 * transcript 0–1, then `matchPost`'s.
 */
export async function matchStale(db: Db, env: Env, userId: string, now: Date, fetchImpl: typeof fetch): Promise<boolean> {
  const stale = new Date(now.getTime() - RELAY_CLAIM_STALE_MS).toISOString();
  const rows = await db
    .select({
      id: savedPosts.id, extraction: savedPosts.extraction, caption: savedPosts.caption, hashtags: savedPosts.hashtags,
      creatorHandle: savedPosts.creatorHandle, creatorName: savedPosts.creatorName, mediaType: savedPosts.mediaType,
      source: savedPosts.source, title: savedPosts.title, durationSec: savedPosts.durationSec, videoInfo: savedPosts.videoInfo,
    })
    .from(savedPosts)
    .where(and(eq(savedPosts.userId, userId), eq(savedPosts.status, "extracted"), lt(savedPosts.updatedAt, stale)))
    .orderBy(savedPosts.updatedAt)
    .limit(3);
  // A stored reading always parses (it was stored after its parse); one that doesn't is left, never failed into a re-read.
  let parsed: ReturnType<typeof extractionSchema.safeParse> | null = null;
  const row = rows.find((r) => (parsed = extractionSchema.safeParse(r.extraction)).success);
  if (!row || !parsed || !(parsed as { success: boolean }).success) return false;
  const words: PostWords = {
    caption: row.caption ?? "", hashtags: row.hashtags ?? [], mediaType: (row.mediaType as PostSubmit["mediaType"]) ?? "video",
    creator: { handle: row.creatorHandle ?? "", ...(row.creatorName ? { name: row.creatorName } : {}) },
    source: row.source, title: row.title, durationSec: row.durationSec, chapters: row.videoInfo?.chapters ?? [],
  };
  if (row.videoInfo?.captions && row.videoInfo.transcriptChars > 0) {
    const [blob] = await db
      .select({ text: importBlobs.text })
      .from(importBlobs)
      .where(and(eq(importBlobs.userId, userId), eq(importBlobs.postId, row.id), eq(importBlobs.kind, "transcript")))
      .orderBy(desc(importBlobs.at))
      .limit(1);
    if (blob) words.transcript = { lang: row.videoInfo.captions.lang, kind: row.videoInfo.captions.kind, text: blob.text, cut: row.videoInfo.transcriptCut };
  }
  await matchPost(db, env, userId, row.id, now.toISOString(), fetchImpl, { checked: checkQuotes((parsed as { data: Extraction }).data, words) });
  return true;
}

/** A long video with no captions: nothing to read until the owner asks for it to be watched. */
const NO_CAPTIONS_LONG = "No captions, and it's over 20 minutes — Watch it too reads it from the video";
/** No captions, and the reader couldn't watch it. */
const NOTHING_TO_READ = "Nothing to read: no captions, and the video couldn't be watched";
/** The system prompt's and the library names' share of a video reading's text, for its reservation. */
const SYSTEM_CHARS = extractSystemText().length;
const LIBRARY_CHARS = EXERCISES.reduce((n, e) => n + e.name.length + 2, 0);
const TEXT_SLACK_CHARS = 4_000;

/** One relay call's facts for the trail: its usage row, time, model, raw reply and tokens, or why it failed. */
interface RelayCall {
  usageId: string;
  latencyMs: number;
  model?: string;
  raw?: string;
  inputTokens?: number;
  outputTokens?: number;
  finishReason?: string | null;
  failure?: string;
  /** The body's bytes, when the Worker built it (a video's). */
  bytes?: number;
  /** A video's reading: whether the video was attached, and whether the bill says it was seen (null: not attached). */
  watched?: boolean;
  videoSeen?: boolean | null;
  /** The gateway refused the video part, and the reading was made from the words alone (G6). */
  videoRefused?: boolean;
  /** How the reading's quotes checked out (§5.6). */
  quotes?: { verified: number; in_speech: number; not_found: number };
}

const KIND_WORDS: Record<Extraction["kind"], string> = {
  routine: "a routine", single_move: "single move", tips: "tips", not_training: "not training",
};

/** The extract stage's event for one attempt (design 2026-11-05 §4). */
function extractEvent(
  out: { extraction: Extraction } | { code: SaveErrorCode; why?: string[] },
  costMicros: number,
  call: RelayCall | undefined,
  claimed: { attempt: number; userText: string; sha: string } | null,
  prompt: { version: string | null; sha: string | null },
  asked: string,
  bytes: number,
): TrailEventInput {
  const asSent = prompt.sha === null || !claimed ? null : prompt.sha === claimed.sha;
  const older = asSent === false;
  let summary: string;
  if ("extraction" in out) {
    const n = out.extraction.moves.length;
    summary = `Read ${n} move${n === 1 ? "" : "s"} (${KIND_WORDS[out.extraction.kind]})`;
    // A video's reading says whether it was watched (§5.4).
    if (call?.videoRefused) summary = `${summary} — the gateway wouldn't take the video; it was read from its words`;
    else if (call?.watched === false) summary = `${summary} — from the transcript (over 20 minutes)`;
    else if (call?.videoSeen === false) summary = `${summary} — the reader couldn't watch the video; it read the transcript only`;
    else if (call?.videoSeen === true) summary = `${summary} — watched`;
  } else if (out.code === "no_captions") {
    summary = out.why?.[0] ?? NOTHING_TO_READ;
  } else if (call?.failure) {
    summary = call.failure.startsWith("gateway_") && /^\d+$/.test(call.failure.slice(8))
      ? `The model gateway answered ${call.failure.slice(8)}`
      : `The model couldn't be reached (${call.failure})`;
  } else if (call?.finishReason === "length") {
    summary = `The reply was cut off at the output limit (${call.outputTokens ?? 0} tokens)`;
  } else {
    summary = `The reply didn't match the format: ${out.why?.[0] ?? "unreadable"}`;
  }
  if (older) summary = `${summary} — the extension sent a different prompt (an older extension)`;
  const failed = !("extraction" in out);
  return {
    stage: "extract",
    source: call ? "gateway" : "worker",
    status: failed ? "fail" : older || call?.videoSeen === false ? "warn" : "ok",
    summary,
    detail: {
      ...("extraction" in out ? { kind: out.extraction.kind, moves: out.extraction.moves.length } : { code: out.code, issues: out.why ?? [] }),
      finishReason: call?.finishReason ?? null,
      ...(call?.inputTokens !== undefined ? { tokens: { in: call.inputTokens, out: call.outputTokens ?? 0 } } : {}),
      promptSha: claimed?.sha ?? null,
      promptShaSent: prompt.sha,
      asSent,
      ...(call?.watched !== undefined ? { watched: call.watched } : {}),
      videoSeen: call?.videoSeen ?? null,
      ...(call?.quotes ? { quotes: call.quotes } : {}),
      bytes,
    },
    ...(claimed ? { attempt: claimed.attempt } : {}),
    ...(call ? { usageId: call.usageId, latencyMs: call.latencyMs, model: call.model ?? asked, costMicros } : {}),
    ...(prompt.version ? { promptVersion: prompt.version } : {}),
    blobs: [
      ...(call?.raw !== undefined ? [{ kind: "raw_reply" as const, text: call.raw }] : []),
      ...(claimed ? [{ kind: "prompt_user" as const, text: claimed.userText }] : []),
      // What the reader heard in the video: its own transcription, labelled so (§5.5).
      ...("extraction" in out && out.extraction.speech ? [{ kind: "speech" as const, text: out.extraction.speech }] : []),
    ],
  };
}

function parseExtraction(content: string): { ok: true; extraction: Extraction } | { ok: false; issues: string[] } {
  const raw = extractJson(content);
  if (raw === null || typeof raw !== "object") return { ok: false, issues: ["the reply was not valid JSON"] };
  // One unknown list value no longer fails the whole reading: it is left out, and the move flagged (live finding, 2026-11-05).
  const lenient = dropUnknownEnums(raw);
  const { dropped: _theModels, ...value } = lenient.value as Record<string, unknown>;
  const parsed = extractionSchema.safeParse(lenient.dropped.length ? { ...value, dropped: lenient.dropped } : value);
  if (parsed.success) return { ok: true, extraction: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.slice(0, ISSUES_MAX).map(issueText),
  };
}

/**
 * One chat completion whose body is the request's own stream. Not retried: the stream is spent by the first attempt.
 * Failures carry a reason (`gateway_<status>` / `llm_error`) and are logged, as the filter's are.
 */
async function callGateway(
  env: Env,
  fetchImpl: typeof fetch,
  body: { stream: ReadableStream | null; length: number } | { text: string },
  model: string,
  timeoutMs: number,
): Promise<
  | { ok: true; content: string; model: string | null; inputTokens: number; outputTokens: number; finishReason: string | null }
  | { ok: false; reason: string }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const length = "text" in body ? body.text.length : body.length;
  try {
    const response = await fetchImpl(`${env.AI_GATEWAY_BASE_URL || "https://ai-gateway.vercel.sh/v1"}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      ...("text" in body
        ? { headers: { Authorization: `Bearer ${env.AI_GATEWAY_API_KEY}`, "Content-Type": "application/json" }, body: body.text }
        : {
            headers: { Authorization: `Bearer ${env.AI_GATEWAY_API_KEY}`, "Content-Type": "application/json", "Content-Length": String(body.length) },
            body: body.stream,
            duplex: "half",
          }),
    } as RequestInit);
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.warn(JSON.stringify({ level: "warn", msg: "saves relay: ai gateway error", status: response.status, model, detail: detail.slice(0, 300) }));
      return { ok: false, reason: `gateway_${response.status}` };
    }
    // The reply is small JSON: parsed whole.
    const json = (await response.json().catch(() => null)) as {
      model?: unknown;
      choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    } | null;
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return { ok: false, reason: "gateway_bad_response" };
    const finishReason = json?.choices?.[0]?.finish_reason;
    return {
      ok: true,
      content,
      model: typeof json?.model === "string" ? json.model : null,
      inputTokens: json?.usage?.prompt_tokens ?? Math.ceil(length / 4),
      outputTokens: json?.usage?.completion_tokens ?? Math.ceil(content.length / 3),
      finishReason: typeof finishReason === "string" ? finishReason : null,
    };
  } catch (e) {
    console.warn(JSON.stringify({ level: "warn", msg: "saves relay: ai gateway request failed", model, detail: String(e).slice(0, 200) }));
    return { ok: false, reason: "llm_error" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One line the extension sends back to the model as a retry hint, OUTSIDE the prompt's data block. Built only from the
 * path, the zod code and our own schema's limits: never zod's `message` or `received`, which echo what the model wrote
 * (a value, an unrecognized key name).
 */
function issueText(i: ZodIssue): string {
  const where = i.path.map(String).join(".") || "(root)";
  switch (i.code) {
    case "invalid_enum_value":
      return `${where}: must be one of ${i.options.map(String).join(", ")}`.slice(0, 300);
    case "invalid_type":
      return `${where}: ${i.received === "undefined" ? "is required" : `must be ${i.expected}`}`;
    case "too_small":
      return `${where}: too short or too small (minimum ${i.minimum})`;
    case "too_big":
      return `${where}: too long or too large (maximum ${i.maximum})`;
    case "unrecognized_keys":
      return `${where}: has keys that are not part of the format`;
    default:
      return `${where}: invalid (${i.code})`;
  }
}

/**
 * A body over the cap: the post is `failed` with `too_large` and the attempt counted. `/work` never hands it out again;
 * only the extension's immediate retry at a smaller size may claim it (while attempts remain). One statement.
 */
export async function markTooLarge(db: Db, userId: string, postId: string, now: string): Promise<void> {
  const marked = await db
    .update(savedPosts)
    .set({ status: "failed", lastErrorCode: "too_large", lastError: null, extractAttempts: sql`${savedPosts.extractAttempts} + 1`, updatedAt: now })
    .where(and(eq(savedPosts.id, postId), eq(savedPosts.userId, userId), inArray(savedPosts.status, ["queued", "failed"])))
    .returning({ source: savedPosts.source });
  if (marked.length > 0) {
    await runAtomically(db, trailStatements(db, userId, postId, [
      { stage: "read", source: siteSource(marked[0]!.source), status: "fail", summary: "Too large to send, at any size", detail: { code: "too_large" } },
    ], now));
  }
}
