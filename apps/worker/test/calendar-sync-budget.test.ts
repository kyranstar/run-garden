/**
 * ONE CALENDAR SYNC IS BOUNDED (cron reliability, 2026-10-08).
 *
 * Workers Free gives an invocation 50 subrequests and a few milliseconds of CPU, and the half-hourly cron spends
 * one invocation on every account's calendar sync and then the COROS sweeps. A sync used to execute every op the
 * reconcile found: a first sync, a token reset or a change that touched every event (a description format, a
 * buffer) meant one Google call and two D1 writes per event — 70+ fetches for a 70-event mirror, past the
 * subrequest ceiling, and enough CPU to be killed part-way. From 2026-10-03 (program slots on the calendar) 52 of
 * 357 calendar runs were left `running`.
 *
 * Now a sync executes at most CALENDAR_OPS_PER_RUN ops, says so in its stats (`capped`, `deferred`), and leaves
 * the rest to the next run — which finds them again, because a capped run does not advance the sync token: a
 * change the athlete made in Google that waited behind the cap is still in the next run's feed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import type { Env } from "../src/env.js";
import { encryptSecret } from "../src/auth/crypto.js";
import { CALENDAR_OPS_PER_RUN, loadPreferences, savePreferences, syncCalendar } from "../src/services/calendar-sync.js";
import { loadAccountState } from "../src/services/account-state.js";
import { halfHourly } from "../src/index.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const env = { APP_URL: "https://app.test", TOKEN_ENCRYPTION_KEY: TEST_KEY } as Env;

interface Ev {
  id: string;
  status: "confirmed" | "cancelled";
  seq: number;
  body: { start: { dateTime: string }; end: { dateTime: string }; extendedProperties: { private: Record<string, string> } } & Record<string, unknown>;
}

/** Google Calendar behind `fetch`, with real sync-token semantics: a token is a change sequence number, and an
 * incremental read returns every event changed after it — including this app's own writes. */
class FakeGoogleApi {
  events = new Map<string, Ev>();
  fetches = 0;
  writes: string[] = [];
  lists: string[] = [];
  private seq = 1;
  private n = 0;

  bump(e: Ev): void {
    e.seq = ++this.seq;
  }

  byWorkout(workoutId: string): Ev | undefined {
    return [...this.events.values()].find((e) => e.body.extendedProperties.private.rgWorkoutId === workoutId);
  }

  fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    this.fetches += 1;
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    const m = url.pathname.match(/\/calendars\/[^/]+\/events(?:\/([^/]+))?$/);
    if (url.hostname !== "www.googleapis.com" || !m) return json({}, 404);
    const eventId = m[1] ? decodeURIComponent(m[1]) : undefined;
    if (method === "GET") {
      const token = url.searchParams.get("syncToken");
      this.lists.push(token ? `incremental:${token}` : "full");
      const items = [...this.events.values()]
        .filter((e) => (token ? e.seq > Number(token) : e.status !== "cancelled"))
        .map((e) => ({ id: e.id, status: e.status, ...e.body }));
      return json({ items, nextSyncToken: String(this.seq) });
    }
    if (method === "POST") {
      const id = `ev${++this.n}`;
      const body = JSON.parse(String(init!.body)) as Ev["body"];
      this.events.set(id, { id, status: "confirmed", seq: ++this.seq, body });
      this.writes.push(`insert:${body.extendedProperties.private.rgWorkoutId}`);
      return json({ id });
    }
    const e = eventId ? this.events.get(eventId) : undefined;
    if (!e) return json({}, 404);
    if (method === "PATCH") {
      e.body = { ...e.body, ...(JSON.parse(String(init!.body)) as Ev["body"]) };
      this.bump(e);
      this.writes.push(`patch:${e.id}`);
      return json({ id: e.id });
    }
    if (method === "DELETE") {
      e.status = "cancelled";
      this.bump(e);
      this.writes.push(`delete:${e.id}`);
      return new Response(null, { status: 204 });
    }
    return json({}, 400);
  }) as typeof fetch;
}

let db: Db;
let userId: string;
let today: string;
let google: FakeGoogleApi;

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId } = await makeTestUser(db));
  const prefs = await loadPreferences(db, userId);
  await savePreferences(db, userId, { ...prefs, calendarId: "cal" });
  today = todayInZone(prefs.timezone);
  await db.insert(schema.providerConnections).values({
    id: newId(),
    userId,
    provider: "google_calendar",
    status: "connected",
    encryptedRefreshToken: await encryptSecret("refresh", TEST_KEY),
    encryptedAccessToken: await encryptSecret("access", TEST_KEY),
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  google = new FakeGoogleApi();
  globalThis.fetch = google.fetch;
});

afterEach(() => vi.restoreAllMocks());

/** `count` workouts, one a day from `from` days after today (tomorrow by default), in that order. */
async function seedWorkouts(count: number, from = 1): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `w-${from < 0 ? "past" : "next"}-${String(i).padStart(3, "0")}`;
    const date = addDays(today, from + i);
    await db.insert(schema.plannedWorkouts).values({
      id,
      userId,
      planId: "p",
      sourceWorkoutId: `src-${id}`,
      title: "Easy",
      category: "easy",
      sport: "run",
      originalPlanDate: date,
      lastVerifiedCorosDate: date,
      effectiveDate: date,
      effectiveTime: "07:00",
      completionState: "scheduled",
      calendarSyncState: "pending",
      sourceContentFingerprint: "fp",
      calendarBlockDurationSeconds: 3600,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    ids.push(id);
  }
  return ids;
}

/** Sync until a run is not capped; every run's own cost is checked on the way. */
async function syncUntilSettled(): Promise<Awaited<ReturnType<typeof syncCalendar>>[]> {
  const runs: Awaited<ReturnType<typeof syncCalendar>>[] = [];
  for (let i = 0; i < 20; i++) {
    const before = google.fetches;
    const stats = await syncCalendar(db, env, userId);
    // One list read (a token Google refuses costs one more), and at most the cap in writes.
    expect(google.fetches - before).toBeLessThanOrEqual(CALENDAR_OPS_PER_RUN + 2);
    runs.push(stats);
    if (!stats.capped) return runs;
  }
  throw new Error("the calendar never settled");
}

describe("a calendar sync's work per run (cron reliability)", () => {
  it("a first sync of more events than the cap writes the cap, says so, and the next runs book the rest once each", async () => {
    const total = CALENDAR_OPS_PER_RUN * 2 + 5;
    const ids = await seedWorkouts(total);

    const first = await syncCalendar(db, env, userId);
    expect(first.created).toBe(CALENDAR_OPS_PER_RUN);
    expect(first).toMatchObject({ capped: true, deferred: total - CALENDAR_OPS_PER_RUN });
    expect(google.writes).toHaveLength(CALENDAR_OPS_PER_RUN);

    const rest = await syncUntilSettled();
    expect(rest.map((r) => r.created)).toEqual([CALENDAR_OPS_PER_RUN, 5]);
    expect(rest.at(-1)?.capped).toBeUndefined();
    // Every workout has exactly one event and one link.
    expect([...google.writes].sort()).toEqual(ids.map((id) => `insert:${id}`).sort());
    const links = await db.select().from(schema.calendarEventLinks);
    expect(links).toHaveLength(total);

    // Settled: a run with nothing to do writes nothing and is not capped.
    const steady = await syncCalendar(db, env, userId);
    expect(steady).toMatchObject({ created: 0, updated: 0, deleted: 0 });
    expect(steady.capped).toBeUndefined();
  });

  it("past the cap, the sessions still ahead are booked first, soonest first, then the ones behind", async () => {
    const behind = await seedWorkouts(10, -10);
    const ahead = await seedWorkouts(CALENDAR_OPS_PER_RUN + 5);
    await syncCalendar(db, env, userId);
    expect(google.writes).toEqual(ahead.slice(0, CALENDAR_OPS_PER_RUN).map((id) => `insert:${id}`));
    // Within the budget the rest go as the reconcile ordered them.
    expect((await syncCalendar(db, env, userId)).capped).toBeUndefined();
    expect(google.writes.slice(CALENDAR_OPS_PER_RUN).sort()).toEqual(
      [...ahead.slice(CALENDAR_OPS_PER_RUN), ...behind].map((id) => `insert:${id}`).sort(),
    );
  });

  it("the half-hourly cron records a capped sync as an ok run that says it was capped", async () => {
    await seedWorkouts(CALENDAR_OPS_PER_RUN + 3);
    await halfHourly(db, env);
    const [run] = await db.select().from(schema.syncRuns).where(eq(schema.syncRuns.kind, "calendar_sync"));
    expect(run).toMatchObject({ status: "ok", stats: expect.objectContaining({ capped: true, deferred: 3, created: CALENDAR_OPS_PER_RUN }) });
  });

  it("a capped run keeps the sync token: an athlete's move waiting behind the cap is adopted on the next run", async () => {
    const ids = await seedWorkouts(CALENDAR_OPS_PER_RUN + 6);
    await syncUntilSettled();

    // Every workout but the last changes content — more updates than one run executes …
    const changed = ids.slice(0, -1);
    for (const id of changed) {
      await db.update(schema.plannedWorkouts).set({ title: "Easy + strides" }).where(eq(schema.plannedWorkouts.id, id));
    }
    // … and the athlete drags the last one's event two hours later in Google.
    const last = ids.at(-1)!;
    const event = google.byWorkout(last)!;
    const shift = (iso: string) => new Date(Date.parse(iso) + 2 * 3_600_000).toISOString();
    event.body = { ...event.body, start: { ...event.body.start, dateTime: shift(event.body.start.dateTime) }, end: { ...event.body.end, dateTime: shift(event.body.end.dateTime) } };
    google.bump(event);

    const capped = await syncCalendar(db, env, userId);
    expect(capped).toMatchObject({ capped: true, updated: CALENDAR_OPS_PER_RUN, userMovesAccepted: 0 });

    const runs = await syncUntilSettled();
    expect(runs.reduce((n, r) => n + r.updated, 0)).toBe(changed.length - CALENDAR_OPS_PER_RUN);
    expect(runs.reduce((n, r) => n + r.userMovesAccepted, 0)).toBe(1);
    const [moved] = await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, last));
    expect(moved?.effectiveTime).toBe("09:00");
    // The athlete's placement stands in Google too: nothing moved their event back.
    const movedStart = event.body.start.dateTime;
    expect(Date.parse(google.byWorkout(last)!.body.start.dateTime)).toBe(Date.parse(movedStart));
  });

  it.each([true, false])("after a restore (sweep %s), a capped run keeps the one-shot reconcile open: full reads go on, the stale token is never used", async (sweep) => {
    // Just restored: the reconcile is flagged and the stored token predates the file.
    await db.insert(schema.accountState).values({
      userId,
      restoreFinishedAt: nowInstant(),
      calendarReconcile: { phase: "pending", sweep },
      updatedAt: nowInstant(),
    });
    await db.insert(schema.providerCursorState).values({
      id: `${userId}:google_calendar:events_sync_token:cal`,
      userId,
      provider: "google_calendar",
      cursorKey: "events_sync_token:cal",
      value: "0",
      updatedAt: nowInstant(),
    });
    const ids = await seedWorkouts(CALENDAR_OPS_PER_RUN + 10);

    const first = await syncCalendar(db, env, userId);
    expect(first).toMatchObject({ capped: true, created: CALENDAR_OPS_PER_RUN });
    expect((await loadAccountState(db, userId))?.calendarReconcile).not.toBeNull();

    const rest = await syncUntilSettled();
    expect(rest.reduce((n, r) => n + r.created, 0)).toBe(10);
    expect((await loadAccountState(db, userId))?.calendarReconcile).toBeNull();
    // Every read while the reconcile was open was a full one; only after it closed is a token used.
    expect(google.lists.slice(0, 1 + rest.length)).toEqual(Array(1 + rest.length).fill("full"));
    await syncCalendar(db, env, userId);
    expect(google.lists.at(-1)).toMatch(/^incremental:/);
    expect(google.lists).not.toContain("incremental:0");
    expect([...google.writes].sort()).toEqual(ids.map((id) => `insert:${id}`).sort());
  });

  it("adopting the athlete's moves builds no date formatter per move", async () => {
    const ids = await seedWorkouts(12);
    await syncUntilSettled();
    for (const id of ids) {
      const event = google.byWorkout(id)!;
      const later = (iso: string) => new Date(Date.parse(iso) + 3_600_000).toISOString();
      event.body = { ...event.body, start: { dateTime: later(event.body.start.dateTime) }, end: { dateTime: later(event.body.end.dateTime) } };
      google.bump(event);
    }
    let built = 0;
    const Real = Intl.DateTimeFormat;
    const counting = new Proxy(Real, {
      construct: (target, args) => ((built += 1), Reflect.construct(target, args)),
      apply: (target, self, args) => ((built += 1), Reflect.apply(target, self, args)),
    });
    vi.spyOn(Intl, "DateTimeFormat", "get").mockReturnValue(counting);
    const stats = await syncCalendar(db, env, userId);
    expect(stats.userMovesAccepted).toBe(12);
    // The run's own date work (today in the athlete's zone, the moves' local clock) — never one per move.
    expect(built).toBeLessThanOrEqual(3);
  });
});
