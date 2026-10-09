/**
 * THE SESSION SHEET (Phase 2a Task 7; mocks §2–3) — the workout sheet for a program slot, from Today and Plan.
 *
 * The pre-check first, when today's reading is missing (the same reading the Today chip records — either answers
 * the other); then what was built and why: mode · theme · time · place as chips, each a short picker that rebuilds;
 * one reason line; the moves by block with their format, dose, ↑ (up today) and New; ⇄ offers the slot's
 * alternatives and Use rebuilds with the swap; ⓘ opens the how-to. Opening the sheet builds (the server returns
 * the stored build when nothing changed), so a reading given on the Today chip is always the one built with.
 *
 *  - A day ahead is a preview (no pre-check, never startable); a day gone offers "Move to today".
 *  - A started or done session is read-only: no pickers, no swaps. A done one this device still holds in progress was
 *    saved on another device (ruling 2b-R18): that copy is offered for Discard only, never Continue.
 *  - A skipped session says so and offers Un-skip, and nothing else: no pre-check, no build, no Skip (ruling 2a-R15).
 *  - Start (and Continue) belong to the player, which arrives in 2b: hidden behind `features.player` until then.
 *  - "Don't show again" on a swap writes the move's prefs (`PUT /api/library/:id/prefs`, 2c): left out until then.
 *
 * THE WATCH (Phase 3 Task 8; approved mocks §1–2, owner call 7: the state sits in the pinned foot). `session.watch` is
 * null while the switch is off, and then nothing about the watch renders. `ready` → Send to watch beside Start, which
 * opens the preview (watch-preview-sheet.tsx); `sending` → "Sending…"; `on_watch` → "On your watch" with Take off
 * watch, which asks first; `failed` → "Couldn't send" with Retry, which previews first. A session too long for the
 * watch still offers Send to watch: its preview says so where Send would be (owner call 8). A sent session's build is
 * the watch's — read-only — but Start, Move and Skip stay (Move takes it off the watch). Send and Take off only queue
 * (ruling 3-R11): right after either, the sheet asks for the drain (a request of its own that runs the job) and then
 * reads the session, and reads it again every few seconds while it is "Sending…".
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  ApiError,
  type BuildSessionRequest,
  type MeResponse,
  type SessionDto,
  type SessionItemDto,
  type SessionOverrides,
  type WorkoutDto,
} from "@rg/api-client";
import { doseText, type DoseStep, type DoseTarget } from "@rg/domain";
import { Banner, CompletionPill, ConfirmDialog, EmptyState, formatDayLong, formatTime, Sheet, Spinner } from "../components.js";
import { features } from "../features.js";
import { IconAlert, IconInfo, IconSwap, IconWatch } from "../icons.js";
import { offlineDb, type OfflineDb } from "../offline/idb.js";
import { readLive, requestPersistentStorage } from "../offline/live.js";
import { chimes } from "../player/audio.js";
import { discardHere } from "../player/save.js";
import { rememberStart, saveBasis } from "../player/stored.js";
import { MoveSheet } from "../screens/move-sheet.js";
import { CheckScale, checkWord, conditionChipLabel, FeelingOffToggle } from "./condition-check-sheet.js";
import { ExerciseHowto, type HowtoTarget } from "./exercise-howto.js";
import { continuable, MODE_LABEL } from "./today-program.js";
import { WatchPreviewSheet } from "./watch-preview-sheet.js";

type Mode = keyof typeof MODE_LABEL;
type Picker = "mode" | "theme" | "minutes" | "place";

const BLOCK_ORDER = ["arrive", "prep", "core", "accessory", "care", "cooldown"] as const;
export const BLOCK_LABEL: Record<string, string> = {
  arrive: "Arrive",
  prep: "Prep",
  core: "Core",
  accessory: "Accessory",
  cooldown: "Cool-down",
};
/** Format markers worth a word; a block of holds or straight sets says nothing more than its name. */
export const FORMAT_LABEL: Record<string, string> = { flow: "Flow", superset: "Superset", circuit: "Circuit", ladder: "Ladder" };
/** The time picker's lengths (the build takes 10–90). */
const MINUTES = [15, 20, 25, 30, 40, 45, 60, 75, 90];
const PICKER_TITLE: Record<Picker, string> = { mode: "Mode", theme: "Theme", minutes: "Time", place: "Place" };
/** How long Start waits for the review's basis before the player opens (ruling 2b-R10: Start stays quick). */
const START_BASIS_WAIT_MS = 1_500;
/** How often the sheet reads the session again while it is "Sending…" (the drain, or the hourly lane, runs the push). */
const WATCH_POLL_MS = 4_000;
/** The watch states of a SENT build (its push queued, running, failed or verified). */
const SENT_STATES: ReadonlyArray<string> = ["sending", "on_watch", "failed", "off_watch"];

/** The program's name: the row's title without the theme a build appends. */
function withoutTheme(title: string, theme: string | null | undefined): string {
  const suffix = theme ? ` · ${theme}` : null;
  return suffix && title.endsWith(suffix) ? title.slice(0, -suffix.length) : title;
}

function itemDose(s: SessionDto, item: SessionItemDto): { text: string; up: boolean } {
  const build = s.build!;
  const target = (build.targets[item.exerciseId] as DoseTarget | undefined) ?? null;
  const steps = build.steps.filter((st) => st.slotKey === item.slotKey && st.kind !== "rest") as unknown as DoseStep[];
  return {
    text: doseText({ sets: item.sets, steps, target, perSide: build.exercises[item.exerciseId]?.laterality === "unilateral" }),
    up: target?.action === "up",
  };
}

export function SessionSheet({ w, today, onClose }: { w: WorkoutDto; today: string; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const key = ["session", w.id];
  const session = useQuery({
    queryKey: key,
    queryFn: () => api.getSession(w.id),
    // "Sending…" moves on when the push runs: read again until it has.
    refetchInterval: (q) => (q.state.data?.watch?.state === "sending" ? WATCH_POLL_MS : false),
  });
  const gone = session.error instanceof ApiError && session.error.status === 404;
  const programs = useQuery({ queryKey: ["programs"], queryFn: api.listPrograms, staleTime: 60_000 });
  const [picker, setPicker] = useState<Picker | null>(null);
  const [swapping, setSwapping] = useState<string | null>(null);
  const [howto, setHowto] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [off, setOff] = useState<Record<string, boolean>>({});
  /** The pre-check reopened from the reading on the when-line, to change the answer (ruling 2a-R14). */
  const [rechecking, setRechecking] = useState(false);
  const asked = useRef(false);
  /** After Build: focus the reading (or the sheet) once the pre-check is gone. */
  const refocus = useRef(false);
  const body0 = useRef<HTMLDivElement>(null);

  const refreshPlan = () => {
    for (const k of ["today", "plan", "plan-week", "programs"]) void qc.invalidateQueries({ queryKey: [k] });
  };
  const build = useMutation({
    mutationFn: (body: BuildSessionRequest) => api.buildSession(w.id, body),
    onSuccess: (next) => {
      const before = qc.getQueryData<SessionDto>(key);
      qc.setQueryData(key, next);
      // A new build renames and resizes the row; so does a stored build adopted by an outline row (the row's state
      // changes, 2a UI re-review U5). The stored build returned unchanged changed nothing.
      if (
        next.build?.buildId !== before?.build?.buildId ||
        next.build?.builtAt !== before?.build?.builtAt ||
        next.contentState !== before?.contentState
      )
        refreshPlan();
    },
    onError: (err) => {
      const body = err instanceof ApiError ? (err.body as { error?: string; session?: SessionDto } | null) : null;
      if (body?.error === "locked" && body.session) qc.setQueryData(key, body.session);
      else void qc.invalidateQueries({ queryKey: key });
    },
  });
  /** The session's name as the player shows it (kept for the Start handler, which runs after this render). */
  const titleRef = useRef("");
  /** Start locked the session, but the device could not keep it (no IndexedDB, storage full): said before it plays. */
  const [notKept, setNotKept] = useState(false);
  const start = useMutation({
    mutationFn: (buildId: string) => api.startSession(w.id, buildId),
    onSuccess: async (next) => {
      qc.setQueryData(key, next);
      refreshPlan();
      // The player plays what Start leaves on the device, never the network (ruling 2b-R1). Without IndexedDB it
      // still opens, online, from the started session — but it keeps nothing, so the sheet says so first and Continue
      // goes on (audit 2b-B I-2).
      let db: OfflineDb;
      try {
        db = await offlineDb();
        await rememberStart(db, next, titleRef.current, qc.getQueryData<MeResponse>(["me"])?.userId ?? null);
      } catch {
        setNotKept(true);
        return;
      }
      // The review's basis comes in the same tap (ruling 2b-R10): a network gone right after Start still leaves the
      // review its records and graduation offers. Waited for only so long; it lands later if slow, and the player
      // asks for it itself when it isn't there.
      const buildId = next.build?.buildId;
      const basis = api
        .reviewBasis(w.id)
        .then((b) => (b.buildId === buildId ? saveBasis(db, w.id, b) : undefined))
        .catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([basis, new Promise<void>((resolve) => (timer = setTimeout(resolve, START_BASIS_WAIT_MS)))]);
      clearTimeout(timer);
      navigate(`/session/${encodeURIComponent(w.id)}`);
    },
    // The day's inputs changed since this build (a check, a save, an edit): show the fresh build to Start again. The
    // fresh build may have renamed or resized the row, so Today and Plan refetch too.
    onError: (err) => {
      const body = err instanceof ApiError ? (err.body as { error?: string; session?: SessionDto } | null) : null;
      if ((body?.error === "stale" || body?.error === "locked") && body.session) qc.setQueryData(key, body.session);
      else void qc.invalidateQueries({ queryKey: key });
      refreshPlan();
    },
  });
  const skip = useMutation({
    mutationFn: () => api.skip(w.id),
    onSuccess: () => {
      refreshPlan();
      onClose();
    },
  });
  const unskip = useMutation({
    mutationFn: () => api.unskipWorkout(w.id),
    onSuccess: () => {
      refreshPlan();
      // Completion feeds the garden, as the run sheet's Un-skip does.
      void qc.invalidateQueries({ queryKey: ["garden"] });
      void qc.invalidateQueries({ queryKey: key });
    },
  });
  const moveToToday = useMutation({
    mutationFn: () => api.move(w.id, today, w.effectiveTime),
    onSuccess: () => {
      refreshPlan();
      void qc.invalidateQueries({ queryKey: key });
    },
  });
  // The watch (Phase 3). Send (in the preview) and Take off only QUEUE (ruling 3-R11): the drain runs the job in a
  // request of its own, then the session says how it went. A drain that fails is no error to show — the hourly lane
  // runs the job, and the sheet keeps "Sending…" (and reads again) until it has.
  const [previewing, setPreviewing] = useState(false);
  const [confirmingTakeOff, setConfirmingTakeOff] = useState(false);
  const afterWatchWrite = (next: SessionDto) => {
    qc.setQueryData(key, next);
    refreshPlan();
    void api
      .drainWatch()
      .catch(() => undefined)
      .finally(() => {
        void qc.invalidateQueries({ queryKey: key });
        refreshPlan();
      });
  };
  const takeOff = useMutation({
    mutationFn: () => api.takeOffWatch(w.id),
    onSuccess: (next) => {
      setConfirmingTakeOff(false);
      afterWatchWrite(next);
    },
    // Offline, or refused: the confirm stays open and says so (audit 3-B UI-3) — never closed as if it went through.
    onError: () => void qc.invalidateQueries({ queryKey: key }),
  });
  const askTakeOff = () => {
    takeOff.reset();
    setConfirmingTakeOff(true);
  };
  const takeOffButton = (
    <button type="button" className="btn" disabled={takeOff.isPending} onClick={askTakeOff}>
      Take off watch
    </button>
  );

  const s = session.data;
  const date = s?.date ?? w.effectiveDate;
  const locked = !!s && (s.locked || s.contentState === "started" || s.contentState === "done");
  const past = date < today;
  const ahead = date > today;
  // Skipped is not today's to-do (ruling 2a-R15): nothing is asked or built until it is un-skipped.
  const skipped = w.completionState === "skipped";
  const changeable = !!s && !locked && !skipped && !past && !ahead;
  const unanswered = s && changeable ? s.profiles.filter((p) => !s.checks[p.profileId]) : [];
  const needsCheck = unanswered.length > 0;
  // What the pre-check asks: the profiles still unanswered, or — reopened from the reading — every one.
  const asking = needsCheck ? unanswered : s && changeable && rechecking ? s.profiles : [];
  const preCheck = asking.length > 0;

  // Opening builds — or returns the stored build when nothing changed — unless the pre-check comes first.
  useEffect(() => {
    if (!s || asked.current || locked || skipped || past || needsCheck) return;
    asked.current = true;
    build.mutate({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s, locked, skipped, past, needsCheck]);

  // The pre-check (ruling 2a-R14): a number, Feeling off, or both, per profile, in any order — nothing is sent until
  // Build, which waits for every profile asked to have one or the other. Feeling off alone is an answer.
  const answer = (profileId: string, value: number | null) =>
    setAnswers((cur) => {
      const next = { ...cur };
      if (value === null) delete next[profileId];
      else next[profileId] = value;
      return next;
    });
  const answered = asking.every((p) => answers[p.profileId] !== undefined || !!off[p.profileId]);
  const submit = () => {
    asked.current = true;
    build.mutate(
      {
        checks: Object.fromEntries(
          asking.map((p) => [p.profileId, { pre: answers[p.profileId] ?? null, feelingOff: !!off[p.profileId] }]),
        ),
      },
      {
        onSuccess: () => {
          setRechecking(false);
          // Build leaves with the pre-check: focus goes to the reading, not out of the dialog (2a UI re-review U7).
          refocus.current = true;
        },
      },
    );
  };
  // The reading on the when-line reopens the pre-check, filled in with the reading as it stands.
  const recheck = () => {
    if (rechecking || !s) {
      setRechecking(false);
      return;
    }
    const held = s.profiles.flatMap((p) => (s.checks[p.profileId] ? [[p.profileId, s.checks[p.profileId]!] as const] : []));
    setAnswers(Object.fromEntries(held.flatMap(([id, c]) => (c.pre === null ? [] : [[id, c.pre]]))));
    setOff(Object.fromEntries(held.map(([id, c]) => [id, c.feelingOff])));
    setRechecking(true);
  };

  const program = programs.data?.programs.find((p) => p.id === w.programId);
  const title = program?.name ?? withoutTheme(w.title, s?.view?.theme?.name);
  titleRef.current = title;
  // A started or done session reads as it was built — a later check cannot change it (2a UI re-review U3).
  const shownChecks = s && locked && s.build ? s.build.params.checks : (s?.checks ?? {});
  const readings = s
    ? s.profiles
        .filter((p) => shownChecks[p.profileId])
        .map((p) => conditionChipLabel({ ...p, today: { value: shownChecks[p.profileId]!.pre, feelingOff: shownChecks[p.profileId]!.feelingOff } }))
    : [];
  const reading = readings.join(" · ");

  const view = s?.view ?? null;
  const params = s?.build?.params ?? { checks: {}, overrides: {}, swaps: {} };
  const rebuild = (patch: SessionOverrides) => build.mutate({ overrides: { ...params.overrides, ...patch } });
  const pickMode = (mode: Mode) => {
    // A theme picked by hand stays only while it suits the new mode.
    const { theme, ...rest } = params.overrides;
    const keepTheme = theme && s?.choices.themes.find((t) => t.id === theme)?.modes.includes(mode);
    build.mutate({ overrides: { ...rest, ...(keepTheme ? { theme } : {}), mode } });
  };

  const showBuild = !!(s?.build && view) && !preCheck;
  useEffect(() => {
    if (!refocus.current || preCheck) return;
    refocus.current = false;
    const el = body0.current;
    const target = el?.querySelector<HTMLElement>(".session-reading") ?? el?.closest<HTMLElement>('[role="dialog"]');
    target?.focus();
  });
  // Done on the server while this device still holds the session in progress: it was played and saved on another
  // device (ruling 2b-R18). This device's copy is offered for Discard only — never Continue, whose save would be a
  // second session for the slot (the server refuses it, 409 slot_done).
  const doneOnServer = features.player && s?.contentState === "done";
  const copyHere = useQuery({
    queryKey: ["live-session", w.id],
    queryFn: async () => (await readLive(await offlineDb(), w.id)) ?? null,
    enabled: doneOnServer,
    retry: false,
    staleTime: 0,
    networkMode: "always",
  });
  const savedElsewhere = doneOnServer && !!copyHere.data;
  const [discardingCopy, setDiscardingCopy] = useState(false);
  const discardCopy = useMutation({
    mutationFn: async () => discardHere(await offlineDb(), w.id),
    networkMode: "always",
    onSuccess: () => {
      setDiscardingCopy(false);
      void qc.invalidateQueries({ queryKey: ["live-session", w.id] });
      void qc.invalidateQueries({ queryKey: ["live-sessions"] });
    },
  });
  const canPlay = features.player && date === today && !past && !skipped;
  // A started session keeps Continue while its save would be taken: its build's day and the day after (ruling 2b-R16).
  const canContinue = features.player && !skipped && s?.contentState === "started" && continuable(s.build?.date ?? date, today);
  // SENT TO THE WATCH (Phase 3): Send locks the build and the slot stays built. The build is the watch's, so nothing
  // rebuilds it — but the session is still today's to do: Start plays that very build, Move takes it off the watch,
  // Skip leaves the watch alone. Sent is what the session's watch says, never the lock alone (audit 3-B UI-13): a
  // locked build still built is also a Start whose two writes split, or one sent before the switch went off — and
  // that sheet stays read-only, as it was before the watch.
  const watch = s?.watch ?? null;
  const sentHere = !!s && s.locked && s.contentState === "built" && !!watch && SENT_STATES.includes(watch.state);
  // Nothing about the watch on a done session (its copy is the session the athlete did, and stays). A skipped one offers
  // Un-skip and nothing else (2a-R15) — unless its copy is still on the watch, which Skip leaves alone: then it says so,
  // with Take off watch (audit 3-B UI-12).
  const watchShown =
    !!s && !!watch && s.contentState !== "done" && w.completionState !== "completed" && (!skipped || watch.state === "on_watch");
  const offersSend =
    watchShown && showBuild && (watch!.state === "ready" || (watch!.state === "unavailable" && watch!.reason === "too_long"));
  // The pinned foot holds the sheet's actions — and is left out when there are none (loading, or a started or done
  // session without the player), rather than drawn as an empty band (audit 2a-UI M6).
  const actions: React.ReactNode[] = [];
  let startButton: React.ReactNode = null;
  if (skipped) {
    actions.push(
      <button key="unskip" type="button" className="btn" disabled={unskip.isPending} onClick={() => unskip.mutate()}>
        Un-skip
      </button>,
    );
  } else {
    if (preCheck) {
      actions.push(
        <button key="build" type="button" className="btn btn-primary" disabled={!answered || build.isPending} onClick={submit}>
          Build
        </button>,
      );
    }
    if (canPlay && showBuild && (!locked || sentHere)) {
      startButton = (
        <button
          key="start"
          type="button"
          className="btn btn-primary"
          disabled={start.isPending}
          onClick={() => {
            // Inside the tap: audio unlocks only in a gesture, and storage is asked to persist (offline spike).
            chimes.unlock();
            void requestPersistentStorage();
            start.mutate(s!.build!.buildId);
          }}
        >
          Start · {view!.minutes} min
        </button>
      );
      // Beside Send to watch on a row of its own when the watch is offered; first among the actions otherwise.
      if (!offersSend) actions.push(startButton);
    }
    if (canContinue) {
      actions.push(
        <button
          key="continue"
          type="button"
          className="btn btn-primary"
          onClick={() => {
            chimes.unlock();
            navigate(`/session/${encodeURIComponent(w.id)}`);
          }}
        >
          Continue
        </button>,
      );
    }
    if (savedElsewhere) {
      actions.push(
        <button key="discard-copy" type="button" className="btn" disabled={discardCopy.isPending} onClick={() => setDiscardingCopy(true)}>
          Discard this device's copy
        </button>,
      );
    }
    if (past && !locked) {
      actions.push(
        <button key="today" type="button" className="btn btn-primary" disabled={moveToToday.isPending} onClick={() => moveToToday.mutate()}>
          Move to today
        </button>,
      );
    }
    if ((!locked || sentHere) && s) {
      actions.push(
        <button key="move" type="button" className="btn" onClick={() => setMoving(true)}>
          Move
        </button>,
        <button key="skip" type="button" className="btn" disabled={skip.isPending} onClick={() => skip.mutate()}>
          Skip
        </button>,
      );
    }
  }
  // The watch's state, in the foot where Send to watch was tapped (owner call 7), each with its one action. "Sending…"
  // offers Take off too (owner, 2026-10-09): a push that cannot run for a while (COROS unreachable) is stopped there,
  // the queued push superseded — not only by Move.
  let watchRow: React.ReactNode = null;
  if (watchShown && watch!.state === "sending") {
    watchRow = (
      <div key="watch" className="watch-state" role="status">
        <span className="watch-state-label watch-state-label--muted">
          <span className="watch-spin" aria-hidden="true" />
          Sending…
        </span>
        {takeOffButton}
      </div>
    );
  } else if (watchShown && watch!.state === "on_watch") {
    watchRow = (
      <div key="watch" className="watch-state">
        <span className="watch-state-label watch-state-label--ok">
          <IconWatch size={16} />
          On your watch
        </span>
        {takeOffButton}
      </div>
    );
  } else if (watchShown && watch!.state === "failed") {
    watchRow = (
      <div key="watch" className="watch-state watch-state--warn">
        <span className="watch-state-label">
          <IconAlert size={16} />
          Couldn't send
        </span>
        <button type="button" className="btn btn-small" onClick={() => setPreviewing(true)}>
          Retry
        </button>
      </div>
    );
  }
  const footRows: React.ReactNode[] = [];
  if (watchRow) footRows.push(watchRow);
  if (offersSend) {
    footRows.push(
      <div key="send" className="btn-row btn-row--split">
        {startButton}
        <button type="button" className="btn" onClick={() => setPreviewing(true)}>
          <IconWatch size={16} />
          Send to watch
        </button>
      </div>,
    );
  }
  if (actions.length > 0) footRows.push(<div key="actions" className="btn-row">{actions}</div>);
  // One column, top to bottom as drawn: the sheet's foot stacks its children in reverse (styles.css `.sheet-foot`).
  // Without the watch in it, the action row sits straight in the foot, as it did before the watch (audit 3-B UI-2).
  const footer = watchRow || offersSend ? <div className="session-foot">{footRows}</div> : (footRows[0] ?? null);

  let body: React.ReactNode;
  if (session.isLoading) body = <Spinner label="Loading the session" />;
  // Only a 404 means the session left the plan; a failure to load says that (audit 2a-UI M7).
  else if (!s)
    body = gone ? (
      <EmptyState title="This session is no longer in the plan" />
    ) : (
      <Banner kind="warn">Couldn't load this session — try again in a moment.</Banner>
    );
  else if (skipped) {
    body = (
      <div className="stack">
        <p className="session-status">
          <CompletionPill state="skipped" />
        </p>
        {showBuild ? <BuiltSession s={s} locked onPick={setPicker} onSwap={setSwapping} onHowto={setHowto} /> : null}
      </div>
    );
  } else if (preCheck) {
    body = (
      <div className="stack session-precheck">
        {asking.map((p) => (
          <section key={p.profileId} className="stack">
            <b>{p.check.label} right now</b>
            <CheckScale
              label={p.check.label}
              min={p.check.min}
              max={p.check.max}
              value={answers[p.profileId] ?? null}
              disabled={build.isPending}
              onPick={(n) => answer(p.profileId, n)}
            />
            <div className="row">
              <FeelingOffToggle
                on={!!off[p.profileId]}
                disabled={build.isPending}
                word={asking.length > 1 ? checkWord(p.check.label) : undefined}
                onToggle={() => setOff((o) => ({ ...o, [p.profileId]: !o[p.profileId] }))}
              />
            </div>
          </section>
        ))}
        {program?.block ? (
          <div className="session-blockrow">
            <b>
              Block {program.block.number} · week {program.block.week} of {program.block.weeks}
            </b>
            <small>
              {program.block.core
                .map((c) => c.name)
                .filter(Boolean)
                .join(" · ")}
            </small>
          </div>
        ) : null}
        {build.isError ? <Banner kind="warn">Couldn't build this session — try again in a moment.</Banner> : null}
      </div>
    );
  } else if (!showBuild) {
    // A day gone is never built (audit 2a-UI I2): a plain line, never a spinner for a build that will not start.
    body = past ? (
      <p className="session-none">Nothing was built for this day.</p>
    ) : build.isError ? (
      <Banner kind="warn">Couldn't build this session — try again in a moment.</Banner>
    ) : (
      <Spinner label="Building the session" />
    );
  } else {
    // A day gone keeps the build it had, read-only: it can no longer be rebuilt (only moved to today).
    body = <BuiltSession s={s} locked={locked || past} onPick={setPicker} onSwap={setSwapping} onHowto={setHowto} />;
  }

  const items = s?.build?.items ?? [];
  const swapItem = swapping ? items.find((i) => i.slotKey === swapping) : undefined;
  const howtoItem = howto ? items.find((i) => i.slotKey === howto) : undefined;

  return (
    <Sheet open onClose={onClose} title={title} footer={footer}>
      <div ref={body0} className="stack session-sheet">
        <p className="session-when">
          {formatDayLong(date)} at {formatTime(w.effectiveTime)}
          {reading ? " · " : null}
          {reading && changeable && !needsCheck ? (
            <button type="button" className="linklike session-reading" aria-expanded={rechecking} onClick={recheck}>
              {reading}
            </button>
          ) : (
            reading
          )}
        </p>
        {notKept ? (
          <Banner kind="warn">
            This session isn't being kept on this device. It plays while you're online, and a reload starts it again.
          </Banner>
        ) : null}
        {savedElsewhere ? (
          <p className="session-status">Saved on another device. This device still holds a copy of it, which won't be saved.</p>
        ) : null}
        {body}
      </div>
      <ConfirmDialog
        open={discardingCopy}
        onClose={() => setDiscardingCopy(false)}
        title="Discard this device's copy?"
        confirmLabel="Discard this copy"
        busy={discardCopy.isPending}
        onConfirm={() => discardCopy.mutate()}
      >
        This session was saved on another device. What this device kept of it won't be saved.
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmingTakeOff}
        onClose={() => setConfirmingTakeOff(false)}
        title="Take this session off your watch?"
        confirmLabel="Take off watch"
        busy={takeOff.isPending}
        onConfirm={() => takeOff.mutate()}
        error={takeOff.isError ? "Couldn't take it off — try again in a moment." : null}
      >
        It stays in the app.
      </ConfirmDialog>
      {previewing && s ? (
        <WatchPreviewSheet
          workoutId={w.id}
          minutes={view?.minutes ?? null}
          onClose={() => setPreviewing(false)}
          onSent={(next) => {
            setPreviewing(false);
            afterWatchWrite(next);
          }}
          onStale={(next) => {
            // The day's inputs moved on since this build (as Start's 409): the fresh session, to send again.
            setPreviewing(false);
            qc.setQueryData(key, next);
            refreshPlan();
          }}
          onRefused={() => {
            setPreviewing(false);
            void qc.invalidateQueries({ queryKey: key });
          }}
        />
      ) : null}
      {picker && view && s ? (
        <ChoiceSheet
          title={PICKER_TITLE[picker]}
          onClose={() => setPicker(null)}
          options={
            picker === "mode"
              ? s.choices.modes.map((m) => ({ id: m, label: MODE_LABEL[m], on: m === view.mode }))
              : picker === "theme"
                ? s.choices.themes
                    .filter((t) => t.modes.includes(view.mode))
                    .map((t) => ({ id: t.id, label: t.name, on: t.id === view.theme?.id }))
                : picker === "minutes"
                  ? [...new Set([...MINUTES, view.minutes])]
                      .sort((a, b) => a - b)
                      .map((m) => ({ id: String(m), label: `${m} min`, on: m === view.minutes }))
                  : s.choices.locations.map((l) => ({ id: l.id, label: l.name, on: l.id === view.location.id }))
          }
          onPick={(id) => {
            setPicker(null);
            if (picker === "mode") pickMode(id as Mode);
            else if (picker === "theme") rebuild({ theme: id });
            else if (picker === "minutes") rebuild({ minutes: Number(id) });
            else rebuild({ locationId: id });
          }}
        />
      ) : null}
      {swapItem && s?.build ? (
        <Sheet open onClose={() => setSwapping(null)} title={`Swap ${s.build.exercises[swapItem.exerciseId]?.name ?? ""}`}>
          <div className="choice-moves">
            {(s.build.alternatives[swapItem.slotKey] ?? []).map((alt) => (
              <div key={alt.id} className="choice-move">
                <div className="choice-move-text">
                  <b>{alt.name}</b>
                  {alt.reasons.length > 0 ? <small>{alt.reasons.join(" · ")}</small> : null}
                </div>
                <button
                  type="button"
                  className="btn"
                  disabled={build.isPending}
                  onClick={() => {
                    const from = params.swaps[swapItem.slotKey]?.from ?? swapItem.exerciseId;
                    setSwapping(null);
                    build.mutate({ swaps: { ...params.swaps, [swapItem.slotKey]: { from, to: alt.id } } });
                  }}
                >
                  Use
                </button>
              </div>
            ))}
          </div>
        </Sheet>
      ) : null}
      {howtoItem && s?.build?.exercises[howtoItem.exerciseId] ? (
        <ExerciseHowto
          exercise={s.build.exercises[howtoItem.exerciseId]!}
          item={howtoItem}
          target={(s.build.targets[howtoItem.exerciseId] as HowtoTarget | undefined) ?? null}
          profiles={s.profiles}
          exercises={s.build.exercises}
          onClose={() => setHowto(null)}
        />
      ) : null}
      <MoveSheet
        workout={w}
        open={moving}
        onClose={() => {
          setMoving(false);
          void qc.invalidateQueries({ queryKey: key });
        }}
      />
    </Sheet>
  );
}

/** What was built: the chips, the reason line, and the moves by block. */
function BuiltSession({
  s,
  locked,
  onPick,
  onSwap,
  onHowto,
}: {
  s: SessionDto;
  locked: boolean;
  onPick: (p: Picker) => void;
  onSwap: (slotKey: string) => void;
  onHowto: (slotKey: string) => void;
}) {
  const build = s.build!;
  const view = s.view!;
  const careLabel = s.profiles.find((p) => p.care)?.care ?? "Care";
  const chips: Array<{ picker: Picker; label: string; on?: boolean; can: boolean }> = [
    { picker: "mode", label: MODE_LABEL[view.mode], on: true, can: s.choices.modes.length > 1 },
    { picker: "theme", label: view.theme?.name ?? "Theme", can: s.choices.themes.some((t) => t.modes.includes(view.mode)) },
    { picker: "minutes", label: `${view.minutes} min`, can: true },
    { picker: "place", label: view.location.name, can: s.choices.locations.length > 1 },
  ];
  return (
    <div className="stack session-built">
      <div className="session-chips">
        {chips.map((c) =>
          locked || !c.can ? (
            <span key={c.picker} className={`session-chip${c.on ? " is-on" : ""}`}>
              {c.label}
            </span>
          ) : (
            <button
              key={c.picker}
              type="button"
              className={`session-chip${c.on ? " is-on" : ""}`}
              aria-haspopup="dialog"
              onClick={() => onPick(c.picker)}
            >
              {c.label} ▾
            </button>
          ),
        )}
      </div>
      {view.modeReasons.length > 0 ? <p className="session-reason">{view.modeReasons.join(" ")}</p> : null}
      <div className="session-blocks">
        {BLOCK_ORDER.map((blockId) => {
          const items = build.items.filter((i) => i.block === blockId);
          if (items.length === 0) return null;
          const format = FORMAT_LABEL[items[0]!.format];
          const rounds = Math.max(
            1,
            ...build.steps.filter((st) => st.block === blockId).map((st) => st.format.round ?? 1),
          );
          const label = blockId === "care" ? careLabel : BLOCK_LABEL[blockId]!;
          return (
            <section key={blockId} className="session-block">
              <h3 className="session-block-head">
                {label}
                {format ? ` · ${format}${rounds > 1 ? ` × ${rounds}` : ""}` : ""}
              </h3>
              {items.map((item) => {
                const ex = build.exercises[item.exerciseId];
                const name = ex?.name ?? item.exerciseId;
                const dose = itemDose(s, item);
                const alternatives = build.alternatives[item.slotKey] ?? [];
                return (
                  <div key={item.slotKey} className="session-move">
                    <span className="session-move-n">{item.group ?? ""}</span>{" "}
                    <span className="session-move-text">
                      <b>{name}</b>
                      {item.isNew ? (
                        <>
                          {" "}
                          <span className="session-new">New</span>
                        </>
                      ) : null}{" "}
                      <small>
                        {dose.text}
                        {dose.up ? (
                          <>
                            {" "}
                            <span className="dose-up" title="Goes up today">
                              ↑
                            </span>
                          </>
                        ) : null}
                      </small>
                    </span>
                    {!locked && alternatives.length > 0 ? (
                      <button type="button" className="session-move-icon" aria-label={`Swap ${name}`} onClick={() => onSwap(item.slotKey)}>
                        <IconSwap size={16} />
                      </button>
                    ) : (
                      <span aria-hidden="true" />
                    )}
                    <button type="button" className="session-move-icon" aria-label={`How to do ${name}`} onClick={() => onHowto(item.slotKey)}>
                      <IconInfo size={16} />
                    </button>
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** A short picker: one choice per row, the current one marked. */
function ChoiceSheet({
  title,
  options,
  onPick,
  onClose,
}: {
  title: string;
  options: Array<{ id: string; label: string; on: boolean }>;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <Sheet open onClose={onClose} title={title} centered>
      <div className="choice-list">
        {options.map((o) => (
          <button key={o.id} type="button" aria-pressed={o.on} onClick={() => onPick(o.id)}>
            {o.label}
          </button>
        ))}
      </div>
    </Sheet>
  );
}
