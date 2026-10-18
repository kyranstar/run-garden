/**
 * THE BODY CHECK ADAPTS AN ENGINE SESSION (the new shape, 2026-10-17; design §4): a programme's session is rebuilt one
 * mode down (build → consistent → recovery) through the build path itself — the day's choice of mode, as the session
 * sheet makes it — and Undo builds it again with the choices the day had. A Bit heavy eases it; Sore eases it only when
 * the session works a sore area; Fresh changes nothing (and puts back an ease of the day). No AI.
 *
 * Synthetic data only; a fixed Friday (`today`, `now` passed in).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { todayInZone, type SessionMode, type UserPreferences } from "@rg/domain";
import { EXERCISES, MUSCLE_REGION } from "@rg/exercise-library";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { todayBodyRoutes } from "../src/routes/today-body.js";
import { answerBodyCheck, BODY_REGIONS, BodyCheckClosedError, readBodyCheck, undoBodyCheck } from "../src/services/body-check.js";
import { buildSession, loadSession, type SessionResponse } from "../src/services/session-build.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { DAY, makeEnv, NOON, seedProgram, seedSlot, seedTmj } from "./watch-push-fixture.js";

const { plannedWorkouts, sessionBuilds } = schema;

vi.setConfig({ testTimeout: 30_000 });

/** A request's budget: Workers Free's 50 subrequests, 45 as the code pins it (D1 statements and fetches alike). */
const BUDGET = 45;

let db: Db;
let userId: string;
let prefs: UserPreferences;
let programId: string;
let statements: string[];

beforeEach(async () => {
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (sql) => statements.push(sql) });
  ({ userId, prefs } = await makeTestUser(db));
  programId = await seedProgram(db, userId);
});

const ctx = () => ({ today: DAY, now: NOON, prefs });
const session = (id: string) => loadSession(db, userId, id, DAY);
const ORDER: SessionMode[] = ["recovery", "consistent", "build"];
const below = (m: SessionMode): SessionMode => ORDER[ORDER.indexOf(m) - 1]!;

/** The regions a build works: each move's regions and its primary muscles' regions. */
function worked(s: SessionResponse): Set<string> {
  const out = new Set<string>();
  for (const item of s.build!.items) {
    const rec = EXERCISES.find((e) => e.id === item.exerciseId)!;
    for (const r of rec.regions) out.add(r);
    for (const m of rec.muscles.primary) out.add(MUSCLE_REGION[m]);
  }
  return out;
}

describe("an engine session, A bit heavy", () => {
  it("is rebuilt one mode down through the build path — the day's other choices kept — and says to what", async () => {
    const id = await seedSlot(db, userId, programId, DAY);
    const before = await buildSession(db, userId, id, { overrides: { mode: "build", minutes: 40 } }, ctx());
    const out = await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    expect(out.view.change).toEqual({ kind: "eased", to: { mode: "consistent" } });
    const after = await session(id);
    expect(after.build).toMatchObject({ mode: "consistent", minutes: 40, params: { overrides: { mode: "consistent", minutes: 40 } } });
    expect(after.build!.version).toBe(before.build!.version + 1);
    // Re-read, the card says the same.
    expect((await readBodyCheck(db, userId, id, ctx())).change).toEqual({ kind: "eased", to: { mode: "consistent" } });
  });

  it("says heavy LEGS only of a session that works the legs: an upper-body session is eased for a heavy body", async () => {
    const id = await seedSlot(db, userId, programId, DAY);
    const before = await buildSession(db, userId, id, { overrides: { mode: "build", theme: "upperBackNeck", minutes: 10 } }, ctx());
    // The engine's upper back and neck in ten minutes works no leg.
    expect(["hips", "glutes", "quads", "hamstrings", "calves", "ankles", "feet"].filter((r) => worked(before).has(r))).toEqual([]);
    const out = await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    expect(out.view.change).toEqual({ kind: "eased", to: { mode: "consistent" }, legs: false });
    // Sore shoulders, which it works: the reason is the shoulders, and the legs are no part of it.
    const sore = await answerBodyCheck(db, userId, id, { feel: "sore", areas: ["shoulders"] }, ctx());
    expect(sore.view.change).toEqual({ kind: "eased", to: { mode: "consistent" } });
  });

  it("not built yet: the day's session is built, and eased one mode below what the engine proposed by the next request (the client's, at once)", async () => {
    const id = await seedSlot(db, userId, programId, DAY);
    const first = await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    const built = await session(id);
    const proposed = built.view!.proposedMode;
    expect(proposed).not.toBe("recovery");
    // Built as the day's own (two builds don't fit one request): the ease is recorded, and the client asks again.
    expect(built.build!.mode).toBe(proposed);
    expect(first.view).toMatchObject({ pending: true, change: { kind: "eased", to: { mode: below(proposed) } } });
    expect((await readBodyCheck(db, userId, id, ctx())).pending).toBe(true);
    const second = await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    expect(second.view.pending).toBeUndefined();
    expect(second.view.change).toEqual({ kind: "eased", to: { mode: below(proposed) } });
    expect((await session(id)).build!.mode).toBe(below(proposed));
    // And Undo from there goes back to the engine's own proposal.
    await undoBodyCheck(db, userId, id, ctx());
    expect((await session(id)).build).toMatchObject({ mode: proposed, params: { overrides: {} } });
  });

  it("an ease recorded and not yet applied is never applied once the answer no longer asks for it", async () => {
    const id = await seedSlot(db, userId, programId, DAY);
    await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    const built = await session(id);
    const fresh = await answerBodyCheck(db, userId, id, { feel: "fresh" }, ctx());
    expect(fresh.view.pending).toBeUndefined();
    expect((await session(id)).build!.buildId).toBe(built.build!.buildId);
    // Nor once it asks only about an area the session leaves alone.
    const other = await seedSlot(db, userId, programId, DAY, "slot-two");
    await answerBodyCheck(db, userId, other, { feel: "heavy" }, ctx());
    const day = await session(other);
    const quietArea = BODY_REGIONS.find((r) => !worked(day).has(r))!;
    const quiet = await answerBodyCheck(db, userId, other, { feel: "sore", areas: [quietArea] }, ctx());
    expect(quiet.view).toMatchObject({ change: { kind: "kept", why: "quiet" } });
    expect(quiet.view.pending).toBeUndefined();
    expect((await session(other)).build!.buildId).toBe(day.build!.buildId);
  });

  it("already in recovery: nothing gentler to go to — kept, nothing rebuilt", async () => {
    const id = await seedSlot(db, userId, programId, DAY);
    const built = await buildSession(db, userId, id, { overrides: { mode: "recovery" } }, ctx());
    const out = await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    expect(out.view.change).toEqual({ kind: "kept", why: "gentlest" });
    expect((await session(id)).build!.buildId).toBe(built.build!.buildId);
  });

  it("a programme whose modes stop above: the gentlest it has is kept", async () => {
    const id = await seedSlot(db, userId, programId, DAY);
    const [p] = await db.select().from(schema.programs).where(eq(schema.programs.id, programId));
    await db.update(schema.programs).set({ config: { ...p!.config, modes: ["build"] } }).where(eq(schema.programs.id, programId));
    const built = await buildSession(db, userId, id, {}, ctx());
    expect(built.build!.mode).toBe("build");
    const out = await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    expect(out.view.change).toEqual({ kind: "kept", why: "gentlest" });
    expect((await session(id)).build!.buildId).toBe(built.build!.buildId);
  });

  it("the same answer again changes nothing more (one mode down, once)", async () => {
    const id = await seedSlot(db, userId, programId, DAY);
    await buildSession(db, userId, id, { overrides: { mode: "build" } }, ctx());
    await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    const eased = await session(id);
    statements = [];
    await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    expect(statements.filter(isWrite)).toEqual([]);
    expect((await session(id)).build!.buildId).toBe(eased.build!.buildId);
  });
});

describe("an ease cut off", () => {
  it("a request cut off after the eased build, before the record says so: the next answer finishes it — one mode down, never two", async () => {
    const id = await seedSlot(db, userId, programId, DAY);
    await buildSession(db, userId, id, { overrides: { mode: "build" } }, ctx());
    // The record's second write (the ease marked done) fails: the build is made, the record still says `easing`.
    let records = 0;
    const sqlite = (db as unknown as { $client: { prepare: (s: string) => unknown } }).$client;
    const prepare = sqlite.prepare.bind(sqlite);
    sqlite.prepare = (s: string) => {
      if (/^insert into "audit_events"/i.test(s) && ++records === 2) throw new Error("the request was cut off");
      return prepare(s);
    };
    await expect(answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx())).rejects.toThrow("cut off");
    sqlite.prepare = prepare;
    expect((await session(id)).build!.mode).toBe("consistent");
    expect((await readBodyCheck(db, userId, id, ctx())).pending).toBe(true);
    const again = await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    expect(again.view).toMatchObject({ change: { kind: "eased", to: { mode: "consistent" } } });
    expect(again.view.pending).toBeUndefined();
    expect((await session(id)).build!.mode).toBe("consistent");
    // And Undo goes back to the day's own choice, not to the eased one.
    await undoBodyCheck(db, userId, id, ctx());
    expect((await session(id)).build!.mode).toBe("build");
  });
});

describe("an engine session, Sore somewhere", () => {
  it("A bit heavy, then Sore in an area the session works: the same ease stands, one mode down", async () => {
    const id = await seedSlot(db, userId, programId, DAY);
    const built = await buildSession(db, userId, id, { overrides: { mode: "build" } }, ctx());
    const workedArea = BODY_REGIONS.find((r) => worked(built).has(r))!;
    await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    const sore = await answerBodyCheck(db, userId, id, { feel: "sore", areas: [workedArea] }, ctx());
    expect(sore.view.change).toEqual({ kind: "eased", to: { mode: "consistent" } });
    expect((await session(id)).build!.mode).toBe("consistent");
  });

  it("eases it when the session works a sore area, and only notes it when it doesn't", async () => {
    const id = await seedSlot(db, userId, programId, DAY);
    const built = await buildSession(db, userId, id, { overrides: { mode: "build" } }, ctx());
    const works = worked(built);
    const workedArea = BODY_REGIONS.find((r) => works.has(r));
    const quietArea = BODY_REGIONS.find((r) => !works.has(r));
    expect(workedArea && quietArea).toBeTruthy();

    const quiet = await answerBodyCheck(db, userId, id, { feel: "sore", areas: [quietArea!] }, ctx());
    expect(quiet.view.change).toEqual({ kind: "kept", why: "quiet" });
    expect((await session(id)).build!.buildId).toBe(built.build!.buildId);

    const sore = await answerBodyCheck(db, userId, id, { feel: "sore", areas: [quietArea!, workedArea!] }, ctx());
    expect(sore.view.change).toEqual({ kind: "eased", to: { mode: "consistent" } });
    expect((await session(id)).build!.mode).toBe("consistent");
  });
});

describe("putting it back", () => {
  it("Undo rebuilds it with the choices the day had — the same session as before — and the answer stays", async () => {
    const id = await seedSlot(db, userId, programId, DAY);
    const before = await buildSession(db, userId, id, { overrides: { mode: "build", minutes: 40 } }, ctx());
    await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    const out = await undoBodyCheck(db, userId, id, ctx());
    expect(out.view).toMatchObject({ answer: { feel: "heavy" }, change: { kind: "kept", why: "undone" } });
    const after = await session(id);
    expect(after.build).toMatchObject({ mode: "build", minutes: 40, params: { overrides: { mode: "build", minutes: 40 } } });
    // The engine is a function of the day's inputs: the same plan as before the ease.
    expect(after.build!.items).toEqual(before.build!.items);
    // Undo again: nothing to undo, nothing written.
    statements = [];
    expect((await undoBodyCheck(db, userId, id, ctx())).view.change).toEqual({ kind: "kept", why: "undone" });
    expect(statements.filter(isWrite)).toEqual([]);
  });

  it("an ease made with no mode chosen goes back to the engine's own proposal", async () => {
    const id = await seedSlot(db, userId, programId, DAY);
    const before = await buildSession(db, userId, id, {}, ctx());
    await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    await undoBodyCheck(db, userId, id, ctx());
    const after = await session(id);
    expect(after.build!.params.overrides).toEqual({});
    expect(after.build!.mode).toBe(before.build!.mode);
  });

  it("Fresh after A bit heavy puts the session back; A bit heavy again eases it again", async () => {
    const id = await seedSlot(db, userId, programId, DAY);
    await buildSession(db, userId, id, { overrides: { mode: "build" } }, ctx());
    await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    const fresh = await answerBodyCheck(db, userId, id, { feel: "fresh" }, ctx());
    expect(fresh.view.change).toBeNull();
    expect((await session(id)).build!.mode).toBe("build");
    const again = await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    expect(again.view.change).toEqual({ kind: "eased", to: { mode: "consistent" } });
    expect((await session(id)).build!.mode).toBe("consistent");
  });

  it("a mode the athlete chose after the ease stands: Undo leaves the session as they set it", async () => {
    const id = await seedSlot(db, userId, programId, DAY);
    await buildSession(db, userId, id, { overrides: { mode: "build" } }, ctx());
    await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    await buildSession(db, userId, id, { overrides: { mode: "recovery" } }, ctx());
    await undoBodyCheck(db, userId, id, ctx());
    expect((await session(id)).build!.mode).toBe("recovery");
  });

  it("once the session has started, neither the answer nor Undo can change it", async () => {
    const id = await seedSlot(db, userId, programId, DAY);
    await buildSession(db, userId, id, { overrides: { mode: "build" } }, ctx());
    await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    await db.update(plannedWorkouts).set({ contentState: "started" }).where(eq(plannedWorkouts.id, id));
    await expect(undoBodyCheck(db, userId, id, ctx())).rejects.toBeInstanceOf(BodyCheckClosedError);
    await expect(answerBodyCheck(db, userId, id, { feel: "fresh" }, ctx())).rejects.toBeInstanceOf(BodyCheckClosedError);
    // A build locked to the watch closes it too.
    const other = await seedSlot(db, userId, programId, DAY, "slot-two");
    const built = await buildSession(db, userId, other, {}, ctx());
    await db.update(sessionBuilds).set({ lockedAt: NOON }).where(eq(sessionBuilds.id, built.build!.buildId));
    await expect(answerBodyCheck(db, userId, other, { feel: "heavy" }, ctx())).rejects.toBeInstanceOf(BodyCheckClosedError);
    expect((await readBodyCheck(db, userId, other, ctx())).open).toBe(false);
  });
});

describe("what it costs", () => {
  /** Every statement each request makes, sign-in and preferences included, with a condition switched on (its checks). */
  it("each request fits Workers Free's budget: the read, the answer that builds the day's session, the one that eases it, Undo", async () => {
    await seedTmj(db, userId);
    const today = todayInZone(prefs.timezone);
    const id = await seedSlot(db, userId, programId, today);
    const cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
    const call = async (method: string, path: string, body?: unknown) => {
      statements = [];
      const res = await mountRoutes(db, "/api/today", todayBodyRoutes).request(
        path,
        { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
        makeEnv(),
      );
      expect(res.status).toBe(200);
      return { json: (await res.json()) as { pending?: true }, cost: statements.length };
    };
    const read = await call("GET", `/api/today/body?workout=${id}`);
    const built = await call("POST", "/api/today/body", { workoutId: id, feel: "heavy" });
    expect(built.json.pending).toBe(true);
    const eased = await call("POST", "/api/today/body", { workoutId: id, feel: "heavy" });
    expect(eased.json.pending).toBeUndefined();
    const undo = await call("POST", "/api/today/body/undo", { workoutId: id });
    const costs = { read: read.cost, built: built.cost, eased: eased.cost, undo: undo.cost };
    // Measured 2026-10-17: printed for the report; each bound is the request budget.
    console.log("body check (engine) statements", costs);
    expect(costs.read).toBeLessThanOrEqual(3);
    for (const cost of [costs.built, costs.eased, costs.undo]) expect(cost).toBeLessThanOrEqual(BUDGET);
  });
});
