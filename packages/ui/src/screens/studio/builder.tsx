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
import { api, ApiError, type ConditionCheckDto, type DesignDraftResponse, type DocIssueDto, type SessionDto, type WorkoutDto } from "@rg/api-client";
import { addDays, EFFORT_LEVELS, GOAL_LABELS, type WorkoutDoc } from "@rg/domain";
import { EXERCISES, GLOSSARY, label, type CheckReading, type ExerciseRecord } from "@rg/exercise-library";
import {
  makeLibraryIndex,
  HISTORY_LIMIT,
  placementFor,
  redo,
  startEditing,
  suggestedItem,
  suggestForPart,
  tryEdit,
  undo,
  type EditAction,
  type EditorState,
  type Rejection,
  type SuggestCtx,
  type Suggestion,
} from "@rg/workout";
import { accountTodayGuess, ConfirmDialog, EmptyState, formatDayShort, formatTime, Spinner } from "../../components.js";
import { checkWord, ConditionCheckSheet } from "../../components/condition-check-sheet.js";
import { Tooltip } from "../../components/tooltip.js";
import { WatchPreviewSheet } from "../../components/watch-preview-sheet.js";
import { features } from "../../features.js";
import { IconAlert, IconBack, IconChevron, IconClose, IconInfo, IconMore, IconPlus, IconRedo, IconUndo } from "../../icons.js";
import { useStudioDraft } from "../../studio-drafts.js";
import { useWeightUnit } from "../../use-units.js";
import { freshDoc } from "./add-model.js";
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
  judgeDayOf,
  judgeDraft,
  laterToday,
  usualTime,
  partMinutes,
  placeChoices,
  placeOf,
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
import { PlaceMenu } from "./place-menu.js";
import { NameSheet, SaveMenu } from "./save-menu.js";
import { ScheduleSheet } from "./schedule-sheet.js";
import { DETAIL_PANE_MIN_PX, useMinWidth, useStudioReads } from "./screen.js";
import { SummaryCard } from "./summary-card.js";
import { builderBack, quickStartFor, type BuilderArrival } from "./templates-model.js";
import { IDLE, sameDocument, useBuildFlows, workoutDocQuery, type CheckAsked, type Flow, type KeptAnswer, type Loaded, type Status } from "./use-build-flows.js";

/** The readings this page recorded (or the session read gave): a Studio-only athlete's Today carries none. */
const readingsQuery = (today: string) => ["studio", "readings", today] as const;
/**
 * The planned workout this builder is on, read with its day and its state: a window either side of today wide enough
 * to find one done (or gone) a while ago, so it opens read-only and says why.
 */
const rowQuery = (today: string) => ["plan", "studio-row", today] as const;
const ROW_DAYS = 56;

/** A coach's draft still the athlete's to decide: its proposal open, the op neither approved nor declined. */
const draftIsOpen = (d: DesignDraftResponse): boolean =>
  (d.status === "pending" || d.status === "partially_approved") && (d.outcome === null || d.outcome.status === "refused");

/** The builder's routes (spec §2): `/studio/build/new`, `…/quick/:kind`, `…/template/:id`, `…/workout/:workoutId`. One instance across them. */
export function BuilderRoute() {
  const { pathname } = useLocation();
  const source = sourceOfPath(pathname);
  if (!source) return <Navigate to="/studio" replace />;
  return <Builder source={source} />;
}

/** Suggestions for one part; a malformed probe (a programming error) suggests nothing rather than breaking the page. */
function suggestionsFor(doc: WorkoutDoc, i: number, sctx: SuggestCtx): Suggestion[] {
  try {
    return suggestForPart(doc, i, EXERCISES, sctx);
  } catch {
    return [];
  }
}

const find = makeLibraryIndex(EXERCISES);

function Builder({ source }: { source: BuildSource }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  /** What the templates list asked of this visit (its Start, its Schedule…), and where its way back goes. */
  const arrived = location.state as BuilderArrival | null;
  const back = builderBack(arrived?.from);
  const { ctx, settled, profilesKnown } = useStudioReads();
  const unit = useWeightUnit();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, staleTime: 60_000 });
  // The account's timezone: "now" is read on its clock, as the server reads it (CUJ R14).
  const timeZone = settings.data?.prefs?.timezone ?? ctx.timeZone;
  // Today is the server's; with no Today read, the account's own date — never the device's (CUJ J34).
  const today = accountTodayGuess(ctx.today, timeZone);
  const wide = useMinWidth(DETAIL_PANE_MIN_PX);
  const drafts = useStudioDraft();
  const key = sourceKey(source);
  const tplId = source.kind === "template" ? source.id : null;
  const wid = source.kind === "workout" ? source.id : null;
  const templates = useQuery({ queryKey: TEMPLATES_QUERY, queryFn: api.templates, enabled: tplId !== null, staleTime: 30_000 });
  // The stored document: a planned workout's own, or the one "Do it again" copies.
  const docId = source.kind === "workout" || source.kind === "again" ? source.id : null;
  const stored = useQuery({ queryKey: workoutDocQuery(docId ?? ""), queryFn: () => api.workoutDoc(docId!), enabled: docId !== null, staleTime: 0 });
  // A coach's draft (Edit before approve, Stage 3): its document, where it goes, and how it stands.
  const draftAt = source.kind === "proposal" ? source : null;
  const draftQ = useQuery({
    queryKey: ["proposal-draft", draftAt?.id ?? "", draftAt?.opId ?? ""],
    queryFn: () => api.coachDesignDraft(draftAt!.id, draftAt!.opId),
    enabled: draftAt !== null,
    staleTime: 0,
  });
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
    if (source.kind === "template") return template?.doc ? { key, editor: startEditing(template.doc), baseline: template.doc, rev: null, row: null, base: template.updatedAt } : null;
    // A coach's draft, while it is the athlete's to decide: on the coach's day and time (none: the athlete's window).
    if (source.kind === "proposal") {
      const d = draftQ.data;
      return d && draftIsOpen(d) ? { key, editor: startEditing(d.doc), baseline: null, rev: null, row: { date: d.date, time: d.time ?? "" } } : null;
    }
    const r = stored.data;
    // Do it again: a copy, as a new workout — nothing saved yet, so nothing to be "changed since".
    if (source.kind === "again") return r?.doc ? { key, editor: startEditing(r.doc), baseline: null, rev: null, row: null } : null;
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
  }, [key, drafts.loaded, drafts.draft, template, stored.data, draftQ.data, made, setLoaded]);

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
      // an edit that says something of its own — "Removed …" — says it after this.) The watch's offer stays: the
      // saved version is still newer than the watch's copy, until it is sent or the workout is saved again.
      setFlow((f) => (f.step === "busy" || f.step === "notKept" ? f : IDLE));
      setStatus((s) => (s?.watch && !s.sent ? { text: "", watch: s.watch } : null));
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
  // Judged and suggested with at the place the document names (CUJ R8), else the default place.
  const placeId = doc?.setting?.placeId;
  const bc = useMemo(() => buildCtxOf(ctx, today, recorded, placeId), [ctx, today, recorded, placeId]);
  const here = placeOf(ctx, placeId);
  const plannedRow: WorkoutDto | undefined = wid ? planned.data?.workouts.find((w) => w.id === wid) : undefined;
  const row = ready?.row ?? (plannedRow ? { date: plannedRow.effectiveDate, time: plannedRow.effectiveTime } : null);
  const isWorkout = key.startsWith("workout:");
  // A coach's draft is judged for the day it is proposed for; saving a revision's approves it (Save changes).
  const isDraft = key.startsWith("proposal:");
  const draftRevises = isDraft && draftQ.data?.target.kind === "revise";
  const date = (isWorkout || isDraft) && row && row.date > today ? row.date : today;
  // A planned workout done with (its day passed, done, gone) is judged by the static rules alone: today's reading says
  // nothing of another day. One under way today keeps today's.
  const judgeOn = isWorkout ? judgeDayOf(plannedRow, today, date) : date;
  const judged = useMemo(() => (doc ? judgeDraft(doc, bc, judgeOn) : null), [doc, bc, judgeOn]);
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
  const [asking, setAsking] = useState<CheckAsked | null>(null);
  const [resume, setResume] = useState(false);
  const [sumOpen, setSumOpen] = useState<boolean | null>(null);
  const [ghostOff, setGhostOff] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [stale, setStale] = useState(false);
  const [saving, setSaving] = useState(false);
  const [flow, setFlow] = useState<Flow>({ step: "idle" });
  const [sendingWatch, setSendingWatch] = useState<{ workoutId: string; minutes: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // Start now turned into the offer to continue today's (I3): focus is on Continue it, never left on the page (N3).
  useEffect(() => {
    if (flow.step === "again") root.current?.querySelector<HTMLElement>(".stu-build-continue")?.focus();
  }, [flow.step]);
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
  /** Answers kept offline, not recorded (R11 fix round 1): sent as ordinary checks should Start go on online. */
  const keptOffline = useRef(new Map<string, KeptAnswer>());
  const onCheckSaved = (c: ConditionCheckDto, kept?: { offline: true }) => {
    const reading = { pre: c.value, post: null, feelingOff: c.feelingOff };
    qc.setQueryData<Record<string, CheckReading>>(readingsQuery(today), (old) => ({ ...(old ?? {}), [c.profileId]: reading }));
    // With its day (the account's, when it was answered): sent only while that is still today (fix round 2).
    if (kept) keptOffline.current.set(c.profileId, { ...reading, date: c.date });
    else keptOffline.current.delete(c.profileId);
    if (asking?.then === "start") setResume(true);
  };
  /** The server's readings for the day (a session read): kept, so this page judges with what the server knows. */
  const noteChecks = (s: SessionDto) => {
    const known = Object.fromEntries(Object.entries(s.checks ?? {}).map(([id, a]) => [id, { pre: a.pre, post: null, feelingOff: a.feelingOff } satisfies CheckReading]));
    if (Object.keys(known).length) qc.setQueryData<Record<string, CheckReading>>(readingsQuery(today), (old) => ({ ...(old ?? {}), ...known }));
  };

  const { dirtyOf, lock, startNow, skipCheck, continueToday, schedule, saveAsTemplate, saveTemplate, saveChanges, reload, startOver, startsHere, asNew, scheduleAsNew } = useBuildFlows({
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
    // The button that was pressed goes (Schedule… becomes Save changes; Save changes greys): focus to what happened.
    focusStatus: () => {
      focusNext.current = [".stu-build-status a", ".stu-build-status-text"];
    },
    timeZone,
    recorded,
    place: here,
    profilesKnown,
    keptOffline,
  });

  // ── Not ready ──
  if (!ready || !doc || !judged) {
    let problem: string | null = null;
    if (source.kind === "template") {
      if (templates.isError) problem = "Opening a template needs a connection the first time.";
      else if (templates.isSuccess) problem = template ? "This template can't be read." : "That template is gone.";
    } else if (source.kind === "again") {
      if (stored.isError) problem = stored.error instanceof ApiError && stored.error.status === 404 ? "That workout is gone." : "Opening it again needs a connection.";
      else if (stored.data && !stored.data.doc) problem = "This workout can't be opened in the Studio.";
    } else if (source.kind === "workout") {
      if (stored.isError) problem = stored.error instanceof ApiError && stored.error.status === 404 ? "That workout is gone." : "Opening a planned workout needs a connection.";
      else if (stored.data && !stored.data.doc) problem = "This workout can't be changed in the Studio.";
    } else if (source.kind === "quick" && made && "reason" in made) {
      // Condition care with the profiles never read (offline, or the read failed): "no profile is on" would be a guess.
      problem = source.quick === "condition_care" && !profilesKnown ? "Condition care needs a connection the first time." : made.reason;
    }
    // A coach's draft: gone, approved already (its workout one tap away), or decided otherwise.
    const d = draftQ.data;
    const madeOf = d?.outcome?.status === "applied" ? d.outcome.workoutId : null;
    if (source.kind === "proposal") {
      if (draftQ.isError) problem = draftQ.error instanceof ApiError && draftQ.error.status === 404 ? "That draft is gone." : "Opening a draft needs a connection.";
      else if (madeOf) problem = "This one is in your plan already.";
      else if (d && !draftIsOpen(d)) problem = "This draft is closed.";
    }
    return (
      <div className="stu-build">
        {problem ? (
          <EmptyState title={problem}>
            {madeOf ? (
              <Link className="btn btn-primary" to={`/studio/build/workout/${encodeURIComponent(madeOf)}`}>
                Open it
              </Link>
            ) : null}
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
  // No Start on a coach's draft: starting would make a workout the proposal never approved.
  const canStart = features.player && !isDraft && (!isWorkout || (row !== null && row.date === today)) && !frozen;
  const blocked = judged.blocked;
  const busy = flow.step === "busy";
  const open = sumOpen ?? wide;
  const notesAt = (p: number, i: number) => judged.notes.filter((n) => n.part === p && n.item === i);
  const showGhost = ghostAt !== null && ghost.length > 0 && !ghostOff && !frozen;
  // The parts on offer — activation not twice: while its prompt is shown, the prompt is where it is offered.
  const addable = addablePurposes(doc, ctx.profiles).filter((p) => !(showGhost && p === "activation"));
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
  /** The activation prompt, declined: it goes, its ✕ with it, so focus goes to the part it stood before (its ⋯), else the title. */
  const dismissGhost = () => {
    setGhostOff(true);
    focusNext.current = [`[data-part="${ghostAt}"] .stu-part-menu`, ".stu-build-title"];
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
  /** A quick start as it is made at a place (`placeId`: the default's when absent), carrying that place. */
  const quickAt = (placeId: string | undefined): WorkoutDoc | null => {
    if (!quick) return null;
    const made = quickStartFor(quick, { ...ctx, place: placeOf(ctx, placeId) }, today, recordedQ.data);
    if (!("doc" in made)) return null;
    return placeId === undefined ? made.doc : { ...made.doc, setting: { ...made.doc.setting, placeId } };
  };
  /**
   * The place chosen (CUJ R8). A quick start not edited since it was made is made again at the new place — its moves,
   * its doses — as if its tile had opened there (CUJ re-walk §2.3); edited, it stays as it is, and its notes say what
   * the place lacks. One edit either way: Undo is what was there.
   */
  const pickPlace = (placeId: string | undefined) => {
    const cur = live.current;
    if (cur && quick) {
      const asMade = quickAt(cur.editor.doc.setting?.placeId);
      const next = asMade && sameDocument(cur.editor.doc, asMade) ? quickAt(placeId) : null;
      if (next) {
        commit({ doc: startEditing(next).doc, past: [...cur.editor.past, cur.editor.doc].slice(-HISTORY_LIMIT), future: [] });
        return;
      }
    }
    say({ type: "setPlace", placeId });
  };
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
        isWorkout || source.kind === "quick" || source.kind === "again" || isDraft
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
            <Link className="btn stu-build-back" to={back.href}>
              <IconBack size={16} />
              {back.label}
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
          {/* Whose this is, while it is still the coach's to approve (fix wave 3B, B-I8). */}
          {isDraft && !asNew ? <p className="eyebrow stu-build-eyebrow">Coach's suggestion</p> : null}
          {(isWorkout || isDraft) && row ? (
            <p className="stu-build-when">{`${row.date === today ? "Today" : formatDayShort(row.date)}${row.time ? ` · ${formatTime(row.time)}` : ""}`}</p>
          ) : null}
          <h1 className="visually-hidden">{doc.title}</h1>
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
          {here ? (
            <PlaceMenu
              name={here.name}
              chosen={here.id}
              choices={placeChoices(ctx)}
              readOnly={frozen}
              onPick={pickPlace}
            />
          ) : null}
          <div className="stu-build-goals">
            <span className="stu-build-k">Goals</span>
            <span className="stu-build-goal-list">
              {/* Goals in plain words, the domain's one map (3B audit A-M2), as the goals sheet and the board say them. */}
              {[...doc.intent.goals.map((g) => GOAL_LABELS[g] ?? label(g)), ...doc.intent.focus.map((f) => label(f))].join(" · ")}
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
            place={here?.name ?? null}
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
          {!frozen && addable.length ? (
            <div className="stu-add-parts">
              <span className="stu-build-k">Add a part</span>
              <div className="stu-chipset">
                {addable.map((p) => (
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
        {/* Empty, it is visually hidden — never display: none — so the region stays in the page and is heard when it speaks. */}
        <div className={status ? "stu-build-status" : "stu-build-status visually-hidden"} role="status">
          {status ? (
            <>
              <span className="stu-build-status-text" tabIndex={-1}>
                {status.watch
                  ? [status.text, status.sent ? "Sending the new version to your watch." : "Your watch has the older version."].filter(Boolean).join(" ")
                  : status.text}
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
              {status.asNew ? (
                <button type="button" className="btn btn-small" onClick={scheduleAsNew}>
                  Schedule it as a new workout
                </button>
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
            {tplId ? "This template changed elsewhere." : "This workout changed elsewhere."}{" "}
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
        {flow.step === "again" ? (
          // Mounted with its words (it answers the tap on Start): an alert, so it is heard.
          <p className="stu-build-why" role="alert">
            {flow.workout.contentState === "started" ? "You've started this today already." : "Today already has this one."}
          </p>
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
          ) : flow.step === "again" ? (
            <>
              <button type="button" className="btn btn-primary stu-build-continue" onClick={() => void continueToday(flow.workout)}>
                Continue it
              </button>
              <button type="button" className="btn" onClick={() => setFlow(IDLE)}>
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
              {/* A coach's draft: saving it approves the athlete's version (fix wave 3B, B-I8) — said so. */}
              {frozen ? null : isWorkout || (draftRevises && !asNew) ? (
                <button type="button" className="btn" disabled={(!dirty && !isDraft) || saving || busy} onClick={() => void saveChanges()}>
                  {saving ? "Saving…" : isDraft ? "Approve my version" : "Save changes"}
                </button>
              ) : (
                <button type="button" className="btn" disabled={!judged.doc || busy} onClick={() => setScheduling(true)}>
                  {isDraft && !asNew ? "Approve my version…" : "Schedule…"}
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
          later={laterToday(new Date(), settings.data?.prefs ?? null, today, judged.derived?.estimatedMinutes ?? 0, timeZone)}
          usual={usualTime(settings.data?.prefs ?? null, today)}
          judgeFor={(d) => judgeDraft(doc, bc, d)}
          checkLabel={checkLabel}
          onCheck={onCheck}
          onSchedule={schedule}
          onClose={() => setScheduling(false)}
          timeZone={timeZone}
          initial={isDraft && row ? { date: row.date, time: row.time || null } : undefined}
          // A coach's draft: the sheet's confirm approves the athlete's version (the re-review).
          confirm={isDraft && !asNew ? { label: "Approve my version", busy: "Approving…" } : undefined}
        />
      ) : null}
      {naming ? <NameSheet initial={doc.title} onSave={saveAsTemplate} onClose={() => setNaming(false)} /> : null}
      {asked ? (
        <ConditionCheckSheet
          condition={checkViewOf(asked)}
          onSaved={onCheckSaved}
          onClose={() => setAsking(null)}
          onSkip={asking?.offered ? () => skipCheck(asked.id) : undefined}
          keepOffline={asking?.then === "start" && startsHere}
        />
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
 * a list, each name its own item that explains itself, told apart by its own outline — never by a "·", which a
 * library name can hold itself ("Active pigeon · back-leg lift") — and, its last chip, "＋ Add": the part's one Add a
 * move, which opens the picker, where they come first, each a tap to add.
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
        {recs.map(({ rec, why }) => (
          <li key={rec.id}>
            <Tooltip term={rec.name} tip={sentence(why)} className="tap-pad" />
          </li>
        ))}
        {/* The row's last chip, wrapping with the names: never a ＋ left alone on a line of its own. */}
        <li className="stu-sug-more">
          <button type="button" className="stu-sug-add stu-sug-add--chip" aria-label={`Add a move to ${partName}`} onClick={onPick}>
            <span className="stu-sug-chip" aria-hidden="true">
              <IconPlus size={14} />
              Add
            </span>
          </button>
        </li>
      </ul>
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
          <span className="stu-part-name eyebrow">{tip ? <Tooltip term={name} tip={tip} className="tap-pad" /> : name}</span>
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
                    readOnly ? (
                      <span className="stu-item-flag stu-item-flag--note">
                        <IconInfo size={14} />
                        <span className="visually-hidden">, has a note</span>
                      </span>
                    ) : (
                      <span className="stu-item-flag">
                        <IconAlert size={14} />
                        <span className="visually-hidden">, needs a fix</span>
                      </span>
                    )
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
