/**
 * The seed script's pure part (saved-posts import, plan Task 20 Step 1; spec §9 "Seed"): one record of the first
 * capture's private post file → one `POST /api/saves/posts` body (without its `source`, which is the command's
 * `--source`) carrying a `seed`. The training categories (strength, mobility/stretching, jaw/neck, posture/desk, general
 * fitness) are `queued` — the bootstrap extracts them; everything else is `filtered_out`, "not training (first capture)".
 * A seeded post is never filtered (the ledger takes the seed's status), so seeding costs nothing.
 *
 * The capture's records are read loosely — they were written by hand-run agents, not by this app: the key (`key`,
 * `shortcode` or `code`), the post's link (`url`, `postUrl` or `link`; a web page's only), the creator (a handle string,
 * or `{handle|username, name|fullName}`, or `owner`), the category (`category` or `categories`, a string or a list; any
 * training one makes the post training), and, when present, the caption, hashtags (else the caption's), media type and
 * date. Every field is cut to the route's own limits (`postSubmitSchema`); a record the route could not take (no key,
 * no web link) is null — the command counts and skips it. Nothing here names a site, a post or a person.
 */

/** The spec's training categories (§9), as the capture names them. */
export const TRAINING_CATEGORIES = Object.freeze(["strength", "mobility/stretching", "jaw/neck", "posture/desk", "general fitness"]);
export const TRAINING_REASON = "training (first capture)";
export const NOT_TRAINING_REASON = "not training (first capture)";

const KEY_MAX = 64;
const URL_MAX = 500;
const HANDLE_MAX = 64;
const NAME_MAX = 120;
const CAPTION_MAX = 4000;
const HASHTAGS_MAX = 30;
const HASHTAG_MAX = 60;
const POSTED_AT_MAX = 40;
/** A web page's scheme (spelled in parts, so the repository's privacy grep reads no link here). */
export const WEB_PROTOCOL = ["ht", "tps:"].join("");

/** A category as compared: lower case, words only ("Jaw / Neck" → "jaw neck"). */
const words = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** Each training category, and each part of a paired one ("mobility/stretching" → mobility, stretching), as `words` reads it. */
const TRAINING_WORDS = new Set(
  TRAINING_CATEGORIES.flatMap((c) => [words(c), ...c.split("/").map(words)]),
);

/** Does the record's category (a string or a list) name a training one? */
export function isTraining(category) {
  const list = Array.isArray(category) ? category : [category];
  return list.some((c) => TRAINING_WORDS.has(words(c)));
}

const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const first = (...vs) => vs.map(str).find((v) => v !== null) ?? null;

function webLink(v) {
  const s = str(v);
  if (!s || s.length > URL_MAX) return null;
  try {
    return new URL(s).protocol === WEB_PROTOCOL ? s : null;
  } catch {
    return null;
  }
}

function creatorOf(r) {
  const c = r.creator ?? r.owner ?? r.handle ?? null;
  const handle = typeof c === "string" ? str(c) : c && typeof c === "object" ? first(c.handle, c.username) : null;
  const name = c && typeof c === "object" ? first(c.name, c.fullName, c.full_name) : null;
  return { handle: (handle ?? "").slice(0, HANDLE_MAX), ...(name ? { name: name.slice(0, NAME_MAX) } : {}) };
}

function hashtagsOf(r, caption) {
  const given = Array.isArray(r.hashtags) ? r.hashtags.filter((h) => typeof h === "string") : null;
  const tags = given ?? [...caption.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1]);
  return [...new Set(tags.map((t) => t.replace(/^#/, "").trim()).filter(Boolean))].slice(0, HASHTAGS_MAX).map((t) => t.slice(0, HASHTAG_MAX));
}

/** The media type the route takes, from the capture's word or the site's numeric code (1 image, 2 video, 8 carousel). */
function mediaTypeOf(r) {
  const t = r.mediaType ?? r.media_type ?? r.type;
  if (t === 1 || t === "1") return "image";
  if (t === 8 || t === "8") return "carousel";
  const w = words(t);
  if (/carousel|sidecar|album/.test(w)) return "carousel";
  if (/image|photo|picture/.test(w)) return "image";
  return "video";
}

function postedAtOf(r) {
  const t = r.postedAt ?? r.takenAt ?? r.taken_at ?? r.timestamp ?? null;
  if (typeof t === "number" && Number.isFinite(t)) return new Date(t < 1e12 ? t * 1000 : t).toISOString();
  const s = str(t);
  return s && s.length <= POSTED_AT_MAX ? s : null;
}

/** One capture record → the post's submit body (no `source`) with its seed; null when the route could not take it. */
export function toSeed(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const key = first(record.key, record.shortcode, record.code);
  const url = webLink(record.url ?? record.postUrl ?? record.link);
  if (!key || key.length > KEY_MAX || !url) return null;
  const caption = (typeof record.caption === "string" ? record.caption : "").slice(0, CAPTION_MAX);
  const postedAt = postedAtOf(record);
  const training = isTraining(record.category ?? record.categories);
  return {
    key,
    url,
    creator: creatorOf(record),
    caption,
    hashtags: hashtagsOf(record, caption),
    mediaType: mediaTypeOf(record),
    ...(postedAt ? { postedAt } : {}),
    seed: training ? { status: "queued", reason: TRAINING_REASON } : { status: "filtered_out", reason: NOT_TRAINING_REASON },
  };
}
