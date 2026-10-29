/**
 * The sync line names a partial COROS read as what it is (Task 11, fix round 3): the read worked and some workouts
 * from it could not be saved — not an outage, not a clean sync.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SyncStatusDto } from "@rg/api-client";
import { SyncStatusLine, syncActionCopy } from "../src/components.js";

const status = (error: string | null): SyncStatusDto => ({
  state: "in_sync",
  pendingCount: 0,
  issueCount: 0,
  lastCorosReadAt: null,
  writesEnabled: true,
  registered: true,
  cloud: { connected: true, lastSyncAt: "2026-10-11T10:00:00.000Z", error },
});

const line = (error: string | null) => renderToStaticMarkup(createElement(SyncStatusLine, { status: status(error) }));

describe("the sync line", () => {
  it("a partial read says some workouts could not be saved, not that COROS is unreachable", () => {
    expect(line("partial_import")).toContain("Some COROS workouts couldn&#x27;t be saved — retrying");
    expect(line("partial_import")).not.toContain("unreachable");
  });

  it("a read that failed is still COROS unreachable, and a clean one synced", () => {
    expect(line("api_error")).toContain("COROS unreachable — retrying");
    expect(line(null)).toContain("Synced with COROS");
  });

  // Audit C2: COROS expired the sleep connection on 09-18 and for five weeks only Settings said so.
  it("an expired sleep connection says so, briefly, where a clean sync would — a COROS outage still leads", () => {
    const render = (s: SyncStatusDto) => renderToStaticMarkup(createElement(SyncStatusLine, { status: s }));
    const sleepless = (error: string | null): SyncStatusDto => ({ ...status(error), sleepNeedsReconnect: true });
    expect(render(sleepless(null))).toContain("Sleep sync stopped — reconnect in Settings");
    expect(render(sleepless(null))).not.toContain("Synced with COROS");
    expect(render(sleepless("api_error"))).toContain("COROS unreachable — retrying");
    expect(render({ ...sleepless(null), cloud: null })).toContain("Sleep sync stopped — reconnect in Settings");
    expect(render({ ...status(null), sleepNeedsReconnect: false })).not.toContain("Sleep");
  });
});

/**
 * THE WATCH CATCHING UP (the watch mirrors the plan §3.9): "N sessions updating on your watch" while sessions have a push
 * or a delete on its way — and nothing of it once they have run. A COROS outage, a write that couldn't sync and an
 * expired sleep connection still lead.
 */
describe("the account line while the watch catches up", () => {
  const render = (s: SyncStatusDto) => renderToStaticMarkup(createElement(SyncStatusLine, { status: s }));

  it("says how many sessions are updating — one, or several — in place of Synced", () => {
    expect(render({ ...status(null), watchUpdatingCount: 1 })).toContain("1 session updating on your watch");
    expect(render({ ...status(null), watchUpdatingCount: 3 })).toContain("3 sessions updating on your watch");
    expect(render({ ...status(null), watchUpdatingCount: 3 })).not.toContain("Synced with COROS");
  });

  it("nothing updating (or an older server that does not say): nothing of it", () => {
    expect(render({ ...status(null), watchUpdatingCount: 0 })).toContain("Synced with COROS");
    expect(render({ ...status(null), watchUpdatingCount: 0 })).not.toContain("updating on your watch");
    expect(render(status(null))).not.toContain("updating on your watch");
  });

  it("louder things lead: COROS unreachable, a change that couldn't sync, the sleep connection", () => {
    expect(render({ ...status("api_error"), watchUpdatingCount: 2 })).toContain("COROS unreachable — retrying");
    expect(render({ ...status(null), state: "sync_issue", issueCount: 1, watchUpdatingCount: 2 })).toContain("1 change couldn&#x27;t sync");
    expect(render({ ...status(null), sleepNeedsReconnect: true, watchUpdatingCount: 2 })).toContain("Sleep sync stopped");
  });

  it("without a cloud connection's line (an older server's shape): in place of in sync and of Syncing N changes", () => {
    const plain = { ...status(null), cloud: null };
    expect(render({ ...plain, watchUpdatingCount: 2 })).toContain("2 sessions updating on your watch");
    expect(render({ ...plain, state: "syncing", pendingCount: 3, watchUpdatingCount: 2 })).toContain("2 sessions updating on your watch");
    expect(render({ ...plain, state: "syncing", pendingCount: 3, watchUpdatingCount: 0 })).toContain("Syncing 3 changes…");
  });

  it("a mirrored session's row action speaks the sheet's words — nothing for the athlete to do", () => {
    expect(syncActionCopy({ agent: "app", code: "watch_updating" })).toEqual({ says: "Updating your watch…", todo: null });
    expect(syncActionCopy({ agent: "app", code: "watch_retrying" })).toEqual({ says: "Couldn't reach COROS — retrying", todo: null });
    // Nothing will queue it again: said without "retrying", and the session's Retry is the athlete's.
    expect(syncActionCopy({ agent: "athlete", code: "watch_failed" })).toEqual({ says: "Couldn't reach COROS", todo: "Open the session and tap Retry." });
    expect(syncActionCopy({ agent: "nobody", code: "kept_off_watch" })).toEqual({ says: "Kept off your watch", todo: null });
  });
});
