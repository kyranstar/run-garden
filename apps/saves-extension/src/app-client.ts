import { SAVE_ERROR_CODES } from "@rg/saves";
import type { CheckReport, ImportHealthDto, LinkDto, PostSubmit, SaveErrorCode, SavePostStatus, SavesStatusDto, WorkItem } from "@rg/saves";
import { AppRefusedError, AppUnreachableError } from "./errors.js";

// The app's token routes (`/api/saves/*`). The token travels only in the Authorization header: never in a URL, a log
// line or an error message.

export interface SubmitAnswer {
  status: SavePostStatus;
  verdict?: string;
  reason?: string;
  errorCode?: string;
}

/**
 * The relay's answer: done, or the code it refused with — for `model_failed`, the issues to retry with; for the Worker's
 * own `too_large`, its body cap (`maxBytes`).
 */
export type ExtractAnswer =
  | { ok: true }
  | { ok: false; code: SaveErrorCode | "not_found" | "conflict"; issues?: string[]; maxBytes?: number };

/** What the relay is told about a call: the model, its output cap, and the prompt it carries (version and text hash). */
export interface ExtractOpts {
  model: string;
  maxTokens: number;
  promptVersion?: string;
  promptSha?: string;
  /** The issues this call retries with (our own schema's words): the app rebuilds the prompt as sent from them. */
  retryIssues?: string[];
  /** What was fetched for this call (import trail): the video's size sent, its bytes, whether by link, the images. */
  readFacts?: { variantWidth: number | null; bytes: number; byLink: boolean; images: number };
}

/** A read that failed before the app had the post (or before any post: a login): `POST /api/saves/read-failed`. */
export interface ReadFailure {
  source: string;
  key?: string;
  code: SaveErrorCode;
  message: string;
}

/** The app's answer to a pasted link: taken, already imported (and when), or not a link it takes (its words). */
export type AddLinkAnswer = { state: "added" } | { state: "known"; postId: string; firstSeenAt: string } | { state: "refused"; message: string };

/** What a video's reading is told: the model, its output cap, and the issues it retries with. */
export interface VideoOpts {
  model: string;
  maxTokens: number;
  retryIssues?: string[];
}

/** Why a post could not be sent at all (`POST /posts/:key/failed`). */
export type FetchFailure = "gone" | "media_failed" | "too_large";

export interface AppClient {
  reportCheck(report: CheckReport): Promise<void>;
  /** Of `keys`, the ones the app has never seen. */
  known(source: string, keys: string[]): Promise<string[]>;
  submitPost(post: PostSubmit): Promise<SubmitAnswer>;
  /** `links`: this extension reads pasted links and videos (`?v=2`): the list hands them out too. */
  work(opts?: { links?: boolean }): Promise<WorkItem[]>;
  /** `body` is the gateway JSON (`buildExtractBody`), sent as a string so the request carries a Content-Length. */
  extract(source: string, key: string, body: string, opts: ExtractOpts): Promise<ExtractAnswer>;
  /** Tells the app a post could not be sent, so its work list stops handing it out first. A 404/409 is nothing to do. */
  reportFailed(source: string, key: string, code: FetchFailure): Promise<void>;
  /** Tells the app a read failed, for its trail and health; best effort: never throws. True when the app took it. */
  reportReadFailed(r: ReadFailure): Promise<boolean>;
  /** A link pasted in the popup, told to the app at once so the phone shows it (`POST /api/saves/links`). */
  addLink(url: string): Promise<AddLinkAnswer>;
  /** The recent pasted links and where each stands (`GET /api/saves/links`). */
  links(): Promise<LinkDto[]>;
  /** A YouTube video's reading, which the app builds and asks for itself (`POST /posts/:key/extract-video`). */
  extractVideo(key: string, opts: VideoOpts): Promise<ExtractAnswer>;
  /** The import's status, as the popup shows it. */
  status(): Promise<SavesStatusDto>;
  /** The import's health row: one light per stage and source (import trail). */
  health(): Promise<ImportHealthDto>;
  /** The owner's word on one post (the popup's Process anyway and Retry). */
  override(source: string, key: string, action: "process" | "skip" | "reference"): Promise<void>;
}

/** The most keys one `/known` call carries (the Worker's KNOWN_MAX_KEYS). */
const KNOWN_CHUNK = 200;
const TIMEOUT_MS = 30_000;
/** The relay waits on the model (up to 120 s at the Worker), plus the upload. */
const RELAY_TIMEOUT_MS = 180_000;
/**
 * A video's reading: the Worker's call waits up to 600 s (120 s and 2 s a minute watched), and this waits that plus 60 s
 * (design 2026-11-05 §5.4). The extension can't know the minutes the app will watch (Watch it too), so it waits the most.
 */
export const VIDEO_TIMEOUT_MS = 660_000;

export function createAppClient(opts: { appUrl: string; token: string; fetchImpl: typeof fetch }): AppClient {
  const base = opts.appUrl.replace(/\/+$/, "");

  async function call(path: string, init: RequestInit & { headers?: Record<string, string> }, timeoutMs = TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await opts.fetchImpl(`${base}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${opts.token}`, ...init.headers },
        signal: controller.signal,
      });
    } catch {
      throw new AppUnreachableError();
    } finally {
      clearTimeout(timer);
    }
  }

  const readJson = async (res: Response): Promise<Record<string, unknown> | null> => {
    const body = (await res.json().catch(() => null)) as unknown;
    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  };

  /** A good answer's JSON; an outage (5xx, a page that is not the app's JSON) is AppUnreachableError; any other no, AppRefusedError. */
  async function expectOk(res: Response): Promise<Record<string, unknown>> {
    const body = await readJson(res);
    if (res.status >= 500 || (!res.ok && !body)) throw new AppUnreachableError(`App unreachable (${res.status})`);
    if (!res.ok) throw new AppRefusedError(res.status, typeof body?.error === "string" ? body.error : null);
    if (!body) throw new AppUnreachableError("App unreachable (an answer that is not JSON)");
    return body;
  }

  const postJson = (path: string, payload: unknown) =>
    call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

  /** A relay's answer: done, or the code it refused with (and the issues to retry with, or the Worker's cap). */
  async function extractAnswer(res: Response): Promise<ExtractAnswer> {
    if (res.ok) return { ok: true };
    const body = await readJson(res);
    const error = typeof body?.error === "string" ? body.error : null;
    const issues = Array.isArray(body?.issues) ? body.issues.filter((i): i is string => typeof i === "string") : undefined;
    if (res.status === 401) throw new AppRefusedError(401, error);
    if (error === "not_found" || error === "conflict") return { ok: false, code: error };
    if (error && (SAVE_ERROR_CODES as readonly string[]).includes(error)) {
      const maxBytes = typeof body?.maxBytes === "number" && body.maxBytes > 0 ? body.maxBytes : undefined;
      return { ok: false, code: error as SaveErrorCode, ...(issues?.length ? { issues } : {}), ...(maxBytes ? { maxBytes } : {}) };
    }
    // A 400/411 is this extension's own mistake (a model or length the relay refuses): a failed post, not an outage.
    if (res.status >= 400 && res.status < 500 && error) return { ok: false, code: "unknown", issues: [error] };
    throw new AppUnreachableError(`App unreachable (${res.status})`);
  }

  return {
    async reportCheck(report) {
      await expectOk(await postJson("/api/saves/checks", report));
    },

    async known(source, keys) {
      const fresh: string[] = [];
      for (let i = 0; i < keys.length; i += KNOWN_CHUNK) {
        const body = await expectOk(await postJson("/api/saves/known", { source, keys: keys.slice(i, i + KNOWN_CHUNK) }));
        if (Array.isArray(body.fresh)) fresh.push(...body.fresh.filter((k): k is string => typeof k === "string"));
      }
      return fresh;
    },

    async submitPost(post) {
      const body = await expectOk(await postJson("/api/saves/posts", post));
      return body as unknown as SubmitAnswer;
    },

    async work(opts) {
      const body = await expectOk(await call(`/api/saves/work${opts?.links ? "?v=2" : ""}`, { method: "GET" }));
      return Array.isArray(body.keys) ? (body.keys as WorkItem[]) : [];
    },

    async extract(source, key, payload, { model, maxTokens, promptVersion, promptSha, retryIssues, readFacts }) {
      const res = await call(
        `/api/saves/posts/${encodeURIComponent(key)}/extract?source=${encodeURIComponent(source)}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-saves-model": model,
            "x-saves-max-tokens": String(maxTokens),
            ...(promptVersion ? { "x-saves-prompt-version": promptVersion } : {}),
            ...(promptSha ? { "x-saves-prompt-sha": promptSha } : {}),
            ...(retryIssues?.length ? { "x-saves-retry-issues": encodeURIComponent(JSON.stringify(retryIssues)) } : {}),
            ...(readFacts ? { "x-saves-read-facts": encodeURIComponent(JSON.stringify(readFacts)) } : {}),
          },
          body: payload,
        },
        RELAY_TIMEOUT_MS,
      );
      return extractAnswer(res);
    },

    async extractVideo(key, { model, maxTokens, retryIssues }) {
      const res = await call(
        `/api/saves/posts/${encodeURIComponent(key)}/extract-video?source=youtube`,
        {
          method: "POST",
          headers: {
            "x-saves-model": model,
            "x-saves-max-tokens": String(maxTokens),
            ...(retryIssues?.length ? { "x-saves-retry-issues": encodeURIComponent(JSON.stringify(retryIssues)) } : {}),
          },
        },
        VIDEO_TIMEOUT_MS,
      );
      return extractAnswer(res);
    },

    async addLink(url) {
      const res = await postJson("/api/saves/links", { url });
      if (res.status === 400) {
        const body = await readJson(res);
        if (body?.error === "not_a_link") return { state: "refused", message: typeof body.message === "string" ? body.message : "Not a link the app takes" };
      }
      const body = await expectOk(res);
      if (body.state === "known" && typeof body.postId === "string") {
        return { state: "known", postId: body.postId, firstSeenAt: typeof body.firstSeenAt === "string" ? body.firstSeenAt : "" };
      }
      return { state: "added" };
    },

    async links() {
      const body = await expectOk(await call("/api/saves/links", { method: "GET" }));
      return Array.isArray(body.links) ? (body.links as LinkDto[]) : [];
    },

    async reportFailed(source, key, code) {
      const res = await postJson(`/api/saves/posts/${encodeURIComponent(key)}/failed?source=${encodeURIComponent(source)}`, { code });
      if (res.status === 404 || res.status === 409) return; // unknown, or no longer waiting: nothing to mark
      await expectOk(res);
    },

    async reportReadFailed(r) {
      try {
        const res = await postJson("/api/saves/read-failed", { source: r.source, ...(r.key ? { key: r.key } : {}), code: r.code, message: r.message.slice(0, 300) });
        return res.ok;
      } catch {
        // The trail misses one failed read; the check's own error still says it.
        return false;
      }
    },

    async status() {
      return (await expectOk(await call("/api/saves/status", { method: "GET" }))) as unknown as SavesStatusDto;
    },

    async health() {
      return (await expectOk(await call("/api/saves/health", { method: "GET" }))) as unknown as ImportHealthDto;
    },

    async override(source, key, action) {
      await expectOk(await postJson(`/api/saves/posts/${encodeURIComponent(key)}/override?source=${encodeURIComponent(source)}`, { action }));
    },
  };
}

/**
 * What the popup reads: the status and the health row, side by side — one round trip each. The status is the popup's
 * own (its failure is the popup's error); a health that can't be read (an older app, a blip) is left out, never in the
 * way of the status.
 */
export async function statusAndHealth(app: Pick<AppClient, "status" | "health">): Promise<{ status: SavesStatusDto; health: ImportHealthDto | null }> {
  const [status, health] = await Promise.allSettled([app.status(), app.health()]);
  if (status.status === "rejected") throw status.reason;
  return { status: status.value, health: health.status === "fulfilled" ? health.value : null };
}

/** How a token tested (`checkToken`): taken, refused (401), the import off (404), or the app not reached. */
export interface TokenCheck {
  state: "ok" | "refused" | "off" | "unreachable";
  /** What the options page says, plainly. */
  line: string;
}

/**
 * The options page's test of a token (audit 2026-11-06, I1: Save said "Saved" without asking): the app's cheapest token
 * route (`GET /api/saves/links`: one statement beside the token check's own two). Never throws.
 */
export async function checkToken(app: Pick<AppClient, "links">): Promise<TokenCheck> {
  try {
    await app.links();
    return { state: "ok", line: "Saved — the app took the token." };
  } catch (e) {
    if (e instanceof AppRefusedError && e.status === 401) return { state: "refused", line: "The app refused this token — nothing was saved. Paste it again." };
    if (e instanceof AppRefusedError && e.status === 404) return { state: "off", line: "Saved — but the app's saves import is off." };
    return { state: "unreachable", line: "Saved — the app couldn't be reached to test it." };
  }
}
