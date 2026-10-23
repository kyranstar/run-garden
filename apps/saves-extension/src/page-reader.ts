import { LoginNeededError, PostGoneError, ReaderError } from "./errors.js";

export { LoginNeededError };

// Reading the owner's saves from inside an instagram.com tab: the requests run in the page itself (its origin, its
// cookies), as the site's own pages make them, so the extension holds no credentials. One tab per check: the owner's
// own if one is open (left open), else a background tab opened for the check and closed after it.

export const IG_ORIGIN = "https://www.instagram.com";
/** The web app's id, sent as `x-ig-app-id` the way the site's own requests send it. */
export const IG_APP_ID = "936619743392459";

export interface RawPageResponse {
  status: number;
  contentType: string;
  redirected: boolean;
  finalUrl: string;
  text: string;
  error?: string;
}

/** What a check reads the site through. Answers are raw JSON: the check parses them (feed.ts). */
export interface FeedReader {
  readSavedPage(maxId: string | null): Promise<unknown>;
  readPost(pk: string): Promise<unknown>;
}

/** The browser's tabs, behind a small seam so the reader can be tested without Chrome. */
export interface TabsAdapter {
  findTab(): Promise<{ id: number; url: string } | null>;
  /** Opens a background tab and resolves once it has loaded, with the URL it ended on. */
  openTab(url: string): Promise<{ id: number; url: string }>;
  closeTab(id: number): Promise<void>;
  fetchInTab(tabId: number, path: string, appId: string): Promise<RawPageResponse>;
}

const isLoginUrl = (url: string): boolean => /\/accounts\/login|\/challenge\//.test(url);

/**
 * The page's answer as JSON, or why not: a 401/403, a login redirect, a login_required body or a page of HTML instead of
 * data is LoginNeededError; a single post answered with another 4xx (not a rate limit) is PostGoneError; anything else
 * (a rate limit, an outage, a body that is not JSON) is ReaderError.
 */
export function classifyPageResponse(raw: RawPageResponse, what: "feed" | "post"): unknown {
  if (raw.status === 0) throw new ReaderError("Instagram could not be reached");
  if (raw.status === 401 || raw.status === 403) throw new LoginNeededError();
  if (isLoginUrl(raw.finalUrl)) throw new LoginNeededError();
  let body: unknown;
  try {
    body = JSON.parse(raw.text);
  } catch {
    body = undefined;
  }
  const message = typeof body === "object" && body !== null ? (body as Record<string, unknown>).message : undefined;
  if (message === "login_required" || (typeof body === "object" && body !== null && (body as Record<string, unknown>).require_login === true)) {
    throw new LoginNeededError();
  }
  // A single post the site will not give (deleted, made private, an id it refuses) is gone; a rate limit is not.
  if (what === "post" && raw.status >= 400 && raw.status < 500 && raw.status !== 429) throw new PostGoneError();
  if (raw.status < 200 || raw.status >= 300) throw new ReaderError(`Instagram answered ${raw.status}`);
  if (raw.contentType.includes("text/html") || raw.text.trimStart().startsWith("<")) throw new LoginNeededError();
  if (body === undefined) throw new ReaderError("Instagram sent something unreadable");
  return body;
}

export function createPageReader(tabs: TabsAdapter): FeedReader & { close(): Promise<void> } {
  let tab: { id: number; opened: boolean } | null = null;

  async function tabId(): Promise<number> {
    if (tab) return tab.id;
    const found = await tabs.findTab();
    const t = found ?? (await tabs.openTab(`${IG_ORIGIN}/`));
    tab = { id: t.id, opened: !found };
    if (isLoginUrl(t.url)) throw new LoginNeededError();
    return t.id;
  }

  async function get(path: string, what: "feed" | "post"): Promise<unknown> {
    const id = await tabId();
    return classifyPageResponse(await tabs.fetchInTab(id, path, IG_APP_ID), what);
  }

  return {
    readSavedPage: (maxId) => get(`/api/v1/feed/saved/posts/${maxId ? `?max_id=${encodeURIComponent(maxId)}` : ""}`, "feed"),
    async readPost(pk) {
      if (!/^\d{1,30}$/.test(pk)) throw new Error("not a post id");
      return get(`/api/v1/media/${pk}/info/`, "post");
    },
    async close() {
      if (tab?.opened) await tabs.closeTab(tab.id).catch(() => undefined);
      tab = null;
    },
  };
}

/**
 * Runs INSIDE the instagram.com page (`chrome.scripting.executeScript`, main world), so it must stay self-contained:
 * it may use only its arguments and the page's globals, never anything else from this module.
 */
export async function pageFetch(path: string, appId: string): Promise<RawPageResponse> {
  try {
    const res = await fetch(path, {
      credentials: "include",
      headers: { "x-ig-app-id": appId, "x-requested-with": "XMLHttpRequest" },
    });
    const text = await res.text();
    return { status: res.status, contentType: res.headers.get("content-type") ?? "", redirected: res.redirected, finalUrl: res.url, text };
  } catch (e) {
    return { status: 0, contentType: "", redirected: false, finalUrl: "", text: "", error: String(e).slice(0, 200) };
  }
}

const TAB_LOAD_TIMEOUT_MS = 45_000;

function waitForLoad(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (fn: () => void) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      fn();
    };
    const listener = (id: number, info: { status?: string }) => {
      if (id === tabId && info.status === "complete") done(resolve);
    };
    const timer = setTimeout(() => done(() => reject(new ReaderError("Instagram did not load"))), TAB_LOAD_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(
      (t) => t.status === "complete" && done(resolve),
      () => done(() => reject(new ReaderError("The Instagram tab closed"))),
    );
  });
}

/** The real tabs: chrome.tabs to find, open and close; chrome.scripting to run `pageFetch` in the page. */
export function chromeTabs(): TabsAdapter {
  return {
    async findTab() {
      const found = await chrome.tabs.query({ url: `${IG_ORIGIN}/*`, status: "complete" });
      const t = found.find((x) => x.id !== undefined && !x.discarded);
      return t?.id !== undefined ? { id: t.id, url: t.url ?? "" } : null;
    },
    async openTab(url) {
      const created = await chrome.tabs.create({ url, active: false });
      if (created.id === undefined) throw new ReaderError("Could not open an Instagram tab");
      await waitForLoad(created.id);
      const loaded = await chrome.tabs.get(created.id);
      return { id: created.id, url: loaded.url ?? "" };
    },
    async closeTab(id) {
      await chrome.tabs.remove(id);
    },
    async fetchInTab(tabId, path, appId) {
      const [first] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: pageFetch, args: [path, appId] });
      const result = first?.result as RawPageResponse | undefined;
      return result ?? { status: 0, contentType: "", redirected: false, finalUrl: "", text: "", error: "no result" };
    },
  };
}
