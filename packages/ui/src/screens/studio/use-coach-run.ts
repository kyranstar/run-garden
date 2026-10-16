/**
 * THE CLIENT STEP LOOP (Stage 3 spec §2; Task 9). The model is called only for a client that is watching — the hourly
 * sweep never calls it — so while the run can be stepped and the page is visible, this asks for one step at a time (or,
 * with the server's step alarm on, arms the run once and keeps it going by reading it: ARMED, below):
 *
 *  - It steps again when the step's `nextDue` says so, never before it (correctness M9); a backoff after a refusal or a
 *    failure applies on top.
 *  - A 409 (another tab or device holds the step): back off at 1, 2, 4, 8 s — capped at 8 — and keep reading events.
 *  - A network error or a 5xx: the same backoff; after MAX_FAILURES in a row it says so (`lost`), with Retry — and it
 *    keeps trying by itself, once every LOST_RETRY_MS, so a passing outage never stalls a run the athlete isn't looking
 *    at (the robustness pass).
 *  - It stops on `waiting_athlete` and on every status that is over; the athlete's answer resumes it.
 *  - Hidden: the step in flight finishes, no new one starts; visible again, it goes on.
 *  - Never two step requests in flight from one tab: one at a time per loop, and per run across the tab (`IN_FLIGHT`) —
 *    a loop mounted again while an old one's step is still out waits for it.
 *  - Events: each step's response carries its own; while a step is in flight the run is also read every POLL_MS, so a
 *    long step's sub-runs' lines appear as they land. Merged by `seq`, never one twice.
 *  - A step whose answer is lost (a dropped connection: the reads say the run isn't stepping, for STEP_LOST_MS) is given
 *    up and asked again, never waited on for the whole deadline (the robustness pass).
 *  - An answer it can't read (a newer server, a cut-off body) is a failure like any other: never a loop that stops
 *    with its step shown in flight for good.
 *  - ARMED (the server's step alarm, COACH_STEP_ALARM): the step's answer says the request only armed the run — the
 *    server steps it itself, so a closed tab can't kill a step. The loop never waits on a step then: it reads the run
 *    every POLL_MS while it can be stepped — each read keeps the server's lease, so the coach goes on while someone
 *    watches — shows it at work (its ●) throughout, and stops when it waits on the athlete or is over. A run the reads
 *    find quiet (steppable, nothing at work) for STEP_LOST_MS is armed again; reads failing MAX_FAILURES in a row say
 *    `lost` and are then made only every LOST_RETRY_MS, and the network back arms it again; a 404 ends the watch (`gone`). Hidden, nothing is read: the server's lease runs out and the coach
 *    rests after the step at work and at most one more.
 *
 * Who owns the loop: the app's run keeper (run-keeper.tsx) when the app mounts one — the run goes on stepping on any
 * screen while the app is open — else the screen that shows the run, which stops it when it goes.
 *
 * Testable without a browser: `fetch` (the step and the read), the timers and the page's visibility are injected
 * (`LoopDeps`); the decisions are run-model.ts's.
 */
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { api, type CoachRunDto, type CoachRunEventDto, type CoachRunRole, type CoachRunStatus, type CoachRunStepResult } from "@rg/api-client";
import { toRunRead, toStepResult } from "./coach-tolerance.js";
import { backoffMs, isLive, isSteppable, lastSeq, LOST_RETRY_MS, MAX_FAILURES, mergeEvents, POLL_MS, STEP_LOST_MS, stepDelay, stepErrorKind } from "./run-model.js";

export interface LoopDeps {
  /** One step; `signal` aborts it (the loop gave up on an answer that was lost); `afterSeq`, the last event held (an
   * armed answer carries the events after it). */
  step: (id: string, signal?: AbortSignal, afterSeq?: number) => Promise<CoachRunStepResult>;
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

/** The page's own: the api client (its answers read tolerantly), the window's timers, the document's visibility and the window's network. */
export function browserDeps(): LoopDeps {
  const doc = typeof document === "undefined" ? null : document;
  const win = typeof window === "undefined" ? null : window;
  return {
    step: async (id, signal, afterSeq) => toStepResult(await api.coachRunStep(id, signal, afterSeq)),
    read: async (id, afterSeq) => toRunRead(await api.coachRun(id, afterSeq)),
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
  /** MAX_FAILURES failures in a row: it says so, keeps trying now and then, and Retry tries at once. */
  lost: boolean;
  /** The run is gone (404). */
  gone: boolean;
  /**
   * Since when (this device's clock) the step now under way has been at work, as this tab knows it: its own step's
   * start, or the first read that found another request's step at work (the run `stepping`, no step of ours out). Null
   * while no step is at work. The run view says "taking longer than usual" past the model's own deadline.
   */
  workingSince: number | null;
}

/** Step requests out in this tab, by run: a second loop on the same run waits for the first's — and can give it up. */
const IN_FLIGHT = new Map<string, { done: Promise<unknown>; abort: () => void }>();

/** Thrown inside the loop when it gives up on a step whose answer was lost. */
class StepLost extends Error {
  constructor() {
    super("step_lost");
  }
}

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
  /**
   * The trail must be read before the next step (an answer's line was written: B-I2). Until a read succeeds, no step —
   * a read that fails is a failure like a step's, retried on the backoff; the line is never left behind the step's seqs.
   */
  private readOwed = false;
  private disposed = false;
  private unsubscribe: (() => void) | null = null;
  private listeners = new Set<(s: LoopSnapshot) => void>();
  /** The seed carried the run's trail (`events`, even none): no read is needed before the first step. */
  private readonly trailKnown: boolean;
  /** While a step is out: when its reads first found the run not stepping (null: the last read found it stepping). */
  private notSteppingSince: number | null = null;
  /** While a step is out: give it up (its answer was lost). */
  private giveUp: (() => void) | null = null;
  /** The server steps the run (an armed answer): the loop reads it, and steps only to arm it again. */
  private armed = false;
  /** While armed: since when the reads have found the run steppable with nothing at work (null: at work, or unread). */
  private quietSince: number | null = null;

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
      workingSince: null,
    };
  }

  get snapshot(): LoopSnapshot {
    return this.snap;
  }

  /** Stopped (`dispose`): its owner makes a new one to show the run again. */
  get isDisposed(): boolean {
    return this.disposed;
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
    // Watching the server's steps: this answer says where the run is now (a cancel ends it; an answer arms it again).
    const watched = this.armed;
    if (watched) this.endWatch();
    this.set({ run, status: run.status, ...(watched ? { inFlight: false } : {}) });
    this.clearStep();
    if (isSteppable(run.status)) {
      this.nextDueAt = null;
      this.readOwed = true;
      this.schedule(0);
    }
  }

  /** Read the run's newest events and its figures (after an undo, a refused answer). */
  async refresh(): Promise<void> {
    await this.read(true);
  }

  // ── Inside ──

  private set(patch: Partial<LoopSnapshot>): void {
    if (this.disposed) return;
    const next = { ...this.snap, ...patch };
    // At work: our own step's start (set with it), else a step of another request's the reads found (`stepping`).
    if (!next.inFlight) next.workingSince = isLive(next.status) && next.status === "stepping" ? (this.snap.workingSince ?? this.deps.now()) : null;
    this.snap = next;
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
      // Whatever goes wrong inside (an answer it can't read), the loop goes on: a failure, retried on the backoff.
      void this.tick().catch((e: unknown) => this.broke(e));
    }, Math.max(0, ms));
  }

  /** Something the loop didn't expect threw: no step is shown in flight for good, and it tries again on the backoff. */
  private broke(e: unknown): void {
    if (this.disposed) return;
    this.clearPoll();
    this.giveUp = null;
    this.set({ inFlight: false });
    void this.failed(e).catch(() => undefined);
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
    // Armed, the ● is the server's step, not a request of ours: arming it again is allowed.
    if (this.disposed || (this.snap.inFlight && !this.armed) || this.snap.gone) return;
    // Lost: only Retry, the network, the page coming back — or the slow retry this tick is — goes on.
    if (this.snap.lost) {
      this.failures = MAX_FAILURES - 1;
      this.set({ lost: false });
    }
    if (!isSteppable(this.snap.status)) return;
    if (!this.deps.visible()) {
      this.owed = true;
      return;
    }
    // The trail first, when an answer wrote to it (the re-review): no step until a read succeeds.
    if (this.readOwed) {
      const ok = await this.read(true, false);
      if (this.disposed) return;
      if (!ok) return this.failed(new Error("read"));
      this.readOwed = false;
      if (!isSteppable(this.snap.status) || this.snap.lost || this.snap.gone) return;
    }
    // Another loop of this tab on this run still has a step out (the screen was left and opened again): wait for it — a
    // step in flight all the same, its lines read as they land (M3) — then read where it left the run. A step whose
    // answer is lost is given up here too.
    const other = IN_FLIGHT.get(this.runId);
    if (other) {
      this.set({ inFlight: true, workingSince: this.snap.workingSince ?? this.deps.now() });
      this.notSteppingSince = null;
      const lost = new Promise<void>((resolve) => {
        this.giveUp = () => {
          other.abort();
          if (IN_FLIGHT.get(this.runId) === other) IN_FLIGHT.delete(this.runId);
          resolve();
        };
      });
      this.startPoll();
      await Promise.race([other.done.catch(() => undefined), lost]);
      this.giveUp = null;
      this.clearPoll();
      if (this.disposed) return;
      this.set({ inFlight: false });
      await this.read(true);
      return;
    }
    await this.step();
  }

  private async step(): Promise<void> {
    const controller = new AbortController();
    this.notSteppingSince = null;
    // Asking again while another request's step is at work (a 409's backoff) doesn't restart its clock.
    const since = this.snap.status === "stepping" && this.snap.workingSince !== null ? this.snap.workingSince : this.deps.now();
    this.set({ inFlight: true, workingSince: since });
    this.startPoll();
    const out = this.deps.step(this.runId, controller.signal, lastSeq(this.snap.events));
    const entry = { done: out, abort: () => controller.abort() };
    IN_FLIGHT.set(this.runId, entry);
    const lost = new Promise<never>((_, reject) => {
      this.giveUp = () => {
        controller.abort();
        reject(new StepLost());
      };
    });
    let res: CoachRunStepResult;
    try {
      res = await Promise.race([out, lost]);
    } catch (e) {
      this.clearPoll();
      this.set({ inFlight: false });
      return this.failed(e);
    } finally {
      this.giveUp = null;
      if (IN_FLIGHT.get(this.runId) === entry) IN_FLIGHT.delete(this.runId);
      out.catch(() => undefined);
    }
    this.clearPoll();
    if (this.disposed) return;
    this.failures = 0;
    this.busy = 0;
    if (res.armed === true) return this.watch(res);
    this.armed = false;
    const due = res.nextDue ? Date.parse(res.nextDue.at) : NaN;
    this.nextDueAt = Number.isFinite(due) ? due : null;
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
    if (this.failures >= MAX_FAILURES) {
      // Said, with Retry — and tried again now and then by itself.
      this.set({ lost: true });
      this.schedule(LOST_RETRY_MS);
      return;
    }
    this.schedule(stepDelay({ nextDueAt: this.nextDueAt, now: this.deps.now(), backoff: backoffMs(this.failures) }));
  }

  /**
   * Read the run's events after the last held, and its figures; `withStatus` (no step out) takes its status too — and
   * then a run that can be stepped, with nothing scheduled and no step out, is stepped (M1): answered on another device,
   * resumed by a refresh.
   */
  private async read(withStatus: boolean, stepAfter = withStatus): Promise<boolean> {
    if (this.disposed) return false;
    let ok = false;
    try {
      const res = await this.deps.read(this.runId, lastSeq(this.snap.events));
      if (this.disposed) return false;
      // A run that is over never comes back to life: a read that says otherwise is older than what the loop knows.
      const fresh = withStatus && !this.snap.inFlight && (isLive(this.snap.status) || !isLive(res.run.status));
      const status = fresh ? res.run.status : this.snap.status;
      this.set({ run: res.run, status, events: mergeEvents(this.snap.events, res.events) });
      // A step of ours out, and the server not at work on any: its answer may be lost (see poll).
      if (this.snap.inFlight) this.notSteppingSince = res.run.status === "stepping" ? null : (this.notSteppingSince ?? this.deps.now());
      ok = true;
    } catch {
      // A read that fails changes nothing: the next one, or the next step, catches up.
    }
    if (stepAfter) this.stepIfIdle();
    return ok;
  }

  private startPoll(): void {
    this.clearPoll();
    this.pollTimer = this.deps.setTimeout(() => void this.poll(), POLL_MS);
  }

  /**
   * While the step is out: read the events every POLL_MS (not while hidden), never two reads at once. A step out for
   * STEP_LOST_MS while every read in that time found the run not stepping lost its answer (a dropped connection): it is
   * given up — the run is stepped again, never waited on for the request's whole deadline.
   */
  private async poll(): Promise<void> {
    this.pollTimer = null;
    if (this.disposed || !this.snap.inFlight) return;
    if (this.armed) return this.pollArmed();
    if (this.deps.visible() && !this.polling) {
      this.polling = true;
      await this.read(false);
      this.polling = false;
      const now = this.deps.now();
      const since = this.snap.workingSince ?? now;
      if (this.giveUp && this.notSteppingSince !== null && now - this.notSteppingSince >= STEP_LOST_MS && now - since >= STEP_LOST_MS) {
        this.giveUp();
        return;
      }
    }
    if (this.snap.inFlight && !this.disposed) this.pollTimer = this.deps.setTimeout(() => void this.poll(), POLL_MS);
  }

  // ── Armed: the server steps the run ──

  /** The step request armed the run: watch it — at work while it can be stepped — reading it from now on. */
  private watch(res: CoachRunStepResult): void {
    this.armed = true;
    this.idle = 0;
    this.nextDueAt = null;
    this.quietSince = null;
    const steppable = isSteppable(res.status);
    this.set({
      inFlight: steppable,
      status: res.status,
      events: mergeEvents(this.snap.events, res.events),
      workingSince: res.status === "stepping" ? (this.snap.workingSince ?? this.deps.now()) : null,
    });
    if (steppable) return this.startPoll();
    // Waiting on the athlete, or over, by the time it was asked: nothing to watch — one read for its figures.
    this.endWatch();
    void this.read(true);
  }

  /** Stop watching: no read scheduled (whoever ends it says what the run is now). */
  private endWatch(): void {
    this.armed = false;
    this.quietSince = null;
    this.clearPoll();
  }

  /** Every POLL_MS while armed: a read (not while hidden — the server's lease then runs out, and the coach rests). */
  private async pollArmed(): Promise<void> {
    if (this.deps.visible() && !this.polling) {
      this.polling = true;
      await this.readArmed();
      this.polling = false;
    }
    // Lost, it reads only every LOST_RETRY_MS, as the direct path tries a step (Retry and the network coming back go on
    // at once): a failing server is never read every POLL_MS for good (the go-live review, I1).
    if (this.armed && !this.disposed && this.snap.inFlight && this.pollTimer === null) {
      this.pollTimer = this.deps.setTimeout(() => void this.poll(), this.snap.lost ? LOST_RETRY_MS : POLL_MS);
    }
  }

  /**
   * One read while armed: the run's status, events and figures. Steppable, it is at work (its ● stays); waiting on the
   * athlete or over, the watch ends. Quiet for STEP_LOST_MS — steppable, nothing at work: the server's chain stopped (its
   * alarm gave up, no read reached it in time) — it is armed again. A read that fails counts toward `lost`.
   */
  private async readArmed(): Promise<void> {
    let res: { run: CoachRunDto; events: CoachRunEventDto[] };
    try {
      res = await this.deps.read(this.runId, lastSeq(this.snap.events));
    } catch (e) {
      if (this.disposed || !this.armed) return;
      // The run is gone (a 404: deleted, or the server's coach switched off under an open tab): nothing more to read.
      if (stepErrorKind(e) === "gone") {
        this.endWatch();
        this.set({ inFlight: false, gone: true });
        return;
      }
      this.failures += 1;
      if (this.failures >= MAX_FAILURES && !this.snap.lost) this.set({ lost: true });
      return;
    }
    if (this.disposed || !this.armed) return;
    this.failures = 0;
    const now = this.deps.now();
    // (A read can't bring a run that is over back to life: the watch ends with the first read that finds it over, and
    // a read still out then is dropped above.)
    const status = res.run.status;
    const working = status === "stepping";
    this.set({
      run: res.run,
      status,
      events: mergeEvents(this.snap.events, res.events),
      lost: false,
      // The step at work's time, never the run's: from the first read that found it at work.
      workingSince: working ? (this.snap.status === "stepping" && this.snap.workingSince !== null ? this.snap.workingSince : now) : null,
    });
    if (!isSteppable(status)) {
      this.endWatch();
      this.set({ inFlight: false });
      return;
    }
    if (working) {
      this.quietSince = null;
      return;
    }
    this.quietSince ??= now;
    if (now - this.quietSince >= STEP_LOST_MS) {
      this.quietSince = null;
      this.schedule(0);
    }
  }
}

/** The app's run keeper (run-keeper.tsx), when the app mounts one: it owns the loop, so leaving a screen never stops it. */
export interface LoopOwner {
  adopt(runId: string, seed: { run?: CoachRunDto | null; events?: CoachRunEventDto[] }, deps?: () => LoopDeps): CoachRunLoop;
}

export const LoopOwnerContext = createContext<LoopOwner | null>(null);

/**
 * The loop for the run shown (`runId`; null: none), as React state. `seed` is what the screen already holds of it (the
 * current run's read, a create's answer). With the app's run keeper, the keeper owns the loop — it goes on stepping when
 * this screen goes; without one, the loop is made once per run and stopped when the run or the screen goes.
 */
export function useCoachRun(
  runId: string | null,
  seed: { run?: CoachRunDto | null; events?: CoachRunEventDto[] } = {},
  deps?: () => LoopDeps,
): { snapshot: LoopSnapshot | null; loop: CoachRunLoop | null } {
  const owner = useContext(LoopOwnerContext);
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
    const kept = owner !== null;
    const l = owner ? owner.adopt(runId, seedRef.current, depsRef.current) : new CoachRunLoop(runId, (depsRef.current ?? browserDeps)(), seedRef.current);
    setLoop(l);
    setSnapshot(l.snapshot);
    const off = l.subscribe(setSnapshot);
    if (!kept) l.start();
    return () => {
      off();
      if (!kept) l.dispose();
    };
  }, [runId, owner]);
  return { snapshot: loop?.runId === runId ? snapshot : null, loop: loop?.runId === runId ? loop : null };
}
