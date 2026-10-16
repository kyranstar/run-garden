/**
 * THE APP'S RUN KEEPER (the robustness pass, 2026-10-16: "make sure the coach … doesn't crash if I navigate away mid
 * response"). The client is what steps a run, so the step loop belongs to the app, not to the Studio screen: leaving the
 * Studio for the Plan mid-response no longer pauses the coach. The keeper
 *
 *  - holds the athlete's one run's loop (`adopt`: the Studio's run view asks for it, by the run's id, and gets the loop
 *    already at work when there is one), so the run goes on stepping on ANY screen while the app is open;
 *  - finds a live run when the app opens (`GET /api/coach/runs/current`, the Studio's own read) and steps it — opened on
 *    the Plan, the coach still finishes;
 *  - pauses only as the loop does: while the page is hidden (a step out finishes), or the network is down;
 *  - says it quietly in the nav: a ● on the Studio tab while the coach has a run going (`CoachNavMark`).
 *
 * Only with the coach designer on (`coachOn`): off, nothing is read and nothing steps.
 */
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CoachRunDto, CoachRunEventDto } from "@rg/api-client";
import { coachOn } from "../../features.js";
import { readCurrent } from "./coach-tolerance.js";
import { isLive, isNotAvailable } from "./run-model.js";
import { browserDeps, CoachRunLoop, LoopOwnerContext, type LoopDeps, type LoopOwner } from "./use-coach-run.js";

/** The current run's read (the Studio's own key: one read serves both). */
export const COACH_CURRENT_QUERY = ["coach-run-current"] as const;

/** The current run's read is asked again on a passing failure (never on a 404: the server's coach is off). */
export const currentRetry = (count: number, e: unknown): boolean => !isNotAvailable(e) && count < 2;

export class RunKeeper implements LoopOwner {
  private held: CoachRunLoop | null = null;
  private off: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(private readonly makeDeps: () => LoopDeps = browserDeps) {}

  /**
   * The loop for this run: the one held, at work, when it is this run's; else a new one from what the caller holds of it
   * (a new run, the current read) — the one held before, another run's, is stopped (the athlete has one run at a time).
   */
  adopt(runId: string, seed: { run?: CoachRunDto | null; events?: CoachRunEventDto[] }, deps?: () => LoopDeps): CoachRunLoop {
    if (this.held && this.held.runId === runId && !this.held.isDisposed) return this.held;
    this.release();
    const loop = new CoachRunLoop(runId, (deps ?? this.makeDeps)(), seed);
    this.held = loop;
    this.off = loop.subscribe(() => this.changed());
    loop.start();
    this.changed();
    return loop;
  }

  /** The loop held (the athlete's run), or none. */
  get loop(): CoachRunLoop | null {
    return this.held;
  }

  /** Stop the loop held: nothing steps (the app is going: signed out). */
  release(): void {
    this.off?.();
    this.off = null;
    this.held?.dispose();
    const had = this.held !== null;
    this.held = null;
    if (had) this.changed();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private changed(): void {
    this.version += 1;
    for (const fn of this.listeners) fn();
  }

  /** Bumped on every change of the loop held or of its snapshot. */
  get changes(): number {
    return this.version;
  }
}

const KeeperContext = createContext<RunKeeper | null>(null);

/**
 * The keeper, for the app: mounted once around the signed-in app. With the coach designer on, it reads the current run
 * when the app opens and steps a live one.
 */
export function CoachKeeper({ children, deps }: { children: ReactNode; deps?: () => LoopDeps }) {
  const [keeper] = useState(() => new RunKeeper(deps));
  useEffect(() => () => keeper.release(), [keeper]);
  return (
    <KeeperContext.Provider value={keeper}>
      <LoopOwnerContext.Provider value={keeper as LoopOwner}>
        {coachOn() ? <FindLiveRun keeper={keeper} /> : null}
        {children}
      </LoopOwnerContext.Provider>
    </KeeperContext.Provider>
  );
}

/** The live run the server holds, adopted: one read when the app opens (and whenever the Studio reads it again). */
function FindLiveRun({ keeper }: { keeper: RunKeeper }) {
  const current = useQuery({ queryKey: COACH_CURRENT_QUERY, queryFn: readCurrent, retry: currentRetry, staleTime: 15_000 });
  const data = current.data;
  useEffect(() => {
    if (!data?.run || !isLive(data.run.status)) return;
    keeper.adopt(data.run.id, { run: data.run, events: data.events });
  }, [data, keeper]);
  return null;
}

/** What the keeper's run is doing, for the nav: at work, waiting on the athlete, or nothing to say. */
export type KeeperState = "working" | "waiting" | null;

export function keeperState(loop: CoachRunLoop | null): KeeperState {
  const s = loop?.snapshot;
  if (!s || s.gone || !isLive(s.status)) return null;
  return s.status === "waiting_athlete" ? "waiting" : "working";
}

const NO_KEEPER = () => () => undefined;

/** The keeper's run's state, as React state (none without a keeper). */
export function useKeeperState(): KeeperState {
  const keeper = useContext(KeeperContext);
  return useSyncExternalStore(
    keeper ? keeper.subscribe : NO_KEEPER,
    () => keeperState(keeper?.loop ?? null),
    () => null,
  );
}

/** The words a reader hears beside the mark. */
export const NAV_MARK_WORDS: Record<Exclude<KeeperState, null>, string> = {
  working: "the coach is working",
  waiting: "the coach is waiting for you",
};

/**
 * A quiet ● beside the Studio tab's label while the coach has a run going; its words for a reader. Only the keeper's
 * run marks it, and the app mounts a keeper only with the coach on.
 */
export function CoachNavMark() {
  const state = useKeeperState();
  if (state === null) return null;
  return (
    <span className="nav-coach-mark" data-state={state}>
      <span aria-hidden="true">●</span>
      <span className="visually-hidden">{` — ${NAV_MARK_WORDS[state]}`}</span>
    </span>
  );
}
