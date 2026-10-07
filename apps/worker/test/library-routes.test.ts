/**
 * The exercise library: browse, detail and preferences (Phase 2 spec §2c "Library API"; plan Task 1, Review Focus 4).
 *
 * Route tests on a D1-strict test database. The build at the end runs the service with fixed dates (nothing here can
 * go stale); the routes read no clock that matters to what they assert.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { adaptiveConfigSchema, addDays, newId, nowInstant } from "@rg/domain";
import { EXERCISES, hasEquipment, TMJ } from "@rg/exercise-library";
import type { Db } from "../src/services/db.js";
import type { Env } from "../src/env.js";
import { libraryRoutes } from "../src/routes/library.js";
import { setExercisePrefs } from "../src/services/library-view.js";
import { RestoreInProgressError } from "../src/services/programs.js";
import { buildSession } from "../src/services/session-build.js";
import { saveProgramState } from "../src/services/engine-inputs.js";
import { slotId } from "../src/services/program-slots.js";
import { savePreferences } from "../src/services/calendar-sync.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import type { UserPreferences } from "@rg/domain";

const {
  accountState,
  exercisePrefs,
  exerciseProvenance,
  locations,
  performedSessions,
  performedSets,
  plannedWorkouts,
  programBlocks,
  programs,
  userConditions,
} = schema;

const TODAY = "2026-10-07";
const NOW = "2026-10-07T19:00:00.000Z";

let db: Db;
let statements: string[];
let userId: string;
let prefs: UserPreferences;
let cookie: string;

beforeEach(async () => {
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (sql) => statements.push(sql) });
  ({ userId, prefs } = await makeTestUser(db));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
});

function makeEnv(): Env {
  return { DB: {} as Env["DB"], ASSETS: {} as Env["ASSETS"], APP_URL: "https://app.test", SESSION_SECRET: "s" } as Env;
}

const call = (method: string, path: string, body?: unknown, as: string = cookie) =>
  mountRoutes(db, "/api/library", libraryRoutes).request(
    path,
    { method, headers: { Cookie: as, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
    makeEnv(),
  );

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

interface Row {
  id: string;
  name: string;
  family: string;
  patterns: string[];
  regions: string[];
  roles: string[];
  equipment: { all: string[]; oneOf: string[] };
  difficulty: number;
  safety: Record<string, "safe" | "care" | "never">;
  rating: 1 | -1 | null;
  excluded: boolean;
  pinned: boolean;
  saved: boolean;
  unlocksWith: { all: string[]; oneOf: string[] } | null;
}
interface ListBody {
  total: number;
  items: Row[];
  place: { id: string; name: string };
  profiles: Array<{ profileId: string; label: string }>;
  wishlist: Array<{ equipmentId: string; label: string; unlocks: number }>;
}

const list = async (query = ""): Promise<ListBody> => {
  const res = await call("GET", `/api/library${query}`);
  expect(res.status).toBe(200);
  return json<ListBody>(res);
};

async function activateTmj(owner: string = userId): Promise<void> {
  await db.insert(userConditions).values({ id: `${owner}:tmj`, userId: owner, profileId: "tmj", active: true, since: "2026-09-01", settings: {} });
}

async function addPlace(name: string, equipment: string[], isDefault = false, owner: string = userId): Promise<string> {
  const id = newId();
  await db.insert(locations).values({ id, userId: owner, name, equipment, implements: {}, isDefault, createdAt: NOW, updatedAt: NOW });
  return id;
}

async function prefRow(exerciseId: string, owner: string = userId) {
  const [r] = await db.select().from(exercisePrefs).where(and(eq(exercisePrefs.userId, owner), eq(exercisePrefs.exerciseId, exerciseId)));
  return r;
}

describe("GET /api/library", () => {
  it("lists every move, slim: no how-to text and no provider internals", async () => {
    const body = await list();
    expect(body.total).toBe(EXERCISES.length);
    expect(body.items.map((r) => r.id).sort()).toEqual(EXERCISES.map((e) => e.id).sort());
    const goblet = body.items.find((r) => r.id === "gobletSquat")!;
    expect(Object.keys(goblet).sort()).toEqual(
      ["difficulty", "equipment", "excluded", "family", "id", "name", "patterns", "pinned", "rating", "regions", "roles", "safety", "saved", "unlocksWith"].sort(),
    );
    expect(goblet).toMatchObject({ name: "Goblet squat", rating: null, excluded: false, pinned: false, saved: false, safety: {} });
    expect(JSON.stringify(body)).not.toMatch(/providers|originId|"text"/);
    // In name order, so the same library always reads the same way.
    const names = body.items.map((r) => r.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("carries this user's ratings, set-asides, pins and saves — never another user's", async () => {
    const other = (await makeTestUser(db)).userId;
    await db.insert(exercisePrefs).values([
      { id: `${userId}:gobletSquat`, userId, exerciseId: "gobletSquat", rating: 1, excluded: false, pinned: true, introducedOn: null, updatedAt: NOW },
      { id: `${userId}:chinTuck`, userId, exerciseId: "chinTuck", rating: -1, excluded: true, pinned: false, introducedOn: null, updatedAt: NOW },
      { id: `${other}:deadlift`, userId: other, exerciseId: "deadlift", rating: 1, excluded: true, pinned: true, introducedOn: null, updatedAt: NOW },
    ]);
    await db.insert(exerciseProvenance).values([
      { id: newId(), userId, exerciseId: "tempoSquat", sourceType: "save", url: "synthetic://save/1", creator: null, sourceKey: "k1", createdAt: NOW },
      { id: newId(), userId: other, exerciseId: "rdl", sourceType: "save", url: "synthetic://save/2", creator: null, sourceKey: "k2", createdAt: NOW },
    ]);
    const byId = new Map((await list()).items.map((r) => [r.id, r]));
    expect(byId.get("gobletSquat")).toMatchObject({ rating: 1, excluded: false, pinned: true, saved: false });
    expect(byId.get("chinTuck")).toMatchObject({ rating: -1, excluded: true, pinned: false });
    expect(byId.get("tempoSquat")).toMatchObject({ saved: true });
    expect(byId.get("deadlift")).toMatchObject({ rating: null, excluded: false, pinned: false });
    expect(byId.get("rdl")).toMatchObject({ saved: false });
    // The list says nothing of where a save came from.
    expect(JSON.stringify(await list())).not.toContain("synthetic://");
  });

  it("filters by text, movement, body area, role and gear, and combines them", async () => {
    expect((await list("?q=SQUAT")).items.map((r) => r.id)).toEqual(
      expect.arrayContaining(["gobletSquat", "boxSquat", "tempoSquat", "bulgarianSplitSquat"]),
    );
    expect((await list("?q=squat")).items.every((r) => /squat/i.test(`${r.name} ${r.id} ${r.family}`))).toBe(true);
    expect((await list("?pattern=push-v")).items.map((r) => r.id)).toEqual(["halfKneelingPress"]);
    const jaw = (await list("?region=jaw")).items;
    expect(jaw.length).toBeGreaterThan(0);
    expect(jaw.every((r) => r.regions.includes("jaw"))).toBe(true);
    expect((await list("?role=jaw-care")).items.every((r) => r.roles.includes("jaw-care"))).toBe(true);
    expect((await list("?equipment=band")).items.map((r) => r.id).sort()).toEqual(
      EXERCISES.filter((e) => e.equipment.all.includes("band") || e.equipment.oneOf.includes("band")).map((e) => e.id).sort(),
    );
    const both = (await list("?pattern=squat&equipment=kettlebell")).items;
    expect(both.length).toBeGreaterThan(0);
    expect(both.every((r) => r.patterns.includes("squat") && [...r.equipment.all, ...r.equipment.oneOf].includes("kettlebell"))).toBe(true);
  });

  it("refuses a filter outside the vocabulary (422) and an unknown place (422)", async () => {
    for (const q of ["?pattern=juggling", "?region=elbow", "?role=hero", "?equipment=trampoline", "?safe=maybe", "?location=nowhere"]) {
      const res = await call("GET", `/api/library${q}`);
      expect(res.status, q).toBe(422);
      expect((await json<{ error: string }>(res)).error).toBe("invalid_query");
    }
  });

  it("filters to what a place's gear allows; the library's Home before any place is set up", async () => {
    const homeIds = (await list("?location=home")).items.map((r) => r.id).sort();
    expect(homeIds).toEqual(
      EXERCISES.filter((e) => hasEquipment(e, ["mat", "yoga-block", "kettlebell", "bench", "chair", "wall", "towel"])).map((e) => e.id).sort(),
    );
    const mat = await addPlace("Floor", ["mat"]);
    const matIds = (await list(`?location=${mat}`)).items.map((r) => r.id);
    expect(matIds.length).toBeGreaterThan(0);
    expect(matIds.every((id) => hasEquipment(EXERCISES.find((e) => e.id === id)!, ["mat"]))).toBe(true);
    // Another user's place is not one of this user's.
    const theirs = await addPlace("Theirs", ["mat"], true, (await makeTestUser(db)).userId);
    expect((await call("GET", `/api/library?location=${theirs}`)).status).toBe(422);
  });

  it("rates each move for every switched-on profile; safe= keeps the moves safe on a flare day for all of them", async () => {
    const none = await list("?safe=1");
    expect(none.items.length).toBe(EXERCISES.length);
    expect(none.profiles).toEqual([]);

    await activateTmj();
    const body = await list();
    expect(body.profiles).toEqual([{ profileId: "tmj", label: TMJ.label }]);
    const byId = new Map(body.items.map((r) => [r.id, r]));
    expect(byId.get("chinTuck")!.safety).toEqual({ tmj: "safe" });
    // Overhead pressing: allowed (build, calm check), never on a flare day.
    expect(byId.get("halfKneelingPress")!.safety).toEqual({ tmj: "care" });
    const safe = (await list("?safe=1")).items.map((r) => r.id);
    expect(safe).not.toContain("halfKneelingPress");
    expect(safe).toContain("chinTuck");
    expect(safe.sort()).toEqual(EXERCISES.filter((e) => TMJ.flareSafe(e.conditions.tmj!)).map((e) => e.id).sort());

    // A profile switched off rates nothing.
    await db.update(userConditions).set({ active: false }).where(eq(userConditions.userId, userId));
    expect((await list()).items.find((r) => r.id === "chinTuck")!.safety).toEqual({});
  });

  it("says what gear the default place lacks for each move, and what each wishlist item would unlock", async () => {
    await addPlace("Gym", ["mat", "kettlebell", "dumbbells", "band"]);
    await addPlace("Floor", ["mat"], true);
    await savePreferences(db, userId, { ...prefs, equipmentWishlist: ["band", "massage-ball", "not-gear"] });
    const body = await list();
    expect(body.place).toMatchObject({ name: "Floor" });
    const byId = new Map(body.items.map((r) => [r.id, r]));
    expect(byId.get("chinTuck")!.unlocksWith).toBeNull();
    expect(byId.get("bandRow")!.unlocksWith).toEqual({ all: ["band"], oneOf: [] });
    expect(byId.get("gobletSquat")!.unlocksWith).toEqual({ all: [], oneOf: ["kettlebell", "dumbbells"] });
    const unlocks = (item: string) =>
      EXERCISES.filter((e) => !hasEquipment(e, ["mat"]) && hasEquipment(e, ["mat", item])).length;
    expect(body.wishlist).toEqual([
      { equipmentId: "band", label: "Resistance band", unlocks: unlocks("band") },
      { equipmentId: "massage-ball", label: "Massage ball", unlocks: unlocks("massage-ball") },
    ]);
    expect(body.wishlist[0]!.unlocks).toBeGreaterThan(0);

    // A move set aside, or one a switched-on profile never allows, is not something the gear "unlocks".
    await db.insert(exercisePrefs).values({ id: `${userId}:bandRow`, userId, exerciseId: "bandRow", rating: null, excluded: true, pinned: false, introducedOn: null, updatedAt: NOW });
    expect((await list()).wishlist[0]!.unlocks).toBe(unlocks("band") - 1);
  });

  it("is a read: no statement writes, and every statement stays under D1's bound-variable cap", async () => {
    await activateTmj();
    statements.length = 0;
    await list("?q=row&safe=1");
    expect(statements.filter(isWrite)).toEqual([]);
  });

  it("401 without a session", async () => {
    expect((await call("GET", "/api/library", undefined, "")).status).toBe(401);
  });
});

describe("GET /api/library/:id", () => {
  interface Item {
    id: string;
    name: string;
    dose: { type: string; range: [number, number] };
    text: Record<string, unknown>;
    conditionNotes: Array<{ profileId: string; label: string; note: string }>;
    safety: Record<string, string>;
    easier: Array<{ id: string; name: string }>;
    harder: Array<{ id: string; name: string }>;
    prefs: { rating: 1 | -1 | null; excluded: boolean; pinned: boolean; introducedOn: string | null };
    saved: boolean;
    provenance: Array<{ sourceType: string; url: string | null; creator: string | null }>;
    history: {
      last: Array<{ date: string; sessionId: string; implement: string | null; perSide: boolean; sets: Array<{ w: { v: number; u: string } | null; reps: number | null; secs: number | null }> }>;
      best: { w: { v: number; u: string } | null; reps: number | null; secs: number | null } | null;
    };
  }
  const item = async (id: string): Promise<Item> => {
    const res = await call("GET", `/api/library/${id}`);
    expect(res.status).toBe(200);
    return json<Item>(res);
  };

  it("returns the whole record with its how-to, linked moves by name, and no provider internals", async () => {
    const tempo = EXERCISES.find((e) => e.id === "tempoSquat")!;
    const body = await item("tempoSquat");
    expect(body).toMatchObject({ id: "tempoSquat", name: tempo.name, dose: tempo.dose, saved: false, provenance: [] });
    expect(body.text).toMatchObject({ summary: tempo.text.summary, steps: tempo.text.steps, setup: tempo.text.setup });
    expect(body.text).not.toHaveProperty("conditions");
    expect(body.easier).toEqual([{ id: "boxSquat", name: EXERCISES.find((e) => e.id === "boxSquat")!.name }]);
    expect(body.harder).toEqual([{ id: "bwSplitSquat", name: EXERCISES.find((e) => e.id === "bwSplitSquat")!.name }]);
    expect(body.prefs).toEqual({ exerciseId: "tempoSquat", rating: null, excluded: false, pinned: false, introducedOn: null });
    expect(body.history).toEqual({ last: [], best: null });
    expect(body).not.toHaveProperty("providers");
    expect(body.conditionNotes).toEqual([]);
  });

  it("shows condition notes only for switched-on profiles, labelled by the profile", async () => {
    await activateTmj();
    const body = await item("gobletSquat");
    const goblet = EXERCISES.find((e) => e.id === "gobletSquat")!;
    expect(body.conditionNotes).toEqual([{ profileId: "tmj", label: TMJ.label, note: goblet.text.conditions.tmj }]);
    expect(body.safety).toEqual({ tmj: TMJ.flareSafe(goblet.conditions.tmj!) ? "safe" : "care" });
  });

  it("links where a saved move came from — this user's provenance only", async () => {
    await db.insert(exerciseProvenance).values([
      { id: newId(), userId, exerciseId: "gobletSquat", sourceType: "save", url: "synthetic://save/1", creator: "synthetic-creator", sourceKey: "k1", createdAt: NOW },
      { id: newId(), userId: (await makeTestUser(db)).userId, exerciseId: "gobletSquat", sourceType: "save", url: "synthetic://save/9", creator: null, sourceKey: "k9", createdAt: NOW },
    ]);
    const body = await item("gobletSquat");
    expect(body.saved).toBe(true);
    expect(body.provenance).toEqual([{ sourceType: "save", url: "synthetic://save/1", creator: "synthetic-creator" }]);
  });

  it("gives the last five entries, newest first, weights as typed, and the best set", async () => {
    // Seven sessions of goblet squats (one still being written, one of another user's), plus a ladder that never
    // counts for a best.
    const seed = async (date: string, sets: Array<{ v: number; u: "lb" | "kg"; reps: number }>, o: { owner?: string; hash?: string; format?: string } = {}) => {
      const sid = newId();
      await db.insert(performedSessions).values({
        id: sid, userId: o.owner ?? userId, workoutId: null, activityId: null, buildId: null, source: "import", sourceRef: sid,
        localDate: date, startedAt: `${date}T18:00:00Z`, endedAt: null, seconds: 1200, plannedSeconds: null, minutes: 20, mode: "build",
        theme: null, locationId: null, blockRef: null, blockNumber: null, completed: true, stepsTotal: null, stepsDone: null,
        movesDone: [], note: null, newMove: null, payloadHash: o.hash ?? "h", createdAt: NOW, updatedAt: NOW,
      });
      await db.insert(performedSets).values(
        sets.map((s, i) => ({
          id: newId(), performedSessionId: sid, entryIndex: 0, exerciseId: "gobletSquat", implement: "kettlebell", format: o.format ?? "straight",
          perSide: false, setIndex: i, side: null, reps: s.reps, seconds: null, loadValue: s.v, loadUnit: s.u,
          loadKg: s.u === "kg" ? s.v : s.v * 0.45359237, done: true, flags: [],
        })),
      );
      return sid;
    };
    await seed("2026-09-01", [{ v: 20, u: "lb", reps: 8 }]);
    await seed("2026-09-03", [{ v: 12, u: "kg", reps: 6 }, { v: 12, u: "kg", reps: 8 }]);
    await seed("2026-09-05", [{ v: 25, u: "lb", reps: 8 }]);
    await seed("2026-09-07", [{ v: 25, u: "lb", reps: 7 }]);
    await seed("2026-09-09", [{ v: 25, u: "lb", reps: 6 }]);
    await seed("2026-09-11", [{ v: 40, u: "lb", reps: 2 }], { format: "ladder" });
    await seed("2026-09-12", [{ v: 99, u: "lb", reps: 9 }], { hash: "pending" });
    await seed("2026-09-13", [{ v: 99, u: "lb", reps: 9 }], { owner: (await makeTestUser(db)).userId });
    const body = await item("gobletSquat");
    expect(body.history.last.map((e) => e.date)).toEqual(["2026-09-11", "2026-09-09", "2026-09-07", "2026-09-05", "2026-09-03"]);
    expect(body.history.last[4]!.sets).toEqual([
      { w: { v: 12, u: "kg" }, reps: 6, secs: null, side: null },
      { w: { v: 12, u: "kg" }, reps: 8, secs: null, side: null },
    ]);
    // 25 lb (11.34 kg) is lighter than 12 kg: the best is 12 kg × 8; the ladder's 40 lb never counts.
    expect(body.history.best).toEqual({ w: { v: 12, u: "kg" }, reps: 8, secs: null });
  });

  it("404 for a move the library does not have", async () => {
    const res = await call("GET", "/api/library/noSuchMove");
    expect(res.status).toBe(404);
    expect((await json<{ error: string }>(res)).error).toBe("not_found");
  });
});

describe("PUT /api/library/:id/prefs", () => {
  const put = (id: string, body: unknown) => call("PUT", `/api/library/${id}/prefs`, body);

  it("rates, sets aside and pins, changing only what is sent; the row is the one the review save writes", async () => {
    let res = await put("gobletSquat", { rating: 1 });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ prefs: { exerciseId: "gobletSquat", rating: 1, excluded: false, pinned: false, introducedOn: null } });
    expect(await prefRow("gobletSquat")).toMatchObject({ id: `${userId}:gobletSquat`, rating: 1, excluded: false, pinned: false });

    res = await put("gobletSquat", { pinned: true });
    expect((await json<{ prefs: object }>(res)).prefs).toMatchObject({ rating: 1, pinned: true, excluded: false });
    res = await put("gobletSquat", { rating: null });
    expect((await json<{ prefs: object }>(res)).prefs).toMatchObject({ rating: null, pinned: true });
    expect(await db.select().from(exercisePrefs)).toHaveLength(1);
  });

  it("each flag is its own, as the review save writes them: \"not for me\" leaves a pin alone (the engine puts it first)", async () => {
    await put("gobletSquat", { pinned: true });
    expect((await json<{ prefs: object }>(await put("gobletSquat", { excluded: true }))).prefs).toMatchObject({ excluded: true, pinned: true });
    expect((await json<{ prefs: object }>(await put("gobletSquat", { excluded: false, pinned: false }))).prefs).toMatchObject({ excluded: false, pinned: false });
  });

  it("keeps what the review save wrote (its rating and the move's first day)", async () => {
    await db.insert(exercisePrefs).values({ id: `${userId}:gobletSquat`, userId, exerciseId: "gobletSquat", rating: -1, excluded: false, pinned: false, introducedOn: "2026-09-01", updatedAt: NOW });
    await put("gobletSquat", { pinned: true });
    expect(await prefRow("gobletSquat")).toMatchObject({ rating: -1, pinned: true, excluded: false, introducedOn: "2026-09-01" });
    expect(await db.select().from(exercisePrefs)).toHaveLength(1);
  });

  it("refuses an invalid body (422) and a move the library does not have (404), writing nothing", async () => {
    for (const body of [{}, { rating: 2 }, { rating: 0 }, { excluded: "yes" }, { pinned: true, extra: 1 }, null]) {
      const res = await put("gobletSquat", body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect((await json<{ error: string }>(res)).error).toBe("invalid_prefs");
    }
    expect((await put("noSuchMove", { rating: 1 })).status).toBe(404);
    expect(await db.select().from(exercisePrefs)).toEqual([]);
  });

  it("423 while a restore is replacing the account", async () => {
    await db.insert(accountState).values({ userId, restoreId: newId(), restoreStartedAt: nowInstant(), updatedAt: nowInstant() });
    expect((await put("gobletSquat", { rating: 1 })).status).toBe(423);
    // The writer checks the marker itself, for a caller that reaches it without the route (ruling B2).
    await expect(setExercisePrefs(db, userId, "gobletSquat", { rating: 1 }, NOW)).rejects.toBeInstanceOf(RestoreInProgressError);
    expect(await db.select().from(exercisePrefs)).toEqual([]);
  });
});

describe("Review Focus 4: setting aside a block's core lift", () => {
  it("the next build resolves the family to another variant, and the block records the rotation with its reason", async () => {
    const programId = newId();
    await db.insert(programs).values({
      id: programId, userId, kind: "adaptive", name: "Mobility", status: "active", disciplines: ["yoga", "strength"],
      startDate: null, endDate: null, raceDate: null, source: null, config: adaptiveConfigSchema.parse({ defaultMinutes: 40 }),
      createdAt: NOW, updatedAt: NOW, archivedAt: null,
    });
    await saveProgramState(
      db,
      programId,
      {
        id: "b1", number: 1, startedAt: addDays(TODAY, -7), weeks: 5,
        core: { squat: "gobletSquat", hinge: "deadlift", row: "supportedRow", press: "floorPress", carry: "suitcaseCarry" },
        rotations: [],
      },
      NOW,
    );
    const workoutId = slotId(programId, TODAY);
    await db.insert(plannedWorkouts).values({
      id: workoutId, userId, planId: programId, sourceWorkoutId: workoutId, title: "Mobility", category: "yoga", sport: "yoga",
      originalPlanDate: TODAY, lastVerifiedCorosDate: "", effectiveDate: TODAY, effectiveTime: "18:00", sourceContentFingerprint: "program",
      calendarBlockDurationSeconds: 2400, fallbackEstimatedDurationSeconds: 2400, corosSyncState: "calendar_only",
      completionState: "scheduled", origin: "program", contentState: "outline", createdAt: NOW, updatedAt: NOW,
    });

    expect((await put("gobletSquat")).status).toBe(200);
    const res = await buildSession(db, userId, workoutId, { overrides: { mode: "build" } }, { today: TODAY, now: NOW, prefs });

    const squat = res.build!.items.find((i) => i.coreFamily === "squat");
    if (squat) expect(squat.exerciseId).not.toBe("gobletSquat");
    expect(res.build!.items.map((i) => i.exerciseId)).not.toContain("gobletSquat");
    expect(res.view!.block!.events).toEqual([expect.stringMatching(/^Goblet squat → .+: not for me\.$/)]);
    const [stored] = await db.select().from(programBlocks).where(eq(programBlocks.programId, programId));
    const intent = stored!.intent as { core: Record<string, string | null>; rotations: unknown[] };
    expect(intent.core.squat).not.toBe("gobletSquat");
    expect(intent.core.squat).toBeTruthy();
    expect(intent.rotations).toEqual([{ family: "squat", from: "gobletSquat", to: intent.core.squat, date: TODAY, why: "not for me" }]);

    async function put(id: string) {
      return call("PUT", `/api/library/${id}/prefs`, { excluded: true });
    }
  });
});
