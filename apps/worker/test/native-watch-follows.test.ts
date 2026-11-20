/**
 * THE WATCH FOLLOWS A PHONE'S PLACE AND TAKE-BACK WITHOUT A LAPTOP (R1.2 item 7; the owner's real-phone check: a take-back's
 * `coach_delete_workout` sat queued for half an hour, the phone saying "Removing it from your watch…", because nothing a
 * phone sends ran it — only the hourly's one heavy step, or a laptop page's drain).
 *
 * The free plan's budget (45 here, of its 50: D1 statements + COROS fetches) holds no route and its watch job together:
 * measured, a phone's place 22, its copy's record 13 and push ≈31; a take-back 24 and the copy's delete ≈26. So the watch
 * work goes as the laptop's own does for an app-built session (ruling 3-R11), one step a request — on the requests a
 * phone already makes:
 *  - a place makes its session's copy (the mirror's record, its push queued) in its own request;
 *  - a take-back syncs the calendar in its own request, as the laptop's remove does;
 *  - the phone's read of the receipt, which its delivery sends straight after each place and each take-back (LifeOS
 *    f83daf9f `receiptsToRead`), runs that session's next watch step: its queued push or delete, else its owed record.
 * Each within 45, its waitUntil work included. Nothing runs with COROS writes off, the switch off, or a restore running.
 * Against the mock COROS server. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

import { DateTime } from "luxon";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, nowInstant } from "@rg/domain";
import { COROS_LOCALE_URL } from "@rg/coros";
import { nativeLibraryRoutes } from "../src/routes/native-library.js";
import { nativeTakeBackRoutes } from "../src/routes/native-take-back.js";
import { CALENDAR_OPS_PER_REQUEST, loadPreferences, savePreferences, syncCalendar } from "../src/services/calendar-sync.js";
import { mockCorosServer, type MockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { nativeWorld, seedDevice, type Answer, type NativeWorld } from "./native-fixture.js";
import { connectMock, seedCatalog } from "./watch-push-fixture.js";

const { accountState, corosWriteJobs, workoutTemplates } = schema;
const LA = "America/Los_Angeles";
const T = "2026-11-18";
const at = (d: string, hm: string) => DateTime.fromISO(`${d}T${hm}`, { zone: LA }).toUTC().toISO()!;
const LOCALE = { T1120: "Warm Up", T1122: "Cool Down", T1123: "Recover", T3001: "Run", sid_run_training: "Run training" };
const BUDGET = 45;

let w: NativeWorld;
let v5: { token: string; id: string };
let server: MockCorosServer;
let fetches = 0;

async function world(env: Record<string, string | undefined> = { WATCH_PUSH_ENABLED: "1" }, writes = true) {
  w = await nativeWorld([["/api/native", nativeLibraryRoutes], ["/api/native", nativeTakeBackRoutes]], { env });
  await savePreferences(w.db, w.userId, { ...(await loadPreferences(w.db, w.userId)), corosWritesEnabled: writes });
  await seedCatalog(w.db);
  server = mockCorosServer();
  await connectMock(w.db, w.userId, server);
  v5 = await seedDevice(w.db, w.userId, { scope: "training-v5", lastUsedAt: nowInstant() });
  await w.db.insert(workoutTemplates).values({ id: "t-1", userId: w.userId, name: "Hip reset", doc: JSON.stringify(calmDoc()), pinned: false, uses: 0, lastUsedAt: null, createdAt: nowInstant(), updatedAt: nowInstant() });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at(T, "09:00")));
  fetches = 0;
  vi.mocked(syncCalendar).mockClear();
  vi.stubGlobal("fetch", (async (input: string | URL | Request, init?: RequestInit) => {
    fetches += 1;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === COROS_LOCALE_URL) return new Response(`window.en_US=${JSON.stringify(LOCALE)};`, { status: 200 });
    return server.fetchImpl(input, init);
  }) as typeof fetch);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** One phone request, its waitUntil work included: the answer and what it cost (D1 statements + COROS fetches). */
async function phone(method: string, path: string, body?: unknown): Promise<Answer & { total: number }> {
  fetches = 0;
  const a = await w.call(method, path, { bearer: v5.token, ...(body === undefined ? {} : { body }) });
  return { ...a, total: a.statements.length + fetches };
}
const place = () => phone("POST", "/api/native/templates/t-1/place", { date: addDays(T, 1), time: "18:00", clientId: "c-1" });
const readReceipt = (id: string) => phone("GET", `/api/native/receipts/${id}`);
const jobsOf = (workoutId: string) => w.db.select().from(corosWriteJobs).where(eq(corosWriteJobs.workoutId, workoutId));
const jobOfKind = async (workoutId: string, kind: string) => (await w.db.select().from(corosWriteJobs).where(and(eq(corosWriteJobs.workoutId, workoutId), eq(corosWriteJobs.kind, kind))))[0];

describe("the watch follows a phone's place and take-back (R1.2 item 7)", () => {
  it("a place makes its session's copy in its own request; the phone's read of its receipt sends it — each within 45", async () => {
    await world();
    const placed = await place();
    expect(placed.status, placed.text).toBe(201);
    expect(placed.total, "the place, its record included").toBeLessThanOrEqual(BUDGET);
    const workoutId = placed.json.workoutId as string;
    // The copy made and its push queued, in the place's own request: nothing sent yet.
    expect((await jobOfKind(workoutId, "program_session_push"))?.status).toBe("queued");
    expect(fetches).toBe(0);
    // The phone's delivery reads the receipt straight after: that read sends the copy.
    const read = await readReceipt(placed.json.receiptId as string);
    expect([read.status, read.json.status], read.text).toEqual([200, "open"]);
    expect(read.total, "the read, the push included").toBeLessThanOrEqual(BUDGET);
    expect((await jobOfKind(workoutId, "program_session_push"))?.status).toBe("verified");
  });

  it("a take-back syncs the calendar in its own request; the phone's read of its receipt takes the copy off — each within 45", async () => {
    await world();
    const placed = await place();
    await readReceipt(placed.json.receiptId as string);
    const workoutId = placed.json.workoutId as string;
    expect((await jobOfKind(workoutId, "program_session_push"))?.status).toBe("verified");
    vi.mocked(syncCalendar).mockClear();
    const back = await phone("POST", "/api/native/take-back", { receiptIds: [placed.json.receiptId], requestId: "r-1" });
    expect([back.status, back.json.outcomes?.[0]?.outcome], back.text).toEqual([200, "taken_back"]);
    expect(back.json.outcomes[0].compensation).toContainEqual({ provider: "watch", state: "pending" });
    expect(back.total, "the take-back, its calendar step included").toBeLessThanOrEqual(BUDGET);
    // The calendar follows in the same request, one bounded step, as the laptop's remove does.
    expect(vi.mocked(syncCalendar).mock.calls.map((call) => call[3])).toEqual([{ maxOps: CALENDAR_OPS_PER_REQUEST }]);
    expect((await jobOfKind(workoutId, "coach_delete_workout"))?.status).toBe("queued");
    // The phone's delivery reads the receipt straight after (its watch still pending): that read takes the copy off.
    const read = await readReceipt(placed.json.receiptId as string);
    expect([read.status, read.json.status], read.text).toEqual([200, "taken_back"]);
    expect(read.total, "the read, the delete included").toBeLessThanOrEqual(BUDGET);
    expect((await jobOfKind(workoutId, "coach_delete_workout"))?.status).toBe("verified");
    // The next read says so.
    expect((await readReceipt(placed.json.receiptId as string)).json.compensation).toContainEqual({ provider: "watch", state: "done" });
  });

  it("with COROS writes off, or the watch switch off: no copy made, nothing sent, nothing run", async () => {
    for (const [env, writes] of [[{ WATCH_PUSH_ENABLED: "1" }, false], [{ WATCH_PUSH_ENABLED: undefined }, true]] as const) {
      await world(env, writes);
      const placed = await place();
      expect(placed.status, placed.text).toBe(201);
      const workoutId = placed.json.workoutId as string;
      expect(await jobsOf(workoutId)).toEqual([]);
      const read = await readReceipt(placed.json.receiptId as string);
      expect(read.status).toBe(200);
      expect([await jobsOf(workoutId), fetches]).toEqual([[], 0]);
    }
    // A delete already queued stays queued while the writes are off: the read runs nothing.
    await world({ WATCH_PUSH_ENABLED: "1" }, false);
    const placed = await place();
    const workoutId = placed.json.workoutId as string;
    await w.db.insert(corosWriteJobs).values({
      id: `unpush:${workoutId}`, userId: w.userId, workoutId, kind: "coach_delete_workout", expectedContentFingerprint: "x", originalDate: addDays(T, 1),
      destinationDate: addDays(T, 1), requestedAt: nowInstant(), status: "queued", createdAt: nowInstant(), updatedAt: nowInstant(),
    });
    await readReceipt(placed.json.receiptId as string);
    expect([(await jobOfKind(workoutId, "coach_delete_workout"))?.status, fetches]).toEqual(["queued", 0]);
  });

  it("while a restore is replacing the account: the read is 503 and runs nothing; the place and take-back are 423", async () => {
    await world();
    const placed = await place();
    const workoutId = placed.json.workoutId as string;
    expect((await jobOfKind(workoutId, "program_session_push"))?.status).toBe("queued");
    await w.db.insert(accountState).values({ userId: w.userId, restoreId: "r-1", restoreStartedAt: nowInstant(), updatedAt: nowInstant() });
    const read = await readReceipt(placed.json.receiptId as string);
    expect([read.status, read.json.error]).toEqual([503, "restore_in_progress"]);
    expect([(await jobOfKind(workoutId, "program_session_push"))?.status, fetches]).toEqual(["queued", 0]);
    expect((await phone("POST", "/api/native/take-back", { receiptIds: [placed.json.receiptId], requestId: "r-2" })).status).toBe(423);
    expect((await phone("POST", "/api/native/templates/t-1/place", { date: addDays(T, 2), time: "18:00", clientId: "c-2" })).status).toBe(423);
  });
});
