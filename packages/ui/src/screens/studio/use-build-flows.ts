/**
 * THE BUILDER'S FLOWS (Stage 2 spec §8, §10): Start now, Schedule, and the saves — moved out of the builder
 * (builder.tsx) as they were. The builder keeps the document, what it is judged with, and what is open; these act on
 * them, through what it hands in.
 *
 *   Start now   a check today's errors wait on comes first, in place; then the workout is made for today (or a planned
 *               one's changes saved), built and started — a build the day changed, or a cost only the server could
 *               see, is shown before it locks — then the player. Arrived from the templates list's Start or
 *               Schedule…, that is done once.
 *   Schedule    the workout made for the day chosen; a new workout or a quick start is that planned workout now.
 *   The saves   a planned workout's changes, a template's (on the version it opened), a new template; Reload when the
 *               base changed elsewhere; Start over.
 */
import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { Location, NavigateFunction } from "react-router-dom";
import type { QueryClient } from "@tanstack/react-query";
import { api, ApiError, type DocIssueDto, type DocWorkoutDto, type MeResponse, type SessionDto } from "@rg/api-client";
import { addDays, type WorkoutDoc } from "@rg/domain";
import { startEditing, toProposable, type EditorState } from "@rg/workout";
import { formatDayShort, formatTime } from "../../components.js";
import { keepStarted } from "../../components/start-session.js";
import { requestPersistentStorage } from "../../offline/live.js";
import { chimes } from "../../player/audio.js";
import type { useStudioDraft } from "../../studio-drafts.js";
import { addTargetHref, freshDoc } from "./add-model.js";
import { TEMPLATES_QUERY } from "./add-sheet.js";
import { EMPTY_BLOCK, forSchedule, judgeDraft, nowHHMM, type BuildCtx, type BuildSource, type Judged } from "./build-model.js";
import type { BuilderArrival } from "./templates-model.js";

/** A planned workout's document, read fresh (`GET /api/workouts/:id/doc`). */
export const workoutDocQuery = (id: string) => ["workout-doc", id] as const;

export interface Loaded {
  key: string;
  editor: EditorState;
  /** What is saved: a template's or a planned workout's document; null for a new workout. */
  baseline: WorkoutDoc | null;
  /** A planned workout's revision. */
  rev: number | null;
  /** A planned workout's day and time, when this page made it. */
  row: { date: string; time: string } | null;
  /** A template's version as opened (its `updatedAt`): its save is written on that version, or refused. */
  base?: string;
}

export type Flow =
  | { step: "idle" }
  | { step: "busy"; what: string }
  /** The day's build changed the workout, or the server saw a cost this page had not said: shown before it locks. */
  | { step: "swaps"; session: SessionDto; notes?: string[] }
  | { step: "refused"; text: string }
  /** Started, but this device could not keep it. */
  | { step: "notKept"; workoutId: string };

export const IDLE: Flow = { step: "idle" };

export interface Status {
  text: string;
  /** Undo the removal: offered until the next edit (every edit clears it), at this depth of the history. */
  undoAt?: number;
  link?: { to: string; label: string };
  /** The watch holds an older copy of the workout: its Send (the preview, then the push) is offered. */
  watch?: { workoutId: string; minutes: number };
  /** That Send was taken. */
  sent?: boolean;
  /** What the server judged that this page did not say already (a cost it could see, the frontier with its flags). */
  notes?: string[];
}

/** Why a write did not happen, in plain words. */
export function refusalText(e: unknown, what: "start" | "schedule" | "save"): string {
  if (e instanceof ApiError) {
    const body = (e.body ?? {}) as { error?: string; issues?: DocIssueDto[]; message?: string };
    const issue = body.issues?.find((i) => i.severity === "error")?.message;
    if (body.error === "invalid_doc" || body.error === "gated" || body.error === "too_large") return issue ?? "This workout can't be used as it is.";
    if (body.error === "run_unsupported") return body.message ?? "Runs can't be planned in the Studio yet.";
    if (body.error === "past_date") return "That day has passed.";
    if (body.error === "stale_revision") return "This workout changed elsewhere.";
    if (body.error === "not_editable") return "This workout can't be changed now.";
    if (body.error === "too_many") return "You have as many templates as you can keep. Delete one first.";
    if (body.error === "not_today") return "This workout isn't today's.";
    if (e.status === 404) return "That's gone now.";
    return what === "start" ? "Couldn't start it. Try again." : what === "schedule" ? "Couldn't schedule it. Try again." : "Couldn't save it. Try again.";
  }
  return what === "start" ? "Starting needs a connection." : what === "schedule" ? "Scheduling needs a connection." : "Saving needs a connection.";
}

const errorBody = (e: unknown): { error?: string; session?: SessionDto } | null =>
  e instanceof ApiError ? ((e.body ?? null) as { error?: string; session?: SessionDto } | null) : null;

/** "Scheduled for today at 4 PM." */
function scheduledText(w: DocWorkoutDto, today: string): string {
  const day = w.date === today ? "today" : w.date === addDays(today, 1) ? "tomorrow" : formatDayShort(w.date);
  return `Scheduled for ${day} at ${formatTime(w.time)}.`;
}

/** What the builder hands its flows: its state, and the setters they move it on with. */
export interface BuildFlowsIn {
  source: BuildSource;
  key: string;
  tplId: string | null;
  wid: string | null;
  today: string;
  qc: QueryClient;
  navigate: NavigateFunction;
  location: Location;
  arrived: BuilderArrival | null;
  drafts: ReturnType<typeof useStudioDraft>;
  live: MutableRefObject<Loaded | null>;
  setLoaded: (next: Loaded | null) => void;
  ready: Loaded | null;
  bc: BuildCtx;
  judged: Judged | null;
  settled: boolean;
  flow: Flow;
  setFlow: Dispatch<SetStateAction<Flow>>;
  setStatus: Dispatch<SetStateAction<Status | null>>;
  setStale: Dispatch<SetStateAction<boolean>>;
  setSaving: Dispatch<SetStateAction<boolean>>;
  setScheduling: Dispatch<SetStateAction<boolean>>;
  setNaming: Dispatch<SetStateAction<boolean>>;
  setAsking: Dispatch<SetStateAction<{ profileId: string; then: "start" | null } | null>>;
  setFreshAsk: Dispatch<SetStateAction<boolean>>;
  resume: boolean;
  setResume: Dispatch<SetStateAction<boolean>>;
  refreshPlan: () => void;
  /** The server's warnings this page has not said already. */
  newNotes: (ws: readonly DocIssueDto[]) => string[] | undefined;
  /** The server's readings for the day (a session read), kept. */
  noteChecks: (s: SessionDto) => void;
}

/**
 * Two documents the same as a save would send them (what the builder's own "changed" test compares). One a save could
 * not send is the same as nothing: never a match.
 */
export function sameDocument(a: WorkoutDoc, b: WorkoutDoc): boolean {
  const x = toProposable(startEditing(a).doc);
  const y = toProposable(startEditing(b).doc);
  return x !== null && y !== null && JSON.stringify(x) === JSON.stringify(y);
}

/** The builder's Start now, Schedule and saves. */
export function useBuildFlows({
  source,
  key,
  tplId,
  wid,
  today,
  qc,
  navigate,
  location,
  arrived,
  drafts,
  live,
  setLoaded,
  ready,
  bc,
  judged,
  settled,
  flow,
  setFlow,
  setStatus,
  setStale,
  setSaving,
  setScheduling,
  setNaming,
  setAsking,
  setFreshAsk,
  resume,
  setResume,
  refreshPlan,
  newNotes,
  noteChecks,
}: BuildFlowsIn) {
  /** Changed since it was saved: the two read alike through the schema (its key order, its empty parts dropped). */
  const dirtyOf = (l: Loaded | null): boolean =>
    !!l && l.baseline !== null && JSON.stringify(toProposable(l.editor.doc)) !== JSON.stringify(toProposable(startEditing(l.baseline).doc));

  /** A planned workout this page made (or saved): the builder is on it now, at its own address. */
  const adopt = (w: DocWorkoutDto, sent: WorkoutDoc) => {
    const cur = live.current;
    if (!cur) return;
    const editor = source.kind === "template" ? { ...cur.editor, doc: startEditing(forSchedule(cur.editor.doc, source)).doc } : cur.editor;
    setLoaded({ key: `workout:${w.id}`, editor, baseline: sent, rev: w.docRev ?? 1, row: { date: w.date, time: w.time } });
    if (cur.key === "new") void drafts.clear().catch(() => undefined);
    // The entry keeps where its way back goes (the templates list, when it came from there).
    navigate(addTargetHref({ kind: "workout", id: w.id }), { replace: true, state: arrived?.from ? ({ from: arrived.from } satisfies BuilderArrival) : null });
  };

  // ── Start now ──
  const userId = () => qc.getQueryData<MeResponse>(["me"])?.userId ?? null;
  const lock = async (s: SessionDto, retried = false): Promise<void> => {
    if (!s.build) {
      setFlow({ step: "refused", text: "This workout couldn't be built." });
      return;
    }
    setFlow({ step: "busy", what: "Starting…" });
    try {
      const next = await api.startSession(s.workoutId, s.build.buildId);
      refreshPlan();
      const title = live.current?.editor.doc.title ?? "Workout";
      if (!(await keepStarted(next, title, userId()))) {
        setFlow({ step: "notKept", workoutId: s.workoutId });
        return;
      }
      setFlow({ step: "idle" });
      navigate(`/session/${encodeURIComponent(s.workoutId)}`);
    } catch (e) {
      const body = errorBody(e);
      // The day's inputs changed since this build: the fresh one is shown first when it swapped a move, else used.
      if (body?.error === "stale" && body.session) {
        noteChecks(body.session);
        if (body.session.build?.fromDoc?.swaps.length) {
          setFlow({ step: "swaps", session: body.session });
          return;
        }
        if (!retried) return lock(body.session, true);
      }
      setFlow({ step: "refused", text: refusalText(e, "start") });
    }
  };
  const runStart = async (): Promise<void> => {
    const cur = live.current;
    const doc0 = cur ? toProposable(cur.editor.doc) : null;
    if (!cur || !doc0) return;
    setFlow({ step: "busy", what: "Starting…" });
    setStatus(null);
    try {
      let id: string;
      // The server's own warnings (what this page could not see) are shown with the build, before it locks.
      let fresh: string[] = [];
      if (cur.key.startsWith("workout:")) {
        id = cur.key.slice("workout:".length);
        if (dirtyOf(cur)) {
          const res = await api.reviseWorkoutDoc(id, doc0, cur.rev ?? 0);
          setLoaded({ ...live.current!, baseline: doc0, rev: res.rev });
          fresh = newNotes(res.warnings) ?? [];
        }
      } else {
        const sent = forSchedule(doc0, source);
        const res = await api.createWorkout({ date: today, time: nowHHMM(new Date()), doc: sent });
        fresh = newNotes(res.warnings) ?? [];
        if (source.kind === "template") void api.useTemplate(source.id).catch(() => undefined);
        adopt(res.workout, sent);
        id = res.workout.id;
      }
      refreshPlan();
      const built = await api.buildSession(id, {});
      noteChecks(built);
      const info = built.build?.fromDoc;
      if (info?.blocked.length) {
        setFlow({ step: "refused", text: info.blocked[0]!.message });
        return;
      }
      if (info?.swaps.length || fresh.length) {
        setFlow({ step: "swaps", session: built, notes: fresh });
        return;
      }
      await lock(built);
    } catch (e) {
      // A base changed elsewhere says so once, on its own line, with Reload.
      if (errorBody(e)?.error === "stale_revision") {
        setStale(true);
        setFlow(IDLE);
        return;
      }
      setFlow({ step: "refused", text: refusalText(e, "start") });
    }
  };
  /** Start now: a check today's errors wait on comes first, in place; then the workout is made, built and started. */
  const startNow = async (gesture: boolean) => {
    if (gesture) {
      // Inside the tap: audio unlocks only in a gesture, and storage is asked to persist (as the session sheet's Start).
      chimes.unlock();
      void requestPersistentStorage();
    }
    if (!judged?.doc || judged.blocked || flow.step === "busy") return;
    if (judged.checks.length) {
      setAsking({ profileId: judged.checks[0]!, then: "start" });
      return;
    }
    await runStart();
  };
  // A check asked for by Start, answered: Start goes on with the reading (or stops where it now blocks).
  useEffect(() => {
    if (!resume || !judged) return;
    setResume(false);
    void startNow(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resume, judged]);
  // Arrived from the templates list's Start or Schedule…: done once the workout and what it is judged with are here —
  // and taken off the history entry first, so Back to it (or a reload) opens the builder and nothing more. (Start's
  // tap unlocked the audio and asked for storage there, inside the gesture.) Once per entry: StrictMode runs a mount's
  // effects twice, and a second Start would make a second workout.
  const then = arrived?.then;
  const actedOn = useRef<string | null>(null);
  useEffect(() => {
    if (!then || !ready || !judged || !settled || actedOn.current === location.key) return;
    actedOn.current = location.key;
    navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: arrived?.from ? ({ from: arrived.from } satisfies BuilderArrival) : null });
    if (then === "schedule") setScheduling(true);
    else void startNow(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [then, ready, judged, settled]);

  // ── Schedule, and the saves ──
  const schedule = async (when: string, time: string | null): Promise<string | null> => {
    const cur = live.current;
    if (!cur) return null;
    const j = judgeDraft(cur.editor.doc, bc, when);
    if (!j.doc) return EMPTY_BLOCK;
    if (j.blocked) return j.blocked;
    const sent = forSchedule(j.doc, source);
    try {
      const res = await api.createWorkout({ date: when, ...(time ? { time } : {}), doc: sent });
      refreshPlan();
      if (source.kind === "template") {
        void api
          .useTemplate(source.id)
          .then(() => qc.invalidateQueries({ queryKey: TEMPLATES_QUERY }))
          .catch(() => undefined);
      }
      // A new workout or a quick start, scheduled, is that planned workout now (a second Start never makes another).
      if (cur.key === "new" || source.kind === "quick") adopt(res.workout, sent);
      setScheduling(false);
      setStatus({ text: scheduledText(res.workout, today), link: { to: "/plan", label: "See it in Plan" }, notes: newNotes(res.warnings) });
      return null;
    } catch (e) {
      return refusalText(e, "schedule");
    }
  };
  const saveAsTemplate = async (name: string, pinned: boolean): Promise<string | null> => {
    const d = live.current ? toProposable(live.current.editor.doc) : null;
    if (!d) return EMPTY_BLOCK;
    try {
      // Pinned as it is made, it is one of the home's quick starts at once (spec §9).
      const res = await api.createTemplate({ name: name.trim(), doc: d, ...(pinned ? { pinned: true } : {}) });
      void qc.invalidateQueries({ queryKey: TEMPLATES_QUERY });
      setNaming(false);
      setStatus({ text: `Saved “${name.trim()}” as a template${pinned ? ", pinned to quick starts" : ""}.`, notes: newNotes(res.warnings) });
      return null;
    } catch (e) {
      return refusalText(e, "save");
    }
  };
  const saveTemplate = async () => {
    const cur = live.current;
    const d = cur ? toProposable(cur.editor.doc) : null;
    if (!tplId || !cur || !d) return;
    setSaving(true);
    try {
      // On the version it opened: one changed elsewhere since (or a cached copy it opened) is refused, never overwritten.
      const put = (base: string | undefined) => api.updateTemplate(tplId, { doc: d, ...(base ? { baseUpdatedAt: base } : {}) });
      let res: Awaited<ReturnType<typeof put>>;
      try {
        res = await put(cur.base);
      } catch (e) {
        if (errorBody(e)?.error !== "stale_revision") throw e;
        // Only renamed or pinned elsewhere — its document still the one opened here: saved again on the version there
        // now, its name and pin as they were made there (only the document is sent). Otherwise it says so, with Reload.
        const there = (await qc.fetchQuery({ queryKey: TEMPLATES_QUERY, queryFn: api.templates, staleTime: 0 })).templates.find((x) => x.id === tplId);
        if (!there?.doc || !cur.baseline || !sameDocument(there.doc, cur.baseline)) throw e;
        res = await put(there.updatedAt);
      }
      void qc.invalidateQueries({ queryKey: TEMPLATES_QUERY });
      if (live.current) setLoaded({ ...live.current, baseline: d, base: res.template.updatedAt });
      setStatus({ text: "Saved.", notes: newNotes(res.warnings) });
    } catch (e) {
      if (errorBody(e)?.error === "stale_revision") {
        setStale(true);
        setStatus(null);
      } else setStatus({ text: refusalText(e, "save") });
    } finally {
      setSaving(false);
    }
  };
  const saveChanges = async () => {
    const cur = live.current;
    const d = cur ? toProposable(cur.editor.doc) : null;
    if (!cur || !d || !cur.key.startsWith("workout:")) return;
    const id = cur.key.slice("workout:".length);
    setSaving(true);
    try {
      const res = await api.reviseWorkoutDoc(id, d, cur.rev ?? 0);
      if (live.current) setLoaded({ ...live.current, baseline: d, rev: res.rev });
      setStale(false);
      refreshPlan();
      void qc.invalidateQueries({ queryKey: workoutDocQuery(id) });
      setStatus({ text: "Saved.", notes: newNotes(res.warnings), ...(res.watchHasOlder ? { watch: { workoutId: id, minutes: res.workout.minutes } } : {}) });
    } catch (e) {
      if (errorBody(e)?.error === "stale_revision") {
        setStale(true);
        setStatus(null);
      } else setStatus({ text: refusalText(e, "save") });
    } finally {
      setSaving(false);
    }
  };
  const reload = async () => {
    if (tplId) {
      try {
        const t = (await qc.fetchQuery({ queryKey: TEMPLATES_QUERY, queryFn: api.templates, staleTime: 0 })).templates.find((x) => x.id === tplId);
        if (!t?.doc) {
          setStatus({ text: t ? "This template can't be read." : "That template is gone." });
          return;
        }
        setLoaded({ key, editor: startEditing(t.doc), baseline: t.doc, rev: null, row: null, base: t.updatedAt });
        setStale(false);
        setStatus(null);
        setFlow(IDLE);
      } catch {
        setStatus({ text: "Reloading needs a connection." });
      }
      return;
    }
    if (!wid) return;
    try {
      const r = await qc.fetchQuery({ queryKey: workoutDocQuery(wid), queryFn: () => api.workoutDoc(wid), staleTime: 0 });
      if (!r.doc) {
        setStatus({ text: "This workout can't be changed in the Studio." });
        return;
      }
      setLoaded({ key, editor: startEditing(r.doc), baseline: r.doc, rev: r.rev, row: live.current?.row ?? null });
      setStale(false);
      setStatus(null);
      setFlow(IDLE);
    } catch {
      setStatus({ text: "Reloading needs a connection." });
    }
  };
  const startOver = () => {
    void drafts.clear().catch(() => undefined);
    setLoaded({ key: "new", editor: startEditing(freshDoc()), baseline: null, rev: null, row: null });
    setFreshAsk(false);
    setStatus(null);
    setFlow({ step: "idle" });
  };

  return { dirtyOf, lock, startNow, schedule, saveAsTemplate, saveTemplate, saveChanges, reload, startOver };
}
