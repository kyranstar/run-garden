/**
 * THE DEVICE BRANCH SERVES TWO ACCOUNTS, AND NEITHER REACHES THE OTHER'S ROWS (the QA harness review's MAJOR-1 and MINOR-2).
 * Device sign-in admits the owner's phone and the LifeOS QA account's (auth/middleware.ts). Every id a device sends is the
 * client's, so every route the newest scope lists (v4: v3's, and stage 2c's three plan reads) must refuse one that names
 * the owner's rows — a workout, a build, a performed session, an activity (the owner's COROS activity among them), a
 * document revision — with 404 or 409, and write nothing of the owner's; and a read naming no id (`/today`, `/days`,
 * `/history`) answers the QA account's own and never a row of the owner's. The owner's account is real here, played
 * through its own phone: a document workout built, started and saved (its build, its performed session, its app activity,
 * its match and source link), a COROS activity automatically matched to another, an unmatched run (an extra), a session
 * said done, a slot ahead, and the rest of the registry filled. Its table hashes are taken before and compared after.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, ne } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, performedSessionSaveSchema } from "@rg/domain";
import { DEVICE_SCOPES } from "../src/auth/device-scope.js";
import { nativeRoutes } from "../src/routes/native.js";
import { planRoutes } from "../src/routes/plan.js";
import { qaRoutes } from "../src/routes/qa.js";
import { sessionRoutes } from "../src/routes/sessions.js";
import { workoutRoutes } from "../src/routes/workouts.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import { createDocWorkout } from "../src/services/doc-workouts.js";
import { tableHashes } from "../src/services/parity.js";
import { qaDoc } from "../src/services/qa-account.js";
import { foreignSession } from "../src/services/session-save.js";
import { seedFullAccount } from "./account-fixture.js";
import { pinMiddayToday } from "./helpers.js";
import { nativeWorld, seedDevice, seedSlot, type Answer, type NativeWorld } from "./native-fixture.js";

const { activities, activitySourceLinks, performedSessions, performedSets, plannedWorkouts, workoutCompletionMatches } = schema;

let today: string;
let w: NativeWorld;
let fetched: string[];

beforeEach(async () => {
  today = pinMiddayToday();
  fetched = [];
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    throw new Error("no external call in the QA account's tests");
  }) as typeof fetch);
  w = await nativeWorld(
    [
      ["/api/qa", qaRoutes],
      ["/api/native", nativeRoutes],
      ["/api/plan", planRoutes],
      ["/api/sessions", sessionRoutes],
      ["/api/workouts", workoutRoutes],
    ],
    { env: { WATCH_PUSH_ENABLED: "1" } },
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type As = (method: string, path: string, body?: unknown) => Promise<Answer>;
const device = (token: string): As => (method, path, body) => w.call(method, path, { bearer: token, ...(body === undefined ? {} : { body }) });

/** A device's Build and Start of `workoutId`: the build, as the phone holds it. */
async function buildAndStart(as: As, workoutId: string): Promise<Record<string, any>> {
  const built = await as("POST", `/api/sessions/${workoutId}/build`, {});
  expect(built.status, built.text).toBe(200);
  const b = built.json.build;
  const started = await as("POST", `/api/sessions/${workoutId}/start`, { buildId: b.buildId });
  expect(started.status, started.text).toBe(200);
  return b;
}

/** The save the phone sends for build `b` of `workoutId`, under `performedId`. */
function saveBody(performedId: string, workoutId: string, b: Record<string, any>) {
  const items = (b.items ?? []) as Array<{ exerciseId: string; slotKey?: string }>;
  return performedSessionSaveSchema.parse({
    id: performedId, source: "app", sourceRef: null, workoutId, buildId: b.buildId, localDate: b.date,
    startedAt: new Date(Date.now() - 600_000).toISOString(), endedAt: new Date().toISOString(), seconds: 600, plannedSeconds: b.plannedSeconds ?? null,
    minutes: b.minutes ?? null, mode: b.mode ?? null, theme: b.theme ?? null, locationId: b.locationId ?? null, blockRef: b.blockRef ?? null,
    blockNumber: null, completed: true, stepsTotal: (b.steps ?? []).length || null, stepsDone: (b.steps ?? []).length || null,
    movesDone: items.map((i) => ({ exerciseId: i.exerciseId, seconds: 60, ...(i.slotKey ? { slotKey: i.slotKey } : {}) })),
    note: null, newMove: b.newMove ?? null,
    entries: items.length > 0 ? [{ exerciseId: items[0]!.exerciseId, implement: null, format: "straight", perSide: false, sets: [{ setIndex: 0, reps: 10, seconds: null, load: null }] }] : [],
    checks: [], review: {},
  });
}

interface Owner {
  /** Played on the owner's phone and saved: completed, matched to its app activity. */
  played: string;
  /** On the plan today, untouched: a document workout with its revision. */
  open: string;
  openRev: number;
  buildId: string;
  performedId: string;
  /** The owner's COROS activity, automatically matched to `lifted` (the review's MAJOR-1 case). */
  coros: string;
  lifted: string;
  corosMatch: string;
  phone: string;
  /** An unmatched COROS run of the owner's yesterday (an extra), a session said done, and an engine slot ahead. */
  extra: string;
  said: string;
  ahead: string;
}

/** The owner's real account: three document workouts today, one played and saved on the owner's own phone, one completed by
 *  a COROS activity the matcher matched, one open; then the rest of the registry filled. */
async function ownerAccount(opts: { fill?: boolean } = {}): Promise<Owner> {
  const prefs = await loadPreferences(w.db, w.userId);
  const ctx = { today, now: nowInstant(), prefs };
  const doc = async (title: string, time: string) => (await createDocWorkout(w.db, w.userId, { date: today, time, doc: qaDoc(title) }, ctx)).workout;
  const played = await doc("Owner hips", "13:00");
  const lifted = await doc("Owner lift", "08:00");
  const open = await doc("Owner core", "17:00");

  const { token: phone } = await seedDevice(w.db, w.userId, { scope: "training-v3" });
  const as = device(phone);
  const b = await buildAndStart(as, played.id);
  const performedId = newId();
  const saved = await as("PUT", `/api/sessions/performed/${performedId}`, saveBody(performedId, played.id, b));
  expect([saved.status, saved.json.status]).toEqual([200, "saved"]);

  // The owner's COROS activity, matched by the ingest's matcher to the morning's lift, with its provider link.
  const coros = newId();
  const corosMatch = newId();
  const at = nowInstant();
  await w.db.insert(activities).values({
    id: coros, userId: w.userId, source: "coros", corosActivityId: "coros-owner-1", startTime: `${today}T15:00:00.000Z`,
    sport: "strength", durationSeconds: 1500, completionMatchId: corosMatch, createdAt: at, updatedAt: at,
  });
  await w.db.insert(workoutCompletionMatches).values({ id: corosMatch, workoutId: lifted.id, activityId: coros, confidence: 0.8, method: "scored_auto", matchedAt: at });
  await w.db.update(plannedWorkouts).set({ completionState: "completed", resolutionDate: today }).where(eq(plannedWorkouts.id, lifted.id));
  await w.db.insert(activitySourceLinks).values({
    id: newId(), activityId: coros, provider: "coros", providerActivityId: "coros-owner-1", sourceCreatedAt: at, sourceUpdatedAt: null,
    firstSeenAt: at, lastSeenAt: at, contentFingerprint: "owner-fp", normalizerVersion: "coros-1", sourceVersion: null, rawSummary: null,
  });
  // An unmatched run yesterday (an extra: /days and /history would list it, were it the reader's), a session said done,
  // and an engine slot two days ahead (/ahead would preview it).
  const extra = newId();
  const yesterday = addDays(today, -1);
  await w.db.insert(activities).values({
    id: extra, userId: w.userId, source: "coros", corosActivityId: "coros-owner-2", startTime: `${yesterday}T15:00:00.000Z`,
    startTimeLocal: `${yesterday}T07:00:00`, sport: "run", durationSeconds: 3000, distanceMeters: 10000, title: "Owner extra", createdAt: at, updatedAt: at,
  });
  const said = (await createDocWorkout(w.db, w.userId, { date: today, time: "09:00", doc: qaDoc("Owner said") }, ctx)).workout.id;
  await w.db
    .update(plannedWorkouts)
    .set({ effectiveDate: yesterday, originalPlanDate: yesterday, completionState: "completed", sanctionedBy: "athlete_said_done", resolutionDate: yesterday })
    .where(eq(plannedWorkouts.id, said));
  const ahead = await seedSlot(w.db, w.userId, addDays(today, 2));
  // The rest of the registry, synthetic (its rows are not the engine's to build from: an owner build after it would fail).
  if (opts.fill !== false) await seedFullAccount(w.db, w.userId);
  const [rev] = await w.db.select({ rev: plannedWorkouts.workoutDocRev }).from(plannedWorkouts).where(eq(plannedWorkouts.id, open.id));
  return { played: played.id, open: open.id, openRev: rev!.rev ?? 0, buildId: b.buildId, performedId, coros, lifted: lifted.id, corosMatch, phone, extra, said, ahead };
}

/** The QA account, seeded, and its phone paired: the phone's caller, and today's QA Hips and back, built and started. */
async function qaPhone(): Promise<{ as: As; token: string; hips: string; build: Record<string, any> }> {
  expect((await w.call("POST", "/api/qa/user")).status).toBe(201);
  const seeded = await w.call("POST", "/api/qa/seed");
  expect(seeded.status, seeded.text).toBe(200);
  const minted = await w.call("POST", "/api/qa/pairings");
  const paired = await w.call("POST", "/api/native/pair", { cookie: false, body: { code: minted.json.code, label: "LifeOS QA" } });
  expect(paired.status, paired.text).toBe(200);
  const token = paired.json.token as string;
  const as = device(token);
  const hips = (seeded.json.fixtures as Array<{ id: string; title: string }>).find((f) => f.title === "QA Hips and back")!.id;
  return { as, token, hips, build: await buildAndStart(as, hips) };
}

describe("a QA-device save naming the owner's activity (the review's MAJOR-1)", () => {
  it("is refused 409 conflict, and the owner's activities, matches and source links are as they were", async () => {
    const owner = await ownerAccount();
    const before = await tableHashes(w.db, w.userId);
    const qa = await qaPhone();

    // The review's probe: the owner's COROS activity id as the performed id, on the QA phone's own started build.
    const crafted = await qa.as("PUT", `/api/sessions/performed/${owner.coros}`, saveBody(owner.coros, qa.hips, qa.build));
    expect([crafted.status, crafted.json]).toEqual([409, { error: "conflict" }]);
    // Nothing written at all: the refusal is a read.
    expect(crafted.writes.filter((s) => !/native_devices/.test(s))).toEqual([]);
    expect(await tableHashes(w.db, w.userId)).toEqual(before);
    expect((await w.db.select().from(workoutCompletionMatches).where(eq(workoutCompletionMatches.id, owner.corosMatch)))[0]!.undoneAt).toBeNull();
    expect((await w.db.select().from(activities).where(eq(activities.id, owner.coros)))[0]!.completionMatchId).toBe(owner.corosMatch);
    expect(await w.db.select().from(activitySourceLinks).where(eq(activitySourceLinks.id, `app:${owner.coros}`))).toEqual([]);

    // The owner's app activity (its performed id) the same.
    const theirs = await qa.as("PUT", `/api/sessions/performed/${owner.performedId}`, saveBody(owner.performedId, qa.hips, qa.build));
    expect([theirs.status, theirs.json]).toEqual([409, { error: "conflict" }]);
    expect(await tableHashes(w.db, w.userId)).toEqual(before);

    // And the QA phone's own save of the same workout still lands, on its own rows only.
    const own = newId();
    const saved = await qa.as("PUT", `/api/sessions/performed/${own}`, saveBody(own, qa.hips, qa.build));
    expect([saved.status, saved.json.status, saved.json.matched]).toEqual([200, "saved", true]);
    expect(await tableHashes(w.db, w.userId)).toEqual(before);
    expect(fetched).toEqual([]);
  });

  it("the owner's own save of the same shape is untouched: an app session supersedes the matcher's guess, as before", async () => {
    const owner = await ownerAccount({ fill: false });
    // The owner's phone: Build and Start the lift COROS completed, and save it as the app's — the 2b-R5 supersede.
    const as = device(owner.phone);
    await w.db.update(plannedWorkouts).set({ completionState: "scheduled", resolutionDate: null }).where(eq(plannedWorkouts.id, owner.lifted));
    await w.db.update(workoutCompletionMatches).set({ workoutId: owner.open }).where(eq(workoutCompletionMatches.id, owner.corosMatch));
    const b = await buildAndStart(as, owner.lifted);
    const id = newId();
    const saved = await as("PUT", `/api/sessions/performed/${id}`, saveBody(id, owner.lifted, b));
    expect([saved.status, saved.json.status, saved.json.matched]).toEqual([200, "saved", true]);
    const live = await w.db
      .select({ workoutId: workoutCompletionMatches.workoutId, activityId: workoutCompletionMatches.activityId, method: workoutCompletionMatches.method })
      .from(workoutCompletionMatches)
      .where(and(eq(workoutCompletionMatches.workoutId, owner.lifted)));
    expect(live).toEqual([{ workoutId: owner.lifted, activityId: id, method: "app_session" }]);
  });
});

describe("a device save's id holding ':' (the re-review's R2-1)", () => {
  it("is refused 400 before any write — the owner's future watch-session id among them — from any device; a UUID saves", async () => {
    const qa = await qaPhone();
    // The ingest names the owner's watch session `watch:<ownerId>:<label>` (watch-sets.ts): a QA row of that id would take
    // the owner's sets when the owner's COROS sync stores it, and the QA purge would delete them.
    const squat = `watch:${w.userId}:lbl-owner-future-1`;
    const a = await qa.as("PUT", `/api/sessions/performed/${encodeURIComponent(squat)}`, saveBody(squat, qa.hips, qa.build));
    expect([a.status, a.json]).toEqual([400, { error: "invalid_performed_id" }]);
    expect(a.writes.filter((s) => !/native_devices/.test(s))).toEqual([]);
    expect(await w.db.select().from(performedSessions).where(eq(performedSessions.id, squat))).toEqual([]);
    // Any deterministic namespace (`app:…` too), and the owner's own phone the same: no device's outbox makes such an id.
    const { token: ownerPhone } = await seedDevice(w.db, w.userId, { scope: "training-v3" });
    const appShaped = `app:${newId()}`;
    const b = await device(ownerPhone)("PUT", `/api/sessions/performed/${encodeURIComponent(appShaped)}`, saveBody(appShaped, qa.hips, qa.build));
    expect([b.status, b.json]).toEqual([400, { error: "invalid_performed_id" }]);
    expect(b.writes.filter((s) => !/native_devices/.test(s))).toEqual([]);
    // The outbox's own shape still saves.
    const own = newId();
    const c = await qa.as("PUT", `/api/sessions/performed/${own}`, saveBody(own, qa.hips, qa.build));
    expect([c.status, c.json.status]).toEqual([200, "saved"]);
  });
});

describe("another account's session row of the same id, landing mid-save (the review's MINOR-2)", () => {
  it("fails the QA save's whole transaction: 409 conflict, the owner's row and sets as written, nothing of the QA save", async () => {
    const qa = await qaPhone();
    const raced = newId();
    const at = nowInstant();
    const ownerRow = {
      id: raced, userId: w.userId, workoutId: null, activityId: null, source: "app", sourceRef: null, localDate: today,
      completed: true, seconds: 900, payloadHash: "owner-hash", createdAt: at, updatedAt: at,
    };
    const ownerSet = { id: `${raced}:0:0`, performedSessionId: raced, entryIndex: 0, exerciseId: "owner-move", setIndex: 0, reps: 7, done: true };
    // The owner's save of the same id commits between the QA save's last read and its write: planted just before the
    // QA save's one transaction runs (the first in the request — locks and reads are single statements).
    const db = w.db as unknown as { transaction: (run: () => unknown) => unknown };
    const real = db.transaction.bind(db);
    let caught: unknown;
    db.transaction = (run) => {
      db.transaction = real;
      w.db.insert(performedSessions).values(ownerRow).run();
      w.db.insert(performedSets).values(ownerSet).run();
      try {
        return real(run);
      } catch (e) {
        caught = e;
        throw e;
      }
    };
    const answer = await qa.as("PUT", `/api/sessions/performed/${raced}`, saveBody(raced, qa.hips, qa.build));
    expect([answer.status, answer.json]).toEqual([409, { error: "conflict" }]);
    expect(foreignSession(caught)).toBe(true);

    const [row] = await w.db.select().from(performedSessions).where(eq(performedSessions.id, raced));
    expect(row).toMatchObject({ userId: w.userId, payloadHash: "owner-hash", seconds: 900, workoutId: null, buildId: null });
    expect(await w.db.select({ id: performedSets.id, reps: performedSets.reps }).from(performedSets).where(eq(performedSets.performedSessionId, raced))).toEqual([
      { id: ownerSet.id, reps: 7 },
    ]);
    expect(await w.db.select().from(activities).where(eq(activities.id, raced))).toEqual([]);
    expect(await w.db.select().from(activitySourceLinks).where(eq(activitySourceLinks.id, `app:${raced}`))).toEqual([]);
    expect(await w.db.select().from(workoutCompletionMatches).where(eq(workoutCompletionMatches.id, `app:${raced}`))).toEqual([]);
    expect((await w.db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, qa.hips)))[0]!.completionState).toBe("scheduled");
  });
});

describe("every v4 device route, sent the owner's ids by the QA phone", () => {
  it("answers 404 or 409 — or, for the routes naming none, the QA account's own — and the owner's hashes are unchanged", async () => {
    const owner = await ownerAccount();
    const qa = await qaPhone();
    const before = await tableHashes(w.db, w.userId);
    const ownerIds = [owner.played, owner.open, owner.lifted, owner.buildId, owner.performedId, owner.coros, owner.corosMatch, owner.extra, owner.said, owner.ahead, w.userId];
    const fresh = newId();
    const from = { date: today, time: "17:00" };

    // [method, path, body, expected statuses]. Routes naming no id answer the QA account's own (200), last the sign-out.
    const cases: Array<[string, string, unknown, number[]]> = [
      ["GET", "/api/native/me", undefined, [200]],
      ["GET", "/api/native/today", undefined, [200]],
      // Stage 2c's reads name no account: the QA account's own days and record, never a row of the owner's.
      ["GET", `/api/native/days?from=${addDays(today, -3)}&to=${addDays(today, 3)}`, undefined, [200]],
      ["GET", "/api/native/history", undefined, [200]],
      ["GET", `/api/native/history?before=${addDays(today, 1)}&limit=30`, undefined, [200]],
      ["GET", `/api/native/sessions/${owner.ahead}/ahead`, undefined, [404]],
      ["GET", `/api/native/sessions/${owner.open}/ahead`, undefined, [404]],
      ["GET", `/api/native/sessions/${owner.said}/ahead`, undefined, [404]],
      ["GET", `/api/sessions/${owner.open}`, undefined, [404]],
      ["GET", `/api/sessions/${owner.played}`, undefined, [404]],
      ["GET", `/api/sessions/${owner.played}/review-basis`, undefined, [404]],
      ["POST", `/api/sessions/${owner.open}/build`, {}, [404]],
      ["POST", `/api/sessions/${owner.played}/start`, { buildId: owner.buildId }, [404]],
      // Start on the QA phone's own build, locked already: idempotent, the QA account's own answer (no owner id in it).
      ["POST", `/api/sessions/${qa.hips}/start`, { buildId: owner.buildId }, [200, 404, 409]],
      ["PUT", `/api/sessions/performed/${owner.coros}`, saveBody(owner.coros, qa.hips, qa.build), [409]],
      ["PUT", `/api/sessions/performed/${owner.performedId}`, saveBody(owner.performedId, qa.hips, qa.build), [409]],
      // The owner's deterministic watch-session id, not yet stored (R2-1): refused for its shape.
      ["PUT", `/api/sessions/performed/watch:${w.userId}:lbl-future`, saveBody(`watch:${w.userId}:lbl-future`, qa.hips, qa.build), [400]],
      ["PUT", `/api/sessions/performed/${fresh}`, saveBody(fresh, owner.open, { ...qa.build, buildId: owner.buildId }), [404]],
      ["PUT", `/api/sessions/performed/${fresh}`, saveBody(fresh, owner.played, { ...qa.build, buildId: owner.buildId }), [404]],
      ["POST", `/api/plan/workouts/${owner.open}/move`, { toDate: today, toTime: "18:15", from }, [404]],
      // Skip answers `ok` for an id that isn't the account's, as it always has for any unknown id: its one write is the
      // account's own (`skipWorkout`'s user-scoped UPDATE), matching no row. The hashes below say nothing of the owner's moved.
      ["POST", `/api/plan/workouts/${owner.open}/skip`, undefined, [200, 404]],
      ["POST", `/api/plan/workouts/${owner.lifted}/unskip`, undefined, [404]],
      ["POST", "/api/sessions/watch/drain", { workoutId: owner.open }, [404]],
      ["GET", `/api/workouts/${owner.open}/doc`, undefined, [404]],
      ["PUT", `/api/workouts/${owner.open}/doc`, { doc: qaDoc("Owner core"), baseRev: owner.openRev }, [404]],
      ["POST", "/api/native/sign-out", undefined, [200]],
    ];
    // Every route the newest scope lists has its case: a route added to the list without one fails here.
    for (const r of DEVICE_SCOPES["training-v4"]) {
      expect(cases.some(([m, p]) => m === r.method && r.pattern.test(p.split("?")[0]!)), `${r.method} ${r.pattern}`).toBe(true);
    }
    for (const [method, path, body, expected] of cases) {
      const a = await qa.as(method, path, body);
      expect(expected, `${method} ${path}: ${a.status} ${a.text.slice(0, 120)}`).toContain(a.status);
      for (const id of ownerIds) expect(a.text.includes(id), `${method} ${path} answered an owner id`).toBe(false);
      expect(await tableHashes(w.db, w.userId), `${method} ${path}`).toEqual(before);
    }
    // Nothing of the QA account's points at the owner's rows either.
    const ownerActivities = [owner.performedId, owner.coros];
    expect(await w.db.select().from(workoutCompletionMatches).where(and(inArray(workoutCompletionMatches.activityId, ownerActivities), ne(workoutCompletionMatches.workoutId, owner.played), ne(workoutCompletionMatches.workoutId, owner.lifted)))).toEqual([]);
    expect(await w.db.select().from(performedSessions).where(and(inArray(performedSessions.activityId, ownerActivities), ne(performedSessions.userId, w.userId)))).toEqual([]);
    // The owner's phone still answers.
    expect((await device(owner.phone)("GET", "/api/native/me")).status).toBe(200);
    expect(fetched).toEqual([]);
  });
});
