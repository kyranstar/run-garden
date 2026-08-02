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

export interface MockCorosServer {
  fetchImpl: typeof fetch;
  email: string;
  password: string;
  userId: string;
  baseMonday: string;
  state: {
    schedule: RawCorosSchedule;
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
  /** Envelope result POST /training/plan/add returns (1031 = the EU rejection). */
  planAddResult: string;
  /** `data` returned when planAddResult is "0000" (documented as the planId). */
  planAddData: unknown;
  /** Bodies received by POST /training/plan/add, in order. */
  planAddBodies: unknown[];
  entityByIdInPlan(idInPlan: string | number): RawCorosEntity | undefined;
  programByIdInPlan(idInPlan: string | number): RawCorosProgram | undefined;
}

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
      activities: [runActivity, bikeActivity, strengthActivity, yogaActivity],
      details: {
        "act-run-1": {
          summary: {
            distance: 1_000_000,
            totalTime: 3050,
            workoutTime: 3000,
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
    planAddResult: "1031", // "Parameter input error" — the one EU attempt on record
    planAddData: null,
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
    const schedule = server.state.schedule;
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
      serverIdCounter += 1;
      const entity = structuredClone(submitted);
      entity.id = `sv-entity-${serverIdCounter}`;
      const program = structuredClone(submittedProgram);
      program.id = `sv-program-${serverIdCounter}`;
      schedule.entities.push(entity);
      schedule.programs.push(program);
      schedule.maxIdInPlan = Math.max(Number(schedule.maxIdInPlan ?? 0), Number(vo.id));
      return envelope("0000");
    }

    if (vo.status === 3) {
      if (server.deleteRejectResult) return envelope(server.deleteRejectResult);
      schedule.entities = schedule.entities.filter((e) => String(e.idInPlan) !== String(vo.id));
      schedule.programs = schedule.programs.filter((p) => String(p.idInPlan) !== String(vo.id));
      // maxIdInPlan never decrements [verified]
      return envelope("0000");
    }

    return envelope("1031");
  }

  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
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
        const entities = (schedule.entities ?? []).filter((e) => {
          const day = Number(e.happenDay);
          return day >= startNum && day <= endNum;
        });
        const ids = new Set(entities.map((e) => String(e.idInPlan)));
        const programs = (schedule.programs ?? []).filter((p) => ids.has(String(p.idInPlan)));
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
        server.planAddBodies.push(JSON.parse(bodyText));
        return envelope(
          server.planAddResult,
          server.planAddResult === "0000" ? server.planAddData : null,
        );
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
  }) as typeof fetch;

  server.fetchImpl = fetchImpl;
  return server;
}
