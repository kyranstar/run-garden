/**
 * The robustness pass (2026-10-16) — the step loop never stalls a run and never freezes its ●:
 *
 *  - an answer it can't read is a failure like any other: no step shown in flight for good, the run stepped again on
 *    the backoff (it was: `res.events` missing threw inside the loop, the ● stayed, nothing more was asked);
 *  - lost (MAX_FAILURES in a row) it says so — and keeps trying by itself, once every LOST_RETRY_MS, so a passing
 *    outage never stalls a run the athlete isn't looking at;
 *  - a step whose answer is lost (the reads find the run not stepping for STEP_LOST_MS) is given up — its request
 *    aborted — and the run stepped again; a long step the reads find at work, or one the reads can't see, never is;
 *  - `workingSince`: since when a step has been at work — its own start, or the first read that found another
 *    request's step at work.
 *
 * Synthetic data only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, type CoachRunDto, type CoachRunEventDto, type CoachRunStepResult } from "@rg/api-client";
import { browserDeps, CoachRunLoop, type LoopDeps } from "../src/screens/studio/use-coach-run.js";
import { LOST_RETRY_MS, MAX_FAILURES, POLL_MS, STEP_LOST_MS } from "../src/screens/studio/run-model.js";

const T0 = Date.parse("2026-10-16T08:00:00.000Z");

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
  async flush(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }
  async advance(ms: number): Promise<void> {
    const until = this.now + ms;
    for (let guard = 0; guard < 2_000; guard++) {
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
}

interface Script {
  steps: Array<CoachRunStepResult | Error | null | ((signal?: AbortSignal) => Promise<CoachRunStepResult>)>;
  read?: (afterSeq: number) => { run: CoachRunDto; events: CoachRunEventDto[] };
}

function harness(script: Script) {
  const clock = new Clock();
  const calls = { steps: [] as number[], signals: [] as Array<AbortSignal | undefined>, reads: 0 };
  const deps: LoopDeps = {
    step: async (_id, signal) => {
      calls.steps.push(clock.now);
      calls.signals.push(signal);
      const next = script.steps.shift();
      if (next === undefined) throw new Error("the script ran out of steps");
      if (next instanceof Error) throw next;
      // A body the loop can't read (null): it must not stop the loop.
      if (next === null) return null as unknown as CoachRunStepResult;
      return typeof next === "function" ? next(signal) : next;
    },
    read: async (_id, afterSeq) => {
      calls.reads += 1;
      return script.read ? script.read(afterSeq) : { run: runDto({ status: "active" }), events: [] };
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: () => clock.now,
    visible: () => true,
    onVisibility: () => () => undefined,
  };
  return { clock, deps, calls };
}

const step = (status: CoachRunStepResult["status"], events: CoachRunEventDto[] = [], dueInMs: number | null = 0): CoachRunStepResult => ({
  status,
  nextDue: dueInMs === null ? null : { runId: "run-1", role: "main", at: new Date(T0 + dueInMs).toISOString() },
  events,
});

/** A step that answers only when aborted (it never answers on its own): the request whose answer was lost. */
const lostStep = () => (signal?: AbortSignal) =>
  new Promise<CoachRunStepResult>((_, reject) => signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));

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

describe("the step loop never stalls", () => {
  it("an answer it can't read is a failure: no step left in flight, the run stepped again on the backoff", async () => {
    // A cut-off body: no events (the old loop threw merging them), then one that isn't an answer at all.
    const h = harness({ steps: [{ status: "active", nextDue: null } as unknown as CoachRunStepResult, null, step("finished", [ev(1)], null)] });
    const loop = start(h);
    await h.clock.advance(10_000);
    expect(loop.snapshot.inFlight).toBe(false);
    expect(h.calls.steps.length).toBe(3);
    expect(loop.snapshot).toMatchObject({ status: "finished", lost: false });
    expect(loop.snapshot.events.map((e) => e.seq)).toEqual([1]);
  });

  it("lost: it says so, and keeps trying by itself every LOST_RETRY_MS — a passing outage never stalls the run", async () => {
    const down = () => new ApiError(502, null);
    const h = harness({ steps: [down(), down(), down(), down(), down(), step("finished", [ev(1)], null)] });
    const loop = start(h);
    await h.clock.advance(10_000);
    expect(h.calls.steps).toHaveLength(MAX_FAILURES);
    expect(loop.snapshot.lost).toBe(true);
    const lostAt = h.calls.steps.at(-1)!;
    // Not before its time; then once, still failing: still lost, the next try a minute on.
    await h.clock.advance(lostAt + LOST_RETRY_MS - h.clock.now - 1);
    expect(h.calls.steps).toHaveLength(MAX_FAILURES);
    await h.clock.advance(1);
    expect(h.calls.steps).toHaveLength(MAX_FAILURES + 1);
    expect(loop.snapshot.lost).toBe(true);
    // The next works: it goes on, no longer lost.
    await h.clock.advance(LOST_RETRY_MS);
    expect(h.calls.steps).toHaveLength(MAX_FAILURES + 2);
    expect(loop.snapshot).toMatchObject({ lost: false, status: "finished" });
  });

  it("a step whose answer is lost (the run reads as not stepping for STEP_LOST_MS) is given up, its request aborted, and asked again", async () => {
    const h = harness({ steps: [lostStep(), step("finished", [ev(1)], null)], read: () => ({ run: runDto({ status: "active" }), events: [] }) });
    const loop = start(h);
    await h.clock.advance(STEP_LOST_MS - POLL_MS);
    expect(h.calls.steps).toHaveLength(1);
    expect(loop.snapshot.inFlight).toBe(true);
    await h.clock.advance(POLL_MS * 3);
    expect(h.calls.signals[0]?.aborted).toBe(true);
    // Given up: a failure like any other, the run stepped again on the backoff.
    await h.clock.advance(2_000);
    expect(h.calls.steps).toHaveLength(2);
    expect(loop.snapshot).toMatchObject({ inFlight: false, status: "finished" });
  });

  it("a long step the reads find at work is never given up", async () => {
    let release!: (r: CoachRunStepResult) => void;
    const h = harness({
      steps: [() => new Promise<CoachRunStepResult>((r) => (release = r)), step("finished", [], null)],
      read: () => ({ run: runDto({ status: "stepping" }), events: [] }),
    });
    const loop = start(h);
    await h.clock.advance(8 * 60_000);
    expect(h.calls.steps).toHaveLength(1);
    expect(h.calls.signals[0]?.aborted).toBe(false);
    expect(loop.snapshot.inFlight).toBe(true);
    release(step("finished", [ev(1)], null));
    await h.clock.advance(10);
    expect(loop.snapshot).toMatchObject({ inFlight: false, status: "finished" });
  });

  it("a step out while the reads can't reach the server (offline) is never given up on their word", async () => {
    let release!: (r: CoachRunStepResult) => void;
    const h = harness({
      steps: [() => new Promise<CoachRunStepResult>((r) => (release = r))],
      read: () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const loop = start(h);
    await h.clock.advance(5 * 60_000);
    expect(h.calls.steps).toHaveLength(1);
    expect(h.calls.signals[0]?.aborted).toBe(false);
    release(step("waiting_athlete", [], null));
    await h.clock.advance(10);
    expect(loop.snapshot.inFlight).toBe(false);
  });

  it("the step goes on once the reads find it at work again: only a stretch of STEP_LOST_MS with none counts", async () => {
    let release!: (r: CoachRunStepResult) => void;
    let n = 0;
    // Not stepping for 40 s, stepping once, then not stepping again for 40 s: never STEP_LOST_MS in a row.
    const h = harness({
      steps: [() => new Promise<CoachRunStepResult>((r) => (release = r))],
      read: () => ({ run: runDto({ status: ++n === 21 ? "stepping" : "active" }), events: [] }),
    });
    start(h);
    await h.clock.advance(82_000);
    expect(h.calls.signals[0]?.aborted).toBe(false);
    release(step("finished", [], null));
    await h.clock.advance(10);
  });

  it("waiting on an old loop's step whose answer is lost: given up too — aborted, and the run stepped, even if that request never settles", async () => {
    // The old loop's request never settles, aborted or not: only giving up on it lets the new loop go on.
    const h = harness({ steps: [() => new Promise<CoachRunStepResult>(() => undefined), step("finished", [ev(1)], null)], read: () => ({ run: runDto({ status: "active" }), events: [] }) });
    const first = start(h);
    await h.clock.advance(10);
    first.dispose();
    const second = start(h);
    await h.clock.advance(STEP_LOST_MS + POLL_MS * 2);
    expect(h.calls.signals[0]?.aborted).toBe(true);
    await h.clock.advance(5_000);
    expect(h.calls.steps).toHaveLength(2);
    expect(second.snapshot).toMatchObject({ inFlight: false, status: "finished" });
  });
});

describe("the step request the loop gives up on", () => {
  it("is aborted: the api client hands the loop's signal to the request (with its own deadline beside it)", async () => {
    let sent: AbortSignal | undefined;
    const fetchStub = vi.fn((_input: string, init?: RequestInit) => {
      sent = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });
    vi.stubGlobal("fetch", fetchStub);
    try {
      const controller = new AbortController();
      void api.coachRunStep("run-1", controller.signal).catch(() => undefined);
      expect(fetchStub).toHaveBeenCalledTimes(1);
      expect(fetchStub.mock.calls[0]![1]).toMatchObject({ method: "POST", body: "{}" });
      expect(sent?.aborted).toBe(false);
      controller.abort();
      expect(sent?.aborted).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("the page's own deps hand the loop's signal on (browserDeps)", async () => {
    let sent: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string, init?: RequestInit) => {
        sent = init?.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      }),
    );
    try {
      const controller = new AbortController();
      void browserDeps().step("run-1", controller.signal).catch(() => undefined);
      await Promise.resolve();
      controller.abort();
      expect(sent?.aborted).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("workingSince: since when a step has been at work", () => {
  it("its own step's start; none once it answered", async () => {
    let release!: (r: CoachRunStepResult) => void;
    let status: CoachRunDto["status"] = "stepping";
    const h = harness({
      steps: [() => new Promise<CoachRunStepResult>((r) => (release = r))],
      read: () => ({ run: runDto({ status }), events: [] }),
    });
    const loop = start(h);
    await h.clock.advance(30_000);
    expect(loop.snapshot.workingSince).toBe(T0);
    status = "waiting_athlete";
    release(step("waiting_athlete", [], null));
    await h.clock.advance(10);
    expect(loop.snapshot.workingSince).toBeNull();
  });

  it("another request's step: from the first read that found the run stepping, kept while it is", async () => {
    let status: CoachRunDto["status"] = "stepping";
    const h = harness({
      steps: [new ApiError(409, { error: "busy" }), new ApiError(409, { error: "busy" }), step("finished", [], null)],
      read: () => ({ run: runDto({ status }), events: [] }),
    });
    const loop = start(h);
    await h.clock.advance(10);
    expect(loop.snapshot).toMatchObject({ inFlight: false, status: "stepping", workingSince: T0 });
    await h.clock.advance(1_500);
    expect(loop.snapshot.workingSince).toBe(T0);
    status = "active";
    await h.clock.advance(5_000);
    expect(loop.snapshot.workingSince).toBeNull();
  });
});
