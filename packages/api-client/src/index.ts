import type {
  AdaptiveConfig,
  CorosSyncState,
  CalendarSyncState,
  CompletionState,
  GardenConditionWord,
  GardenEvent,
  GardenWeatherState,
  LiftingPlan,
  ObjectiveCreate,
  ObjectiveDto,
  ObjectiveProgressDto,
  ObjectiveUpdate,
  PerformedEntry,
  PerformedSessionWire,
  PerformedSet,
  PlanBrief,
  ProfileDto,
  ProfileUpdate,
  ReadinessVerdict,
  SessionLead,
  SessionMode,
  SyncAction,
  UserPreferences,
  WatchCoverageView,
  Weight,
  WorkoutDoc,
  WorkoutSyncView,
} from "@rg/domain";
import type {
  AerobicEfficiencyValue,
  ConditionTrendValue,
  ConsistencyReport,
  DecouplingValue,
  Discipline,
  EvidenceCard,
  InterpretedMetric,
  LiftTopSetsValue,
  MetricResult,
  StoredRecord,
  WeeklyTrainingReport,
  WeeklyVolumeValue,
} from "@rg/analytics";
import type {
  Alternative,
  Block,
  BlockId,
  ExerciseRecord,
  FormatId,
  HistorySession,
  RecordsState,
  Step,
  Swaps,
  Target,
} from "@rg/session-engine";

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
  /**
   * Where the row came from: program | on_demand | studio | template for the app's own sessions (studio and template
   * rows are document workouts, played from their document); null for rows not yet labelled.
   */
  origin?: string | null;
  /** How far an app session's content has got; null for rows that have none. */
  contentState?: "outline" | "built" | "started" | "done" | null;
  /** The program an app session belongs to (a Studio or template row: the account's Studio programme); null otherwise. */
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
    /** `place` = the build's place name; `lead` = its moves in one line (`sessionLead`). Either is absent only for a
     * stored build that lacks what it reads. */
    build: {
      mode: "recovery" | "consistent" | "build";
      theme: string | null;
      minutes: number;
      place?: string;
      lead?: SessionLead;
      /** A document workout's effort: said in place of the mode. */
      effort?: WorkoutDoc["intent"]["effort"];
    } | null;
    /**
     * The session's sent build is on the watch (Phase 3): its push verified and the row holding the copy's address.
     * Today marks it "On your watch". False while the switch is off; absent from a payload cached before Phase 3.
     */
    onWatch?: boolean;
  }>;
  /**
   * "Log your session" (Phase 3): today's and yesterday's sessions done on the watch whose quick review is offered —
   * the program's name, the session's day, how long the watch session ran. Empty while the switch is off; absent from a
   * payload cached before Phase 3.
   */
  watchReviews?: Array<{ workoutId: string; title: string; date: string; seconds: number; category: string }>;
  /** The condition chips: switched-on profiles with today's reading; empty without an active program. */
  conditions: Array<ConditionViewDto & { today: { value: number | null; feelingOff: boolean } | null }>;
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
  /** Average heart rate, when a watch recorded one — the watch's on a merged app + watch row; never an import's. */
  avgHeartRate?: number | null;
  /** Self-reported feel 1-5 from the watch, when present. */
  feel: number | null;
  /** Compact lap profile (seconds + pace per lap, in order) for the
   * pace-shape micro chart; null when fewer than two laps exist. */
  laps: Array<{ s: number; p: number | null }> | null;
  /**
   * What was logged in this session (app, watch review, import or the watch
   * itself), by exercise in the order done — names already in words, weights
   * as typed (the watch's own copy in the athlete's unit). Null when nothing was logged.
   */
  logged?: LoggedExerciseDto[] | null;
  /** The performed session behind the row (Phase 2d): where it came from and what it was. Null when there is none. */
  performed?: PerformedSummaryDto | null;
  /** The planned workout this run completed, or null if it was unplanned. */
  matched: { workoutId: string; title: string; category: string; date: string } | null;
}

/** What a performed session was, as the Activity feed shows it (worker: services/logged-sets.ts). */
export interface PerformedSummaryDto {
  /** The app's own save, a watch review, an import, or the watch's derived copy. */
  source: "app" | "watch_review" | "import" | "watch";
  mode: "recovery" | "consistent" | "build" | null;
  /** The theme's name. */
  theme: string | null;
  /** Check values around the session, labelled by the profile itself (`check.label`). */
  checks: Array<{ profileId: string; label: string; pre: number | null; post: number | null }>;
  /** Moves played with no set logged: how many, and their time. */
  played: { moves: number; seconds: number } | null;
}

/** One logged set, as the activity feed shows it. */
export interface LoggedSetDto {
  reps: number | null;
  seconds: number | null;
  /** The athlete's own record (app, watch review, import) as typed; the watch's copy in the athlete's unit. Null for a bodyweight or timed set. */
  load: { v: number; u: "lb" | "kg" } | null;
  side: "left" | "right" | null;
}

/** One exercise of a logged session and its sets. */
export interface LoggedExerciseDto {
  exerciseId: string;
  name: string;
  sets: LoggedSetDto[];
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
    /** When the AI gateway started answering 402 (out of credits), or null. */
    outOfCreditsSince?: string | null;
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

/** `GET /api/workouts/:id/doc`: a row's document and what is derived from it, or why there is none. */
export type WorkoutDocResponse =
  | { doc: WorkoutDoc; derived: { estimatedMinutes: number; discipline: string; category: string; mode: string; watchStepCount: number } & Record<string, unknown>; rev: number | null }
  | { doc: null; reason: "missing" | "invalid" };

/** One issue `validateWorkoutDoc` raises on a workout document: an error blocks, a warning is a cost shown. */
export interface DocIssueDto {
  /** Where in the document: "intent.focus[2]", "parts[1].format", "parts[1].items[0].libraryId". */
  path: string;
  code: string;
  /** Plain words for the athlete. */
  message: string;
  /** A replacement for the value at `path` (a library id, a vocabulary id, a format, an effort, or a dose as JSON). */
  fix?: string;
  severity: "error" | "warning";
}

/** A document workout as `POST /api/workouts` and `PUT /api/workouts/:id/doc` answer it. */
export interface DocWorkoutDto {
  id: string;
  date: string;
  /** "HH:MM". */
  time: string;
  title: string;
  intentSummary: string;
  category: string;
  sport: string;
  origin: "studio" | "template";
  contentState: "outline" | "built" | "started" | "done";
  completionState: string;
  docRev: number | null;
  /** Derived from the document. */
  minutes: number;
}

/** `POST /api/workouts`: a document workout for a day (today or later). `time` left out: the athlete's window. */
export interface CreateDocWorkoutRequest {
  date: string;
  time?: string | null;
  doc: WorkoutDoc;
  /** The draft's key, made once on the device: a retry with it answers the workout it made (200), never a second. */
  clientId?: string;
  /** Made to start at once (the builder's Start now): never planned, so booked on no calendar. */
  startNow?: true;
}

/**
 * 201 of `POST /api/workouts`. Errors: 422 `{error: "invalid_doc", issues}` (every issue; an error blocks),
 * `{error: "past_date"}`, `{error: "run_unsupported", message}` (a run is not planned in the Studio yet),
 * `{error: "invalid_workout"}`. For today a move the day's reading keeps out that an alternate answers is a warning
 * (its `fix` the alternate), not an error: the day's build swaps it.
 */
export interface CreateDocWorkoutResponse {
  workout: DocWorkoutDto;
  warnings: DocIssueDto[];
}

/**
 * 200 of `PUT /api/workouts/:id/doc`. `watchHasOlder`: the watch holds (or is being sent) a copy built from another
 * revision — offer "Send the new version". Errors: 409 `{error: "stale_revision", rev}` (changed elsewhere — reload),
 * `{error: "not_editable"}` (a programme's session, or one resolved or under way); 422 `invalid_doc`; 404.
 */
export interface ReviseDocWorkoutResponse {
  workout: DocWorkoutDto;
  /** The row's revision now (the same as the base when the document did not change). */
  rev: number | null;
  watchHasOlder: boolean;
  warnings: DocIssueDto[];
}

/** A move the day kept out of a document workout, and the alternate that stands in for it in today's build. */
export interface DocSwapDto {
  /** The item: "parts[0].items[2]". */
  path: string;
  from: string;
  to: string;
  /** Why the day kept `from` out. */
  reason: string;
}

/** What the player reads of one slot's item beside its steps (`DocBuildInfoDto.slots`). */
export interface DocSlotDto {
  /** The item's cue: shown under the move's name. */
  cue?: string;
  /** "To max" (`dose.max`): the slot's holds count up past their window until Done, and log the seconds held. */
  max?: true;
  /**
   * The item's planned alternates, each with the slot's steps with it in place: ⇄ offers them first — those the day
   * judges clean in the document's order, then those that cost something, the cost in their reasons.
   */
  alternates?: Alternative[];
  /** The library's usual offers for the slot, after the planned alternates: three at most, each clean on the day. */
  offers?: Alternative[];
}

/** What a document workout's build says of its document (`SessionBuildDto.fromDoc`). */
export interface DocBuildInfoDto {
  /** The revision the build was made from. */
  rev: number | null;
  swaps: DocSwapDto[];
  /** Errors still standing once the swaps are made: Start and Send refuse (409 `gated`). */
  blocked: DocIssueDto[];
  /**
   * Per slot key, what its item says that the steps do not: only slots that say something. Absent from a build made
   * before it (`doc-build-1`): nothing is said.
   */
  slots?: Record<string, DocSlotDto>;
  /** The document's effort: the sheet's and Today's word for it, never a mode's. Absent from a build stored before it. */
  effort?: WorkoutDoc["intent"]["effort"];
  /** The document's parts in play order, by purpose, each with its items' slot keys: the sheet and the player name them. */
  parts?: Array<{ purpose: WorkoutDoc["parts"][number]["purpose"]; keys: string[] }>;
  /** Per slot key, the item's dose in the builder's words ("4 × 5–8"). */
  doses?: Record<string, string>;
}

/** A saved template (`GET /api/templates`). */
export interface TemplateDto {
  id: string;
  name: string;
  /** Null when the stored document no longer reads. */
  doc: WorkoutDoc | null;
  pinned: boolean;
  uses: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Derived from the document; null without one. */
  minutes: number | null;
  discipline: string | null;
}

/** One row of `GET /api/workouts`. */
export interface WorkoutListItemDto {
  id: string;
  date: string;
  title: string;
  intentSummary: string | null;
  category: string;
  completionState: string;
  docRev: number | null;
  minutes: number;
}

/** `GET /api/settings/diagnostics/workout-docs`: counts and ids only. */
export interface WorkoutDocParityReport {
  checked: number;
  withDoc: number;
  missing: number;
  invalid: number;
  exempt: number;
  /** Rows with no source or fallback estimate: minutes not compared. */
  unestimated: number;
  /** Documents whose derived minutes are more than 50 % away from the length they state: counted, not a mismatch. */
  derivedFar: number;
  /** Rows whose latest build predates the current document: steps not compared. */
  stale: number;
  mismatched: Array<{ id: string; field: "minutes" | "discipline" | "title" | "steps" }>;
  sample: string[];
  next: string | null;
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
  /** The AI gateway answered 402 — the account is out of credits — and no call
   * has worked since (worker services/ai-credits.ts). Null when it is fine. */
  outOfCredits?: { since: string; lastSeenAt: string } | null;
}

export interface CoachWakeResult {
  /** Arrives when the wake is FINISHED — minutes, possibly never (see
   * `NO_DEADLINE`). Useful when it lands; nothing waits for it.
   * `out_of_credits` arrives at once: the AI account needs credits. */
  status: "ok" | "skipped" | "busy" | "resting" | "error" | "out_of_credits";
  coachMessageId?: string;
  proposalIds?: string[];
}

// ── The coach designer's runs (worker: services/coach-runs.ts, routes/coach-runs.ts) ──

export type CoachRunStatus =
  | "active"
  | "stepping"
  | "waiting_athlete"
  | "finished"
  | "failed"
  | "cancelled"
  | "expired"
  | "stopped_cap";
export type CoachRunRole = "main" | "designer" | "reviewer";
export interface CoachRunScope {
  kind: "now" | "later_today" | "week" | "next_n";
  /** `next_n` only. */
  n?: number;
}

export interface CoachRunDto {
  id: string;
  role: CoachRunRole;
  scope: CoachRunScope;
  /** The athlete's words. */
  request: string | null;
  /** What the run is doing now; `waiting_athlete` while any part of it waits on an answer. */
  status: CoachRunStatus;
  steps: number;
  costUsd: number;
  proposalId: string | null;
  /** Why it stopped, as a code (weekly_cap, run_ceiling, step_cap, state_cap, gateway_402, no_key, retries, refusal,
   * expired, …); the plain line is the run's last event. */
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface CoachRunEventDto {
  seq: number;
  kind: "tool_call" | "tool_result" | "draft" | "review" | "revision" | "question" | "note" | "error";
  /** One plain line for the run view. */
  summary: string;
  /** Bounded detail; a sub-run's event carries `by: { runId, role }`. */
  payload: unknown;
  at: string;
}

/** `POST /api/coach/runs`: a new run, or the athlete's live one — nothing about it changed — with what the screen can
 * offer, and the request it did not start (to offer again once the live run is cancelled). */
export type CoachRunCreateResult =
  | { run: CoachRunDto; existing: false }
  | {
      run: CoachRunDto;
      existing: true;
      offer: "answer_or_cancel" | "continue_or_cancel";
      ignoredRequest: { scope: CoachRunScope; request: string | null };
    };

export interface CoachRunStepResult {
  status: CoachRunStatus;
  /** Step again at `at`; null: nothing to step (finished, stopped, or waiting on the athlete). */
  nextDue: { runId: string; role: CoachRunRole; at: string } | null;
  events: CoachRunEventDto[];
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
  | "race_move_rejected"
  /** A sent program session changed in COROS; the app kept its version. Dismiss only (undo answers 422). */
  | "watch_copy_changed"
  /** A sent program session's copy was deleted in COROS. Dismiss only (undo answers 422). */
  | "watch_copy_removed"
  /** A sent program session's copy was moved in COROS; the slot followed it. Dismiss only (undo answers 422). */
  | "watch_copy_moved";

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
  /** Failed coach watch writes queued again — only sessions still ahead (the set the banner counts). */
  coachRetried: number;
  /** The same count, under the name the client drains on. */
  rewritesRetried?: number;
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

/** Exact shape of `GET /api/programs`: the programs, and what their settings pick from. */
export interface ProgramsResponse {
  programs: ProgramDto[];
  /** The account's places, the default first (none until places are set up). */
  places: Array<{ id: string; name: string; isDefault: boolean }>;
  /** The switched-on condition profiles; a program can care for each one with care content. */
  profiles: ConditionViewDto[];
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
  /** The session's one new or retried jump (the engine's swap state): ⇄ offers no second one elsewhere. */
  fresh?: true;
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
  /** A document workout's build (a Studio or template row): made from its document, not by the engine. */
  fromDoc?: DocBuildInfoDto;
}

export interface SessionViewDto {
  mode: SessionMode;
  proposedMode: SessionMode;
  modeReasons: string[];
  theme: { id: string; name: string } | null;
  proposedTheme: { id: string; name: string } | null;
  themeReasons: string[];
  minutes: number;
  /**
   * The place, with what the player needs of it offline: its equipment ids and its implement weights as parsed from
   * the typed list (ruling 2b-R2).
   */
  location: { id: string; name: string; equipment: string[]; implements: Record<string, Weight[]> };
  block: { number: number; week: number; weeks: number; core: { family: string; name: string | null }[]; events: string[] } | null;
  /** The exercise id introduced today. */
  newMove: string | null;
}

/**
 * Exact shape of `GET /api/sessions/:workoutId` and of a build or start. Errors: 404 `not_found`; 409
 * `{error: "not_today", date, today}`, `{error: "locked", session}`, `{error: "not_built"}`, and for a start
 * `{error: "stale", session}` (the fresh build to show); 422 `invalid_build`, `invalid_start` or `unknown_profile`.
 * A document workout's start (or send) also: 409 `{error: "gated", issues: DocIssueDto[]}` — the day's reading keeps a
 * move out that no alternate stands in for — `{error: "no_document"}`, and (a build, a preview, or a start's fresh build)
 * `{error: "too_large", issues: DocIssueDto[]}` for a stored document too large to build.
 */
export interface SessionDto {
  workoutId: string;
  date: string;
  contentState: "outline" | "built" | "started" | "done";
  locked: boolean;
  /**
   * The planned workout's own title, and its kind (`origin`): what the player names the session by on a device that
   * keeps nothing of it. Absent from a session read before them (a cached answer).
   */
  title?: string;
  origin?: string | null;
  /** The slot's day's checks per profile: its own pre-checks, else today's daily check. */
  checks: Record<string, SessionCheckAnswer>;
  build: SessionBuildDto | null;
  view: SessionViewDto | null;
  /** The switched-on condition profiles, as the sheet labels them (the pre-check, the reading, the care block). */
  profiles: ConditionViewDto[];
  /**
   * What the sheet's chips can pick: the program's modes, the themes (each with the modes it suits), the places. A
   * document workout (a Studio or template row) offers none: its document decides them.
   */
  choices: {
    modes: SessionMode[];
    themes: Array<{ id: string; name: string; modes: SessionMode[] }>;
    locations: Array<{ id: string; name: string }>;
  };
  /**
   * The session on the watch (Phase 3). The worker always sends it: null while the switch is off, and then nothing
   * about the watch renders. Optional here only because a session cached on the device before Phase 3 lacks it.
   */
  watch?: WatchStateDto | null;
}

/** Why Send to watch is not offered (`watch.reason`), and the 409 `error` of a refused send. */
export type WatchUnavailableReason =
  | "not_today"
  | "not_built"
  | "done"
  | "precheck"
  | "writes_off"
  | "not_connected"
  | "too_long"
  | "empty"
  | "taking_off"
  /** Send's 409 only: this build's copy is on the watch already (its removal failed or was neutralised) — Take off. */
  | "already_sent"
  /**
   * A document workout whose build holds a move the day's reading keeps out: never sent (first Send, Retry, or after
   * Start). Taken off or discarded, the day's build swaps in an alternate where one passes.
   */
  | "gated";

/**
 * `ready` → Send to watch; `sending` → "Sending…"; `on_watch` → "On your watch" with Take off watch; `failed` →
 * "Couldn't send" with Retry; `off_watch` (removed in COROS) and `unavailable` → nothing to send.
 */
export interface WatchStateDto {
  state: "unavailable" | "ready" | "sending" | "on_watch" | "failed" | "off_watch";
  reason?: WatchUnavailableReason;
}

/** One step as the watch will show it, read off the wire program (the preview IS the wire). */
export interface WatchPreviewStepDto {
  /** The English name of a catalog step; the free text of a move the catalog does not hold. */
  name: string;
  freeText: boolean;
  target: { kind: "reps"; reps: number } | { kind: "hold"; seconds: number } | { kind: "open" };
  /** kg × 1000 as the watch holds it; null = bodyweight. */
  grams: number | null;
  /** The same weight in the athlete's unit, beside the kg ("11.3 kg · 25 lb"). */
  load: Weight | null;
  overview: string;
  restSeconds: number;
}

/** `GET /api/sessions/:workoutId/watch-preview`. */
export interface WatchPreviewDto {
  buildId: string;
  /** The program name the watch shows: `<program> — <date>`, " (2)" for a second session that day. */
  stamp: string;
  steps: WatchPreviewStepDto[];
  freeText: number;
  /**
   * Set: no Send. `too_long` ("Too long for the watch" at the preview's foot) still lists every step; `empty` lists
   * none.
   */
  refusal: "empty" | "too_long" | null;
  /** The digest of the payload this preview rendered: Send carries it back, so what is sent is what was shown. */
  digest: string;
}

/** One move of the quick review, prefilled: what the watch logged, else the build's targets (not done). */
export interface WatchReviewEntryDto {
  exerciseId: string;
  perSide: boolean;
  format: PerformedEntry["format"];
  implement: string | null;
  sets: Array<PerformedSet & { from: "watch" | "target" }>;
}

/** `GET /api/sessions/:workoutId/watch-review`. */
export interface WatchReviewBasisDto {
  workoutId: string;
  buildId: string;
  activityId: string;
  /** The COROS activity id: the save's `sourceRef`. */
  sourceRef: string;
  /** The session's day: the save's `localDate`. */
  localDate: string;
  startedAt: string;
  endedAt: string | null;
  seconds: number;
  newMove: string | null;
  entries: Array<WatchReviewEntryDto & { name: string }>;
  /** The post-check's grid. */
  profiles: ConditionViewDto[];
  /** The session's pre-check, per profile, as it was built with ("Before 1"). */
  before: Record<string, { pre: number | null; feelingOff: boolean }>;
  /** The athlete's weight unit, for a weight typed where the watch logged none. */
  unit: "lb" | "kg";
}

/** A switched-on condition profile as the UI labels it: its check's label and scale, and its care label. */
export interface ConditionViewDto {
  profileId: string;
  check: { label: string; min: number; max: number };
  /** The care block's label; null = the profile has no care content. */
  care: string | null;
}

/** A day's condition check (`POST /api/conditions/checks`); null while a restore is replacing the account. */
export interface ConditionCheckDto {
  profileId: string;
  date: string;
  value: number | null;
  feelingOff: boolean;
}

// ── Settings: conditions and places (worker routes: routes/conditions.ts, routes/places.ts) ────────────────────

/** A condition profile the library knows, as Settings shows it — labelled by the profile itself. */
export interface ConditionSettingDto {
  profileId: string;
  label: string;
  active: boolean;
  /** The day it was first switched on (kept across off and on); null when it never was. */
  since: string | null;
}

/** A place and its gear; weights per weighted gear id exactly as typed ("10, 15, 20 lb, 12kg"). */
export interface PlaceDto {
  id: string;
  name: string;
  equipment: string[];
  implements: Record<string, string>;
  isDefault: boolean;
}

/** Exact shape of `GET /api/places`: the places (default first) and the gear vocabulary, labelled. */
export interface PlacesResponse {
  places: PlaceDto[];
  equipment: Array<{ id: string; label: string; weighted: boolean }>;
}

/** `POST /api/places`; `PATCH` takes any part of it (`implements` replaced whole). 422 `invalid_place`. */
export interface PlaceInput {
  name: string;
  equipment: string[];
  implements?: Record<string, string>;
  isDefault?: true;
}

// ── Import (worker route: routes/imports.ts; service: services/standalone-import.ts) ───────────────────────────

/**
 * Exact shape of `POST /api/import/provenance` (services/provenance-import.ts; with or without `?dryRun=1`): counts
 * only — a saved post's link or creator never comes back.
 */
export interface ProvenanceImportSummaryDto {
  dryRun: boolean;
  /** Links in the file (one per source). */
  items: number;
  /** Library moves those links name. */
  moves: number;
  added: number;
  updated: number;
  unchanged: number;
  /** Links whose move this library doesn't have — left out. */
  unknownMoves: number;
}

/** Exact shape of `POST /api/import/standalone` (with or without `?dryRun=1`: the same summary). */
export interface StandaloneImportSummaryDto {
  dryRun: boolean;
  /** This import brings the tool's settings (program, block, places, preferences, condition, units, wishlist). */
  firstImport: boolean;
  sessions: {
    total: number;
    added: number;
    alreadyImported: number;
    /** The file's readable sessions, first and last day. */
    firstDate: string | null;
    lastDate: string | null;
    /** The sessions this import adds, first and last day (null when it adds none). */
    addedFirstDate: string | null;
    addedLastDate: string | null;
    invalid: Array<{ index: number; id: string | null; reason: string }>;
  };
  unknownMoves: number;
  /**
   * What the import does to the adaptive program (ruling 2d-R5): `created` the tool's program (`name`), `adopted` the
   * file's block into the athlete's program (`name`, its own settings kept), `kept` nothing (`name` when the account
   * has exactly one active program). A later import always keeps.
   */
  program: { outcome: "created" | "adopted" | "kept"; name: string | null };
  /** The weight unit before and after the import (ruling 2d-R6). */
  weightUnit: { before: "lb" | "kg"; after: "lb" | "kg" };
  /** The file's places the import writes, by name. */
  places: string[];
  /** Move ratings the import writes. */
  ratings: number;
  block: { number: number; week: number; weeks: number } | null;
  dropped: string[];
  written: {
    sessions: number;
    sets: number;
    checks: number;
    activities: number;
    program: number;
    block: number;
    places: number;
    prefs: number;
    condition: number;
    preferences: number;
  };
  /** The standalone tool's own numbers over the file, as its Progress tab shows them, to hold side by side with it. */
  oracle: {
    /** The unit the tool's Progress tab shows weights in (the tool's own setting). */
    unit: "lb" | "kg";
    sessionCount: number;
    /** The last eight weeks, oldest first, by their Mondays. */
    sessionsPerWeek: Array<{ week: string; sessions: number }>;
    /** Whole kilos as the tool keeps them, and the whole number in `unit` its Progress tab shows. */
    weeklyVolume: Array<{ week: string; kg: number; inUnit: number }>;
    /** `latest` is the number on the tool's lift tile: the last session's top set, weight as typed. */
    bestByCoreLift: Array<{
      family: string;
      exerciseId: string;
      name: string;
      best: { w: Weight | null; reps: number | null; secs: number | null } | null;
      latest: { date: string; w: Weight | null; reps: number | null; secs: number | null } | null;
    }>;
    /** Records as the Progress tab lists them: new bests and milestones, never a first time. */
    records: number;
    prePostPairs: number;
    block: { number: number; week: number } | null;
  };
}

// ── Library (worker routes: apps/worker/src/routes/library.ts; service: services/library-view.ts) ──────────────

/**
 * A move's standing with one switched-on profile: `safe` even on a flare day, `care` allowed with limits (a mode, a
 * calm check), `never` not allowed.
 */
export type LibrarySafety = "safe" | "care" | "never";

/** `GET /api/library` filters. Every one is optional; values outside the vocabularies are 422 `invalid_query`. */
export interface LibraryQuery {
  q?: string;
  pattern?: string;
  region?: string;
  role?: string;
  equipment?: string;
  /** A place id of the account's, or one of the library's presets (home, gym, mat). */
  location?: string;
  /** Only moves safe on a flare day for every switched-on profile. */
  safe?: boolean;
  purpose?: string;
  tag?: string;
  theme?: string;
  /** A muscle the move works, primary or secondary. */
  muscle?: string;
  contraction?: string;
  position?: string;
  laterality?: string;
  maxDifficulty?: number;
  /** Default 50, at most 200. */
  limit?: number;
}

/** One move as the library list shows it (no how-to text). */
export interface LibraryRowDto {
  id: string;
  name: string;
  family: string;
  patterns: string[];
  regions: string[];
  roles: string[];
  equipment: { all: string[]; oneOf: string[] };
  difficulty: number;
  /** The card line. */
  summary: string;
  purposes: string[];
  contraction: string[];
  tags: string[];
  primaryMuscles: string[];
  /** The latest day this athlete did it, or null. */
  lastDoneOn: string | null;
  /** Sessions with it in the last 30 days. */
  timesDone30d: number;
  /**
   * Done CLEANLY — the library's one rule for what unlocks the next rung (`isDoneCleanly`): done, and logged at least
   * once without a switched-on profile's set flag. The builder judges a jump's frontier with it (`DayContext.done`).
   */
  doneCleanly: boolean;
  /** Per switched-on profile id. */
  safety: Record<string, LibrarySafety>;
  rating: 1 | -1 | null;
  excluded: boolean;
  pinned: boolean;
  /** From the account's saves. */
  saved: boolean;
  /** The gear the default place lacks for it (any one of `oneOf`); null when it can be done there now. */
  unlocksWith: { all: string[]; oneOf: string[] } | null;
}

/** Exact shape of `GET /api/library`. */
export interface LibraryListDto {
  /** Moves in the library before filters. */
  total: number;
  /** Moves that matched the filters, before the limit. */
  matched: number;
  items: LibraryRowDto[];
  /** The place `unlocksWith` and the wishlist are judged at. */
  place: { id: string; name: string };
  profiles: Array<{ profileId: string; label: string }>;
  wishlist: Array<{ equipmentId: string; label: string; unlocks: number }>;
}

/** The athlete's say on one move (`exercise_prefs`). */
export interface ExercisePrefsDto {
  exerciseId: string;
  rating: 1 | -1 | null;
  excluded: boolean;
  pinned: boolean;
  introducedOn: string | null;
}

/** `PUT /api/library/:id/prefs`: only what is sent changes. */
export interface ExercisePrefsPatch {
  rating?: 1 | -1 | null;
  excluded?: boolean;
  pinned?: boolean;
}

/** Exact shape of `GET /api/library/:id`. */
export interface LibraryItemDto {
  id: string;
  name: string;
  family: string;
  patterns: string[];
  regions: string[];
  roles: string[];
  equipment: { all: string[]; oneOf: string[] };
  position: string;
  laterality: string;
  load: string;
  dose: ExerciseRecord["dose"];
  difficulty: number;
  tags: string[];
  text: Omit<ExerciseRecord["text"], "conditions">;
  /** The move's note for each switched-on profile, labelled by the profile. */
  conditionNotes: Array<{ profileId: string; label: string; note: string }>;
  safety: Record<string, LibrarySafety>;
  easier: Array<{ id: string; name: string }>;
  harder: Array<{ id: string; name: string }>;
  prefs: ExercisePrefsDto;
  saved: boolean;
  /** Where a saved move came from — the account's own links. */
  provenance: Array<{ sourceType: string; url: string | null; creator: string | null }>;
  history: {
    /** The last five entries, newest first, weights as typed. */
    last: Array<{
      date: string;
      sessionId: string;
      implement: string | null;
      perSide: boolean;
      format: string | null;
      sets: Array<{ w: Weight | null; reps: number | null; secs: number | null; side: string | null; flags: string[] }>;
    }>;
    best: { w: Weight | null; reps: number | null; secs: number | null } | null;
  };
}

function libraryQueryString(q: LibraryQuery): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === "" || v === false) continue;
    params.set(k, v === true ? "1" : String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
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
  /**
   * The Progress tiles (Phase 2d; worker: services/progress.ts), the same under every discipline: the last eight
   * weeks of logged sessions. Optional only for a payload cached before it existed.
   */
  progress?: ProgressDto;
}

/** The Progress tiles' numbers: every one a MetricResult that says honestly when there is too little. */
export interface ProgressDto {
  /** The athlete's weight unit: what the volume tile speaks. */
  weightUnit: "lb" | "kg";
  /** One per switched-on profile, labelled by the profile itself (`check.label`). */
  conditions: Array<{ profileId: string; label: string; trend: MetricResult<ConditionTrendValue> }>;
  /** Kilograms, weight × reps, both sides of a one-sided move. */
  volume: MetricResult<WeeklyVolumeValue>;
  /** The current block's core lifts, in family order: kilograms inside, labelled in the unit last used. */
  lifts: Array<{ exerciseId: string; name: string; trend: MetricResult<LiftTopSetsValue> }>;
}

// ── Endpoints ────────────────────────────────────────────────────────────────

/**
 * A move or remove of a programme session queues its watch copy's take-off and leaves running it to a request of its
 * own (ruling 3-R11: the free plan's per-request budget) — `watchDrain` in the answer. Fire that drain and move on;
 * the hourly lane runs it anyway if this one never lands.
 */
function drainedWatch<T extends { watchDrain?: boolean }>(res: T): T {
  if (res.watchDrain) void post<{ executed: number }>("/api/sessions/watch/drain", {}).catch(() => undefined);
  return res;
}

/** Most coach drain requests one approve or Retry fires; the hourly lane runs whatever is left. */
export const COACH_DRAIN_MAX = 8;

/**
 * Run the coach's queued watch writes — one a request (ruling 3-R11, 2026-10-10): an approve answers `coachDrain`,
 * the banner's Retry `rewritesRetried`, and neither runs the writes itself any more (an approve that did measured 65
 * against the free plan's 50 per invocation). Drains until a request runs nothing, at most COACH_DRAIN_MAX. Fired,
 * never waited on.
 */
async function drainCoach(): Promise<void> {
  for (let i = 0; i < COACH_DRAIN_MAX; i++) {
    const { executed } = await post<{ executed: number }>("/api/coach/drain", {});
    if (!executed) return;
  }
}

/** Most drain requests a studio Retire fires; the hourly lane runs whatever is left. */
export const STUDIO_DRAIN_MAX = 8;

/**
 * Run queued COROS writes a request at a time (`POST /api/sync/drain-writes` with a cap of one, each within one
 * invocation's budget) until one runs nothing, at most STUDIO_DRAIN_MAX: a studio Retire queues its removals and runs
 * none itself. Fired, never waited on.
 */
async function drainWrites(): Promise<void> {
  for (let i = 0; i < STUDIO_DRAIN_MAX; i++) {
    const { executed } = await post<{ ok: boolean; executed: number }>("/api/sync/drain-writes", { cap: 1 });
    if (!executed) return;
  }
}

/**
 * A path with its query, when it has one. Reads the query's text, not `URLSearchParams.size`, which Safari before 17
 * lacks (there it is undefined, so every query would be dropped).
 */
export function withQuery(path: string, qs: URLSearchParams): string {
  const query = qs.toString();
  return query ? `${path}?${query}` : path;
}

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
  move: async (id: string, toDate: string, toTime: string) =>
    drainedWatch(
      await post<{ workoutId: string; corosSyncState: CorosSyncState; watchDrain?: boolean }>(`/api/plan/workouts/${id}/move`, {
        toDate,
        toTime,
      }),
    ),
  skip: (id: string) => post(`/api/plan/workouts/${id}/skip`),
  unskipWorkout: (id: string) => post(`/api/plan/workouts/${id}/unskip`),
  defer: (id: string) => post(`/api/plan/workouts/${id}/defer`),
  match: (id: string, activityId: string) => post(`/api/plan/workouts/${id}/match`, { activityId }),
  unmatch: (id: string) => post(`/api/plan/workouts/${id}/unmatch`),
  restoreCalendar: (id: string) => post(`/api/plan/workouts/${id}/restore-calendar`),
  retryCoros: (id: string) => post(`/api/plan/workouts/${id}/retry-coros`),
  removeWorkout: async (id: string) => drainedWatch(await post<{ ok: true; watchDrain?: boolean }>(`/api/plan/workouts/${id}/remove`)),
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
  coachApprove: async (proposalId: string) => {
    const res = await post<{ ok: boolean; coachDrain?: boolean }>(`/api/coach/proposals/${proposalId}/approve`);
    if (res.coachDrain) void drainCoach().catch(() => undefined);
    return res;
  },
  /** One proposal's status: what a tap whose answer never came back reads before it says anything. */
  coachProposal: (proposalId: string) =>
    get<{ id: string; status: CoachProposalDto["status"]; resolvedAt: string | null }>(`/api/coach/proposals/${proposalId}`),
  coachDecline: (proposalId: string) =>
    post<{ ok: boolean }>(`/api/coach/proposals/${proposalId}/decline`),
  coachAnswerQuestion: (questionId: string, answer: string) =>
    post<{ ok: boolean; wake?: CoachWakeResult }>(`/api/coach/questions/${questionId}/answer`, { answer }, NO_DEADLINE),
  coachDismissQuestion: (questionId: string) =>
    post<{ ok: boolean }>(`/api/coach/questions/${questionId}/dismiss`),
  coachMemoryList: () => get<{ memory: CoachMemoryItem[] }>("/api/coach/memory"),
  coachMemoryUpdate: (id: string, body: string) =>
    request<{ ok: boolean }>(`/api/coach/memory/${id}`, { method: "PATCH", body: JSON.stringify({ body }) }),
  coachMemoryDelete: (id: string) =>
    request<{ ok: boolean }>(`/api/coach/memory/${id}`, { method: "DELETE" }),
  // The coach designer's runs (Stage 3; 404 unless the server turned them on). One live run per athlete: a second
  // create answers the live one (`existing`). A step is one model call — minutes at most — so it is never cut off
  // client-side; a 409 means another step holds the run (poll `coachRun` and step again).
  coachRunCreate: (body: { scope: CoachRunScope; request?: string | null; rehearsal?: boolean }) =>
    post<CoachRunCreateResult>("/api/coach/runs", body),
  coachRunStep: (id: string) =>
    post<CoachRunStepResult>(`/api/coach/runs/${encodeURIComponent(id)}/step`, {}, AI_TIMEOUT_MS),
  coachRun: (id: string, afterSeq = 0) =>
    get<{ run: CoachRunDto; events: CoachRunEventDto[] }>(`/api/coach/runs/${encodeURIComponent(id)}?afterSeq=${afterSeq}`),
  coachRunAnswer: (id: string, body: { answers: string[]; dismissed?: boolean }) =>
    post<{ run: CoachRunDto }>(`/api/coach/runs/${encodeURIComponent(id)}/answer`, body),
  coachRunCancel: (id: string) => post<{ run: CoachRunDto }>(`/api/coach/runs/${encodeURIComponent(id)}/cancel`, {}),
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
  workoutDocParity: (opts: { after?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (opts.after) qs.set("after", opts.after);
    if (opts.limit) qs.set("limit", String(opts.limit));
    return get<WorkoutDocParityReport>(withQuery("/api/settings/diagnostics/workout-docs", qs));
  },
  workoutDoc: (id: string) => get<WorkoutDocResponse>(`/api/workouts/${encodeURIComponent(id)}/doc`),
  searchWorkouts: (opts: { from?: string; to?: string; q?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (opts.from) qs.set("from", opts.from);
    if (opts.to) qs.set("to", opts.to);
    if (opts.q) qs.set("q", opts.q);
    if (opts.limit) qs.set("limit", String(opts.limit));
    return get<WorkoutListItemDto[]>(withQuery("/api/workouts", qs));
  },
  /** Schedule a document workout (the Studio's Schedule and Start now). */
  createWorkout: (body: CreateDocWorkoutRequest) => post<CreateDocWorkoutResponse>("/api/workouts", body),
  /**
   * A Studio or template workout never started, removed — its calendar event and unsent watch work with it. 409
   * `{error: "not_removable", reason: "not_studio" | "started" | "done" | "sending"}`; 404 when it is not there.
   */
  deleteWorkout: (id: string) => request<{ ok: true }>(`/api/workouts/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** Save a new revision of a document workout's document; `baseRev` is the revision the edit started from. */
  reviseWorkoutDoc: (id: string, doc: WorkoutDoc, baseRev: number) =>
    put<ReviseDocWorkoutResponse>(`/api/workouts/${encodeURIComponent(id)}/doc`, { doc, baseRev }),
  templates: () => get<{ templates: TemplateDto[] }>("/api/templates"),
  /** `clientId`: the draft's key, as a workout's — a retry with it answers the template it saved (200), never a second. */
  createTemplate: (body: { name: string; doc: WorkoutDoc; pinned?: boolean; clientId?: string }) =>
    post<{ template: TemplateDto; warnings: DocIssueDto[] }>("/api/templates", body),
  /**
   * `baseUpdatedAt`: the `updatedAt` of the copy a whole-document write was built on — the template moved past it since
   * is 409 `stale_revision` (with its `updatedAt`), nothing written. A rename or a pin needs none.
   */
  updateTemplate: (id: string, patch: { name?: string; doc?: WorkoutDoc; pinned?: boolean; baseUpdatedAt?: string }) =>
    put<{ template: TemplateDto; warnings: DocIssueDto[] }>(`/api/templates/${encodeURIComponent(id)}`, patch),
  deleteTemplate: (id: string) => request<{ ok: true }>(`/api/templates/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** Bumps the template's uses; its document comes back stamped `basedOn: template`, to open or schedule. */
  useTemplate: (id: string) => post<{ template: TemplateDto; doc: WorkoutDoc | null }>(`/api/templates/${encodeURIComponent(id)}/use`, {}),
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
  /**
   * Retire the old generator's current plan (its screens are retired; the plan modal's Retire…): what is ahead leaves
   * the watch, what is behind stays. 409 `not_current` / `already_retired` / `plan_completed`, 412 `writes_disabled`.
   */
  studioPlanRetire: async (id: string) => {
    const res = await post<{ ok: true; summary?: { deletes?: number } }>(`/api/studio/plans/${encodeURIComponent(id)}/retire`);
    // Its removals are queued, not run: drained a request at a time, so they reach the watch soon.
    if ((res.summary?.deletes ?? 0) > 0) void drainWrites().catch(() => undefined);
    return res;
  },
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
  retrySync: async () => {
    const res = await post<RetrySyncResponse>("/api/sync/retry");
    // A failed rewrite the Retry queued again runs in the coach drain's own requests (ruling 3-R11).
    if ((res.rewritesRetried ?? 0) > 0) void drainCoach().catch(() => undefined);
    return res;
  },

  // ── Programs (worker routes: apps/worker/src/routes/programs.ts) ─────────
  listPrograms: () => get<ProgramsResponse>("/api/programs"),
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
  /** The slot's state alone — no build or view (Today's Continue check, re-review 2b-B2 M-3). 404 `not_found`. */
  getSessionState: (workoutId: string) =>
    get<Pick<SessionDto, "workoutId" | "contentState">>(`/api/sessions/${encodeURIComponent(workoutId)}/state`),
  buildSession:(workoutId: string, body: BuildSessionRequest = {}) =>
    post<SessionDto>(`/api/sessions/${encodeURIComponent(workoutId)}/build`, body),
  /**
   * Lock the build the athlete was shown. 409 `{error: "stale", session}` when it is no longer the one the day's inputs
   * make (a check, a save or an edit since): show `session` and Start again with its build id.
   */
  startSession: (workoutId: string, buildId: string) =>
    post<SessionDto>(`/api/sessions/${encodeURIComponent(workoutId)}/start`, { buildId }),
  /**
   * The player's Discard: the started slot back to built, its build unlocked (Today offers Start again). Idempotent;
   * 409 `{error: "performed"}` once a performed session exists for the slot; 423 while a restore runs.
   */
  /** `removed: true`: a workout started at once (Start now) with nothing logged was never planned, and is gone. */
  unstartSession: (workoutId: string) => post<SessionDto & { removed?: true }>(`/api/sessions/${encodeURIComponent(workoutId)}/unstart`, {}),
  /** The steps as the watch will hold them (Phase 3). 404 while the switch is off; 409 `{error: reason}`. */
  watchPreview: (workoutId: string) => get<WatchPreviewDto>(`/api/sessions/${encodeURIComponent(workoutId)}/watch-preview`),
  /**
   * The quick review after a watch session (Phase 3): the watch's logged sets paired with the locked build, the
   * activity's times and the post-check's profiles. 404 while the switch is off, and whenever it is not offered. The
   * save is `savePerformed` with `source: "watch_review"`, through the outbox.
   */
  watchReview: (workoutId: string) => get<WatchReviewBasisDto>(`/api/sessions/${encodeURIComponent(workoutId)}/watch-review`),
  /**
   * Send the previewed build to the watch: the build locks (the slot stays built) and its push is queued. `digest` is
   * the shown preview's (`WatchPreviewDto.digest`). 409 `{error: reason}` (`WatchUnavailableReason`), `{error: "stale",
   * session}` (show `session`, preview again) or `{error: "stale_preview", preview}` (the payload is not the one shown:
   * nothing was sent — swap `preview` in, and Send again with its digest).
   */
  sendToWatch: (workoutId: string, buildId: string, digest: string) =>
    post<SessionDto>(`/api/sessions/${encodeURIComponent(workoutId)}/send-to-watch`, { buildId, digest }),
  /** Take the sent session off the watch (or stop it reaching it); idempotent. */
  takeOffWatch: (workoutId: string) => post<SessionDto>(`/api/sessions/${encodeURIComponent(workoutId)}/take-off-watch`, {}),
  /**
   * Run the queued push or unpush now, in a request of its own: Send and Take off only queue (ruling 3-R11, the
   * Workers Free budget). Call it right after either answers 200, then read the session for the state. Runs at most
   * one of this athlete's watch jobs; 404 while the switch is off.
   */
  drainWatch: () => post<{ executed: number }>("/api/sessions/watch/drain", {}),
  recordCheck: (body: { profileId: string; value: number | null; feelingOff?: boolean }) =>
    post<{ check: ConditionCheckDto | null }>("/api/conditions/checks", body),
  /** Whether the build the slot shows is still the day's (Start would lock it as it is); never builds. */
  sessionCurrent: (workoutId: string) => get<SessionCurrencyDto>(`/api/sessions/${encodeURIComponent(workoutId)}/current`),
  /**
   * The outbox's delivery of a performed session: saved exactly once by its id. 409 `{error:"conflict"}` when the
   * same session was saved with other edits; 409 `{error:"slot_done"}` when another session of its slot was saved
   * first, on another device (ruling 2b-R18); 503 `{error:"busy"}` and 423 are worth retrying; 404 / 422 are not.
   */
  savePerformed: (performedId: string, payload: PerformedSessionWire) =>
    put<SavePerformedDto>(`/api/sessions/performed/${encodeURIComponent(performedId)}`, payload),
  /** What the review reads of the history, fetched at Start and kept on the device (a read; 404, 409 `not_built`). */
  reviewBasis: (workoutId: string) => get<ReviewBasisDto>(`/api/sessions/${encodeURIComponent(workoutId)}/review-basis`),

  // ── Settings: conditions and places ─────────────────────────────────────
  listConditions: () => get<{ profiles: ConditionSettingDto[] }>("/api/conditions"),
  /** Switch a profile on or off; answers with the whole list. */
  setCondition: (profileId: string, active: boolean) =>
    put<{ profiles: ConditionSettingDto[] }>("/api/conditions", { profileId, active }),
  listPlaces: () => get<PlacesResponse>("/api/places"),
  createPlace: (body: PlaceInput) => post<{ place: PlaceDto }>("/api/places", body),
  updatePlace: (id: string, patch: Partial<PlaceInput>) =>
    request<{ place: PlaceDto }>(`/api/places/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  /** 409 `{error: "place_in_use", program: {id, name}}` while an active program builds there. */
  deletePlace: (id: string) => request<{ ok: true }>(`/api/places/${encodeURIComponent(id)}`, { method: "DELETE" }),

  // ── Import (worker route: apps/worker/src/routes/imports.ts) ─────────────
  /**
   * The standalone tool's backup (the parsed file) → the summary; `dryRun` writes nothing. 422 `invalid_backup`,
   * 423 while restoring, 503 `busy` while another import of the account is writing.
   */
  importStandalone: (backup: unknown, opts: { dryRun?: boolean } = {}) =>
    post<StandaloneImportSummaryDto>(`/api/import/standalone${opts.dryRun ? "?dryRun=1" : ""}`, backup, 120_000),
  /**
   * A saved-post links file (built locally by apps/worker/scripts/build-provenance.mjs; the parsed file) → counts;
   * `dryRun` writes nothing. 422 `invalid_provenance`, 413 `too_large`, 423 while restoring.
   */
  importProvenance: (file: unknown, opts: { dryRun?: boolean } = {}) =>
    post<ProvenanceImportSummaryDto>(`/api/import/provenance${opts.dryRun ? "?dryRun=1" : ""}`, file),

  // ── Library (worker routes: apps/worker/src/routes/library.ts) ───────────
  listLibrary: (query: LibraryQuery = {}) => get<LibraryListDto>(`/api/library${libraryQueryString(query)}`),
  /** 404 `not_found` for a move the library does not have. */
  getLibraryItem: (id: string) => get<LibraryItemDto>(`/api/library/${encodeURIComponent(id)}`),
  /** Rate, set aside ("not for me") or pin one move; only what is sent changes. */
  setExercisePrefs: (id: string, patch: ExercisePrefsPatch) =>
    put<{ prefs: ExercisePrefsDto }>(`/api/library/${encodeURIComponent(id)}/prefs`, patch),

  // ── Profile and objectives (worker routes: apps/worker/src/routes/profile.ts) ───────────────────────────────────
  /** Goals, focus areas, events, preferences; units, timezone, race, places and conditions read-only. */
  getProfile: () => get<ProfileDto>("/api/profile"),
  /** Each part sent is replaced whole; nothing else is accepted. 422 `invalid_profile` with the issues; 423 while restoring. */
  updateProfile: (body: ProfileUpdate) => put<ProfileDto>("/api/profile", body),
  /** Board order: `sort`, then oldest first. */
  listObjectives: () => get<{ objectives: ObjectiveDto[] }>("/api/objectives"),
  /** 422 `invalid_objective` with the issues; 423 while restoring. */
  createObjective: (body: ObjectiveCreate) => post<{ objective: ObjectiveDto }>("/api/objectives", body),
  /** What is sent changes; `keyResults` is the whole list (one left out is deleted). 404 for another account's. */
  updateObjective: (id: string, patch: ObjectiveUpdate) =>
    put<{ objective: ObjectiveDto }>(`/api/objectives/${encodeURIComponent(id)}`, patch),
  /** Every key result measured from logged data, in its own unit too. 404 for another account's. */
  objectiveProgress: (id: string) => get<ObjectiveProgressDto>(`/api/objectives/${encodeURIComponent(id)}/progress`),
};

/** Exact shape of `GET /api/sessions/:workoutId/review-basis` (services/session-review-basis.ts). */
export interface ReviewBasisDto {
  workoutId: string;
  buildId: string;
  /** `Records.baseline` of the history for this build's day and moves. */
  records: RecordsState;
  graduation: { block: Block | null; sessions: HistorySession[]; unit: "lb" | "kg" };
  prefs: { ratings: Record<string, number>; excluded: string[] };
  /** Harder moves the block's lifts may graduate to, beyond the build's own slice. */
  exercises: Record<string, SessionExerciseDto>;
}

/** Exact shape of `GET /api/sessions/:workoutId/current`. */
export interface SessionCurrencyDto {
  workoutId: string;
  buildId: string | null;
  current: boolean;
  locked: boolean;
}

/** What a save says beside the session (worker: services/session-save.ts `SaveNote`). */
export type SaveNote =
  | "slot_already_matched"
  | "activity_matched_elsewhere"
  | "slot_gone"
  | "graduation_skipped"
  | "superseded_auto_match";

/** Exact shape of a 200 from `PUT /api/sessions/performed/:id`. */
export type SavePerformedDto =
  | {
      status: "saved";
      performedId: string;
      /** The session's activity: its own id, or the watch's copy it joined. */
      activityId: string;
      matched: boolean;
      /**
       * `superseded_auto_match`: the matcher's own guess (another activity on this slot, or the watch's copy filed on
       * another slot) gave way to this session — that activity is extra training, that slot is open again (2b-R5).
       * `slot_already_matched` / `activity_matched_elsewhere`: a match someone made stands; the session is saved
       * unmatched.
       */
      notes: SaveNote[];
    }
  | { status: "same_payload" };

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

/** Bytes of rows (JSON) per restore request: a page of session builds
 * (107–142 KB each) is one or two of them, inside the worker's CPU limit and
 * below its `RESTORE_MAX_PAGE_BYTES` (Ruling 2a-R9). A row larger than this
 * still goes, alone. */
const RESTORE_PAGE_BYTES = 192 * 1024;

/** Where each page of a table starts and ends: at most RESTORE_PAGE_ROWS
 * rows and RESTORE_PAGE_BYTES bytes, one row at the least. */
function restorePageBounds(rows: ReadonlyArray<Record<string, unknown>>): Array<[number, number]> {
  const bounds: Array<[number, number]> = [];
  let start = 0;
  let bytes = 2;
  for (let i = 0; i < rows.length; i += 1) {
    const size = JSON.stringify(rows[i]).length + 1;
    if (i > start && (i - start >= RESTORE_PAGE_ROWS || bytes + size > RESTORE_PAGE_BYTES)) {
      bounds.push([start, i]);
      start = i;
      bytes = 2;
    }
    bytes += size;
  }
  if (rows.length > start) bounds.push([start, rows.length]);
  return bounds;
}

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
    const bounds = restorePageBounds(rows);
    // A table the worker does not restore is sent even when it is empty, so
    // the check can say what it is.
    if (bounds.length === 0 && !known) bounds.push([0, 0]);
    for (const [offset, end] of bounds) {
      const page = rows.slice(offset, end);
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
