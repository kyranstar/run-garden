import { SAVE_ERROR_CODES } from "@rg/saves";
import type { CheckReport, PostSubmit, SaveErrorCode, SavePostStatus, WorkItem } from "@rg/saves";
import { AppRefusedError, AppUnreachableError } from "./errors.js";

// The app's token routes (`/api/saves/*`). The token travels only in the Authorization header: never in a URL, a log
// line or an error message.

export interface SubmitAnswer {
  status: SavePostStatus;
  verdict?: string;
  reason?: string;
  errorCode?: string;
}

/** The relay's answer: done, or the code it refused with (and, for `model_failed`, the issues to retry with). */
export type ExtractAnswer =
  | { ok: true }
  | { ok: false; code: SaveErrorCode | "not_found" | "conflict"; issues?: string[] };

export interface AppClient {
  reportCheck(report: CheckReport): Promise<void>;
  /** Of `keys`, the ones the app has never seen. */
  known(source: string, keys: string[]): Promise<string[]>;
  submitPost(post: PostSubmit): Promise<SubmitAnswer>;
  work(): Promise<WorkItem[]>;
  /** `body` is the gateway JSON (`buildExtractBody`), sent as a string so the request carries a Content-Length. */
  extract(source: string, key: string, body: string, opts: { model: string; maxTokens: number }): Promise<ExtractAnswer>;
}

/** The most keys one `/known` call carries (the Worker's KNOWN_MAX_KEYS). */
const KNOWN_CHUNK = 200;
const TIMEOUT_MS = 30_000;
/** The relay waits on the model (up to 120 s at the Worker), plus the upload. */
const RELAY_TIMEOUT_MS = 180_000;

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

    async work() {
      const body = await expectOk(await call("/api/saves/work", { method: "GET" }));
      return Array.isArray(body.keys) ? (body.keys as WorkItem[]) : [];
    },

    async extract(source, key, payload, { model, maxTokens }) {
      const res = await call(
        `/api/saves/posts/${encodeURIComponent(key)}/extract?source=${encodeURIComponent(source)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-saves-model": model, "x-saves-max-tokens": String(maxTokens) },
          body: payload,
        },
        RELAY_TIMEOUT_MS,
      );
      if (res.ok) return { ok: true };
      const body = await readJson(res);
      const error = typeof body?.error === "string" ? body.error : null;
      const issues = Array.isArray(body?.issues) ? body.issues.filter((i): i is string => typeof i === "string") : undefined;
      if (res.status === 401) throw new AppRefusedError(401, error);
      if (error === "not_found" || error === "conflict") return { ok: false, code: error };
      if (error && (SAVE_ERROR_CODES as readonly string[]).includes(error)) {
        return { ok: false, code: error as SaveErrorCode, ...(issues?.length ? { issues } : {}) };
      }
      // A 400/411 is this extension's own mistake (a model or length the relay refuses): a failed post, not an outage.
      if (res.status >= 400 && res.status < 500 && error) return { ok: false, code: "unknown", issues: [error] };
      throw new AppUnreachableError(`App unreachable (${res.status})`);
    },
  };
}
