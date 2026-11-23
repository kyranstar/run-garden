/**
 * THE OWNER'S REQUEST, REPLAYED (R1.6; DEBUG-tre-cadence §1, §4): "Can we change TRE to be like every two weeks please". On
 * 2026-11-22 the coach couldn't find TRE in read_plans (dropped from the end of an answer that didn't fit), was refused by
 * change_programme (a course is no programme), skipped three sessions by hand and promised to skip the rest as they appeared.
 *
 * Here the same request runs through the real registry, the real opening context and the real loop, on a fixture account as
 * crowded as the owner's, driven by a scripted model (no key, no network) that does what the prompt now routes: read the plans,
 * find TRE (in full or in short), and change its rhythm with ONE change_plan {days: ["Mon"], everyWeeks: 2}. The proposal holds
 * that one card and no skip; approved, the course is every other Monday. The model is told the words for "every few weeks" too.
 * The script stands in for the model, so what this proves is the path the words point at, not a model's choice of it.
 *
 * Synthetic data only: the made-up athlete of design-read-fixture.ts on its fixed clock (Wed 13 May 2026), and a made-up course.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@rg/workout", async (importOriginal) => {
  const { withIntroCourse } = await import("./course-fixture.js");
  return withIntroCourse(await importOriginal<typeof import("@rg/workout")>());
});

import { and, eq, isNull } from "drizzle-orm";
import { schema } from "@rg/database";
import { courseConfigSchema } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import { createRun, runStep, type RunDeps } from "../src/services/coach-runs.js";
import { designContextBuilder } from "../src/services/design-context.js";
import { approveDesignOps } from "../src/services/design-approve.js";
import { allTools } from "../src/services/design-tools/index.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import type { ContentBlock, MessagesOk, MessagesRequest, MessagesResult } from "../src/services/llm-messages.js";
import type { PlanChangeOp } from "../src/services/proposal-kinds.js";
import { placeSlots } from "../src/services/program-slots.js";
import { at, day, NOW, seedRichAthlete, TODAY } from "./design-read-fixture.js";
import { INTRO_COURSE } from "./course-fixture.js";
import { makeTestDb, untilDone } from "./helpers.js";

/** The main block's routing of a rhythm (design-prompt-cadence.test.ts holds the whole line). */
const RHYTHM_LINE = "A course's days, time or rhythm from now on are change_plan's. A rhythm longer than a week is everyWeeks with the days";

const env = { APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1" } as Env;
const ASK = "Can we change TRE to be like every two weeks please";

let db: Db;
beforeAll(() => {
  db = makeTestDb({ boundVariableCap: 100 });
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

let seq = 0;
const use = (name: string, input: unknown): ContentBlock => ({ type: "tool_use", id: `toolu_tre${++seq}`, name, input });
function turn(uses: ContentBlock[], text = "Working on it."): MessagesOk {
  return {
    ok: true,
    model: "anthropic/claude-opus-5.5",
    content: [{ type: "thinking", thinking: "", signature: `sig-${++seq}-${"x".repeat(30)}` }, { type: "text", text }, ...uses],
    stopReason: uses.length > 0 ? "tool_use" : "end_turn",
    usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 50, outputTokens: 40 },
    costMicros: 1_000,
  };
}

/** The last tool result the model was handed for `name`, parsed. */
function lastResult(req: MessagesRequest, name: string): Record<string, any> | null {
  const ids = new Map<string, string>();
  let out: Record<string, any> | null = null;
  for (const m of req.messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "tool_use") ids.set(b.id, b.name);
      if (b.type === "tool_result" && ids.get(b.tool_use_id) === name) out = JSON.parse(typeof b.content === "string" ? b.content : b.content.map((c) => c.text).join(""));
    }
  }
  return out;
}

/**
 * The model, as the prompt now routes the request: read the plans; find the course by its name wherever read_plans names it —
 * in full or in short — and change its rhythm with one change_plan; then finish.
 */
function scriptedCoach(rhythm: { everyWeeks: number; why: string }, finishLine: string) {
  const requests: MessagesRequest[] = [];
  let step = 0;
  const deps: RunDeps = {
    callModel: async (_env, req): Promise<MessagesResult> => {
      requests.push(structuredClone(req));
      step += 1;
      if (step === 1) return turn([use("read_plans", {})], "Reading your plans.");
      if (step === 2) {
        const read = lastResult(req, "read_plans");
        const full = (read?.data?.plans ?? []) as Array<{ id: string; planId?: string | null; name: { text: string } }>;
        // In short: [id, name, schedule] by kind (a block in lines by its id alone).
        const short = Object.values((read?.data?.otherPlans ?? {}) as Record<string, unknown[]>)
          .flat()
          .flatMap((s) => (Array.isArray(s) ? [{ id: s[0] as string, name: s[1] as { text: string } }] : []));
        const tre = [...full.map((p) => ({ id: p.planId ?? p.id, name: p.name })), ...short].find((p) => p.name.text === "TRE");
        if (!tre) return turn([use("finish", { summary: "I couldn't find TRE." })]);
        return turn([use("change_plan", { planId: tre.id, days: ["Mon"], everyWeeks: rhythm.everyWeeks, why: rhythm.why })], "TRE is a course: its rhythm is change_plan's.");
      }
      return turn([use("finish", { summary: finishLine })], finishLine);
    },
    buildContext: designContextBuilder,
    tools: allTools(),
    review: true,
    clock: () => 0,
  };
  return { deps, requests };
}

async function drive(userId: string, runId: string, deps: RunDeps) {
  let last = "active";
  await untilDone(
    async (i) => {
      const out = await runStep(db, env, runId, userId, new Date(NOW.getTime() + i * 1000), deps);
      if (out.kind !== "ok") throw new Error(`step answered ${out.kind}`);
      last = out.result.status;
      return last !== "active";
    },
    { max: 40, what: "drive" },
  );
  return last;
}

/** The owner's account, in shape: TRE on Mondays and Fridays at 19:30 among more plans than read_plans fits in full. */
async function crowdedWithTre(): Promise<{ userId: string; tre: string }> {
  const a = await seedRichAthlete(db);
  const long = (s: string) => `${s} ${"with a very long name the watch gave it ".repeat(4)}`.trim();
  for (let n = 0; n < 10; n++) {
    const id = `cp-owner-${n}-${a.userId.slice(0, 6)}`;
    await db.insert(schema.coachPlans).values({
      id, userId: a.userId, discipline: "run", name: long(`Block ${n}`), status: "active", startDate: day(2), endDate: "2026-12-31", raceDate: null,
      stampPrefix: `B${n}`, createdAt: at(day(10)), updatedAt: at(day(10)),
    });
  }
  const tre = `course-${a.userId}-tre`;
  await db.insert(schema.programs).values({
    id: tre, userId: a.userId, kind: "course", name: "TRE", status: "active", disciplines: ["yoga"], onEnd: "continue", purpose: "Calm the nervous system",
    brief: "Ten sessions in order, then floor practice.",
    config: courseConfigSchema.parse({ course: INTRO_COURSE.id, weekdays: [0, 4], time: "19:30" }), createdAt: at(day(40)), updatedAt: at(day(40)),
  });
  // Its last session done: Monday this week (the fixture's today is Wednesday 13 May).
  const done = `tre-done-${a.userId.slice(0, 6)}`;
  await db.insert(schema.plannedWorkouts).values({
    id: done, userId: a.userId, planId: tre, sourceWorkoutId: done, title: "TRE", category: "yoga", sport: "yoga", originalPlanDate: "2026-05-11", lastVerifiedCorosDate: "",
    effectiveDate: "2026-05-11", effectiveTime: "19:30", sourceContentFingerprint: "studio", fallbackEstimatedDurationSeconds: 660, calendarBlockDurationSeconds: 900,
    origin: "studio", contentState: "outline", completionState: "completed", courseSession: 3, createdAt: at(day(2)), updatedAt: at(day(2)),
  });
  await placeSlots(db, a.userId, tre, TODAY, await loadPreferences(db, a.userId), NOW.toISOString());
  return { userId: a.userId, tre };
}

const liveDates = async (planId: string) =>
  (await db.select().from(schema.plannedWorkouts).where(and(eq(schema.plannedWorkouts.planId, planId), isNull(schema.plannedWorkouts.archivedAt))))
    .map((r) => r.effectiveDate)
    .filter((d) => d >= TODAY)
    .sort();

describe('"Can we change TRE to be like every two weeks please", replayed', () => {
  it("one change_plan {days: [Mon], everyWeeks: 2}, no skips; approved, TRE is every other Monday", async () => {
    const { userId, tre } = await crowdedWithTre();
    expect(await liveDates(tre)).toEqual(["2026-05-15", "2026-05-18", "2026-05-22", "2026-05-25", "2026-05-29"]);
    const runId = (await createRun(db, userId, { scope: { kind: "auto" }, request: ASK }, NOW)).run.id;
    const line = "TRE is every other Monday now: two weeks after Monday's session, Mon 25 May; Friday's sessions come off.";
    const { deps, requests } = scriptedCoach({ everyWeeks: 2, why: "Every two weeks, as you asked: Mondays, two weeks after your last." }, line);
    expect(await drive(userId, runId, deps)).toBe("finished");

    // The model saw TRE, its id and its schedule, though the plans don't all fit in full.
    const read = lastResult(requests[1]!, "read_plans")!;
    const shortIds = Object.values((read.data.otherPlans ?? {}) as Record<string, unknown[]>).flat().map((s) => (Array.isArray(s) ? s[0] : s));
    expect([...read.data.plans.map((p: { id: string }) => p.id), ...shortIds]).toContain(tre);
    expect(read.data.morePlans).toBeUndefined();
    // And it was told how a rhythm is set.
    expect(requests[0]!.system.map((b) => b.text).join("\n")).toContain(RHYTHM_LINE);
    expect(JSON.stringify(requests[0]!.tools.find((t) => t.name === "change_plan"))).toContain("everyWeeks");

    const [p] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, designProposalId(runId)));
    expect(p!.status).toBe("pending");
    const ops = p!.ops as Array<{ kind: string }>;
    expect(ops.map((o) => o.kind)).toEqual(["plan_change"]);
    expect(ops.filter((o) => o.kind === "plan_adjust")).toEqual([]);
    const op = ops[0] as PlanChangeOp;
    expect(op.planId).toBe(tre);
    // Counted from this week, the week of the last session done (Mon 11 May), so the next is two weeks after it.
    expect(op.change).toEqual({ weekdays: [0], everyWeeks: 2, cadenceFrom: "2026-05-11" });
    // Then every other Monday (fix round 2: the next two), and what comes off: the Fridays, and the Monday between.
    expect(op.lines).toEqual([
      "Days Mon · Fri → Mon",
      "Every week → Every 2 weeks",
      "Next TRE Mon 25 May, then Mon 8 Jun",
      "Comes off: Fri 15 May · Mon 18 May · Fri 22 May +1 more",
    ]);

    const prefs = await loadPreferences(db, userId);
    const res = await approveDesignOps(db, userId, p! as never, { opIds: [op.id] }, { today: TODAY, now: NOW.toISOString(), prefs }, Number.POSITIVE_INFINITY);
    expect(res.status, JSON.stringify(res)).toBe("approved");
    const [row] = await db.select().from(schema.programs).where(eq(schema.programs.id, tre));
    expect(row!.config).toMatchObject({ weekdays: [0], everyWeeks: 2, cadenceFrom: "2026-05-11" });
    await placeSlots(db, userId, tre, TODAY, prefs, NOW.toISOString());
    // From today: Mon 25 May, two weeks after the last; no Friday, and none in the week between.
    expect(await liveDates(tre)).toEqual(["2026-05-25"]);
    await placeSlots(db, userId, tre, "2026-05-25", prefs, "2026-05-25T15:00:00.000Z");
    expect((await liveDates(tre)).filter((d) => d <= "2026-06-14")).toEqual(["2026-05-25", "2026-06-08"]);
  });

  it('"every few weeks": the model is told it is 2 or 3, chosen from the plan, its why saying which; the card says the rhythm', async () => {
    const { userId, tre } = await crowdedWithTre();
    const runId = (await createRun(db, userId, { scope: { kind: "auto" }, request: "Can we do TRE every few weeks instead?" }, NOW)).run.id;
    const { deps, requests } = scriptedCoach(
      { everyWeeks: 3, why: "Every 3 weeks: its brief is ten sessions in order, and three weeks apart still keeps them going." },
      "TRE is every third Monday, three weeks after your last: Mon 1 Jun.",
    );
    expect(await drive(userId, runId, deps)).toBe("finished");
    expect(requests[0]!.system.map((b) => b.text).join("\n")).toContain('"every few weeks" is 2 or 3, chosen from the plan\'s brief and history, the card\'s why saying which');
    const [p] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, designProposalId(runId)));
    const op = (p!.ops as PlanChangeOp[])[0]!;
    expect(op.planId).toBe(tre);
    expect(op.lines).toContain("Every week → Every 3 weeks");
    expect(op.why).toContain("Every 3 weeks");
  });
});
