import { z } from "zod";
import { addDays, isLocalDate } from "./time.js";

// ── The music dock (2026-10-17; one abstraction 2026-10-19) ──────────────────

/**
 * `music` in the user's preferences: the athlete's own playlists (or albums) — each one they linked in the dock,
 * picked from their Spotify playlists or pasted, played with shuffle on. The app builds nothing in their Spotify
 * account. Each keeps what Spotify says of it, read once when it is linked — its name, its description, its cover and
 * how many tracks it holds — and what it suits (`goodFor`), so a workout can play it. Absent until the athlete links
 * one (no migration: the preferences are JSON).
 *
 * `minecraftPlaylistId` is an earlier version's: still read so old preferences parse, and ignored.
 */

/** A Spotify id: base-62 (22 characters today; a little latitude either way costs nothing). */
export const SPOTIFY_ID_PATTERN = /^[A-Za-z0-9]{16,32}$/;
const CONTEXT_URI = /^spotify:(playlist|album):([A-Za-z0-9]{16,32})$/;
/** A saved playlist's id in the dock (and what a workout names it by). */
export const MUSIC_ID_PATTERN = /^[a-z0-9-]{1,40}$/;
/** A cover's address: Spotify's own image hosts, over https, and nothing else. */
const COVER_URL = /^https:\/\/(?:i|mosaic|image-cdn-[a-z0-9-]{1,20})\.(?:scdn\.co|spotifycdn\.com)\/[A-Za-z0-9/_.-]{1,200}$/;

/** The most playlists the dock keeps. */
export const MUSIC_SHORTCUTS_MAX = 12;
/** A playlist's label (what the dock shows; Spotify's name unless the athlete renames it), at most. */
export const MUSIC_LABEL_MAX = 60;
/** Spotify's name for it, as kept. */
export const MUSIC_NAME_MAX = 100;
/** Its description, made plain (`plainSpotifyText`) and clipped. */
export const MUSIC_DESCRIPTION_MAX = 300;

/**
 * What a playlist suits — a fixed set, the kinds of workout the app has (`workoutMusicKind`): mobility (the app's
 * "yoga" is mobility, and a yoga playlist is tagged so), winding down (a calm session), strength, and runs.
 */
export const MUSIC_GOOD_FOR = ["mobility", "wind-down", "strength", "run"] as const;
export type MusicGoodFor = (typeof MUSIC_GOOD_FOR)[number];
export const MUSIC_GOOD_FOR_LABELS: Record<MusicGoodFor, string> = {
  mobility: "Mobility",
  "wind-down": "Winding down",
  strength: "Strength",
  run: "Runs",
};

/** A cover address the dock may keep and show: Spotify's own image hosts only. */
export const isSpotifyCover = (url: unknown): url is string => typeof url === "string" && COVER_URL.test(url);

export type SpotifyContextKind = "playlist" | "album";

/** A playlist's or an album's Spotify URI, read: its kind and id. Anything else (a track, an artist, a link) is null. */
export function spotifyContextUri(uri: string): { kind: SpotifyContextKind; id: string } | null {
  const m = CONTEXT_URI.exec(uri);
  return m ? { kind: m[1] as SpotifyContextKind, id: m[2]! } : null;
}

const goodForSchema = z
  .array(z.enum(MUSIC_GOOD_FOR))
  .max(MUSIC_GOOD_FOR.length)
  .refine((list) => new Set(list).size === list.length, "a tag listed twice");

export const musicShortcutSchema = z
  .object({
    id: z.string().regex(MUSIC_ID_PATTERN, "a short id"),
    label: z.string().trim().min(1, "a label").max(MUSIC_LABEL_MAX),
    uri: z.string().regex(CONTEXT_URI, "a Spotify playlist or album"),
    shuffle: z.boolean().default(true),
    /** Spotify's name for it, read once when it was linked (absent: not read, or Spotify wouldn't say). */
    name: z.string().trim().min(1).max(MUSIC_NAME_MAX).optional(),
    /** Its description, plain text (an album's: who made it). */
    description: z.string().max(MUSIC_DESCRIPTION_MAX).optional(),
    image: z.string().regex(COVER_URL, "a Spotify cover").optional(),
    total: z.number().int().min(0).max(100_000).optional(),
    /** What it suits; absent until it is tagged (once, when linked — or, for one linked before tags, on the dock's
     * next open). Empty: tagged, and suits nothing in particular. */
    goodFor: goodForSchema.optional(),
  })
  .strict();
export type MusicShortcut = z.infer<typeof musicShortcutSchema>;

export const musicPreferencesSchema = z
  .object({
    shortcuts: z
      .array(musicShortcutSchema)
      .max(MUSIC_SHORTCUTS_MAX)
      .refine((list) => new Set(list.map((s) => s.id)).size === list.length, "a shortcut listed twice")
      .default([]),
    /** An earlier version's playlist built in the athlete's account: read, never used. */
    minecraftPlaylistId: z.string().regex(SPOTIFY_ID_PATTERN, "a Spotify id").optional(),
  })
  .strict();
export type MusicPreferences = z.infer<typeof musicPreferencesSchema>;

// ── Spotify's words, made plain ──────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** A code point as text, or a space for one that is no character to show (a control, a surrogate, out of range). */
function codePoint(n: number): string {
  if (!Number.isInteger(n) || n < 0x20 || (n >= 0x7f && n < 0xa0) || (n >= 0xd800 && n <= 0xdfff) || n > 0x10ffff) return " ";
  return String.fromCodePoint(n);
}

/** Clipped at a word, with an ellipsis, to at most `max` characters. */
export function clipWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = text.slice(0, Math.max(0, max - 1));
  // The room ends at a word's end when a space follows it: kept whole; else back to the last space (half way at most).
  const cut = text[room.length] === " " ? room.length : room.lastIndexOf(" ");
  return `${(cut > max / 2 ? room.slice(0, cut) : room).replace(/[\s,.;:–—-]+$/, "")}…`;
}

/**
 * A Spotify description as plain text: Spotify sends it HTML-escaped (`&amp;`, and links as `&lt;a href=…&gt;`). The
 * entities are decoded once, then every tag — and any angle bracket left — is dropped, so nothing in it reads as markup
 * wherever it is shown or sent; control characters and runs of space become one space; clipped at a word. Anything
 * that isn't text is "".
 */
export function plainSpotifyText(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  const decoded = raw.slice(0, 4 * max + 400).replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6});/gi, (whole, e: string) => {
    if (e[0] === "#") return codePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return NAMED_ENTITIES[e.toLowerCase()] ?? whole;
  });
  const plain = decoded
    // A tag starts with a letter, a slash or a bang, as HTML reads one ("a < b" is text, its bracket dropped below).
    .replace(/<[/!]?[a-z][^<>]*>/gi, " ")
    .replace(/[<>]/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clipWords(plain, max);
}

/** What a playlist suits, by the words of its name and description: the tagging's fallback when no model is asked. */
const KEYWORDS: ReadonlyArray<readonly [RegExp, readonly MusicGoodFor[]]> = [
  [/\b(spa|yoga|yin|pilates)\b/, ["mobility", "wind-down"]],
  [/\b(stretch\w*|mobility|flexib\w*|flows?)\b/, ["mobility"]],
  [/\b(calm\w*|chill\w*|relax\w*|sleep\w*|ambient|unwind\w*|wind[\s-]?down|meditat\w*|peaceful|lo-?fi|soothing|gentle|serene|zen|massage)\b/, ["wind-down"]],
  [/\b(gym|lift\w*|strength|weights?|power|pump|hiit|crossfit|squats?|deadlifts?|workout)\b/, ["strength"]],
  [/\b(run|runs|running|runner|jog\w*|cardio|marathon|tempo|bpm|race|pace|5k|10k)\b/, ["run"]],
];

export function keywordGoodFor(name: string, description: string): MusicGoodFor[] {
  const text = ` ${name} ${description} `.toLowerCase();
  const hit = new Set<MusicGoodFor>();
  for (const [re, tags] of KEYWORDS) if (re.test(text)) for (const t of tags) hit.add(t);
  return MUSIC_GOOD_FOR.filter((t) => hit.has(t));
}

// ── A workout's music ────────────────────────────────────────────────────────

/** The kinds of workout, for music: the tags a playlist carries. */
export type MusicKind = MusicGoodFor;

/** The categories that are runs (`WORKOUT_CATEGORIES`; "unknown" is an imported run). */
const RUN_CATEGORIES = new Set(["recovery", "easy", "long", "quality", "race", "unknown"]);

export interface MusicKindInput {
  /**
   * The workout's category: its planned row's — or, for a document with no row yet (a quick start, a template), the
   * category its document derives (`deriveDoc(doc).category`, @rg/workout: the same rule the row is filed by).
   */
  category: string | null | undefined;
  /** The session is calm: built in recovery mode, or its document's effort is "recover". */
  calm?: boolean;
}

/**
 * What kind of workout a session is, for its music — one rule, the server's and the app's, read from its category: a
 * run category is a run; strength is strength; the mobility category (the app's "yoga") is mobility, and winding down
 * when the session is calm. Rest, cross-training, or no category: none.
 */
export function workoutMusicKind(w: MusicKindInput): MusicKind | null {
  const category = w.category ?? null;
  if (category === null) return null;
  if (RUN_CATEGORIES.has(category)) return "run";
  if (category === "strength") return "strength";
  if (category === "yoga") return w.calm ? "wind-down" : "mobility";
  return null;
}

/** The tags a kind of workout plays, best first: mobility and winding down each take the other's after their own. */
export const KIND_TAGS: Readonly<Record<MusicKind, readonly MusicGoodFor[]>> = {
  mobility: ["mobility", "wind-down"],
  "wind-down": ["wind-down", "mobility"],
  strength: ["strength"],
  run: ["run"],
};

/** The athlete's choice for one workout: a playlist, no music, or the default (over the workout's own). */
export type MusicPick = { use: "playlist"; playlist: string } | { use: "none" } | { use: "default" };
/** A workout's own choice (its document's `music`): a playlist, or none. */
export type WorkoutMusic = { playlist: string | null };

export interface ResolvedMusic {
  shortcut: MusicShortcut | null;
  /** Whose choice it is: the athlete's for this workout, the workout's own, or the default for its kind. */
  source: "athlete" | "workout" | "default";
}

/** The first saved playlist good for a kind, in the order they are saved; null when none is. */
export function defaultMusicFor(kind: MusicKind | null, shortcuts: readonly MusicShortcut[]): MusicShortcut | null {
  if (!kind) return null;
  for (const tag of KIND_TAGS[kind]) {
    const hit = shortcuts.find((s) => s.goodFor?.includes(tag));
    if (hit) return hit;
  }
  return null;
}

/**
 * Which playlist a workout plays: the athlete's choice for it, else the workout's own, else the default for its kind.
 * A choice naming a playlist no longer saved counts as no choice.
 */
export function resolveWorkoutMusic(input: {
  shortcuts: readonly MusicShortcut[];
  kind: MusicKind | null;
  athlete?: MusicPick | null;
  workout?: WorkoutMusic | null;
}): ResolvedMusic {
  const find = (id: string) => input.shortcuts.find((s) => s.id === id) ?? null;
  const athlete = input.athlete ?? null;
  if (athlete?.use === "none") return { shortcut: null, source: "athlete" };
  if (athlete?.use === "playlist" && find(athlete.playlist)) return { shortcut: find(athlete.playlist), source: "athlete" };
  if (athlete?.use !== "default" && input.workout) {
    if (input.workout.playlist === null) return { shortcut: null, source: "workout" };
    const named = find(input.workout.playlist);
    if (named) return { shortcut: named, source: "workout" };
  }
  return { shortcut: defaultMusicFor(input.kind, input.shortcuts), source: "default" };
}

/** A workout document's `music` (workout-doc.ts): a saved playlist by its id, or none. Read leniently, as the document
 * is: a key a later version adds is dropped, never a refusal. */
export const workoutMusicSchema = z.object({ playlist: z.string().regex(MUSIC_ID_PATTERN, "a saved playlist's id").nullable() });

// ── The athlete's choices, per workout ───────────────────────────────────────

/** The most workouts the choices keep (the newest days). */
export const MUSIC_CHOICES_MAX = 60;
/** A choice for a workout dated this many days before today is still kept (one done a day late). */
export const MUSIC_CHOICE_GRACE_DAYS = 2;

export const musicChoiceSchema = z
  .object({
    /** The workout's day: what the choices are pruned by. */
    date: z.string().refine(isLocalDate, "a date"),
    use: z.enum(["playlist", "none", "default"]),
    playlist: z.string().regex(MUSIC_ID_PATTERN).optional(),
  })
  .strict()
  .refine((c) => (c.use === "playlist") === (c.playlist !== undefined), "a playlist only with use: playlist");
export type MusicChoice = z.infer<typeof musicChoiceSchema>;

/**
 * `musicChoices` in the preferences: per planned workout (by its id), the athlete's music for it, set from its sheet —
 * beside `music`, never inside it, so the dock's save of its playlists never writes over one. Pruned of past workouts.
 */
export const musicChoicesSchema = z
  .record(z.string().min(1).max(120), musicChoiceSchema)
  .refine((m) => Object.keys(m).length <= MUSIC_CHOICES_MAX, "too many");
export type MusicChoices = z.infer<typeof musicChoicesSchema>;

/** A stored choice as a pick (`resolveWorkoutMusic`). */
export function pickOf(choice: MusicChoice | null | undefined): MusicPick | null {
  if (!choice) return null;
  if (choice.use === "playlist") return choice.playlist ? { use: "playlist", playlist: choice.playlist } : null;
  return { use: choice.use };
}

/** The choices kept: none for a workout more than `MUSIC_CHOICE_GRACE_DAYS` gone, and the newest days at most. */
export function pruneMusicChoices(choices: MusicChoices, today: string): MusicChoices {
  const from = addDays(today, -MUSIC_CHOICE_GRACE_DAYS);
  const live = Object.entries(choices).filter(([, c]) => c.date >= from);
  live.sort((a, b) => (a[1].date === b[1].date ? a[0].localeCompare(b[0]) : b[1].date.localeCompare(a[1].date)));
  return Object.fromEntries(live.slice(0, MUSIC_CHOICES_MAX));
}
