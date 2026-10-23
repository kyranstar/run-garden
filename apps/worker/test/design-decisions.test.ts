/**
 * EVERY DECISION THE COACH MAKES, IT CAN MAKE (2026-10-18, decision guidance; .superpowers/sdd/2026-10-18-section-8/
 * audit-decisions.md). For each decision the audit found without criteria, or with a lever the code then dropped:
 *  - the prompt gives criteria, not a script (principles §6.1), in the block of the role that makes the decision — the
 *    shared prefix only for what a designer and the reviewer need too (a run's targets, its pace, the watch), the main
 *    coach's block for routing and plans;
 *  - a lever the watch can't honour is no longer offered (a run target's heart rate, zone and typed text);
 *  - the opening message says, per run, how the watch takes what is approved (the run wire in force, or no COROS writes),
 *    so the cached prefix stays wire-neutral;
 *  - propose_plan says on the card which runs stay in the app (a distance block: the watch takes timed sessions), and
 *    refuses a lift or mobility session whose moves an active condition's rules keep out, as a document's are judged.
 * Synthetic data only, on the rich fixture's fixed clock (today Wed 13 May 2026).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { buildDesignContext } from "../src/services/design-context.js";
import { roleBlock, SHARED_PROMPT } from "../src/services/design-prompt.js";
import { watchLine } from "../src/services/designed-runs.js";
import { allTools } from "../src/services/design-tools/index.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import { MAX_PLAN_SESSIONS, proposePlan } from "../src/services/design-tools/propose-plan.js";
import { isToolErr, type SetHooks, type ToolContext, type ToolErr, type ToolOk } from "../src/services/design-tools/types.js";
import type { PlanStructureOp } from "../src/services/proposal-kinds.js";
import { at, NOW, seedRichAthlete, TODAY } from "./design-read-fixture.js";
import { isWrite, makeTestDb, makeTestUser } from "./helpers.js";

// ── The prompt: criteria for each decision, where the role that makes it reads them ─────────────────────────────────

describe("the prompt's criteria, each in its role's block", () => {
  const runs = SHARED_PROMPT.slice(SHARED_PROMPT.indexOf("Runs. "), SHARED_PROMPT.indexOf("Conditions. "));
  const main = roleBlock("main");
  /** The blocks that never route or plan: a designer's and the reviewer's (either rubric). */
  const others = [roleBlock("designer"), roleBlock("reviewer"), roleBlock("reviewer", undefined, "run")].join("\n");
  const line = (tool: string): string => SHARED_PROMPT.split("\n").find((l) => l.startsWith(`- ${tool}:`)) ?? "";

  it("1. time or distance: the criteria in the shared Runs paragraph (a designer writes runs too), wire-neutral; a plan's sessions timed in the main block", () => {
    expect(runs).toContain("with durationSec or distanceM, one of them, and a why.");
    expect(runs).toContain(
      "Time or distance is yours to choose: a distance when the athlete names one, for track or race-specific reps, and for a long run built to a distance goal; time for easy and recovery running, warm-ups and cool-downs, hills, strides, heat or trails.",
    );
    // What no threshold means for a distance depends on the wire in force: the opening message's watch line says it
    // (fix round M1), never the cached prefix.
    expect(SHARED_PROMPT).not.toContain("whenever no threshold is known");
    // The wire is the opening message's (`watchLine`), never the cached prefix's.
    expect(runs).not.toContain("a distance runs as its time");
    expect(runs).not.toContain("repeats are written out");
    expect(runs).toContain("On the watch a run holds at most 60 steps; the opening message says how its distances and repeats go.");
    expect(main).toContain("Give plan sessions timed blocks unless the athlete asks for a distance: a distance block keeps its session off the watch.");
    expect(others).not.toContain("Give plan sessions timed blocks");
  });

  it("2. heart rate: the watch holds pace — an HR cap or a zone is an easy or recovery effort, the cap said where it is seen and in the cue", () => {
    // The cue reaches only the stage notes (fix round M4): the intent summary or the segment's why is what the card shows.
    expect(runs).toContain(
      'The watch holds pace, not heart rate: an HR cap or "zone 2" is an easy or recovery effort, the cap said in the intent summary or the segment\'s why, and in its cue.',
    );
  });

  it("3. race pace: a goal race's pace on reps is a named pace with the nearest effort; effort race is a segment over its own distance", () => {
    expect(runs).toContain("leave target.pace out unless the athlete asked for a pace — a band they named, or a goal race's pace on reps, written as target.pace with the nearest effort.");
    expect(runs).toContain("Effort race is a segment run at race effort over its own distance, so give it distanceM.");
  });

  it("4. a run's length: adjust re-times a structured run by the rule and the watch gets it; a new purpose is ease or a new run — the main coach's", () => {
    // The owner's decision, 2026-10-20 (adjust-retime.ts): the coach states the length, the code re-times the steps.
    expect(main).toContain(
      "A length set with adjust re-times a structured run by a fixed rule — warm-up and cool-down kept, reps counted, the main block scaled — and the watch gets it; to change its purpose, ease it or design a new run, the old skipped.",
    );
    expect(others).not.toContain("A length set with adjust");
  });

  it("5 and 8. plan_set or propose_plan: reviewed library workouts for the coming days, a block of session specs for weeks; a mixed request", () => {
    const routing = main.split("\n").find((l) => l.startsWith("- plan_set or propose_plan:")) ?? "";
    expect(routing).toContain("plan_set designs a week or the next few workouts as reviewed library workouts — the coming days' strength and mobility go there");
    expect(routing).toContain("propose_plan builds a block of weeks from session specs, its timed runs going to the watch, its lift sessions simple specs");
    expect(routing).toContain("A mixed request (a block of runs and this week's strength): the block with propose_plan, then the strength with plan_set in a later turn — or ask which first.");
    expect(others).not.toContain("plan_set or propose_plan");
    // The plan's sessions meet the condition rules too (propose_plan below).
    expect(line("propose_plan")).toContain("checked by the plan guardrails and each active condition's rules");
  });

  it("6. a plan session's intensities: the five, and where the run efforts land, in propose_plan's own session schema", () => {
    const tool = allTools().find((t) => t.name === "propose_plan")!;
    const session = (tool.inputSchema as any).properties.change.properties.firmSessions.items.properties.session.description as string;
    expect(session).toContain("intensity?: easy|steady|threshold|interval|rest");
    expect(session).toContain("A block's intensity is one of those five: tempo is threshold, recovery is easy; strides, hills and race pace have none (a block without one runs by feel).");
    expect(session).toContain("Only a session of duration blocks goes to the watch.");
  });

  it("7. no threshold: a stated race result can set the pace; what it means for a distance is the opening message's", () => {
    expect(runs).toContain("With no threshold known, a recent race result the athlete states can set target.pace.");
    expect(watchLine({ writesOn: true, wire: "v1", thresholdKnown: false })).toContain("with no threshold known it can't be timed");
  });

  it("9. watch or app: a run goes only while COROS writes are on, strength stays until sent — never promise a watch copy beyond that", () => {
    expect(runs).toContain(
      "Approved, a run goes to the athlete's watch only when their COROS writes are on (the opening message says), and strength you design stays in the app until they send it: never promise a watch copy beyond that.",
    );
  });

  it("10. a programme's pattern from now on is change_programme's; one week's exception adjust_plan's; unclear days or goal asked (§8 §5, stream W)", () => {
    expect(main).toContain(
      "A programme's days, goal or minutes from now on are change_programme's (\"Tuesdays and Thursdays from now on\"); one week's exception, adjust_plan's. Days or goal unclear: ask once.",
    );
    expect(main).not.toContain("change in its settings");
    expect(others).not.toContain("change_programme's");
  });

  it("11. no stale 'Plan ahead'; when to remember, with a stated preference among the examples", () => {
    expect([SHARED_PROMPT, main, others].join("\n")).not.toContain("Plan ahead");
    expect(main).toContain("A request bigger than the scope — a week asked for from Now — gets what the scope allows, and your last line says they can ask for the rest.");
    expect(line("remember")).toContain('a lasting preference the athlete states ("I prefer distance targets", "no runs before work"), a standing limit, a pattern that holds across sessions');
  });

  it("every line stays generic: no figure, unit, race or person", () => {
    expect(runs).not.toMatch(/\d+:\d\d|\bkm\b|\bmi\b|marathon|10K/);
  });
});

// ── The model's run target: only what the watch honours ─────────────────────────────────────────────────────────────

describe("the run target the model is offered", () => {
  it("is a time, a distance, open or a named pace — no heart rate, zone or typed text, in any tool's schema", () => {
    // validate_workout carries the document's schema; propose_workout takes "a workout document exactly as validate_workout takes it".
    const doc = (allTools().find((t) => t.name === "validate_workout")!.inputSchema as any).properties.doc;
    const runItem = doc.properties.parts.items.properties.items.items.anyOf.find((b: any) => b.properties.kind.const === "run");
    expect(Object.keys(runItem.properties.target.properties)).toEqual(["durationSec", "distanceM", "open", "pace"]);
    expect(runItem.properties.target.additionalProperties).toBe(false);
    for (const t of allTools()) expect(JSON.stringify(t.inputSchema), t.name).not.toMatch(/"(hr|zone)":/);
  });
});

// ── The opening message: how the watch takes what is approved ───────────────────────────────────────────────────────

describe("the opening message's watch line", () => {
  it("says the wire in force — v1 a distance as its time, v2 as a distance — or that COROS writes are off", () => {
    expect(watchLine({ writesOn: true, wire: "v1", thresholdKnown: true })).toBe(
      "On the watch: a run's repeats go written out, and a distance step as its time at its band's middle.",
    );
    expect(watchLine({ writesOn: true, wire: "v1", thresholdKnown: false })).toBe(
      "On the watch: a run's repeats go written out, and a distance step as its time at its band's middle — with no threshold known it can't be timed, and keeps its run off the watch.",
    );
    expect(watchLine({ writesOn: true, wire: "v2", thresholdKnown: false })).toBe(
      "On the watch: a distance step goes as a distance, and a part's rounds as one repeat group (a rest between rounds writes them out).",
    );
    expect(watchLine({ writesOn: false, wire: "v2", thresholdKnown: true })).toBe(
      "On the watch: nothing for now — the athlete's COROS writes are off, so what they approve stays in the app.",
    );
  });

  describe("in every role's header, from the switch and the athlete's settings", () => {
    let db: Db;
    beforeEach(() => {
      db = makeTestDb({ boundVariableCap: 100 });
    });
    const header = async (env: Partial<Env>, writes: boolean, role: "main" | "designer" | "reviewer" = "main") => {
      const { userId } = await seedRichAthlete(db, { corosWritesEnabled: writes });
      const ctx = await buildDesignContext(db, env as Env, userId, { id: `run-${newId().slice(0, 6)}`, role, scope: { kind: "now" }, request: "A run, please.", parentId: null }, NOW);
      return ctx.header.split("\n");
    };
    it("v1 by default, v2 with RUN_WIRE_V2, nothing with writes off — right after the running line", async () => {
      for (const role of ["main", "designer", "reviewer"] as const) {
        const lines = await header({}, true, role);
        const i = lines.findIndex((l) => l.startsWith("Running:"));
        expect(lines[i + 1], role).toMatch(/^On the watch: a run's repeats go written out, and a distance step as its time at its band's middle/);
      }
      expect(await header({ RUN_WIRE_V2: "1" }, true)).toContain(
        "On the watch: a distance step goes as a distance, and a part's rounds as one repeat group (a rest between rounds writes them out).",
      );
      expect(await header({ RUN_WIRE_V2: "1" }, false)).toContain("On the watch: nothing for now — the athlete's COROS writes are off, so what they approve stays in the app.");
      // The cached prefix carries neither wire's words.
      expect(SHARED_PROMPT).not.toContain("On the watch:");
    });
  });
});

// ── propose_plan: the watch note and the condition rules ────────────────────────────────────────────────────────────

describe("propose_plan: what the card says of the watch, and what the condition rules refuse", () => {
  const ENV = {} as Env;
  let db: Db;
  const statements: string[] = [];
  let rich: Awaited<ReturnType<typeof seedRichAthlete>>;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => statements.push(s) });
    rich = await seedRichAthlete(db);
  });
  afterEach(() => vi.useRealTimers());

  const hooks = (): SetHooks => ({
    rounds: () => [],
    start: async () => [],
    budget: () => ({ ceilingMicros: 0, spentMicros: 0, mainSpentMicros: 0, perDesignerMicros: null, estimate: null }),
    started: () => false,
    keyLine: () => undefined,
    raisePlan: () => undefined,
  });
  let seq = 0;
  async function propose(input: unknown, userId = rich.userId) {
    const id = `run-dd-${++seq}-${newId().slice(0, 6)}`;
    await db.insert(schema.coachRuns).values({
      id, userId, parentId: null, role: "main", scope: { kind: "auto" }, request: "Plan my next weeks", status: "active", state: null,
      steps: 0, costUsd: 0, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    });
    const run: ToolContext["run"] = { id, role: "main", scope: { kind: "auto" }, parentId: null, rehearsal: false };
    statements.length = 0;
    const res = await proposePlan.run({ db, env: ENV, userId, run, now: NOW, toolUseId: `toolu_dd${seq}`, set: hooks() }, input);
    const [p] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, designProposalId(id)));
    return { res, count: statements.length, writes: statements.filter(isWrite).length, op: (p?.ops as unknown[] | undefined)?.[0] as PlanStructureOp | undefined };
  }
  const ok = (res: ToolOk | ToolErr) => {
    if (isToolErr(res)) throw new Error(`refused: ${res.error} — ${res.why}`);
    return res;
  };
  const refused = (res: ToolOk | ToolErr): ToolErr => {
    if (!isToolErr(res)) throw new Error(`not refused: ${JSON.stringify(res.data)}`);
    return res;
  };

  const easyRun = (minutes: number) => ({ category: "easy", title: "Easy run", durationMinutes: minutes, run: { blocks: [{ kind: "duration", value: minutes, intensity: "easy" }] } });
  const byDistance = (title: string, category: string, metres: number) => ({ category, title, durationMinutes: 60, run: { blocks: [{ kind: "distance", value: metres, intensity: "easy" }] } });
  const lift = (title: string, names: string[], category = "strength") => ({ category, title, durationMinutes: 30, lift: { exercises: names.map((name) => ({ name, sets: 3, reps: 6 })) } });
  const block = (discipline: "run" | "lift", firmSessions: Array<{ date: string; session: unknown }>, startDate = "2026-05-18") => ({
    change: { kind: "createPlan", discipline, name: discipline === "run" ? "Run block" : "Strength block", startDate, endDate: "2026-06-07", firmSessions, shapeWeeks: [] },
    why: "A steady block.",
  });

  it("a run with a distance block stays in the app, said on the card — one note for every such run; timed runs say nothing", async () => {
    const one = await propose(block("run", [{ date: "2026-05-18", session: easyRun(40) }, { date: "2026-05-24", session: byDistance("Long run", "long", 14000) }]));
    ok(one.res);
    expect(one.op!.issues.filter((i) => i.code === "plan_off_watch")).toEqual([{ code: "plan_off_watch", message: "Sun 24 May · Long run stays in the app — the watch takes timed sessions" }]);
    const two = await propose(block("run", [{ date: "2026-05-21", session: byDistance("Steady run", "easy", 8000) }, { date: "2026-05-24", session: byDistance("Long run", "long", 14000) }]));
    expect(two.op!.issues.filter((i) => i.code === "plan_off_watch")).toEqual([{ code: "plan_off_watch", message: "2 runs stay in the app — the watch takes timed sessions: Thu 21 May, Sun 24 May" }]);
    const timed = await propose(block("run", [{ date: "2026-05-18", session: easyRun(40) }, { date: "2026-05-20", session: easyRun(35) }]));
    expect(timed.op!.issues.some((i) => i.code === "plan_off_watch")).toBe(false);
  });

  it("a lift session whose move today's condition check keeps out is refused in words, nothing written", async () => {
    // Today's check reads high and the athlete feels off: jumps are closed today (since 2026-10-23 the number alone
    // closes none).
    await db.insert(schema.conditionChecks).values({ id: newId(), userId: rich.userId, profileId: "tmj", kind: "pre", value: 7, feelingOff: true, localDate: TODAY, at: at(TODAY, "08:30") });
    const r = await propose(block("lift", [{ date: TODAY, session: lift("Legs", ["Goblet squat", "Pogo hops"]) }], TODAY));
    const e = refused(r.res);
    expect(e.error).toBe("plan_refused");
    expect(e.why).toMatch(/^The condition rules refuse it: Wed 13 May · Legs: Pogo hops isn't allowed while you're feeling off\.$/);
    expect(e.fix).toContain("plan_set");
    expect(r.writes).toBe(0);
    expect(r.count).toBeLessThanOrEqual(proposePlan.statementCost);
  });

  it("a later day's move a check could close is refused — a session spec carries no alternate; today's, on a calm answered check, goes", async () => {
    ok((await propose(block("lift", [{ date: TODAY, session: lift("Legs", ["Goblet squat", "Pogo hops"]) }], TODAY))).res);
    const later = refused((await propose(block("lift", [{ date: "2026-05-19", session: lift("Legs", ["Goblet squat", "Pogo hops"]) }]))).res);
    expect(later.why).toMatch(/^The condition rules refuse it: Tue 19 May · Legs: Pogo hops depends on that day's .+ check, and a plan session can't carry an alternate\.$/);
    // The same move twice in the plan is said once; moves the rules allow, never.
    const twice = refused(
      (await propose(block("lift", [
        { date: "2026-05-19", session: lift("Legs", ["Pogo hops"]) },
        { date: "2026-05-21", session: lift("Legs again", ["Goblet squat", "Pogo hops"]) },
      ]))).res,
    );
    expect(twice.why.match(/Pogo hops/g)).toHaveLength(1);
    ok((await propose(block("lift", [{ date: "2026-05-19", session: lift("Legs", ["Goblet squat"]) }]))).res);
  });

  it("a session is judged at its own effort: a move a calm check allows on a strength day is refused in a recovery session", async () => {
    const recovery = refused((await propose(block("lift", [{ date: TODAY, session: lift("Easy legs", ["Pogo hops"], "recovery") }], TODAY))).res);
    expect(recovery.why).toMatch(/^The condition rules refuse it: Wed 13 May · Easy legs: Pogo hops isn't allowed on a .+ day with .+\.$/);
  });

  it("a mobility session is judged too", async () => {
    const mobility = { category: "yoga", title: "Loosen up", durationMinutes: 20, mobility: { exercises: [{ name: "Pogo hops", sets: 1, holdSeconds: 30 }] } };
    expect(refused((await propose(block("lift", [{ date: "2026-05-19", session: mobility }]))).res).why).toContain("Tue 19 May · Loosen up: Pogo hops");
  });

  it("while a condition profile is on, a move no library or COROS name resolves can't be checked: refused, each name in words (fix round M3)", async () => {
    const names = ["Pogo Jumps", "Jump squat", "Burpees", "Jumping jacks"];
    const e = refused((await propose(block("lift", [{ date: "2026-05-19", session: lift("Legs", names) }]))).res);
    expect(e.error).toBe("plan_refused");
    expect(e.why).toBe(
      `The condition rules refuse it: ${names.map((n) => `Tue 19 May · Legs: I can't check '${n}' against your conditions — pick a move from the library`).join("; ")}.`,
    );
    expect(e.fix).toContain("plan_set");
    // A name is said once, at the first session holding it.
    const twice = refused(
      (await propose(block("lift", [
        { date: "2026-05-19", session: lift("Legs", ["Jump squat"]) },
        { date: "2026-05-21", session: lift("Legs again", ["Goblet squat", "Jump squat"]) },
      ]))).res,
    );
    expect(twice.why).toBe("The condition rules refuse it: Tue 19 May · Legs: I can't check 'Jump squat' against your conditions — pick a move from the library.");
  });

  it("a name the athlete's COROS catalog resolves to a library move is judged as that move — and unresolved without it", async () => {
    // COROS's "Straight-Leg Hops" (T1260) is the library's pogo hops; the coach's words match it only through the catalog.
    const words = "Hops straight leg";
    expect(refused((await propose(block("lift", [{ date: "2026-05-19", session: lift("Legs", [words]) }]))).res).why).toContain(`I can't check '${words}'`);
    await db.insert(schema.corosExercises).values({ id: "catalog-1", name: "T1260", raw: { id: "catalog-1", name: "T1260" }, updatedAt: NOW.toISOString() });
    const judged = refused((await propose(block("lift", [{ date: "2026-05-19", session: lift("Legs", [words]) }]))).res);
    expect(judged.why).toMatch(/^The condition rules refuse it: Tue 19 May · Legs: Pogo hops depends on that day's .+ check, and a plan session can't carry an alternate\.$/);
  });

  it("the catalog read once serves both: the check's names and each lift's watch identity", async () => {
    // COROS's "Goblet Squat" (T1301), as the athlete's synced catalog holds it under its own id.
    await db.insert(schema.corosExercises).values({ id: "catalog-goblet", name: "T1301", raw: { id: "catalog-goblet", name: "T1301" }, updatedAt: NOW.toISOString() });
    const r = await propose(block("lift", [{ date: "2026-05-19", session: lift("Legs", ["Goblet squat"]) }]));
    ok(r.res);
    const stored = r.op!.op as unknown as { firmSessions: Array<{ session: { lift: { exercises: Array<{ name: string; originId?: string }> } } }> };
    expect(stored.firmSessions[0]!.session.lift.exercises).toEqual([expect.objectContaining({ name: "Goblet squat", originId: "catalog-goblet" })]);
    expect(r.count).toBeLessThanOrEqual(proposePlan.statementCost);
  });

  it("with no condition profile on, an unknown name stays the coach's, unjudged, as before", async () => {
    const { userId } = await makeTestUser(db, { timezone: "America/Los_Angeles" });
    ok((await propose(block("lift", [{ date: "2026-05-19", session: lift("Legs", ["Jump squat", "Pogo hops"]) }]), userId)).res);
  });

  it(`a plan change writes ${MAX_PLAN_SESSIONS} sessions at most — two weeks of up to twelve (fix round I1)`, async () => {
    expect(MAX_PLAN_SESSIONS).toBe(24);
    const days = (n: number) => Array.from({ length: n }, (_, i) => ({ date: i < 12 ? "2026-05-18" : "2026-05-25", session: easyRun(20) }));
    ok((await propose(block("run", days(24)))).res);
    const over = refused((await propose(block("run", days(25)))).res);
    expect(over.error).toBe("too_many_sessions");
    expect(over.why).toBe("It writes 25 sessions; one plan change writes at most 24.");
  });
});
