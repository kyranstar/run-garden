import type {
  CorosSyncState,
  CalendarSyncState,
  CompletionState,
  GardenConditionWord,
  GardenEvent,
  GardenWeatherState,
  LiftingPlan,
  PlanBrief,
  ReadinessVerdict,
  UserPreferences,
} from "@rg/domain";
import type {
  AerobicEfficiencyValue,
  ConsistencyReport,
  DecouplingValue,
  Discipline,
  EvidenceCard,
  InterpretedMetric,
  MetricResult,
  StoredRecord,
  WeeklyTrainingReport,
} from "@rg/analytics";

/**
 * Typed client for the Run Garden worker API. Same-origin; cookie sessions.
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`api_${status}`);
  }
}

/** Default request deadline. A hung connection (mobile switching networks)
 * otherwise left spinners spinning forever — React Query only retries once a
 * request actually REJECTS. Long-running AI calls pass their own budget. */
const DEFAULT_TIMEOUT_MS = 30_000;

async function request<T>(path: string, init?: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    signal: AbortSignal.timeout(timeoutMs),
    ...init,
  });
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, body);
  }
  return (await res.json()) as T;
}

export const get = <T>(path: string) => request<T>(path);
export const post = <T>(path: string, body?: unknown, timeoutMs?: number) =>
  request<T>(
    path,
    { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) },
    timeoutMs,
  );

/** AI generation legitimately runs for minutes — never cut it off client-side. */
const AI_TIMEOUT_MS = 15 * 60_000;
export const put = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "PUT", body: JSON.stringify(body) });

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface WorkoutDto {
  id: string;
  /** Human display name — the server substitutes category words when COROS
   * sent an opaque code ("T1004"); the raw code rides in corosName. */
  title: string;
  corosName?: string;
  category: string;
  qualitySubtype?: string | null;
  sport: string;
  originalPlanDate: string;
  lastVerifiedCorosDate: string;
  effectiveDate: string;
  effectiveTime: string;
  workoutSeconds: number | null;
  estimateSource?: string;
  calendarSeconds: number;
  stageSummary?: string | null;
  calendarSyncState: CalendarSyncState;
  corosSyncState: CorosSyncState;
  /** Derived per-workout view (sync-transparency Task 10) — same legacy
   * five-value vocabulary as `corosSyncState` (so `CorosPill`/
   * `COROS_SYNC_LABELS` keep working unchanged), computed fresh from open
   * intents + in-flight/failed jobs rather than echoed from the stored
   * column. Optional: absent on any DTO a route hasn't opted into deriving. */
  corosSyncView?: CorosSyncState;
  completionState: CompletionState;
  archived: boolean;
  /**
   * A lift/mobility session's prescription, one line per movement, already
   * formatted (`formatExercise`) and already name-resolved server-side.
   * `onWatch: false` means the athlete's synced COROS library has no
   * matching movement — the session is real and stays in the app, it just
   * can never be written to the watch. Absent for runs and rest days, and
   * for any route that hasn't opted into loading it.
   */
  exercises?: Array<{ name: string; line: string; onWatch: boolean }>;
  /** Set when the exercise list is a CIRCUIT cycled this many times. */
  exerciseRounds?: number;
}

export interface TodayResponse {
  today: string;
  nextWorkout: WorkoutDto | null;
  upcoming: WorkoutDto[];
  unresolved: WorkoutDto[];
  needsAttention: WorkoutDto[];
  sync: {
    pendingCorosJobs: number;
    corosConnected: boolean;
    corosWritesEnabled: boolean;
    calendarConnected: boolean;
  };
  readiness: {
    latest: {
      date: string;
      restingHeartRate: number | null;
      hrv: number | null;
      recoveryScore: number | null;
      trainingLoad7d: number | null;
    } | null;
    baseline: { restingHeartRate: number | null; hrv: number | null } | null;
    sampleDays: number;
    /** The server's one judgement on those numbers — null when the evidence
     * is too thin to have one, in which case surfaces show nothing at all. */
    verdict: ReadinessVerdict | null;
  };
  /** The coach's own weekly action line, already gated by the 72h staleness
   * rule server-side (absent/stale → null). It was written about the WEEK,
   * never about today's readiness — surfaces must label and date it. */
  focus: { text: string; at: string } | null;
  garden: {
    condition: GardenConditionWord;
    weather: GardenWeatherState;
    plants: number;
    recentEvents: GardenEvent[];
    wateredYesterday: boolean;
  } | null;
}

export interface MeResponse {
  userId: string;
  email: string;
  connections: Array<{
    provider: string;
    status: string;
    lastSyncAt: string | null;
    lastErrorCategory: string | null;
  }>;
  fixtureMode: boolean;
}

export interface CandidateResponse {
  candidates: Array<{
    date: string;
    time: string;
    window: "morning" | "evening";
    explanation: string;
    warnings: string[];
    daysMoved: number;
  }>;
  blockedReason?: string;
  skipOption: { explanation: string };
  /** False when Google free/busy couldn't be checked — "open" claims are
   * then unverified (audit#2 #16). */
  busyChecked?: boolean;
}

export interface PlanResponse {
  today: string;
  plan: { name: string; startDate: string | null; endDate: string | null } | null;
  corosWritesEnabled: boolean;
  workouts: WorkoutDto[];
}

export interface ActivityDto {
  id: string;
  startTime: string;
  startTimeLocal: string | null;
  date: string;
  title: string | null;
  sport: string;
  durationSeconds: number;
  distanceMeters: number | null;
  avgPaceSecPerKm: number | null;
  /** Total climb, when the watch recorded it — the terrain signal. */
  elevationGainMeters?: number | null;
  /** COROS training load, when reported — drives the effort chip. */
  trainingLoad: number | null;
  /** Self-reported feel 1-5 from the watch, when present. */
  feel: number | null;
  /** Compact lap profile (seconds + pace per lap, in order) for the
   * pace-shape micro chart; null when fewer than two laps exist. */
  laps: Array<{ s: number; p: number | null }> | null;
  /** The planned workout this run completed, or null if it was unplanned. */
  matched: { workoutId: string; title: string; category: string; date: string } | null;
}

export interface SettingsResponse {
  prefs: UserPreferences;
  llm: {
    spentDollars: number;
    warnDollars: number;
    cutoffDollars: number;
    maxDollars: number;
    warn: boolean;
    cutoff: boolean;
  };
}

/** How balanced run/strength/yoga are right now — mirrors @rg/garden-engine's DisciplineBalance. */
export interface DisciplineBalance {
  run: { days: number; health: number };
  /** `days: null` = never recorded — render "not yet", not a recency. */
  strength: { days: number | null; health: number };
  yoga: { days: number | null; health: number };
  /** How balanced the garden is overall: the weakest discipline sets the pace. */
  overall: number;
}


/**
 * One day of `GET /api/garden/timeline` (worker route:
 * apps/worker/src/routes/garden.ts). `view` mirrors
 * `GardenTimelineDay["view"]` (garden-sync.ts) — loosely typed like
 * `api.garden()`'s payload above; the UI casts `snapshot` to `GardenSnapshot`
 * from `@rg/garden-engine` (not a dependency here) the same way it already
 * casts `api.garden()`'s snapshot. */
export interface GardenTimelineDayDto {
  date: string;
  view: {
    snapshot: Record<string, unknown>;
    condition: GardenConditionWord;
  };
}

export interface GardenTimelineResponse {
  days: GardenTimelineDayDto[];
}

// ── The coach (spec: docs/superpowers/specs/2026-08-06-coach-*-design.md) ──

export interface CoachMessageDto {
  id: string;
  role: "coach" | "user" | "receipt";
  body: string;
  refs: {
    proposalId?: string;
    memoryIds?: string[];
    questionId?: string;
    kind?: "analysis";
    activityId?: string;
    /** Marks an inert "couldn't think" / "resting" receipt (audit C4/C14) —
     * lets the thread collapse repeats of exactly these without also
     * merging unrelated receipts that happen to share body text. */
    wakeFailure?: boolean;
    /** The briefing's one action line (rework spec §3) — surfaced on the
     * plan page's weekly brief. */
    focus?: string;
  };
  at: string;
  /** Client-only: set on an optimistic echo whose send failed (audit C16).
   * Never sent by the server — undefined for every persisted message. */
  failed?: boolean;
}

/** One ambient read from the perception ledger (rework spec §2). A 202
 * `{status:"working"}` (someone else is generating) surfaces as
 * `read: undefined` — poll again shortly. */
export interface CoachAnalyzeResult {
  read?: { id: string; glance: string; body: string; flags: string[]; at: string };
  cached?: boolean;
  status?: "working";
}

export interface CoachProposalDto {
  id: string;
  title: string;
  evidence: string;
  rationale: string;
  flags: string[];
  ops: unknown[];
  status: "pending" | "approved" | "declined" | "superseded" | "expired";
  createdAt: string;
  expiresAt: string;
}

export interface CoachQuestionDto {
  id: string;
  body: string;
  chips: string[];
  askedAt: string;
}

export interface CoachMemoryItem {
  id: string;
  kind: "fact" | "rule" | "note";
  body: string;
  provenance: { source: string; messageId?: string; at: string };
  learnedAt: string;
  expiresAt: string | null;
}

export interface CoachPlanDto {
  id: string;
  discipline: "run" | "lift";
  name: string;
  status: "draft" | "active" | "completed" | "retired";
  startDate: string;
  endDate: string;
  raceDate: string | null;
  /** Who authored it: the coach, the Studio (lifting plans written to
   * COROS), or COROS itself (imported plans — read-only cards). Absent in
   * older payloads — treat as "coach". */
  source?: "coach" | "studio" | "coros";
}

/** One pickable week + the brief's facts (rework spec §4). */
export interface PlanWeekResponse {
  weekStart: string;
  days: Array<{ date: string; workouts: WorkoutDto[] }>;
  plannedSeconds: number;
  doneCount: number;
  sessionCount: number;
  weekIndex: number | null;
  weekTotal: number | null;
  adherence4w: { pct: number | null; trend: "up" | "flat" | "down" | null };
  loadRatio: number | null;
  /** Distinct adventure-sport days in the trailing 28 — the brief's context
   * line uses this to say "the plan paused", not "you failed". */
  adventureDays: number;
  /** An active race workout sits on a different day than prefs.raceDate. */
  raceMismatch?: { workoutId: string; plannedDate: string; raceDate: string; title: string } | null;
  headline: "on_track" | "behind" | "ahead" | "rebuilding" | "race_week" | "resting";
  focus: { text: string; at: string } | null;
}

/** GET /api/plan/race — everything the plan page's race strip renders.
 * Metric on the wire; the client converts via prefs.units. */
export interface RaceHubResponse {
  race: {
    raceDate: string;
    daysToRace: number;
    taperStartDate: string;
    phase: "build" | "taper" | "race_week" | "post";
    goal: {
      thresholdPaceSecPerKm: number;
      asOf: string;
      prediction: {
        distanceKm: number;
        fastSecPerKm: number;
        slowSecPerKm: number;
        fastSeconds: number;
        slowSeconds: number;
      } | null;
    } | null;
    stamina: Array<{ date: string; value: number }>;
    checklist: Array<{
      id: string;
      label: string;
      done: boolean;
      kind: "coach" | "user";
      note?: string;
    }>;
    raceLine: { text: string; at: string } | null;
    /** Measured climb per km recently, against the described course. */
    terrain: {
      recent: {
        metresPerKm: number;
        runs: number;
        totalClimbMetres: number;
        sinceDate: string;
      } | null;
      raceMetresPerKm: number | null;
      comparison: {
        recentMetresPerKm: number;
        raceMetresPerKm: number;
        ratio: number | null;
        verdict: "under_prepared" | "matched" | "over_prepared";
      } | null;
    };
    debrief: {
      activityId: string;
      durationSeconds: number;
      distanceMeters: number | null;
      avgPaceSecPerKm: number | null;
    } | null;
  } | null;
}

export interface PlanProgressionPoint {
  week: number;
  value: number;
  done?: boolean;
  actual?: number;
}

export interface PlanProgression {
  key: string;
  label: string;
  unit: string;
  from: number;
  to: number;
  now: number | null;
  series: PlanProgressionPoint[];
}

export interface PlanDetailWeek {
  weekStart: string;
  index: number;
  state: "firm" | "shape";
  volumeTarget: string | null;
  keySessions: string[];
  summary: string;
  done: boolean;
  current: boolean;
}

export interface PlanDetailResponse {
  plan: CoachPlanDto;
  weeks: PlanDetailWeek[];
  progressions: PlanProgression[];
  sessions: { planned: number; done: number };
  adherencePct: number | null;
}


/** Cloud COROS connection (cloud-direct spec §1). */
export interface CorosStatusResponse {
  connected: boolean;
  status: string | null;
  lastSyncAt: string | null;
  lastErrorCategory: string | null;
  email: string | null;
  region: string | null;
}

export interface CorosConnectResponse {
  status: "connected" | "bad_credentials" | "login_failed";
  /** COROS envelope result code when COROS itself rejected the login. */
  code?: string;
}

export interface CoachStateResponse {
  messages: CoachMessageDto[];
  pendingProposals: CoachProposalDto[];
  openQuestion: CoachQuestionDto | null;
  memoryCount: number;
  lastCoachAt: string | null;
  wakeAdvised: boolean;
  /** A wake is running (or a reply is still owed) server-side — survives
   * page navigation where the client's own mutation state cannot. */
  coachThinking?: boolean;
}

export interface CoachWakeResult {
  status: "ok" | "skipped" | "busy" | "resting" | "error";
  coachMessageId?: string;
  proposalIds?: string[];
}

/** Arrival watermark for the garden's celebration/beat surfaces — the newest
 * durable event the user has seen plus same-day (preview) unlocks already
 * celebrated. Mirrors `GardenView["seen"]` (garden-sync.ts) and the body of
 * `POST /api/garden/seen`. */
export interface GardenSeenState {
  lastSeenDate: string;
  lastSeenSeq: number;
  celebratedSpeciesIds: string[];
  /** When this watermark was last written (server-stamped) — present on the
   * GET /api/garden read, absent on the POST /api/garden/seen body (the
   * client never sets it; the server stamps its own on write). Lets arrival
   * admission tell a genuinely rebuilt event (resimulateFrom) apart from an
   * ordinary one that's simply behind the watermark (C13). */
  updatedAt?: string;
}

// ── Plan Studio (worker routes: apps/worker/src/routes/studio.ts) ──────────────

/** One `studio_plan_pushes` row, trimmed to what the UI needs (no internal
 * COROS addressing fields — see the route's `pushRowDto`). */
export interface StudioPushRowDto {
  id: string;
  happenDay: string;
  sessionTitle: string;
  /** `adopted` (sync-transparency Task 7): a genuine external edit/move/removal
   * on COROS was detected; the studio stepped back from managing this session
   * (`error` is always `null` in this state) until undone via
   * `studioUndoAdoption`/`undoSyncNote`. */
  status: "pending" | "verified" | "failed" | "deleted" | "adopted";
  error: string | null;
  corosHappenDay: string | null;
}

/** Read back from the push's own audit-log row (never persisted separately);
 * `null` until the plan has been pushed at least once. */
export interface StudioPushSummaryDto {
  ok: true;
  planVersion: number;
  creates: number;
  deletes: number;
  failures: number;
  unchanged: number;
  drifted: number;
  blocked: number;
}

/** "Waiting for bridge" indicator: device online heuristic plus two DISTINCT
 * job-count facts — the UI decides what "stale"/"stuck" means.
 * `pendingJobs` is unclaimed (`status: "queued"`) work — no device has
 * picked it up yet, the actual "is a bridge even listening" signal.
 * `inFlight` (fix round 1, F2) is work a device DID claim but hasn't
 * finished — a stuck/crashed device, a different failure mode that would be
 * invisible if folded into `pendingJobs`. */
export interface StudioBridgeStatusDto {
  online: boolean;
  pendingJobs: { queued: number; oldestQueuedAt: string | null };
  inFlight: { count: number; oldestClaimedAt: string | null };
}

/** Mirrors `SettingsResponse["llm"]` — same `llmBudgetStatus` service, same
 * shape, reused rather than re-declared. */
export type StudioLlmStatusDto = SettingsResponse["llm"];

export interface StudioStateResponse {
  plan: LiftingPlan | null;
  brief: PlanBrief | null;
  version: number | null;
  pushes: StudioPushRowDto[];
  lastPushSummary: StudioPushSummaryDto | null;
  bridge: StudioBridgeStatusDto;
  llm: StudioLlmStatusDto;
}

export interface StudioGenerateResponse {
  ok: true;
  plan: LiftingPlan;
  brief: PlanBrief;
  version: number;
}

/**
 * Fix round 1, F5: if the CURRENT plan has any push row that's `verified`, or
 * `pending`/`failed` but with a recorded COROS id (may have materialized
 * before its outcome resolved), a `generate` call is refused with
 * `{error: "plan_has_live_pushes"}` (409) unless `replace: true` is passed —
 * regenerating over a plan with real COROS sessions would otherwise orphan
 * them (nothing in the app would track them anymore).
 *
 * Passing `replace: true` does NOT delete anything synchronously: the worker
 * enqueues guarded deletes for the old plan's live rows (the same
 * triple-addressed, ownership-reproving path a normal push uses) BEFORE
 * creating the new plan, then returns as soon as the new plan exists. The
 * bridge executes those deletes on its own poll. Because of that gap, a
 * `/push` on the new plan run before the old deletes verify MAY hit
 * `duplicate_title` failures for sessions whose stamp collides with a
 * not-yet-deleted old workout — this is expected and safe (the
 * title-uniqueness guard fails closed rather than double-writing); a later
 * `/push`/`push/retry` once the old deletes have verified succeeds normally.
 */
export interface StudioGenerateOptions {
  replace?: boolean;
}

export interface StudioEditResponse {
  ok: true;
  plan: LiftingPlan;
  brief: PlanBrief;
  version: number;
}

export interface StudioPushResponse {
  ok: true;
  summary: StudioPushSummaryDto;
  pushes: StudioPushRowDto[];
}

// ── Sync transparency (worker routes: apps/worker/src/routes/sync.ts) ──────────

/** Mirrors `sync-status.ts`'s `SyncStatusState` — the account-wide summary,
 * distinct from `WorkoutDto.corosSyncView`'s per-workout vocabulary. */
export type SyncStatusState = "in_sync" | "syncing" | "not_synced" | "sync_issue";

export interface SyncStatusDto {
  state: SyncStatusState;
  pendingCount: number;
  issueCount: number;
  lastCorosReadAt: string | null;
  writesEnabled: boolean;
  registered: boolean;
  /** Cloud-direct COROS: present when a cloud connection exists (or errors).
   * The sync line prefers this over Mac presence. */
  cloud?: { connected: boolean; lastSyncAt: string | null; error: string | null } | null;
}

export type SyncNoteKind =
  | "kept_local_change"
  | "adopted_coros_change"
  | "adopted_coros_edit"
  | "adopted_coros_removal"
  | "race_move_rejected";

export interface SyncNoteDto {
  id: string;
  kind: SyncNoteKind;
  workoutId: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface ReadNowResponse {
  enqueued: boolean;
  lastCorosReadAt: string | null;
}

export interface RetrySyncResponse {
  ok: true;
  /** Failed workout moves that were superseded and re-applied. */
  movesRetried: number;
  /** Studio plans (holding one or more failed rows) that were re-pushed. */
  studioRetried: number;
}

/** Progress of the one-shot deep history backfill. */
export interface BackfillStatusResponse {
  /** "queued" until the Mac's bridge has actually landed a chunk — the UI
   * must never say "reading" while nothing is. */
  status: "idle" | "queued" | "running" | "done" | "error";
  earliestDateReached: string | null;
  chunksCompleted: number;
  activitiesIngested: number;
  /** COROS sportType codes the registry couldn't name (admitted as "other"). */
  skippedSportTypes: Record<string, number>;
  /** Why status is "error": never_started | stalled | api_error. */
  lastErrorCategory: string | null;
  /** A backfill job is still live (queued or claimed) — an errored walk with
   * a live job resumes on the next cloud tick, so keep polling. */
  jobQueued: boolean;
}

/** Response from `POST /api/studio/adoption/:pushId/undo` — mirrors the
 * worker's own `PushSummary` (apps/worker/src/services/studio-push.ts), which
 * is a distinct, lighter shape than `StudioPushSummaryDto` above (no
 * `planVersion`; carries its own `error` for the rare `plan_not_found` /
 * `invalid_plan` re-push failure). A 404/409 (not_found /
 * undo_unsupported_rename) throws `ApiError` instead of reaching this shape. */
export interface StudioAdoptionUndoResponse {
  ok: boolean;
  summary: {
    ok: boolean;
    error?: "plan_not_found" | "invalid_plan";
    creates: number;
    deletes: number;
    failures: number;
    unchanged: number;
    drifted: number;
    blocked: number;
  };
}

// ── Insights (worker route: apps/worker/src/routes/misc.ts insightRoutes) ──────

/** A weekly narrative row as persisted by `weeklyReviews` — echoed verbatim. */
export interface WeeklyReviewDto {
  id: string;
  userId: string;
  weekStart: string;
  facts: Record<string, unknown>;
  narrative: string | null;
  llmModel: string | null;
  llmCostMicros: number | null;
  createdAt: string;
}

/** Exact shape of `GET /api/insights`'s `c.json({...})` payload. */
export interface InsightsResponse {
  discipline: Discipline;
  /** Only disciplines with sessions in the window — never offer an empty view. */
  availableDisciplines: Discipline[];
  consistency: ConsistencyReport;
  weekly: WeeklyTrainingReport;
  /**
   * Pace-based, so ABSENT (not empty) for strength and yoga: an empty card
   * reads as "your data is missing", when the question simply does not apply.
   */
  efficiency?: MetricResult<AerobicEfficiencyValue>;
  decoupling?: MetricResult<DecouplingValue>;
  records: StoredRecord[];
  evidence: EvidenceCard | null;
  reviews: WeeklyReviewDto[];
  interpreted: InterpretedMetric[];
  /** Climb per km recently vs the race course — running only. */
  terrain?: {
    recent: { metresPerKm: number; runs: number; totalClimbMetres: number; sinceDate: string } | null;
    raceMetresPerKm: number | null;
    comparison: {
      recentMetresPerKm: number;
      raceMetresPerKm: number;
      ratio: number | null;
      verdict: "under_prepared" | "matched" | "over_prepared";
    } | null;
  };
}

// ── Endpoints ────────────────────────────────────────────────────────────────

export const api = {
  me: () => get<MeResponse>("/api/auth/me"),
  logout: () => post("/api/auth/logout"),
  today: () => get<TodayResponse>("/api/plan/today"),
  workouts: (start?: string, end?: string) =>
    get<PlanResponse>(
      `/api/plan/workouts${start ? `?start=${start}${end ? `&end=${end}` : ""}` : ""}`,
    ),
  workout: (id: string) => get<Record<string, unknown> & { workout: WorkoutDto }>(`/api/plan/workouts/${id}`),
  candidates: (id: string) => get<CandidateResponse>(`/api/plan/workouts/${id}/candidates`),
  move: (id: string, toDate: string, toTime: string) =>
    post<{ workoutId: string; corosSyncState: CorosSyncState }>(`/api/plan/workouts/${id}/move`, {
      toDate,
      toTime,
    }),
  skip: (id: string) => post(`/api/plan/workouts/${id}/skip`),
  unskipWorkout: (id: string) => post(`/api/plan/workouts/${id}/unskip`),
  defer: (id: string) => post(`/api/plan/workouts/${id}/defer`),
  match: (id: string, activityId: string) => post(`/api/plan/workouts/${id}/match`, { activityId }),
  unmatch: (id: string) => post(`/api/plan/workouts/${id}/unmatch`),
  restoreCalendar: (id: string) => post(`/api/plan/workouts/${id}/restore-calendar`),
  retryCoros: (id: string) => post(`/api/plan/workouts/${id}/retry-coros`),
  removeWorkout: (id: string) => post(`/api/plan/workouts/${id}/remove`),
  garden: () =>
    get<Record<string, unknown> & { balance: DisciplineBalance; seen: GardenSeenState | null }>(
      "/api/garden",
    ),
  gardenSeen: (body: GardenSeenState) => post<{ ok: boolean }>("/api/garden/seen", body),

  // ── The coach (worker routes: apps/worker/src/routes/coach.ts) ───────────
  coachState: (before?: string) =>
    get<CoachStateResponse>(`/api/coach/state${before ? `?before=${encodeURIComponent(before)}` : ""}`),
  coachWake: (force = false) => post<CoachWakeResult>("/api/coach/wake", { force }, 320_000),
  coachMessage: (body: string) => post<CoachWakeResult>("/api/coach/message", { body }, 320_000),
  coachAnalyze: (activityId: string, force = false) =>
    post<CoachAnalyzeResult>(`/api/coach/analyze/${activityId}`, { force }, 320_000),
  coachApprove: (proposalId: string) =>
    post<{ ok: boolean }>(`/api/coach/proposals/${proposalId}/approve`),
  coachDecline: (proposalId: string) =>
    post<{ ok: boolean }>(`/api/coach/proposals/${proposalId}/decline`),
  coachAnswerQuestion: (questionId: string, answer: string) =>
    post<{ ok: boolean }>(`/api/coach/questions/${questionId}/answer`, { answer }, 320_000),
  coachDismissQuestion: (questionId: string) =>
    post<{ ok: boolean }>(`/api/coach/questions/${questionId}/dismiss`),
  coachMemoryList: () => get<{ memory: CoachMemoryItem[] }>("/api/coach/memory"),
  coachMemoryUpdate: (id: string, body: string) =>
    request<{ ok: boolean }>(`/api/coach/memory/${id}`, { method: "PATCH", body: JSON.stringify({ body }) }),
  coachMemoryDelete: (id: string) =>
    request<{ ok: boolean }>(`/api/coach/memory/${id}`, { method: "DELETE" }),
  corosStatus: () => get<CorosStatusResponse>("/api/coros/status"),
  corosReadNow: () =>
    post<{ status: string; ingested?: number }>("/api/coros/read-now", undefined, 60_000),
  corosConnect: (body: { email: string; pwdMd5: string; region: "us" | "eu" | "cn" }) =>
    post<CorosConnectResponse>("/api/coros/connect", body, 60_000),
  corosDisconnect: () =>
    request<{ ok: boolean }>("/api/coros/connect", { method: "DELETE" }),
  coachPlans: () => get<{ plans: CoachPlanDto[] }>("/api/coach/plans"),
  planWeek: (start?: string) =>
    get<PlanWeekResponse>(`/api/plan/week${start ? `?start=${encodeURIComponent(start)}` : ""}`),
  planDetail: (id: string) =>
    get<PlanDetailResponse>(`/api/coach/plans/${encodeURIComponent(id)}/detail`),
  coachPlanRename: (id: string, name: string) =>
    post<{ ok: boolean }>(`/api/coach/plans/${id}/rename`, { name }),
  coachPlanRetire: (id: string) => post<{ ok: boolean }>(`/api/coach/plans/${id}/retire`),
  gardenRestMode: (active: boolean, until?: string | null) =>
    post("/api/garden/rest-mode", { active, until }),
  gardenTimeline: () => get<GardenTimelineResponse>("/api/garden/timeline"),
  insights: (discipline?: Discipline) =>
    get<InsightsResponse>(
      `/api/insights${discipline ? `?discipline=${discipline}` : ""}`,
    ),
  dismissInsight: (cardId: string) => post("/api/insights/dismiss", { cardId }),
  activities: (limit = 40) => get<{ activities: ActivityDto[] }>(`/api/activities?limit=${limit}`),
  unmatchedActivities: () => get<{ activities: Array<Record<string, unknown>> }>("/api/activities/unmatched"),
  /** Queue the one-shot deep walk of COROS history (all three disciplines). */
  backfillHistory: () =>
    post<{ ok: boolean; enqueued: boolean; reason?: string; matched: number }>(
      "/api/activities/backfill",
    ),
  backfillStatus: () => get<BackfillStatusResponse>("/api/sync/backfill-status"),
  settings: () => get<SettingsResponse>("/api/settings"),
  updateSettings: (partial: Partial<UserPreferences>) => put<{ ok: true; prefs: UserPreferences }>("/api/settings", partial),
  diagnostics: () => get<Record<string, unknown>>("/api/settings/diagnostics"),
  deleteAll: () => post("/api/settings/delete-all", { confirm: "delete everything" }),
  calendars: () => get<{ calendars: Array<{ id: string; summary: string; primary?: boolean }> }>("/api/calendar/calendars"),
  chooseCalendar: (opts: { calendarId?: string; createNew?: boolean }) => post<{ ok: true; calendarId: string }>("/api/calendar/choose", opts),
  calendarSync: () => post<Record<string, unknown>>("/api/calendar/sync"),
  calendarPreview: () => get<{ days: Array<Record<string, unknown>>; eventCount: number }>("/api/calendar/preview"),
  fixtureLogin: () => post<{ ok: true }>("/api/dev/fixture-login"),
  fixtureSeed: () => post<Record<string, unknown>>("/api/dev/seed"),
  studio: () => get<StudioStateResponse>("/api/studio"),
  studioGenerate: (brief: PlanBrief, opts: StudioGenerateOptions = {}) =>
    post<StudioGenerateResponse>("/api/studio/generate", { brief, replace: opts.replace }, AI_TIMEOUT_MS),
  studioEdit: (request: string, major = false) =>
    post<StudioEditResponse>("/api/studio/edit", { request, major }, AI_TIMEOUT_MS),
  studioPush: () => post<StudioPushResponse>("/api/studio/push"),
  studioPushRetry: (happenDay: string) =>
    post<StudioPushResponse>("/api/studio/push/retry", { happenDay }),
  studioUndoAdoption: (pushId: string) =>
    post<StudioAdoptionUndoResponse>(`/api/studio/adoption/${pushId}/undo`),
  studioHistory: () => get<{ plans: StudioHistoryEntryDto[] }>("/api/studio/history"),
  syncStatus: () => get<SyncStatusDto>("/api/sync/status"),
  syncNotes: () => get<{ notes: SyncNoteDto[] }>("/api/sync/notes"),
  raceHub: () => get<RaceHubResponse>("/api/plan/race"),
  saveRaceChecklist: (items: Array<{ id: string; label: string; done: boolean }>) =>
    post<{ ok: true }>("/api/plan/race/checklist", { items }),
  resolveRaceConflict: (keep: "settings" | "plan") =>
    post<{ ok: true; resolved: boolean }>("/api/plan/race-conflict/resolve", { keep }),
  dismissSyncNote: (id: string) => post<{ ok: true }>(`/api/sync/notes/${id}/dismiss`),
  undoSyncNote: (id: string) => post<{ ok: true }>(`/api/sync/notes/${id}/undo`),
  readNow: () => post<ReadNowResponse>("/api/sync/read-now"),
  retrySync: () => post<RetrySyncResponse>("/api/sync/retry"),
};

/** One previously generated plan + the brief (prompt) that produced it. */
export interface StudioHistoryEntryDto {
  id: string;
  name: string;
  weeks: number | null;
  version: number;
  createdAt: string;
  brief: PlanBrief;
}
