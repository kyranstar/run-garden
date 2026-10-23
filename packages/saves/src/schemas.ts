import { z } from "zod";
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
] as const;
export type SaveErrorCode = (typeof SAVE_ERROR_CODES)[number];

export const postSubmitSchema = z
  .object({
    source: z.string().regex(SAVE_SOURCE_RE),
    key: z.string().min(1).max(64),
    url: z.string().max(500).url().startsWith("https://"),
    creator: z.object({ handle: z.string().max(64), name: z.string().max(120).optional() }).strict(),
    caption: z.string().max(4000),
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
  })
  .strict();
export type PostSubmit = z.infer<typeof postSubmitSchema>;

export const filterVerdictSchema = z
  .object({ verdict: z.enum(["training", "maybe", "not"]), reason: z.string().max(160) })
  .strict();
export type FilterVerdict = z.infer<typeof filterVerdictSchema>;

const range = z.tuple([z.number(), z.number()]);
const stated = z.enum(["stated", "inferred"]);

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
      .object({ text: z.string().max(80), type: z.enum(DOSE_TYPES).optional(), range: range.optional(), sets: range.optional() })
      .strict(),
    patterns: z.array(z.enum(PATTERNS)),
    regions: z.array(z.enum(REGIONS)),
    equipment: z.array(z.enum(EQUIPMENT_IDS)),
    position: z.enum(POSITIONS),
    laterality: z.enum(LATERALITY),
    load: z.enum(LOADS),
    contraction: z.array(z.enum(CONTRACTIONS)),
    difficulty: z.number().int().min(1).max(5),
    conditions: z.object(conditionsShape).strict(),
    corosHint: z.string().max(60).optional(),
    evidence: z.object({ name: stated, dose: stated, steps: stated }).strict(),
    confidence: z.enum(["high", "medium", "low"]),
  })
  .strict();
export type ExtractedMove = z.infer<typeof extractedMoveSchema>;

export const extractionSchema = z
  .object({
    kind: z.enum(["routine", "single_move", "tips", "not_training"]),
    summary: z.string().max(300),
    themes: z.array(z.string().max(40)).max(5),
    moves: z.array(extractedMoveSchema).max(12),
    routine: z
      .object({ rounds: z.number().optional(), restSec: z.number().optional(), order: z.array(z.number()) })
      .strict()
      .optional(),
  })
  .strict();
export type Extraction = z.infer<typeof extractionSchema>;

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
  key: string;
  url: string;
  creator: { handle: string; name?: string };
  status: SavePostStatus;
  reason: string | null;
  updatedAt: string;
}
export interface SavesStatusDto {
  state: "ok" | "login_needed" | "feed_changed" | "paused_budget" | "error" | "idle";
  lastCheckAt: string | null;
  checks: CheckRowDto[];
  posts: PostRowDto[];
  spend: { spentMicros: number; capMicros: number };
}
