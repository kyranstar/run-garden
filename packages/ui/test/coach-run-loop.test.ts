/**
 * Stage 3 Task 9 — the client step loop (use-coach-run.ts): the client is the only thing that steps a run. With the step,
 * the read, the timers and the page's visibility injected, these drive it on a clock of their own:
 *
 *  - it steps until the run waits on the athlete, and never before `nextDue`;
 *  - a 409 (another tab holds the step) backs off 1, 2, 4, 8 s and keeps reading events;
 *  - four failures in a row stop it ("lost"); Retry, or the page coming back, resumes it;
 *  - hidden, the step in flight finishes and no new one starts; visible again, it goes on;
 *  - never two step requests in flight from one tab — not even from two loops on one run;
 *  - a step's events and a poll's merge by seq, never one twice; it polls every 2 s while a step is out.
 *
 * Synthetic data only.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ApiError, type CoachRunDto, type CoachRunEventDto, type CoachRunStepResult } from "@rg/api-client";
import { CoachRunLoop, type LoopDeps } from "../src/screens/studio/use-coach-run.js";
import { MAX_FAILURES, POLL_MS } from "../src/screens/studio/run-model.js";

const T0 = Date.parse("2026-10-14T08:00:00.000Z");

const runDto = (over: Partial<CoachRunDto> = {}): CoachRunDto => ({
  id: "run-1",
  role: "main",
  scope: { kind: "now" },
  request: "hips",
  status: "active",
  steps: 0,
  costUsd: 0,
  proposalId: null,
  error: null,
  createdAt: new Date(T0).toISOString(),
  updatedAt: new Date(T0).toISOString(),
  finishedAt: null,
  estimateUsd: null,
  ceilingUsd: 1.5,
  ...over,
});

const ev = (seq: number, summary = `Line ${seq}`): CoachRunEventDto => ({ seq, kind: "note", summary, payload: null, at: new Date(T0).toISOString() });

/** A clock and timers the test advances by hand; promises settle between ticks. */
class Clock {
  now = T0;
  private timers: Array<{ at: number; fn: () => void; id: number }> = [];
  private seq = 0;
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.timers.push({ at: this.now + ms, fn, id });
    return id;
  };
  clearTimeout = (h: unknown) => {
    this.timers = this.timers.filter((t) => t.id !== h);
  };
  /** Settle what is pending: every microtask, a few rounds. */
  async flush(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }
  /** Run time forward by `ms`, firing each timer due, in order. */
  async advance(ms: number): Promise<void> {
    const until = this.now + ms;
    for (let guard = 0; guard < 500; guard++) {
      await this.flush();
      const next = this.timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) break;
      this.timers = this.timers.filter((t) => t !== next);
      this.now = next.at;
      next.fn();
    }
    this.now = until;
    await this.flush();
  }
  pending(): number {
    return this.timers.length;
  }
}

interface Script {
  /** The step's answers in turn: a result, an error, or a promise the test resolves. */
  steps: Array<CoachRunStepResult | Error | (() => Promise<CoachRunStepResult>)>;
  /** The read's answer: the run as it stands and its events after `afterSeq`. */
  read?: (afterSeq: number) => { run: CoachRunDto; events: CoachRunEventDto[] };
}

function harness(script: Script) {
  const clock = new Clock();
  let visible = true;
  let lastStatus: CoachRunStepResult["status"] = "active";
  const online = new Set<() => void>();
  const vis = new Set<() => void>();
  const calls = { steps: [] as number[], reads: [] as Array<{ at: number; afterSeq: number }>, inFlight: 0, maxInFlight: 0 };
  const deps: LoopDeps = {
    step: async () => {
      calls.steps.push(clock.now);
      calls.inFlight += 1;
      calls.maxInFlight = Math.max(calls.maxInFlight, calls.inFlight);
      try {
        const next = script.steps.shift();
        if (!next) throw new Error("the script ran out of steps");
        if (next instanceof Error) throw next;
        const res = typeof next === "function" ? await next() : next;
        lastStatus = res.status;
        return res;
      } finally {
        calls.inFlight -= 1;
      }
    },
    read: async (_id, afterSeq) => {
      calls.reads.push({ at: clock.now, afterSeq });
      // By default the server's run is as its last step left it.
      return script.read ? script.read(afterSeq) : { run: runDto({ status: lastStatus }), events: [] };
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: () => clock.now,
    visible: () => visible,
    onVisibility: (fn) => {
      vis.add(fn);
      return () => vis.delete(fn);
    },
    onOnline: (fn) => {
      online.add(fn);
      return () => online.delete(fn);
    },
  };
  const setVisible = (v: boolean) => {
    visible = v;
    for (const fn of vis) fn();
  };
  /** The browser says the network is back (`window`'s `online`). */
  const goOnline = () => {
    for (const fn of online) fn();
  };
  return { clock, deps, calls, setVisible, goOnline };
}

const step = (status: CoachRunStepResult["status"], events: CoachRunEventDto[] = [], dueInMs: number | null = 0, role: "main" | "reviewer" | "designer" = "main"): CoachRunStepResult => ({
  status,
  nextDue: dueInMs === null ? null : { runId: "run-1", role, at: new Date(T0 + dueInMs).toISOString() },
  events,
});

const loops: CoachRunLoop[] = [];
afterEach(() => {
  for (const l of loops.splice(0)) l.dispose();
});
function start(h: ReturnType<typeof harness>, seed: ConstructorParameters<typeof CoachRunLoop>[2] = { run: runDto(), events: [] }, id = "run-1") {
  const loop = new CoachRunLoop(id, h.deps, seed);
  loops.push(loop);
  loop.start();
  return loop;
}

describe("the step loop", () => {
  it("steps until the run waits on the athlete, then stops and reads the run once", async () => {
    const h = harness({
      steps: [step("active", [ev(1)]), step("active", [ev(2)]), step("waiting_athlete", [ev(3, "Hips today?")], null)],
      read: () => ({ run: runDto({ status: "waiting_athlete", costUsd: 0.04 }), events: [] }),
    });
    const loop = start(h);
    await h.clock.advance(10_000);
    expect(h.calls.steps).toHaveLength(3);
    expect(loop.snapshot.status).toBe("waiting_athlete");
    expect(loop.snapshot.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(loop.snapshot.run?.costUsd).toBe(0.04);
    expect(loop.snapshot.inFlight).toBe(false);
    // Nothing more is asked for: it waits on the athlete.
    await h.clock.advance(60_000);
    expect(h.calls.steps).toHaveLength(3);
  });

  it("an answer resumes it: the run the answer left steps again at once", async () => {
    const h = harness({ steps: [step("waiting_athlete", [], null), step("finished", [ev(2)], null)], read: () => ({ run: runDto({ status: "finished" }), events: [] }) });
    const loop = start(h);
    await h.clock.advance(1_000);
    expect(h.calls.steps).toHaveLength(1);
    loop.setRun(runDto({ status: "active" }));
    await h.clock.advance(10);
    expect(h.calls.steps).toHaveLength(2);
    expect(loop.snapshot.status).toBe("finished");
  });

  it("never steps before nextDue", async () => {
    const h = harness({ steps: [step("active", [], 20_000), step("finished", [], null)] });
    start(h);
    await h.clock.advance(19_000);
    expect(h.calls.steps).toHaveLength(1);
    await h.clock.advance(2_000);
    expect(h.calls.steps).toEqual([T0, T0 + 20_000]);
  });

  it("a 409 backs off 1, 2, 4, 8, 8 s and keeps reading the run's events", async () => {
    const busy = () => new ApiError(409, { error: "busy" });
    let seq = 0;
    const h = harness({
      steps: [busy(), busy(), busy(), busy(), busy(), step("finished", [], null)],
      // Another tab holds the step: the run reads as stepping, its lines landing.
      read: () => ({ run: runDto({ status: "stepping" }), events: [ev(++seq)] }),
    });
    const loop = start(h);
    await h.clock.advance(60_000);
    const gaps = h.calls.steps.slice(1).map((t, i) => t - h.calls.steps[i]!);
    expect(gaps).toEqual([1_000, 2_000, 4_000, 8_000, 8_000]);
    // A read after every refusal: the other tab's lines appear, in order, once each.
    expect(h.calls.reads.length).toBeGreaterThanOrEqual(5);
    expect(loop.snapshot.events.map((e) => e.seq)).toEqual([...new Set(loop.snapshot.events.map((e) => e.seq))].sort((a, b) => a - b));
    expect(loop.snapshot.status).toBe("finished");
  });

  it("four failures in a row stop it with the lost line; Retry resumes it", async () => {
    const down = () => new ApiError(503, null);
    const h = harness({ steps: [down(), new TypeError("Failed to fetch"), down(), down(), step("finished", [ev(1)], null)] });
    const loop = start(h);
    await h.clock.advance(60_000);
    expect(h.calls.steps).toHaveLength(MAX_FAILURES);
    expect(loop.snapshot.lost).toBe(true);
    const gaps = h.calls.steps.slice(1).map((t, i) => t - h.calls.steps[i]!);
    expect(gaps).toEqual([1_000, 2_000, 4_000]);
    await h.clock.advance(60_000);
    expect(h.calls.steps).toHaveLength(MAX_FAILURES);
    loop.retry();
    await h.clock.advance(10);
    expect(h.calls.steps).toHaveLength(MAX_FAILURES + 1);
    expect(loop.snapshot).toMatchObject({ lost: false, status: "finished" });
  });

  it("Retry starts the count again: one more failure backs off, it isn't lost at once", async () => {
    const down = () => new ApiError(503, null);
    const h = harness({ steps: [down(), down(), down(), down(), down(), step("finished", [], null)] });
    const loop = start(h);
    await h.clock.advance(60_000);
    expect(loop.snapshot.lost).toBe(true);
    loop.retry();
    await h.clock.advance(10);
    expect(h.calls.steps).toHaveLength(MAX_FAILURES + 1);
    expect(loop.snapshot.lost).toBe(false);
    await h.clock.advance(1_000);
    expect(h.calls.steps).toHaveLength(MAX_FAILURES + 2);
    expect(loop.snapshot.status).toBe("finished");
  });

  it("a failure after a good step starts the count again", async () => {
    const down = () => new ApiError(502, null);
    const h = harness({ steps: [down(), down(), down(), step("active", [], 0), down(), down(), down(), step("finished", [], null)] });
    const loop = start(h);
    await h.clock.advance(120_000);
    expect(h.calls.steps).toHaveLength(8);
    expect(loop.snapshot.lost).toBe(false);
    expect(loop.snapshot.status).toBe("finished");
  });

  it("hidden: the step in flight finishes, no new one starts; visible again, it goes on", async () => {
    let release!: (r: CoachRunStepResult) => void;
    const h = harness({
      steps: [() => new Promise<CoachRunStepResult>((r) => (release = r)), step("finished", [ev(2)], null)],
      read: () => ({ run: runDto({ status: "finished" }), events: [] }),
    });
    const loop = start(h);
    await h.clock.advance(10);
    expect(loop.snapshot.inFlight).toBe(true);
    h.setVisible(false);
    release(step("active", [ev(1)], 0));
    await h.clock.advance(30_000);
    expect(h.calls.steps).toHaveLength(1);
    expect(loop.snapshot.events.map((e) => e.seq)).toEqual([1]);
    h.setVisible(true);
    await h.clock.advance(10);
    expect(h.calls.steps).toHaveLength(2);
    expect(loop.snapshot.status).toBe("finished");
  });

  it("never two step requests in flight from one tab: one loop, kicked again; two loops on one run", async () => {
    let release!: (r: CoachRunStepResult) => void;
    const h = harness({
      steps: [() => new Promise<CoachRunStepResult>((r) => (release = r)), step("finished", [], null)],
      read: () => ({ run: runDto({ status: "active" }), events: [] }),
    });
    const first = start(h);
    await h.clock.advance(10);
    first.setRun(runDto({ status: "active" }));
    first.retry();
    // The screen left and came back: a second loop on the same run, while the first's step is out.
    first.dispose();
    const second = start(h);
    await h.clock.advance(30_000);
    expect(h.calls.maxInFlight).toBe(1);
    expect(h.calls.steps).toHaveLength(1);
    release(step("active", [], 0));
    await h.clock.advance(1_000);
    expect(h.calls.maxInFlight).toBe(1);
    expect(h.calls.steps).toHaveLength(2);
    expect(second.snapshot.status).toBe("finished");
  });

  it("polls the run every 2 s while a step is out, merging its events and the step's by seq", async () => {
    let release!: (r: CoachRunStepResult) => void;
    const h = harness({
      steps: [() => new Promise<CoachRunStepResult>((r) => (release = r))],
      read: (afterSeq) => ({ run: runDto({ status: "stepping", costUsd: 0.1 }), events: [ev(1), ev(2), ev(3)].filter((e) => e.seq > afterSeq).slice(0, 1) }),
    });
    const loop = start(h);
    await h.clock.advance(POLL_MS * 3 + 10);
    expect(h.calls.reads.map((r) => r.at - T0)).toEqual([POLL_MS, POLL_MS * 2, POLL_MS * 3]);
    expect(h.calls.reads.map((r) => r.afterSeq)).toEqual([0, 1, 2]);
    expect(loop.snapshot.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    // The poll's status is not the loop's while its own step is out.
    expect(loop.snapshot.status).toBe("active");
    release(step("waiting_athlete", [ev(2), ev(3), ev(4)], null));
    await h.clock.advance(10);
    expect(loop.snapshot.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    const reads = h.calls.reads.length;
    await h.clock.advance(POLL_MS * 3);
    // No step out: no polling (the one read after the step aside).
    expect(h.calls.reads.length).toBeLessThanOrEqual(reads + 1);
  });

  it("a run that is gone stops it; a run over is never stepped", async () => {
    const h = harness({ steps: [new ApiError(404, { error: "not_found" })] });
    const loop = start(h);
    await h.clock.advance(30_000);
    expect(loop.snapshot.gone).toBe(true);
    expect(h.calls.steps).toHaveLength(1);
    const h2 = harness({ steps: [] });
    start(h2, { run: runDto({ status: "finished" }) }, "run-2");
    await h2.clock.advance(30_000);
    expect(h2.calls.steps).toEqual([]);
  });

  it("live with nothing due (another request took the claim): reads, then tries again after a backoff", async () => {
    const h = harness({
      steps: [step("active", [], null), step("finished", [], null)],
      read: () => ({ run: runDto({ status: "active" }), events: [] }),
    });
    start(h);
    await h.clock.advance(5_000);
    expect(h.calls.steps).toEqual([T0, T0 + 1_000]);
  });

  it("seeded with no events (an `existing` answer), it reads the trail first: a run waiting on a question shows it and isn't stepped", async () => {
    const h = harness({
      steps: [],
      read: (afterSeq) => ({ run: runDto({ status: "waiting_athlete" }), events: afterSeq === 0 ? [ev(1), ev(2, "How are the hips today?")] : [] }),
    });
    const loop = start(h, { run: runDto({ status: "waiting_athlete" }) });
    await h.clock.advance(10_000);
    expect(h.calls.reads[0]).toEqual({ at: T0, afterSeq: 0 });
    expect(loop.snapshot.events.map((e) => e.summary)).toEqual(["Line 1", "How are the hips today?"]);
    expect(h.calls.steps).toEqual([]);
  });

  it("…and an active one is read, then stepped", async () => {
    const h = harness({
      steps: [step("finished", [ev(3)], null)],
      read: (afterSeq) => ({ run: runDto({ status: h.calls.steps.length ? "finished" : "active" }), events: afterSeq === 0 ? [ev(1), ev(2)] : [] }),
    });
    const loop = start(h, { run: runDto({ status: "active" }) });
    await h.clock.advance(1_000);
    expect(h.calls.reads[0]!.afterSeq).toBe(0);
    expect(h.calls.steps).toHaveLength(1);
    expect(loop.snapshot.events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("a read that finds the run can be stepped steps it, when nothing is scheduled or in flight (M1)", async () => {
    let status: CoachRunDto["status"] = "waiting_athlete";
    const h = harness({ steps: [step("finished", [], null)], read: () => ({ run: runDto({ status }), events: [] }) });
    const loop = start(h, { run: runDto({ status: "waiting_athlete" }), events: [ev(1)] });
    await h.clock.advance(5_000);
    expect(h.calls.steps).toEqual([]);
    // Answered from another device: the run reads active again.
    status = "active";
    await loop.refresh();
    await h.clock.advance(10);
    expect(h.calls.steps).toHaveLength(1);
    expect(loop.snapshot.status).toBe("finished");
  });

  it("a read that steps it still never steps before nextDue (M1)", async () => {
    let status: CoachRunDto["status"] = "active";
    const h = harness({ steps: [step("active", [], 20_000), step("finished", [], null)], read: () => ({ run: runDto({ status }), events: [] }) });
    const loop = start(h);
    await h.clock.advance(1_000);
    expect(h.calls.steps).toEqual([T0]);
    // Waiting a moment (its step cleared), then read active again: the step it was due still waits for its time.
    loop.setRun(runDto({ status: "waiting_athlete" }));
    status = "active";
    await loop.refresh();
    await h.clock.advance(1_000);
    expect(h.calls.steps).toEqual([T0]);
    await h.clock.advance(20_000);
    expect(h.calls.steps).toEqual([T0, T0 + 20_000]);
  });

  it("back online, a loop that isn't lost goes on as it was: no step before its time", async () => {
    const h = harness({ steps: [step("active", [], 20_000), step("finished", [], null)] });
    start(h);
    await h.clock.advance(1_000);
    h.goOnline();
    await h.clock.advance(1_000);
    expect(h.calls.steps).toEqual([T0]);
  });

  it("back online, a lost loop goes on (M2)", async () => {
    const down = () => new TypeError("Failed to fetch");
    const h = harness({ steps: [down(), down(), down(), down(), step("finished", [], null)] });
    const loop = start(h);
    await h.clock.advance(60_000);
    expect(loop.snapshot.lost).toBe(true);
    h.goOnline();
    await h.clock.advance(10);
    expect(h.calls.steps).toHaveLength(MAX_FAILURES + 1);
    expect(loop.snapshot).toMatchObject({ lost: false, status: "finished" });
  });

  it("waiting on an old loop's step, it shows the step in flight and keeps reading the trail (M3)", async () => {
    let release!: (r: CoachRunStepResult) => void;
    let seq = 0;
    const h = harness({
      steps: [() => new Promise<CoachRunStepResult>((r) => (release = r)), step("finished", [], null)],
      read: () => ({ run: runDto({ status: "stepping" }), events: [ev(++seq)] }),
    });
    const first = start(h);
    await h.clock.advance(10);
    first.dispose();
    const second = start(h);
    await h.clock.advance(10);
    expect(second.snapshot.inFlight).toBe(true);
    const before = h.calls.reads.length;
    await h.clock.advance(POLL_MS * 2 + 10);
    expect(h.calls.reads.length).toBeGreaterThanOrEqual(before + 2);
    expect(second.snapshot.events.length).toBeGreaterThanOrEqual(2);
    release(step("active", [], 0));
    await h.clock.advance(1_000);
    expect(h.calls.maxInFlight).toBe(1);
    expect(second.snapshot).toMatchObject({ inFlight: false, status: "finished" });
  });

  it("disposed, it leaves no timer and asks for nothing more", async () => {
    const h = harness({ steps: [step("active", [], 5_000), step("active", [], 0)] });
    const loop = start(h);
    await h.clock.advance(10);
    loop.dispose();
    // No timer is left behind at all, not even one that would find the loop gone.
    expect(h.clock.pending()).toBe(0);
    await h.clock.advance(60_000);
    expect(h.calls.steps).toHaveLength(1);
    expect(h.clock.pending()).toBe(0);
  });
});
