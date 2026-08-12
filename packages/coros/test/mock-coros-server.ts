/**
 * Stateful mock of the COROS Training Hub API, backed by the shared
 * fixtureRawSchedule. Mirrors the verified behaviors the bridge depends on:
 * result-code envelopes on HTTP 200, one-workout-per-call writes (multi-entity
 * → 1031), status 1/2/3 mutations, write responses that omit server ids, and
 * the range cap (5011).
 */

import { createHash } from "node:crypto";
import {
  fixtureRawSchedule,
  type RawCorosActivityDetail,
  type RawCorosActivityListItem,
  type RawCorosEntity,
  type RawCorosProgram,
  type RawCorosSchedule,
} from "@rg/providers";

function md5(s: string): string {
  return createHash("md5").update(s, "utf8").digest("hex");
}

function corosDay(iso: string): number {
  return Number(iso.replaceAll("-", ""));
}

function isoFromCorosDay(day: number | string): string {
  const s = String(day).padStart(8, "0");
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Next Monday strictly after today (keeps dynamic-date tests in range). */
export function nextMonday(): string {
  let d = new Date().toISOString().slice(0, 10);
  do {
    d = addDaysIso(d, 1);
  } while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1);
  return d;
}

function envelope(result: string, data: unknown = null): Response {
  return new Response(
    JSON.stringify({ apiCode: "TEST", message: result === "0000" ? "OK" : "ERROR", result, data }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const LOCALE_MAP: Record<string, string> = {
  T1120: "Warm Up",
  T1122: "Cool Down",
  T1123: "Recover",
  T3001: "Run",
  sid_run_training: "Run training",
};

interface VersionObject {
  id: string | number;
  status: number;
  planProgramId?: string | number;
  planId?: string;
}

interface ScheduleUpdateBody {
  entities?: RawCorosEntity[];
  programs?: RawCorosProgram[];
  versionObjects?: VersionObject[];
  pbVersion?: number;
}

/** POST /training/plan/add body — day-offset relative, not date-absolute. */
interface PlanAddBody {
  name?: string;
  entities?: Array<{ idInPlan?: number | string; dayNo?: number; happenDay?: string }>;
  programs?: RawCorosProgram[];
  totalDay?: number;
  region?: number | string;
}

export interface MockCorosServer {
  fetchImpl: typeof fetch;
  email: string;
  password: string;
  userId: string;
  baseMonday: string;
  state: {
    /** The target plan: the account's own container. `schedule.id` is its id. */
    schedule: RawCorosSchedule;
    /**
     * Other plans on the account (e.g. a COROS-authored template the athlete
     * follows). /training/schedule/query MERGES every plan's entities and
     * programs into one response, and their idInPlan values overlap freely —
     * this is what the second live run tripped over.
     */
    mergedPlans: RawCorosSchedule[];
    activities: RawCorosActivityListItem[];
    details: Record<string, RawCorosActivityDetail>;
    dayList: Array<Record<string, unknown>>;
  };
  counts: {
    login: number;
    scheduleQuery: number;
    scheduleWrites: number;
    localeFetches: number;
  };
  /** Invalidate all issued tokens: the next authed call returns 1019. */
  expireTokens(): void;
  /** While set, every status:2 update is rejected with this result code. */
  updateRejectResult: string | null;
  /** While set, every status:3 delete is rejected with this result code. */
  deleteRejectResult: string | null;
  /** Once: apply the status:2 update, then throw a network error. */
  throwAfterApplyOnce: boolean;
  /** Once: throw a network error BEFORE applying the status:2 update. */
  throwBeforeApplyOnce: boolean;
  /** While set, status:1 creates return 0000 but do not mutate state. */
  addSilentlyFails: boolean;
  /** Cap the /activity/query page size below the requested one (pagination tests). */
  forcePageSize: number | null;
  /**
   * Whether a status:1 create bumps `maxIdInPlan`. Set false to model the live
   * template plan that reported maxIdInPlan 0 while carrying ids up to 45.
   */
  maintainsIdCounter: boolean;
  /**
   * Ignore the claimed `idInPlan` on a status:1 create and store the entity
   * under an id the server picks — observed live (claimed 49, stored
   * elsewhere), which is why recovery must be by stamp, not by id.
   *   "offset"  — a fresh, unused id (claimed + REASSIGN_OFFSET).
   *   "counter" — the plan's own maxIdInPlan+1, which on an unmaintained plan
   *               COLLIDES with existing workouts. The live shape.
   */
  reassignsIdInPlan: "offset" | "counter" | null;
  /** Envelope result POST /training/plan/add returns (1031 = the EU rejection). */
  planAddResult: string;
  /** `data` returned when planAddResult is "0000" (documented as the planId). */
  planAddData: unknown;
  /** On a "0000" plan/add, also materialize the plan's entities + programs. */
  planAddMaterializes: boolean;
  /** Day offset from today the materialized plan entities land on. */
  planAddAnchorOffsetDays: number;
  /** Bodies received by POST /training/plan/add, in order. */
  planAddBodies: unknown[];
  entityByIdInPlan(idInPlan: string | number): RawCorosEntity | undefined;
  programByIdInPlan(idInPlan: string | number): RawCorosProgram | undefined;
}

/** How far a "offset"-mode reassignment moves the id away from the claim. */
export const REASSIGN_OFFSET = 7;

/** Fixed metrics /training/program/calculate returns for a hand-built program. */
const CALCULATED_DURATION = 1234;
const CALCULATED_TRAINING_LOAD = 42;

/** Two entries of the sportType=4 exercise catalog (ids double as originIds). */
const STRENGTH_CATALOG = [
  { id: "425898928110747648", name: "T2001", sportType: 4, exerciseType: 1, targetType: 2 },
  { id: "426109589008859137", name: "T2101", sportType: 4, exerciseType: 2, targetType: 3 },
];

export function mockCorosServer(opts: { baseMonday?: string } = {}): MockCorosServer {
  const baseMonday = opts.baseMonday ?? nextMonday();
  const email = "athlete@example.com";
  const password = "correct horse battery staple";
  const pwdMd5 = md5(password);
  const userId = "user-1234567890";

  const activityDay = addDaysIso(baseMonday, 1);
  const activityStart = Math.floor(Date.parse(`${activityDay}T07:00:00Z`) / 1000);
  const runActivity: RawCorosActivityListItem = {
    labelId: "act-run-1",
    date: corosDay(activityDay),
    name: "Morning Run",
    sportType: 100,
    startTime: activityStart,
    endTime: activityStart + 3050,
    startTimezone: 8, // +2h in 15-minute units
    distance: 1_000_000, // cm → 10 km
    totalTime: 3050,
    workoutTime: 3000,
    trainingLoad: 80,
    avgHr: 150,
    maxHr: 172,
    device: "PACE 3",
    calorie: 600_000,
  };
  const bikeActivity: RawCorosActivityListItem = {
    labelId: "act-bike-1",
    date: corosDay(activityDay),
    name: "Spin",
    sportType: 200,
    startTime: activityStart + 40_000,
    totalTime: 1800,
    workoutTime: 1800,
  };
  const strengthActivity: RawCorosActivityListItem = {
    labelId: "act-strength-1",
    date: corosDay(activityDay),
    name: "Full Body Strength",
    sportType: 402,
    startTime: activityStart + 10_000,
    totalTime: 2700,
    workoutTime: 2700,
    avgHr: 120,
    calorie: 350_000,
  };
  const yogaActivity: RawCorosActivityListItem = {
    labelId: "act-yoga-1",
    date: corosDay(activityDay),
    name: "Evening Flow",
    sportType: 904,
    startTime: activityStart + 20_000,
    totalTime: 1800,
    workoutTime: 1800,
    avgHr: 95,
    calorie: 180_000,
  };

  const server: MockCorosServer = {
    email,
    password,
    userId,
    baseMonday,
    state: {
      schedule: fixtureRawSchedule(baseMonday),
      mergedPlans: [],
      activities: [runActivity, bikeActivity, strengthActivity, yogaActivity],
      details: {
        "act-run-1": {
          summary: {
            // Detail-summary units are CENTISECONDS/centimetres — 100× the
            // list's plain seconds (the real wire contract; encoding it
            // wrong here is what let the 2026-08-12 corruption ship green).
            distance: 1_000_000,
            totalTime: 305_000,
            workoutTime: 300_000,
            avgHr: 150,
            maxHr: 172,
            avgPace: 300,
            trainingLoad: 80,
            startTimestamp: activityStart,
            timezone: 8,
            sportType: 100,
            name: "Morning Run",
            hasProgram: 1,
            planId: "800000000000001234",
            programId: "900000000000000011",
          },
          lapList: [
            {
              type: 0,
              lapDistance: 100000,
              lapItemList: [
                { lapIndex: 1, distance: 100000, time: 30_000, avgPace: 300, avgHr: 148 },
                { lapIndex: 2, distance: 100000, time: 29_500, avgPace: 295, avgHr: 152 },
              ],
            },
          ],
        },
      },
      dayList: [
        { happenDay: corosDay(baseMonday), rhr: 47, t7d: 320, tiredRateNew: 28, avgSleepHrv: 72 },
        {
          happenDay: corosDay(addDaysIso(baseMonday, 1)),
          rhr: 45,
          t7d: 335,
          tiredRateNew: 31,
          avgSleepHrv: 69,
        },
      ],
    },
    counts: { login: 0, scheduleQuery: 0, scheduleWrites: 0, localeFetches: 0 },
    updateRejectResult: null,
    deleteRejectResult: null,
    throwAfterApplyOnce: false,
    throwBeforeApplyOnce: false,
    addSilentlyFails: false,
    forcePageSize: null,
    maintainsIdCounter: true,
    reassignsIdInPlan: null,
    planAddResult: "1031", // "Parameter input error" — the one EU attempt on record
    planAddData: null,
    planAddMaterializes: false,
    planAddAnchorOffsetDays: 40,
    planAddBodies: [],
    expireTokens: () => {
      validTokens.clear();
    },
    entityByIdInPlan: (idInPlan) =>
      (server.state.schedule.entities ?? []).find(
        (e) => String(e.idInPlan) === String(idInPlan),
      ),
    programByIdInPlan: (idInPlan) =>
      (server.state.schedule.programs ?? []).find(
        (p) => String(p.idInPlan) === String(idInPlan),
      ),
    fetchImpl: undefined as unknown as typeof fetch,
  };

  const validTokens = new Set<string>();
  let tokenCounter = 0;
  let serverIdCounter = 500;

  function handleScheduleUpdate(body: ScheduleUpdateBody): Response {
    server.counts.scheduleWrites += 1;
    if ((body.entities?.length ?? 0) > 1 || (body.programs?.length ?? 0) > 1) {
      return envelope("1031"); // "Plan data is illegal" — one workout per call
    }
    const vo = body.versionObjects?.[0];
    if (!vo) return envelope("1031");
    // Route by planId. Deletes are allowed to reach ANY plan — if the spike
    // ever addresses the wrong one, the test must be able to see the damage.
    const target =
      [server.state.schedule, ...server.state.mergedPlans].find(
        (p) => vo.planId != null && vo.planId !== "" && String(p.id ?? "") === String(vo.planId),
      ) ?? server.state.schedule;
    const schedule = target;
    schedule.entities ??= [];
    schedule.programs ??= [];

    if (vo.status === 2) {
      if (server.throwBeforeApplyOnce) {
        server.throwBeforeApplyOnce = false;
        throw new TypeError("fetch failed");
      }
      if (server.updateRejectResult) return envelope(server.updateRejectResult);
      const submitted = body.entities?.[0];
      if (!submitted) return envelope("1031");
      const idx = schedule.entities.findIndex((e) => String(e.idInPlan) === String(vo.id));
      if (idx < 0) return envelope("1001");
      schedule.entities[idx] = structuredClone(submitted);
      const submittedProgram = body.programs?.[0];
      if (submittedProgram) {
        const pIdx = schedule.programs.findIndex((p) => String(p.idInPlan) === String(vo.id));
        if (pIdx >= 0) schedule.programs[pIdx] = structuredClone(submittedProgram);
      }
      if (server.throwAfterApplyOnce) {
        server.throwAfterApplyOnce = false;
        throw new TypeError("fetch failed"); // write landed; response lost
      }
      return envelope("0000"); // response omits server ids, like the real API
    }

    if (vo.status === 1) {
      if (server.addSilentlyFails) return envelope("0000"); // accepted, never materializes
      const submitted = body.entities?.[0];
      const submittedProgram = body.programs?.[0];
      if (!submitted || !submittedProgram) return envelope("1031");
      // idInPlan is a plan-scoped unique key: a create onto an occupied slot
      // is rejected, it does not silently overwrite. [inferred] Skipped when
      // the server allocates the id itself.
      if (
        server.reassignsIdInPlan === null &&
        schedule.entities.some((e) => String(e.idInPlan) === String(vo.id))
      ) {
        return envelope("1031");
      }
      serverIdCounter += 1;
      const entity = structuredClone(submitted);
      const program = structuredClone(submittedProgram);
      let storedId = Number(vo.id);
      if (server.reassignsIdInPlan !== null) {
        storedId =
          server.reassignsIdInPlan === "offset"
            ? Number(vo.id) + REASSIGN_OFFSET
            : Number(schedule.maxIdInPlan ?? 0) + 1;
        entity.idInPlan = String(storedId);
        entity.planProgramId = String(storedId);
        program.idInPlan = String(storedId);
        if (server.reassignsIdInPlan === "counter") {
          // The live shape: the counter ticks, but never catches up to reality.
          schedule.maxIdInPlan = Number(schedule.maxIdInPlan ?? 0) + 1;
        }
      }
      entity.id = `sv-entity-${serverIdCounter}`;
      program.id = `sv-program-${serverIdCounter}`;
      schedule.entities.push(entity);
      schedule.programs.push(program);
      if (server.maintainsIdCounter && server.reassignsIdInPlan !== "counter") {
        schedule.maxIdInPlan = Math.max(Number(schedule.maxIdInPlan ?? 0), storedId);
      }
      return envelope("0000");
    }

    if (vo.status === 3) {
      if (server.deleteRejectResult) return envelope(server.deleteRejectResult);
      // A delete is scoped to (planId, idInPlan) — an id aimed at the wrong
      // plan removes nothing, and the envelope still reads 0000.
      const wantsPlan = vo.planId != null && vo.planId !== "";
      const wantsProgram = vo.planProgramId != null && vo.planProgramId !== "";
      const matches = (e: RawCorosEntity): boolean =>
        String(e.idInPlan) === String(vo.id) &&
        (!wantsPlan || String(e.planId ?? "") === String(vo.planId)) &&
        (!wantsProgram ||
          String(e.planProgramId ?? e.idInPlan) === String(vo.planProgramId));
      const removedIds = new Set(schedule.entities.filter(matches).map((e) => String(e.idInPlan)));
      schedule.entities = schedule.entities.filter((e) => !matches(e));
      schedule.programs = schedule.programs.filter((p) => !removedIds.has(String(p.idInPlan)));
      // maxIdInPlan never decrements [verified]
      return envelope("0000");
    }

    return envelope("1031");
  }

  /**
   * The plan/add success path: the server turns the day-offset-relative plan
   * template into real, dated schedule entities. Names are carried over from
   * the submitted programs, which is what makes ownership provable.
   */
  function materializePlan(body: PlanAddBody): void {
    const schedule = server.state.schedule;
    schedule.entities ??= [];
    schedule.programs ??= [];
    const anchor = addDaysIso(
      new Date().toISOString().slice(0, 10),
      server.planAddAnchorOffsetDays,
    );
    for (const submitted of body.entities ?? []) {
      const dayNo = Number(submitted.dayNo ?? 1);
      const template = (body.programs ?? []).find(
        (p) => String(p.idInPlan) === String(submitted.idInPlan),
      );
      const idInPlan = Number(schedule.maxIdInPlan ?? 0) + 1;
      schedule.maxIdInPlan = idInPlan;
      serverIdCounter += 1;
      schedule.entities.push({
        id: `sv-entity-${serverIdCounter}`,
        idInPlan: String(idInPlan),
        planId: String(schedule.id ?? ""),
        planProgramId: String(idInPlan),
        happenDay: corosDay(addDaysIso(anchor, dayNo - 1)),
        dayNo,
        sortNoInSchedule: 1,
        name: template?.name,
      });
      if (template) {
        schedule.programs.push({
          ...structuredClone(template),
          id: `sv-program-${serverIdCounter}`,
          idInPlan: String(idInPlan),
          planId: String(schedule.id ?? ""),
        });
      }
    }
  }

  // A regular function (not an arrow) so it can police its receiver the way
  // the Cloudflare Workers runtime polices the real `fetch`: calling it as a
  // method of anything but globalThis is an Illegal invocation there, and
  // Node's permissiveness let exactly that bug ship (prod incident,
  // 2026-08-12: CorosClient called a stored fetch as `this.fetchImpl`).
  const fetchImpl = async function (
    this: unknown,
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    if (this !== undefined && this !== globalThis && this !== server) {
      // (`server` itself is allowed: test wrappers call `server.fetchImpl(…)`
      // method-style; production code can never have it as a receiver.)
      throw new TypeError(
        "Illegal invocation: mock fetch called with an incorrect `this` (workerd semantics)",
      );
    }
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const headers = new Headers(init?.headers);

    // Unauthenticated CDN locale bundle.
    if (url.hostname === "static.coros.com") {
      server.counts.localeFetches += 1;
      return new Response(`window.en_US=${JSON.stringify(LOCALE_MAP)};`, {
        status: 200,
        headers: { "content-type": "application/javascript" },
      });
    }

    if (url.pathname === "/account/login") {
      server.counts.login += 1;
      const body = JSON.parse(bodyText) as { account?: string; pwd?: string; accountType?: number };
      if (body.account !== email || body.pwd !== pwdMd5 || body.accountType !== 2) {
        return envelope("1030");
      }
      tokenCounter += 1;
      const token = `tok-${tokenCounter}`;
      validTokens.add(token);
      return envelope("0000", { accessToken: token, userId });
    }

    // Everything else requires a valid token; expired → 1019 on HTTP 200.
    const token = headers.get("accesstoken");
    if (!token || !validTokens.has(token)) return envelope("1019");

    switch (url.pathname) {
      case "/training/schedule/query": {
        server.counts.scheduleQuery += 1;
        const start = url.searchParams.get("startDate") ?? "0";
        const end = url.searchParams.get("endDate") ?? "0";
        if (diffDays(isoFromCorosDay(start), isoFromCorosDay(end)) > 90) {
          return envelope("5011");
        }
        const startNum = Number(start);
        const endNum = Number(end);
        const schedule = server.state.schedule;
        const entities: RawCorosEntity[] = [];
        const programs: RawCorosProgram[] = [];
        // Every plan's rows are merged into the one response, exactly as the
        // real endpoint does. Only the top-level plan fields (id, name,
        // maxIdInPlan) describe the target plan.
        for (const plan of [schedule, ...server.state.mergedPlans]) {
          const inWindow = (plan.entities ?? []).filter((e) => {
            const day = Number(e.happenDay);
            return day >= startNum && day <= endNum;
          });
          const ids = new Set(inWindow.map((e) => String(e.planProgramId ?? e.idInPlan)));
          entities.push(...inWindow);
          programs.push(...(plan.programs ?? []).filter((p) => ids.has(String(p.idInPlan))));
        }
        return envelope("0000", structuredClone({ ...schedule, entities, programs }));
      }

      case "/training/schedule/update":
        return handleScheduleUpdate(JSON.parse(bodyText) as ScheduleUpdateBody);

      case "/training/program/calculate": {
        // Server-computed: a hand-built program submits 0/absent and gets the
        // real numbers back. Programs that already carry an estimate keep it.
        const program = JSON.parse(bodyText) as RawCorosProgram;
        return envelope("0000", {
          planDuration: program.duration || CALCULATED_DURATION,
          planTrainingLoad: program.trainingLoad || CALCULATED_TRAINING_LOAD,
        });
      }

      case "/training/plan/add": {
        const planBody = JSON.parse(bodyText) as PlanAddBody;
        server.planAddBodies.push(planBody);
        if (server.planAddResult !== "0000") return envelope(server.planAddResult);
        if (server.planAddMaterializes) materializePlan(planBody);
        return envelope("0000", server.planAddData);
      }

      case "/training/exercise/query": {
        const sportType = Number(url.searchParams.get("sportType") ?? "0");
        const list = sportType === 4 ? STRENGTH_CATALOG : [];
        return envelope("0000", structuredClone(list)); // data is a bare array
      }

      case "/activity/query": {
        const startDay = Number(url.searchParams.get("startDay") ?? "0");
        const endDay = Number(url.searchParams.get("endDay") ?? "99999999");
        const requested = Number(url.searchParams.get("size") ?? "200");
        const size = server.forcePageSize
          ? Math.min(requested, server.forcePageSize)
          : requested;
        const pageNumber = Number(url.searchParams.get("pageNumber") ?? "1");
        const matching = server.state.activities.filter(
          (a) => a.date >= startDay && a.date <= endDay,
        );
        const totalPage = Math.max(1, Math.ceil(matching.length / size));
        const dataList = matching.slice((pageNumber - 1) * size, pageNumber * size);
        return envelope("0000", { count: matching.length, pageNumber, totalPage, dataList });
      }

      case "/activity/detail/query": {
        const form = new URLSearchParams(bodyText);
        const labelId = form.get("labelId") ?? "";
        const detail = server.state.details[labelId];
        return detail ? envelope("0000", structuredClone(detail)) : envelope("0000", {});
      }

      case "/dashboard/query":
        return envelope("0000", {
          summaryInfo: {
            rhr: 47,
            recoveryPct: 88,
            fullRecoveryHours: 9,
            sleepHrvData: { avgSleepHrv: 72 },
            lthr: 171,
          },
        });

      case "/analyse/dayDetail/query": {
        const startDay = Number(url.searchParams.get("startDay") ?? "0");
        const endDay = Number(url.searchParams.get("endDay") ?? "99999999");
        const dayList = server.state.dayList.filter((d) => {
          const day = Number(d.happenDay);
          return day >= startDay && day <= endDay;
        });
        return envelope("0000", { dayList: structuredClone(dayList) });
      }

      case "/account/logout":
        validTokens.delete(token);
        return envelope("0000");

      default:
        return envelope("1001");
    }
  } as typeof fetch;

  server.fetchImpl = fetchImpl;
  return server;
}
