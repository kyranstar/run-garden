/**
 * Offline coverage for the shared create-executor — the machinery the spike
 * proved live and the product now reuses. Everything runs against the stateful
 * multi-plan mock COROS server: no credentials, no network, safe in CI.
 *
 * The spike suite (test/spike-create.test.ts) is the behaviour-identity proof
 * for the refactor; this file covers the NEW product paths: building a strength
 * program from a StudioSession (all three §(d) weight encodings), the full
 * create→verify cycle, and every delete refusal.
 */

import { describe, expect, it } from "vitest";
import type { StudioExercise, StudioSession } from "@rg/domain";
import { FIXTURE_PLAN_ID, type RawCorosEntity, type RawCorosExercise } from "@rg/providers";
import { CorosClient } from "../src/coros-client.js";
import {
  buildStrengthProgram,
  createWorkout,
  deleteWorkout,
  type CreateWorkoutSpec,
} from "../src/create-executor.js";
import { mockCorosServer, nextMonday, REASSIGN_OFFSET, type MockCorosServer } from "./mock-coros-server.js";

const noop = (): void => undefined;
const TODAY = new Date().toISOString().slice(0, 10);

/** The two entries the mock's /training/exercise/query?sportType=4 returns. */
const SQUAT_ID = "425898928110747648";
const BENCH_ID = "426109589008859137";
const CATALOG = new Map([
  [SQUAT_ID, "Back Squat"],
  [BENCH_ID, "Bench Press"],
]);

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function corosDay(iso: string): string {
  return iso.replaceAll("-", "");
}

function exercise(over: Partial<StudioExercise> = {}): StudioExercise {
  return {
    originId: SQUAT_ID,
    name: "Squat (LLM label)",
    sets: 3,
    reps: 10,
    weight: { type: "bodyweight" },
    restSeconds: 0,
    ...over,
  };
}

function session(exercises: StudioExercise[], title = "Upper A"): StudioSession {
  return { title, weekday: 1, exercises };
}

function spec(over: Partial<CreateWorkoutSpec> = {}): CreateWorkoutSpec {
  return {
    happenDay: corosDay(addDaysIso(TODAY, 28)),
    name: "Upper A — wk 1",
    session: session([exercise()]),
    ...over,
  };
}

/** The child (real step) of the nth exercise, as a bag of wire fields. */
function childOf(program: { exercises?: RawCorosExercise[] }, n = 0): Record<string, unknown> {
  return program.exercises![n * 2 + 1] as unknown as Record<string, unknown>;
}

function containerOf(program: { exercises?: RawCorosExercise[] }, n = 0): Record<string, unknown> {
  return program.exercises![n * 2] as unknown as Record<string, unknown>;
}

async function setup(): Promise<{ server: MockCorosServer; client: CorosClient }> {
  const server = mockCorosServer({ baseMonday: nextMonday() });
  const client = new CorosClient({ region: "us", fetchImpl: server.fetchImpl, logger: noop });
  await client.login(server.email, server.password);
  return { server, client };
}

/** A workout the studio already pushed: entity + its stamp-named program. */
function seedPushed(
  server: MockCorosServer,
  opts: {
    idInPlan: string;
    date: string;
    name: string;
    planId?: string;
    planProgramId?: string;
    entityId?: string;
  },
): void {
  const planId = opts.planId ?? FIXTURE_PLAN_ID;
  server.state.schedule.entities!.push({
    id: opts.entityId ?? `sv-entity-${opts.idInPlan}`,
    idInPlan: opts.idInPlan,
    planId,
    planProgramId: opts.planProgramId ?? opts.idInPlan,
    happenDay: Number(corosDay(opts.date)),
  });
  server.state.schedule.programs!.push({
    id: `sv-program-${opts.idInPlan}`,
    idInPlan: opts.planProgramId ?? opts.idInPlan,
    planId,
    name: opts.name,
    sportType: 4,
  });
}

describe("buildStrengthProgram — §(d) weight encodings", () => {
  it("encodes bodyweight as an empty STRING value with custom 1", () => {
    const program = buildStrengthProgram(spec(), CATALOG);
    const child = childOf(program);

    expect(child.intensityType).toBe(1);
    expect(child.intensityValue).toBe(""); // empty STRING, never 0
    expect(child.intensityPercent).toBe(0);
    expect(child.intensityDisplayUnit).toBe("6"); // STRING, never the number 6
    expect(child.intensityCustom).toBe(1);
  });

  it("encodes kg as round(kg × 1000) with custom 0", () => {
    const program = buildStrengthProgram(
      spec({ session: session([exercise({ weight: { type: "kg", value: 62.5 } })]) }),
      CATALOG,
    );
    const child = childOf(program);

    expect(child.intensityType).toBe(1);
    expect(child.intensityValue).toBe(62_500);
    expect(child.intensityPercent).toBe(0);
    expect(child.intensityDisplayUnit).toBe("6");
    expect(child.intensityCustom).toBe(0);
  });

  it("encodes an explicit 0 kg as numeric 0 with custom 0 — NOT bodyweight", () => {
    const program = buildStrengthProgram(
      spec({ session: session([exercise({ weight: { type: "kg", value: 0 } })]) }),
      CATALOG,
    );
    const child = childOf(program);

    expect(child.intensityType).toBe(1);
    expect(child.intensityValue).toBe(0); // the NUMBER 0 — renders "0.00 kg"
    expect(child.intensityValue).not.toBe("");
    expect(child.intensityPercent).toBe(0);
    expect(child.intensityDisplayUnit).toBe("6");
    expect(child.intensityCustom).toBe(0); // the row that distinguishes it
  });

  it("rounds fractional kg to the nearest gram", () => {
    const program = buildStrengthProgram(
      spec({ session: session([exercise({ weight: { type: "kg", value: 20.3335 } })]) }),
      CATALOG,
    );
    expect(childOf(program).intensityValue).toBe(20_334);
  });
});

describe("buildStrengthProgram — repeat-group structure (§(d))", () => {
  it("wraps every exercise in a repeat-group container the sortNo scheme orders", () => {
    const program = buildStrengthProgram(
      spec({
        session: session([
          exercise({ originId: SQUAT_ID, sets: 3, reps: 10 }),
          exercise({ originId: BENCH_ID, sets: 4, reps: 8, weight: { type: "kg", value: 40 } }),
        ]),
      }),
      CATALOG,
    );

    expect(program.exercises).toHaveLength(4); // container + child, twice
    const first = containerOf(program, 0);
    const firstChild = childOf(program, 0);
    const second = containerOf(program, 1);
    const secondChild = childOf(program, 1);

    // Container: "3 sets" is the repeat count, TIME per iteration, no rest.
    expect(first).toMatchObject({
      id: 1,
      name: "Group",
      exerciseType: 0,
      sportType: 4,
      intensityType: 0,
      intensityValue: 0,
      targetType: 2,
      sets: 3,
      restType: 3,
      restValue: 0,
      groupId: "0",
      isGroup: true,
      originId: "0",
    });
    // Child: REPS target, linked to its container by id.
    expect(firstChild).toMatchObject({
      id: 2,
      exerciseType: 2,
      sportType: 4,
      targetType: 3,
      targetValue: 10,
      sets: 1,
      groupId: "1",
      isGroup: false,
      originId: SQUAT_ID,
    });
    expect(second).toMatchObject({ id: 3, sets: 4, isGroup: true });
    expect(secondChild).toMatchObject({ id: 4, targetValue: 8, groupId: "3", originId: BENCH_ID });

    // §5.3: top-level step n → 2^24·n; sub-steps → groupSort + 2^16.
    expect(first.sortNo).toBe(16_777_216);
    expect(firstChild.sortNo).toBe(16_777_216 + 65_536);
    expect(second.sortNo).toBe(16_777_216 * 2);
    expect(secondChild.sortNo).toBe(16_777_216 * 2 + 65_536);
  });

  it("counts REAL steps only in exerciseNum, and every set in totalSets", () => {
    const program = buildStrengthProgram(
      spec({
        session: session([
          exercise({ sets: 3 }),
          exercise({ originId: BENCH_ID, sets: 4 }),
          exercise({ originId: BENCH_ID, sets: 5 }),
        ]),
      }),
      CATALOG,
    );

    expect(program.exercises).toHaveLength(6);
    expect(program.exerciseNum).toBe(3); // containers are NOT counted (§5.4)
    expect(program.totalSets).toBe(12);
  });

  it("marks the program structured strength with zeroed server-computed metrics", () => {
    const program = buildStrengthProgram(spec({ name: "Lower B — wk 2" }), CATALOG);

    expect(program.name).toBe("Lower B — wk 2"); // the program name IS the stamp
    expect(program.sportType).toBe(4);
    expect(program.subType).toBe(65535);
    expect(program.duration).toBe(0);
    expect(program.trainingLoad).toBe(0);
    expect(program.referExercise).toEqual({
      gradeSystem: 0,
      hrType: 0,
      intensityType: 1,
      valueType: 1,
    });
  });

  it("encodes restSeconds on the step: 0 → skip rests, >0 → an explicit rest", () => {
    const skipped = buildStrengthProgram(
      spec({ session: session([exercise({ restSeconds: 0 })]) }),
      CATALOG,
    );
    expect(childOf(skipped)).toMatchObject({ restType: 3, restValue: 0 });

    const rested = buildStrengthProgram(
      spec({ session: session([exercise({ restSeconds: 90 })]) }),
      CATALOG,
    );
    expect(childOf(rested)).toMatchObject({ restType: 1, restValue: 90 });
  });

  it("names the step from the CATALOG, not from the caller's label", () => {
    const program = buildStrengthProgram(spec(), CATALOG);
    expect(childOf(program).name).toBe("Back Squat");
  });
});

describe("buildStrengthProgram — server-side validation before any wire call", () => {
  it("throws when an originId is not in the catalog", () => {
    expect(() =>
      buildStrengthProgram(
        spec({ session: session([exercise({ originId: "999999999999999999" })]) }),
        CATALOG,
      ),
    ).toThrow(/999999999999999999/);
  });

  it("throws on a session with no exercises", () => {
    expect(() => buildStrengthProgram(spec({ session: session([]) }), CATALOG)).toThrow(
      /no exercises/i,
    );
  });
});

describe("createWorkout — plan-scoped create + verify by stamp", () => {
  it("derives the id, creates, verifies by stamp and returns the server ids", async () => {
    const { server, client } = await setup();
    const date = addDaysIso(TODAY, 28);
    const target = spec({ happenDay: corosDay(date) });

    const result = await createWorkout(client, target, { today: TODAY, catalog: CATALOG });

    expect(result.ok).toBe(true);
    expect(result.code).toBe("0000");
    // Fixture counter is 20 and its observed max is 20 → the next free id is 21.
    expect(result.serverIdInPlan).toBe("21");
    expect(result.serverProgramId).toBe("21"); // planProgramId — the delete triple
    expect(result.serverEntityId).toMatch(/^sv-entity-/);
    expect(result.serverPlanId).toBe(FIXTURE_PLAN_ID);

    // …and the workout really is on the calendar, with the stamp on the PROGRAM.
    const created = server.entityByIdInPlan("21");
    expect(Number(created?.happenDay)).toBe(Number(corosDay(date)));
    expect(server.programByIdInPlan("21")?.name).toBe("Upper A — wk 1");
    expect(server.programByIdInPlan("21")?.sportType).toBe(4);
  });

  it("splices the server's calculate output in before the create", async () => {
    const { server, client } = await setup();
    await createWorkout(client, spec(), { today: TODAY, catalog: CATALOG });

    const stored = server.programByIdInPlan("21");
    expect(stored?.duration).toBe(1234);
    expect(stored?.estimatedTime).toBe(1234);
    expect(stored?.trainingLoad).toBe(42);
    expect(stored?.totalSets).toBe(3); // calculate must not clobber the client count
  });

  it("recovers by stamp when the server renumbers the workout", async () => {
    const { server, client } = await setup();
    server.reassignsIdInPlan = "offset";

    const result = await createWorkout(client, spec(), { today: TODAY, catalog: CATALOG });

    expect(result.ok).toBe(true);
    expect(result.serverIdInPlan).toBe(String(21 + REASSIGN_OFFSET));
    expect(result.serverProgramId).toBe(String(21 + REASSIGN_OFFSET));
  });

  it("refuses to write when the derived slot is occupied", async () => {
    const { server, client } = await setup();
    const date = addDaysIso(TODAY, 28);
    // Free during the span sweep, taken by the time of the pre-write read.
    let sawSpanSweep = false;
    let injected = false;
    const racing: typeof fetch = async (input, init) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.pathname === "/training/schedule/query") {
        const start = url.searchParams.get("startDate");
        if (start === corosDay(addDaysIso(TODAY, -180))) sawSpanSweep = true;
        else if (sawSpanSweep && !injected && start === corosDay(addDaysIso(date, -3))) {
          injected = true;
          server.state.schedule.entities!.push({
            id: "70000000000000998",
            idInPlan: "21",
            planId: FIXTURE_PLAN_ID,
            planProgramId: "21",
            happenDay: Number(corosDay(date)),
            name: "Legacy Tempo",
          });
        }
      }
      return server.fetchImpl(input, init);
    };
    const raced = new CorosClient({ region: "us", fetchImpl: racing, logger: noop });
    await raced.login(server.email, server.password);
    const writesBefore = server.counts.scheduleWrites;

    const result = await createWorkout(raced, spec({ happenDay: corosDay(date) }), {
      today: TODAY,
      catalog: CATALOG,
    });

    expect(injected).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("slot_occupied");
    expect(server.counts.scheduleWrites).toBe(writesBefore); // not one write issued
    expect(server.entityByIdInPlan("21")?.name).toBe("Legacy Tempo");
    // The foreign workout's title never reaches a caller-visible string.
    expect(JSON.stringify(result)).not.toContain("Legacy Tempo");
  });

  it("is idempotent: a second push of the same session creates nothing", async () => {
    const { server, client } = await setup();
    const first = await createWorkout(client, spec(), { today: TODAY, catalog: CATALOG });
    const writesAfterFirst = server.counts.scheduleWrites;

    const second = await createWorkout(client, spec(), { today: TODAY, catalog: CATALOG });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.reason).toBe("already_present");
    expect(second.serverIdInPlan).toBe(first.serverIdInPlan);
    expect(server.counts.scheduleWrites).toBe(writesAfterFirst); // no duplicate
  });

  it("refuses to duplicate a stamp when the user moved the workout in COROS", async () => {
    const { server, client } = await setup();
    const target = spec();
    // Same stamp, one day earlier: the athlete dragged it in the COROS app.
    seedPushed(server, {
      idInPlan: "21",
      date: addDaysIso(TODAY, 27),
      name: target.name,
    });
    const writesBefore = server.counts.scheduleWrites;

    const result = await createWorkout(client, target, { today: TODAY, catalog: CATALOG });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("already_present");
    expect(result.error).toContain(addDaysIso(TODAY, 27));
    expect(result.serverIdInPlan).toBe("21"); // the caller can still address it
    expect(server.counts.scheduleWrites).toBe(writesBefore);
  });

  it("records a server rejection verbatim and never retries another id", async () => {
    const { server } = await setup();
    let attempts = 0;
    const rejecting: typeof fetch = async (input, init) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (href.includes("/training/schedule/update")) {
        attempts += 1;
        return new Response(
          JSON.stringify({ apiCode: "TEST", message: "ERROR", result: "1031", data: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return server.fetchImpl(input, init);
    };
    const strict = new CorosClient({ region: "us", fetchImpl: rejecting, logger: noop });
    await strict.login(server.email, server.password);

    const result = await createWorkout(strict, spec(), { today: TODAY, catalog: CATALOG });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("rejected");
    expect(result.code).toBe("1031");
    expect(result.error).toContain("not retrying");
    expect(attempts).toBe(1); // exactly one attempt, never a guessed second id
    expect(server.entityByIdInPlan("21")).toBeUndefined();
  });

  it("reports accepted-but-not-visible instead of claiming success", async () => {
    const { server, client } = await setup();
    server.addSilentlyFails = true;

    const result = await createWorkout(client, spec(), { today: TODAY, catalog: CATALOG });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_visible");
    expect(result.code).toBe("0000");
    expect(result.serverIdInPlan).toBeUndefined();
  });

  it("reports wrong_date WITH the ids when the server files it on another day", async () => {
    const { server } = await setup();
    const date = addDaysIso(TODAY, 28);
    // The create lands, but the server stores it 10 days away — outside the
    // ±3-day read-after-write window, so only the widened search finds it.
    const moving: typeof fetch = async (input, init) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const res = await server.fetchImpl(input, init);
      if (href.includes("/training/schedule/update")) {
        const landed = server.entityByIdInPlan("21");
        if (landed) landed.happenDay = Number(corosDay(addDaysIso(date, 10)));
      }
      return res;
    };
    const moved = new CorosClient({ region: "us", fetchImpl: moving, logger: noop });
    await moved.login(server.email, server.password);

    const result = await createWorkout(moved, spec({ happenDay: corosDay(date) }), {
      today: TODAY,
      catalog: CATALOG,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("wrong_date");
    expect(result.error).toContain(addDaysIso(date, 10));
    // The ids are returned so the caller can remove what it created.
    expect(result.serverIdInPlan).toBe("21");
    expect(result.serverProgramId).toBe("21");
    expect(result.serverPlanId).toBe(FIXTURE_PLAN_ID);
  });

  it("never adopts a foreign workout that lands on the claimed id", async () => {
    const { server } = await setup();
    const date = addDaysIso(TODAY, 28);
    server.addSilentlyFails = true; // our own create never materializes
    const injecting: typeof fetch = async (input, init) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const res = await server.fetchImpl(input, init);
      if (href.includes("/training/schedule/update") && !server.entityByIdInPlan("21")) {
        server.state.schedule.entities!.push({
          idInPlan: "21",
          planId: FIXTURE_PLAN_ID,
          planProgramId: "21",
          happenDay: Number(corosDay(date)),
          name: "Someone Else's Workout",
        });
      }
      return res;
    };
    const raced = new CorosClient({ region: "us", fetchImpl: injecting, logger: noop });
    await raced.login(server.email, server.password);

    const result = await createWorkout(raced, spec({ happenDay: corosDay(date) }), {
      today: TODAY,
      catalog: CATALOG,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_visible");
    expect(result.serverIdInPlan).toBeUndefined();
    expect(server.entityByIdInPlan("21")?.name).toBe("Someone Else's Workout");
    expect(JSON.stringify(result)).not.toContain("Someone Else's Workout");
  });

  it("refuses a happenDay outside the span the id derivation can see", async () => {
    const { server, client } = await setup();

    const result = await createWorkout(client, spec({ happenDay: corosDay(addDaysIso(TODAY, 400)) }), {
      today: TODAY,
      catalog: CATALOG,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("out_of_span");
    expect(server.counts.scheduleWrites).toBe(0);
  });

  it("refuses to write when the read names no target plan", async () => {
    const { server, client } = await setup();
    delete server.state.schedule.id;

    const result = await createWorkout(client, spec(), { today: TODAY, catalog: CATALOG });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no_target_plan");
    expect(server.counts.scheduleWrites).toBe(0);
  });

  it("validates the catalog before any wire call", async () => {
    const { server, client } = await setup();

    const result = await createWorkout(
      client,
      spec({ session: session([exercise({ originId: "not-in-catalog" })]) }),
      { today: TODAY, catalog: CATALOG },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("error");
    expect(result.error).toContain("not-in-catalog");
    expect(server.counts.scheduleWrites).toBe(0);
  });
});

describe("createWorkout — multi-plan accounts", () => {
  const TEMPLATE_PLAN_ID = "479324793288704499";

  /** A COROS template plan merged into every read, reusing low idInPlan values. */
  function withTemplatePlan(server: MockCorosServer): void {
    server.state.schedule = {
      id: "473846232060707016",
      name: "My Plan",
      maxIdInPlan: 0,
      entities: [],
      programs: [],
    };
    server.state.mergedPlans.push({
      id: TEMPLATE_PLAN_ID,
      name: "S4557",
      maxIdInPlan: 48,
      entities: [
        {
          id: "tpl-entity-1",
          idInPlan: "1",
          planId: TEMPLATE_PLAN_ID,
          planProgramId: "1",
          happenDay: Number(corosDay(addDaysIso(TODAY, 28))),
          name: "Template Tempo",
        },
      ],
      programs: [
        { id: "tpl-prog-1", idInPlan: "1", planId: TEMPLATE_PLAN_ID, name: "T3001", sportType: 1 },
      ],
    });
  }

  it("derives ids from the target plan alone and leaves the template untouched", async () => {
    const { server, client } = await setup();
    withTemplatePlan(server);

    const result = await createWorkout(client, spec(), { today: TODAY, catalog: CATALOG });

    // The container is empty → the first free id is 1, even though the merged
    // read shows the template's id 1 on the very same day.
    expect(result.ok).toBe(true);
    expect(result.serverIdInPlan).toBe("1");
    expect(result.serverPlanId).toBe("473846232060707016");
    expect(server.state.mergedPlans[0]?.entities).toHaveLength(1);
    expect(server.state.mergedPlans[0]?.entities?.[0]?.id).toBe("tpl-entity-1");
  });
});

describe("deleteWorkout — guarded, triple-addressed removal", () => {
  const date = addDaysIso(TODAY, 28);
  const NAME = "Upper A — wk 1";

  function target(over: Partial<Parameters<typeof deleteWorkout>[1]> = {}) {
    return {
      happenDay: corosDay(date),
      name: NAME,
      idInPlan: "21",
      programId: "21",
      planId: FIXTURE_PLAN_ID,
      ...over,
    };
  }

  it("deletes a pushed workout and verifies it is gone", async () => {
    const { server, client } = await setup();
    seedPushed(server, { idInPlan: "21", date, name: NAME });
    const before = (server.state.schedule.entities ?? []).length;

    const result = await deleteWorkout(client, target(), { today: TODAY });

    expect(result.ok).toBe(true);
    expect(result.refused).toBeUndefined();
    expect(server.entityByIdInPlan("21")).toBeUndefined();
    expect(server.state.schedule.entities).toHaveLength(before - 1);
  });

  it("refuses with not_found when nothing carries the stamp", async () => {
    const { server, client } = await setup();
    const writesBefore = server.counts.scheduleWrites;

    const result = await deleteWorkout(client, target(), { today: TODAY });

    expect(result.ok).toBe(false);
    expect(result.refused).toBe("not_found");
    expect(server.counts.scheduleWrites).toBe(writesBefore);
  });

  it("refuses with stamp_mismatch when the recorded address holds something else", async () => {
    const { server, client } = await setup();
    // The user edited the workout in COROS: same slot, different program name.
    seedPushed(server, { idInPlan: "21", date, name: "My Own Lifting Day" });
    const writesBefore = server.counts.scheduleWrites;

    const result = await deleteWorkout(client, target(), { today: TODAY });

    expect(result.ok).toBe(false);
    expect(result.refused).toBe("stamp_mismatch");
    expect(server.counts.scheduleWrites).toBe(writesBefore);
    expect(server.entityByIdInPlan("21")).toBeDefined();
    // The user's own title never travels back to the caller.
    expect(JSON.stringify(result)).not.toContain("My Own Lifting Day");
  });

  it("refuses with ambiguous when another workout shares the delete triple", async () => {
    const { server, client } = await setup();
    seedPushed(server, { idInPlan: "21", date, name: NAME });
    // A real workout 120 days out, sharing (planId, idInPlan, planProgramId):
    // a status:3 delete is plan-wide, so this one would go with ours.
    const victim: RawCorosEntity = {
      id: "70000000000000555",
      idInPlan: "21",
      planId: FIXTURE_PLAN_ID,
      planProgramId: "21",
      happenDay: Number(corosDay(addDaysIso(TODAY, 120))),
      name: "Marathon Race",
    };
    server.state.schedule.entities!.push(victim);
    const writesBefore = server.counts.scheduleWrites;

    const result = await deleteWorkout(client, target(), { today: TODAY });

    expect(result.ok).toBe(false);
    expect(result.refused).toBe("ambiguous");
    expect(server.counts.scheduleWrites).toBe(writesBefore); // nothing sent
    expect(
      (server.state.schedule.entities ?? []).find((e) => e.id === "70000000000000555"),
    ).toBeDefined();
    expect(JSON.stringify(result)).not.toContain("Marathon Race");
  });

  it("refuses with ambiguous when the link key resolves to two different programs", async () => {
    const { server, client } = await setup();
    seedPushed(server, { idInPlan: "21", date, name: NAME });
    // A second program under the same link key that we did NOT write: the key
    // no longer resolves unanimously, so ownership cannot be proven.
    server.state.schedule.programs!.push({
      id: "sv-program-other",
      idInPlan: "21",
      planId: FIXTURE_PLAN_ID,
      name: "Club Handicap",
      sportType: 1,
    });
    const writesBefore = server.counts.scheduleWrites;

    const result = await deleteWorkout(client, target(), { today: TODAY });

    expect(result.ok).toBe(false);
    expect(result.refused).toBe("ambiguous");
    expect(server.counts.scheduleWrites).toBe(writesBefore);
    expect(server.entityByIdInPlan("21")).toBeDefined();
  });

  it("never reaches into another plan that shares the id, date and name", async () => {
    const { server, client } = await setup();
    const foreignPlanId = "479324793288704499";
    server.state.mergedPlans.push({
      id: foreignPlanId,
      name: "S4557",
      maxIdInPlan: 48,
      entities: [
        {
          id: "tpl-entity-21",
          idInPlan: "21",
          planId: foreignPlanId,
          planProgramId: "21",
          happenDay: Number(corosDay(date)),
        },
      ],
      // Identical program name — only the planId tells them apart.
      programs: [
        { id: "tpl-prog-21", idInPlan: "21", planId: foreignPlanId, name: NAME, sportType: 4 },
      ],
    });

    const result = await deleteWorkout(client, target(), { today: TODAY });

    expect(result.ok).toBe(false);
    expect(result.refused).toBe("not_found"); // nothing of ours in the target plan
    expect(server.state.mergedPlans[0]?.entities).toHaveLength(1);
    expect(server.counts.scheduleWrites).toBe(0);
  });

  it("reports a rejected delete instead of claiming the workout is gone", async () => {
    const { server, client } = await setup();
    seedPushed(server, { idInPlan: "21", date, name: NAME });
    server.deleteRejectResult = "1001";

    const result = await deleteWorkout(client, target(), { today: TODAY });

    expect(result.ok).toBe(false);
    expect(result.refused).toBeUndefined(); // sent and failed, not refused
    expect(result.code).toBe("1001");
    expect(server.entityByIdInPlan("21")).toBeDefined();
  });

  it("refuses a happenDay outside the span the plan-wide read can see", async () => {
    const { server, client } = await setup();

    const result = await deleteWorkout(
      client,
      target({ happenDay: corosDay(addDaysIso(TODAY, 400)) }),
      { today: TODAY },
    );

    expect(result.ok).toBe(false);
    expect(result.refused).toBeUndefined();
    expect(result.error).toContain("span");
    expect(server.counts.scheduleWrites).toBe(0);
  });
});

describe("createWorkout + deleteWorkout — round trip", () => {
  it("creates, then removes exactly what it created", async () => {
    const { server, client } = await setup();
    const date = addDaysIso(TODAY, 35);
    const before = (server.state.schedule.entities ?? []).map((e) => String(e.id)).sort();
    const target = spec({
      happenDay: corosDay(date),
      name: "Lower B — wk 3",
      session: session([
        exercise({ originId: SQUAT_ID, sets: 5, reps: 5, weight: { type: "kg", value: 100 } }),
        exercise({ originId: BENCH_ID, sets: 3, reps: 12, restSeconds: 60 }),
      ]),
    });

    const created = await createWorkout(client, target, { today: TODAY, catalog: CATALOG });
    expect(created.ok).toBe(true);

    const removed = await deleteWorkout(
      client,
      {
        happenDay: target.happenDay,
        name: target.name,
        idInPlan: created.serverIdInPlan!,
        programId: created.serverProgramId!,
        planId: created.serverPlanId!,
      },
      { today: TODAY },
    );

    expect(removed.ok).toBe(true);
    expect((server.state.schedule.entities ?? []).map((e) => String(e.id)).sort()).toEqual(before);
  });
});
