import { failureWords } from "./trail.js";

// PASTED LINKS (design 2026-11-05 §3.1, §5.1, §15.2): a YouTube video or an Instagram post pasted in the extension's
// popup or the app's field. One normalizer for both sides, so a link is the same key wherever it was pasted.

export const LINK_REFUSED = "Only YouTube and Instagram links for now.";
export type LinkSource = "youtube" | "instagram";
export interface NormalLink {
  source: LinkSource;
  /** The video id, or the post's shortcode: what the app keys the post by. */
  key: string;
  /** The canonical link: a video's watch link; a post's /p/ or /reel/ link, never with a query. */
  url: string;
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const SHORTCODE = /^[A-Za-z0-9_-]{5,64}$/;
const YT_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);
const IG_HOSTS = new Set(["instagram.com", "www.instagram.com"]);

const video = (id: string | null | undefined): NormalLink | null =>
  id && VIDEO_ID.test(id) ? { source: "youtube", key: id, url: `https://www.youtube.com/watch?v=${id}` } : null;

/**
 * A pasted link as the app keys it, or null for anything this round doesn't take. Pasted text may be a share's words
 * around a link: its first link the app takes is the one (final audit G12). An http link is read as https; a bare host
 * gets https.
 */
export function normalizeLink(input: string): NormalLink | null {
  const text = input.trim();
  if (!text) return null;
  if (!/\s/.test(text)) return normalizeOne(text);
  // Share text: each link-like piece in turn, the first the app takes.
  for (const m of text.matchAll(/(?:https?:\/\/|www\.|youtu\.be\/|(?:m\.)?youtube\.com\/|instagram\.com\/)[^\s<>"']+/gi)) {
    const link = normalizeOne(m[0].replace(/[).,;!?\]]+$/, ""));
    if (link) return link;
  }
  return null;
}

function normalizeOne(text: string): NormalLink | null {
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text.replace(/^http:/i, "https:") : `https://${text}`);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return null;
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);
  if (host === "youtu.be") return parts.length === 1 ? video(parts[0]) : null;
  if (YT_HOSTS.has(host)) {
    if (parts.length === 1 && parts[0] === "watch") return video(u.searchParams.get("v"));
    if (parts.length === 2 && (parts[0] === "shorts" || parts[0] === "live" || parts[0] === "embed")) return video(parts[1]);
    return null;
  }
  if (IG_HOSTS.has(host)) {
    // /p/<code>/, /reel/<code>/, /reels/<code>/, and the newer /<user>/p/<code>/.
    const at = parts.length === 2 ? 0 : parts.length === 3 ? 1 : -1;
    const kind = at >= 0 ? parts[at] : undefined;
    const code = at >= 0 ? parts[at + 1] : undefined;
    if (!code || !SHORTCODE.test(code)) return null;
    if (kind === "p") return { source: "instagram", key: code, url: `https://www.instagram.com/p/${code}/` };
    if (kind === "reel" || kind === "reels") return { source: "instagram", key: code, url: `https://www.instagram.com/reel/${code}/` };
    return null;
  }
  return null;
}

export type LinkState = "waiting" | "reading" | "screening" | "reading_moves" | "moves" | "not_training" | "failed" | "skipped";
export type LinkAction = "retry" | "import_anyway";

/** One pasted link and where it stands (`GET /api/my-saves/links`, `GET /api/saves/links`). Its title is a stranger's: text. */
export interface LinkDto {
  /** The link's id: the post's id once the post is in (the same hash). */
  id: string;
  source: string;
  key: string;
  url: string;
  title: string | null;
  addedAt: string;
  addedFrom: "extension" | "app";
  /** The post, once the extension has read it; null before. */
  postId: string | null;
  state: LinkState;
  words: string;
  /** The post's moves, once matched; else null. */
  moves: number | null;
  action: LinkAction | null;
}

export const WAITING_FOR_EXTENSION = "Waiting for your computer's extension";
/** The link field's answers (the popup's and the app's). */
export const ADDED_LINE = "Added — it'll be waiting in the coach.";

/** "Already in — imported Tue 3 Nov.", the day in the reader's own time zone. */
export function alreadyInLine(firstSeenAt: string): string {
  const d = new Date(firstSeenAt);
  if (Number.isNaN(d.getTime())) return "Already in.";
  const weekday = d.toLocaleDateString("en-GB", { weekday: "short" });
  const month = d.toLocaleDateString("en-GB", { month: "short" });
  return `Already in — imported ${weekday} ${d.getDate()} ${month}.`;
}

/**
 * Where a link stands, in a word or two: before its post exists, the link's own state; after, the post's (the app's
 * status is the truth once it has the post: §5.1). A link pasted on the phone, or a watch asked on the phone, waits for
 * the computer's extension (§14.4).
 */
export function linkState(
  link: { status: string; addedFrom: "extension" | "app"; errorCode: string | null; error: string | null },
  post: { status: string; lastErrorCode: string | null; lastError: string | null; moves: number; watchVideo: boolean } | null,
): { state: LinkState; words: string; action: LinkAction | null } {
  if (!post) {
    if (link.status === "failed") return { state: "failed", words: `Failed: ${failureWords(link.errorCode ?? "unknown", link.error)}`, action: "retry" };
    return link.addedFrom === "app" ? { state: "waiting", words: WAITING_FOR_EXTENSION, action: null } : { state: "reading", words: "Reading", action: null };
  }
  switch (post.status) {
    case "seen":
      return { state: "screening", words: "Screening", action: null };
    case "queued":
      if (post.watchVideo && link.addedFrom === "app") return { state: "waiting", words: WAITING_FOR_EXTENSION, action: null };
      return { state: "reading_moves", words: "Reading the moves", action: null };
    case "extracting":
    case "extracted":
      return { state: "reading_moves", words: "Reading the moves", action: null };
    case "matched":
      return { state: "moves", words: post.moves === 0 ? "No moves" : `${post.moves} move${post.moves === 1 ? "" : "s"}`, action: null };
    case "filtered_out":
      return { state: "not_training", words: "Not training", action: "import_anyway" };
    case "failed":
      return { state: "failed", words: `Failed: ${failureWords(post.lastErrorCode ?? "unknown", post.lastError)}`, action: "retry" };
    case "skipped_by_owner":
      return { state: "skipped", words: "Skipped", action: null };
    case "reference_only":
      return { state: "skipped", words: "Kept as a reference", action: null };
    default:
      return { state: "reading", words: "Reading", action: null };
  }
}
