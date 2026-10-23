import { createAppClient } from "./app-client.js";
import { DEFAULT_CONFIG, runCheck, singleFlight, type CheckSummary } from "./check.js";
import { chromeTabs, createPageReader } from "./page-reader.js";
import { chromeStore, ExtQueue } from "./queue.js";
import { loadSettings } from "./settings.js";
import { SOURCE } from "./feed.js";
import { isPostKey, NOT_CONFIGURED } from "./status.js";
import type { SavesStatusDto } from "@rg/saves";

// The service worker: a check every 6 hours (each delayed 0–30 min, so checks never land on the same minute), and one
// on the popup's "Check now". Checks are single-flight: an alarm during a long check, or a second "Check now", joins
// the running one (two at once could submit and match the same posts twice).

const ALARM = "check";
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
      config: { ...DEFAULT_CONFIG, ...(settings.maxPages ? { maxPages: settings.maxPages } : {}) },
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

const checkOnce = singleFlight(check);

async function ensureAlarm(): Promise<void> {
  // Created once: re-creating it on every start would push the next check back. A missed alarm fires on wake.
  if (!(await chrome.alarms.get(ALARM))) await chrome.alarms.create(ALARM, { periodInMinutes: PERIOD_MINUTES, delayInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(() => void ensureAlarm());
chrome.runtime.onStartup.addListener(() => void ensureAlarm());

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) {
    // Chrome's shortest alarm delay is 30 s.
    void chrome.alarms.create(JITTERED, { delayInMinutes: Math.max(0.5, Math.random() * JITTER_MINUTES) });
  } else if (alarm.name === JITTERED) {
    void checkOnce();
  }
});

export interface StatusResponse {
  status: SavesStatusDto | null;
  appError: string | null;
  queueSize: number;
  nextCheckAt: number | null;
}
export type OverrideResponse = { ok: true } | { ok: false; message: string };

const messageOf = (e: unknown, fallback: string): string => (e instanceof Error ? e.message : fallback);

/** What the popup shows: the app's status (or why it could not be read), the local queue, and the next alarm. */
async function popupStatus(): Promise<StatusResponse> {
  const nextCheckAt = (await chrome.alarms.get(JITTERED))?.scheduledTime ?? (await chrome.alarms.get(ALARM))?.scheduledTime ?? null;
  const queueSize = await new ExtQueue(chromeStore).size();
  const settings = await loadSettings(chromeStore);
  if (!settings) return { status: null, appError: NOT_CONFIGURED, queueSize, nextCheckAt };
  try {
    const status = await createAppClient({ appUrl: settings.appUrl, token: settings.token, fetchImpl }).status();
    const last = (await chromeStore.get("lastCheck")) as CheckSummary | undefined;
    return { status, appError: last?.error?.message ?? null, queueSize, nextCheckAt };
  } catch (e) {
    return { status: null, appError: messageOf(e, "App unreachable"), queueSize, nextCheckAt };
  }
}

async function override(key: string, action: "process" | "skip" | "reference"): Promise<OverrideResponse> {
  const settings = await loadSettings(chromeStore);
  if (!settings) return { ok: false, message: "Set the app URL and token in Options" };
  try {
    await createAppClient({ appUrl: settings.appUrl, token: settings.token, fetchImpl }).override(SOURCE, key, action);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: messageOf(e, "The app did not answer") };
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  const m = message as { type?: unknown; key?: unknown; action?: unknown } | null;
  if (m?.type === "check-now") {
    checkOnce().then(sendResponse, (e: unknown) => sendResponse({ ok: false, message: messageOf(e, "The check failed") }));
    return true; // the answer comes asynchronously
  }
  if (m?.type === "status") {
    popupStatus().then(sendResponse, (e: unknown) => sendResponse({ status: null, appError: messageOf(e, "App unreachable"), queueSize: 0, nextCheckAt: null }));
    return true;
  }
  if (m?.type === "override" && isPostKey(m.key) && (m.action === "process" || m.action === "skip" || m.action === "reference")) {
    override(m.key, m.action).then(sendResponse, (e: unknown) => sendResponse({ ok: false, message: messageOf(e, "The app did not answer") }));
    return true;
  }
});
