/**
 * Offline coverage for the reversible create spike. Drives `runCreateSpike`
 * (the CLI-free core) against the stateful mock COROS server: no credentials,
 * no network, safe in CI.
 */

import { describe, expect, it } from "vitest";
import { loginWithPassword } from "../src/coros-login.js";
import {
  FIXTURE_PLAN_ID,
  type RawCorosEntity,
  type RawCorosExercise,
  type RawCorosProgram,
  type RawCorosSchedule,
} from "@rg/providers";
import { CorosClient } from "@rg/coros";
import {
  observationWindows,
  parseInspectDates,
  runCreateSpike,
  type CreateSpikeHandle,
  type CreateSpikeReport,
} from "../src/spike-create.js";
import {
  mockCorosServer,
  nextMonday,
  REASSIGN_OFFSET,
  type MockCorosServer,
} from "./mock-coros-server.js";

const noop = (): void => undefined;
const TODAY = new Date().toISOString().slice(0, 10);
const SPIKE_NAME = "RG SPIKE — SAFE TO DELETE";

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function corosDay(iso: string): number {
  return Number(iso.replaceAll("-", ""));
}

function corosDayToIso(day: number | string): string {
  const s = String(day).padStart(8, "0");
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

async function setup(): Promise<{ server: MockCorosServer; client: CorosClient }> {
  const server = mockCorosServer({ baseMonday: nextMonday() });
  const client = new CorosClient({ region: "us", fetchImpl: server.fetchImpl, logger: noop });
  await loginWithPassword(client, server.email, server.password);
  return { server, client };
}

/** A leftover from an earlier run: entity + its stamp-named program. */
function stampedStray(
  server: MockCorosServer,
  idInPlan: string,
  date: string,
  label: string,
  entityId: string,
  planId: string = FIXTURE_PLAN_ID,
): void {
  server.state.schedule.entities!.push({
    id: entityId,
    idInPlan,
    planId,
    planProgramId: idInPlan,
    happenDay: corosDay(date),
  });
  server.state.schedule.programs!.push({
    id: `sv-program-${idInPlan}`,
    idInPlan,
    planId,
    name: `${SPIKE_NAME} ${label}`,
    sportType: label === "strength" ? 4 : 1,
  });
}

function scheduleIds(server: MockCorosServer): string[] {
  return (server.state.schedule.entities ?? []).map((e) => String(e.idInPlan)).sort();
}

/**
 * The exact shape of the plan the spike hit on its first live run
 * (docs/reports/coros-create-spike-2026-08-02.json): a COROS-authored template
 * plan "S4557" whose `maxIdInPlan` is 0 on the wire even though its entities
 * carry ids up to 45 — and which reuses ids 2, 8 and 38 across two entities
 * each, because idInPlan identifies the program-in-plan, not the entity.
 */
const LIVE_PLAN_ID = "800000000000004557";
const LIVE_ID_IN_PLAN = [
  1, 2, 2, 3, 4, 5, 6, 7, 8, 8, 9, 10, 11, 17, 18, 20, 21, 23, 24, 26, 35, 36, 37, 38, 38, 42, 45,
];

function liveShapeSchedule(): RawCorosSchedule {
  const entities: RawCorosEntity[] = LIVE_ID_IN_PLAN.map((id, i) => ({
    id: `7000000000000${1000 + i}`,
    idInPlan: String(id),
    planId: LIVE_PLAN_ID,
    planProgramId: String(id),
    // Spread across today-25 … today+27, i.e. entirely inside the ±30d window.
    happenDay: corosDay(addDaysIso(TODAY, -25 + i * 2)),
    dayNo: i + 1,
    sortNo: 1,
    sortNoInSchedule: 1,
    completeRate: "-1.00",
  }));
  const programs: RawCorosProgram[] = [...new Set(LIVE_ID_IN_PLAN)].map((id) => ({
    id: `9000000000000${id}`,
    idInPlan: String(id),
    planId: LIVE_PLAN_ID,
    name: "T3001",
    sportType: 1,
    subType: 65535,
    duration: 1800,
    trainingLoad: 30,
    version: 2,
    exercises: [],
  }));
  return {
    id: LIVE_PLAN_ID,
    name: "S4557",
    startDay: corosDay(addDaysIso(TODAY, -25)),
    endDay: corosDay(addDaysIso(TODAY, 60)),
    maxIdInPlan: 0, // the whole point: the counter is not maintained
    pbVersion: 2,
    version: 3,
    entities,
    programs,
  };
}

interface RequestShape {
  entity: Record<string, unknown>;
  program: RawCorosProgram;
}

function shapeOf(report: CreateSpikeReport, test: "strength" | "run" | "bike"): RequestShape {
  return report.tests[test].requestShape as RequestShape;
}

/**
 * Deep scan for any key matching /userid/i. The only permitted one is the
 * report's own top-level `userIdRedacted` (4 chars + ellipsis).
 */
function findUserIdKeys(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => findUserIdKeys(v, `${path}[${i}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      /userid/i.test(k) ? [`${path}.${k}`] : findUserIdKeys(v, `${path}.${k}`),
    );
  }
  return [];
}

describe("runCreateSpike — happy path", () => {
  it("creates strength + run + bike, verifies each, and restores the baseline", async () => {
    const { server, client } = await setup();
    const before = scheduleIds(server);

    const report = await runCreateSpike(client, { today: TODAY, log: noop });

    expect(report.kind).toBe("coros-create-spike");
    expect(report.failure).toBeUndefined();
    expect(report.abortReason).toBeUndefined();

    // TEST A — strength from scratch.
    expect(report.tests.strength.attempted).toBe(true);
    expect(report.tests.strength.resultCode).toBe("0000");
    expect(report.tests.strength.verified).toBe(true);
    expect(report.tests.strength.structuralChecks).toEqual({
      sportTypeIs4: true,
      repeatGroupPresent: true,
      groupSetsIs3: true,
      childTargetTypeIsReps: true,
      childTargetValueIs10: true,
      childIntensityTypeIsWeight: true,
    });
    expect(report.tests.strength.observedDate).toBe(report.tests.strength.scheduledDate);

    // TEST B — minimal 2-block run.
    expect(report.tests.run.verified).toBe(true);
    expect(report.tests.run.structuralChecks?.exactlyTwoBlocks).toBe(true);
    expect(report.tests.run.structuralChecks?.noRepeatGroup).toBe(true);

    // TEST C — bike probe: recorded either way (this mock accepts it).
    expect(report.tests.bike.attempted).toBe(true);
    expect(report.tests.bike.resultCode).toBe("0000");
    expect(report.tests.bike.verified).toBe(true);

    // Server ids recovered from the read-after-write, not from the write response.
    for (const test of ["strength", "run", "bike"] as const) {
      expect(report.tests[test].serverIds?.entityId).toMatch(/^sv-entity-/);
      expect(report.tests[test].serverIds?.programId).toMatch(/^sv-program-/);
      expect(report.tests[test].serverIds?.planId).toBeDefined();
      expect(report.tests[test].cleanedUp).toBe(true);
    }

    // Each create used a fresh maxIdInPlan + 1 (21, 22, 23 over the fixture's 20).
    expect([
      report.tests.strength.idInPlan,
      report.tests.run.idInPlan,
      report.tests.bike.idInPlan,
    ]).toEqual([21, 22, 23]);

    // Cleanup + restoration.
    expect(report.overall.leftovers).toEqual([]);
    expect(report.overall.orphanPlanIds).toEqual([]);
    expect(report.overall.baselineRestored).toBe(true);
    expect(report.overall.finalWorkoutCount).toBe(before.length);
    expect(report.succeeded).toBe(true);
    expect(scheduleIds(server)).toEqual(before);
    // maxIdInPlan never decrements — deletes are hard but the counter stands.
    expect(Number(server.state.schedule.maxIdInPlan)).toBe(23);
  });

  it("skips the plan/add probe unless the caller explicitly opts in", async () => {
    const { server, client } = await setup();
    const report = await runCreateSpike(client, { today: TODAY, log: noop });

    expect(report.tests.planAdd.attempted).toBe(false);
    expect(report.tests.planAdd.cleanedUp).toBe(true);
    expect(report.tests.planAdd.notes.join(" ")).toContain("opt-in only");
    expect(server.planAddBodies).toHaveLength(0);
    expect(report.overall.baselineRestored).toBe(true);
  });

  it("records the plan/add probe rejection verbatim when opted in", async () => {
    const { server, client } = await setup();
    const report = await runCreateSpike(client, {
      today: TODAY,
      log: noop,
      includePlanAddProbe: true,
    });

    expect(report.tests.planAdd.attempted).toBe(true);
    expect(report.tests.planAdd.resultCode).toBe("1031");
    expect(report.tests.planAdd.verified).toBe(false);
    expect(report.tests.planAdd.cleanedUp).toBe(true);
    expect(report.overall.capabilitiesConfirmed.planLevelCreate).toBe(false);
    expect(server.planAddBodies).toHaveLength(1);

    // §(b) shape: day-offset relative entity, versionObjects status 1.
    const body = server.planAddBodies[0] as Record<string, unknown>;
    expect(body.totalDay).toBe(2);
    expect(body.versionObjects).toEqual([{ id: 1, status: 1 }]);
    expect((body.entities as Array<Record<string, unknown>>)[0]?.happenDay).toBe("");
    expect((body.entities as Array<Record<string, unknown>>)[0]?.dayNo).toBe(1);
    // I4: region is derived from the client, not hardcoded to the CN capture.
    expect(body.region).toBe("us");
    expect(report.tests.planAdd.notes.join(" ")).toContain("us/eu are unknown");
  });

  it("sends the CN wire region value on a cn client", async () => {
    const server = mockCorosServer({ baseMonday: nextMonday() });
    const client = new CorosClient({ region: "cn", fetchImpl: server.fetchImpl, logger: noop });
    await loginWithPassword(client, server.email, server.password);

    await runCreateSpike(client, { today: TODAY, log: noop, includePlanAddProbe: true });

    expect((server.planAddBodies[0] as Record<string, unknown>).region).toBe(2);
  });

  it("runs the plan probe only after the A/B/C workouts are cleaned up", async () => {
    const { server } = await setup();
    const before = scheduleIds(server);
    let idsAtProbeTime: string[] = [];
    const observing: typeof fetch = async (input, init) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (href.includes("/training/plan/add")) idsAtProbeTime = scheduleIds(server);
      return server.fetchImpl(input, init);
    };
    const observed = new CorosClient({ region: "us", fetchImpl: observing, logger: noop });
    await loginWithPassword(observed, server.email, server.password);

    await runCreateSpike(observed, { today: TODAY, log: noop, includePlanAddProbe: true });

    // I2: by the time plan/add fires, the schedule is already back to baseline.
    expect(idsAtProbeTime).toEqual(before);
  });
});

describe("runCreateSpike — payload encodings (research §(b)/§(d))", () => {
  it("encodes bodyweight strength exactly: empty-string value, string display unit", async () => {
    const { client } = await setup();
    const report = await runCreateSpike(client, { today: TODAY, log: noop });
    const program = shapeOf(report, "strength").program;

    expect(program.sportType).toBe(4);
    expect(program.subType).toBe(65535);
    // exerciseNum counts REAL steps only — the repeat-group container is excluded.
    expect(program.exerciseNum).toBe(1);
    // Minor fix: calculate must not clobber the client-computed set count.
    expect(program.totalSets).toBe(3);

    const exercises = program.exercises as RawCorosExercise[];
    expect(exercises).toHaveLength(2);
    const container = exercises[0] as unknown as Record<string, unknown>;
    const child = exercises[1] as unknown as Record<string, unknown>;

    expect(container.exerciseType).toBe(0);
    expect(container.isGroup).toBe(true);
    expect(container.sets).toBe(3);
    expect(container.targetType).toBe(2);
    expect(container.restType).toBe(3);
    expect(container.groupId).toBe("0");

    expect(child.exerciseType).toBe(2);
    expect(child.targetType).toBe(3); // REPS
    expect(child.targetValue).toBe(10);
    expect(child.groupId).toBe("1"); // the container's id
    expect(child.isGroup).toBe(false);
    // §(d) bodyweight row of the weight-encoding table.
    expect(child.intensityType).toBe(1);
    expect(child.intensityValue).toBe(""); // empty STRING, not 0
    expect(child.intensityPercent).toBe(0);
    expect(child.intensityDisplayUnit).toBe("6"); // STRING, not number
    expect(child.intensityCustom).toBe(1);
    // originId comes from the live exercise catalog (targetType 3 entry).
    expect(child.originId).toBe("426109589008859137");

    // sortNo: top-level 2^24, sub-step +2^16.
    expect(container.sortNo).toBe(16_777_216);
    expect(child.sortNo).toBe(16_777_216 + 65_536);
  });

  it("names every created program with the ownership marker", async () => {
    const { client } = await setup();
    const report = await runCreateSpike(client, { today: TODAY, log: noop });
    for (const test of ["strength", "run", "bike"] as const) {
      const shape = shapeOf(report, test);
      expect(String(shape.program.name)).toContain(SPIKE_NAME);
      expect(String(shape.entity.name)).toContain(SPIKE_NAME);
    }
  });

  it("builds the run as 2 blocks, no group, no cooldown", async () => {
    const { client } = await setup();
    const report = await runCreateSpike(client, { today: TODAY, log: noop });
    const program = shapeOf(report, "run").program;
    const exercises = program.exercises as RawCorosExercise[];

    expect(program.sportType).toBe(1);
    expect(exercises).toHaveLength(2);
    expect(exercises.map((e) => e.exerciseType)).toEqual([1, 2]); // warmup, training
    expect(exercises.every((e) => e.isGroup !== true)).toBe(true);
    expect(exercises.some((e) => Number(e.exerciseType) === 3)).toBe(false); // no cooldown
    expect(exercises.every((e) => Number(e.targetType) === 2)).toBe(true); // TIME
  });

  it("applies calculate-then-add: server duration/load are spliced in before the create", async () => {
    const { client } = await setup();
    const report = await runCreateSpike(client, { today: TODAY, log: noop });

    expect(report.tests.strength.calculated).toEqual({ duration: 1234, trainingLoad: 42 });
    const program = shapeOf(report, "strength").program;
    expect(program.duration).toBe(1234);
    expect(program.estimatedTime).toBe(1234);
    expect(program.trainingLoad).toBe(42);
    expect(program.estimatedValue).toBe(42);
  });

  it("schedules the tests far outside real training (+21/+22/+23)", async () => {
    const { client } = await setup();
    const report = await runCreateSpike(client, {
      today: TODAY,
      log: noop,
      includePlanAddProbe: true,
    });
    const days = (d: string): number =>
      Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${TODAY}T00:00:00Z`)) / 86_400_000);

    expect(days(report.tests.strength.scheduledDate!)).toBe(21);
    expect(days(report.tests.run.scheduledDate!)).toBe(22);
    expect(days(report.tests.bike.scheduledDate!)).toBe(23);
    expect(days(report.tests.planAdd.scheduledDate!)).toBe(40);
  });
});

describe("runCreateSpike — report sanitization", () => {
  it("leaks no userId: neither the value nor any userId-shaped key", async () => {
    const { server, client } = await setup();
    const report = await runCreateSpike(client, { today: TODAY, log: noop });
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain(server.userId);
    expect(serialized).not.toContain(server.email);
    expect(serialized).not.toContain(server.password);
    expect(findUserIdKeys(report)).toEqual(["$.userIdRedacted"]);
    expect(report.userIdRedacted).toBe(`${server.userId.slice(0, 4)}…`);
    expect(report.userIdRedacted).not.toContain(server.userId);
    // …and the sanitized request shapes carry no userId key at all.
    expect(findUserIdKeys(report.tests)).toEqual([]);
  });

  it("has the documented report shape", async () => {
    const { client } = await setup();
    const report = await runCreateSpike(client, {
      today: TODAY,
      log: noop,
      includePlanAddProbe: true,
    });

    expect(Object.keys(report.tests).sort()).toEqual(["bike", "planAdd", "run", "strength"]);
    for (const test of Object.values(report.tests)) {
      expect(typeof test.attempted).toBe("boolean");
      expect(typeof test.verified).toBe("boolean");
      expect(typeof test.cleanedUp).toBe("boolean");
      expect(Array.isArray(test.notes)).toBe(true);
      expect(test.requestShape).toBeDefined();
      expect(typeof test.resultCode).toBe("string");
    }
    expect(report.baseline?.workoutCount).toBeGreaterThan(0);
    expect(report.baseline?.idInPlan.length).toBe(report.baseline?.workoutCount);
    expect(typeof report.overall.baselineRestored).toBe("boolean");
    expect(report.region).toBe("us");
    // Round-trips through JSON without loss (it is written to disk verbatim).
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});

describe("runCreateSpike — idInPlan derivation (live plan shape)", () => {
  it("sweeps ≤90-day windows covering today-180 … today+240", () => {
    const windows = observationWindows(TODAY);
    expect(windows[0]?.[0]).toBe(addDaysIso(TODAY, -180));
    expect(windows[windows.length - 1]?.[1]).toBe(addDaysIso(TODAY, 240));
    for (const [start, end] of windows) {
      const span =
        (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000;
      expect(span).toBeGreaterThanOrEqual(0);
      expect(span).toBeLessThanOrEqual(90); // /schedule/query 5011s beyond this
    }
    // Disjoint and contiguous: no entity is counted twice (duplicate detection).
    for (let i = 1; i < windows.length; i += 1) {
      expect(windows[i]![0]).toBe(addDaysIso(windows[i - 1]![1], 1));
    }
  });

  it("derives from the observed max when the plan does not maintain the counter", async () => {
    const { server, client } = await setup();
    server.state.schedule = liveShapeSchedule();
    server.maintainsIdCounter = false; // the counter stays 0 even after creates
    const before = scheduleIds(server);
    const lines: string[] = [];

    const report = await runCreateSpike(client, {
      today: TODAY,
      log: (line) => lines.push(line),
    });

    // The live diagnosis, reproduced.
    expect(report.baseline?.planName).toBe("S4557");
    expect(report.baseline?.workoutCount).toBe(27);
    expect(report.baseline?.maxIdInPlan).toBe(0);
    expect(report.baseline?.observedMaxIdInPlan).toBe(45);
    expect(report.baseline?.counterMaintained).toBe(false);
    expect(report.baseline?.duplicateIdInPlan).toEqual(["2", "8", "38"]);
    expect(report.baseline?.observedEntityCount).toBe(27);

    // 0 + 1 = 1 would have collided with a real workout; 45 + 1 does not. Each
    // subsequent id comes from a fresh observation, NOT from the counter.
    expect(report.tests.strength.idInPlan).toBe(46);
    expect(report.tests.run.idInPlan).toBe(47);
    expect(report.tests.bike.idInPlan).toBe(48);
    expect(report.tests.strength.idInPlanDerivedFrom).toEqual({ counter: 0, observedMax: 45 });
    expect(report.tests.run.idInPlanDerivedFrom).toEqual({ counter: 0, observedMax: 46 });

    // The spike gets to actually test something, and cleans up after itself.
    expect(report.tests.strength.verified).toBe(true);
    expect(report.tests.run.verified).toBe(true);
    expect(report.tests.bike.verified).toBe(true);
    expect(report.abortReason).toBeUndefined();
    expect(report.overall.baselineRestored).toBe(true);
    expect(report.succeeded).toBe(true);
    expect(scheduleIds(server)).toEqual(before);

    // The next live run explains itself from the console alone.
    const output = lines.join("\n");
    expect(output).toContain("maxIdInPlan(counter)=0");
    expect(output).toContain("maxIdInPlan(observed)=45");
    expect(output).toContain("next candidate 46");
    expect(output).toContain("does not maintain maxIdInPlan");
    expect(output).toContain("idInPlan values reused by multiple entities: 2, 8, 38");
  });

  it("still derives correctly when the counter IS maintained and leads", async () => {
    const { server, client } = await setup(); // fixture: counter 20, observed 20
    const report = await runCreateSpike(client, { today: TODAY, log: noop });

    expect(report.baseline?.counterMaintained).toBe(true);
    expect(report.baseline?.duplicateIdInPlan).toEqual([]);
    expect(report.tests.strength.idInPlan).toBe(21);
    expect(report.tests.strength.verified).toBe(true);
    expect(Number(server.state.schedule.maxIdInPlan)).toBe(23);
  });

  it("records a rejected create as informative and does not retry other ids", async () => {
    const { server, client } = await setup();
    server.state.schedule = liveShapeSchedule();
    // Model a server that allocates ids itself and rejects our claim.
    const rejecting: typeof fetch = async (input, init) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (href.includes("/training/schedule/update")) {
        return new Response(
          JSON.stringify({ apiCode: "TEST", message: "ERROR", result: "1031", data: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return server.fetchImpl(input, init);
    };
    const strict = new CorosClient({ region: "us", fetchImpl: rejecting, logger: noop });
    await loginWithPassword(strict, server.email, server.password);
    const before = scheduleIds(server);

    const report = await runCreateSpike(strict, { today: TODAY, log: noop });

    for (const test of ["strength", "run", "bike"] as const) {
      expect(report.tests[test].resultCode).toBe("1031");
      expect(report.tests[test].verified).toBe(false);
      expect(report.tests[test].cleanedUp).toBe(true);
      expect(report.tests[test].notes.join(" ")).toContain("not retrying with other ids");
      // Every attempt used the same correctly-derived id, never a guess.
      expect(report.tests[test].idInPlan).toBe(46);
    }
    expect(scheduleIds(server)).toEqual(before);
    expect(report.overall.baselineRestored).toBe(true);
  });
});

describe("runCreateSpike — ownership guard (C1)", () => {
  /**
   * A legacy workout at idInPlan 21, above the counter, on a different date
   * with a different name. Since the fix this no longer blocks the spike: the
   * wide observation sees id 21 and claims 22 instead — but the legacy workout
   * must still be left completely alone.
   */
  function seedCollision(server: MockCorosServer): RawCorosEntity {
    const legacy: RawCorosEntity = {
      id: "70000000000000999",
      idInPlan: "21",
      planId: FIXTURE_PLAN_ID,
      planProgramId: "21",
      happenDay: corosDay(addDaysIso(TODAY, -5)),
      name: "Legacy Tempo",
    };
    server.state.schedule.entities!.push(legacy);
    return legacy;
  }

  it("observes a legacy id above the counter and claims past it", async () => {
    const { server, client } = await setup();
    seedCollision(server);
    const before = scheduleIds(server);

    const report = await runCreateSpike(client, { today: TODAY, log: noop });

    // counter=20 but id 21 is in use → claim 22.
    expect(report.tests.strength.idInPlanDerivedFrom).toEqual({ counter: 20, observedMax: 21 });
    expect(report.tests.strength.idInPlan).toBe(22);
    expect(report.tests.strength.verified).toBe(true);
    // The legacy workout is untouched, on its own date, with its own name.
    const survivor = server.entityByIdInPlan("21");
    expect(survivor?.name).toBe("Legacy Tempo");
    expect(Number(survivor?.happenDay)).toBe(corosDay(addDaysIso(TODAY, -5)));
    expect(scheduleIds(server)).toEqual(before);
    expect(report.overall.baselineRestored).toBe(true);
  });

  it("aborts without writing when a foreign workout races into the derived slot", async () => {
    const { server } = await setup();
    const before = scheduleIds(server);
    const writesBefore = server.counts.scheduleWrites;
    // The derived id (21) is free during the observation sweep, then a foreign
    // workout lands on it before the pre-write read — the race the final
    // occupancy gate exists for.
    let sawObservation = false;
    let injected = false;
    const racing: typeof fetch = async (input, init) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.pathname === "/training/schedule/query") {
        const start = url.searchParams.get("startDate");
        if (start === String(corosDay(addDaysIso(TODAY, -180)))) sawObservation = true;
        else if (sawObservation && !injected && start === String(corosDay(addDaysIso(TODAY, -30)))) {
          injected = true;
          server.state.schedule.entities!.push({
            id: "70000000000000998",
            idInPlan: "21",
            planId: FIXTURE_PLAN_ID,
            planProgramId: "21",
            happenDay: corosDay(addDaysIso(TODAY, -5)),
            name: "Legacy Tempo",
          });
        }
      }
      return server.fetchImpl(input, init);
    };
    const raced = new CorosClient({ region: "us", fetchImpl: racing, logger: noop });
    await loginWithPassword(raced, server.email, server.password);
    const lines: string[] = [];

    const report = await runCreateSpike(raced, {
      today: TODAY,
      log: (line) => lines.push(line),
    });

    expect(injected).toBe(true);
    // Not one write was issued — not a create, and above all not a delete.
    expect(server.counts.scheduleWrites).toBe(writesBefore);
    expect(server.entityByIdInPlan("21")?.name).toBe("Legacy Tempo");
    expect(scheduleIds(server)).toEqual([...before, "21"].sort());

    expect(report.abortReason).toContain("21");
    expect(report.failure).toBeDefined();
    expect(report.succeeded).toBe(false);
    expect(report.tests.strength.notes.join(" ")).toContain("no write attempted");
    // Remaining tests are skipped rather than blundering on.
    expect(report.tests.run.attempted).toBe(false);
    expect(report.tests.bike.attempted).toBe(false);
    expect(report.overall.leftovers).toEqual([]);

    // The report is committed to the repo: identifiers only, never the title.
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("Legacy Tempo");
    expect(serialized).toContain("title printed to console");
    expect(serialized).toContain(`date=${addDaysIso(TODAY, -5)}`);
    expect(lines.join("\n")).toContain("Legacy Tempo");
  });

  it("never even considers a foreign workout that appears in its claimed slot", async () => {
    const { server } = await setup();
    // The slot is empty at the pre-write read, then a foreign workout lands in
    // it before the read-after-write (the race the reviewer flagged).
    server.addSilentlyFails = true; // the spike's own create never materializes
    const injecting: typeof fetch = async (input, init) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const res = await server.fetchImpl(input, init);
      if (href.includes("/training/schedule/update") && !server.entityByIdInPlan("21")) {
        server.state.schedule.entities!.push({
          idInPlan: "21",
          planId: FIXTURE_PLAN_ID,
          planProgramId: "21",
          happenDay: corosDay(addDaysIso(TODAY, -5)),
          name: "Someone Else's Workout",
        });
      }
      return res;
    };
    const raced = new CorosClient({ region: "us", fetchImpl: injecting, logger: noop });
    await loginWithPassword(raced, server.email, server.password);
    const lines: string[] = [];

    const report = await runCreateSpike(raced, {
      today: TODAY,
      log: (line) => lines.push(line),
    });

    // Recovery is by stamp, so a foreign workout landing on the claimed id is
    // simply never a candidate: it is not registered, not deleted, and its
    // title never reaches the report.
    expect(server.entityByIdInPlan("21")?.name).toBe("Someone Else's Workout");
    expect(report.tests.strength.notes.join(" ")).toContain("nothing materialized");
    expect(report.tests.strength.serverIdInPlan).toBeUndefined();
    expect(report.overall.leftovers).toEqual([]);
    expect(JSON.stringify(report)).not.toContain("Someone Else's Workout");
    // The account did change (something appeared that we did not create), and
    // the spike says so rather than claiming a clean run.
    expect(report.overall.baselineRestored).toBe(false);
    expect(lines.length).toBeGreaterThan(0);
  });

  it("records accepted-but-not-visible without registering anything", async () => {
    const { server, client } = await setup();
    const before = scheduleIds(server);
    server.addSilentlyFails = true;

    const report = await runCreateSpike(client, { today: TODAY, log: noop });

    for (const test of ["strength", "run", "bike"] as const) {
      expect(report.tests[test].resultCode).toBe("0000");
      expect(report.tests[test].verified).toBe(false);
      expect(report.tests[test].cleanedUp).toBe(true);
      expect(report.tests[test].notes.join(" ")).toContain("nothing materialized");
    }
    expect(report.overall.capabilitiesConfirmed).toEqual({
      strengthCreateFromScratch: false,
      minimalRunCreateFromScratch: false,
      minimalBikeCreateFromScratch: false,
      planLevelCreate: false,
    });
    expect(report.overall.leftovers).toEqual([]);
    expect(scheduleIds(server)).toEqual(before);
    expect(report.overall.baselineRestored).toBe(true);
  });
});

describe("runCreateSpike — abort / SIGINT drain (I1)", () => {
  it("drains everything created when aborted mid-sequence", async () => {
    const { server } = await setup();
    const before = scheduleIds(server);
    const handles: CreateSpikeHandle[] = [];
    let creates = 0;

    // Interrupt while the run create is in flight (2nd status:1 write).
    const interrupting: typeof fetch = async (input, init) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const res = await server.fetchImpl(input, init);
      if (href.includes("/training/schedule/update")) {
        creates += 1;
        if (creates === 2) handles[0]?.abort("interrupted (SIGINT)");
      }
      return res;
    };
    const interrupted = new CorosClient({ region: "us", fetchImpl: interrupting, logger: noop });
    await loginWithPassword(interrupted, server.email, server.password);

    const report = await runCreateSpike(interrupted, {
      today: TODAY,
      log: noop,
      onStart: (h) => handles.push(h),
    });

    expect(report.abortReason).toBe("interrupted (SIGINT)");
    // Strength landed before the abort; the run create was already in flight
    // and materialized — BOTH must be drained, not just the first.
    expect(report.tests.strength.cleanedUp).toBe(true);
    expect(report.tests.run.cleanedUp).toBe(true);
    // No write was issued after the abort.
    expect(report.tests.bike.attempted).toBe(false);
    expect(report.tests.bike.notes.join(" ")).toContain("aborted");
    // Restoration ran and the account really is back to baseline.
    expect(report.overall.leftovers).toEqual([]);
    expect(report.overall.finalWorkoutCount).toBe(before.length);
    expect(scheduleIds(server)).toEqual(before);
    // …but the run is still marked failed, because it did not complete.
    expect(report.succeeded).toBe(false);
  });

  it("reports leftovers when an abort's drain cannot remove what it created", async () => {
    const { server } = await setup();
    const handles: CreateSpikeHandle[] = [];
    let creates = 0;
    const interrupting: typeof fetch = async (input, init) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const res = await server.fetchImpl(input, init);
      if (href.includes("/training/schedule/update")) {
        creates += 1;
        if (creates === 1) {
          handles[0]?.abort("interrupted (SIGINT)");
          server.deleteRejectResult = "1001"; // deletes start failing
        }
      }
      return res;
    };
    const interrupted = new CorosClient({ region: "us", fetchImpl: interrupting, logger: noop });
    await loginWithPassword(interrupted, server.email, server.password);

    const report = await runCreateSpike(interrupted, {
      today: TODAY,
      log: noop,
      onStart: (h) => handles.push(h),
    });

    expect(report.overall.leftovers).toHaveLength(1);
    expect(report.overall.leftovers[0]).toContain("server idInPlan 21");
    expect(report.tests.strength.cleanedUp).toBe(false);
    expect(report.overall.baselineRestored).toBe(false);
    expect(report.succeeded).toBe(false);
    expect(server.entityByIdInPlan("21")).toBeDefined(); // the report is truthful
  });

  it("publishes an idempotent cleanup handle", async () => {
    const { server, client } = await setup();
    const handles: CreateSpikeHandle[] = [];

    const report = await runCreateSpike(client, {
      today: TODAY,
      log: noop,
      onStart: (h) => handles.push(h),
    });

    expect(handles).toHaveLength(1);
    expect(handles[0]?.report).toBe(report); // the live object, mutated in place
    const writesBefore = server.counts.scheduleWrites;
    await expect(handles[0]!.cleanup()).resolves.toBeUndefined();
    await expect(handles[0]!.finalize()).resolves.toBeUndefined();
    expect(server.counts.scheduleWrites).toBe(writesBefore); // no double-delete
  });
});

describe("runCreateSpike — failure discipline", () => {
  it("reports leftovers instead of silently succeeding when cleanup is rejected", async () => {
    const { server, client } = await setup();
    const before = scheduleIds(server);
    server.deleteRejectResult = "1001";

    const report = await runCreateSpike(client, { today: TODAY, log: noop });

    expect(report.tests.strength.verified).toBe(true);
    expect(report.tests.strength.cleanedUp).toBe(false);
    expect(report.overall.leftovers).toHaveLength(3);
    expect(report.overall.leftovers.join(" ")).toContain(`"${SPIKE_NAME} strength"`);
    expect(report.overall.leftovers.join(" ")).toContain("server idInPlan 21");
    expect(report.overall.baselineRestored).toBe(false);
    expect(report.succeeded).toBe(false);
    // The report tells the truth: the three spike workouts really are still there.
    expect(scheduleIds(server).length).toBe(before.length + 3);
  });

  it("attempts cleanup and records the exact state when the network dies mid-run", async () => {
    const server = mockCorosServer({ baseMonday: nextMonday() });
    let updates = 0;
    const flaky: typeof fetch = async (input, init) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (href.includes("/training/schedule/update")) {
        updates += 1;
        // Strength + run land, then everything fails from here on.
        if (updates > 2) throw new TypeError("fetch failed");
      } else if (updates > 2) {
        throw new TypeError("fetch failed");
      }
      return server.fetchImpl(input, init);
    };
    const client = new CorosClient({ region: "us", fetchImpl: flaky, logger: noop });
    await loginWithPassword(client, server.email, server.password);

    const report = await runCreateSpike(client, { today: TODAY, log: noop });

    expect(report.tests.strength.verified).toBe(true);
    expect(report.tests.run.verified).toBe(true);
    expect(report.failure).toBeDefined();
    expect(report.overall.baselineRestored).toBe(false);
    expect(report.succeeded).toBe(false);
    // Both created workouts are named as leftovers the user must remove.
    expect(report.overall.leftovers).toHaveLength(2);
    expect(report.overall.leftovers.join(" ")).toContain("server idInPlan 21");
    expect(report.overall.leftovers.join(" ")).toContain("server idInPlan 22");
  });
});

describe("runCreateSpike — plan/add unexpected success (C2/I3)", () => {
  it("removes the plan's own workouts, leaves foreign ones alone, flags the orphan plan", async () => {
    const { server } = await setup();
    server.planAddResult = "0000";
    server.planAddData = { id: "plan-orphan-999" };
    server.planAddMaterializes = true;

    // A workout that is NOT the spike's also appears in the sweep window
    // between the before/after reads — the sweep must not touch it.
    const foreignDay = corosDay(addDaysIso(TODAY, 45));
    const sweeping: typeof fetch = async (input, init) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const res = await server.fetchImpl(input, init);
      if (href.includes("/training/plan/add")) {
        server.state.schedule.entities!.push({
          id: "70000000000000777",
          idInPlan: "777",
          planId: FIXTURE_PLAN_ID,
          planProgramId: "777",
          happenDay: foreignDay,
          name: "Race Simulation",
        });
      }
      return res;
    };
    const swept = new CorosClient({ region: "us", fetchImpl: sweeping, logger: noop });
    await loginWithPassword(swept, server.email, server.password);
    const lines: string[] = [];

    const report = await runCreateSpike(swept, {
      today: TODAY,
      log: (line) => lines.push(line),
      includePlanAddProbe: true,
    });

    expect(report.tests.planAdd.resultCode).toBe("0000");
    expect(report.tests.planAdd.verified).toBe(true);
    expect(report.tests.planAdd.serverIds?.planId).toBe("plan-orphan-999");

    // The plan's materialized workout carried the spike's name → removed.
    const planWorkouts = (server.state.schedule.entities ?? []).filter((e) =>
      String(e.name ?? "").startsWith(SPIKE_NAME),
    );
    expect(planWorkouts).toEqual([]);
    // The foreign workout was left strictly alone.
    expect(server.entityByIdInPlan("777")?.name).toBe("Race Simulation");
    expect(report.tests.planAdd.notes.join(" ")).toContain("left untouched");
    // …and its title never reaches the committed report.
    expect(JSON.stringify(report)).not.toContain("Race Simulation");
    expect(lines.join("\n")).toContain("Race Simulation");

    // Never silent: the undeletable plan is surfaced at the top level.
    expect(report.overall.orphanPlanIds).toEqual(["plan-orphan-999"]);
    expect(report.overall.capabilitiesConfirmed.planLevelCreate).toBe(true);
    expect(report.tests.planAdd.cleanedUp).toBe(false);
    expect(report.overall.baselineRestored).toBe(false);
    expect(report.succeeded).toBe(false);

    // …and the schedule-side cleanup still ran for the three workouts.
    for (const test of ["strength", "run", "bike"] as const) {
      expect(report.tests[test].cleanedUp).toBe(true);
    }
  });
});

describe("runCreateSpike — server reassigns idInPlan (stamp recovery)", () => {
  it("recovers created workouts by stamp when the server renumbers them", async () => {
    const { server, client } = await setup();
    server.state.schedule = liveShapeSchedule();
    server.maintainsIdCounter = false;
    server.reassignsIdInPlan = "offset"; // stores at claimed + 7, ignoring our claim
    const before = scheduleIds(server);
    const lines: string[] = [];

    const report = await runCreateSpike(client, {
      today: TODAY,
      log: (line) => lines.push(line),
    });

    // Claimed vs stored are different at every step — id-based recovery would
    // have found nothing, which is exactly what happened on the live account.
    expect(report.tests.strength.idInPlan).toBe(46);
    expect(report.tests.strength.serverIdInPlan).toBe(String(46 + REASSIGN_OFFSET));
    expect(report.tests.run.serverIdInPlan).not.toBe(String(report.tests.run.idInPlan));
    expect(report.tests.bike.serverIdInPlan).not.toBe(String(report.tests.bike.idInPlan));
    expect(report.tests.strength.notes.join(" ")).toContain("server REASSIGNED idInPlan");
    expect(lines.join("\n")).toContain("server reassigned idInPlan");

    // Recovery by stamp still verifies the structure…
    expect(report.tests.strength.verified).toBe(true);
    expect(report.tests.run.verified).toBe(true);
    expect(report.tests.bike.verified).toBe(true);
    // …and, crucially, cleanup finds them and the account is restored.
    for (const test of ["strength", "run", "bike"] as const) {
      expect(report.tests[test].cleanedUp).toBe(true);
    }
    expect(report.overall.leftovers).toEqual([]);
    expect(report.overall.baselineRestored).toBe(true);
    expect(report.succeeded).toBe(true);
    expect(scheduleIds(server)).toEqual(before);
  });

  it("refuses to delete when renumbering makes the delete address ambiguous", async () => {
    const { server, client } = await setup();
    server.state.schedule = liveShapeSchedule();
    server.maintainsIdCounter = false;
    // The live shape taken to its worst case: the server files our workouts
    // under ids 1, 2, 3 — which real workouts in this plan already use.
    server.reassignsIdInPlan = "counter";
    const before = scheduleIds(server);

    const report = await runCreateSpike(client, { today: TODAY, log: noop });

    // The server filed our workouts under ids real workouts already use, so
    // each link key now resolves to BOTH a spike program and a real one. That
    // is ambiguous: nothing is claimed, nothing is deleted, and it is reported.
    expect(report.tests.strength.verified).toBe(false);
    expect(report.overall.leftovers.join(" ")).toContain("AMBIGUOUS STAMP");
    expect(report.overall.baselineRestored).toBe(false);
    expect(report.succeeded).toBe(false);

    // Every original workout is still there, untouched.
    expect(scheduleIds(server)).toEqual([...before, "1", "2", "3"].sort());
    for (const id of before) expect(server.entityByIdInPlan(id)).toBeDefined();
  });
});

describe("runCreateSpike — stray sweep + cleanup-only mode", () => {
  /**
   * Two leftovers from an earlier run, plus a real workout beside them. The
   * stamp lives on the PROGRAM — entity names do not round-trip, as the live
   * inspect proved.
   */
  function seedStrays(server: MockCorosServer): void {
    stampedStray(server, "90", addDaysIso(TODAY, 21), "strength", "70000000000000901");
    stampedStray(server, "91", addDaysIso(TODAY, 22), "run", "70000000000000902");
    server.state.schedule.entities!.push({
      id: "70000000000000903",
      idInPlan: "92",
      planId: FIXTURE_PLAN_ID,
      planProgramId: "92",
      happenDay: corosDay(addDaysIso(TODAY, 25)),
    });
    server.state.schedule.programs!.push({
      idInPlan: "92",
      planId: FIXTURE_PLAN_ID,
      name: "Race Simulation",
      sportType: 1,
    });
  }

  it("cleanup-only removes stamped strays and creates nothing", async () => {
    const { server, client } = await setup();
    seedStrays(server);
    const lines: string[] = [];

    const report = await runCreateSpike(client, {
      today: TODAY,
      cleanupOnly: true,
      log: (line) => lines.push(line),
    });

    expect(report.mode).toBe("cleanup-only");
    expect(report.strays?.found).toHaveLength(2);
    expect(report.strays?.removed).toHaveLength(2);
    expect(report.strays?.failed).toEqual([]);
    expect(report.strays?.windowStart).toBe(TODAY);
    expect(report.strays?.windowEnd).toBe(addDaysIso(TODAY, 60));

    // Both strays gone; the real workout beside them untouched.
    expect(server.entityByIdInPlan("90")).toBeUndefined();
    expect(server.entityByIdInPlan("91")).toBeUndefined();
    expect(server.entityByIdInPlan("92")).toBeDefined();
    // Exactly two writes: the two deletes. Nothing was created.
    expect(server.counts.scheduleWrites).toBe(2);
    for (const test of Object.values(report.tests)) {
      expect(test.attempted).toBe(false);
      expect(test.notes.join(" ")).toContain("cleanup-only");
    }
    expect(report.overall.leftovers).toEqual([]);
    expect(lines.join("\n")).toContain(`"${SPIKE_NAME} strength" on ${addDaysIso(TODAY, 21)}`);
  });

  it("a full run sweeps earlier strays before creating anything", async () => {
    const { server, client } = await setup();
    seedStrays(server);

    const report = await runCreateSpike(client, { today: TODAY, log: noop });

    expect(report.mode).toBe("full");
    expect(report.strays?.removed).toHaveLength(2);
    // The strays occupied the very dates the spike writes to; once swept, the
    // creates land and verify cleanly.
    expect(report.tests.strength.verified).toBe(true);
    expect(report.tests.run.verified).toBe(true);
    expect(report.overall.baselineRestored).toBe(true);
    expect(report.succeeded).toBe(true);
    expect(server.entityByIdInPlan("92")).toBeDefined();
    expect(scheduleIds(server)).not.toContain("90");
  });

  it("reports a stray it cannot remove instead of claiming success", async () => {
    const { server, client } = await setup();
    seedStrays(server);
    server.deleteRejectResult = "1001";

    const report = await runCreateSpike(client, {
      today: TODAY,
      cleanupOnly: true,
      log: noop,
    });

    expect(report.strays?.removed).toEqual([]);
    expect(report.strays?.failed).toHaveLength(2);
    expect(report.overall.leftovers).toHaveLength(2);
    expect(report.overall.baselineRestored).toBe(false);
    expect(report.succeeded).toBe(false);
    expect(server.entityByIdInPlan("90")).toBeDefined();
  });
});

describe("runCreateSpike — plan-wide delete guards", () => {
  /**
   * Demonstrated attack: the ambiguity guard only saw the sweep window, so a
   * real workout sharing the delete triple far outside it was invisible — and
   * a status:3 delete is plan-wide, so it would have been destroyed.
   */
  it("sees a colliding workout 120 days out, outside every working window", async () => {
    const { server, client } = await setup();
    server.maintainsIdCounter = false;
    server.reassignsIdInPlan = "counter"; // stores at maxIdInPlan+1 = 21
    // A real workout far outside every working window, sharing the exact
    // delete address our first create will be given — and with no program of
    // its own in the read, so classification alone would not save it. The
    // stamp-independent address check is the last line, and this is it.
    const victim: RawCorosEntity = {
      id: "70000000000000555",
      idInPlan: "21",
      planId: FIXTURE_PLAN_ID,
      planProgramId: "21",
      happenDay: corosDay(addDaysIso(TODAY, 120)), // far outside ±30 and ±60
      name: "Marathon Race",
    };
    server.state.schedule.entities!.push(victim);
    const writesBefore = server.counts.scheduleWrites;

    const report = await runCreateSpike(client, { today: TODAY, log: noop });

    // The workout 120 days out is untouched — identified by its server id, not
    // by an id-multiset that reassignment makes meaningless.
    const survivor = (server.state.schedule.entities ?? []).find(
      (e) => e.id === "70000000000000555",
    );
    expect(survivor).toBeDefined();
    expect(survivor?.name).toBe("Marathon Race");
    expect(Number(survivor?.happenDay)).toBe(corosDay(addDaysIso(TODAY, 120)));

    // Only the workout whose delete address collided is refused; the other two
    // are addressable and get removed.
    expect(report.overall.leftovers).toHaveLength(1);
    expect(report.overall.leftovers[0]).toContain("delete address");
    expect(report.overall.leftovers[0]).toContain("remove it by hand");
    expect(report.tests.strength.cleanedUp).toBe(false);
    expect(report.tests.run.cleanedUp).toBe(true);
    expect(report.tests.bike.cleanedUp).toBe(true);
    expect(report.overall.baselineRestored).toBe(false);
    expect(report.succeeded).toBe(false);
    // 3 creates + exactly 2 deletes: the colliding one was never sent.
    expect(server.counts.scheduleWrites).toBe(writesBefore + 5);
  });

  /**
   * Demonstrated attack: a real, NAMED workout whose own program is missing
   * from the response was classified as the spike's because a stamped program
   * happened to share its idInPlan.
   */
  it("never touches another plan's workout that shares an idInPlan", async () => {
    const { server, client } = await setup();
    // The account's own container is the target; a COROS template plan is
    // merged into every read and reuses the same idInPlan values.
    const templateId = "479324793288704499";
    server.state.mergedPlans.push({
      id: templateId,
      name: "S4557",
      maxIdInPlan: 48,
      entities: [
        {
          id: "tpl-entity-1",
          idInPlan: "1",
          planId: templateId,
          planProgramId: "1",
          happenDay: corosDay(addDaysIso(TODAY, 21)),
          name: "Template Tempo",
        },
      ],
      programs: [{ id: "tpl-prog-1", idInPlan: "1", planId: templateId, name: "T3001", sportType: 1 }],
    });
    // A leftover of ours in the CONTAINER at the very same idInPlan and date.
    stampedStray(server, "1", addDaysIso(TODAY, 21), "strength", "container-1");

    const report = await runCreateSpike(client, {
      today: TODAY,
      cleanupOnly: true,
      log: noop,
    });

    // Exactly one stray — ours. The template plan's row is invisible to every
    // decision because it belongs to a different planId.
    expect(report.strays?.found).toHaveLength(1);
    expect(report.strays?.removed).toHaveLength(1);
    expect(
      (server.state.schedule.entities ?? []).find((e) => e.id === "container-1"),
    ).toBeUndefined();
    // The template plan is untouched, by server-assigned entity id.
    const template = server.state.mergedPlans[0]!;
    expect((template.entities ?? []).map((e) => e.id)).toEqual(["tpl-entity-1"]);
    expect((template.programs ?? []).map((p) => p.id)).toEqual(["tpl-prog-1"]);
  });
});

describe("runCreateSpike — dry run (read-only)", () => {
  function seedStamped(server: MockCorosServer): void {
    server.state.schedule.entities!.push(
      {
        id: "70000000000000701",
        idInPlan: "49",
        planId: FIXTURE_PLAN_ID,
        planProgramId: "49",
        happenDay: corosDay(addDaysIso(TODAY, 21)),
      },
      {
        // Unstamped, shares planId+idInPlan, DIFFERENT planProgramId.
        id: "70000000000000702",
        idInPlan: "49",
        planId: FIXTURE_PLAN_ID,
        planProgramId: "77",
        happenDay: corosDay(addDaysIso(TODAY, 100)),
        name: "Club Handicap",
      },
    );
    server.state.schedule.programs!.push({
      id: "sv-program-strength",
      idInPlan: "49",
      planId: FIXTURE_PLAN_ID,
      name: `${SPIKE_NAME} strength`,
      sportType: 4,
      subType: 65535,
      duration: 1234,
      trainingLoad: 42,
      exerciseNum: 1,
      totalSets: 3,
      exercises: [
        { id: 1, exerciseType: 0, targetType: 2, targetValue: 60, sets: 3, isGroup: true, originId: "0" },
        {
          id: 2,
          exerciseType: 2,
          targetType: 3,
          targetValue: 10,
          intensityType: 1,
          intensityValue: "",
          intensityDisplayUnit: "6",
          intensityCustom: 1,
          originId: "426109589008859137",
        },
      ],
    } as never);
  }

  it("reports ids, stored structure and collisions without writing anything", async () => {
    const { server, client } = await setup();
    seedStamped(server);
    const writesBefore = server.counts.scheduleWrites;
    const lines: string[] = [];

    const report = await runCreateSpike(client, {
      today: TODAY,
      dryRun: true,
      log: (line) => lines.push(line),
    });

    expect(report.mode).toBe("dry-run");
    // ZERO writes — the whole point of the mode.
    expect(server.counts.scheduleWrites).toBe(writesBefore);
    expect(server.counts.scheduleWrites).toBe(0);

    const dry = report.dryRun;
    expect(dry?.stamped).toHaveLength(1);
    const stray = dry!.stamped[0]!;
    expect(stray.stampName).toBe(`${SPIKE_NAME} strength`);
    expect(stray.date).toBe(addDaysIso(TODAY, 21));
    expect(stray.planId).toBe(FIXTURE_PLAN_ID);
    expect(stray.idInPlan).toBe("49");
    expect(stray.planProgramId).toBe("49");
    expect(stray.planProgramIdEqualsIdInPlan).toBe(true);
    expect(stray.entityId).toBe("70000000000000701");

    // Full structure, so the round-trip can be checked against what we submit.
    expect(stray.program?.sportType).toBe(4);
    expect(stray.program?.subType).toBe(65535);
    expect(stray.program?.exercises).toHaveLength(2);
    expect(stray.program?.exercises[0]).toMatchObject({
      exerciseType: 0,
      targetType: 2,
      sets: 3,
      isGroup: true,
    });
    expect(stray.program?.exercises[1]).toMatchObject({
      exerciseType: 2,
      targetType: 3,
      targetValue: 10,
      intensityType: 1,
      intensityValue: "",
      intensityDisplayUnit: "6",
      originId: "426109589008859137",
    });

    // The collision question: is our delete triple unique?
    expect(dry?.collisions).toHaveLength(1);
    expect(dry?.collisions[0]).toMatchObject({
      idInPlan: "49",
      planProgramId: "77",
      fullTripleMatches: false, // triple differs → a delete IS addressable
      date: addDaysIso(TODAY, 100),
    });

    const output = lines.join("\n");
    expect(output).toContain("read-only, no writes");
    expect(output).toContain("planProgramId=49");
    expect(output).toContain("COLLISION");
    expect(output).toContain("triple differs, delete is addressable");
    // A real workout's title still never reaches the report.
    expect(JSON.stringify(report)).not.toContain("Club Handicap");
  });

  it("flags a link key that resolves to both a spike and a non-spike program", async () => {
    const { server, client } = await setup();
    seedStamped(server);
    // The unstamped workout now shares the link key AND has its own program:
    // the key no longer resolves unanimously, so nothing may be claimed.
    const other = (server.state.schedule.entities ?? []).find(
      (e) => e.id === "70000000000000702",
    );
    other!.planProgramId = "49";
    server.state.schedule.programs!.unshift({
      idInPlan: "49",
      planId: FIXTURE_PLAN_ID,
      name: "Club Handicap",
      sportType: 1,
    });

    const report = await runCreateSpike(client, { today: TODAY, dryRun: true, log: noop });

    expect(report.dryRun?.ambiguousStamps.length).toBeGreaterThan(0);
    expect(report.dryRun?.stamped).toHaveLength(0); // nothing claimed
    expect(server.counts.scheduleWrites).toBe(0);
  });
});

describe("runCreateSpike — inspect mode (read-only wire dump)", () => {
  /**
   * The live dry run found ZERO stamped workouts on a plan that demonstrably
   * held the spike's creates — so the stamp may not round-trip at all. This
   * mode exists to show the wire truth: every field, unredacted except for
   * user ids, for the dates in question and for every entity elsewhere
   * sharing their idInPlan.
   */
  function seedUnnamedStrays(server: MockCorosServer): void {
    // What the account appears to actually hold: extra entities at ids 1/2/3
    // carrying NO name, beside the real workouts at those same ids.
    server.state.schedule.entities!.push(
      {
        id: "70000000000000801",
        idInPlan: "11",
        planId: FIXTURE_PLAN_ID,
        planProgramId: "11",
        happenDay: corosDay(addDaysIso(TODAY, 21)),
        // no name — the shape the live dry run implies
      },
      {
        id: "70000000000000802",
        idInPlan: "12",
        planId: FIXTURE_PLAN_ID,
        planProgramId: "12",
        happenDay: corosDay(addDaysIso(TODAY, 22)),
      },
    );
  }

  it("dumps full entity + program objects for the given dates, and writes nothing", async () => {
    const { server, client } = await setup();
    seedUnnamedStrays(server);
    const lines: string[] = [];

    const report = await runCreateSpike(client, {
      today: TODAY,
      inspectDates: [addDaysIso(TODAY, 21), addDaysIso(TODAY, 22)],
      log: (line) => lines.push(line),
    });

    expect(report.mode).toBe("inspect");
    expect(server.counts.scheduleWrites).toBe(0); // read-only, pinned

    const inspect = report.inspect;
    expect(inspect?.dates).toEqual([addDaysIso(TODAY, 21), addDaysIso(TODAY, 22)]);
    expect(inspect?.onDates).toHaveLength(2);
    expect(inspect?.idInPlanOnDates).toEqual(["11", "12"]);
    expect(inspect?.planId).toBe(FIXTURE_PLAN_ID);

    // Every field is preserved verbatim — including the ABSENT name, which is
    // the whole question.
    const dumped = inspect!.onDates[0]!.entity as Record<string, unknown>;
    expect(dumped.id).toBe("70000000000000801");
    expect(dumped.idInPlan).toBe("11");
    expect(dumped.planProgramId).toBe("11");
    expect(dumped.happenDay).toBe(corosDay(addDaysIso(TODAY, 21)));
    expect("name" in dumped).toBe(false);

    // …and the real workouts elsewhere sharing those ids, to compare against.
    expect(inspect!.sameIdElsewhere.length).toBeGreaterThan(0);
    const others = inspect!.sameIdElsewhere.map(
      (o) => (o.entity as Record<string, unknown>).idInPlan,
    );
    expect(others).toContain("11");
    expect(inspect!.sameIdElsewhere[0]!.programs.length).toBeGreaterThan(0);

    // Console carries the same dump for a live run.
    const output = lines.join("\n");
    expect(output).toContain("read-only, no writes");
    expect(output).toContain('"idInPlan": "11"');
    expect(output).toContain("ENTITY:");
    expect(output).toContain("PROGRAMS");
  });

  it("keeps user ids out of the dump but nothing else", async () => {
    const { server, client } = await setup();
    server.state.schedule.entities![0]!.userId = server.userId;
    server.state.schedule.entities![0]!.operateUserId = server.userId;
    const date = corosDayToIso(server.state.schedule.entities![0]!.happenDay);

    const report = await runCreateSpike(client, {
      today: TODAY,
      inspectDates: [date],
      log: noop,
    });

    const serialized = JSON.stringify(report.inspect);
    expect(serialized).not.toContain(server.userId);
    expect(serialized).not.toContain("operateUserId");
    // The warning travels with the data.
    expect(report.inspect?.warning).toContain("do not commit");
    expect(server.counts.scheduleWrites).toBe(0);
  });
});

describe("parseInspectDates", () => {
  it("accepts both --inspect <dates> and --inspect=<dates>", () => {
    expect(parseInspectDates(["node", "spike", "--inspect", "2026-08-23,2026-08-24"])).toEqual([
      "2026-08-23",
      "2026-08-24",
    ]);
    expect(parseInspectDates(["node", "spike", "--inspect=2026-08-25"])).toEqual(["2026-08-25"]);
    expect(parseInspectDates(["node", "spike", "--dry-run"])).toBeUndefined();
  });

  it("refuses anything that is not a yyyy-mm-dd list", () => {
    expect(() => parseInspectDates(["node", "spike", "--inspect"])).toThrow(/yyyy-mm-dd/);
    expect(() => parseInspectDates(["node", "spike", "--inspect", "tomorrow"])).toThrow(
      /yyyy-mm-dd/,
    );
  });
});

describe("runCreateSpike — multi-plan accounts (the live shape)", () => {
  /**
   * The account the spike actually ran against, reproduced exactly:
   *
   *  - a COROS-authored TEMPLATE plan "S4557" holding the 27 real workouts,
   *    with idInPlan values up to 48 (and duplicates at 2, 8 and 38);
   *  - the account's own plan CONTAINER, empty, counter at 0 — which is what
   *    the top-level fields of a schedule read describe, and where creates land.
   *
   * `/training/schedule/query` merges both into one response. Every anomaly of
   * the first two live runs came from reasoning over that merged view.
   */
  const TEMPLATE_PLAN_ID = "479324793288704499";
  const CONTAINER_PLAN_ID = "473846232060707016";

  function liveTwoPlanServer(): MockCorosServer {
    const server = mockCorosServer({ baseMonday: nextMonday() });
    // The container: the target plan, empty, counter 0.
    server.state.schedule = {
      id: CONTAINER_PLAN_ID,
      name: "My Plan",
      startDay: corosDay(addDaysIso(TODAY, -25)),
      endDay: corosDay(addDaysIso(TODAY, 60)),
      maxIdInPlan: 0,
      pbVersion: 2,
      version: 1,
      entities: [],
      programs: [],
    };
    // The template plan, merged into every read.
    const template = liveShapeSchedule();
    template.id = TEMPLATE_PLAN_ID;
    for (const entity of template.entities ?? []) entity.planId = TEMPLATE_PLAN_ID;
    for (const program of template.programs ?? []) program.planId = TEMPLATE_PLAN_ID;
    server.state.mergedPlans.push(template);
    return server;
  }

  async function connect(server: MockCorosServer): Promise<CorosClient> {
    const client = new CorosClient({ region: "us", fetchImpl: server.fetchImpl, logger: noop });
    await loginWithPassword(client, server.email, server.password);
    return client;
  }

  function templateEntityIds(server: MockCorosServer): string[] {
    return (server.state.mergedPlans[0]?.entities ?? []).map((e) => String(e.id)).sort();
  }

  it("derives idInPlan from the target plan alone, ignoring the template plan", async () => {
    const server = liveTwoPlanServer();
    const client = await connect(server);
    const templateBefore = templateEntityIds(server);
    const lines: string[] = [];

    const report = await runCreateSpike(client, {
      today: TODAY,
      log: (line) => lines.push(line),
    });

    // The container is empty, so the first free id is 1 — even though the
    // merged read shows ids up to 45. Deriving from the merged view is what
    // made run 1 abort on a bogus "slot occupied".
    expect(report.baseline?.observedMaxIdInPlan).toBe(0);
    expect(report.tests.strength.idInPlan).toBe(1);
    expect(report.tests.run.idInPlan).toBe(2);
    expect(report.tests.bike.idInPlan).toBe(3);
    expect(report.abortReason).toBeUndefined();

    // The creates land in the container and are found there — run 2's
    // "ACCEPTED BUT NOT VISIBLE" was locate() searching the merged view.
    expect(report.tests.strength.verified).toBe(true);
    expect(report.tests.run.verified).toBe(true);
    expect(report.tests.bike.verified).toBe(true);
    expect(report.tests.strength.serverIds?.planId).toBe(CONTAINER_PLAN_ID);

    // Cleanup empties the container and never touches the template plan.
    expect(report.overall.leftovers).toEqual([]);
    expect(report.overall.baselineRestored).toBe(true);
    expect(report.succeeded).toBe(true);
    expect(server.state.schedule.entities).toEqual([]);
    expect(templateEntityIds(server)).toEqual(templateBefore);

    // The console explains the multi-plan account.
    expect(lines.join("\n")).toContain(`target plan ${CONTAINER_PLAN_ID}`);
    expect(lines.join("\n")).toContain("merges 2 plan(s)");
  });

  it("sweeps the three strays the live run left, and only those", async () => {
    const server = liveTwoPlanServer();
    // Exactly what the account holds now: three container entities at ids
    // 1/2/3 whose programs carry the stamp, beside template ids 1/2/3.
    stampedStray(server, "1", addDaysIso(TODAY, 21), "strength", "sv-e-1", CONTAINER_PLAN_ID);
    stampedStray(server, "2", addDaysIso(TODAY, 22), "run", "sv-e-2", CONTAINER_PLAN_ID);
    stampedStray(server, "3", addDaysIso(TODAY, 23), "bike", "sv-e-3", CONTAINER_PLAN_ID);
    server.state.schedule.maxIdInPlan = 3;
    const client = await connect(server);
    const templateBefore = templateEntityIds(server);

    const report = await runCreateSpike(client, {
      today: TODAY,
      cleanupOnly: true,
      log: noop,
    });

    expect(report.strays?.found).toHaveLength(3);
    expect(report.strays?.removed).toHaveLength(3);
    expect(report.strays?.failed).toEqual([]);
    expect(server.state.schedule.entities).toEqual([]);
    // The template plan's 27 workouts — including its own ids 1, 2 and 3 —
    // are untouched, asserted by server-assigned entity id.
    expect(templateEntityIds(server)).toEqual(templateBefore);
    expect(templateEntityIds(server)).toHaveLength(27);
    // Deletes only: three of them, one per stray.
    expect(server.counts.scheduleWrites).toBe(3);
  });

  it("keeps the template plan untouchable when its ids collide with new creates", async () => {
    const server = liveTwoPlanServer();
    const client = await connect(server);
    const templateBefore = templateEntityIds(server);
    const templateProgramsBefore = (server.state.mergedPlans[0]?.programs ?? []).length;

    // Container ids 1/2/3 collide with template ids 1/2/3 throughout.
    const report = await runCreateSpike(client, { today: TODAY, log: noop });

    expect(report.tests.strength.idInPlan).toBe(1);
    expect(report.succeeded).toBe(true);
    expect(templateEntityIds(server)).toEqual(templateBefore);
    expect(server.state.mergedPlans[0]?.programs).toHaveLength(templateProgramsBefore);
  });

  it("reports the per-plan breakdown in dry-run so a merged read is legible", async () => {
    const server = liveTwoPlanServer();
    stampedStray(server, "1", addDaysIso(TODAY, 21), "strength", "sv-e-1", CONTAINER_PLAN_ID);
    const client = await connect(server);

    const report = await runCreateSpike(client, { today: TODAY, dryRun: true, log: noop });

    expect(server.counts.scheduleWrites).toBe(0);
    expect(report.dryRun?.planId).toBe(CONTAINER_PLAN_ID);
    const plans = report.dryRun?.plans ?? [];
    expect(plans).toHaveLength(2);
    expect(plans.find((p) => p.planId === TEMPLATE_PLAN_ID)?.entityCount).toBe(27);
    expect(plans.find((p) => p.planId === CONTAINER_PLAN_ID)?.entityCount).toBe(1);
    // Only the container's stray is reported as the spike's.
    expect(report.dryRun?.stamped).toHaveLength(1);
    expect(report.dryRun?.stamped[0]?.planId).toBe(CONTAINER_PLAN_ID);
    // Template rows never appear as collisions: the delete address includes planId.
    expect(report.dryRun?.collisions).toEqual([]);
  });
});
