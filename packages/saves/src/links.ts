import { failureWords } from "./trail.js";

// PASTED LINKS (design 2026-11-05 §3.1, §5.1, §15.2): a YouTube video or an Instagram post pasted in the extension's
// popup or the app's field. One normalizer for both sides, so a link is the same key wherever it was pasted.

export const LINK_REFUSED = "Only YouTube and Instagram links for now.";
/** A YouTube or Instagram link that isn't one video or post: a playlist, a channel, a profile (audit 2026-11-06, I4). */
export const LINK_NOT_SINGLE = "Single videos and posts only — not playlists or channels.";
/** The most links one paste adds (audit 2026-11-06, I4): the rest are said, never dropped silently. */
export const LINKS_AT_ONCE = 5;
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
  for (const piece of pieces(input)) {
    const link = normalizeOne(piece);
    if (link) return link;
  }
  return null;
}

/**
 * The link-like pieces of pasted text, in order: the text itself when it is one word, else each link in share text.
 * Links pasted on several lines into a one-line field come glued (the field drops the line breaks): each `http(s)://`
 * after the first starts a piece of its own (audit 2026-11-06, I4).
 */
function pieces(input: string): string[] {
  const text = input.trim();
  if (!text) return [];
  const words = !/\s/.test(text)
    ? [text]
    : [...text.matchAll(/(?:https?:\/\/|www\.|youtu\.be\/|(?:m\.)?youtube\.com\/|instagram\.com\/)[^\s<>"']+/gi)].map((m) => m[0]);
  return words.flatMap((w) => w.split(GLUED)).map((w) => w.replace(/[).,;!?\]]+$/, "")).filter(Boolean);
}

/**
 * Where a glued link starts: a scheme, or a bare host the app takes not right after `//` or a dot (so a link's own
 * `https://www.` and `m.youtube.com` stay whole; review, 2026-11-06).
 */
const GLUED = /(?=https?:\/\/)|(?<!\/\/|\.)(?=(?:www\.|m\.)?(?:youtu\.be|youtube\.com|instagram\.com)\/)/i;

/** What one paste holds (audit 2026-11-06, I4): each link the app takes, once, in order, at most `LINKS_AT_ONCE`. */
export interface PastedLinks {
  links: NormalLink[];
  /** The link-like pieces pasted. */
  pieces: number;
  /** Why each piece the app doesn't take was refused (`linkRefusal`'s words), in order. */
  refused: string[];
  /** Links the app takes past the first `LINKS_AT_ONCE`. */
  cut: number;
}

/** Every link in a paste the app takes — not only the first (audit 2026-11-06, I4). */
export function normalizeLinks(input: string): PastedLinks {
  const all = pieces(input);
  const links: NormalLink[] = [];
  const seen = new Set<string>();
  const refused: string[] = [];
  let cut = 0;
  for (const piece of all) {
    const link = normalizeOne(piece);
    if (!link) {
      refused.push(refusalOf(piece));
      continue;
    }
    if (seen.has(`${link.source}:${link.key}`)) continue;
    seen.add(`${link.source}:${link.key}`);
    if (links.length < LINKS_AT_ONCE) links.push(link);
    else cut++;
  }
  return { links, pieces: all.length, refused, cut };
}

/** Why pasted text holds no link the app takes: a YouTube or Instagram page that isn't one video or post, or any other. */
export function linkRefusal(input: string): string {
  const all = pieces(input);
  return all.some((p) => refusalOf(p) === LINK_NOT_SINGLE) ? LINK_NOT_SINGLE : LINK_REFUSED;
}

/** Instagram's own first path segments: never a profile. */
const IG_PAGES = new Set(["p", "reel", "reels", "stories", "explore", "accounts", "direct", "tv"]);

/**
 * Why one piece isn't taken: a playlist, a channel (`/@…`, `/channel/…`, `/c/…`, `/user/…`) or an Instagram profile is
 * "not playlists or channels"; anything else — another site, a malformed or cut-off link — is not a link the app takes
 * (review, 2026-11-06: a bad video id read as a playlist).
 */
function refusalOf(piece: string): string {
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(piece) ? piece : `https://${piece}`);
  } catch {
    return LINK_REFUSED;
  }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);
  const first = parts[0] ?? "";
  if (YT_HOSTS.has(host)) {
    const many = first === "playlist" || first.startsWith("@") || ["channel", "c", "user"].includes(first);
    const list = first === "watch" && u.searchParams.has("list") && !u.searchParams.get("v");
    return many || list ? LINK_NOT_SINGLE : LINK_REFUSED;
  }
  if (IG_HOSTS.has(host)) return parts.length === 1 && !IG_PAGES.has(first.toLowerCase()) ? LINK_NOT_SINGLE : LINK_REFUSED;
  return LINK_REFUSED;
}

/** The words for "and why": "single videos and posts only, not playlists or channels". */
const lowered = (words: string): string => words.charAt(0).toLowerCase() + words.slice(1).replace(" — ", ", ").replace(/\.$/, "");

/**
 * The one line a paste of several links needs beyond each link's own answer: how many it took and why not the rest —
 * "Took 1 of 3 — single videos and posts only, not playlists or channels." — or that it took the first five. Null when
 * it took everything pasted.
 */
export function pastedLine(p: PastedLinks): string | null {
  const total = p.links.length + p.cut + p.refused.length;
  const why = [...new Set(p.refused)].map(lowered);
  if (p.cut > 0) return `Took the first ${p.links.length} of ${total} — ${[`${LINKS_AT_ONCE} links at a time`, ...why].join("; ")}.`;
  if (p.refused.length === 0 || p.links.length === 0) return null;
  return `Took ${p.links.length} of ${total} — ${why.join("; ")}.`;
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
  /**
   * The batch its moves are in, or null while they wait for the next one (or there are none yet): the coach's saves
   * card lists the links an open batch doesn't hold (audit 2026-11-06, I6). Absent from an older Worker's answer.
   */
  batchId?: string | null;
}

export const WAITING_FOR_EXTENSION = "Waiting for your computer's extension";
/** The link field's answers (the popup's and the app's). */
export const ADDED_LINE = "Added — it'll be waiting in the coach.";

/**
 * The field's answer when several links went in at once (audit 2026-11-06, I4): how many were added, were in already,
 * or weren't added and why (the first refusal's words).
 */
export function severalAddedLine(o: { added: number; known: number; refused: readonly string[] }): string {
  if (o.added > 0 && o.known === 0 && o.refused.length === 0) return `Added ${o.added} — they'll be waiting in the coach.`;
  const parts = [o.added ? `Added ${o.added}` : "", o.known ? `${o.known} already in` : ""].filter(Boolean);
  if (o.refused.length) return [...parts, `${o.refused.length} not added: ${o.refused[0]}`].join(" · ");
  return `${parts.join(" · ")}.`;
}

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
