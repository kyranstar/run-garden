/**
 * A CALENDAR RUN THAT DIES PART-WAY HEALS ON THE NEXT ONE (re-review C-2b, pre-existing).
 *
 * Workers Free kills an invocation without a trace (52 calendar runs left `running` since 2026-10-03). Killed between
 * Google's insert and the link's D1 insert, a run left an event of ours — it carries the workout id in its private
 * extended properties — that no link names. Every later run read it as an unlinked event, patched it, and recorded
 * nothing (the update's link write matched no row): one Google call and a cap slot per run, for ever. Now the run
 * that finds an unlinked event of ours for a workout adopts it — one patch, the link recorded — instead of patching
 * it again and again or inserting a second.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import type { Env } from "../src/env.js";
import { encryptSecret } from "../src/auth/crypto.js";
import { CALENDAR_OPS_PER_RUN, loadPreferences, savePreferences, syncCalendar } from "../src/services/calendar-sync.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const env = { APP_URL: "https://app.test", TOKEN_ENCRYPTION_KEY: TEST_KEY } as Env;

interface Ev {
  id: string;
  status: "confirmed" | "cancelled";
  seq: number;
  body: { start: { dateTime: string }; end: { dateTime: string }; extendedProperties: { private: Record<string, string> } } & Record<string, unknown>;
}

/** Copied from calendar-sync-budget.test.ts: Google with real sync-token semantics. */
class FakeGoogleApi {
  events = new Map<string, Ev>();
  fetches = 0;
  writes: string[] = [];
  lists: string[] = [];
  /** Events every write to answers 403 (a poisoned event, as executeOps' own comment lists). */
  forbidden = new Set<string>();
  private seq = 1;
  private n = 0;
  bump(e: Ev): void {
    e.seq = ++this.seq;
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
    if (this.forbidden.has(e.id)) return json({ error: { code: 403, message: "forbidden" } }, 403);
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
/** Set: the invocation is dead — every later statement and fetch throws (nothing after a kill runs). */
let dead = false;
/** Kill the invocation at the link insert that follows the Nth Google insert. */
let killAfterInsert = 0;

beforeEach(async () => {
  dead = false;
  killAfterInsert = 0;
  google = new FakeGoogleApi();
  db = makeTestDb({
    boundVariableCap: 100,
    onStatement: (sql) => {
      if (dead) throw new Error("killed");
      if (
        killAfterInsert > 0 &&
        google.writes.filter((w) => w.startsWith("insert:")).length === killAfterInsert &&
        /insert into "calendar_event_links"/i.test(sql)
      ) {
        dead = true;
        throw new Error("killed");
      }
    },
  });
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
  const real = google.fetch;
  vi.stubGlobal("fetch", (async (i: RequestInfo | URL, init?: RequestInit) => {
    if (dead) throw new Error("killed");
    return real(i, init);
  }) as typeof fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function seedWorkouts(count: number, from = 1): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `w-next-${String(i).padStart(3, "0")}`;
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

describe("a calendar run killed part-way", () => {
  it("killed between Google's insert and the link: later runs converge to one event and one link per workout, then go quiet", async () => {
    const ids = await seedWorkouts(CALENDAR_OPS_PER_RUN + 5);
    killAfterInsert = 7;
    // executeOps swallows per-op errors, so the "kill" surfaces when the run's own tail statements throw.
    await expect(syncCalendar(db, env, userId)).rejects.toThrow("killed");
    dead = false;
    killAfterInsert = 0;
    for (let i = 0; i < 6; i++) await syncCalendar(db, env, userId);
    const events = [...google.events.values()].filter((e) => e.status === "confirmed");
    const perWorkout = new Map<string, number>();
    for (const e of events) {
      const wid = e.body.extendedProperties.private.rgWorkoutId!;
      perWorkout.set(wid, (perWorkout.get(wid) ?? 0) + 1);
    }
    const links = await db.select().from(schema.calendarEventLinks);
    const writesBefore = google.writes.length;
    const steady = await syncCalendar(db, env, userId);
    expect({
      dup: [...perWorkout].filter(([, n]) => n > 1),
      unlinked: ids.filter((id) => !links.some((l) => l.workoutId === id)),
      quietWrites: google.writes.slice(writesBefore),
      updated: steady.updated,
    }).toEqual({ dup: [], unlinked: [], quietWrites: [], updated: 0 });
    expect(events).toHaveLength(ids.length);
    expect(links).toHaveLength(ids.length);
  });

  it("one workout, killed between the insert and the link: the next run leaves exactly one event, linked, then goes quiet", async () => {
    const [id] = await seedWorkouts(1);
    killAfterInsert = 1;
    await expect(syncCalendar(db, env, userId)).rejects.toThrow("killed");
    dead = false;
    killAfterInsert = 0;
    expect(await db.select().from(schema.calendarEventLinks)).toEqual([]);
    const next = await syncCalendar(db, env, userId);
    const events = [...google.events.values()].filter((e) => e.status === "confirmed");
    const links = await db.select().from(schema.calendarEventLinks);
    expect({ events: events.map((e) => e.body.extendedProperties.private.rgWorkoutId), links: links.map((l) => [l.workoutId, l.eventId]) }).toEqual({
      events: [id],
      links: [[id, events[0]!.id]],
    });
    expect(next.created).toBe(0);
    expect((await db.select().from(schema.plannedWorkouts)).map((w) => w.calendarSyncState)).toEqual(["synced"]);
    const writesBefore = google.writes.length;
    for (let i = 0; i < 2; i++) await syncCalendar(db, env, userId);
    expect(google.writes.slice(writesBefore)).toEqual([]);
  });
});
