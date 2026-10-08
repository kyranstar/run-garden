/**
 * Google Calendar after a restore (audit 1 data finding 3, ruling B6, and the
 * four unsafe sweep paths in verify-1-data.md §R3).
 *
 * A restore brings back an older plan while the calendar still holds every
 * event written since. Before this: sessions added after the export kept
 * their events for good (nothing deletes an event whose workout id names no
 * row), the same sessions re-imported under new ids got a second event, a
 * workout whose event existed but whose link did not was "updated" without
 * ever being linked (so every later calendar edit the athlete made was
 * reverted), and a restored link whose event was gone became a permanent
 * "deleted from calendar".
 *
 * Now the first SUCCESSFUL FULL read after a restore — marker clear, Google
 * reconnected — runs a one-shot reconcile:
 *  (a) links events whose rgWorkoutId names a row of this account, live or
 *      archived (the normal path then deletes an archived row's event) — only
 *      events stamped with THIS app's origin, or unstamped ones the file
 *      already linked (ruling B10, M7): another deployment writing into the
 *      same calendar keeps its events;
 *  (b) recreates a restored link's event that is gone, unless the file held
 *      a user_deleted suppression for it;
 *  (c) deletes, at most 25 per sync (and the run's op budget) and resuming on later syncs, events that
 *      carry THIS app's origin and whose rgWorkoutId names no row — never an
 *      unstamped event, never one from another origin, never on a partial or
 *      failed read, and not at all when the restore came back short.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone } from "@rg/domain";
import type { GoogleEventResource } from "@rg/calendar";
import type { Db } from "../src/services/db.js";
import type { Env } from "../src/env.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

interface FakeEvent {
  id: string;
  status: "confirmed" | "cancelled";
  start: { dateTime: string };
  end: { dateTime: string };
  summary: string;
  description: string;
  extendedProperties: { private: Record<string, string> };
}

/** An in-memory Google calendar with the client's shape. */
class FakeGoogle {
  events = new Map<string, FakeEvent>();
  calls: string[] = [];
  failList = false;
  private seq = 0;

  add(opts: { workoutId: string; date: string; origin?: string | null; description?: string; status?: "confirmed" | "cancelled" }): string {
    const id = `ev-${++this.seq}`;
    const priv: Record<string, string> = { rgWorkoutId: opts.workoutId, rgApp: "Run Garden", rgFingerprint: "old-fp" };
    if (opts.origin !== null) priv.rgOrigin = opts.origin ?? "https://app.test";
    this.events.set(id, {
      id,
      status: opts.status ?? "confirmed",
      start: { dateTime: `${opts.date}T14:00:00Z` },
      end: { dateTime: `${opts.date}T15:00:00Z` },
      summary: "Run · old",
      description: opts.description ?? "old",
      extendedProperties: { private: priv },
    });
    return id;
  }

  live(id: string): boolean {
    return this.events.get(id)?.status === "confirmed";
  }

  client() {
    return {
      listCalendars: async () => [],
      createCalendar: async () => ({ id: "cal" }),
      freeBusy: async () => [],
      listEvents: async (_cal: string, opts: { syncToken?: string; timeMin?: string; timeMax?: string }) => {
        this.calls.push(opts.syncToken ? "list:incremental" : "list:full");
        if (this.failList) throw new Error("google_api_500");
        if (opts.syncToken) return { items: [], nextSyncToken: "tok-next" };
        const items = [...this.events.values()].filter(
          (e) => e.start.dateTime >= opts.timeMin! && e.start.dateTime <= opts.timeMax!,
        );
        return { items: structuredClone(items), nextSyncToken: "tok-full" };
      },
      insertEvent: async (_cal: string, resource: GoogleEventResource) => {
        const id = `ev-${++this.seq}`;
        this.events.set(id, {
          id,
          status: "confirmed",
          start: { dateTime: resource.start.dateTime },
          end: { dateTime: resource.end.dateTime },
          summary: resource.summary,
          description: resource.description,
          extendedProperties: structuredClone(resource.extendedProperties),
        });
        this.calls.push(`insert:${resource.extendedProperties.private.rgWorkoutId}`);
        return { id };
      },
      patchEvent: async (_cal: string, eventId: string) => {
        this.calls.push(`patch:${eventId}`);
      },
      deleteEvent: async (_cal: string, eventId: string) => {
        this.calls.push(`delete:${eventId}`);
        const e = this.events.get(eventId);
        if (e) e.status = "cancelled";
      },
    };
  }
}

const google = vi.hoisted(() => ({ fake: null as unknown }));
vi.mock("../src/services/google-calendar.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/google-calendar.js")>()),
  googleCalendarClient: vi.fn(async () => google.fake),
}));

import {
  CALENDAR_OPS_PER_RUN,
  loadPreferences,
  POST_RESTORE_DELETE_CAP,
  savePreferences,
  syncCalendar,
} from "../src/services/calendar-sync.js";
import { loadAccountState } from "../src/services/account-state.js";

const env = { APP_URL: "https://app.test" } as Env;

async function workout(db: Db, userId: string, date: string, over: Record<string, unknown> = {}): Promise<string> {
  const id = newId();
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
    calendarSyncState: "synced",
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 3600,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
    ...over,
  } as never);
  return id;
}

async function link(db: Db, workoutId: string, eventId: string, state = "synced"): Promise<void> {
  await db.insert(schema.calendarEventLinks).values({
    id: newId(),
    workoutId,
    calendarId: "cal",
    eventId,
    state,
    lastWrittenFingerprint: "old-fp",
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
}

async function linkOf(db: Db, workoutId: string) {
  const [row] = await db.select().from(schema.calendarEventLinks).where(eq(schema.calendarEventLinks.workoutId, workoutId));
  return row ?? null;
}

/** An account just restored: Google reconnected, reconcile flagged. */
async function restoredAccount(reconcile: { phase: "pending" | "sweeping"; sweep: boolean } | null = { phase: "pending", sweep: true }) {
  const db = makeTestDb({ boundVariableCap: 100 });
  const { userId } = await makeTestUser(db);
  const prefs = await loadPreferences(db, userId);
  await savePreferences(db, userId, { ...prefs, calendarId: "cal" });
  const today = todayInZone(prefs.timezone);
  const windowStart = addDays(today, -7 * prefs.mirrorWeeksBehind);
  const finishedAt = nowInstant();
  await db.insert(schema.accountState).values({
    userId,
    restoreFinishedAt: finishedAt,
    calendarReconcile: reconcile,
    updatedAt: finishedAt,
  });
  // A sync token from before the restore must NOT be trusted.
  await db.insert(schema.providerCursorState).values({
    id: `${userId}:google_calendar:events_sync_token:cal`,
    userId,
    provider: "google_calendar",
    cursorKey: "events_sync_token:cal",
    value: "tok-stale",
    updatedAt: nowInstant(),
  });
  const fake = new FakeGoogle();
  google.fake = fake.client();
  return { db, userId, today, windowStart, fake, finishedAt };
}

beforeEach(() => {
  google.fake = null;
});

describe("the one-shot post-restore calendar reconcile (B6)", () => {
  it("applies every rule on the first full read, then clears itself", async () => {
    const { db, userId, today, windowStart, fake, finishedAt } = await restoredAccount();
    const { userId: other } = await makeTestUser(db);

    // (a) live, no link, its event exists — the athlete had written notes on it.
    const linkless = await workout(db, userId, addDays(today, 3));
    const linklessEvent = fake.add({
      workoutId: linkless,
      date: addDays(today, 3),
      description: "Easy\n\n――― Your notes (kept when this event updates) ―――\nBring gels.\n\nManaged by Run Garden.",
    });
    // (a) archived in the window, no link — linked, then removed by the normal path.
    const archivedIn = await workout(db, userId, addDays(today, 6), { archivedAt: nowInstant() });
    const archivedInEvent = fake.add({ workoutId: archivedIn, date: addDays(today, 6) });
    // (b) a restored link whose event is gone — recreated.
    const gone = await workout(db, userId, addDays(today, 4));
    await link(db, gone, "ev-vanished");
    // (b) …unless the file held a user_deleted suppression for it.
    const userDeleted = await workout(db, userId, addDays(today, 5), { calendarSyncState: "user_deleted" });
    await link(db, userDeleted, "ev-deleted-by-athlete", "user_deleted");
    await db.insert(schema.calendarEventSuppressions).values({
      id: newId(),
      workoutId: userDeleted,
      eventId: "ev-deleted-by-athlete",
      reason: "user_deleted",
      createdAt: new Date(Date.parse(finishedAt) - 86_400_000).toISOString(),
    });
    // (c) orphans: this origin and no row → deleted.
    const orphan = fake.add({ workoutId: "added-after-the-export", date: addDays(today, 2) });
    // Never deleted: unstamped; another origin; a row of another account; already cancelled.
    const unstamped = fake.add({ workoutId: "pre-stamp-orphan", date: addDays(today, 2), origin: null });
    const staging = fake.add({ workoutId: "staging-only", date: addDays(today, 2), origin: "https://staging.test" });
    const theirs = fake.add({ workoutId: await workout(db, other, addDays(today, 2)), date: addDays(today, 2) });
    const cancelled = fake.add({ workoutId: "already-gone", date: addDays(today, 2), status: "cancelled" });
    // Unsafe path 1: a live row just outside the workout window, inside the
    // padded read range — "live" must come from ALL rows, not the window.
    const edge = await workout(db, userId, addDays(windowStart, -1));
    const edgeEvent = fake.add({ workoutId: edge, date: addDays(windowStart, -1) });
    // Unsafe path 4: an archived row outside the window — linked, never swept.
    const archivedOut = await workout(db, userId, addDays(windowStart, -1), { archivedAt: nowInstant() });
    const archivedOutEvent = fake.add({ workoutId: archivedOut, date: addDays(windowStart, -1) });

    const stats = await syncCalendar(db, env, userId);

    expect(fake.calls[0]).toBe("list:full");
    expect(fake.calls).not.toContain("list:incremental");
    // (a)
    expect(await linkOf(db, linkless)).toMatchObject({ eventId: linklessEvent, userNotes: "Bring gels." });
    expect(fake.calls).not.toContain(`insert:${linkless}`);
    expect(fake.live(linklessEvent)).toBe(true);
    expect(fake.calls).toContain(`delete:${archivedInEvent}`);
    expect(await linkOf(db, archivedIn)).toBeNull();
    expect(await linkOf(db, archivedOut)).toMatchObject({ eventId: archivedOutEvent });
    // (b)
    expect(fake.calls).toContain(`insert:${gone}`);
    expect((await linkOf(db, gone))?.eventId).not.toBe("ev-vanished");
    expect(fake.calls).not.toContain(`insert:${userDeleted}`);
    expect(
      await db
        .select()
        .from(schema.calendarEventSuppressions)
        .where(and(eq(schema.calendarEventSuppressions.workoutId, userDeleted), eq(schema.calendarEventSuppressions.reason, "user_deleted"))),
    ).toHaveLength(1);
    // (c)
    expect(fake.live(orphan)).toBe(false);
    for (const kept of [unstamped, staging, theirs, edgeEvent, archivedOutEvent]) expect(fake.live(kept), kept).toBe(true);
    expect(fake.calls).not.toContain(`delete:${cancelled}`);
    expect(stats.deleted).toBe(2); // the orphan (sweep) + the archived row's event (normal path)
    // Every event written from now on carries this app's origin.
    const created = [...fake.events.values()].find((e) => e.extendedProperties.private.rgWorkoutId === gone && e.status === "confirmed");
    expect(created?.extendedProperties.private.rgOrigin).toBe("https://app.test");

    expect((await loadAccountState(db, userId))?.calendarReconcile).toBeNull();
    // One-shot: the next sync is an ordinary incremental one.
    fake.calls = [];
    await syncCalendar(db, env, userId);
    expect(fake.calls[0]).toBe("list:incremental");
  });

  it("adopts only this app's events, or unstamped ones the file already linked (B10, M7)", async () => {
    const { db, userId, today, fake } = await restoredAccount();
    // Another deployment (prod, say, when a local stack restores prod's file)
    // wrote these into the same calendar, for the same workout ids.
    const live = await workout(db, userId, addDays(today, 3));
    const liveForeign = fake.add({ workoutId: live, date: addDays(today, 3), origin: "https://prod.test" });
    const archived = await workout(db, userId, addDays(today, 4), { archivedAt: nowInstant() });
    const archivedForeign = fake.add({ workoutId: archived, date: addDays(today, 4), origin: "https://prod.test" });
    // Unstamped, and nothing in the file links it: not ours to claim.
    const bare = await workout(db, userId, addDays(today, 5));
    const bareEvent = fake.add({ workoutId: bare, date: addDays(today, 5), origin: null });
    // Unstamped, but the file's own link names it: it stays linked.
    const linked = await workout(db, userId, addDays(today, 6));
    const linkedEvent = fake.add({ workoutId: linked, date: addDays(today, 6), origin: null });
    await link(db, linked, linkedEvent);
    // This app's own event: adopted, as before.
    const ours = await workout(db, userId, addDays(today, 2));
    const oursEvent = fake.add({ workoutId: ours, date: addDays(today, 2) });

    const stats = await syncCalendar(db, env, userId);

    // The other deployment's events are neither adopted, nor edited, nor deleted.
    for (const kept of [liveForeign, archivedForeign, bareEvent]) {
      expect(fake.live(kept), kept).toBe(true);
      expect(fake.calls).not.toContain(`patch:${kept}`);
      expect(fake.calls).not.toContain(`delete:${kept}`);
    }
    expect((await linkOf(db, live))?.eventId).not.toBe(liveForeign);
    expect(fake.calls).toContain(`insert:${live}`);
    expect(await linkOf(db, archived)).toBeNull();
    expect((await linkOf(db, bare))?.eventId).not.toBe(bareEvent);
    expect(fake.calls).toContain(`insert:${bare}`);
    expect(await linkOf(db, linked)).toMatchObject({ eventId: linkedEvent });
    expect(fake.calls).not.toContain(`insert:${linked}`);
    expect(await linkOf(db, ours)).toMatchObject({ eventId: oursEvent });
    expect(fake.calls).not.toContain(`insert:${ours}`);
    expect(stats.adopted).toBe(1);
  });

  it("never marks a session deleted, or deletes an event, because the file linked another app's event (m2)", async () => {
    const { db, userId, today, fake } = await restoredAccount();
    // The file links these sessions to events another deployment wrote into
    // the same calendar (a prod file rehearsed in staging, or APP_URL changed).
    const live = await workout(db, userId, addDays(today, 3));
    const liveForeign = fake.add({ workoutId: live, date: addDays(today, 3), origin: "https://prod.test" });
    await link(db, live, liveForeign);
    const cancelled = await workout(db, userId, addDays(today, 4));
    const cancelledForeign = fake.add({ workoutId: cancelled, date: addDays(today, 4), origin: "https://prod.test", status: "cancelled" });
    await link(db, cancelled, cancelledForeign);
    const archived = await workout(db, userId, addDays(today, 5), { archivedAt: nowInstant() });
    const archivedForeign = fake.add({ workoutId: archived, date: addDays(today, 5), origin: "https://prod.test" });
    await link(db, archived, archivedForeign);

    await syncCalendar(db, env, userId);

    for (const w of [live, cancelled]) {
      const [row] = await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, w));
      expect(row!.calendarSyncState, w).not.toBe("user_deleted");
      expect(await db.select().from(schema.calendarEventSuppressions).where(eq(schema.calendarEventSuppressions.workoutId, w))).toEqual([]);
      expect(fake.calls).toContain(`insert:${w}`);
    }
    for (const e of [liveForeign, archivedForeign]) {
      expect(fake.live(e), e).toBe(true);
      expect(fake.calls).not.toContain(`patch:${e}`);
      expect(fake.calls).not.toContain(`delete:${e}`);
    }
    expect(await linkOf(db, archived)).toBeNull();
  });

  it("deletes at most a run's op budget of orphans a sync and resumes on the next full read", async () => {
    const { db, userId, today, fake } = await restoredAccount();
    const orphans = Array.from({ length: 30 }, (_, i) => fake.add({ workoutId: `orphan-${i}`, date: addDays(today, 1 + (i % 10)) }));

    await syncCalendar(db, env, userId);
    // 25 a sync, and never more than the run's own budget (CALENDAR_OPS_PER_RUN, cron reliability 2026-10-08).
    expect(orphans.filter((id) => !fake.live(id))).toHaveLength(Math.min(POST_RESTORE_DELETE_CAP, CALENDAR_OPS_PER_RUN));
    expect((await loadAccountState(db, userId))?.calendarReconcile).toEqual({ phase: "sweeping", sweep: true });

    fake.calls = [];
    await syncCalendar(db, env, userId);
    expect(fake.calls[0]).toBe("list:full");
    expect(orphans.filter((id) => fake.live(id))).toEqual([]);
    expect((await loadAccountState(db, userId))?.calendarReconcile).toBeNull();
  });

  it("never acts on a failed read: nothing linked or deleted, the reconcile waits for a good one", async () => {
    const { db, userId, today, fake } = await restoredAccount();
    const linkless = await workout(db, userId, addDays(today, 3));
    fake.add({ workoutId: linkless, date: addDays(today, 3) });
    const orphan = fake.add({ workoutId: "added-after-the-export", date: addDays(today, 2) });
    fake.failList = true;

    await expect(syncCalendar(db, env, userId)).rejects.toThrow();
    expect(fake.live(orphan)).toBe(true);
    expect(await linkOf(db, linkless)).toBeNull();
    expect((await loadAccountState(db, userId))?.calendarReconcile).toEqual({ phase: "pending", sweep: true });

    fake.failList = false;
    await syncCalendar(db, env, userId);
    expect(fake.live(orphan)).toBe(false);
    expect(await linkOf(db, linkless)).not.toBeNull();
  });

  it("a restore that came back short links and recreates, but deletes nothing (unsafe path 2)", async () => {
    const { db, userId, today, fake } = await restoredAccount({ phase: "pending", sweep: false });
    // The page carrying this workout never landed: its event names no row.
    const lost = fake.add({ workoutId: "workout-whose-page-failed", date: addDays(today, 2) });
    const linkless = await workout(db, userId, addDays(today, 3));
    const linklessEvent = fake.add({ workoutId: linkless, date: addDays(today, 3) });

    await syncCalendar(db, env, userId);
    expect(fake.live(lost)).toBe(true);
    expect(await linkOf(db, linkless)).toMatchObject({ eventId: linklessEvent });
    expect((await loadAccountState(db, userId))?.calendarReconcile).toBeNull();
  });

  it("waits while Google is disconnected or a restore is still running", async () => {
    const { db, userId, today, fake } = await restoredAccount();
    const orphan = fake.add({ workoutId: "added-after-the-export", date: addDays(today, 2) });
    const client = google.fake;

    google.fake = null; // not reconnected yet
    expect(await syncCalendar(db, env, userId)).toMatchObject({ skipped: true });
    await db.update(schema.accountState).set({ restoreId: "r2" }).where(eq(schema.accountState.userId, userId));
    google.fake = client; // reconnected, but a second restore began
    expect(await syncCalendar(db, env, userId)).toMatchObject({ skipped: true });
    expect(fake.calls).toEqual([]);
    expect(fake.live(orphan)).toBe(true);
    expect((await loadAccountState(db, userId))?.calendarReconcile).toEqual({ phase: "pending", sweep: true });
  });
});
