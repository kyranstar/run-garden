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
 * reads the session, and reads it again on a backoff while it is "Sending…" (`WATCH_POLL_S`), for about five minutes.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  ApiError,
  type BuildSessionRequest,
  type MeResponse,
  type SessionBuildDto,
  type SessionDto,
  type SessionItemDto,
  type SessionOverrides,
  type WorkoutDto,
} from "@rg/api-client";
import { docOriginRow, doseText, newId, type DoseStep, type DoseTarget } from "@rg/domain";
import { APP_BUILT_CHOICE, WatchVersion } from "./watch-version.js";
import { EXERCISES, isProfileId, label as vocab, PROFILES } from "@rg/exercise-library";
import { effortAdvice } from "@rg/workout";
import { Banner, CompletionPill, ConfirmDialog, EmptyState, formatDayLong, formatTime, Sheet, Spinner } from "../components.js";
import { features } from "../features.js";
import { IconAlert, IconInfo, IconSwap, IconWatch } from "../icons.js";
import { offlineDb } from "../offline/idb.js";
import { readLive, requestPersistentStorage } from "../offline/live.js";
import { cuePlayer } from "../player/cue-player.js";
import { discardHere } from "../player/save.js";
import { MoveSheet } from "../screens/move-sheet.js";
import { CheckScale, checkWord, conditionChipLabel, FeelingOffToggle } from "./condition-check-sheet.js";
import { keepStarted } from "./start-session.js";
import { ExerciseHowto, type HowtoTarget } from "./exercise-howto.js";
import { addTargetHref, editableWorkout } from "../screens/studio/add-model.js";
import type { BuilderArrival } from "../screens/studio/templates-model.js";
import { refusalText } from "../screens/studio/use-build-flows.js";
import { focusAfterRemove } from "../screens/week-view.js";
import { AskCoach } from "../screens/studio/coach-ask.js";
import { workoutFocus } from "../screens/studio/coach-focus.js";
import { continuable, MODE_LABEL } from "./today-program.js";
import { WatchPreviewSheet } from "./watch-preview-sheet.js";
import { musicAtStart, WorkoutMusicRow, type SessionMusicInput } from "../music/workout-music.js";

type Mode = keyof typeof MODE_LABEL;
type Picker = "mode" | "theme" | "minutes" | "place";

const BLOCK_ORDER = ["arrive", "prep", "core", "accessory", "care", "cooldown"] as const;
type SheetBlock = (typeof BLOCK_ORDER)[number];
/** A jumping day's accessory block holds jumps only and plays before the core lifts: it reads "Jumps". */
export const JUMPS_LABEL = "Jumps";
/** The name a block goes by: "Jumps" for a block of plyometric moves (whatever block it plays as), else the block's own label. */
export function blockLabel(blockId: string, moves: ReadonlyArray<{ contraction?: readonly string[] } | undefined>): string {
  if (moves.length > 0 && moves.every((m) => Boolean(m?.contraction?.includes("plyometric")))) return JUMPS_LABEL;
  return BLOCK_LABEL[blockId] ?? blockId;
}
/**
 * The sheet's one reason line: the mode's reasons, then a hand-picked theme's own reasons. A theme picked by hand has
 * none unless today held its moves back (a jumping day on an uncalm check), and then they say why.
 */
export function reasonLine(view: {
  modeReasons: readonly string[];
  themeReasons: readonly string[];
  theme: { id: string } | null;
  proposedTheme: { id: string } | null;
}): string {
  const handPicked = Boolean(view.theme) && view.theme?.id !== view.proposedTheme?.id;
  return [...view.modeReasons, ...(handPicked ? view.themeReasons : [])].join(" ");
}

/**
 * The moves as the sheet groups them: a document build by its own parts, each named by its purpose as the Studio
 * names it ("Warm-up", "Main" — never PREP or CORE), in play order; an engine build by its blocks.
 */
export function sessionGroups(
  build: Pick<SessionBuildDto, "steps" | "items" | "exercises" | "fromDoc">,
  careLabel: string,
): Array<{ key: string; label: string; items: SessionItemDto[] }> {
  const parts = build.fromDoc?.parts;
  if (parts && parts.length > 0) {
    return parts
      .map((p, i) => ({
        key: `part-${i}`,
        label: p.purpose === "care" ? careLabel : vocab(p.purpose),
        items: p.keys.flatMap((k) => build.items.filter((it) => it.slotKey === k)),
      }))
      .filter((g) => g.items.length > 0);
  }
  return blocksInPlayOrder(build)
    .map((blockId) => {
      const items = build.items.filter((i) => i.block === blockId);
      const name = blockId === "care" ? careLabel : blockLabel(blockId, items.map((i) => build.exercises[i.exerciseId]));
      return { key: blockId, label: name, items };
    })
    .filter((g) => g.items.length > 0);
}

/** A document build's name for the part a slot is in ("Warm-up", "Main"), as the Studio says it; null for an engine build. */
export function partLabelOf(build: Pick<SessionBuildDto, "fromDoc">, slotKey: string, careLabel: string | null): string | null {
  const part = build.fromDoc?.parts?.find((p) => p.keys.includes(slotKey));
  if (!part) return null;
  return part.purpose === "care" ? (careLabel ?? "Care") : vocab(part.purpose);
}

/** The blocks in the order the player plays them (a jumping day's jumps come before the core lifts). */
export function blocksInPlayOrder(build: { steps: ReadonlyArray<{ block: string }> }): SheetBlock[] {
  const played = [...new Set(build.steps.map((s) => s.block))].filter((b): b is SheetBlock => (BLOCK_ORDER as readonly string[]).includes(b));
  return [...played, ...BLOCK_ORDER.filter((b) => !played.includes(b))];
}
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
/**
 * "SENDING…" READS AGAIN ON A BACKOFF, THEN STOPS (audit 3-B UI-1): 4, 4, 8, 15, 30 and 60 s, then each minute — nine
 * reads, about five minutes. The drain right after Send runs the push in a few seconds when COROS answers; when it
 * cannot (COROS slow or down, a token refreshing), the job waits for the hourly lane, and a read every 4 s for as long
 * as the sheet was open cost ≈20 D1 statements each (900 requests an hour on the Workers Free plan) for a state that
 * could not change. So: once, ≈30 s in, the drain is asked for again (one heavy request, never a loop); then the reads
 * stop and the sheet keeps "Sending…" — coming back to the page reads once more (`refetchOnWindowFocus` while
 * sending), and so does opening the sheet again. Nothing is read while the page is hidden or the sheet is closed.
 */
export const WATCH_POLL_S: readonly number[] = [4, 4, 8, 15, 30, 60, 60, 60, 60];
/** The read the drain goes before: the fourth, ≈31 s in. */
const WATCH_DRAIN_READ = 3;

/**
 * The clock the "Sending…" reads run on: the page's own timers. Tests drive a clock of their own here — faking the
 * global timers for minutes of fake time would also fire the test runner's own RPC timeouts.
 */
export const sendingPollClock = {
  set: (run: () => void, ms: number): unknown => setTimeout(run, ms),
  clear: (id: unknown): void => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/** While `sending`: `read` on the backoff above, the drain before the fourth read; restarted each time it starts sending. */
function useSendingPoll(sending: boolean, read: () => void, drain: () => Promise<unknown>): void {
  const latest = useRef({ read, drain });
  latest.current = { read, drain };
  useEffect(() => {
    if (!sending) return;
    let stopped = false;
    let timer: unknown;
    const tick = async (i: number) => {
      // Hidden: no read, as React Query's own interval would not; the page coming back reads once.
      if (document.visibilityState !== "hidden") {
        if (i === WATCH_DRAIN_READ) await latest.current.drain().catch(() => undefined);
        if (stopped) return;
        latest.current.read();
      }
      if (!stopped && i + 1 < WATCH_POLL_S.length) timer = sendingPollClock.set(() => void tick(i + 1), WATCH_POLL_S[i + 1]! * 1_000);
    };
    timer = sendingPollClock.set(() => void tick(0), WATCH_POLL_S[0]! * 1_000);
    return () => {
      stopped = true;
      sendingPollClock.clear(timer);
    };
  }, [sending]);
}
/** The watch states of a SENT build (its push queued, running, failed or verified). */
const SENT_STATES: ReadonlyArray<string> = ["sending", "on_watch", "failed", "off_watch"];

/**
 * The day's go-Recover line for a document built for today above Recover (CUJ re-walk §2.6): the builder's own words
 * (`effortAdvice`), from the day's readings; null when the day asks nothing of it.
 */
export function goRecoverLine(s: SessionDto, today: string): string | null {
  const effort = s.build?.fromDoc?.effort;
  if (!effort || s.date !== today) return null;
  const profiles = s.profiles.flatMap((v) => (isProfileId(v.profileId) ? [PROFILES[v.profileId]] : []));
  const readings = Object.fromEntries(Object.entries(s.checks).map(([id, a]) => [id, { pre: a.pre, post: null, feelingOff: a.feelingOff }]));
  return effortAdvice(effort, profiles, { date: today, readings }).find((a) => a.fix === "recover")?.message ?? null;
}

/** The plan's reads, read again once a workout leaves it. */
const PLAN_QUERIES = ["today", "plan", "plan-week", "programs"] as const;

/** A workout with no document of its own: nothing to keep as a template. */
class NoTemplateDoc extends Error {}

/** Why Remove didn't happen, and what to do (re-review N5): the server's reason, a workout gone, no connection. */
export function removeRefusal(e: unknown): string {
  if (e instanceof ApiError) {
    const reason = (e.body as { reason?: string } | null)?.reason;
    if (reason === "started") return "It's under way. Open it and discard it first, then remove it.";
    if (reason === "done") return "It's done, so it stays on your plan. Close this to see it there.";
    if (reason === "sending") return "It's being sent to your watch. Try again once it's there.";
    if (reason === "not_studio") return "Only a workout made in the Studio can be removed. Skip this one instead.";
    if (e.status === 404) return "It's gone already. Close this to see your plan.";
    return "Couldn't remove it. Try again.";
  }
  return "Removing needs a connection — try again once you're online.";
}

/** The program's name: the row's title without the theme a build appends. */
function withoutTheme(title: string, theme: string | null | undefined): string {
  const suffix = theme ? ` · ${theme}` : null;
  return suffix && title.endsWith(suffix) ? title.slice(0, -suffix.length) : title;
}

/**
 * What a session read from the server is named by, where the device keeps nothing of it — as Start names it: a Studio
 * or template workout by its own title, a programme's session by its programme (the row's title without the theme
 * its build appended). A read from before the title: its theme, else "Session".
 */
export function sessionTitle(s: SessionDto): string {
  if (s.title) return docOriginRow({ origin: s.origin ?? null }) ? s.title : withoutTheme(s.title, s.view?.theme?.name);
  return s.view?.theme?.name ?? "Session";
}

function itemDose(s: SessionDto, item: SessionItemDto): { text: string; up: boolean } {
  const build = s.build!;
  const target = (build.targets[item.exerciseId] as DoseTarget | undefined) ?? null;
  const steps = build.steps.filter((st) => st.slotKey === item.slotKey && st.kind !== "rest") as unknown as DoseStep[];
  // A document build says each dose as the builder does ("4 × 5–8"), never the steps' "4 sets".
  const own = build.fromDoc?.doses?.[item.slotKey];
  return {
    text: own ?? doseText({ sets: item.sets, steps, target, perSide: build.exercises[item.exerciseId]?.laterality === "unilateral" }),
    up: target?.action === "up",
  };
}

export function SessionSheet({ w, today, onClose }: { w: WorkoutDto; today: string; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  // Opened from Today's row (its link says so) or from Plan: the Studio's way back returns there.
  const cameFrom = (useLocation().state as { from?: string } | null)?.from === "today" ? "today" : "plan";
  const editable = features.studio && editableWorkout(w, today);
  // A Studio workout done with — done, or its day passed — can't change, but it can be the start of another (CUJ B2).
  const doneWith =
    features.studio &&
    docOriginRow({ origin: w.origin ?? null }) &&
    !editable &&
    (w.completionState === "completed" || w.contentState === "done" || w.effectiveDate < today);
  const [removing, setRemoving] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.deleteWorkout(w.id),
    onSuccess: () => {
      setRemoving(false);
      onClose();
      // Focus moves on to the next card of its day, else the day's heading, never to the page (re-review N3) — now,
      // not once the plan is read again: that card is there before the read and after it, and a read that fails is
      // retried for seconds (twice, 1 s then 2 s; offline, until the connection is back), which the focus never waits
      // on. Its card goes when the read answers. The dialogs closing after this leave the focus where it is.
      for (const k of PLAN_QUERIES) void qc.invalidateQueries({ queryKey: [k] });
      setTimeout(() => focusAfterRemove(w.effectiveDate, w.id), 0);
    },
  });
  // Saved once (re-review N4): the button gives way to the line, which takes focus (N3); a retry whose answer was lost
  // names the same template, so the server answers it, never a second.
  const [templateLine, setTemplateLine] = useState<{ text: string; saved: boolean } | null>(null);
  const templateKey = useRef(newId());
  const templateLineRef = useRef<HTMLParagraphElement>(null);
  const saveAsTemplate = useMutation({
    mutationFn: async () => {
      const r = await api.workoutDoc(w.id);
      if (!r.doc) throw new NoTemplateDoc();
      return api.createTemplate({ name: r.doc.title, doc: r.doc, clientId: templateKey.current });
    },
    onSuccess: (res) => setTemplateLine({ text: `Saved “${res.template.name}” as a template.`, saved: true }),
    onError: (e) =>
      setTemplateLine({ text: e instanceof NoTemplateDoc ? "This workout can't be kept as a template." : refusalText(e, "save"), saved: false }),
  });
  useEffect(() => {
    if (templateLine?.saved) templateLineRef.current?.focus();
  }, [templateLine]);
  /** Start refused because today's check keeps a move out (409 `gated`): said, never swallowed (CUJ B3). */
  const [startRefused, setStartRefused] = useState<string | null>(null);
  const key = ["session", w.id];
  const session = useQuery({
    queryKey: key,
    queryFn: () => api.getSession(w.id),
    // "Sending…" moves on when the push runs (`useSendingPoll` below): its reads may have stopped, or the page was away
    // — coming back reads once. Otherwise the app's rule: nothing is read on focus.
    refetchOnWindowFocus: (q) => q.state.data?.watch?.state === "sending",
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
  /** What its music is read from (kept for the Start handler, as the title is). */
  const musicRef = useRef<SessionMusicInput | null>(null);
  /** Start locked the session, but the device could not keep it (no IndexedDB, storage full): said before it plays. */
  const [notKept, setNotKept] = useState(false);
  const start = useMutation({
    mutationFn: (buildId: string) => api.startSession(w.id, buildId),
    onSuccess: async (next) => {
      qc.setQueryData(key, next);
      refreshPlan();
      // The player plays what Start leaves on the device, never the network (ruling 2b-R1), the review's basis with it
      // (2b-R10; `keepStarted`). Without IndexedDB it still opens, online, from the started session — but it keeps
      // nothing, so the sheet says so first and Continue goes on (audit 2b-B I-2).
      // Its music goes with it: the player plays it once, as the session begins (music/workout-music.tsx).
      const music = musicRef.current ? musicAtStart(qc, musicRef.current) : null;
      if (!(await keepStarted(next, titleRef.current, qc.getQueryData<MeResponse>(["me"])?.userId ?? null, music))) {
        setNotKept(true);
        return;
      }
      navigate(`/session/${encodeURIComponent(w.id)}`);
    },
    // The day's inputs changed since this build (a check, a save, an edit): show the fresh build to Start again. The
    // fresh build may have renamed or resized the row, so Today and Plan refetch too.
    onError: (err) => {
      const body = err instanceof ApiError ? (err.body as { error?: string; session?: SessionDto; issues?: Array<{ message: string; severity: string }> } | null) : null;
      if (body?.error === "gated") {
        const why = body.issues?.find((i) => i.severity === "error")?.message;
        setStartRefused(`${why ?? "Today's check keeps a move of this workout out."} ${editable ? "Edit it in the Studio to change it." : ""}`.trim());
      }
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
  // runs the job, and the sheet keeps "Sending…" until it has (reading again on a backoff, `useSendingPoll`).
  const [previewing, setPreviewing] = useState(false);
  const [confirmingTakeOff, setConfirmingTakeOff] = useState(false);
  /**
   * After Send or Take off, the control that opened the dialog is gone — replaced by the new state's row — so the
   * dialog's own focus restore lands nowhere (on <body>, outside the modal; audit 3-B UI-4). Once the sheet shows the
   * state the write answered, focus goes to that state's control (Take off watch, Retry, Send to watch), else the sheet.
   */
  const refocusWatchOn = useRef<string | null>(null);
  const watchControl = useRef<HTMLButtonElement>(null);
  const afterWatchWrite = (next: SessionDto) => {
    refocusWatchOn.current = next.watch?.state ?? "none";
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
  useSendingPoll(
    session.data?.watch?.state === "sending",
    () => void qc.invalidateQueries({ queryKey: key }),
    // The one more drain: what it ran shows on Today and Plan too ("On your watch").
    () => api.drainWatch().finally(refreshPlan),
  );
  const takeOffButton = (
    <button ref={watchControl} type="button" className="btn" disabled={takeOff.isPending} onClick={askTakeOff}>
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
  // Its music: the athlete's choice for it, its document's own, else the default for its kind — calm (winding down) when
  // built in recovery mode or its document's effort is "recover".
  const musicInput: SessionMusicInput | null = s
    ? { workoutId: w.id, category: w.category, calm: view?.mode === "recovery" || s.build?.fromDoc?.effort === "recover", docMusic: s.music ?? null }
    : null;
  musicRef.current = musicInput;
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
  // After a watch write, once the sheet shows the state it answered (the closing dialog has restored focus by then).
  const watchState = s?.watch?.state ?? "none";
  useEffect(() => {
    if (refocusWatchOn.current === null || refocusWatchOn.current !== watchState) return;
    refocusWatchOn.current = null;
    (watchControl.current ?? body0.current?.closest<HTMLElement>('[role="dialog"]'))?.focus();
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
  // Today's check keeps a move out that no alternate stands in for: Start waits, and the sheet says why (CUJ B3).
  const gatedToday = (s?.build?.fromDoc?.blocked.length ?? 0) > 0;
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
          disabled={start.isPending || gatedToday}
          onClick={() => {
            // Inside the tap: audio unlocks only in a gesture, and storage is asked to persist (offline spike).
            cuePlayer.unlock();
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
            cuePlayer.unlock();
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
  //
  // ONE STATUS REGION, KEPT (audit 3-B UI-10): from Send to watch through Sending… to On your watch or Couldn't send, the
  // row and its `role="status"` label are the same nodes, so the outcome the athlete waits for is announced — a live
  // region added with its words already in it often is not. While there is nothing to say (Send to watch offered) the
  // row is there, empty and visually hidden. The action sits beside the label, outside the region.
  const watchLive = watchShown && (offersSend || ["sending", "on_watch", "failed"].includes(watch!.state));
  let watchRow: React.ReactNode = null;
  if (watchLive) {
    const state = watch!.state;
    const said =
      state === "sending" ? (
        <>
          <span className="watch-spin" aria-hidden="true" />
          Sending…
        </>
      ) : state === "on_watch" ? (
        <>
          <IconWatch size={16} />
          On your watch
        </>
      ) : state === "failed" ? (
        <>
          <IconAlert size={16} />
          Couldn't send
        </>
      ) : null;
    const tone = state === "sending" ? " watch-state-label--muted" : state === "on_watch" ? " watch-state-label--ok" : "";
    watchRow = (
      <div key="watch" className={!said ? "watch-state visually-hidden" : state === "failed" ? "watch-state watch-state--warn" : "watch-state"}>
        <span role="status" className={`watch-state-label${tone}`}>
          {said}
        </span>
        {state === "sending" || state === "on_watch" ? (
          takeOffButton
        ) : state === "failed" ? (
          <button ref={watchControl} type="button" className="btn btn-small" onClick={() => setPreviewing(true)}>
            Retry
          </button>
        ) : null}
      </div>
    );
  }
  const footRows: React.ReactNode[] = [];
  if (watchRow) footRows.push(watchRow);
  if (offersSend) {
    footRows.push(
      <div key="send" className="btn-row btn-row--split">
        {startButton}
        <button ref={watchControl} type="button" className="btn" onClick={() => setPreviewing(true)}>
          <IconWatch size={16} />
          Send to watch
        </button>
      </div>,
    );
  }
  if (actions.length > 0) footRows.push(<div key="actions" className="btn-row">{actions}</div>);
  // One column, top to bottom as drawn: the sheet's foot stacks its children in reverse (styles.css `.sheet-foot`).
  // Without the watch in it, the action row sits straight in the foot, as it did before the watch (audit 3-B UI-2).
  const footer = watchLive ? <div className="session-foot">{footRows}</div> : (footRows[0] ?? null);

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
    const recover = !locked && !past ? goRecoverLine(s, today) : null;
    body = (
      <BuiltSession
        s={s}
        locked={locked || past}
        onPick={setPicker}
        onSwap={setSwapping}
        onHowto={setHowto}
        advice={
          recover ? (
            <p className="session-advice">
              {recover}{" "}
              {editable ? (
                <Link to={addTargetHref({ kind: "workout", id: w.id })} state={{ from: cameFrom } satisfies BuilderArrival}>
                  Edit in Studio
                </Link>
              ) : null}
            </p>
          ) : null
        }
      />
    );
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
        {/* A modal sheet hides the nav, so it keeps its own small Ask, seeing the workout (the integrated review, I3). */}
        <AskCoach focus={workoutFocus(w)} wrap="session-ask-row" />
        {/* The watch holds an earlier version of this session (the owner, 2026-10-19): said, and the watch's kept if the
            athlete wants. An app-built session is never rewritten from here, so there is nothing to send. */}
        {w.corosSyncView === "content_stale" ? <WatchVersion workoutId={w.id} choice={APP_BUILT_CHOICE} /> : null}
        {notKept ? (
          <Banner kind="warn">
            This session isn't being kept on this device. It plays while you're online, and a reload starts it again.
          </Banner>
        ) : null}
        {savedElsewhere ? (
          <p className="session-status">Saved on another device. This device still holds a copy of it, which won't be saved.</p>
        ) : null}
        {body}
        {musicInput && showBuild && !skipped && !past && s?.contentState !== "done" ? <WorkoutMusicRow {...musicInput} date={date} /> : null}
        {startRefused ? (
          <p className="session-refused" role="alert">
            {startRefused}
          </p>
        ) : null}
        {editable ? (
          <p className="session-edit">
            <Link className="btn btn-small" to={addTargetHref({ kind: "workout", id: w.id })} state={{ from: cameFrom } satisfies BuilderArrival}>
              Edit in Studio
            </Link>
            {/* A Studio workout never started can come off the plan (and the calendar): asked first (CUJ R6). */}
            <button type="button" className="btn btn-small" onClick={() => setRemoving(true)}>
              Remove
            </button>
          </p>
        ) : null}
        {doneWith ? (
          <p className="session-edit">
            {/* Done with: the start of another — a copy as a new workout, or a template (CUJ B2). */}
            <Link className="btn btn-small" to={`/studio/build/again/${encodeURIComponent(w.id)}`} state={{ from: cameFrom } satisfies BuilderArrival}>
              Do it again
            </Link>
            {templateLine?.saved ? null : (
              <button type="button" className="btn btn-small" disabled={saveAsTemplate.isPending} onClick={() => saveAsTemplate.mutate()}>
                Save as template
              </button>
            )}
          </p>
        ) : null}
        {doneWith ? (
          <p ref={templateLineRef} tabIndex={-1} className={templateLine ? "session-status" : "session-status visually-hidden"} role="status">
            {templateLine?.text ?? ""}
          </p>
        ) : null}
      </div>
      <ConfirmDialog
        open={removing}
        onClose={() => setRemoving(false)}
        title="Remove this workout?"
        confirmLabel="Remove"
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
        error={remove.isError ? removeRefusal(remove.error) : null}
      >
        {s?.watch?.state === "on_watch" ? "It comes off your plan, your calendar and your watch." : "It comes off your plan and your calendar."}
      </ConfirmDialog>
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
        error={takeOff.isError ? "Couldn't take it off — try again." : null}
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

/** A move by name: the build's own, else the library's — the move a stand-in replaced is no longer in the build. */
function moveName(build: NonNullable<SessionDto["build"]>, id: string): string {
  return build.exercises[id]?.name ?? EXERCISES.find((r) => r.id === id)?.name ?? id;
}

/** What was built: the chips, the reason line, and the moves by block. */
function BuiltSession({
  s,
  locked,
  onPick,
  onSwap,
  onHowto,
  advice = null,
}: {
  s: SessionDto;
  locked: boolean;
  onPick: (p: Picker) => void;
  onSwap: (slotKey: string) => void;
  onHowto: (slotKey: string) => void;
  /** The day's go-Recover line, with its way to change it (a document built today above Recover). */
  advice?: ReactNode;
}) {
  const build = s.build!;
  const view = s.view!;
  const careLabel = s.profiles.find((p) => p.care)?.care ?? "Care";
  // A document workout: its document decides the mode, theme and length (Edit in Studio changes them). The sheet says
  // its effort in the Studio's word, and offers no picker that the build would ignore.
  const doc = !!build.fromDoc;
  const effort = build.fromDoc?.effort;
  const chips: Array<{ picker: Picker; label: string; on?: boolean; can: boolean }> = [
    ...(doc
      ? effort
        ? [{ picker: "mode" as const, label: vocab(effort), on: true, can: false }]
        : []
      : [{ picker: "mode" as const, label: MODE_LABEL[view.mode], on: true, can: s.choices.modes.length > 1 }]),
    ...(doc ? [] : [{ picker: "theme" as const, label: view.theme?.name ?? "Theme", can: s.choices.themes.some((t) => t.modes.includes(view.mode)) }]),
    { picker: "minutes", label: `${view.minutes} min`, can: !doc || s.choices.modes.length > 0 },
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
      {reasonLine(view) ? <p className="session-reason">{reasonLine(view)}</p> : null}
      {advice}
      {build.fromDoc?.blocked.length ? (
        <p className="session-refused">{build.fromDoc.blocked[0]!.message} Start waits until it can.</p>
      ) : null}
      {build.fromDoc?.swaps.length ? (
        <ul className="session-swaps" aria-label="Today's check changes this workout">
          {build.fromDoc.swaps.map((x) => (
            <li key={x.path}>{`${moveName(build, x.from)} → ${moveName(build, x.to)}: ${x.reason}`}</li>
          ))}
        </ul>
      ) : null}
      <div className="session-blocks">
        {sessionGroups(build, careLabel).map(({ key: groupKey, label, items }) => {
          const format = FORMAT_LABEL[items[0]!.format];
          const keys = new Set(items.map((i) => i.slotKey));
          const rounds = Math.max(
            1,
            ...build.steps.filter((st) => keys.has(st.slotKey)).map((st) => st.format.round ?? 1),
          );
          return (
            <section key={groupKey} className="session-block">
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
