import { EXERCISES } from "@rg/exercise-library";
import { buildExtractBody, postSubmitSchema } from "@rg/saves";
import type { CheckReport, PostSubmit, SaveErrorCode } from "@rg/saves";
import type { AppClient, FetchFailure } from "./app-client.js";
import { AppRefusedError, AppUnreachableError, CheckError, LoginNeededError, MediaError, PostGoneError, ReaderError } from "./errors.js";
import { parseFeedPage, parseMediaInfo, shouldStop, SOURCE, toSubmit, type FeedPost } from "./feed.js";
import { fetchAsBase64, MIN_VIDEO_WIDTH, nextSmaller, pickVariant } from "./media.js";
import type { FeedReader } from "./page-reader.js";
import type { ExtQueue, KvStore, QueueEntry } from "./queue.js";
import { shortcodeToPk } from "./shortcode.js";

export interface CheckConfig {
  source: string;
  /** The most feed pages one check reads (top of the feed and resumed backlog together). */
  maxPages: number;
  /** The most work-list posts one check takes. */
  maxWork: number;
  minVideoWidth: number;
  model: string;
  maxTokens: number;
  /**
   * The largest relay body to send; a bigger one steps down a size before sending. The gateway's limit (a 413 at about
   * 4.5 MB has been reported) until probe R2 measures it; a 413 naming the Worker's own cap lowers it for the check.
   */
  maxBodyBytes: number;
}

export const DEFAULT_CONFIG: CheckConfig = {
  source: SOURCE,
  maxPages: 20,
  maxWork: 20,
  minVideoWidth: MIN_VIDEO_WIDTH,
  model: "google/gemini-3.6-flash",
  maxTokens: 4000,
  maxBodyBytes: 4_500_000,
};

/** The library's own move names, sent with each post so the model reuses them for the same move. */
const LIBRARY_NAMES = EXERCISES.map((e) => e.name);

export interface CheckDeps {
  app: AppClient;
  reader: FeedReader;
  fetchImpl: typeof fetch;
  queue: ExtQueue;
  /** Where the feed's resume cursors live between checks (the same storage as the queue). */
  store: KvStore;
  now: () => number;
  config: CheckConfig;
  /** Waits between reads of the site (feed pages, single posts), so they come at a person's pace. None in tests. */
  pause?: () => Promise<void>;
}

export interface CheckSummary {
  checkId: string;
  startedAt: string;
  finishedAt: string;
  pages: number;
  found: number;
  fresh: number;
  submitted: number;
  filtered: number;
  extracted: number;
  failed: number;
  error: { code: SaveErrorCode; message: string } | null;
}

/**
 * Where an earlier check stopped reading a backlog it could not finish (a page cap, or a failed read past the first page),
 * newest region first: the site's cursor, how many resumes from it failed, and when it was saved.
 */
interface SavedCursor {
  cursor: string;
  failures: number;
  savedAt: string;
}
interface ScanState {
  cursors: SavedCursor[];
}
const SCAN_KEY = "scan";
const MAX_CURSORS = 5;
/** A cursor is given up after this many failed resumes, or once it is this old (the site's cursors may expire). */
const CURSOR_MAX_FAILURES = 2;
const CURSOR_MAX_AGE_MS = 24 * 3_600_000;
const CURSOR_GIVEN_UP = "Stopped resuming an unfinished read of the saved list; older saves past it may be missed";

function savedCursors(raw: unknown, now: string): SavedCursor[] {
  const list = (raw as { cursors?: unknown } | undefined)?.cursors;
  if (!Array.isArray(list)) return [];
  return list.flatMap((c): SavedCursor[] => {
    if (typeof c === "string") return [{ cursor: c, failures: 0, savedAt: now }];
    const o = c as Partial<SavedCursor> | null;
    return o && typeof o.cursor === "string" && typeof o.savedAt === "string"
      ? [{ cursor: o.cursor, failures: typeof o.failures === "number" ? o.failures : 0, savedAt: o.savedAt }]
      : [];
  });
}

/** The cover sent with a submit must fit the app's schema (a small image, one of three types). */
const COVER_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const COVER_MAX_BASE64 = 400_000;

interface SubmitPayload {
  post: PostSubmit;
  coverUrl: string | null;
}

/** UTF-8 length without copying the string. */
function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/**
 * One check, in order: report the start; send what the last check left in the queue; read the feed (newest first,
 * stopping by `shouldStop`, then resuming any backlog a page cap left, at most `maxPages` pages in all), asking `/known`
 * per page; submit each fresh post, newest last, with its cover; extract each post the filter queued; then take the
 * app's work list (filter work first, at most `maxWork`); report the finish with the counts and the error.
 *
 * Every app call goes through the persistent queue, so an outage leaves the rest of the work queued, sent first next
 * time. Extractions run one at a time. The check's `error` is only ever the check's own (a login, a changed site, the
 * import budget, the app unreachable or refusing, a read that ended the scan, a backlog given up): one post that could
 * not be sent only counts in `failed`, and is told to the app when it could not be fetched at all.
 */
export async function runCheck(deps: CheckDeps): Promise<CheckSummary> {
  const { app, reader, queue, store, config } = deps;
  const pause = deps.pause ?? (async () => undefined);
  const iso = () => new Date(deps.now()).toISOString();
  const s: CheckSummary = {
    checkId: crypto.randomUUID(),
    startedAt: iso(),
    finishedAt: "",
    pages: 0,
    found: 0,
    fresh: 0,
    submitted: 0,
    filtered: 0,
    extracted: 0,
    failed: 0,
    error: null,
  };
  /** Posts read this check, by key: their media links are fresh, so an extraction needs no second read. */
  const posts = new Map<string, FeedPost>();
  /** Keys submitted or extracted this check: the work list does not hand them over again. */
  const handled = new Set<string>();
  let budgetPaused = false;

  /** The relay body limit: the config's, lowered for the rest of the check by a 413 that names the Worker's own cap. */
  let bodyLimit = config.maxBodyBytes;

  /** One post could not be sent: counted, never the check's error (spec §12). */
  const postFailed = () => {
    s.failed++;
  };

  /** One post could not be sent at all: counted, and told to the app, whose work list then stops handing it out first. */
  const fetchFailed = async (source: string, key: string, code: FetchFailure): Promise<void> => {
    s.failed++;
    await app.reportFailed(source, key, code);
  };

  const readPost = async (key: string): Promise<FeedPost> => {
    await pause();
    const post = parseMediaInfo(await reader.readPost(shortcodeToPk(key)));
    posts.set(key, post);
    return post;
  };

  /** Queue a post's submit. One the app's schema would refuse is counted as failed instead (it could never pass). */
  async function enqueueSubmit(post: FeedPost, source: string): Promise<void> {
    const payload: SubmitPayload = { post: toSubmit(post, source), coverUrl: post.coverUrl };
    if (!postSubmitSchema.safeParse(payload.post).success) {
      handled.add(post.key);
      return postFailed();
    }
    await queue.push({ kind: "submit", source, key: post.key, payload });
  }

  async function withCover(payload: SubmitPayload): Promise<PostSubmit> {
    if (!payload.coverUrl) return payload.post;
    try {
      const cover = await fetchAsBase64(payload.coverUrl, deps.fetchImpl, "image/jpeg");
      if (!COVER_MIMES.has(cover.mime) || cover.base64.length > COVER_MAX_BASE64) return payload.post;
      return { ...payload.post, cover: { mime: cover.mime as "image/jpeg", base64: cover.base64 } };
    } catch {
      return payload.post; // the filter reads the caption without it
    }
  }

  async function sendSubmit(entry: QueueEntry): Promise<void> {
    const submit = await withCover(entry.payload as SubmitPayload);
    let answer;
    try {
      answer = await app.submitPost(submit);
    } catch (e) {
      // A request the app finds invalid will never pass: drop it and count it. Anything else ends the check.
      if (e instanceof AppRefusedError && (e.status === 400 || e.status === 422)) {
        handled.add(entry.key);
        postFailed();
        return;
      }
      throw e;
    }
    s.submitted++;
    handled.add(entry.key);
    if (answer.status === "filtered_out") s.filtered++;
    if (answer.status === "queued") await queue.push({ kind: "extract", source: entry.source, key: entry.key });
  }

  /**
   * Fetch a post's media and call the relay: one retry, either with the issues on `model_failed` or a size down on
   * `too_large`. A post that is gone, whose media would not download, or that no size can send is told to the app. A 409
   * or 404 (a replay or work item the app no longer wants) is nothing to do.
   */
  async function sendExtract(entry: QueueEntry): Promise<void> {
    if (budgetPaused) return; // the app keeps the post queued; its work list hands it back once the budget has room
    handled.add(entry.key);
    let post: FeedPost;
    try {
      post = posts.get(entry.key) ?? (await readPost(entry.key));
    } catch (e) {
      if (e instanceof PostGoneError) return fetchFailed(entry.source, entry.key, "gone");
      throw e; // a login, a changed site or a read error is the check's
    }
    try {
      const images: { mime: string; base64: string }[] = [];
      for (const img of post.images) {
        const { mime, base64 } = await fetchAsBase64(img.url, deps.fetchImpl, "image/jpeg");
        images.push({ mime, base64 });
      }
      let variant = post.videoVariants.length ? pickVariant(post.videoVariants, config.minVideoWidth) : null;
      // The video is downloaded once per size: a retry with the issues reuses it.
      let video: { mime: string; base64: string } | undefined;
      let videoUrl: string | null = null;
      let retryIssues: string[] | undefined;
      let retried = false;
      for (;;) {
        if (variant && videoUrl !== variant.url) {
          const got = await fetchAsBase64(variant.url, deps.fetchImpl, "video/mp4");
          video = { mime: got.mime, base64: got.base64 };
          videoUrl = variant.url;
        }
        const body = buildExtractBody({
          model: config.model,
          post: toSubmit(post, entry.source),
          video,
          images,
          libraryNames: LIBRARY_NAMES,
          retryIssues,
          maxTokens: config.maxTokens,
        });
        if (utf8Length(body) > bodyLimit) {
          // Over the limit the gateway or the Worker would refuse it: try a smaller size before sending anything.
          const smaller = variant ? nextSmaller(post.videoVariants, variant.width) : null;
          if (!smaller) return fetchFailed(entry.source, entry.key, "too_large");
          variant = smaller;
          continue;
        }
        const answer = await app.extract(entry.source, entry.key, body, { model: config.model, maxTokens: config.maxTokens });
        if (answer.ok) {
          s.extracted++;
          return;
        }
        if (answer.code === "budget_paused") {
          // Check-wide, so it outranks a single post's error.
          budgetPaused = true;
          s.error = { code: "budget_paused", message: "Paused — import budget" };
          return;
        }
        if (answer.code === "conflict" || answer.code === "not_found") {
          // The app has nothing to extract here (done already, or another call holds it); after our own retry, the
          // retry was refused.
          if (retried) postFailed();
          return;
        }
        if (!retried && answer.code === "model_failed" && answer.issues?.length) {
          retried = true;
          retryIssues = answer.issues;
          continue;
        }
        if (answer.code === "too_large") {
          if (answer.maxBytes) bodyLimit = Math.min(bodyLimit, answer.maxBytes);
          const smaller = variant ? nextSmaller(post.videoVariants, variant.width) : null;
          if (!retried && smaller) {
            retried = true;
            variant = smaller;
            continue;
          }
        }
        return postFailed();
      }
    } catch (e) {
      if (e instanceof MediaError) return fetchFailed(entry.source, entry.key, "media_failed");
      throw e;
    }
  }

  /**
   * Send the queue, head first; each entry leaves it once the app has answered. An app outage, a refused token or a
   * login keeps the entry (the same call can work later) and ends the check. Any other failure drops it, so no entry
   * can block the queue for good: an extract the app still wants comes back through its work list, and a submit that
   * failed for its own reason is counted as failed.
   */
  async function drain(): Promise<void> {
    for (let entry = await queue.peek(); entry; entry = await queue.peek()) {
      try {
        if (entry.kind === "submit") await sendSubmit(entry);
        else await sendExtract(entry);
      } catch (e) {
        const keep = e instanceof AppUnreachableError || e instanceof AppRefusedError || e instanceof LoginNeededError;
        if (!keep) await queue.ack(entry.id);
        if (e instanceof CheckError) throw e; // the site or the app is not answering: the check ends
        postFailed();
        continue;
      }
      await queue.ack(entry.id);
    }
  }

  /**
   * Read the feed: the top until `shouldStop`, then each saved cursor (a backlog an earlier check's page cap left), all
   * within `maxPages`. Returns the fresh posts, newest first, and the cursors to keep. A login or a changed feed throws:
   * nothing from that partial read is submitted, and the next check reads it again from the top. Any other failed read
   * past the first page keeps what was read and leaves a cursor at the failed page. A cursor is given up (and that is
   * the check's error, once) after `CURSOR_MAX_FAILURES` failed resumes or once older than `CURSOR_MAX_AGE_MS`.
   */
  async function scan(): Promise<{ fresh: FeedPost[]; cursors: SavedCursor[] }> {
    const now = iso();
    const giveUp = () => {
      s.error ??= { code: "unknown", message: CURSOR_GIVEN_UP };
    };
    const live = savedCursors(await store.get(SCAN_KEY), now).filter((c) => {
      const fresh = deps.now() - Date.parse(c.savedAt) <= CURSOR_MAX_AGE_MS;
      if (!fresh) giveUp();
      return fresh;
    });
    const fresh: FeedPost[] = [];
    const freshKeys = new Set<string>();
    const cursors: SavedCursor[] = [];
    for (const saved of [null, ...live]) {
      if (s.pages >= config.maxPages) {
        if (saved) cursors.push(saved); // not reached this time: kept for the next check
        continue;
      }
      let maxId: string | null = saved?.cursor ?? null;
      let run = { knownStreak: 0 };
      for (;;) {
        if (s.pages > 0) await pause();
        let raw: unknown;
        try {
          raw = await reader.readSavedPage(maxId);
        } catch (e) {
          // Past the first page, a failed read (a rate limit, a cursor the site refuses) keeps what was read and resumes
          // at this page next check, so one bad page cannot stop new saves at the top. A login ends the check.
          if (!(e instanceof ReaderError) || maxId === null) throw e;
          const again = saved !== null && maxId === saved.cursor;
          const failures = again ? saved.failures + 1 : 1;
          if (failures >= CURSOR_MAX_FAILURES) giveUp();
          else {
            cursors.push({ cursor: maxId, failures, savedAt: again ? saved.savedAt : now });
            s.error ??= { code: e.code, message: e.message };
          }
          break;
        }
        const page = parseFeedPage(raw);
        s.pages++;
        s.found += page.posts.length;
        const keys = page.posts.map((p) => p.key);
        const freshOnPage = keys.length ? new Set(await app.known(config.source, keys)) : new Set<string>();
        for (const p of page.posts) {
          if (!freshOnPage.has(p.key) || freshKeys.has(p.key)) continue;
          freshKeys.add(p.key);
          fresh.push(p);
        }
        const verdict = shouldStop({ keys, fresh: freshOnPage }, run);
        run = { knownStreak: verdict.knownStreak };
        if (verdict.stop || page.nextMaxId === null) break;
        if (s.pages >= config.maxPages) {
          // The backlog goes on below here: the next check resumes from it.
          cursors.push({ cursor: page.nextMaxId, failures: 0, savedAt: now });
          break;
        }
        maxId = page.nextMaxId;
      }
    }
    s.fresh = fresh.length;
    return { fresh, cursors: cursors.slice(0, MAX_CURSORS) };
  }

  async function work(): Promise<void> {
    const items = (await app.work()).slice(0, config.maxWork);
    const ordered = [...items.filter((i) => i.action === "filter"), ...items.filter((i) => i.action !== "filter")];
    for (const item of ordered) {
      if (handled.has(item.key)) continue;
      if (item.action === "filter") {
        // Re-read the post (a fresh cover) and submit it again: the app runs its filter once more.
        let post: FeedPost;
        try {
          post = await readPost(item.key);
        } catch (e) {
          if (e instanceof PostGoneError) {
            handled.add(item.key);
            await fetchFailed(item.source, item.key, "gone");
            continue;
          }
          throw e;
        }
        await enqueueSubmit(post, item.source);
      } else {
        await queue.push({ kind: "extract", source: item.source, key: item.key });
      }
      await drain();
    }
  }

  try {
    await app.reportCheck({ checkId: s.checkId, phase: "start" });
    await drain(); // what the last check could not send goes first
    const { fresh, cursors } = await scan();
    for (const post of [...fresh].reverse()) {
      posts.set(post.key, post);
      await enqueueSubmit(post, config.source);
    }
    await store.set(SCAN_KEY, { cursors } satisfies ScanState);
    await drain();
    await work();
  } catch (e) {
    const err = e instanceof CheckError ? e : new CheckError("unknown", e instanceof Error ? e.message : String(e));
    s.error = { code: err.code, message: err.message };
  }

  s.finishedAt = iso();
  const report: CheckReport = {
    checkId: s.checkId,
    phase: "finish",
    found: s.found,
    fresh: s.fresh,
    filtered: s.filtered,
    extracted: s.extracted,
    failed: s.failed,
    ...(s.error ? { error: s.error } : {}),
  };
  await app.reportCheck(report).catch(() => undefined); // an unreachable app already shows in the error
  return s;
}

/** Wraps a task so a second call while one runs joins it instead of starting another: checks never overlap. */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | null = null;
  return () => {
    running ??= fn().finally(() => {
      running = null;
    });
    return running;
  };
}
