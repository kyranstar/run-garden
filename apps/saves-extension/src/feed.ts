import type { PostSubmit } from "@rg/saves";
import { FeedChangedError, PostGoneError } from "./errors.js";
import { COVER_WIDTH, MIN_IMAGE_WIDTH, pickVariant } from "./media.js";
import { shortcodeToPk } from "./shortcode.js";

export { FeedChangedError };

// The saved feed, read defensively: the site's web API is undocumented, so every field is checked, a missing optional
// one reads as empty, and a shape without the essentials (an items list; a code on each post) is FeedChangedError —
// nothing from that read is used.

/** The source name the app files these posts under. */
export const SOURCE = "instagram";
/** A check stops reading the feed after this many known posts in a row (or on a page that is all known). */
export const KNOWN_STREAK_STOP = 12;

export type MediaType = PostSubmit["mediaType"];

export interface FeedPost {
  /** The shortcode: the post's permanent key. */
  key: string;
  /** The canonical link: /reel/<code>/ for a video, /p/<code>/ otherwise. */
  url: string;
  /** The numeric post id, exact (a decimal string). */
  pk: string;
  creator: { handle: string; name?: string };
  caption: string;
  hashtags: string[];
  mediaType: MediaType;
  postedAt: string | null;
  /** The post's video (a carousel's first video slide), every size the site offers. */
  videoVariants: { width: number; height: number; url: string }[];
  /** One image per photo or carousel slide (a video slide by its cover), at about MIN_IMAGE_WIDTH. */
  images: { width: number; url: string }[];
  /** A cover thumbnail at about COVER_WIDTH, for the filter. */
  coverUrl: string | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

const CODE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CAPTION_MAX = 4000;
const HASHTAGS_MAX = 30;

/** The link the app stores and dedupes on: exactly this form, never with a query string. */
export function postUrl(code: string, mediaType: MediaType): string {
  return `https://www.instagram.com/${mediaType === "video" ? "reel" : "p"}/${code}/`;
}

function sizes(list: unknown): { width: number; height: number; url: string }[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((v) => {
    if (!isObj(v)) return [];
    const url = str(v.url);
    const width = typeof v.width === "number" ? v.width : NaN;
    if (!url?.startsWith("https://") || !(width > 0)) return [];
    return [{ width, height: typeof v.height === "number" ? v.height : 0, url }];
  });
}

const candidatesOf = (m: Obj) => sizes(isObj(m.image_versions2) ? m.image_versions2.candidates : undefined);

function hashtagsOf(caption: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of caption.matchAll(/#([\p{L}\p{N}_]+)/gu)) {
    const tag = match[1]!.slice(0, 60);
    if (seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
    if (out.length >= HASHTAGS_MAX) break;
  }
  return out;
}

/** The pk as sent when it came as a string; else the lead of `id` ("<pk>_<owner>"); else from the code. A numeric pk lost precision in JSON.parse, so it is never used. */
function pkOf(m: Obj, code: string): string {
  if (typeof m.pk === "string" && /^\d+$/.test(m.pk)) return m.pk;
  const lead = str(m.id)?.split("_")[0];
  if (lead && /^\d+$/.test(lead)) return lead;
  return shortcodeToPk(code);
}

function mediaTypeOf(m: Obj): MediaType {
  if (m.media_type === 2) return "video";
  if (m.media_type === 8) return "carousel";
  if (m.media_type === 1) return "image";
  if (Array.isArray(m.carousel_media)) return "carousel";
  return sizes(m.video_versions).length ? "video" : "image";
}

function parseMedia(m: unknown): FeedPost {
  if (!isObj(m)) throw new FeedChangedError();
  const code = str(m.code);
  if (!code || !CODE_RE.test(code)) throw new FeedChangedError();
  const user = isObj(m.user) ? m.user : {};
  const name = str(user.full_name)?.trim().slice(0, 120);
  const caption = ((isObj(m.caption) ? str(m.caption.text) : null) ?? "").slice(0, CAPTION_MAX);
  const mediaType = mediaTypeOf(m);
  const slides = mediaType === "carousel" && Array.isArray(m.carousel_media) ? m.carousel_media.filter(isObj) : [];
  const videoSource = mediaType === "video" ? m : slides.find((s) => sizes(s.video_versions).length > 0);
  const imageSources = mediaType === "video" ? [] : mediaType === "image" ? [m] : slides;
  const images = imageSources.flatMap((s) => {
    const c = candidatesOf(s);
    if (!c.length) return [];
    const { width, url } = pickVariant(c, MIN_IMAGE_WIDTH);
    return [{ width, url }];
  });
  const covers = candidatesOf(m).length ? candidatesOf(m) : slides[0] ? candidatesOf(slides[0]) : [];
  const takenAt = typeof m.taken_at === "number" && m.taken_at > 0 ? m.taken_at : null;
  return {
    key: code,
    url: postUrl(code, mediaType),
    pk: pkOf(m, code),
    creator: { handle: (str(user.username) ?? "").slice(0, 64), ...(name ? { name } : {}) },
    caption,
    hashtags: hashtagsOf(caption),
    mediaType,
    postedAt: takenAt ? new Date(takenAt * 1000).toISOString() : null,
    videoVariants: videoSource ? sizes(videoSource.video_versions) : [],
    images,
    coverUrl: covers.length ? pickVariant(covers, COVER_WIDTH).url : null,
  };
}

/** One page of the saved feed (`items[].media`), newest first, and the cursor of the next page (null on the last). */
export function parseFeedPage(json: unknown): { posts: FeedPost[]; nextMaxId: string | null } {
  if (!isObj(json) || !Array.isArray(json.items)) throw new FeedChangedError();
  const posts = json.items.map((item) => parseMedia(isObj(item) && isObj(item.media) ? item.media : item));
  const next = str(json.next_max_id);
  return { posts, nextMaxId: json.more_available !== false && next ? next : null };
}

/** The post-details answer (`items: [media]`) for one post. An empty answer is a post that is gone. */
export function parseMediaInfo(json: unknown): FeedPost {
  if (!isObj(json) || !Array.isArray(json.items)) throw new FeedChangedError();
  if (json.items.length === 0) throw new PostGoneError();
  return parseMedia(json.items[0]);
}

/** What `/posts` takes for a post (the cover is added when it is sent). */
export function toSubmit(post: FeedPost, source: string): PostSubmit {
  return {
    source,
    key: post.key,
    url: post.url,
    creator: post.creator.name ? { handle: post.creator.handle, name: post.creator.name } : { handle: post.creator.handle },
    caption: post.caption,
    hashtags: post.hashtags,
    mediaType: post.mediaType,
    postedAt: post.postedAt,
  };
}

/**
 * Whether to stop reading the feed after this page. Not at the first known post: a re-saved old post jumps to the top,
 * above new saves. It stops on a page where every key is known (an empty page too), or once `KNOWN_STREAK_STOP` known
 * keys have come in a row, counting across pages (`run.knownStreak` carries the count; a fresh key resets it).
 */
export function shouldStop(
  page: { keys: string[]; fresh: Set<string> },
  run: { knownStreak: number },
): { stop: boolean; knownStreak: number } {
  let knownStreak = run.knownStreak;
  let stop = page.keys.every((k) => !page.fresh.has(k));
  for (const k of page.keys) {
    knownStreak = page.fresh.has(k) ? 0 : knownStreak + 1;
    if (knownStreak >= KNOWN_STREAK_STOP) stop = true;
  }
  return { stop, knownStreak };
}
