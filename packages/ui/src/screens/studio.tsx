import { useMemo, useState } from "react";
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
import { Banner, formatDayShort, Sheet, Spinner } from "../components.js";
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
  if (!Number.isInteger(brief.sessionsPerWeek) || brief.sessionsPerWeek < 1 || brief.sessionsPerWeek > 6) {
    errs.push("Sessions per week must be 1–6.");
  }
  if (brief.preferredDays.length !== brief.sessionsPerWeek) {
    errs.push(
      `Pick exactly ${brief.sessionsPerWeek} day${brief.sessionsPerWeek === 1 ? "" : "s"} (currently ${brief.preferredDays.length}).`,
    );
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
      if (reason === "bridge_outdated") {
        return "Your desktop app is running an older build that can't sync the exercise catalog — update the desktop app, then leave it open for a minute.";
      }
      if (reason === "syncing") {
        return "Your Mac is connected and the exercise catalog is on its way — try again in a minute.";
      }
      return "Open the desktop app on your Mac so it can sync your exercise catalog, then try again.";
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
  if (bridge.pendingJobs.queued > 0) {
    return (
      <Banner kind="info">
        Waiting for your Mac — open the desktop app to send {bridge.pendingJobs.queued} pending change
        {bridge.pendingJobs.queued === 1 ? "" : "s"}.
      </Banner>
    );
  }
  if (bridge.inFlight.count > 0) {
    const ageMs = bridge.inFlight.oldestClaimedAt ? Date.now() - Date.parse(bridge.inFlight.oldestClaimedAt) : 0;
    const stuck = ageMs > 10 * 60_000;
    return (
      <Banner kind={stuck ? "warn" : "info"}>
        {stuck
          ? "This is taking longer than usual — your Mac may be stuck on this change."
          : "Your Mac is working on it…"}
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
    setBrief((b) => ({
      ...b,
      preferredDays: b.preferredDays.includes(n)
        ? b.preferredDays.filter((d) => d !== n)
        : [...b.preferredDays, n].sort((a, c) => a - c),
    }));
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
        <label htmlFor="studio-spw">Sessions per week</label>
        <input
          id="studio-spw"
          type="number"
          min={1}
          max={6}
          value={brief.sessionsPerWeek}
          onChange={(e) => setBrief((b) => ({ ...b, sessionsPerWeek: Number(e.target.value) }))}
        />
        <span className="hint">1–6 sessions</span>
      </div>

      <div className="field">
        <label>Preferred days</label>
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
          {brief.preferredDays.length} of {brief.sessionsPerWeek} picked
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

      <div className="btn-row">
        <button className="btn btn-studio" disabled={generate.isPending} onClick={submit}>
          {generate.isPending ? "Generating…" : hasCurrentPlan ? "Generate new plan" : "Create plan"}
        </button>
        {onCancel ? (
          <button className="btn" onClick={onCancel} disabled={generate.isPending}>
            Cancel
          </button>
        ) : null}
      </div>

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
}: {
  row: StudioPushRowDto | null;
  onRetry: (happenDay: string) => void;
  retrying: boolean;
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

  // status === "failed" from here down.
  if (row.error === "changed_on_coros") {
    // Launch requirement b: no forget/re-adopt endpoint exists on the worker
    // yet (confirmed against apps/worker/src/routes/studio.ts — only
    // GET / , /generate, /edit, /push, /push/retry). Shipping the affordance
    // disabled with honest copy rather than inventing a route. Also: retrying
    // this row is a no-op server-side (pushStudioPlan's `untouchable` set
    // treats any changed_on_coros row as blocked regardless), so no retry
    // button is offered here — it would look actionable but do nothing.
    return (
      <div className="stack" style={{ gap: "0.3rem" }}>
        <span className="pill pill-warn">
          <IconAlert /> Changed outside the studio
        </span>
        <button className="btn btn-small" disabled>
          Forget / re-adopt
        </button>
        <span className="faint">
          Coming soon — this session changed outside the studio and is no longer managed.
        </span>
      </div>
    );
  }

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
}: {
  session: StudioSession;
  happenDay: string;
  row: StudioPushRowDto | null;
  onRetry: (happenDay: string) => void;
  retrying: boolean;
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
        <PushRowStatus row={row} onRetry={onRetry} retrying={retrying} />
      </div>
    </div>
  );
}

// ── Draft view (plan exists) ─────────────────────────────────────────────────

function StudioDraft({ studio, onStartNew }: { studio: StudioStateResponse; onStartNew: () => void }) {
  const qc = useQueryClient();
  const plan = studio.plan!;
  const brief = studio.brief!;
  const version = studio.version!;

  const [request, setRequest] = useState("");
  const [major, setMajor] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [pushError, setPushError] = useState<string | null>(null);

  const monday = useMemo(() => startOfIsoWeek(brief.startDate), [brief.startDate]);
  const pushByDay = useMemo(() => new Map(studio.pushes.map((p) => [p.happenDay, p])), [studio.pushes]);

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

  // Launch requirement f: shown whenever verified content currently exists —
  // never a watch-delivery claim, only "the calendar was updated."
  const everVerified = studio.pushes.some((p) => p.status === "verified");

  return (
    <div className="stack">
      <div className="row-between">
        <div>
          <div style={{ fontWeight: 650 }}>{plan.name}</div>
          <p className="faint">
            {brief.durationWeeks} weeks · {brief.sessionsPerWeek}×/week · v{version}
          </p>
        </div>
        <button className="btn btn-small" onClick={onStartNew}>
          New plan
        </button>
      </div>

      {sessionsByWeek.map((wk) => (
        <div key={wk.weekIndex}>
          <div className="studio-week-label">Week {wk.weekIndex + 1}</div>
          {wk.sessions.length === 0 ? (
            <p className="muted">No sessions this week.</p>
          ) : (
            wk.sessions.map(({ session, happenDay }, i) => (
              <SessionCard
                key={`${wk.weekIndex}-${i}`}
                session={session}
                happenDay={happenDay}
                row={pushByDay.get(happenDay) ?? null}
                onRetry={(d) => retry.mutate(d)}
                retrying={retry.isPending}
              />
            ))
          )}
        </div>
      ))}

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
      </div>
      {editError ? <Banner kind="warn">{editError}</Banner> : null}
      <button
        className="btn btn-studio"
        disabled={edit.isPending || request.trim().length === 0}
        onClick={() => edit.mutate()}
      >
        {edit.isPending ? "Applying…" : "Apply edit"}
      </button>

      <div className="studio-diff-strip">
        <span className="studio-diff-added">+{diff.added} new</span>
        <span className="studio-diff-removed">−{diff.removed} removed</span>
        {diff.editedSincePush ? (
          <span className="studio-diff-changed">Edited since last push — exact changes are computed when you push.</span>
        ) : null}
      </div>

      {everVerified ? <Banner kind="info">COROS calendar updated · open COROS to sync your watch.</Banner> : null}

      {pushError ? <Banner kind="warn">{pushError}</Banner> : null}
      <button className="btn btn-studio" disabled={push.isPending} onClick={() => push.mutate()}>
        {push.isPending ? "Pushing…" : "Push to COROS"}
      </button>
    </div>
  );
}

// ── Section shell ────────────────────────────────────────────────────────────

function StudioBody({ studio }: { studio: StudioStateResponse }) {
  const [showIntake, setShowIntake] = useState(false);
  return (
    <div className="studio-content stack">
      <BridgeStatusLine bridge={studio.bridge} />
      {!studio.plan || showIntake ? (
        <IntakeForm
          initial={studio.brief}
          hasCurrentPlan={Boolean(studio.plan)}
          llm={studio.llm}
          onCancel={studio.plan ? () => setShowIntake(false) : undefined}
          onDone={() => setShowIntake(false)}
        />
      ) : (
        <StudioDraft studio={studio} onStartNew={() => setShowIntake(true)} />
      )}
      <UsageMeter llm={studio.llm} />
    </div>
  );
}

/** Mounted at the top of the Plan screen (packages/ui/src/screens/plan.tsx).
 * Collapsible — the calendar list below is unaffected by open/closed state. */
export function StudioSection() {
  const [open, setOpen] = useState(true);
  const studio = useQuery({ queryKey: ["studio"], queryFn: api.studio, refetchInterval: 15_000 });

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
