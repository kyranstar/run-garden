import { LINK_REFUSED, normalizeLink } from "@rg/saves";
import { createAppClient, statusAndHealth } from "./app-client.js";
import { DEFAULT_CONFIG, enqueuePastedSubmit, runCheck, serialLock, singleFlight, type CheckSummary } from "./check.js";
import { parseMediaInfo } from "./feed.js";
import { LinkQueue, runLinks, type LinksSummary } from "./links.js";
import { chromeTabs, createPageReader } from "./page-reader.js";
import { shortcodeToPk } from "./shortcode.js";
import { chromeYoutubeTabs, readYoutube } from "./youtube-reader.js";
import { chromeStore, ExtQueue } from "./queue.js";
import { loadSettings } from "./settings.js";
import { SOURCE } from "./feed.js";
import { isPostKey, NOT_CONFIGURED } from "./status.js";
import { AppUnreachableError } from "./errors.js";
import type { ImportHealthDto, LinkDto, SavesStatusDto } from "@rg/saves";
import type { AddLinkAnswer, PopupLocalLink } from "./status.js";

// The service worker: a check every 6 hours (each delayed 0–30 min, so checks never land on the same minute), and one
// on the popup's "Check now". Checks are single-flight: an alarm during a long check, or a second "Check now", joins
// the running one (two at once could submit and match the same posts twice). Pasted links (design 2026-11-05 §5.1,
// §14.4) are read on add, after each check, and every 15 minutes, when the app is also asked for work started there
// (a link pasted on the phone, Watch it too) — that ask touches no site. One lock: never a check and links at once.

const ALARM = "check";
const LINKS_ALARM = "links";
const LINKS_PERIOD_MINUTES = 15;
const JITTERED = "check-jittered";
const PERIOD_MINUTES = 360;
const JITTER_MINUTES = 30;
/** Chrome stops an idle service worker after 30 s; an extension API call every 20 s keeps a long check alive. */
const KEEP_ALIVE_MS = 20_000;

/** Between reads of the site: 1.5–4 s, the pace of someone opening posts. */
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 1500 + Math.random() * 2500));
const fetchImpl: typeof fetch = (input, init) => fetch(input, init);

export type CheckNowResponse = { ok: true; summary: CheckSummary } | { ok: false; message: string };

async function check(): Promise<CheckNowResponse> {
  const settings = await loadSettings(chromeStore);
  if (!settings) return { ok: false, message: "Set the app URL and token in Options" };
  const reader = createPageReader(chromeTabs());
  const keepAlive = setInterval(() => void chrome.runtime.getPlatformInfo(), KEEP_ALIVE_MS);
  try {
    const summary = await runCheck({
      app: createAppClient({ appUrl: settings.appUrl, token: settings.token, fetchImpl }),
      reader,
      fetchImpl,
      queue: new ExtQueue(chromeStore),
      store: chromeStore,
      now: Date.now,
      config: { ...DEFAULT_CONFIG, extVersion: chrome.runtime.getManifest().version, ...(settings.maxPages ? { maxPages: settings.maxPages } : {}) },
      pause,
    });
    await chromeStore.set("lastCheck", summary);
    if (summary.error) console.warn(`saves check: ${summary.error.code}: ${summary.error.message}`);
    return { ok: true, summary };
  } finally {
    clearInterval(keepAlive);
    await reader.close();
  }
}

/** The pasted links and the app's video work, one at a time (links.ts). Null when the options aren't set. */
async function links(): Promise<LinksSummary | null> {
  const settings = await loadSettings(chromeStore);
  if (!settings) return null;
  const app = createAppClient({ appUrl: settings.appUrl, token: settings.token, fetchImpl });
  const reader = createPageReader(chromeTabs());
  const extVersion = chrome.runtime.getManifest().version;
  const keepAlive = setInterval(() => void chrome.runtime.getPlatformInfo(), KEEP_ALIVE_MS);
  try {
    return await runLinks({
      app,
      queue: new LinkQueue(chromeStore),
      now: Date.now,
      youtube: (id) => readYoutube(chromeYoutubeTabs(), id, { now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }),
      async instagram(key) {
        // One post read from the owner's Instagram tab, then sent (and read for its moves) through the check's queue.
        await pause();
        const post = parseMediaInfo(await reader.readPost(shortcodeToPk(key)));
        const queue = new ExtQueue(chromeStore);
        await enqueuePastedSubmit(queue, post, SOURCE);
        const summary = await runCheck({
          app, reader, fetchImpl, queue, store: chromeStore, now: Date.now, pause, prefetched: [post],
          config: { ...DEFAULT_CONFIG, extVersion, mode: "queue" },
        });
        if (summary.error?.code === "app_unreachable") throw new AppUnreachableError(summary.error.message);
      },
      config: { model: DEFAULT_CONFIG.model, maxTokens: DEFAULT_CONFIG.maxTokens, extVersion },
    });
  } finally {
    clearInterval(keepAlive);
    await reader.close();
  }
}

/** True from the moment a check starts until it settles; the popup reads it as "Checking…" between its own opens. */
let checking = false;
const lock = serialLock();
const checkOnce = singleFlight(() =>
  lock(async () => {
    checking = true;
    try {
      const out = await check();
      // A check ends with the links: the saved list first, then what was pasted.
      await links().catch((e: unknown) => console.warn(`saves links: ${messageOf(e, "failed")}`));
      return out;
    } finally {
      checking = false;
    }
  }),
);
const linksOnce = singleFlight(() => lock(() => links()));

async function ensureAlarm(): Promise<void> {
  // Created once: re-creating it on every start would push the next check back. A missed alarm fires on wake.
  if (!(await chrome.alarms.get(ALARM))) await chrome.alarms.create(ALARM, { periodInMinutes: PERIOD_MINUTES, delayInMinutes: 1 });
  if (!(await chrome.alarms.get(LINKS_ALARM))) await chrome.alarms.create(LINKS_ALARM, { periodInMinutes: LINKS_PERIOD_MINUTES, delayInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(() => void ensureAlarm());
chrome.runtime.onStartup.addListener(() => void ensureAlarm());

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) {
    // Chrome's shortest alarm delay is 30 s.
    void chrome.alarms.create(JITTERED, { delayInMinutes: Math.max(0.5, Math.random() * JITTER_MINUTES) });
  } else if (alarm.name === JITTERED) {
    void checkOnce();
  } else if (alarm.name === LINKS_ALARM) {
    void linksOnce().catch((e: unknown) => console.warn(`saves links: ${messageOf(e, "failed")}`));
  }
});

export type AddLinkResponse = AddLinkAnswer;

/**
 * A link from the popup: normalized here, told to the app at once (so the phone shows it; already in answers when),
 * queued, and read in the background — the popup may close. An unreachable app doesn't lose it: it's queued anyway.
 */
async function addLink(url: string): Promise<AddLinkResponse> {
  const link = normalizeLink(url);
  if (!link) return { ok: false, message: LINK_REFUSED };
  const settings = await loadSettings(chromeStore);
  if (!settings) return { ok: false, message: NOT_CONFIGURED };
  try {
    const answer = await createAppClient({ appUrl: settings.appUrl, token: settings.token, fetchImpl }).addLink(link.url);
    if (answer.state === "known") return { ok: true, known: { postId: answer.postId, firstSeenAt: answer.firstSeenAt } };
    if (answer.state === "refused") return { ok: false, message: answer.message };
  } catch {
    // The app can't be reached now: the link waits here, and is read once it can.
  }
  await new LinkQueue(chromeStore).add(link, new Date().toISOString());
  void linksOnce().catch((e: unknown) => console.warn(`saves links: ${messageOf(e, "failed")}`));
  return { ok: true, added: true };
}

export interface StatusResponse {
  status: SavesStatusDto | null;
  appError: string | null;
  queueSize: number;
  nextCheckAt: number | null;
  /** A check is running in this service worker right now. */
  checking: boolean;
  /** The health row (import trail), read beside the status; null when it couldn't be. */
  health: ImportHealthDto | null;
  /** The app URL the options saved: the popup links each post to its trail there. */
  appUrl: string | null;
  /** The app's recent pasted links (null when they couldn't be read), and the ones only the extension holds yet. */
  links?: LinkDto[] | null;
  localLinks?: PopupLocalLink[];
  /** The active tab's video, as its watch link, when it is one: the field is filled with it (§3.1). */
  activeVideo?: string | null;
}
export type OverrideResponse = { ok: true } | { ok: false; message: string };

const messageOf = (e: unknown, fallback: string): string => (e instanceof Error ? e.message : fallback);

/**
 * What the popup shows: the app's status (or why it could not be read) and its health row — one call each, side by
 * side — the local queue, and the next alarm.
 */
async function popupStatus(): Promise<StatusResponse> {
  const nextCheckAt = (await chrome.alarms.get(JITTERED))?.scheduledTime ?? (await chrome.alarms.get(ALARM))?.scheduledTime ?? null;
  const queueSize = await new ExtQueue(chromeStore).size();
  const localLinks = await new LinkQueue(chromeStore).all();
  const activeVideo = await activeVideoLink();
  const settings = await loadSettings(chromeStore);
  if (!settings) return { status: null, appError: NOT_CONFIGURED, queueSize, nextCheckAt, checking, health: null, appUrl: null, links: null, localLinks, activeVideo };
  const app = createAppClient({ appUrl: settings.appUrl, token: settings.token, fetchImpl });
  try {
    const [{ status, health }, links] = await Promise.all([statusAndHealth(app), app.links().catch(() => null)]);
    const last = (await chromeStore.get("lastCheck")) as CheckSummary | undefined;
    return { status, appError: last?.error?.message ?? null, queueSize, nextCheckAt, checking, health, appUrl: settings.appUrl, links, localLinks, activeVideo };
  } catch (e) {
    return { status: null, appError: messageOf(e, "App unreachable"), queueSize, nextCheckAt, checking, health: null, appUrl: settings.appUrl, links: null, localLinks, activeVideo };
  }
}

/** The active tab's video as its watch link, when the owner is on one (the popup's "Import this video"). */
async function activeVideoLink(): Promise<string | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const link = tab?.url ? normalizeLink(tab.url) : null;
    return link?.source === "youtube" ? link.url : null;
  } catch {
    return null;
  }
}

async function override(key: string, action: "process" | "skip" | "reference", source: string = SOURCE): Promise<OverrideResponse> {
  const settings = await loadSettings(chromeStore);
  if (!settings) return { ok: false, message: "Set the app URL and token in Options" };
  try {
    await createAppClient({ appUrl: settings.appUrl, token: settings.token, fetchImpl }).override(source, key, action);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: messageOf(e, "The app did not answer") };
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  const m = message as { type?: unknown; key?: unknown; action?: unknown; source?: unknown } | null;
  if (m?.type === "check-now") {
    checkOnce().then(sendResponse, (e: unknown) => sendResponse({ ok: false, message: messageOf(e, "The check failed") }));
    return true; // the answer comes asynchronously
  }
  if (m?.type === "status") {
    popupStatus().then(sendResponse, (e: unknown) =>
      sendResponse({ status: null, appError: messageOf(e, "App unreachable"), queueSize: 0, nextCheckAt: null, checking, health: null, appUrl: null } satisfies StatusResponse),
    );
    return true;
  }
  if (m?.type === "add-link" && typeof (m as { url?: unknown }).url === "string") {
    addLink((m as { url: string }).url).then(sendResponse, (e: unknown) => sendResponse({ ok: false, message: messageOf(e, "The link couldn't be added") }));
    return true;
  }
  if (m?.type === "retry-link" && typeof (m as { url?: unknown }).url === "string") {
    const link = normalizeLink((m as { url: string }).url);
    if (!link) return;
    new LinkQueue(chromeStore)
      .add(link, new Date().toISOString())
      .then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false, message: "The link couldn't be retried" }));
    void linksOnce().catch(() => undefined);
    return true;
  }
  if (m?.type === "override" && isPostKey(m.key) && (m.action === "process" || m.action === "skip" || m.action === "reference")) {
    // A pasted video names its source; a saved post's is the feed's (an older popup names none).
    const source = m.source === "youtube" || m.source === "instagram" ? m.source : SOURCE;
    override(m.key, m.action, source).then(sendResponse, (e: unknown) => sendResponse({ ok: false, message: messageOf(e, "The app did not answer") }));
    return true;
  }
});
