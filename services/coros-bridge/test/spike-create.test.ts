/**
 * Offline coverage for the reversible create spike. Drives `runCreateSpike`
 * (the CLI-free core) against the stateful mock COROS server: no credentials,
 * no network, safe in CI.
 */

import { describe, expect, it } from "vitest";
import type { RawCorosExercise, RawCorosProgram } from "@rg/providers";
import { CorosClient } from "../src/coros-client.js";
import {
  runCreateSpike,
  type CreateSpikeHandle,
  type CreateSpikeReport,
} from "../src/spike-create.js";
import { mockCorosServer, nextMonday, type MockCorosServer } from "./mock-coros-server.js";

const noop = (): void => undefined;
const TODAY = new Date().toISOString().slice(0, 10);

async function setup(): Promise<{ server: MockCorosServer; client: CorosClient }> {
  const server = mockCorosServer({ baseMonday: nextMonday() });
  const client = new CorosClient({ region: "us", fetchImpl: server.fetchImpl, logger: noop });
  await client.login(server.email, server.password);
  return { server, client };
}

function baselineIds(server: MockCorosServer): string[] {
  return (server.state.schedule.entities ?? []).map((e) => String(e.idInPlan)).sort();
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
    const before = baselineIds(server);

    const report = await runCreateSpike(client, { today: TODAY, log: noop });

    expect(report.kind).toBe("coros-create-spike");
    expect(report.failure).toBeUndefined();

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
    expect(baselineIds(server)).toEqual(before);
    // maxIdInPlan never decrements — deletes are hard but the counter stands.
    expect(Number(server.state.schedule.maxIdInPlan)).toBe(23);
  });

  it("records the plan/add probe rejection verbatim", async () => {
    const { server, client } = await setup();
    const report = await runCreateSpike(client, { today: TODAY, log: noop });

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
    const report = await runCreateSpike(client, { today: TODAY, log: noop });
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
    const report = await runCreateSpike(client, { today: TODAY, log: noop });

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

describe("runCreateSpike — failure discipline", () => {
  it("reports leftovers instead of silently succeeding when cleanup is rejected", async () => {
    const { server, client } = await setup();
    const before = baselineIds(server);
    server.deleteRejectResult = "1001";

    const report = await runCreateSpike(client, { today: TODAY, log: noop });

    expect(report.tests.strength.verified).toBe(true);
    expect(report.tests.strength.cleanedUp).toBe(false);
    expect(report.overall.leftovers).toHaveLength(3);
    expect(report.overall.leftovers.join(" ")).toContain("idInPlan=21");
    expect(report.overall.baselineRestored).toBe(false);
    expect(report.succeeded).toBe(false);
    // The report tells the truth: the three spike workouts really are still there.
    expect(baselineIds(server).length).toBe(before.length + 3);
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
    await client.login(server.email, server.password);

    const report = await runCreateSpike(client, { today: TODAY, log: noop });

    expect(report.tests.strength.verified).toBe(true);
    expect(report.tests.run.verified).toBe(true);
    expect(report.failure).toBeDefined();
    expect(report.overall.baselineRestored).toBe(false);
    expect(report.succeeded).toBe(false);
    // Both created workouts are named as leftovers the user must remove.
    expect(report.overall.leftovers).toHaveLength(2);
    expect(report.overall.leftovers.join(" ")).toContain("idInPlan=21");
    expect(report.overall.leftovers.join(" ")).toContain("idInPlan=22");
  });

  it("cleans up an unexpectedly-successful plan/add and records the orphan plan id", async () => {
    const { server, client } = await setup();
    server.planAddResult = "0000";
    server.planAddData = { id: "plan-orphan-999" };

    const report = await runCreateSpike(client, { today: TODAY, log: noop });

    expect(report.tests.planAdd.resultCode).toBe("0000");
    expect(report.tests.planAdd.verified).toBe(true);
    expect(report.tests.planAdd.serverIds?.planId).toBe("plan-orphan-999");
    expect(report.tests.planAdd.cleanedUp).toBe(false);
    // Never silent: the undeletable plan is surfaced at the top level.
    expect(report.overall.orphanPlanIds).toEqual(["plan-orphan-999"]);
    expect(report.overall.capabilitiesConfirmed.planLevelCreate).toBe(true);
    expect(report.overall.baselineRestored).toBe(false);
    expect(report.succeeded).toBe(false);
    // …and the schedule-side cleanup still ran for the three workouts.
    for (const test of ["strength", "run", "bike"] as const) {
      expect(report.tests[test].cleanedUp).toBe(true);
    }
  });

  it("publishes an idempotent cleanup handle for the SIGINT path", async () => {
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
    expect(server.counts.scheduleWrites).toBe(writesBefore); // no double-delete
  });

  it("skips the plan/add probe when the caller opts out", async () => {
    const { server, client } = await setup();
    const report = await runCreateSpike(client, {
      today: TODAY,
      log: noop,
      includePlanAddProbe: false,
    });

    expect(report.tests.planAdd.attempted).toBe(false);
    expect(server.planAddBodies).toHaveLength(0);
    expect(report.overall.baselineRestored).toBe(true);
  });
});
