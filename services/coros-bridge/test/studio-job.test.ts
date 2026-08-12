/**
 * Bridge-side dispatch of the two studio job kinds onto the Task-2
 * create-executor (plan-studio-design §5). Everything runs against the
 * stateful multi-plan mock COROS server — no credentials, no network.
 *
 * What this file pins:
 *  - the executor is called with `verbose: false` and NO caller-asserted plan
 *    id on creates (it resolves and guards its own target plan);
 *  - the reported result carries structured codes and server ids only — never
 *    an executor message, which can name a workout the user authored;
 *  - the NDJSON protocol op accepts both kinds and refuses malformed ones.
 */

import { describe, expect, it } from "vitest";
import { loginWithPassword } from "../src/coros-login.js";
import { FIXTURE_PLAN_ID } from "@rg/providers";
import { studioJobResultSchema } from "@rg/domain";
import type { CreateScheduledWorkoutJob, DeleteScheduledWorkoutJob } from "@rg/domain";
import { CorosClient } from "@rg/coros";
import type { CreateWorkoutOptions, DeleteWorkoutOptions } from "@rg/coros";
import { createWorkout, deleteWorkout } from "@rg/coros";
import { executeStudioJob, type StudioExecutors, type StudioJob } from "@rg/coros";
import { createBridgeState, handleRequest } from "../src/protocol.js";
import { CloudSync, generateDeviceKeypair } from "../src/cloud-sync.js";
import { mockCorosServer, nextMonday, type MockCorosServer } from "./mock-coros-server.js";

const noop = (): void => undefined;
const TODAY = new Date().toISOString().slice(0, 10);
const SQUAT_ID = "425898928110747648";

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function corosDay(iso: string): number {
  return Number(iso.replaceAll("-", ""));
}

const TARGET_DAY = addDaysIso(TODAY, 28);

function createJob(over: Partial<CreateScheduledWorkoutJob> = {}): StudioJob {
  return {
    id: "job-1",
    kind: "create_scheduled_workout",
    studio: {
      pushId: "push-1",
      happenDay: TARGET_DAY,
      name: "Upper A — wk 1",
      session: {
        title: "Upper A",
        weekday: 1,
        exercises: [
          {
            originId: SQUAT_ID,
            name: "Back Squat",
            sets: 3,
            reps: 10,
            weight: { type: "bodyweight" },
            restSeconds: 0,
          },
        ],
      },
      catalog: [{ id: SQUAT_ID, name: "Back Squat" }],
      ...over,
    },
  };
}

function deleteJob(over: Partial<DeleteScheduledWorkoutJob> = {}): StudioJob {
  return {
    id: "job-2",
    kind: "delete_scheduled_workout",
    studio: {
      pushId: "push-1",
      happenDay: TARGET_DAY,
      name: "Upper A — wk 1",
      idInPlan: "60",
      programId: "60",
      corosPlanId: FIXTURE_PLAN_ID,
      ...over,
    },
  };
}

async function setup(): Promise<{ server: MockCorosServer; client: CorosClient }> {
  const server = mockCorosServer({ baseMonday: nextMonday() });
  const client = new CorosClient({ region: "us", fetchImpl: server.fetchImpl, logger: noop });
  await loginWithPassword(client, server.email, server.password);
  return { server, client };
}

function seedPushed(
  server: MockCorosServer,
  opts: { idInPlan: string; date: string; name: string },
): void {
  server.state.schedule.entities!.push({
    id: `sv-entity-${opts.idInPlan}`,
    idInPlan: opts.idInPlan,
    planId: FIXTURE_PLAN_ID,
    planProgramId: opts.idInPlan,
    happenDay: corosDay(opts.date),
  });
  server.state.schedule.programs!.push({
    id: `sv-program-${opts.idInPlan}`,
    idInPlan: opts.idInPlan,
    planId: FIXTURE_PLAN_ID,
    name: opts.name,
    sportType: 4,
  });
}

describe("executeStudioJob — create", () => {
  it("creates the workout and reports the server ids under the job's pushId", async () => {
    const { server, client } = await setup();
    const result = await executeStudioJob(client, createJob());

    expect(result.jobId).toBe("job-1");
    expect(result.outcome).toBe("verified");
    expect(result.studio).toBeDefined();
    expect(result.studio!.pushId).toBe("push-1");
    expect(result.studio!.kind).toBe("create_scheduled_workout");
    expect(result.studio!.ok).toBe(true);
    expect(result.studio!.code).toBe("0000");
    expect(result.studio!.serverIdInPlan).toBeTruthy();
    expect(result.studio!.serverProgramId).toBeTruthy();
    expect(result.studio!.serverPlanId).toBe(FIXTURE_PLAN_ID);
    expect(server.counts.scheduleWrites).toBeGreaterThan(0);
  });

  it("converts the LocalDate happenDay to the COROS YYYYMMDD wire day", async () => {
    const { server, client } = await setup();
    await executeStudioJob(client, createJob());
    const created = server.state.schedule
      .programs!.filter((p) => p.name === "Upper A — wk 1")
      .map((p) => String(p.idInPlan));
    const entity = server.state.schedule.entities!.find((e) =>
      created.includes(String(e.planProgramId ?? e.idInPlan)),
    );
    expect(Number(entity!.happenDay)).toBe(corosDay(TARGET_DAY));
  });

  it("passes verbose:false and NO planId — the executor guards its own target plan", async () => {
    const { client } = await setup();
    const seen: CreateWorkoutOptions[] = [];
    const executors: StudioExecutors = {
      createWorkout: (c, spec, opts) => {
        seen.push(opts);
        return createWorkout(c, spec, opts);
      },
      deleteWorkout,
    };

    await executeStudioJob(client, createJob(), { executors });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.verbose).toBe(false);
    expect(seen[0]!.planId).toBeUndefined();
    expect(seen[0]!.catalog.get(SQUAT_ID)).toBe("Back Squat");
  });

  it("reports already_present as an idempotent success (a retried push must not duplicate)", async () => {
    const { server, client } = await setup();
    seedPushed(server, { idInPlan: "60", date: TARGET_DAY, name: "Upper A — wk 1" });

    const before = server.counts.scheduleWrites;
    const result = await executeStudioJob(client, createJob());

    expect(result.studio!.ok).toBe(true);
    expect(result.studio!.reason).toBe("already_present");
    expect(result.outcome).toBe("already_in_desired_state");
    expect(result.studio!.serverIdInPlan).toBe("60");
    expect(server.counts.scheduleWrites).toBe(before); // nothing written
  });

  it("reports a same-stamp-different-day refusal with NO ids, but WITH the day it is on", async () => {
    const { server, client } = await setup();
    const elsewhere = addDaysIso(TARGET_DAY, 2);
    seedPushed(server, { idInPlan: "60", date: elsewhere, name: "Upper A — wk 1" });

    const result = await executeStudioJob(client, createJob());

    expect(result.studio!.ok).toBe(false);
    expect(result.studio!.reason).toBe("already_present");
    expect(result.studio!.serverIdInPlan).toBeUndefined();
    expect(result.studio!.serverProgramId).toBeUndefined();
    expect(result.studio!.serverPlanId).toBeUndefined();
    // The ids are withheld (they would aim a delete at the wrong date), but
    // WHERE the stamp is, is what makes the refusal actionable at all.
    expect(result.studio!.serverHappenDay).toBe(elsewhere);
  });

  it("reports the actual day on a verified create too", async () => {
    const { client } = await setup();
    const result = await executeStudioJob(client, createJob());
    expect(result.studio!.serverHappenDay).toBe(TARGET_DAY);
  });

  it("reports serverHappenDay as a LocalDate the domain schema accepts", async () => {
    const { client } = await setup();
    const result = await executeStudioJob(client, createJob());
    expect(studioJobResultSchema.safeParse(result.studio).success).toBe(true);
    expect(result.studio!.serverHappenDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("reports a local build failure as the retryable reason 'error'", async () => {
    const { client } = await setup();
    // Empty catalog: the originId cannot resolve, so the build throws before
    // any wire call.
    const result = await executeStudioJob(client, createJob({ catalog: [] }));

    expect(result.studio!.ok).toBe(false);
    expect(result.studio!.reason).toBe("error");
    expect(result.outcome).toBe("write_failed");
  });

  it("never transmits the executor's message text", async () => {
    const { client } = await setup();
    const result = await executeStudioJob(client, createJob({ catalog: [] }));
    // The executor's error names the exercise; the envelope must not carry it.
    expect(JSON.stringify(result.studio)).not.toContain("Back Squat");
    expect(Object.keys(result.studio!)).not.toContain("error");
  });

  it("refuses a day outside the observation span rather than deriving an id blindly", async () => {
    const { server, client } = await setup();
    const result = await executeStudioJob(client, createJob({ happenDay: addDaysIso(TODAY, 300) }));

    expect(result.studio!.ok).toBe(false);
    expect(result.studio!.reason).toBe("out_of_span");
    expect(result.outcome).toBe("unsupported");
    expect(server.counts.scheduleWrites).toBe(0);
  });
});

describe("executeStudioJob — delete", () => {
  it("deletes a workout it can prove it owns", async () => {
    const { server, client } = await setup();
    seedPushed(server, { idInPlan: "60", date: TARGET_DAY, name: "Upper A — wk 1" });

    const result = await executeStudioJob(client, deleteJob());

    expect(result.studio!.ok).toBe(true);
    expect(result.studio!.kind).toBe("delete_scheduled_workout");
    expect(result.outcome).toBe("verified");
    expect(
      server.state.schedule.programs!.some((p) => p.name === "Upper A — wk 1"),
    ).toBe(false);
  });

  it("reports not_found when nothing carries the stamp (already gone)", async () => {
    const { client } = await setup();
    const result = await executeStudioJob(client, deleteJob());

    expect(result.studio!.ok).toBe(false);
    expect(result.studio!.refused).toBe("not_found");
    expect(result.outcome).toBe("already_in_desired_state");
  });

  it("reports stamp_mismatch when the recorded address holds something else", async () => {
    const { server, client } = await setup();
    seedPushed(server, { idInPlan: "60", date: TARGET_DAY, name: "Renamed by the user" });

    const result = await executeStudioJob(client, deleteJob());

    expect(result.studio!.ok).toBe(false);
    expect(result.studio!.refused).toBe("stamp_mismatch");
    expect(result.outcome).toBe("upstream_changed");
    // Nothing was deleted.
    expect(
      server.state.schedule.programs!.some((p) => p.name === "Renamed by the user"),
    ).toBe(true);
  });

  it("passes verbose:false to the executor", async () => {
    const { server, client } = await setup();
    seedPushed(server, { idInPlan: "60", date: TARGET_DAY, name: "Upper A — wk 1" });
    const seen: DeleteWorkoutOptions[] = [];
    const executors: StudioExecutors = {
      createWorkout,
      deleteWorkout: (c, target, opts) => {
        seen.push(opts ?? {});
        return deleteWorkout(c, target, opts);
      },
    };

    await executeStudioJob(client, deleteJob(), { executors });

    expect(seen[0]!.verbose).toBe(false);
  });
});

describe("protocol executeJob — studio kinds", () => {
  async function bridge(): Promise<{ state: ReturnType<typeof createBridgeState>; server: MockCorosServer }> {
    const server = mockCorosServer({ baseMonday: nextMonday() });
    const state = createBridgeState({
      fetchImpl: server.fetchImpl,
      makeClient: () => new CorosClient({ region: "us", fetchImpl: server.fetchImpl, logger: noop }),
    });
    await handleRequest(state, {
      id: "1",
      op: "authenticate",
      params: { email: server.email, password: server.password, region: "us" },
    });
    return { state, server };
  }

  it("dispatches a create job through the op", async () => {
    const { state } = await bridge();
    const res = await handleRequest(state, {
      id: "2",
      op: "executeJob",
      params: { job: createJob() },
    });
    expect(res.ok).toBe(true);
    const result = (res as { result: { studio?: { ok: boolean } } }).result;
    expect(result.studio!.ok).toBe(true);
  });

  it("dispatches a delete job through the op", async () => {
    const { state, server } = await bridge();
    seedPushed(server, { idInPlan: "60", date: TARGET_DAY, name: "Upper A — wk 1" });
    const res = await handleRequest(state, {
      id: "2",
      op: "executeJob",
      params: { job: deleteJob() },
    });
    expect(res.ok).toBe(true);
    expect((res as { result: { studio: { ok: boolean } } }).result.studio.ok).toBe(true);
  });

  it("refuses a studio job with a malformed payload", async () => {
    const { state } = await bridge();
    const res = await handleRequest(state, {
      id: "2",
      op: "executeJob",
      params: { job: { id: "j", kind: "create_scheduled_workout", studio: { pushId: "p" } } },
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error.category).toBe("invalid_request");
  });

  it("still dispatches a move job", async () => {
    const { state } = await bridge();
    const res = await handleRequest(state, {
      id: "2",
      op: "executeJob",
      params: {
        job: {
          id: "j",
          kind: "move_scheduled_workout",
          originalDate: TODAY,
          destinationDate: addDaysIso(TODAY, 1),
          workout: { sourceIdInPlan: "999", sourcePlanId: FIXTURE_PLAN_ID },
        },
      },
    });
    expect(res.ok).toBe(true);
    expect((res as { result: { outcome: string } }).result.outcome).toBe("upstream_changed");
  });
});

describe("CloudSync poll — studio kinds", () => {
  /**
   * The claimed-job shape the worker's claim route emits for a studio job:
   * `workout: null`, plus a `studio` payload. The bridge must dispatch on
   * `kind` rather than assuming a planned workout is attached.
   */
  async function drainOne(job: unknown): Promise<Record<string, unknown>> {
    const server = mockCorosServer({ baseMonday: nextMonday() });
    const client = new CorosClient({ region: "us", fetchImpl: server.fetchImpl, logger: noop });
    await loginWithPassword(client, server.email, server.password);
    seedPushed(server, { idInPlan: "60", date: TARGET_DAY, name: "Upper A — wk 1" });

    let claims = 0;
    const results: Array<Record<string, unknown>> = [];
    const cloudFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(typeof input === "string" ? input : (input as URL).href).pathname;
      let payload: unknown = { ok: true };
      if (path === "/api/devices/bridge/jobs/claim") {
        claims += 1;
        payload = claims === 1 ? { job } : { job: null };
      } else if (path.endsWith("/result")) {
        results.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const { privateKeyPem } = generateDeviceKeypair();
    const sync = new CloudSync({
      apiUrl: "https://api.example.com",
      deviceId: "dev-studio",
      privateKeyPem,
      client,
      fetchImpl: cloudFetch,
      logger: noop,
    });
    await sync.pollJobs();
    return results[0]!;
  }

  it("executes a claimed delete job that carries no planned workout", async () => {
    const reported = await drainOne({
      id: "cloud-job-1",
      kind: "delete_scheduled_workout",
      originalDate: TARGET_DAY,
      destinationDate: TARGET_DAY,
      attemptCount: 0,
      workout: null,
      studio: deleteJob().studio,
    });

    expect(reported.outcome).toBe("verified");
    expect((reported.studio as { ok: boolean }).ok).toBe(true);
    expect((reported.studio as { pushId: string }).pushId).toBe("push-1");
  });

  it("refuses to act on a studio job whose payload does not validate", async () => {
    const reported = await drainOne({
      id: "cloud-job-2",
      kind: "delete_scheduled_workout",
      originalDate: TARGET_DAY,
      destinationDate: TARGET_DAY,
      attemptCount: 0,
      workout: null,
      studio: { pushId: "push-1" }, // missing the delete triple
    });

    expect(reported.outcome).toBe("unsupported");
    expect(reported.errorCategory).toBe("malformed_studio_payload");
    expect(reported.studio).toBeUndefined();
  });
});
