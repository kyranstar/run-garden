/**
 * MEMORY V2 IN THE MEMORY LIST (Stage 3 Task 10; spec §9; principles §6.7). The list is live for the thread coach too,
 * so everything here is additive and its statements are pinned.
 *
 *  - `GET /api/coach/memory`: `memory` is what it always was (live items only, newest first); `history` adds the items
 *    a newer one superseded — never a rehearsal's, never one the athlete deleted. Still the session and one read.
 *  - `PATCH /api/coach/memory/:id { body?, pinned?, confirm? }`: an edit as before; pin and unpin; `confirm` turns the
 *    coach's inference into the athlete's confirmed item. Pinned items are capped (MEMORY_PIN_CAP): a pin past the cap
 *    is refused in plain words. Only the athlete's own live item — another's, a superseded one, a deleted one or a
 *    rehearsal's is a 404. The session, the restore marker and one write; a refusal reads once more to say why.
 *  - The pinned core still holds every pinned item, and the thread coach's own reads don't change.
 *  - `remember`'s line carries an undo handle (record_answer's design): `POST /api/coach/runs/:id/undo-answer` takes
 *    the item back, puts back what it replaced, and says so on the trail; once.
 *
 * Synthetic data only.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { coachRoutes } from "../src/routes/coach.js";
import { makeCoachRunRoutes } from "../src/routes/coach-runs.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { buildDossier } from "../src/services/coach-context.js";
import { MEMORY_CORE, MEMORY_PIN_CAP, memoryCore } from "../src/services/memory-core.js";
import { createRun, type RunDeps } from "../src/services/coach-runs.js";
import { remember } from "../src/services/design-tools/remember.js";
import { handleRunId } from "../src/services/design-tools/record-answer.js";
import type { ToolContext, ToolOk } from "../src/services/design-tools/types.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const env = {
  DB: {} as unknown as Env["DB"],
  ASSETS: {} as unknown as Env["ASSETS"],
  APP_URL: "https://app.test",
  FIXTURE_MODE: "0",
  AI_DEFAULT_ENABLED: "1",
  SESSION_SECRET: "s",
  TOKEN_ENCRYPTION_KEY: "k",
  ALLOWED_GOOGLE_EMAIL: "runner@example.com",
  GOOGLE_CLIENT_ID: "c",
  GOOGLE_CLIENT_SECRET: "c",
  AI_GATEWAY_API_KEY: "test-key",
} as Env;
const ON = { ...env, COACH_DESIGNER: "1" } as Env;

let db: Db;
let userId: string;
let prefs: UserPreferences;
let cookie: string;
let statements = 0;

const AT = "2026-10-01T09:00:00.000Z";
type Row = typeof schema.coachMemory.$inferInsert;
const row = (id: string, o: Partial<Row> = {}): Row => ({
  id,
  userId,
  kind: "fact",
  body: `Body of ${id}`,
  provenance: { source: "message", at: AT },
  learnedAt: AT,
  active: true,
  ...o,
});

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
  ({ userId, prefs } = await makeTestUser(db));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
});

async function api(method: string, path: string, body?: unknown, cookieOf = cookie) {
  const app = mountRoutes(db, "/api/coach", coachRoutes);
  statements = 0;
  const res = await app.request(
    `/api/coach${path}`,
    { method, headers: { Cookie: cookieOf, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    env,
  );
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any>, cost: statements };
}

/** Rows a few at a time: each binds a dozen values, and D1 takes 100 a statement. */
async function insertRows(rows: Row[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 5) await db.insert(schema.coachMemory).values(rows.slice(i, i + 5));
}

const one = async (id: string) => (await db.select().from(schema.coachMemory).where(eq(schema.coachMemory.id, id)))[0]!;

describe("GET /memory: the live list as before, and the history beside it", () => {
  it("history holds what a newer item superseded — never a rehearsal's or a deleted one — and the read costs what it did", async () => {
    await db.insert(schema.coachMemory).values([
      row("live", { kind: "rule", body: "Evenings now", learnedAt: "2026-10-03T09:00:00.000Z" }),
      row("older", { kind: "rule", body: "Mornings", supersededBy: "mid", learnedAt: "2026-09-01T09:00:00.000Z" }),
      row("mid", { kind: "rule", body: "Lunchtimes", supersededBy: "live", learnedAt: "2026-09-15T09:00:00.000Z" }),
      row("pinned-note", { kind: "note", body: "Away next week", expiresAt: "2031-01-01", pinned: true, confidence: "confirmed" }),
      row("rehearsal-old", { body: "A rehearsal's", supersededBy: "live", provenance: { source: "athlete_words", at: AT, rehearsal: true } }),
      row("deleted-old", { body: "Deleted", supersededBy: "live", active: false }),
      row("expired", { kind: "note", body: "Gone by now", expiresAt: "2001-01-01" }),
    ]);
    const got = await api("GET", "/memory");
    expect(got.status).toBe(200);
    expect(got.body.memory.map((m: { id: string }) => m.id)).toEqual(["live", "pinned-note"]);
    expect(got.body.memory[1]).toMatchObject({ pinned: true, confidence: "confirmed", supersededBy: null });
    expect(got.body.history.map((m: { id: string }) => m.id).sort()).toEqual(["mid", "older"]);
    expect(got.body.history.find((m: { id: string }) => m.id === "mid")).toMatchObject({ body: "Lunchtimes", supersededBy: "live" });
    expect(got.cost).toBe(2);
  });
});

describe("PATCH /memory/:id", () => {
  beforeEach(async () => {
    await db.insert(schema.coachMemory).values([
      row("stated", { confidence: "stated" }),
      row("inferred", { kind: "observation", confidence: "inferred", provenance: { source: "coach_inference", runId: "r1", role: "main", at: AT } as never }),
      row("old", { supersededBy: "stated" }),
      row("gone", { active: false }),
      row("rehearsal", { provenance: { source: "athlete_words", at: AT, rehearsal: true } }),
    ]);
  });

  it("an edit works as it did: the body, at most 300 characters; the answer adds the item", async () => {
    const edited = await api("PATCH", "/memory/stated", { body: "Trains in a garage" });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ ok: true, item: { id: "stated", body: "Trains in a garage" } });
    expect((await one("stated")).body).toBe("Trains in a garage");
    // The session, the restore marker, the write.
    expect(edited.cost).toBe(3);
    expect((await api("PATCH", "/memory/stated", { body: "x".repeat(301) })).status).toBe(400);
    expect((await api("PATCH", "/memory/stated", { body: "" })).status).toBe(400);
    expect((await api("PATCH", "/memory/stated", {})).status).toBe(400);
    expect((await api("PATCH", "/memory/stated", { pinned: "yes" })).status).toBe(400);
    expect((await api("PATCH", "/memory/stated", { confirm: false })).status).toBe(400);
  });

  it("pins and unpins", async () => {
    expect((await api("PATCH", "/memory/stated", { pinned: true })).body.item).toMatchObject({ pinned: true });
    expect((await one("stated")).pinned).toBe(true);
    const unpinned = await api("PATCH", "/memory/stated", { pinned: false });
    expect(unpinned.body.item).toMatchObject({ pinned: false });
    expect(unpinned.cost).toBe(3);
    expect((await one("stated")).pinned).toBe(false);
  });

  it("confirm turns the coach's inference into a confirmed item; what the athlete said stays theirs", async () => {
    const confirmed = await api("PATCH", "/memory/inferred", { confirm: true });
    expect(confirmed.status).toBe(200);
    expect((await one("inferred")).confidence).toBe("confirmed");
    expect(confirmed.cost).toBe(3);
    expect((await api("PATCH", "/memory/stated", { confirm: true })).status).toBe(200);
    expect((await one("stated")).confidence).toBe("stated");
    // Together, in one write.
    await db.update(schema.coachMemory).set({ confidence: "inferred" }).where(eq(schema.coachMemory.id, "inferred"));
    const both = await api("PATCH", "/memory/inferred", { confirm: true, pinned: true, body: "Squats go better after activation" });
    expect(both.body.item).toMatchObject({ confidence: "confirmed", pinned: true, body: "Squats go better after activation" });
    expect(both.cost).toBe(3);
  });

  it("only the athlete's own live item: another's, a superseded one, a deleted one or a rehearsal's is a 404 — and untouched", async () => {
    const other = await makeTestUser(db);
    const otherCookie = `${SESSION_COOKIE}=${await createSession(db, other.userId)}`;
    expect((await api("PATCH", "/memory/stated", { pinned: true }, otherCookie)).status).toBe(404);
    expect((await api("PATCH", "/memory/stated", { body: "Not theirs" }, otherCookie)).status).toBe(404);
    for (const id of ["old", "gone", "rehearsal", "nope"]) {
      const res = await api("PATCH", `/memory/${id}`, { pinned: true });
      expect(res.status, id).toBe(404);
      // The write matched nothing; one read says why.
      expect(res.cost).toBe(4);
    }
    expect((await one("stated")).body).toBe("Body of stated");
    expect((await one("old")).pinned).toBe(false);
    expect((await one("rehearsal")).pinned).toBe(false);
  });

  it(`at most ${12} pinned: one more is refused in plain words; unpinning one makes room`, async () => {
    expect(MEMORY_PIN_CAP).toBe(12);
    await insertRows(Array.from({ length: MEMORY_PIN_CAP }, (_, i) => row(`pin-${i}`, { pinned: true })));
    // Items that no longer count: superseded, deleted, expired, a rehearsal's.
    await insertRows([
      row("pin-old", { pinned: true, supersededBy: "pin-0" }),
      row("pin-gone", { pinned: true, active: false }),
      row("pin-expired", { kind: "note", pinned: true, expiresAt: "2001-01-01" }),
      row("pin-rehearsal", { pinned: true, provenance: { source: "athlete_words", at: AT, rehearsal: true } }),
    ]);
    const refused = await api("PATCH", "/memory/stated", { pinned: true });
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: "pin_cap", max: 12, why: "You can pin up to 12. Unpin one first." });
    expect(refused.cost).toBe(4);
    expect((await one("stated")).pinned).toBe(false);
    // An edit of a pinned item is no new pin.
    expect((await api("PATCH", "/memory/pin-3", { pinned: true, body: "Still pinned" })).status).toBe(200);
    expect((await api("PATCH", "/memory/pin-3", { pinned: false })).status).toBe(200);
    expect((await api("PATCH", "/memory/stated", { pinned: true })).status).toBe(200);
  });
});

describe("the pinned core and the thread coach", () => {
  it("every pinned item rides in the designer's core, with room left for recent facts and rules", async () => {
    await insertRows([
      ...Array.from({ length: MEMORY_PIN_CAP }, (_, i) => row(`pin-${i}`, { kind: "note", expiresAt: "2031-01-01", pinned: true, learnedAt: "2026-01-01T00:00:00.000Z" })),
      ...Array.from({ length: 15 }, (_, i) => row(`fact-${i}`, { learnedAt: `2026-09-${String(10 + i).padStart(2, "0")}T00:00:00.000Z` })),
    ]);
    const core = await memoryCore(db, userId, "2026-10-16");
    expect(core).toHaveLength(MEMORY_CORE);
    expect(core.filter((m) => m.pinned)).toHaveLength(MEMORY_PIN_CAP);
    expect(MEMORY_PIN_CAP).toBeLessThan(MEMORY_CORE);
  });

  it("pinning and confirming change nothing the thread coach reads: the dossier lists the same lines in the same statements", async () => {
    await db.insert(schema.coachMemory).values([row("a", { kind: "rule", body: "Long runs on Sunday" }), row("b", { kind: "fact", body: "Has a bench", confidence: "inferred" })]);
    const today = todayInZone(prefs.timezone);
    statements = 0;
    const before = await buildDossier(db, userId, prefs, today);
    const cost = statements;
    await api("PATCH", "/memory/a", { pinned: true });
    await api("PATCH", "/memory/b", { confirm: true });
    statements = 0;
    const after = await buildDossier(db, userId, prefs, today);
    expect(statements).toBe(cost);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });
});

// ── remember's undo ─────────────────────────────────────────────────────────

const noModel: RunDeps = {
  callModel: async () => {
    throw new Error("no model call here");
  },
  buildContext: { statementCost: 0, build: async () => ({ system: [], header: "" }) },
  tools: [],
};

async function undo(runId: string, handle: unknown, e: Env = ON, cookieOf = cookie) {
  const app = mountRoutes(db, "/api/coach/runs", makeCoachRunRoutes(() => noModel));
  statements = 0;
  const res = await app.request(
    `/api/coach/runs/${runId}/undo-answer`,
    { method: "POST", headers: { Cookie: cookieOf, "content-type": "application/json" }, body: JSON.stringify({ handle }) },
    e,
  );
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any>, cost: statements };
}

async function remembered(runId: string, o: { role?: "main" | "designer"; runOf?: string; toolUseId: string; input: unknown }): Promise<ToolOk> {
  const ctx: ToolContext = {
    db,
    env: ON,
    userId,
    run: { id: o.runOf ?? runId, role: o.role ?? "main", scope: { kind: "now" }, parentId: o.runOf ? runId : null, rehearsal: false },
    now: new Date(),
    toolUseId: o.toolUseId,
  };
  return (await remember.run(ctx, o.input)) as ToolOk;
}

describe("remember's line, with undo", () => {
  it("carries an undo handle naming its main run — a designer's too", async () => {
    const runId = (await createRun(db, userId, { scope: { kind: "now" }, request: "x" }, new Date())).run.id;
    const out = await remembered(runId, { toolUseId: "toolu_rm1", input: { kind: "fact", body: "Trains in a garage", confidence: "stated" } });
    expect(out.receipt).toMatchObject({ memoryId: `mem:${runId}:toolu_rm1`, undo: { handle: `rm:${runId}:toolu_rm1` } });
    expect(handleRunId(`rm:${runId}:toolu_rm1`)).toBe(runId);
    // The line says it in the Settings list's words.
    expect(out.summary).toBe("Remembered (you said): Trains in a garage");
    const designerId = `${runId}-d1`;
    await db.insert(schema.coachRuns).values({ id: designerId, userId, parentId: runId, role: "designer", scope: { kind: "now" }, request: null, status: "active", state: null, steps: 0, costUsd: 0, createdAt: AT, updatedAt: AT });
    const byDesigner = await remembered(runId, { role: "designer", runOf: designerId, toolUseId: "toolu_rm2", input: { kind: "rule", body: "Prefers short sessions", confidence: "inferred" } });
    expect(byDesigner.receipt).toMatchObject({ memoryId: `mem:${designerId}:toolu_rm2`, undo: { handle: `rm:${runId}:toolu_rm2` } });
    expect(byDesigner.summary).toBe("Remembered (the coach inferred): Prefers short sessions");
  });

  it("the undo takes the item back, puts back what it replaced, says so on the trail; once; the athlete's own only", async () => {
    await db.insert(schema.coachMemory).values(row("before", { kind: "rule", body: "Trains mornings" }));
    const runId = (await createRun(db, userId, { scope: { kind: "now" }, request: "I train evenings now" }, new Date())).run.id;
    const out = await remembered(runId, { toolUseId: "toolu_rm3", input: { kind: "rule", body: "Trains evenings", confidence: "stated", replaces: "before" } });
    const handle = (out.receipt as { undo: { handle: string } }).undo.handle;
    expect((await one("before")).supersededBy).toBe(`mem:${runId}:toolu_rm3`);

    // Inert without the flag; another run's handle is refused; another athlete's is no item of theirs.
    expect((await undo(runId, handle, env)).status).toBe(404);
    expect((await undo(runId, `rm:other-run:toolu_rm3`)).status).toBe(400);
    const other = await makeTestUser(db);
    expect((await undo(runId, handle, ON, `${SESSION_COOKIE}=${await createSession(db, other.userId)}`)).status).toBe(404);

    const done = await undo(runId, handle);
    expect(done).toMatchObject({ status: 200, body: { undone: 1 } });
    // The session and the restore marker, what it replaced put back, the item taken back, the trail's line.
    expect(done.cost).toBe(5);
    expect((await one(`mem:${runId}:toolu_rm3`)).active).toBe(false);
    expect(await one("before")).toMatchObject({ active: true, supersededBy: null });
    const trail = await db.select().from(schema.coachRunEvents).where(eq(schema.coachRunEvents.runId, runId));
    expect(trail.at(-1)!.summary).toBe('Taken back: the memory "Trains evenings"');
    // Already undone: a 404, and nothing changes.
    expect((await undo(runId, handle)).status).toBe(404);
    expect(await one("before")).toMatchObject({ active: true, supersededBy: null });
  });

  it("a handle reaches its own run's item only: another run's call with the same id is no item of this run's", async () => {
    const runA = (await createRun(db, userId, { scope: { kind: "now" }, request: "x" }, new Date())).run.id;
    await db.update(schema.coachRuns).set({ status: "cancelled" }).where(eq(schema.coachRuns.id, runA));
    const runB = (await createRun(db, userId, { scope: { kind: "now" }, request: "y" }, new Date())).run.id;
    await remembered(runB, { toolUseId: "toolu_same", input: { kind: "fact", body: "Run B's item", confidence: "stated" } });
    expect((await undo(runA, `rm:${runA}:toolu_same`)).status).toBe(404);
    expect((await one(`mem:${runB}:toolu_same`)).active).toBe(true);
  });

  it("an item replaced again since keeps its history: only the item is taken back", async () => {
    await db.insert(schema.coachMemory).values(row("first", { kind: "rule", body: "Mornings" }));
    const runId = (await createRun(db, userId, { scope: { kind: "now" }, request: "x" }, new Date())).run.id;
    const out = await remembered(runId, { toolUseId: "toolu_rm4", input: { kind: "rule", body: "Lunchtimes", confidence: "stated", replaces: "first" } });
    const second = `mem:${runId}:toolu_rm4`;
    await db.insert(schema.coachMemory).values(row("third", { kind: "rule", body: "Evenings" }));
    await db.update(schema.coachMemory).set({ supersededBy: "third", updatedAt: nowInstant() }).where(eq(schema.coachMemory.id, second));
    expect((await undo(runId, (out.receipt as { undo: { handle: string } }).undo.handle)).status).toBe(200);
    expect((await one(second)).active).toBe(false);
    expect((await one("first")).supersededBy).toBe(second);
    expect(await one("third")).toMatchObject({ active: true, supersededBy: null });
  });
});
