/**
 * Corrections approved (import trail phase 3, Task 5; design 2026-11-05 §8.4, §14.3, §6.1): an `import_correction` op is
 * applied at Approve in ONE atomic write — its `import_corrections` row and its trail event on every post it touches,
 * each gated on the value still being what the coach read, the state change last — refused `stale` when it changed
 * since, recorded applied with nothing written when it is already so; declined and superseded like any designed op.
 * Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId } from "@rg/domain";
import { EXERCISES, type ExerciseRecord } from "@rg/exercise-library";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { coachRoutes } from "../src/routes/coach.js";
import { savePreferences } from "../src/services/calendar-sync.js";
import { APPROVE_FIXED, REQUEST_BUDGET } from "../src/services/design-approve.js";
import { supersedeOlderPlans } from "../src/services/design-orchestrate.js";
import { ACT_TOOLS, READ_TOOLS } from "../src/services/design-tools/index.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import { isToolErr, type ToolContext } from "../src/services/design-tools/types.js";
import { readPostTrail } from "../src/services/import-trail-read.js";
import { CORRECTION_COST, CORRECTIONS_FIXED, correctionCostOf } from "../src/services/import-corrections.js";
import { correctionId, isImportCorrectionOp, type ImportCorrectionOp } from "../src/services/proposal-kinds.js";
import { savedMoveDraft, seedSavedBatch } from "./saves-batch-fixture.js";
import { readSavesInRun } from "./saves-read-fixture.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { coachMemory, coachProposals, coachRuns, importCorrections, importEvents, personalMoves, savedPostMoves, savedPosts } = schema;
const NOW = new Date("2026-10-21T08:00:00.000Z");
const SAVED_AT = "2026-10-20T17:00:00.000Z";
const DEAD_BUG = EXERCISES.find((e) => e.id === "deadBug")!;

function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"], ASSETS: {} as unknown as Env["ASSETS"], APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "s", TOKEN_ENCRYPTION_KEY: "k", ALLOWED_GOOGLE_EMAIL: "runner@example.com", GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "c",
    AI_GATEWAY_API_KEY: "test-key", COACH_DESIGNER: "1",
  } as Env;
}

let db: Db;
let userId: string;
let cookie: string;
let statements = 0;
/** A test's own look at each statement, while it is set (one may throw: a failure inside the write). */
let watch: ((sql: string) => unknown) | null = null;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  statements = 0;
  db = makeTestDb({ boundVariableCap: 100, onStatement: (q) => { statements += 1; watch?.(q); } });
  const made = await makeTestUser(db, { timezone: "UTC" });
  userId = made.userId;
  await savePreferences(db, userId, { ...made.prefs, timezone: "UTC" });
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  vi.stubGlobal("fetch", (async () => new Response("{}", { status: 404 })) as typeof fetch);
});
afterEach(() => {
  watch = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const LIFT = savedMoveDraft("Zorbex hip lift", {
  dose: { text: "6-10 reps", type: "reps", range: [6, 10] },
  useWhen: [{ text: "after an easy run", evidence: "stated" }],
  quotes: [{ field: "dose", text: "two sets of thirty seconds", at: 192, from: "transcript", check: "verified" }],
});
const NOD = savedMoveDraft("Zorbex neck nod", { regions: ["neck"] });
const TUCK = savedMoveDraft("Zorbex neck tuck", { regions: ["neck"] });
const DOSE_FIX = { type: "time", range: [30, 30], sets: [2, 2] };

/** Post 0: the lift, the goblet squat, the nod. Post 1: the lift again, the tuck — and two insights. */
async function batch() {
  const seeded = await seedSavedBatch(db, userId, {
    savedAt: SAVED_AT,
    posts: [
      { moves: [{ draft: LIFT }, { library: "gobletSquat" }, { draft: NOD }] },
      { moves: [{ draft: LIFT }, { draft: TUCK }], insights: ["Twice a week is plenty.", { text: "Day one of the split.", scope: "general" }] },
    ],
  });
  const [lift, , nod] = seeded.moveIds[0]!;
  const [, tuck] = seeded.moveIds[1]!;
  return { batchId: seeded.batchId, p0: seeded.postIds[0]!, p1: seeded.postIds[1]!, lift: lift!, nod: nod!, tuck: tuck! };
}

async function mainRun(): Promise<ToolContext> {
  const id = `run-${newId()}`;
  await db.insert(coachRuns).values({
    id, userId, parentId: null, role: "main", scope: { kind: "auto" }, request: "That reading is wrong.", status: "active", state: null, steps: 0, costUsd: 0,
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  });
  return { db, env: makeEnv(), userId, run: { id, role: "main", scope: { kind: "auto" }, parentId: null, rehearsal: false }, now: new Date(), toolUseId: `toolu_${newId()}` };
}

/** A run that read its saves and proposed `fixes` (each correct_import's input), made pending as a finish makes it. */
async function proposed(fixes: Array<Record<string, unknown>>): Promise<{ id: string; ctx: ToolContext }> {
  const ctx = await mainRun();
  await readSavesInRun(db, ctx);
  const tool = ACT_TOOLS.find((t) => t.name === "correct_import")!;
  for (const [i, f] of fixes.entries()) {
    const r = await tool.run({ ...ctx, toolUseId: `toolu_fix_${i}` }, { why: "The transcript says so.", basis: "evidence", cites: ["history"], ...f });
    if (isToolErr(r)) throw new Error(`refused: ${r.error} — ${r.why}`);
  }
  await db.update(coachProposals).set({ status: "pending" }).where(eq(coachProposals.id, designProposalId(ctx.run.id)));
  return { id: designProposalId(ctx.run.id), ctx };
}

async function invoke(method: string, path: string, body?: unknown) {
  const app = mountRoutes(db, "/api/coach", coachRoutes);
  const pending: Promise<unknown>[] = [];
  const executionCtx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => undefined, props: {} };
  statements = 0;
  const res = await app.request(path, { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, makeEnv(), executionCtx as never);
  await Promise.all(pending);
  const text = await res.text();
  let json: Record<string, any> | null = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { text };
  }
  return { status: res.status, json: json as Record<string, any>, total: statements };
}
const approve = (id: string, body: unknown = {}) => invoke("POST", `/api/coach/proposals/${id}/approve`, body);
const fixesOf = async (id: string) => ((await db.select().from(coachProposals).where(eq(coachProposals.id, id)))[0]!.ops as unknown[]).filter(isImportCorrectionOp) as Array<ImportCorrectionOp & { outcome?: any }>;
const recordOf = async (id: string) => (await db.select().from(personalMoves).where(eq(personalMoves.id, id)))[0]!;
const rows = async () => db.select().from(importCorrections).where(eq(importCorrections.userId, userId));
const correctionEvents = async () => db.select().from(importEvents).where(and(eq(importEvents.userId, userId), eq(importEvents.stage, "correction")));

describe("a correction approved", () => {
  it("a move's dose: the record changed, one correction row, one trail event on each post it came from, the op applied — within its declared cost", async () => {
    const b = await batch();
    const { id } = await proposed([{ target: "move", targetId: b.lift, field: "dose", after: DOSE_FIX, cites: ["q1.1"] }]);
    const res = await approve(id);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.status).toBe("approved");
    const move = await recordOf(b.lift);
    expect((move.record as ExerciseRecord).dose).toEqual(DOSE_FIX);
    expect(move.editedByOwner).toBe(true);
    const [row, ...more] = await rows();
    expect(more).toEqual([]);
    expect(row).toMatchObject({
      target: "move", targetId: b.lift, field: "dose", before: { type: "reps", range: [6, 10] }, after: DOSE_FIX,
      why: "The transcript says so.", basis: "evidence", by: "coach", proposalId: id,
      evidence: [{ id: "q1.1", kind: "quote", label: "said 3:12", postId: b.p0, position: 0, quote: 0 }],
    });
    const events = await correctionEvents();
    expect(events.map((e) => e.postId).sort()).toEqual([b.p0, b.p1].sort());
    expect(events[0]).toMatchObject({ source: "coach", status: "ok", moveId: b.lift, proposalId: id, summary: "Dose of Zorbex hip lift: 30 s, 2 sets (was 6–10 reps) — The transcript says so." });
    const [op] = await fixesOf(id);
    expect(op!.outcome).toMatchObject({ status: "applied" });
    expect(res.total).toBeLessThanOrEqual(APPROVE_FIXED + CORRECTIONS_FIXED + CORRECTION_COST);
    // The trail shows it.
    const trail = await readPostTrail(db, userId, b.p0);
    expect(trail!.events.filter((e) => e.stage === "correction").map((e) => e.summary)).toEqual([events.find((e) => e.postId === b.p0)!.summary]);
  });

  it("a failure inside the write leaves neither the change nor its log", async () => {
    const b = await batch();
    const { id } = await proposed([{ target: "move", targetId: b.lift, field: "dose", after: DOSE_FIX }]);
    watch = (q) => {
      if (/^update "personal_moves"/i.test(q.trim()) && q.includes("json_set")) throw new Error("disk full");
    };
    const res = await approve(id);
    expect(res.status).toBeGreaterThanOrEqual(500);
    watch = null;
    expect((await recordOf(b.lift)).record).toMatchObject({ dose: { type: "reps", range: [6, 10] } });
    expect(await rows()).toEqual([]);
    expect(await correctionEvents()).toEqual([]);
  });

  it("a post's reading: when to use it — the post's reading rewritten, the trail's account reads the new words", async () => {
    const b = await batch();
    const { id } = await proposed([{ target: "reading", targetId: `${b.p0}:0`, field: "useWhen", after: [{ text: "after a long run", evidence: "stated" }] }]);
    expect((await approve(id)).status).toBe(200);
    const trail = await readPostTrail(db, userId, b.p0);
    expect(trail!.account.moves[0]!.useWhen).toEqual([{ text: "after a long run", evidence: "stated" }]);
    expect((await rows())[0]).toMatchObject({ target: "reading", targetId: `${b.p0}:0`, field: "useWhen", before: [{ text: "after an easy run", evidence: "stated" }] });
  });

  it("an insight: dropped (the coach no longer reads it; its memory let go), reworded (its memory too), rescoped (its memory let go)", async () => {
    const b = await batch();
    for (const idx of [0, 1]) {
      await db.insert(coachMemory).values({
        id: `saved:${b.p1}:${idx}`, userId, kind: "observation", body: idx === 0 ? "Twice a week is plenty." : "Day one of the split.",
        provenance: { source: "saved_post", postId: b.p1 }, learnedAt: SAVED_AT, active: true, pinned: false, confidence: "inferred", updatedAt: SAVED_AT,
      } as never);
    }
    const { id } = await proposed([
      { target: "insight", targetId: `${b.p1}:0`, field: "text", after: "Twice a week is enough." },
      { target: "insight", targetId: `${b.p1}:1`, field: "scope", after: "creator_programme" },
    ]);
    expect((await approve(id)).status).toBe(200);
    const memory = await db.select().from(coachMemory).where(eq(coachMemory.userId, userId));
    expect(memory.find((m) => m.id.endsWith(":0"))).toMatchObject({ body: "Twice a week is enough.", active: true });
    expect(memory.find((m) => m.id.endsWith(":1"))).toMatchObject({ active: false });
    const { id: dropId } = await proposed([{ target: "insight", targetId: `${b.p1}:0`, field: "drop", after: true }]);
    expect((await approve(dropId)).status).toBe(200);
    expect((await db.select().from(coachMemory).where(eq(coachMemory.id, `saved:${b.p1}:0`)))[0]!.active).toBe(false);
    const ctx = await mainRun();
    const read = await READ_TOOLS.find((t) => t.name === "read_saves")!.run(ctx, {});
    expect(JSON.stringify(read)).not.toContain("Twice a week");
  });

  it("same as: a clean duplicate is archived into the move it is; one with history stays, marked like it, and the outcome says why", async () => {
    const b = await batch();
    const { id } = await proposed([{ target: "link", targetId: `${b.p0}:2`, field: "same_as", after: "deadBug" }]);
    expect((await approve(id)).status).toBe(200);
    expect((await db.select().from(savedPostMoves).where(and(eq(savedPostMoves.postId, b.p0), eq(savedPostMoves.position, 2))))[0]).toMatchObject({ moveId: "deadBug", moveKind: "library" });
    expect(await recordOf(b.nod)).toMatchObject({ status: "merged", mergedInto: "deadBug" });

    // The lift has a logged set: it stays, its other link marked like the dead bug.
    const sessionId = newId();
    await db.insert(schema.performedSessions).values({ id: sessionId, userId, source: "app", localDate: "2026-10-19", payloadHash: "h", createdAt: SAVED_AT, updatedAt: SAVED_AT } as never);
    await db.insert(schema.performedSets).values({ id: newId(), performedSessionId: sessionId, entryIndex: 0, exerciseId: b.lift, setIndex: 0, reps: 8 } as never);
    const { id: used } = await proposed([{ target: "link", targetId: `${b.p0}:0`, field: "same_as", after: "deadBug" }]);
    const res = await approve(used);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(await recordOf(b.lift)).toMatchObject({ status: "active" });
    expect((await db.select().from(savedPostMoves).where(and(eq(savedPostMoves.postId, b.p1), eq(savedPostMoves.position, 0))))[0]).toMatchObject({ moveId: b.lift, likeMoveId: "deadBug" });
    const [op] = await fixesOf(used);
    // (The second post names the lift too.)
    expect(op!.outcome.lines).toEqual([`Zorbex hip lift stays: it has logged sets, another post names it — marked like ${DEAD_BUG.name}`]);
  });

  it("not the same: the library link becomes a move of its own, active, from the post's reading", async () => {
    const b = await batch();
    const { id } = await proposed([{ target: "link", targetId: `${b.p0}:1`, field: "not_same", after: null }]);
    expect((await approve(id)).status).toBe(200);
    const [link] = await db.select().from(savedPostMoves).where(and(eq(savedPostMoves.postId, b.p0), eq(savedPostMoves.position, 1)));
    expect(link).toMatchObject({ moveKind: "personal" });
    expect(await recordOf(link!.moveId)).toMatchObject({ status: "active", batchId: b.batchId });
  });

  it("changed since the coach suggested it: refused stale, nothing written; asked again after the write, recorded applied, nothing written twice", async () => {
    const b = await batch();
    const { id } = await proposed([{ target: "move", targetId: b.lift, field: "dose", after: DOSE_FIX }]);
    // The owner edited the dose meanwhile.
    const rec = (await recordOf(b.lift)).record as ExerciseRecord;
    await db.update(personalMoves).set({ record: { ...rec, dose: { type: "reps", range: [5, 5] } } }).where(eq(personalMoves.id, b.lift));
    const res = await approve(id);
    expect(res.status).toBe(200);
    expect(res.json.refused).toEqual([{ opId: correctionId("move", b.lift, "dose"), error: "stale", why: "It changed since the coach suggested this — ask again." }]);
    expect(await rows()).toEqual([]);

    // A second suggestion approved; its outcome lost (the request died after the write): asked again, applied, once.
    await db.update(personalMoves).set({ record: rec }).where(eq(personalMoves.id, b.lift));
    const { id: again } = await proposed([{ target: "move", targetId: b.lift, field: "dose", after: DOSE_FIX }]);
    expect((await approve(again)).status).toBe(200);
    const ops = (await db.select().from(coachProposals).where(eq(coachProposals.id, again)))[0]!.ops as Array<Record<string, unknown>>;
    await db.update(coachProposals).set({ status: "pending", ops: ops.map(({ outcome: _o, ...op }) => op) }).where(eq(coachProposals.id, again));
    const replay = await approve(again);
    expect(replay.status).toBe(200);
    expect(replay.json.status).toBe("approved");
    expect(await rows()).toHaveLength(1);
  });

  it("Not now declines it: nothing written", async () => {
    const b = await batch();
    const { id } = await proposed([{ target: "move", targetId: b.lift, field: "dose", after: DOSE_FIX }]);
    const res = await invoke("POST", `/api/coach/proposals/${id}/decline`, {});
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect((await fixesOf(id))[0]!.outcome).toMatchObject({ status: "declined" });
    expect(await rows()).toEqual([]);
    expect((await recordOf(b.lift)).record).toMatchObject({ dose: { range: [6, 10] } });
  });

  it("a suggestion of corrections alone reads, and is approved whole", async () => {
    const b = await batch();
    const { id } = await proposed([{ target: "move", targetId: b.lift, field: "name", after: "Zorbex hip raise" }]);
    const read = await invoke("GET", `/api/coach/proposals/${id}`);
    expect(read.status, JSON.stringify(read.json)).toBe(200);
    expect((await approve(id)).json.status).toBe("approved");
    expect(((await recordOf(b.lift)).record as ExerciseRecord).name).toBe("Zorbex hip raise");
  });

  it("a newer suggestion with the same correction supersedes the older one's", async () => {
    const b = await batch();
    const { id: older } = await proposed([{ target: "move", targetId: b.lift, field: "dose", after: DOSE_FIX }]);
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    const { id: newer } = await proposed([{ target: "move", targetId: b.lift, field: "dose", after: { type: "time", range: [40, 40] } }]);
    await db.update(coachProposals).set({ createdAt: new Date(NOW.getTime() + 60_000).toISOString() }).where(eq(coachProposals.id, newer));
    await supersedeOlderPlans(db, userId, newer, new Date(NOW.getTime() + 60_000).toISOString());
    expect((await fixesOf(older))[0]!.outcome).toMatchObject({ status: "superseded", by: newer });
  });

  it("ten corrections fit one request, within the Workers budget", async () => {
    const b = await batch();
    const fields: Array<[string, unknown]> = [
      ["name", "Zorbex hip raise"], ["summary", "Slow."], ["purpose", "Hips."], ["laterality", "unilateral"], ["steps", ["Up."]],
      ["cues", ["Slow."]], ["load", "bodyweight"], ["dose", DOSE_FIX],
    ];
    const { id } = await proposed([
      ...fields.map(([field, after]) => ({ target: "move", targetId: b.lift, field, after })),
      { target: "reading", targetId: `${b.p0}:0`, field: "why", after: "Long runs." },
      { target: "link", targetId: `${b.p0}:2`, field: "same_as", after: "deadBug" },
    ]);
    const ops = await fixesOf(id);
    expect(ops).toHaveLength(10);
    const res = await approve(id);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.remaining).toEqual([]);
    expect(res.json.status).toBe("approved");
    expect(res.total).toBeLessThanOrEqual(REQUEST_BUDGET);
    expect(APPROVE_FIXED + CORRECTIONS_FIXED + ops.reduce((n, o) => n + correctionCostOf(o), 0)).toBeLessThanOrEqual(REQUEST_BUDGET);
    expect(await rows()).toHaveLength(10);
  });
});

describe("a correction beside a workout (final review, Important 4)", () => {
  it("costs no more than it declares: the account's library read again after the correction is counted", async () => {
    const { createDocWorkout } = await import("../src/services/doc-workouts.js");
    const { loadPreferences } = await import("../src/services/calendar-sync.js");
    const { proposeWorkout } = await import("../src/services/design-tools/propose.js");
    const { calmDoc } = await import("./doc-workout-fixture.js");
    const prefs = await loadPreferences(db, userId);
    const day = "2026-10-24";
    const b = await batch();
    /** A revision of a planned workout, reviewed, and — `withFix` — a correction of the lift's dose beside it. */
    const suggestion = async (withFix: boolean) => {
      const made = await createDocWorkout(db, userId, { date: day, doc: calmDoc({ title: `Mine ${withFix}` }) }, { today: "2026-10-21", now: NOW.toISOString(), prefs });
      const ctx = await mainRun();
      await readSavesInRun(db, ctx);
      const drafted = await proposeWorkout.run(ctx, { doc: calmDoc({ title: `Mine, calmer ${withFix}` }), target: { kind: "revise", workoutId: made.workout.id, baseRev: 1 } });
      if (isToolErr(drafted)) throw new Error(`propose refused: ${drafted.error} — ${drafted.why}`);
      if (withFix) {
        const r = await ACT_TOOLS.find((t) => t.name === "correct_import")!.run({ ...ctx, toolUseId: "toolu_fix" }, { target: "move", targetId: b.lift, field: "dose", after: DOSE_FIX, why: "The transcript says so.", basis: "evidence", cites: ["history"] });
        if (isToolErr(r)) throw new Error(r.why);
      }
      const id = designProposalId(ctx.run.id);
      const [p] = await db.select().from(coachProposals).where(eq(coachProposals.id, id));
      const review = { scores: { intent: 4 }, notes: { intent: "Clear." }, mustFix: [], improvements: [], rounds: 1, changes: [] };
      await db.update(coachProposals).set({ status: "pending", ops: (p!.ops as Array<Record<string, unknown>>).map((o) => (o.kind === "doc_workout" ? { ...o, review } : o)) }).where(eq(coachProposals.id, id));
      return id;
    };
    const alone = await approve(await suggestion(false));
    expect(alone.status, JSON.stringify(alone.json)).toBe(200);
    const both = await approve(await suggestion(true));
    expect(both.status, JSON.stringify(both.json)).toBe(200);
    expect(both.json.status).toBe("approved");
    const fix = { target: "move" as const, field: "dose" };
    expect(both.total - alone.total).toBeLessThanOrEqual(CORRECTIONS_FIXED + correctionCostOf(fix));
  });
});

describe("a dose fix that doesn't land under its pins card (final review, Important 1)", () => {
  it("the pins apply; the trail's approved line states no dose the move doesn't have", async () => {
    const b = await batch();
    const ctx = await mainRun();
    await readSavesInRun(db, ctx);
    const pinsTool = ACT_TOOLS.find((t) => t.name === "pin_moves")!;
    const pinned = await pinsTool.run(ctx, {
      batchId: b.batchId, pin: [b.lift], title: "One in", why: "The lift fills the hip work.",
      lines: [{ moveId: b.lift, text: "It serves hip mobility.", cites: ["history"] }, { moveId: b.nod, text: "Your care covers it.", cites: ["history"] }, { moveId: b.tuck, text: "Not this week.", cites: ["history"] }],
    });
    if (isToolErr(pinned)) throw new Error(pinned.why);
    const fixed = await ACT_TOOLS.find((t) => t.name === "correct_import")!.run({ ...ctx, toolUseId: "toolu_dose" }, { target: "move", targetId: b.lift, field: "dose", after: DOSE_FIX, why: "The transcript says so.", basis: "evidence", cites: ["history"] });
    if (isToolErr(fixed)) throw new Error(fixed.why);
    const id = designProposalId(ctx.run.id);
    await db.update(coachProposals).set({ status: "pending" }).where(eq(coachProposals.id, id));
    // The owner changed the dose meanwhile: the fix is refused stale; the pins still apply.
    const rec = (await recordOf(b.lift)).record as ExerciseRecord;
    await db.update(personalMoves).set({ record: { ...rec, dose: { type: "reps", range: [5, 5] } } }).where(eq(personalMoves.id, b.lift));
    const res = await approve(id);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.refused.map((r: { error: string }) => r.error)).toEqual(["stale"]);
    const approved = (await db.select().from(importEvents).where(and(eq(importEvents.userId, userId), eq(importEvents.stage, "coach"), eq(importEvents.moveId, b.lift))))
      .filter((e) => e.summary.startsWith("You approved it"));
    expect(approved.length).toBeGreaterThan(0);
    for (const e of approved) {
      expect(e.summary).not.toContain("30 s, 2 sets");
      expect((e.detail as { dose: unknown }).dose).toBeNull();
    }
  });
});
