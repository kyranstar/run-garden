import { describe, expect, it } from "vitest";
import { corosProgramFingerprint, FIXTURE_PLAN_ID } from "@rg/providers";
import { CorosClient } from "../src/coros-client.js";
import { executeMoveJob, type MoveJob } from "../src/write-executor.js";
import { mockCorosServer, type MockCorosServer } from "./mock-coros-server.js";

const BASE_MONDAY = "2026-08-03";
// Fixture: idInPlan 11 = "Threshold 5x5" on D+1 (Tue 2026-08-04); Friday D+4 is free.
const ORIGINAL = "2026-08-04";
const DESTINATION = "2026-08-07";
const noop = (): void => undefined;

async function setup(): Promise<{ server: MockCorosServer; client: CorosClient }> {
  const server = mockCorosServer({ baseMonday: BASE_MONDAY });
  const client = new CorosClient({ region: "us", fetchImpl: server.fetchImpl, logger: noop });
  await client.login(server.email, server.password);
  return { server, client };
}

function job(server: MockCorosServer, overrides: Partial<MoveJob> = {}): MoveJob {
  const program = server.state.schedule.programs?.find((p) => String(p.idInPlan) === "11");
  return {
    id: "job-1",
    originalDate: ORIGINAL,
    destinationDate: DESTINATION,
    expectedContentFingerprint: corosProgramFingerprint(program!),
    workout: { sourceIdInPlan: "11", sourcePlanId: FIXTURE_PLAN_ID },
    ...overrides,
  };
}

describe("executeMoveJob — direct update path", () => {
  it("moves the workout and verifies via read-after-write", async () => {
    const { server, client } = await setup();
    const result = await executeMoveJob(client, job(server));

    expect(result.jobId).toBe("job-1");
    expect(result.outcome).toBe("verified");
    expect(result.pathUsed).toBe("direct_update");
    expect(result.observedDate).toBe(DESTINATION);
    expect(result.observedVersion).toBe("3");
    expect(result.observedFingerprint).toBeDefined();

    const entity = server.entityByIdInPlan("11");
    expect(Number(entity?.happenDay)).toBe(20260807);
    expect(entity?.dayNo).toBe(5); // recomputed from plan startDay
  });

  it("is idempotent: a re-run observes the desired state without writing", async () => {
    const { server, client } = await setup();
    await executeMoveJob(client, job(server));
    const writesAfterFirst = server.counts.scheduleWrites;
    expect(writesAfterFirst).toBe(1);

    const rerun = await executeMoveJob(client, job(server));
    expect(rerun.outcome).toBe("already_in_desired_state");
    expect(rerun.observedDate).toBe(DESTINATION);
    expect(server.counts.scheduleWrites).toBe(writesAfterFirst); // no second write
  });

  it("refuses to write when the workout moved upstream", async () => {
    const { server, client } = await setup();
    const result = await executeMoveJob(
      client,
      job(server, { originalDate: "2026-08-05", destinationDate: "2026-08-08" }),
    );
    expect(result.outcome).toBe("upstream_changed");
    expect(result.observedDate).toBe(ORIGINAL); // where COROS actually has it
    expect(server.counts.scheduleWrites).toBe(0);
    expect(Number(server.entityByIdInPlan("11")?.happenDay)).toBe(20260804);
  });

  it("reports workout_not_found when the entity is gone upstream", async () => {
    const { server, client } = await setup();
    const result = await executeMoveJob(
      client,
      job(server, { workout: { sourceIdInPlan: "99", sourcePlanId: FIXTURE_PLAN_ID } }),
    );
    expect(result.outcome).toBe("upstream_changed");
    expect(result.errorCategory).toBe("workout_not_found");
  });

  it("refuses to write when the content fingerprint changed upstream", async () => {
    const { server, client } = await setup();
    const result = await executeMoveJob(
      client,
      job(server, { expectedContentFingerprint: "deadbeefdeadbeef" }),
    );
    expect(result.outcome).toBe("upstream_changed");
    expect(result.errorCategory).toBe("content_changed");
    expect(server.counts.scheduleWrites).toBe(0);
  });
});

describe("executeMoveJob — ambiguous network failures", () => {
  it("resolves a mid-write network failure to verified when the write landed", async () => {
    const { server, client } = await setup();
    server.throwAfterApplyOnce = true; // write applies, response is lost
    const result = await executeMoveJob(client, job(server));
    expect(result.outcome).toBe("verified");
    expect(result.pathUsed).toBe("direct_update");
    expect(result.observedDate).toBe(DESTINATION);
  });

  it("resolves a pre-apply network failure to a clean write_failed", async () => {
    const { server, client } = await setup();
    server.throwBeforeApplyOnce = true; // nothing changed server-side
    const result = await executeMoveJob(client, job(server));
    expect(result.outcome).toBe("write_failed");
    expect(result.errorCategory).toBe("network");
    expect(result.observedDate).toBe(ORIGINAL);
    expect(Number(server.entityByIdInPlan("11")?.happenDay)).toBe(20260804);
  });
});

describe("executeMoveJob — remove-and-add fallback", () => {
  it("falls back when the server rejects the update, insert-before-delete", async () => {
    const { server, client } = await setup();
    server.updateRejectResult = "1001";
    const result = await executeMoveJob(client, job(server));

    expect(result.outcome).toBe("verified");
    expect(result.pathUsed).toBe("remove_and_add");
    expect(result.observedDate).toBe(DESTINATION);

    // Clone created with idInPlan = maxIdInPlan + 1 (fixture max was 20).
    const clone = server.entityByIdInPlan("21");
    expect(clone).toBeDefined();
    expect(Number(clone?.happenDay)).toBe(20260807);
    expect(Number(server.state.schedule.maxIdInPlan)).toBe(21);
    // Original deleted.
    expect(server.entityByIdInPlan("11")).toBeUndefined();
    // Program cloned alongside the entity.
    const cloneProgram = server.state.schedule.programs?.find(
      (p) => String(p.idInPlan) === "21",
    );
    expect(cloneProgram?.name).toBe("Threshold 5x5");
  });

  it("leaves the original untouched when clone insertion fails verification", async () => {
    const { server, client } = await setup();
    server.updateRejectResult = "1001";
    server.addSilentlyFails = true; // create returns 0000 but never materializes
    const result = await executeMoveJob(client, job(server));

    expect(result.outcome).toBe("write_failed");
    expect(result.errorCategory).toBe("insert_verification_failed");
    // Original untouched, no clone, no delete issued.
    expect(Number(server.entityByIdInPlan("11")?.happenDay)).toBe(20260804);
    expect(server.entityByIdInPlan("21")).toBeUndefined();
  });

  it("never silently proceeds when the original cannot be deleted (duplicate left)", async () => {
    const { server, client } = await setup();
    server.updateRejectResult = "1001";
    server.deleteRejectResult = "1001";
    const result = await executeMoveJob(client, job(server));

    expect(result.outcome).toBe("verification_failed");
    expect(result.errorCategory).toBe("duplicate_left");
    // Both the clone and the original are visible — recoverable, not lost.
    expect(server.entityByIdInPlan("11")).toBeDefined();
    expect(server.entityByIdInPlan("21")).toBeDefined();
  });
});
