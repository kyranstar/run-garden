import type { KvStore } from "./queue.js";

/** Filled in by build.mjs from `APP_ORIGIN`: the one app origin this build may reach (its host permission). */
declare const __APP_ORIGIN__: string | undefined;

export const DEFAULT_APP_ORIGIN = "https://run-garden-api.kyranadams.workers.dev";
export const BUILT_APP_ORIGIN = typeof __APP_ORIGIN__ === "string" ? __APP_ORIGIN__ : DEFAULT_APP_ORIGIN;

/** What the options page keeps in chrome.storage.local. The token is never logged or put in a URL. */
export interface Settings {
  appUrl: string;
  token: string;
  /** Feed pages per check, for a probe (default 20). */
  maxPages?: number;
}

const KEY = "settings";

/** The settings, or why they cannot be saved: an https app URL on the built origin, a token, at most 20 pages. */
export function validateSettings(
  input: { appUrl: string; token: string; maxPages?: number | null },
  builtOrigin: string = BUILT_APP_ORIGIN,
): { ok: true; settings: Settings } | { ok: false; message: string } {
  let url: URL;
  try {
    url = new URL(input.appUrl.trim());
  } catch {
    return { ok: false, message: "The app URL is not a URL" };
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return { ok: false, message: "The app URL must start with https://" };
  if (url.origin !== builtOrigin) return { ok: false, message: `This build reaches only ${builtOrigin}` };
  const token = input.token.trim();
  if (!token || /\s/.test(token)) return { ok: false, message: "Paste the import token" };
  const pages = input.maxPages ?? undefined;
  if (pages !== undefined && !(Number.isInteger(pages) && pages >= 1 && pages <= 20)) {
    return { ok: false, message: "Pages per check: 1 to 20" };
  }
  return { ok: true, settings: { appUrl: url.origin, token, ...(pages !== undefined ? { maxPages: pages } : {}) } };
}

export async function loadSettings(store: KvStore): Promise<Settings | null> {
  const raw = (await store.get(KEY)) as Partial<Settings> | undefined;
  return raw && typeof raw.appUrl === "string" && typeof raw.token === "string" && raw.token ? (raw as Settings) : null;
}

export async function saveSettings(store: KvStore, settings: Settings): Promise<void> {
  await store.set(KEY, settings);
}
