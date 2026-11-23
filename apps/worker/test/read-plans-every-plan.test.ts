/**
 * READ_PLANS NEVER HIDES A PLAN (R1.6; DEBUG-tre-cadence §5.2). The owner's coach was asked to change TRE and never saw it:
 * the answer fits 6,500 bytes, and plans were dropped from its end to fit, so the course past the cut was counted
 * (`morePlans: 6`) but not named. Now every plan the read finds is named: in full while they fit, and the rest in short — its
 * id, its kind, its name and its schedule — and `read_plans {planId}` gives any one of them in full. A course lists its
 * settings (days, time, rhythm), and its `why` names change_plan's lever for them. One statement either way.
 *
 * Synthetic data only, on the rich fixture's fixed clock (today Wed 13 May 2026).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import { courseConfigSchema, newId } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { readPlans } from "../src/services/design-tools/read-plans.js";
import { RESULT_BUDGET_BYTES } from "../src/services/design-tools/read-common.js";
import { isToolErr, type ToolErr, type ToolOk } from "../src/services/design-tools/types.js";
import { at, day, NOW, seedRichAthlete } from "./design-read-fixture.js";
import { isWrite, makeTestDb } from "./helpers.js";

const ENV = {} as Env;
let db: Db;
const statements: string[] = [];
let userId: string;
let programmeId: string;

beforeEach(async () => {
  statements.length = 0;
  db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => statements.push(s) });
  const rich = await seedRichAthlete(db);
  userId = rich.userId;
  programmeId = rich.programId;
});

const TRE = "course-invented-tre";

async function course(id: string, name: string, config: Record<string, unknown>, createdAt = at(day(60))) {
  await db.insert(schema.programs).values({
    id, userId, kind: "course", name, status: "active", disciplines: ["yoga"], onEnd: "continue", purpose: "Calm the nervous system",
    config: courseConfigSchema.parse({ course: "intro", time: "19:30", ...config }), createdAt, updatedAt: createdAt,
  });
}

async function block(id: string, name: string) {
  await db.insert(schema.coachPlans).values({
    id, userId, discipline: "run", name, status: "active", startDate: day(2), endDate: "2026-12-31", raceDate: null, stampPrefix: name, createdAt: at(day(10)), updatedAt: at(day(10)),
  });
}

async function session(planId: string, date: string, title: string) {
  const id = newId();
  await db.insert(schema.plannedWorkouts).values({
    id, userId, planId, sourceWorkoutId: id, title, category: "easy", sport: "run", originalPlanDate: date, lastVerifiedCorosDate: date, effectiveDate: date,
    effectiveTime: "07:00", sourceContentFingerprint: "fp", sourceEstimatedDurationSeconds: 2400, calendarBlockDurationSeconds: 3300, completionState: "scheduled",
    origin: "coach", createdAt: at(day(10)), updatedAt: at(day(10)),
  });
}

async function read(input: unknown = {}) {
  statements.length = 0;
  const res = await readPlans.run({ db, env: ENV, userId, run: { id: "run-rp", role: "main", scope: { kind: "auto" }, parentId: null, rehearsal: false }, now: NOW }, input);
  return { res, count: statements.length, writes: statements.filter(isWrite) };
}
type Answer = ToolOk & { data: { plans: Array<Record<string, any>>; otherPlans?: Array<Record<string, any>>; otherPlansNote?: string; morePlans?: number } };
const ok = (res: ToolOk | ToolErr): Answer => {
  if (isToolErr(res)) throw new Error(`refused: ${res.error} — ${res.why}`);
  return res as Answer;
};
const bytes = (r: Answer) => Buffer.byteLength(JSON.stringify({ provenance: r.provenance, missing: r.missing, data: r.data }));

/** Ten running blocks with long names and long session titles, two watch plans, the fixture's programme, and TRE: fourteen. */
async function crowded(): Promise<string[]> {
  const long = (s: string) => `${s} ${"with a very long name the watch gave it ".repeat(4)}`.trim();
  const ids: string[] = [];
  for (let n = 0; n < 10; n++) {
    await block(`cp-crowd-${n}`, long(`Block ${n}`));
    for (let d = 1; d <= 3; d++) await session(`cp-crowd-${n}`, day(-d), long(`Session ${d}`));
    ids.push(`cp-crowd-${n}`);
  }
  for (let n = 0; n < 2; n++) {
    await db.insert(schema.trainingPlans).values({
      id: `tp-crowd-${n}`, userId, sourcePlanId: `src-${n}`, name: long(`Watch plan ${n}`), startDate: day(30), endDate: "2026-12-31", status: "active", createdAt: at(day(30)), updatedAt: at(day(30)),
    });
    ids.push(`tp-crowd-${n}`);
  }
  await course(TRE, "TRE", { weekdays: [0, 4] });
  return [...ids, programmeId, TRE];
}

describe("read_plans with more plans than fit", () => {
  it("names every one of fourteen plans: in full while they fit, the rest in short with their schedule — none counted away", async () => {
    const ids = await crowded();
    expect(ids.length).toBeGreaterThanOrEqual(12);
    const { res, count, writes } = await read();
    const r = ok(res);
    expect(count).toBe(1);
    expect(writes).toEqual([]);
    expect(bytes(r)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
    expect(r.data.morePlans).toBeUndefined();
    const named = [...r.data.plans.map((p) => p.id), ...(r.data.otherPlans ?? []).map((p) => p.id)];
    for (const id of ids) expect(named, id).toContain(id);
    // Some had to go short: the answer says how to read one in full.
    expect(r.data.otherPlans!.length).toBeGreaterThan(0);
    expect(r.data.otherPlansNote).toBe("Listed in short to fit the answer: read_plans with a planId gives that plan in full.");
    // The coach's own running blocks still come first, in full.
    expect(r.data.plans[0]!.kind).toBe("coach block");
  });

  it("a course in short says its kind, its name and its days and time; a programme its days and goal; a block its dates", async () => {
    await crowded();
    const r = ok((await read()).res);
    const short = new Map((r.data.otherPlans ?? []).map((p) => [p.id, p]));
    const all = new Map([...r.data.plans.map((p) => [p.id, p] as const), ...short]);
    const tre = all.get(TRE)!;
    if (short.has(TRE)) expect(tre).toEqual({ id: TRE, kind: "course", name: { untrusted: true, text: "TRE" }, schedule: "Mon · Fri · 19:30", planId: TRE });
    else expect(tre.settings).toMatchObject({ days: ["Mon", "Fri"], time: "19:30", everyWeeks: 1 });
    for (const p of short.values()) {
      expect(typeof p.schedule).toBe("string");
      if (p.kind === "coach block" || p.kind === "watch plan") expect(p.schedule).toMatch(/^\d{4}-\d\d-\d\d → \d{4}-\d\d-\d\d$/);
    }
  });

  it("read_plans {planId} gives that plan in full, whatever else there is", async () => {
    await crowded();
    const { res, count } = await read({ planId: TRE });
    const r = ok(res);
    expect(count).toBe(1);
    expect(r.data.plans).toHaveLength(1);
    expect(r.data.plans[0]).toMatchObject({ id: TRE, kind: "course", planId: TRE, settings: { days: ["Mon", "Fri"], time: "19:30", everyWeeks: 1 } });
    expect(r.data.otherPlans).toBeUndefined();
  });

  it("read_plans {planId} of no plan of theirs says so, and how to find them", async () => {
    await crowded();
    const r = ok((await read({ planId: "no-such-plan" })).res);
    expect(r.data.plans).toEqual([]);
    expect(r.missing).toContain('no plan "no-such-plan": read_plans with no planId names them all');
  });
});

describe("a course's settings, and what changes them", () => {
  it("lists its days, time and rhythm; every 2 weeks, the Monday it counts from; its why names change_plan's lever", async () => {
    await course(TRE, "TRE", { weekdays: [0], everyWeeks: 2, cadenceFrom: "2026-05-11" });
    const r = ok((await read()).res);
    const tre = r.data.plans.find((p) => p.id === TRE)!;
    expect(tre.settings).toEqual({ days: ["Mon"], time: "19:30", everyWeeks: 2, from: "2026-05-11" });
    expect(tre.why).toBe(
      "a course: a fixed sequence, each session written on its day. Change its days, time or rhythm (everyWeeks: its days every 1 to 4 weeks), ease its next session or pause it with change_plan (its planId); skip or move one session with adjust_plan",
    );
  });
});
