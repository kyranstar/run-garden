import type {
  CorosSyncState,
  CalendarSyncState,
  CompletionState,
  GardenConditionWord,
  GardenEvent,
  GardenWeatherState,
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
};
