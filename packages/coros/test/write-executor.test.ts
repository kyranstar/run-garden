import { describe, expect, it } from "vitest";
import { corosProgramFingerprint, FIXTURE_PLAN_ID } from "@rg/providers";
import { CorosClient } from "../src/client.js";
import { executeMoveJob, type MoveJob } from "../src/write-executor.js";
import { mockCorosServer, type MockCorosServer } from "./mock-coros-server.js";
import type { RawCorosEntity } from "@rg/providers";

import { createHash } from "node:crypto";
import type { CorosClient as CorosClientType } from "../src/client.js";

/** Test-side password login: node md5 + the public loginWithHash seam. */
const loginMd5 = (client: CorosClientType, email: string, password: string) =>
  client.loginWithHash(email, createHash("md5").update(password, "utf8").digest("hex"));


const BASE_MONDAY = "2026-08-03";
// Fixture: idInPlan 11 = "Threshold 5x5" on D+1 (Tue 2026-08-04); Friday D+4 is free.
const ORIGINAL = "2026-08-04";
const DESTINATION = "2026-08-07";
const noop = (): void => undefined;

async function setup(): Promise<{ server: MockCorosServer; client: CorosClient }> {
  const server = mockCorosServer({ baseMonday: BASE_MONDAY });
  const client = new CorosClient({ region: "us", fetchImpl: server.fetchImpl, logger: noop });
  await loginMd5(client, server.email, server.password);
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

/**
 * The fallback used to be the one place in the codebase that broke the safety
 * core's own invariants: it derived the clone's slot from `maxIdInPlan + 1`
 * (INVARIANT 2 says the counter cannot be trusted) and it sent both of its
 * deletes by remembered id with no re-proof and no ambiguity guard
 * (INVARIANT 4). Simulated against a plan whose counter is stale — the live
 * shape, reproduced by the mock — that combination deleted a hand-made
 * workout that had nothing to do with the move.
 */
describe("executeMoveJob — remove-and-add derives and deletes like the safety core", () => {
  /** Push the plan's counter behind reality, exactly as the live template
   * plan did (`maxIdInPlan: 0` while carrying ids up to 45). Fixture entities
   * run 10…20, so a counter of 14 makes the naive slot 15 — "Long Run" on
   * D+5, a workout this job must never touch. */
  function staleCounter(server: MockCorosServer): { naiveSlot: number; foreign: RawCorosEntity } {
    server.state.schedule.maxIdInPlan = 14;
    const naiveSlot = Number(server.state.schedule.maxIdInPlan) + 1;
    const foreign = server.entityByIdInPlan(String(naiveSlot))!;
    // The premise of every test below: the OLD derivation aimed at a real,
    // occupied slot belonging to someone else's workout.
    expect(foreign).toBeDefined();
    expect(String(foreign.idInPlan)).toBe(String(naiveSlot));
    return { naiveSlot, foreign };
  }

  it("derives max(counter, observed) + 1 instead of counter + 1", async () => {
    const { server, client } = await setup();
    const { naiveSlot } = staleCounter(server);
    server.updateRejectResult = "1001";

    const result = await executeMoveJob(client, job(server));

    // Observed max is 20, so the clone lands at 21 — past the counter AND
    // past reality. `counter + 1` would have been 15.
    expect(result.outcome).toBe("verified");
    expect(result.pathUsed).toBe("remove_and_add");
    expect(server.entityByIdInPlan("21")).toBeDefined();
    expect(Number(server.entityByIdInPlan("21")?.happenDay)).toBe(20260807);
    // The workout sitting in the naive slot is untouched, on its own day.
    const foreignAfter = server.entityByIdInPlan(String(naiveSlot));
    expect(foreignAfter).toBeDefined();
    expect(Number(foreignAfter?.happenDay)).toBe(20260808);
    expect(
      server.state.schedule.programs?.find((p) => String(p.idInPlan) === String(naiveSlot))?.name,
    ).toBe("Long Run");
    // Only the moved workout is gone from its old slot.
    expect(server.entityByIdInPlan("11")).toBeUndefined();
  });

  it("does not delete a foreign workout when the server allocates ids itself", async () => {
    const { server, client } = await setup();
    const { naiveSlot } = staleCounter(server);
    server.updateRejectResult = "1001";
    // The live shape: the server ignores the claimed id and stores the create
    // under its own counter + 1, which on a stale counter COLLIDES.
    server.reassignsIdInPlan = "counter";

    const result = await executeMoveJob(client, job(server));

    // No clone is provable at the derived slot, so nothing is deleted at all:
    // a clean failure the caller can retry. BEFORE, the rollback delete fired
    // at the colliding address and took "Long Run" with it.
    expect(result.outcome).toBe("write_failed");
    expect(result.errorCategory).toBe("insert_verification_failed");
    const foreignAfter = server.state.schedule.entities?.filter(
      (e) => String(e.idInPlan) === String(naiveSlot) && Number(e.happenDay) === 20260808,
    );
    expect(foreignAfter).toHaveLength(1);
    // Verbatim reproduction of the old code against this same mock state
    // deleted BOTH this entity and its program (the delete matcher removes
    // every row sharing the address), leaving `15:Long Run` gone.
    expect(
      server.state.schedule.programs?.find((p) => String(p.idInPlan) === String(naiveSlot))?.name,
    ).toBe("Long Run");
    // …and the workout being moved is still where it was.
    expect(Number(server.entityByIdInPlan("11")?.happenDay)).toBe(20260804);
  });

  it("refuses the original's delete when its address is shared with another entity", async () => {
    const { server, client } = await setup();
    server.updateRejectResult = "1001";
    // Two entities of one plan may legally share an idInPlan (live-observed:
    // ids 2, 8 and 38 each appeared twice). A `status: 3` delete is addressed
    // by (planId, idInPlan, planProgramId) and cannot tell them apart.
    server.state.schedule.entities!.push({
      id: "sv-entity-shadow",
      idInPlan: "11",
      planId: FIXTURE_PLAN_ID,
      planProgramId: "11",
      happenDay: 20260805,
    });

    const result = await executeMoveJob(client, job(server));

    expect(result.outcome).toBe("verification_failed");
    expect(result.errorCategory).toBe("duplicate_left");
    // NOTHING was deleted: the clone stands at the destination (visible and
    // recoverable) and both entities sharing the address survive. BEFORE, the
    // delete was sent and the server removed BOTH of them.
    expect(server.entityByIdInPlan("21")).toBeDefined();
    expect(
      server.state.schedule.entities!.filter((e) => String(e.idInPlan) === "11"),
    ).toHaveLength(2);
  });

  it("refuses to derive a slot for a date the id sweep cannot see", async () => {
    const { server, client } = await setup();
    server.updateRejectResult = "1001";
    // The sweep covers today-180 … today+240. A workout past that horizon
    // would be cloned into a slot derived from a plan nobody read.
    const far = new Date();
    far.setUTCDate(far.getUTCDate() + 300);
    const farIso = far.toISOString().slice(0, 10);
    const farDay = Number(farIso.replaceAll("-", ""));
    server.state.schedule.entities!.push({
      id: "sv-entity-far",
      idInPlan: "30",
      planId: FIXTURE_PLAN_ID,
      planProgramId: "30",
      happenDay: farDay,
    });
    server.state.schedule.programs!.push({
      id: "sv-program-far",
      idInPlan: "30",
      planId: FIXTURE_PLAN_ID,
      name: "Next spring's long run",
      sportType: 1,
      version: 1,
      exercises: [],
    });
    const destination = new Date(far);
    destination.setUTCDate(destination.getUTCDate() + 2);

    const result = await executeMoveJob(client, {
      id: "job-far",
      originalDate: farIso,
      destinationDate: destination.toISOString().slice(0, 10),
      workout: { sourceIdInPlan: "30", sourcePlanId: FIXTURE_PLAN_ID },
    });

    expect(result.outcome).toBe("write_failed");
    expect(result.errorCategory).toBe("out_of_span");
    // Nothing written, nothing deleted.
    expect(Number(server.entityByIdInPlan("30")?.happenDay)).toBe(farDay);
    expect(server.counts.scheduleWrites).toBe(1); // only the rejected update
  });
});
