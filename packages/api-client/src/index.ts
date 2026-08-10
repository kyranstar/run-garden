import type {
  CorosSyncState,
  CalendarSyncState,
  CompletionState,
  GardenConditionWord,
  GardenEvent,
  GardenWeatherState,
  LiftingPlan,
  PlanBrief,
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
  title: string;
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
}

export interface TodayResponse {
  today: string;
  nextWorkout: WorkoutDto | null;
  upcoming: WorkoutDto[];
  unresolved: WorkoutDto[];
  needsAttention: WorkoutDto[];
  sync: {
    pendingCorosJobs: number;
    deviceOnline: boolean;
    deviceRegistered: boolean;
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
  };
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

export interface DeviceDto {
  id: string;
  name: string;
  platform: string;
  appVersion: string;
  bridgeVersion: string | null;
  capabilities: Record<string, boolean> | null;
  bridgePaused: boolean;
  lastSeenAt: string;
  revokedAt: string | null;
  online: boolean;
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
  };
  at: string;
}

export interface CoachAnalyzeResult {
  message: { id: string; body: string; at: string };
  cached: boolean;
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
}

export interface CoachStateResponse {
  messages: CoachMessageDto[];
  pendingProposals: CoachProposalDto[];
  openQuestion: CoachQuestionDto | null;
  memoryCount: number;
  lastCoachAt: string | null;
  wakeAdvised: boolean;
}

export interface CoachWakeResult {
  status: "ok" | "skipped" | "resting" | "error";
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
export type SyncStatusState = "in_sync" | "syncing" | "waiting_for_mac" | "not_synced" | "sync_issue";

export interface SyncStatusDto {
  state: SyncStatusState;
  pendingCount: number;
  issueCount: number;
  lastCorosReadAt: string | null;
  paused: boolean;
  writesEnabled: boolean;
  registered: boolean;
}

export type SyncNoteKind =
  | "kept_local_change"
  | "adopted_coros_change"
  | "adopted_coros_edit"
  | "adopted_coros_removal";

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
  /** Why status is "error": bridge_cannot_run_backfill | bridge_never_claimed
   * | bridge_stalled_mid_walk. */
  lastErrorCategory: string | null;
  /** A backfill job is still live (queued or claimed) — an errored walk with
   * a live job resumes by itself when the Mac wakes, so keep polling. */
  jobQueued: boolean;
  /** The desktop bridge's liveness, so queued states can name the wait. */
  bridgeLastSeenAt: string | null;
  bridgeOnline: boolean;
  /** Syncing is paused on the Mac — queued work provably cannot start. */
  bridgePaused: boolean;
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
  coachMemoryList: () => get<{ memory: CoachMemoryItem[] }>("/api/coach/memory"),
  coachMemoryUpdate: (id: string, body: string) =>
    request<{ ok: boolean }>(`/api/coach/memory/${id}`, { method: "PATCH", body: JSON.stringify({ body }) }),
  coachMemoryDelete: (id: string) =>
    request<{ ok: boolean }>(`/api/coach/memory/${id}`, { method: "DELETE" }),
  coachPlans: () => get<{ plans: CoachPlanDto[] }>("/api/coach/plans"),
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
  devices: () => get<{ devices: DeviceDto[] }>("/api/devices"),
  revokeDevice: (id: string) => post(`/api/devices/${id}/revoke`),
  pauseDevice: (id: string, paused: boolean) => post(`/api/devices/${id}/pause`, { paused }),
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
