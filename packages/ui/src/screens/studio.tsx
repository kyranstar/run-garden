import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  ApiError,
  type StudioBridgeStatusDto,
  type StudioLlmStatusDto,
  type StudioPushRowDto,
  type StudioStateResponse,
} from "@rg/api-client";
import {
  addDays,
  isLocalDate,
  startOfIsoWeek,
  STUDIO_GOALS,
  type PlanBrief,
  type StudioGoal,
  type StudioSession,
} from "@rg/domain";
import { Banner, formatDayLong, formatDayShort, Sheet, Spinner } from "../components.js";
import { IconAlert, IconCheck, IconChevron, IconSync } from "../icons.js";

/**
 * Plan Studio — the Plan screen's collapsible lifting-plan authoring section.
 * Spec: docs/superpowers/specs/2026-08-03-plan-studio-design.md §6.
 *
 * Server truth drives the mode: no `plan` → intake form; a `plan` → the draft
 * grid with per-session push status. There is no separate client-side
 * "state machine" beyond that — `GET /api/studio` is the single source.
 */

// ── Small helpers ────────────────────────────────────────────────────────────

/** Browser-local calendar date, used only as a client-side pre-check (the
 * server is authoritative via the account's own timezone preference — see
 * `todayInZone` in apps/worker/src/routes/studio.ts). */
function localTodayGuess(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function defaultBrief(): PlanBrief {
  return {
    goal: "strength",
    durationWeeks: 8,
    sessionsPerWeek: 3,
    preferredDays: [1, 3, 5],
    sessionMinutes: 45,
    equipment: "",
    constraints: "",
    notes: "",
    startDate: localTodayGuess(),
  };
}

const GOAL_LABELS: Record<StudioGoal, string> = {
  strength: "Strength",
  hypertrophy: "Hypertrophy",
  general: "General fitness",
};

/** Mirrors `sessionStamp` in apps/worker/src/services/studio-push.ts exactly —
 * the push row's `sessionTitle` IS this stamp. On its own it is only HALF of
 * the server's real diff identity, though: a session whose weekday moves
 * (permitted by an edit request) keeps the same stamp but a different
 * `happenDay` — the server genuinely deletes-and-recreates it, so matching on
 * the stamp alone would silently read that as "unchanged." See
 * `diffIdentity` below, which folds the day back in to match
 * `planPush`'s `identity(happenDay, sessionTitle)` exactly. */
function sessionStamp(title: string, weekIndex: number): string {
  return `${title} — wk ${weekIndex + 1}`;
}

/** Mirrors studio-push.ts's `identity(happenDay, sessionTitle)` byte-for-byte
 * (a single space joins them — `happenDay`'s fixed `YYYY-MM-DD` width is what
 * keeps that unambiguous there, and the same reasoning applies here). This
 * pair, not the stamp alone, is the real client-computable proxy for the
 * server's diff key — used only for the honest new/removed counts below. */
function diffIdentity(happenDay: string, sessionTitle: string): string {
  return `${happenDay} ${sessionTitle}`;
}

const ISO_DAYS: { n: number; label: string }[] = [
  { n: 1, label: "Mon" },
  { n: 2, label: "Tue" },
  { n: 3, label: "Wed" },
  { n: 4, label: "Thu" },
  { n: 5, label: "Fri" },
  { n: 6, label: "Sat" },
  { n: 7, label: "Sun" },
];

/** Mirrors planBriefSchema's own ranges (packages/domain/src/studio.ts) —
 * client-side so bad input never round-trips to the worker just to bounce. */
function validateBrief(brief: PlanBrief): string[] {
  const errs: string[] = [];
  if (!Number.isInteger(brief.durationWeeks) || brief.durationWeeks < 2 || brief.durationWeeks > 16) {
    errs.push("Duration must be 2–16 weeks.");
  }
  // Sessions per week is derived from the day picker — one source of truth.
  if (brief.preferredDays.length < 1 || brief.preferredDays.length > 6) {
    errs.push("Pick 1–6 training days.");
  }
  if (brief.preferredDays.length !== brief.sessionsPerWeek) {
    // Unreachable through the UI (toggleDay keeps them in lockstep); kept so
    // a template brief from an older plan can never sneak through skewed.
    errs.push("Training days and sessions per week fell out of sync — re-pick your days.");
  }
  if (!Number.isInteger(brief.sessionMinutes) || brief.sessionMinutes < 20 || brief.sessionMinutes > 120) {
    errs.push("Session length must be 20–120 minutes.");
  }
  if (!isLocalDate(brief.startDate)) {
    errs.push("Pick a valid start date.");
  } else if (brief.startDate < localTodayGuess()) {
    errs.push("Start date can't be in the past.");
  }
  return errs;
}

/**
 * Structured reason codes only (never raw model output) — mirrors the
 * worker's own binding carry-forward (i). `budget_cutoff`, `output_truncated`
 * and `catalog_not_synced` get the exact copy the launch requirements call
 * for; everything else gets an honest, generic fallback.
 */
function studioErrorCopy(err: unknown, llm: StudioLlmStatusDto): string {
  if (!(err instanceof ApiError)) return "Something went wrong — try again.";
  const code = (err.body as { error?: string } | null)?.error;
  switch (code) {
    case "budget_cutoff":
      return `Weekly AI budget reached ($${llm.spentDollars.toFixed(2)} of $${llm.cutoffDollars.toFixed(0)}) — generation is paused until the rolling week clears.`;
    case "output_truncated":
      return "The plan was too large to generate — try fewer weeks or sessions per week.";
    case "catalog_not_synced": {
      const reason = (err.body as { reason?: string } | null)?.reason;
      if (reason === "syncing") {
        return "The exercise catalog is syncing from COROS — try again in a minute.";
      }
      return "Connect COROS in Settings so the exercise catalog can sync, then try again.";
    }
    case "invalid_output":
      return "The AI produced an invalid plan — try again, or adjust your request.";
    case "no_api_key":
      return "AI generation isn't configured on this server yet.";
    case "start_date_in_past":
      return "Pick a start date that's today or later.";
    case "no_plan":
      return "No plan to edit yet — generate one first.";
    case "unknown_exercise":
      return "The AI referenced an exercise outside the synced catalog — try again.";
    case "invalid_ops":
      return "That edit couldn't be applied — try rephrasing it.";
    case "invalid_request":
    case "invalid_json":
      return "That request wasn't valid — check the form and try again.";
    default:
      return code ? `Request failed (${code}).` : "Request failed — try again.";
  }
}

// ── Bridge status (two distinct signals — launch requirement c) ─────────────

function BridgeStatusLine({ bridge }: { bridge: StudioBridgeStatusDto }) {
  // Attention is earned: while something is actively pushing, the syncing
  // phase card already says so — this line only speaks when the user must
  // actually DO something (no executor at all, with work waiting). `online`
  // covers both executors: the COROS cloud connection and a live Mac.
  if (bridge.pendingJobs.queued > 0 && !bridge.online) {
    return (
      <Banner kind="warn">
        {bridge.pendingJobs.queued} change{bridge.pendingJobs.queued === 1 ? "" : "s"} waiting to
        sync — connect COROS in Settings so they push from the cloud.
      </Banner>
    );
  }
  if (bridge.inFlight.count > 0) {
    const ageMs = bridge.inFlight.oldestClaimedAt ? Date.now() - Date.parse(bridge.inFlight.oldestClaimedAt) : 0;
    const stuck = ageMs > 10 * 60_000;
    return (
      <Banner kind={stuck ? "warn" : "info"}>
        {stuck
          ? "This is taking longer than usual — the push may be stuck; it retries on its own."
          : "Pushing to COROS…"}
      </Banner>
    );
  }
  return null;
}

// ── Usage meter ──────────────────────────────────────────────────────────────

function UsageMeter({ llm }: { llm: StudioLlmStatusDto }) {
  const pct = llm.cutoffDollars > 0 ? Math.min(100, (llm.spentDollars / llm.cutoffDollars) * 100) : 0;
  const cls = llm.cutoff ? "cutoff" : llm.warn ? "warn" : "";
  return (
    <div className="usage-meter">
      <div className="row-between">
        <span className="faint">AI spend this week</span>
        <span className="faint">
          ${llm.spentDollars.toFixed(2)} / ${llm.cutoffDollars.toFixed(0)}
        </span>
      </div>
      <div className="usage-meter-track">
        <div className={`usage-meter-fill ${cls}`} style={{ width: `${pct}%` }} />
      </div>
      {llm.cutoff ? (
        <p className="faint" style={{ marginTop: "0.25rem" }}>
          Paused until the rolling week clears — generation and edits are blocked.
        </p>
      ) : llm.warn ? (
        <p className="faint" style={{ marginTop: "0.25rem" }}>
          Approaching the weekly AI budget.
        </p>
      ) : null}
    </div>
  );
}

// ── Intake form (empty state, and "start a new plan" from the draft) ───────

function IntakeForm({
  initial,
  hasCurrentPlan,
  llm,
  onCancel,
  onDone,
}: {
  initial: PlanBrief | null;
  hasCurrentPlan: boolean;
  llm: StudioLlmStatusDto;
  onCancel?: () => void;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  // A template, not a resume: the old plan's startDate has usually already
  // elapsed, so it's never carried forward into a fresh intake.
  const [brief, setBrief] = useState<PlanBrief>(() =>
    initial ? { ...initial, startDate: localTodayGuess() } : defaultBrief(),
  );
  const [errors, setErrors] = useState<string[]>([]);
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);

  const generate = useMutation({
    mutationFn: (opts: { replace?: boolean }) => api.studioGenerate(brief, opts),
    onSuccess: () => {
      setConfirmReplace(false);
      void qc.invalidateQueries({ queryKey: ["studio"] });
      onDone();
    },
    onError: (err: unknown) => {
      // Launch requirement d: a 409 here means the CURRENT plan still has
      // live COROS sessions — surface a confirmation naming the consequence
      // rather than either silently blocking or silently clobbering.
      if (err instanceof ApiError && (err.body as { error?: string } | null)?.error === "plan_has_live_pushes") {
        setConfirmReplace(true);
        return;
      }
      setConfirmReplace(false);
      setServerError(studioErrorCopy(err, llm));
    },
  });

  const submit = () => {
    const errs = validateBrief(brief);
    setErrors(errs);
    setServerError(null);
    if (errs.length > 0) return;
    generate.mutate({});
  };

  const toggleDay = (n: number) => {
    setBrief((b) => {
      const preferredDays = b.preferredDays.includes(n)
        ? b.preferredDays.filter((d) => d !== n)
        : [...b.preferredDays, n].sort((a, c) => a - c);
      // Sessions per week IS the number of days you train — one source of
      // truth, derived from the picker instead of a redundant second input.
      return { ...b, preferredDays, sessionsPerWeek: preferredDays.length };
    });
  };

  return (
    <div className="stack">
      {hasCurrentPlan ? (
        <p className="muted">
          Starting a new plan doesn't touch your current one until this generates — you'll confirm
          before anything on COROS changes.
        </p>
      ) : (
        <p className="muted">A short intake, then a strong model drafts the whole plan for you to review.</p>
      )}

      <div className="field">
        <label htmlFor="studio-goal">Goal</label>
        <select
          id="studio-goal"
          value={brief.goal}
          onChange={(e) => setBrief((b) => ({ ...b, goal: e.target.value as StudioGoal }))}
        >
          {STUDIO_GOALS.map((g) => (
            <option key={g} value={g}>
              {GOAL_LABELS[g]}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="studio-weeks">Duration (weeks)</label>
        <input
          id="studio-weeks"
          type="number"
          min={2}
          max={16}
          value={brief.durationWeeks}
          onChange={(e) => setBrief((b) => ({ ...b, durationWeeks: Number(e.target.value) }))}
        />
        <span className="hint">2–16 weeks</span>
      </div>


      <div className="field">
        <label>Training days</label>
        <div className="day-picker">
          {ISO_DAYS.map((d) => (
            <button
              type="button"
              key={d.n}
              className={`day-chip ${brief.preferredDays.includes(d.n) ? "active" : ""}`}
              onClick={() => toggleDay(d.n)}
            >
              {d.label}
            </button>
          ))}
        </div>
        <span className="hint">
          {brief.preferredDays.length === 0
            ? "Pick the days you'll train (1–6)"
            : `${brief.preferredDays.length} session${brief.preferredDays.length === 1 ? "" : "s"} per week`}
        </span>
      </div>

      <div className="field">
        <label htmlFor="studio-minutes">Session length (minutes)</label>
        <input
          id="studio-minutes"
          type="number"
          min={20}
          max={120}
          step={5}
          value={brief.sessionMinutes}
          onChange={(e) => setBrief((b) => ({ ...b, sessionMinutes: Number(e.target.value) }))}
        />
        <span className="hint">20–120 minutes</span>
      </div>

      <div className="field">
        <label htmlFor="studio-equipment">Equipment</label>
        <input
          id="studio-equipment"
          type="text"
          value={brief.equipment}
          placeholder="e.g. full gym, dumbbells + bench"
          onChange={(e) => setBrief((b) => ({ ...b, equipment: e.target.value }))}
        />
      </div>

      <div className="field">
        <label htmlFor="studio-constraints">Constraints</label>
        <input
          id="studio-constraints"
          type="text"
          value={brief.constraints}
          placeholder="e.g. bad left knee, no overhead pressing"
          onChange={(e) => setBrief((b) => ({ ...b, constraints: e.target.value }))}
        />
      </div>

      <div className="field">
        <label htmlFor="studio-notes">Notes</label>
        <textarea
          id="studio-notes"
          rows={2}
          value={brief.notes}
          placeholder="Anything else the plan should account for"
          onChange={(e) => setBrief((b) => ({ ...b, notes: e.target.value }))}
        />
      </div>

      <div className="field">
        <label htmlFor="studio-start">Start date</label>
        <input
          id="studio-start"
          type="date"
          min={localTodayGuess()}
          value={brief.startDate}
          onChange={(e) => setBrief((b) => ({ ...b, startDate: e.target.value }))}
        />
        <span className="hint">Plans start on the Monday of the chosen week.</span>
      </div>

      {errors.length > 0 ? <Banner kind="warn">{errors[0]}</Banner> : null}
      {serverError ? <Banner kind="warn">{serverError}</Banner> : null}

      {generate.isPending ? (
        <GenerationProgress />
      ) : (
        <div className="btn-row">
          <button className="btn btn-studio" onClick={submit}>
            {hasCurrentPlan ? "Generate new plan" : "Create plan"}
          </button>
          {onCancel ? (
            <button className="btn" onClick={onCancel}>
              Cancel
            </button>
          ) : null}
        </div>
      )}

      {confirmReplace ? (
        <Sheet open onClose={() => setConfirmReplace(false)} title="Replace your current plan?">
          <div className="stack">
            <p>
              Your current plan's workouts will be removed from COROS, then the new plan is created.
              Push again after the deletes finish if any titles collide.
            </p>
            <div className="btn-row">
              <button
                className="btn btn-studio"
                disabled={generate.isPending}
                onClick={() => generate.mutate({ replace: true })}
              >
                {generate.isPending ? "Replacing…" : "Replace plan"}
              </button>
              <button className="btn" onClick={() => setConfirmReplace(false)} disabled={generate.isPending}>
                Cancel
              </button>
            </div>
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}

// ── Per-session push status (launch requirements b, e) ──────────────────────

function PushRowStatus({
  row,
  onRetry,
  retrying,
  onUndo,
  undoing,
  undoError,
}: {
  row: StudioPushRowDto | null;
  onRetry: (happenDay: string) => void;
  retrying: boolean;
  onUndo: (pushId: string) => void;
  undoing: boolean;
  undoError: string | null;
}) {
  if (!row) return null; // never pushed — the diff strip already counts it as "new"

  if (row.status === "verified") {
    return (
      <span className="pill pill-ok">
        <IconCheck /> On COROS
      </span>
    );
  }
  if (row.status === "pending") {
    return (
      <span className="pill pill-progress">
        <IconSync /> Pending push
      </span>
    );
  }
  if (row.status === "deleted") {
    return <span className="pill pill-neutral">Removed from COROS</span>;
  }
  if (row.status === "adopted") {
    // A genuine external edit/move/removal on COROS (sync-transparency Task
    // 7/12) — a fact, not a failure, so no red pill and no retry: the studio
    // just stepped back from managing this session until undone. Undo
    // forwards to `POST /api/studio/adoption/:pushId/undo`; a 409
    // (`undo_unsupported_rename`) means the session's stamp is gone on
    // COROS too, so there's nothing here that can prove a delete is ours —
    // the fix is deleting it on COROS, not retrying here.
    return (
      <div className="stack" style={{ gap: "0.3rem" }}>
        <span className="pill pill-neutral">Edited on COROS</span>
        <button className="btn btn-small" disabled={undoing} onClick={() => onUndo(row.id)}>
          {undoing ? "Undoing…" : "Undo"}
        </button>
        {undoError ? <span className="faint">{undoError}</span> : null}
      </div>
    );
  }

  // status === "failed" from here down.
  // The trimmed DTO only exposes `corosHappenDay`, not the raw COROS address
  // fields — that's the one signal available to distinguish "still really on
  // the calendar somewhere" from "never made it" for a failed row.
  const stillOnCalendar = Boolean(row.corosHappenDay);
  return (
    <div className="stack" style={{ gap: "0.3rem" }}>
      <span className="pill pill-danger" title={row.error ?? undefined}>
        <IconAlert /> {stillOnCalendar ? "Failed — still on calendar" : "Failed — not on calendar"}
      </span>
      {stillOnCalendar ? <span className="faint">COROS shows it on {formatDayShort(row.corosHappenDay!)}.</span> : null}
      <button className="btn btn-small" disabled={retrying} onClick={() => onRetry(row.happenDay)}>
        {retrying ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}

function SessionCard({
  session,
  happenDay,
  row,
  onRetry,
  retrying,
  onUndo,
  undoing,
  undoError,
}: {
  session: StudioSession;
  happenDay: string;
  row: StudioPushRowDto | null;
  onRetry: (happenDay: string) => void;
  retrying: boolean;
  onUndo: (pushId: string) => void;
  undoing: boolean;
  undoError: string | null;
}) {
  return (
    <div className="studio-session">
      <div className="studio-session-head">
        <span className="studio-session-title">{session.title}</span>
        {/* Launch requirement a: the actual computed date on every card —
            happenDay = ISO-Monday(startDate) + week*7 + (weekday-1), the
            same formula the worker uses, so week-0/past-day surprises are
            impossible. */}
        <span className="studio-session-date">{formatDayShort(happenDay)}</span>
      </div>
      <ul className="studio-exercise-list">
        {session.exercises.map((ex, i) => (
          <li key={i}>
            {ex.name} — {ex.sets}×{ex.reps} @ {ex.weight.type === "bodyweight" ? "bodyweight" : `${ex.weight.value} kg`}
            {ex.note ? ` (${ex.note})` : ""}
          </li>
        ))}
      </ul>
      <div className="studio-session-status">
        <PushRowStatus
          row={row}
          onRetry={onRetry}
          retrying={retrying}
          onUndo={onUndo}
          undoing={undoing}
          undoError={undoError}
        />
      </div>
    </div>
  );
}

// ── Generation progress ──────────────────────────────────────────────────────

/**
 * Honest, staged feedback while the strong model writes the plan. The stages
 * are keyed to elapsed time (the server doesn't stream progress), and the
 * copy never claims more than we know: a big plan genuinely takes minutes.
 */
function GenerationProgress() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  const stage =
    elapsed < 8
      ? "Reading your brief and recent training…"
      : elapsed < 45
        ? "Writing every session — warmups, progressions, cooldowns…"
        : elapsed < 120
          ? "Still writing — a full plan is a lot of sessions…"
          : "Long plans can take a few minutes. Leave this open; it will finish.";
  const mm = Math.floor(elapsed / 60);
  const ss = String(elapsed % 60).padStart(2, "0");
  return (
    <div className="studio-progress" role="status">
      <Spinner label="" />
      <div>
        <div style={{ fontWeight: 600 }}>Drafting your plan</div>
        <p className="muted">{stage}</p>
        <p className="faint">
          {mm}:{ss} elapsed · usually 1–3 minutes
        </p>
      </div>
    </div>
  );
}

// ── Lifecycle phases ─────────────────────────────────────────────────────────

type StudioPhase = "draft" | "syncing" | "attention" | "synced" | "over";

/** Which single thing deserves the user's attention right now. */
function studioPhase(studio: StudioStateResponse, today: string): StudioPhase {
  const rows = studio.pushes.filter((p) => p.status !== "deleted");
  // changed_on_coros is "you edited it on the watch, we stepped back" — a
  // fact, not a failure; counting it as attention pinned a permanent warning
  // with a retry that is a documented no-op.
  const failed = rows.filter(
    (p) => (p.status === "failed" || p.error != null) && p.error !== "changed_on_coros",
  );
  const verified = rows.filter((p) => p.status === "verified");
  const inFlight = studio.bridge.pendingJobs.queued + studio.bridge.inFlight.count;
  // "Syncing" is only true while a live executor (COROS cloud connection or
  // a Mac) is moving work. With nothing online, jobs just wait — the banner
  // says what to do, and the normal draft/synced view stays usable.
  if (inFlight > 0 && studio.bridge.online) return "syncing";
  if (failed.length > 0) return "attention";
  if (verified.length === 0) return "draft";
  const brief = studio.brief!;
  const end = addDays(startOfIsoWeek(brief.startDate), brief.durationWeeks * 7 - 1);
  if (today > end) return "over";
  return "synced";
}

/** Past plans + the briefs that produced them — reusable as templates. */
function PastPlans({ onUseTemplate }: { onUseTemplate: (brief: PlanBrief) => void }) {
  const [open, setOpen] = useState(false);
  const history = useQuery({ queryKey: ["studio-history"], queryFn: api.studioHistory, enabled: open });
  return (
    <details onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="muted" style={{ cursor: "pointer" }}>
        Past plans
      </summary>
      {history.isLoading ? (
        <Spinner label="Loading history" />
      ) : (history.data?.plans ?? []).length === 0 ? (
        <p className="faint">Nothing yet — every plan you generate is kept here.</p>
      ) : (
        <ul className="studio-history">
          {history.data!.plans.map((p) => (
            <li key={p.id} className="row-between">
              <span>
                <strong>{p.name}</strong>{" "}
                <span className="faint">
                  {p.weeks ? `${p.weeks} wks` : ""} · {p.createdAt.slice(0, 10)}
                </span>
              </span>
              <button className="btn btn-small" onClick={() => onUseTemplate(p.brief)}>
                Reuse brief
              </button>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

// ── Draft view (plan exists) ─────────────────────────────────────────────────

function StudioDraft({
  studio,
  onStartNew,
  onUseTemplate,
}: {
  studio: StudioStateResponse;
  onStartNew: () => void;
  onUseTemplate: (brief: PlanBrief) => void;
}) {
  const qc = useQueryClient();
  const plan = studio.plan!;
  const brief = studio.brief!;
  const version = studio.version!;

  const [request, setRequest] = useState("");
  const [major, setMajor] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [pushError, setPushError] = useState<string | null>(null);

  const monday = useMemo(() => startOfIsoWeek(brief.startDate), [brief.startDate]);
  const pushByDay = useMemo(
    // Deleted rows out: a re-created session on the same day must show its
    // live status, not a stale "Removed from COROS" from a prior version.
    () => new Map(studio.pushes.filter((p) => p.status !== "deleted").map((p) => [p.happenDay, p])),
    [studio.pushes],
  );

  const sessionsByWeek = useMemo(
    () =>
      plan.weeks.map((week, weekIndex) => ({
        weekIndex,
        sessions: week.sessions
          .map((session) => ({
            session,
            happenDay: addDays(monday, weekIndex * 7 + (session.weekday - 1)),
            stamp: sessionStamp(session.title, weekIndex),
          }))
          .sort((a, b) => a.happenDay.localeCompare(b.happenDay)),
      })),
    [plan, monday],
  );

  /**
   * Honest-counts rationale (fix round 1, Medium; corrected in fix round 2
   * after re-review). The trimmed `StudioPushRowDto` has no
   * `sessionFingerprint`, so per-session CONTENT changes genuinely can't be
   * detected client-side — only the server's real diff (`planPush` in
   * studio-push.ts) can say which sessions actually changed. Round 1
   * approximated "changed" from a plan-wide "has the version moved since
   * last push?" boolean, which was flatly wrong: editing ONE session made
   * EVERY pushed session read as "changed."
   *
   * Round 1's fix then keyed new/removed on `sessionStamp` (title+week)
   * ALONE, which turned out to be the same false-precision bug moved one
   * level down: a session whose WEEKDAY moves (an edit request is explicitly
   * allowed to do this) keeps the same stamp but a different `happenDay`.
   * The server's real diff identity is the FULL pair
   * (`planPush`'s `identity(happenDay, sessionTitle)`), so a moved-weekday
   * session is a genuine delete-then-recreate on COROS — stamp-only matching
   * read it as untouched instead. Fixed by keying on `diffIdentity(happenDay,
   * stamp)` on both sides, matching the server's key exactly:
   *  - "new": draft sessions whose (day, stamp) key has no live pushed row
   *    (none at all, the existing one is `deleted`, or it exists only under
   *    a DIFFERENT day — a weekday move counts here, correctly, since the
   *    server really does re-create it).
   *  - "removed": pushed rows whose (day, stamp) key no longer appears in
   *    the draft — excluding rows already `deleted`, AND excluding
   *    `changed_on_coros` rows, which `planPush`'s own `untouchable` set
   *    reports as `blocked`, not removed.
   *  - Note: a `startDate` change shifts every draft session's `happenDay`
   *    at once, so it will legitimately show as "all new + all removed" —
   *    that's correct, not a bug: the server re-diffs the whole plan against
   *    the new day grid too, and would genuinely delete-and-recreate
   *    everything.
   *  - the murky middle — a session unchanged in day+stamp, whose CONTENT
   *    may have changed — still gets a qualitative flag, not a count:
   *    `editedSincePush`, true whenever the plan's version has moved past
   *    the version last pushed. Its copy says the exact per-session diff is
   *    computed at push time, rather than implying a number this component
   *    cannot honestly produce.
   */
  const diff = useMemo(() => {
    const draftKeys = new Set<string>();
    const pushedByKey = new Map(studio.pushes.map((p) => [diffIdentity(p.happenDay, p.sessionTitle), p]));
    let added = 0;
    for (const wk of sessionsByWeek) {
      for (const { happenDay, stamp } of wk.sessions) {
        const key = diffIdentity(happenDay, stamp);
        draftKeys.add(key);
        const row = pushedByKey.get(key);
        if (!row || row.status === "deleted") added++;
      }
    }
    let removed = 0;
    for (const row of studio.pushes) {
      if (row.status === "deleted") continue;
      if (row.error === "changed_on_coros") continue;
      if (!draftKeys.has(diffIdentity(row.happenDay, row.sessionTitle))) removed++;
    }
    const editedSincePush = studio.lastPushSummary != null && version !== studio.lastPushSummary.planVersion;
    return { added, removed, editedSincePush };
  }, [sessionsByWeek, studio.pushes, studio.lastPushSummary, version]);

  const edit = useMutation({
    mutationFn: () => api.studioEdit(request, major),
    onSuccess: () => {
      setRequest("");
      setEditError(null);
      void qc.invalidateQueries({ queryKey: ["studio"] });
    },
    onError: (err: unknown) => setEditError(studioErrorCopy(err, studio.llm)),
  });

  const push = useMutation({
    mutationFn: () => api.studioPush(),
    onSuccess: () => {
      setPushError(null);
      void qc.invalidateQueries({ queryKey: ["studio"] });
    },
    onError: (err: unknown) => setPushError(studioErrorCopy(err, studio.llm)),
  });

  // `push/retry` re-invokes the whole-plan push (worker's binding
  // carry-forward e — not a row-scoped retry), so sharing one mutation across
  // every "Retry" button and disabling all of them while any is in flight is
  // correct, not just simplest: a second concurrent click really would just
  // be another whole-plan push.
  const retry = useMutation({
    mutationFn: (happenDay: string) => api.studioPushRetry(happenDay),
    onSuccess: () => {
      setPushError(null);
      void qc.invalidateQueries({ queryKey: ["studio"] });
    },
    onError: (err: unknown) => setPushError(studioErrorCopy(err, studio.llm)),
  });

  // Per-row undo for `adopted` sessions (sync-transparency Task 12) — a
  // separate mutation from `retry` (different endpoint, different row
  // states), one shared instance across every row like `retry` already is:
  // only one undo can plausibly be in flight from a user's own clicking.
  const [undoErrors, setUndoErrors] = useState<Record<string, string>>({});
  const undoAdoption = useMutation({
    mutationFn: (pushId: string) => api.studioUndoAdoption(pushId),
    onSuccess: (_data, pushId) => {
      setUndoErrors((e) => {
        if (!(pushId in e)) return e;
        const next = { ...e };
        delete next[pushId];
        return next;
      });
      setPushError(null);
      void qc.invalidateQueries({ queryKey: ["studio"] });
    },
    onError: (err: unknown, pushId: string) => {
      const code = err instanceof ApiError ? (err.body as { error?: string } | null)?.error : undefined;
      setUndoErrors((e) => ({
        ...e,
        [pushId]:
          code === "undo_unsupported_rename"
            ? "Renamed on COROS — delete it there to re-push."
            : "Couldn't undo — try again.",
      }));
    },
  });

  const today = localTodayGuess();
  const phase = studioPhase(studio, today);
  const liveRows = studio.pushes.filter((p) => p.status !== "deleted");
  const verifiedCount = liveRows.filter((p) => p.status === "verified").length;
  const failedRows = liveRows.filter(
    (p) => (p.status === "failed" || p.error != null) && p.error !== "changed_on_coros",
  );
  const totalSessions = sessionsByWeek.reduce((n, wk) => n + wk.sessions.length, 0);
  const dirty = diff.added > 0 || diff.removed > 0 || diff.editedSincePush;
  const planEnd = addDays(monday, brief.durationWeeks * 7 - 1);
  // The session-by-session grid earns its place only while there's something
  // to review or repair. Once the plan is synced, the calendar below IS the
  // plan — repeating it here is noise.
  const showGrid = phase === "draft" || phase === "attention" || (phase === "synced" && dirty);

  return (
    <div className="stack">
      <div className="row-between">
        <div>
          <div style={{ fontWeight: 650 }}>{plan.name}</div>
          <p className="faint">
            {brief.durationWeeks} weeks · {brief.sessionsPerWeek}×/week · through {formatDayLong(planEnd)}
          </p>
        </div>
        <button className="btn btn-small" onClick={onStartNew}>
          New plan
        </button>
      </div>

      {phase === "syncing" ? (
        <div className="studio-progress" role="status">
          <Spinner label="" />
          <div>
            <div style={{ fontWeight: 600 }}>
              Syncing to COROS — {verifiedCount} of {liveRows.length || totalSessions} sessions on the calendar
            </div>
            <p className="muted">
              Each session is being written to COROS and verified. You can close this page — it
              finishes on its own.
            </p>
          </div>
        </div>
      ) : null}

      {phase === "attention" ? (
        <Banner kind="warn">
          {failedRows.length} session{failedRows.length === 1 ? "" : "s"} didn't reach COROS. Retry
          below — everything else is synced.
        </Banner>
      ) : null}

      {phase === "synced" && !dirty ? (
        <div className="studio-synced-card">
          <span className="studio-synced-check" aria-hidden>
            ✓
          </span>
          <div>
            <div style={{ fontWeight: 600 }}>
              On COROS — {verifiedCount} sessions through {formatDayLong(planEnd)}
            </div>
            <p className="faint">
              Your sessions live in the calendar below. Ask for changes here any time; they sync
              back to COROS when you confirm.
            </p>
          </div>
        </div>
      ) : null}

      {phase === "over" ? (
        <Banner kind="info">
          This plan finished {formatDayLong(planEnd)} — nice work. Start the next one whenever
          you're ready; your past plans and briefs are saved below.
        </Banner>
      ) : null}

      {showGrid
        ? sessionsByWeek.map((wk) => (
            <div key={wk.weekIndex}>
              <div className="studio-week-label">Week {wk.weekIndex + 1}</div>
              {wk.sessions.length === 0 ? (
                <p className="muted">No sessions this week.</p>
              ) : (
                wk.sessions.map(({ session, happenDay }, i) => {
                  const row = pushByDay.get(happenDay) ?? null;
                  return (
                    <SessionCard
                      key={`${wk.weekIndex}-${i}`}
                      session={session}
                      happenDay={happenDay}
                      row={row}
                      onRetry={(d) => retry.mutate(d)}
                      retrying={retry.isPending}
                      onUndo={(id) => undoAdoption.mutate(id)}
                      undoing={undoAdoption.isPending && undoAdoption.variables === row?.id}
                      undoError={row ? (undoErrors[row.id] ?? null) : null}
                    />
                  );
                })
              )}
            </div>
          ))
        : null}

      {phase !== "syncing" ? (
        <div className="field">
          <label htmlFor="studio-edit-request">Ask for changes</label>
          <textarea
            id="studio-edit-request"
            rows={2}
            maxLength={2000}
            value={request}
            placeholder="e.g. swap Friday's session for a lower-body focus"
            onChange={(e) => setRequest(e.target.value)}
          />
          <label className="row" style={{ fontWeight: 500, cursor: "pointer" }}>
            <input type="checkbox" checked={major} onChange={(e) => setMajor(e.target.checked)} />
            Major revision (bigger changes — uses the stronger model)
          </label>
          {editError ? <Banner kind="warn">{editError}</Banner> : null}
          <button
            className="btn btn-studio"
            disabled={edit.isPending || request.trim().length === 0}
            onClick={() => edit.mutate()}
          >
            {edit.isPending ? "Applying…" : "Apply edit"}
          </button>
        </div>
      ) : null}

      {dirty && phase !== "syncing" ? (
        <div className="studio-diff-strip">
          <span className="studio-diff-added">+{diff.added} new</span>
          <span className="studio-diff-removed">−{diff.removed} removed</span>
          {diff.editedSincePush ? (
            <span className="studio-diff-changed">
              Edited since last sync — exact changes are computed when you sync.
            </span>
          ) : null}
        </div>
      ) : null}

      {pushError ? <Banner kind="warn">{pushError}</Banner> : null}
      {phase === "draft" ? (
        <button className="btn btn-studio" disabled={push.isPending} onClick={() => push.mutate()}>
          {push.isPending
            ? "Starting sync…"
            : `Sync to COROS — ${totalSessions} session${totalSessions === 1 ? "" : "s"}`}
        </button>
      ) : phase === "attention" ? (
        <button className="btn btn-studio" disabled={push.isPending} onClick={() => push.mutate()}>
          {push.isPending ? "Retrying…" : `Retry ${failedRows.length} failed`}
        </button>
      ) : phase === "synced" && dirty ? (
        <button className="btn btn-studio" disabled={push.isPending} onClick={() => push.mutate()}>
          {push.isPending ? "Starting sync…" : "Sync changes to COROS"}
        </button>
      ) : null}

      <PastPlans onUseTemplate={onUseTemplate} />
    </div>
  );
}

// ── Section shell ────────────────────────────────────────────────────────────

function StudioBody({ studio }: { studio: StudioStateResponse }) {
  const [showIntake, setShowIntake] = useState(false);
  const [templateBrief, setTemplateBrief] = useState<PlanBrief | null>(null);
  const useTemplate = (brief: PlanBrief) => {
    setTemplateBrief(brief);
    setShowIntake(true);
  };
  return (
    <div className="studio-content stack">
      {/* No separate `<SyncPanel />` here: `StudioSection` only ever mounts
          inside `PlanScreen` (never standalone), which already renders the
          shared status line + notes feed above it — a second copy here would
          just duplicate it whenever this panel is expanded. BridgeStatusLine
          keeps its own narrower stuck-jobs warning, which needs facts
          (`pendingJobs`/`inFlight`) `SyncStatusDto` doesn't carry. */}
      <BridgeStatusLine bridge={studio.bridge} />
      {!studio.plan || showIntake ? (
        <>
          <IntakeForm
            key={templateBrief ? JSON.stringify(templateBrief) : "fresh"}
            initial={templateBrief ?? studio.brief}
            hasCurrentPlan={Boolean(studio.plan)}
            llm={studio.llm}
            onCancel={studio.plan ? () => setShowIntake(false) : undefined}
            onDone={() => {
              setShowIntake(false);
              setTemplateBrief(null);
            }}
          />
          {!studio.plan ? <PastPlans onUseTemplate={useTemplate} /> : null}
        </>
      ) : (
        <StudioDraft studio={studio} onStartNew={() => setShowIntake(true)} onUseTemplate={useTemplate} />
      )}
      <UsageMeter llm={studio.llm} />
    </div>
  );
}

/** One-line status for the collapsed header — the section only demands
 * attention when something is actually happening or wrong. */
function studioHeaderStatus(studio: StudioStateResponse | undefined): string | null {
  if (!studio?.plan) return null;
  const phase = studioPhase(studio, localTodayGuess());
  const live = studio.pushes.filter((p) => p.status !== "deleted");
  const verified = live.filter((p) => p.status === "verified").length;
  if (phase === "syncing") return `Syncing ${verified}/${live.length}…`;
  if (phase === "attention") return "Needs attention";
  if (phase === "draft") return "Draft ready to sync";
  if (phase === "over") return "Plan finished";
  return null; // synced & quiet: no badge — normal earns silence
}

/** Mounted at the top of the Plan screen (packages/ui/src/screens/plan.tsx).
 * Collapsible — the calendar list below is unaffected by open/closed state. */
export function StudioSection() {
  // Collapsed by default: the Plan page's primary content is the calendar,
  // and the studio is an occasional tool, not the landing experience.
  const [open, setOpen] = useState(false);
  const studio = useQuery({
    queryKey: ["studio"],
    queryFn: api.studio,
    // Poll fast only while a sync is actually moving; otherwise stay quiet.
    refetchInterval: (query) => {
      const data = query.state.data as StudioStateResponse | undefined;
      const busy = data ? data.bridge.pendingJobs.queued + data.bridge.inFlight.count > 0 : false;
      return busy ? 4_000 : 30_000;
    },
  });
  const headerStatus = studioHeaderStatus(studio.data);

  return (
    <section className="card studio-card">
      <button
        type="button"
        className="studio-toggle"
        aria-expanded={open}
        aria-controls="studio-panel"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="studio-heading">
          <strong>Studio</strong>
          <span className="faint">Lifting plans, written to COROS</span>
        </span>
        {headerStatus ? <span className="pill pill-neutral studio-header-pill">{headerStatus}</span> : null}
        <span className="chevron" aria-hidden>
          <IconChevron size={18} />
        </span>
      </button>
      {/* Kept in the DOM (even collapsed, just empty) so aria-controls above
          always resolves to a real element rather than a dangling id. */}
      <div id="studio-panel">
        {open ? (
          studio.isLoading ? (
            <div className="studio-content">
              <Spinner label="Loading studio" />
            </div>
          ) : !studio.data ? (
            <div className="studio-content">
              <Banner kind="warn">Couldn't load the studio.</Banner>
            </div>
          ) : (
            <StudioBody studio={studio.data} />
          )
        ) : null}
      </div>
    </section>
  );
}
