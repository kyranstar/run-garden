/**
 * THE SESSION PLAYER (Phase 2b Task 4; mocks §4; spec §2b "Player") — `/session/:workoutId`, full screen at every width,
 * outside the tab shell (no tab bar).
 *
 * It plays what Start left on the device (ruling 2b-R1: Start needs the network, everything after it works offline):
 * the locked build from IndexedDB, never the network, once started. Holds count down after a get-ready, sets wait for
 * Done and its log card, rests count down with +15 s and Skip. ✕ asks before leaving and keeps the session; opening
 * it again resumes on the same step with the timer where it was. ⇄ swaps the move in play for one the build offers;
 * ⓘ opens its how-to (and holds a running countdown). On desktop the keys do the same (`player/keys.ts`, `?`).
 *
 * The session in progress is written to IndexedDB on every change (debounced, flushed when the page is hidden or
 * left). Timers read the wall clock (`player/timer.ts`); chimes are placed on the audio clock from it
 * (`player/audio.ts`); the screen is kept on while playing (`player/wake.ts`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, type MeResponse, type ReviewBasisDto, type SessionDto, type SessionExerciseDto } from "@rg/api-client";
import { formatWeight, parseWeight, type Weight, type WeightUnit } from "@rg/domain";
import type { EngineData } from "@rg/exercise-library";
import { Lib, Prog, type SlotChoice, type Step } from "@rg/session-engine";
import { Sheet, Spinner } from "../components.js";
import { ExerciseHowto, type HowtoTarget } from "../components/exercise-howto.js";
import { BLOCK_LABEL, FORMAT_LABEL } from "../components/session-sheet.js";
import { Stepper } from "../components/set-steppers.js";
import { IconClose, IconInfo, IconSwap } from "../icons.js";
import { loadBuild, saveBuild, type StoredSessionBuild } from "../offline/builds.js";
import { offlineDb, type OfflineDb } from "../offline/idb.js";
import { meWithOfflineFallback } from "../offline/me.js";
import { createLiveWriter, readLive, writeLive, type LiveWriter } from "../offline/live.js";
import type { OutboxApi } from "../offline/outbox.js";
import { chimes as appChimes, type Chimes } from "../player/audio.js";
import { commandFor, type PlayerCommand } from "../player/keys.js";
import {
  addRest,
  beginPlayer,
  closeHowto,
  confirmLog,
  endSession,
  fromLiveSession,
  logTarget,
  next,
  pause,
  playerData,
  prev,
  resume,
  settle,
  stepView,
  swapSlot,
  toLiveSession,
  type PlayerSource,
  type PlayerState,
} from "../player/run.js";
import { loadBasis, loadExtras, saveBasis, saveExtras, type PlayerExtras } from "../player/stored.js";
import { reviewData } from "../player/review.js";
import { discardSession, savedHere, saveSession } from "../player/save.js";
import { ReviewScreen } from "./review.js";
import { offeredNow } from "../player/swap.js";
import { clockText, lengthMs, readyMs } from "../player/timer.js";
import { holdWakeLock } from "../player/wake.js";

export interface PlayerDeps {
  db: () => Promise<OfflineDb>;
  /** Only when nothing is stored for the slot: a session started on another device, opened online. */
  getSession: (workoutId: string) => Promise<SessionDto>;
  /** Once, while online, when the review's basis is not on the device yet. */
  reviewBasis: (workoutId: string) => Promise<ReviewBasisDto>;
  /** The outbox's delivery (Save tries it at once). */
  savePerformed: OutboxApi["savePerformed"];
  /** Who is signed in, when Start did not say (offline: the answer kept on the device). */
  whoAmI: () => Promise<string | null>;
  chimes: Chimes;
  /** Hold the screen on; returns release. */
  wake: () => () => void;
}

const defaultDeps: PlayerDeps = {
  db: offlineDb,
  getSession: api.getSession,
  reviewBasis: api.reviewBasis,
  savePerformed: api.savePerformed,
  whoAmI: async () => (await meWithOfflineFallback().catch(() => null))?.userId ?? null,
  chimes: appChimes,
  wake: () => holdWakeLock(),
};

const AUTO_KEY = "rg-player-auto-advance";
function readAuto(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) !== "0";
  } catch {
    return true;
  }
}
function writeAuto(on: boolean): void {
  try {
    localStorage.setItem(AUTO_KEY, on ? "1" : "0");
  } catch {
    // no storage: the setting lasts the visit
  }
}

type Loaded =
  | { kind: "loading" }
  /** Nothing on this device and no network: the session was started elsewhere, or never. */
  | { kind: "missing" }
  /** Built but not started: Start is on its sheet. */
  | { kind: "unstarted" }
  | { kind: "done" }
  /** Saved on this device, waiting for the server (or refused by it: Settings → Data). */
  | { kind: "saved" }
  | { kind: "ready"; src: PlayerSource; data: EngineData; extras: PlayerExtras | null; basis: ReviewBasisDto | null; initial: PlayerState };

/** What IndexedDB holds for the slot (or, online with nothing stored, a session already started elsewhere). */
async function load(workoutId: string, deps: PlayerDeps): Promise<{ loaded: Loaded; db: OfflineDb | null }> {
  let db: OfflineDb | null = null;
  try {
    db = await deps.db();
  } catch {
    db = null;
  }
  // Saved here and not yet synced: never a second session for the slot.
  if (db && (await savedHere(db, workoutId).catch(() => false))) return { loaded: { kind: "saved" }, db };
  let stored: StoredSessionBuild | undefined = db ? await loadBuild(db, workoutId).catch(() => undefined) : undefined;
  let extras: PlayerExtras | null = db ? ((await loadExtras(db, workoutId).catch(() => undefined)) ?? null) : null;
  if (!stored) {
    let session: SessionDto;
    try {
      session = await deps.getSession(workoutId);
    } catch {
      return { loaded: { kind: "missing" }, db };
    }
    if (session.contentState === "done") return { loaded: { kind: "done" }, db };
    if (session.contentState !== "started" || !session.build || !session.view) return { loaded: { kind: "unstarted" }, db };
    stored = { workoutId, build: session.build, view: session.view, savedAt: Date.now() };
    extras = { workoutId, title: session.view.theme?.name ?? "Session", profiles: session.profiles, userId: null, savedAt: Date.now() };
    if (db) {
      await saveBuild(db, session).catch(() => undefined);
      await saveExtras(db, extras).catch(() => undefined);
    }
  }
  const src: PlayerSource = {
    workoutId,
    build: stored.build,
    view: stored.view,
    profiles: (extras?.profiles ?? []).map((p) => p.profileId),
  };
  const data = playerData(src);
  const now = Date.now();
  const live = db ? await readLive(db, workoutId).catch(() => undefined) : undefined;
  const resumed = live ? fromLiveSession(live, src) : null;
  let initial = resumed;
  if (!initial) {
    initial = beginPlayer(src, data, { performedId: crypto.randomUUID(), now });
    // In IndexedDB from the first moment: a reload a second later resumes it (and the app opens offline on it).
    if (db) await writeLive(db, toLiveSession(initial, now)).catch(() => undefined);
  }
  let basis = db ? ((await loadBasis(db, workoutId).catch(() => undefined)) ?? null) : null;
  if (basis && basis.buildId !== src.build.buildId) basis = null;
  return { loaded: { kind: "ready", src, data, extras, basis, initial }, db };
}

export function PlayerScreen({ workoutId, deps: given }: { workoutId: string; deps?: Partial<PlayerDeps> }) {
  // Fixed for the life of the screen (a new object each render would reload it).
  const [deps] = useState<PlayerDeps>(() => ({ ...defaultDeps, ...given }));
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [db, setDb] = useState<OfflineDb | null>(null);
  useEffect(() => {
    let alive = true;
    void load(workoutId, deps).then(({ loaded: l, db: d }) => {
      if (!alive) return;
      setDb(d);
      setLoaded(l);
    });
    return () => {
      alive = false;
    };
  }, [workoutId, deps]);

  if (loaded.kind === "loading") {
    return (
      <div className="player player-status">
        <Spinner label="Opening the session" />
      </div>
    );
  }
  if (loaded.kind !== "ready") {
    const line =
      loaded.kind === "missing"
        ? "This session isn't on this device. Open it while online to start it."
        : loaded.kind === "done"
          ? "This session is done."
          : loaded.kind === "saved"
            ? "This session is saved."
            : "Start this session from its sheet.";
    return (
      <div className="player player-status">
        <p>{line}</p>
        <div className="btn-row">
          {loaded.kind === "unstarted" ? (
            <Link className="btn btn-primary" to={`/plan?workout=${encodeURIComponent(workoutId)}`}>
              Open
            </Link>
          ) : null}
          <Link className="btn" to="/">
            Today
          </Link>
        </div>
      </div>
    );
  }
  return <Playing key={loaded.initial.performedId} loaded={loaded} db={db} deps={deps} />;
}

type Panel = "howto" | "swap" | "keys" | "leave" | null;

function Playing({ loaded, db, deps }: { loaded: Extract<Loaded, { kind: "ready" }>; db: OfflineDb | null; deps: PlayerDeps }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { src, data, extras } = loaded;
  const [basis, setBasis] = useState<ReviewBasisDto | null>(loaded.basis);
  // The review's basis, once, while online (Start's own request may have beaten the player to it, or not).
  useEffect(() => {
    if (basis) return;
    let alive = true;
    deps
      .reviewBasis(src.workoutId)
      .then(async (b) => {
        if (!alive || b.buildId !== src.build.buildId) return;
        setBasis(b);
        if (db) await saveBasis(db, src.workoutId, b).catch(() => undefined);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [basis, deps, db, src.workoutId, src.build.buildId]);
  const reviewEngine = useMemo(() => reviewData(src, basis), [src, basis]);
  const [auto, setAuto] = useState(readAuto);
  const [now, setNow] = useState(() => Date.now());
  const [state, setState] = useState<PlayerState>(() => settle(loaded.initial, Date.now(), { autoAdvance: readAuto() }));
  const [panel, setPanel] = useState<Panel>(null);
  const [logOpen, setLogOpen] = useState(false);
  /** A panel paused the countdown: closing it resumes. */
  const pausedByPanel = useRef(false);
  const writer = useRef<LiveWriter | null>(null);
  /** Keeping the session on the device failed (storage full, the database gone): the athlete is told. */
  const [notKept, setNotKept] = useState(false);

  // ── Persistence: every change, debounced; flushed when hidden or left ─────────────────────────────────────────
  useEffect(() => {
    if (!db) return;
    const w = createLiveWriter(db, { onError: () => setNotKept(true) });
    writer.current = w;
    return () => {
      writer.current = null;
      w.dispose();
    };
  }, [db]);
  useEffect(() => {
    writer.current?.write(toLiveSession(state, Date.now()));
    // The end of the session is kept at once: a reload right after it comes back to the review, never to the last step.
    if (state.finished) writer.current?.flush().catch(() => setNotKept(true));
  }, [state]);

  // ── The wall clock: a light tick while playing, and a catch-up whenever the page comes back ────────────────────
  const refresh = useCallback(() => {
    const t = Date.now();
    setNow(t);
    // A write that lands again clears the warning.
    if (writer.current && writer.current.error === null) setNotKept(false);
    setState((s) => settle(s, t, { autoAdvance: auto }));
  }, [auto]);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "hidden") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(refresh, 250);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, [refresh]);

  // ── Chimes on the audio clock: the end of each get-ready and each timer, on through the timed steps ahead ──────
  useEffect(() => {
    if (state.finished || state.paused || state.clock.anchor === null) {
      deps.chimes.cancel();
      return;
    }
    const due: number[] = [];
    let start = state.clock.anchor - state.clock.bankedMs;
    for (let i = state.index; i < state.live.steps.length; i++) {
      const step = state.live.steps[i]!;
      const length = lengthMs(step, state.restExtra[i] ?? 0);
      if (length === null) break;
      if (readyMs(step) > 0) due.push(start + readyMs(step));
      due.push(start + length);
      start += length;
      if (!auto || due.length > 60) break;
    }
    deps.chimes.schedule(due);
  }, [state.index, state.clock, state.paused, state.finished, state.restExtra, state.live.steps, auto, deps.chimes]);
  // A reload loses the audio unlock: the first tap after it unlocks again.
  useEffect(() => {
    const unlock = () => deps.chimes.unlock();
    window.addEventListener("pointerdown", unlock, { once: true });
    return () => window.removeEventListener("pointerdown", unlock);
  }, [deps.chimes]);

  // ── The screen stays on while playing ──────────────────────────────────────────────────────────────────────────
  const playing = !state.finished && !state.paused;
  useEffect(() => {
    if (!playing) return;
    return deps.wake();
  }, [playing, deps]);

  // ── The new move's how-to, the first time it comes up ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (state.howto && panel === null) setPanel("howto");
  }, [state.howto, panel]);

  const view = state.finished ? null : stepView(state, now);
  const step = view?.step ?? null;
  /** The slot ⇄ and ⓘ are about: the step in play, or during a rest the move that comes next. */
  const focus = useMemo(() => focusStep(state), [state]);
  // What ⇄ offers now: recomputed after each swap with the engine's rules over what the build stored (player/swap.ts).
  const alternatives: SlotChoice[] = useMemo(
    () => (focus ? offeredNow(src.build, state.swaps, focus.slotKey).filter((a) => a.id !== focus.exerciseId) : []),
    [focus, src.build, state.swaps],
  );

  const act = (f: (s: PlayerState, t: number) => PlayerState) => {
    const t = Date.now();
    setNow(t);
    setState((s) => f(s, t));
  };
  const openPanel = (p: Exclude<Panel, null>) => {
    if (p === "howto" || p === "swap") {
      if (!state.paused && !state.finished) {
        pausedByPanel.current = true;
        act(pause);
      }
    }
    setPanel(p);
  };
  const closePanel = () => {
    const was = panel;
    setPanel(null);
    if (was === "howto" && state.howto) {
      pausedByPanel.current = false;
      act(closeHowto);
      return;
    }
    if (pausedByPanel.current) {
      pausedByPanel.current = false;
      act(resume);
    }
  };
  const leave = async () => {
    const t = Date.now();
    const paused = pause(state, t);
    setState(paused);
    if (db) await writeLive(db, toLiveSession(paused, t)).catch(() => undefined);
    navigate("/");
  };

  // ── The log card ───────────────────────────────────────────────────────────────────────────────────────────────
  const unit: WeightUnit = useMemo(() => {
    const bells = Lib.kettlebellsAt(src.view.location);
    return bells[0]?.u ?? "lb";
  }, [src.view.location]);
  const flags = useMemo(
    () => data.profiles.active.flatMap((p) => (p.setFlag ? [{ id: p.setFlag.id, label: p.setFlag.label }] : [])),
    [data],
  );
  const [draft, setDraft] = useState<LogDraft | null>(null);
  const openLog = () => {
    const t = logTarget(state);
    if (!t) return;
    setDraft({
      weight: t.w ? formatWeight(t.w) : "",
      reps: t.reps === null ? "" : String(t.reps),
      secs: t.secs === null ? "" : String(t.secs),
      flags: Object.fromEntries(flags.map((f) => [f.id, t.entry.flags.includes(f.id)])),
    });
    setLogOpen(true);
  };
  const confirm = () => {
    const t = logTarget(state);
    if (!t || !draft) return;
    const w = t.entry.log === "load" ? (draft.weight.trim() === "" ? null : (parseWeight(draft.weight, t.w?.u ?? unit) ?? t.w)) : undefined;
    const reps = t.entry.metric === "reps" ? wholeOr(draft.reps, t.reps) : undefined;
    const secs = t.entry.metric === "time" ? wholeOr(draft.secs, t.secs) : undefined;
    setLogOpen(false);
    setDraft(null);
    act((s, at) => confirmLog(s, { w, reps, secs }, draft.flags, at));
  };

  // ── The primary action and the keys ────────────────────────────────────────────────────────────────────────────
  const primary = () => {
    if (!view || !step) return;
    if (logOpen) return confirm();
    if (step.kind === "set") return openLog();
    if (view.phase === "over") return act(next);
    if (step.kind === "rest") return act(next);
    return act(state.paused ? resume : pause);
  };
  const run = (c: PlayerCommand): boolean => {
    switch (c) {
      case "close":
        if (panel) closePanel();
        else if (logOpen) {
          setLogOpen(false);
          setDraft(null);
        } else return false;
        return true;
      case "confirm":
        if (!logOpen) return false;
        confirm();
        return true;
      case "primary":
        primary();
        return true;
      case "prev":
        setLogOpen(false);
        act(prev);
        return true;
      case "next":
        setLogOpen(false);
        act(next);
        return true;
      case "swap":
        if (alternatives.length === 0) return false;
        openPanel("swap");
        return true;
      case "howto":
        if (!focus?.exerciseId) return false;
        openPanel("howto");
        return true;
      case "keys":
        setPanel("keys");
        return true;
    }
  };
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const c = commandFor(e, { panelOpen: panelRef.current !== null, logOpen: logRef.current });
      if (c && runRef.current(c)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const logRef = useRef(logOpen);
  logRef.current = logOpen;

  if (state.finished) {
    /** Nothing more is written for this session in progress (Save and Discard end it). */
    const stopWriting = async () => {
      const w = writer.current;
      writer.current = null;
      if (w) {
        await w.flush().catch(() => undefined);
        w.dispose();
      }
    };
    const refresh = (saved: boolean) => {
      void qc.invalidateQueries({ queryKey: ["outbox"] });
      if (saved) for (const k of ["today", "plan", "plan-week", "programs", "garden"]) void qc.invalidateQueries({ queryKey: [k] });
    };
    return (
      <ReviewScreen
        state={state}
        onChange={setState}
        src={src}
        data={reviewEngine}
        title={extras?.title ?? src.view.theme?.name ?? ""}
        profiles={extras?.profiles ?? []}
        basis={basis}
        onLeave={() => void leave()}
        onSave={async (wire) => {
          await stopWriting();
          if (db) {
            // The account the save belongs to: Start's, else the one signed in now, else the answer kept here.
            const userId = extras?.userId ?? qc.getQueryData<MeResponse>(["me"])?.userId ?? (await deps.whoAmI());
            if (!userId) throw new Error("no signed-in account to save for");
            const result = await saveSession(db, wire, { savePerformed: deps.savePerformed }, userId);
            refresh(result === "saved");
          } else {
            // No IndexedDB (a private window): straight to the server, or not at all.
            await deps.savePerformed(wire.id, wire);
            refresh(true);
          }
          navigate("/", { replace: true });
        }}
        onDiscard={async () => {
          await stopWriting();
          if (db) await discardSession(db, src.workoutId).catch(() => undefined);
          navigate("/", { replace: true });
        }}
      />
    );
  }

  const total = state.live.steps.length;
  const ex = step?.exerciseId ? src.build.exercises[step.exerciseId] : undefined;
  const title = extras?.title ?? src.view.theme?.name ?? "";
  const left = timeLeft(state, now);
  const careLabel = (extras?.profiles ?? []).find((p) => p.care)?.care ?? null;

  return (
    <div className="player">
      <header className="player-top">
        <button type="button" className="player-icon" aria-label="Leave the session" onClick={() => setPanel("leave")}>
          <IconClose size={18} />
        </button>
        <span className="player-count num">
          <span className="player-count-title">{title} · </span>
          {state.index + 1} of {total}
          <span className="player-count-left"> · {clockText(left)} left</span>
        </span>
        <span className="player-tools">
          {alternatives.length > 0 ? (
            <button type="button" className="player-icon" aria-label="Swap" onClick={() => openPanel("swap")}>
              <IconSwap size={18} />
            </button>
          ) : null}
          {focus?.exerciseId ? (
            <button type="button" className="player-icon" aria-label="How to" onClick={() => openPanel("howto")}>
              <IconInfo size={18} />
            </button>
          ) : null}
          <button type="button" className="player-icon player-keys-btn" aria-label="Keys" onClick={() => setPanel("keys")}>
            ?
          </button>
        </span>
      </header>
      <div className="player-bar" aria-hidden="true">
        <i style={{ width: `${Math.round((state.index / Math.max(1, total)) * 1000) / 10}%` }} />
      </div>
      {notKept ? (
        <p className="player-warn" role="status">
          This session isn't being kept on this device.
        </p>
      ) : null}

      <main className="player-main">
        {step && view ? (
          <StepBody
            state={state}
            step={step}
            view={view}
            exercise={ex}
            exercises={src.build.exercises}
            careLabel={careLabel}
            log={
              logOpen && draft ? (
                <LogCard
                  state={state}
                  draft={draft}
                  setDraft={setDraft}
                  flags={flags}
                  location={src.view.location}
                  unit={unit}
                />
              ) : null
            }
          />
        ) : null}
      </main>

      <footer className="player-actions">
        {step && view ? (
          <Actions
            state={state}
            step={step}
            phase={view.phase}
            logOpen={logOpen}
            onPrimary={primary}
            onConfirm={confirm}
            onSkip={() => {
              setLogOpen(false);
              act(next);
            }}
            onAddRest={() => act((s) => addRest(s, 15))}
            onPause={() => act(state.paused ? resume : pause)}
          />
        ) : null}
        <p className="player-kbd" aria-hidden="true">
          <kbd>Space</kbd> {primaryWord(step, view?.phase ?? null, logOpen, state.paused)} · <kbd>←</kbd> <kbd>→</kbd> step
          {alternatives.length > 0 ? (
            <>
              {" "}
              · <kbd>S</kbd> swap
            </>
          ) : null}{" "}
          · <kbd>I</kbd> how-to · <kbd>?</kbd> keys
        </p>
      </footer>

      {panel === "howto" && focus?.exerciseId && src.build.exercises[focus.exerciseId] ? (
        <ExerciseHowto
          exercise={src.build.exercises[focus.exerciseId]!}
          item={src.build.items.find((i) => i.slotKey === focus.slotKey && i.exerciseId === focus.exerciseId)}
          target={((src.build.targets[focus.exerciseId] ?? focus.target) as HowtoTarget | null) ?? null}
          profiles={extras?.profiles ?? []}
          exercises={src.build.exercises}
          onClose={closePanel}
        />
      ) : null}
      {panel === "swap" && focus ? (
        <Sheet open onClose={closePanel} title={`Swap ${src.build.exercises[focus.exerciseId ?? ""]?.name ?? ""}`}>
          <div className="choice-moves">
            {alternatives.map((alt) => (
              <div key={alt.id} className="choice-move">
                <div className="choice-move-text">
                  <b>{alt.name}</b>
                  {alt.reasons.length > 0 ? <small>{alt.reasons.join(" · ")}</small> : null}
                </div>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    pausedByPanel.current = false;
                    setPanel(null);
                    setLogOpen(false);
                    act((s, t) => {
                      const swapped = swapSlot(s, data, focus.slotKey, alt, t);
                      return swapped.paused && !s.howto ? resume(swapped, t) : swapped;
                    });
                  }}
                >
                  Use
                </button>
              </div>
            ))}
          </div>
        </Sheet>
      ) : null}
      {panel === "keys" ? (
        <Sheet open onClose={closePanel} title="Keys">
          <div className="stack player-keylist">
            <dl>
              <dt>
                <kbd>Space</kbd>
              </dt>
              <dd>Done, pause or skip</dd>
              <dt>
                <kbd>Enter</kbd>
              </dt>
              <dd>Confirm the set</dd>
              <dt>
                <kbd>←</kbd> <kbd>→</kbd>
              </dt>
              <dd>Previous or next step</dd>
              <dt>
                <kbd>S</kbd>
              </dt>
              <dd>Swap</dd>
              <dt>
                <kbd>I</kbd>
              </dt>
              <dd>How-to</dd>
              <dt>
                <kbd>Esc</kbd>
              </dt>
              <dd>Close</dd>
            </dl>
            <button
              type="button"
              className="chipbtn"
              aria-pressed={auto}
              onClick={() => {
                writeAuto(!auto);
                setAuto(!auto);
              }}
            >
              Move on when a timer ends
            </button>
          </div>
        </Sheet>
      ) : null}
      {panel === "leave" ? (
        <Sheet
          open
          centered
          onClose={() => setPanel(null)}
          title="Leave the session?"
          footer={
            <div className="btn-row">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setPanel(null);
                  act(endSession);
                }}
              >
                End and review
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void leave()}>
                Leave
              </button>
            </div>
          }
        >
          <p>Your place is kept.</p>
        </Sheet>
      ) : null}
    </div>
  );
}

interface LogDraft {
  weight: string;
  reps: string;
  secs: string;
  flags: Record<string, boolean>;
}

const wholeOr = (text: string, fallback: number | null): number | null => {
  if (text.trim() === "") return null;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
};

/** The step ⇄ and ⓘ are about: the one in play, or during a rest the next one. */
function focusStep(state: PlayerState): Step | null {
  for (let i = state.index; i < state.live.steps.length; i++) {
    const s = state.live.steps[i]!;
    if (s.kind !== "rest") return s.exerciseId ? s : null;
  }
  return null;
}

/** What is left of the session: the steps still to come, and what remains of this one. */
function timeLeft(state: PlayerState, now: number): number {
  let ms = 0;
  for (let i = state.index; i < state.live.steps.length; i++) {
    const s = state.live.steps[i]!;
    ms += (s.seconds + (s.prepGap || 0) + (state.restExtra[i] ?? 0)) * 1000;
  }
  if (state.clock.anchor !== null || state.clock.bankedMs > 0) {
    const view = stepView(state, now);
    ms -= Math.min(view.elapsedMs, (view.step.seconds + (view.step.prepGap || 0) + (state.restExtra[state.index] ?? 0)) * 1000);
  }
  return Math.max(0, ms);
}

function primaryWord(step: Step | null, phase: string | null, logOpen: boolean, paused: boolean): string {
  if (!step) return "";
  if (logOpen) return "Confirm";
  if (step.kind === "set") return "Done";
  if (phase === "over" || step.kind === "rest") return "Next";
  return paused ? "Resume" : "Pause";
}

const sideWord = (side: Step["side"]) => (side ? `${side} side` : null);

function doseLine(step: Step, ex: SessionExerciseDto | undefined): string {
  const t = step.target ?? {};
  const each = ex?.laterality === "unilateral" ? " each side" : "";
  if (step.kind === "timed") return `${step.seconds} s${each}`;
  const reps = t.reps != null ? `${t.reps}${each}` : "";
  const w = t.w ? ` @ ${formatWeight(t.w)}` : "";
  return `${reps}${w}`.trim();
}

/** "Next · Right side", "Then · Supported row", or during a rest "Next · Supported row · 10 each side @ 20 lb". */
function nextLine(state: PlayerState, step: Step, exercises: Readonly<Record<string, SessionExerciseDto | undefined>>): string | null {
  for (let i = state.index + 1; i < state.live.steps.length; i++) {
    const n = state.live.steps[i]!;
    if (n.kind === "rest") continue;
    const name = (n.exerciseId && exercises[n.exerciseId]?.name) || null;
    if (step.kind === "rest") {
      const dose = doseLine(n, n.exerciseId ? exercises[n.exerciseId] : undefined);
      return ["Next", name, dose || null].filter(Boolean).join(" · ");
    }
    if (n.exerciseId === step.exerciseId && n.side && n.side !== step.side) return `Next · ${sideWord(n.side)}`;
    if (n.exerciseId === step.exerciseId) return null;
    return name ? `${step.kind === "set" ? "Then" : "Next"} · ${name}` : null;
  }
  return null;
}

function eyebrow(step: Step, careLabel: string | null): string {
  const block = step.kind === "rest" ? "Rest" : step.block === "care" ? (careLabel ?? "Care") : (BLOCK_LABEL[step.block] ?? step.block);
  if (step.kind === "rest") return block;
  const parts = [block];
  const format = FORMAT_LABEL[step.format.id];
  if (step.kind === "set") {
    if (step.format.group) parts.push(step.format.group);
    if (step.setCount && step.setCount > 1) parts.push(`set ${(step.setIndex ?? 0) + 1} of ${step.setCount}`);
  } else {
    if (format) parts.push(format);
    if (step.format.round && step.setCount && step.setCount > 1) parts.push(`round ${step.format.round} of ${step.setCount}`);
  }
  return parts.join(" · ");
}

function Ring({ fraction, children }: { fraction: number; children: React.ReactNode }) {
  const r = 46;
  const c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, fraction));
  return (
    <div className="player-ring">
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle className="player-ring-track" cx="50" cy="50" r={r} />
        <circle className="player-ring-fill" cx="50" cy="50" r={r} strokeDasharray={`${c * f} ${c}`} transform="rotate(-90 50 50)" />
      </svg>
      <div className="player-ring-face">{children}</div>
    </div>
  );
}

function StepBody({
  state,
  step,
  view,
  exercise,
  exercises,
  careLabel,
  log,
}: {
  state: PlayerState;
  step: Step;
  view: ReturnType<typeof stepView>;
  exercise: SessionExerciseDto | undefined;
  exercises: Readonly<Record<string, SessionExerciseDto | undefined>>;
  careLabel: string | null;
  log: React.ReactNode;
}) {
  const following = nextLine(state, step, exercises);
  if (step.kind === "rest") {
    return (
      <>
        <span className="eyebrow player-eyebrow">Rest</span>
        <span className="player-big num">{clockText(view.remainingMs)}</span>
        {state.paused ? <span className="player-meta">Paused</span> : null}
        {log}
        {following ? <span className="player-next">{following}</span> : null}
      </>
    );
  }
  const name = exercise?.name ?? step.exerciseId ?? "";
  if (step.kind === "set") {
    const t = step.target ?? {};
    const each = exercise?.laterality === "unilateral" ? " each side" : "";
    const metric = exercise?.dose.type === "time" ? "s" : "reps";
    return (
      <>
        <span className="eyebrow player-eyebrow">{eyebrow(step, careLabel)}</span>
        <h1 className="display player-name">{name}</h1>
        {log ?? (
          <>
            <span className="player-big num">{t.reps ?? t.secs ?? "—"}</span>
            <span className="player-meta">
              {metric}
              {each}
              {t.w ? ` @ ${formatWeight(t.w)}` : ""}
            </span>
          </>
        )}
        {following ? <span className="player-next">{following}</span> : null}
      </>
    );
  }
  const ready = view.phase === "ready";
  return (
    <>
      <span className="eyebrow player-eyebrow">{eyebrow(step, careLabel)}</span>
      <h1 className="display player-name">{name}</h1>
      {step.side ? <span className="player-meta">{sideWord(step.side)}</span> : null}
      <Ring fraction={view.phaseMs > 0 ? view.remainingMs / view.phaseMs : 0}>
        {ready ? <span className="eyebrow player-ring-label">Get ready</span> : null}
        <span className="player-big num">{clockText(view.remainingMs)}</span>
      </Ring>
      {state.paused ? <span className="player-meta">Paused</span> : null}
      {following ? <span className="player-next">{following}</span> : null}
    </>
  );
}

function Actions({
  state,
  step,
  phase,
  logOpen,
  onPrimary,
  onConfirm,
  onSkip,
  onAddRest,
  onPause,
}: {
  state: PlayerState;
  step: Step;
  phase: string;
  logOpen: boolean;
  onPrimary: () => void;
  onConfirm: () => void;
  onSkip: () => void;
  onAddRest: () => void;
  onPause: () => void;
}) {
  if (step.kind === "set") {
    if (logOpen) {
      const rest = state.live.steps[state.index + 1];
      const label = rest?.kind === "rest" ? `Confirm · rest ${rest.seconds} s` : "Confirm";
      return (
        <button type="button" className="btn btn-primary player-primary" onClick={onConfirm}>
          {label}
        </button>
      );
    }
    return (
      <button type="button" className="btn btn-primary player-primary" onClick={onPrimary}>
        Done
      </button>
    );
  }
  if (phase === "over") {
    return (
      <button type="button" className="btn btn-primary player-primary" onClick={onSkip}>
        Next
      </button>
    );
  }
  if (step.kind === "rest") {
    return (
      <div className="btn-row player-pair">
        <button type="button" className="btn" onClick={onAddRest}>
          +15 s
        </button>
        <button type="button" className="btn" onClick={onSkip}>
          Skip
        </button>
      </div>
    );
  }
  return (
    <div className="btn-row player-pair">
      <button type="button" className="btn" onClick={onPause}>
        {state.paused ? "Resume" : "Pause"}
      </button>
      <button type="button" className="btn" onClick={onSkip}>
        Skip
      </button>
    </div>
  );
}

function LogCard({
  state,
  draft,
  setDraft,
  flags,
  location,
  unit,
}: {
  state: PlayerState;
  draft: LogDraft;
  setDraft: (d: LogDraft) => void;
  flags: Array<{ id: string; label: string }>;
  location: { equipment: string[]; implements: Record<string, Weight[]>; id: string };
  unit: WeightUnit;
}) {
  const t = logTarget(state);
  if (!t) return null;
  const kbWeights = Lib.kettlebellsAt(location);
  const ctx = { implement: t.entry.implement, kbWeights };
  const current = parseWeight(draft.weight, t.w?.u ?? unit);
  const stepW = (dir: 1 | -1) => {
    const base = current ?? t.w ?? kbWeights[0] ?? null;
    if (!base) return;
    setDraft({ ...draft, weight: formatWeight(current ? Prog.stepWeight(base, dir, ctx) : base) });
  };
  const stepN = (field: "reps" | "secs", by: number) => {
    const n = Number(draft[field]);
    const v = Math.max(0, (Number.isFinite(n) ? n : 0) + by);
    setDraft({ ...draft, [field]: String(v) });
  };
  return (
    <div className="player-log" role="group" aria-label="Log this set">
      {t.entry.log === "load" ? (
        <Stepper
          label="Weight"
          inputMode="decimal"
          value={draft.weight}
          onChange={(weight) => setDraft({ ...draft, weight })}
          lessLabel="Lighter"
          moreLabel="Heavier"
          onLess={() => stepW(-1)}
          onMore={() => stepW(1)}
        />
      ) : null}
      {t.entry.metric === "reps" ? (
        <Stepper
          label="Reps"
          inputMode="numeric"
          value={draft.reps}
          onChange={(reps) => setDraft({ ...draft, reps })}
          lessLabel="Fewer reps"
          moreLabel="More reps"
          onLess={() => stepN("reps", -1)}
          onMore={() => stepN("reps", 1)}
        />
      ) : (
        <Stepper
          label="Seconds"
          inputMode="numeric"
          value={draft.secs}
          onChange={(secs) => setDraft({ ...draft, secs })}
          lessLabel="Fewer seconds"
          moreLabel="More seconds"
          onLess={() => stepN("secs", -5)}
          onMore={() => stepN("secs", 5)}
        />
      )}
      {flags.length > 0 ? (
        <div className="row player-flags">
          {flags.map((f) => (
            <button
              key={f.id}
              type="button"
              className="chipbtn"
              aria-pressed={!!draft.flags[f.id]}
              onClick={() => setDraft({ ...draft, flags: { ...draft.flags, [f.id]: !draft.flags[f.id] } })}
            >
              {f.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

