// @vitest-environment jsdom
/**
 * The outbox in the app (Phase 2 spec §2b "Client storage"; plan 2b Task 7):
 *  - it drains from app start (and on `online`, on visible) — `OutboxSync`, mounted once by the app;
 *  - a session saved here and waiting reads "Done · 31 min · saved, will sync" on the Today card;
 *  - a refused one (409 conflict, or a refusal retrying cannot fix) is a quiet "Couldn't sync one session" row in
 *    Settings → Data with Retry and Discard; with none, nothing renders (an account with no program sees no change).
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TodayResponse, WorkoutDto } from "@rg/api-client";
import { ApiError } from "@rg/api-client";
import type { PerformedSessionWireInput } from "@rg/domain";
import { openOfflineDb, type OfflineDb } from "../src/offline/idb.js";
import { enqueue, outboxEntries } from "../src/offline/outbox.js";
import { OutboxSync } from "../src/components/outbox-sync.js";
import { UnsyncedSessions } from "../src/components/unsynced-sessions.js";
import { TodayProgramLead, TodayProgramLine } from "../src/components/today-program.js";
import { features } from "../src/features.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let db: OfflineDb | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  db?.close();
  db = null;
  features.player = true;
});

const SLOT = "slot-p1-2026-10-08";
const wire = (id = "11111111-1111-4111-8111-111111111111"): PerformedSessionWireInput => ({
  id, source: "app", sourceRef: null, workoutId: SLOT, buildId: "b1", localDate: "2026-10-08",
  startedAt: "2026-10-08T18:00:00.000Z", endedAt: "2026-10-08T18:31:00.000Z", seconds: 1860, plannedSeconds: 1800, minutes: 30,
  mode: "consistent", theme: null, locationId: "home", blockRef: null, blockNumber: null, completed: true, stepsTotal: 9, stepsDone: 9,
  movesDone: [], note: null, newMove: null, entries: [], checks: [],
});

function render(el: React.ReactElement, qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(createElement(QueryClientProvider, { client: qc }, el)));
  return qc;
}
const flush = () => act(async () => void (await new Promise((r) => setImmediate(r))));
async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await flush();
  }
  throw new Error(`timed out waiting for: ${what}\n${document.body.textContent}`);
}
const text = () => (document.body.textContent ?? "").replace(/\s+/g, " ");
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name);

describe("OutboxSync", () => {
  it("drains once at app start; a saved session refreshes Today", async () => {
    db = await openOfflineDb(new IDBFactory());
    await enqueue(db, wire());
    const savePerformed = vi.fn(async () => ({ status: "saved" }));
    const qc = new QueryClient();
    const invalidated: string[] = [];
    const spy = vi.spyOn(qc, "invalidateQueries").mockImplementation(async (f) => {
      invalidated.push(String((f as { queryKey?: unknown[] })?.queryKey?.[0]));
    });
    render(createElement(OutboxSync, { db: () => Promise.resolve(db!), api: { savePerformed } }), qc);
    await until(async () => (await outboxEntries(db!)).length === 0, "the outbox drained");
    await until(() => invalidated.includes("today"), "Today refreshed");
    expect(savePerformed).toHaveBeenCalledTimes(1);
    expect(invalidated).toContain("outbox");
    spy.mockRestore();
  });
});

describe("Settings → Data: a session that couldn't sync", () => {
  async function conflicted() {
    db = await openOfflineDb(new IDBFactory());
    const e = await enqueue(db, wire());
    await db.put("outbox", e.key, { ...e, state: "conflict", lastError: "conflict", attempts: 1 });
  }

  it("nothing at all when every session synced or is still on its way (an account with no program sees no change)", async () => {
    db = await openOfflineDb(new IDBFactory());
    // A session waiting for the network is not a refused one.
    await enqueue(db, wire());
    const qc = render(createElement(UnsyncedSessions, { db: () => Promise.resolve(db!), api: { savePerformed: vi.fn() } }));
    // The outbox has been read (not merely not read yet).
    await until(() => qc.getQueryState(["outbox"])?.status === "success", "the outbox read");
    await flush();
    expect(host!.innerHTML).toBe("");
  });

  it("a refused session is one quiet row with Retry and Discard", async () => {
    await conflicted();
    render(createElement(UnsyncedSessions, { db: () => Promise.resolve(db!), api: { savePerformed: vi.fn() } }));
    await until(() => text().includes("Couldn't sync one session"), "the row");
    expect(text()).toContain("Oct 8");
    expect(button("Retry")).toBeDefined();
    expect(button("Discard")).toBeDefined();
  });

  it("Retry sends it again: saved, the row goes", async () => {
    await conflicted();
    const savePerformed = vi.fn(async () => ({ status: "saved" }));
    render(createElement(UnsyncedSessions, { db: () => Promise.resolve(db!), api: { savePerformed } }));
    await until(() => !!button("Retry"), "the row");
    await act(async () => button("Retry")!.click());
    await until(async () => (await outboxEntries(db!)).length === 0, "sent");
    await until(() => !text().includes("Couldn't sync"), "the row gone");
    expect(savePerformed).toHaveBeenCalledTimes(1);
  });

  it("Retry refused again keeps the row", async () => {
    await conflicted();
    const savePerformed = vi.fn(async () => {
      throw new ApiError(409, { error: "conflict" });
    });
    render(createElement(UnsyncedSessions, { db: () => Promise.resolve(db!), api: { savePerformed } }));
    await until(() => !!button("Retry"), "the row");
    await act(async () => button("Retry")!.click());
    await until(() => savePerformed.mock.calls.length === 1, "sent");
    await flush();
    expect(text()).toContain("Couldn't sync one session");
    expect((await outboxEntries(db!))[0]!.state).toBe("conflict");
  });

  it("Discard asks, then drops it", async () => {
    await conflicted();
    render(createElement(UnsyncedSessions, { db: () => Promise.resolve(db!), api: { savePerformed: vi.fn() } }));
    await until(() => !!button("Discard"), "the row");
    await act(async () => button("Discard")!.click());
    await until(() => !!button("Discard session"), "the question");
    await act(async () => button("Discard session")!.click());
    await until(async () => (await outboxEntries(db!)).length === 0, "dropped");
    await until(() => !text().includes("Couldn't sync"), "the row gone");
  });
});

describe("the Today card after Save", () => {
  const workout = (over: Partial<WorkoutDto> = {}): WorkoutDto =>
    ({
      id: SLOT, title: "Program one · Desk unwind", category: "strength", effectiveDate: "2026-10-08", effectiveTime: "19:00",
      completionState: "scheduled", origin: "program", contentState: "started", programId: "p1", workoutSeconds: 1800, ...over,
    }) as WorkoutDto;
  const session = (over: Partial<WorkoutDto> = {}): TodayResponse["todaySessions"][number] => ({
    workout: workout(over),
    build: { mode: "consistent", theme: "Desk unwind", minutes: 30 },
  });
  const html = (el: React.ReactElement) =>
    renderToStaticMarkup(createElement(MemoryRouter, null, el)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  it("saved here and waiting: Done · 31 min · saved, will sync — no Continue", () => {
    const out = html(createElement(TodayProgramLead, { session: session(), today: "2026-10-08", pending: { minutes: 31 } }));
    expect(out).toContain("Done · 31 min · saved, will sync");
    expect(out).not.toMatch(/Continue|Start/);
    const line = html(createElement(TodayProgramLine, { session: session(), today: "2026-10-08", pending: { minutes: 31 } }));
    expect(line).toContain("Done · will sync");
    expect(line).not.toMatch(/Continue|Start/);
  });

  it("synced: Done, as the server says", () => {
    const out = html(createElement(TodayProgramLead, { session: session({ contentState: "done", completionState: "completed" }), today: "2026-10-08" }));
    expect(out).toContain("Done");
    expect(out).not.toContain("will sync");
  });
});
