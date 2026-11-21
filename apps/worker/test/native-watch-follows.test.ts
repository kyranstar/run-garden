/**
 * THE WATCH FOLLOWS A PHONE'S PLACE AND TAKE-BACK WITHOUT A LAPTOP (R1.2 item 7; the owner's real-phone check: a take-back's
 * `coach_delete_workout` sat queued for half an hour, the phone saying "Removing it from your watch…", because nothing a
 * phone sends ran it — only the hourly's one heavy step, or a laptop page's drain).
 *
 * The free plan's budget (45 here, of its 50: D1 statements + COROS and Google fetches) holds no route and its watch job
 * together: measured, a phone's place 22, its copy's record 13 and push ≈31; a take-back 24 and the copy's delete ≈26. So
 * the watch work goes one step a request, on the requests a phone already makes:
 *  - a place makes its session's copy (the mirror's record, its push queued) BEFORE it answers, so the phone's read that
 *    follows finds the push queued (the re-check's MAJOR-B: a record still running in waitUntil raced the read's own);
 *  - the phone's read of the receipt, which its delivery sends straight after each place and each take-back (LifeOS
 *    f83daf9f `receiptsToRead`), runs that session's next watch step: its queued push or delete, else its owed record —
 *    one record at a time per account (a lock: a record that meets another's makes nothing, the next read or the hourly does);
 *  - each request's calendar step is sized to the room its declared costs left (`calendarOpsFitting`, as the approve's;
 *    the re-check's MAJOR-A): a place with its record leaves none, so its event waits for the half-hourly run; a take-back
 *    of one receipt books its one op, a grouped one none.
 * Every request within 45, its waitUntil work included, with the owner's calendar connected and its token refreshed in the
 * request (a real calendar step, against a fake Google). Nothing runs with COROS writes off, the switch off, or a restore
 * running. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant } from "@rg/domain";
import { COROS_LOCALE_URL } from "@rg/coros";
import { encryptSecret } from "../src/auth/crypto.js";
import { nativeLibraryRoutes } from "../src/routes/native-library.js";
import { nativeTakeBackRoutes } from "../src/routes/native-take-back.js";
import { loadPreferences, savePreferences, syncCalendar } from "../src/services/calendar-sync.js";
import { deviceWatchRecord } from "../src/services/device-watch.js";
import { mockCorosServer, type MockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { nativeWorld, seedDevice, type Answer, type NativeWorld } from "./native-fixture.js";
import { connectMock, seedCatalog } from "./watch-push-fixture.js";

const { accountState, corosWriteJobs, plannedWorkouts, providerConnections, workoutTemplates } = schema;
const LA = "America/Los_Angeles";
const T = "2026-11-18";
const at = (d: string, hm: string) => DateTime.fromISO(`${d}T${hm}`, { zone: LA }).toUTC().toISO()!;
const LOCALE = { T1120: "Warm Up", T1122: "Cool Down", T1123: "Recover", T3001: "Run", sid_run_training: "Run training" };
const BUDGET = 45;

let w: NativeWorld;
let v5: { token: string; id: string };
let server: MockCorosServer;
let fetches = 0;

/** Google Calendar's events endpoint and its token endpoint, enough for the owner's connected calendar. */
function fakeGoogle() {
  let n = 0;
  const inserted: string[] = [];
  const deleted: string[] = [];
  let refreshes = 0;
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const handle = async (url: URL, init?: RequestInit): Promise<Response> => {
    if (url.hostname === "oauth2.googleapis.com") {
      refreshes += 1;
      return json({ access_token: `access-${refreshes}`, expires_in: 3600 });
    }
    const method = (init?.method ?? "GET").toUpperCase();
    const m = url.pathname.match(/\/calendars\/[^/]+\/events(?:\/([^/]+))?$/);
    if (!m) return json({}, 404);
    const id = m[1] ? decodeURIComponent(m[1]) : undefined;
    if (method === "GET") return json({ items: [], nextSyncToken: String(n) });
    if (method === "POST") {
      const body = JSON.parse(String(init!.body)) as { extendedProperties?: { private?: { rgWorkoutId?: string } } };
      inserted.push(body.extendedProperties?.private?.rgWorkoutId ?? "?");
      return json({ id: `ev${++n}` });
    }
    if (id && method === "PATCH") return json({ id });
    if (id && method === "DELETE") {
      deleted.push(id);
      return new Response(null, { status: 204 });
    }
    return json({}, 400);
  };
  return { handle, inserted, deleted, refreshes: () => refreshes };
}
let google: ReturnType<typeof fakeGoogle>;

async function world(env: Record<string, string | undefined> = { WATCH_PUSH_ENABLED: "1" }, writes = true) {
  w = await nativeWorld([["/api/native", nativeLibraryRoutes], ["/api/native", nativeTakeBackRoutes]], { env });
  await savePreferences(w.db, w.userId, { ...(await loadPreferences(w.db, w.userId)), corosWritesEnabled: writes, calendarId: "cal" });
  await seedCatalog(w.db);
  server = mockCorosServer();
  await connectMock(w.db, w.userId, server);
  // The owner's calendar, connected (its event went at the 18:30 half-hourly run).
  await w.db.insert(providerConnections).values({
    id: newId(), userId: w.userId, provider: "google_calendar", status: "connected",
    encryptedRefreshToken: await encryptSecret("refresh", w.env.TOKEN_ENCRYPTION_KEY), encryptedAccessToken: await encryptSecret("access", w.env.TOKEN_ENCRYPTION_KEY),
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), createdAt: nowInstant(), updatedAt: nowInstant(),
  });
  v5 = await seedDevice(w.db, w.userId, { scope: "training-v5", lastUsedAt: nowInstant() });
  for (const id of ["t-1", "t-2"]) {
    await w.db.insert(workoutTemplates).values({ id, userId: w.userId, name: `Hip reset ${id}`, doc: JSON.stringify(calmDoc()), pinned: false, uses: 0, lastUsedAt: null, createdAt: nowInstant(), updatedAt: nowInstant() });
  }
}

/** The calendar's token gone stale: the next calendar step refreshes it in its own request (one fetch and one write more). */
const expireToken = () => w.db.update(providerConnections).set({ accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString() }).where(eq(providerConnections.provider, "google_calendar"));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at(T, "09:00")));
  fetches = 0;
  google = fakeGoogle();
  vi.stubGlobal("fetch", (async (input: string | URL | Request, init?: RequestInit) => {
    fetches += 1;
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.href === COROS_LOCALE_URL) return new Response(`window.en_US=${JSON.stringify(LOCALE)};`, { status: 200 });
    if (url.hostname.endsWith("googleapis.com")) return google.handle(url, init);
    return server.fetchImpl(input, init);
  }) as typeof fetch);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** One phone request, its waitUntil work included: the answer and what it cost (D1 statements + every fetch). */
async function phone(method: string, path: string, body?: unknown): Promise<Answer & { total: number }> {
  fetches = 0;
  const a = await w.call(method, path, { bearer: v5.token, ...(body === undefined ? {} : { body }) });
  return { ...a, total: a.statements.length + fetches };
}
const place = (id = "t-1", clientId = "c-1", time: string | null = "18:00") =>
  phone("POST", `/api/native/templates/${id}/place`, { date: addDays(T, 1), ...(time ? { time } : {}), clientId });
const readReceipt = (id: string) => phone("GET", `/api/native/receipts/${id}`);
const jobsOf = (workoutId: string) => w.db.select().from(corosWriteJobs).where(eq(corosWriteJobs.workoutId, workoutId));
const pushesOf = async (workoutId: string) => (await jobsOf(workoutId)).filter((j) => j.kind === "program_session_push");
const jobOfKind = async (workoutId: string, kind: string) => (await w.db.select().from(corosWriteJobs).where(and(eq(corosWriteJobs.workoutId, workoutId), eq(corosWriteJobs.kind, kind))))[0];
/** The calendar books the plan as the half-hourly run does (what a place leaves it). */
const halfHourly = () => syncCalendar(w.db, w.env, w.userId);

describe("the watch follows a phone's place and take-back (R1.2 item 7)", () => {
  it("a place makes its session's copy before it answers, its calendar left to the half-hourly; each within 45", async () => {
    await world();
    for (const [id, clientId, time] of [["t-1", "c-1", "18:00"], ["t-2", "c-2", null]] as const) {
      await expireToken();
      const placed = await place(id, clientId, time);
      expect(placed.status, placed.text).toBe(201);
      expect(placed.total, `the place (${time ?? "untimed"}), its record and any calendar step included`).toBeLessThanOrEqual(BUDGET);
      const workoutId = placed.json.workoutId as string;
      // The copy made and its push queued: nothing sent yet, no calendar op (no room left beside the record).
      expect((await pushesOf(workoutId)).map((j) => j.status)).toEqual(["queued"]);
      expect(google.inserted).toEqual([]);
      // The phone's delivery reads the receipt straight after: that read sends the copy.
      const read = await readReceipt(placed.json.receiptId as string);
      expect([read.status, read.json.status], read.text).toEqual([200, "open"]);
      expect(read.total, "the read, the push included").toBeLessThanOrEqual(BUDGET);
      expect((await pushesOf(workoutId)).map((j) => j.status)).toEqual(["verified"]);
    }
  });

  it("the race (MAJOR-B): the phone's read sent while the place's waitUntil work is still pending sends the one copy", async () => {
    await world();
    // The place answered, its waitUntil work NOT awaited: the read follows at once, as the installed phone sends it.
    const pending: Promise<unknown>[] = [];
    const res = await w.app.request(
      "/api/native/templates/t-1/place",
      { method: "POST", headers: { Authorization: `Bearer ${v5.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ date: addDays(T, 1), time: "18:00", clientId: "c-race" }) },
      w.env,
      { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined, props: {} } as never,
    );
    const placed = (await res.json()) as { workoutId: string; receiptId: string };
    expect(res.status).toBe(201);
    // Its push is queued already, before the answer: the read finds it.
    expect((await pushesOf(placed.workoutId)).map((j) => j.status)).toEqual(["queued"]);
    const read = await readReceipt(placed.receiptId);
    expect(read.status, read.text).toBe(200);
    await Promise.allSettled(pending);
    // One copy, sent: never a second record or push.
    expect((await pushesOf(placed.workoutId)).map((j) => j.status)).toEqual(["verified"]);
  });

  it("two of a session's records at once make one copy (the record's lock): never a second push", async () => {
    await world();
    // A place from the laptop's cookie makes no record: its session is owed one.
    const laptop = await w.call("POST", "/api/native/templates/t-1/place", { body: { date: addDays(T, 1), time: "18:00", clientId: "c-laptop" } });
    expect(laptop.status, laptop.text).toBe(201);
    const workoutId = laptop.json.workoutId as string;
    expect(await pushesOf(workoutId)).toEqual([]);
    const made = await Promise.all([deviceWatchRecord(w.db, w.env, w.userId, workoutId), deviceWatchRecord(w.db, w.env, w.userId, workoutId)]);
    expect(made.filter(Boolean)).toHaveLength(1);
    expect((await pushesOf(workoutId)).map((j) => j.status)).toEqual(["queued"]);
  });

  // A PHONE'S RECEIPT READ IS MUTATION-CAPABLE (R1.3; the lead's v0.22 ruling: "a receipt read that advances watch work is
  // mutation-capable, even if it uses GET. Keep it out of passive verification"). The laptop's read of the same receipt is
  // the passive one, which the harness's check uses: it reads, and writes and sends nothing.
  it("the laptop's read of a receipt is passive — no step, no write, no fetch; the phone's same read sends the copy (R1.3)", async () => {
    await world();
    const placed = await place();
    const workoutId = placed.json.workoutId as string;
    expect((await pushesOf(workoutId)).map((j) => j.status)).toEqual(["queued"]);
    fetches = 0;
    const laptop = await w.call("GET", `/api/native/receipts/${placed.json.receiptId}`);
    expect([laptop.status, laptop.json.status], laptop.text).toEqual([200, "open"]);
    expect([laptop.writes, fetches]).toEqual([[], 0]);
    expect((await pushesOf(workoutId)).map((j) => j.status)).toEqual(["queued"]);
    const read = await readReceipt(placed.json.receiptId as string);
    expect(read.writes.length).toBeGreaterThan(0);
    expect((await pushesOf(workoutId)).map((j) => j.status)).toEqual(["verified"]);
  });

  it("a take-back books its calendar op in the room it left; the phone's read takes the copy off — each within 45", async () => {
    await world();
    const placed = await place();
    await readReceipt(placed.json.receiptId as string);
    const workoutId = placed.json.workoutId as string;
    expect((await jobOfKind(workoutId, "program_session_push"))?.status).toBe("verified");
    await halfHourly();
    expect(google.inserted).toEqual([workoutId]);
    await expireToken();
    const back = await phone("POST", "/api/native/take-back", { receiptIds: [placed.json.receiptId], requestId: "r-1" });
    expect([back.status, back.json.outcomes?.[0]?.outcome], back.text).toEqual([200, "taken_back"]);
    expect(back.json.outcomes[0].compensation).toContainEqual({ provider: "watch", state: "pending" });
    expect(back.total, "the take-back, its calendar step and a token refresh included").toBeLessThanOrEqual(BUDGET);
    // One receipt leaves room for one calendar op: the event comes off in the same request, its token refreshed there.
    expect([google.deleted.length, google.refreshes()]).toEqual([1, 1]);
    expect((await jobOfKind(workoutId, "coach_delete_workout"))?.status).toBe("queued");
    // The phone's delivery reads the receipt straight after (its watch still pending): that read takes the copy off.
    const read = await readReceipt(placed.json.receiptId as string);
    expect([read.status, read.json.status], read.text).toEqual([200, "taken_back"]);
    expect(read.total, "the read, the delete included").toBeLessThanOrEqual(BUDGET);
    expect((await jobOfKind(workoutId, "coach_delete_workout"))?.status).toBe("verified");
    expect((await readReceipt(placed.json.receiptId as string)).json.compensation).toContainEqual({ provider: "watch", state: "done" });
  });

  it("a grouped take-back (3b's case) stays within 45: no calendar op fits beside two receipts, so the half-hourly books it", async () => {
    await world();
    const a = await place("t-1", "c-a");
    const b = await place("t-2", "c-b");
    await halfHourly();
    expect(google.inserted).toHaveLength(2);
    await expireToken();
    const back = await phone("POST", "/api/native/take-back", { receiptIds: [a.json.receiptId, b.json.receiptId], requestId: "r-g" });
    expect([back.status, back.json.outcomes?.map((o: { outcome: string }) => o.outcome)], back.text).toEqual([200, ["taken_back", "taken_back"]]);
    expect(back.total, "the grouped take-back").toBeLessThanOrEqual(BUDGET);
    expect([google.deleted, google.refreshes()]).toEqual([[], 0]);
    await halfHourly();
    expect(google.deleted).toHaveLength(2);
  });

  it("with COROS writes off, or the watch switch off: no copy made, nothing sent to the watch, nothing run", async () => {
    for (const [env, writes] of [[{ WATCH_PUSH_ENABLED: "1" }, false], [{ WATCH_PUSH_ENABLED: undefined }, true]] as const) {
      await world(env, writes);
      await expireToken();
      const booked = google.inserted.length;
      const placed = await place();
      expect(placed.status, placed.text).toBe(201);
      const workoutId = placed.json.workoutId as string;
      expect(await jobsOf(workoutId)).toEqual([]);
      // No record can run, so none holds its room (the R1.2 re-check's NIT-2): the place books its event itself, within 45.
      expect(google.inserted.slice(booked)).toEqual([workoutId]);
      expect(placed.total, "the place and its calendar step, the token refreshed").toBeLessThanOrEqual(BUDGET);
      fetches = 0;
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
      destinationDate: addDays(T, 1), requestedAt: nowInstant(), status: "queued", updatedAt: nowInstant(),
    });
    await readReceipt(placed.json.receiptId as string);
    expect([(await jobOfKind(workoutId, "coach_delete_workout"))?.status, fetches]).toEqual(["queued", 0]);
  });

  // PLACE_COST is a light day's figure (the R1.2 re-check's NIT-3): an untimed place's collision pass writes one statement a
  // row it re-times. With no record to make, the calendar step takes the room left, so a crowded day must still fit.
  it("an untimed place on a crowded day stays within 45: its collision pass, and the calendar step in the room left (NIT-3)", async () => {
    await world({ WATCH_PUSH_ENABLED: "1" }, false);
    const day = addDays(T, 1);
    for (let i = 0; i < 8; i++) {
      await w.db.insert(plannedWorkouts).values({
        id: `crowd-${i}`, userId: w.userId, planId: `studio-${w.userId}`, origin: "studio", sourceWorkoutId: `studio:crowd-${i}`, title: `Crowd ${i}`,
        category: "yoga", sport: "yoga", originalPlanDate: day, lastVerifiedCorosDate: day, effectiveDate: day, effectiveTime: "18:00",
        sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 1500, sourceEstimatedDurationSeconds: 1500, completionState: "scheduled",
        createdAt: nowInstant(), updatedAt: nowInstant(),
      });
    }
    await expireToken();
    const placed = await place("t-1", "c-crowd", null);
    expect(placed.status, placed.text).toBe(201);
    // The pass's write: a row's new time, held to the row as it read it (`guardOrFail` on its day).
    const retimed = placed.writes.filter((s) => /^update "planned_workouts" set /.test(s) && /"effective_time" = \?/.test(s) && / = case when /.test(s)).length;
    expect(retimed, "the collision pass re-timed the day's rows").toBeGreaterThan(3);
    expect(placed.total, `the place, ${retimed} rows re-timed by its collision pass, and its calendar step`).toBeLessThanOrEqual(BUDGET);
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
