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
import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { useNavigate, type Location, type NavigateFunction } from "react-router-dom";
import type { QueryClient } from "@tanstack/react-query";
import { api, ApiError, type DocIssueDto, type DocWorkoutDto, type MeResponse, type SessionDto } from "@rg/api-client";
import { addDays, newId, type WorkoutDoc } from "@rg/domain";
import type { CheckReading } from "@rg/exercise-library";
import { startEditing, toProposable, type EditorState } from "@rg/workout";
import { formatDayShort, formatTime } from "../../components.js";
import { keepStarted } from "../../components/start-session.js";
import { saveBuild } from "../../offline/builds.js";
import { offlineDb } from "../../offline/idb.js";
import { requestPersistentStorage } from "../../offline/live.js";
import { forgetLocalStart, isLocalId, localIdOf, rememberLocalStart, startKindOf, unfinishedLocalStart, type LocalStart } from "../../offline/local-starts.js";
import { meWithOfflineFallback } from "../../offline/me.js";
import { chimes } from "../../player/audio.js";
import { localBuild } from "../../player/local-build.js";
import { forgetStart, saveExtras } from "../../player/stored.js";
import type { useStudioDraft } from "../../studio-drafts.js";
import { addTargetHref, freshDoc } from "./add-model.js";
import { TEMPLATES_QUERY } from "./add-sheet.js";
import { answered, checkViewOf, clockIn, editDraftHref, EMPTY_BLOCK, forSchedule, judgeDraft, nowHHMM, type BuildCtx, type BuildSource, type Judged } from "./build-model.js";
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
  | { step: "notKept"; workoutId: string }
  /** Start now of a quick start or template today already holds, still to finish: that one is offered (Continue). */
  | { step: "again"; workout: DocWorkoutDto };

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
  /** A coach's draft that can't be approved: the athlete's edits are kept, and scheduling them as a new workout offered. */
  asNew?: true;
}

/**
 * Why a coach's draft can't be approved (Edit before approve), when that is the draft's own story rather than the
 * Studio save's — never something to try again: the plan changed since the coach drafted it, a revision's day has
 * passed, the draft isn't open any more, or it's gone. Null for any other refusal (the Studio save's words say it).
 */
export function draftRefusal(e: unknown, revises: boolean): Status | null {
  const body = e instanceof ApiError ? ((e.body ?? {}) as { error?: string }) : null;
  if (!body) return null;
  if (body.error === "stale_revision") return { text: "This workout changed after the coach drafted this, so the draft can't be applied.", asNew: true };
  if (body.error === "past_date" && revises) return { text: "This workout's day has passed, so the draft can't be applied any more.", asNew: true };
  if (body.error === "not_pending" || body.error === "not_yet") return { text: "This draft isn't open any more, so it can't be approved.", asNew: true };
  if (e instanceof ApiError && e.status === 404) return { text: "This draft is gone.", asNew: true };
  return null;
}

/** A coach's draft decided elsewhere meanwhile, in plain words. */
const DECIDED_TEXT: Record<"applied" | "declined" | "superseded", string> = {
  applied: "The coach's version was approved already.",
  declined: "The coach's version was declined already.",
  superseded: "A newer plan from the coach replaced this one.",
};

/** Why a write did not happen, in plain words. */
export function refusalText(e: unknown, what: "start" | "schedule" | "save"): string {
  if (e instanceof ApiError) {
    const body = (e.body ?? {}) as { error?: string; issues?: DocIssueDto[]; message?: string };
    const issue = body.issues?.find((i) => i.severity === "error")?.message;
    if (body.error === "invalid_doc" || body.error === "gated" || body.error === "too_large") return issue ?? "This workout can't be used as it is — change it, then try again.";
    if (body.error === "run_unsupported") return body.message ?? "Runs can't be planned in the Studio yet.";
    if (body.error === "past_date") return "That day has passed — pick today or a later day.";
    if (body.error === "stale_revision") return "This workout changed elsewhere — reload it to see the new version.";
    if (body.error === "not_editable") return "This workout can't be changed now — it's under way or done. Save it as a template to change a copy.";
    if (body.error === "too_many") return "You have as many templates as you can keep. Delete one first.";
    if (body.error === "not_today") return "This workout isn't today's — schedule it for today to start it.";
    if (e.status === 404) return "That's gone now — go back to the Studio to start another.";
    return what === "start" ? "Couldn't start it. Try again." : what === "schedule" ? "Couldn't schedule it. Try again." : "Couldn't save it. Try again.";
  }
  return what === "start"
    ? "Starting needs a connection — try again once you're online."
    : what === "schedule"
      ? "Scheduling needs a connection — try again once you're online."
      : "Saving needs a connection — try again once you're online.";
}

const errorBody = (e: unknown): { error?: string; session?: SessionDto; workout?: DocWorkoutDto } | null =>
  e instanceof ApiError ? ((e.body ?? null) as { error?: string; session?: SessionDto; workout?: DocWorkoutDto } | null) : null;

/** A start made offline and still to finish, as the offer to continue names it (R11): under way, on this device. */
const heldHere = (s: LocalStart): DocWorkoutDto => ({
  id: s.localId,
  date: s.date,
  time: s.time,
  title: s.title,
  intentSummary: s.doc.intent.summary,
  category: "",
  sport: "",
  origin: s.kind.startsWith("template:") ? "template" : "studio",
  contentState: "started",
  completionState: "scheduled",
  docRev: null,
  minutes: 0,
});

/** "Scheduled for today at 4 PM." */
function scheduledText(w: DocWorkoutDto, today: string): string {
  const day = w.date === today ? "today" : w.date === addDays(today, 1) ? "tomorrow" : formatDayShort(w.date);
  return `Scheduled for ${day} at ${formatTime(w.time)}.`;
}

/**
 * A check the builder asks for: from a note (`then: null`), or by Start — one today's errors wait on, or one it only
 * offers (`offered`: today unanswered, nothing waiting on it; skippable, CUJ R5).
 */
export interface CheckAsked {
  profileId: string;
  then: "start" | null;
  offered?: true;
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
  setAsking: Dispatch<SetStateAction<CheckAsked | null>>;
  setFreshAsk: Dispatch<SetStateAction<boolean>>;
  resume: boolean;
  setResume: Dispatch<SetStateAction<boolean>>;
  refreshPlan: () => void;
  /** The server's warnings this page has not said already. */
  newNotes: (ws: readonly DocIssueDto[]) => string[] | undefined;
  /** The server's readings for the day (a session read), kept. */
  noteChecks: (s: SessionDto) => void;
  /** Focus goes to the line that says what a Schedule or a save did (its link, else its words), once it shows. */
  focusStatus: () => void;
  /** The account's timezone (its settings); null until known — then the device's clock. */
  timeZone: string | null;
  /** The readings answered on this page: what is known of now when the device's plan is another day's (R11). */
  recorded: Readonly<Record<string, CheckReading>>;
  /** Where it is done (`placeOf`): the place a build made on the device names (R11). */
  place: { id?: string; name: string; equipment: readonly string[] } | null;
  /**
   * The account's condition profiles are known on the device (the library's read is here): without them a document is
   * judged by no profile's rules, so an offline Start is refused (R11 fix round 1).
   */
  profilesKnown: boolean;
  /**
   * Answers kept offline on this page, not recorded (R11 fix round 1), each with its day. Should a Start go on ONLINE
   * after all (the network back before its create), one still of today with no reading the server holds is sent as an
   * ordinary check before the build, so the server gates and builds on it; the rest are dropped (fix round 2).
   */
  keptOffline: MutableRefObject<Map<string, KeptAnswer>>;
}

/** An answer kept offline (`keptOffline`): the reading, and the account's day it was answered on. */
export type KeptAnswer = CheckReading & { date: string };

/** A zone this runtime can read a date in: the account's day, never the device's guess (R11 fix round 1). */
function zoneKnown(timeZone: string | null): timeZone is string {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
    return true;
  } catch {
    return false;
  }
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

/** Edit before approve (Stage 3): opens the builder on a coach's draft — that op of the proposal. */
export function useEditBeforeApprove(): (proposalId: string, opId: string) => void {
  const navigate = useNavigate();
  return useCallback((proposalId: string, opId: string) => navigate(editDraftHref(proposalId, opId)), [navigate]);
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
  focusStatus,
  timeZone,
  recorded,
  place,
  profilesKnown,
  keptOffline,
}: BuildFlowsIn) {
  /** Changed since it was saved: the two read alike through the schema (its key order, its empty parts dropped). */
  const dirtyOf = (l: Loaded | null): boolean =>
    !!l && l.baseline !== null && JSON.stringify(toProposable(l.editor.doc)) !== JSON.stringify(toProposable(startEditing(l.baseline).doc));

  /**
   * A create's key (`clientId`): made once for what is being built — per draft, and per kind of create — and kept
   * until that create lands, so a retry whose answer was lost names the same workout (or template) and the server
   * answers it, never a second; a create that landed lets the next one make another (a template scheduled twice).
   * The new draft's are kept with it on the device (`StudioDraft.keys`), so a reload between a lost answer and the
   * retry sends the same; the page's memory holds the rest's, and the draft's when the device keeps none.
   */
  const createKeys = useRef(new Map<string, string>());
  const keyed = async (kind: "workout" | "template", draftKey: string) => {
    const k = `${kind}|${draftKey}`;
    const kept = draftKey === "new" ? await drafts.createKey(kind).catch(() => null) : null;
    const id = kept ?? createKeys.current.get(k) ?? newId();
    if (!kept) createKeys.current.set(k, id);
    return {
      clientId: id,
      landed: () => {
        createKeys.current.delete(k);
        if (kept) void drafts.createLanded(kind).catch(() => undefined);
      },
    };
  };

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
      setFlow({ step: "refused", text: "This workout couldn't be built — try again, or change it and try again." });
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
  /** The check Start offers (CUJ R5): a switched-on profile unanswered today, not skipped here already. */
  const offered = () => bc.profiles.find((p) => !answered(bc.readings[p.id]) && !skipped.current.has(p.id));
  /**
   * A quick start's or a template's new workout: today may already hold one from the same start, which only the create
   * can say (I3). Its check is offered once the create has made it — never before the offer to continue the one today
   * already holds (re-review N2).
   */
  const startsOnce = (cur: Loaded | null): boolean => {
    const doc = cur && !cur.key.startsWith("workout:") ? toProposable(cur.editor.doc) : null;
    const sent = doc ? forSchedule(doc, source) : null;
    return !!sent && (sent.basedOn?.kind === "template" || !!sent.source.ref?.startsWith("quick_start:"));
  };
  /** The server's warnings at a create whose check was offered before its build: shown with that build. */
  const heldNotes = useRef<string[]>([]);
  /**
   * A Start going on online with answers kept offline on this page (the network back before its create; R11 fix round
   * 1): each is sent as an ordinary check before the build, so the server gates and builds on it — never attached to
   * the session's save. Only while it is still today's on the account's clock, and the server holds no reading of its
   * own for today (a fresh Today read says both); otherwise it is dropped (fix round 2). One whose send fails stays
   * kept, and the server judges the day unanswered.
   */
  const sendKept = async (): Promise<void> => {
    if (keptOffline.current.size === 0) return;
    const now = await qc.fetchQuery({ queryKey: ["today"], queryFn: api.today, staleTime: 0, retry: false }).catch(() => null);
    let sent = false;
    for (const [profileId, k] of [...keptOffline.current]) {
      const held = now?.conditions?.find((c) => c.profileId === profileId)?.today ?? null;
      // No fresh word of today, another day's answer (the page left open overnight), or the server's own reading: dropped.
      if (!now || k.date !== now.today || (held && (held.value !== null || held.feelingOff))) {
        keptOffline.current.delete(profileId);
        continue;
      }
      const res = await api.recordCheck({ profileId, value: k.pre, feelingOff: k.feelingOff }).catch(() => null);
      if (!res?.check) continue;
      keptOffline.current.delete(profileId);
      sent = true;
    }
    if (sent) void qc.invalidateQueries({ queryKey: ["today"] });
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
      let fresh: string[] = heldNotes.current.splice(0);
      if (cur.key.startsWith("workout:")) {
        id = cur.key.slice("workout:".length);
        if (dirtyOf(cur)) {
          const res = await api.reviseWorkoutDoc(id, doc0, cur.rev ?? 0);
          setLoaded({ ...live.current!, baseline: doc0, rev: res.rev });
          fresh = newNotes(res.warnings) ?? [];
        }
      } else {
        const sent = forSchedule(doc0, source);
        const once = await keyed("workout", cur.key);
        // The account's now (CUJ R14): today as the server reads it at this moment — a Today read kept overnight is
        // yesterday's — and the time on the account's clock, not the device's.
        const day = await qc.fetchQuery({ queryKey: ["today"], queryFn: api.today, staleTime: 0, retry: false }).then(
          (t) => t.today,
          () => today,
        );
        let res: Awaited<ReturnType<typeof api.createWorkout>>;
        try {
          res = await api.createWorkout({ date: day, time: nowHHMM(new Date(), timeZone), doc: sent, clientId: once.clientId, startNow: true });
        } catch (e) {
          // No network (R11): a quick start or a template plays from this device, recorded once the outbox can.
          if (!(e instanceof ApiError) && startsOnce(cur)) return await startOffline(cur, sent, once);
          throw e;
        }
        once.landed();
        fresh = newNotes(res.warnings) ?? [];
        if (source.kind === "template") void api.useTemplate(source.id).catch(() => undefined);
        adopt(res.workout, sent);
        id = res.workout.id;
        // Made now, today's check unanswered: offered before it is built (N2), then Start goes on with it.
        const later = offered();
        if (later) {
          heldNotes.current = fresh;
          refreshPlan();
          setFlow(IDLE);
          setAsking({ profileId: later.id, then: "start", offered: true });
          return;
        }
      }
      refreshPlan();
      await sendKept();
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
      // Today already holds this quick start or template, still to finish: that one, not a second (I3).
      const held = errorBody(e)?.error === "started_today" ? errorBody(e)?.workout : undefined;
      if (held) {
        setFlow({ step: "again", workout: held });
        return;
      }
      setFlow({ step: "refused", text: refusalText(e, "start") });
    }
  };
  /**
   * START NOW WITH NO NETWORK (R11): a quick start or a template, played from a build made on this device under a
   * provisional id, and recorded when the outbox can (`offline/local-starts.ts`). Its day and time are the account's
   * clock's, now; what is known of the day is today's readings here — or, when this device's plan is another day's,
   * only those answered on this page. Judged for that day as the server would (an unanswered day keeps day-gated moves
   * out): an error stops it in the validator's words, a check its errors wait on is asked, and today's unanswered check
   * is offered as online — its answer kept for this session alone. Two of one kind on one day are one session (Continue
   * it). A device that cannot keep it (no storage, no account known here) still needs a connection — and so does one
   * that does not know the account's condition profiles (it would judge by none of their rules) or its zone (it would
   * date the session by a day the server may refuse) (fix round 1).
   */
  const startOffline = async (cur: Loaded, sent: WorkoutDoc, once: { clientId: string; landed: () => void }): Promise<void> => {
    const needsConnection = () => setFlow({ step: "refused", text: refusalText(null, "start") });
    if (!profilesKnown || !zoneKnown(timeZone)) return needsConnection();
    const kind = startKindOf(sent);
    const uid = userId() ?? (await meWithOfflineFallback().catch(() => null))?.userId ?? null;
    const db = await offlineDb().catch(() => null);
    if (!kind || !uid || !db) return needsConnection();
    const now = new Date();
    const clock = clockIn(now, timeZone);
    const date = clock.date;
    const held = await unfinishedLocalStart(db, uid, kind, date).catch(() => undefined);
    if (held) {
      setFlow({ step: "again", workout: heldHere(held) });
      return;
    }
    const readings = date === bc.today ? bc.readings : recorded;
    const day = date === bc.today ? judged : judgeDraft(cur.editor.doc, { ...bc, today: date, readings }, date);
    if (day?.blocked) {
      setFlow({ step: "refused", text: day.blocked });
      return;
    }
    const waits = day?.checks[0];
    const unanswered = bc.profiles.find((p) => !answered(readings[p.id]) && !skipped.current.has(p.id));
    if (waits || unanswered) {
      setFlow(IDLE);
      setAsking(waits ? { profileId: waits, then: "start" } : { profileId: unanswered!.id, then: "start", offered: true });
      return;
    }
    const checks = Object.fromEntries(bc.profiles.flatMap((p) => (answered(readings[p.id]) ? [[p.id, { pre: readings[p.id]!.pre, feelingOff: readings[p.id]!.feelingOff }]] : [])));
    const localId = localIdOf(once.clientId);
    try {
      const where = { id: place?.id ?? "home", name: place?.name ?? "Home", equipment: place?.equipment ?? [] };
      const { build, view } = localBuild(sent, { localId, date, checks, location: where, now: now.getTime() });
      const start: LocalStart = { localId, clientId: once.clientId, userId: uid, kind, title: sent.title, doc: sent, date, time: nowHHMM(now, timeZone), createdAt: now.getTime() };
      await rememberLocalStart(db, start);
      await saveBuild(db, { workoutId: localId, build, view }, now.getTime());
      await saveExtras(db, { workoutId: localId, title: sent.title, profiles: bc.profiles.map(checkViewOf), userId: uid, savedAt: now.getTime() });
    } catch {
      // Too large to build, or the device full: nothing half-kept.
      await forgetLocalStart(db, localId).catch(() => undefined);
      await forgetStart(db, localId).catch(() => undefined);
      return needsConnection();
    }
    // Its key is the start's now: the next Start of this draft makes another.
    once.landed();
    setFlow(IDLE);
    navigate(`/session/${encodeURIComponent(localId)}`);
  };
  /** Continue the one today already holds: back into its session when it is under way, else started now. */
  const continueToday = async (w: DocWorkoutDto): Promise<void> => {
    // Started offline on this device (R11): its session is here, and only here.
    if (isLocalId(w.id)) {
      setFlow(IDLE);
      navigate(`/session/${encodeURIComponent(w.id)}`);
      return;
    }
    if (w.contentState === "started") {
      // Under way — on this device, or on another: what the player plays is left here first, under the workout's own
      // title, as Start leaves it. Read from the server alone, the session names no workout (the player said "Session").
      setFlow({ step: "busy", what: "Opening…" });
      const s = await api.getSession(w.id).catch(() => null);
      if (s && s.contentState === "started" && !(await keepStarted(s, w.title, userId()))) {
        setFlow({ step: "notKept", workoutId: w.id });
        return;
      }
      setFlow(IDLE);
      navigate(`/session/${encodeURIComponent(w.id)}`);
      return;
    }
    setFlow({ step: "busy", what: "Starting…" });
    try {
      await sendKept();
      const built = await api.buildSession(w.id, {});
      noteChecks(built);
      const info = built.build?.fromDoc;
      if (info?.blocked.length) {
        setFlow({ step: "refused", text: info.blocked[0]!.message });
        return;
      }
      if (info?.swaps.length) {
        setFlow({ step: "swaps", session: built });
        return;
      }
      await lock(built);
    } catch (e) {
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
    // Today's check unanswered, though nothing waits on it: offered first, so the session has a before as well as an
    // after (CUJ R5) — the same sheet, one tap to go on without it. A quick start's or template's comes after the
    // create (N2).
    const offer = offered();
    if (offer && !startsOnce(live.current)) {
      setAsking({ profileId: offer.id, then: "start", offered: true });
      return;
    }
    await runStart();
  };
  /** The checks Start offered that were skipped: not offered again on this page. */
  const skipped = useRef(new Set<string>());
  /** Start without the offered check: it goes on at once. */
  const skipCheck = (profileId: string) => {
    skipped.current.add(profileId);
    setAsking(null);
    setResume(true);
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
  /** The athlete took a coach's draft as a new workout of their own (it couldn't be approved): Schedule makes one. */
  const [asNew, setAsNew] = useState(false);
  /** Their edits, scheduled as a new workout: the Schedule sheet, and it makes one of their own. */
  const scheduleAsNew = () => {
    setAsNew(true);
    setStatus(null);
    setScheduling(true);
  };
  /** A coach's draft that can't be approved: the edits stay, said plainly, with scheduling them as a new workout offered. */
  const sayDraft = (said: Status) => {
    setScheduling(false);
    setStatus(said);
    focusStatus();
  };
  /**
   * EDIT BEFORE APPROVE (Stage 3): a coach's draft saved here — Schedule (a new workout, on the day chosen) or Save
   * changes (a revision) — is that op of the proposal approved with this version, through the coach's approve, never
   * a workout of its own; the builder is then on the workout it became. A refusal that is the Studio save's own is
   * thrown, for the save's own words; one that is the draft's (`draftRefusal`), or a draft decided elsewhere meanwhile,
   * keeps the athlete's edits, says so, and offers to schedule them as a new workout.
   */
  const approveDraft = async (doc: WorkoutDoc, when?: { date: string; time: string | null }): Promise<string | null> => {
    if (source.kind !== "proposal") return null;
    let res: Awaited<ReturnType<typeof api.coachDesignApprove>>;
    try {
      res = await api.coachDesignApprove(source.id, { edit: { opId: source.opId, doc, ...(when ?? {}) } });
    } catch (e) {
      const said = draftRefusal(e, !when);
      if (!said) throw e;
      sayDraft(said);
      return null;
    }
    const made = res.applied.find((a) => a.opId === source.opId);
    if (!made) {
      const before = res.settled.find((s) => s.opId === source.opId)?.outcome;
      sayDraft({ text: before ? DECIDED_TEXT[before] : "This draft isn't open any more, so it can't be approved.", asNew: true });
      return null;
    }
    refreshPlan();
    adopt(made.workout, doc);
    setScheduling(false);
    setStatus(
      when
        ? { text: scheduledText(made.workout, today), link: { to: "/plan", label: "See it in Plan" }, notes: newNotes(made.warnings) }
        : { text: "Saved.", notes: newNotes(made.warnings), ...(made.watchHasOlder ? { watch: { workoutId: made.workout.id, minutes: made.workout.minutes } } : {}) },
    );
    focusStatus();
    return null;
  };
  const schedule = async (when: string, time: string | null): Promise<string | null> => {
    const cur = live.current;
    if (!cur) return null;
    const j = judgeDraft(cur.editor.doc, bc, when);
    if (!j.doc) return EMPTY_BLOCK;
    if (j.blocked) return j.blocked;
    const sent = forSchedule(j.doc, source);
    try {
      if (source.kind === "proposal" && !asNew) return await approveDraft(sent, { date: when, time });
      const once = await keyed("workout", cur.key);
      const res = await api.createWorkout({ date: when, ...(time ? { time } : {}), doc: sent, clientId: once.clientId });
      once.landed();
      refreshPlan();
      if (source.kind === "template") {
        void api
          .useTemplate(source.id)
          .then(() => qc.invalidateQueries({ queryKey: TEMPLATES_QUERY }))
          .catch(() => undefined);
      }
      // A new workout or a quick start, scheduled, is that planned workout now (a second Start never makes another).
      if (cur.key === "new" || source.kind === "quick" || source.kind === "again" || source.kind === "proposal") adopt(res.workout, sent);
      setScheduling(false);
      setStatus({ text: scheduledText(res.workout, today), link: { to: "/plan", label: "See it in Plan" }, notes: newNotes(res.warnings) });
      focusStatus();
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
      const once = await keyed("template", live.current!.key);
      const res = await api.createTemplate({ name: name.trim(), doc: d, ...(pinned ? { pinned: true } : {}), clientId: once.clientId });
      once.landed();
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
      focusStatus();
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
    if (cur && d && source.kind === "proposal") {
      // A coach's revision, saved: approved with this version (Edit before approve).
      setSaving(true);
      const why = await approveDraft(d).catch((e: unknown) => refusalText(e, "save"));
      if (why) setStatus({ text: why });
      setSaving(false);
      return;
    }
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
      focusStatus();
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
    // Another draft: what this one's creates were keyed by goes with it.
    createKeys.current.clear();
    void drafts.clear().catch(() => undefined);
    setLoaded({ key: "new", editor: startEditing(freshDoc()), baseline: null, rev: null, row: null });
    setFreshAsk(false);
    setStatus(null);
    setFlow({ step: "idle" });
  };

  // A quick start's or a template's new workout: its Start can go on with no network, and so its check's answer (R11).
  const startsHere = startsOnce(ready);
  return { dirtyOf, lock, startNow, skipCheck, continueToday, schedule, saveAsTemplate, saveTemplate, saveChanges, reload, startOver, startsHere, asNew, scheduleAsNew };
}
