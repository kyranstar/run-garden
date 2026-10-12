/**
 * THE BUILDER (Stage 2 spec §8; principles §2.1–§2.8, §7): where an athlete shapes a workout with intention — parts
 * with purposes and suggestions in each, items with dose, cue and swap, a live summary with the validator's notes —
 * then saves it as a template, schedules it, or starts it now.
 *
 *   ‹ Studio                                  ↶  ↷  [Save ▾]
 *   Hips & posture                                 ← the title, edited in place
 *   Open the hips and wake the glutes…             ← the why
 *   Effort  Recover · Maintain · [Develop] · Peak
 *   Goals   Posture · Ski                   Edit
 *   ┌ 34 min · Strength · Home        1 to fix ⌄ ┐ ← the summary (folds; its errors never do)
 *   WARM-UP · 5 min                            ⋯   ← a part: its purpose (explained one tap down), format, minutes
 *     Cat-cow                     6 reps       ›   ← an item: tap for dose, cue, swap, move, remove
 *     Suggested  Hip airplane ＋ · Ankle rocks ＋   ← the part's suggestions (reason one tap down)
 *     ＋ Add a move
 *   ACTIVATION (not made yet)                  ✕   ← prompted once a part loads a lift (activate before loading)
 *     Suggested  Glute bridge ＋
 *   MAIN · Superset × 3 · 20 min               ⋯
 *   …
 *   Add a part  ＋ Power · ＋ Accessory · …
 *   ┌──────────────────────────────────────────┐ ← pinned above the tab bar
 *   │ Why Start is off, when it is              │
 *   │ [ Start now ]            [ Schedule… ]   │
 *   └──────────────────────────────────────────┘
 *
 * THE DOCUMENT IS THE MODEL. Every change is one action of the editor (`tryEdit`), so it is the same edit a test makes,
 * and Undo and Redo are the editor's history, two quiet buttons at the top. Text lands when its field is left. A new
 * workout is the draft on this device (`useStudioDraft`): it starts as warm-up, main and cool-down, empty, with
 * suggestions, and it is saved on every change — it works offline. A template or a planned workout is read from the
 * server and saved to it only when asked (Save ▾).
 *
 * ERRORS BLOCK, WARNINGS COST (principles §2.7–§2.8). The notes are the validator's, judged for the day (today, or a
 * planned workout's own day) with today's readings, the athlete's set-aside moves and the place's gear (`judgeDraft`).
 * An error keeps Start off and says why beside it, with a Fix where the validator has one. An error today's check could
 * answer does not: it asks for the check — in place, the condition check's own sheet — so a Studio-only athlete, who
 * has no programme's check chip, never meets a dead end; answered, Start goes on by itself.
 *
 * START NOW (spec §8, §10): the workout is made for today (or a planned one's changes saved), built from its document,
 * and started — the same session flow as the session sheet's Start — then the player. A build the day's reading
 * changed (a gated move swapped for its alternate) is shown before it locks, and Start goes on only when the athlete
 * says so; one the day refuses says why. Once made, the builder is on that planned workout (its address too), so a
 * second Start never makes a second workout.
 *
 * QUICK STARTS AND TEMPLATES (spec §9): a quick start (`/studio/build/quick/:kind`) opens pre-filled, built on the
 * device for the day, so its tile and Start now are two taps to a running session; it is kept nowhere until it is
 * started, scheduled or saved as a template. The templates list's Start and Schedule… open the template here and do
 * that once, and its way back is the list.
 *
 * SCHEDULE (spec §8): one small sheet — "Later today" (the athlete's usual time while it is ahead, else the next whole
 * hour and one more) or another day. A new workout or a quick start, scheduled, becomes that planned workout here; a
 * template stays a template, and the workout made from it says so (`basedOn`).
 *
 * WIDTHS. One column on a phone, the summary folded. From md the summary is a column of its own beside the parts,
 * open and sticky. The actions are pinned to the bottom at every width, above the phone's tab bar.
 */
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  ApiError,
  type ConditionCheckDto,
  type DocIssueDto,
  type DocWorkoutDto,
  type MeResponse,
  type SessionDto,
  type WorkoutDto,
} from "@rg/api-client";
import { addDays, EFFORT_LEVELS, type WorkoutDoc } from "@rg/domain";
import { EXERCISES, GLOSSARY, label, type CheckReading, type ExerciseRecord } from "@rg/exercise-library";
import {
  makeLibraryIndex,
  placementFor,
  redo,
  startEditing,
  suggestedItem,
  suggestForPart,
  toProposable,
  tryEdit,
  undo,
  type EditAction,
  type EditorState,
  type Rejection,
  type SuggestCtx,
  type Suggestion,
} from "@rg/workout";
import { ConfirmDialog, EmptyState, formatDayShort, formatTime, localTodayGuess, Spinner } from "../../components.js";
import { checkWord, ConditionCheckSheet } from "../../components/condition-check-sheet.js";
import { keepStarted } from "../../components/start-session.js";
import { Tooltip } from "../../components/tooltip.js";
import { WatchPreviewSheet } from "../../components/watch-preview-sheet.js";
import { features } from "../../features.js";
import { IconAlert, IconBack, IconChevron, IconClose, IconMore, IconPlus, IconRedo, IconUndo } from "../../icons.js";
import { requestPersistentStorage } from "../../offline/live.js";
import { chimes } from "../../player/audio.js";
import { useStudioDraft } from "../../studio-drafts.js";
import { useWeightUnit } from "../../use-units.js";
import { addTargetHref, freshDoc } from "./add-model.js";
import { TEMPLATES_QUERY } from "./add-sheet.js";
import {
  activationAt,
  addablePurposes,
  blockedLine,
  buildCtxOf,
  checkViewOf,
  doseSummary,
  editAll,
  editRefusal,
  EMPTY_BLOCK,
  forSchedule,
  judgeDraft,
  laterToday,
  usualTime,
  nowHHMM,
  partMinutes,
  readOnlyWhy,
  sentence,
  showsSuggestions,
  sourceKey,
  sourceOfPath,
  suggestCtxOf,
  withPart,
  type BuildSource,
  type Note,
} from "./build-model.js";
import { CommitField, ItemSheet, itemName } from "./item-sheet.js";
import { MovePicker } from "./move-picker.js";
import { GoalsSheet } from "./goals-sheet.js";
import { formatLine, PartMenu } from "./part-menu.js";
import { NameSheet, SaveMenu } from "./save-menu.js";
import { ScheduleSheet } from "./schedule-sheet.js";
import { DETAIL_PANE_MIN_PX, useMinWidth, useStudioReads } from "./screen.js";
import { SummaryCard } from "./summary-card.js";
import { quickStartFor, TEMPLATES_HREF, type BuilderArrival } from "./templates-model.js";

/** A planned workout's document, read fresh (`GET /api/workouts/:id/doc`). */
export const workoutDocQuery = (id: string) => ["workout-doc", id] as const;
/** The readings this page recorded (or the session read gave): a Studio-only athlete's Today carries none. */
const readingsQuery = (today: string) => ["studio", "readings", today] as const;
/**
 * The planned workout this builder is on, read with its day and its state: a window either side of today wide enough
 * to find one done (or gone) a while ago, so it opens read-only and says why.
 */
const rowQuery = (today: string) => ["plan", "studio-row", today] as const;
const ROW_DAYS = 56;

/** The builder's routes (spec §2): `/studio/build/new`, `…/quick/:kind`, `…/template/:id`, `…/workout/:workoutId`. One instance across them. */
export function BuilderRoute() {
  const { pathname } = useLocation();
  const source = sourceOfPath(pathname);
  if (!source) return <Navigate to="/studio" replace />;
  return <Builder source={source} />;
}

interface Loaded {
  key: string;
  editor: EditorState;
  /** What is saved: a template's or a planned workout's document; null for a new workout. */
  baseline: WorkoutDoc | null;
  /** A planned workout's revision. */
  rev: number | null;
  /** A planned workout's day and time, when this page made it. */
  row: { date: string; time: string } | null;
}

type Flow =
  | { step: "idle" }
  | { step: "busy"; what: string }
  /** The day's build changed the workout, or the server saw a cost this page had not said: shown before it locks. */
  | { step: "swaps"; session: SessionDto; notes?: string[] }
  | { step: "refused"; text: string }
  /** Started, but this device could not keep it. */
  | { step: "notKept"; workoutId: string };

const IDLE: Flow = { step: "idle" };

interface Status {
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

/** Suggestions for one part; a malformed probe (a programming error) suggests nothing rather than breaking the page. */
function suggestionsFor(doc: WorkoutDoc, i: number, sctx: SuggestCtx): Suggestion[] {
  try {
    return suggestForPart(doc, i, EXERCISES, sctx);
  } catch {
    return [];
  }
}

const find = makeLibraryIndex(EXERCISES);

/** "Scheduled for today at 4 PM." */
function scheduledText(w: DocWorkoutDto, today: string): string {
  const day = w.date === today ? "today" : w.date === addDays(today, 1) ? "tomorrow" : formatDayShort(w.date);
  return `Scheduled for ${day} at ${formatTime(w.time)}.`;
}

function Builder({ source }: { source: BuildSource }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  /** What the templates list asked of this visit (its Start, its Schedule…), and where its way back goes. */
  const arrived = location.state as BuilderArrival | null;
  const { ctx, settled } = useStudioReads();
  const today = ctx.today ?? localTodayGuess();
  const unit = useWeightUnit();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, staleTime: 60_000 });
  const wide = useMinWidth(DETAIL_PANE_MIN_PX);
  const drafts = useStudioDraft();
  const key = sourceKey(source);
  const tplId = source.kind === "template" ? source.id : null;
  const wid = source.kind === "workout" ? source.id : null;
  const templates = useQuery({ queryKey: TEMPLATES_QUERY, queryFn: api.templates, enabled: tplId !== null, staleTime: 30_000 });
  const stored = useQuery({ queryKey: workoutDocQuery(wid ?? ""), queryFn: () => api.workoutDoc(wid!), enabled: wid !== null, staleTime: 0 });
  const planned = useQuery({
    queryKey: rowQuery(today),
    queryFn: () => api.workouts(addDays(today, -ROW_DAYS), addDays(today, ROW_DAYS)),
    enabled: wid !== null,
    staleTime: 30_000,
  });
  const recordedQ = useQuery({
    queryKey: readingsQuery(today),
    queryFn: () => ({}) as Record<string, CheckReading>,
    enabled: false,
    staleTime: Infinity,
    initialData: {} as Record<string, CheckReading>,
  });
  // A quick start (spec §9): built here, from the bundled library, as soon as what it is judged with is known — no
  // network, no AI; the day's seed keeps it the same workout all day. Kept nowhere until it is started, scheduled or
  // saved as a template, so the workout being built on this device is never touched.
  const quick = source.kind === "quick" ? source.quick : null;
  const made = useMemo(() => (quick && settled ? quickStartFor(quick, ctx, today, recordedQ.data) : null), [quick, settled, ctx, today, recordedQ.data]);

  // ── The document, and every edit to it ──
  const template = tplId ? templates.data?.templates.find((t) => t.id === tplId) : undefined;
  /** The source's document as it is read, once it is here: the draft (or a new one), the template's, the workout's. */
  const opened = (): Loaded | null => {
    if (source.kind === "new") {
      return drafts.loaded ? { key, editor: startEditing(drafts.draft?.doc ?? freshDoc()), baseline: null, rev: null, row: null } : null;
    }
    if (source.kind === "quick") return made && "doc" in made ? { key, editor: startEditing(made.doc), baseline: null, rev: null, row: null } : null;
    if (source.kind === "template") return template?.doc ? { key, editor: startEditing(template.doc), baseline: template.doc, rev: null, row: null } : null;
    const r = stored.data;
    return r?.doc ? { key, editor: startEditing(r.doc), baseline: r.doc, rev: r.rev, row: null } : null;
  };
  // Opened in the first render when its read is already here (the device's draft, a cached template), else once it is.
  const [loaded, setLoadedState] = useState<Loaded | null>(opened);
  const live = useRef<Loaded | null>(loaded);
  const setLoaded = useCallback((next: Loaded | null) => {
    live.current = next;
    setLoadedState(next);
  }, []);
  useEffect(() => {
    if (live.current?.key === key) return;
    const next = opened();
    if (next) setLoaded(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, drafts.loaded, drafts.draft, template, stored.data, made, setLoaded]);

  const ready = loaded?.key === key ? loaded : null;
  const doc = ready?.editor.doc ?? null;

  const commit = useCallback(
    (editor: EditorState) => {
      const cur = live.current;
      if (!cur) return;
      const next = { ...cur, editor };
      setLoaded(next);
      if (next.key === "new") void drafts.save(editor.doc).catch(() => undefined);
      // An edit moves on from what the footer said of the last state: a refusal, a build shown before it locked, the
      // offer to undo a removal, "Saved." (A start under way, and a started session this device could not keep, stay;
      // an edit that says something of its own — "Removed …" — says it after this.)
      setFlow((f) => (f.step === "busy" || f.step === "notKept" ? f : IDLE));
      setStatus(null);
    },
    [drafts, setLoaded],
  );
  /** One editor action; why it was refused, if it was ("unchanged" is no refusal). */
  const edit = useCallback(
    (action: EditAction): Rejection | undefined => {
      const cur = live.current;
      if (!cur) return "missing";
      const r = tryEdit(cur.editor, action, EXERCISES);
      if (r.rejected) return r.rejected === "unchanged" ? undefined : r.rejected;
      commit(r.state);
      return undefined;
    },
    [commit],
  );
  /** Several editor actions as one edit (one Undo). */
  const editMany = useCallback(
    (actions: readonly EditAction[]): Rejection | undefined => {
      const cur = live.current;
      if (!cur) return "missing";
      const r = editAll(cur.editor, actions, EXERCISES);
      if (r.rejected) return r.rejected === "unchanged" ? undefined : r.rejected;
      commit(r.state);
      return undefined;
    },
    [commit],
  );

  // ── What it is judged and suggested with ──
  const recorded = recordedQ.data;
  const bc = useMemo(() => buildCtxOf(ctx, today, recorded), [ctx, today, recorded]);
  const plannedRow: WorkoutDto | undefined = wid ? planned.data?.workouts.find((w) => w.id === wid) : undefined;
  const row = ready?.row ?? (plannedRow ? { date: plannedRow.effectiveDate, time: plannedRow.effectiveTime } : null);
  const isWorkout = key.startsWith("workout:");
  const date = isWorkout && row && row.date > today ? row.date : today;
  const judged = useMemo(() => (doc ? judgeDraft(doc, bc, date) : null), [doc, bc, date]);
  const sctx = useMemo(() => suggestCtxOf(bc, date), [bc, date]);
  const suggestions = useMemo(() => (doc ? doc.parts.map((p, i) => (showsSuggestions(p) ? suggestionsFor(doc, i, sctx) : [])) : []), [doc, sctx]);
  const ghostAt = useMemo(() => (doc ? activationAt(doc) : null), [doc]);
  const ghost = useMemo(() => (doc && ghostAt !== null ? suggestionsFor(withPart(doc, ghostAt, "activation"), ghostAt, sctx) : []), [doc, ghostAt, sctx]);

  // ── What is open ──
  const [editing, setEditing] = useState<{ part: number; item: number } | null>(null);
  const [menuPart, setMenuPart] = useState<number | null>(null);
  const [picking, setPicking] = useState<number | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [goalsOpen, setGoalsOpen] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [naming, setNaming] = useState(false);
  const [freshAsk, setFreshAsk] = useState(false);
  const [asking, setAsking] = useState<{ profileId: string; then: "start" | null } | null>(null);
  const [resume, setResume] = useState(false);
  const [sumOpen, setSumOpen] = useState<boolean | null>(null);
  const [ghostOff, setGhostOff] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [stale, setStale] = useState(false);
  const [saving, setSaving] = useState(false);
  const [flow, setFlow] = useState<Flow>({ step: "idle" });
  const [sendingWatch, setSendingWatch] = useState<{ workoutId: string; minutes: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  /** Where focus goes once the next render lands: the first of these on the page. */
  const focusNext = useRef<readonly string[] | null>(null);
  const whyId = useId();
  useEffect(() => {
    const want = focusNext.current;
    if (!want) return;
    focusNext.current = null;
    for (const sel of want) {
      const el = root.current?.querySelector<HTMLElement>(sel);
      if (el) {
        el.focus();
        break;
      }
    }
  });

  const refreshPlan = useCallback(() => {
    for (const k of ["today", "plan", "plan-week", "programs"]) void qc.invalidateQueries({ queryKey: [k] });
  }, [qc]);

  /** The server's warnings this page has not said already. */
  const newNotes = (ws: readonly DocIssueDto[]): string[] | undefined => {
    const said = new Set(judged?.notes.map((n) => n.message) ?? []);
    const fresh = [...new Set(ws.filter((w) => !said.has(w.message)).map((w) => w.message))];
    return fresh.length ? fresh : undefined;
  };
  const profileOf = (id: string) => ctx.profiles.find((p) => p.id === id);
  const checkLabel = (id: string) => {
    const p = profileOf(id);
    return p ? `${checkWord(p.check.label)} check` : "Check";
  };
  /** A note's Fix. From the summary, its button goes with the note: focus goes to what was fixed. */
  const onFix = (n: Note, from: "summary" | "sheet" = "summary") => {
    if (!n.fix) return;
    const r = edit(n.fix.action);
    if (r) {
      const cur = live.current;
      setStatus({ text: cur ? editRefusal(n.fix.action, r, cur.editor.doc) : "That can't be done here." });
      return;
    }
    setStatus(null);
    if (from === "summary") {
      focusNext.current = [
        ...(n.part !== null && n.item !== null ? [`[data-at="${n.part}-${n.item}"]`] : []),
        ...(n.part !== null ? [`[data-part="${n.part}"] .stu-part-menu`] : []),
        ".stu-sum-head",
      ];
    }
  };
  const onCheck = (profileId: string) => setAsking({ profileId, then: null });
  const onCheckSaved = (c: ConditionCheckDto) => {
    qc.setQueryData<Record<string, CheckReading>>(readingsQuery(today), (old) => ({ ...(old ?? {}), [c.profileId]: { pre: c.value, post: null, feelingOff: c.feelingOff } }));
    if (asking?.then === "start") setResume(true);
  };
  /** The server's readings for the day (a session read): kept, so this page judges with what the server knows. */
  const noteChecks = (s: SessionDto) => {
    const known = Object.fromEntries(Object.entries(s.checks ?? {}).map(([id, a]) => [id, { pre: a.pre, post: null, feelingOff: a.feelingOff } satisfies CheckReading]));
    if (Object.keys(known).length) qc.setQueryData<Record<string, CheckReading>>(readingsQuery(today), (old) => ({ ...(old ?? {}), ...known }));
  };

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
    navigate(addTargetHref({ kind: "workout", id: w.id }), { replace: true });
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
  const saveAsTemplate = async (name: string): Promise<string | null> => {
    const d = live.current ? toProposable(live.current.editor.doc) : null;
    if (!d) return EMPTY_BLOCK;
    try {
      const res = await api.createTemplate({ name: name.trim(), doc: d });
      void qc.invalidateQueries({ queryKey: TEMPLATES_QUERY });
      setNaming(false);
      setStatus({ text: `Saved “${name.trim()}” as a template.`, notes: newNotes(res.warnings) });
      return null;
    } catch (e) {
      return refusalText(e, "save");
    }
  };
  const saveTemplate = async () => {
    const d = live.current ? toProposable(live.current.editor.doc) : null;
    if (!tplId || !d) return;
    setSaving(true);
    try {
      const res = await api.updateTemplate(tplId, { doc: d });
      void qc.invalidateQueries({ queryKey: TEMPLATES_QUERY });
      if (live.current) setLoaded({ ...live.current, baseline: d });
      setStatus({ text: "Saved.", notes: newNotes(res.warnings) });
    } catch (e) {
      setStatus({ text: refusalText(e, "save") });
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

  // ── Not ready ──
  if (!ready || !doc || !judged) {
    let problem: string | null = null;
    if (source.kind === "template") {
      if (templates.isError) problem = "Opening a template needs a connection.";
      else if (templates.isSuccess) problem = template ? "This template can't be read." : "That template is gone.";
    } else if (source.kind === "workout") {
      if (stored.isError) problem = stored.error instanceof ApiError && stored.error.status === 404 ? "That workout is gone." : "Opening a planned workout needs a connection.";
      else if (stored.data && !stored.data.doc) problem = "This workout can't be changed in the Studio.";
    } else if (source.kind === "quick" && made && "reason" in made) problem = made.reason;
    return (
      <div className="stu-build">
        {problem ? (
          <EmptyState title={problem}>
            <Link className="btn" to="/studio">
              Back to the Studio
            </Link>
          </EmptyState>
        ) : (
          <Spinner label="Opening the workout" />
        )}
      </div>
    );
  }

  // ── Ready ──
  const dirty = dirtyOf(ready);
  // Done, under way, gone or past: read-only, and the page says why.
  const frozenWhy = isWorkout && plannedRow ? readOnlyWhy(plannedRow, today) : null;
  const frozen = frozenWhy !== null;
  const canStart = features.player && (!isWorkout || (row !== null && row.date === today)) && !frozen;
  const blocked = judged.blocked;
  const busy = flow.step === "busy";
  const open = sumOpen ?? wide;
  const notesAt = (p: number, i: number) => judged.notes.filter((n) => n.part === p && n.item === i);
  const showGhost = ghostAt !== null && ghost.length > 0 && !ghostOff && !frozen;
  const footWhy = flow.step === "swaps" ? null : canStart ? blockedLine(judged) : blocked === EMPTY_BLOCK ? EMPTY_BLOCK : null;

  const addSuggested = (pi: number | "ghost", rec: ExerciseRecord, why?: string) => {
    let r: Rejection | undefined;
    if (pi === "ghost") {
      const item = suggestedItem(rec, "activation", why);
      // The move's own part is activation: one action makes the part and puts it in. Otherwise the part first.
      if (placementFor(rec) === "activation") r = edit({ type: "addItem", item });
      else {
        r = edit({ type: "addPart", purpose: "activation", at: ghostAt! });
        if (!r) r = edit({ type: "addItem", part: ghostAt!, item });
      }
    } else {
      r = edit({ type: "addItem", part: pi, item: suggestedItem(rec, doc.parts[pi]!.purpose, why) });
    }
    if (r) {
      setStatus({ text: editRefusal({ type: "addItem", item: suggestedItem(rec, "main") }, r, doc) });
      return r;
    }
    setStatus(null);
    // The pressed ＋ goes with its suggestion: focus goes to the move's new row, else the next ＋, else Add a move.
    const p = pi === "ghost" ? ghostAt! : pi;
    const at = pi === "ghost" ? 0 : doc.parts[pi]!.items.length;
    focusNext.current = [`[data-at="${p}-${at}"]`, `[data-part="${p}"] .stu-sug-add`, `[data-part="${p}"] .stu-add-move`];
    return r;
  };
  /** The activation prompt, declined: it goes, its ✕ with it, so focus goes to the page's heading. */
  const dismissGhost = () => {
    setGhostOff(true);
    focusNext.current = [".stu-build-h1"];
  };
  const removeItem = (p: number, i: number) => {
    const it = doc.parts[p]?.items[i];
    const name = it ? itemName(it, it.kind === "exercise" ? find(it.libraryId) : undefined) : "it";
    const action: EditAction = { type: "removeItem", part: p, item: i };
    const r = edit(action);
    if (r) {
      setStatus({ text: editRefusal(action, r, doc) });
      return;
    }
    setEditing(null);
    // The part's add: Add a move, or — while its suggestions fold to one line — that line's ＋.
    focusNext.current = [`[data-part="${p}"] .stu-add-move`, `[data-part="${p}"] .stu-sug-line .stu-sug-add`];
    setStatus({ text: `Removed ${name}.`, undoAt: live.current?.editor.past.length ?? 0 });
  };
  const removePart = (p: number) => {
    const part = doc.parts[p];
    if (!part) return;
    const action: EditAction = { type: "removePart", part: p };
    const r = edit(action);
    if (r) {
      setStatus({ text: editRefusal(action, r, doc) });
      return;
    }
    setMenuPart(null);
    focusNext.current = [".stu-add-parts .chip", ".stu-build-title"];
    setStatus({ text: `Removed ${label(part.purpose)}.`, undoAt: live.current?.editor.past.length ?? 0 });
  };
  /** An edit whose refusal is said in the footer's line. */
  const say = (action: EditAction) => {
    const r = edit(action);
    if (r) setStatus({ text: editRefusal(action, r, doc) });
  };
  const setTitle = (text: string) => {
    const t = text.trim();
    if (!t) return;
    // A why never written follows the title (the document keeps the title as its summary until one is) — one edit, one Undo.
    const actions: EditAction[] = [
      ...(doc.intent.summary === doc.title ? [{ type: "setIntent", intent: { summary: t.slice(0, 200) } } satisfies EditAction] : []),
      { type: "setTitle", title: t },
    ];
    const r = editMany(actions);
    if (r) setStatus({ text: editRefusal(actions[actions.length - 1]!, r, doc) });
  };
  const setWhy = (text: string) => say({ type: "setIntent", intent: { summary: (text.trim() || doc.title).slice(0, 200) } });

  const saveItems: Array<{ label: string; run: () => void }> =
    source.kind === "template" && !isWorkout
      ? [
          { label: "Save template", run: () => void saveTemplate() },
          { label: "Save as a new template…", run: () => setNaming(true) },
        ]
      : // A quick start offers no "Start over": that would clear the workout being built on this device.
        isWorkout || source.kind === "quick"
        ? [{ label: "Save as template…", run: () => setNaming(true) }]
        : [
            { label: "Save as template…", run: () => setNaming(true) },
            { label: "Start over…", run: () => setFreshAsk(true) },
          ];

  const swapsShown = flow.step === "swaps" ? flow.session.build?.fromDoc?.swaps ?? [] : [];
  const editingItem = editing ? doc.parts[editing.part]?.items[editing.item] : undefined;
  const asked = asking ? profileOf(asking.profileId) : undefined;

  return (
    <div ref={root} className="stu-build">
      <div className="stu-build-grid">
        <header className="stu-build-head">
          <div className="stu-build-bar">
            <Link className="btn stu-build-back" to={arrived?.from === "templates" ? TEMPLATES_HREF : "/studio"}>
              <IconBack size={16} />
              {arrived?.from === "templates" ? "Templates" : "Studio"}
            </Link>
            <span className="stu-build-tools">
              {frozen ? null : (
                <>
                  <button type="button" className="btn stu-icon-btn" aria-label="Undo" disabled={ready.editor.past.length === 0} onClick={() => commit(undo(ready.editor))}>
                    <IconUndo size={18} />
                  </button>
                  <button type="button" className="btn stu-icon-btn" aria-label="Redo" disabled={ready.editor.future.length === 0} onClick={() => commit(redo(ready.editor))}>
                    <IconRedo size={18} />
                  </button>
                </>
              )}
              <SaveMenu items={saveItems} />
            </span>
          </div>
          {isWorkout && row ? <p className="stu-build-when">{`${row.date === today ? "Today" : formatDayShort(row.date)} · ${formatTime(row.time)}`}</p> : null}
          <h1 className="visually-hidden stu-build-h1" tabIndex={-1}>
            {doc.title}
          </h1>
          <CommitField label="Title" className="stu-build-title display" value={doc.title} maxLength={80} onCommit={setTitle} readOnly={frozen} />
          <CommitField
            label="Why"
            className="stu-build-why-field"
            multiline
            maxLength={200}
            placeholder="Why this workout"
            value={doc.intent.summary === doc.title ? "" : doc.intent.summary}
            onCommit={setWhy}
            readOnly={frozen}
          />
          <EffortPicker value={doc.intent.effort} disabled={frozen} onPick={(effort) => say({ type: "setIntent", intent: { effort } })} />
          <div className="stu-build-goals">
            <span className="stu-build-k">Goals</span>
            <span className="stu-build-goal-list">
              {[...doc.intent.goals.map((g) => label(g)), ...doc.intent.focus.map((f) => label(f))].join(" · ")}
            </span>
            {frozen ? null : (
              <button type="button" className="linklike stu-build-goals-edit" onClick={() => setGoalsOpen(true)}>
                {doc.intent.goals.length || doc.intent.focus.length ? "Edit" : "Add"}
              </button>
            )}
          </div>
        </header>

        {/* Nothing to sum up until there is a move: the actions say so ("Add a move first."). */}
        <div className="stu-build-sum" hidden={!judged.doc}>
          <SummaryCard
            judged={judged}
            place={ctx.place?.name ?? null}
            open={open}
            onToggle={() => setSumOpen(!open)}
            onFix={onFix}
            onCheck={onCheck}
            checkLabel={checkLabel}
            readOnly={frozen}
          />
        </div>

        <div className="stu-parts">
          {doc.parts.map((part, pi) => (
            <Fragment key={pi}>
              {showGhost && ghostAt === pi ? <GhostPart list={ghost} onAdd={(rec, why) => addSuggested("ghost", rec, why)} onDismiss={dismissGhost} /> : null}
              <PartBlock
                index={pi}
                part={part}
                minutes={partMinutes(doc, pi)}
                suggestions={suggestions[pi] ?? []}
                flagged={(i) => notesAt(pi, i).some((n) => n.severity === "error")}
                onItem={(i) => setEditing({ part: pi, item: i })}
                onMenu={() => setMenuPart(pi)}
                onAdd={(rec, why) => addSuggested(pi, rec, why)}
                onPick={() => {
                  setPickError(null);
                  setPicking(pi);
                }}
                readOnly={frozen}
              />
            </Fragment>
          ))}
          {showGhost && ghostAt === doc.parts.length ? <GhostPart list={ghost} onAdd={(rec, why) => addSuggested("ghost", rec, why)} onDismiss={dismissGhost} /> : null}
          {!frozen && addablePurposes(doc, ctx.profiles).length ? (
            <div className="stu-add-parts">
              <span className="stu-build-k">Add a part</span>
              <div className="stu-chipset">
                {addablePurposes(doc, ctx.profiles).map((p) => (
                  <button
                    key={p}
                    type="button"
                    className="chip stu-add-part"
                    onClick={() => {
                      const action: EditAction = { type: "addPart", purpose: p };
                      const r = edit(action);
                      setStatus(r ? { text: editRefusal(action, r, doc) } : null);
                    }}
                  >
                    <IconPlus size={14} />
                    {label(p)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="stu-build-foot">
        <div className="stu-build-status" role="status">
          {status ? (
            <>
              <span className="stu-build-status-text">
                {status.watch ? `${status.text} ${status.sent ? "Sending the new version to your watch." : "Your watch has the older version."}` : status.text}
              </span>
              {status.undoAt !== undefined ? (
                <button
                  type="button"
                  className="linklike"
                  onClick={() => {
                    if (live.current) commit(undo(live.current.editor));
                    setStatus(null);
                  }}
                >
                  Undo
                </button>
              ) : null}
              {status.link ? (
                <Link className="linklike" to={status.link.to}>
                  {status.link.label}
                </Link>
              ) : null}
              {status.watch && !status.sent ? (
                <button type="button" className="btn btn-small" onClick={() => setSendingWatch(status.watch!)}>
                  Send the new version
                </button>
              ) : null}
              {status.notes ? (
                <ul className="stu-build-notes">
                  {status.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}
        </div>
        {stale ? (
          <p className="stu-build-stale" role="alert">
            This workout changed elsewhere.{" "}
            <button type="button" className="linklike" onClick={() => void reload()}>
              Reload
            </button>
          </p>
        ) : null}
        {frozenWhy ? <p className="stu-build-why">{frozenWhy}</p> : null}
        {flow.step === "refused" ? (
          <p className="stu-build-error" role="alert">
            {flow.text}
          </p>
        ) : null}
        {flow.step === "swaps" ? (
          <div className="stu-build-swaps" role="alert">
            {swapsShown.length ? (
              <>
                <p className="stu-build-why">Today's check changes this workout:</p>
                <ul>
                  {swapsShown.map((s) => (
                    <li key={s.path}>{`${find(s.from)?.name ?? s.from} → ${find(s.to)?.name ?? s.to}. ${s.reason}`}</li>
                  ))}
                </ul>
              </>
            ) : null}
            {flow.notes?.length ? (
              <ul className="stu-build-notes">
                {flow.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {flow.step === "notKept" ? (
          <p className="stu-build-error" role="alert">
            This session isn't being kept on this device. It plays while you're online, and a reload starts it again.
          </p>
        ) : null}
        {/* One voice per fact: the note above says what and offers its Fix; here, only that Start waits on it — the full
            reason is Start's description, for a screen reader on the button. Only where there is a Start: a workout
            that can't change, or one on another day, has nothing waiting to start (an empty one still says to add a
            move, which Schedule waits on too). */}
        {footWhy ? <p className="stu-build-why">{footWhy}</p> : null}
        {blocked && canStart ? (
          <span id={whyId} hidden>
            {blocked}
          </span>
        ) : null}
        <div className="stu-build-actions">
          {flow.step === "swaps" ? (
            <>
              <button type="button" className="btn btn-primary" onClick={() => void lock(flow.session)}>
                {swapsShown.length ? "Start with these changes" : "Start anyway"}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setFlow(IDLE);
                  setStatus({ text: "It stays on today's plan." });
                }}
              >
                Not now
              </button>
            </>
          ) : flow.step === "notKept" ? (
            <button type="button" className="btn btn-primary" onClick={() => navigate(`/session/${encodeURIComponent(flow.workoutId)}`)}>
              Continue
            </button>
          ) : (
            <>
              {canStart ? (
                <button
                  type="button"
                  className="btn btn-primary stu-build-start"
                  disabled={!!blocked || busy}
                  aria-describedby={blocked ? whyId : undefined}
                  onClick={() => void startNow(true)}
                >
                  {busy ? flow.what : "Start now"}
                </button>
              ) : null}
              {frozen ? null : isWorkout ? (
                <button type="button" className="btn" disabled={!dirty || saving || busy} onClick={() => void saveChanges()}>
                  {saving ? "Saving…" : "Save changes"}
                </button>
              ) : (
                <button type="button" className="btn" disabled={!judged.doc || busy} onClick={() => setScheduling(true)}>
                  Schedule…
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {editing && editingItem ? (
        <ItemSheet
          doc={doc}
          part={editing.part}
          item={editing.item}
          rec={editingItem.kind === "exercise" ? find(editingItem.libraryId) : undefined}
          notes={notesAt(editing.part, editing.item)}
          unit={unit}
          bc={bc}
          ctx={ctx}
          library={EXERCISES}
          onEdit={edit}
          onMoved={(to) => setEditing({ part: to[0], item: to[1] })}
          onRemove={() => removeItem(editing.part, editing.item)}
          onFix={(n) => onFix(n, "sheet")}
          onCheck={onCheck}
          checkLabel={checkLabel}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {menuPart !== null && doc.parts[menuPart] ? (
        <PartMenu
          part={doc.parts[menuPart]!}
          index={menuPart}
          count={doc.parts.length}
          onEdit={edit}
          onMoved={(to) => setMenuPart(to)}
          onRemove={() => removePart(menuPart)}
          onClose={() => setMenuPart(null)}
        />
      ) : null}
      {picking !== null && doc.parts[picking] ? (
        <MovePicker
          doc={doc}
          part={doc.parts[picking]!}
          suggestions={suggestions[picking]?.length ? suggestions[picking]! : suggestionsFor(doc, picking, sctx)}
          ctx={ctx}
          error={pickError}
          onPick={(rec, why) => {
            const r = addSuggested(picking, rec, why);
            if (r) setPickError(editRefusal({ type: "addItem", item: suggestedItem(rec, doc.parts[picking]!.purpose) }, r, doc));
            else setPicking(null);
          }}
          onClose={() => setPicking(null)}
        />
      ) : null}
      {goalsOpen ? <GoalsSheet doc={doc} onEdit={edit} onClose={() => setGoalsOpen(false)} /> : null}
      {scheduling ? (
        <ScheduleSheet
          today={today}
          later={laterToday(new Date(), settings.data?.prefs ?? null, today, judged.derived?.estimatedMinutes ?? 0)}
          usual={usualTime(settings.data?.prefs ?? null, today)}
          judgeFor={(d) => judgeDraft(doc, bc, d)}
          checkLabel={checkLabel}
          onCheck={onCheck}
          onSchedule={schedule}
          onClose={() => setScheduling(false)}
        />
      ) : null}
      {naming ? <NameSheet initial={doc.title} onSave={saveAsTemplate} onClose={() => setNaming(false)} /> : null}
      {asked ? (
        <ConditionCheckSheet condition={checkViewOf(asked)} onSaved={onCheckSaved} onClose={() => setAsking(null)} />
      ) : null}
      {sendingWatch ? (
        <WatchPreviewSheet
          workoutId={sendingWatch.workoutId}
          minutes={sendingWatch.minutes}
          onClose={() => setSendingWatch(null)}
          onSent={() => {
            const id = sendingWatch.workoutId;
            setSendingWatch(null);
            setStatus((cur) => (cur?.watch?.workoutId === id ? { ...cur, sent: true } : cur));
            // As the session sheet does after a Send: run the queued push, then read again what it changed.
            const written = () => {
              void qc.invalidateQueries({ queryKey: ["session", id] });
              refreshPlan();
            };
            written();
            void api
              .drainWatch()
              .catch(() => undefined)
              .finally(written);
          }}
          onStale={() => {
            setSendingWatch(null);
            void qc.invalidateQueries({ queryKey: ["session", sendingWatch.workoutId] });
          }}
          onRefused={() => {
            setSendingWatch(null);
            void qc.invalidateQueries({ queryKey: ["session", sendingWatch.workoutId] });
          }}
        />
      ) : null}
      <ConfirmDialog open={freshAsk} onClose={() => setFreshAsk(false)} title="Start a new workout?" confirmLabel="Start new" onConfirm={startOver}>
        {`“${doc.title}” will be cleared.`}
      </ConfirmDialog>
    </div>
  );
}

// ── The pieces ─────────────────────────────────────────────────────────────

function EffortPicker({
  value,
  onPick,
  disabled = false,
}: {
  value: WorkoutDoc["intent"]["effort"];
  onPick: (e: WorkoutDoc["intent"]["effort"]) => void;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className="stu-effort" disabled={disabled}>
      <legend className="stu-build-k">Effort</legend>
      <div className="stu-seg">
        {EFFORT_LEVELS.map((e) => (
          <label key={e} className="stu-seg-opt">
            <input type="radio" name={name} value={e} checked={value === e} onChange={() => onPick(e)} />
            <span>{label(e)}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const recsOf = (list: readonly Suggestion[]) =>
  list.flatMap((s) => {
    const rec = find(s.libraryId);
    return rec ? [{ rec, why: s.reason }] : [];
  });

/** A part's suggestions while it has no move: a row each — the name explains itself (its reason, one tap down), ＋ adds it. */
function SuggestionChips({ list, onAdd }: { list: readonly Suggestion[]; onAdd: (rec: ExerciseRecord, why: string) => void }) {
  const recs = recsOf(list);
  if (recs.length === 0) return null;
  return (
    <div className="stu-sugs">
      <span className="stu-sugs-k">Suggested</span>
      <ul className="stu-sug-list">
        {recs.map(({ rec, why }) => (
          <li key={rec.id} className="stu-sug">
            <Tooltip term={rec.name} tip={sentence(why)} />
            <button type="button" className="stu-sug-add" aria-label={`Add ${rec.name}`} onClick={() => onAdd(rec, why)}>
              <IconPlus size={16} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Once a part has a move, its suggestions fold to one line (the spec's mock: "Suggested: Hip airplane · Ankle rocks ＋"):
 * a list, each name its own item that explains itself (the dots between are drawn, not read), and ＋ — the part's one
 * Add a move — opens the picker, where they come first, each a tap to add.
 */
function SuggestionLine({ list, partName, onPick }: { list: readonly Suggestion[]; partName: string; onPick: () => void }) {
  const hid = useId();
  const recs = recsOf(list);
  if (recs.length === 0) return null;
  return (
    <div className="stu-sug-line">
      <span className="stu-sugs-k" id={hid}>
        Suggested:
      </span>
      <ul className="stu-sug-names" aria-labelledby={hid}>
        {recs.map(({ rec, why }, i) => (
          <li key={rec.id}>
            {i > 0 ? (
              <span className="stu-sep" aria-hidden="true">
                ·
              </span>
            ) : null}
            <Tooltip term={rec.name} tip={sentence(why)} />
          </li>
        ))}
      </ul>
      <button type="button" className="stu-sug-add" aria-label={`Add a move to ${partName}`} onClick={onPick}>
        <IconPlus size={16} />
      </button>
    </div>
  );
}

function PartBlock({
  index,
  part,
  minutes,
  suggestions,
  flagged,
  onItem,
  onMenu,
  onAdd,
  onPick,
  readOnly = false,
}: {
  index: number;
  part: WorkoutDoc["parts"][number];
  minutes: number;
  suggestions: readonly Suggestion[];
  flagged: (item: number) => boolean;
  onItem: (item: number) => void;
  onMenu: () => void;
  onAdd: (rec: ExerciseRecord, why: string) => void;
  onPick: () => void;
  /** A planned workout that can't change: its moves are shown, nothing offers to change them. */
  readOnly?: boolean;
}) {
  const hid = useId();
  const name = label(part.purpose);
  const tip = GLOSSARY[part.purpose];
  const meta = [formatLine(part), minutes ? `${minutes} min` : ""].filter(Boolean).join(" · ");
  const lined = part.items.length > 0 && recsOf(suggestions).length > 0;
  return (
    <section className="stu-part" data-part={index} aria-labelledby={hid}>
      <div className="stu-part-head">
        <h2 id={hid} className="stu-part-title">
          <span className="stu-part-name eyebrow">{tip ? <Tooltip term={name} tip={tip} /> : name}</span>
          {meta ? <span className="stu-part-meta">{meta}</span> : null}
        </h2>
        {readOnly ? null : (
          <button type="button" className="btn stu-icon-btn stu-part-menu" aria-label={`${name}: options`} onClick={onMenu}>
            <IconMore size={18} />
          </button>
        )}
      </div>
      {part.why ? <p className="stu-part-why">{part.why}</p> : null}
      {part.items.length ? (
        <ul className="stu-items">
          {part.items.map((it, i) => {
            const rec = it.kind === "exercise" ? find(it.libraryId) : undefined;
            const dose = it.kind === "exercise" || it.kind === "free_exercise" ? doseSummary(it.dose) : it.kind === "rest" ? `${it.seconds} s` : "";
            const cue = it.kind !== "rest" ? it.cue : undefined;
            const body = (
              <>
                <span className="stu-item-name">
                  {itemName(it, rec)}
                  {flagged(i) ? (
                    <span className="stu-item-flag">
                      <IconAlert size={14} />
                      <span className="visually-hidden">, needs a fix</span>
                    </span>
                  ) : null}
                </span>
                <span className="stu-item-dose">{dose}</span>
                {readOnly ? null : (
                  <span className="stu-item-chev" aria-hidden="true">
                    <IconChevron size={16} />
                  </span>
                )}
                {cue ? <span className="stu-item-cue">{cue}</span> : null}
              </>
            );
            return (
              <li key={i}>
                {readOnly ? (
                  <div className="stu-item stu-item--still">{body}</div>
                ) : (
                  <button type="button" className="stu-item" data-at={`${index}-${i}`} onClick={() => onItem(i)}>
                    {body}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {readOnly || suggestions.length === 0 ? null : part.items.length === 0 ? (
        <SuggestionChips list={suggestions} onAdd={onAdd} />
      ) : (
        <SuggestionLine list={suggestions} partName={name} onPick={onPick} />
      )}
      {/* One control per action: while the suggestions fold to one line, its ＋ is the part's Add a move. */}
      {readOnly || lined ? null : (
        <button type="button" className="linklike stu-add-move" onClick={onPick}>
          <IconPlus size={14} />
          Add a move
        </button>
      )}
    </section>
  );
}

/** A part the workout does not have yet, prompted: activation once a part loads a lift. */
function GhostPart({ list, onAdd, onDismiss }: { list: readonly Suggestion[]; onAdd: (rec: ExerciseRecord, why: string) => void; onDismiss: () => void }) {
  const hid = useId();
  const tip = GLOSSARY.activation;
  return (
    <section className="stu-part stu-part--ghost" aria-labelledby={hid}>
      <div className="stu-part-head">
        <h2 id={hid} className="stu-part-title">
          <span className="stu-part-name eyebrow">{tip ? <Tooltip term={label("activation")} tip={tip} /> : label("activation")}</span>
        </h2>
        <button type="button" className="btn stu-icon-btn" aria-label="No activation part" onClick={onDismiss}>
          <IconClose size={16} />
        </button>
      </div>
      <SuggestionChips list={list} onAdd={onAdd} />
    </section>
  );
}
