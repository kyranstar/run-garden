/**
 * R11: a quick start or template started offline is played under a provisional id (`local:<clientId>`) and saved to the
 * outbox like any session. On reconnect the outbox records it: first the workout — once, with the device's key and
 * `playedOffline` (Start now: no calendar) — then the session onto it, with no build. Each step is retry-safe; a refusal
 * that remains leaves the session's entry `failed` (Retry, Discard), never lost and never saved anywhere else.
 */
import { describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { ApiError, type CreateDocWorkoutRequest } from "@rg/api-client";
import { workoutDocSchema, type PerformedSessionWire, type PerformedSessionWireInput, type WorkoutDoc } from "@rg/domain";
import { openOfflineDb, type OfflineDb } from "../../src/offline/idb.js";
import { loadBuild, saveBuild } from "../../src/offline/builds.js";
import {
  forgetLocalStart,
  isLocalId,
  loadLocalStart,
  localIdOf,
  localStarts,
  rememberLocalStart,
  startKindOf,
  unfinishedLocalStart,
  type LocalStart,
} from "../../src/offline/local-starts.js";
import { discardAccountEntries, discardEntry, drain, enqueue, entryActions, outboxEntries, retryEntry, type OutboxApi } from "../../src/offline/outbox.js";
import { queuedUnstarts } from "../../src/offline/unstarts.js";
import { discardSession, saveSession } from "../../src/player/save.js";
import { loadExtras, saveExtras } from "../../src/player/stored.js";
import type { SessionDto } from "@rg/api-client";

const ME = "u1";
const DAY = "2026-10-07";
const CLIENT = "c0ffee00-0000-4000-8000-000000000001";
const LOCAL = localIdOf(CLIENT);

const quickDoc = (kind = "desk_reset"): WorkoutDoc =>
  workoutDocSchema.parse({
    version: 1,
    title: "Desk reset",
    intent: { summary: "Undo the desk.", goals: ["posture"], focus: [], effort: "maintain" },
    parts: [{ purpose: "main", format: "straight", items: [{ kind: "exercise", libraryId: "bridge", dose: { sets: 2, reps: 12 } }] }],
    source: { kind: "studio", ref: `quick_start:${kind}` },
  });

const start = (over: Partial<LocalStart> = {}): LocalStart => ({
  localId: LOCAL,
  clientId: CLIENT,
  userId: ME,
  kind: "quick_start:desk_reset",
  title: "Desk reset",
  doc: quickDoc(),
  date: DAY,
  time: "07:30",
  createdAt: 1000,
  ...over,
});

const save = (id: string, over: Partial<PerformedSessionWireInput> = {}): PerformedSessionWireInput => ({
  id,
  source: "app",
  sourceRef: null,
  workoutId: LOCAL,
  buildId: LOCAL,
  localDate: DAY,
  startedAt: `${DAY}T07:30:00.000Z`,
  endedAt: `${DAY}T07:40:00.000Z`,
  seconds: 600,
  plannedSeconds: 600,
  minutes: 8,
  mode: "consistent",
  theme: null,
  locationId: "home",
  blockRef: null,
  blockNumber: null,
  completed: true,
  stepsTotal: 2,
  stepsDone: 2,
  note: null,
  newMove: null,
  entries: [{ exerciseId: "bridge", implement: null, format: "straight", perSide: false, sets: [{ setIndex: 0, reps: 12, seconds: null, load: null }] }],
  checks: [{ profileId: "tmj", kind: "pre", value: 2, feelingOff: false, at: `${DAY}T07:29:00.000Z` }],
  ...over,
});

type CreateOutcome = "ok" | "offline" | "started_today" | 422 | 500;
type SaveOutcome = "ok" | "offline" | 422;

/** A server double: creates and saves answered from scripts, every call recorded. */
function server(script: { create?: CreateOutcome[]; save?: SaveOutcome[] } = {}) {
  const creates: CreateDocWorkoutRequest[] = [];
  const saves: PerformedSessionWire[] = [];
  const api: Required<Pick<OutboxApi, "savePerformed" | "createWorkout">> = {
    createWorkout: vi.fn(async (body: CreateDocWorkoutRequest) => {
      creates.push(body);
      const next = script.create?.shift() ?? "ok";
      if (next === "ok") return { workout: { id: "w-server" } };
      if (next === "offline") throw new TypeError("Failed to fetch");
      if (next === "started_today") throw new ApiError(409, { error: "started_today", workout: { id: "w-today" } });
      if (next === 422) throw new ApiError(422, { error: "played_offline_refused", why: "date" });
      throw new ApiError(500, null);
    }),
    savePerformed: vi.fn(async (_id: string, payload: PerformedSessionWire) => {
      saves.push(payload);
      const next = script.save?.shift() ?? "ok";
      if (next === "ok") return { status: "saved" };
      if (next === "offline") throw new TypeError("Failed to fetch");
      throw new ApiError(422, { error: "invalid_save" });
    }),
  };
  return { api, creates, saves };
}

async function freshDb(): Promise<OfflineDb> {
  return openOfflineDb(new IDBFactory());
}

describe("the provisional id", () => {
  it("is `local:` and the device's key; a server id never reads as one", () => {
    expect(LOCAL).toBe(`local:${CLIENT}`);
    expect(isLocalId(LOCAL)).toBe(true);
    for (const id of ["w-server", "", null, undefined, "slot-local:1"]) expect(isLocalId(id)).toBe(false);
  });

  it("a start's kind is its quick start's or its template's; anything else has none", () => {
    expect(startKindOf(quickDoc("hip_opener"))).toBe("quick_start:hip_opener");
    expect(startKindOf({ ...quickDoc(), source: { kind: "studio" }, basedOn: { kind: "template", id: "tpl-9" } })).toBe("template:tpl-9");
    expect(startKindOf({ ...quickDoc(), source: { kind: "studio" } })).toBeNull();
    expect(startKindOf({ ...quickDoc(), source: { kind: "coach", ref: "quick_start:desk_reset" } })).toBeNull();
  });
});

describe("the outbox records a start made offline, then its session (R11)", () => {
  it("creates the workout once — the device's key, Start now, played offline, its own day and time — then saves onto it with no build", async () => {
    const db = await freshDb();
    await rememberLocalStart(db, start());
    await enqueue(db, save("p1"), ME, 2000);
    const { api, creates, saves } = server();
    expect(await drain(db, api, { userId: ME })).toMatchObject({ saved: 1, failed: 0 });
    expect(creates).toEqual([{ date: DAY, time: "07:30", doc: quickDoc(), clientId: CLIENT, startNow: true, playedOffline: true }]);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ id: "p1", workoutId: "w-server", buildId: null, localDate: DAY });
    // The before-reading travels in the session itself: one `pre` check, at its own time.
    expect(saves[0]!.checks).toEqual([{ profileId: "tmj", kind: "pre", value: 2, feelingOff: false, at: `${DAY}T07:29:00.000Z` }]);
    expect(await outboxEntries(db)).toEqual([]);
    // Delivered: nothing of it is kept.
    expect(await loadLocalStart(db, LOCAL)).toBeUndefined();
    db.close();
  });

  it("network out at the create: nothing is saved, the entry backs off, and the next drain creates with the same key", async () => {
    const db = await freshDb();
    await rememberLocalStart(db, start());
    await enqueue(db, save("p1"), ME, 2000);
    const { api, creates, saves } = server({ create: ["offline"] });
    expect(await drain(db, api, { userId: ME, now: () => 5000 })).toMatchObject({ saved: 0, failed: 0, retryAt: 6000 });
    expect(saves).toEqual([]);
    expect((await outboxEntries(db))[0]).toMatchObject({ state: "pending", attempts: 1, lastError: "network" });
    expect(await drain(db, api, { userId: ME })).toMatchObject({ saved: 1 });
    expect(creates.map((c) => c.clientId)).toEqual([CLIENT, CLIENT]);
    expect(saves.map((s) => s.workoutId)).toEqual(["w-server"]);
    db.close();
  });

  it("network out at the save, after the create: the next drain sends the same session onto the same workout, never creating again", async () => {
    const db = await freshDb();
    await rememberLocalStart(db, start());
    await enqueue(db, save("p1"), ME, 2000);
    const { api, creates, saves } = server({ save: ["offline"] });
    await drain(db, api, { userId: ME });
    expect(await loadLocalStart(db, LOCAL)).toMatchObject({ workoutId: "w-server" });
    await drain(db, api, { userId: ME });
    expect(creates).toHaveLength(1);
    expect(saves).toHaveLength(2);
    // The same payload both times: the server's same-id check answers a repeat as the same save, never a conflict.
    expect(saves[1]).toEqual(saves[0]);
    expect(await outboxEntries(db)).toEqual([]);
    db.close();
  });

  it("today already holds the same start, still to finish (409 started_today): the session goes onto that one", async () => {
    const db = await freshDb();
    await rememberLocalStart(db, start());
    await enqueue(db, save("p1"), ME, 2000);
    const { api, saves } = server({ create: ["started_today"] });
    expect(await drain(db, api, { userId: ME })).toMatchObject({ saved: 1 });
    expect(saves.map((s) => s.workoutId)).toEqual(["w-today"]);
    db.close();
  });

  it("the server refuses the workout (422): the session is kept, its entry failed with Retry and Discard; what was saved after it still goes", async () => {
    const db = await freshDb();
    await rememberLocalStart(db, start());
    await enqueue(db, save("p1"), ME, 2000);
    await enqueue(db, save("p2", { workoutId: "w-other", buildId: "b1" }), ME, 3000);
    const { api, saves } = server({ create: [422] });
    expect(await drain(db, api, { userId: ME })).toMatchObject({ saved: 1, failed: 1 });
    expect(saves.map((s) => s.id)).toEqual(["p2"]);
    const [left] = await outboxEntries(db);
    expect(left).toMatchObject({ performedId: "p1", state: "failed", lastError: "http_422 played_offline_refused" });
    expect(entryActions(left!)).toEqual(["retry", "discard"]);
    // Kept as played: the outbox holds the session, the device the start it needs.
    expect(left!.payload.workoutId).toBe(LOCAL);
    expect(await loadLocalStart(db, LOCAL)).toBeDefined();
    // Retry tries the create again.
    await retryEntry(db, left!.key);
    expect(await drain(db, api, { userId: ME })).toMatchObject({ saved: 1 });
    expect(saves.map((s) => s.id)).toEqual(["p2", "p1"]);
    db.close();
  });

  it("a create the server keeps failing (5xx) backs off as a save's does", async () => {
    const db = await freshDb();
    await rememberLocalStart(db, start());
    await enqueue(db, save("p1"), ME, 2000);
    const { api, saves } = server({ create: [500] });
    expect(await drain(db, api, { userId: ME, now: () => 5000 })).toMatchObject({ saved: 0, failed: 0, retryAt: 6000 });
    expect(saves).toEqual([]);
    expect((await outboxEntries(db))[0]).toMatchObject({ state: "pending", lastError: "http_500" });
    db.close();
  });

  it("its start gone from the device: the entry is failed (nothing can record it), never sent as it is", async () => {
    const db = await freshDb();
    await enqueue(db, save("p1"), ME, 2000);
    const { api, creates, saves } = server();
    expect(await drain(db, api, { userId: ME })).toMatchObject({ failed: 1 });
    expect(creates).toEqual([]);
    expect(saves).toEqual([]);
    expect((await outboxEntries(db))[0]).toMatchObject({ state: "failed", lastError: "local_start_missing" });
    db.close();
  });

  it("a sender that cannot create (no createWorkout) leaves it waiting, never sends the provisional id", async () => {
    const db = await freshDb();
    await rememberLocalStart(db, start());
    await enqueue(db, save("p1"), ME, 2000);
    const { api, saves } = server();
    expect(await drain(db, { savePerformed: api.savePerformed }, { userId: ME, now: () => 5000 })).toMatchObject({ saved: 0, failed: 0 });
    expect(saves).toEqual([]);
    expect((await outboxEntries(db))[0]).toMatchObject({ state: "pending" });
    db.close();
  });

  it("Discard of its entry forgets the start; deleting the account's data forgets its starts, never another account's", async () => {
    const db = await freshDb();
    await rememberLocalStart(db, start());
    const entry = await enqueue(db, save("p1"), ME, 2000);
    await discardEntry(db, entry.key);
    expect(await loadLocalStart(db, LOCAL)).toBeUndefined();

    await rememberLocalStart(db, start());
    await rememberLocalStart(db, start({ localId: "local:theirs", clientId: "theirs", userId: "u2" }));
    await discardAccountEntries(db, ME);
    expect((await localStarts(db, ME)).map((s) => s.localId)).toEqual([]);
    expect((await localStarts(db, "u2")).map((s) => s.localId)).toEqual(["local:theirs"]);
    db.close();
  });
});

describe("Save and Discard of a session played under a provisional id", () => {
  const stored = async (db: OfflineDb) => {
    await saveBuild(db, { workoutId: LOCAL, build: { buildId: LOCAL }, view: {} } as unknown as SessionDto);
    await saveExtras(db, { workoutId: LOCAL, title: "Desk reset", profiles: [], userId: ME, savedAt: 1000 });
  };

  it("Save records the workout and the session through the outbox, offline or on", async () => {
    const db = await freshDb();
    await rememberLocalStart(db, start());
    await stored(db);
    const { api, saves } = server();
    expect(await saveSession(db, performed("p1"), api, ME, { waitMs: 2000 })).toBe("saved");
    expect(saves.map((s) => s.workoutId)).toEqual(["w-server"]);
    expect(await loadBuild(db, LOCAL)).toBeUndefined();
    db.close();
  });

  it("Discard keeps nothing — the start, its build — and sends nothing (the server never knew it)", async () => {
    const db = await freshDb();
    await rememberLocalStart(db, start());
    await stored(db);
    const unstart = vi.fn(async () => ({}));
    await discardSession(db, LOCAL, { userId: ME, api: { unstartSession: unstart }, waitMs: 50 });
    expect(unstart).not.toHaveBeenCalled();
    expect(await queuedUnstarts(db, ME)).toEqual([]);
    expect(await loadLocalStart(db, LOCAL)).toBeUndefined();
    expect(await loadBuild(db, LOCAL)).toBeUndefined();
    expect(await loadExtras(db, LOCAL)).toBeUndefined();
    db.close();
  });
});

describe("two starts of one kind on one day are one session (Continue)", () => {
  it("a start not yet saved is offered again; one saved, another day's, another kind's or another account's is not", async () => {
    const db = await freshDb();
    await rememberLocalStart(db, start());
    expect((await unfinishedLocalStart(db, ME, "quick_start:desk_reset", DAY))?.localId).toBe(LOCAL);
    expect(await unfinishedLocalStart(db, ME, "quick_start:hip_opener", DAY)).toBeUndefined();
    expect(await unfinishedLocalStart(db, ME, "quick_start:desk_reset", "2026-10-08")).toBeUndefined();
    expect(await unfinishedLocalStart(db, "u2", "quick_start:desk_reset", DAY)).toBeUndefined();
    await enqueue(db, save("p1"), ME, 2000);
    expect(await unfinishedLocalStart(db, ME, "quick_start:desk_reset", DAY)).toBeUndefined();
    await forgetLocalStart(db, LOCAL);
    db.close();
  });
});

/** A save as the player makes it (the wire, parsed). */
function performed(id: string): PerformedSessionWire {
  return save(id) as PerformedSessionWire;
}
