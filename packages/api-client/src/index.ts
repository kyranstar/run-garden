import type {
  AdaptiveConfig,
  CorosSyncState,
  CalendarSyncState,
  CompletionState,
  GardenConditionWord,
  GardenEvent,
  GardenWeatherState,
  LiftingPlan,
  PlanBrief,
  ReadinessVerdict,
  SessionMode,
  SyncAction,
  UserPreferences,
  WatchCoverageView,
  WorkoutSyncView,
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
import type { Alternative, BlockId, ExerciseRecord, FormatId, Step, Swaps, Target } from "@rg/session-engine";

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

/**
 * No deadline at all — for a request the UI FIRES rather than waits on.
 *
 * The coach's wake thinks for minutes inside its own request (a detached
 * `waitUntil` is cancelled seconds after the response — measured in prod,
 * 2026-08-17), and an abort is the one thing that could cut that thinking
 * short: the worker demonstrably keeps working after the client goes away,
 * but not after the connection is torn down. So these are sent with no
 * signal, and nothing in the UI depends on them settling — the reply arrives
 * through `coachState`'s `coachThinking` poll instead.
 */
export const NO_DEADLINE = null;

async function request<T>(
  path: string,
  init?: RequestInit,
  timeoutMs: number | null = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    signal: timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs),
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
export const post = <T>(path: string, body?: unknown, timeoutMs?: number | null) =>
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
  /** Where the row came from: program | on_demand for the app's own sessions; null for rows not yet labelled. */
  origin?: string | null;
  /** How far an app session's content has got; null for rows that have none. */
  contentState?: "outline" | "built" | "started" | "done" | null;
  /** The program a program or on-demand row belongs to; null otherwise. */
  programId?: string | null;
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
  /** The row carries a COROS watch address. Absent otherwise. */
  hasWatchAddress?: boolean;
  /** The APP put this session on the watch (verified create + address, writes
   * on), so removing it takes it back off the watch. Absent for imported,
   * never-pushed and already-unpushed sessions — whose watch copy a remove
   * leaves alone. */
  appPushed?: boolean;
  /** Derived per-workout view (sync-transparency Task 10) — `corosSyncState`'s
   * vocabulary plus `content_stale`, the one value only a derivation can
   * produce (see `WorkoutSyncView`). Computed fresh from the open content
   * intent + in-flight/failed jobs rather than echoed from the stored column.
   * Optional: absent on any DTO a route hasn't opted into deriving. */
  corosSyncView?: WorkoutSyncView;
  /**
   * WHAT THE WATCH WILL SHOW — coverage plus enumerated reasons, computed by
   * the same rules that decide the push (`@rg/domain` watch-coverage.ts), so
   * the disclosure cannot drift from the wire.
   *
   * ABSENT is the common case and means "nothing to disclose": either the
   * whole session crosses, or its content came from COROS in the first place.
   * A normal synced run therefore carries this field never, and is exactly as
   * quiet as it was before the field existed.
   */
  watchCoverage?: WatchCoverageView;
  /**
   * WHAT TO DO ABOUT IT — the agent (`app` / `athlete` / `nobody`), the code the
   * copy keys off, and the control that genuinely performs it, if any
   * (`@rg/domain` sync-action.ts).
   *
   * The two fields above say THAT something is off; this one is the half the
   * athlete asked for. ABSENT means there is nothing to do, which is every
   * fully-synced session and every session whose day has passed — so this field
   * never makes a healthy card noisier.
   */
  syncAction?: SyncAction;
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
  /** Every live row dated today, by time. `build` is the app session's current build, when it has one. */
  todaySessions: Array<{
    workout: WorkoutDto;
    build: { mode: "recovery" | "consistent" | "build"; theme: string | null; minutes: number } | null;
  }>;
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
      /** COROS's "hours until fully recovered", stamped on the current day
       * only (sleep/recovery 0020). */
      fullRecoveryHours?: number | null;
    } | null;
    baseline: { restingHeartRate: number | null; hrv: number | null } | null;
    sampleDays: number;
    /** The server's one judgement on those numbers — null when the evidence
     * is too thin to have one, in which case surfaces show nothing at all. */
    verdict: ReadinessVerdict | null;
    /** The athlete's own sleep-HRV band (COROS base ± sd), when known —
     * what "usually" means, said precisely. */
    band?: { lo: number; hi: number } | null;
    /** Last 7 nights ending today, oldest first; "gap" = no reading. */
    nights?: Array<{ date: string; state: "settled" | "low" | "gap" }>;
    /** Last night's sleep, when a record exists (prod: only after the sleep
     * connection ships; fixtures carry it today). */
    sleep?: { durationSeconds: number; deepSeconds: number | null; remSeconds: number | null } | null;
  };
  /** The coach's own weekly action line, already gated by the 72h staleness
   * rule server-side (absent/stale → null). It was written about the WEEK,
   * never about today's readiness — surfaces must label and date it. */
  focus: { text: string; at: string } | null;
  /** The streak band (System 1): exactly 12 ISO weeks oldest-first (last is
   * always the current week), a 12-week adherence percentage (null until
   * anything has resolved), and the garden's own consistency streak. */
  consistency: {
    weeks: Array<{ weekStart: string; band: "full" | "partial" | "quiet" | "current" }>;
    adherencePct: number | null;
    streakWeeks: number;
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
  /** Set while a restore has begun and not finished. */
  restore: RestoreStatus | null;
}

/** An unfinished restore: when it began, and the file it was restoring. */
export interface RestoreStatus {
  restoreId: string;
  startedAt: string | null;
  /** When its begin or last page arrived. */
  heartbeatAt: string | null;
  /** Still running (a page arrived under two minutes ago) — on this device
   * or another — rather than abandoned. */
  running: boolean;
  fileExportedAt: string | null;
  fileExportedFrom: string | null;
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
  /** `rejected` = the guardrails found something FATAL in it and the coach's
   * convergence retries could not fix it. Kept, inspectable, never
   * approvable — the draft is not lost, it just cannot be applied. */
  status: "pending" | "approved" | "declined" | "superseded" | "expired" | "rejected";
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string | null;
  /** workoutId → the plan's state when this APPLIED (manifest 0019) —
   * settled cards read this, never the live plan. */
  appliedRefs?: Record<string, { date?: string; summary?: string; durationMinutes?: number }> | null;
  /** Rendered selector intents — "every strength session, 22 Sep – 1 Nov".
   * The ops below are already expanded, so this is the only thing that says
   * twelve lines were one request. */
  selectors?: string[] | null;
  /** What a structural proposal assumes to be true, shown above the approve
   * button so the assumption can be rejected without the plan. */
  premise?: string | null;
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
  /** `mobility` exists: the coach files a mobility one-off in its own bucket
   * rather than stretching the running plan's dates, and that row reaches this
   * DTO. It was typed `"run" | "lift"` while the wire carried a third value. */
  discipline: "run" | "lift" | "mobility";
  name: string;
  status: "draft" | "active" | "completed" | "retired";
  startDate: string;
  endDate: string;
  raceDate: string | null;
  /** Who authored it: the coach, the Studio (lifting plans written to
   * COROS), or COROS itself (imported plans — read-only cards). Absent in
   * older payloads — treat as "coach". */
  source?: "coach" | "studio" | "coros";
  /**
   * `block` — a training block: a planned duration, weeks, a week counter, a
   * progress bar. `loose` — a container for one-off sessions that landed
   * outside every block ("Coach one-offs"): it has CONTENTS, not a duration,
   * and none of that vocabulary applies to it. Absent in older payloads —
   * treat as "block". */
  kind?: "block" | "loose";
  /** What a `loose` container holds. The row's own dates only record where its
   * one-offs happen to fall, so this is what the UI renders instead. */
  holds?: {
    sessions: number;
    done: number;
    firstDate: string | null;
    lastDate: string | null;
  };
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
  /** Every proposal a receipt in `messages` refers to, whatever its status —
   * so a settled card (approved, declined, expired, replaced, rejected) keeps
   * its manifest across a reload instead of degrading to a title. */
  settledProposals?: CoachProposalDto[];
  openQuestion: CoachQuestionDto | null;
  memoryCount: number;
  lastCoachAt: string | null;
  wakeAdvised: boolean;
  /** A wake is running (or a reply is still owed) server-side — survives
   * page navigation where the client's own mutation state cannot. */
  coachThinking?: boolean;
}

export interface CoachWakeResult {
  /** Arrives when the wake is FINISHED — minutes, possibly never (see
   * `NO_DEADLINE`). Useful when it lands; nothing waits for it. */
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
  /** Sessions Run Garden has rewritten since COROS was last given them.
   * Deliberately NOT part of `issueCount` or of `state`: there is no
   * content-write job, so the Retry button cannot act on it. The line says it;
   * nothing badges it. Optional so an older worker's payload still parses. */
  contentStaleCount?: number;
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

// ── Programs (worker route: apps/worker/src/routes/programs.ts) ──────────────

/** One core lift of a program's current block. */
export interface ProgramCoreLiftDto {
  /** A core family id: squat, hinge, row, press, carry. */
  family: string;
  /** Null = no lift for the family yet. */
  exerciseId: string | null;
  /** The lift's library name; null with no lift, or one the library no longer has. */
  name: string | null;
}

/** Exact shape of each program in `GET /api/programs`, and of `{program}` from POST and PATCH. */
export interface ProgramDto {
  id: string;
  kind: "adaptive";
  name: string;
  status: "active" | "retired";
  config: AdaptiveConfig;
  /** The latest block; null before the first build starts one. */
  block: { number: number; week: number; weeks: number; core: ProgramCoreLiftDto[] } | null;
  /** This ISO week, by where each slot sits now: live slots, the ones done, and the weekly goal. */
  week: { placed: number; done: number; goal: number };
}

/** `PATCH /api/programs/:id`: only what is sent changes; `config` keys are merged over the stored config. */
export interface ProgramPatch {
  name?: string;
  config?: Partial<AdaptiveConfig>;
  status?: "active" | "retired";
}

// ── Sessions (worker routes: apps/worker/src/routes/sessions.ts; service: services/session-build.ts) ──────────

/**
 * A condition profile's answer before a session: 0–10 (null = no number) and "feeling off". `{pre: null,
 * feelingOff: false}` is no answer: sent to a build, it records nothing and clears the slot's own pre-check, so the
 * day's check (if any) stands.
 */
export interface SessionCheckAnswer {
  pre: number | null;
  feelingOff: boolean;
}

/** The day's overrides for a session. */
export interface SessionOverrides {
  mode?: SessionMode;
  /** A theme id. */
  theme?: string;
  /** 10–90. */
  minutes?: number;
  locationId?: string;
}

/**
 * `POST /api/sessions/:workoutId/build`. Checks are recorded as the slot's pre-checks. Overrides and swaps left
 * out keep the day's stored ones; new overrides drop the swaps. Each swap records the slot's original move as
 * `from` (keyed by slot key).
 */
export interface BuildSessionRequest {
  checks?: Record<string, SessionCheckAnswer>;
  overrides?: SessionOverrides;
  swaps?: Swaps;
}

/** One slot of a built plan. */
export interface SessionItemDto {
  slotKey: string;
  block: BlockId;
  exerciseId: string;
  format: FormatId;
  sets: number;
  group: string | null;
  coreFamily: string | null;
  isNew: boolean;
  why: string[];
}

/** A library record as the sheet and player need it, offline. */
export type SessionExerciseDto = Omit<ExerciseRecord, "providers">;

/** Exact shape of a session's build (programme spec §7.3). */
export interface SessionBuildDto {
  /** What a performed session names as its build. */
  buildId: string;
  /** 0 = a preview of a day ahead (never lockable); 1, 2, … = the day's builds. */
  version: number;
  engineVersion: string;
  inputsHash: string;
  builtAt: string;
  date: string;
  mode: SessionMode;
  modeReasons: string[];
  theme: string | null;
  themeReasons: string[];
  minutes: number;
  locationId: string;
  blockRef: string | null;
  weekOfBlock: number | null;
  plannedSeconds: number;
  steps: Step[];
  items: SessionItemDto[];
  /** Every move in the plan and in its alternatives, with its how-to text. */
  exercises: Record<string, SessionExerciseDto>;
  /** Per slot key, the moves it can take now (never 👎-rated or "not for me" ones). Empty = hide ⇄. */
  alternatives: Record<string, Alternative[]>;
  targets: Record<string, Target>;
  newMove: string | null;
  /** The day's choices this build was made with. */
  params: { checks: Record<string, SessionCheckAnswer>; overrides: SessionOverrides; swaps: Swaps };
}

export interface SessionViewDto {
  mode: SessionMode;
  proposedMode: SessionMode;
  modeReasons: string[];
  theme: { id: string; name: string } | null;
  proposedTheme: { id: string; name: string } | null;
  themeReasons: string[];
  minutes: number;
  location: { id: string; name: string };
  block: { number: number; week: number; weeks: number; core: { family: string; name: string | null }[]; events: string[] } | null;
  /** The exercise id introduced today. */
  newMove: string | null;
}

/**
 * Exact shape of `GET /api/sessions/:workoutId` and of a build or start. Errors: 404 `not_found`; 409
 * `{error: "not_today", date, today}`, `{error: "locked", session}`, `{error: "not_built"}`, and for a start
 * `{error: "stale", session}` (the fresh build to show); 422 `invalid_build`, `invalid_start` or `unknown_profile`.
 */
export interface SessionDto {
  workoutId: string;
  date: string;
  contentState: "outline" | "built" | "started" | "done";
  locked: boolean;
  /** The slot's day's checks per profile: its own pre-checks, else today's daily check. */
  checks: Record<string, SessionCheckAnswer>;
  build: SessionBuildDto | null;
  view: SessionViewDto | null;
}

/** A day's condition check (`POST /api/conditions/checks`); null while a restore is replacing the account. */
export interface ConditionCheckDto {
  profileId: string;
  date: string;
  value: number | null;
  feelingOff: boolean;
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
  // A wake runs INSIDE its request and takes minutes, so these carry no
  // deadline (2026-08-17): the old 320s budget was the athlete's patience
  // acting as the ceiling on the coaching, and its abort was the only thing
  // that could actually cut a live wake short. Fire, then watch
  // `coachState().coachThinking`.
  coachWake: (force = false) => post<CoachWakeResult>("/api/coach/wake", { force }, NO_DEADLINE),
  coachMessage: (body: string) => post<CoachWakeResult>("/api/coach/message", { body }, NO_DEADLINE),
  coachAnalyze: (activityId: string, force = false) =>
    post<CoachAnalyzeResult>(`/api/coach/analyze/${activityId}`, { force }, 320_000),
  /** A cached read or null — never generates, never spends (System 2). */
  coachReadPeek: (activityId: string) =>
    get<{ read: CoachAnalyzeResult["read"] | null }>(`/api/coach/analyze/${activityId}`),
  coachApprove: (proposalId: string) =>
    post<{ ok: boolean }>(`/api/coach/proposals/${proposalId}/approve`),
  coachDecline: (proposalId: string) =>
    post<{ ok: boolean }>(`/api/coach/proposals/${proposalId}/decline`),
  coachAnswerQuestion: (questionId: string, answer: string) =>
    post<{ ok: boolean }>(`/api/coach/questions/${questionId}/answer`, { answer }, NO_DEADLINE),
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
  /** The official-MCP sleep connection (sleep/recovery phase 2); connect is a
   * full-page redirect to /api/auth/coros-mcp/start, never an XHR. */
  corosMcpDisconnect: () => post<{ ok: boolean }>("/api/auth/coros-mcp/disconnect", {}),
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

  // ── Programs (worker routes: apps/worker/src/routes/programs.ts) ─────────
  listPrograms: () => get<{ programs: ProgramDto[] }>("/api/programs"),
  /** Missing config keys take their defaults. 422 `{error, issues}` for an invalid body. */
  createProgram: (body: { name: string; config: Partial<AdaptiveConfig> }) =>
    post<{ program: ProgramDto }>("/api/programs", body),
  updateProgram: (id: string, patch: ProgramPatch) =>
    request<{ program: ProgramDto }>(`/api/programs/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  // ── Sessions (worker routes: apps/worker/src/routes/sessions.ts) ─────────
  getSession: (workoutId: string) => get<SessionDto>(`/api/sessions/${encodeURIComponent(workoutId)}`),
  buildSession: (workoutId: string, body: BuildSessionRequest = {}) =>
    post<SessionDto>(`/api/sessions/${encodeURIComponent(workoutId)}/build`, body),
  /**
   * Lock the build the athlete was shown. 409 `{error: "stale", session}` when it is no longer the one the day's inputs
   * make (a check, a save or an edit since): show `session` and Start again with its build id.
   */
  startSession: (workoutId: string, buildId: string) =>
    post<SessionDto>(`/api/sessions/${encodeURIComponent(workoutId)}/start`, { buildId }),
  recordCheck: (body: { profileId: string; value: number | null; feelingOff?: boolean }) =>
    post<{ check: ConditionCheckDto | null }>("/api/conditions/checks", body),
};

// ── Account export / restore (worker: services/account-export.ts, account-restore.ts)

export const EXPORT_FORMAT = "run-garden-export";

export interface ExportManifest {
  format: typeof EXPORT_FORMAT;
  schemaVersion: string;
  /** The app the export is taken from (its origin). */
  exportedFrom?: string | null;
  tables: Array<{ name: string; rows: number }>;
}

export interface ExportTablePage {
  rows: Array<Record<string, unknown>>;
  /** Opaque keyset cursor for the next page; null on the last one. */
  nextCursor: string | null;
}

/** The downloaded file: every account table, keyed by SQL table name. */
export interface AccountExportFile {
  format: typeof EXPORT_FORMAT;
  schemaVersion: string;
  exportedAt: string;
  /** The app the file came from (its origin). Older exports lack it. */
  exportedFrom?: string;
  tables: Record<string, Array<Record<string, unknown>>>;
}

export interface RestoreProgress {
  done: number;
  total: number;
  table: string | null;
}

/** Rows per restore request — a page the worker inserts well inside its
 * per-request query budget, even for the widest table. */
const RESTORE_PAGE_ROWS = 200;

/** One table, every page, following the worker's keyset cursor. */
async function exportTableRows(name: string): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  let after: string | null = null;
  do {
    const query: string = after === null ? "" : `?after=${encodeURIComponent(after)}`;
    const page: ExportTablePage = await get<ExportTablePage>(
      `/api/settings/export/table/${encodeURIComponent(name)}${query}`,
    );
    rows.push(...page.rows);
    after = page.nextCursor;
  } while (after !== null);
  return rows;
}

/**
 * Every table of the signed-in account, page by page, as one object. Each
 * table's row count is checked against the manifest; a table that came back
 * short is read once more (rows removed mid-export legitimately shrink it —
 * the second read settles which it was). Garden tables come last, in the
 * manifest's order.
 */
export async function exportAccountData(): Promise<AccountExportFile> {
  const manifest = await get<ExportManifest>("/api/settings/export/manifest");
  const tables: AccountExportFile["tables"] = {};
  for (const { name, rows: expected } of manifest.tables) {
    let rows = await exportTableRows(name);
    if (rows.length < expected) rows = await exportTableRows(name);
    tables[name] = rows;
  }
  return {
    format: EXPORT_FORMAT,
    schemaVersion: manifest.schemaVersion,
    exportedAt: new Date().toISOString(),
    ...(manifest.exportedFrom ? { exportedFrom: manifest.exportedFrom } : {}),
    tables,
  };
}

/** The whole account as a JSON file body. */
export async function exportAccount(): Promise<Blob> {
  const data = await exportAccountData();
  return new Blob([JSON.stringify(data)], { type: "application/json" });
}

/** `run-garden-export-YYYY-MM-DD.json`, dated in the device's own zone. */
export function exportFileName(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `run-garden-export-${y}-${m}-${d}.json`;
}

/** Thrown by `readExportFile` for a file that is not a Run Garden export. */
export class NotAnExportError extends Error {
  constructor() {
    super("not_an_export");
  }
}

/** Parse and shape-check an export file, locally — no request is made. */
export async function readExportFile(file: Blob): Promise<AccountExportFile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new NotAnExportError();
  }
  const f = parsed as Partial<AccountExportFile> | null;
  if (
    !f ||
    typeof f !== "object" ||
    f.format !== EXPORT_FORMAT ||
    typeof f.schemaVersion !== "string" ||
    typeof f.exportedAt !== "string" ||
    !f.tables ||
    typeof f.tables !== "object" ||
    Object.values(f.tables).some((rows) => !Array.isArray(rows))
  ) {
    throw new NotAnExportError();
  }
  return f as AccountExportFile;
}

/** What the worker restores, in order, and what an export carries that a
 * restore deliberately leaves out. */
export interface RestoreTablesResponse {
  schemaVersion: string;
  tables: string[];
  skip: string[];
}

/** One problem the check found in the file. `row` is the row's index within
 * its table (-1 for the table as a whole); `message` is plain text. */
export interface RestoreRowError {
  table: string;
  row: number;
  column?: string;
  code: string;
  message: string;
}

type CheckPageResult =
  | { ok: true; token: string; rows: number }
  | { ok: false; errors: Array<Omit<RestoreRowError, "table">> };

/** A file every page of which the worker checked clean — what begin needs. */
export interface CheckedRestore {
  schemaVersion: string;
  /** The signed check session (the file's manifest) begin needs. */
  session: string;
  /** The restore this check clears — begin's id, and Start fresh's. */
  restoreId: string;
  /** Tables in the worker's restore order, each with its checked pages. */
  pages: Array<{ table: string; rows: Array<Record<string, unknown>>; token: string }>;
  /** Rows the file holds per table the worker restores. */
  fileCounts: Record<string, number>;
  total: number;
}

export type RestoreCheck = { ok: true; checked: CheckedRestore } | { ok: false; errors: RestoreRowError[] };

/** Errors worth showing: the first few say what is wrong. */
const CHECK_ERROR_LIMIT = 5;

/**
 * Check every page of a parsed export with the worker — no side effects, the
 * account is untouched — and collect the page tokens begin will need. The
 * check runs in a session that signs the file's manifest (rows per table the
 * worker restores, every one named) and the account it came from, so begin
 * can insist on exactly this file, whole. Stops early once it has a handful
 * of errors to show.
 */
export async function checkRestore(
  data: AccountExportFile,
  onProgress?: (p: RestoreProgress) => void,
): Promise<RestoreCheck> {
  const plan = await get<RestoreTablesResponse>("/api/settings/restore/tables");
  const skip = new Set(plan.skip);
  const order = [
    ...plan.tables.filter((t) => t in data.tables),
    ...Object.keys(data.tables).filter((t) => !plan.tables.includes(t) && !skip.has(t)),
  ];
  const total = order.reduce((n, t) => n + (data.tables[t]?.length ?? 0), 0);
  const pages: CheckedRestore["pages"] = [];
  const fileCounts: Record<string, number> = {};
  const errors: RestoreRowError[] = [];
  const sourceUserId = data.tables.users?.[0]?.id;
  const started = await post<{ ok: true; session: string; restoreId: string } | { ok: false; errors: Array<Omit<RestoreRowError, "table">> }>(
    "/api/settings/restore/check/start",
    {
      schemaVersion: data.schemaVersion,
      manifest: Object.fromEntries(plan.tables.map((t) => [t, data.tables[t]?.length ?? 0])),
      sourceUserId: typeof sourceUserId === "string" ? sourceUserId : null,
      exportedAt: data.exportedAt,
      exportedFrom: data.exportedFrom ?? null,
    },
  );
  if (!started.ok) return { ok: false, errors: started.errors.map((e) => ({ ...e, table: "" })) };
  let done = 0;
  onProgress?.({ done, total, table: null });
  for (const table of order) {
    const rows = data.tables[table] ?? [];
    const known = plan.tables.includes(table);
    if (known) fileCounts[table] = rows.length;
    const offsets: number[] = [];
    for (let i = 0; i < rows.length; i += RESTORE_PAGE_ROWS) offsets.push(i);
    // A table the worker does not restore is sent even when it is empty, so
    // the check can say what it is.
    if (offsets.length === 0 && !known) offsets.push(0);
    for (const offset of offsets) {
      const page = rows.slice(offset, offset + RESTORE_PAGE_ROWS);
      const res = await post<CheckPageResult>(
        "/api/settings/restore/check",
        { session: started.session, table, rows: page, offset },
        120_000,
      );
      if (res.ok) pages.push({ table, rows: page, token: res.token });
      else {
        errors.push(...res.errors.map((e) => ({ ...e, table })));
        if (errors.length >= CHECK_ERROR_LIMIT) return { ok: false, errors: errors.slice(0, CHECK_ERROR_LIMIT) };
      }
      done += page.length;
      onProgress?.({ done, total, table });
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    checked: { schemaVersion: data.schemaVersion, session: started.session, restoreId: started.restoreId, pages, fileCounts, total },
  };
}

/** A table that came back with fewer rows than the file holds. */
export interface ShortTable {
  table: string;
  expected: number;
  restored: number;
}

export interface RestoreSummary {
  counts: Record<string, number>;
  /** Tables whose restored count is below the file's — named to the athlete. */
  short: ShortTable[];
  /** Rows the worker reported lost to a conflict. */
  lost: number;
}

/**
 * Replace the signed-in account with a checked file: begin (which wipes the
 * account and disconnects COROS and Google Calendar), every checked page in
 * the worker's order, then finish. The finish counts are compared with the
 * file here too, so a table that came back short is named rather than
 * reported as "Restored". Rejects with `ApiError` on any refusal — a 422
 * `insert_failed` names the table and row.
 */
export async function runRestore(
  data: AccountExportFile,
  checked: CheckedRestore,
  onProgress?: (p: RestoreProgress) => void,
): Promise<RestoreSummary> {
  const begun = await post<{ restoreId: string; tables: string[] }>("/api/settings/restore/begin", {
    session: checked.session,
    replace: true,
    tokens: checked.pages.map((p) => p.token),
  });
  let done = 0;
  let lost = 0;
  onProgress?.({ done, total: checked.total, table: null });
  for (const table of begun.tables) {
    for (const page of checked.pages.filter((p) => p.table === table)) {
      const res = await post<{ received: number; skipped: number; lost: number }>(
        "/api/settings/restore/rows",
        { restoreId: begun.restoreId, table, rows: page.rows, token: page.token },
        120_000,
      );
      lost += res.lost ?? 0;
      done += page.rows.length;
      onProgress?.({ done, total: checked.total, table });
    }
  }
  const finished = await post<{ counts: Record<string, number>; short: ShortTable[] }>(
    "/api/settings/restore/finish",
    { restoreId: begun.restoreId },
    120_000,
  );
  const short = new Map<string, ShortTable>((finished.short ?? []).map((s) => [s.table, s]));
  for (const table of begun.tables) {
    const expected = checked.fileCounts[table] ?? 0;
    const restored = finished.counts[table] ?? 0;
    if (restored < expected && !short.has(table)) short.set(table, { table, expected, restored });
  }
  return { counts: finished.counts, short: [...short.values()], lost };
}

/** Abandon a restore that didn't finish: wipe the account, clear the notice.
 * Refused (409 `restore_running`) while it is still running elsewhere; the
 * device that ran it names its restore id to start fresh at once. */
export const restoreStartFresh = (restoreId?: string) =>
  post<{ ok: true }>("/api/settings/restore/start-fresh", restoreId ? { restoreId } : {});

/** One previously generated plan + the brief (prompt) that produced it. */
export interface StudioHistoryEntryDto {
  id: string;
  name: string;
  weeks: number | null;
  version: number;
  createdAt: string;
  brief: PlanBrief;
}
