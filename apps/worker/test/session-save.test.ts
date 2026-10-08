/**
 * SAVING A PERFORMED SESSION, EXACTLY ONCE (Phase 2 spec §2b "Review and save", steps 1–6; programme spec §9.2,
 * §10.6; plan 2b Task 6; rulings 2b-R3, Phase 0 audit 1 ingest #3).
 *
 * The service tests pass every time explicitly; the slot is played the day before the save lands (the outbox
 * draining the next morning), which is when the garden's replay from the session's own date matters.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import {
  adaptiveConfigSchema,
  canonicalJson,
  newId,
  performedSessionSaveSchema,
  type PerformedSessionWireInput,
  type SourceActivity,
  type UserPreferences,
} from "@rg/domain";
import type { GardenDayInput } from "@rg/garden-engine";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { sha256Hex } from "../src/auth/crypto.js";
import { buildSession, startSession, unstartSession, type BuildPayload } from "../src/services/session-build.js";
import { loadProgramState } from "../src/services/engine-inputs.js";
import { slotId } from "../src/services/program-slots.js";
import { ingestActivities } from "../src/services/completion.js";
import { advanceGarden, buildDayInput, ensureGarden } from "../src/services/garden-sync.js";
import { savePerformedSession } from "../src/services/session-save.js";
import { sessionRoutes } from "../src/routes/sessions.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { detailOf, workView } from "./watch-sets-fixture.js";

const {
  activities,
  activitySourceLinks,
  conditionChecks,
  exercisePrefs,
  gardenDayInputs,
  performedSessions,
  performedSets,
  plannedWorkouts,
  programs,
  workoutCompletionMatches,
  accountState,
  coachLocks,
} = schema;

vi.setConfig({ testTimeout: 30_000 });

// The calendar is not this suite's business.
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

/** The session is played on PLAYED (Tuesday, noon in Los Angeles — the test user's zone); the save lands on SAVED. */
const PLAYED = "2026-10-06";
const PLAYED_NOON = "2026-10-06T19:00:00.000Z";
const SAVED = "2026-10-07T16:00:00.000Z";

let db: Db;
let statements: string[];
let userId: string;
let prefs: UserPreferences;
let programId: string;
/**
 * The first statement matching this dies (the invocation killed part-way: CPU, the query cap, a dropped connection);
 * it is cleared as it fires.
 */
let killAt: RegExp | null;

beforeEach(async () => {
  statements = [];
  killAt = null;
  db = makeTestDb({
    boundVariableCap: 100,
    onStatement: (sql) => {
      statements.push(sql);
      if (killAt?.test(sql)) {
        killAt = null;
        throw new Error("the invocation died here");
      }
    },
  });
  ({ userId, prefs } = await makeTestUser(db));
  programId = await seedProgram(userId);
});

async function seedProgram(owner: string): Promise<string> {
  const id = newId();
  await db.insert(programs).values({
    id,
    userId: owner,
    kind: "adaptive",
    name: "Mobility",
    status: "active",
    disciplines: ["yoga", "strength"],
    startDate: null,
    endDate: null,
    raceDate: null,
    source: null,
    config: adaptiveConfigSchema.parse({ defaultMinutes: 30 }),
    createdAt: PLAYED_NOON,
    updatedAt: PLAYED_NOON,
    archivedAt: null,
  });
  return id;
}

async function seedSlot(date: string, owner = userId, program = programId): Promise<string> {
  const id = slotId(program, date);
  await db.insert(plannedWorkouts).values({
    id,
    userId: owner,
    planId: program,
    sourceWorkoutId: id,
    title: "Mobility",
    category: "yoga",
    sport: "yoga",
    originalPlanDate: date,
    lastVerifiedCorosDate: "",
    effectiveDate: date,
    effectiveTime: "18:00",
    sourceContentFingerprint: "program",
    calendarBlockDurationSeconds: 1800,
    fallbackEstimatedDurationSeconds: 1800,
    corosSyncState: "calendar_only",
    completionState: "scheduled",
    origin: "program",
    contentState: "outline",
    createdAt: PLAYED_NOON,
    updatedAt: PLAYED_NOON,
  });
  return id;
}

/** A slot built and started on PLAYED: `recovery` holds no core lift (yoga, §9.2), `build` holds one (strength). */
async function started(mode: "recovery" | "build" = "build") {
  const workoutId = await seedSlot(PLAYED);
  const built = await buildSession(db, userId, workoutId, { overrides: { mode } }, { today: PLAYED, now: PLAYED_NOON, prefs });
  const locked = await startSession(db, userId, workoutId, built.build!.buildId, PLAYED_NOON);
  return { workoutId, build: locked.build!, title: (await rowOf(workoutId)).title };
}

async function rowOf(id: string) {
  const [r] = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id));
  return r!;
}

/** What the player's review saves: two logged moves (weights as typed, one per side), the session's own checks. */
function payload(s: { workoutId: string; build: BuildPayload }, over: Partial<PerformedSessionWireInput> = {}): PerformedSessionWireInput {
  const [first, second] = s.build.items;
  return {
    id: over.id ?? "7c1e2a4b-5d6f-4a8b-9c0d-1e2f3a4b5c6d",
    source: "app",
    sourceRef: null,
    workoutId: s.workoutId,
    buildId: s.build.buildId,
    localDate: PLAYED,
    startedAt: "2026-10-06T19:05:00.000Z",
    endedAt: "2026-10-06T19:36:00.000Z",
    seconds: 1860,
    plannedSeconds: s.build.plannedSeconds,
    minutes: s.build.minutes,
    mode: s.build.mode,
    theme: s.build.theme,
    locationId: s.build.locationId,
    blockRef: s.build.blockRef,
    blockNumber: 1,
    completed: true,
    stepsTotal: s.build.steps.length,
    stepsDone: s.build.steps.length,
    movesDone: s.build.items.map((i) => ({ exerciseId: i.exerciseId, seconds: 120 })),
    note: "felt good",
    newMove: s.build.newMove,
    entries: [
      {
        exerciseId: first!.exerciseId,
        implement: "kettlebell",
        format: "straight",
        perSide: false,
        sets: [
          { setIndex: 0, reps: 6, seconds: null, load: { v: 30, u: "lb" }, flags: ["clenched"] },
          { setIndex: 1, reps: 6, seconds: null, load: { v: 12, u: "kg" } },
        ],
      },
      { exerciseId: second!.exerciseId, implement: null, format: null, perSide: true, sets: [{ setIndex: 0, reps: null, seconds: 30, load: null }] },
    ],
    checks: [],
    review: {},
    ...over,
  };
}

const save = (body: unknown, id = (body as { id: string }).id, ctx: { now?: string; prefs?: UserPreferences } = {}) =>
  savePerformedSession(db, userId, id, body, { now: ctx.now ?? SAVED, prefs: ctx.prefs ?? prefs });

/** Everything a save writes, counted, for "one of everything". */
async function counts() {
  const [sessions, sets, checks, acts, links, matches] = await Promise.all([
    db.select().from(performedSessions),
    db.select().from(performedSets),
    db.select().from(conditionChecks).where(eq(conditionChecks.userId, userId)),
    db.select().from(activities),
    db.select().from(activitySourceLinks),
    db.select().from(workoutCompletionMatches),
  ]);
  return { sessions: sessions.length, sets: sets.length, checks: checks.length, activities: acts.length, links: links.length, matches: matches.length };
}

describe("a save writes the session, its sets and checks, an app activity and the slot's match (§2b steps 2–4)", () => {
  it("writes each row as the spec says", async () => {
    const s = await started("build");
    // What the outbox sends: the payload as the client's schema parsed it (defaults filled).
    const body = performedSessionSaveSchema.parse(payload(s));
    const outcome = await save(body);
    expect(outcome).toEqual({ status: "saved", performedId: body.id, activityId: body.id, matched: true, notes: [] });

    const [session] = await db.select().from(performedSessions);
    const parsed = performedSessionSaveSchema.parse(body);
    expect(session).toMatchObject({
      id: body.id,
      userId,
      workoutId: s.workoutId,
      activityId: body.id,
      buildId: s.build.buildId,
      source: "app",
      sourceRef: null,
      localDate: PLAYED,
      seconds: 1860,
      mode: s.build.mode,
      completed: true,
      note: "felt good",
      movesDone: parsed.movesDone,
      // The commit marker is the payload's hash: sha256 of the canonical JSON of the body sent — the client's own
      // hash, which its outbox keys the entry by.
      payloadHash: await sha256Hex(canonicalJson(parsed)),
    });

    // Weights exactly as typed, plus kg for the maths.
    const sets = (await db.select().from(performedSets)).sort((a, b) => a.entryIndex - b.entryIndex || a.setIndex - b.setIndex);
    expect(sets.map((r) => [r.entryIndex, r.setIndex, r.exerciseId, r.reps, r.seconds, r.loadValue, r.loadUnit, r.perSide, r.flags])).toEqual([
      [0, 0, body.entries![0]!.exerciseId, 6, null, 30, "lb", false, ["clenched"]],
      [0, 1, body.entries![0]!.exerciseId, 6, null, 12, "kg", false, []],
      [1, 0, body.entries![1]!.exerciseId, null, 30, null, null, true, []],
    ]);
    expect(sets[0]!.loadKg).toBeCloseTo(13.608, 3);
    expect(sets[1]!.loadKg).toBe(12);

    // §9.2: a core lift makes it strength. The start in UTC and on the athlete's own clock (Los Angeles, UTC−7).
    const [activity] = await db.select().from(activities);
    expect(activity).toMatchObject({
      id: body.id,
      userId,
      source: "app",
      corosActivityId: null,
      sport: "strength",
      startTime: "2026-10-06T19:05:00Z",
      startTimeLocal: "2026-10-06T12:05:00",
      timezone: "America/Los_Angeles",
      durationSeconds: 1860,
      elapsedSeconds: 1860,
      title: s.title,
      avgHeartRate: null,
    });
    const links = await db.select().from(activitySourceLinks);
    expect(links.map((l) => [l.provider, l.providerActivityId, l.activityId])).toEqual([["app", body.id, body.id]]);

    const [match] = await db.select().from(workoutCompletionMatches);
    expect(match).toMatchObject({ workoutId: s.workoutId, activityId: body.id, method: "app_session", confidence: 1, undoneAt: null });
    expect(activity!.completionMatchId).toBe(match!.id);
    expect(await rowOf(s.workoutId)).toMatchObject({
      completionState: "completed",
      resolutionDate: PLAYED,
      contentState: "done",
      category: "strength",
      sport: "strength",
    });
  });

  it("a session with no core lift is yoga (§9.2), on the activity and the slot", async () => {
    const s = await started("recovery");
    expect(s.build.items.some((i) => i.block === "core")).toBe(false);
    await save(payload(s));
    expect((await db.select().from(activities))[0]!.sport).toBe("yoga");
    expect(await rowOf(s.workoutId)).toMatchObject({ category: "yoga", sport: "yoga", contentState: "done" });
  });

  it("post checks are written with the session; a pre the sheet already recorded is not written twice", async () => {
    await db.insert(schema.userConditions).values({ id: `${userId}:tmj`, userId, profileId: "tmj", active: true, since: "2026-09-01", settings: {} });
    const s = await started("build");
    // The sheet's pre-check for this slot and day (one per profile).
    await db.insert(conditionChecks).values({
      id: "sheet-pre",
      userId,
      profileId: "tmj",
      kind: "pre",
      value: 3,
      feelingOff: false,
      localDate: PLAYED,
      at: PLAYED_NOON,
      performedSessionId: null,
      workoutId: s.workoutId,
    });
    const body = payload(s, {
      checks: [
        { profileId: "tmj", kind: "pre", value: 3, feelingOff: false, at: "2026-10-06T19:05:00.000Z" },
        { profileId: "tmj", kind: "post", value: 1, feelingOff: false, at: "2026-10-06T19:36:00.000Z" },
        { profileId: "neck", kind: "pre", value: 2, feelingOff: false, at: "2026-10-06T19:05:00.000Z" },
      ],
    });
    await save(body);
    const rows = await db.select().from(conditionChecks);
    expect(rows.map((r) => [r.profileId, r.kind, r.value, r.performedSessionId, r.workoutId, r.localDate]).sort()).toEqual([
      ["neck", "pre", 2, body.id, s.workoutId, PLAYED],
      ["tmj", "post", 1, body.id, s.workoutId, PLAYED],
      ["tmj", "pre", 3, null, s.workoutId, PLAYED],
    ]);
  });

  it("a slot that another activity already completed keeps that match: the save still lands, the match is skipped and said", async () => {
    const s = await started("build");
    await db.insert(activities).values({
      id: "other",
      userId,
      startTime: "2026-10-06T14:00:00Z",
      sport: "strength",
      durationSeconds: 1500,
      completionMatchId: "m-other",
      createdAt: SAVED,
      updatedAt: SAVED,
    });
    await db.insert(workoutCompletionMatches).values({ id: "m-other", workoutId: s.workoutId, activityId: "other", confidence: 1, method: "manual", matchedAt: SAVED });
    await db.update(plannedWorkouts).set({ completionState: "completed", resolutionDate: PLAYED }).where(eq(plannedWorkouts.id, s.workoutId));

    const outcome = await save(payload(s));
    expect(outcome).toMatchObject({ status: "saved", matched: false, notes: ["slot_already_matched"] });
    expect((await db.select().from(workoutCompletionMatches)).map((m) => m.id)).toEqual(["m-other"]);
    const app = (await db.select().from(activities).where(eq(activities.source, "app")))[0]!;
    expect(app.completionMatchId).toBeNull();
    expect(await rowOf(s.workoutId)).toMatchObject({ completionState: "completed", contentState: "done" });
    expect((await counts()).sessions).toBe(1);
  });

  it("a slot that is not this user's is not found, and nothing is written", async () => {
    const other = await makeTestUser(db);
    const theirProgram = await seedProgram(other.userId);
    const theirs = await seedSlot(PLAYED, other.userId, theirProgram);
    const s = await started("build");
    statements.length = 0;
    await expect(save(payload(s, { workoutId: theirs }))).rejects.toThrow("not_found");
    expect(statements.filter(isWrite)).toEqual([]);
    expect(await counts()).toMatchObject({ sessions: 0, activities: 0, matches: 0 });
  });

  it("the restore marker stops every write", async () => {
    const s = await started("build");
    await db.insert(accountState).values({ userId, restoreId: "restore-1", restoreStartedAt: SAVED, updatedAt: SAVED });
    statements.length = 0;
    expect(await save(payload(s))).toEqual({ status: "restoring" });
    expect(statements.filter(isWrite)).toEqual([]);
  });

  it("a big session stays under D1's 100 bound variables per statement", async () => {
    const s = await started("build");
    const entries = Array.from({ length: 30 }, (_, e) => ({
      exerciseId: s.build.items[e % s.build.items.length]!.exerciseId,
      implement: "kettlebell",
      format: "straight" as const,
      perSide: e % 2 === 0,
      sets: Array.from({ length: 5 }, (_, i) => ({ setIndex: i, reps: 8, seconds: null, load: { v: 20, u: "lb" as const }, flags: ["clenched"] })),
    }));
    await save(payload(s, { entries }));
    expect((await counts()).sets).toBe(150);
  });

  it("refuses the audit's 5,000-set body (P3) before any read or write: it could never complete (audit 2b-A M-4)", async () => {
    const s = await started("build");
    const entries = Array.from({ length: 100 }, (_, e) => ({
      exerciseId: `move-${e}`,
      implement: "kettlebell",
      format: "straight" as const,
      perSide: false,
      sets: Array.from({ length: 50 }, (_, i) => ({ setIndex: i, reps: 8, seconds: null, load: { v: 20, u: "lb" as const } })),
    }));
    statements.length = 0;
    await expect(save(payload(s, { entries }))).rejects.toThrow("invalid_save");
    expect(statements).toEqual([]);
  });
});

describe("exactly once (§2b step 1; Review Focus 2 and 3)", () => {
  it("the same save twice (the outbox drained twice) is one of everything; the second says same_payload", async () => {
    const s = await started("build");
    const body = payload(s);
    await save(body);
    const once = await counts();
    statements.length = 0;
    expect(await save(JSON.parse(JSON.stringify(body)))).toEqual({ status: "same_payload" });
    expect(statements.filter(isWrite)).toEqual([]);
    expect(await counts()).toEqual(once);
    expect(once).toEqual({ sessions: 1, sets: 3, checks: 0, activities: 1, links: 1, matches: 1 });
  });

  it("the same session saved with different edits (two tabs) is refused, never overwritten", async () => {
    const s = await started("build");
    const body = payload(s);
    await save(body);
    const before = await db.select().from(performedSessions);
    statements.length = 0;
    expect(await save({ ...body, note: "the other tab" })).toEqual({ status: "conflict" });
    expect(statements.filter(isWrite)).toEqual([]);
    expect(await db.select().from(performedSessions)).toEqual(before);
  });

  it("a slot holds one app session (ruling 2b-R18): another device's save of it is refused slot_done, and nothing is written", async () => {
    const s = await started("build");
    // Device A saved first; device B played the same started slot from its own step 1 and saves its own session.
    const onA = payload(s);
    expect(await save(onA)).toMatchObject({ status: "saved" });
    const before = { sessions: await db.select().from(performedSessions), counts: await counts() };
    const onB = payload(s, { id: "b2b2b2b2-0000-4000-8000-000000000002", note: "on the other phone", seconds: 1500 });
    statements.length = 0;
    expect(await save(onB)).toEqual({ status: "slot_done" });
    expect(statements.filter((q) => isWrite(q) && !/coach_locks/.test(q))).toEqual([]);
    expect(await db.select().from(performedSessions)).toEqual(before.sessions);
    expect(await counts()).toEqual(before.counts);
    // Every retry of B's says the same; A's own retry is still the same payload.
    expect(await save(onB)).toEqual({ status: "slot_done" });
    expect(await save(onA)).toEqual({ status: "same_payload" });
  });

  it("ruling 2b-R18 is about the app's own sessions: a watch session that performed the slot does not refuse the app's save", async () => {
    const s = await started("build");
    await db.insert(performedSessions).values({
      id: "watch-1", userId, workoutId: s.workoutId, activityId: null, buildId: null, source: "watch", sourceRef: "w-1", localDate: PLAYED,
      startedAt: "2026-10-06T19:05:00.000Z", endedAt: null, seconds: 1800, plannedSeconds: null, minutes: null, mode: null, theme: null,
      locationId: null, blockRef: null, blockNumber: null, completed: true, stepsTotal: null, stepsDone: null, movesDone: [],
      note: null, newMove: null, payloadHash: "h", createdAt: SAVED, updatedAt: SAVED,
    });
    expect(await save(payload(s))).toMatchObject({ status: "saved" });
  });

  it("the hash is the client's own, over the body it sent: a retry after a deploy that added a defaulted field is same_payload (audit 2b-A M-6)", async () => {
    const s = await started("build");
    // The client sends its fully parsed payload, built with the schema it shipped with. Say that schema had no
    // `review`: the body has none, and the server before the deploy stored the hash of exactly that body.
    const { review: _review, ...sent } = performedSessionSaveSchema.parse(payload(s));
    expect(await save(sent)).toMatchObject({ status: "saved" });
    await db.update(performedSessions).set({ payloadHash: await sha256Hex(canonicalJson(sent)) }).where(eq(performedSessions.id, sent.id));
    // The response was lost; the server now defaults `review`. The retry is the same session, the same body.
    statements.length = 0;
    expect(await save(JSON.parse(JSON.stringify(sent)))).toEqual({ status: "same_payload" });
    expect(statements.filter(isWrite)).toEqual([]);
  });

  it("a save that died part-way is finished by the retry: one of everything, committed", async () => {
    const s = await started("build");
    const body = payload(s);
    // The first attempt got as far as the session row (still marked pending) and one stray set, then died.
    await db.insert(performedSessions).values({
      id: body.id,
      userId,
      workoutId: s.workoutId,
      activityId: body.id,
      source: "app",
      localDate: PLAYED,
      payloadHash: "pending",
      createdAt: SAVED,
      updatedAt: SAVED,
    });
    await db.insert(performedSets).values({ id: `${body.id}:stray`, performedSessionId: body.id, entryIndex: 9, exerciseId: "x", setIndex: 0 });

    expect(await save(body)).toMatchObject({ status: "saved" });
    expect(await counts()).toEqual({ sessions: 1, sets: 3, checks: 0, activities: 1, links: 1, matches: 1 });
    expect((await db.select().from(performedSessions))[0]!.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await save(body)).toEqual({ status: "same_payload" });
  });

  it("a save that dies at its last write leaves nothing: no session, activity, match or completed slot (audit 2b-A M-3)", async () => {
    const s = await started("build");
    const body = payload(s);
    const before = await rowOf(s.workoutId);
    // Killed at the commit marker: everything before it in the write phase must go with it (one transaction).
    killAt = /^update "performed_sessions" set "payload_hash"/;
    await expect(save(body)).rejects.toThrow("the invocation died here");
    killAt = null;
    expect(await counts()).toEqual({ sessions: 0, sets: 0, checks: 0, activities: 0, links: 0, matches: 0 });
    expect(await rowOf(s.workoutId)).toEqual(before);
    expect(await db.select().from(exercisePrefs)).toEqual([]);
    // Nothing is held either: the retry saves it.
    expect(await save(body)).toMatchObject({ status: "saved", matched: true });
    expect(await counts()).toEqual({ sessions: 1, sets: 3, checks: 0, activities: 1, links: 1, matches: 1 });
  });

  it("two PUTs of the same session at once: one saves, the other waits its turn (busy) or finds it saved — one of everything (audit 2b-A M-10)", async () => {
    const s = await started("build");
    const body = payload(s);
    const outcomes = await Promise.all([save(body), save(JSON.parse(JSON.stringify(body)))]);
    expect(outcomes.filter((o) => o.status === "saved")).toHaveLength(1);
    expect(outcomes.every((o) => ["saved", "busy", "same_payload"].includes(o.status))).toBe(true);
    expect(await save(body)).toEqual({ status: "same_payload" });
    expect(await counts()).toEqual({ sessions: 1, sets: 3, checks: 0, activities: 1, links: 1, matches: 1 });
  });

  for (const [edits, answer] of [["the same payload", "same_payload"], ["other edits", "conflict"]] as const) {
    it(`a second delivery (${edits}) that found nothing saved yet, and got the lock just after the first committed, answers ${answer} (audit 2b-A M-10)`, async () => {
      const s = await started("build");
      const body = payload(s);
      const second = edits === "other edits" ? { ...body, note: "the other tab" } : JSON.parse(JSON.stringify(body));
      const locks = await import("../src/services/locks.js");
      const claim = locks.claimUserLock;
      // The second request has read "nothing saved" and asks for the session's lock: the first request runs whole
      // just then.
      let first: Promise<unknown> | null = null;
      vi.spyOn(locks, "claimUserLock").mockImplementation(async (...args) => {
        if (args[2] === `save:${body.id}` && first === null) {
          first = save(body);
          await first;
        }
        return claim(...args);
      });
      try {
        expect(await save(second)).toEqual({ status: answer });
      } finally {
        vi.restoreAllMocks();
      }
      expect(await first).toMatchObject({ status: "saved" });
      expect((await db.select().from(performedSessions))[0]!.note).toBe("felt good");
      expect(await counts()).toEqual({ sessions: 1, sets: 3, checks: 0, activities: 1, links: 1, matches: 1 });
    });
  }

  it("two PUTs of the same session with different edits at once: one saves, the other is refused or busy, never merged (audit 2b-A M-10)", async () => {
    const s = await started("build");
    const body = payload(s);
    const edited = { ...body, note: "the other tab" };
    const outcomes = await Promise.all([save(body), save(edited)]);
    const won = outcomes.findIndex((o) => o.status === "saved");
    expect(won).toBeGreaterThanOrEqual(0);
    expect(["conflict", "busy"]).toContain(outcomes[1 - won]!.status);
    // Delivered again: the loser is a conflict, for good; the stored session is the winner's, whole.
    expect(await save(won === 0 ? edited : body)).toEqual({ status: "conflict" });
    expect((await db.select().from(performedSessions))[0]!.note).toBe(won === 0 ? "felt good" : "the other tab");
    expect(await counts()).toEqual({ sessions: 1, sets: 3, checks: 0, activities: 1, links: 1, matches: 1 });
  });

  it("another save of the same session in flight answers busy, and writes nothing", async () => {
    const s = await started("build");
    const body = payload(s);
    // Claimed a moment ago by another request (the lock's clock is the real one).
    await db.insert(coachLocks).values({ userId, kind: `save:${body.id}`, token: "other-request", claimedAt: new Date().toISOString() });
    statements.length = 0;
    expect(await save(body)).toEqual({ status: "busy" });
    expect(statements.filter((q) => isWrite(q) && !/coach_locks/.test(q))).toEqual([]);
  });

  it("refuses a payload whose id is not the address's, or that is not the app's own", async () => {
    const s = await started("build");
    await expect(save(payload(s), "another-id")).rejects.toThrow("invalid_save");
    await expect(save(payload(s, { source: "import", sourceRef: "x" }))).rejects.toThrow("invalid_save");
    await expect(save({ id: "x" })).rejects.toThrow("invalid_save");
  });
});

describe("the review's decisions apply on save (§2b step 5)", () => {
  it("ratings and 'not for me' land in exercise_prefs, the new move's first day is kept", async () => {
    const s = await started("build");
    const [a, b] = s.build.items.map((i) => i.exerciseId);
    await db.insert(exercisePrefs).values({ id: `${userId}:${b}`, userId, exerciseId: b!, rating: 1, excluded: false, pinned: true, introducedOn: "2026-09-01", updatedAt: SAVED });
    await save(payload(s, { newMove: a!, review: { ratings: { [a!]: -1, [b!]: null }, excluded: { [b!]: true } } }));
    const rows = await db.select().from(exercisePrefs).where(eq(exercisePrefs.userId, userId));
    const byId = Object.fromEntries(rows.map((r) => [r.exerciseId, [r.rating, r.excluded, r.pinned, r.introducedOn]]));
    expect(byId).toEqual({ [a!]: [-1, false, false, PLAYED], [b!]: [null, true, true, "2026-09-01"] });
  });

  it("a rating or 'not for me' for an exercise the library does not have is dropped, never stored (audit 2b-A M-4)", async () => {
    const s = await started("build");
    const a = s.build.items[0]!.exerciseId;
    expect(await save(payload(s, { review: { ratings: { [a]: 1, "no-such-move": -1 }, excluded: { "not-a-move-either": true } } }))).toMatchObject({
      status: "saved",
    });
    const rows = await db.select().from(exercisePrefs).where(eq(exercisePrefs.userId, userId));
    expect(rows.find((r) => r.exerciseId === a)).toMatchObject({ rating: 1 });
    expect(rows.map((r) => r.exerciseId).filter((id) => id.includes("move"))).toEqual([]);
  });

  it("a session whose moves were all skipped still saves its ratings of them (ruling 2b-R17, re-review 2b-B C-A)", async () => {
    const s = await started("build");
    const ids = [...new Set(s.build.items.map((i) => i.exerciseId))];
    // Nothing logged, nothing done: every move was skipped, and the review 👎'd each one.
    const body = payload(s, {
      entries: [],
      movesDone: [],
      movesPlanned: ids.length,
      completed: false,
      stepsDone: 0,
      review: { ratings: Object.fromEntries(ids.map((id) => [id, -1 as const])) },
    });
    expect(await save(body)).toMatchObject({ status: "saved" });
    const rows = await db.select().from(exercisePrefs).where(eq(exercisePrefs.userId, userId));
    expect(Object.fromEntries(rows.map((r) => [r.exerciseId, r.rating]))).toEqual(Object.fromEntries(ids.map((id) => [id, -1])));
  });

  it("a new move met before keeps the day it was first introduced", async () => {
    const s = await started("build");
    const b = s.build.items[1]!.exerciseId;
    await db.insert(exercisePrefs).values({ id: `${userId}:${b}`, userId, exerciseId: b, rating: null, excluded: false, pinned: false, introducedOn: "2026-09-01", updatedAt: SAVED });
    await save(payload(s, { newMove: b }));
    const [row] = await db.select().from(exercisePrefs).where(eq(exercisePrefs.id, `${userId}:${b}`));
    expect(row!.introducedOn).toBe("2026-09-01");
  });

  it("an accepted graduation switches the block's lift once, however often the save is retried", async () => {
    const s = await started("build");
    const block = (await loadProgramState(db, programId))!;
    const family = Object.keys(block.core).find((f) => block.core[f]);
    expect(family).toBeDefined();
    // A harder move the family can take (the engine's own candidates), not the block's current lift.
    const { Blocks } = await import("@rg/session-engine");
    const { makeEngineData, EXERCISES, LOCATION_PRESETS } = await import("@rg/exercise-library");
    const data = makeEngineData({ activeProfiles: [], careProfiles: [], exercises: EXERCISES });
    const home = LOCATION_PRESETS.find((l) => l.id === "home")!;
    const to = Blocks.familyCandidates(data, family!, { equipment: home.equipment }).find((e) => e.id !== block.core[family!])!.id;

    const body = payload(s, { review: { graduations: [{ family: family!, to }] } });
    // A retry after a death before the commit marker applies the review again.
    await db.insert(performedSessions).values({ id: body.id, userId, source: "app", localDate: PLAYED, payloadHash: "pending", createdAt: SAVED, updatedAt: SAVED });
    await save(body);
    const after = (await loadProgramState(db, programId))!;
    expect(after.core[family!]).toBe(to);
    expect(after.rotations.filter((r) => r.why === "graduated")).toEqual([
      { family: family!, from: block.core[family!], to, date: PLAYED, why: "graduated" },
    ]);

    await db.update(performedSessions).set({ payloadHash: "pending" }).where(eq(performedSessions.id, body.id));
    await save(body);
    expect((await loadProgramState(db, programId))!.rotations.filter((r) => r.why === "graduated")).toHaveLength(1);
  });
});

describe("the garden replays from the session's own day (§2b step 6)", () => {
  // The 2d epoch gate (APP_SESSION_EPOCH) is not there yet: today an app session credits through the completed slot,
  // with the slot's discipline. When the gate lands, this asserts the post-epoch case.
  const dayInput = async (date: string): Promise<GardenDayInput | undefined> =>
    (await db.select().from(gardenDayInputs).where(eq(gardenDayInputs.id, `${userId}:${date}`)))[0]?.input as unknown as
      | GardenDayInput
      | undefined;

  for (const [mode, axis] of [["build", "strength"], ["recovery", "yoga"]] as const) {
    it(`a ${mode === "build" ? "strength" : "mobility"} session credits ${axis}, once, on the day it was done`, async () => {
      await ensureGarden(db, userId, prefs, "2026-09-28");
      const s = await started(mode);
      await advanceGarden(db, userId, prefs, new Date(SAVED));
      // Yesterday's slot still open: the garden's grace window holds the day back.
      expect(await dayInput(PLAYED)).toBeUndefined();

      await save(payload(s));

      const credited = (await dayInput(PLAYED))!.completedRuns;
      expect(credited).toHaveLength(1);
      expect(credited[0]).toMatchObject({ workoutId: s.workoutId, discipline: axis, activityId: payload(s).id });
      expect(credited[0]!.unplanned).toBeUndefined();
    });
  }

  /** Four days on: the garden has walked past the slot's day, which counted as missed while the slot stood open. */
  const LATE = "2026-10-10T16:00:00.000Z";
  async function closedDay() {
    await ensureGarden(db, userId, prefs, "2026-09-28");
    const s = await started("build");
    await advanceGarden(db, userId, prefs, new Date(LATE));
    expect((await dayInput(PLAYED))!.completedRuns).toEqual([]);
    return s;
  }

  it("a session that ran past midnight replays from its slot's day, which the completed slot credits (ruling 2b-R7)", async () => {
    // A Monday slot: the garden's weekly checkpoint is that very day, so a replay from the next day would start after it.
    const MONDAY = "2026-10-05";
    await ensureGarden(db, userId, prefs, "2026-09-28");
    const workoutId = await seedSlot(MONDAY);
    const built = await buildSession(db, userId, workoutId, { overrides: { mode: "build" } }, { today: MONDAY, now: "2026-10-05T19:00:00.000Z", prefs });
    const build = (await startSession(db, userId, workoutId, built.build!.buildId, "2026-10-05T19:00:00.000Z")).build!;
    await advanceGarden(db, userId, prefs, new Date(LATE));
    expect((await dayInput(MONDAY))!.completedRuns).toEqual([]);
    // Started at 23:40 on the slot's day, saved with the next day's date.
    const body = payload({ workoutId, build }, { localDate: PLAYED, startedAt: "2026-10-06T06:40:00.000Z", endedAt: "2026-10-06T07:11:00.000Z" });
    expect(await save(body, body.id, { now: LATE })).toMatchObject({ status: "saved", matched: true });
    expect((await dayInput(MONDAY))!.completedRuns.map((r) => r.workoutId)).toEqual([workoutId]);
  });

  it("a replay killed after the commit is not lost: the day is on record, and the next garden read credits it (audit 2b-A M-5)", async () => {
    const s = await closedDay();
    const body = payload(s);
    // The replay dies at its first day; the save itself had committed.
    killAt = /^insert into "garden_day_inputs"/;
    expect(await save(body, body.id, { now: LATE })).toMatchObject({ status: "saved" });
    expect(killAt).toBeNull();
    // The response was lost; the outbox's retry finds it saved, and drops the entry.
    expect(await save(body, body.id, { now: LATE })).toEqual({ status: "same_payload" });
    // The next garden read (or the hourly cron) walks the change on record.
    await advanceGarden(db, userId, prefs, new Date(LATE));
    expect((await dayInput(PLAYED))!.completedRuns.map((r) => r.workoutId)).toEqual([s.workoutId]);
  });

  it("an old session replays through the capped catch-up: the save stays inside D1's query budget, and the next garden reads finish the walk (ruling 2b-R7, audit 2b-A I-4)", async () => {
    await ensureGarden(db, userId, prefs, "2026-05-01");
    const s = await started("build");
    const old = await seedSlot("2026-05-04");
    await advanceGarden(db, userId, prefs, new Date(SAVED));
    // A tablet that saved it offline in May and only now came online.
    const body = payload(s, {
      workoutId: old,
      buildId: null,
      localDate: "2026-05-04",
      startedAt: "2026-05-04T19:05:00.000Z",
      endedAt: "2026-05-04T19:36:00.000Z",
    });
    statements.length = 0;
    expect(await save(body)).toMatchObject({ status: "saved", matched: true });
    console.log(`[save] a 156-day-old session: ${statements.length} statements, save and capped replay together`);
    expect(statements.length).toBeLessThan(800);
    const [account] = await db.select().from(accountState).where(eq(accountState.userId, userId));
    expect(account!.gardenCatchUpPending).toBe(true);
    // The save's own step walked a month from the start of May, no more.
    const [state] = await db.select().from(schema.gardenState).where(eq(schema.gardenState.userId, userId));
    expect(state!.lastSimulatedDate < "2026-06-05").toBe(true);

    let steps = 0;
    let result: Awaited<ReturnType<typeof advanceGarden>>;
    do {
      result = await advanceGarden(db, userId, prefs, new Date(SAVED));
      steps += 1;
    } while (result.resimPending && steps < 10);
    expect(result.resimPending).toBeFalsy();
    expect(result.lastSimulatedDate >= "2026-10-05").toBe(true);
    expect((await dayInput("2026-05-04"))!.completedRuns.map((r) => r.workoutId)).toContain(old);
    expect((await db.select().from(accountState).where(eq(accountState.userId, userId)))[0]).toMatchObject({ gardenCatchUpPending: false, gardenChangedFrom: null });
    // Five months of garden walked twice: ~3 s here, half a minute on a loaded runner.
  }, 120_000);
});

describe("ruling 2b-R7 as amended: the session's day is its locked build's, else its slot's (audit 2b-A I-4)", () => {
  it("refuses a day before the slot's or more than a day after it: invalid_save, nothing written", async () => {
    const s = await started("build");
    statements.length = 0;
    for (const localDate of ["2026-10-05", "2026-10-08", "2026-05-02"]) {
      await expect(save(payload(s, { localDate }))).rejects.toThrow("invalid_save");
    }
    expect(statements.filter(isWrite)).toEqual([]);
  });

  it("refuses a day after tomorrow, whatever the slot says", async () => {
    const s = await started("build");
    const ahead = await seedSlot("2026-10-10");
    const body = payload(s, { workoutId: ahead, buildId: null, localDate: "2026-10-10" });
    await expect(save(body)).rejects.toThrow("invalid_save");
    // Its day is tomorrow (a clock a little ahead): taken.
    expect(await save(body, body.id, { now: "2026-10-09T16:00:00.000Z" })).toMatchObject({ status: "saved" });
  });

  it("a session started yesterday and continued today (ruling 2b-R16): its save, dated the build's day, is taken", async () => {
    const s = await started("build");
    // The day after Start, in the evening: Today offered Continue from the device's session in progress.
    expect(await save(payload(s), undefined, { now: "2026-10-07T20:00:00.000Z" })).toMatchObject({ status: "saved" });
    expect(await rowOf(s.workoutId)).toMatchObject({ contentState: "done" });
  });

  it("a committed save's retry is same_payload even after its slot moved", async () => {
    const s = await started("build");
    const body = payload(s);
    await save(body);
    await db.update(plannedWorkouts).set({ effectiveDate: "2026-10-09" }).where(eq(plannedWorkouts.id, s.workoutId));
    expect(await save(body)).toEqual({ status: "same_payload" });
  });

  /** The slot moved to `date` after Start (the athlete in another tab, the coach, a collision pass), before the drain. */
  const moveSlot = (workoutId: string, date: string) =>
    db.update(plannedWorkouts).set({ effectiveDate: date }).where(eq(plannedWorkouts.id, workoutId));

  it("amended: the day is the LOCKED build's — a slot moved after Start still saves, completes, and the garden replays from the earliest day touched", async () => {
    await ensureGarden(db, userId, prefs, "2026-09-28");
    const s = await started("build"); // built and started on PLAYED
    const LATE = "2026-10-10T16:00:00.000Z";
    await advanceGarden(db, userId, prefs, new Date(LATE));
    // Moved two days back while the save sat in the outbox: the slot now credits that day.
    const EARLIER = "2026-10-04";
    await moveSlot(s.workoutId, EARLIER);

    const outcome = await save(payload(s), payload(s).id, { now: LATE });
    expect(outcome).toMatchObject({ status: "saved", matched: true });
    expect(await rowOf(s.workoutId)).toMatchObject({ completionState: "completed", contentState: "done", effectiveDate: EARLIER });
    // The replay reached back to the slot's new day, behind the Monday checkpoint after it.
    const day = (await db.select().from(gardenDayInputs).where(eq(gardenDayInputs.id, `${userId}:${EARLIER}`)))[0]?.input as unknown as GardenDayInput;
    expect(day.completedRuns.map((r) => r.workoutId)).toEqual([s.workoutId]);
  });

  it("amended: the build's day joins the replay — a session past midnight of its Monday build, saved unmatched after the slot moved, is extra training on that Monday", async () => {
    const MONDAY = "2026-10-05";
    const LATE = "2026-10-10T16:00:00.000Z";
    await ensureGarden(db, userId, prefs, "2026-09-28");
    const workoutId = await seedSlot(MONDAY);
    const built = await buildSession(db, userId, workoutId, { overrides: { mode: "build" } }, { today: MONDAY, now: "2026-10-05T19:00:00.000Z", prefs });
    const build = (await startSession(db, userId, workoutId, built.build!.buildId, "2026-10-05T19:00:00.000Z")).build!;
    await advanceGarden(db, userId, prefs, new Date(LATE));
    // Moved to Thursday, where the athlete matched another lift by hand: this session cannot match it.
    await moveSlot(workoutId, "2026-10-08");
    await db.insert(activities).values({ id: "theirs", userId, startTime: "2026-10-08T14:00:00Z", sport: "strength", durationSeconds: 1500, completionMatchId: "m-hand", createdAt: SAVED, updatedAt: SAVED });
    await db.insert(workoutCompletionMatches).values({ id: "m-hand", workoutId, activityId: "theirs", confidence: 1, method: "manual", matchedAt: SAVED });

    // Started at 23:40 on the Monday, saved with Tuesday's date.
    const body = payload({ workoutId, build }, { localDate: PLAYED, startedAt: "2026-10-06T06:40:00.000Z", endedAt: "2026-10-06T07:11:00.000Z" });
    expect(await save(body, body.id, { now: LATE })).toMatchObject({ status: "saved", matched: false, notes: ["slot_already_matched"] });
    const monday = (await db.select().from(gardenDayInputs).where(eq(gardenDayInputs.id, `${userId}:${MONDAY}`)))[0]?.input as unknown as GardenDayInput;
    expect(monday.completedRuns.filter((r) => r.activityId === body.id).map((r) => [r.workoutId, r.unplanned])).toEqual([[`unplanned-${body.id}`, true]]);
  });

  it("amended: with no build locked, the slot's own day is the reference (an unlocked build's day is not)", async () => {
    // Built for PLAYED but never started; the slot moved on to the 9th.
    const workoutId = await seedSlot(PLAYED);
    const built = await buildSession(db, userId, workoutId, { overrides: { mode: "build" } }, { today: PLAYED, now: PLAYED_NOON, prefs });
    await moveSlot(workoutId, "2026-10-09");
    const body = payload({ workoutId, build: built.build! }, { buildId: null, localDate: "2026-10-09" });
    expect(await save(body, body.id, { now: "2026-10-09T16:00:00.000Z" })).toMatchObject({ status: "saved" });
  });

  it("ruling 2b-R19: a save waiting on another device lands after the slot was un-started, moved and built again (re-review 2b-B N-2)", async () => {
    const s = await started("build"); // device A plays it on PLAYED; its save waits in A's outbox
    const NINTH = "2026-10-09";
    const LATER = "2026-10-09T16:00:00.000Z";
    // Device B Discards (the un-start), the slot is moved to the 9th, and B opens it that day (a new build, then Start).
    await unstartSession(db, userId, s.workoutId, { today: PLAYED, now: PLAYED_NOON });
    await moveSlot(s.workoutId, NINTH);
    const rebuilt = await buildSession(db, userId, s.workoutId, { overrides: { mode: "recovery" } }, { today: NINTH, now: LATER, prefs });
    expect(rebuilt.build!.buildId).not.toBe(s.build.buildId);
    // A comes back online on the 9th: its session, dated the day its build was started for, is taken.
    expect(await save(payload(s), undefined, { now: LATER })).toMatchObject({ status: "saved" });
    expect(await rowOf(s.workoutId)).toMatchObject({ contentState: "done", effectiveDate: NINTH });
  });

  it("ruling 2b-R19: the day of a build that was started once still counts after a new Start on the slot's new day", async () => {
    const s = await started("build");
    const NINTH = "2026-10-09";
    const LATER = "2026-10-09T16:00:00.000Z";
    await unstartSession(db, userId, s.workoutId, { today: PLAYED, now: PLAYED_NOON });
    await moveSlot(s.workoutId, NINTH);
    const rebuilt = await buildSession(db, userId, s.workoutId, { overrides: { mode: "recovery" } }, { today: NINTH, now: LATER, prefs });
    await startSession(db, userId, s.workoutId, rebuilt.build!.buildId, LATER);
    // Either build's day is the session's: A's (PLAYED) and the new one's (the 9th); any other day is still refused.
    await expect(save(payload(s, { localDate: "2026-10-08" }), undefined, { now: LATER })).rejects.toThrow("invalid_save");
    expect(await save(payload(s), undefined, { now: LATER })).toMatchObject({ status: "saved" });
  });

  it("amended: a slot moved ahead after Start saves too, and the build's day is still the reference — not the slot's", async () => {
    const s = await started("build");
    await moveSlot(s.workoutId, "2026-10-08");
    // The session's day is the build's (PLAYED), whatever day the slot shows now.
    await expect(save(payload(s, { localDate: "2026-10-08" }))).rejects.toThrow("invalid_save");
    expect(await save(payload(s))).toMatchObject({ status: "saved", matched: true });
  });
});

describe("the watch and the app, one physical session (programme spec §10.6; ruling 2b-R3; Phase 0 audit 1 ingest #3)", () => {
  const watch = (over: Partial<SourceActivity> = {}): SourceActivity => ({
    provider: "coros",
    providerActivityId: "lbl-strength-9001",
    startTime: "2026-10-06T19:06:00Z",
    startTimeLocal: "2026-10-06T12:06:00",
    sport: "strength",
    durationSeconds: 1850,
    avgHeartRate: 104,
    title: "Strength",
    contentFingerprint: "fp-1",
    ...over,
  });
  const details = { "lbl-strength-9001": detailOf(workView()) };

  it("app yoga session saved, the watch's Strength copy ingested twice: one activity, the app's title, yoga, the watch's HR", async () => {
    const s = await started("recovery");
    const body = payload(s);
    await save(body);

    await ingestActivities(db, { userId, sources: [watch()], strengthDetailsByProviderId: details });
    // The refresh path: COROS changed something (a new fingerprint), with a title and sport of its own.
    await ingestActivities(db, { userId, sources: [watch({ contentFingerprint: "fp-2", avgHeartRate: 108 })], strengthDetailsByProviderId: details });

    const rows = await db.select().from(activities);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: body.id, title: s.title, sport: "yoga", avgHeartRate: 108, corosActivityId: "lbl-strength-9001" });
    // The app's session owns the sets: no watch copy, on the adopting ingest or the refresh (audit 2a+ M-4).
    expect((await db.select().from(performedSessions)).map((p) => p.source)).toEqual(["app"]);
    // Still one match, to the slot, and the slot still yoga.
    expect((await db.select().from(workoutCompletionMatches)).map((m) => [m.workoutId, m.activityId])).toEqual([[s.workoutId, body.id]]);
    expect(await rowOf(s.workoutId)).toMatchObject({ category: "yoga", sport: "yoga" });
  });

  it("an app row is adoptable by COROS (only import rows never are): a strength session merges too", async () => {
    const s = await started("build");
    const body = payload(s);
    await save(body);
    await ingestActivities(db, { userId, sources: [watch()] });
    const rows = await db.select().from(activities);
    expect(rows.map((r) => [r.id, r.corosActivityId, r.title, r.sport])).toEqual([[body.id, "lbl-strength-9001", s.title, "strength"]]);
  });

  it("watch first, app save after: the save joins the watch's activity, drops its watch copy, and its title and sport last", async () => {
    const s = await started("recovery");
    await ingestActivities(db, { userId, sources: [watch()], strengthDetailsByProviderId: details });
    const [corosRow] = await db.select().from(activities);
    expect((await db.select().from(performedSessions)).map((p) => p.source)).toEqual(["watch"]);

    const body = payload(s);
    const outcome = await save(body);
    expect(outcome).toMatchObject({ status: "saved", activityId: corosRow!.id, matched: true });
    expect(corosRow!.id).not.toBe(body.id);

    const rows = await db.select().from(activities);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: corosRow!.id, title: s.title, sport: "yoga", avgHeartRate: 104, source: "coros", durationSeconds: 1850 });
    const sessions = await db.select().from(performedSessions);
    expect(sessions.map((p) => [p.source, p.activityId])).toEqual([["app", corosRow!.id]]);
    expect(await db.select().from(performedSets)).toHaveLength(3); // the app's, none of the watch's
    expect((await db.select().from(activitySourceLinks)).map((l) => l.provider).sort()).toEqual(["app", "coros"]);
    // One match, slot to that activity (the ingest's matcher may already have made it; the save keeps it).
    expect((await db.select().from(workoutCompletionMatches)).map((m) => [m.workoutId, m.activityId])).toEqual([[s.workoutId, corosRow!.id]]);
    expect(await rowOf(s.workoutId)).toMatchObject({ completionState: "completed", contentState: "done", sport: "yoga" });

    // Later COROS refreshes keep the app's title and sport, and never bring the watch copy back.
    await ingestActivities(db, { userId, sources: [watch({ contentFingerprint: "fp-2", avgHeartRate: 111 })], strengthDetailsByProviderId: details });
    await ingestActivities(db, { userId, sources: [watch({ contentFingerprint: "fp-2", avgHeartRate: 111 })], strengthDetailsByProviderId: details });
    expect((await db.select().from(activities))[0]).toMatchObject({ title: s.title, sport: "yoga", avgHeartRate: 111 });
    expect((await db.select().from(performedSessions)).map((p) => p.source)).toEqual(["app"]);
  });

  it("a save waits for a COROS read in flight (the ingest's coros_read lock): busy, nothing written, and the read's lock is left alone (audit 2b-A M-7)", async () => {
    const s = await started("build");
    const body = payload(s);
    // A read-now is ingesting: it looked for an app row to adopt a moment ago and is about to insert the watch's.
    await db.insert(coachLocks).values({ userId, kind: "coros_read", token: "read-now", claimedAt: new Date().toISOString() });
    statements.length = 0;
    expect(await save(body)).toEqual({ status: "busy" });
    expect(statements.filter((q) => isWrite(q) && !/coach_locks/.test(q))).toEqual([]);
    expect((await db.select().from(coachLocks)).map((l) => [l.kind, l.token])).toEqual([["coros_read", "read-now"]]);

    // The read finishes (its copy of the session landed meanwhile); the outbox's retry joins it — one activity.
    await ingestActivities(db, { userId, sources: [watch()] });
    await db.delete(coachLocks);
    expect(await save(body)).toMatchObject({ status: "saved" });
    expect(await db.select().from(activities)).toHaveLength(1);
    // And the save let go of every claim it took: a read-now after it is not refused.
    expect(await db.select().from(coachLocks)).toEqual([]);
  });

  it("a session older than the read window also waits for the deep backfill's lock (the backfill ingests those days)", async () => {
    const s = await started("build");
    const body = payload(s);
    await db.insert(coachLocks).values({ userId, kind: "coros_backfill", token: "backfill", claimedAt: new Date().toISOString() });
    // Delivered three weeks late: the backfill walks those days.
    expect(await save(body, body.id, { now: "2026-10-28T16:00:00.000Z" })).toEqual({ status: "busy" });
    // A session inside the read window does not wait for the backfill.
    expect(await save(body)).toMatchObject({ status: "saved" });
    expect((await db.select().from(coachLocks)).map((l) => l.kind)).toEqual(["coros_backfill"]);
  });

  it("a watch activity far from the session's time, another sport, or imported is left alone", async () => {
    const s = await started("build");
    const coros = (id: string, startTime: string, sport: string, source = "coros") => ({
      id,
      userId,
      corosActivityId: `lbl-${id}`,
      source,
      startTime,
      sport,
      durationSeconds: 1850,
      title: "Strength",
      createdAt: SAVED,
      updatedAt: SAVED,
    });
    await db.insert(activities).values([
      coros("far", "2026-10-06T21:30:00Z", "strength"),
      coros("run", "2026-10-06T19:06:00Z", "run"),
      coros("old", "2026-10-06T19:06:00Z", "strength", "import"),
    ]);
    const body = payload(s);
    expect(await save(body)).toMatchObject({ activityId: body.id });
    const rows = await db.select().from(activities);
    expect(rows).toHaveLength(4);
    expect(rows.filter((a) => a.id !== body.id).map((a) => [a.id, a.title, a.sport, a.completionMatchId])).toEqual([
      ["far", "Strength", "strength", null],
      ["run", "Strength", "run", null],
      ["old", "Strength", "strength", null],
    ]);
  });
});

describe("ruling 2b-R5: the app's session supersedes an automatic match, never a manual one (audit 2b-A I-2, I-3)", () => {
  const YESTERDAY = "2026-10-05";
  const TOMORROW = "2026-10-07";
  const watchCopy = (over: Partial<SourceActivity> = {}): SourceActivity => ({
    provider: "coros",
    providerActivityId: "lbl-strength-9001",
    startTime: "2026-10-06T19:06:00Z",
    startTimeLocal: "2026-10-06T12:06:00",
    sport: "strength",
    durationSeconds: 1850,
    avgHeartRate: 104,
    title: "Strength",
    contentFingerprint: "fp-1",
    ...over,
  });

  /** Another activity of the athlete's that day (no COROS id: never the session's watch copy). */
  async function otherActivity(id: string, startTime = "2026-10-06T14:00:00Z", sport = "strength") {
    await db.insert(activities).values({ id, userId, startTime, sport, durationSeconds: 1500, createdAt: SAVED, updatedAt: SAVED });
  }
  /** `activityId` completes `workoutId` by `method`, as the ingest's matcher (or the athlete) left it. */
  async function matched(matchId: string, workoutId: string, activityId: string, method: string, resolutionDate = PLAYED) {
    await db.insert(workoutCompletionMatches).values({ id: matchId, workoutId, activityId, confidence: 0.8, method, matchedAt: SAVED });
    await db.update(activities).set({ completionMatchId: matchId }).where(eq(activities.id, activityId));
    await db.update(plannedWorkouts).set({ completionState: "completed", resolutionDate }).where(eq(plannedWorkouts.id, workoutId));
  }
  const active = async () =>
    (await db.select().from(workoutCompletionMatches))
      .filter((m) => m.undoneAt === null)
      .map((m) => [m.workoutId, m.activityId, m.method])
      .sort();
  const pointer = async (id: string) => (await db.select().from(activities).where(eq(activities.id, id)))[0]!.completionMatchId;
  /** The watch's copy ingested first, with whatever the ingest's matcher did undone: the case under test is planted. */
  async function watchFirst(): Promise<string> {
    await ingestActivities(db, { userId, sources: [watchCopy()], strengthDetailsByProviderId: { "lbl-strength-9001": detailOf(workView()) } });
    await db.delete(workoutCompletionMatches);
    await db.update(activities).set({ completionMatchId: null });
    await db.update(plannedWorkouts).set({ completionState: "scheduled", resolutionDate: null });
    return (await db.select().from(activities))[0]!.id;
  }
  async function strengthSlot(date: string): Promise<string> {
    const id = await seedSlot(date);
    await db.update(plannedWorkouts).set({ title: "Strength", category: "strength", sport: "strength" }).where(eq(plannedWorkouts.id, id));
    return id;
  }

  for (const method of ["scored_auto", "coros_plan_link"]) {
    it(`a ${method} match of another activity yields: undone, that activity extra training once, the slot the app session's`, async () => {
      const s = await started("build");
      await otherActivity("morning-lift");
      await matched("m-auto", s.workoutId, "morning-lift", method);
      // The watch logged that lift's sets, and the match named its workout (linkWatchSessionsToWorkouts).
      await db.insert(performedSessions).values({ id: "watch-morning", userId, workoutId: s.workoutId, activityId: "morning-lift", source: "watch", sourceRef: "lbl-morning", localDate: PLAYED, payloadHash: "h", createdAt: SAVED, updatedAt: SAVED });
      const body = payload(s);

      expect(await save(body)).toEqual({ status: "saved", performedId: body.id, activityId: body.id, matched: true, notes: ["superseded_auto_match"] });
      // That lift's own session no longer performed this slot (the slot's pre-check is not its to carry).
      expect((await db.select().from(performedSessions).where(eq(performedSessions.id, "watch-morning")))[0]!.workoutId).toBeNull();
      expect((await db.select().from(workoutCompletionMatches).where(eq(workoutCompletionMatches.id, "m-auto")))[0]!.undoneAt).toBe(SAVED);
      expect(await active()).toEqual([[s.workoutId, body.id, "app_session"]]);
      expect(await pointer("morning-lift")).toBeNull();
      expect(await pointer(body.id)).toBe(`app:${body.id}`);
      expect(await rowOf(s.workoutId)).toMatchObject({ completionState: "completed", resolutionDate: PLAYED, contentState: "done" });

      // The day credits the slot once, with the app's session, and the displaced lift once, as extra training.
      const day = await buildDayInput(db, userId, PLAYED, prefs);
      expect(day.completedRuns.map((r) => [r.workoutId, r.activityId, r.unplanned ?? false])).toEqual([
        [s.workoutId, body.id, false],
        ["unplanned-morning-lift", "morning-lift", true],
      ]);
    });
  }

  for (const method of ["manual", "app_session"]) {
    it(`a ${method} match is never superseded: the save lands unmatched and says so`, async () => {
      const s = await started("build");
      await otherActivity("theirs");
      await matched("m-kept", s.workoutId, "theirs", method);
      const outcome = await save(payload(s));
      expect(outcome).toMatchObject({ status: "saved", matched: false, notes: ["slot_already_matched"] });
      expect(await active()).toEqual([[s.workoutId, "theirs", method]]);
      expect(await pointer("theirs")).toBe("m-kept");
    });
  }

  it("a retry of a superseding save supersedes nothing more: one live match, the displaced one undone once", async () => {
    const s = await started("build");
    await otherActivity("morning-lift");
    await matched("m-auto", s.workoutId, "morning-lift", "scored_auto");
    const body = payload(s);
    await save(body);
    // A row an older deploy left pending is redone from the top: the second pass finds its own match on the slot.
    await db.update(performedSessions).set({ payloadHash: "pending" }).where(eq(performedSessions.id, body.id));
    expect(await save(body, body.id, { now: "2026-10-07T17:00:00.000Z" })).toMatchObject({ status: "saved", matched: true, notes: [] });
    expect(await active()).toEqual([[s.workoutId, body.id, "app_session"]]);
    expect((await db.select().from(workoutCompletionMatches).where(eq(workoutCompletionMatches.id, "m-auto")))[0]!.undoneAt).toBe(SAVED);
    expect(await db.select().from(workoutCompletionMatches)).toHaveLength(2);
  });

  it("watch first and already auto-matched to this slot: the same match becomes the app session's (method app_session, confidence 1)", async () => {
    const s = await started("recovery");
    const coros = await watchFirst();
    await matched("m-watch", s.workoutId, coros, "scored_auto");
    expect(await save(payload(s))).toMatchObject({ status: "saved", activityId: coros, matched: true, notes: [] });
    const [m] = await db.select().from(workoutCompletionMatches);
    expect(m).toMatchObject({ id: "m-watch", workoutId: s.workoutId, activityId: coros, method: "app_session", confidence: 1, undoneAt: null });
  });

  it("watch first, its activity auto-matched to yesterday's slot: moved here, yesterday's slot reopens, and the garden replays from yesterday (I-3)", async () => {
    await ensureGarden(db, userId, prefs, "2026-09-28");
    const s = await started("recovery");
    const yesterday = await seedSlot(YESTERDAY);
    const coros = await watchFirst();
    await matched("m-elsewhere", yesterday, coros, "scored_auto", PLAYED);
    await advanceGarden(db, userId, prefs, new Date(SAVED));
    const credited = async (date: string, workoutId: string) =>
      (((await db.select().from(gardenDayInputs).where(eq(gardenDayInputs.id, `${userId}:${date}`)))[0]?.input as unknown as GardenDayInput | undefined)?.completedRuns ?? []).some(
        (r) => r.workoutId === workoutId,
      );
    expect(await credited(YESTERDAY, yesterday)).toBe(true);

    const outcome = await save(payload(s));
    expect(outcome).toMatchObject({ status: "saved", activityId: coros, matched: true, notes: ["superseded_auto_match"] });
    expect(await active()).toEqual([[s.workoutId, coros, "app_session"]]);
    expect(await pointer(coros)).toBe(`app:${payload(s).id}`);
    expect(await rowOf(yesterday)).toMatchObject({ completionState: "unresolved", resolutionDate: null });
    expect(await rowOf(s.workoutId)).toMatchObject({ completionState: "completed", resolutionDate: PLAYED });
    // Yesterday's credit came from a session that was today's: the replay went back for it.
    expect(await credited(YESTERDAY, yesterday)).toBe(false);
  });

  it("watch first, its activity matched by hand to another slot: that match stands, and the save says so (I-3)", async () => {
    const s = await started("recovery");
    const yesterday = await seedSlot(YESTERDAY);
    const coros = await watchFirst();
    await matched("m-hand", yesterday, coros, "manual");
    expect(await save(payload(s))).toMatchObject({ status: "saved", activityId: coros, matched: false, notes: ["activity_matched_elsewhere"] });
    expect(await active()).toEqual([[yesterday, coros, "manual"]]);
    expect(await rowOf(yesterday)).toMatchObject({ completionState: "completed" });
    expect(await rowOf(s.workoutId)).toMatchObject({ completionState: "scheduled", contentState: "done" });
  });

  it("the next ingest never files an unmatched app session onto another open slot (I-2, the audit's P6)", async () => {
    const s = await started("build");
    await otherActivity("theirs");
    await matched("m-hand", s.workoutId, "theirs", "manual");
    const body = payload(s);
    expect(await save(body)).toMatchObject({ matched: false, notes: ["slot_already_matched"] });
    const tomorrow = await strengthSlot(TOMORROW);
    // An unrelated run that evening: its ingest runs the matching pass over these days.
    await ingestActivities(db, {
      userId,
      sources: [watchCopy({ providerActivityId: "lbl-run-1", sport: "run", startTime: "2026-10-07T01:30:00Z", startTimeLocal: "2026-10-06T18:30:00", durationSeconds: 2400, distanceMeters: 6000, contentFingerprint: "fp-run" })],
    });
    expect(await pointer(body.id)).toBeNull();
    expect(await rowOf(tomorrow)).toMatchObject({ completionState: "scheduled" });
    expect((await active()).filter(([w]) => w === tomorrow)).toEqual([]);
  });

  it("the next ingest never files the displaced activity onto another open slot either (I-2)", async () => {
    const s = await started("build");
    await otherActivity("morning-lift", "2026-10-06T19:50:00Z");
    await matched("m-auto", s.workoutId, "morning-lift", "scored_auto");
    await save(payload(s));
    const tomorrow = await strengthSlot(TOMORROW);
    await ingestActivities(db, {
      userId,
      sources: [watchCopy({ providerActivityId: "lbl-run-1", sport: "run", startTime: "2026-10-07T01:30:00Z", startTimeLocal: "2026-10-06T18:30:00", durationSeconds: 2400, distanceMeters: 6000, contentFingerprint: "fp-run" })],
    });
    expect(await pointer("morning-lift")).toBeNull();
    expect(await rowOf(tomorrow)).toMatchObject({ completionState: "scheduled" });
  });

  it("a watch-only session still completes an open program slot (R5 leaves the matcher to it)", async () => {
    const tomorrow = await strengthSlot(TOMORROW);
    await ingestActivities(db, {
      userId,
      sources: [watchCopy({ providerActivityId: "lbl-strength-2", startTime: "2026-10-07T19:06:00Z", startTimeLocal: "2026-10-07T12:06:00", contentFingerprint: "fp-2" })],
    });
    expect(await rowOf(tomorrow)).toMatchObject({ completionState: "completed" });
  });
});

function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "test-session-secret",
    TOKEN_ENCRYPTION_KEY: "test-token-encryption-key",
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
  } as Env;
}

describe("PUT /api/sessions/performed/:id", () => {
  let cookie: string;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(SAVED));
    cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
    return () => vi.useRealTimers();
  });

  const put = (path: string, body: unknown, raw = false) =>
    mountRoutes(db, "/api/sessions", sessionRoutes).request(
      path,
      { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: raw ? (body as string) : JSON.stringify(body) },
      makeEnv(),
    );

  it("200 saved, 200 same_payload, 409 conflict, 404 for a slot not found, 422 for a bad body", async () => {
    const s = await started("build");
    const body = payload(s);
    const first = await put(`/api/sessions/performed/${body.id}`, body);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: "saved", performedId: body.id });
    const again = await put(`/api/sessions/performed/${body.id}`, body);
    expect([again.status, await again.json()]).toEqual([200, { status: "same_payload" }]);
    const other = await put(`/api/sessions/performed/${body.id}`, { ...body, note: "edited" });
    expect([other.status, await other.json()]).toEqual([409, { error: "conflict" }]);
    // Another session of the same slot, from another device (ruling 2b-R18).
    const second = payload(s, { id: "c3c3c3c3-0000-4000-8000-000000000003" });
    const done = await put(`/api/sessions/performed/${second.id}`, second);
    expect([done.status, await done.json()]).toEqual([409, { error: "slot_done" }]);

    const lost = payload(s, { id: "0b6c7d8e-1111-4222-8333-944455556666", workoutId: "slot-nobody" });
    expect((await put(`/api/sessions/performed/${lost.id}`, lost)).status).toBe(404);
    expect((await put(`/api/sessions/performed/abc`, "{not json", true)).status).toBe(422);
    const wrongId = await put(`/api/sessions/performed/abc`, body);
    expect(wrongId.status).toBe(422);
    expect(await wrongId.json()).toMatchObject({ error: "invalid_save" });
    // A day that is not the slot's (ruling 2b-R7).
    const wrongDay = payload(s, { id: "5e0c1d2e-3333-4444-8555-966677778888", localDate: "2026-05-02" });
    const refused = await put(`/api/sessions/performed/${wrongDay.id}`, wrongDay);
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ error: "invalid_save", issues: [{ path: ["localDate"] }] });
  });

  it("423 while a restore replaces the account; 503 busy while the same session is being saved", async () => {
    const s = await started("build");
    const body = payload(s);
    await db.insert(coachLocks).values({ userId, kind: `save:${body.id}`, token: "other", claimedAt: SAVED });
    const busy = await put(`/api/sessions/performed/${body.id}`, body);
    expect([busy.status, await busy.json()]).toEqual([503, { error: "busy" }]);
    await db.delete(coachLocks);
    await db.insert(accountState).values({ userId, restoreId: "r", restoreStartedAt: SAVED, updatedAt: SAVED });
    expect((await put(`/api/sessions/performed/${body.id}`, body)).status).toBe(423);
    expect(await db.select().from(performedSessions)).toEqual([]);
    expect(await db.select().from(activities).where(and(eq(activities.userId, userId)))).toEqual([]);
  });
});
