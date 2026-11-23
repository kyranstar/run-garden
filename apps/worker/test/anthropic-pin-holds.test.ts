/**
 * THE ANTHROPIC PIN HOLDS WHATEVER HAPPENED TO THE AUDIT ROWS, ON EVERY COACH CALL (R1.5 fix round 2; the re-check's N1, N2,
 * N4 and its probes P2–P11; device-sharing.ts `sharesDaySql`). Pinned = switch A's audit rows say it was ever on, OR a phone's
 * switch A is on now:
 *  - a restore of a file from before A, and "Start fresh", leave the switch on: the next framed run is pinned, every call;
 *  - both spare the switch's own audit rows, so "ever on" survives them even with the switch now off; a file from after A
 *    lands beside the spared rows with nothing lost or doubled; delete-all spares nothing;
 *  - the live switch alone pins (its audit rows gone by any means), and with neither the account is routed as before;
 *  - the flag over a week with no spend; malformed audit rows neither throw nor pin;
 *  - the wake's and a read's schema repairs, a backfill digest, a run step retried after a provider error, and the weekly
 *    review: all pinned;
 *  - no statement more: a never-on account's requests cost what an on account's do.
 * Synthetic data, test accounts, scripted model, no network.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { deleteAllUserData } from "../src/routes/misc.js";
import { patchAccountState } from "../src/services/account-state.js";
import { startFresh } from "../src/services/account-restore.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import { enqueueBackfillDigest, ensureRead, processCoachReads } from "../src/services/coach-reads.js";
import { createRun, runStep, type RunDeps } from "../src/services/coach-runs.js";
import { wake } from "../src/services/coach-wake.js";
import { designContextBuilder } from "../src/services/design-context.js";
import type { DayFrame } from "../src/services/design-frame.js";
import { REVIEW_DIMENSIONS } from "../src/services/design-prompt.js";
import { allTools } from "../src/services/design-tools/index.js";
import { frameRefusal, setSharing, SHARING_SET_KIND, sharingOf } from "../src/services/device-sharing.js";
import { devBudgetStatus, generateWeeklyReview, llmBudgetStatus } from "../src/services/llm.js";
import type { ContentBlock, MessagesOk, MessagesRequest, MessagesResult } from "../src/services/llm-messages.js";
import { generatePlan } from "../src/services/studio-llm.js";
import { NOW, seedRichAthlete, TODAY } from "./design-read-fixture.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { makeTestDb, untilDone } from "./helpers.js";
import { exportAll, restoreAll } from "./restore-driver.js";

const { activities, auditEvents, llmUsage, nativeDeviceSharing } = schema;
const env = { APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1", AI_GATEWAY_API_KEY: "test-key" } as Env;
const VERSION = "2026-11-19.1";
const ONLY = { gateway: { only: ["anthropic"] } };
const ORDER = { gateway: { order: ["anthropic"] } };

let counting = false;
let count = 0;
let db: Db;
beforeAll(() => {
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => { if (counting) count += 1; } });
});
async function counted(f: () => Promise<unknown>): Promise<number> {
  count = 0;
  counting = true;
  try { await f(); } finally { counting = false; }
  return count;
}

/** Each account's own phone: `native_device_sharing` is keyed by the device id alone. */
const phoneOf = (userId: string) => `d-${userId}`;
const switchA = (userId: string, on: boolean) => setSharing(db, userId, phoneOf(userId), { toTraining: on, disclosureVersion: VERSION }, nowInstant());
const sharesDay = async (userId: string) => (await llmBudgetStatus(db, userId)).sharesDay;
const switchRows = async (userId: string) =>
  (await db.select().from(auditEvents).where(and(eq(auditEvents.userId, userId), eq(auditEvents.kind, SHARING_SET_KIND)))).length;
const otherAudit = async (userId: string) => {
  const id = newId();
  await db.insert(auditEvents).values({ id, userId, kind: "pin_holds_other", detail: { n: 1 }, createdAt: nowInstant() });
  return id;
};
const auditRow = async (id: string) => (await db.select().from(auditEvents).where(eq(auditEvents.id, id))).length;

const frame = (): DayFrame =>
  ({
    days: [TODAY],
    energy: "low",
    free: { [TODAY]: [{ from: "17:30", to: "19:30" }] },
    dayEnd: "23:00",
    load: { [TODAY]: "full" },
    coverage: { [TODAY]: { planAsOf: NOW.toISOString(), calendarAsOf: NOW.toISOString(), drafted: false } },
    consent: VERSION,
  }) as DayFrame;

let seq = 0;
const use = (name: string, input: unknown): ContentBlock => ({ type: "tool_use", id: `toolu_ph${++seq}`, name, input });
const turn = (uses: ContentBlock[], text = "Working on it."): MessagesOk => ({
  ok: true,
  model: "anthropic/claude-opus-5.5",
  content: [{ type: "thinking", thinking: "", signature: `sig-${++seq}-${"x".repeat(30)}` }, { type: "text", text }, ...uses],
  stopReason: uses.length > 0 ? "tool_use" : "end_turn",
  usage: { inputTokens: 100, cacheReadTokens: 60, cacheWriteTokens: 50, outputTokens: 40 },
  costMicros: 1_000,
});
const DIMS = REVIEW_DIMENSIONS.map((d) => d.id);
const verdict = { scores: Object.fromEntries(DIMS.map((d) => [d, 4])), notes: Object.fromEntries(DIMS.map((d) => [d, `${d}: fine.`])), mustFix: [], improvements: [] };
const threeTurns = (title: string) => [
  turn([use("propose_workout", { doc: calmDoc({ title }), target: { kind: "new", date: TODAY } })]),
  turn([use("submit_review", verdict)]),
  turn([use("finish", { summary: "An easy one for today." })]),
];

/** Every request a run sent, driven step by step to its end with a scripted model. */
async function drive(userId: string, runId: string, turns: MessagesResult[], stepMs = 1000) {
  const requests: MessagesRequest[] = [];
  const deps: RunDeps = {
    callModel: async (_env, req) => {
      requests.push(structuredClone(req));
      const next = turns.shift();
      if (!next) throw new Error("the scripted model ran out of turns");
      return next;
    },
    buildContext: designContextBuilder,
    tools: allTools(),
    review: true,
    clock: () => 0,
  };
  await untilDone(
    async (i) => {
      const out = await runStep(db, env, runId, userId, new Date(NOW.getTime() + i * stepMs), deps);
      if (out.kind !== "ok") throw new Error(`step answered ${out.kind}`);
      return out.result.status !== "active";
    },
    { max: 60, what: "drive" },
  );
  return requests;
}

/** The route's order (routes/coach-runs.ts): the frame is taken only when `frameRefusal` says nothing, then the run. */
async function framedTurn(userId: string) {
  expect(await frameRefusal(db, userId, phoneOf(userId), VERSION), "the route takes this frame").toBeNull();
  const run = await createRun(db, userId, { scope: { kind: "now" }, request: "Today's 18:00 run: make it easier (low energy).", conversationId: null, lifeos: { deviceId: phoneOf(userId), frame: frame() } }, NOW);
  return drive(userId, run.run.id, threeTurns("Easy 25 for a low-energy full day"));
}

function chatGateway(contents: unknown[]) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init!.body)) as Record<string, unknown>);
    const content = contents.shift();
    if (content === undefined) return new Response("bad request", { status: 400 });
    const body = { choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 40 } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, bodies };
}
const briefing = { briefing: "Noted.", proposals: [], question: null, memoryOps: [] };
const aRead = { glance: "Easy.", body: "Easy.", flags: [] };
async function wakeRouting(userId: string): Promise<unknown> {
  const g = chatGateway([briefing]);
  await wake(db, env, userId, await loadPreferences(db, userId), { kind: "manual" }, g.fetchImpl);
  expect(g.bodies.length).toBe(1);
  return g.bodies[0]!.providerOptions;
}
async function anActivity(userId: string): Promise<string> {
  const id = `act-${newId().slice(0, 8)}`;
  await db.insert(activities).values({ id, userId, startTime: "2026-05-12T15:00:00Z", startTimeLocal: "2026-05-12T07:00:00", sport: "run", durationSeconds: 1800, distanceMeters: 5000, sourceMergeConfidence: 1, createdAt: nowInstant(), updatedAt: nowInstant() } as typeof activities.$inferInsert);
  return id;
}
/** A restore left unfinished three days ago, ready for "Start fresh". */
async function abandonedRestore(userId: string): Promise<void> {
  const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
  await patchAccountState(db, userId, { restoreId: "r-holds", restoreStartedAt: old, restoreHeartbeatAt: old });
  expect((await startFresh(db, userId, { restoreId: "r-holds" })).ok).toBe(true);
}
const allPinned = (requests: MessagesRequest[]) => {
  expect(requests.length).toBeGreaterThanOrEqual(3);
  expect(requests.map((r) => r.anthropicOnly)).toEqual(requests.map(() => true));
};

describe("a restore or Start fresh never drops the pin (R1.5 re-check N1)", () => {
  it("P2: a file from before switch A restored, the switch still on: the next framed run is pinned, every call", async () => {
    const { userId } = await seedRichAthlete(db);
    const before = await exportAll(db, userId);
    await switchA(userId, true);
    const out = await restoreAll(db, userId, before);
    expect(out.lost).toBe(0);
    expect(out.short).toEqual([]);
    expect((await sharingOf(db, userId, phoneOf(userId))).toTraining).toBe(true);
    expect(await sharesDay(userId)).toBe(true);
    allPinned(await framedTurn(userId));
  }, 60_000);

  it("a file from before switch A restored after A was turned off: the switch's audit rows are spared, so still pinned", async () => {
    const { userId } = await seedRichAthlete(db);
    const before = await exportAll(db, userId);
    await switchA(userId, true);
    await switchA(userId, false);
    const other = await otherAudit(userId);
    await restoreAll(db, userId, before);
    expect((await sharingOf(db, userId, phoneOf(userId))).toTraining).toBe(false);
    expect(await switchRows(userId)).toBe(2);
    expect(await auditRow(other), "every other audit row is the file's").toBe(0);
    expect(await sharesDay(userId)).toBe(true);
    expect(await wakeRouting(userId)).toEqual(ONLY);
  }, 60_000);

  it("a file from after switch A lands beside the spared rows: nothing lost, nothing doubled", async () => {
    const { userId } = await seedRichAthlete(db);
    await switchA(userId, true);
    const after = await exportAll(db, userId);
    expect(after.tables.audit_events!.filter((r) => r.kind === SHARING_SET_KIND)).toHaveLength(1);
    const out = await restoreAll(db, userId, after);
    expect(out.lost).toBe(0);
    expect(out.short).toEqual([]);
    expect(await switchRows(userId)).toBe(1);
    expect(await sharesDay(userId)).toBe(true);
  }, 60_000);

  it("P3: Start fresh, the switch still on: pinned, and the next framed run is pinned, every call", async () => {
    const { userId } = await seedRichAthlete(db);
    await switchA(userId, true);
    await abandonedRestore(userId);
    expect((await sharingOf(db, userId, phoneOf(userId))).toTraining).toBe(true);
    expect(await sharesDay(userId)).toBe(true);
    allPinned(await framedTurn(userId));
  }, 60_000);

  it("Start fresh after A was turned off: the switch's audit rows are spared, every other row goes, still pinned", async () => {
    const { userId } = await seedRichAthlete(db);
    await switchA(userId, true);
    await switchA(userId, false);
    const other = await otherAudit(userId);
    await abandonedRestore(userId);
    expect(await switchRows(userId)).toBe(2);
    expect(await auditRow(other)).toBe(0);
    expect(await sharesDay(userId)).toBe(true);
    expect(await wakeRouting(userId)).toEqual(ONLY);
  }, 60_000);

  it("the live switch alone pins, whatever happened to its audit rows; with neither, the account is routed as before", async () => {
    const { userId } = await seedRichAthlete(db);
    await switchA(userId, true);
    await db.delete(auditEvents).where(and(eq(auditEvents.userId, userId), eq(auditEvents.kind, SHARING_SET_KIND)));
    expect(await switchRows(userId)).toBe(0);
    expect(await sharesDay(userId)).toBe(true);
    expect((await devBudgetStatus(db, userId)).sharesDay).toBe(true);
    expect(await wakeRouting(userId)).toEqual(ONLY);
    // Its rows gone again, the phone off: nothing says A was ever on.
    await db.update(nativeDeviceSharing).set({ toTraining: false }).where(eq(nativeDeviceSharing.userId, userId));
    expect(await sharesDay(userId)).toBe(false);
    expect(await wakeRouting(userId)).toEqual(ORDER);
  }, 60_000);

  it("another account's live switch pins nothing here", async () => {
    const { userId } = await seedRichAthlete(db);
    const other = await seedRichAthlete(db);
    await switchA(other.userId, true);
    await db.delete(auditEvents).where(and(eq(auditEvents.userId, other.userId), eq(auditEvents.kind, SHARING_SET_KIND)));
    expect(await sharesDay(other.userId)).toBe(true);
    expect(await sharesDay(userId)).toBe(false);
  }, 30_000);

  it("delete-all spares nothing: the switch and its audit rows go with the account", async () => {
    const { userId } = await seedRichAthlete(db);
    await switchA(userId, true);
    await deleteAllUserData(db, userId);
    expect(await switchRows(userId)).toBe(0);
    expect(await db.select().from(nativeDeviceSharing).where(eq(nativeDeviceSharing.userId, userId))).toEqual([]);
  }, 30_000);
});

describe("the flag, read where every coach call reads its budget (R1.5 re-check N4)", () => {
  it("P4: over a week with no spend at all, both lanes, and the first wake", async () => {
    const { userId } = await seedRichAthlete(db);
    await switchA(userId, true);
    const [n] = await db.select({ n: sql<number>`count(*)` }).from(llmUsage).where(eq(llmUsage.userId, userId));
    expect(Number(n!.n)).toBe(0);
    expect(await sharesDay(userId)).toBe(true);
    expect((await devBudgetStatus(db, userId)).sharesDay).toBe(true);
    expect(await wakeRouting(userId)).toEqual(ONLY);
  }, 30_000);

  it("P5: malformed switch audit rows neither throw nor pin; a good row then pins that account only", async () => {
    const { userId } = await seedRichAthlete(db);
    const other = await seedRichAthlete(db);
    const at = nowInstant();
    for (const [u, detail] of [
      [userId, "not json"],
      [userId, null],
      [userId, '{"toTraining":"true"}'],
      [userId, '{"toTraining":false}'],
      [userId, '"toTraining"'],
      [other.userId, "{broken"],
    ] as const) {
      await db.run(sql`insert into audit_events (id, user_id, kind, detail, created_at) values (${newId()}, ${u}, ${SHARING_SET_KIND}, ${detail}, ${at})`);
    }
    expect(await sharesDay(userId)).toBe(false);
    expect(await sharesDay(other.userId)).toBe(false);
    await switchA(userId, true);
    expect(await sharesDay(userId)).toBe(true);
    expect(await sharesDay(other.userId)).toBe(false);
  }, 30_000);
});

describe("every coach call once A has been on: repairs, retries, digests and the weekly review (R1.5 re-check N2, N4)", () => {
  it("P8: the wake's schema repair is pinned too", async () => {
    const { userId } = await seedRichAthlete(db);
    await switchA(userId, true);
    const g = chatGateway([{ nope: 1 }, briefing]);
    await wake(db, env, userId, await loadPreferences(db, userId), { kind: "manual" }, g.fetchImpl);
    expect(g.bodies.length).toBeGreaterThanOrEqual(2);
    expect(g.bodies.map((b) => b.providerOptions)).toEqual(g.bodies.map(() => ONLY));
  }, 30_000);

  it("P9: an activity read's schema repair is pinned too", async () => {
    const { userId } = await seedRichAthlete(db);
    await switchA(userId, true);
    const g = chatGateway([{ nope: 1 }, aRead]);
    await ensureRead(db, env, userId, await loadPreferences(db, userId), await anActivity(userId), { fetchImpl: g.fetchImpl });
    expect(g.bodies.map((b) => b.providerOptions)).toEqual([ONLY, ONLY]);
  }, 30_000);

  it("P10: a backfill digest read is pinned", async () => {
    const { userId } = await seedRichAthlete(db);
    await switchA(userId, true);
    expect(await enqueueBackfillDigest(db, userId, "rk-holds", 999)).toBe(true);
    const g = chatGateway([{ glance: "History.", body: "History.", flags: [] }, aRead, aRead]);
    await processCoachReads(db, env, userId, await loadPreferences(db, userId), { fetchImpl: g.fetchImpl, cap: 1 });
    expect(g.bodies.length).toBeGreaterThan(0);
    expect(JSON.stringify(g.bodies[0]!.messages)).toContain("TRAINING HISTORY");
    expect(g.bodies.map((b) => b.providerOptions)).toEqual(g.bodies.map(() => ONLY));
  }, 30_000);

  it("P11: a run step retried after a provider error is pinned, the retry included", async () => {
    const { userId } = await seedRichAthlete(db);
    await switchA(userId, true);
    const run = await createRun(db, userId, { scope: { kind: "now" }, request: "Something calm.", conversationId: null }, NOW);
    const requests = await drive(userId, run.run.id, [
      { ok: false, kind: "retryable", reason: "gateway_503", status: 503 } as MessagesResult,
      turn([], "Here."),
      turn([], "Done."),
      turn([], "Done."),
    ], 120_000);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests.map((r) => r.anthropicOnly)).toEqual(requests.map(() => true));
  }, 30_000);

  it("the weekly review: routed as before for a never-on account, Anthropic's only once A has been on", async () => {
    const facts = { weekStart: "2026-05-04", planned: 4, completed: 3, moved: 1, skipped: 0, totalDurationSeconds: 7200, totalDistanceMeters: 20000, sessions: { runs: 3 }, qualitySessions: 1, longRunCompleted: true, adherencePct: 75, gardenSummary: "A quiet week in the garden" };
    const routing = async (userId: string) => {
      const g = chatGateway([{ narrative: "Last week was steady." }]);
      const out = await generateWeeklyReview(db, env, userId, { weekStart: "2026-05-04", facts, units: "km" }, true, g.fetchImpl);
      expect(out.narrative).toBe("Last week was steady.");
      expect(g.bodies.length).toBe(1);
      return g.bodies[0]!.providerOptions;
    };
    const never = await seedRichAthlete(db);
    expect(await routing(never.userId)).toEqual(ORDER);
    const on = await seedRichAthlete(db);
    await switchA(on.userId, true);
    await switchA(on.userId, false);
    expect(await routing(on.userId)).toEqual(ONLY);
  }, 30_000);
});

describe("no statement more (R1.5 re-check P7)", () => {
  it("a never-on account's wake, 3-step run, read and Studio plan cost what an on account's do", async () => {
    const out: Record<string, number> = {};
    for (const on of [false, true]) {
      const { userId } = await seedRichAthlete(db);
      if (on) await switchA(userId, true);
      const prefs = await loadPreferences(db, userId);
      const tag = on ? "on" : "never";
      out[`wake.${tag}`] = await counted(() => wake(db, env, userId, prefs, { kind: "manual" }, chatGateway([briefing]).fetchImpl));
      const run = await createRun(db, userId, { scope: { kind: "now" }, request: "Something calm.", conversationId: null }, NOW);
      out[`run3.${tag}`] = await counted(() => drive(userId, run.run.id, threeTurns("Calm")));
      const actId = await anActivity(userId);
      out[`read.${tag}`] = await counted(() => ensureRead(db, env, userId, prefs, actId, { fetchImpl: chatGateway([aRead]).fetchImpl }));
      const brief = { goal: "strength", durationWeeks: 2, sessionsPerWeek: 1, preferredDays: [1], sessionMinutes: 45, equipment: "full gym", constraints: "", notes: "", startDate: "2026-09-07" };
      out[`studio.${tag}`] = await counted(() => generatePlan(env, db, userId, brief as never, [{ id: "sq-1", name: "Back Squat" }], chatGateway([{ nothing: "valid" }]).fetchImpl));
    }
    console.log("pin-holds STATEMENTS", JSON.stringify(out));
    for (const k of ["wake", "run3", "read", "studio"]) expect(out[`${k}.on`], k).toBe(out[`${k}.never`]);
  }, 120_000);
});
