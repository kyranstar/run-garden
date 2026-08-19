/**
 * Vendored COROS Training Hub client (unofficial web API), pinned to the
 * verified surface in docs/COROS_INTEGRATION_FINDINGS.md §2 and
 * docs/research/coros-community-clients.md §2–§8.
 *
 * Security invariants:
 *  - The plaintext password is hashed (md5) immediately and never retained.
 *  - Nothing secret is ever logged: log lines carry operation + result code only.
 *  - All logging goes to stderr (stdout is reserved for the NDJSON protocol).
 */

import { daysBetween, type TrainingProviderCapabilities } from "@rg/domain";
import {
  corosDayToLocalDate,
  localDateToCorosDay,
  type CorosEnvelope,
  type RawCorosActivityDetail,
  type RawCorosActivityListItem,
  type RawCorosEntity,
  type RawCorosProgram,
  type RawCorosSchedule,
} from "@rg/providers";

export type CorosRegion = "us" | "eu" | "cn";

export const COROS_HOSTS: Record<CorosRegion, string> = {
  us: "https://teamapi.coros.com",
  eu: "https://teameuapi.coros.com",
  cn: "https://teamcnapi.coros.com",
};

/** Every COROS request aborts after this long — a hung request must never
 * wedge the bridge (one did, for four days, via the shared work chain). */
const COROS_REQUEST_TIMEOUT_MS = 60_000;

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/** Max span accepted by /training/schedule/query before the server 5011s. */
const MAX_SCHEDULE_RANGE_DAYS = 90;

export type CorosErrorCategory =
  | "bad_credentials"
  | "login_failed"
  | "not_authenticated"
  | "range_too_wide"
  | "api_error";

export class CorosApiError extends Error {
  override readonly name = "CorosApiError";
  constructor(
    readonly category: CorosErrorCategory,
    readonly resultCode: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

/** Static capability report for the Training Hub bridge (see findings §2/§3). */
export const COROS_BRIDGE_CAPABILITIES: TrainingProviderCapabilities = {
  readPlan: true,
  readSchedule: true,
  readActivities: true,
  readHealth: true,
  readSleep: false, // mobile-API only; never called (kills the phone-app session)
  readNativeDurationEstimate: true,
  calculateWorkout: true,
  updateExistingScheduledWorkout: true,
  addScheduledWorkout: true,
  removeScheduledWorkout: true,
  verifyWatchSync: false, // no server-side watch push exists
  exerciseCatalog: true,
};

/** Raw envelope status of a schedule write; the executor branches on `result`. */
export interface CorosWriteResponse {
  ok: boolean;
  result: string;
  message: string;
}

/** Server-computed program metrics from POST /training/program/calculate. */
export interface CorosProgramMetrics {
  duration?: number; // seconds
  trainingLoad?: number;
  distance?: number; // coros units (m × 100)
  totalSets?: number;
  sets?: number;
  exerciseBarChart?: unknown;
}

/** Raw data of /training/program/calculate — both documented field families. */
interface CorosCalculateResponse {
  planDuration?: number;
  duration?: number;
  planTrainingLoad?: number;
  trainingLoad?: number;
  planDistance?: number;
  distance?: number;
  planHybridTotalSets?: number;
  totalSets?: number;
  planSets?: number;
  sets?: number;
  exerciseBarChart?: unknown;
}

/** Envelope of POST /training/plan/add, `data` documented as the new planId. */
export interface CorosPlanAddResponse extends CorosWriteResponse {
  data: unknown;
}

/** Entry of GET /training/exercise/query — `id` doubles as an `originId`. */
export interface CorosExerciseCatalogItem {
  id: string | number;
  name?: string;
  sportType?: number;
  exerciseType?: number;
  targetType?: number;
  intensityType?: number;
  [key: string]: unknown;
}

function parseSleepHrvDay(v: unknown): CorosSleepHrvDay | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const num = (x: unknown) => (typeof x === "number" ? x : undefined);
  return {
    happenDay: typeof o.happenDay === "number" || typeof o.happenDay === "string" ? o.happenDay : undefined,
    avgSleepHrv: num(o.avgSleepHrv),
    sleepHrvBase: num(o.sleepHrvBase),
    sleepHrvSd: num(o.sleepHrvSd),
  };
}

function parseSleepHrvData(
  v: unknown,
): (CorosSleepHrvDay & { sleepHrvList?: CorosSleepHrvDay[] }) | undefined {
  const day = parseSleepHrvDay(v);
  if (!day) return undefined;
  const list = (v as Record<string, unknown>).sleepHrvList;
  const days = Array.isArray(list)
    ? list.map(parseSleepHrvDay).filter((d): d is CorosSleepHrvDay => d !== undefined)
    : undefined;
  return days ? { ...day, sleepHrvList: days } : day;
}

/** One day inside dashboard sleepHrvData — COROS's own band per night. */
export interface CorosSleepHrvDay {
  happenDay?: number | string;
  avgSleepHrv?: number;
  sleepHrvBase?: number;
  sleepHrvSd?: number;
}

export interface CorosDashboardSubset {
  rhr?: number;
  recoveryPct?: number;
  fullRecoveryHours?: number;
  /** Current night plus a short history in sleepHrvList (sleep/recovery 0020). */
  sleepHrvData?: CorosSleepHrvDay & { sleepHrvList?: CorosSleepHrvDay[] };
  /** COROS running-fitness score 0–100 (probe-verified 2026-08-14). */
  staminaLevel?: number;
  /** Lactate-threshold pace, seconds per km. */
  ltsp?: number;
  /** Lactate-threshold heart rate, bpm. */
  lthr?: number;
}

/** Zone boundaries from /account/query, wire ratios already ÷1000 to %. */
export interface CorosAccountZones {
  maxHr?: number;
  lthr?: number;
  ltsp?: number;
  lthrZones?: Array<{ index: number; bound: number; ratioPct: number | undefined }>;
  ltspZones?: Array<{ index: number; bound: number; ratioPct: number | undefined }>;
}

/** dayList[] item of GET /analyse/dayDetail/query. */
export interface CorosDayDetail {
  happenDay: number | string;
  rhr?: number;
  trainingLoad?: number;
  t7d?: number;
  tiredRateNew?: number;
  avgSleepHrv?: number;
  [key: string]: unknown;
}

interface StoredCredentials {
  email: string;
  pwdMd5: string;
}

export interface CorosClientOptions {
  region: CorosRegion;
  fetchImpl?: typeof fetch;
  /** Sanitized log sink (operation + result code only). Defaults to stderr. */
  logger?: (line: string) => void;
}

export class CorosClient {
  readonly region: CorosRegion;
  readonly fetchImpl: typeof fetch;
  private readonly base: string;
  private readonly logger: (line: string) => void;

  private accessToken: string | null = null;
  private userId: string | null = null;
  private credentials: StoredCredentials | null = null;

  constructor(opts: CorosClientOptions) {
    this.region = opts.region;
    this.base = COROS_HOSTS[opts.region];
    // Wrapped, never stored bare: calling a stored global `fetch` as
    // `this.fetchImpl(...)` gives it the client as `this`, which the
    // Cloudflare Workers runtime rejects ("Illegal invocation"). Node's
    // fetch tolerates it, so only production ever saw the crash.
    const f = opts.fetchImpl ?? fetch;
    this.fetchImpl = (input, init) => f(input, init);
    this.logger = opts.logger ?? ((line) => console.error(line));
  }

  get isAuthenticated(): boolean {
    return this.accessToken !== null;
  }

  /** Resume a previous session without a fresh login (worker token cache).
   * Credentials are optional; when present the 1019-expired retry can
   * re-login transparently, exactly as after loginWithHash. */
  resumeSession(session: { accessToken: string; userId: string; email?: string; pwdMd5?: string }): void {
    this.accessToken = session.accessToken;
    this.userId = session.userId;
    this.credentials =
      session.email && session.pwdMd5 ? { email: session.email, pwdMd5: session.pwdMd5 } : null;
  }

  /** The live session token (for persisting a cache) — never log this. */
  get sessionToken(): string | null {
    return this.accessToken;
  }

  get currentUserId(): string | null {
    return this.userId;
  }

  getCapabilities(): TrainingProviderCapabilities {
    return { ...COROS_BRIDGE_CAPABILITIES };
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  /** Login with a pre-hashed password (md5 hex). Hashing happens at the
   * edges — browser (settings) or the bridge's node wrapper — because this
   * module also runs on Workers, where WebCrypto has no MD5. */
  async loginWithHash(email: string, pwdMd5: string): Promise<{ userId: string }> {
    const res = await this.fetchImpl(`${this.base}/account/login`, {
      signal: AbortSignal.timeout(COROS_REQUEST_TIMEOUT_MS),
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify({ account: email, accountType: 2, pwd: pwdMd5 }),
    });
    const envelope = (await res.json()) as CorosEnvelope<{ accessToken?: string; userId?: string }>;
    this.log("account.login", envelope.result);
    if (envelope.result !== "0000" || !envelope.data?.accessToken || !envelope.data.userId) {
      throw new CorosApiError(
        envelope.result === "1030" ? "bad_credentials" : "login_failed",
        envelope.result,
        envelope.result === "1030" ? "COROS rejected the credentials" : "COROS login failed",
      );
    }
    this.accessToken = envelope.data.accessToken;
    this.userId = String(envelope.data.userId);
    this.credentials = { email, pwdMd5 };
    return { userId: this.userId };
  }

  async logout(): Promise<void> {
    if (this.accessToken) {
      try {
        await this.requestEnvelope("account.logout", "POST", "/account/logout", {}, false);
      } catch {
        // best-effort; local wipe below is what matters
      }
    }
    this.accessToken = null;
    this.userId = null;
    this.credentials = null;
  }

  // ── Schedule ─────────────────────────────────────────────────────────────

  /** Fresh read of the active plan + calendar window (dates yyyy-mm-dd). */
  async getRawSchedule(startDate: string, endDate: string): Promise<RawCorosSchedule> {
    if (daysBetween(startDate, endDate) > MAX_SCHEDULE_RANGE_DAYS) {
      throw new CorosApiError(
        "range_too_wide",
        "5011",
        `schedule range must be <= ${MAX_SCHEDULE_RANGE_DAYS} days`,
      );
    }
    const data = await this.requireData<RawCorosSchedule | null>(
      "schedule.query",
      "GET",
      "/training/schedule/query",
      {
        query: {
          startDate: String(localDateToCorosDay(startDate)),
          endDate: String(localDateToCorosDay(endDate)),
          supportRestExercise: "1",
        },
      },
    );
    return data ?? {};
  }

  /**
   * Date-move via status:2 update. Sends the FULL raw entity/program exactly
   * as read, with only happenDay (and recomputed dayNo) changed. ONE workout
   * per call — the server rejects multi-entity payloads.
   */
  async updateScheduleEntity(
    entity: RawCorosEntity,
    program: RawCorosProgram,
    planId: string,
    newHappenDay: number,
    planStartDay?: number,
  ): Promise<CorosWriteResponse> {
    const edited: RawCorosEntity = { ...entity, happenDay: newHappenDay };
    if (planStartDay != null && Number(planStartDay) > 0) {
      edited.dayNo =
        daysBetween(corosDayToLocalDate(planStartDay), corosDayToLocalDate(newHappenDay)) + 1;
    }
    return this.sendStatus2("schedule.update", edited, program, planId);
  }

  /**
   * CONTENT rewrite via status:2 — the same wire verb, the same address, the
   * calendar day untouched and the PROGRAM replaced.
   *
   * A date move and a content rewrite are one endpoint with one status code:
   * `status: 2` at (planId, idInPlan, planProgramId) means "this workout is now
   * what I am sending". The move path exploited that to change `happenDay`
   * while resending the program byte-for-byte; this method is the other half —
   * the day is resent as read and the program is the new one. Nothing else in
   * the payload differs, which is why there is one private sender for both.
   *
   * The caller owns the safety: the program must be built for the address it is
   * about to overwrite, and ownership must have been re-proven immediately
   * before the call (`content-executor.ts` is the only production caller and
   * does both). This method itself proves nothing.
   */
  async updateScheduleProgram(
    entity: RawCorosEntity,
    program: RawCorosProgram,
    planId: string,
  ): Promise<CorosWriteResponse> {
    return this.sendStatus2("schedule.content", { ...entity }, program, planId);
  }

  /** The one `status: 2` payload shape (§D4): entity + program + version triple. */
  private async sendStatus2(
    op: string,
    entity: RawCorosEntity,
    program: RawCorosProgram,
    planId: string,
  ): Promise<CorosWriteResponse> {
    return this.writeSchedule(op, {
      entities: [entity],
      programs: [program],
      versionObjects: [
        {
          id: String(entity.idInPlan),
          status: 2,
          planProgramId: String(entity.planProgramId ?? entity.idInPlan),
          planId,
        },
      ],
      pbVersion: 2,
    });
  }

  /**
   * status:1 create. `idInPlan` must be a freshly-read maxIdInPlan+1 (caller
   * supplies — writes are serialized upstream, so the read is not racy here).
   */
  async addScheduleEntity(
    entity: RawCorosEntity,
    program: RawCorosProgram,
    idInPlan: number,
    planId: string,
  ): Promise<CorosWriteResponse> {
    const entityClone: RawCorosEntity = {
      ...entity,
      idInPlan,
      planProgramId: String(idInPlan),
      planId,
      sortNoInSchedule: 1,
    };
    delete entityClone.id; // server-assigned
    const programClone: RawCorosProgram = { ...program, idInPlan, planId };
    delete programClone.id; // server-assigned
    return this.writeSchedule("schedule.create", {
      entities: [entityClone],
      programs: [programClone],
      versionObjects: [
        { id: String(idInPlan), status: 1, planProgramId: String(idInPlan), planId },
      ],
      pbVersion: 2,
    });
  }

  /** status:3 hard delete — versionObjects only. */
  async removeScheduleEntity(
    idInPlan: string | number,
    planProgramId: string | number,
    planId: string,
  ): Promise<CorosWriteResponse> {
    return this.writeSchedule("schedule.delete", {
      versionObjects: [
        { id: String(idInPlan), status: 3, planProgramId: String(planProgramId), planId },
      ],
      pbVersion: 2,
    });
  }

  /** Native duration estimate for a program (planDuration ?? duration, seconds). */
  async calculateProgram(program: RawCorosProgram): Promise<number | undefined> {
    return (await this.calculateProgramMetrics(program)).duration;
  }

  /**
   * Full server-computed metrics for a program. The response uses `plan*`
   * names on the calendar path and bare names on the library path (community
   * survey §6.1) — read both. Used by calculate-then-add: splice the returned
   * duration/load into the program before a status:1 create.
   */
  async calculateProgramMetrics(program: RawCorosProgram): Promise<CorosProgramMetrics> {
    const data = await this.requireData<CorosCalculateResponse | null>(
      "program.calculate",
      "POST",
      "/training/program/calculate",
      { json: program },
    );
    return {
      duration: data?.planDuration ?? data?.duration,
      trainingLoad: data?.planTrainingLoad ?? data?.trainingLoad,
      distance: data?.planDistance ?? data?.distance,
      totalSets: data?.planHybridTotalSets ?? data?.totalSets,
      sets: data?.planSets ?? data?.sets,
      exerciseBarChart: data?.exerciseBarChart,
    };
  }

  /**
   * Plan-level create probe (`POST /training/plan/add`). Speculative: the one
   * community attempt on record against a non-CN account was rejected with
   * `1031`. Returns the envelope verbatim (including `data`, documented as the
   * new planId) instead of throwing, so a caller can record either outcome.
   */
  async planAdd(body: unknown): Promise<CorosPlanAddResponse> {
    const envelope = await this.requestEnvelope<unknown>("plan.add", "POST", "/training/plan/add", {
      json: body,
    });
    return {
      ok: envelope.result === "0000",
      result: envelope.result,
      message: envelope.message,
      data: envelope.data,
    };
  }

  /**
   * Exercise catalog for a workout-namespace sportType (4 = strength, ~400
   * entries). Each entry's `id` is the stable `originId` a hand-built program
   * references. Response `data` is a bare array on the observed captures.
   */
  async getExerciseCatalog(sportType: number): Promise<CorosExerciseCatalogItem[]> {
    const data = await this.requireData<unknown>(
      "exercise.query",
      "GET",
      "/training/exercise/query",
      { query: { userId: this.userId ?? "", sportType: String(sportType) } },
    );
    if (Array.isArray(data)) return data as CorosExerciseCatalogItem[];
    const list = (data as { list?: unknown; dataList?: unknown } | null)?.list ??
      (data as { dataList?: unknown } | null)?.dataList;
    return Array.isArray(list) ? (list as CorosExerciseCatalogItem[]) : [];
  }

  // ── Activities ───────────────────────────────────────────────────────────

  async getActivities(startDay: string, endDay: string): Promise<RawCorosActivityListItem[]> {
    const all: RawCorosActivityListItem[] = [];
    let pageNumber = 1;
    for (;;) {
      const data = await this.requireData<{
        dataList?: RawCorosActivityListItem[];
        totalPage?: number;
      } | null>("activity.query", "GET", "/activity/query", {
        query: {
          size: "200",
          pageNumber: String(pageNumber),
          startDay: String(localDateToCorosDay(startDay)),
          endDay: String(localDateToCorosDay(endDay)),
          modeList: "",
        },
      });
      all.push(...(data?.dataList ?? []));
      if (pageNumber >= (data?.totalPage ?? 1)) break;
      pageNumber += 1;
    }
    return all;
  }

  async getActivityDetail(labelId: string, sportType: number): Promise<RawCorosActivityDetail> {
    const data = await this.requireData<RawCorosActivityDetail | null>(
      "activity.detail",
      "POST",
      "/activity/detail/query",
      { form: { labelId, sportType: String(sportType) } },
    );
    return data ?? {};
  }

  // ── Daily health ─────────────────────────────────────────────────────────

  async getDashboard(): Promise<CorosDashboardSubset> {
    const data = await this.requireData<Record<string, unknown> | null>(
      "dashboard.query",
      "GET",
      "/dashboard/query",
    );
    const s = (data?.summaryInfo ?? data ?? {}) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" ? v : undefined);
    return {
      rhr: num(s.rhr),
      recoveryPct: num(s.recoveryPct),
      fullRecoveryHours: num(s.fullRecoveryHours),
      sleepHrvData: parseSleepHrvData(s.sleepHrvData),
      staminaLevel: num(s.staminaLevel),
      ltsp: num(s.ltsp),
      lthr: num(s.lthr),
    };
  }

  /** The athlete's own zone definitions + profile ceilings (coach-input
   * audit 0018). `/account/query` is the cheapest authenticated call; zone
   * `ratio` rides the wire in permille-of-percent (59000 = 59%). */
  async getAccountZones(): Promise<CorosAccountZones> {
    const data = await this.requireData<Record<string, unknown> | null>(
      "account.query",
      "GET",
      "/account/query",
    );
    const num = (v: unknown) => (typeof v === "number" ? v : undefined);
    const zoneData = (data?.zoneData ?? {}) as Record<string, unknown>;
    const zones = (v: unknown, key: "hr" | "pace") =>
      Array.isArray(v)
        ? v
            .map((z) => {
              const r = z as Record<string, unknown>;
              const bound = num(r[key]);
              const index = num(r.index);
              if (bound == null || index == null) return null;
              const ratio = num(r.ratio);
              return { index, bound, ratioPct: ratio != null ? ratio / 1000 : undefined };
            })
            .filter((z): z is { index: number; bound: number; ratioPct: number | undefined } => z != null)
        : undefined;
    return {
      maxHr: num(data?.maxHr),
      lthr: num(zoneData.lthr),
      ltsp: num(zoneData.ltsp),
      lthrZones: zones(zoneData.lthrZone, "hr"),
      ltspZones: zones(zoneData.ltspZone, "pace"),
    };
  }

  async getDailyMetrics(startDay: string, endDay: string): Promise<CorosDayDetail[]> {
    const data = await this.requireData<{ dayList?: CorosDayDetail[] } | null>(
      "analyse.dayDetail",
      "GET",
      "/analyse/dayDetail/query",
      {
        query: {
          startDay: String(localDateToCorosDay(startDay)),
          endDay: String(localDateToCorosDay(endDay)),
        },
      },
    );
    return data?.dayList ?? [];
  }

  // ── Transport ────────────────────────────────────────────────────────────

  private log(op: string, result: string): void {
    // Sanitized by construction: operation + envelope result code only.
    this.logger(`[coros-bridge] coros ${op} result=${result}`);
  }

  private async writeSchedule(op: string, body: unknown): Promise<CorosWriteResponse> {
    const envelope = await this.requestEnvelope<unknown>(
      op,
      "POST",
      "/training/schedule/update",
      { json: body },
    );
    return { ok: envelope.result === "0000", result: envelope.result, message: envelope.message };
  }

  private async requireData<T>(
    op: string,
    method: "GET" | "POST",
    path: string,
    opts: RequestOpts = {},
  ): Promise<T> {
    const envelope = await this.requestEnvelope<T>(op, method, path, opts);
    if (envelope.result !== "0000") {
      throw new CorosApiError(
        envelope.result === "5011" ? "range_too_wide" : "api_error",
        envelope.result,
        `${op} failed (result ${envelope.result})`,
      );
    }
    return envelope.data;
  }

  private async requestEnvelope<T>(
    op: string,
    method: "GET" | "POST",
    path: string,
    opts: RequestOpts = {},
    retryOnExpiry = true,
  ): Promise<CorosEnvelope<T>> {
    if (!this.accessToken || !this.userId) {
      throw new CorosApiError("not_authenticated", undefined, `${op}: not authenticated`);
    }
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

    const headers: Record<string, string> = {
      accessToken: this.accessToken,
      yfheader: JSON.stringify({ userId: this.userId }),
      "User-Agent": USER_AGENT,
    };
    let body: string | undefined;
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    } else if (opts.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(opts.form).toString();
    }

    // HTTP status is 200 even for logical errors — always branch on envelope.result.
    // Bounded: a COROS request that never settles must not wedge the bridge's
    // work chain (same rationale as CloudSync's request timeout).
    const res = await this.fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(COROS_REQUEST_TIMEOUT_MS) });
    const envelope = (await res.json()) as CorosEnvelope<T>;
    this.log(op, envelope.result);

    if (envelope.result === "1019" && retryOnExpiry && this.credentials) {
      // Token expired (~24h TTL, no refresh endpoint): re-login once, retry once.
      await this.loginWithHash(this.credentials.email, this.credentials.pwdMd5);
      return this.requestEnvelope(op, method, path, opts, false);
    }
    return envelope;
  }
}

interface RequestOpts {
  query?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
}
