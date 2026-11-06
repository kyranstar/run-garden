import { normalizeLink, postSubmitSchema, type NormalLink, type SaveErrorCode, type WorkItem } from "@rg/saves";
import type { AppClient } from "./app-client.js";
import { AppRefusedError, AppUnreachableError, CheckError, LoginNeededError, TOKEN_REFUSED } from "./errors.js";
import type { AddLinkAnswer } from "./status.js";
import type { KvStore } from "./queue.js";
import { toYoutubeSubmit } from "./youtube.js";
import type { YoutubeRead } from "./youtube-reader.js";

// PASTED LINKS IN THE EXTENSION (design 2026-11-05 §3.1, §5.1, §14.4). A link pasted in the popup waits in a queue kept
// in storage until the app has its post; the runner reads one at a time (YouTube: the page reader; Instagram: the
// single-post reader and the check's own queue), under the same lock as the saved-list check. It also takes the app's
// work that is the extension's to do without touching the saved list: links pasted on the phone, and videos to screen
// or read again (Watch it too, Retry) — asked every 15 minutes.

export interface LocalLink extends NormalLink {
  addedAt: string;
  /** Why the last read failed, when the app couldn't be told (else the link left the queue). Null while waiting. */
  error: { code: string; message: string } | null;
}

const STORAGE_KEY = "links";
const MAX_LINKS = 50;

/** The links waiting for the app, in storage (a closed laptop or an outage loses none). Single-flight: no concurrent writes. */
export class LinkQueue {
  constructor(private readonly store: KvStore) {}

  async all(): Promise<LocalLink[]> {
    const raw = await this.store.get(STORAGE_KEY);
    return Array.isArray(raw) ? (raw as LocalLink[]) : [];
  }

  private async save(list: LocalLink[]): Promise<void> {
    await this.store.set(STORAGE_KEY, list.slice(-MAX_LINKS));
  }

  /** Adds a link at the back; one already there has its error cleared (the popup's Retry). True when it was new. */
  async add(link: NormalLink, at: string): Promise<boolean> {
    const list = await this.all();
    const there = list.find((l) => l.source === link.source && l.key === link.key);
    if (there) {
      if (there.error) {
        there.error = null;
        await this.save(list);
      }
      return false;
    }
    list.push({ ...link, addedAt: at, error: null });
    await this.save(list);
    return true;
  }

  /** The first link with no error. */
  async next(): Promise<LocalLink | null> {
    return (await this.all()).find((l) => !l.error) ?? null;
  }

  async fail(source: string, key: string, error: { code: string; message: string }): Promise<void> {
    const list = await this.all();
    const l = list.find((x) => x.source === source && x.key === key);
    if (!l) return;
    l.error = error;
    await this.save(list);
  }

  async done(source: string, key: string): Promise<void> {
    const list = await this.all();
    const rest = list.filter((l) => !(l.source === source && l.key === key));
    if (rest.length !== list.length) await this.save(rest);
  }
}

/**
 * A link from the popup's field (already normalized): told to the app at once (so the phone shows it; already in answers
 * when), then queued and read in the background. An app that can't be reached doesn't lose it: it is queued and the
 * answer says it waits. An app that says no — a refused token, the import off, a link it doesn't take — queues nothing
 * and says why (audit 2026-11-06, I1: a 401 read "Added" and the link sat on "Reading" for good).
 */
export async function addPastedLink(
  deps: { app: Pick<AppClient, "addLink">; queue: LinkQueue; now: () => number },
  link: NormalLink,
): Promise<AddLinkAnswer> {
  try {
    const answer = await deps.app.addLink(link.url);
    if (answer.state === "known") return { ok: true, known: { postId: answer.postId, firstSeenAt: answer.firstSeenAt } };
    if (answer.state === "refused") return { ok: false, message: answer.message };
  } catch (e) {
    if (e instanceof AppRefusedError) return { ok: false, message: e.status === 401 ? TOKEN_REFUSED : e.message };
    if (!(e instanceof AppUnreachableError)) throw e;
    await deps.queue.add(link, new Date(deps.now()).toISOString());
    return { ok: true, added: true, waiting: true };
  }
  await deps.queue.add(link, new Date(deps.now()).toISOString());
  return { ok: true, added: true };
}

/**
 * A pasted Instagram post sent through the check's queue (`enqueue`, then `run` in queue mode): a submit that couldn't be
 * queued (its details don't fit the app's format) or that the app refused is a failure with its reason, so the link
 * reaches an end on the app instead of waiting to be read again every 15 minutes (final audit G11).
 */
export async function sendPastedInstagram(
  enqueue: () => Promise<boolean>,
  run: () => Promise<{ submitted: number; error: { code: SaveErrorCode; message: string } | null }>,
): Promise<void> {
  if (!(await enqueue())) throw new CheckError("unknown", "The post's details didn't fit");
  const s = await run();
  if (s.error?.code === "app_unreachable") throw new AppUnreachableError(s.error.message);
  if (s.submitted === 0) throw new CheckError(s.error?.code ?? "unknown", s.error?.message ?? "The app refused the post");
}

export interface LinksDeps {
  app: Pick<AppClient, "work" | "submitPost" | "extractVideo" | "reportReadFailed" | "reportFailed">;
  queue: LinkQueue;
  now: () => number;
  /** Reads one video (youtube-reader.ts `readYoutube`). */
  youtube: (id: string) => Promise<YoutubeRead>;
  /** Reads one Instagram post and sends it (and its reading) through the check's queue; throws the site's errors. */
  instagram: (key: string) => Promise<void>;
  config: { model: string; maxTokens: number; extVersion: string };
}

export interface LinksSummary {
  read: number;
  failed: number;
  /** What ended the run early (the app unreachable, a login), else null. */
  error: SaveErrorCode | null;
}

/** Ends the run: the app or the site can't be used now; the link stays, with no error of its own. */
class StopRun extends Error {
  constructor(readonly code: SaveErrorCode) {
    super(code);
  }
}

/**
 * One run: the app's work (`?v=2`) — links to read join the queue — then the queue one link at a time, then the app's
 * video work (screen again: read and submit; read again: ask for the reading). Never two at once: the caller holds the lock.
 */
export async function runLinks(deps: LinksDeps): Promise<LinksSummary> {
  const { app, queue, config } = deps;
  const out: LinksSummary = { read: 0, failed: 0, error: null };
  const at = () => new Date(deps.now()).toISOString();
  let budgetPaused = false;

  const stopOn = (e: unknown): never => {
    if (e instanceof AppUnreachableError) throw new StopRun("app_unreachable");
    if (e instanceof AppRefusedError && e.status === 401) throw new StopRun("unknown");
    if (e instanceof LoginNeededError) throw new StopRun("login_needed");
    throw e;
  };

  /** A read that failed: told to the app (the link then leaves the queue), or kept here with its reason. */
  const failed = async (link: NormalLink, code: SaveErrorCode, message: string) => {
    out.failed++;
    if (await app.reportReadFailed({ source: link.source, key: link.key, code, message })) await queue.done(link.source, link.key);
    else await queue.fail(link.source, link.key, { code, message });
  };

  /** A video's reading, asked once more with the issues when the app refuses the reply with them. */
  const readVideo = async (key: string) => {
    if (budgetPaused) return;
    let answer = await app.extractVideo(key, { model: config.model, maxTokens: config.maxTokens }).catch(stopOn);
    if (!answer.ok && answer.code === "model_failed" && answer.issues?.length) {
      answer = await app.extractVideo(key, { model: config.model, maxTokens: config.maxTokens, retryIssues: answer.issues }).catch(stopOn);
    }
    if (!answer.ok && answer.code === "budget_paused") budgetPaused = true;
  };

  /** Read a video and send it; its reading when the app keeps it for one. False when the read failed. */
  /** A video read for the app's own work (`held`: the app has its post) or for a pasted link. */
  const youtube = async (link: NormalLink, held = false): Promise<boolean> => {
    const r = await deps.youtube(link.key);
    if (!r.ok) {
      await failed(link, r.code, r.message);
      // YouTube asking to sign in meets every video until the owner does: told once, and the run ends — the links after
      // it wait, unread, like Instagram's login (audit 2026-11-06, I3).
      if (r.code === "youtube_login") throw new StopRun("youtube_login");
      // A video the app holds that is gone or won't play any more leaves its work list (final review F3).
      if (held && (r.code === "gone" || r.code === "unplayable")) await app.reportFailed(link.source, link.key, "gone").catch(stopOn);
      return false;
    }
    const submit = toYoutubeSubmit(r.meta, r.transcript, r.chapters, config.extVersion, r.ms);
    if (!postSubmitSchema.safeParse(submit).success) {
      await failed(link, "unknown", "The video's details didn't fit");
      return false;
    }
    let answer;
    try {
      answer = await app.submitPost(submit);
    } catch (e) {
      if (e instanceof AppRefusedError && (e.status === 400 || e.status === 422)) {
        await failed(link, "unknown", "The app refused the video");
        return false;
      }
      return stopOn(e);
    }
    await queue.done(link.source, link.key);
    out.read++;
    if (answer.status === "queued") await readVideo(link.key);
    return true;
  };

  const one = async (link: NormalLink) => {
    if (link.source === "youtube") return void (await youtube(link));
    try {
      await deps.instagram(link.key);
    } catch (e) {
      if (e instanceof CheckError && !(e instanceof LoginNeededError) && !(e instanceof AppUnreachableError) && !(e instanceof AppRefusedError)) {
        return void (await failed(link, e.code, e.message));
      }
      return stopOn(e);
    }
    await queue.done(link.source, link.key);
    out.read++;
  };

  try {
    const items: WorkItem[] = await app.work({ links: true }).catch(stopOn);
    for (const item of items) {
      if (item.action !== "read") continue;
      const link = normalizeLink(item.url);
      if (link) await queue.add(link, at());
    }
    for (let link = await queue.next(); link; link = await queue.next()) await one(link);
    for (const item of items) {
      if (item.source !== "youtube" || item.action === "read") continue;
      if (item.action === "extract") await readVideo(item.key);
      else await youtube({ source: "youtube", key: item.key, url: item.url }, true);
    }
  } catch (e) {
    if (!(e instanceof StopRun)) throw e;
    out.error = e.code;
  }
  return out;
}
