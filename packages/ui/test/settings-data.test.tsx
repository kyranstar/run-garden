// @vitest-environment jsdom
/**
 * Settings → Your data: the restore flow, interactively (audit 1 data
 * findings 5, 7, 8 and 14; rulings B1, B7, B8).
 *
 * Mounted in jsdom against a stubbed worker, so the real Data card is driven
 * the way the athlete drives it: choose a file → the worker checks every page
 * (no side effects, and no begin) → the confirm sheet says what the file is →
 * "Replace everything in this account" → begin, rows, finish in that order,
 * with a leave-page prompt while it runs → the summary says what to do next.
 * Every query is invalidated when a restore ends, succeeded or not.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXPORT_FORMAT, exportFileName, NotAnExportError, readExportFile } from "@rg/api-client";
import { DataSection } from "../src/screens/settings.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom's Blob has no text(); browsers do. Read it the old way in tests.
if (typeof Blob.prototype.text !== "function") {
  Blob.prototype.text = function text(this: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };
}

type Row = Record<string, unknown>;
const APP = "https://app.test";
const EXPORTED_AT = "2026-09-20T12:00:00.000Z";

function exportFile(over: Record<string, unknown> = {}, tables: Record<string, Row[]> = {}): File {
  return new File(
    [
      JSON.stringify({
        format: EXPORT_FORMAT,
        schemaVersion: "0023",
        exportedAt: EXPORTED_AT,
        exportedFrom: APP,
        tables: {
          users: [{ id: "u-old", email: "runner@example.com" }],
          provider_connections: [{ id: "pc", provider: "coros" }],
          user_preferences: [{ userId: "u-old", prefs: {}, updatedAt: EXPORTED_AT }],
          planned_workouts: [{ id: "w1" }, { id: "w2" }, { id: "w3" }],
          activities: [{ id: "a1" }, { id: "a2" }],
          garden_day_inputs: [{ id: "g1" }],
          ...tables,
        },
        ...over,
      }),
    ],
    "run-garden-export-2026-09-20.json",
    { type: "application/json" },
  );
}

interface Worker {
  calls: string[];
  /** Resolves the next `rows` call (the test holds the restore mid-flight). */
  releaseRows: () => void;
}

function stubWorker(
  opts: {
    checkErrors?: Record<string, unknown[]>;
    failRowsOn?: string;
    holdRows?: boolean;
    beginError?: string;
    restore?: unknown;
  } = {},
): Worker {
  const calls: string[] = [];
  let release: () => void = () => undefined;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Row) : {};
      const path = url.replace(/\?.*$/, "");
      calls.push(`${init?.method ?? "GET"} ${path}${body.table ? ` ${String(body.table)}` : ""}`);
      switch (path) {
        case "/api/auth/me":
          return json({ userId: "u1", email: "runner@example.com", connections: [], fixtureMode: false, restore: opts.restore ?? null });
        case "/api/settings/restore/tables":
          return json({
            schemaVersion: "0023",
            tables: ["user_preferences", "planned_workouts", "activities", "garden_day_inputs"],
            skip: ["users", "provider_connections", "provider_cursor_state", "coach_locks"],
          });
        case "/api/settings/restore/check/start":
          calls[calls.length - 1] += ` ${JSON.stringify(body.manifest)} ${String(body.sourceUserId)}`;
          return json({ ok: true, session: "sess-1", restoreId: "r1" });
        case "/api/settings/restore/check": {
          if (body.session !== "sess-1") return json({ ok: false, errors: [{ row: -1, code: "check_required", message: "no session" }] });
          const errors = opts.checkErrors?.[String(body.table)];
          if (errors) return json({ ok: false, errors });
          return json({ ok: true, token: `tok-${String(body.table)}`, rows: (body.rows as Row[]).length });
        }
        case "/api/settings/restore/begin":
          if (opts.beginError) return json({ error: opts.beginError }, opts.beginError === "restore_running" ? 409 : 422);
          if (body.session !== "sess-1") return json({ error: "check_required" }, 422);
          return json({ restoreId: "r1", tables: ["user_preferences", "planned_workouts", "activities", "garden_day_inputs"] });
        case "/api/settings/restore/rows":
          if (opts.holdRows) await new Promise<void>((r) => (release = r));
          if ("sourceUserId" in body) return json({ error: "unsigned_source" }, 400);
          if (body.table === opts.failRowsOn) {
            return json({ error: "insert_failed", table: body.table, row: 1, detail: "x" }, 422);
          }
          return json({ received: (body.rows as Row[]).length, skipped: 0, lost: 0 });
        case "/api/settings/restore/finish":
          return json({
            counts: { user_preferences: 1, planned_workouts: 2, activities: 2, garden_day_inputs: 1 },
            expected: { user_preferences: 1, planned_workouts: 3, activities: 2, garden_day_inputs: 1 },
            short: [],
          });
        case "/api/settings/restore/start-fresh":
          calls[calls.length - 1] += ` ${JSON.stringify(body)}`;
          return json({ ok: true });
        default:
          return json({ error: "not_found" }, 404);
      }
    }),
  );
  return {
    calls,
    releaseRows: () => release(),
  };
}

let root: Root | null = null;
let container: HTMLDivElement;

function mount(): { qc: QueryClient; invalidate: ReturnType<typeof vi.spyOn> } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(createElement(QueryClientProvider, { client: qc }, createElement(DataSection, { appOrigin: APP })));
  });
  return { qc, invalidate };
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
  throw new Error(`timed out waiting for: ${what}\n${document.body.textContent}`);
}

const text = () => document.body.textContent ?? "";
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement | undefined;

async function choose(file: File): Promise<void> {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function click(label: string): Promise<void> {
  const b = button(label);
  if (!b) throw new Error(`no button "${label}" in: ${text()}`);
  await act(async () => {
    b.click();
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
  // The restore summary names a date ("since Sunday, September 20.") and adds the year once today is in another
  // year — pin today (Date only; the UI's timers stay real).
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Settings → Your data → Restore from file", () => {
  it("checks every page with no begin, then says what the file is before the destructive tap", async () => {
    const worker = stubWorker();
    mount();
    await choose(exportFile());
    await until(() => !!button("Replace everything in this account"), "the confirm step");

    // Only side-effect-free calls so far: the table list, the check session
    // (every table the worker restores, with the file's count, and the id of
    // the account it came from), and one check per page.
    expect(worker.calls.filter((c) => !c.includes("/api/auth/me"))).toEqual([
      "GET /api/settings/restore/tables",
      'POST /api/settings/restore/check/start {"user_preferences":1,"planned_workouts":3,"activities":2,"garden_day_inputs":1} u-old',
      "POST /api/settings/restore/check user_preferences",
      "POST /api/settings/restore/check planned_workouts",
      "POST /api/settings/restore/check activities",
      "POST /api/settings/restore/check garden_day_inputs",
    ]);
    const t = text();
    expect(t).toContain("Fromapp.test");
    expect(t).toContain("Accountrunner@example.com");
    expect(t).toMatch(/Exported[A-Za-z]+, September 20/);
    expect(t).toContain("Workouts3");
    expect(t).toContain("Activities2");
    expect(t).toContain("Garden days1");
    expect(t).toContain("All tables");
    expect(t).toContain(
      "COROS and Google Calendar will be disconnected, and changes waiting to go to your watch won't be sent.",
    );
    expect(button("Replace everything in this account")!.disabled).toBe(false);
  });

  it("confirm runs begin → rows → finish in order, holds the page while running, then summarises", async () => {
    const worker = stubWorker({ holdRows: true });
    const { invalidate } = mount();
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    await choose(exportFile());
    await until(() => !!button("Replace everything in this account"), "the confirm step");
    worker.calls.length = 0;

    await click("Replace everything in this account");
    await until(() => worker.calls.some((c) => c.includes("/restore/rows")), "the first rows page");
    // Mid-restore: leaving the page asks first, and the sheet can't be cancelled.
    const hold = added.mock.calls.find(([type]) => type === "beforeunload");
    expect(hold).toBeDefined();
    const leaving = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);
    expect(button("Cancel")!.disabled).toBe(true);

    for (let i = 0; i < 4; i += 1) {
      worker.releaseRows();
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
    }
    await until(() => text().includes("Restored."), "the summary");
    expect(worker.calls.filter((c) => !c.includes("/api/auth/me"))).toEqual([
      "POST /api/settings/restore/begin",
      "POST /api/settings/restore/rows user_preferences",
      "POST /api/settings/restore/rows planned_workouts",
      "POST /api/settings/restore/rows activities",
      "POST /api/settings/restore/rows garden_day_inputs",
      "POST /api/settings/restore/finish",
    ]);
    expect(text()).toMatch(
      /Reconnect COROS and Google Calendar, then run Backfill history to bring back activities since [A-Za-z]+, September 20\./,
    );
    // The file held 3 workouts; finish counted 2 — named, not "Restored" alone.
    expect(text()).toContain("Some tables came back short: planned_workouts (2 of 3).");
    expect(removed.mock.calls.some(([type]) => type === "beforeunload")).toBe(true);
    expect(invalidate).toHaveBeenCalled();
    await click("Done");
    expect(text()).not.toContain("Restored.");
  });

  it("a refused row names the table and row, invalidates too, and offers Try again", async () => {
    const worker = stubWorker({ failRowsOn: "activities" });
    const { invalidate } = mount();
    await choose(exportFile());
    await until(() => !!button("Replace everything in this account"), "the confirm step");
    await click("Replace everything in this account");
    await until(() => text().includes("The restore stopped at activities row 2."), "the failure");
    expect(worker.calls).not.toContain("POST /api/settings/restore/finish");
    expect(invalidate).toHaveBeenCalled();

    worker.calls.length = 0;
    await click("Try again");
    await until(() => text().includes("The restore stopped"), "the second failure");
    expect(worker.calls[0]).toBe("POST /api/settings/restore/begin");
  });

  it("an expired check, an incomplete one and a restore running elsewhere each say what happened (M6, M10)", async () => {
    for (const [error, says] of [
      ["check_expired", "The check expired — it lasts a day. Choose the file again to check it."],
      ["check_incomplete", "The check didn't cover the whole file. Choose it again."],
      ["restore_running", "A restore is already running on another device. Let it finish, or try again in a couple of minutes."],
      ["check_required", "The file changed after it was checked. Choose it again."],
    ] as const) {
      stubWorker({ beginError: error });
      mount();
      await choose(exportFile());
      await until(() => !!button("Replace everything in this account"), "the confirm step");
      await click("Replace everything in this account");
      await until(() => text().includes(says), error);
      act(() => root?.unmount());
      root = null;
      vi.unstubAllGlobals();
      document.body.innerHTML = "";
    }
  });

  it("after its own restore failed, this device may start fresh at once — naming its restore", async () => {
    const running = {
      restoreId: "r1",
      startedAt: EXPORTED_AT,
      heartbeatAt: EXPORTED_AT,
      running: true,
      fileExportedAt: EXPORTED_AT,
      fileExportedFrom: APP,
    };
    const worker = stubWorker({ failRowsOn: "activities", restore: running });
    mount();
    await choose(exportFile());
    await until(() => !!button("Replace everything in this account"), "the confirm step");
    await click("Replace everything in this account");
    await until(() => text().includes("The restore stopped at activities row 2."), "the failure");
    await until(() => !!button("Start fresh"), "the notice");
    await click("Start fresh");
    await click("Delete everything and start fresh");
    await until(() => worker.calls.some((c) => c.includes("start-fresh")), "start fresh");
    expect(worker.calls.find((c) => c.includes("start-fresh"))).toBe('POST /api/settings/restore/start-fresh {"restoreId":"r1"}');
  });

  it("a file that fails the check lists what is wrong and never offers the replace", async () => {
    const worker = stubWorker({
      checkErrors: {
        activities: [{ row: 1, column: "duration_seconds", code: "missing_column", message: "activities row 2: duration_seconds is missing" }],
      },
    });
    mount();
    await choose(exportFile());
    await until(() => text().includes("This file can't be restored."), "the problems");
    expect(text()).toContain("activities row 2: duration_seconds is missing");
    expect(button("Replace everything in this account")).toBeUndefined();
    expect(worker.calls.some((c) => c.includes("/restore/begin"))).toBe(false);
  });

  it("a file from another app, or another account, is named — and another app's needs a second yes", async () => {
    stubWorker();
    mount();
    await choose(exportFile({ exportedFrom: "https://staging.app.test" }, { users: [{ id: "x", email: "someone@else.test" }] }));
    await until(() => !!button("Replace everything in this account"), "the confirm step");
    expect(text()).toContain("This file came from staging.app.test, not this app.");
    expect(text()).toContain("This file is from someone@else.test. You're signed in as runner@example.com.");
    expect(button("Replace everything in this account")!.disabled).toBe(true);
    const box = container.ownerDocument.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => {
      box.click();
    });
    expect(button("Replace everything in this account")!.disabled).toBe(false);
  });

  it("Cancel after the check sends nothing that changes the account", async () => {
    const worker = stubWorker();
    mount();
    await choose(exportFile());
    await until(() => !!button("Replace everything in this account"), "the confirm step");
    await click("Cancel");
    expect(button("Replace everything in this account")).toBeUndefined();
    expect(worker.calls.some((c) => /begin|rows|finish/.test(c))).toBe(false);
  });

  it("a file that is not an export is refused locally, with no request", async () => {
    const worker = stubWorker();
    mount();
    await choose(new File(["{}"], "x.json"));
    await until(() => text().includes("That file isn't a Run Garden export."), "the refusal");
    expect(worker.calls.filter((c) => !c.includes("/api/auth/me"))).toEqual([]);
  });
});

describe("export file helpers", () => {
  it("refuses a file that is not a Run Garden export", async () => {
    await expect(readExportFile(new File(["{}"], "x.json"))).rejects.toBeInstanceOf(NotAnExportError);
    await expect(readExportFile(new File(["not json"], "x.json"))).rejects.toBeInstanceOf(NotAnExportError);
  });

  it("names the download run-garden-export-YYYY-MM-DD.json", () => {
    expect(exportFileName(new Date(2026, 2, 4, 9, 0))).toBe("run-garden-export-2026-03-04.json");
  });
});
