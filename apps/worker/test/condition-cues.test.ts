/**
 * A CONDITION'S DAYTIME CUE ON THE CALENDAR (condition care gaps, Task 3).
 *
 * `PUT /api/conditions/:profileId/cues { times }` puts one recurring event per time on the calendar the athlete chose
 * for the app — five minutes, free, one alert at its start, on the first seven days of each month, at the athlete's
 * wall-clock time in their zone — and `DELETE` takes them off. The events' ids are kept in the preferences.
 *
 * What these pin:
 *  - The event, exactly; its first occurrence, and its clock time across a change of clocks, as Google expands it.
 *  - Every PUT reads the calendar once: the same times it holds write nothing; one the athlete deleted or moved by
 *    hand is put back. Other times: the old ones go first, then the new ones. An occurrence the athlete changed or
 *    deleted one day is never taken for a cue of its own.
 *  - A call that fails part way leaves the stored ids saying what is there, and the answer names it; a create whose
 *    answer was lost is found on the calendar by the next request, never made twice; a retry finishes the job.
 *  - DELETE removes exactly those events and clears them.
 *  - A calendar sync — incremental, full, and the post-restore reconcile with its orphan sweep — never lists a cue as
 *    one of its own: it never moves, re-times or deletes one (calendar-sync.ts owns an event only by `rgWorkoutId`).
 *  - The export carries the ids and a restore makes no event; a state a restore brought back is checked against the
 *    calendar before it is trusted, so nothing is doubled.
 *  - Plain refusals: no Google connection, no calendar, a condition with no cue or not on, bad times, a change already
 *    under way. An expired token refreshes as every Google call's does.
 *  - The statements and subrequests a request spends (Workers Free: 50 subrequests, D1 statements and fetches
 *    together).
 *
 * Google is a fake behind `fetch` (never called for real), with sync-token semantics and the expansion of the one
 * recurrence rule a cue uses. Synthetic zones, dates and times throughout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone } from "@rg/domain";
import { TMJ } from "@rg/exercise-library";
import type { Db } from "../src/services/db.js";
import type { Env } from "../src/env.js";
import { encryptSecret } from "../src/auth/crypto.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { conditionSettingsRoutes } from "../src/routes/conditions.js";
import { settingsRoutes } from "../src/routes/misc.js";
import { loadPreferences, savePreferences, syncCalendar } from "../src/services/calendar-sync.js";
import { setCondition } from "../src/services/user-conditions.js";
import { patchAccountState } from "../src/services/account-state.js";
import { claimUserLock } from "../src/services/locks.js";
import { CUE_CALLS_PER_REQUEST, CUE_LOCK } from "../src/services/condition-cues.js";
import { importStandalone } from "../src/services/standalone-import.js";
import { backup, history } from "./fixtures/standalone-backup.js";
import { exportAll, restoreAll } from "./restore-driver.js";
import { FakeGoogle, type FakeBody } from "./fake-google-calendar.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

/** Runs once, just before the standalone import's one batch — after it read the preferences: what lands meanwhile. */
const race = vi.hoisted(() => ({ before: null as null | (() => Promise<unknown>) }));
vi.mock("../src/services/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/db.js")>();
  return {
    ...actual,
    runAtomically: async (...args: Parameters<typeof actual.runAtomically>) => {
      const hook = race.before;
      race.before = null;
      await hook?.();
      return actual.runAtomically(...args);
    },
  };
});

// A second profile the library doesn't have, with no cue: the refusal for a condition that has none.
vi.mock("@rg/exercise-library", async (importOriginal) => {
  const lib = await importOriginal<typeof import("@rg/exercise-library")>();
  const quiet = { ...lib.TMJ, id: "quiet", label: "Quiet knees", cue: undefined };
  const ids = [...lib.PROFILE_IDS, "quiet"];
  return {
    ...lib,
    PROFILES: { ...lib.PROFILES, quiet },
    PROFILE_IDS: ids,
    isProfileId: (id: string) => ids.includes(id),
    profileById: (id: string) => (id === "quiet" ? quiet : lib.profileById(id)),
  };
});

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const ENV = {
  APP_URL: "https://app.test",
  TOKEN_ENCRYPTION_KEY: TEST_KEY,
  GOOGLE_CLIENT_ID: "c",
  GOOGLE_CLIENT_SECRET: "c",
  SESSION_SECRET: "s",
  AI_DEFAULT_ENABLED: "0",
} as unknown as Env;
const ORIGIN = "https://app.test";

/** A synthetic zone, and a moment in it: 10:00 on the 10th, so every cue starts on the 1st of the next month. */
const ZONE = "America/Denver";
const NOW = "2030-04-10T16:00:00Z";
const FIRST_DAY = "2030-05-01";
const A = "07:15";
const B = "13:40";
const C = "18:05";
const D = "21:30";

const NOT_CONNECTED = "Google Calendar isn't connected. Connect it in Settings, then try again.";
const READ_FAILED = "Google Calendar didn't answer, so nothing changed. Try again.";
const DESCRIPTION = "Run Garden's daytime cue for TMJ. To stop it, delete this event and all its repeats.";

// ── The account ───────────────────────────────────────────────────────────────────────────────────────────────────

let db: Db;
let statements: string[];
let userId: string;
let cookie: string;
let google: FakeGoogle;

async function connectGoogle(opts: { expired?: boolean } = {}): Promise<void> {
  await db.delete(schema.providerConnections).where(eq(schema.providerConnections.userId, userId));
  await db.insert(schema.providerConnections).values({
    id: newId(),
    userId,
    provider: "google_calendar",
    status: "connected",
    encryptedRefreshToken: await encryptSecret("refresh", TEST_KEY),
    encryptedAccessToken: await encryptSecret("access", TEST_KEY),
    accessTokenExpiresAt: new Date(Date.now() + (opts.expired ? -60_000 : 3_600_000)).toISOString(),
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (sql) => statements.push(sql) });
  ({ userId } = await makeTestUser(db, { timezone: ZONE, calendarId: "cal" }));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
  await setCondition(db, userId, { profileId: "tmj", active: true }, { today: todayInZone(ZONE) });
  await connectGoogle();
  google = new FakeGoogle({ now: NOW, zone: ZONE, origin: ORIGIN, firstDay: FIRST_DAY });
  vi.stubGlobal("fetch", google.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  race.before = null;
});

type Answer = { status: number; body: Record<string, unknown> };

async function call(method: string, path: string, body?: unknown, routes = conditionSettingsRoutes, base = "/api/conditions"): Promise<Answer> {
  const res = await mountRoutes(db, base, routes).request(
    path,
    { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
    ENV,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const put = (times: unknown, profileId = "tmj") => call("PUT", `/api/conditions/${profileId}/cues`, { times });
const del = (profileId = "tmj") => call("DELETE", `/api/conditions/${profileId}/cues`);

const stored = async () => (await loadPreferences(db, userId)).conditionCues?.tmj;
const storedTimes = async () => ((await stored())?.events ?? []).map((e) => e.time).sort();
/** The live cue series' times, as their wall clock reads. */
const liveTimes = (calendarId = "cal") => google.liveCues(calendarId).map((e) => e.body.start.dateTime.slice(11, 16)).sort();
const idOf = async (time: string) => (await stored())!.events.find((e) => e.time === time)!.eventId;

const cues = (times: string[], timezone = ZONE) => ({ profileId: "tmj", words: "Teeth apart, jaw soft", times, timezone });

// ── Putting cues on ───────────────────────────────────────────────────────────────────────────────────────────────

describe("PUT /api/conditions/:profileId/cues", () => {
  it("puts one recurring event per time: the cue's words, five minutes, free, one alert at its start, days 1–7 of each month, in the athlete's zone", async () => {
    const res = await put([B, A]);
    expect(res).toEqual({ status: 200, body: { cues: cues([A, B]), done: true } });
    // A first change reads the calendar for cues already there (none), then makes one event per time, in order.
    expect(google.calls).toEqual(["GET cal", "POST cal", "POST cal"]);
    const made = google.liveCues();
    expect(made.map((e) => e.body)).toEqual(
      [A, B].map((t) => ({
        summary: TMJ.cue,
        description: DESCRIPTION,
        start: { dateTime: `${FIRST_DAY}T${t}:00`, timeZone: ZONE },
        end: { dateTime: `${FIRST_DAY}T${t === A ? "07:20" : "13:45"}:00`, timeZone: ZONE },
        recurrence: ["RRULE:FREQ=MONTHLY;BYMONTHDAY=1,2,3,4,5,6,7"],
        transparency: "transparent",
        reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 0 }] },
        extendedProperties: { private: { rgCue: "tmj", rgApp: "Run Garden", rgOrigin: ORIGIN } },
      })),
    );
    expect(made.some((e) => "rgWorkoutId" in (e.body.extendedProperties?.private ?? {}))).toBe(false);
    // The ids are kept, by profile, with the calendar and zone they went to.
    expect(await stored()).toEqual({
      events: [
        { time: A, eventId: made[0]!.id, calendarId: "cal", timezone: ZONE },
        { time: B, eventId: made[1]!.id, calendarId: "cal", timezone: ZONE },
      ],
      settledAt: NOW.replace("Z", ".000Z"),
    });
    // The first occurrence, as Google expands the rule: the 1st of next month at the athlete's clock time (MDT, UTC−6).
    expect(google.firstOccurrence(made[0]!.id)).toBe("2030-05-01T13:15:00.000Z");
    // …and then the 2nd to the 7th, then the 1st of the month after.
    const days = google.occurrences(made[0]!, "2030-04-01T00:00:00Z", "2030-06-02T00:00:00Z").map((o) => o.start.toISODate());
    expect(days).toEqual(["2030-05-01", "2030-05-02", "2030-05-03", "2030-05-04", "2030-05-05", "2030-05-06", "2030-05-07", "2030-06-01"]);
  });

  it("starts today when today is one of the first seven days in the athlete's zone and the time is still ahead, though UTC is a day on", async () => {
    // 02:00 UTC on the 8th is 16:00 on the 7th in Honolulu (UTC−10, no change of clocks).
    vi.setSystemTime(new Date("2030-05-08T02:00:00Z"));
    const prefs = await loadPreferences(db, userId);
    await savePreferences(db, userId, { ...prefs, timezone: "Pacific/Honolulu" });
    expect((await put(["17:30", "15:00"])).status).toBe(200);
    const byTime = new Map(google.liveCues().map((e) => [e.body.start.dateTime.slice(11, 16), e]));
    expect(byTime.get("17:30")!.body.start.dateTime).toBe("2030-05-07T17:30:00");
    expect(google.firstOccurrence(byTime.get("17:30")!.id)).toBe("2030-05-08T03:30:00.000Z");
    // 15:00 has passed on the 7th, the last of the seven days: the 1st of next month.
    expect(byTime.get("15:00")!.body.start.dateTime).toBe("2030-06-01T15:00:00");
  });

  it("keeps the athlete's clock time across a change of clocks: a wall-clock start and a zone, never an offset", async () => {
    // Mid-February in Chicago: the cue starts 1 March (CST, UTC−6); clocks go forward on the 10th; 1 April is CDT (UTC−5).
    vi.setSystemTime(new Date("2030-02-15T18:00:00Z"));
    const prefs = await loadPreferences(db, userId);
    await savePreferences(db, userId, { ...prefs, timezone: "America/Chicago" });
    expect((await put([A])).status).toBe(200);
    const [e] = google.liveCues();
    expect(e!.body.start).toEqual({ dateTime: "2030-03-01T07:15:00", timeZone: "America/Chicago" });
    const at = google.occurrences(e!, "2030-03-01T00:00:00Z", "2030-04-02T00:00:00Z").map((o) => o.start.toUTC().toISO());
    expect(at[0]).toBe("2030-03-01T13:15:00.000Z");
    expect(at.at(-1)).toBe("2030-04-01T12:15:00.000Z");
  });

  it("the same times again, in any order: one read of the calendar, which holds them, and no write", async () => {
    await put([A, B]);
    const before = { prefs: await stored() };
    statements.length = 0;
    google.calls.length = 0;
    expect(await put([B, A])).toEqual({ status: 200, body: { cues: cues([A, B]), done: true } });
    expect(google.calls).toEqual(["GET cal"]);
    expect(statements.filter(isWrite)).toEqual([]);
    expect(await stored()).toEqual(before.prefs);
    expect(liveTimes()).toEqual([A, B]);
  });

  it("the same times after the athlete deleted them in Google by hand: they are put back", async () => {
    await put([A, B]);
    google.cancel(await idOf(A));
    google.cancel(await idOf(B));
    google.calls.length = 0;
    expect(await put([A, B])).toEqual({ status: 200, body: { cues: cues([A, B]), done: true } });
    // Read and found missing; read again under the lock; made again.
    expect(google.calls).toEqual(["GET cal", "GET cal", "POST cal", "POST cal"]);
    expect(liveTimes()).toEqual([A, B]);
    expect(await stored()).toMatchObject({ events: google.liveCues().map((e) => ({ eventId: e.id })) });
  });

  it("the same times after the athlete moved one by hand: it is put back at its time", async () => {
    await put([A]);
    const id = await idOf(A);
    google.moveSeries(id, "08:00");
    google.calls.length = 0;
    expect(await put([A])).toEqual({ status: 200, body: { cues: cues([A]), done: true } });
    expect(google.calls).toEqual(["GET cal", "GET cal", `DELETE cal/${id}`, "POST cal"]);
    expect(liveTimes()).toEqual([A]);
  });

  it("the same times with an extra cue of ours beside them on the calendar: the extra goes", async () => {
    await put([A]);
    const extra = google.addCue(B);
    google.calls.length = 0;
    expect((await put([A])).status).toBe(200);
    expect(google.calls).toEqual(["GET cal", "GET cal", `DELETE cal/${extra}`]);
    expect(liveTimes()).toEqual([A]);
  });

  it("the same times with no Google connection now: refused in plain words, nothing claimed", async () => {
    await put([A]);
    await db.delete(schema.providerConnections).where(eq(schema.providerConnections.userId, userId));
    expect(await put([A])).toEqual({ status: 412, body: { error: "google_not_connected", message: NOT_CONNECTED } });
  });

  it("the same times, and the calendar read fails: nothing claimed", async () => {
    await put([A]);
    google.fail("GET", 1, "500");
    google.calls.length = 0;
    expect(await put([A])).toEqual({ status: 502, body: { error: "calendar_failed", done: false, message: READ_FAILED, cues: cues([A]) } });
    expect(google.calls).toEqual(["GET cal"]);
  });

  it("other times keeping one the athlete moved by hand: the moved one goes, and its time is made again", async () => {
    await put([A, B]);
    const moved = await idOf(A);
    google.moveSeries(moved, "08:00");
    expect((await put([A, C])).status).toBe(200);
    expect(liveTimes()).toEqual([A, C]);
    expect(google.events.get(moved)!.status).toBe("cancelled");
  });

  it("other times: the old ones go first, then the new ones are made; a time in both is kept as it is", async () => {
    await put([A, B]);
    const keptId = await idOf(B);
    const goneId = await idOf(A);
    google.calls.length = 0;
    expect(await put([B, C])).toEqual({ status: 200, body: { cues: cues([B, C]), done: true } });
    // One read of the calendar, then the change.
    expect(google.calls).toEqual(["GET cal", `DELETE cal/${goneId}`, "POST cal"]);
    expect(liveTimes()).toEqual([B, C]);
    expect(await idOf(B)).toBe(keptId);
    expect(await storedTimes()).toEqual([B, C]);
  });

  it("an empty list takes them all off", async () => {
    await put([A]);
    expect(await put([])).toEqual({ status: 200, body: { cues: cues([]), done: true } });
    expect(google.liveCues()).toEqual([]);
    expect(await stored()).toMatchObject({ events: [] });
  });

  it("a delete that fails part way: nothing new is made, the one still there stays stored and is named; a retry finishes", async () => {
    await put([A, B]);
    const bId = await idOf(B);
    google.calls.length = 0;
    google.fail("DELETE", 2, "500");
    const res = await put([C]);
    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      error: "calendar_failed",
      done: false,
      message: `Google Calendar didn't finish the change. On your calendar now: ${B}. Not on it yet: ${C}. Try again to finish.`,
      cues: cues([B]),
    });
    expect(google.writes().filter((c) => c.startsWith("POST"))).toEqual([]);
    expect(await stored()).toMatchObject({ events: [{ time: B, eventId: bId }] });
    expect(liveTimes()).toEqual([B]);

    google.calls.length = 0;
    expect(await put([C])).toEqual({ status: 200, body: { cues: cues([C]), done: true } });
    expect(google.calls).toEqual(["GET cal", `DELETE cal/${bId}`, "POST cal"]);
    expect(liveTimes()).toEqual([C]);
    expect(await storedTimes()).toEqual([C]);
  });

  it("a create Google refuses: nothing stored for it, what was made is stored and named; a retry makes the rest, once", async () => {
    google.fail("POST", 2, "403");
    const res = await put([A, B, C]);
    expect(res).toEqual({
      status: 502,
      body: {
        error: "calendar_failed",
        done: false,
        message: `Google Calendar didn't finish the change. On your calendar now: ${A}. Not on it yet: ${B}, ${C}. Try again to finish.`,
        cues: cues([A]),
      },
    });
    expect(liveTimes()).toEqual([A]);
    expect(await stored()).toMatchObject({ events: [{ time: A, eventId: google.liveCues()[0]!.id }] });
    expect((await stored())!.settledAt).not.toBeNull();

    google.calls.length = 0;
    expect((await put([A, B, C])).status).toBe(200);
    // A refusal is certain: the retry finds only the one made, and makes the two that are missing.
    expect(google.calls).toEqual(["GET cal", "POST cal", "POST cal"]);
    expect(liveTimes()).toEqual([A, B, C]);
    expect(await storedTimes()).toEqual([A, B, C]);
  });

  it.each([
    ["Google made it, and its answer was lost", "lost", [A, B]],
    ["Google made it, and the connection dropped", "lost-throw", [A, B]],
    ["Google failed with no answer to trust", "500", [A]],
    ["the connection dropped before Google saw it", "throw", [A]],
  ] as const)("a create with no answer to trust (%s): the next request reads the calendar, keeps what's there and makes only what isn't", async (_why, answer, there) => {
    google.fail("POST", 2, answer);
    const res = await put([A, B]);
    expect(res.status).toBe(502);
    expect(res.body.message).toBe(
      `Google Calendar didn't finish the change. On your calendar now: ${A}. Not on it yet: ${B}. Google didn't answer for ${B}, so it may be there too: trying again checks. Try again to finish.`,
    );
    expect(liveTimes()).toEqual(there);
    // Not settled: the stored ids may not be all there is.
    expect((await stored())!.settledAt).toBeNull();

    google.calls.length = 0;
    expect(await put([A, B])).toEqual({ status: 200, body: { cues: cues([A, B]), done: true } });
    expect(google.calls).toEqual(there.length === 2 ? ["GET cal"] : ["GET cal", "POST cal"]);
    expect(liveTimes()).toEqual([A, B]);
    expect(await stored()).toMatchObject({ events: google.liveCues().map((e) => ({ eventId: e.id })) });
    expect((await stored())!.settledAt).not.toBeNull();
  });

  it("an event the athlete already deleted in Google (410), or that Google no longer has (404), counts as gone", async () => {
    await put([A, B]);
    google.cancel(await idOf(A));
    google.events.delete(await idOf(B));
    expect(await put([C])).toEqual({ status: 200, body: { cues: cues([C]), done: true } });
    expect(liveTimes()).toEqual([C]);
    expect(await storedTimes()).toEqual([C]);
  });

  it("a request stops at its call budget and says so; the next one finishes", async () => {
    // Stray cue series this deployment made and lost track of (no state on record): more than one request may write.
    const strays = Array.from({ length: CUE_CALLS_PER_REQUEST + 2 }, (_, i) => `${String(i).padStart(2, "0")}:30`);
    for (const t of strays) google.addCue(t);
    const first = await put([A]);
    expect(first.status).toBe(202);
    expect(first.body).toEqual({
      done: false,
      message: `Part done. On your calendar now: ${strays.slice(-2).join(", ")}. Not on it yet: ${A}. Try again to finish.`,
      cues: cues(strays.slice(-2)),
    });
    expect(google.writes()).toHaveLength(CUE_CALLS_PER_REQUEST);
    expect(google.liveCues()).toHaveLength(2);

    expect(await put([A])).toEqual({ status: 200, body: { cues: cues([A]), done: true } });
    expect(liveTimes()).toEqual([A]);
  });

  it("a calendar or zone changed since: the old events go from where they are, the new ones go to the calendar and zone now", async () => {
    await put([A]);
    const old = await idOf(A);
    const prefs = await loadPreferences(db, userId);
    await savePreferences(db, userId, { ...prefs, calendarId: "cal2" });
    google.calls.length = 0;
    expect((await put([A])).status).toBe(200);
    expect(google.calls).toEqual(["GET cal2", `DELETE cal/${old}`, "POST cal2"]);
    expect(liveTimes("cal")).toEqual([]);
    expect(liveTimes("cal2")).toEqual([A]);

    await savePreferences(db, userId, { ...(await loadPreferences(db, userId)), timezone: "America/Chicago" });
    expect(await put([A])).toEqual({ status: 200, body: { cues: cues([A], "America/Chicago"), done: true } });
    expect(google.liveCues("cal2").map((e) => e.body.start.timeZone)).toEqual(["America/Chicago"]);
  });

  it("finds a cue on the calendar it has no record of, and keeps or removes it rather than doubling it; another deployment's are never touched", async () => {
    const lost = google.addCue(A);
    const other = google.addCue(A, { origin: "https://other.test" });
    const otherProfile = google.addCue(B, { profileId: "quiet" });
    statements.length = 0;
    expect(await put([A])).toEqual({ status: 200, body: { cues: cues([A]), done: true } });
    // Nothing written to Google, so the sync's token stands: session 1, restore marker 1, condition 1, preferences 1,
    // account state 1; the lock 3; preferences again 1; the connection 1; settled 1; the lock let go 1.
    expect(statements).toHaveLength(12);
    expect(google.calls).toEqual(["GET cal"]);
    // The read is a search for this profile's series: no occurrences, no deleted events.
    const q = new URLSearchParams(google.queries[0]);
    expect({ property: q.get("privateExtendedProperty"), single: q.get("singleEvents"), deleted: q.get("showDeleted") }).toEqual({
      property: "rgCue=tmj",
      single: "false",
      deleted: "false",
    });
    expect(await stored()).toMatchObject({ events: [{ time: A, eventId: lost }] });
    expect(google.events.get(other)!.status).toBe("confirmed");
    expect(google.events.get(otherProfile)!.status).toBe("confirmed");
  });

  it("takes only this profile's cues from the calendar's answer, even one holding more than the search asked for", async () => {
    google.ignoreProperty = true;
    const session = google.add("cal", {
      summary: "Run · Easy",
      start: { dateTime: "2030-05-02T13:00:00Z", timeZone: ZONE },
      end: { dateTime: "2030-05-02T14:00:00Z", timeZone: ZONE },
      extendedProperties: { private: { rgWorkoutId: "w-1", rgApp: "Run Garden", rgOrigin: ORIGIN } },
    });
    const own = google.add("cal", { summary: "Dentist", start: { dateTime: "2030-05-02T15:00:00Z", timeZone: ZONE }, end: { dateTime: "2030-05-02T16:00:00Z", timeZone: ZONE } });
    const otherProfile = google.addCue(B, { profileId: "quiet" });
    expect(await put([A])).toEqual({ status: 200, body: { cues: cues([A]), done: true } });
    expect(google.calls).toEqual(["GET cal", "POST cal"]);
    for (const id of [session, own, otherProfile]) expect(google.events.get(id)!.status).toBe("confirmed");
  });

  it("an occurrence the athlete changed by hand (Google lists it as its own event) is not taken for a cue, with nothing on record", async () => {
    const series = google.addCue(A);
    google.modifyOccurrence(series, "2030-05-02");
    expect(await put([A])).toEqual({ status: 200, body: { cues: cues([A]), done: true } });
    expect(google.writes()).toEqual([]);
    expect(google.events.get(series)!.status).toBe("confirmed");
    expect(await stored()).toMatchObject({ events: [{ time: A, eventId: series }] });
  });

  it.each([
    ["settled here", false],
    ["brought back by a restore", true],
  ])("…nor with a list on record (%s): the athlete's changed day is left alone, and the series kept", async (_why, restored) => {
    await put([A]);
    const series = await idOf(A);
    google.modifyOccurrence(series, "2030-05-02");
    if (restored) await patchAccountState(db, userId, { restoreFinishedAt: new Date(Date.parse(NOW) + 1000).toISOString() });
    google.calls.length = 0;
    expect(await put([A])).toEqual({ status: 200, body: { cues: cues([A]), done: true } });
    expect(google.writes()).toEqual([]);
    expect(await stored()).toMatchObject({ events: [{ time: A, eventId: series }] });
  });

  it("an answer holding deleted events though none were asked for: none is taken for a cue", async () => {
    const gone = google.addCue(A);
    google.cancel(gone);
    google.answersDeleted = true;
    expect((await put([A])).status).toBe(200);
    expect(google.calls).toEqual(["GET cal", "POST cal"]);
    expect(liveTimes()).toEqual([A]);
  });

  it("a calendar the list names that Google no longer has: its events count as gone", async () => {
    await savePreferences(db, userId, { ...(await loadPreferences(db, userId)), calendarId: "cal2" });
    await put([A]);
    // The athlete deleted that calendar, and chose another; and the list is one a restore brought back.
    google.calendars.delete("cal2");
    await savePreferences(db, userId, { ...(await loadPreferences(db, userId)), calendarId: "cal" });
    await patchAccountState(db, userId, { restoreFinishedAt: new Date(Date.parse(NOW) + 1000).toISOString() });
    google.calls.length = 0;
    expect(await put([A])).toEqual({ status: 200, body: { cues: cues([A]), done: true } });
    expect(google.calls).toEqual(["GET cal", "GET cal2", "POST cal"]);
    expect(await stored()).toMatchObject({ events: [{ time: A, calendarId: "cal" }] });
  });

  it("an empty list with the condition switched off still takes them off", async () => {
    await put([A]);
    await setCondition(db, userId, { profileId: "tmj", active: false }, { today: todayInZone(ZONE) });
    expect(await put([])).toEqual({ status: 200, body: { cues: cues([]), done: true } });
    expect(google.liveCues()).toEqual([]);
  });

  it("an empty list for a condition with no cue is not refused: there is nothing to take off", async () => {
    expect(await put([], "quiet")).toEqual({
      status: 200,
      body: { cues: { profileId: "quiet", words: null, times: [], timezone: ZONE }, done: true },
    });
  });

  it("a cue change makes the next sync read its window in full, not every changed occurrence for months; the same times don't", async () => {
    await seedSessions(2);
    await syncCalendar(db, ENV, userId);
    await put([A, B]);
    google.queries.length = 0;
    await syncCalendar(db, ENV, userId);
    const after = new URLSearchParams(google.queries.at(-1));
    expect({ token: after.get("syncToken"), from: after.get("timeMin") !== null }).toEqual({ token: null, from: true });
    // The same times write nothing, so the sync's token stands.
    await put([A, B]);
    google.queries.length = 0;
    await syncCalendar(db, ENV, userId);
    expect(new URLSearchParams(google.queries.at(-1)).get("syncToken")).not.toBeNull();
    // Turning them off is a change too.
    await del();
    google.queries.length = 0;
    await syncCalendar(db, ENV, userId);
    expect(new URLSearchParams(google.queries.at(-1)).get("syncToken")).toBeNull();
  });

  it("an occurrence the athlete deleted by hand is not taken for a cue of its own: the series is kept", async () => {
    const series = google.addCue(A);
    google.cancelOccurrence(series, "2030-05-02");
    expect(await put([A])).toEqual({ status: 200, body: { cues: cues([A]), done: true } });
    expect(google.writes()).toEqual([]);
    expect(await stored()).toMatchObject({ events: [{ time: A, eventId: series }] });
  });

  it("a cue the athlete turned into an all-day event is theirs now: left alone, and the time is made", async () => {
    const mine = google.add("cal", {
      summary: "mine now",
      start: { date: "2030-05-01" },
      end: { date: "2030-05-02" },
      extendedProperties: { private: { rgCue: "tmj", rgApp: "Run Garden", rgOrigin: ORIGIN } },
    } as unknown as FakeBody);
    expect((await put([A])).status).toBe(200);
    expect(google.calls).toEqual(["GET cal", "POST cal"]);
    expect(google.events.get(mine)!.status).toBe("confirmed");
    expect(await storedTimes()).toEqual([A]);
  });

  it("two events at one time (both found on the calendar): one is kept and the extra goes, even after a failed delete left both on the list", async () => {
    const first = google.addCue(A);
    const second = google.addCue(A);
    google.fail("DELETE", 1, "500");
    const res = await put([A]);
    expect(res.status).toBe(502);
    expect(res.body.message).toBe(`Google Calendar didn't finish the change. On your calendar now: ${A}. Try again to finish.`);
    expect(await stored()).toMatchObject({ events: [{ eventId: first }, { eventId: second }] });
    expect((await stored())!.settledAt).not.toBeNull();

    google.calls.length = 0;
    expect(await put([A])).toEqual({ status: 200, body: { cues: cues([A]), done: true } });
    expect(google.calls).toEqual(["GET cal", `DELETE cal/${second}`]);
    expect(google.liveCues().map((e) => e.id)).toEqual([first]);
  });

  it("a calendar read that fails changes nothing, and says so", async () => {
    google.fail("GET", 1, "500");
    expect(await put([A])).toEqual({
      status: 502,
      body: { error: "calendar_failed", done: false, message: "Google Calendar didn't answer, so nothing changed. Try again.", cues: cues([]) },
    });
    expect(google.writes()).toEqual([]);
    expect(await stored()).toBeUndefined();
  });

  it("a request cut off after Google made an event: the next one finds it on the calendar and never makes it twice", async () => {
    await put([A]);
    google.fail("POST", 1, "hang");
    // Dies after Google made the event for B, before the list could be written.
    void put([A, B]);
    await vi.waitFor(() => expect(google.liveCues()).toHaveLength(2));
    // Its lock goes stale.
    vi.setSystemTime(new Date(Date.parse(NOW) + 3 * 60_000));
    google.calls.length = 0;
    expect(await put([A, B])).toEqual({ status: 200, body: { cues: cues([A, B]), done: true } });
    expect(google.calls).toEqual(["GET cal"]);
    expect(liveTimes()).toEqual([A, B]);
  });

  it("a request whose calls run out while making the new ones says which aren't on yet; the next makes them", async () => {
    const strays = Array.from({ length: CUE_CALLS_PER_REQUEST - 2 }, (_, i) => `${String(i).padStart(2, "0")}:30`);
    for (const t of strays) google.addCue(t);
    expect(await put([A, B, C, D])).toEqual({
      status: 202,
      body: { done: false, message: `Part done. On your calendar now: ${A}, ${B}. Not on it yet: ${C}, ${D}. Try again to finish.`, cues: cues([A, B]) },
    });
    google.calls.length = 0;
    expect((await put([A, B, C, D])).status).toBe(200);
    expect(google.calls).toEqual(["GET cal", "POST cal", "POST cal"]);
    expect(liveTimes()).toEqual([A, B, C, D]);
  });
});

// ── Refusals ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe("refusals, in plain words, before any call", () => {
  it("no Google connection", async () => {
    await db.delete(schema.providerConnections).where(eq(schema.providerConnections.userId, userId));
    expect(await put([A])).toEqual({
      status: 412,
      body: { error: "google_not_connected", message: "Google Calendar isn't connected. Connect it in Settings, then try again." },
    });
    expect(google.fetches).toBe(0);
    expect(await stored()).toBeUndefined();
  });

  it("no calendar chosen for the app's events", async () => {
    await savePreferences(db, userId, { ...(await loadPreferences(db, userId)), calendarId: null });
    expect(await put([A])).toEqual({
      status: 412,
      body: { error: "no_calendar", message: "No calendar is chosen for the app's events yet. Choose one in Settings, then try again." },
    });
    expect(google.fetches).toBe(0);
  });

  it("a condition with no cue", async () => {
    await setCondition(db, userId, { profileId: "quiet", active: true }, { today: todayInZone(ZONE) });
    expect(await put([A], "quiet")).toEqual({ status: 422, body: { error: "no_cue", message: "Quiet knees has no daytime cue." } });
    expect(google.fetches).toBe(0);
  });

  it("a condition the athlete doesn't have on", async () => {
    await setCondition(db, userId, { profileId: "tmj", active: false }, { today: todayInZone(ZONE) });
    expect(await put([A])).toEqual({ status: 409, body: { error: "condition_off", message: "TMJ isn't switched on. Switch it on first." } });
    expect(google.fetches).toBe(0);
  });

  it("a condition the library doesn't know", async () => {
    expect(await put([A], "nope")).toEqual({ status: 422, body: { error: "unknown_profile", message: "No such condition." } });
    expect(await del("nope")).toEqual({ status: 422, body: { error: "unknown_profile", message: "No such condition." } });
  });

  it.each([
    [["7:15"], 'a time is 24-hour "HH:MM", like "07:15"'],
    [["24:00"], 'a time is 24-hour "HH:MM", like "07:15"'],
    [[A, B, A], "a time is listed twice"],
    [["01:00", "02:00", "03:00", "04:00", "05:00"], "at most 4 times"],
  ])("times %j", async (times, message) => {
    expect(await put(times)).toEqual({ status: 422, body: { error: "invalid_cue_times", message } });
    expect(google.fetches).toBe(0);
  });

  it.each([[undefined], ["07:15"], [[715]]])("a body that isn't { times: [...] }: %j", async (times) => {
    const res = await call("PUT", "/api/conditions/tmj/cues", times === undefined ? {} : { times });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("invalid_cue_times");
    expect(typeof res.body.message).toBe("string");
  });

  it("an extra field", async () => {
    const res = await call("PUT", "/api/conditions/tmj/cues", { times: [A], at: "now" });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("invalid_cue_times");
  });

  it("a change to the cues already under way: refused, not doubled", async () => {
    expect(await claimUserLock(db, userId, CUE_LOCK)).not.toBeNull();
    expect(await put([A])).toEqual({
      status: 409,
      body: { error: "cues_busy", message: "Another change to these cues is still going. Try again in a moment." },
    });
    expect(google.fetches).toBe(0);
  });

  it("the lock is let go after a change, and after a refusal inside it", async () => {
    await put([A]);
    await db.delete(schema.providerConnections).where(eq(schema.providerConnections.userId, userId));
    expect((await put([B])).status).toBe(412);
    await connectGoogle();
    expect((await put([B])).status).toBe(200);
  });
});

// ── Tokens ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("tokens", () => {
  it("an access token that has expired refreshes as every Google call's does, and the new one is kept", async () => {
    await connectGoogle({ expired: true });
    expect((await put([A, B])).status).toBe(200);
    expect(google.refreshes).toBe(1);
    expect(new Set(google.bearers)).toEqual(new Set(["Bearer fresh-access"]));
    const [conn] = await db.select().from(schema.providerConnections).where(eq(schema.providerConnections.userId, userId));
    expect(conn!.accessTokenExpiresAt! > nowInstant()).toBe(true);
    expect(conn!.status).toBe("connected");
  });

  it("a 401 part way refreshes once and the call goes through", async () => {
    await put([A]);
    google.fail("POST", 1, "401");
    expect((await put([A, B])).status).toBe(200);
    expect(google.refreshes).toBe(1);
    expect(liveTimes()).toEqual([A, B]);
  });

  it("a token Google won't refresh after a 401: nothing was made, the list stays settled, and the connection asks to reconnect", async () => {
    await put([A]);
    google.fail("POST", 1, "401");
    google.refuseRefresh = true;
    expect(await put([A, B])).toEqual({
      status: 502,
      body: {
        error: "calendar_failed",
        done: false,
        message: `Google Calendar didn't finish the change. On your calendar now: ${A}. Not on it yet: ${B}. Try again to finish.`,
        cues: cues([A]),
      },
    });
    expect((await stored())!.settledAt).not.toBeNull();
    const [conn] = await db.select().from(schema.providerConnections).where(eq(schema.providerConnections.userId, userId));
    expect(conn).toMatchObject({ status: "error", lastErrorCategory: "token_expired" });
  });
});

// ── Turning them off ──────────────────────────────────────────────────────────────────────────────────────────────

describe("DELETE /api/conditions/:profileId/cues", () => {
  it("removes exactly those events and clears them; the athlete's own events, the sessions' and another deployment's stay", async () => {
    await put([A, B]);
    const ids = [await idOf(A), await idOf(B)];
    const own = google.add("cal", { summary: "Dentist", start: { dateTime: "2030-05-02T15:00:00Z" }, end: { dateTime: "2030-05-02T16:00:00Z" } });
    const other = google.addCue(C, { origin: "https://other.test" });
    google.calls.length = 0;
    expect(await del()).toEqual({ status: 200, body: { cues: cues([]), done: true } });
    expect(google.calls).toEqual(ids.map((id) => `DELETE cal/${id}`));
    expect(google.live().map((e) => e.id).sort()).toEqual([own, other].sort());
    expect(await stored()).toEqual({ events: [], settledAt: NOW.replace("Z", ".000Z") });
  });

  it("again: no call, no write", async () => {
    await put([A]);
    await del();
    statements.length = 0;
    const fetches = google.fetches;
    expect(await del()).toEqual({ status: 200, body: { cues: cues([]), done: true } });
    expect(google.fetches).toBe(fetches);
    expect(statements.filter(isWrite)).toEqual([]);
  });

  it("a delete that fails part way keeps the one still there and names it; a retry finishes", async () => {
    await put([A, B]);
    const bId = await idOf(B);
    google.fail("DELETE", 2, "throw");
    expect(await del()).toEqual({
      status: 502,
      body: {
        error: "calendar_failed",
        done: false,
        message: `Google Calendar didn't remove them all. Still on your calendar: ${B}. Try again to finish.`,
        cues: cues([B]),
      },
    });
    expect(await stored()).toMatchObject({ events: [{ time: B, eventId: bId }] });
    google.calls.length = 0;
    expect((await del()).status).toBe(200);
    expect(google.calls).toEqual([`DELETE cal/${bId}`]);
    expect(google.liveCues()).toEqual([]);
  });

  it("works with the condition switched off", async () => {
    await put([A]);
    await setCondition(db, userId, { profileId: "tmj", active: false }, { today: todayInZone(ZONE) });
    expect((await del()).status).toBe(200);
    expect(google.liveCues()).toEqual([]);
  });

  it("with no Google connection: refused, and the ids kept", async () => {
    await put([A]);
    const before = await stored();
    await db.delete(schema.providerConnections).where(eq(schema.providerConnections.userId, userId));
    expect(await del()).toEqual({
      status: 412,
      body: { error: "google_not_connected", message: "Google Calendar isn't connected. Connect it in Settings, then try again." },
    });
    expect(await stored()).toEqual(before);
  });

  it("with nothing on record, reads the calendar once for cues it lost track of, and removes them", async () => {
    const lost = google.addCue(A);
    expect((await del()).status).toBe(200);
    expect(google.calls).toEqual(["GET cal", `DELETE cal/${lost}`]);
    expect(google.liveCues()).toEqual([]);
  });

  it("after a create whose answer was lost: it looks for what Google made, and removes that too", async () => {
    google.fail("POST", 2, "lost");
    expect((await put([A, B])).status).toBe(502);
    expect(liveTimes()).toEqual([A, B]);
    google.calls.length = 0;
    expect(await del()).toEqual({ status: 200, body: { cues: cues([]), done: true } });
    expect(google.calls[0]).toBe("GET cal");
    expect(google.liveCues()).toEqual([]);
  });

  it("more events than one request's calls: it says what is still there, and the next one finishes", async () => {
    const strays = Array.from({ length: CUE_CALLS_PER_REQUEST + 2 }, (_, i) => `${String(i).padStart(2, "0")}:30`);
    for (const t of strays) google.addCue(t);
    expect(await del()).toEqual({
      status: 202,
      body: { done: false, message: `Part done. Still on your calendar: ${strays.slice(-2).join(", ")}. Try again to finish.`, cues: cues(strays.slice(-2)) },
    });
    expect(google.liveCues()).toHaveLength(2);
    google.calls.length = 0;
    expect(await del()).toEqual({ status: 200, body: { cues: cues([]), done: true } });
    expect(google.calls).toHaveLength(2);
    expect(google.liveCues()).toEqual([]);
  });

  it("with no calendar chosen and nothing on record, it can't look: refused in plain words, never done", async () => {
    google.addCue(A);
    await savePreferences(db, userId, { ...(await loadPreferences(db, userId)), calendarId: null });
    expect(await del()).toEqual({
      status: 412,
      body: { error: "no_calendar", message: "No calendar is chosen for the app's events, so the app can't look for cues on it. Choose one in Settings, then try again." },
    });
    expect(google.calls).toEqual([]);
    expect(google.liveCues()).toHaveLength(1);
  });

  it("after a restore, with a day the athlete changed: the series goes, the changed day is not taken for one", async () => {
    await put([A]);
    const series = await idOf(A);
    google.modifyOccurrence(series, "2030-05-02");
    await patchAccountState(db, userId, { restoreFinishedAt: new Date(Date.parse(NOW) + 1000).toISOString() });
    google.calls.length = 0;
    expect((await del()).status).toBe(200);
    expect(google.calls).toEqual(["GET cal", `DELETE cal/${series}`]);
  });

  it("with no calendar chosen now, a list not settled here is read where its events are, and removed", async () => {
    await put([A]);
    const id = await idOf(A);
    await patchAccountState(db, userId, { restoreFinishedAt: new Date(Date.parse(NOW) + 1000).toISOString() });
    await savePreferences(db, userId, { ...(await loadPreferences(db, userId)), calendarId: null });
    google.calls.length = 0;
    expect((await del()).status).toBe(200);
    expect(google.calls).toEqual(["GET cal", `DELETE cal/${id}`]);
    expect(google.liveCues()).toEqual([]);
  });
});

// ── The session mirror never takes a cue for its own ──────────────────────────────────────────────────────────────

async function seedSessions(count: number): Promise<string[]> {
  const today = todayInZone(ZONE);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `w-${i}`;
    const date = addDays(today, 1 + i * 3);
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
      effectiveTime: "07:15",
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

describe("a calendar sync after cues are set", () => {
  it("never lists one as its own: no move, re-time or delete, on a first full read, an incremental one, a full resync and the post-restore reconcile", async () => {
    await put([A, B]);
    await seedSessions(4);
    const syncWrites: string[] = [];
    const sync = async (opts?: Parameters<typeof syncCalendar>[3]) => {
      const from = google.calls.length;
      const stats = await syncCalendar(db, ENV, userId, opts);
      syncWrites.push(...google.calls.slice(from).filter((c) => !c.startsWith("GET")));
      return stats;
    };
    const cueItems = () => google.listed.filter((i) => (i.extendedProperties as { private?: Record<string, string> } | undefined)?.private?.rgCue === "tmj");
    const quiet = { created: 0, updated: 0, deleted: 0, userMovesAccepted: 0, userDeletions: 0, notesPreserved: 0 };

    // First sync: a full read of the window. The pin isn't empty: the read held the cues' occurrences.
    google.listed.length = 0;
    expect(await sync()).toMatchObject({ ...quiet, skipped: false, created: 4 });
    expect(cueItems().length).toBeGreaterThan(0);

    // A cue change between syncs puts cancelled and new occurrences in the next incremental read.
    await put([B, C]);
    const cueIds = [...google.events.values()].filter((e) => e.body.extendedProperties?.private?.rgCue).map((e) => e.id);
    const cueBodies = google.liveCues().map((e) => structuredClone(e.body));
    google.listed.length = 0;
    expect(await sync()).toMatchObject(quiet);
    expect(cueItems().some((i) => i.status === "cancelled")).toBe(true);
    expect(cueItems().some((i) => i.status === "confirmed")).toBe(true);

    expect(await sync({ fullResync: true })).toMatchObject(quiet);

    // The one-shot reconcile after a restore: adoption by workout id, and the sweep of this app's events naming no row.
    await patchAccountState(db, userId, { calendarReconcile: { phase: "pending", sweep: true }, restoreFinishedAt: nowInstant() });
    const reconciled = await sync();
    expect(reconciled).toMatchObject(quiet);
    expect(reconciled.orphansDeleted ?? 0).toBe(0);
    expect(reconciled.adopted ?? 0).toBe(0);
    expect((await db.select().from(schema.accountState).where(eq(schema.accountState.userId, userId)))[0]!.calendarReconcile).toBeNull();

    // Every write the syncs made was a session's own event: four creates, and nothing to a cue or an occurrence of one.
    expect(syncWrites).toEqual(["POST cal", "POST cal", "POST cal", "POST cal"]);
    expect(google.liveCues().map((e) => e.body)).toEqual(cueBodies);
    expect(liveTimes()).toEqual([B, C]);
    const links = await db.select().from(schema.calendarEventLinks);
    expect(links).toHaveLength(4);
    expect(links.filter((l) => cueIds.some((id) => l.eventId === id || l.eventId.startsWith(`${id}_`)))).toEqual([]);
  });
});

// ── Export and restore ────────────────────────────────────────────────────────────────────────────────────────────

describe("export and restore", () => {
  it("the export carries the ids; a restore makes no event and a sync after it touches none; the same times after it make no second set", async () => {
    await put([A, B]);
    const file = await exportAll(db, userId);
    const cuesBefore = await stored();
    const fetches = google.fetches;
    await restoreAll(db, userId, file);
    expect(google.fetches).toBe(fetches);
    expect(await stored()).toEqual(cuesBefore);

    await connectGoogle();
    await syncCalendar(db, ENV, userId);
    expect(liveTimes()).toEqual([A, B]);
    vi.setSystemTime(new Date(Date.parse(NOW) + 60_000));

    // A state a restore brought back is read against the calendar once — here it holds — and is this account's again.
    google.calls.length = 0;
    expect(await put([A, B])).toEqual({ status: 200, body: { cues: cues([A, B]), done: true } });
    expect(google.calls).toEqual(["GET cal"]);
    expect(google.liveCues()).toHaveLength(2);
    google.calls.length = 0;
    expect((await put([A, B])).status).toBe(200);
    expect(google.calls).toEqual(["GET cal"]);
    // Settled again by this account: turning them off removes exactly those, with no read.
    const ids = (await stored())!.events.map((e) => e.eventId);
    google.calls.length = 0;
    expect((await del()).status).toBe(200);
    expect(google.calls).toEqual(ids.map((id) => `DELETE cal/${id}`));
  });

  it("a file older than the cues' last change: the next change trusts the calendar, not the file, so nothing is doubled or left behind", async () => {
    await put([A]);
    const file = await exportAll(db, userId);
    await put([B]);
    const bId = await idOf(B);
    await restoreAll(db, userId, file);
    await connectGoogle();
    expect(await storedTimes()).toEqual([A]);

    google.calls.length = 0;
    expect(await put([A])).toEqual({ status: 200, body: { cues: cues([A]), done: true } });
    expect(google.calls).toEqual(["GET cal", `DELETE cal/${bId}`, "POST cal"]);
    expect(liveTimes()).toEqual([A]);
  });

  it("turning them off after a restore of an older file removes what is really there", async () => {
    await put([A]);
    const file = await exportAll(db, userId);
    await put([B]);
    await restoreAll(db, userId, file);
    await connectGoogle();
    expect((await del()).status).toBe(200);
    expect(google.liveCues()).toEqual([]);
    expect(await stored()).toMatchObject({ events: [] });
  });
});

// ── The ids are the cue service's alone ───────────────────────────────────────────────────────────────────────────

describe("the stored ids are written only by the cue service", () => {
  it("a settings save that sends them is not taken: what is stored stays, and is what the answer says", async () => {
    await put([A]);
    const before = await stored();
    const res = await call("PUT", "/api/settings", { theme: "dark", conditionCues: { tmj: { events: [], settledAt: null } } }, settingsRoutes, "/api/settings");
    expect(res.status).toBe(200);
    expect((res.body.prefs as { conditionCues?: unknown }).conditionCues).toEqual({ tmj: before });
    expect(await stored()).toEqual(before);
    expect((await loadPreferences(db, userId)).theme).toBe("dark");
  });

  it("a save that names them never invents them: not for an account with none stored, nor one with no preferences yet", async () => {
    const invented = { tmj: { events: [{ time: A, eventId: "invented", calendarId: "cal", timezone: ZONE }], settledAt: nowInstant() } };
    const prefs = await loadPreferences(db, userId);
    await savePreferences(db, userId, { ...prefs, conditionCues: invented });
    expect(await stored()).toBeUndefined();

    const fresh = newId();
    await db.insert(schema.users).values({ id: fresh, email: `runner-${fresh}@example.com`, googleSub: `sub-${fresh}`, createdAt: nowInstant() });
    await savePreferences(db, fresh, { ...prefs, conditionCues: invented });
    expect((await loadPreferences(db, fresh)).conditionCues).toBeUndefined();
    expect((await loadPreferences(db, fresh)).timezone).toBe(ZONE);
  });

  it("a whole-preferences save from a read taken before the cues were set keeps them", async () => {
    const stale = await loadPreferences(db, userId);
    await put([A]);
    const before = await stored();
    await savePreferences(db, userId, { ...stale, theme: "light" });
    expect(await stored()).toEqual(before);
    expect((await loadPreferences(db, userId)).theme).toBe("light");
  });
});

// ── Delete-all, and the standalone import ──────────────────────────────────────────────────────────────────────────

describe("delete-all", () => {
  const deleteAll = () => call("POST", "/api/settings/delete-all", { confirm: "delete everything" }, settingsRoutes, "/api/settings");
  const userGone = async () => (await db.select().from(schema.users).where(eq(schema.users.id, userId))).length === 0;
  const warnings = (warn: { mock: { calls: unknown[][] } }) =>
    warn.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>).filter((w) => w.msg === "delete-all: a condition's cues not taken off");

  it("takes the cues off the calendar first, through the cue service, then deletes everything", async () => {
    await put([A, B]);
    const ids = [await idOf(A), await idOf(B)];
    google.calls.length = 0;
    expect(await deleteAll()).toEqual({ status: 200, body: { ok: true } });
    expect(google.writes()).toEqual(ids.map((id) => `DELETE cal/${id}`));
    expect(google.liveCues()).toEqual([]);
    expect(await userGone()).toBe(true);
  });

  it.each([
    ["Google fails part way", "calendar_failed", () => google.fail("DELETE", 1, "500")],
    ["Google isn't connected", "google_not_connected", () => db.delete(schema.providerConnections).where(eq(schema.providerConnections.userId, userId))],
    ["another change to them is under way", "cues_busy", () => claimUserLock(db, userId, CUE_LOCK)],
  ] as const)("when they can't be taken off (%s): the delete goes on, and the code is logged", async (_why, code, arrange) => {
    await put([A]);
    await arrange();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await deleteAll()).toEqual({ status: 200, body: { ok: true } });
    expect(await userGone()).toBe(true);
    expect(warnings(warn)).toEqual([{ level: "warn", msg: "delete-all: a condition's cues not taken off", profileId: "tmj", code }]);
  });

  it("takes off a list for a condition the library no longer has, and cues it has no list for (a file from before them restored)", async () => {
    const lost = google.addCue(A);
    const retired = google.addCue(B, { profileId: "retired" });
    const list = { retired: { events: [{ time: B, eventId: retired, calendarId: "cal", timezone: ZONE }], settledAt: nowInstant() } };
    await db.run(sql`UPDATE user_preferences SET prefs = json_set(prefs, '$.conditionCues', json(${JSON.stringify(list)})) WHERE user_id = ${userId}`);
    expect(await deleteAll()).toEqual({ status: 200, body: { ok: true } });
    expect(google.events.get(lost)!.status).toBe("cancelled");
    expect(google.events.get(retired)!.status).toBe("cancelled");
  });

  it("preferences that can't be read don't stop the delete: each profile is tried, and logged", async () => {
    await put([A]);
    await db.run(sql`UPDATE user_preferences SET prefs = 'not json' WHERE user_id = ${userId}`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await deleteAll()).toEqual({ status: 200, body: { ok: true } });
    expect(await userGone()).toBe(true);
    expect(warnings(warn)).toEqual([{ level: "warn", msg: "delete-all: a condition's cues not taken off", profileId: "tmj", code: "exception" }]);
  });

  it("a cue service that throws doesn't stop the delete either", async () => {
    await put([A]);
    // Thrown from below the service: the connection's token can't be decrypted.
    await db.update(schema.providerConnections).set({ encryptedAccessToken: "not-a-token" }).where(eq(schema.providerConnections.userId, userId));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await deleteAll()).toEqual({ status: 200, body: { ok: true } });
    expect(await userGone()).toBe(true);
    expect(warnings(warn).map((w) => w.code)).toEqual(["exception"]);
  });
});

describe("a first standalone import beside a cue change", () => {
  it("keeps the cue ids a change wrote after the import read the preferences", async () => {
    await put([A]);
    // Lands between the import's read of the preferences and its write of them.
    race.before = () => put([B]);
    const summary = await importStandalone(db, userId, backup(history()), { today: todayInZone(ZONE), now: nowInstant(), timezone: ZONE, dryRun: false });
    expect(summary.firstImport).toBe(true);
    expect(await storedTimes()).toEqual([B]);
    expect(await stored()).toMatchObject({ events: [{ eventId: google.liveCues()[0]!.id }] });
    expect(liveTimes()).toEqual([B]);
  });
});

// ── What a request spends ─────────────────────────────────────────────────────────────────────────────────────────

describe("what a request spends (Workers Free: 50 subrequests, D1 statements and fetches together)", () => {
  it("the most a change spends: a state to check against the calendar, an expired token, four times replaced by four", async () => {
    await put([A, B, C, D]);
    // As a restore would leave it: the state was settled before the restore finished.
    await patchAccountState(db, userId, { restoreFinishedAt: new Date(Date.parse(NOW) + 1000).toISOString() });
    await connectGoogle({ expired: true });
    statements.length = 0;
    const fetches = google.fetches;
    expect((await put(["06:10", "10:20", "15:50", "20:45"])).status).toBe(200);
    const spent = { statements: statements.length, fetches: google.fetches - fetches };
    // D1: session 1, restore marker 1, condition 1, preferences 1, account state 1; the lock 3; preferences again 1;
    // the connection 1, the refreshed token 1; not settled 1; the sync's token forgotten 1; settled 1; the lock let go 1.
    // Fetches: the token 1, the calendar read 1, four deletes, four creates.
    expect(spent).toEqual({ statements: 15, fetches: 10 });
    expect(spent.statements).toBeLessThanOrEqual(45);
    expect(spent.statements + spent.fetches).toBeLessThanOrEqual(50);
  });

  it("the most turning them off spends", async () => {
    await put([A, B, C, D]);
    await patchAccountState(db, userId, { restoreFinishedAt: new Date(Date.parse(NOW) + 1000).toISOString() });
    await connectGoogle({ expired: true });
    statements.length = 0;
    const fetches = google.fetches;
    expect((await del()).status).toBe(200);
    const spent = { statements: statements.length, fetches: google.fetches - fetches };
    // D1: session 1, restore marker 1, preferences 1, account state 1; the lock 3; preferences again 1; the connection
    // 1, the refreshed token 1; the sync's token forgotten 1; settled 1; the lock let go 1. Fetches: the token 1, the
    // calendar read 1, four deletes.
    expect(spent).toEqual({ statements: 13, fetches: 6 });
    expect(spent.statements + spent.fetches).toBeLessThanOrEqual(50);
  });

  it("the same times again: reads only — five statements and the connection, one fetch", async () => {
    await put([A, B]);
    statements.length = 0;
    const fetches = google.fetches;
    await put([A, B]);
    // Session 1, restore marker 1, condition 1, preferences 1, account state 1; the connection 1. The calendar read.
    expect(statements).toHaveLength(6);
    expect(statements.filter(isWrite)).toEqual([]);
    expect(google.fetches - fetches).toBe(1);
  });

  it("the most the same times spend when the athlete moved every series by hand: they are put back", async () => {
    await put([A, B, C, D]);
    for (const e of google.liveCues()) google.moveSeries(e.id, "05:05");
    await connectGoogle({ expired: true });
    statements.length = 0;
    const fetches = google.fetches;
    expect((await put([A, B, C, D])).status).toBe(200);
    const spent = { statements: statements.length, fetches: google.fetches - fetches };
    // D1: session 1, restore marker 1, condition 1, preferences 1, account state 1; the connection 1, the refreshed
    // token 1; the lock 3; preferences again 1 (the client is the one already made); not settled 1; the sync's token
    // forgotten 1; settled 1; the lock let go 1. Fetches: the token 1, the calendar read twice (before the lock, and
    // under it), four deletes, four creates.
    expect(spent).toEqual({ statements: 15, fetches: 11 });
    expect(spent.statements + spent.fetches).toBeLessThanOrEqual(50);
    expect(liveTimes()).toEqual([A, B, C, D]);
  });
});
