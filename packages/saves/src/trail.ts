import type { SaveErrorCode } from "./schemas.js";

// THE IMPORT TRAIL's shared words and types (design 2026-11-05 §4, §6): what each stage of a saved or pasted post took
// in, decided and gave out, as the Worker stores it and the app and the extension read it.

/**
 * A post's failure in the owner's words, from its code and the stage's own text. The code decides the words, so a
 * failure never reads as an earlier one's (audit 2026-11-05, bugs 2 and 5).
 */
export function failureWords(code: SaveErrorCode | string | null, raw: string | null): string | null {
  if (!code) return null;
  const first = raw?.split(" | ")[0]?.trim() || null;
  switch (code) {
    case "gone":
      return "The post is gone";
    case "media_failed":
      return "The video wouldn't download";
    case "too_large":
      return "Too large to send, at any size";
    case "model_failed":
      return first ? `The reader's reply didn't work: ${first}` : "The reader's reply didn't work";
    case "budget_paused":
      return "Waiting for the import budget";
    case "login_needed":
      return "Instagram wants you to log in again";
    case "feed_changed":
      return "Instagram changed something";
    case "app_unreachable":
      return "The app couldn't be reached";
    case "no_captions":
      return first ?? "No captions, and the video couldn't be watched";
    case "unplayable":
      return first ?? "YouTube won't play it";
    default:
      return first ? `Something went wrong: ${first}` : "Something went wrong";
  }
}

/** The stages of a post's path, in pipeline order (the trail sheet's sections follow it). */
export const IMPORT_STAGES = [
  "read", "submit", "screen", "extract", "check", "match", "batch", "choice", "save", "coach", "correction",
] as const;
export type ImportStage = (typeof IMPORT_STAGES)[number];
/** How a stage's step went: `skip` is a stage that had nothing to do; `info` a step that is neither a pass nor a fail. */
export type TrailStatus = "ok" | "warn" | "fail" | "skip" | "info";
/** Who did the step: a site, the model gateway, the app, the coach, the owner, the extension. */
export type TrailSource = "instagram" | "youtube" | "gateway" | "worker" | "coach" | "owner" | "extension";
export type BlobKind = "raw_reply" | "prompt_user" | "transcript" | "speech" | "read_facts" | "detail";

/** One step of a post's trail, as the owner's trail route gives it. Text written by a model or a stranger is data. */
export interface TrailEventDto {
  id: string;
  stage: ImportStage;
  source: TrailSource;
  status: TrailStatus;
  summary: string;
  detail: unknown;
  moveId: string | null;
  model: string | null;
  promptVersion: string | null;
  costMicros: number | null;
  latencyMs: number | null;
  attempt: number | null;
  runId: string | null;
  proposalId: string | null;
  /** Built from stored columns for a post imported before the trail (§6.6), not written by the stage. */
  rebuilt: boolean;
  blobs: { id: string; kind: BlobKind; chars: number }[];
  at: string;
}

/** One post's trail, as the owner reads it (`GET /api/my-saves/posts/:id/trail`; design 2026-11-05 §3.4). */
export interface ImportTrailDto {
  post: {
    id: string;
    source: string;
    url: string | null;
    title: string | null;
    creator: { handle: string; name?: string };
    mediaType: string | null;
    postedAt: string | null;
    firstSeenAt: string;
    status: string;
    origin: "saved" | "pasted" | null;
    durationSec: number | null;
    videoSeen: boolean | null;
  };
  /** The account (level 1): what the post is, its moves and how each came out, and one health word. */
  account: {
    kind: string | null;
    summary: string | null;
    moves: { position: number; name: string; outcome: "new" | "yours" | "library"; moveId: string | null; purpose: string | null }[];
    health: { status: TrailStatus; line: string };
  };
  /** Oldest first. */
  events: TrailEventDto[];
  /** The post came before the trail: its events were built from what was kept (§6.6). */
  rebuilt: boolean;
}

/** One blob's text (`GET /api/my-saves/blobs/:id`). */
export interface ImportBlobDto {
  id: string;
  kind: BlobKind;
  text: string;
  cut: boolean;
}

/** The health row's lights, in the order the row shows them (design 2026-11-05 §3.2, §6.5). */
export const HEALTH_LIGHTS = ["instagram", "youtube", "screening", "reader", "matching", "coach", "budget"] as const;
export type HealthLight = (typeof HEALTH_LIGHTS)[number];
export type HealthColor = "green" | "yellow" | "red" | "grey";
export interface HealthLightDto {
  light: HealthLight;
  color: HealthColor;
  /** One line when it isn't green ("Reader: 3 of 4 readings failed"), else null. */
  line: string | null;
  /** Its recent failures, newest first: the post (null for one before any post, like a login), what, when, why. */
  failures: { postId: string | null; title: string; at: string; why: string }[];
}
export interface ImportHealthDto {
  lights: HealthLightDto[];
  /** The reddest light's line, or null when every light is green or grey. */
  worst: string | null;
}

/** The lights' labels, as the row shows them wherever it is drawn (the app, the popup) and the Worker's lines say them. */
export const HEALTH_LABELS: Readonly<Record<HealthLight, string>> = {
  instagram: "Instagram",
  youtube: "YouTube",
  screening: "Screening",
  reader: "Reader",
  matching: "Matching",
  coach: "Coach",
  budget: "Budget",
};

/** A colour's glyph and word: a light reads the same without its colour, and grey (nothing to judge) is never green. */
export const HEALTH_MARKS: Readonly<Record<HealthColor, { mark: string; word: string }>> = {
  green: { mark: "✓", word: "working" },
  yellow: { mark: "!", word: "needs a look" },
  red: { mark: "✕", word: "failing" },
  grey: { mark: "–", word: "nothing to judge yet" },
};

/**
 * While any light is red, what a headline says in place of "all is well" (audit 2026-11-05, bug 7): the worst light's
 * line. Null while none is red.
 */
export function redLine(health: Pick<ImportHealthDto, "lights" | "worst"> | null | undefined): string | null {
  if (!health?.lights.some((l) => l.color === "red")) return null;
  return health.worst ?? "Something in the import needs a look";
}
