/**
 * The step in the server's alarm (COACH_STEP_ALARM; the lead's ruling on the robustness pass): `POST /step` arms the
 * run's object and answers at once, `{ armed: true }`. The loop then never waits on a step: it reads the run every
 * POLL_MS while the coach is at work — each read keeps the server's lease on the run — shows the ● while it is, and
 * stops at a question or an end. With the switch off the answer isn't armed, and the loop is the one it was.
 *
 * Synthetic data only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type CoachRunDto, type CoachRunEventDto, type CoachRunStepResult } from "@rg/api-client";
import { toStepResult } from "../src/screens/studio/coach-tolerance.js";
import { browserDeps, CoachRunLoop, type LoopDeps } from "../src/screens/studio/use-coach-run.js";
import { MAX_FAILURES, POLL_MS, STEP_LOST_MS } from "../src/screens/studio/run-model.js";

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
    for (let guard = 0; guard < 5_000; guard++) {
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

type Read = { run: CoachRunDto; events: CoachRunEventDto[] } | Error;

function harness(o: { steps?: Array<CoachRunStepResult | Error>; reads: (afterSeq: number, n: number) => Read }) {
  const clock = new Clock();
  let visible = true;
  let onVisible: (() => void) | null = null;
  let onOnline: (() => void) | null = null;
  const calls = { steps: [] as Array<{ at: number; afterSeq: number | undefined }>, reads: [] as Array<{ at: number; afterSeq: number }> };
  const steps = o.steps ?? [];
  const deps: LoopDeps = {
    step: async (_id, _signal, afterSeq) => {
      calls.steps.push({ at: clock.now, afterSeq });
      const next = steps.shift() ?? armed("active");
      if (next instanceof Error) throw next;
      return next;
    },
    read: async (_id, afterSeq) => {
      calls.reads.push({ at: clock.now, afterSeq });
      const r = o.reads(afterSeq, calls.reads.length);
      if (r instanceof Error) throw r;
      return r;
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: () => clock.now,
    visible: () => visible,
    onVisibility: (fn) => {
      onVisible = fn;
      return () => (onVisible = null);
    },
    onOnline: (fn) => {
      onOnline = fn;
      return () => (onOnline = null);
    },
  };
  return {
    clock,
    deps,
    calls,
    hide: () => {
      visible = false;
      onVisible?.();
    },
    show: () => {
      visible = true;
      onVisible?.();
    },
    online: () => onOnline?.(),
  };
}

const armed = (status: CoachRunStepResult["status"], events: CoachRunEventDto[] = []): CoachRunStepResult =>
  ({ status, armed: true, nextDue: null, events }) as CoachRunStepResult;
const read = (status: CoachRunDto["status"], events: CoachRunEventDto[] = []): Read => ({ run: runDto({ status }), events });

const loops: CoachRunLoop[] = [];
afterEach(() => {
  for (const l of loops.splice(0)) l.dispose();
});
function start(h: ReturnType<typeof harness>, seed: ConstructorParameters<typeof CoachRunLoop>[2] = { run: runDto(), events: [] }) {
  const loop = new CoachRunLoop("run-1", h.deps, seed);
  loops.push(loop);
  loop.start();
  return loop;
}

describe("an armed answer: the server steps the run, the loop reads it", () => {
  it("never waits on a step: it reads every POLL_MS while the coach works, its ● shown throughout, and stops at the question", async () => {
    const statuses: CoachRunDto["status"][] = ["stepping", "active", "stepping", "stepping", "waiting_athlete"];
    const h = harness({ reads: (_a, n) => read(statuses[Math.min(n, statuses.length) - 1]!, n === 5 ? [ev(1), ev(2, "Gym?")] : []) });
    const loop = start(h);
    await h.clock.advance(1);
    expect(h.calls.steps).toHaveLength(1);
    expect(loop.snapshot).toMatchObject({ inFlight: true, status: "active" });
    for (let i = 1; i <= 4; i++) {
      await h.clock.advance(POLL_MS);
      expect(h.calls.reads).toHaveLength(i);
      expect(loop.snapshot.inFlight).toBe(true); // between the server's steps too: the coach is at work
    }
    await h.clock.advance(POLL_MS);
    expect(loop.snapshot).toMatchObject({ inFlight: false, status: "waiting_athlete" });
    expect(loop.snapshot.events.map((e) => e.seq)).toEqual([1, 2]);
    // Nothing more: no step, no read, while it waits for the athlete.
    await h.clock.advance(60_000);
    expect(h.calls.steps).toHaveLength(1);
    expect(h.calls.reads).toHaveLength(5);
  });

  it("each read asks after the last seq held, and so does the step that arms it", async () => {
    let seq = 0;
    const h = harness({ steps: [armed("active", [ev(1)])], reads: () => read(seq < 2 ? "stepping" : "finished", [ev(++seq + 1)]) });
    const loop = start(h, { run: runDto(), events: [] });
    await h.clock.advance(1);
    expect(h.calls.steps[0]!.afterSeq).toBe(0);
    await h.clock.advance(POLL_MS * 4);
    expect(h.calls.reads.map((r) => r.afterSeq)).toEqual([1, 2, 3]);
    expect(loop.snapshot).toMatchObject({ status: "finished", inFlight: false });
    expect(loop.snapshot.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it("over: the loop stops, and the run is never stepped again", async () => {
    const h = harness({ reads: (_a, n) => read(n < 2 ? "stepping" : "finished") });
    const loop = start(h);
    await h.clock.advance(POLL_MS * 3);
    expect(loop.snapshot).toMatchObject({ status: "finished", inFlight: false });
    const reads = h.calls.reads.length;
    await h.clock.advance(5 * 60_000);
    expect(h.calls.steps).toHaveLength(1);
    expect(h.calls.reads).toHaveLength(reads);
  });

  it("steppable and not at work for STEP_LOST_MS (the server's chain stopped): armed again — once, not every read", async () => {
    const h = harness({ reads: () => read("active") });
    start(h);
    // The first read that found it quiet is at POLL_MS; STEP_LOST_MS after it, the next read arms it again.
    await h.clock.advance(STEP_LOST_MS);
    expect(h.calls.steps).toHaveLength(1);
    await h.clock.advance(POLL_MS * 2);
    expect(h.calls.steps).toHaveLength(2);
    await h.clock.advance(POLL_MS * 3);
    expect(h.calls.steps).toHaveLength(2);
  });

  it("a long step the reads find at work is waited on: never armed again, and its time is counted from the first read that found it", async () => {
    const h = harness({ reads: () => read("stepping") });
    const loop = start(h);
    await h.clock.advance(POLL_MS);
    expect(loop.snapshot.workingSince).toBe(T0 + POLL_MS);
    await h.clock.advance(8 * 60_000);
    expect(h.calls.steps).toHaveLength(1);
    expect(loop.snapshot.workingSince).toBe(T0 + POLL_MS);
  });

  it("a server step's time starts again with each step: `workingSince` is the step at work's, never the run's", async () => {
    const statuses: CoachRunDto["status"][] = ["stepping", "stepping", "active", "stepping"];
    const h = harness({ reads: (_a, n) => read(statuses[Math.min(n, statuses.length) - 1]!) });
    const loop = start(h);
    await h.clock.advance(POLL_MS * 2);
    expect(loop.snapshot.workingSince).toBe(T0 + POLL_MS);
    await h.clock.advance(POLL_MS);
    expect(loop.snapshot.workingSince).toBeNull();
    await h.clock.advance(POLL_MS);
    expect(loop.snapshot.workingSince).toBe(T0 + 4 * POLL_MS);
  });

  it("reads that fail MAX_FAILURES in a row: lost, said, the ● kept (the server may still be at work); a read that works: not lost", async () => {
    let down = true;
    const h = harness({ reads: () => (down ? new TypeError("Failed to fetch") : read("stepping")) });
    const loop = start(h);
    await h.clock.advance(POLL_MS * MAX_FAILURES);
    expect(loop.snapshot).toMatchObject({ lost: true, inFlight: true });
    down = false;
    await h.clock.advance(POLL_MS);
    expect(loop.snapshot).toMatchObject({ lost: false, inFlight: true, status: "stepping" });
  });

  it("the network back: armed again at once", async () => {
    const h = harness({ reads: () => new TypeError("Failed to fetch") });
    const loop = start(h);
    await h.clock.advance(POLL_MS * MAX_FAILURES);
    expect(loop.snapshot.lost).toBe(true);
    h.online();
    await h.clock.advance(1);
    expect(h.calls.steps).toHaveLength(2);
    expect(loop.snapshot.lost).toBe(false);
  });

  it("hidden, it reads nothing — the server's lease runs out and the coach rests; visible again, the reads go on", async () => {
    const h = harness({ reads: () => read("stepping") });
    start(h);
    await h.clock.advance(POLL_MS);
    expect(h.calls.reads).toHaveLength(1);
    h.hide();
    await h.clock.advance(5 * 60_000);
    expect(h.calls.reads).toHaveLength(1);
    h.show();
    await h.clock.advance(POLL_MS);
    expect(h.calls.reads).toHaveLength(2);
  });

  it("disposed (the app closed): nothing more is asked", async () => {
    const h = harness({ reads: () => read("stepping") });
    const loop = start(h);
    await h.clock.advance(POLL_MS);
    loop.dispose();
    await h.clock.advance(60_000);
    expect(h.calls.reads).toHaveLength(1);
    expect(h.calls.steps).toHaveLength(1);
  });

  it("an answer the athlete sends (setRun) resumes it: the trail read, then armed again", async () => {
    let status: CoachRunDto["status"] = "waiting_athlete";
    const h = harness({ reads: () => read(status) });
    const loop = start(h);
    await h.clock.advance(POLL_MS);
    expect(loop.snapshot).toMatchObject({ status: "waiting_athlete", inFlight: false });
    status = "active";
    loop.setRun(runDto({ status: "active" }));
    await h.clock.advance(1);
    expect(h.calls.steps).toHaveLength(2);
    expect(loop.snapshot).toMatchObject({ inFlight: true });
  });

  it("a cancel while armed: the ● goes, nothing more is read", async () => {
    const h = harness({ reads: () => read("stepping") });
    const loop = start(h);
    await h.clock.advance(POLL_MS);
    loop.setRun(runDto({ status: "cancelled" }));
    await h.clock.advance(1);
    expect(loop.snapshot).toMatchObject({ status: "cancelled", inFlight: false });
    const reads = h.calls.reads.length;
    await h.clock.advance(60_000);
    expect(h.calls.reads).toHaveLength(reads);
  });

  it("an armed answer for a run that waits or is over by then: nothing to watch", async () => {
    const h = harness({ steps: [armed("waiting_athlete")], reads: () => read("waiting_athlete") });
    const loop = start(h);
    await h.clock.advance(POLL_MS * 3);
    expect(loop.snapshot).toMatchObject({ status: "waiting_athlete", inFlight: false });
    expect(h.calls.steps).toHaveLength(1);
    expect(h.calls.reads).toHaveLength(1); // one read, for its figures — and no watch
  });
});

describe("the wire", () => {
  it("an armed answer is read as one; anything else is not", () => {
    expect(toStepResult({ status: "active", armed: true, nextDue: null, events: [] })).toEqual({ status: "active", armed: true, nextDue: null, events: [] });
    expect(toStepResult({ status: "active", armed: "yes", nextDue: null, events: [] })).toEqual({ status: "active", nextDue: null, events: [] });
    expect(toStepResult({ status: "active", nextDue: null, events: [] })).toEqual({ status: "active", nextDue: null, events: [] });
  });

  it("the step request carries the last seq held (afterSeq), and the page's deps hand it on", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string) => {
        urls.push(String(input));
        return Promise.resolve(new Response(JSON.stringify(armed("active")), { status: 200, headers: { "content-type": "application/json" } }));
      }),
    );
    try {
      await api.coachRunStep("run-1", undefined, 7);
      await browserDeps().step("run-1", new AbortController().signal, 9);
      await api.coachRunStep("run-1");
      expect(urls[0]).toMatch(/\/api\/coach\/runs\/run-1\/step\?afterSeq=7$/);
      expect(urls[1]).toMatch(/\/api\/coach\/runs\/run-1\/step\?afterSeq=9$/);
      expect(urls[2]).toMatch(/\/api\/coach\/runs\/run-1\/step$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
