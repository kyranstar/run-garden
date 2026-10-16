/**
 * THE STEP IN A DURABLE OBJECT'S ALARM (the lead's ruling on the robustness pass, Phase 3 (d)): a closed tab can't kill a
 * step, because no client connection carries it. `POST /api/coach/runs/:id/step` arms the run's object and answers at
 * once; the object's alarm runs the existing `runStep`; every client request stamps a lease, and the alarm chains the
 * next step only while a client is watching. A retried alarm takes back its own claim at once; a dead step counts
 * against the run's ceiling at a realistic estimate, never at its worst case.
 *
 * The object runs on a fake `DurableObjectState` (its storage a map, its alarm a number) — the platform's part, firing
 * the alarm and retrying one that died, is the test's. Every model is scripted: no key, no network. Synthetic data only.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeCoachRunRoutes } from "../src/routes/coach-runs.js";
import {
  createRun,
  deadStepEstimateMicros,
  DEAD_STEP_ESTIMATE_CAP_MICROS,
  LINES,
  MAX_TAKEOVERS,
  RUN_CEILING_MICROS,
  runStep,
  STEP_BUDGET,
  type ContextBuilder,
  type RunDeps,
} from "../src/services/coach-runs.js";
import {
  CoachRunStepper,
  STEPPER_BUSY_RETRY_MS,
  STEPPER_LEASE_MS,
  STEPPER_MAX_DEATHS,
  STEPPER_TAKEBACK_GRACE_MS,
  stepTakebackAt,
  stepAlarmOn,
  type StepperAnswer,
} from "../src/services/coach-run-stepper.js";
import { COACH_RUN_STEP_STALE_MINUTES } from "../src/services/cron-limits.js";
import { StagingOutboundBlocked, uninstallStagingGuardForTests } from "../src/services/staging.js";
import type { DesignTool } from "../src/services/design-tools/types.js";
import { DESIGN_MODEL_TIMEOUT_MS, messagesCostMicros, PRICE_CEILING, type ContentBlock, type MessagesOk, type MessagesResult } from "../src/services/llm-messages.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

/** The most recent 20:00 UTC (midday for the test athlete): within the last day, which the weekly cap reads. */
const T0 = (() => {
  const d = new Date();
  d.setUTCHours(20, 0, 0, 0);
  if (d.getTime() > Date.now()) d.setUTCDate(d.getUTCDate() - 1);
  return d.getTime();
})();

const BASE_ENV = {
  APP_URL: "https://app.test",
  FIXTURE_MODE: "0",
  AI_DEFAULT_ENABLED: "1",
  COACH_DESIGNER: "1",
  SESSION_SECRET: "s",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  ALLOWED_GOOGLE_EMAIL: "runner@example.com",
  GOOGLE_CLIENT_ID: "c",
  GOOGLE_CLIENT_SECRET: "c",
} as Env;

// ── A scripted model ────────────────────────────────────────────────────

type Turn = MessagesResult | (() => MessagesResult | Promise<MessagesResult>);

let callsBegun = 0;
function scriptedModel(turns: Turn[]) {
  const model = {
    calls: 0,
    callModel: async (): Promise<MessagesResult> => {
      model.calls += 1;
      callsBegun += 1;
      const next = turns.shift();
      if (!next) throw new Error("the scripted model ran out of turns");
      return typeof next === "function" ? next() : next;
    },
  };
  return model;
}

let seq = 0;
const use = (name: string, input: unknown = {}): ContentBlock => ({ type: "tool_use", id: `toolu_s${++seq}`, name, input });
const thinking = (): ContentBlock => ({ type: "thinking", thinking: "", signature: `sig-${++seq}-${"x".repeat(40)}` });
function answer(content: ContentBlock[], stopReason: MessagesOk["stopReason"], outputTokens = 500): MessagesOk {
  const usage = { inputTokens: 1200, cacheReadTokens: 3000, cacheWriteTokens: 400, outputTokens };
  return { ok: true, model: "anthropic/claude-opus-5.5", content, stopReason, usage, costMicros: messagesCostMicros("anthropic/claude-opus-5.5", usage) };
}
const toolTurn = (...uses: ContentBlock[]) => answer([thinking(), { type: "text", text: "Looking into it." }, ...uses], "tool_use");
const finishTurn = () => toolTurn(use("finish", { summary: "Designed a short session." }));

/** A model call that never answers: the invocation holding it is killed (a deploy, an eviction) while it waits. */
function hang(begun: () => void): () => Promise<MessagesResult> {
  return () => {
    begun();
    return new Promise<MessagesResult>(() => undefined);
  };
}

function readTool(name: string): DesignTool {
  return {
    name,
    description: `Reads ${name}.`,
    inputSchema: { type: "object", properties: {} },
    statementCost: 1,
    cpuWeight: 0,
    roles: ["main", "designer", "reviewer"],
    async run(ctx) {
      await ctx.db.all(sql`select 1`);
      return { data: { found: 1 }, summary: `Read ${name}` };
    },
  };
}
function finishTool(): DesignTool {
  return {
    name: "finish",
    description: "End the run.",
    inputSchema: { type: "object" },
    statementCost: 0,
    cpuWeight: 0,
    roles: ["main", "designer", "reviewer"],
    control: "finish",
    async run(_ctx, input: { summary: string }) {
      return { data: {}, summary: input.summary };
    },
  };
}
const askTool: DesignTool = {
  name: "ask_athlete",
  description: "Ask.",
  inputSchema: { type: "object" },
  statementCost: 1,
  cpuWeight: 0,
  roles: ["main"],
  control: "ask",
  async run(ctx, input: { questions: Array<{ text: string; chips: string[] }> }) {
    await ctx.db.all(sql`select 1`);
    return { data: { questions: input.questions }, summary: input.questions[0]!.text };
  },
};
const TOOLS = [readTool("read_day"), readTool("read_plan"), finishTool(), askTool];
const askTurn = () => toolTurn(use("ask_athlete", { questions: [{ text: "Gym?", chips: [] }] }));

const testContext: ContextBuilder = {
  statementCost: 1,
  async build(db) {
    await db.all(sql`select 1`);
    return { system: [{ type: "text", text: "STABLE PRINCIPLES", cache_control: { type: "ephemeral" } }], header: "Scope: now" };
  },
};

// ── The platform's part: the object's state, its alarm, a reset ─────────

class FakeStorage {
  readonly data = new Map<string, unknown>();
  alarm: number | null = null;
  writes = 0;
  async get<T>(key: string): Promise<T | undefined> {
    const v = this.data.get(key);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  async put(key: string, value: unknown): Promise<void> {
    this.writes += 1;
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }
  async deleteAll(): Promise<void> {
    this.data.clear();
  }
  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }
  async setAlarm(at: number | Date): Promise<void> {
    this.writes += 1;
    this.alarm = typeof at === "number" ? at : at.getTime();
  }
  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}

let db: Db;
let userId: string;
let statements = 0;
let fetches = 0;
let nowMs = T0;
const clock = () => nowMs;
const advance = (ms: number) => (nowMs += ms);

beforeEach(async () => {
  nowMs = T0;
  statements = 0;
  fetches = 0;
  callsBegun = 0;
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
  ({ userId } = await makeTestUser(db));
});

const runDeps = (model: ReturnType<typeof scriptedModel>, tools: DesignTool[] = TOOLS): RunDeps => ({
  callModel: () => model.callModel(),
  buildContext: testContext,
  tools,
  clock,
});

/** One run's object as the platform keeps it: its storage outlives an instance; `kill` is a reset (a deploy). */
function stepper(runId: string, model: ReturnType<typeof scriptedModel>, env: Env = { ...BASE_ENV, COACH_STEP_ALARM: "1" } as Env) {
  const storage = new FakeStorage();
  const make = () =>
    new CoachRunStepper({ storage, id: { toString: () => runId, name: runId } } as unknown as DurableObjectState, env, {
      db,
      clock,
      deps: () => runDeps(model),
    });
  let instance = make();
  let retryPending = false;
  const tell = async (op: "arm" | "touch" | "forget", who = userId): Promise<StepperAnswer> => {
    const res = await instance.fetch(new Request(`https://coach-run-stepper/${op}`, { method: "POST", body: JSON.stringify({ runId, userId: who }) }));
    return (await res.json()) as StepperAnswer;
  };
  return {
    storage,
    arm: () => tell("arm"),
    touch: () => tell("touch"),
    tell,
    /** The platform fires the alarm that is due: during the handler, none is set unless the handler sets one. The alarm
     * it set again after an invocation that died is a retry (`alarmInfo.isRetry`); any other is not. */
    fire: async () => {
      if (storage.alarm === null || storage.alarm > nowMs) throw new Error(`no alarm due (alarm ${storage.alarm}, now ${nowMs})`);
      storage.alarm = null;
      const isRetry = retryPending;
      retryPending = false;
      await instance.alarm({ isRetry, retryCount: isRetry ? 1 : 0, scheduledTime: nowMs });
    },
    /** The invocation at work dies (a crash, an eviction): a fresh instance over the same storage, and the platform's
     * retry of the alarm it was running, `afterMs` later (none: its retries are spent). */
    kill: (retryAfterMs: number | null = 2_000) => {
      instance = make();
      retryPending = retryAfterMs !== null;
      storage.alarm = retryAfterMs === null ? null : nowMs + retryAfterMs;
    },
    /** A deploy: new requests go to a fresh instance, while the old one's invocation runs on — it touches the object's
     * storage only once its step is done (Cloudflare: in-flight requests finish if they don't access storage). */
    deploy: () => {
      instance = make();
    },
  };
}

async function newRun(costUsd = 0): Promise<string> {
  const id = (await createRun(db, userId, { scope: { kind: "now" }, request: "a short session" }, new Date(nowMs))).run.id;
  if (costUsd) await db.update(schema.coachRuns).set({ costUsd }).where(eq(schema.coachRuns.id, id));
  return id;
}
async function runRow(id: string) {
  const [row] = await db.select().from(schema.coachRuns).where(eq(schema.coachRuns.id, id));
  return row!;
}
async function trail(id: string) {
  return db.select().from(schema.coachRunEvents).where(eq(schema.coachRunEvents.runId, id)).orderBy(schema.coachRunEvents.seq);
}
async function usageRows(id: string) {
  return (await db.select().from(schema.llmUsage)).filter((u) => (u.requestFingerprint ?? "").startsWith(`run:${id}:`));
}
/** The most recent midnight in the test athlete's zone (America/Los_Angeles: helpers.ts), as an instant. */
function lastLocalMidnight(): number {
  const hour = 3_600_000;
  const format = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const top = Math.floor(Date.now() / hour) * hour;
  for (let h = 0; h < 48; h++) {
    if (format.format(new Date(top - h * hour)) === "00:00") return top - h * hour;
  }
  throw new Error("no midnight in Los Angeles in two days");
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

// ── The object ──────────────────────────────────────────────────────────

describe("the run's object: the alarm steps, a client's lease keeps it going", () => {
  it("arm, the step, chained while a client reads during it, resting when none did", async () => {
    const runId = await newRun();
    let w!: ReturnType<typeof stepper>;
    const model = scriptedModel([
      async () => {
        // A client reads while the model works: it is watching.
        advance(2_000);
        await w.touch();
        advance(2_000);
        return toolTurn(use("read_day"));
      },
      async () => {
        advance(3_000);
        return finishTurn();
      },
    ]);
    w = stepper(runId, model);

    expect(await w.arm()).toMatchObject({ armed: true });
    expect(w.storage.alarm).toBe(nowMs);
    advance(20);
    await w.fire(); // the context step: no model call, and no client read during it
    expect(model.calls).toBe(0);
    expect((await runRow(runId)).steps).toBe(1);
    expect(w.storage.alarm).toBeNull(); // nobody read since it began: it waits for one

    // A client's read: the step that is due is armed.
    advance(2_000);
    expect(await w.touch()).toMatchObject({ armed: true });
    expect(w.storage.alarm).toBe(nowMs);
    advance(20);
    await w.fire(); // the model step: read during it, so the next is chained
    expect(model.calls).toBe(1);
    expect(w.storage.alarm).not.toBeNull();
    nowMs = Math.max(nowMs, w.storage.alarm!);
    await w.fire(); // the finish: nobody read during it — and the run is over, so the object forgets it
    expect(model.calls).toBe(2);
    expect((await runRow(runId)).status).toBe("finished");
    expect(w.storage.alarm).toBeNull();
    expect(w.storage.data.size).toBe(0);
  });

  it("a client gone past the lease: an alarm finds nobody watching, and nothing is stepped", async () => {
    const runId = await newRun();
    const model = scriptedModel([]);
    const w = stepper(runId, model);
    await w.arm();
    advance(STEPPER_LEASE_MS + 1);
    await w.fire();
    expect((await runRow(runId)).steps).toBe(0);
    expect(model.calls).toBe(0);
    expect(w.storage.alarm).toBeNull();
    // Back within the lease: a read arms it again, and it steps.
    await w.touch();
    await w.fire();
    expect((await runRow(runId)).steps).toBe(1);
  });

  it("an alarm that fires with nobody watching runs nothing — not even calls the model queued, which need no model", async () => {
    const runId = await newRun();
    const six = [use("read_day"), use("read_plan"), use("read_day"), use("read_plan"), use("read_day"), use("read_plan")];
    const model = scriptedModel([async () => toolTurn(...six)]);
    const w = stepper(runId, model);
    await w.arm();
    advance(20);
    await w.fire(); // context
    await w.touch();
    advance(20);
    await w.fire(); // the model step: five calls run, the sixth queued; nobody read during it
    const before = await runRow(runId);
    expect(JSON.parse(before.state!).pending).toHaveLength(1);
    expect(w.storage.alarm).toBeNull();
    // An alarm due after the lease ran out (a retry's backoff, say): nobody is watching.
    advance(STEPPER_LEASE_MS + 1);
    w.storage.alarm = nowMs;
    await w.fire();
    const after = await runRow(runId);
    expect(after.steps).toBe(before.steps);
    expect(JSON.parse(after.state!).pending).toHaveLength(1);
    expect(model.calls).toBe(1);
  });

  it("a tab closed mid-step: the step in flight finishes, plus at most one more, then the run rests until a client is back", async () => {
    const runId = await newRun();
    let w!: ReturnType<typeof stepper>;
    const model = scriptedModel([
      async () => {
        advance(2_000);
        await w.touch(); // the tab's last read, mid-call — then it closes
        advance(30_000);
        return toolTurn(use("read_day"));
      },
      async () => {
        advance(30_000);
        return toolTurn(use("read_plan"));
      },
      async () => finishTurn(),
    ]);
    w = stepper(runId, model);
    await w.arm();
    advance(20);
    await w.fire(); // context
    await w.touch();
    advance(20);
    await w.fire(); // the step in flight when the tab closed: it finishes
    expect(model.calls).toBe(1);
    expect(w.storage.alarm).not.toBeNull();
    nowMs = Math.max(nowMs, w.storage.alarm!);
    await w.fire(); // one more
    expect(model.calls).toBe(2);
    expect(w.storage.alarm).toBeNull(); // and no more: nobody has read since it began
    expect((await runRow(runId)).status).toBe("active");

    // Opened again: its read arms the step that is due, and the run finishes.
    advance(60_000);
    await w.touch();
    await w.fire();
    expect(model.calls).toBe(3);
    expect((await runRow(runId)).status).toBe("finished");
  });

  it("a step that outlasts the lease after the last read: nothing chained, though that read came during it", async () => {
    const runId = await newRun();
    let w!: ReturnType<typeof stepper>;
    const model = scriptedModel([
      async () => {
        await w.touch(); // the last read, early in the call
        advance(STEPPER_LEASE_MS + 1_000); // a long call: the lease runs out before it ends
        return toolTurn(use("read_day"));
      },
    ]);
    w = stepper(runId, model);
    await w.arm();
    advance(20);
    await w.fire();
    await w.touch();
    advance(20);
    await w.fire();
    expect(model.calls).toBe(1);
    expect((await runRow(runId)).status).toBe("active");
    expect(w.storage.alarm).toBeNull();
  });

  it("a step it holds is never stepped twice: an arm or a read while the alarm is at work only keeps the lease", async () => {
    const runId = await newRun();
    let w!: ReturnType<typeof stepper>;
    const during: StepperAnswer[] = [];
    const model = scriptedModel([
      async () => {
        during.push(await w.arm(), await w.touch());
        return finishTurn();
      },
    ]);
    w = stepper(runId, model);
    await w.arm();
    await w.fire();
    await w.touch();
    await w.fire();
    expect(during).toEqual([
      expect.objectContaining({ armed: true, working: true }),
      expect.objectContaining({ armed: true, working: true }),
    ]);
    expect(model.calls).toBe(1);
  });

  it("a read of a run nobody asked to step arms nothing; an arm starts it; another athlete's word is refused", async () => {
    const runId = await newRun();
    const w = stepper(runId, scriptedModel([]));
    expect(await w.touch()).toMatchObject({ armed: false });
    expect(w.storage.data.size).toBe(0);
    expect(w.storage.alarm).toBeNull();
    const other = await makeTestUser(db);
    await w.arm();
    expect(await w.tell("arm", other.userId)).toMatchObject({ armed: false, refused: true });
  });

  it("a step another request holds (a claim of its own, fresh): busy — tried again shortly while a client watches, never taken", async () => {
    const runId = await newRun();
    const model = scriptedModel([]);
    const w = stepper(runId, model);
    await w.arm();
    await w.fire(); // context
    await db.update(schema.coachRuns).set({ status: "stepping", updatedAt: new Date(nowMs).toISOString() }).where(eq(schema.coachRuns.id, runId));
    advance(1_000);
    await w.touch();
    await w.fire();
    expect(model.calls).toBe(0);
    expect((await runRow(runId)).status).toBe("stepping");
    expect(w.storage.alarm).toBe(nowMs + STEPPER_BUSY_RETRY_MS);
  });

  it("the run waits for the athlete: nothing is armed until a client asks again", async () => {
    const runId = await newRun();
    const model = scriptedModel([async () => askTurn()]);
    const w = stepper(runId, model);
    await w.arm();
    await w.fire();
    await w.touch();
    await w.fire();
    expect((await runRow(runId)).status).toBe("waiting_athlete");
    expect(w.storage.alarm).toBeNull();
    expect(await w.touch()).toMatchObject({ armed: false }); // a read while it waits arms nothing
    expect(w.storage.alarm).toBeNull();
  });
});

// ── Recovery ────────────────────────────────────────────────────────────

describe("an alarm that dies mid-step (a deploy, an eviction)", () => {
  it("is retried, and the retry takes back its own claim at once — no 15-minute wait — and the run goes on", async () => {
    const runId = await newRun();
    const begun = deferred();
    const model = scriptedModel([hang(begun.resolve), finishTurn()]);
    const w = stepper(runId, model);
    await w.arm();
    await w.fire(); // context
    await w.touch();
    void w.fire().catch(() => undefined); // the model step…
    await begun.promise;
    expect((await runRow(runId)).status).toBe("stepping");
    w.kill(); // …dies with it
    advance(2_000);
    await w.fire(); // the platform's retry, 2 s later
    expect(model.calls).toBe(2);
    const row = await runRow(runId);
    expect(row.status).toBe("finished");
    expect(COACH_RUN_STEP_STALE_MINUTES * 60_000).toBeGreaterThan(2_000);
  });

  it("a retry while nobody watches takes the claim back and stops there: no model is called for nobody", async () => {
    const runId = await newRun();
    const begun = deferred();
    const model = scriptedModel([hang(begun.resolve)]);
    const w = stepper(runId, model);
    await w.arm();
    await w.fire();
    await w.touch();
    void w.fire().catch(() => undefined);
    await begun.promise;
    w.kill();
    advance(STEPPER_LEASE_MS + 1);
    w.storage.alarm = nowMs; // the platform's retry, late
    await w.fire();
    expect(model.calls).toBe(1);
    expect((await runRow(runId)).status).toBe("active");
    expect(w.storage.alarm).toBeNull();
  });

  it("anything but the platform's retry finds the step within the model's deadline: armed for its claim + the deadline + a minute, and no model is called before then (I2)", async () => {
    const runId = await newRun();
    const begun = deferred();
    const model = scriptedModel([hang(begun.resolve), finishTurn()]);
    const w = stepper(runId, model);
    await w.arm();
    await w.fire();
    await w.touch();
    const claimAt = new Date(nowMs).toISOString();
    void w.fire().catch(() => undefined);
    await begun.promise;
    w.kill(null); // no retry: a fresh instance knows nothing of how the step ended
    const takeback = stepTakebackAt(BASE_ENV, claimAt);
    expect(takeback).toBe(Date.parse(claimAt) + DESIGN_MODEL_TIMEOUT_MS + STEPPER_TAKEBACK_GRACE_MS);
    expect(DESIGN_MODEL_TIMEOUT_MS).toBe(600_000); // production's model deadline: 10 minutes, pinned
    // A client's read on the fresh instance: armed for then, not now.
    advance(5_000);
    expect(await w.touch()).toMatchObject({ armed: true, working: false });
    expect(w.storage.alarm).toBe(takeback);
    // An alarm that is no retry, before then (one set earlier, say): it arms for then and steps nothing.
    w.storage.alarm = nowMs;
    await w.fire();
    expect(w.storage.alarm).toBe(takeback);
    expect(model.calls).toBe(1);
    expect((await runRow(runId)).status).toBe("stepping");
    // Then: the claim taken back, the run goes on.
    nowMs = takeback;
    await w.touch();
    await w.fire();
    expect(model.calls).toBe(2);
    expect((await runRow(runId)).status).toBe("finished");
  });

  it("a deploy mid-step: the old invocation runs on and finishes it, and the new instance never steps it a second time (I2)", async () => {
    const runId = await newRun();
    let answer!: (r: MessagesResult) => void;
    const begun = deferred();
    const model = scriptedModel([
      () => {
        begun.resolve();
        return new Promise<MessagesResult>((r) => (answer = r));
      },
      finishTurn(),
    ]);
    const w = stepper(runId, model);
    await w.arm();
    await w.fire();
    await w.touch();
    const old = w.fire(); // the step, on the old instance
    await begun.promise;
    w.deploy();
    // The client reads on, every 2 s, from the new instance: nothing is stepped there.
    for (let i = 0; i < 30; i++) {
      advance(2_000);
      await w.touch();
    }
    expect(model.calls).toBe(1);
    expect(w.storage.alarm).toBeGreaterThan(nowMs);
    // The old call answers; its invocation finishes the step.
    answer(toolTurn(use("read_day")));
    await old;
    expect((await runRow(runId)).status).toBe("active");
    // The next step, whenever its alarm fires, is the next — not this one again.
    nowMs = Math.max(nowMs, w.storage.alarm ?? nowMs);
    await w.touch();
    if (w.storage.alarm !== null && w.storage.alarm <= nowMs) await w.fire();
    nowMs = Math.max(nowMs, w.storage.alarm ?? nowMs);
    if (w.storage.alarm !== null) await w.fire();
    expect(model.calls).toBe(2);
    expect((await runRow(runId)).status).toBe("finished");
  });

  it("dies 3 times in a row: the run fails plainly, and the model is not called a fourth time", async () => {
    const runId = await newRun();
    const begun = [deferred(), deferred(), deferred()];
    const model = scriptedModel(begun.map((b) => hang(b.resolve)));
    const w = stepper(runId, model);
    await w.arm();
    await w.fire();
    await w.touch();
    for (const b of begun) {
      void w.fire().catch(() => undefined);
      await b.promise;
      w.kill();
      advance(2_000);
    }
    await w.fire();
    expect(model.calls).toBe(MAX_TAKEOVERS);
    const row = await runRow(runId);
    expect(row).toMatchObject({ status: "failed", error: "kept_stopping" });
    expect((await trail(runId)).map((e) => e.summary)).toContain(LINES.keptStopping);
    // Three dead steps counted at their estimates, not their worst cases: it was A14, not the ceiling, that stopped it.
    expect(row.costUsd).toBeLessThanOrEqual((MAX_TAKEOVERS * DEAD_STEP_ESTIMATE_CAP_MICROS) / 1_000_000 + 1e-9);
    expect(w.storage.data.size).toBe(0);
  });

  it("a step that keeps dying: at STEPPER_MAX_DEATHS the object stops taking it back as its own — a read arms the stale window's takeover for its claim's stale time (M3)", async () => {
    const runId = await newRun();
    const model = scriptedModel([]);
    const w = stepper(runId, model);
    await w.arm();
    // The run held by a claim nobody will finish, and the object's record of it after deaths in a row.
    const claimAt = new Date(nowMs - 1_000).toISOString();
    await db.update(schema.coachRuns).set({ status: "stepping", updatedAt: claimAt }).where(eq(schema.coachRuns.id, runId));
    const record = (await w.storage.get<Record<string, unknown>>("run"))!;
    await w.storage.put("run", { ...record, step: { claimAt, startedAt: Date.parse(claimAt) }, deaths: STEPPER_MAX_DEATHS - 1 });
    w.kill(0); // the platform's retry of the last death
    await w.fire();
    expect(STEPPER_MAX_DEATHS).toBeGreaterThan(MAX_TAKEOVERS); // A14 fails a step that dies after its claim first
    expect(model.calls).toBe(0);
    expect((await runRow(runId)).status).toBe("stepping");
    // A client still reading: the takeover armed for the claim's stale time — never not at all, never every read.
    const staleAt = Date.parse(claimAt) + COACH_RUN_STEP_STALE_MINUTES * 60_000;
    advance(2_000);
    expect(await w.touch()).toMatchObject({ armed: true });
    expect(w.storage.alarm).toBe(staleAt);
    nowMs = staleAt + 1;
    await w.touch(); // the client, still reading (every 2 s while the run is at work)
    await w.fire();
    const row = await runRow(runId);
    expect(row.status).toBe("active");
    expect(row.steps).toBe(1); // taken over as a stale claim: the context step ran
  });

  it("in staging, an alarm installs the outbound guard the Worker's own requests get (an alarm is no request)", async () => {
    const runId = await newRun();
    const model = scriptedModel([]);
    const w = stepper(runId, model, { ...BASE_ENV, STAGING: "1" } as Env);
    uninstallStagingGuardForTests();
    try {
      await w.arm();
      await w.fire();
      await expect(fetch("https://api.example.com/x")).rejects.toBeInstanceOf(StagingOutboundBlocked);
    } finally {
      uninstallStagingGuardForTests();
    }
  });

  it("`forget`: the run's record and alarm gone at once; another athlete's word to forget is refused (M5)", async () => {
    const runId = await newRun();
    const w = stepper(runId, scriptedModel([]));
    await w.arm();
    const other = await makeTestUser(db);
    expect(await w.tell("forget", other.userId)).toMatchObject({ refused: true });
    expect(w.storage.data.size).toBe(1);
    expect(await w.tell("forget")).toMatchObject({ armed: false });
    expect(w.storage.data.size).toBe(0);
    expect(w.storage.alarm).toBeNull();
  });

  it("answers only its words, with a body it can read", async () => {
    const runId = await newRun();
    const storage = new FakeStorage();
    const s = new CoachRunStepper({ storage } as unknown as DurableObjectState, BASE_ENV, { db, clock });
    expect((await s.fetch(new Request("https://x/step", { method: "POST", body: JSON.stringify({ runId, userId }) }))).status).toBe(404);
    expect((await s.fetch(new Request("https://x/arm", { method: "POST", body: "{not json" }))).status).toBe(400);
    expect((await s.fetch(new Request("https://x/arm", { method: "POST", body: JSON.stringify({ runId }) }))).status).toBe(400);
    expect(storage.data.size).toBe(0);
  });

  it("a run past its window, its own step dead minutes ago: expired at once by the retry, not left behind the stale window", async () => {
    // A run for now begun five minutes before the athlete's midnight; its step dies; the retry comes two minutes after
    // midnight — the run's day is over, and the claim, six minutes old, is far from stale.
    const midnight = lastLocalMidnight();
    nowMs = midnight - 5 * 60_000;
    const runId = await newRun();
    const begun = deferred();
    const model = scriptedModel([hang(begun.resolve)]);
    const w = stepper(runId, model);
    await w.arm();
    await w.fire();
    await w.touch();
    advance(60_000);
    void w.fire().catch(() => undefined);
    await begun.promise;
    w.kill();
    nowMs = midnight + 2 * 60_000;
    expect(COACH_RUN_STEP_STALE_MINUTES * 60_000).toBeGreaterThan(nowMs - (midnight - 4 * 60_000));
    await w.touch();
    w.storage.alarm = nowMs;
    await w.fire();
    const row = await runRow(runId);
    expect(row.status).toBe("expired");
    expect(model.calls).toBe(1);
    expect(w.storage.data.size).toBe(0);
  });

  it("only its own claim: a foreign one still waits the stale window", async () => {
    const runId = await newRun();
    const model = scriptedModel([]);
    const w = stepper(runId, model);
    await w.arm();
    await w.fire();
    const foreign = new Date(nowMs - 60_000).toISOString();
    await db.update(schema.coachRuns).set({ status: "stepping", updatedAt: foreign }).where(eq(schema.coachRuns.id, runId));
    await w.touch();
    await w.fire();
    expect((await runRow(runId)).updatedAt).toBe(foreign);
    expect(model.calls).toBe(0);
  });
});

// ── A dead step's spend ─────────────────────────────────────────────────

describe("a dead step's spend: the run's ceiling counts a realistic estimate, the week its worst case", () => {
  it("the estimate: the input at the cache-write rate on a first call, the cache-read rate after; the median output so far; never over the cap", () => {
    const model = "anthropic/claude-opus-5.5";
    // No output yet: the fixed cap.
    expect(deadStepEstimateMicros(model, 30_000, { calls: 0, outputs: [] }, 2_000_000)).toBe(DEAD_STEP_ESTIMATE_CAP_MICROS);
    // After calls: the prompt read from the cache, the median output.
    const later = deadStepEstimateMicros(model, 30_000, { calls: 3, outputs: [400, 2_000, 900] }, 2_000_000);
    expect(later).toBe(messagesCostMicros(model, { inputTokens: 0, cacheReadTokens: 30_000, cacheWriteTokens: 0, outputTokens: 900 }));
    // A huge prompt: the cap.
    expect(deadStepEstimateMicros(model, 3_000_000, { calls: 1, outputs: [500] }, 9_000_000)).toBe(DEAD_STEP_ESTIMATE_CAP_MICROS);
    // Never over the call's own worst case.
    expect(deadStepEstimateMicros(model, 10, { calls: 0, outputs: [] }, 1_000)).toBe(1_000);
    // An unknown model: the ceiling's prices.
    const unknown = deadStepEstimateMicros("x/unknown", 1_000, { calls: 2, outputs: [100, 300] }, 2_000_000);
    expect(unknown).toBe(Math.ceil(1_000 * PRICE_CEILING.cacheRead + 200 * PRICE_CEILING.output));
  });

  it("one dead step can never stop a run by itself: a run past half its ceiling goes on after its takeover, the week keeps the worst case", async () => {
    // A model the price table doesn't know is priced at the ceiling's rates: its worst case is ~$1.2 for 16k tokens out.
    const env = { ...BASE_ENV, COACH_STEP_ALARM: "1", AI_DESIGN_MODEL: "x/unknown-model" } as Env;
    const runId = await newRun();
    const begun = deferred();
    const model = scriptedModel([async () => toolTurn(use("read_day")), hang(begun.resolve), finishTurn()]);
    const w = stepper(runId, model, env);
    await w.arm();
    await w.fire(); // context
    await w.touch();
    await w.fire(); // the first model call (its output, 500 tokens, is the median so far)
    await db.update(schema.coachRuns).set({ costUsd: 0.6 }).where(eq(schema.coachRuns.id, runId));
    advance(1_000); // the next step's claim is its own instant, not the last one's
    await w.touch();
    nowMs = Math.max(nowMs, w.storage.alarm ?? nowMs);
    void w.fire().catch(() => undefined);
    await begun.promise;
    const dead = (await usageRows(runId)).find((u) => u.costMicros > 1_000_000)!;
    expect(dead).toBeDefined(); // the weekly ledger's row: the worst case
    w.kill();
    advance(2_000);
    await w.fire();
    const row = await runRow(runId);
    // Taken back at the estimate its row carries — from the run's own median output so far, under the cap — then the
    // finish's own cost: under the $1.50 ceiling, the model was called again and the run finished. At the worst case it
    // would have stopped with nothing proposed.
    const estimate = Number(dead.requestFingerprint!.split(";est=")[1]);
    expect(estimate).toBeGreaterThan(0);
    expect(estimate).toBeLessThan(DEAD_STEP_ESTIMATE_CAP_MICROS);
    expect(model.calls).toBe(3);
    expect(row.status).toBe("finished");
    expect(row.error).toBeNull();
    expect(row.costUsd).toBeCloseTo(0.6 + estimate / 1_000_000 + finishTurn().costMicros / 1_000_000, 6);
    expect(0.6 + dead.costMicros / 1_000_000).toBeGreaterThan(RUN_CEILING_MICROS.now / 1_000_000);
    // The week's ledger keeps the dead call at its worst case: the $20 cap stays a hard bound.
    const after = (await usageRows(runId)).find((u) => u.id === dead.id)!;
    expect(after.costMicros).toBe(dead.costMicros);
  });

  it("a call that answered before its step died counts at what it really cost", async () => {
    const runId = await newRun();
    const model = scriptedModel([async () => finishTurn()]);
    const d = { ...runDeps(model) };
    // The step runs to its call's answer and the usage row's update, then dies before writing the run.
    const dies: RunDeps = {
      ...d,
      tools: [
        {
          ...finishTool(),
          async run() {
            throw new KilledHere();
          },
        },
      ],
    };
    const env = { ...BASE_ENV } as Env;
    await runStep(db, env, runId, userId, new Date(nowMs), d); // context
    const claimAt = new Date(nowMs + 1_000);
    const killed = runStep(db, env, runId, userId, claimAt, dies).catch(() => undefined);
    await killed;
    // (The tool threw: the step failed it plainly — so set the row back to the killed step's: stepping, its claim.)
    await db.update(schema.coachRuns).set({ status: "stepping", updatedAt: claimAt.toISOString(), costUsd: 0, error: null, finishedAt: null }).where(eq(schema.coachRuns.id, runId));
    const [settled] = (await usageRows(runId)).filter((u) => u.createdAt === claimAt.toISOString());
    expect(settled!.requestFingerprint).toBe(`run:${runId}:1`);
    const taken = await runStep(db, env, runId, userId, new Date(claimAt.getTime() + (COACH_RUN_STEP_STALE_MINUTES + 1) * 60_000), { ...d, callModel: async () => finishTurn() });
    expect(taken.kind).toBe("ok");
    expect((await runRow(runId)).costUsd).toBeGreaterThanOrEqual(settled!.costMicros / 1_000_000 - 1e-9);
  });
});

class KilledHere extends Error {}

// ── The routes ──────────────────────────────────────────────────────────

/** The namespace as the Worker sees it: one object per run id, each request to one counted as a fetch. */
function namespace(model: ReturnType<typeof scriptedModel>, env: () => Env) {
  const objects = new Map<string, { storage: FakeStorage; instance: CoachRunStepper }>();
  const object = (name: string) => {
    let o = objects.get(name);
    if (!o) {
      const storage = new FakeStorage();
      o = { storage, instance: new CoachRunStepper({ storage } as unknown as DurableObjectState, env(), { db, clock, deps: () => runDeps(model) }) };
      objects.set(name, o);
    }
    return o;
  };
  const ns = {
    idFromName: (name: string) => ({ name, toString: () => name, equals: () => false }),
    get: (id: { name: string }) => ({
      fetch: async (input: RequestInfo, init?: RequestInit) => {
        fetches += 1;
        return object(id.name).instance.fetch(input instanceof Request ? input : new Request(input, init));
      },
    }),
  };
  return { ns: ns as unknown as DurableObjectNamespace, objects, object };
}

async function routesWith(envExtra: Partial<Env>, model: ReturnType<typeof scriptedModel>, binding = true) {
  // The routes stamp with the real clock (a run's window is the athlete's local day): the object's runs on it too.
  nowMs = Date.now();
  let env!: Env;
  const space = namespace(model, () => env);
  env = { ...BASE_ENV, ...envExtra, ...(binding ? { COACH_RUN_STEPPER: space.ns } : {}) } as Env;
  const app = mountRoutes(db, "/api/coach/runs", makeCoachRunRoutes(() => runDeps(model)));
  const cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  const call = async (method: string, path: string, body?: unknown) => {
    statements = 0;
    fetches = 0;
    const res = await app.request(
      `/api/coach/runs${path}`,
      { method, headers: { Cookie: cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      env,
    );
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any>, cost: statements + fetches, fetches };
  };
  return { call, space, env };
}

describe("the routes with the switch on (COACH_STEP_ALARM = 1)", () => {
  it("is on only with the switch at 1 and the binding there", () => {
    const ns = {} as DurableObjectNamespace;
    expect(stepAlarmOn({ ...BASE_ENV, COACH_STEP_ALARM: "1", COACH_RUN_STEPPER: ns } as Env)).toBe(true);
    expect(stepAlarmOn({ ...BASE_ENV, COACH_STEP_ALARM: "0", COACH_RUN_STEPPER: ns } as Env)).toBe(false);
    expect(stepAlarmOn({ ...BASE_ENV, COACH_RUN_STEPPER: ns } as Env)).toBe(false);
    expect(stepAlarmOn({ ...BASE_ENV, COACH_STEP_ALARM: "1" } as Env)).toBe(false);
    expect(stepAlarmOn(undefined)).toBe(false);
  });

  it("POST /:id/step arms the run's object and answers at once — the model is never called in the request — with the events after afterSeq", async () => {
    const model = scriptedModel([finishTurn()]);
    const { call, space } = await routesWith({ COACH_STEP_ALARM: "1" }, model);
    const runId = await newRun();
    const res = await call("POST", `/${runId}/step?afterSeq=0`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "active", armed: true, nextDue: null, events: [] });
    expect(model.calls).toBe(0);
    expect((await runRow(runId)).steps).toBe(0);
    expect(res.fetches).toBe(1);
    expect(res.cost).toBeLessThanOrEqual(STEP_BUDGET);
    expect(res.cost).toBe(5); // sign-in 2 (the session, the restore check), the run and its events 2, the object 1
    expect(space.object(runId).storage.alarm).toBe(nowMs);

    // The alarm steps it; the next step's answer carries the events since the client's last.
    await space.object(runId).instance.alarm();
    const again = await call("POST", `/${runId}/step?afterSeq=0`);
    expect(again.body.events.map((e: { summary: string }) => e.summary)).toEqual([LINES.context]);
    expect((await call("POST", `/${runId}/step?afterSeq=${again.body.events[0].seq}`)).body.events).toEqual([]);
    expect((await call("POST", `/${runId}/step?afterSeq=x`)).status).toBe(400);
  });

  it("arms nothing for a run waiting on the athlete or over, and answers 404 for another athlete's", async () => {
    const model = scriptedModel([]);
    const { call } = await routesWith({ COACH_STEP_ALARM: "1" }, model);
    const runId = await newRun();
    await db.update(schema.coachRuns).set({ status: "waiting_athlete" }).where(eq(schema.coachRuns.id, runId));
    const waiting = await call("POST", `/${runId}/step`);
    expect(waiting.body).toMatchObject({ status: "waiting_athlete", nextDue: null });
    expect(waiting.body.armed).toBeUndefined();
    expect(waiting.fetches).toBe(0);
    await db.update(schema.coachRuns).set({ status: "finished" }).where(eq(schema.coachRuns.id, runId));
    expect((await call("POST", `/${runId}/step`)).fetches).toBe(0);
    expect((await call("POST", `/no-such-run/step`)).status).toBe(404);
  });

  it("arms only a main run: a sub-run's id is no run here (404), and nothing is armed", async () => {
    const model = scriptedModel([]);
    const { call } = await routesWith({ COACH_STEP_ALARM: "1" }, model);
    const runId = await newRun();
    const main = await runRow(runId);
    const subId = `${runId}-sub`;
    await db.insert(schema.coachRuns).values({ ...main, id: subId, parentId: runId, role: "designer", status: "active" });
    const res = await call("POST", `/${subId}/step`);
    expect(res.status).toBe(404);
    expect(res.fetches).toBe(0);
    expect((await call("GET", `/${subId}?afterSeq=0`)).fetches).toBe(0);
  });

  it("GET /:id stamps the lease (and arms a step that is due); a read of a run that is over tells the object nothing", async () => {
    const model = scriptedModel([]);
    const { call, space } = await routesWith({ COACH_STEP_ALARM: "1" }, model);
    const runId = await newRun();
    await call("POST", `/${runId}/step`);
    const o = space.object(runId);
    o.storage.alarm = null;
    advance(20);
    await o.instance.alarm(); // the context step; nobody read during it, so it waits for a read
    expect(o.storage.alarm).toBeNull();
    advance(1_000);
    const read = await call("GET", `/${runId}?afterSeq=0`);
    expect(read.status).toBe(200);
    expect(read.fetches).toBe(1);
    expect(read.cost).toBe(4); // sign-in 1 (a read: no restore check), the run and its events 2, the object 1
    expect(o.storage.alarm).toBe(nowMs);
    await db.update(schema.coachRuns).set({ status: "cancelled" }).where(eq(schema.coachRuns.id, runId));
    expect((await call("GET", `/${runId}?afterSeq=0`)).fetches).toBe(0);
  });

  it("a read whose word to the object fails still answers the read", async () => {
    const model = scriptedModel([]);
    const { call, env } = await routesWith({ COACH_STEP_ALARM: "1" }, model);
    const runId = await newRun();
    (env as { COACH_RUN_STEPPER: unknown }).COACH_RUN_STEPPER = {
      idFromName: (n: string) => ({ name: n }),
      get: () => ({ fetch: async () => { throw new Error("the object is unreachable"); } }),
    };
    const read = await call("GET", `/${runId}?afterSeq=0`);
    expect(read.status).toBe(200);
    expect(read.body.run.id).toBe(runId);
  });

  it("an answer arms the run it resumes", async () => {
    const model = scriptedModel([async () => askTurn()]);
    const { call, space } = await routesWith({ COACH_STEP_ALARM: "1" }, model);
    const runId = await newRun();
    await call("POST", `/${runId}/step`);
    const o = space.object(runId);
    for (let i = 0; i < 2; i++) {
      o.storage.alarm = null;
      await o.instance.alarm();
      await call("GET", `/${runId}?afterSeq=0`);
    }
    expect((await runRow(runId)).status).toBe("waiting_athlete");
    expect(o.storage.alarm).toBeNull();
    advance(1_000);
    const res = await call("POST", `/${runId}/answer`, { answers: ["At home"] });
    expect(res.status).toBe(200);
    expect(res.body.run.status).toBe("active");
    expect(res.fetches).toBe(1); // the object: one request more than the answer's own
    expect(res.cost - res.fetches).toBeLessThanOrEqual(7); // the answer's own statements: 7 at most, pinned (A8)
    expect(o.storage.alarm).toBe(nowMs);
  });
});

describe("a cancel (M5)", () => {
  it("tells the run's object to forget it — nothing left armed for a run that is over — for one request more than the cancel's own", async () => {
    const model = scriptedModel([]);
    const on = await routesWith({ COACH_STEP_ALARM: "1" }, model);
    const runId = await newRun();
    await on.call("POST", `/${runId}/step`);
    const o = on.space.object(runId);
    expect(o.storage.alarm).not.toBeNull();
    const cancelled = await on.call("POST", `/${runId}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.run.status).toBe("cancelled");
    expect(o.storage.data.size).toBe(0);
    expect(o.storage.alarm).toBeNull();
    expect(cancelled.fetches).toBe(1);

    const off = await routesWith({}, model);
    const other = await newRun();
    await db.update(schema.coachRuns).set({ status: "cancelled" }).where(eq(schema.coachRuns.id, runId));
    const plain = await off.call("POST", `/${other}/cancel`);
    expect(plain.fetches).toBe(0);
    expect(cancelled.cost).toBe(plain.cost + 1);
  });
});

describe("the switch off: the direct path, unchanged", () => {
  for (const [why, extra, binding] of [
    ["the switch absent", {}, true],
    ["the switch at 0", { COACH_STEP_ALARM: "0" }, true],
    ["the switch on without its binding", { COACH_STEP_ALARM: "1" }, false],
  ] as const) {
    it(`${why}: POST /:id/step steps in the request, and the object is never told`, async () => {
      const model = scriptedModel([finishTurn()]);
      const { call } = await routesWith(extra, model, binding);
      const runId = await newRun();
      const context = await call("POST", `/${runId}/step`);
      expect(context.fetches).toBe(0);
      expect(context.body).toMatchObject({ status: "active" });
      expect(context.body.armed).toBeUndefined();
      expect(context.body.events.map((e: { summary: string }) => e.summary)).toEqual([LINES.context]);
      const done = await call("POST", `/${runId}/step`);
      expect(done.body.status).toBe("finished");
      expect(model.calls).toBe(1); // the model was called in the request itself
      expect(done.fetches).toBe(0); // and no word went to an object
      expect((await call("GET", `/${runId}?afterSeq=0`)).fetches).toBe(0);
    });
  }
});

describe("what an alarm spends", () => {
  it("a model step run by the alarm stays within the request budget: the same step, without a route's sign-in", async () => {
    const runId = await newRun();
    let w!: ReturnType<typeof stepper>;
    const model = scriptedModel([async () => toolTurn(use("read_day"), use("read_plan"), use("read_day"), use("read_plan"), use("read_day"))]);
    w = stepper(runId, model);
    await w.arm();
    await w.fire();
    await w.touch();
    statements = 0;
    const before = callsBegun;
    await w.fire();
    expect(statements + (callsBegun - before)).toBeLessThanOrEqual(STEP_BUDGET);
  });
});
