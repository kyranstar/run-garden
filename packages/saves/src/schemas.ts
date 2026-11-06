import { z } from "zod";
import { LIST_FIELDS } from "./lenient.js";
import { TRANSCRIPT_MAX } from "./transcript.js";

export const chapterSchema = z.object({ start: z.number().min(0).max(86_400), title: z.string().max(100) }).strict();
import {
  CONTRACTIONS, DOSE_TYPES, EQUIPMENT_IDS, LATERALITY, LOADS, PATTERNS, POSITIONS, PROFILE_IDS, REGIONS,
} from "@rg/exercise-library";

// The wire contract between the browser extension, the Worker and the extraction model. Every enum is built from the
// exercise library's own arrays so a schema can never drift from the library. Site-neutral: the source arrives as data.

export const SAVE_SOURCE_RE = /^[a-z][a-z0-9._-]{0,39}$/;

export const SAVE_POST_STATUSES = [
  "seen", "filtered_out", "queued", "extracting", "extracted", "matched", "failed", "skipped_by_owner", "reference_only",
] as const;
export type SavePostStatus = (typeof SAVE_POST_STATUSES)[number];

export const SAVE_ERROR_CODES = [
  "login_needed", "feed_changed", "app_unreachable", "budget_paused", "media_failed", "model_failed", "too_large",
  "gone", "unknown",
  // A video with no captions that couldn't be watched either; a video YouTube won't play (pasted links, 2026-11-06).
  "no_captions", "unplayable",
] as const;
export type SaveErrorCode = (typeof SAVE_ERROR_CODES)[number];

export const postSubmitSchema = z
  .object({
    source: z.string().regex(SAVE_SOURCE_RE),
    key: z.string().min(1).max(64),
    url: z.string().max(500).url().startsWith("https://"),
    creator: z.object({ handle: z.string().max(64), name: z.string().max(120).optional() }).strict(),
    /** A post's caption, or a video's description (YouTube's own cap is 5,000). */
    caption: z.string().max(5000),
    hashtags: z.array(z.string().max(60)).max(30),
    mediaType: z.enum(["video", "carousel", "image"]),
    postedAt: z.string().max(40).nullable().optional(),
    cover: z
      .object({ mime: z.enum(["image/jpeg", "image/png", "image/webp"]), base64: z.string().max(400_000) })
      .strict()
      .optional(),
    seed: z
      .object({ status: z.enum(["queued", "filtered_out"]), reason: z.string().max(160) })
      .strict()
      .optional(),
    /** What the extension fetched to send this post (import trail, 2026-11-05): the post's read event. */
    readFacts: z
      .object({
        via: z.enum(["saved_list", "pasted"]),
        extVersion: z.string().max(20),
        coverSent: z.boolean(),
        mediaCount: z.number().int().min(0).max(50),
        page: z.number().int().min(0).max(100).optional(),
        /** A YouTube read's own facts (design 2026-11-05 §4): captions, transcript, chapters, how it was got, its time. */
        youtube: z
          .object({
            captions: z.object({ lang: z.string().max(20), kind: z.enum(["uploaded", "auto"]) }).strict().nullable(),
            segments: z.number().int().min(0).max(1_000_000),
            transcriptChars: z.number().int().min(0).max(TRANSCRIPT_MAX),
            chapters: z.number().int().min(0).max(100),
            chaptersFrom: z.enum(["player", "description"]).nullable(),
            via: z.enum(["captured", "panel"]).nullable(),
            ms: z.number().int().min(0).max(600_000),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    // Pasted links and YouTube (design 2026-11-05 §5.3), all optional: a saved Instagram post carries none of them.
    origin: z.enum(["saved", "pasted"]).optional(),
    title: z.string().max(200).optional(),
    durationSec: z.number().int().min(0).max(86_400).optional(),
    chapters: z.array(chapterSchema).max(100).optional(),
    /** The transcript as one text, a segment a line (transcript.ts); never stored in the post row. */
    transcript: z
      .object({ lang: z.string().max(20), kind: z.enum(["uploaded", "auto"]), text: z.string().max(TRANSCRIPT_MAX), cut: z.boolean() })
      .strict()
      .optional(),
    /** A video that was a live stream (finished: one live now is not read). */
    live: z.boolean().optional(),
  })
  .strict();
export type PostSubmit = z.infer<typeof postSubmitSchema>;

/** `POST /api/saves/read-failed`: a read that failed before the app had the post (or before any post: a login). */
export const readFailedSchema = z
  .object({
    source: z.string().regex(SAVE_SOURCE_RE),
    key: z.string().min(1).max(64).optional(),
    code: z.enum(SAVE_ERROR_CODES),
    message: z.string().max(300),
  })
  .strict();
export type ReadFailed = z.infer<typeof readFailedSchema>;

export const filterVerdictSchema = z
  .object({ verdict: z.enum(["training", "maybe", "not"]), reason: z.string().max(160) })
  .strict();
export type FilterVerdict = z.infer<typeof filterVerdictSchema>;

const range = z.tuple([z.number(), z.number()]);
const stated = z.enum(["stated", "inferred"]);

/** When the post says to use a move, or not (extract-6): the "in what cases" the owner asked for. */
const caseSchema = z.object({ text: z.string().max(160), evidence: stated }).strict();
export const QUOTE_FIELDS = ["name", "dose", "purpose", "useWhen", "skipWhen", "steps", "why"] as const;
export const QUOTE_CHECKS = ["verified", "in_speech", "not_found"] as const;
export type QuoteCheck = (typeof QUOTE_CHECKS)[number];
/**
 * A passage that supports a field, verbatim (extract-6). `check` is the Worker's, set after the parse (quotes.ts): a
 * model-written one is replaced.
 */
export const quoteSchema = z
  .object({
    field: z.enum(QUOTE_FIELDS),
    text: z.string().max(200),
    at: z.number().min(0).max(86_400).optional(),
    from: z.enum(["caption", "transcript", "speech", "screen"]),
    check: z.enum(QUOTE_CHECKS).optional(),
  })
  .strict();
export type Quote = z.infer<typeof quoteSchema>;
export const INSIGHT_SCOPES = ["general", "this_routine", "creator_programme"] as const;
export type InsightScope = (typeof INSIGHT_SCOPES)[number];
/** An insight: words (before extract-6, always `general`), or words with their scope and the passage behind them. */
const insightSchema = z.union([
  z.string().max(200),
  z.object({ text: z.string().max(200), scope: z.enum(INSIGHT_SCOPES), quote: z.string().max(200).optional() }).strict(),
]);
export type Insight = z.infer<typeof insightSchema>;
export const insightText = (i: Insight): string => (typeof i === "string" ? i : i.text);
export const insightScope = (i: Insight): InsightScope => (typeof i === "string" ? "general" : i.scope);

/** The most moves one reading holds: a 30-move follow-along stays whole (design 2026-11-05 §5.5, §14.5). */
export const EXTRACT_MOVES_MAX = 30;

const conditionEntry = z
  .object({ attrs: z.record(z.union([z.number(), z.boolean()])), note: z.string().max(160) })
  .strict();
/** One rating per profile in the library; a profile missing here is rejected. */
const conditionsShape = Object.fromEntries(PROFILE_IDS.map((id) => [id, conditionEntry])) as Record<
  (typeof PROFILE_IDS)[number], typeof conditionEntry
>;

export const extractedMoveSchema = z
  .object({
    name: z.string().min(1).max(80),
    aliases: z.array(z.string().max(80)).max(5),
    summary: z.string().max(160),
    steps: z.array(z.string().max(200)).max(8),
    cues: z.array(z.string().max(160)).max(6),
    mistakes: z.array(z.string().max(160)).max(5),
    purpose: z.string().max(160),
    dose: z
      .object({
        text: z.string().max(80),
        type: z.enum(DOSE_TYPES).optional(),
        range: range.optional(),
        sets: range.optional(),
        secsPerRep: z.number().min(0).max(60).optional(),
      })
      .strict(),
    patterns: z.array(z.enum(PATTERNS)),
    regions: z.array(z.enum(REGIONS)),
    equipment: z.array(z.enum(EQUIPMENT_IDS)),
    /** Any one of these will do (a bench or a chair); `equipment` is what the move can't be done without. */
    equipmentOneOf: z.array(z.enum(EQUIPMENT_IDS)).optional(),
    position: z.enum(POSITIONS),
    laterality: z.enum(LATERALITY),
    load: z.enum(LOADS),
    contraction: z.array(z.enum(CONTRACTIONS)),
    difficulty: z.number().int().min(1).max(5),
    conditions: z.object(conditionsShape).strict(),
    corosHint: z.string().max(60).optional(),
    evidence: z
      .object({ name: stated, dose: stated, steps: stated, purpose: stated.optional(), useWhen: stated.optional(), skipWhen: stated.optional() })
      .strict(),
    confidence: z.enum(["high", "medium", "low"]),
    // extract-6 (design 2026-11-05 §5.5): absent from a reading made before it.
    useWhen: z.array(caseSchema).max(4).optional(),
    skipWhen: z.array(caseSchema).max(4).optional(),
    why: z.string().max(200).optional(),
    quotes: z.array(quoteSchema).max(8).optional(),
  })
  .strict();
export type ExtractedMove = z.infer<typeof extractedMoveSchema>;

export const extractionSchema = z
  .object({
    kind: z.enum(["routine", "single_move", "tips", "not_training"]),
    summary: z.string().max(300),
    themes: z.array(z.string().max(40)).max(5),
    moves: z.array(extractedMoveSchema).max(EXTRACT_MOVES_MAX),
    routine: z
      .object({ rounds: z.number().optional(), restSec: z.number().optional(), order: z.array(z.number()) })
      .strict()
      .optional(),
    /**
     * What the post says about when, why or how often to do this, beyond any one move's steps (spec §17): kept in the
     * coach's memory when the owner saves the batch. An extraction stored before they were asked for has none.
     */
    insights: z.array(insightSchema).max(5).default([]),
    /** What the video says, transcribed by the reader (an Instagram video; extract-6): never "the transcript". */
    speech: z.string().max(4000).optional(),
    /**
     * Written by the Worker after the parse, never the model's (a model-written one is replaced): the list values the
     * library doesn't know, left out so one word can't throw a paid reading away (live finding, 2026-11-05).
     */
    dropped: z
      .array(z.object({ move: z.number().int().min(0), field: z.enum(LIST_FIELDS), values: z.array(z.string().max(40)).max(20) }).strict())
      .max(150)
      .optional(),
  })
  .strict();
/** An extraction as stored: one read before `insights` were asked for has none (the schema reads it as `[]`). */
export type Extraction = z.input<typeof extractionSchema>;

export const checkReportSchema = z
  .object({
    checkId: z.string().uuid(),
    phase: z.enum(["start", "finish"]),
    found: z.number().optional(),
    fresh: z.number().optional(),
    filtered: z.number().optional(),
    extracted: z.number().optional(),
    failed: z.number().optional(),
    error: z.object({ code: z.enum(SAVE_ERROR_CODES), message: z.string().max(200) }).strict().optional(),
  })
  .strict();
export type CheckReport = z.infer<typeof checkReportSchema>;

// Status DTOs (Worker -> app and extension popup).
export interface CheckRowDto {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  found: number;
  fresh: number;
  filtered: number;
  extracted: number;
  failed: number;
  errorCode: SaveErrorCode | null;
}
export interface PostRowDto {
  /** The ledger's row id (what an owner override names). */
  id: string;
  key: string;
  url: string;
  creator: { handle: string; name?: string };
  status: SavePostStatus;
  /** The screening's reason (why the post was kept or filtered out). */
  reason: string | null;
  /** A failed post's code, else null (import trail, 2026-11-05). */
  errorCode: SaveErrorCode | null;
  /** A failed post's failure in plain words (`failureWords`), else null: never the screening's reason. */
  error: string | null;
  updatedAt: string;
}
/**
 * One item of `GET /work`: `filter` = resubmit the post to `/posts` (the filter runs again); `extract` = fetch its media
 * (a YouTube video: ask for its reading); `read` = a pasted link waiting to be read (only for `?v=2`: pasted links).
 */
export interface WorkItem {
  source: string;
  key: string;
  url: string;
  action: "filter" | "extract" | "read";
}
export interface SavesStatusDto {
  state: "ok" | "login_needed" | "feed_changed" | "paused_budget" | "error" | "idle";
  lastCheckAt: string | null;
  /** When moves last arrived: the newest batch's save, else its release. Null before the first batch. */
  lastImportAt: string | null;
  /** What the import has brought so far: the distinct moves linked from saved posts (library and personal alike, links the owner saved), and the posts those links come from. */
  totals: { moves: number; posts: number };
  checks: CheckRowDto[];
  posts: PostRowDto[];
  spend: { spentMicros: number; capMicros: number };
}

/** The matching judge's reply: for each move it was asked about, the candidate id that is the same move, or null. */
export const matchVerdictSchema = z.object({
  matches: z.array(z.object({ move: z.number().int(), id: z.string().max(80).nullable() })).max(EXTRACT_MOVES_MAX),
});
export type MatchVerdict = z.infer<typeof matchVerdictSchema>;
