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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
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
export const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
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
    stravaStatus?: "connected" | "error" | "disconnected";
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
  strength: { days: number; health: number };
  yoga: { days: number; health: number };
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

// ── Plan Studio (worker routes: apps/worker/src/routes/studio.ts) ──────────────

/** One `studio_plan_pushes` row, trimmed to what the UI needs (no internal
 * COROS addressing fields — see the route's `pushRowDto`). */
export interface StudioPushRowDto {
  id: string;
  happenDay: string;
  sessionTitle: string;
  status: "pending" | "verified" | "failed" | "deleted";
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
  defer: (id: string) => post(`/api/plan/workouts/${id}/defer`),
  match: (id: string, activityId: string) => post(`/api/plan/workouts/${id}/match`, { activityId }),
  unmatch: (id: string) => post(`/api/plan/workouts/${id}/unmatch`),
  restoreCalendar: (id: string) => post(`/api/plan/workouts/${id}/restore-calendar`),
  retryCoros: (id: string) => post(`/api/plan/workouts/${id}/retry-coros`),
  garden: () => get<Record<string, unknown> & { balance: DisciplineBalance }>("/api/garden"),
  gardenRestMode: (active: boolean, until?: string | null) =>
    post("/api/garden/rest-mode", { active, until }),
  insights: () => get<Record<string, unknown>>("/api/insights"),
  dismissInsight: (cardId: string) => post("/api/insights/dismiss", { cardId }),
  activities: (limit = 40) => get<{ activities: ActivityDto[] }>(`/api/activities?limit=${limit}`),
  unmatchedActivities: () => get<{ activities: Array<Record<string, unknown>> }>("/api/activities/unmatched"),
  backfillRuns: (days = 90) =>
    post<{ ok: boolean; reason?: string; ingested: number; matched: number }>(
      `/api/activities/backfill?days=${days}`,
    ),
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
  stravaDisconnect: () => post("/api/strava/disconnect"),
  fixtureLogin: () => post<{ ok: true }>("/api/dev/fixture-login"),
  fixtureSeed: () => post<Record<string, unknown>>("/api/dev/seed"),
  studio: () => get<StudioStateResponse>("/api/studio"),
  studioGenerate: (brief: PlanBrief, opts: StudioGenerateOptions = {}) =>
    post<StudioGenerateResponse>("/api/studio/generate", { brief, replace: opts.replace }),
  studioEdit: (request: string, major = false) =>
    post<StudioEditResponse>("/api/studio/edit", { request, major }),
  studioPush: () => post<StudioPushResponse>("/api/studio/push"),
  studioPushRetry: (happenDay: string) =>
    post<StudioPushResponse>("/api/studio/push/retry", { happenDay }),
};
