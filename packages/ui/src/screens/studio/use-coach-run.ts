/**
 * THE CLIENT STEP LOOP (Stage 3 spec §2; Task 9). The client is the only thing that steps a run — the hourly sweep never
 * calls the model — so while the run can be stepped and the page is visible, this asks for one step at a time:
 *
 *  - It steps again when the step's `nextDue` says so, never before it (correctness M9); a backoff after a refusal or a
 *    failure applies on top.
 *  - A 409 (another tab or device holds the step): back off at 1, 2, 4, 8 s — capped at 8 — and keep reading events.
 *  - A network error or a 5xx: the same backoff; after MAX_FAILURES in a row it stops and says so (`lost`), with Retry.
 *  - It stops on `waiting_athlete` and on every status that is over; the athlete's answer resumes it.
 *  - Hidden: the step in flight finishes, no new one starts; visible again, it goes on.
 *  - Never two step requests in flight from one tab: one at a time per loop, and per run across the tab (`IN_FLIGHT`) —
 *    a loop mounted again while an old one's step is still out waits for it.
 *  - Events: each step's response carries its own; while a step is in flight the run is also read every POLL_MS, so a
 *    long step's sub-runs' lines appear as they land. Merged by `seq`, never one twice.
 *
 * Testable without a browser: `fetch` (the step and the read), the timers and the page's visibility are injected
 * (`LoopDeps`); the decisions are run-model.ts's.
 */
import { useEffect, useRef, useState } from "react";
import { api, type CoachRunDto, type CoachRunEventDto, type CoachRunRole, type CoachRunStatus, type CoachRunStepResult } from "@rg/api-client";
import { backoffMs, isLive, isSteppable, lastSeq, MAX_FAILURES, mergeEvents, POLL_MS, stepDelay, stepErrorKind } from "./run-model.js";

export interface LoopDeps {
  step: (id: string) => Promise<CoachRunStepResult>;
  read: (id: string, afterSeq: number) => Promise<{ run: CoachRunDto; events: CoachRunEventDto[] }>;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
  /** Whether the page is visible (`document.visibilityState`). */
  visible: () => boolean;
  /** Called on every visibility change; answers the unsubscribe. */
  onVisibility: (fn: () => void) => () => void;
  /** Called when the browser says the network is back (`window`'s `online`); answers the unsubscribe. */
  onOnline?: (fn: () => void) => () => void;
}

/** The page's own: the api client, the window's timers, the document's visibility and the window's network. */
export function browserDeps(): LoopDeps {
  const doc = typeof document === "undefined" ? null : document;
  const win = typeof window === "undefined" ? null : window;
  return {
    step: (id) => api.coachRunStep(id),
    read: (id, afterSeq) => api.coachRun(id, afterSeq),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    visible: () => !doc || doc.visibilityState !== "hidden",
    onVisibility: (fn) => {
      if (!doc) return () => undefined;
      doc.addEventListener("visibilitychange", fn);
      return () => doc.removeEventListener("visibilitychange", fn);
    },
    onOnline: (fn) => {
      if (!win) return () => undefined;
      win.addEventListener("online", fn);
      return () => win.removeEventListener("online", fn);
    },
  };
}

export interface LoopSnapshot {
  run: CoachRunDto | null;
  /** What the loop knows of the run's status: the last step's, or the last read's when no step is out. */
  status: CoachRunStatus;
  events: CoachRunEventDto[];
  /** A step request is out. */
  inFlight: boolean;
  /** Who the next step is for (the last step's `nextDue.role`): the header says "reviewing" for a reviewer. */
  dueRole: CoachRunRole | null;
  /** MAX_FAILURES failures in a row: stopped until Retry (or the page comes back). */
  lost: boolean;
  /** The run is gone (404). */
  gone: boolean;
}

/** Step requests out in this tab, by run: a second loop on the same run waits for the first's. */
const IN_FLIGHT = new Map<string, Promise<unknown>>();

export class CoachRunLoop {
  private snap: LoopSnapshot;
  private stepTimer: unknown = null;
  private pollTimer: unknown = null;
  private polling = false;
  private failures = 0;
  private busy = 0;
  private idle = 0;
  private nextDueAt: number | null = null;
  /** A step came due while the page was hidden: take it when it is visible again. */
  private owed = false;
  private disposed = false;
  private unsubscribe: (() => void) | null = null;
  private listeners = new Set<(s: LoopSnapshot) => void>();
  /** The seed carried the run's trail (`events`, even none): no read is needed before the first step. */
  private readonly trailKnown: boolean;

  constructor(
    readonly runId: string,
    private readonly deps: LoopDeps,
    seed: { run?: CoachRunDto | null; events?: CoachRunEventDto[]; status?: CoachRunStatus } = {},
  ) {
    this.trailKnown = seed.events !== undefined;
    this.snap = {
      run: seed.run ?? null,
      status: seed.status ?? seed.run?.status ?? "active",
      events: mergeEvents([], seed.events ?? []),
      inFlight: false,
      dueRole: null,
      lost: false,
      gone: false,
    };
  }

  get snapshot(): LoopSnapshot {
    return this.snap;
  }

  subscribe(fn: (s: LoopSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Start stepping (when the run can be stepped) and following the page's visibility and the network. */
  start(): void {
    if (this.disposed) return;
    const offVisibility = this.deps.onVisibility(() => this.visibilityChanged());
    const offOnline = this.deps.onOnline?.(() => this.cameOnline()) ?? (() => undefined);
    this.unsubscribe = () => {
      offVisibility();
      offOnline();
    };
    // Seeded without its trail (an `existing` answer: the run as it stands, its events unknown): read it first — a
    // question it waits on shows — and the read steps a run that can be stepped (M1). Seeded with it (the current run's
    // read; a new run, which has none yet): step at once.
    if (!this.trailKnown) void this.read(true);
    else this.schedule(0);
  }

  /** Stop: no timer left, nothing more asked; a step already out is left to finish, its answer unread. */
  dispose(): void {
    this.disposed = true;
    this.clearStep();
    this.clearPoll();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listeners.clear();
  }

  /** Retry after the loop lost the connection: from the start, now. */
  retry(): void {
    this.failures = 0;
    this.set({ lost: false });
    this.schedule(0);
  }

  /**
   * The run as another request answered it (an answer, a skip, a logged check, a cancel): its status is the loop's now.
   * A run that can be stepped again (an answer resumed it) has its trail read first — after the last seq held — so the
   * line the answer wrote ("You answered…", its Undo) shows now: a step that returns within the poll would leave it
   * behind the step's own seqs, where no later read looks (fix wave 3B, B-I2). The read then steps it.
   */
  setRun(run: CoachRunDto): void {
    this.set({ run, status: run.status });
    this.clearStep();
    if (isSteppable(run.status)) {
      this.nextDueAt = null;
      void this.read(true);
    }
  }

  /** Read the run's newest events and its figures (after an undo, a refused answer). */
  async refresh(): Promise<void> {
    await this.read(true);
  }

  // ── Inside ──

  private set(patch: Partial<LoopSnapshot>): void {
    if (this.disposed) return;
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn(this.snap);
  }

  private clearStep(): void {
    if (this.stepTimer !== null) this.deps.clearTimeout(this.stepTimer);
    this.stepTimer = null;
  }

  private clearPoll(): void {
    if (this.pollTimer !== null) this.deps.clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private schedule(ms: number): void {
    if (this.disposed) return;
    this.clearStep();
    this.stepTimer = this.deps.setTimeout(() => {
      this.stepTimer = null;
      void this.tick();
    }, Math.max(0, ms));
  }

  /** The network is back: a loop that lost the connection goes on (M2). */
  private cameOnline(): void {
    if (!this.disposed && this.snap.lost) this.retry();
  }

  /** A run that can be stepped, with nothing scheduled and no step out, is stepped (never before its nextDue): M1. */
  private stepIfIdle(): void {
    if (this.disposed || this.snap.lost || this.snap.gone || this.snap.inFlight || this.stepTimer !== null) return;
    if (isSteppable(this.snap.status)) this.schedule(stepDelay({ nextDueAt: this.nextDueAt, now: this.deps.now(), backoff: 0 }));
  }

  private visibilityChanged(): void {
    if (this.disposed || !this.deps.visible()) return;
    // Back in view: a step owed while hidden goes now (still never before its nextDue); a lost loop tries again.
    if (this.snap.lost) return this.retry();
    if (this.owed && this.stepTimer === null && !this.snap.inFlight) {
      this.owed = false;
      this.schedule(stepDelay({ nextDueAt: this.nextDueAt, now: this.deps.now(), backoff: 0 }));
    }
  }

  private async tick(): Promise<void> {
    if (this.disposed || this.snap.inFlight || this.snap.lost || this.snap.gone) return;
    if (!isSteppable(this.snap.status)) return;
    if (!this.deps.visible()) {
      this.owed = true;
      return;
    }
    // Another loop of this tab on this run still has a step out (the screen was left and opened again): wait for it — a
    // step in flight all the same, its lines read as they land (M3) — then read where it left the run.
    const other = IN_FLIGHT.get(this.runId);
    if (other) {
      this.set({ inFlight: true });
      this.startPoll();
      await other.catch(() => undefined);
      this.clearPoll();
      if (this.disposed) return;
      this.set({ inFlight: false });
      await this.read(true);
      return;
    }
    await this.step();
  }

  private async step(): Promise<void> {
    this.set({ inFlight: true });
    this.startPoll();
    const out = this.deps.step(this.runId);
    IN_FLIGHT.set(this.runId, out);
    let res: CoachRunStepResult;
    try {
      res = await out;
    } catch (e) {
      this.clearPoll();
      this.set({ inFlight: false });
      return this.failed(e);
    } finally {
      if (IN_FLIGHT.get(this.runId) === out) IN_FLIGHT.delete(this.runId);
    }
    this.clearPoll();
    if (this.disposed) return;
    this.failures = 0;
    this.busy = 0;
    this.nextDueAt = res.nextDue ? Date.parse(res.nextDue.at) : null;
    this.set({
      inFlight: false,
      status: res.status,
      events: mergeEvents(this.snap.events, res.events),
      dueRole: res.nextDue?.role ?? null,
    });
    if (isSteppable(res.status)) {
      if (res.nextDue) {
        this.idle = 0;
        this.schedule(stepDelay({ nextDueAt: this.nextDueAt, now: this.deps.now(), backoff: 0 }));
      } else {
        // Live, with nothing due now (another request took the claim): look again after a while — scheduled first, so
        // the read doesn't step at once — unless the read finds the run waiting or over.
        this.idle += 1;
        this.schedule(backoffMs(this.idle));
        await this.read(true);
        if (!isSteppable(this.snap.status)) this.clearStep();
      }
    } else {
      // Waiting on the athlete, or over: one read for the run's figures and anything the step left unsaid.
      await this.read(true);
    }
  }

  private async failed(e: unknown): Promise<void> {
    if (this.disposed) return;
    const kind = stepErrorKind(e);
    if (kind === "gone") return this.set({ gone: true });
    if (kind === "busy") {
      // Another tab or device is stepping: try again after the backoff (scheduled first, so the read doesn't step at
      // once), and read what it has written meanwhile — a run it left waiting or over isn't stepped.
      this.busy += 1;
      this.schedule(stepDelay({ nextDueAt: this.nextDueAt, now: this.deps.now(), backoff: backoffMs(this.busy) }));
      await this.read(true);
      if (!isSteppable(this.snap.status)) this.clearStep();
      return;
    }
    this.failures += 1;
    if (this.failures >= MAX_FAILURES) return this.set({ lost: true });
    this.schedule(stepDelay({ nextDueAt: this.nextDueAt, now: this.deps.now(), backoff: backoffMs(this.failures) }));
  }

  /**
   * Read the run's events after the last held, and its figures; `withStatus` (no step out) takes its status too — and
   * then a run that can be stepped, with nothing scheduled and no step out, is stepped (M1): answered on another device,
   * resumed by a refresh.
   */
  private async read(withStatus: boolean): Promise<void> {
    if (this.disposed) return;
    try {
      const res = await this.deps.read(this.runId, lastSeq(this.snap.events));
      if (this.disposed) return;
      // A run that is over never comes back to life: a read that says otherwise is older than what the loop knows.
      const fresh = withStatus && !this.snap.inFlight && (isLive(this.snap.status) || !isLive(res.run.status));
      const status = fresh ? res.run.status : this.snap.status;
      this.set({ run: res.run, status, events: mergeEvents(this.snap.events, res.events) });
    } catch {
      // A read that fails changes nothing: the next one, or the next step, catches up.
    }
    if (withStatus) this.stepIfIdle();
  }

  private startPoll(): void {
    this.clearPoll();
    this.pollTimer = this.deps.setTimeout(() => void this.poll(), POLL_MS);
  }

  /** While the step is out: read the events every POLL_MS (not while hidden), never two reads at once. */
  private async poll(): Promise<void> {
    this.pollTimer = null;
    if (this.disposed || !this.snap.inFlight) return;
    if (this.deps.visible() && !this.polling) {
      this.polling = true;
      await this.read(false);
      this.polling = false;
    }
    if (this.snap.inFlight && !this.disposed) this.pollTimer = this.deps.setTimeout(() => void this.poll(), POLL_MS);
  }
}

/**
 * The loop for the run shown (`runId`; null: none), as React state. `seed` is what the screen already holds of it (the
 * current run's read, a create's answer). The loop is made once per run and stopped when the run or the screen goes.
 */
export function useCoachRun(
  runId: string | null,
  seed: { run?: CoachRunDto | null; events?: CoachRunEventDto[] } = {},
  deps: () => LoopDeps = browserDeps,
): { snapshot: LoopSnapshot | null; loop: CoachRunLoop | null } {
  const [loop, setLoop] = useState<CoachRunLoop | null>(null);
  const [snapshot, setSnapshot] = useState<LoopSnapshot | null>(null);
  const seedRef = useRef(seed);
  seedRef.current = seed;
  const depsRef = useRef(deps);
  depsRef.current = deps;
  useEffect(() => {
    if (!runId) {
      setLoop(null);
      setSnapshot(null);
      return;
    }
    const l = new CoachRunLoop(runId, depsRef.current(), seedRef.current);
    setLoop(l);
    setSnapshot(l.snapshot);
    const off = l.subscribe(setSnapshot);
    l.start();
    return () => {
      off();
      l.dispose();
    };
  }, [runId]);
  return { snapshot: loop?.runId === runId ? snapshot : null, loop: loop?.runId === runId ? loop : null };
}
