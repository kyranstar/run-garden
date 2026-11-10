/**
 * THE SMALLEST AUTHENTICATED WORKOUT, FROM THE PHONE (SLICE-CONTRACT revision 2 §11), through the real routes: the
 * phone's token builds `{}`, starts `{buildId}` and saves the performed session; the web (the same account's cookie) is
 * the other client. What the server already answers for two clients is the contract, and these pin it for a device:
 *
 *  - a save carrying `review.graduations` or `review.excluded` (plan edits), or not the app's own, is 403
 *    `out_of_scope` before any write (§9.6, §10.5);
 *  - an interrupted save, retried with the token, is `same_payload`: one performed session, the same ids, one credit;
 *  - a web change while the phone is offline: the web saves the slot first (`slot_done`), moves or skips it (refused
 *    while the phone's session is under way, the save then lands), removes it after a Discard (`slot_gone`), or saves the
 *    same id with other edits (`conflict`) — each with the rows it leaves;
 *  - Build and Start's provider effects are the web's (DEVICE_PROVIDER_EFFECTS, the owner's open question 2).
 *
 * The record compared is the rows themselves: performed sessions, activities, matches, the slot, and the garden's
 * credits per day after the cron has walked them. Under a faked `Date`, D1's bind cap on; `fetch` stubbed, the Calendar
 * sync mocked and counted. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, performedSessionSaveSchema } from "@rg/domain";
import { syncCalendar } from "../src/services/calendar-sync.js";

vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

import { DEVICE_PROVIDER_EFFECTS } from "../src/auth/native-devices.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import { advanceGarden, ensureGarden, REQUEST_GARDEN_STEP } from "../src/services/garden-sync.js";
import { reconcileCompletionStates } from "../src/services/reconcile-daily.js";
import { nativeRoutes } from "../src/routes/native.js";
import { planRoutes } from "../src/routes/plan.js";
import { sessionRoutes } from "../src/routes/sessions.js";
import { workoutRoutes } from "../src/routes/workouts.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { nativeWorld, seedDevice, seedSlot, type Answer, type NativeWorld } from "./native-fixture.js";

const { exercisePrefs, trainingPlans } = schema;

const LA = "America/Los_Angeles";
const GENESIS = "2026-11-02";
const D = "2026-11-18"; // a Wednesday
const instant = (date: string, hhmm: string) => DateTime.fromISO(`${date}T${hhmm}`, { zone: LA }).toUTC().toISO()!;
const setClock = (date: string, hhmm: string) => vi.setSystemTime(new Date(instant(date, hhmm)));

/** The first statement matching this dies (the invocation killed part-way); it clears itself as it fires. */
let killAt: RegExp | null = null;
let w: NativeWorld;
let token: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.stubGlobal("fetch", (async () => new Response("{}", { status: 404 })) as typeof fetch);
  vi.mocked(syncCalendar).mockClear();
  killAt = null;
  setClock(GENESIS, "12:00");
  w = await nativeWorld(
    [
      ["/api/native", nativeRoutes],
      ["/api/sessions", sessionRoutes],
      ["/api/plan", planRoutes],
      ["/api/workouts", workoutRoutes],
    ],
    {
      onStatement: (s) => {
        if (killAt?.test(s)) {
          killAt = null;
          throw new Error("the invocation died here");
        }
      },
    },
  );
  await w.db.insert(trainingPlans).values({ id: `plan-${w.userId.slice(0, 8)}`, userId: w.userId, sourcePlanId: "slice-plan", name: "Synthetic plan", startDate: "2026-10-20", endDate: "2026-12-31", status: "active", createdAt: nowInstant(), updatedAt: nowInstant() });
  await ensureGarden(w.db, w.userId, await loadPreferences(w.db, w.userId), GENESIS);
  ({ token } = await seedDevice(w.db, w.userId, { expiresAt: "2027-06-01T00:00:00.000Z" }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const q = (sql: string, ...args: unknown[]): any[] =>
  (w.db as unknown as { $client: { prepare(s: string): { all(...a: unknown[]): any[] } } }).$client.prepare(sql).all(...args);

async function walkGarden(from: string, to: string): Promise<void> {
  for (let d = from; d <= to; d = addDays(d, 1)) {
    setClock(d, "03:15");
    const prefs = await loadPreferences(w.db, w.userId);
    await reconcileCompletionStates(w.db, w.userId, prefs);
    for (let i = 0; i < 40; i++) {
      const r = await advanceGarden(w.db, w.userId, prefs, new Date(), REQUEST_GARDEN_STEP);
      if (!r.resimPending && r.simulatedDays === 0) break;
    }
  }
}

/** The rows a save writes, and the garden's credits by day (after the walk). */
function record() {
  return {
    sessions: q(`select id, workout_id as workout, activity_id as activity, source, local_date as day, note from performed_sessions where user_id = ? order by id`, w.userId),
    activities: q(`select id, source, completion_match_id is not null as matched from activities where user_id = ? order by id`, w.userId),
    matches: q(`select workout_id as workout, activity_id as activity, method, undone_at is not null as undone from workout_completion_matches order by rowid`),
    credits: q(`select id, input from garden_day_inputs where id like ? order by id`, `${w.userId}:%`).flatMap((r) =>
      (JSON.parse(r.input).completedRuns as Array<{ workoutId: string; activityId?: string; unplanned?: boolean }>).map((c) => ({
        date: (r.id as string).slice(w.userId.length + 1),
        workout: c.workoutId,
        activity: c.activityId ?? null,
        unplanned: c.unplanned === true,
      })),
    ),
  };
}
const rowOf = (id: string) =>
  q(`select effective_date as date, completion_state as completion, content_state as content, archived_at is not null as archived from planned_workouts where id = ?`, id)[0];

/** A Studio workout on `day`, made on the laptop the day before. */
async function workoutOn(day: string): Promise<string> {
  setClock(addDays(day, -1), "12:00");
  const made = await w.call("POST", "/api/workouts", { body: { doc: calmDoc(), date: day, time: "18:00", clientId: `slot-${newId()}` } });
  expect(made.status, made.text).toBeLessThan(300);
  return made.json.workout.id as string;
}

/** The phone opens the day's row and starts it: GET, Build `{}`, Start `{buildId}` — each with its token. */
async function phoneStarts(id: string): Promise<any> {
  setClock(D, "17:55");
  const today = await w.call("GET", "/api/native/today", { bearer: token });
  expect(today.json.sessions.map((s: { id: string }) => s.id)).toContain(id);
  expect((await w.call("GET", `/api/sessions/${id}`, { bearer: token })).status).toBe(200);
  const built = await w.call("POST", `/api/sessions/${id}/build`, { bearer: token, body: {} });
  expect(built.status, built.text).toBe(200);
  const started = await w.call("POST", `/api/sessions/${id}/start`, { bearer: token, body: { buildId: built.json.build.buildId } });
  expect(started.status, started.text).toBe(200);
  return started.json.build;
}

/** What the phone's outbox sends for its session of `id`. */
function wire(performedId: string, workoutId: string, build: any, over: Record<string, unknown> = {}) {
  const items = (build?.items ?? []) as Array<{ exerciseId: string; slotKey?: string }>;
  return performedSessionSaveSchema.parse({
    id: performedId, source: "app", sourceRef: null, workoutId, buildId: build.buildId, localDate: build.date,
    startedAt: instant(D, "18:00"), endedAt: instant(D, "18:30"), seconds: 1800, plannedSeconds: build.plannedSeconds ?? 1800, minutes: build.minutes ?? 30,
    mode: build.mode ?? "build", theme: build.theme ?? null, locationId: build.locationId ?? null, blockRef: build.blockRef ?? null, blockNumber: null,
    completed: true, stepsTotal: (build.steps ?? []).length || 1, stepsDone: (build.steps ?? []).length || 1,
    movesDone: items.map((i) => ({ exerciseId: i.exerciseId, seconds: 120, ...(i.slotKey ? { slotKey: i.slotKey } : {}) })),
    note: null, newMove: build.newMove ?? null,
    entries: [{ exerciseId: items[0]?.exerciseId ?? "bridge", implement: null, format: "straight", perSide: false, sets: [{ setIndex: 0, reps: 10, seconds: null, load: null }] }],
    checks: [], review: {}, ...over,
  });
}

const phoneSaves = (body: { id: string } & Record<string, unknown>, raw?: string): Promise<Answer> =>
  w.call("PUT", `/api/sessions/performed/${body.id}`, { bearer: token, ...(raw === undefined ? { body } : { raw }) });
const webSaves = (body: { id: string } & Record<string, unknown>): Promise<Answer> => w.call("PUT", `/api/sessions/performed/${body.id}`, { body });

describe("a device's save holds no plan edit", () => {
  it("review.graduations, review.excluded, or another source: 403 out_of_scope before any write; the stripped save lands", async () => {
    const id = await workoutOn(D);
    const build = await phoneStarts(id);
    setClock(D, "18:40");
    const exercise = build.items[0].exerciseId as string;
    const body = wire(`p-${id}`, id, build);
    const refused = [
      { ...body, review: { ...body.review, graduations: [{ family: "hinge", to: exercise }] } },
      { ...body, review: { ...body.review, excluded: { [exercise]: true } } },
      { ...body, review: { ...body.review, excluded: { [exercise]: false } } },
      { ...body, review: { graduations: [{ family: "hinge", to: exercise }], excluded: {}, ratings: {} } },
      { ...body, source: "watch_review" },
      { ...body, source: "import", sourceRef: "x" },
      { ...body, review: "graduate everything" },
    ];
    for (const b of refused) {
      const a = await phoneSaves(b);
      expect([a.status, a.json]).toEqual([403, { error: "out_of_scope" }]);
      expect(a.writes).toEqual([]);
    }
    expect(record().sessions).toEqual([]);
    expect(await w.db.select().from(exercisePrefs)).toEqual([]);
    expect(rowOf(id)).toMatchObject({ content: "started", completion: "scheduled" });
    // What the phone sends after stripping them: empty, or absent. A rating stays (§9.6 strips only those two).
    const stripped = { ...body, review: { graduations: [], excluded: {}, ratings: { [exercise]: 1 } } };
    const saved = await phoneSaves(stripped);
    expect([saved.status, saved.json.status], saved.text).toEqual([200, "saved"]);
    expect(record().sessions).toHaveLength(1);
  });

  it("the web's save is not held to it: the cookie still saves a 'not for me'", async () => {
    const id = await workoutOn(D);
    const build = await phoneStarts(id);
    setClock(D, "18:40");
    const exercise = build.items[0].exerciseId as string;
    const a = await webSaves(wire(`p-${id}`, id, build, { review: { excluded: { [exercise]: true } } }));
    expect([a.status, a.json.status], a.text).toEqual([200, "saved"]);
    expect((await w.db.select().from(exercisePrefs)).map((p) => [p.exerciseId, p.excluded])).toEqual([[exercise, true]]);
  });
});

describe("an interrupted save, retried with the device token", () => {
  it("the answer lost after the commit: the retry is same_payload — one performed session, the same ids, one credit", async () => {
    const id = await workoutOn(D);
    const build = await phoneStarts(id);
    setClock(D, "18:40");
    const body = wire(`p-${id}`, id, build);
    const first = await phoneSaves(body); // its answer never reaches the phone
    expect(first.json).toEqual({ status: "saved", performedId: body.id, activityId: body.id, matched: true, notes: [] });
    setClock(addDays(D, 1), "08:00");
    const retry = await phoneSaves(JSON.parse(JSON.stringify(body)));
    expect([retry.status, retry.json]).toEqual([200, { status: "same_payload" }]);
    expect(retry.writes.filter((s) => !/coach_locks|native_devices/.test(s))).toEqual([]);
    await walkGarden(addDays(D, 1), addDays(D, 3));
    expect(record()).toEqual({
      sessions: [{ id: body.id, workout: id, activity: body.id, source: "app", day: D, note: null }],
      activities: [{ id: body.id, source: "app", matched: 1 }],
      matches: [{ workout: id, activity: body.id, method: "app_session", undone: 0 }],
      credits: [{ date: D, workout: id, activity: body.id, unplanned: false }],
    });
    expect(rowOf(id)).toMatchObject({ date: D, completion: "completed", content: "done" });
  });

  it("the save killed part-way (at its commit marker): nothing landed; the retry saves it once, the next is same_payload", async () => {
    const id = await workoutOn(D);
    const build = await phoneStarts(id);
    setClock(D, "18:40");
    const body = wire(`p-${id}`, id, build);
    killAt = /^update "performed_sessions" set "payload_hash"/;
    const died = await phoneSaves(body);
    expect(died.status).toBe(500);
    expect(record().sessions).toEqual([]);
    expect(rowOf(id)).toMatchObject({ content: "started", completion: "scheduled" });
    const retried = await phoneSaves(body);
    expect(retried.json).toMatchObject({ status: "saved", performedId: body.id, activityId: body.id });
    expect((await phoneSaves(body)).json).toEqual({ status: "same_payload" });
    await walkGarden(addDays(D, 1), addDays(D, 2));
    const after = record();
    expect(after.sessions.map((s) => [s.id, s.workout, s.activity])).toEqual([[body.id, id, body.id]]);
    expect(after.activities.map((a) => a.id)).toEqual([body.id]);
    expect(after.matches).toEqual([{ workout: id, activity: body.id, method: "app_session", undone: 0 }]);
    expect(after.credits).toEqual([{ date: D, workout: id, activity: body.id, unplanned: false }]);
  });
});

describe("a web change while the phone is offline", () => {
  it("the web saved the slot first (its own session): the phone's save is 409 slot_done, and adds nothing", async () => {
    const id = await workoutOn(D);
    const build = await phoneStarts(id);
    setClock(D, "18:35");
    const web = wire(`web-${id}`, id, build, { note: "done on the laptop" });
    expect((await webSaves(web)).json.status).toBe("saved");
    setClock(D, "19:10");
    const phone = wire(`p-${id}`, id, build);
    const a = await phoneSaves(phone);
    expect([a.status, a.json]).toEqual([409, { error: "slot_done" }]);
    expect((await phoneSaves(phone)).json).toEqual({ error: "slot_done" });
    expect((await webSaves(web)).json).toEqual({ status: "same_payload" });
    await walkGarden(addDays(D, 1), addDays(D, 2));
    expect(record()).toEqual({
      sessions: [{ id: web.id, workout: id, activity: web.id, source: "app", day: D, note: "done on the laptop" }],
      activities: [{ id: web.id, source: "app", matched: 1 }],
      matches: [{ workout: id, activity: web.id, method: "app_session", undone: 0 }],
      credits: [{ date: D, workout: id, activity: web.id, unplanned: false }],
    });
  });

  it("the web moved or skipped it: refused while the phone's session is under way; the phone's save lands on its day", async () => {
    const id = await workoutOn(D);
    const build = await phoneStarts(id);
    setClock(D, "18:10");
    for (const [path, body] of [["move", { toDate: addDays(D, 2), toTime: "18:00" }], ["skip", undefined], ["remove", undefined]] as const) {
      const a = await w.call("POST", `/api/plan/workouts/${id}/${path}`, { body });
      expect([path, a.status, a.json.error]).toEqual([path, 409, "session_under_way"]);
      expect(a.writes).toEqual([]);
    }
    setClock(addDays(D, 1), "07:00");
    const phone = wire(`p-${id}`, id, build);
    expect((await phoneSaves(phone)).json).toMatchObject({ status: "saved", matched: true, notes: [] });
    await walkGarden(addDays(D, 1), addDays(D, 2));
    const after = record();
    expect(after.sessions.map((s) => [s.id, s.day])).toEqual([[phone.id, D]]);
    expect(after.credits).toEqual([{ date: D, workout: id, activity: phone.id, unplanned: false }]);
    expect(rowOf(id)).toMatchObject({ date: D, completion: "completed", content: "done", archived: 0 });
  });

  it("the web discarded the phone's start and removed the slot: the phone's save lands saved with slot_gone; the slot stays removed", async () => {
    const id = await workoutOn(D);
    const build = await phoneStarts(id);
    setClock(D, "18:20");
    expect((await w.call("POST", `/api/sessions/${id}/unstart`, { body: {} })).status).toBe(200);
    expect((await w.call("POST", `/api/plan/workouts/${id}/remove`)).status).toBe(200);
    expect(rowOf(id)).toMatchObject({ archived: 1 });
    setClock(addDays(D, 1), "07:00");
    const phone = wire(`p-${id}`, id, build);
    const a = await phoneSaves(phone);
    expect([a.status, a.json]).toEqual([200, { status: "saved", performedId: phone.id, activityId: phone.id, matched: false, notes: ["slot_gone"] }]);
    expect((await phoneSaves(phone)).json).toEqual({ status: "same_payload" });
    await walkGarden(addDays(D, 1), addDays(D, 2));
    const after = record();
    expect(after.sessions.map((s) => [s.id, s.workout])).toEqual([[phone.id, id]]);
    expect(after.activities).toEqual([{ id: phone.id, source: "app", matched: 0 }]);
    expect(after.matches).toEqual([]);
    expect(after.credits).toEqual([{ date: D, workout: `unplanned-${phone.id}`, activity: phone.id, unplanned: true }]);
    expect(rowOf(id)).toMatchObject({ archived: 1, completion: "scheduled" });
  });

  it("the same session id landed from the web with other edits: the phone's save is 409 conflict, the web's stands whole", async () => {
    const id = await workoutOn(D);
    const build = await phoneStarts(id);
    setClock(D, "18:35");
    const phone = wire(`p-${id}`, id, build);
    expect((await webSaves({ ...phone, note: "edited on the laptop" })).json.status).toBe("saved");
    const before = record();
    const a = await phoneSaves(phone);
    expect([a.status, a.json]).toEqual([409, { error: "conflict" }]);
    expect(a.writes.filter((s) => !/coach_locks|native_devices/.test(s))).toEqual([]);
    expect(record()).toEqual(before);
    expect(before.sessions.map((s) => [s.id, s.note])).toEqual([[phone.id, "edited on the laptop"]]);
  });
});

describe("Build and Start's provider effects (the owner's open question 2)", () => {
  it("are the web's, by default: a phone's Build and Start resync the Calendar exactly as the laptop's do", async () => {
    expect(DEVICE_PROVIDER_EFFECTS).toBe("as_on_web");
    // A programme's slots: the day's first build renames and resizes the row, so the Calendar is resynced.
    setClock(D, "17:50");
    const byPhone = await seedSlot(w.db, w.userId, D);
    const byWeb = await seedSlot(w.db, w.userId, D);
    const calls = async (who: "phone" | "web", id: string) => {
      vi.mocked(syncCalendar).mockClear();
      const auth = who === "phone" ? { bearer: token } : {};
      const built = await w.call("POST", `/api/sessions/${id}/build`, { ...auth, body: {} });
      const afterBuild = vi.mocked(syncCalendar).mock.calls.length;
      await w.call("POST", `/api/sessions/${id}/start`, { ...auth, body: { buildId: built.json.build.buildId } });
      return [afterBuild, vi.mocked(syncCalendar).mock.calls.length];
    };
    const phone = await calls("phone", byPhone);
    const web = await calls("web", byWeb);
    expect(phone).toEqual(web);
    expect(phone[0]).toBeGreaterThan(0);
  });
});
